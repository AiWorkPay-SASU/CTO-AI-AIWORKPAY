import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function tmpDir(prefix = 'cto-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const gitSync = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

/** A real git repository with one commit on `main`. */
export function makeRepo() {
  const dir = tmpDir('cto-repo-');
  gitSync(dir, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture","type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export const version = 1;\n');
  gitSync(dir, 'add', '-A');
  gitSync(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export const head = (repo, ref = 'HEAD') => gitSync(repo, 'rev-parse', ref).trim();
export const branches = (repo) => gitSync(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);

export const PLAN = `## Plan
1. Create src/slug.js exporting slugify(text).
2. Cover lowercase, accents and separators.

## Files
- src/slug.js: implementation
- test/slug.test.js: node:test cases

## Acceptance tests
- slugify("Hello World") returns "hello-world"
- slugify("  Été  à Paris ") returns "ete-a-paris"
`;

export const GOOD_SLUG = `export function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

export const BUGGY_SLUG = `export function slugify(text) {
  return String(text).toLowerCase().replace(/ /g, '-');
}
`;

export const SLUG_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.js';
test('basic', () => assert.equal(slugify('Hello World'), 'hello-world'));
`;

export const ACCEPTANCE = {
  'slug.accept.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.js';
test('accents and trimming', () => assert.equal(slugify('  Été  à Paris '), 'ete-a-paris'));
test('punctuation', () => assert.equal(slugify('Hello, World!'), 'hello-world'));
`
};

export const write = (cwd, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, rel), content);
};

/**
 * Test double for the Claude CLI: each role gets a list of scripted behaviours that really
 * modify the isolated worktree. It exists only in tests; the demo script uses the real CLI.
 */
export function scriptedRunner({ architect = [], backend = [] }) {
  const calls = [];
  const queues = { architect: [...architect], backend: [...backend] };
  const runner = async (opts) => {
    const role = opts.systemPrompt.includes('ARCHITECT') ? 'architect' : 'backend';
    calls.push({ role, cwd: opts.cwd, instruction: opts.instruction, tools: opts.tools, permissionMode: opts.permissionMode });
    const step = queues[role].length > 1 ? queues[role].shift() : queues[role][0];
    if (!step) throw new Error(`no scripted behaviour for ${role}`);
    const out = await step({ ...opts, call: calls.length });
    return { result: 'done', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { 'test-model': {} }, ...out };
  };
  runner.calls = calls;
  return runner;
}
