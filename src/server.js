import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROLES } from './core.js';
import { Cto } from './cto.js';
import { storeFromEnv } from './store/index.js';
import { cachedPreflight } from './preflight.js';
import { humanFromEnv } from './human/index.js';
import { HumanError } from './human/errors.js';
import { BriefError } from './human/brief.js';
import { safeEqual, redact } from './util.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
  '/ui.css': ['ui.css', 'text/css; charset=utf-8']
};
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY = 64 * 1024;

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin'
};
const API_CSP = "default-src 'none'; frame-ancestors 'none'";
const UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Fixed-window limiter per client address. */
function makeLimiter(limit, windowMs) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/**
 * Builds the HTTP server (not listening). Two bearer tokens: the owner token can do everything,
 * the optional viewer token is read-only. Browser credentials are never stored by the UI.
 */
export function createServer({
  cto, human = null, adminToken, viewerToken = null, requestsPerMinute = 240, failedAuthPerMinute = 10
}) {
  if (!adminToken || adminToken.length < 24) throw new Error('CTO_ADMIN_TOKEN (24+ chars) required');
  if (viewerToken && viewerToken.length < 24) throw new Error('CTO_VIEWER_TOKEN must be 24+ chars');
  if (viewerToken && safeEqual(viewerToken, adminToken)) throw new Error('Viewer and admin tokens must differ');
  const allow = makeLimiter(requestsPerMinute, 60000);
  const allowFailedAuth = makeLimiter(failedAuthPerMinute, 60000);
  const assets = Object.fromEntries(
    Object.entries(STATIC).map(([url, [file, type]]) => [url, { body: fs.readFileSync(path.join(PUBLIC_DIR, file)), type }])
  );

  const send = (res, status, data, extra = {}) => {
    res.writeHead(status, { ...BASE_HEADERS, 'content-security-policy': API_CSP, 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(data));
  };

  const authenticate = (req) => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice(7);
    if (safeEqual(token, adminToken)) return 'owner';
    if (viewerToken && safeEqual(token, viewerToken)) return 'viewer';
    return null;
  };

  // The payment link is a bearer-like Stripe page: only the owner ever receives it.
  const viewOf = (d, role) => (role === 'owner' ? d : { ...d, payment_url: undefined, payment_url_expires_at: undefined });

  const routeDelegations = async (req, res, url, role) => {
    if (!human) throw new HttpError(404, 'Human delegation is not configured');
    const method = req.method;
    const m = url.pathname.match(/^\/api\/delegations(?:\/([^/]+)(?:\/([a-z]+))?)?$/);
    if (!m) throw new HttpError(404, 'Not found');
    const [, id, action] = m;
    if (id && !ID_RE.test(id)) throw new HttpError(400, 'Invalid delegation id');
    try {
      if (!id && method === 'GET') return send(res, 200, (await human.list({ mission_id: url.searchParams.get('mission_id') || undefined })).map((d) => viewOf(d, role)));
      if (!id && method === 'POST') {
        const body = await readJson(req);
        if (typeof body.mission_id === 'string' && !ID_RE.test(body.mission_id)) throw new HttpError(400, 'Invalid mission id');
        return send(res, 201, viewOf(await human.create({ brief: body.brief, mission_id: body.mission_id ?? null, by: role }), role));
      }
      if (id && !action && method === 'GET') return send(res, 200, viewOf(await human.get(id), role));
      if (id && method === 'POST') {
        const body = await readJson(req);
        if (action === 'approval') return send(res, 200, viewOf(await human.approve(id, { decision: body.decision, brief_hash: body.brief_hash, note: body.note, by: role }), role));
        if (action === 'cancel') return send(res, 200, viewOf(await human.cancel(id, { by: role }), role));
        if (action === 'refresh') return send(res, 200, viewOf(await human.refresh(id, { force: true }), role));
        if (action === 'review') return send(res, 200, viewOf(await human.review(id, { verdict: body.verdict, note: body.note, by: role }), role));
      }
    } catch (error) {
      if (error instanceof BriefError) return send(res, 400, { error: redact(error.message), code: error.code, problems: error.problems });
      if (error instanceof HumanError) return send(res, error.http, { error: redact(error.message), code: error.code, ...(error.reasons ? { reasons: error.reasons } : {}) });
      throw error;
    }
    throw new HttpError(404, 'Not found');
  };

  const route = async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && assets[pathname]) {
      res.writeHead(200, { ...BASE_HEADERS, 'content-security-policy': UI_CSP, 'content-type': assets[pathname].type });
      return res.end(assets[pathname].body);
    }
    if (pathname === '/health' && method === 'GET') return send(res, 200, { ok: true });
    if (!pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');

    const ip = req.socket.remoteAddress ?? 'unknown';
    const role = authenticate(req);
    if (!role) {
      if (!allowFailedAuth(ip)) throw new HttpError(429, 'Too many failed attempts');
      throw new HttpError(401, 'Unauthorized');
    }
    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');
      if (role !== 'owner') throw new HttpError(403, 'Read-only token');
    }

    if (pathname === '/api/whoami' && method === 'GET') return send(res, 200, { role });
    if (pathname === '/api/human/status' && method === 'GET') {
      return send(res, 200, human ? await human.status() : { enabled: false, disabled_reasons: ['human delegation is not configured'] });
    }
    if (pathname.startsWith('/api/delegations')) return routeDelegations(req, res, url, role);
    if (pathname === '/api/runtime' && method === 'GET') {
      // Real runtime checks (Linux, Node, Claude CLI, bubblewrap). `force=1` bypasses the short cache.
      const preflight = cto.preflight ? await cto.preflight({ force: url.searchParams.get('force') === '1' }) : null;
      return send(res, 200, { api: 'cto-ai/1', repo_path: fs.realpathSync(cto.repoPath), preflight });
    }
    if (pathname === '/api/agents' && method === 'GET') {
      const running = await cto.store.list('tasks', { status: 'running' });
      return send(res, 200, Object.entries(ROLES).map(([name, def]) => ({
        role: name,
        capabilities: def.capabilities,
        read_only: def.readOnly,
        max_budget_usd: def.maxBudgetUsd,
        state: running.some((t) => t.role === name) ? 'busy' : 'idle',
        running_tasks: running.filter((t) => t.role === name).map((t) => ({ id: t.id, mission_id: t.mission_id }))
      })));
    }
    if (pathname === '/api/missions' && method === 'GET') {
      const ref = url.searchParams.get('external_ref');
      if (ref) {
        const found = await cto.getMissionByRef(ref);
        return send(res, 200, found ? [found] : []);
      }
      return send(res, 200, await cto.listMissions());
    }
    if (pathname === '/api/missions' && method === 'POST') {
      const body = await readJson(req);
      const existing = typeof body.external_ref === 'string' ? await cto.getMissionByRef(body.external_ref) : null;
      const mission = await cto.createMission({
        objective: body.objective, project: body.project, budgetUsd: body.budget_usd, acceptance: body.acceptance,
        externalRef: body.external_ref, scope: body.scope
      });
      // 200 + idempotent_replay: the same external_ref was already accepted, nothing new was created or started.
      return send(res, existing ? 200 : 201, existing ? { ...mission, idempotent_replay: true } : mission);
    }

    const m = pathname.match(/^\/api\/missions\/([^/]+)(?:\/([a-z]+))?$/);
    if (!m) throw new HttpError(404, 'Not found');
    const [, id, action] = m;
    if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid mission id');

    if (!action && method === 'GET') {
      const mission = await cto.getMission(id);
      if (!mission) throw new HttpError(404, 'Not found');
      return send(res, 200, mission);
    }
    if (action === 'events' && method === 'GET') {
      if (!(await cto.store.get('missions', id))) throw new HttpError(404, 'Not found');
      return send(res, 200, await cto.store.list('events', { mission_id: id }));
    }
    if (action === 'report' && method === 'GET') return send(res, 200, await cto.consolidatedReport(id));
    if (method !== 'POST') throw new HttpError(404, 'Not found');

    const body = await readJson(req);
    if (action === 'approvals') {
      return send(res, 200, await cto.approve(id, { kind: body.kind, decision: body.decision, note: body.note, by: role }));
    }
    if (action === 'budget') return send(res, 200, await cto.raiseBudget(id, body.budget_usd, { by: role }));
    if (action === 'resume') {
      try {
        return send(res, 200, await cto.resume(id, { by: role }));
      } catch (error) {
        if (error.blocked) return send(res, 409, { error: redact(error.message), status: 'BLOCKED' });
        throw error;
      }
    }
    if (action === 'cancel') return send(res, 200, await cto.cancelMission(id, { by: role, reason: body.reason ?? 'cancelled by owner' }));
    if (action === 'run') {
      if (!(await cto.store.get('missions', id))) throw new HttpError(404, 'Not found');
      if (url.searchParams.get('wait') === '1') {
        await cto.drain();
        return send(res, 200, await cto.getMission(id));
      }
      const started = await cto.tick();
      return send(res, 202, { started });
    }
    throw new HttpError(404, 'Not found');
  };

  return http.createServer(async (req, res) => {
    try {
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (!allow(ip)) throw new HttpError(429, 'Rate limit exceeded');
      await route(req, res, new URL(req.url, 'http://local'));
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status ?? (/^Supabase|ENOENT|EACCES/.test(error.message) ? 500 : 400);
      if (status >= 500) console.error('internal error:', redact(error.message));
      send(res, status, { error: status >= 500 ? 'Internal error' : redact(error.message) }, status === 429 ? { 'retry-after': '60' } : {});
    }
  });
}

