import { spawn } from 'node:child_process';
import { buildAgentEnv, redact } from './util.js';

/** Flags that must never be forwarded to the CLI, whatever a caller passes. */
const DENIED_TOOLS = [
  'WebFetch', 'WebSearch', 'Bash(git:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(npm:*)',
  'Bash(npx:*)', 'Bash(rm:*)', 'Bash(sudo:*)', 'Bash(ssh:*)', 'Bash(gh:*)'
];

export function buildClaudeArgs({ tools, permissionMode, maxBudgetUsd, systemPrompt }) {
  if (!Array.isArray(tools) || !tools.length) throw new Error('Explicit tool allowlist required');
  if (permissionMode === 'bypassPermissions') throw new Error('bypassPermissions is forbidden');
  const args = [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--permission-mode', permissionMode,
    '--allowedTools', tools.join(','),
    '--disallowedTools', DENIED_TOOLS.join(','),
    '--max-budget-usd', String(maxBudgetUsd)
  ];
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  return args;
}

/**
 * Runs one real Claude Code CLI session in an isolated workspace. The instruction goes through
 * stdin, the environment is an allowlist (no GitHub/Supabase/admin secrets), the process is bounded
 * by a timeout and by an AbortSignal (mission cancellation), and cost is capped with --max-budget-usd.
 */
export async function runClaude({
  instruction, cwd, tools, permissionMode = 'default', maxBudgetUsd = 0.5,
  timeoutMs = 120000, signal, systemPrompt, env = buildAgentEnv(), command = 'claude'
}) {
  if (!cwd) throw new Error('Workspace required');
  if (!instruction) throw new Error('Instruction required');
  const args = buildClaudeArgs({ tools, permissionMode, maxBudgetUsd, systemPrompt });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
    let out = '';
    let err = '';
    let settled = false;
    const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
    const MAX_ERROR_BYTES = 64 * 1024;
    let outputBytes = 0;
    let errorBytes = 0;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`Claude timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(reject, Object.assign(new Error('Cancelled'), { cancelled: true }));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => {
      outputBytes += d.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(reject, new Error('Claude output exceeded the 8 MiB safety limit'));
        return;
      }
      out += d;
    });
    child.stderr.on('data', (d) => {
      errorBytes += d.length;
      if (errorBytes > MAX_ERROR_BYTES) {
        child.kill('SIGKILL');
        finish(reject, new Error('Claude stderr exceeded the 64 KiB safety limit'));
        return;
      }
      err += d;
    });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (code !== 0) return finish(reject, new Error(`Claude exit ${code}: ${redact(err || out).slice(0, 1000)}`));
      try {
        const parsed = JSON.parse(out);
        if (parsed.is_error) return finish(reject, new Error(`Claude reported an error: ${redact(parsed.result ?? '').slice(0, 500)}`));
        finish(resolve, parsed);
      } catch {
        finish(reject, new Error('Invalid Claude output'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(instruction);
  });
}
