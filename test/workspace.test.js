import { trustedFixtureTests } from '../testkit/fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planMission } from '../src/core.js';
import {
  ensureWorkspace, collectEvidence, forbiddenChanges, commitAll, writeAcceptance, clearAcceptance,
  resetWorkspace, removeWorkspace, branchSummary
} from '../src/workspace.js';
import { makeRepo, tmpDir, write, head, branches, SLUG_TEST, GOOD_SLUG, BUGGY_SLUG } from '../testkit/fixtures.js';

async function workspace(detached = false) {
  const repo = makeRepo();
  const { tasks, ...mission } = planMission('Build slug', 'owner/repo');
  const ws = await ensureWorkspace({ repoPath: repo, baseDir: tmpDir('cto-ws-'), task: tasks[1], mission, detached });
  return { repo, ws, task: tasks[1], mission };
}

test('each task gets its own worktree on its own branch; the main checkout is untouched', async () => {
  const { repo, ws } = await workspace();
  const mainHead = head(repo);
  write(ws.path, 'src/new.js', 'export default 1;\n');
  assert.ok(!fs.existsSync(path.join(repo, 'src', 'new.js')), 'file must not appear in the main checkout');
  assert.equal(head(repo), mainHead);
  assert.ok(branches(repo).some((b) => b.startsWith('cto/')));
});

test('worktree is reused across correction rounds', async () => {
  const { repo, ws, task, mission } = await workspace();
  const again = await ensureWorkspace({ repoPath: repo, baseDir: path.dirname(ws.path), task, mission });
  assert.equal(again.reused, true);
  assert.equal(again.path, ws.path);
});

test('read-only roles get a detached worktree', async () => {
  const { ws } = await workspace(true);
  assert.equal(ws.branch, null);
});

test('evidence comes from git: changed + untracked files, diffstat, secret detection', async () => {
  const { ws } = await workspace();
  write(ws.path, 'src/slug.js', GOOD_SLUG);
  write(ws.path, 'src/index.js', 'export const version = 2;\n');
  let ev = await collectEvidence(ws);
  assert.deepEqual([...ev.changed_files].sort(), ['src/index.js', 'src/slug.js']);
  assert.match(ev.diffstat, /slug\.js/);
  assert.equal(ev.secret_in_diff, false);
  write(ws.path, 'src/config.js', `export const k = 'ghp_${'q1W2e3R4t5'.repeat(4)}';\n`);
  ev = await collectEvidence(ws);
  assert.equal(ev.secret_in_diff, true);
});

test('forbidden paths are detected', () => {
  assert.deepEqual(
    forbiddenChanges(['src/a.js', '.github/workflows/x.yml', '.env', '.env.local', 'SECURITY.md', 'AGENTS.md', '.cto-acceptance/a.test.js']),
    ['.github/workflows/x.yml', '.env', '.env.local', 'SECURITY.md', 'AGENTS.md', '.cto-acceptance/a.test.js']
  );
  assert.deepEqual(forbiddenChanges(['src/env.js', 'docs/SECURITY.md.bak']), []);
});

test('the CTO runs the tests itself and parses real results', async () => {
  const { ws } = await workspace();
  write(ws.path, 'src/slug.js', GOOD_SLUG);
  write(ws.path, 'test/slug.test.js', SLUG_TEST);
  const ok = await trustedFixtureTests(ws);
  assert.equal(ok.exit_code, 0);
  assert.equal(ok.passed, 1);
  assert.equal(ok.failed, 0);

  write(ws.path, 'src/slug.js', 'export const slugify = () => "nope";\n');
  const ko = await trustedFixtureTests(ws);
  assert.notEqual(ko.exit_code, 0);
  assert.equal(ko.failed, 1);
});

test('acceptance tests are written outside the commit and validated by name', async () => {
  const { ws } = await workspace();
  write(ws.path, 'src/slug.js', BUGGY_SLUG);
  const files = writeAcceptance(ws, {
    'a.test.js': "import test from 'node:test';import assert from 'node:assert/strict';import {slugify} from '../src/slug.js';test('x',()=>assert.equal(slugify('A B'),'a-b'));"
  });
  assert.deepEqual(files, [path.join('.cto-acceptance', 'a.test.js')]);
  const run = await trustedFixtureTests(ws, files);
  assert.equal(run.passed, 1);
  clearAcceptance(ws);
  assert.ok(!fs.existsSync(path.join(ws.path, '.cto-acceptance')));
  assert.throws(() => writeAcceptance(ws, { '../evil.js': 'x' }), /Invalid acceptance file name/);
  assert.throws(() => writeAcceptance(ws, { 'ok.txt': 'x' }), /Invalid acceptance file name/);
});

test('commitAll commits on the task branch only, resetWorkspace discards changes, removeWorkspace cleans up', async () => {
  const { repo, ws } = await workspace();
  const mainHead = head(repo);
  write(ws.path, 'src/slug.js', GOOD_SLUG);
  const sha = await commitAll(ws, 'feat: slug');
  assert.equal(head(repo), mainHead, 'main is not moved');
  assert.equal(head(repo, ws.branch), sha);

  write(ws.path, 'src/junk.js', 'x');
  fs.appendFileSync(path.join(ws.path, 'src/slug.js'), '// junk\n');
  await resetWorkspace(ws);
  assert.deepEqual((await collectEvidence(ws)).changed_files, []);

  await removeWorkspace(repo, ws);
  assert.ok(!fs.existsSync(ws.path));
  assert.ok(branches(repo).includes(ws.branch), 'branch is kept for the PR');
});

test('a reused reviewer worktree is moved onto the commit under review (it changes after a rework)', async () => {
  const { repo, ws: implWs } = await workspace();
  write(implWs.path, 'src/slug.js', GOOD_SLUG);
  const first = await commitAll(implWs, 'round 1');
  const { tasks, ...mission } = planMission('Build slug', 'owner/repo');
  const base = tmpDir('cto-ws-');
  const reviewer = await ensureWorkspace({ repoPath: repo, baseDir: base, task: tasks[2], mission, baseRef: first, detached: true });
  assert.equal(head(reviewer.path), first);

  write(implWs.path, 'src/extra.js', 'export const extra = 1;\n');
  const second = await commitAll(implWs, 'round 2');
  const again = await ensureWorkspace({ repoPath: repo, baseDir: base, task: tasks[2], mission, baseRef: second, detached: true });
  assert.equal(again.reused, true);
  assert.equal(head(again.path), second);
  assert.ok(fs.existsSync(path.join(again.path, 'src/extra.js')));
});

test('branchSummary spans every round since the worktree was created', async () => {
  const { ws } = await workspace();
  assert.ok(ws.base, 'a fresh worktree reports its base commit');
  write(ws.path, 'src/a.js', 'export const a = 1;\n');
  await commitAll(ws, 'round 1');
  write(ws.path, 'src/b.js', 'export const b = 1;\n');
  await commitAll(ws, 'round 2');
  const summary = await branchSummary(ws, ws.base);
  assert.deepEqual([...summary.files].sort(), ['src/a.js', 'src/b.js']);
  assert.match(summary.diffstat, /2 files changed/);
  assert.deepEqual(await branchSummary(ws, null), { files: [], diffstat: '' });
});

