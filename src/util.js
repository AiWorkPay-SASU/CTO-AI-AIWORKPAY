import { createHash, timingSafeEqual } from 'node:crypto';

/** Patterns of well-known secret formats. Every report, event and prompt goes through redact(). */
const SECRET_PATTERNS = [
  { re: /sk-ant-[A-Za-z0-9_-]{10,}/g, to: '[REDACTED]' },
  { re: /\bsk-[A-Za-z0-9]{20,}/g, to: '[REDACTED]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, to: '[REDACTED]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, to: '[REDACTED]' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, to: '[REDACTED_JWT]' },
  { re: /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, to: '$1[REDACTED]' },
  {
    re: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[=:]\s*)['"]?[^\s'"]{8,}/gi,
    to: '$1[REDACTED]'
  }
];

export function redact(value) {
  let out = String(value ?? '');
  for (const { re, to } of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

export function containsSecret(value) {
  const text = String(value ?? '');
  return SECRET_PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    const hit = re.test(text);
    re.lastIndex = 0;
    return hit;
  });
}

/** Strips control characters (except tab/newline) and bounds the length. */
export function sanitizeText(value, max = 4000) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

/** Constant-time string comparison (hashes first so lengths never leak). */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export const nowIso = (now = Date.now()) => new Date(now).toISOString();

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Environment given to agent processes and test runs: an allowlist.
 * GitHub, Supabase and admin credentials are never forwarded.
 */
export function buildAgentEnv(env = process.env) {
  const allowExact = new Set([
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER', 'SHELL',
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
    'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'
  ]);
  const allowPrefixes = ['ANTHROPIC_', 'CLAUDE_', 'CCR_'];
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (allowExact.has(key) || allowPrefixes.some((p) => key.startsWith(p))) out[key] = value;
  }
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}

/** Tests receive no provider credentials, proxies, home directory or runtime preload flags. */
export function buildTestEnv() {
  return { PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8' };
}

