import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, containsSecret, sanitizeText, safeEqual, buildAgentEnv } from '../src/util.js';

const FAKE_GH = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const FAKE_ANT = `sk-ant-${'x9Y8z7'.repeat(6)}`;

test('redact removes well-known secret formats', () => {
  const text = `token ${FAKE_GH} and ${FAKE_ANT} and Authorization: Bearer abcdefghijklmnop12345 and SUPABASE_SERVICE_ROLE_KEY=abcdefgh12345678`;
  const out = redact(text);
  for (const leaked of [FAKE_GH, FAKE_ANT, 'abcdefghijklmnop12345', 'abcdefgh12345678']) assert.ok(!out.includes(leaked), leaked);
  assert.match(out, /SUPABASE_SERVICE_ROLE_KEY=\[REDACTED\]/);
});

test('redact keeps ordinary text', () => {
  assert.equal(redact('hello world 42'), 'hello world 42');
});

test('containsSecret is stable across repeated calls', () => {
  assert.equal(containsSecret(FAKE_GH), true);
  assert.equal(containsSecret(FAKE_GH), true);
  assert.equal(containsSecret('nothing here'), false);
});

test('sanitizeText strips control chars and truncates', () => {
  assert.equal(sanitizeText('a\u0000b\u001bc', 10), 'abc');
  assert.equal(sanitizeText('abcdef', 3), 'abc');
  assert.equal(sanitizeText('keep\nnewline'), 'keep\nnewline');
});

test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('agent environment is an allowlist: no GitHub, Supabase or admin secrets', () => {
  const env = buildAgentEnv({
    PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_X: '1', HTTPS_PROXY: 'p',
    GH_TOKEN: 'g', GITHUB_TOKEN: 'g', SUPABASE_SERVICE_ROLE_KEY: 's', CTO_ADMIN_TOKEN: 'a', AWS_SECRET_ACCESS_KEY: 'z', RANDOM: 'r'
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.ANTHROPIC_API_KEY, 'k');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'CTO_ADMIN_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'RANDOM']) {
    assert.equal(env[k], undefined, k);
  }
});
