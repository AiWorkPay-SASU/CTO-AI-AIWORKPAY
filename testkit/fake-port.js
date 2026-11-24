import { createHash } from 'node:crypto';
import { PortError, ContractDriftError } from '../src/human/errors.js';
import { assertCallable } from '../src/human/policy.js';

const j = (res) => (res.body && res.headers['content-type']?.includes('json') ? JSON.parse(res.body) : null);
const ref = (args) => `mcp-${createHash('sha256').update(`ref:${args.client_reference}`).digest('hex').slice(0, 48)}`;
const AGENT = { PAYMENT_PENDING: 'awaiting_payment', CREATED: 'awaiting_payment', PUBLISHED: 'open', ASSIGNED: 'assigned', IN_PROGRESS: 'in_progress', DELIVERED: 'delivered', COMPLETED: 'completed', CANCELED: 'canceled' };

/**
 * In-process port over the simulated API with the same observable behaviour as the real MCP server (preview makes no call,
 * create sends an Idempotency-Key derived from client_reference, errors carry stable codes). Used by unit tests; the real MCP
 * process is exercised by the integration tests.
 */
export class FakePort {
  constructor(sim, key = [...sim.keys.keys()][0]) {
    this.sim = sim;
    this.key = key;
    this.calls = [];
    this.drift = null; // set to an Error to simulate contract drift
    this.transportDown = false;
  }

  #send(tool, method, path, body, headers = {}) {
    assertCallable(tool);
    this.calls.push(tool);
    if (this.transportDown) throw new PortError('NETWORK_ERROR', 'transport down', { retryable: true });
    const res = this.sim.handle(method, path, { authorization: `Bearer ${this.key}`, ...headers }, body ? JSON.stringify(body) : undefined);
    if (res.drop) throw new PortError('NETWORK_ERROR', 'connection reset after the backend accepted', { retryable: true });
    if (res.status >= 400) {
      const e = j(res) ?? {};
      throw new PortError(e.code ?? `HTTP_${res.status}`, e.error ?? 'error', { retryable: res.status >= 500 || res.status === 429, httpStatus: res.status, source: 'aiworkpay_api' });
    }
    return res;
  }

  async discover() { if (this.drift) throw this.drift instanceof ContractDriftError ? this.drift : new ContractDriftError([String(this.drift.message)]); return { ok: true, tools: 13 }; }

  async account() {
    const a = j(this.#send('get_account', 'GET', '/api/account'));
    const eff = Math.min(...[a.limits.maxMissionBudget, a.usage.remainingThisMonth].filter((v) => v !== null));
    return { scopes: a.key.scopes, canApprove: a.key.scopes.includes('missions:approve'), maxMissionBudget: a.limits.maxMissionBudget, monthlyBudget: a.limits.monthlyBudget, remainingThisMonth: a.usage.remainingThisMonth, effectiveMaxBudget: eff, canCreateNow: a.key.scopes.includes('missions:write') };
  }

  async preview(args) { assertCallable('create_mission'); this.calls.push('create_mission:preview'); return { status: 'preview', created: false, charged: false, mission: { title: args.title, budget: args.budget, currency: args.currency }, payment: 'A Stripe payment page will be returned; a human must pay it.' }; }

  async create(args) {
    const body = { title: args.title, description: `${args.type}\n${args.instructions}`, budget: args.budget, currency: args.currency, deadline: args.deadline, priority: args.priority.toUpperCase(), paymentMode: 'checkout' };
    const res = this.#send('create_mission', 'POST', '/api/missions', body, { 'idempotency-key': ref(args) });
    const out = j(res);
    return { missionId: out.mission.id, status: AGENT[out.mission.status], alreadyExisted: res.headers['Idempotent-Replayed'] === 'true', paymentUrl: out.payment?.url ?? null, paymentUrlExpiresAt: out.payment?.expiresAt ?? null };
  }

  async status(id) { const m = j(this.#send('get_mission_status', 'GET', `/api/missions/${id}`)); return { status: AGENT[m.status] ?? `unknown:${m.status}`, nextAction: '', isPastDeadline: false }; }

  async result(id) {
    const m = j(this.#send('get_mission_result', 'GET', `/api/missions/${id}`));
    if (!['DELIVERED', 'COMPLETED'].includes(m.status)) return { available: false, status: AGENT[m.status] };
    const proofs = (m.attachments ?? []).filter((a) => a.kind === 'PROOF').map((a) => ({ proof_id: a.id, source: a.source, filename: a.filename, mime_type: a.mimeType, size_bytes: a.size, virus_scan: a.source === 'upload' ? (a.scanStatus === 'CLEAN' ? 'clean' : 'not_scanned') : 'not_applicable', url: a.source === 'link' ? a.url : undefined }));
    return { available: true, status: AGENT[m.status], validated: m.status === 'COMPLETED', deliveredAt: m.deliveredAt, note: m.resultNote, data: m.resultData, proofs };
  }

  async proof(id, pid) {
    const res = this.#send('get_proof_file', 'GET', `/api/missions/${id}/proofs/${pid}`);
    return { meta: {}, bytes: Buffer.from(res.body), mimeType: res.headers['content-type'] };
  }

  async cancel(id) { const out = j(this.#send('cancel_mission', 'POST', `/api/missions/${id}/cancel`)); return { status: AGENT[out.mission.status] }; }

  async close() {}
}
