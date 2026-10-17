// Real end-to-end demonstration: the actual `claude` CLI runs as architect then backend inside isolated
// git worktrees of a throwaway test repository. Nothing is simulated; costs are real and capped.
//
//   node scripts/demo.js
//
// The script stands in for the owner ONLY on this disposable repository and records that fact in the
// approvals (`by`). It stops at the `review` state: the final completion approval, any merge and any
// deployment stay with the human owner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Cto } from '../src/cto.js';
import { FileStore } from '../src/store/index.js';

const OBJECTIVE = [
  'Add a function slugify(text) exported from src/slug.js (ES module).',
  'It lowercases the text, removes accents (é -> e), turns every run of non-alphanumeric characters into a single hyphen,',
  'trims leading/trailing hyphens, and returns an empty string for empty or whitespace-only input.',
  'Write node:test tests in test/slug.test.js covering these rules.'
].join(' ');

// Owner-supplied acceptance tests: the CTO runs them itself, independently of what the agent claims.
const ACCEPTANCE = {
  'slug.accept.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.js';
test('basic', () => assert.equal(slugify('Hello World'), 'hello-world'));
test('accents and trimming', () => assert.equal(slugify('  Été  à Paris '), 'ete-a-paris'));
test('punctuation runs collapse', () => assert.equal(slugify('Hello,   World!!! 2026'), 'hello-world-2026'));
test('empty and blank', () => { assert.equal(slugify(''), ''); assert.equal(slugify('   '), ''); });
test('only symbols', () => assert.equal(slugify('---***---'), ''));
test('cedilla and umlaut', () => assert.equal(slugify('Français Über'), 'francais-uber'));
`
};

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@localhost', ...args], { cwd, encoding: 'utf8' }).trim();
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cto-demo-'));
const repo = path.join(root, 'test-repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
git(repo, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"demo-target","type":"module","scripts":{"test":"node --test"}}\n');
fs.writeFileSync(path.join(repo, 'src/index.js'), '// demo target project\nexport const name = "demo-target";\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'initial commit');
const mainHead = git(repo, 'rev-parse', 'HEAD');
log(`isolated test repo: ${repo} (main @ ${mainHead.slice(0, 8)})`);

const store = new FileStore(path.join(root, 'data'));
const cto = new Cto({
  store, repoPath: repo, workspacesDir: path.join(root, 'workspaces'),
  limits: { maxCorrections: 2, maxFailures: 2, backoffMs: 2000, leaseMs: 120000 }
});

const OWNER = 'demo-script (disposable test repo)';
const mission = await cto.createMission({ objective: OBJECTIVE, project: 'demo/test-repo', budgetUsd: 2, acceptance: ACCEPTANCE });
log(`mission ${mission.id.slice(0, 8)} created (${mission.status}), budget ${mission.budget_usd} USD`);

await cto.approve(mission.id, { kind: 'mission', decision: 'approve', by: OWNER, note: 'demo run' });
log('mission approved -> dispatching the ARCHITECT (real Claude, read-only worktree)');
await cto.drain();

let current = await cto.getMission(mission.id);
log(`status after architect: ${current.status}`);
const architectReports = current.reports.filter((r) => r.role === 'architect');
for (const r of architectReports) log(`architect report: verdict=${r.verdict} cost=${r.cost_usd} USD ${r.problems.length ? `problems=${JSON.stringify(r.problems)}` : ''}`);
if (current.status !== 'awaiting_owner') {
  log('architect did not produce an accepted plan; stopping for owner arbitration');
} else {
  await cto.approve(mission.id, { kind: 'architecture', decision: 'approve', by: OWNER, note: 'plan reviewed by demo script' });
  log('architecture approved -> dispatching the BACKEND (real Claude, write access limited to its worktree)');
  await cto.drain();
  current = await cto.getMission(mission.id);
  log(`status after backend: ${current.status}`);
}

const report = await cto.consolidatedReport(mission.id);
const events = await store.list('events', { mission_id: mission.id });
const evidence = {
  generated_at: new Date().toISOString(),
  mission: report.mission,
  tasks: report.tasks,
  approvals: report.approvals,
  corrections_requested: report.corrections_requested,
  blockers: report.blockers,
  branch: report.branch,
  commit: report.commit,
  tests: report.tests,
  reports: current.reports.map((r) => ({
    role: r.role, verdict: r.verdict, cost_usd: r.cost_usd, tests: r.report.tests,
    changed_files: r.evidence.changed_files, acceptance: r.evidence.acceptance ?? null,
    problems: r.problems.map((p) => p.slice(0, 400)), commit: r.evidence.commit ?? null
  })),
  event_sequence: events.map((e) => `${e.at.slice(11, 19)} ${e.type}${e.detail?.role ? ` (${e.detail.role})` : ''}`),
  main_unchanged: git(repo, 'rev-parse', 'main') === mainHead,
  branches: git(repo, 'branch', '--format=%(refname:short)').split('\n'),
  pull_request_body: report.pull_request_body
};
if (report.commit) {
  evidence.committed_files = git(repo, 'show', '--stat', '--format=%h %s', report.commit).split('\n');
  evidence.independent_recheck = (() => {
    // Re-run the project tests and the acceptance tests ourselves, outside the CTO code path.
    const dir = path.join(root, 'recheck');
    execFileSync('git', ['worktree', 'add', '--detach', dir, report.commit], { cwd: repo, stdio: 'pipe' });
    fs.mkdirSync(path.join(dir, '.accept'));
    for (const [name, content] of Object.entries(ACCEPTANCE)) fs.writeFileSync(path.join(dir, '.accept', name), content);
    const run = (args) => { try { return { ok: true, out: execFileSync(process.execPath, args, { cwd: dir, encoding: 'utf8' }) }; } catch (e) { return { ok: false, out: String(e.stdout) }; } };
    const proj = run(['--test', '--test-reporter=tap']);
    const acc = run(['--test', '--test-reporter=tap', '.accept/slug.accept.test.js']);
    const pick = (s, k) => (s.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1];
    return { project_tests: { ok: proj.ok, pass: pick(proj.out, 'pass'), fail: pick(proj.out, 'fail') }, acceptance_tests: { ok: acc.ok, pass: pick(acc.out, 'pass'), fail: pick(acc.out, 'fail') } };
  })();
  evidence.slug_js = git(repo, 'show', `${report.commit}:src/slug.js`);
}
const out = path.join(process.env.DEMO_OUT || root, 'demo-evidence.json');
fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
log(`final mission status: ${evidence.mission.status} · spent ${evidence.mission.spent_usd} USD · corrections requested: ${evidence.corrections_requested}`);
log(`evidence written to ${out}`);
console.log(JSON.stringify({ status: evidence.mission.status, spent_usd: evidence.mission.spent_usd, corrections: evidence.corrections_requested, commit: evidence.commit, recheck: evidence.independent_recheck, main_unchanged: evidence.main_unchanged }, null, 2));
