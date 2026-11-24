import fs from 'node:fs';
import path from 'node:path';

export const TABLES = Object.freeze(['missions', 'tasks', 'reports', 'events', 'approvals', 'costs', 'delegations']);

/**
 * Durable single-process store: one JSON state file written atomically (tmp + rename).
 * All operations are serialized, so compare-and-set is atomic inside the process.
 * It is the development/test backend; Supabase is the shared backend.
 */
export class FileStore {
  constructor(dir) {
    if (!dir) throw new Error('FileStore requires a directory');
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
    this.state = this.#load();
    this.chain = Promise.resolve();
  }

  #load() {
    const empty = Object.fromEntries(TABLES.map((t) => [t, {}]));
    if (!fs.existsSync(this.file)) return empty;
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const t of TABLES) parsed[t] ??= {};
    return parsed;
  }

  #persist() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  #tx(fn) {
    const run = this.chain.then(() => {
      const result = fn();
      this.#persist();
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  #table(name) {
    if (!TABLES.includes(name)) throw new Error(`Unknown table ${name}`);
    return this.state[name];
  }

  async insert(table, row) {
    return this.#tx(() => {
      const t = this.#table(table);
      if (!row?.id) throw new Error('Row id required');
      if (t[row.id]) throw new Error(`Duplicate id ${row.id} in ${table}`);
      const now = new Date().toISOString();
      const stored = { ...structuredClone(row), rev: 0, created_at: row.created_at ?? now, updated_at: now };
      stored.seq = Object.keys(t).length;
      t[row.id] = stored;
      return structuredClone(stored);
    });
  }

  async get(table, id) {
    return this.#tx(() => {
      const row = this.#table(table)[id];
      return row ? structuredClone(row) : null;
    });
  }

  async update(table, id, patch) {
    return this.cas(table, id, {}, patch);
  }

  /** Compare-and-set: applies patch only if every field in `expect` currently matches. */
  async cas(table, id, expect, patch) {
    if (table === 'events') throw new Error('events are append-only');
    return this.#tx(() => {
      const row = this.#table(table)[id];
      if (!row) return null;
      for (const [k, v] of Object.entries(expect)) if (row[k] !== v) return null;
      Object.assign(row, structuredClone(patch), { rev: row.rev + 1, updated_at: new Date().toISOString() });
      return structuredClone(row);
    });
  }

  async list(table, filter = {}) {
    return this.#tx(() =>
      Object.values(this.#table(table))
        .filter((row) => Object.entries(filter).every(([k, v]) => row[k] === v))
        .sort((a, b) => a.seq - b.seq)
        .map((row) => structuredClone(row))
    );
  }
}
