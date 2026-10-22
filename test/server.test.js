import { trustedFixtureTests } from '../testkit/fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { Cto } from '../src/cto.js';
import { FileStore } from '../src/store/index.js';
import { makeRepo, tmpDir, write, scriptedRunner, PLAN, GOOD_SLUG, SLUG_TEST, ACCEPTANCE } from '../testkit/fixtures.js';

const ADMIN = 'admin-token-0123456789-abcdefghij';
const VIEWER = 'viewer-token-0123456789-abcdefghij';

async function boot(options = {}) {
  const backend = async ({ cwd }) => {
    write(cwd, 'src/slug.js', GOOD_SLUG);
    write(cwd, 'test/slug.test.js', SLUG_TEST);
    return { result: 'done' };
  };
  const runner = scriptedRunner({ architect: [async () => ({ result: PLAN })], backend: [backend] });
  const cto = new Cto({
    testRunner: trustedFixtureTests,
    store: new FileStore(tmpDir('cto-data-')), runner, repoPath: makeRepo(), workspacesDir: tmpDir('cto-ws-'),
    limits: { backoffMs: 5 }
  });
  const server = createServer({ cto, adminToken: ADMIN, viewerToken: VIEWER, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token = ADMIN, headers = {}, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { server, cto, call, runner, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('health is public; everything under /api needs a valid token', async (t) => {
  const { call, close } = await boot();
  t.after(close);
  assert.equal((await call('/health', { token: null })).status, 200);
  assert.equal((await call('/api/missions', { token: null })).status, 401);
  assert.equal((await call('/api/missions', { token: 'wrong' })).status, 401);
  assert.equal((await call('/api/missions', { token: `${ADMIN}x` })).status, 401);
  assert.equal((await call('/api/missions')).status, 200);
  assert.deepEqual((await call('/api/whoami')).json, { role: 'owner' });
  assert.deepEqual((await call('/api/whoami', { token: VIEWER })).json, { role: 'viewer' });
});

test('security headers on API and UI responses', async (t) => {
  const { call, close } = await boot();
  t.after(close);
  const api = await call('/api/missions');
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(api.headers.get('x-frame-options'), 'DENY');
  assert.equal(api.headers.get('cache-control'), 'no-store');
  assert.match(api.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(api.headers.get('access-control-allow-origin'), null, 'no CORS: same-origin only');

  const ui = await call('/', { token: null });
  assert.equal(ui.status, 200);
  assert.match(ui.headers.get('content-type'), /text\/html/);
  assert.match(ui.headers.get('content-security-policy'), /script-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(ui.headers.get('content-security-policy')));
  assert.equal((await call('/ui.js', { token: null })).status, 200);
  assert.equal((await call('/ui.css', { token: null })).status, 200);
  assert.equal((await call('/../package.json', { token: null })).status, 404);
});

test('input validation: JSON, content-type, size, project, ids', async (t) => {
  const { call, close } = await boot();
  t.after(close);
  assert.equal((await call('/api/missions', { method: 'POST', raw: '{bad json' })).status, 400);
  assert.equal((await call('/api/missions', { method: 'POST', raw: '[1,2]' })).status, 400);
  assert.equal((await call('/api/missions', { method: 'POST', raw: 'x', headers: { 'content-type': 'text/plain' } })).status, 415);
  const huge = await call('/api/missions', { method: 'POST', body: { objective: 'a'.repeat(100 * 1024), project: 'o/r' } });
  assert.equal(huge.status, 413);
  assert.equal((await call('/api/missions', { method: 'POST', body: { objective: 'x', project: '../etc' } })).status, 400);
  assert.equal((await call('/api/missions', { method: 'POST', body: { objective: '', project: 'o/r' } })).status, 400);
  assert.equal((await call('/api/missions/not-a-uuid')).status, 400);
  assert.equal((await call('/api/missions/11111111-1111-4111-8111-111111111111')).status, 404);
  assert.equal((await call('/api/nothing')).status, 404);
});

test('viewer token is read-only; cross-origin writes are refused', async (t) => {
  const { call, close } = await boot();
  t.after(close);
  const body = { objective: 'x', project: 'o/r' };
  assert.equal((await call('/api/missions', { method: 'POST', body, token: VIEWER })).status, 403);
  assert.equal((await call('/api/missions', { token: VIEWER })).status, 200);
  assert.equal((await call('/api/missions', { method: 'POST', body, headers: { origin: 'https://evil.example' } })).status, 403);
});

test('rate limiting and failed-auth lockout', async (t) => {
  const limited = await boot({ requestsPerMinute: 5, failedAuthPerMinute: 3 });
  t.after(limited.close);
  const statuses = [];
  for (let i = 0; i < 8; i += 1) statuses.push((await limited.call('/health', { token: null })).status);
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(statuses.at(-1), 429);

  const lock = await boot({ failedAuthPerMinute: 3 });
  t.after(lock.close);
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push((await lock.call('/api/missions', { token: 'bad' })).status);
  assert.deepEqual(results, [401, 401, 401, 429, 429]);
});

test('end to end over HTTP: create, approve, run, validate, report', async (t) => {
  const { call, close, runner } = await boot();
  t.after(close);
  const created = await call('/api/missions', {
    method: 'POST', body: { objective: 'Add slugify helper', project: 'owner/repo', budget_usd: 2, acceptance: ACCEPTANCE }
  });
  assert.equal(created.status, 201);
  const id = created.json.id;
  assert.equal(created.json.status, 'pending_approval');

  // Approvals that do not match the state are refused.
  const early = await call(`/api/missions/${id}/approvals`, { method: 'POST', body: { kind: 'architecture', decision: 'approve' } });
  assert.equal(early.status, 400);
  assert.match(early.json.error, /pending_approval/);

  assert.equal((await call(`/api/missions/${id}/approvals`, { method: 'POST', body: { kind: 'mission', decision: 'approve' } })).status, 200);
  assert.equal((await call(`/api/missions/${id}/run?wait=1`, { method: 'POST', body: {} })).json.status, 'awaiting_owner');
  assert.equal(runner.calls.length, 1);

  await call(`/api/missions/${id}/approvals`, { method: 'POST', body: { kind: 'architecture', decision: 'approve', note: 'ok' } });
  const afterRun = await call(`/api/missions/${id}/run?wait=1`, { method: 'POST', body: {} });
  assert.equal(afterRun.json.status, 'review');

  const events = await call(`/api/missions/${id}/events`);
  assert.ok(events.json.some((e) => e.type === 'approval_recorded' && e.actor === 'owner'));

  const report = await call(`/api/missions/${id}/report`);
  assert.deepEqual(report.json.pending_approvals, ['completion']);
  assert.match(report.json.pull_request_body, /Tests actually executed by the CTO/);
  assert.ok(report.json.commit);

  const agents = await call('/api/agents');
  assert.deepEqual(agents.json.map((a) => a.role), ['architect', 'backend', 'qa', 'security']);

  const final = await call(`/api/missions/${id}/approvals`, { method: 'POST', body: { kind: 'completion', decision: 'approve' } });
  assert.equal(final.json.status, 'completed');
  assert.equal((await call(`/api/missions/${id}/cancel`, { method: 'POST', body: {} })).status, 400, 'terminal missions cannot be cancelled');
});

test('error responses never leak internals or secrets', async (t) => {
  const { call, close } = await boot();
  t.after(close);
  const res = await call('/api/missions', { method: 'POST', body: { objective: `ghp_${'a1B2c3D4e5'.repeat(4)}`, project: 'bad project' } });
  assert.equal(res.status, 400);
  assert.ok(!res.text.includes('a1B2c3D4e5'));
  assert.ok(!/at .*\.js:\d+/.test(res.text), 'no stack trace');
});

test('server refuses to start with weak or duplicated tokens', () => {
  assert.throws(() => createServer({ cto: {}, adminToken: 'short' }), /24\+/);
  assert.throws(() => createServer({ cto: {}, adminToken: ADMIN, viewerToken: ADMIN }), /differ/);
  assert.throws(() => createServer({ cto: {}, adminToken: ADMIN, viewerToken: 'short' }), /24\+/);
});

