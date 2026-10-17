import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Cto } from '../src/cto.js';
import { FileStore } from '../src/store/index.js';
import {
  makeRepo, tmpDir, write, head, branches, scriptedRunner, PLAN, GOOD_SLUG, BUGGY_SLUG, SLUG_TEST, ACCEPTANCE,
  PASS_REVIEW, reviewWith
} from '../testkit/fixtures.js';

const OBJECTIVE = 'Add a slugify(text) helper with tests';
const architectOk = async () => ({ result: PLAN });
const backendGood = async ({ cwd }) => {
  write(cwd, 'src/slug.js', GOOD_SLUG);
  write(cwd, 'test/slug.test.js', SLUG_TEST);
  return { result: 'Implemented slugify; node --test passes.' };
};
const backendBuggy = async ({ cwd }) => {
  write(cwd, 'src/slug.js', BUGGY_SLUG);
  write(cwd, 'test/slug.test.js', SLUG_TEST); // passes with the buggy code: only the owner's acceptance test can catch it
  return { result: 'All tests pass, done.' };
};

function setup(runner, limits = {}) {
  const repo = makeRepo();
  const dataDir = tmpDir('cto-data-');
  const store = new FileStore(dataDir);
  const cto = new Cto({
    store, runner, repoPath: repo, workspacesDir: tmpDir('cto-ws-'),
    limits: { backoffMs: 5, leaseMs: 1000, maxCorrections: 2, ...limits }
  });
  return { repo, dataDir, store, cto };
}

const create = (cto, extra = {}) => cto.createMission({ objective: OBJECTIVE, project: 'owner/repo', ...extra });
const types = async (store, id) => (await store.list('events', { mission_id: id })).map((e) => e.type);

test('full loop: objective -> delegation -> execution -> report -> CTO control -> correction -> validation', async () => {
  const runner = scriptedRunner({ architect: [architectOk], backend: [backendBuggy, backendGood] });
  const { repo, store, cto } = setup(runner);
  const mainHead = head(repo);
  const mission = await create(cto, { acceptance: ACCEPTANCE });
  assert.equal(mission.status, 'pending_approval');

  // Nothing runs before the owner approves the mission.
  await cto.drain();
  assert.equal(runner.calls.length, 0);
  await cto.approve(mission.id, { kind: 'mission', decision: 'approve' });

  // Architect runs, then the CTO waits for the architecture approval.
  await cto.drain();
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].role, 'architect');
  assert.equal((await cto.getMission(mission.id)).status, 'awaiting_owner');
  const waiting = (await cto.getMission(mission.id)).tasks.find((t) => t.role === 'backend');
  assert.equal(waiting.status, 'waiting', 'backend must not start without the owner approval');

  await cto.approve(mission.id, { kind: 'architecture', decision: 'approve', note: 'plan ok' });
  await cto.drain();

  // Backend: attempt 1 passed its own tests but failed the acceptance tests -> correction -> attempt 2 verified.
  const backendCalls = runner.calls.filter((c) => c.role === 'backend');
  assert.equal(backendCalls.length, 2);
  assert.match(backendCalls[0].instruction, /<approved_plan>/);
  assert.match(backendCalls[1].instruction, /<review_feedback>[\s\S]*acceptance tests failed/i);
  assert.equal(backendCalls[0].cwd, backendCalls[1].cwd, 'same isolated worktree across correction rounds');
  assert.notEqual(backendCalls[0].cwd, runner.calls[0].cwd, 'architect and backend are isolated from each other');

  const done = await cto.getMission(mission.id);
  assert.equal(done.status, 'review');
  const backendTask = done.tasks.find((t) => t.role === 'backend');
  assert.equal(backendTask.status, 'done');
  assert.equal(backendTask.corrections, 1);

  const reports = done.reports.filter((r) => r.role === 'backend');
  assert.deepEqual(reports.map((r) => r.verdict), ['rejected', 'accepted']);
  const accepted = reports[1];
  assert.ok(accepted.evidence.commit, 'verified work is committed on a task branch');
  assert.deepEqual([...accepted.evidence.changed_files].sort(), ['src/slug.js', 'test/slug.test.js']);
  assert.equal(accepted.report.tests.failed, 0);
  assert.ok(accepted.report.tests.passed >= 1);
  assert.deepEqual(accepted.evidence.acceptance, { passed: 2, failed: 0 });
  assert.equal(head(repo, accepted.evidence.branch), accepted.evidence.commit);

  // The main checkout was never touched; nothing was merged.
  assert.equal(head(repo), mainHead);
  assert.ok(!fs.existsSync(path.join(repo, 'src', 'slug.js')));
  assert.ok(branches(repo).includes(accepted.evidence.branch));

  // Owner validation closes the mission (still no merge/deploy).
  await cto.approve(mission.id, { kind: 'completion', decision: 'approve' });
  assert.equal((await cto.getMission(mission.id)).status, 'completed');

  const eventTypes = await types(store, mission.id);
  for (const expected of [
    'mission_created', 'approval_recorded', 'task_leased', 'task_started', 'task_verified',
    'approval_requested', 'correction_requested', 'mission_status'
  ]) assert.ok(eventTypes.includes(expected), expected);

  const report = await cto.consolidatedReport(mission.id);
  assert.equal(report.corrections_requested, 1);
  assert.equal(report.mission.status, 'completed');
  assert.deepEqual(report.approvals.map((a) => a.kind), ['mission', 'architecture', 'completion']);
  assert.match(report.pull_request_body, /Tests actually executed by the CTO/);
  assert.match(report.pull_request_body, /No merge and no deployment/);
  assert.equal(report.mission.spent_usd, 0.05); // architect + 2 backend rounds + qa + security, 0.01 each
  assert.deepEqual(report.reviews.map((r) => `${r.role}:${r.verdict}`), ['qa:pass', 'security:pass']);
  assert.match(report.pull_request_body, /Independent reviews/);
});

