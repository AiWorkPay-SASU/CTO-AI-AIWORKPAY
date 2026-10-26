import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Cto } from '../src/cto.js';
import { FileStore } from '../src/store/index.js';
import {
  tmpDir, makeRepo, write, scriptedRunner, PLAN, GOOD_SLUG, SLUG_TEST, trustedFixtureTests
} from '../testkit/fixtures.js';

// Acceptance scenarios on a disposable repository (see docs/RECETTE.md for the scenario -> test map).
// The agents are scripted doubles that really modify the git worktrees; git, the queue and the stores are real.

const CRASH_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testkit', 'crash-worker.js');
const backendGood = async ({ cwd }) => { write(cwd, 'src/slug.js', GOOD_SLUG); write(cwd, 'test/slug.test.js', SLUG_TEST); return { result: 'ok' }; };

test('two CTO workers on the same store: every task runs exactly once and the concurrency limit holds', async (t) => {
  const repo = makeRepo();
  const root = tmpDir('cto-recette-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new FileStore(path.join(root, 'data'));
  let live = 0;
  let peak = 0;
  const tracked = (fn) => async (opts) => {
    live += 1; peak = Math.max(peak, live);
    try { await new Promise((r) => setTimeout(r, 30)); return await fn(opts); } finally { live -= 1; }
  };
  const runner = scriptedRunner({
    architect: [tracked(async () => ({ result: PLAN }))], backend: [tracked(backendGood)],
    qa: [tracked(async () => ({ result: 'ok\n```json\n{"verdict":"pass","findings":[]}\n```' }))],
    security: [tracked(async () => ({ result: 'ok\n```json\n{"verdict":"pass","findings":[]}\n```' }))]
  });
  const make = (workerId) => new Cto({
    store, runner, repoPath: repo, workspacesDir: path.join(root, 'work'), testRunner: trustedFixtureTests, workerId,
    limits: { maxConcurrent: 2, backoffMs: 1, reconcileGraceMs: 0 }
  });
  const [w1, w2] = [make('worker-1'), make('worker-2')];
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const m = await w1.createMission({ objective: `Implement slugify variant ${i}`, project: 'owner/repo', budgetUsd: 10 });
    await w1.approve(m.id, { kind: 'mission', decision: 'approve' });
    ids.push(m.id);
  }
  await Promise.all([w1.drain(), w2.drain()]);
  for (const id of ids) await w1.approve(id, { kind: 'architecture', decision: 'approve' });
  await Promise.all([w1.drain(), w2.drain()]);

  assert.ok(peak <= 2, `never more than maxConcurrent agents at once (peak ${peak})`);
  for (const id of ids) {
    const m = await w1.getMission(id);
    assert.equal(m.status, 'review');
    for (const task of m.tasks) assert.equal(task.attempts, 1, `${task.role} ran exactly once (no double execution)`);
    assert.equal(m.reports.filter((r) => r.verdict === 'accepted').length, 4);
    assert.deepEqual(m.budget_reservations, {}, 'no reservation left behind');
  }
  const leased = (await store.list('events')).filter((e) => e.type === 'task_leased');
  assert.equal(leased.length, 12, '3 missions x 4 tasks, each leased once');
});

test('REAL process kill (SIGKILL) while an agent runs: a new process recovers the lease and finishes the mission', async (t) => {
  const repo = makeRepo();
  const root = tmpDir('cto-recette-kill-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, 'data');
  const wsDir = path.join(root, 'work');
  const marker = path.join(root, 'marker');

  const setup = new Cto({
    store: new FileStore(dataDir), repoPath: repo, workspacesDir: wsDir, testRunner: trustedFixtureTests,
    runner: scriptedRunner({ architect: [async () => ({ result: PLAN })] }), limits: { backoffMs: 1, leaseMs: 400, reconcileGraceMs: 0 }
  });
  const mission = await setup.createMission({ objective: 'Implement slugify', project: 'owner/repo', budgetUsd: 5 });
  await setup.approve(mission.id, { kind: 'mission', decision: 'approve' });

  const child = fork(CRASH_WORKER, [], { env: { ...process.env, DATA_DIR: dataDir, REPO: repo, WS_DIR: wsDir, MARKER: marker }, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 300 && !fs.existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(marker), 'the agent of the doomed worker started');
  child.kill('SIGKILL');
  assert.equal((await exited).signal, 'SIGKILL');

  await new Promise((r) => setTimeout(r, 600)); // the dead worker's lease (400 ms) expires
  const restarted = new Cto({
    store: new FileStore(dataDir), repoPath: repo, workspacesDir: wsDir, testRunner: trustedFixtureTests, workerId: 'new-process',
    runner: scriptedRunner({ architect: [async () => ({ result: PLAN })] }), limits: { backoffMs: 1, leaseMs: 400, reconcileGraceMs: 0 }
  });
  await restarted.drain();
  const after = await restarted.getMission(mission.id);
  assert.equal(after.status, 'awaiting_owner');
  const architect = after.tasks.find((x) => x.role === 'architect');
  assert.equal(architect.attempts, 2, 'attempt 1 died with the process, attempt 2 completed');
  assert.equal(architect.worker_id, 'new-process');
  const events = (await restarted.store.list('events', { mission_id: mission.id })).map((e) => e.type);
  assert.ok(events.includes('lease_expired'));
  assert.ok(after.estimated_usd > 0, 'the killed attempt is charged as an explicit estimate, never refunded');
});
