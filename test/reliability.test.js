import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FileStore, SupabaseStore } from '../src/store/index.js';
import { JobQueue } from '../src/queue.js';
import { planMission } from '../src/core.js';
import { Cto } from '../src/cto.js';
import { startFakePostgrest } from '../testkit/fake-postgrest.js';
import {
  tmpDir, makeRepo, write, scriptedRunner, PLAN, GOOD_SLUG, SLUG_TEST, trustedFixtureTests
} from '../testkit/fixtures.js';

// Regression tests for the defects found by the 2026-10-26 audit (docs/AUDIT_2026-10-26.md, section "Constats").

async function queueSetup(opts = {}) {
  const store = new FileStore(tmpDir('cto-rel-'));
  const queue = new JobQueue({ store, leaseMs: 1000, maxFailures: 3, maxConcurrent: 2, backoffMs: 10, ...opts });
  const plan = planMission('Do the thing', 'owner/repo');
  const { tasks, ...mission } = plan;
  await store.insert('missions', { ...mission, status: 'approved' });
  for (const t of tasks) await queue.enqueue(t);
  return { store, queue, mission, architect: tasks[0] };
}

// ------------------------------------------------------------------ D1 fencing

test('D1: a stale worker cannot move or fail a task that now belongs to another attempt', async () => {
  const { store, queue, architect } = await queueSetup();
  const first = await queue.claimNext({ workerId: 'A', now: 1000 });
  assert.equal(first.id, architect.id);
  // Worker A stalls; its lease expires and the task is recovered, then claimed by worker B.
  const recovered = await queue.recoverExpired(1000 + 5000);
  assert.deepEqual(recovered.map((r) => r.outcome), ['requeued']);
  const second = await queue.claimNext({ workerId: 'B', now: 1000 + 5000 + 100 });
  assert.equal(second.worker_id, 'B');
  assert.equal(second.attempts, 2);

  // A wakes up late with its old fence: nothing may change.
  const fenceA = { workerId: 'A', attempt: first.attempts };
  assert.equal(await queue.toReview(architect.id, {}, fenceA), null, 'stale toReview must be refused');
  assert.equal(await queue.retryOrFail(architect.id, 'late crash', Date.now(), fenceA), null, 'stale retry must be refused');
  const current = await store.get('tasks', architect.id);
  assert.equal(current.status, 'running');
  assert.equal(current.worker_id, 'B');

  // The rightful owner still works.
  const ok = await queue.toReview(architect.id, {}, { workerId: 'B', attempt: second.attempts });
  assert.equal(ok.status, 'review');
});

test('D1: heartbeat reports a lost lease so the worker can stop', async () => {
  const { queue, architect } = await queueSetup();
  const first = await queue.claimNext({ workerId: 'A', now: 1000 });
  await queue.recoverExpired(10000);
  await queue.claimNext({ workerId: 'B', now: 10100 });
  assert.equal(await queue.heartbeat(architect.id, 'A', 10200, first.attempts), null);
  assert.ok(await queue.heartbeat(architect.id, 'B', 10200, 2));
});

// ------------------------------------------------------------ D2 concurrency

test('D2: two workers claiming at the same instant never exceed the concurrency limit', async () => {
  const store = new FileStore(tmpDir('cto-rel-'));
  const q1 = new JobQueue({ store, maxConcurrent: 1, leaseMs: 60000 });
  const q2 = new JobQueue({ store, maxConcurrent: 1, leaseMs: 60000 });
  for (let i = 0; i < 2; i += 1) {
    const { tasks, ...mission } = planMission(`Mission ${i}`, 'owner/repo');
    await store.insert('missions', { ...mission, status: 'approved' });
    await q1.enqueue(tasks[0]);
  }
  const [a, b] = await Promise.all([q1.claimNext({ workerId: 'A' }), q2.claimNext({ workerId: 'B' })]);
  assert.equal([a, b].filter(Boolean).length, 1, 'exactly one worker wins the single slot');
  assert.equal((await store.list('tasks', { status: 'running' })).length, 1);
  assert.equal((await store.list('tasks', { status: 'queued' })).length, 1, 'the loser is back in the queue');
});

test('D2: a rolled-back over-claim releases its budget reservation', async () => {
  const store = new FileStore(tmpDir('cto-rel-'));
  const q1 = new JobQueue({ store, maxConcurrent: 1, leaseMs: 60000 });
  const q2 = new JobQueue({ store, maxConcurrent: 1, leaseMs: 60000 });
  for (let i = 0; i < 2; i += 1) {
    const { tasks, ...mission } = planMission(`Mission ${i}`, 'owner/repo');
    await store.insert('missions', { ...mission, status: 'approved' });
    await q1.enqueue(tasks[0]);
  }
  const created = [];
  const released = [];
  const accept = async () => { const r = { reservation_id: randomUUID(), reserved_usd: 0.5 }; created.push(r.reservation_id); return r; };
  const release = async (_task, r) => released.push(r.reservation_id);
  const results = await Promise.all([
    q1.claimNext({ workerId: 'A', accept, release }),
    q2.claimNext({ workerId: 'B', accept, release })
  ]);
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.ok(!released.includes(winners[0].reservation_id), 'the surviving claim keeps its reservation');
  assert.deepEqual(created.filter((id) => !released.includes(id)), [winners[0].reservation_id],
    'every reservation that did not end in a surviving claim was handed back');
});