test('an agent claiming success without any change is rejected, then escalated after the correction limit', async () => {
  const liar = async () => ({ result: 'All done, all tests pass!' });
  const runner = scriptedRunner({ architect: [architectOk], backend: [liar] });
  const { store, cto } = setup(runner, { maxCorrections: 1 });
  const m = await create(cto);
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  await cto.approve(m.id, { kind: 'architecture', decision: 'approve' });
  await cto.drain();

  const after = await cto.getMission(m.id);
  assert.equal(after.status, 'blocked');
  assert.equal(after.tasks.find((t) => t.role === 'backend').status, 'failed');
  assert.match(after.blockers[0], /could not be verified/);
  assert.equal(runner.calls.filter((c) => c.role === 'backend').length, 2, 'initial attempt + one correction');
  assert.ok(!runner.calls.some((c) => c.role === 'qa' || c.role === 'security'), 'reviewers never see unverified work');
  assert.deepEqual(after.tasks.filter((t) => ['qa', 'security'].includes(t.role)).map((t) => t.status), ['waiting', 'waiting']);
  assert.ok((await types(store, m.id)).includes('escalation'));
  assert.equal((await cto.consolidatedReport(m.id)).blockers.length, 1);
});

test('an architect that modifies files is rejected and its worktree is reset', async () => {
  const naughty = async ({ cwd }) => { write(cwd, 'src/hack.js', 'x'); return { result: PLAN }; };
  const runner = scriptedRunner({ architect: [naughty, architectOk] });
  const { cto } = setup(runner);
  const m = await create(cto);
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  const after = await cto.getMission(m.id);
  const reports = after.reports.filter((r) => r.role === 'architect');
  assert.deepEqual(reports.map((r) => r.verdict), ['rejected', 'accepted']);
  assert.match(reports[0].problems[0], /read-only but modified/);
  assert.equal(after.status, 'awaiting_owner');
});

