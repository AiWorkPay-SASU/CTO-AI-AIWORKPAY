// Dependency-free lint: syntax check of every JS file (node --check) plus a few repository rules.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'test', 'testkit', 'scripts', 'public'];
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(c|m)?js$/.test(entry.name)) files.push(full);
  }
};
roots.filter((r) => fs.existsSync(r)).forEach(walk);

const problems = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    problems.push(`${file}: ${String(e.stderr).split('\n').slice(0, 3).join(' ')}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  if (/\binnerHTML\s*=/.test(source) && file.startsWith('public')) problems.push(`${file}: innerHTML assignment (XSS risk)`);
  if (/\beval\(|new Function\(/.test(source)) problems.push(`${file}: eval/new Function is forbidden`);
  if (file.startsWith('public') && /localStorage|sessionStorage|document\.cookie/.test(source)) {
    problems.push(`${file}: browser storage must not be used for credentials`);
  }
  if (file.startsWith('public') && /SERVICE_ROLE|SUPABASE/.test(source)) problems.push(`${file}: server secret reference in client code`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`lint ok (${files.length} files)`);
