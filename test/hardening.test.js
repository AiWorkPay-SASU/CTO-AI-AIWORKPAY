import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Cto } from '../src/cto.js';
import { FileStore } from '../src/store/file-store.js';
import { ROLES } from '../src/core.js';
import { buildTestEnv } from '../src/util.js';
import { sandboxCommand } from '../src/test-sandbox.js';
import { runTests, snapshotTree, commitAll } from '../src/workspace.js';
import {
  makeRepo, tmpDir, write, scriptedRunner, PLAN, GOOD_SLUG, SLUG_TEST, PASS_REVIEW, trustedFixtureTests, head
} from '../testkit/fixtures.js';

function setup(t, steps, options = {}) {
  const root = tmpDir('cto-hardening-');
  const repo = makeRepo();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });
  const store = new FileStore(path.join(root, 'data'));
  const runner = scriptedRunner({ architect: [async () => ({ result: PLAN })], ...steps });
  const cto = new Cto({ store, runner, repoPath: repo, workspacesDir: path.join(root, 'work'),
    testRunner: trustedFixtureTests, limits: { maxCorrections: 0, backoffMs: 1 }, ...options });
  return { cto, store, runner, repo };
}

async function start(cto, budgetUsd = 3) {
  const m = await cto.createMission({ objective: 'Implement slugify', project: 'owner/repo', budgetUsd });
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  await cto.approve(m.id, { kind: 'architecture', decision: 'approve' });
  await cto.drain();
  return cto.getMission(m.id);
}

for (const [label, mutation] of [
  ['forbidden file', "fs.writeFileSync('SECURITY.md', 'changed by test')"],
  ['secret', "fs.writeFileSync('src/credentials.js', 'export const value = '+JSON.stringify('ghp_'+'a'.repeat(40)))"],
  ['implementation', "fs.writeFileSync('src/slug.js', 'export const slugify = () => null')"]
]) {
  test(`rejects a passing test that changes ${label} after the first scan`, async (t) => {
    const { cto, runner, repo } = setup(t, { backend: [async ({ cwd }) => {
      write(cwd, 'src/slug.js', GOOD_SLUG);
      write(cwd, 'test/slug.test.js', `${SLUG_TEST}\nimport fs from 'node:fs';\n${mutation};\n`);
      return {};
    }] });
    const initial = head(repo);
    const m = await start(cto);
    assert.equal(m.status, 'blocked');
    assert.ok(m.reports.some((r) => r.problems.some((p) => /changed during test execution/.test(p))));
    assert.ok(m.reports.every((r) => !r.evidence?.commit));
    assert.ok(!runner.calls.some((c) => ['qa', 'security'].includes(c.role)));
    assert.equal(head(repo), initial);
  });
}

test('commit rejects edits made after the verified staged tree', async (t) => {
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const ws = { path: repo };
  write(repo, 'src/new.js', 'export const x = 1;');
  const tree = await snapshotTree(ws);
  write(repo, 'SECURITY.md', 'unchecked');
  await assert.rejects(() => commitAll(ws, 'must not commit', tree), /changed after verification/);
});

test('parallel reviewers cannot spend the same remaining mission budget', async (t) => {
  let active = 0;
  let peak = 0;
  const reviewer = async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 30));
    active -= 1;
    return { result: PASS_REVIEW, total_cost_usd: 0.4 };
  };
  const { cto, runner, store } = setup(t, {
    architect: [async () => ({ result: PLAN, total_cost_usd: 0.5 })],
    backend: [async ({ cwd }) => {
      write(cwd, 'src/slug.js', GOOD_SLUG); write(cwd, 'test/slug.test.js', SLUG_TEST);
      return { total_cost_usd: 1 };
    }], qa: [reviewer], security: [reviewer]
  });
  const m = await start(cto, 1.9);
  assert.equal(m.status, 'blocked');
  assert.equal(m.spent_usd, 1.9);
  assert.equal(peak, 1);
  assert.equal(runner.calls.filter((c) => ['qa', 'security'].includes(c.role)).length, 1);
  assert.deepEqual((await store.get('missions', m.id)).budget_reservations, {});
  await cto.raiseBudget(m.id, 2.3);
  await cto.drain();
  assert.equal((await cto.getMission(m.id)).status, 'review');
  assert.equal((await cto.getMission(m.id)).spent_usd, 2.3);
});

test('unknown spend after a CLI crash is an explicit estimate and prevents unbudgeted retries', async (t) => {
  const { cto, store, runner } = setup(t, { architect: [async () => { throw new Error('lost CLI output'); }] });
  const m = await cto.createMission({ objective: 'Plan', project: 'owner/repo', budgetUsd: 0.5 });
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  assert.equal(runner.calls.length, 1);
  const costs = await store.list('costs', { mission_id: m.id });
  assert.equal(costs[0].estimated, true);
  assert.equal(costs[0].usd, 0.5);
  assert.equal((await cto.getMission(m.id)).status, 'blocked');
});

