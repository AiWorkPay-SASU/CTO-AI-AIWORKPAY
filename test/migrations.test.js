import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Cto } from '../src/cto.js';
import { SupabaseStore } from '../src/store/index.js';
import { startFakePostgrest } from '../testkit/fake-postgrest.js';
import { startPostgres, postgresUnavailableReason } from '../testkit/pg.js';
import {
  makeRepo, tmpDir, write, scriptedRunner, PLAN, GOOD_SLUG, SLUG_TEST, PASS_REVIEW, reviewWith, trustedFixtureTests
} from '../testkit/fixtures.js';

// The SQL migrations are executed on a REAL local PostgreSQL (throwaway cluster), not on Supabase: roles are
// re-created by hand and there is no PostgREST. What this proves: the SQL is valid and idempotent, RLS denies
// anon/authenticated, the audit trail is append-only, and everything the engine writes satisfies the constraints.

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const TABLES = ['cto_missions', 'cto_tasks', 'cto_reports', 'cto_events', 'cto_approvals', 'cto_costs'];
const unavailable = postgresUnavailableReason();
let pg = null;
let db = 0;

const freshDb = () => {
  const name = `cto_${(db += 1)}`;
  pg.psql(`create database ${name}`);
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    pg.psql(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'), { db: name });
  }
  // Supabase grants service_role on new tables through default privileges; emulate that here.
  pg.psql('grant all on all tables in schema public to service_role; grant usage on schema public to anon, authenticated, service_role',
    { db: name });
  return name;
};

const skip = (t) => {
  if (!unavailable) return false;
  if (process.env.CTO_REQUIRE_PG_TESTS === '1') assert.fail(`PostgreSQL unavailable: ${unavailable}`);
  t.skip(`PostgreSQL unavailable: ${unavailable}`);
  return true;
};

before(() => {
  if (unavailable) return;
  pg = startPostgres();
  for (const role of ['anon', 'authenticated', 'service_role']) pg.psql(`create role ${role} nologin`);
  pg.psql('alter role service_role bypassrls');
});
after(() => pg?.stop());

const MISSION = '11111111-1111-4111-8111-111111111111';
const insertMission = (d, id = MISSION) => pg.psql(
  `insert into public.cto_missions (id, mission_id, status, data) values ('${id}', null, 'running', '{"status":"running"}')`, { db: d, role: 'service_role' });

test('migrations apply in order and can be applied again without error', (t) => {
  if (skip(t)) return;
  const d = freshDb();
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    pg.psql(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'), { db: d });
  }
  assert.equal(pg.psql(`select count(*) from pg_class where relname in (${TABLES.map((x) => `'${x}'`).join(',')}) and relrowsecurity and relforcerowsecurity`, { db: d }), '6');
});

test('RLS: anon and authenticated can neither read nor write any CTO table; the service role can', (t) => {
  if (skip(t)) return;
  const d = freshDb();
  insertMission(d);
  for (const role of ['anon', 'authenticated']) {
    for (const table of TABLES) {
      assert.throws(() => pg.psql(`select count(*) from public.${table}`, { db: d, role }), /permission denied/, `${role} read ${table}`);
      assert.throws(() => pg.psql(`insert into public.${table} (id, data) values ('${randomUUID()}', '{}')`, { db: d, role }), /permission denied/, `${role} write ${table}`);
    }
  }
  assert.equal(pg.psql('select count(*) from public.cto_missions', { db: d, role: 'service_role' }), '1');
  assert.throws(() => pg.psql('select public.cto_events_append_only()', { db: d, role: 'anon' }), /permission denied/, 'the trigger function is not an API');
});

test('the audit trail is append-only, even for the service role', (t) => {
  if (skip(t)) return;
  const d = freshDb();
  insertMission(d);
  const event = randomUUID();
  pg.psql(`insert into public.cto_events (id, mission_id, data) values ('${event}', '${MISSION}', '{"mission_id":"${MISSION}","type":"x"}')`, { db: d, role: 'service_role' });
  for (const sql of [`update public.cto_events set data = '{}' where id = '${event}'`, `delete from public.cto_events where id = '${event}'`, 'truncate public.cto_events']) {
    assert.throws(() => pg.psql(sql, { db: d, role: 'service_role' }), /append-only|permission denied/, sql);
  }
  assert.equal(pg.psql('select count(*) from public.cto_events', { db: d, role: 'service_role' }), '1');
});

test('one approval per (mission, kind) is enforced by the database', (t) => {
  if (skip(t)) return;
  const d = freshDb();
  insertMission(d);
  const approve = (id) => pg.psql(
    `insert into public.cto_approvals (id, mission_id, data) values ('${id}', '${MISSION}', '{"mission_id":"${MISSION}","kind":"architecture","decision":"approve"}')`, { db: d, role: 'service_role' });
  approve(randomUUID());
  assert.throws(() => approve(randomUUID()), /duplicate key/);
});

test('stale writes are rejected: rev must advance by exactly one; id and mission are immutable', (t) => {
  if (skip(t)) return;
  const d = freshDb();
  insertMission(d);
  const update = (set) => pg.psql(`update public.cto_missions set ${set} where id = '${MISSION}'`, { db: d, role: 'service_role' });
  update('rev = 1');
  assert.throws(() => update('rev = 1'), /stale write/, 'same rev again');
  assert.throws(() => update('rev = 5'), /stale write/, 'skipping revs');
  assert.throws(() => update("data = '{\"status\":\"running\",\"x\":1}'"), /stale write/, 'no rev change at all');
  assert.throws(() => update(`rev = 2, id = '${randomUUID()}'`), /cannot change id/);
  update('rev = 2');
  assert.equal(pg.psql(`select rev from public.cto_missions where id = '${MISSION}'`, { db: d }), '2');
});

