import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { Cto } from '../src/cto.js';
import { FileStore } from '../src/store/index.js';
import { HumanLoop } from '../src/human/delegations.js';
import { AiworkpaySim } from '../testkit/aiworkpay-sim.js';
import { FakePort } from '../testkit/fake-port.js';
import { makeRepo, tmpDir, scriptedRunner } from '../testkit/fixtures.js';

const ADMIN = 'admin-token-0123456789-abcdefghij';
const VIEWER = 'viewer-token-0123456789-abcdefghij';
const KEY = 'awp_sim_cto_key_00000000';
const brief = (over = {}) => ({ type: 'photo', title: 'Photo de la façade', instructions: 'Prendre une photo de la façade, avec la date.', budget: 20, currency: 'EUR', deadline: '2099-01-01T10:00:00+01:00', ...over });

async function boot({ withHuman = true } = {}) {
  const dir = tmpDir('cto-hs-');
  const store = new FileStore(path.join(dir, 'data'));
  const cto = new Cto({ store, runner: scriptedRunner({}), repoPath: makeRepo(), workspacesDir: tmpDir('cto-ws-') });
  const sim = new AiworkpaySim();
  const cfg = { enabled: true, disabledReasons: [], currency: 'EUR', maxPerDelegation: 50, monthlyBudget: 100, maxPerDay: 5, approvalTtlMs: 3600000, pollMinMs: 0, maxSubmitAttempts: 3, quarantineDir: path.join(dir, 'q') };
  const human = withHuman ? new HumanLoop({ store, port: new FakePort(sim, KEY), config: cfg }) : null;
  const server = createServer({ cto, human, adminToken: ADMIN, viewerToken: VIEWER });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { method = body0 => (body0 === undefined ? 'GET' : 'POST'), body, token = ADMIN } = {}) => {
    const m = typeof method === 'function' ? method(body) : method;
    const res = await fetch(base + p, { method: m, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { sim, call, close: () => new Promise((r) => server.close(r)) };
}

test('delegation API: create → approve (hash) → track → deliver → review, owner only, no payment route', async (t) => {
  const { sim, call, close } = await boot();
  t.after(close);
  assert.equal((await call('/api/human/status')).json.enabled, true);

  const bad = await call('/api/delegations', { body: { brief: brief({ instructions: 'const a = require("fs") ; secret awp_abcdef123456' }) } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'INVALID_BRIEF');
  assert.ok(bad.json.problems.length >= 1);

  const created = await call('/api/delegations', { body: { brief: brief() } });
  assert.equal(created.status, 201);
  const d = created.json;
  assert.equal(d.status, 'awaiting_approval');
  assert.equal(sim.created, 0);

  assert.equal((await call(`/api/delegations/${d.id}/approval`, { body: { decision: 'approve', brief_hash: d.brief_hash }, token: VIEWER })).status, 403, 'read-only token cannot approve');
  assert.equal((await call(`/api/delegations/${d.id}/approval`, { body: { decision: 'approve', brief_hash: 'f'.repeat(64) } })).json.code, 'BRIEF_CHANGED');
  const ok = await call(`/api/delegations/${d.id}/approval`, { body: { decision: 'approve', brief_hash: d.brief_hash, note: 'go' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'awaiting_payment');
  assert.ok(ok.json.payment_url);

  const asViewer = await call(`/api/delegations/${d.id}`, { token: VIEWER });
  assert.equal(asViewer.status, 200);
  assert.equal(asViewer.json.payment_url, undefined, 'the payment link is for the owner only');
  assert.ok((await call('/api/delegations', { token: VIEWER })).json.every((x) => x.payment_url === undefined));

  const id = ok.json.remote.mission_id;
  sim.ownerPays(id); sim.workerAccepts(id);
  assert.equal((await call(`/api/delegations/${d.id}/refresh`, { body: {} })).json.status, 'assigned');
  sim.workerDelivers(id, { note: 'Fait.', proofs: [] });
  const delivered = await call(`/api/delegations/${d.id}/refresh`, { body: {} });
  assert.equal(delivered.json.status, 'delivered');
  assert.equal(delivered.json.result.risk, 'none');
  assert.equal((await call(`/api/delegations/${d.id}/review`, { body: { verdict: 'acceptable' }, token: VIEWER })).status, 403);
  assert.equal((await call(`/api/delegations/${d.id}/review`, { body: { verdict: 'nonsense' } })).json.code, 'INVALID_VERDICT');
  assert.equal((await call(`/api/delegations/${d.id}/review`, { body: { verdict: 'needs_changes', note: 'photo floue' } })).json.review.verdict, 'needs_changes');
  assert.ok(!sim.requests.some((r) => /\/(approve|request-changes)$/.test(r.path)));
  assert.equal((await call('/api/delegations/not-an-id')).status, 400);
});

test('delegation API: cancel and refusal paths; disabled when not configured', async (t) => {
  const { call, close } = await boot();
  t.after(close);
  const d = (await call('/api/delegations', { body: { brief: brief() } })).json;
  assert.equal((await call(`/api/delegations/${d.id}/cancel`, { body: {}, token: VIEWER })).status, 403);
  assert.equal((await call(`/api/delegations/${d.id}/cancel`, { body: {} })).json.status, 'canceled');
  assert.equal((await call(`/api/delegations/${d.id}/cancel`, { body: {} })).json.code, 'ALREADY_FINAL');
  assert.equal((await call('/api/delegations', { body: { brief: brief({ budget: 999 }) } })).json.code, 'CEILING_EXCEEDED');
  const off = await boot({ withHuman: false });
  t.after(off.close);
  assert.equal((await off.call('/api/delegations')).status, 404);
  assert.equal((await off.call('/api/human/status')).json.enabled, false);
});
