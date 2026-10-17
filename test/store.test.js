import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FileStore, SupabaseStore, storeFromEnv } from '../src/store/index.js';
import { startFakePostgrest } from '../testkit/fake-postgrest.js';
import { tmpDir } from '../testkit/fixtures.js';

function contract(name, makeStore) {
  describe(`store contract: ${name}`, () => {
    test('insert / get / list / update', async (t) => {
      const { store, close } = await makeStore();
      t.after(close);
      const missionId = randomUUID();
      await store.insert('missions', { id: missionId, status: 'pending_approval', project: 'o/r' });
      await store.insert('tasks', { id: randomUUID(), mission_id: missionId, status: 'queued', n: 1 });
      await store.insert('tasks', { id: randomUUID(), mission_id: randomUUID(), status: 'queued', n: 2 });
      assert.equal((await store.get('missions', missionId)).project, 'o/r');
      assert.equal(await store.get('missions', randomUUID()), null);
      assert.equal((await store.list('tasks', { mission_id: missionId })).length, 1);
      assert.equal((await store.list('tasks', { status: 'queued' })).length, 2);
      const updated = await store.update('missions', missionId, { status: 'approved' });
      assert.equal(updated.status, 'approved');
      assert.equal(updated.project, 'o/r');
      assert.equal((await store.get('missions', missionId)).status, 'approved');
    });

    test('duplicate ids are rejected', async (t) => {
      const { store, close } = await makeStore();
      t.after(close);
      const id = randomUUID();
      await store.insert('missions', { id, status: 'x' });
      await assert.rejects(() => store.insert('missions', { id, status: 'x' }));
    });

    test('compare-and-set applies only when the expectation holds', async (t) => {
      const { store, close } = await makeStore();
      t.after(close);
      const id = randomUUID();
      await store.insert('tasks', { id, mission_id: randomUUID(), status: 'queued' });
      assert.equal(await store.cas('tasks', id, { status: 'running' }, { status: 'done' }), null);
      assert.equal((await store.cas('tasks', id, { status: 'queued' }, { status: 'running' })).status, 'running');
      assert.equal(await store.cas('tasks', randomUUID(), { status: 'queued' }, { status: 'running' }), null);
    });

    test('concurrent claims: exactly one wins', async (t) => {
      const { store, close } = await makeStore();
      t.after(close);
      const id = randomUUID();
      await store.insert('tasks', { id, mission_id: randomUUID(), status: 'queued' });
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.cas('tasks', id, { status: 'queued' }, { status: 'running', worker: i }))
      );
      assert.equal(results.filter(Boolean).length, 1);
    });

    test('events are append-only', async (t) => {
      const { store, close } = await makeStore();
      t.after(close);
      const id = randomUUID();
      await store.insert('events', { id, type: 'x' });
      await assert.rejects(() => store.update('events', id, { type: 'y' }), /append-only/);
      await assert.rejects(() => store.cas('events', id, {}, { type: 'y' }), /append-only/);
      assert.equal((await store.get('events', id)).type, 'x');
    });

    test('unknown tables are refused', async (t) => {
      const { store, close } = await makeStore();
      t.after(close);
      await assert.rejects(() => store.insert('secrets', { id: randomUUID() }));
    });
  });
}

contract('FileStore', async () => ({ store: new FileStore(tmpDir('cto-store-')), close: async () => {} }));

contract('SupabaseStore (against a simulated PostgREST)', async () => {
  const fake = await startFakePostgrest();
  return { store: new SupabaseStore({ url: fake.url, serviceRoleKey: fake.apiKey }), close: fake.close };
});

test('FileStore survives a restart (state is on disk)', async () => {
  const dir = tmpDir('cto-store-');
  const a = new FileStore(dir);
  const id = randomUUID();
  await a.insert('missions', { id, status: 'running', project: 'o/r' });
  await a.update('missions', id, { status: 'blocked' });
  const b = new FileStore(dir);
  assert.equal((await b.get('missions', id)).status, 'blocked');
});

test('SupabaseStore sends the service key and encodes filters', async (t) => {
  const fake = await startFakePostgrest();
  t.after(fake.close);
  const store = new SupabaseStore({ url: fake.url, serviceRoleKey: fake.apiKey });
  const id = randomUUID();
  await store.insert('missions', { id, status: 'x' });
  await store.get('missions', id);
  assert.ok(fake.requests.length >= 2);
  assert.ok(fake.requests.every((r) => r.headers.apikey === fake.apiKey));
  assert.ok(fake.requests.every((r) => r.table === 'cto_missions'));
  assert.match(fake.requests.at(-1).query, new RegExp(`id=eq.${id}`));
});

test('SupabaseStore: wrong key surfaces as an error without leaking the key', async (t) => {
  const fake = await startFakePostgrest();
  t.after(fake.close);
  const store = new SupabaseStore({ url: fake.url, serviceRoleKey: 'wrong-wrong-wrong-wrong-key' });
  await assert.rejects(() => store.get('missions', randomUUID()), (e) => {
    assert.match(e.message, /401/);
    assert.ok(!e.message.includes('wrong-wrong'));
    return true;
  });
});

test('SupabaseStore: optimistic lock detects a concurrent write', async (t) => {
  const fake = await startFakePostgrest();
  t.after(fake.close);
  let injected = false;
  // Another writer bumps rev between our read and our first PATCH.
  const racingFetch = async (url, init) => {
    if (init.method === 'PATCH' && !injected) {
      injected = true;
      fake.tables.get('cto_tasks')[0].rev += 1;
    }
    return fetch(url, init);
  };
  const store = new SupabaseStore({ url: fake.url, serviceRoleKey: fake.apiKey, fetchImpl: racingFetch });
  const id = randomUUID();
  await store.insert('tasks', { id, mission_id: randomUUID(), status: 'queued', n: 0 });
  const out = await store.update('tasks', id, { n: 1 });
  assert.equal(out.n, 1);
  assert.equal(fake.requests.filter((r) => r.method === 'PATCH').length, 2, 'first PATCH lost the race, second succeeded');
  assert.equal(fake.tables.get('cto_tasks')[0].rev, 2);
});

test('storeFromEnv picks the backend from the environment', async () => {
  const dir = tmpDir('cto-store-');
  assert.ok(storeFromEnv({ CTO_DATA_DIR: dir }) instanceof FileStore);
  assert.ok(storeFromEnv({ SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(30) }) instanceof SupabaseStore);
  assert.throws(() => storeFromEnv({ SUPABASE_URL: 'http://x' }), /credentials/);
});
