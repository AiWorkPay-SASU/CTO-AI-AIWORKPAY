import { trustedFixtureTests } from '../testkit/fixtures.js';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cto } from '../src/cto.js';
import { createServer } from '../src/server.js';
import { FileStore } from '../src/store/index.js';
import { cachedPreflight, runPreflight } from '../src/preflight.js';
import { validateScope, outsideScope, validateExternalRef } from '../src/core.js';
import { makeRepo, tmpDir, write, scriptedRunner, PLAN, GOOD_SLUG, SLUG_TEST } from '../testkit/fixtures.js';

// Open Cortex Code integration contract: idempotent missions, write scope, BLOCKED runtime, resume, enriched report.

const OBJECTIVE = 'Add a slugify(text) helper with tests';
const REF = '3f2b8c1e-5a9d-4e0f-9b1c-0123456789ab';
const architectOk = async () => ({ result: PLAN });
const backendGood = async ({ cwd }) => {
  write(cwd, 'src/slug.js', GOOD_SLUG);
  write(cwd, 'test/slug.test.js', SLUG_TEST);
  return { result: 'Implemented slugify.' };
};
const backendOutOfScope = async ({ cwd }) => {
  write(cwd, 'src/slug.js', GOOD_SLUG);
  write(cwd, 'test/slug.test.js', SLUG_TEST);
  write(cwd, 'docs/notes.md', 'outside scope\n');
  return { result: 'Implemented slugify and notes.' };
};

const backendFixed = async ({ cwd }) => {
  fs.rmSync(path.join(cwd, 'docs'), { recursive: true, force: true });
  return backendGood({ cwd });
};

function setup(runner, extra = {}) {
  const store = new FileStore(tmpDir('cto-data-'));
  const cto = new Cto({
    testRunner: trustedFixtureTests, store, runner, repoPath: makeRepo(), workspacesDir: tmpDir('cto-ws-'),
    limits: { backoffMs: 5, leaseMs: 1000, maxCorrections: 2 }, ...extra
  });
  return { store, cto };
}
const create = (cto, extra = {}) => cto.createMission({ objective: OBJECTIVE, project: 'owner/repo', ...extra });
const readyPreflight = { ok: true, status: 'READY', blockers: [], checks: [], isolation: 'bubblewrap-namespaces', container_certified: false };
const blockedPreflight = { ok: false, status: 'BLOCKED', blockers: ['bubblewrap_isolation: bwrap not found'], checks: [], isolation: 'unavailable', container_certified: false };

test('external_ref makes mission creation idempotent, even for concurrent retries', async () => {
  const { store, cto } = setup(scriptedRunner({ architect: [architectOk], backend: [backendGood] }));
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => create(cto, { externalRef: REF })));
  assert.equal(a.id, b.id);
  assert.equal(a.id, c.id);
  assert.equal((await store.list('missions')).length, 1);
  assert.equal((await store.list('tasks')).length, 4, 'one set of tasks, not three');
  const again = await create(cto, { externalRef: REF, objective: 'a different objective is ignored for the same key' });
  assert.equal(again.id, a.id);
  assert.equal(again.objective, OBJECTIVE);
  assert.equal((await cto.getMissionByRef(REF)).id, a.id);
  assert.equal(await cto.getMissionByRef('unknown-ref-00000'), null);
  const other = await create(cto, { externalRef: 'another-ref-00000000' });
  assert.notEqual(other.id, a.id);
});

test('external_ref and scope are validated', () => {
  assert.throws(() => validateExternalRef('short'), /external_ref/);
  assert.throws(() => validateExternalRef('has space in it 12345'), /external_ref/);
  assert.equal(validateExternalRef(null), null);
  assert.deepEqual(validateScope(['src/', './test']), ['src', 'test']);
  for (const bad of [[], ['/etc'], ['../x'], ['a/../b'], ['a\\b'], [''], ['a//b'], 'src', Array(21).fill('a')]) {
    assert.throws(() => validateScope(bad), /scope|Invalid scope/, JSON.stringify(bad));
  }
  assert.deepEqual(outsideScope(['src/a.js', 'srcx/b.js', 'docs/c.md', 'test/t.js'], ['src', 'test']), ['srcx/b.js', 'docs/c.md']);
  assert.deepEqual(outsideScope(['anything'], null), []);
});

