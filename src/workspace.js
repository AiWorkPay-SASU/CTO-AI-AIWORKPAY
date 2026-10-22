import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildAgentEnv, buildTestEnv, redact, containsSecret } from './util.js';
import { sandboxCommand } from './test-sandbox.js';

const GIT_ENV = () => ({ ...buildAgentEnv(), GIT_CONFIG_NOSYSTEM: '1' });
const GIT_BASE = ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=CTO-AI', '-c', 'user.email=cto-ai@localhost'];

export function run(cmd, args, { cwd, timeoutMs = 60000, env = GIT_ENV(), input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, timedOut: Boolean(error?.killed) });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export async function git(cwd, args, opts = {}) {
  return run('git', [...GIT_BASE, ...args], { cwd, ...opts });
}

/** Paths an agent must never change. */
const FORBIDDEN = [/^\.git\//, /^\.github\//, /^\.env(\..*)?$/, /^SECURITY\.md$/, /^AGENTS\.md$/, /^\.cto-acceptance\//];

export function forbiddenChanges(files) {
  return files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
}

/**
 * One isolated git worktree per task (reused across correction rounds so the specialist can fix
 * its own work). Read-only roles get a detached worktree.
 */
export async function ensureWorkspace({ repoPath, baseDir, task, mission, baseRef = 'HEAD', detached = false }) {
  const dir = path.resolve(baseDir, task.id.slice(0, 8));
  const branch = `cto/${mission.id.slice(0, 8)}/${task.role}-${task.id.slice(0, 8)}`;
  if (fs.existsSync(path.join(dir, '.git'))) {
    if (detached) {
      // A reviewer's worktree must always sit on the commit under review (it changes after a rework).
      await git(dir, ['checkout', '-q', '--detach', baseRef]);
      await git(dir, ['reset', '--hard', '-q', baseRef]);
      await git(dir, ['clean', '-fdq']);
    }
    return { path: dir, branch: detached ? null : branch, reused: true };
  }
  fs.mkdirSync(baseDir, { recursive: true });
  const args = detached
    ? ['worktree', 'add', '--detach', dir, baseRef]
    : ['worktree', 'add', '-b', branch, dir, baseRef];
  const res = await git(repoPath, args);
  if (res.code !== 0) throw new Error(`worktree creation failed: ${redact(res.stderr).slice(0, 500)}`);
  const base = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  return { path: dir, branch: detached ? null : branch, reused: false, base };
}

/** Everything the branch changed since the worktree was created (spans correction and rework rounds). */
export async function branchSummary(ws, baseCommit) {
  if (!baseCommit) return { files: [], diffstat: '' };
  const names = await git(ws.path, ['diff', '--name-only', `${baseCommit}..HEAD`]);
  const stat = await git(ws.path, ['diff', '--stat', `${baseCommit}..HEAD`]);
  return { files: names.stdout.split('\n').filter(Boolean), diffstat: redact(stat.stdout).trim() };
}

export async function removeWorkspace(repoPath, ws) {
  await git(repoPath, ['worktree', 'remove', '--force', ws.path]);
}

/** Real change evidence taken from git, never from the agent's own claims. */
export async function collectEvidence(ws) {
  const status = await git(ws.path, ['status', '--porcelain', '--untracked-files=all']);
  const files = status.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''));
  await git(ws.path, ['add', '-N', '.']); // intent-to-add so untracked files show in the diff stat
  const stat = await git(ws.path, ['diff', '--stat', 'HEAD']);
  // Untracked files are invisible to `git diff`; include their content for the secret scan.
  let diffText = (await git(ws.path, ['diff', 'HEAD'])).stdout;
  for (const f of files) {
    const abs = path.join(ws.path, f);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size < 512 * 1024) {
      diffText += `\n--- ${f}\n${fs.readFileSync(abs, 'utf8')}`;
    }
  }
  return {
    changed_files: files,
    diffstat: redact(stat.stdout).trim(),
    secret_in_diff: containsSecret(diffText)
  };
}

