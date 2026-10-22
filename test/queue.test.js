import test from 'node:test';
import assert from 'node:assert/strict';
import { FileStore } from '../src/store/index.js';
import { JobQueue } from '../src/queue.js';
import { planMission } from '../src/core.js';
import { tmpDir } from '../testkit/fixtures.js';

async function setup(opts = {}) {
  const store = new FileStore(tmpDir('cto-queue-'));
  const queue = new JobQueue({ store, leaseMs: 1000, maxFailures: 3, maxConcurrent: 2, backoffMs: 10, ...opts });
  const plan = planMission('Do the thing', 'owner/repo');
  const { tasks, ...mission } = plan;
  await store.insert('missions', mission);
  for (const t of tasks) await queue.enqueue(t);
  return { store, queue, mission, architect: tasks[0], backend: tasks[1] };
}

const approve = (store, mission, kind) =>
  store.insert('approvals', { id: crypto.randomUUID(), mission_id: mission.id, kind, decision: 'approve', by: 'owner' });

test('nothing is dispatched before the mission is approved', async () => {
  const { queue } = await setup();
  assert.equal(await queue.claimNext({ workerId: 'w' }), null);
});

test('architect is claimed once the mission is approved; backend stays waiting', async () => {
  const { store, queue, mission, architect } = await setup();
  await store.update('missions', mission.id, { status: 'approved' });
  const claimed = await queue.claimNext({ workerId: 'w1' });
  assert.equal(claimed.id, architect.id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempts, 1);
  assert.ok(claimed.lease_expires_at > Date.now());
  assert.equal(await queue.claimNext({ workerId: 'w2' }), null);
});

test('queue refuses a backend task that is queued without architecture approval or finished dependency', async () => {
  const { store, queue, mission, architect, backend } = await setup();
  await store.update('missions', mission.id, { status: 'running' });
  await store.update('tasks', architect.id, { status: 'done' });
  await store.update('tasks', backend.id, { status: 'queued' }); // promoted by mistake
  assert.equal(await queue.claimNext({ workerId: 'w' }), null, 'no approval recorded');
  await approve(store, mission, 'architecture');
  const claimed = await queue.claimNext({ workerId: 'w' });
  assert.equal(claimed.id, backend.id);
});

test('dependency must be done', async () => {
  const { store, queue, mission, architect, backend } = await setup();
  await store.update('missions', mission.id, { status: 'running' });
  await store.update('tasks', architect.id, { status: 'review' });
  await store.update('tasks', backend.id, { status: 'queued' });
  await approve(store, mission, 'architecture');
  assert.equal(await queue.claimNext({ workerId: 'w' }), null);
});

test('concurrency limit is enforced from persisted state', async () => {
  const { store, queue, mission } = await setup({ maxConcurrent: 1 });
  await store.update('missions', mission.id, { status: 'running' });
  const { tasks: secondTasks, ...secondMission } = planMission('Other', 'owner/repo');
  await store.insert('missions', { ...secondMission, status: 'running' });
  for (const t of secondTasks) await queue.enqueue(t);
  assert.ok(await queue.claimNext({ workerId: 'w' }));
  assert.equal(await queue.claimNext({ workerId: 'w' }), null, 'limit of 1 reached');
});

test('expired lease is recovered after a crash and retried with backoff', async () => {
  const { store, queue, mission, architect } = await setup();
  await store.update('missions', mission.id, { status: 'running' });
  const longAgo = Date.now() - 60000;
  await queue.claimNext({ workerId: 'dead-worker', now: longAgo });
  const recovered = await queue.recoverExpired();
  assert.deepEqual(recovered, [{ id: architect.id, outcome: 'requeued' }]);
  const task = await store.get('tasks', architect.id);
  assert.equal(task.status, 'queued');
  assert.equal(task.failures, 1);
  assert.ok(task.not_before);
  const events = (await store.list('events', { mission_id: mission.id })).map((e) => e.type);
  assert.ok(events.includes('lease_expired'));
});

