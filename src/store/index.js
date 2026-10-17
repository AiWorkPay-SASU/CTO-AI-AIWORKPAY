import path from 'node:path';
import { FileStore } from './file-store.js';
import { SupabaseStore } from './supabase-store.js';

export { FileStore, SupabaseStore };

/**
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY select the Supabase backend;
 * otherwise a durable local file store under CTO_DATA_DIR (default ./.cto-data) is used.
 */
export function storeFromEnv(env = process.env) {
  if (env.SUPABASE_URL || env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseStore({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY });
  }
  return new FileStore(path.resolve(env.CTO_DATA_DIR || '.cto-data'));
}
