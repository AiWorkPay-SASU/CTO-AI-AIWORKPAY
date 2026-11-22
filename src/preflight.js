import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxCommand } from './test-sandbox.js';
import { buildAgentEnv, buildTestEnv } from './util.js';

const PROBE_TIMEOUT_MS = 10000;

function probe(command, args, { env, cwd = os.tmpdir() } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child?.kill('SIGKILL');
      done({ ok: false, detail: `${command} timed out` });
    }, PROBE_TIMEOUT_MS);
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return done({ ok: false, detail: error.message });
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (error) => done({ ok: false, detail: error.code === 'ENOENT' ? `${command} not found` : error.message }));
    child.on('close', (code) => done({ ok: code === 0, detail: out.trim().split('\n')[0]?.slice(0, 200) || `exit ${code}` }));
  });
}

/**
 * Verifies what the runtime really provides: Linux, Node >= 20, the Claude CLI and a working bubblewrap
 * sandbox (the same command line the CTO uses to run tests). Nothing is assumed: each check actually executes.
 * `ok:false` means the CTO must report BLOCKED instead of pretending to run.
 */
export async function runPreflight({ claudeCommand = 'claude' } = {}) {
  const checks = [];
  const add = (name, ok, detail, required = true) => checks.push({ name, ok, detail, required });

  add('linux', process.platform === 'linux', process.platform);
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20, `v${process.versions.node}`);

  const claude = await probe(claudeCommand, ['--version'], { env: buildAgentEnv() });
  add('claude_cli', claude.ok, claude.detail);

  let sandbox = { ok: false, detail: 'linux required' };
  if (process.platform === 'linux') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cto-preflight-'));
    try {
      const { command, args } = sandboxCommand(dir, ['-e', 'process.exit(0)']);
      sandbox = await probe(command, args, { env: buildTestEnv(), cwd: dir });
      if (sandbox.ok) sandbox.detail = 'bubblewrap: user/pid/net/mount namespaces, capabilities dropped, empty environment';
    } catch (error) {
      sandbox = { ok: false, detail: error.message };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  add('bubblewrap_isolation', sandbox.ok, sandbox.detail);

  const blockers = checks.filter((c) => c.required && !c.ok).map((c) => `${c.name}: ${c.detail}`);
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'READY' : 'BLOCKED',
    blockers,
    checks,
    // Namespaces are not a certified container: this is stated explicitly and never upgraded.
    isolation: sandbox.ok ? 'bubblewrap-namespaces' : 'unavailable',
    container_certified: false,
    checked_at: new Date().toISOString()
  };
}

/** Caches the (spawning) probe for a short time so the worker loop does not re-run it every tick. */
export function cachedPreflight(run = runPreflight, ttlMs = 30000) {
  let cache = null;
  return async ({ force = false } = {}) => {
    if (!force && cache && Date.now() - cache.at < ttlMs) return cache.value;
    const value = await run();
    cache = { at: Date.now(), value };
    return value;
  };
}
