import { randomUUID } from 'node:crypto';
import { redact } from './util.js';

/** Appends an audit event. Details are JSON-serialized, redacted and size-bounded. */
export async function emit(store, { mission_id = null, task_id = null, type, actor = 'cto', detail = {} }) {
  if (!type) throw new Error('Event type required');
  const safeDetail = JSON.parse(redact(JSON.stringify(detail ?? {}).slice(0, 8000) || '{}'));
  return store.insert('events', {
    id: randomUUID(),
    mission_id,
    task_id,
    type,
    actor,
    detail: safeDetail,
    at: new Date().toISOString()
  });
}
