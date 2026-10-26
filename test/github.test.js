import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Cto } from '../src/cto.js';
import { FileStore } from '../src/store/index.js';
import { GitHubClient } from '../src/github.js';
import { buildAgentEnv } from '../src/util.js';
import { startFakeGitHub, checkRun } from '../testkit/fake-github.js';
import {
  tmpDir, makeRepo, write, scriptedRunner, PLAN, GOOD_SLUG, SLUG_TEST, trustedFixtureTests, head, branches
} from '../testkit/fixtures.js';

// The GitHub REST API is SIMULATED (testkit/fake-github.js). The git push is REAL, against a local bare repository.

const TOKEN = `ghp_${'b'.repeat(40)}`;
const PROJECT = 'owner/repo';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const backendRound1 = async ({ cwd }) => { write(cwd, 'src/slug.js', GOOD_SLUG); write(cwd, 'test/slug.test.js', SLUG_TEST); return { result: 'ok' }; };
const backendRound2 = async ({ cwd }) => { write(cwd, 'src/slug.js', `${GOOD_SLUG}// fixed for CI\n`); return { result: 'fixed' }; };

async function setup(t, { steps = {}, projects = [PROJECT], limits = {} } = {}) {
  const root = tmpDir('cto-gh-');
  const gitBase = path.join(root, 'remotes');
  const repos = {};
  const bares = {};
  for (const project of projects) {
    repos[project] = makeRepo();
    bares[project] = path.join(gitBase, `${project}.git`);
    fs.mkdirSync(bares[project], { recursive: true });
    git(bares[project], 'init', '-q', '--bare');
  }
  const gh = await startFakeGitHub({ token: TOKEN });
  t.after(async () => {
    await gh.close();
    fs.rmSync(root, { recursive: true, force: true });
    for (const dir of Object.values(repos)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const github = new GitHubClient({ token: TOKEN, apiBase: gh.url, gitBase: `file://${gitBase}`, allowedRepos: projects });
  const store = new FileStore(path.join(root, 'data'));
  const runner = scriptedRunner({ architect: [async () => ({ result: PLAN })], backend: [backendRound1, backendRound2], ...steps });
  const cto = new Cto({
    store, runner, repos, github, workspacesDir: path.join(root, 'work'), testRunner: trustedFixtureTests,
    limits: { backoffMs: 1, maxCorrections: 2, reconcileGraceMs: 0, ...limits }
  });
  return { cto, store, gh, github, repos, bares, runner };
}

async function toReview(cto, project = PROJECT) {
  const m = await cto.createMission({ objective: 'Implement slugify', project, budgetUsd: 10 });
  await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
  await cto.drain();
  await cto.approve(m.id, { kind: 'architecture', decision: 'approve' });
  await cto.drain();
  assert.equal((await cto.getMission(m.id)).status, 'review');
  return m.id;
}

test('the proposal pushes the verified commit to a CTO branch and opens a DRAFT pull request, never merging', async (t) => {
  const { cto, gh, bares, store } = await setup(t);
  const id = await toReview(cto);
  const report = await cto.consolidatedReport(id);

  const pr = await cto.submitPullRequest(id, { by: 'owner', credentialId: 'a1b2c3d4' });
  assert.equal(pr.draft, true);
  assert.equal(pr.number, 1);
  assert.equal(git(bares[PROJECT], 'rev-parse', `refs/heads/${report.branch}`), report.commit, 'the verified commit really reached the remote');
  assert.notEqual(report.branch, 'main');
  const posted = gh.pulls[0];
  assert.equal(posted.draft, true);
  assert.equal(posted.base, 'main');
  assert.equal(posted.head, report.branch);
  assert.match(posted.title, /^\[CTO IA\] Implement slugify/);
  assert.match(posted.body, /No merge and no deployment/);

  // Everything the CTO ever asked of GitHub is inside the narrow allowed set; no merge, ever.
  for (const r of gh.requests) {
    assert.ok(
      (r.method === 'GET') || (r.method === 'POST' && /\/pulls$/.test(r.path)), `unexpected GitHub request ${r.method} ${r.path}`
    );
  }
  assert.ok(!gh.requests.some((r) => /merge/.test(r.path)));
  // The credential is in no stored record, and not in the environment given to agents.
  const dump = JSON.stringify(await Promise.all(['missions', 'tasks', 'reports', 'events', 'approvals', 'costs'].map((n) => store.list(n))));
  assert.ok(!dump.includes(TOKEN));
  assert.ok(!('CTO_GITHUB_TOKEN' in buildAgentEnv({ CTO_GITHUB_TOKEN: TOKEN, PATH: '/usr/bin' })));
});

test('opening the pull request twice at once creates one PR; later calls update the same one', async (t) => {
  const { cto, gh } = await setup(t);
  const id = await toReview(cto);
  const results = await Promise.allSettled([cto.submitPullRequest(id), cto.submitPullRequest(id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(gh.pulls.length, 1);
  const again = await cto.submitPullRequest(id);
  assert.equal(again.number, 1);
  assert.equal(gh.pulls.length, 1, 'no second PR');
});

test('a failing CI sends the work back with the failing checks; the corrected commit updates the same PR', async (t) => {
  const { cto, store, gh, bares } = await setup(t);
  const id = await toReview(cto);
  const first = (await cto.consolidatedReport(id)).commit;
  await cto.submitPullRequest(id);
  gh.setChecks(first, [checkRun('unit-tests', 'failure', 'slug.test.js failed on Node 22'), checkRun('lint', 'success')]);

  const verdict = await cto.checkCi(id);
  assert.equal(verdict.state, 'failure');
  assert.equal(verdict.action, 'rework_requested');
  let state = await cto.getMission(id);
  assert.equal(state.status, 'running');
  const backend = state.tasks.find((x) => x.role === 'backend');
  assert.equal(backend.status, 'queued');
  assert.match(backend.feedback, /unit-tests/);
  assert.match(backend.feedback, /slug\.test\.js failed/);
  assert.ok(!/lint:/.test(backend.feedback), 'passing checks are not blamed');

  await cto.drain();
  state = await cto.getMission(id);
  assert.equal(state.status, 'review', 'second round verified, reviewers re-ran');
  const report = await cto.consolidatedReport(id);
  assert.notEqual(report.commit, first);
  assert.equal(git(bares[PROJECT], 'rev-parse', `refs/heads/${report.branch}`), report.commit, 'the corrected commit was pushed to the same branch');
  assert.equal(gh.pulls.length, 1, 'same pull request');

  gh.setChecks(report.commit, [checkRun('unit-tests', 'success'), checkRun('lint', 'success')]);
  const second = await cto.checkCi(id);
  assert.deepEqual([second.state, second.action], ['success', 'none']);
  const types = (await store.list('events', { mission_id: id })).map((e) => e.type);
  for (const expected of ['pull_request_opened', 'ci_rework_requested', 'pull_request_updated', 'ci_status']) assert.ok(types.includes(expected), expected);
});

test('missing or pending checks are never reported as success and never trigger a rework', async (t) => {
  const { cto, gh } = await setup(t);
  const id = await toReview(cto);
  const commit = (await cto.consolidatedReport(id)).commit;
  await cto.submitPullRequest(id);
  assert.deepEqual(await cto.checkCi(id).then((r) => [r.state, r.action]), ['none', 'none']);
  gh.setChecks(commit, [checkRun('unit-tests', null)]);
  assert.deepEqual(await cto.checkCi(id).then((r) => [r.state, r.action]), ['pending', 'none']);
  assert.equal((await cto.getMission(id)).status, 'review');
});

test('CI that keeps failing is escalated after the correction limit instead of looping', async (t) => {
  const { cto, gh } = await setup(t, { limits: { maxCorrections: 1 } });
  const id = await toReview(cto);
  await cto.submitPullRequest(id);
  gh.setChecks((await cto.consolidatedReport(id)).commit, [checkRun('unit-tests', 'failure', 'still red')]);
  assert.equal((await cto.checkCi(id)).action, 'rework_requested');
  await cto.drain();
  assert.equal((await cto.getMission(id)).status, 'review');
  gh.setChecks((await cto.consolidatedReport(id)).commit, [checkRun('unit-tests', 'failure', 'still red')]);
  assert.equal((await cto.checkCi(id)).action, 'escalated');
  const state = await cto.getMission(id);
  assert.equal(state.status, 'blocked');
  assert.match(state.blockers.at(-1), /CI still failing/);
});

test('GitHub operations are limited to authorized repositories and CTO branches', async (t) => {
  const { github, gh, repos } = await setup(t);
  await assert.rejects(() => github.openDraftPullRequest({ project: 'evil/other', head: 'cto/12345678/backend-12345678', base: 'main', title: 't', body: 'b' }), /not authorized/);
  await assert.rejects(() => github.openDraftPullRequest({ project: PROJECT, head: 'main', base: 'main', title: 't', body: 'b' }), /CTO task branches/);
  await assert.rejects(() => github.pushBranch({ repoPath: repos[PROJECT], project: PROJECT, branch: 'main', commit: head(repos[PROJECT]) }), /not a CTO task branch/);
  await assert.rejects(() => github.pushBranch({ repoPath: repos[PROJECT], project: 'evil/other', branch: 'cto/12345678/backend-12345678', commit: head(repos[PROJECT]) }), /not authorized/);
  assert.equal(gh.requests.length, 0, 'refused before any request was made');
  const names = Object.getOwnPropertyNames(GitHubClient.prototype).join(' ');
  assert.ok(!/merge|deploy|delete|close|approve/i.test(names), `no dangerous capability exposed: ${names}`);
  assert.throws(() => new GitHubClient({ token: TOKEN, allowedRepos: [] }), /authorized repository/);
});

test('a pull request needs a mission in review with a verified commit', async (t) => {
  const { cto } = await setup(t);
  const m = await cto.createMission({ objective: 'Implement slugify', project: PROJECT });
  await assert.rejects(() => cto.submitPullRequest(m.id), /only be opened for a mission in review/);
  await assert.rejects(() => cto.checkCi(m.id), /No pull request/);
});

test('one CTO drives several projects, each in its own repository, and refuses unlisted ones', async (t) => {
  const other = 'owner/other';
  const { cto, repos, bares, gh } = await setup(t, { projects: [PROJECT, other], steps: { backend: [backendRound1] } });
  await assert.rejects(() => cto.createMission({ objective: 'x', project: 'owner/unlisted' }), /not an authorized repository/);
  const a = await toReview(cto, PROJECT);
  const b = await toReview(cto, other);
  const ra = await cto.consolidatedReport(a);
  const rb = await cto.consolidatedReport(b);
  assert.ok(branches(repos[PROJECT]).includes(ra.branch) && !branches(repos[PROJECT]).includes(rb.branch));
  assert.ok(branches(repos[other]).includes(rb.branch) && !branches(repos[other]).includes(ra.branch));
  await cto.submitPullRequest(a);
  await cto.submitPullRequest(b);
  assert.equal(git(bares[PROJECT], 'rev-parse', `refs/heads/${ra.branch}`), ra.commit);
  assert.equal(git(bares[other], 'rev-parse', `refs/heads/${rb.branch}`), rb.commit);
  assert.equal(gh.pulls.length, 2);
});
