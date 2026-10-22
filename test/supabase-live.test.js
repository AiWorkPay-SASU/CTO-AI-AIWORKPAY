import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStore } from '../src/store/supabase-store.js';

/**
 * Opt-in read-only integration test against a dedicated CTO Supabase project.
 * Never prints credentials, never creates records, never invokes Claude.
 * Run with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set privately.
 */
test('live Supabase: all six CTO tables are readable by the server role', { skip: !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY }, async () => {
  const url = process.env.SUPABASE_URL;
  assert.equal(new URL(url).hostname, 'wdfvaxdesxqwipqsavqm.supabase.co',
    'Refusing to test against a project other than the dedicated CTO development database');
  const store = new SupabaseStore({ url, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  for (const table of ['missions', 'tasks', 'reports', 'events', 'approvals', 'costs']) {
    const rows = await store.list(table);
    assert.ok(Array.isArray(rows), `Expected array for ${table}`);
  }
});