test('malformed plan is sent back for correction', async () => {
  const runner = scriptedRunner({ architect: [async () => ({ result: 'I will think about it.' }), architectOk] });
  const { cto } = setup(runner);
  const m = await create(cto);
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  const reports = (await cto.getMission(m.id)).reports;
  assert.deepEqual(reports.map((r) => r.verdict), ['rejected', 'accepted']);
});

test('forbidden paths and secrets in the diff are rejected', async () => {
  const bad = async ({ cwd }) => {
    write(cwd, 'src/slug.js', GOOD_SLUG);
    write(cwd, 'test/slug.test.js', SLUG_TEST);
    write(cwd, '.github/workflows/evil.yml', 'on: push');
    write(cwd, 'src/key.js', `export const k = 'ghp_${'M1n2B3v4C5'.repeat(4)}';\n`);
    return { result: 'done' };
  };
  const runner = scriptedRunner({ architect: [architectOk], backend: [bad, backendGood] });
  const { cto } = setup(runner);
  const m = await create(cto);
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  await cto.approve(m.id, { kind: 'architecture', decision: 'approve' });
  await cto.drain();
  const reports = (await cto.getMission(m.id)).reports.filter((r) => r.role === 'backend');
  assert.equal(reports[0].verdict, 'rejected');
  const problems = reports[0].problems.join('\n');
  assert.match(problems, /Forbidden paths modified: .*\.github/);
  assert.match(problems, /secret-like value/);
  assert.ok(!problems.includes('M1n2B3v4C5'), 'the secret itself never reaches the report');
});

test('budget: the CTO stops and escalates instead of overspending; raising the budget resumes', async () => {
  const runner = scriptedRunner({ architect: [architectOk], backend: [backendGood] });
  const { cto, store } = setup(runner);
  const m = await create(cto, { budgetUsd: 0.4 }); // below the architect cap of 0.5
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  assert.equal(runner.calls.length, 0);
  assert.equal((await cto.getMission(m.id)).status, 'blocked');
  assert.ok((await types(store, m.id)).includes('budget_exceeded'));

  await assert.rejects(() => cto.raiseBudget(m.id, 0.3), /exceed/);
  await cto.raiseBudget(m.id, 3);
  await cto.drain();
  assert.equal(runner.calls.length, 1);
  assert.equal((await cto.getMission(m.id)).status, 'awaiting_owner');
});

test('runner crash: retried with backoff, then succeeds', async () => {
  let n = 0;
  const flaky = async () => { n += 1; if (n === 1) throw new Error('claude exited 1'); return { result: PLAN }; };
  const runner = scriptedRunner({ architect: [flaky] });
  const { cto, store } = setup(runner);
  const m = await create(cto);
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  const after = await cto.getMission(m.id);
  assert.equal(after.status, 'awaiting_owner');
  assert.equal(after.tasks[0].failures, 1);
  assert.ok((await types(store, m.id)).includes('task_retry_scheduled'));
});

test('runner that keeps crashing ends as a blocked mission, not a loop', async () => {
  const broken = async () => { throw new Error('claude exited 1'); };
  const runner = scriptedRunner({ architect: [broken] });
  const { cto } = setup(runner, { maxFailures: 2 });
  const m = await create(cto);
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  const after = await cto.getMission(m.id);
  assert.equal(after.status, 'blocked');
  assert.equal(after.tasks[0].status, 'failed');
  assert.equal(runner.calls.length, 2);
});

test('restart recovery: a task leased by a dead worker is picked up by a new CTO process on the same data', async () => {
  const runner = scriptedRunner({ architect: [architectOk] });
  const { repo, dataDir, cto, store } = setup(runner);
  const m = await create(cto);
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  // A worker leases the task long ago and then dies (no heartbeat, no result).
  const leased = await cto.queue.claimNext({ workerId: 'dead-worker', now: Date.now() - 600000 });
  assert.equal(leased.status, 'running');

  // New process: everything it knows comes from disk.
  const restartedStore = new FileStore(dataDir);
  const restarted = new Cto({
    store: restartedStore, runner, repoPath: repo, workspacesDir: tmpDir('cto-ws-'),
    limits: { backoffMs: 5, leaseMs: 1000 }
  });
  await restarted.drain();
  const after = await restarted.getMission(m.id);
  assert.equal(after.status, 'awaiting_owner');
  assert.equal(after.tasks[0].failures, 1);
  assert.ok((await types(restartedStore, m.id)).includes('lease_expired'));
  assert.ok(store, 'the old handle is stale by design: FileStore is single-process');
});

