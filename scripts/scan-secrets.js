// Scans git-tracked and untracked (non-ignored) files for secret-like values.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const PATTERNS = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/]
];

const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

const hits = [];
for (const file of listed) {
  if (!fs.existsSync(file) || fs.statSync(file).size > 1024 * 1024) continue;
  if (file === 'scripts/scan-secrets.js' || file.startsWith('test/') || file.startsWith('testkit/')) continue; // fixtures use fake values
  const text = fs.readFileSync(file, 'utf8');
  for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(`${file}: ${name}`);
}

if (hits.length) {
  console.error(`Secret-like values found:\n${hits.join('\n')}`);
  process.exit(1);
}
console.log(`secret scan ok (${listed.length} files)`);