export function ctoFromEnv(env = process.env) {
  return new Cto({
    store: storeFromEnv(env),
    repoPath: env.CTO_REPO_PATH || process.cwd(),
    workspacesDir: env.CTO_WORKSPACES_DIR,
    preflight: env.CTO_PREFLIGHT === '0' ? null : cachedPreflight(),
    limits: { maxConcurrent: Number(env.CTO_MAX_CONCURRENT || 2) }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cto = ctoFromEnv();
  const human = await humanFromEnv(cto.store);
  const server = createServer({
    cto, human, adminToken: process.env.CTO_ADMIN_TOKEN, viewerToken: process.env.CTO_VIEWER_TOKEN || null
  });
  if (human.config.enabled) {
    // Finish uncertain submissions (by replay, never a duplicate) and follow active delegations.
    human.recover().catch((e) => console.error('human recover failed:', redact(e.message)));
    setInterval(() => human.recover().catch((e) => console.error('human poll failed:', redact(e.message))), Math.max(60000, human.config.pollMinMs)).unref();
  }
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`CTO API listening on ${host}:${port}`));
  if (process.env.CTO_WORKER !== '0') cto.startWorker();
  const stop = async () => {
    server.close();
    await human.port.close?.();
    await cto.stopWorker({ waitForTasks: false });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
