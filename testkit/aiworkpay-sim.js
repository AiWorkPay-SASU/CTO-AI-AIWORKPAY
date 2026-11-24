import http from 'node:http';

/**
 * SIMULATED AIWorkPay agent API (no Stripe, no money, no real Payworker). Same contract as the one the AIWORKPAY MCP server
 * 0.7.0 calls: Bearer key, per-key Idempotency-Key with body fingerprint, owner-only reads, scopes, caps, Checkout payment
 * that a (simulated) human pays, Payworker lifecycle driven by the test. Every method that stands for a human or a Payworker
 * is named for it. This file is test tooling: it never talks to a real service.
 */
const json = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const strip = ({ apiKey, idem, fp, ...mission }) => mission;
const MONTH = () => { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

export class AiworkpaySim {
  constructor({ keys = { awp_sim_cto_key_00000000: ['missions:read', 'missions:write'] }, limits = { maxMissionBudget: 100, monthlyBudget: 300 } } = {}) {
    this.keys = new Map(Object.entries(keys));
    this.limits = limits;
    this.missions = new Map();
    this.files = new Map();
    this.payments = [];
    this.requests = [];
    this.seq = 0;
    this.dropNext = 0; // answer lost AFTER the backend accepted: the network cut scenario
    this.failNext = null; // { status, body }: refuse the next request
    this.approverKeys = new Set(); // proposed evolution only (disabled unless a test enables it)
  }

  key(headers) {
    const k = String(headers.authorization ?? '').replace(/^Bearer /i, '');
    return this.keys.has(k) ? k : null;
  }

  can(key, scope) { return this.keys.get(key).includes(scope); }

  /** Returns { status, headers, body, drop? }. */
  handle(method, url, headers, rawBody) {
    const u = new URL(url, 'http://sim');
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    this.requests.push({ method, path: u.pathname + u.search, headers, body });
    if (this.failNext) { const f = this.failNext; this.failNext = null; return json(f.status, f.body, f.headers); }
    const res = this.#route(method, u, headers, body);
    if (this.dropNext > 0 && method === 'POST' && u.pathname === '/api/missions') { this.dropNext -= 1; return { ...res, drop: true }; }
    return res;
  }

  #route(method, u, headers, body) {
    const key = this.key(headers);
    if (!headers.authorization) return json(401, { error: 'Clé API manquante', code: 'UNAUTHORIZED' });
    if (!key) return json(403, { error: 'Clé API invalide', code: 'INVALID_API_KEY' });
    const need = (scope) => (this.can(key, scope) ? null : json(403, { error: 'Permission insuffisante', code: 'INSUFFICIENT_SCOPE', details: { required: scope } }));

    const proof = u.pathname.match(/^\/api\/missions\/([^/]+)\/proofs\/([^/]+)$/);
    if (proof && method === 'GET') {
      const denied = need('missions:read'); if (denied) return denied;
      const m = this.missions.get(proof[1]); const f = this.files.get(proof[2]);
      if (!m || m.apiKey !== key || !f || !['DELIVERED', 'COMPLETED'].includes(m.status)) return json(404, { error: 'Fichier introuvable', code: 'PROOF_NOT_FOUND' });
      return { status: 200, headers: { 'content-type': f.contentType, 'content-length': String(f.content.length) }, body: f.content };
    }
    if (u.pathname === '/api/account' && method === 'GET') { const d = need('missions:read'); return d ?? this.#account(key); }
    if (u.pathname === '/api/transactions' && method === 'GET') { const d = need('missions:read'); return d ?? json(200, { total: 0, transactions: [] }); }

    const act = u.pathname.match(/^\/api\/missions\/([^/]+)\/(cancel|approve|request-changes)$/);
    if (act && method === 'POST') return this.#act(key, act[1], act[2], body, need);

    const match = u.pathname.match(/^\/api\/missions(?:\/([^/]+))?$/);
    if (!match) return json(404, { error: 'not found' });
    const id = match[1];
    if (method === 'POST' && !id) return this.#create(key, headers, body, need);
    if (method === 'GET') {
      const d = need('missions:read'); if (d) return d;
      if (id) {
        const m = this.missions.get(id);
        return !m || m.apiKey !== key ? json(404, { error: 'Mission introuvable', code: 'MISSION_NOT_FOUND' }) : json(200, strip(m));
      }
      const status = u.searchParams.get('status');
      return json(200, [...this.missions.values()].filter((m) => m.apiKey === key && (!status || m.status === status)).reverse().map(strip));
    }
    return json(405, { error: 'method' });
  }

  #create(key, headers, body, need) {
    const denied = need('missions:write'); if (denied) return denied;
    if (body.paymentMode !== 'checkout') return json(400, { error: 'paymentMode', code: 'VALIDATION_ERROR' });
    if (this.limits.maxMissionBudget !== null && Number(body.budget) > this.limits.maxMissionBudget) return json(403, { error: 'plafond', code: 'BUDGET_LIMIT_EXCEEDED' });
    const idem = headers['idempotency-key'];
    const fp = JSON.stringify(body);
    if (idem) {
      const existing = [...this.missions.values()].find((m) => m.apiKey === key && m.idem === idem);
      if (existing) {
        if (existing.fp !== fp) return json(422, { error: 'reused', code: 'IDEMPOTENCY_KEY_REUSED' });
        return json(200, { mission: strip(existing), payment: this.#checkout(existing) }, { 'Idempotent-Replayed': 'true' });
      }
    }
    const committed = [...this.missions.values()].filter((m) => m.apiKey === key && m.status !== 'CANCELED').reduce((s, m) => s + Number(m.budget), 0);
    if (this.limits.monthlyBudget !== null && committed + Number(body.budget) > this.limits.monthlyBudget) return json(403, { error: 'mensuel', code: 'MONTHLY_BUDGET_EXCEEDED' });
    const now = new Date().toISOString();
    const id = `sim-m-${++this.seq}`;
    const mission = {
      id, title: body.title, description: body.description, budget: String(body.budget), currency: body.currency,
      deadline: new Date(body.deadline).toISOString(), priority: body.priority, status: 'PAYMENT_PENDING',
      checkoutUrl: `https://checkout.stripe.com/c/pay/cs_sim_${id}`, checkoutExpiresAt: new Date(Date.now() + 864e5).toISOString(),
      resultNote: null, resultData: null, deliveredAt: null, assigned: false, revisionCount: 0, createdAt: now, updatedAt: now,
      attachments: [], apiKey: key, idem, fp
    };
    this.missions.set(id, mission);
    return json(201, { mission: strip(mission), payment: this.#checkout(mission) });
  }

  #act(key, id, action, body, need) {
    const denied = need(action === 'cancel' ? 'missions:write' : 'missions:approve'); if (denied) return denied;
    const m = this.missions.get(id);
    const owner = m && (m.apiKey === key || (this.approverKeys.has(key) && action !== 'cancel'));
    if (!m || !owner) return json(404, { error: 'Mission introuvable', code: 'MISSION_NOT_FOUND' });
    if (action === 'cancel') {
      if (m.status === 'CANCELED') return json(200, { mission: strip(m), payment: 'already_canceled' });
      if (!['PAYMENT_PENDING', 'PUBLISHED'].includes(m.status)) return json(409, { error: 'engagé', code: 'MISSION_NOT_CANCELABLE' });
      const payment = m.status === 'PUBLISHED' ? 'refunded' : 'checkout_closed';
      this.#set(id, { status: 'CANCELED' });
      return json(200, { mission: strip(m), payment });
    }
    if (action === 'approve') {
      if (m.status === 'COMPLETED') return json(200, { mission: strip(m), alreadyApproved: true });
      if (m.status !== 'DELIVERED') return json(409, { error: 'pas livrée', code: 'MISSION_NOT_DELIVERED' });
      this.#set(id, { status: 'COMPLETED' });
      const b = Number(m.budget);
      return json(200, { mission: strip(m), alreadyApproved: false, commission: { payworkerAmount: b * 0.9, platformFeeAmount: b * 0.1, transferStatus: 'SUCCEEDED' } });
    }
    if (m.status !== 'DELIVERED') return json(409, { error: 'pas livrée', code: 'MISSION_NOT_DELIVERED' });
    this.#set(id, { status: 'IN_PROGRESS', revisionFeedback: body?.feedback, revisionCount: (m.revisionCount ?? 0) + 1 });
    return json(200, { mission: strip(m), revisionsLeft: 3 - m.revisionCount });
  }

  #account(key) {
    const missions = [...this.missions.values()].filter((m) => m.apiKey === key);
    const committed = missions.filter((m) => m.status !== 'CANCELED').reduce((s, m) => s + Number(m.budget), 0);
    const byStatus = {};
    for (const m of missions) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
    return json(200, {
      key: { id: 'key_sim', label: 'CTO IA (simulated)', prefix: key.slice(0, 12), scopes: this.keys.get(key), active: true, expiresAt: null, lastUsedAt: null, createdAt: MONTH() },
      limits: this.limits,
      usage: { monthStart: MONTH(), committedThisMonth: committed, remainingThisMonth: this.limits.monthlyBudget === null ? null : Math.max(0, this.limits.monthlyBudget - committed), totalPaid: 0, totalRefunded: 0, netPaid: 0 },
      missions: { total: missions.length, byStatus }, webhook: { configured: false }
    });
  }

  #checkout(m) { return { mode: 'checkout', checkoutSessionId: `cs_sim_${m.id}`, url: m.checkoutUrl, expiresAt: m.checkoutExpiresAt }; }

  #set(id, patch) { Object.assign(this.missions.get(id), patch, { updatedAt: new Date().toISOString() }); }

  // ---- the humans of the scenario (test-driven) -------------------------------------------------
  /** The owner pays the Checkout page: the mission is published. */
  ownerPays(id) { this.#set(id, { status: 'PUBLISHED' }); }
  workerAccepts(id) { this.#set(id, { status: 'ASSIGNED', assigned: true }); }
  workerStarts(id) { this.#set(id, { status: 'IN_PROGRESS' }); }
  /** proofs: [{ filename, mimeType, bytes: Buffer, scanned?: boolean, source?: 'upload'|'link', url? }] */
  workerDelivers(id, { note = '', data = null, proofs = [] } = {}) {
    const attachments = proofs.map((p, i) => {
      const pid = `proof-${id}-${i + 1}`;
      if (p.source === 'link') return { id: pid, url: p.url, filename: p.filename, mimeType: null, size: null, kind: 'PROOF', source: 'link', createdAt: new Date().toISOString() };
      this.files.set(pid, { content: p.bytes, contentType: p.mimeType });
      return { id: pid, url: `/api/missions/${id}/proofs/${pid}`, filename: p.filename, mimeType: p.mimeType, size: p.bytes.length, kind: 'PROOF', source: 'upload', scanStatus: p.scanned === false ? 'NOT_SCANNED' : 'CLEAN', createdAt: new Date().toISOString() };
    });
    this.#set(id, { status: 'DELIVERED', resultNote: note, resultData: data, deliveredAt: new Date().toISOString(), attachments });
  }
  /** The human AUTHORITY (outside the CTO) validates the result: this is what pays the Payworker in the real system. */
  humanAuthorityApproves(id) { this.#set(id, { status: 'COMPLETED' }); }
  /** Number of mission-creating calls the backend really accepted (duplicates would show here). */
  get created() { return this.missions.size; }
}

/** Serves the simulator over HTTP so that the REAL MCP server process can use it as AIWORKPAY_BASE_URL. */
export async function serveSim(sim) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const out = sim.handle(req.method, req.url, req.headers, Buffer.concat(chunks).toString('utf8'));
      if (out.drop) { req.socket.destroy(); return; }
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
