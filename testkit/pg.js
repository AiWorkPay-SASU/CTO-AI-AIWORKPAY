import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Throwaway local PostgreSQL cluster (unix socket only, no network) used to run the SQL migrations for real.
 * It is REAL PostgreSQL but NOT Supabase: there is no PostgREST, no Supabase auth and the `anon`, `authenticated`
 * and `service_role` roles are re-created by hand, so a green run proves the SQL, not a live project.
 */
export function findPostgresBin() {
  const dirs = [process.env.CTO_PG_BIN].filter(Boolean);
  const root = '/usr/lib/postgresql';
  if (fs.existsSync(root)) {
    dirs.push(...fs.readdirSync(root).sort((a, b) => Number(b) - Number(a)).map((v) => path.join(root, v, 'bin')));
  }
  return dirs.find((d) => fs.existsSync(path.join(d, 'initdb')) && fs.existsSync(path.join(d, 'pg_ctl'))) ?? null;
}

export function postgresUnavailableReason() {
  if (process.platform !== 'linux') return 'not Linux';
  if (!findPostgresBin()) return 'no PostgreSQL server binaries found (install postgresql, or set CTO_PG_BIN)';
  try { execFileSync('psql', ['--version'], { stdio: 'ignore' }); } catch { return 'psql client not found'; }
  if (process.getuid?.() === 0) {
    try { execFileSync('runuser', ['-u', 'nobody', '--', 'true'], { stdio: 'ignore' }); } catch { return 'running as root and runuser is unavailable'; }
  }
  return null;
}

export function startPostgres() {
  const bin = findPostgresBin();
  const asRoot = process.getuid?.() === 0;
  const dir = fs.mkdtempSync('/tmp/ctopg-'); // short path: unix socket paths are length-limited
  fs.chmodSync(dir, 0o755);
  const wrap = (cmd, args) => (asRoot ? ['runuser', ['-u', 'nobody', '--', cmd, ...args]] : [cmd, args]);
  if (asRoot) execFileSync('chown', ['nobody', dir]);
  const exec = (cmd, args) => { const [c, a] = wrap(cmd, args); return execFileSync(c, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); };
  exec(path.join(bin, 'initdb'), ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres']);
  exec(path.join(bin, 'pg_ctl'), [
    '-D', path.join(dir, 'data'), '-o', `-c listen_addresses='' -c unix_socket_directories=${dir} -c fsync=off`,
    '-l', path.join(dir, 'log'), '-w', 'start'
  ]);
  const psql = (sql, { db = 'postgres', user = 'postgres', role = null } = {}) => {
    const script = `${role ? `set role ${role};\n` : ''}${sql}`;
    const res = spawnSync('psql', ['-h', dir, '-U', user, '-d', db, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: script, encoding: 'utf8' });
    if (res.status !== 0) throw Object.assign(new Error(res.stderr.trim()), { stderr: res.stderr });
    return res.stdout.trim();
  };
  return {
    psql,
    stop() {
      try { exec(path.join(bin, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* already down */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