test('cancellation aborts the running agent and cleans up worktrees', async () => {
  let started;
  const hangs = new Promise((resolve) => { started = resolve; });
  const waiting = ({ signal }) => new Promise((_, reject) => {
    started();
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { cancelled: true })));
  });
  const runner = scriptedRunner({ architect: [waiting] });
  const { cto, store } = setup(runner);
  const m = await create(cto);
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.tick();
  await hangs;
  const cancelled = await cto.cancelMission(m.id, { reason: 'changed my mind' });
  await Promise.all([...cto.inflight]);
  assert.equal(cancelled.status, 'cancelled');
  const after = await cto.getMission(m.id);
  assert.ok(after.tasks.every((t) => t.status === 'cancelled'));
  assert.ok((await types(store, m.id)).includes('task_cancelled'));
  assert.deepEqual(fs.readdirSync(cto.workspacesDir), [], 'worktrees removed');
});

test('approval rules: wrong state, unknown kind and rejection', async () => {
  const runner = scriptedRunner({ architect: [architectOk], backend: [backendGood] });
  const { cto } = setup(runner);
  const m = await create(cto);
  await assert.rejects(() => cto.approve(m.id, { kind: 'architecture', decision: 'approve' }), /pending_approval/);
  await assert.rejects(() => cto.approve(m.id, { kind: 'completion', decision: 'approve' }), /pending_approval/);
  await assert.rejects(() => cto.approve(m.id, { kind: 'deploy', decision: 'approve' }), /Unknown approval kind/);
  await assert.rejects(() => cto.approve(m.id, { kind: 'mission', decision: 'maybe' }), /approve or reject/);
  const rejected = await cto.approve(m.id, { kind: 'mission', decision: 'reject', note: 'no' });
  assert.equal(rejected.status, 'cancelled');
  await assert.rejects(() => cto.approve(m.id, { kind: 'mission', decision: 'approve' }), /cancelled/);
  await cto.drain();
  assert.equal(runner.calls.length, 0);
});

test('approval gate cannot be skipped by a premature approval record for another mission', async () => {
  const runner = scriptedRunner({ architect: [architectOk], backend: [backendGood] });
  const { cto, store } = setup(runner);
  const a = await create(cto);
  const b = await create(cto);
  for (const m of [a, b]) await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  await cto.approve(a.id, { kind: 'architecture', decision: 'approve' });
  await cto.drain();
  const bBackend = (await cto.getMission(b.id)).tasks.find((t) => t.role === 'backend');
  assert.equal(bBackend.status, 'waiting', 'approval of mission A does not unlock mission B');
  assert.equal((await store.list('tasks', { mission_id: b.id })).find((t) => t.role === 'backend').attempts, 0);
});

test('events and reports never contain secrets', async () => {
  const leaky = async () => ({ result: `${PLAN}\nmy key is ghp_${'L1e2A3k4Y5'.repeat(4)}` });
  const runner = scriptedRunner({ architect: [leaky] });
  const { cto, store } = setup(runner);
  const m = await create(cto);
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  const dump = JSON.stringify({ events: await store.list('events'), reports: await store.list('reports') });
  assert.ok(!dump.includes('L1e2A3k4Y5'));
});

test('concurrent missions respect the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const slow = async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 60));
    active -= 1;
    return { result: PLAN };
  };
  const runner = scriptedRunner({ architect: [slow] });
  const { cto } = setup(runner, { maxConcurrent: 2 });
  const missions = await Promise.all([create(cto), create(cto), create(cto)]);
  for (const m of missions) await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  assert.equal(peak, 2);
  for (const m of missions) assert.equal((await cto.getMission(m.id)).status, 'awaiting_owner');
});

