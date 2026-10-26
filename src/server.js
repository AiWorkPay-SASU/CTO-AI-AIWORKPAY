import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROLES } from './core.js';
import { Cto } from './cto.js';
import { storeFromEnv } from './store/index.js';
import { githubFromEnv } from './github.js';
import { createHash } from 'node:crypto';
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
  cto, adminToken, viewerToken = null, requestsPerMinute = 240, failedAuthPerMinute = 10
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

  // A short fingerprint identifies which credential made a request without ever storing the credential.
  const fingerprint = (token) => createHash('sha256').update(token).digest('hex').slice(0, 8);
  const authenticate = (req) => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice(7);
    if (safeEqual(token, adminToken)) return { role: 'owner', credentialId: fingerprint(token) };
    if (viewerToken && safeEqual(token, viewerToken)) return { role: 'viewer', credentialId: fingerprint(token) };
    return null;
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
    const identity = authenticate(req);
    const role = identity?.role;
    if (!identity) {
      if (!allowFailedAuth(ip)) throw new HttpError(429, 'Too many failed attempts');
      throw new HttpError(401, 'Unauthorized');
    }
    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');
      if (role !== 'owner') throw new HttpError(403, 'Read-only token');
    }

    if (pathname === '/api/whoami' && method === 'GET') return send(res, 200, { role, credential_id: identity.credentialId, github: Boolean(cto.github) });
    if (pathname === '/api/agents' && method === 'GET') {
      const running = await cto.store.list('tasks', { status: 'running' });
      return send(res, 200, Object.entries(ROLES).map(([name, def]) => ({
        role: name,
        capabilities: def.capabilities,
        read_only: def.readOnly,
        max_budget_usd: def.maxBudgetUsd,
        running_tasks: running.filter((t) => t.role === name).map((t) => ({ id: t.id, mission_id: t.mission_id }))
      })));
    }
    if (pathname === '/api/missions' && method === 'GET') return send(res, 200, await cto.listMissions());
    if (pathname === '/api/missions' && method === 'POST') {
      const body = await readJson(req);
      const mission = await cto.createMission({
        objective: body.objective, project: body.project, budgetUsd: body.budget_usd, acceptance: body.acceptance
      });
      return send(res, 201, mission);
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
      return send(res, 200, await cto.approve(id, { kind: body.kind, decision: body.decision, note: body.note, by: role, credentialId: identity.credentialId }));
    }
    if (action === 'budget') return send(res, 200, await cto.raiseBudget(id, body.budget_usd, { by: role }));
    if (action === 'resume') return send(res, 200, await cto.resumeMission(id, { by: role, note: body.note, credentialId: identity.credentialId }));
    if (action === 'pr') return send(res, 200, await cto.submitPullRequest(id, { by: role, credentialId: identity.credentialId }));
    if (action === 'ci') return send(res, 200, await cto.checkCi(id));
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
  // CTO_REPOS: JSON {"owner/repo": "/path/to/checkout"}; it is also the allowlist of projects.
  const repos = env.CTO_REPOS ? JSON.parse(env.CTO_REPOS) : null;
  return new Cto({
    store: storeFromEnv(env),
    github: githubFromEnv(env),
    ...(repos ? { repos } : { repoPath: env.CTO_REPO_PATH || process.cwd() }),
    workspacesDir: env.CTO_WORKSPACES_DIR,
    limits: { maxConcurrent: Number(env.CTO_MAX_CONCURRENT || 2) }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cto = ctoFromEnv();
  const server = createServer({
    cto, adminToken: process.env.CTO_ADMIN_TOKEN, viewerToken: process.env.CTO_VIEWER_TOKEN || null
  });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`CTO API listening on ${host}:${port}`));
  if (process.env.CTO_WORKER !== '0') cto.startWorker();
  const stop = async () => {
    server.close();
    await cto.stopWorker({ waitForTasks: false });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