test('indexed columns must mirror the record, and statuses must be known', (t) => {
  if (skip(t)) return;
  const d = freshDb();
  const bad = (sql) => assert.throws(() => pg.psql(sql, { db: d, role: 'service_role' }), /violates check constraint/, sql);
  bad(`insert into public.cto_missions (id, status, data) values ('${randomUUID()}', 'running', '{"status":"completed"}')`);
  bad(`insert into public.cto_missions (id, status, data) values ('${randomUUID()}', 'flying', '{"status":"flying"}')`);
  insertMission(d);
  bad(`insert into public.cto_tasks (id, mission_id, status, data) values ('${randomUUID()}', '${MISSION}', 'queued', '{"status":"queued","mission_id":"${randomUUID()}"}')`);
  bad(`insert into public.cto_tasks (id, mission_id, status, data) values ('${randomUUID()}', '${MISSION}', 'napping', '{"status":"napping","mission_id":"${MISSION}"}')`);
});

// ------------------------------------------------------------ engine replay

const crash = async () => { throw new Error('agent crashed'); };
const backendGood = async ({ cwd }) => { write(cwd, 'src/slug.js', GOOD_SLUG); write(cwd, 'test/slug.test.js', SLUG_TEST); return { result: 'ok' }; };
const backendFix = async ({ cwd }) => { write(cwd, 'src/slug.js', `${GOOD_SLUG}// reviewed\n`); return { result: 'fixed' }; };

test('everything a real engine run writes is accepted by the schema, and every update advances rev by one', async (t) => {
  if (skip(t)) return;
  const fake = await startFakePostgrest();
  t.after(fake.close);
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const store = new SupabaseStore({ url: fake.url, serviceRoleKey: fake.apiKey });
  const make = (steps) => new Cto({
    store, runner: scriptedRunner({ architect: [async () => ({ result: PLAN })], ...steps }), repoPath: repo,
    workspacesDir: tmpDir('cto-mig-ws-'), testRunner: trustedFixtureTests, limits: { backoffMs: 1, reconcileGraceMs: 0, maxCorrections: 2 }
  });
  const go = async (cto, { stopAt = null } = {}) => {
    const m = await cto.createMission({ objective: 'Implement slugify', project: 'owner/repo', budgetUsd: 10 });
    await cto.approve(m.id, { kind: 'mission', decision: 'approve' });
    await cto.drain();
    if (stopAt === 'cancel') return cto.cancelMission(m.id);
    await cto.approve(m.id, { kind: 'architecture', decision: 'approve' });
    await cto.drain();
    return cto.getMission(m.id);
  };
  // 1) clean success, completed by the owner
  const a = make({ backend: [backendGood] });
  const done = await go(a);
  await a.approve(done.id, { kind: 'completion', decision: 'approve' });
  // 2) cancelled before the architecture was approved
  await go(make({ backend: [backendGood] }), { stopAt: 'cancel' });
  // 3) agent crashes until escalation, then the owner resumes
  const c = make({ backend: [crash, crash, crash, backendGood] });
  const blocked = await go(c);
  assert.equal(blocked.status, 'blocked');
  await c.resumeMission(blocked.id);
  await c.drain();
  // 4) a blocking independent review sends the work back, a corrected commit passes
  const failing = async () => ({ result: reviewWith('fail', [{ severity: 'high', file: 'src/slug.js', issue: 'handles nothing' }]) });
  const reviewed = await go(make({ backend: [backendGood, backendFix], qa: [failing, async () => ({ result: PASS_REVIEW })] }));
  assert.equal(reviewed.status, 'review');

  // every PATCH the store made moved rev by exactly one (what the database trigger demands)
  const patches = fake.requests.filter((r) => r.method === 'PATCH');
  assert.ok(patches.length > 50);
  for (const r of patches) {
    const expected = Number(new URLSearchParams(r.query).get('rev').replace('eq.', ''));
    assert.equal(r.body.rev, expected + 1, `${r.table} update`);
  }

  // load exactly what the store persisted into the real schema, parents first
  const d = freshDb();
  const loaded = {};
  for (const table of TABLES) {
    const rows = fake.tables.get(table) ?? [];
    loaded[table] = rows.length;
    if (!rows.length) continue;
    const json = JSON.stringify(rows);
    assert.ok(!json.includes('$cto_json$'));
    pg.psql(`insert into public.${table} select * from jsonb_populate_recordset(null::public.${table}, $cto_json$${json}$cto_json$::jsonb)`, { db: d, role: 'service_role' });
  }
  assert.ok(loaded.cto_missions === 4 && loaded.cto_tasks === 16 && loaded.cto_events > 40 && loaded.cto_approvals >= 6 && loaded.cto_costs > 10, JSON.stringify(loaded));
  const statuses = pg.psql("select string_agg(distinct status, ',' order by status) from public.cto_tasks", { db: d }).split(',');
  for (const expected of ['cancelled', 'done']) assert.ok(statuses.includes(expected), `task status ${expected} present in the replayed data`);
});