test('write scope: a change outside the scope is rejected by the CTO and sent back for correction', async () => {
  const runner = scriptedRunner({ architect: [architectOk], backend: [backendOutOfScope, backendFixed] });
  const { cto } = setup(runner);
  const mission = await create(cto, { scope: ['src', 'test'] });
  await cto.approve(mission.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  await cto.approve(mission.id, { kind: 'architecture', decision: 'approve' });
  await cto.drain();

  const backendCalls = runner.calls.filter((c) => c.role === 'backend');
  assert.match(backendCalls[0].instruction, /<allowed_scope>[\s\S]*- src[\s\S]*- test/);
  assert.equal(backendCalls.length, 2, 'the out-of-scope attempt is corrected');
  assert.match(backendCalls[1].instruction, /outside the mission scope[\s\S]*docs\/notes\.md/);
  const done = await cto.getMission(mission.id);
  assert.equal(done.status, 'review');
  const report = await cto.consolidatedReport(mission.id);
  assert.deepEqual(report.git.files.sort(), ['src/slug.js', 'test/slug.test.js']);
  assert.deepEqual(report.mission.scope, ['src', 'test']);
});

test('report exposes git evidence, cost by role and acceptance data for Open Cortex Code', async () => {
  const { cto } = setup(scriptedRunner({ architect: [architectOk], backend: [backendGood] }));
  const mission = await create(cto, { externalRef: REF });
  await cto.approve(mission.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  await cto.approve(mission.id, { kind: 'architecture', decision: 'approve' });
  await cto.drain();
  const report = await cto.consolidatedReport(mission.id);
  assert.equal(report.mission.external_ref, REF);
  assert.match(report.git.commit, /^[0-9a-f]{40}$/);
  assert.match(report.git.base_commit, /^[0-9a-f]{40}$/);
  assert.match(report.git.branch, /^cto\//);
  assert.equal(report.git.pushed, false);
  assert.equal(report.git.merged, false);
  assert.deepEqual(Object.keys(report.cost_by_role).sort(), ['architect', 'backend', 'qa', 'security']);
  assert.ok(Object.values(report.cost_by_role).every((v) => v > 0));
  assert.deepEqual(report.pending_approvals, ['completion']);
});

test('a runtime without working isolation is BLOCKED: no agent is started, nothing is simulated', async () => {
  let pf = blockedPreflight;
  const runner = scriptedRunner({ architect: [architectOk], backend: [backendGood] });
  const { store, cto } = setup(runner, { preflight: async () => pf });
  const mission = await create(cto);
  await cto.approve(mission.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  assert.equal(runner.calls.length, 0, 'no Claude call without isolation');
  const blocked = await cto.getMission(mission.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.blockers[0], /^BLOCKED: bubblewrap_isolation/);
  assert.ok((await store.list('events', { mission_id: mission.id })).some((e) => e.type === 'escalation'));

  // Still blocked: resume refuses and says why.
  await assert.rejects(cto.resume(mission.id), (e) => e.blocked === true && /BLOCKED: bubblewrap_isolation/.test(e.message));
  assert.equal((await cto.getMission(mission.id)).status, 'blocked');

  // Runtime fixed: resume releases the mission and the work runs exactly once.
  pf = readyPreflight;
  const resumed = await cto.resume(mission.id);
  assert.equal(resumed.status, 'running');
  await cto.drain();
  assert.equal(runner.calls.filter((c) => c.role === 'architect').length, 1);
  assert.equal((await cto.getMission(mission.id)).status, 'awaiting_owner');

  // Resuming a mission that is not blocked is a no-op: it must not queue anything twice.
  await cto.resume(mission.id);
  await cto.drain();
  assert.equal(runner.calls.filter((c) => c.role === 'architect').length, 1);
});

test('resume refuses a mission whose task failed permanently, and a finished mission', async () => {
  const { store, cto } = setup(scriptedRunner({ architect: [architectOk], backend: [backendGood] }));
  const mission = await create(cto);
  await cto.approve(mission.id, { kind: 'mission', decision: 'approve' });
  const tasks = await store.list('tasks', { mission_id: mission.id });
  const architect = tasks.find((t) => t.role === 'architect');
  await store.update('tasks', architect.id, { status: 'failed' });
  await store.update('missions', mission.id, { status: 'blocked', blockers: ['x'] });
  await assert.rejects(cto.resume(mission.id), /failed permanently/);
  await cto.cancelMission(mission.id);
  await assert.rejects(cto.resume(mission.id), /already cancelled/);
});

test('real preflight probes the actual runtime (Linux + Node + bubblewrap) and caches', async () => {
  const pf = await runPreflight({ claudeCommand: 'definitely-not-a-claude-binary' });
  assert.equal(pf.container_certified, false);
  const byName = Object.fromEntries(pf.checks.map((c) => [c.name, c]));
  assert.equal(byName.node.ok, true);
  assert.equal(byName.claude_cli.ok, false, 'a missing CLI is reported, not assumed');
  assert.equal(pf.ok, false);
  assert.equal(pf.status, 'BLOCKED');
  assert.ok(pf.blockers.some((b) => b.startsWith('claude_cli')));
  let runs = 0;
  const cached = cachedPreflight(async () => ({ ok: true, n: ++runs }), 60000);
  await cached(); await cached();
  assert.equal(runs, 1);
  await cached({ force: true });
  assert.equal(runs, 2);
});

test('HTTP: idempotent create, runtime, resume and the enriched agent list', async (t) => {
  const { cto } = setup(scriptedRunner({ architect: [architectOk], backend: [backendGood] }), { preflight: async () => readyPreflight });
  const token = 'owner-token-0123456789-abcdefghij';
  const server = createServer({ cto, adminToken: token });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(base + path, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, json: await res.json() };
  };

  const first = await call('/api/missions', { objective: OBJECTIVE, project: 'owner/repo', external_ref: REF, scope: ['src'] });
  assert.equal(first.status, 201);
  const replay = await call('/api/missions', { objective: OBJECTIVE, project: 'owner/repo', external_ref: REF, scope: ['src'] });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, first.json.id);
  assert.equal(replay.json.idempotent_replay, true);
  assert.equal((await call('/api/missions')).json.length, 1);
  assert.equal((await call(`/api/missions?external_ref=${REF}`)).json[0].id, first.json.id);
  assert.deepEqual((await call('/api/missions?external_ref=nothing-here-0000')).json, []);
  assert.equal((await call('/api/missions', { objective: OBJECTIVE, project: 'owner/repo', scope: ['../x'] })).status, 400);

  const runtime = await call('/api/runtime');
  assert.equal(runtime.status, 200);
  assert.equal(runtime.json.preflight.ok, true);
  assert.ok(runtime.json.repo_path.startsWith('/'));
  const agents = (await call('/api/agents')).json;
  assert.deepEqual(agents.map((a) => a.role), ['architect', 'backend', 'qa', 'security']);
  assert.ok(agents.every((a) => a.state === 'idle'));

  assert.equal((await call(`/api/missions/${first.json.id}/resume`, {})).status, 200, 'resume of a non-blocked mission is a no-op');
});