test('a live lease is not recovered, and heartbeat extends it', async () => {
  const { store, queue, mission, architect } = await setup();
  await store.update('missions', mission.id, { status: 'running' });
  await queue.claimNext({ workerId: 'w' });
  assert.deepEqual(await queue.recoverExpired(), []);
  const before = (await store.get('tasks', architect.id)).lease_expires_at;
  const extended = await queue.heartbeat(architect.id, 'w', Date.now() + 5000);
  assert.ok(extended.lease_expires_at > before);
  assert.equal(await queue.heartbeat(architect.id, 'someone-else'), null);
});

test('repeated failures end in failed, not in an infinite loop', async () => {
  const { store, queue, mission, architect } = await setup({ backoffMs: 1 });
  await store.update('missions', mission.id, { status: 'running' });
  const outcomes = [];
  for (let i = 0; i < 3; i += 1) {
    await store.update('tasks', architect.id, { not_before: null });
    await queue.claimNext({ workerId: 'w' });
    outcomes.push(await queue.retryOrFail(architect.id, 'boom'));
  }
  assert.deepEqual(outcomes, ['requeued', 'requeued', 'failed']);
  assert.equal((await store.get('tasks', architect.id)).status, 'failed');
});

test('backoff delays the retry', async () => {
  const { store, queue, mission } = await setup({ backoffMs: 60000 });
  await store.update('missions', mission.id, { status: 'running' });
  const t = await queue.claimNext({ workerId: 'w' });
  await queue.retryOrFail(t.id, 'boom');
  assert.equal(await queue.claimNext({ workerId: 'w' }), null);
});

test('cancelMission cancels every open task and reports the running ones', async () => {
  const { store, queue, mission, architect, backend } = await setup();
  await store.update('missions', mission.id, { status: 'running' });
  await queue.claimNext({ workerId: 'w' });
  const wasRunning = await queue.cancelMission(mission.id);
  assert.deepEqual(wasRunning, [architect.id]);
  assert.equal((await store.get('tasks', architect.id)).status, 'cancelled');
  assert.equal((await store.get('tasks', backend.id)).status, 'cancelled');
});

test('correction sends a reviewed task back with feedback and counts it', async () => {
  const { store, queue, mission, architect } = await setup();
  await store.update('missions', mission.id, { status: 'running' });
  await queue.claimNext({ workerId: 'w' });
  await queue.toReview(architect.id);
  const back = await queue.requestCorrection(architect.id, 'fix X');
  assert.equal(back.status, 'queued');
  assert.equal(back.corrections, 1);
  assert.equal(back.feedback, 'fix X');
});

test('reopenForRework reopens the done task, resets its reviewers and is idempotent', async () => {
  const { store, queue, mission } = await setup();
  const tasks = await store.list('tasks', { mission_id: mission.id });
  const [architect, backend, qa, security] = tasks;
  await store.update('missions', mission.id, { status: 'running' });
  await store.update('tasks', architect.id, { status: 'done' });
  await store.update('tasks', backend.id, { status: 'done' });
  await store.update('tasks', qa.id, { status: 'done' });
  await store.update('tasks', security.id, { status: 'done' });

  const reopened = await queue.reopenForRework(backend.id, 'fix the injection');
  assert.equal(reopened.status, 'queued');
  assert.equal(reopened.corrections, 1);
  assert.equal(reopened.feedback, 'fix the injection');
  assert.equal((await store.get('tasks', qa.id)).status, 'waiting');
  assert.equal((await store.get('tasks', security.id)).status, 'waiting');
  assert.equal((await store.get('tasks', architect.id)).status, 'done', 'unrelated tasks are untouched');

  assert.equal(await queue.reopenForRework(backend.id, 'again'), null, 'second call is a no-op');
  assert.equal((await store.get('tasks', backend.id)).corrections, 1);
  const events = (await store.list('events', { mission_id: mission.id })).filter((e) => e.type === 'rework_requested');
  assert.equal(events.length, 1);
});
