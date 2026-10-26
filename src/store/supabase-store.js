/**
 * Supabase backend using the PostgREST HTTP API directly (no npm dependency).
 * Server-side only: it needs the service-role key, which must never reach a browser.
 *
 * Row layout (see supabase/migrations/001_init.sql): id, mission_id, status, data jsonb, rev, timestamps.
 * Compare-and-set is optimistic: PATCH ... WHERE id=? AND rev=? (and status=?), 0 rows => lost the race.
 */
const TABLE_NAMES = Object.freeze({
  missions: 'cto_missions',
  tasks: 'cto_tasks',
  reports: 'cto_reports',
  events: 'cto_events',
  approvals: 'cto_approvals',
  costs: 'cto_costs'
});

const enc = encodeURIComponent;
const PAGE_SIZE = 500;
const MAX_LIST_ROWS = 500000;

export class SupabaseStore {
  constructor({ url, serviceRoleKey, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    if (!url || !serviceRoleKey) throw new Error('Supabase server credentials required');
    this.base = `${url.replace(/\/+$/, '')}/rest/v1`;
    this.headers = {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json'
    };
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  #name(table) {
    const name = TABLE_NAMES[table];
    if (!name) throw new Error(`Unknown table ${table}`);
    return name;
  }

  async #request(method, pathAndQuery, body, extraHeaders = {}) {
    const res = await this.fetch(`${this.base}/${pathAndQuery}`, {
      method,
      headers: { ...this.headers, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${method} ${pathAndQuery.split('?')[0]} failed: ${res.status}`);
    return text ? JSON.parse(text) : null;
  }

  static #toDomain(row) {
    return {
      ...row.data,
      id: row.id,
      mission_id: row.mission_id ?? row.data?.mission_id,
      status: row.status ?? row.data?.status,
      rev: row.rev,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  async insert(table, row) {
    if (!row?.id) throw new Error('Row id required');
    const created = await this.#request(
      'POST',
      this.#name(table),
      { id: row.id, mission_id: row.mission_id ?? null, status: row.status ?? null, data: row },
      { prefer: 'return=representation' }
    );
    return SupabaseStore.#toDomain(created[0]);
  }

  async #getRaw(table, id) {
    const rows = await this.#request('GET', `${this.#name(table)}?id=eq.${enc(id)}&select=*`);
    return rows?.[0] ?? null;
  }

  async get(table, id) {
    const raw = await this.#getRaw(table, id);
    return raw ? SupabaseStore.#toDomain(raw) : null;
  }

  async update(table, id, patch) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await this.cas(table, id, {}, patch);
      if (result !== 'conflict') return result;
    }
    throw new Error('Too many concurrent updates');
  }

  /** Returns the updated row, null if the row is missing or `expect` does not match. */
  async cas(table, id, expect, patch) {
    if (table === 'events') throw new Error('events are append-only');
    const raw = await this.#getRaw(table, id);
    if (!raw) return null;
    const current = SupabaseStore.#toDomain(raw);
    for (const [k, v] of Object.entries(expect)) if (current[k] !== v) return null;
    const merged = { ...raw.data, ...patch };
    const statusFilter = raw.status === null ? '' : `&status=eq.${enc(raw.status)}`;
    const updated = await this.#request(
      'PATCH',
      `${this.#name(table)}?id=eq.${enc(id)}&rev=eq.${raw.rev}${statusFilter}`,
      {
        status: merged.status ?? null,
        mission_id: merged.mission_id ?? null,
        data: merged,
        rev: raw.rev + 1,
        updated_at: new Date().toISOString()
      },
      { prefer: 'return=representation' }
    );
    if (!updated?.length) return Object.keys(expect).length ? null : 'conflict';
    return SupabaseStore.#toDomain(updated[0]);
  }

  /**
   * Lists every matching row. PostgREST/Supabase caps a single response (1000 rows by default), so the
   * rows are read page by page with a stable order until an empty page comes back: a lower server cap
   * than PAGE_SIZE is therefore harmless, and nothing is silently dropped.
   */
  async list(table, filter = {}) {
    const query = ['select=*', 'order=created_at.asc,id.asc'];
    if (filter.mission_id) query.push(`mission_id=eq.${enc(filter.mission_id)}`);
    if (filter.status) query.push(`status=eq.${enc(filter.status)}`);
    const rows = [];
    for (let offset = 0; ; ) {
      const page = await this.#request('GET', `${this.#name(table)}?${query.join('&')}&limit=${PAGE_SIZE}&offset=${offset}`);
      if (!Array.isArray(page) || page.length === 0) break;
      rows.push(...page);
      offset += page.length;
      if (rows.length > MAX_LIST_ROWS) throw new Error(`Supabase list of ${this.#name(table)} exceeds ${MAX_LIST_ROWS} rows`);
    }
    return rows
      .map((r) => SupabaseStore.#toDomain(r))
      .filter((row) => Object.entries(filter).every(([k, v]) => row[k] === v));
  }
}
