import { emit } from './events.js';
import { validateTaskTransition } from './core.js';

const CLAIMABLE_MISSION = new Set(['approved', 'running']);

/**
 * Durable job queue on top of the store. Nothing about execution lives only in memory:
 * leases, attempts, failures and cancellations are persisted, so a restarted process can
 * call recoverExpired() and continue.
 */
export class JobQueue {
  constructor({ store, leaseMs = 60000, maxFailures = 3, maxConcurrent = 2, backoffMs = 1000 }) {
    this.store = store;
    this.leaseMs = leaseMs;
    this.maxFailures = maxFailures;
    this.maxConcurrent = maxConcurrent;
    this.backoffMs = backoffMs;
  }

  async enqueue(task) {
    return this.store.insert('tasks', task);
  }

  async runningCount() {
    return (await this.store.list('tasks', { status: 'running' })).length;
  }

  /** True when the task may be dispatched: mission state, approval gate and dependency are all satisfied. */
  async isDispatchable(task, now) {
    if (task.not_before && task.not_before > now) return false;
    const mission = await this.store.get('missions', task.mission_id);
    if (!mission || !CLAIMABLE_MISSION.has(mission.status)) return false;
    if (task.requires_approval) {
      const approvals = await this.store.list('approvals', { mission_id: task.mission_id });
      const granted = approvals.some((a) => a.kind === task.requires_approval && a.decision === 'approve');
      if (!granted) return false;
    }
    if (task.depends_on) {
      const dep = await this.store.get('tasks', task.depends_on);
      if (!dep || dep.status !== 'done') return false;
    }
    return true;
  }

  /**
   * Leases the next dispatchable task, or returns null. `accept` is an optional async
   * predicate (budget checks) evaluated after the built-in gates.
   */
  async claimNext({ workerId, now = Date.now(), accept = null }) {
    if ((await this.runningCount()) >= this.maxConcurrent) return null;
    const queued = await this.store.list('tasks', { status: 'queued' });
    for (const task of queued) {
      if (!(await this.isDispatchable(task, new Date(now).toISOString()))) continue;
      if (accept && !(await accept(task))) continue;
      validateTaskTransition('queued', 'running');
      const claimed = await this.store.cas('tasks', task.id, { status: 'queued' }, {
        status: 'running',
        worker_id: workerId,
        attempts: task.attempts + 1,
        lease_expires_at: now + this.leaseMs,
        started_at: new Date(now).toISOString()
      });
      if (claimed) {
        await emit(this.store, {
          mission_id: task.mission_id,
          task_id: task.id,
          type: 'task_leased',
          actor: workerId,
          detail: { role: task.role, attempt: claimed.attempts }
        });
        return claimed;
      }
    }
    return null;
  }

  async heartbeat(taskId, workerId, now = Date.now()) {
    const task = await this.store.get('tasks', taskId);
    if (!task || task.status !== 'running' || task.worker_id !== workerId) return null;
    return this.store.cas('tasks', taskId, { status: 'running', worker_id: workerId }, {
      lease_expires_at: now + this.leaseMs
    });
  }

  /** Moves a running task to review (agent finished; the CTO must still verify). */
  async toReview(taskId, patch = {}) {
    validateTaskTransition('running', 'review');
    return this.store.cas('tasks', taskId, { status: 'running' }, { status: 'review', lease_expires_at: null, ...patch });
  }

  async markDone(taskId, patch = {}) {
    validateTaskTransition('review', 'done');
    return this.store.cas('tasks', taskId, { status: 'review' }, { status: 'done', finished_at: new Date().toISOString(), ...patch });
  }

  /** Verification failed: send the task back with feedback for the same specialist. */
  async requestCorrection(taskId, feedback) {
    const task = await this.store.get('tasks', taskId);
    if (!task || task.status !== 'review') return null;
    validateTaskTransition('review', 'queued');
    return this.store.cas('tasks', taskId, { status: 'review' }, {
      status: 'queued',
      corrections: task.corrections + 1,
      feedback,
      not_before: null
    });
  }

  async failPermanently(taskId, error, from = 'review') {
    validateTaskTransition(from, 'failed');
    return this.store.cas('tasks', taskId, { status: from }, {
      status: 'failed',
      error,
      lease_expires_at: null,
      finished_at: new Date().toISOString()
    });
  }

  /** Crash/timeout path: requeue with backoff until maxFailures is reached. */
  async retryOrFail(taskId, error, now = Date.now()) {
    const task = await this.store.get('tasks', taskId);
    if (!task || task.status !== 'running') return null;
    const failures = task.failures + 1;
    if (failures >= this.maxFailures) {
      await this.store.cas('tasks', taskId, { status: 'running' }, {
        status: 'failed', failures, error, lease_expires_at: null, finished_at: new Date(now).toISOString()
      });
      await emit(this.store, { mission_id: task.mission_id, task_id: taskId, type: 'task_failed', detail: { error, failures } });
      return 'failed';
    }
    await this.store.cas('tasks', taskId, { status: 'running' }, {
      status: 'queued',
      failures,
      error,
      lease_expires_at: null,
      not_before: new Date(now + this.backoffMs * 2 ** (failures - 1)).toISOString()
    });
    await emit(this.store, { mission_id: task.mission_id, task_id: taskId, type: 'task_retry_scheduled', detail: { error, failures } });
    return 'requeued';
  }

  /** Restart recovery: leases that expired belong to a dead worker. */
  async recoverExpired(now = Date.now()) {
    const running = await this.store.list('tasks', { status: 'running' });
    const recovered = [];
    for (const task of running) {
      if (!task.lease_expires_at || task.lease_expires_at > now) continue;
      const outcome = await this.retryOrFail(task.id, 'lease expired (worker lost)', now);
      await emit(this.store, { mission_id: task.mission_id, task_id: task.id, type: 'lease_expired', detail: { outcome } });
      recovered.push({ id: task.id, outcome });
    }
    return recovered;
  }

  /** Cancels every non-terminal task of a mission. Returns ids that were running. */
  async cancelMission(missionId) {
    const tasks = await this.store.list('tasks', { mission_id: missionId });
    const wasRunning = [];
    for (const task of tasks) {
      if (['done', 'failed', 'cancelled'].includes(task.status)) continue;
      if (task.status === 'running') wasRunning.push(task.id);
      await this.store.cas('tasks', task.id, { status: task.status }, {
        status: 'cancelled', lease_expires_at: null, finished_at: new Date().toISOString()
      });
    }
    return wasRunning;
  }
}