// ------------------------------------------------------------ independent reviews

async function reachReviews(cto, extra = {}) {
  const m = await create(cto, extra);
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  await cto.approve(m.id, { kind: 'architecture', decision: 'approve' });
  await cto.drain();
  return m;
}

test('qa and security run in parallel, in their own worktrees, on the backend\'s verified commit', async () => {
  let active = 0;
  let peak = 0;
  const heads = {};
  const reviewer = (name) => async ({ cwd }) => {
    active += 1; peak = Math.max(peak, active);
    heads[name] = head(cwd);
    await new Promise((r) => setTimeout(r, 80));
    active -= 1;
    return { result: PASS_REVIEW };
  };
  const runner = scriptedRunner({ architect: [architectOk], backend: [backendGood], qa: [reviewer('qa')], security: [reviewer('security')] });
  const { cto } = setup(runner, { maxConcurrent: 2 });
  const m = await reachReviews(cto);
  const after = await cto.getMission(m.id);
  const commit = after.reports.find((r) => r.role === 'backend' && r.verdict === 'accepted').evidence.commit;

  assert.equal(after.status, 'review');
  assert.equal(peak, 2, 'both reviewers ran at the same time');
  assert.equal(heads.qa, commit);
  assert.equal(heads.security, commit);
  const cwds = new Set(runner.calls.map((c) => c.cwd));
  assert.equal(cwds.size, 4, 'architect, backend, qa and security each have their own worktree');
  const qaCall = runner.calls.find((c) => c.role === 'qa');
  assert.match(qaCall.instruction, /<implementation_summary>[\s\S]*src\/slug\.js/);
  assert.ok(!qaCall.tools.some((t) => /Write|Edit/.test(t)));
});

test('a blocking review sends the work back to the backend; reviewers then re-run on the new commit', async () => {
  const seenHeads = [];
  const blockingOnce = [
    async ({ cwd }) => { seenHeads.push(head(cwd)); return { result: reviewWith('fail', [{ severity: 'high', file: 'src/slug.js', issue: 'no input length limit (DoS)' }]) }; },
    async ({ cwd }) => { seenHeads.push(head(cwd)); return { result: PASS_REVIEW }; }
  ];
  const secondRound = async ({ cwd }) => {
    write(cwd, 'src/slug.js', GOOD_SLUG.replace('String(text)', 'String(text).slice(0, 1000)'));
    write(cwd, 'src/limits.js', 'export const MAX = 1000;\n');
    return { result: 'added a length limit' };
  };
  const runner = scriptedRunner({ architect: [architectOk], backend: [backendGood, secondRound], qa: blockingOnce });
  const { repo, cto, store } = setup(runner);
  const m = await reachReviews(cto);
  const after = await cto.getMission(m.id);

  assert.equal(after.status, 'review');
  const backendCalls = runner.calls.filter((c) => c.role === 'backend');
  assert.equal(backendCalls.length, 2);
  assert.match(backendCalls[1].instruction, /\[qa\/high\] src\/slug\.js: no input length limit/);
  assert.equal(after.tasks.find((t) => t.role === 'backend').corrections, 1);
  assert.equal(runner.calls.filter((c) => c.role === 'qa').length, 2, 'qa re-ran after the rework');
  assert.equal(runner.calls.filter((c) => c.role === 'security').length, 2, 'security re-ran too');

  const commits = after.reports.filter((r) => r.role === 'backend' && r.verdict === 'accepted').map((r) => r.evidence.commit);
  assert.equal(commits.length, 2);
  assert.equal(seenHeads[0], commits[0], 'first review looked at the first commit');
  assert.equal(seenHeads[1], commits[1], 'second review looked at the reworked commit');
  assert.ok((await types(store, m.id)).includes('rework_requested'));

  const report = await cto.consolidatedReport(m.id);
  assert.equal(report.rework_rounds, 1);
  assert.equal(report.commit, commits[1]);
  assert.deepEqual([...report.reviews.map((r) => r.verdict)], ['pass', 'pass']);
  // The PR lists everything the branch changed across both rounds.
  assert.match(report.pull_request_body, /src\/limits\.js/);
  assert.match(report.pull_request_body, /src\/slug\.js/);
  assert.equal(head(repo, report.branch), commits[1]);
});