test('test environment and specialist tools cannot expose provider credentials via shell tests', () => {
  assert.deepEqual(Object.keys(buildTestEnv()).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
  for (const role of Object.values(ROLES)) assert.ok(role.tools.every((tool) => !tool.startsWith('Bash')));
});

test('a lost task claim releases its budget reservation', async (t) => {
  const { cto, store, runner } = setup(t, {});
  const m = await cto.createMission({ objective: 'Plan', project: 'owner/repo', budgetUsd: 0.5 });
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  const original = store.cas.bind(store);
  let loseOnce = true;
  store.cas = async (table, id, expect, patch) => {
    if (table === 'tasks' && patch.status === 'running' && loseOnce) { loseOnce = false; return null; }
    return original(table, id, expect, patch);
  };
  await cto.tick({ wait: true });
  assert.deepEqual((await store.get('missions', m.id)).budget_reservations, {});
  assert.equal(runner.calls.length, 0);
  await cto.drain();
  assert.equal((await cto.getMission(m.id)).status, 'awaiting_owner');
});

test('restart conservatively settles an orphan reservation instead of refunding unknown spend', async (t) => {
  const { cto, store, runner } = setup(t, {});
  const m = await cto.createMission({ objective: 'Plan', project: 'owner/repo', budgetUsd: 0.5 });
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await store.update('missions', m.id, { budget_accounted_usd: 0, budget_reservations: {
    'orphan-attempt': { task_id: m.tasks[0].id, usd: 0.5, created_at: Date.now() - 600000 }
  } });
  await cto.drain();
  assert.equal(runner.calls.length, 0);
  const after = await cto.getMission(m.id);
  assert.equal(after.status, 'blocked');
  assert.equal(after.estimated_usd, 0.5);
  assert.deepEqual(after.budget_reservations, {});
});

test('a verification infrastructure error blocks the mission instead of stranding review', async (t) => {
  const { cto } = setup(t, { backend: [async ({ cwd }) => {
    write(cwd, 'src/slug.js', GOOD_SLUG); write(cwd, 'test/slug.test.js', SLUG_TEST); return {};
  }] }, { testRunner: async () => { throw new Error('sandbox startup failed'); } });
  const m = await start(cto);
  assert.equal(m.status, 'blocked');
  assert.equal(m.tasks.find((task) => task.role === 'backend').status, 'failed');
});

test('sandbox mounts only the runtime and worktree and masks git metadata', (t) => {
  if (process.platform !== 'linux') return t.skip('Linux-only sandbox');
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const spec = sandboxCommand(repo, ['--test']);
  assert.equal(spec.command, 'bwrap');
  assert.ok(spec.args.includes('--unshare-all'));
  assert.ok(spec.args.includes('--clearenv'));
  assert.ok(spec.args.includes('/work/.git'));
  assert.ok(!spec.args.includes('/home'));
  assert.ok(!spec.args.includes('/etc'));
  assert.ok(!spec.args.includes('--share-net'));
});

// A real bwrap invocation: in restricted hosts these fail closed, with an explicit local skip.
// CI requires them: inability to establish isolation makes CI red.
const probeRoot = tmpDir('cto-sandbox-probe-');
write(probeRoot, 'probe.test.js', "import test from 'node:test'; test('probe', () => {});");
const probe = process.platform === 'linux' ? await runTests({ path: probeRoot }, null, { timeoutMs: 2000 }) : { exit_code: 1, tail: 'not Linux' };
fs.rmSync(probeRoot, { recursive: true, force: true });

test('sandbox is mandatory: unavailable isolation never falls back to host execution', async (t) => {
  const repo = tmpDir('cto-sandbox-failclosed-');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  write(repo, 'never.test.js', "import fs from 'node:fs'; fs.writeFileSync('marker', 'executed');");
  if (probe.exit_code === 0) return t.skip('Sandbox available; covered by real isolation test');
  if (process.platform !== 'linux') {
    await assert.rejects(() => runTests({ path: repo }), /requires Linux/);
  } else {
    const result = await runTests({ path: repo }, null, { timeoutMs: 5000 });
    assert.notEqual(result.exit_code, 0);
  }
  assert.ok(!fs.existsSync(path.join(repo, 'marker')));
});

test('real sandbox denies host file reads, host writes, git metadata and external network', async (t) => {
  if (probe.exit_code !== 0) {
    if (process.env.CTO_REQUIRE_SANDBOX_TESTS === '1') assert.fail(`Sandbox unavailable: ${probe.tail}`);
    return t.skip(`Kernel refused sandbox; fail-closed verified separately: ${probe.tail.slice(-180)}`);
  }
  const repo = makeRepo();
  const outside = tmpDir('cto-host-secret-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  write(outside, 'credential', 'synthetic-host-secret');
  write(repo, 'isolation.test.js', `import test from 'node:test';
import assert from 'node:assert/strict'; import fs from 'node:fs'; import net from 'node:net';
test('host files inaccessible', () => {
  assert.throws(() => fs.readFileSync(${JSON.stringify(path.join(outside, 'credential'))}));
  assert.throws(() => fs.writeFileSync(${JSON.stringify(path.join(outside, 'written'))}, 'no'));
  assert.ok(!fs.existsSync('.git/config'));
  assert.ok(!fs.existsSync('.git/objects'));
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
});
test('no external network route', async () => {
  await new Promise((resolve, reject) => {
    const s = net.connect({host:'1.1.1.1',port:443});
    s.on('connect', () => {s.destroy(); reject(new Error('network escaped'));});
    s.on('error', () => resolve());
    s.setTimeout(1000, () => {s.destroy(); resolve();});
  });
});`);
  const result = await runTests({ path: repo }, null, { timeoutMs: 5000 });
  assert.equal(result.exit_code, 0, result.tail);
  assert.equal(result.passed, 2);
  assert.ok(!fs.existsSync(path.join(outside, 'written')));
});