// ------------------------------------------------------------- D3 pagination

test('D3: SupabaseStore.list returns every row even when the API caps a response', async (t) => {
  const pg = await startFakePostgrest({ maxRows: 50 });
  t.after(pg.close);
  const store = new SupabaseStore({ url: pg.url, serviceRoleKey: pg.apiKey });
  const missionId = randomUUID();
  await store.insert('missions', { id: missionId, status: 'running' });
  for (let i = 0; i < 120; i += 1) await store.insert('costs', { id: randomUUID(), mission_id: missionId, usd: 0.01, n: i });
  const rows = await store.list('costs', { mission_id: missionId });
  assert.equal(rows.length, 120, 'rows beyond the API cap must not be silently dropped');
  assert.deepEqual(rows.map((r) => r.n), Array.from({ length: 120 }, (_, i) => i), 'order is stable across pages');
});

// ------------------------------------------------------ D4 crash windows

function ctoSetup(t, steps = {}) {
  const repo = makeRepo();
  const root = tmpDir('cto-rel-cto-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new FileStore(path.join(root, 'data'));
  const runner = scriptedRunner({ architect: [async () => ({ result: PLAN })], ...steps });
  const cto = new Cto({
    store, runner, repoPath: repo, workspacesDir: path.join(root, 'work'), testRunner: trustedFixtureTests,
    limits: { backoffMs: 1, maxCorrections: 1, reconcileGraceMs: 0 }
  });
  return { cto, store, runner };
}

const backendGood = async ({ cwd }) => {
  write(cwd, 'src/slug.js', GOOD_SLUG);
  write(cwd, 'test/slug.test.js', SLUG_TEST);
  return { result: 'ok' };
};

test('D4: a crash between recording the architecture approval and releasing the backend is repaired on restart', async (t) => {
  const { cto, store } = ctoSetup(t, { backend: [backendGood] });
  const m = await cto.createMission({ objective: 'Implement slugify', project: 'owner/repo' });
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  assert.equal((await cto.getMission(m.id)).status, 'awaiting_owner');
  // Simulate the crash: approval row + mission 'running' were written, the backend was never queued.
  await store.insert('approvals', { id: randomUUID(), mission_id: m.id, kind: 'architecture', decision: 'approve', by: 'owner', at: new Date().toISOString() });
  await store.update('missions', m.id, { status: 'running' });
  const backend = (await store.list('tasks', { mission_id: m.id })).find((x) => x.role === 'backend');
  assert.equal(backend.status, 'waiting');

  await cto.drain(); // a restarted CTO only calls tick/drain
  const after = await cto.getMission(m.id);
  assert.equal(after.tasks.find((x) => x.role === 'backend').status, 'done', 'backend must have been released and run');
  assert.equal(after.status, 'review');
});

test('D4: a crash between finishing the architect and asking for the architecture approval is repaired', async (t) => {
  const { cto, store } = ctoSetup(t, { backend: [backendGood] });
  const m = await cto.createMission({ objective: 'Implement slugify', project: 'owner/repo' });
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  await store.update('missions', m.id, { status: 'running' }); // as if the crash hit before awaiting_owner
  await cto.drain();
  assert.equal((await cto.getMission(m.id)).status, 'awaiting_owner');
  const events = (await store.list('events', { mission_id: m.id })).filter((e) => e.type === 'approval_requested');
  assert.equal(events.length, 1);
});

test('D4: a crash after the last reviewer finished still reaches the owner', async (t) => {
  const { cto, store } = ctoSetup(t, { backend: [backendGood] });
  const m = await cto.createMission({ objective: 'Implement slugify', project: 'owner/repo' });
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  await cto.approve(m.id, { kind: 'architecture', decision: 'approve' });
  await cto.drain();
  assert.equal((await cto.getMission(m.id)).status, 'review');
  await store.update('missions', m.id, { status: 'running' }); // crash before #decideAfterReviews recorded its outcome
  await cto.drain();
  assert.equal((await cto.getMission(m.id)).status, 'review');
});

// --------------------------------------------------- D5 approval idempotence

test('D5: submitting the same approval twice at once records one decision and one transition', async (t) => {
  const { cto, store } = ctoSetup(t);
  const m = await cto.createMission({ objective: 'Implement slugify', project: 'owner/repo' });
  const results = await Promise.allSettled([
    cto.approve(m.id, { kind: 'mission', decision: 'approve' }),
    cto.approve(m.id, { kind: 'mission', decision: 'approve' })
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const approvals = await store.list('approvals', { mission_id: m.id });
  assert.equal(approvals.filter((a) => a.kind === 'mission').length, 1, 'no duplicate approval row');
  assert.equal((await cto.getMission(m.id)).status, 'approved');
});

test('D5: an approval keeps the credential fingerprint that made it, never the credential', async (t) => {
  const { cto, store } = ctoSetup(t);
  const m = await cto.createMission({ objective: 'Implement slugify', project: 'owner/repo' });
  await cto.approve(m.id, { kind: 'mission', decision: 'approve', by: 'owner', credentialId: 'a1b2c3d4' });
  const [approval] = await store.list('approvals', { mission_id: m.id });
  assert.equal(approval.credential_id, 'a1b2c3d4');
});

// ------------------------------------------- D1 at CTO level: a stalled agent is stopped

test('D1: an agent whose lease was recovered is stopped and cannot overwrite the new attempt', async (t) => {
  const stalled = async (opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { cancelled: true })), { once: true });
  });
  const repo = makeRepo();
  const root = tmpDir('cto-rel-lease-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new FileStore(path.join(root, 'data'));
  const runner = scriptedRunner({ architect: [stalled, async () => ({ result: PLAN })] });
  const cto = new Cto({
    store, runner, repoPath: repo, workspacesDir: path.join(root, 'work'), testRunner: trustedFixtureTests,
    limits: { backoffMs: 1, leaseMs: 600, reconcileGraceMs: 0 }
  });
  const keepAlive = setInterval(() => {}, 50); // the CTO's heartbeat timer is unref'd by design
  t.after(() => clearInterval(keepAlive));
  const m = await cto.createMission({ objective: 'Implement slugify', project: 'owner/repo' });
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.tick();
  for (let i = 0; i < 100 && runner.calls.length < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
  const architect = (await store.list('tasks', { mission_id: m.id })).find((x) => x.role === 'architect');
  // The lease expires while the first attempt is still "running" (stalled worker).
  await store.update('tasks', architect.id, { lease_expires_at: 1 });
  assert.deepEqual((await cto.queue.recoverExpired()).map((r) => r.outcome), ['requeued']);

  await Promise.all([...cto.inflight]); // the stale attempt notices the lost lease and stops
  const events = (await store.list('events', { mission_id: m.id })).map((e) => e.type);
  assert.ok(events.includes('lease_lost'), 'stale attempt reports the lost lease');
  assert.ok(!events.includes('task_cancelled'), 'a lost lease is not a cancellation');
  assert.equal((await store.get('tasks', architect.id)).status, 'queued', 'the stale attempt did not touch the task');

  await cto.drain();
  const after = await cto.getMission(m.id);
  assert.equal(after.status, 'awaiting_owner');
  assert.equal(after.tasks.find((x) => x.role === 'architect').attempts, 2);
  assert.equal(after.reports.filter((r) => r.role === 'architect' && r.verdict === 'accepted').length, 1);
});

// ------------------------------------------------ D6 escalation can be resolved

test('D6: after an escalation the owner can resume the mission; the failed task gets a fresh attempt budget', async (t) => {
  const crash = async () => { throw new Error('agent crashed'); };
  const { cto, store } = ctoSetup(t, { backend: [crash, crash, crash, backendGood] });
  const m = await cto.createMission({ objective: 'Implement slugify', project: 'owner/repo', budgetUsd: 10 });
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  await cto.approve(m.id, { kind: 'architecture', decision: 'approve' });
  await cto.drain();
  let state = await cto.getMission(m.id);
  assert.equal(state.status, 'blocked');
  assert.equal(state.tasks.find((x) => x.role === 'backend').status, 'failed');

  // Raising the budget alone used to leave the failed task stranded forever.
  await assert.rejects(() => cto.resumeMission(randomUUID(), {}), /not found/i);
  await cto.resumeMission(m.id, { by: 'owner', credentialId: 'c0ffee00', note: 'retry after fixing the agent' });
  await cto.drain();
  state = await cto.getMission(m.id);
  assert.equal(state.status, 'review', 'the retried backend passed verification and both reviewers ran');
  assert.deepEqual(state.blockers, []);
  const resumed = (await store.list('events', { mission_id: m.id })).find((e) => e.type === 'mission_resumed');
  assert.equal(resumed.actor, 'owner');
  assert.equal(resumed.detail.credential_id, 'c0ffee00');
  assert.equal(resumed.detail.requeued.length, 1);
  await assert.rejects(() => cto.resumeMission(m.id, {}), /only a blocked mission/i);
});