test('a "pass" that still carries a medium finding blocks the mission from reaching the owner', async () => {
  const mediumPass = async () => ({ result: reviewWith('pass', [{ severity: 'medium', file: 'src/slug.js', issue: 'weak validation' }]) });
  const runner = scriptedRunner({ architect: [architectOk], backend: [backendGood], security: [mediumPass] });
  const { cto } = setup(runner, { maxCorrections: 0 });
  const m = await reachReviews(cto);
  const after = await cto.getMission(m.id);
  assert.equal(after.status, 'blocked');
  assert.match(after.blockers[0], /Independent review still blocking/);
});

test('review keeps failing: rework is bounded, then the mission is escalated', async () => {
  const alwaysFail = async () => ({ result: reviewWith('fail', [{ severity: 'high', file: 'src/slug.js', issue: 'still broken' }]) });
  const tweak = async ({ cwd, call }) => { write(cwd, 'src/slug.js', `${GOOD_SLUG}// round ${call}\n`); return { result: 'tweaked' }; };
  const runner = scriptedRunner({ architect: [architectOk], backend: [backendGood, tweak], qa: [alwaysFail] });
  const { cto, store } = setup(runner, { maxCorrections: 1 });
  const m = await reachReviews(cto);
  const after = await cto.getMission(m.id);
  assert.equal(after.status, 'blocked');
  assert.equal(runner.calls.filter((c) => c.role === 'backend').length, 2, 'initial + exactly one rework');
  assert.match(after.blockers[0], /1 rework rounds/);
  assert.ok((await types(store, m.id)).includes('escalation'));
});

test('a reviewer that edits files or omits the verdict is corrected; its edits are discarded', async () => {
  const meddling = async ({ cwd }) => { write(cwd, 'src/slug.js', '// sabotaged\n'); return { result: PASS_REVIEW }; };
  const noVerdict = async () => ({ result: 'Looks fine to me.' });
  const runner = scriptedRunner({
    architect: [architectOk], backend: [backendGood], qa: [meddling, passStepLocal], security: [noVerdict, passStepLocal]
  });
  const { cto } = setup(runner);
  const m = await reachReviews(cto);
  const after = await cto.getMission(m.id);
  assert.equal(after.status, 'review');
  const reports = after.reports;
  const qaReports = reports.filter((r) => r.role === 'qa');
  const secReports = reports.filter((r) => r.role === 'security');
  assert.deepEqual(qaReports.map((r) => r.verdict), ['rejected', 'accepted']);
  assert.match(qaReports[0].problems[0], /read-only but modified/);
  assert.deepEqual(secReports.map((r) => r.verdict), ['rejected', 'accepted']);
  assert.match(secReports[0].problems[0], /Malformed review/);
  const commit = reports.find((r) => r.role === 'backend' && r.verdict === 'accepted').evidence.commit;
  assert.equal(fs.readFileSync(path.join(runner.calls.find((c) => c.role === 'qa').cwd, 'src/slug.js'), 'utf8'), GOOD_SLUG, 'sabotage was reset');
  assert.ok(commit);
});

async function passStepLocal() { return { result: PASS_REVIEW }; }

test('a reviewer verdict never replaces the CTO checks: failing work does not reach the reviewers', async () => {
  const runner = scriptedRunner({ architect: [architectOk], backend: [backendBuggy], qa: [passStepLocal], security: [passStepLocal] });
  const { cto } = setup(runner, { maxCorrections: 0 });
  const m = await reachReviews(cto, { acceptance: ACCEPTANCE });
  const after = await cto.getMission(m.id);
  assert.equal(after.status, 'blocked');
  assert.ok(!runner.calls.some((c) => c.role === 'qa' || c.role === 'security'));
});