/** Discards every change in a worktree (used after a read-only role misbehaves). */
export async function resetWorkspace(ws) {
  await git(ws.path, ['reset', '--hard', 'HEAD']);
  await git(ws.path, ['clean', '-fdq']);
}

export async function commitAll(ws, message, expectedTree = null) {
  await git(ws.path, ['add', '-A']);
  if (expectedTree && (await snapshotTree(ws)) !== expectedTree) throw new Error('Workspace changed after verification');
  const res = await git(ws.path, ['commit', '-m', message]);
  if (res.code !== 0) throw new Error(`commit failed: ${redact(res.stderr).slice(0, 300)}`);
  return (await git(ws.path, ['rev-parse', 'HEAD'])).stdout.trim();
}

/** Stage a snapshot. The commit later uses this exact index, never an unchecked working tree. */
export async function snapshotTree(ws) {
  for (const args of [['add', '-A'], ['write-tree']]) {
    const result = await git(ws.path, args);
    if (result.code !== 0) throw new Error('Cannot snapshot workspace');
    if (args[0] === 'write-tree') return result.stdout.trim();
  }
}

export async function inspectTree(ws, tree, base = 'HEAD') {
  const names = await git(ws.path, ['diff', '--name-only', '-z', base, tree]);
  if (names.code !== 0) throw new Error('Cannot inspect staged files');
  const files = names.stdout.split('\0').filter(Boolean);
  let secret = false;
  for (const file of files) {
    const entry = await git(ws.path, ['ls-tree', tree, '--', file]);
    if (!entry.stdout) continue; // deletion
    if (entry.code !== 0) throw new Error('Cannot inspect staged entry');
    const blob = entry.stdout.match(/^\d+ blob ([0-9a-f]+)\t/);
    if (!blob) throw new Error('Unsupported staged entry');
    const content = await git(ws.path, ['cat-file', 'blob', blob[1]]);
    if (content.code !== 0) throw new Error('Cannot scan staged content (missing or too large)');
    secret ||= containsSecret(content.stdout);
  }
  return { files, secret };
}

/** Writes owner-supplied acceptance tests under .cto-acceptance/ (never part of the commit). */
export function writeAcceptance(ws, acceptance) {
  const dir = path.join(ws.path, '.cto-acceptance');
  fs.rmSync(dir, { recursive: true, force: true });
  if (!acceptance) return [];
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [name, content] of Object.entries(acceptance)) {
    if (!/^[A-Za-z0-9_.-]+\.test\.(c|m)?js$/.test(name)) throw new Error(`Invalid acceptance file name ${name}`);
    fs.writeFileSync(path.join(dir, name), String(content));
    written.push(path.join('.cto-acceptance', name));
  }
  return written;
}

export function clearAcceptance(ws) {
  fs.rmSync(path.join(ws.path, '.cto-acceptance'), { recursive: true, force: true });
}

function parseTap(output) {
  const pick = (label) => Number((output.match(new RegExp(`^# ${label} (\\d+)`, 'm')) || [])[1] ?? NaN);
  return { passed: pick('pass'), failed: pick('fail') };
}

/** The CTO runs the tests itself; an agent saying "tests pass" is never evidence. */
export async function runTests(ws, files = null, { timeoutMs = 120000 } = {}) {
  const args = ['--test', '--test-reporter=tap', ...(files ?? [])];
  const sandbox = sandboxCommand(ws.path, args);
  const res = await run(sandbox.command, sandbox.args, { cwd: ws.path, timeoutMs, env: buildTestEnv() });
  const { passed, failed } = parseTap(res.stdout);
  return {
    command: `node ${args.join(' ')}`,
    sandbox_required: true,
    exit_code: res.code,
    timed_out: res.timedOut,
    passed: Number.isNaN(passed) ? 0 : passed,
    failed: Number.isNaN(failed) ? 0 : failed,
    tail: redact(`${res.stdout}\n${res.stderr}`).slice(-1500)
  };
}

