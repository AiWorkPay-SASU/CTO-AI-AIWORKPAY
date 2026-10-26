import { emit } from './events.js';
import { validateTaskTransition, validateOwnerRetry } from './core.js';

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
   * predicate (budget checks) evaluated after the built-in gates; `release` hands a reservation back.
   *
   * The concurrency limit is enforced across workers with a claim-then-verify protocol, because the
   * store only offers per-row compare-and-set: a claim starts as `slot_state: pending`, is confirmed once
   * it fits next to the already-confirmed claims, and is verified again after it was confirmed. Whatever
   * the interleaving, at most `maxConcurrent` claims survive; a claim that does not fit is rolled back.
   */
  async claimNext({ workerId, now = Date.now(), accept = null, release = null }) {
    if ((await this.runningCount()) >= this.maxConcurrent) return null;
    const queued = await this.store.list('tasks', { status: 'queued' });
    for (const task of queued) {
      if (!(await this.isDispatchable(task, new Date(now).toISOString()))) continue;
      const reservation = accept ? await accept(task) : true;
      if (!reservation) continue;
      const reserved = typeof reservation === 'object';
      let claimed = null;
      try {
        validateTaskTransition('queued', 'running');
        claimed = await this.store.cas('tasks', task.id, { status: 'queued' }, {
          status: 'running',
          ...(reserved ? reservation : {}),
          worker_id: workerId,
          attempts: task.attempts + 1,
          lease_expires_at: now + this.leaseMs,
          started_at: new Date(now).toISOString(),
          slot_state: 'pending'
        });
      } catch (error) {
        if (release && reserved) await release(task, reservation);
        throw error;
      }
      if (!claimed) {
        if (release && reserved) await release(task, reservation);
        continue;
      }
      const confirmed = await this.#confirmSlot(claimed, task);
      if (!confirmed) {
        if (release && reserved) await release(task, reservation);
        return null; // the worker pool is full: do not keep scanning
      }
      await emit(this.store, {
        mission_id: task.mission_id,
        task_id: task.id,
        type: 'task_leased',
        actor: workerId,
        detail: { role: task.role, attempt: confirmed.attempts }
      });
      return confirmed;
    }
    return null;
  }

  async #rollbackClaim(claimed, original) {
    await this.store.cas('tasks', claimed.id,
      { status: 'running', worker_id: claimed.worker_id, attempts: claimed.attempts }, {
        status: 'queued', worker_id: null, attempts: original.attempts, lease_expires_at: null,
        started_at: original.started_at ?? null, slot_state: null
      });
  }

  async #confirmSlot(claimed, original) {
    const others = (await this.store.list('tasks', { status: 'running' })).filter((t) => t.id !== claimed.id);
    const confirmedOthers = others.filter((t) => t.slot_state !== 'pending').length;
    const pendingRank = others.filter((t) => t.slot_state === 'pending'
      && (t.started_at ?? '') + t.id < (claimed.started_at ?? '') + claimed.id).length;
    if (confirmedOthers + pendingRank >= this.maxConcurrent) {
      await this.#rollbackClaim(claimed, original);
      return null;
    }
    const confirmed = await this.store.cas('tasks', claimed.id,
      { status: 'running', worker_id: claimed.worker_id, attempts: claimed.attempts }, { slot_state: 'confirmed' });
    if (!confirmed) return null; // lease already lost: somebody else owns the task now
    const survivors = (await this.store.list('tasks', { status: 'running' })).filter((t) => t.slot_state !== 'pending');
    if (survivors.length > this.maxConcurrent) {
      await this.#rollbackClaim(confirmed, original);
      return null;
    }
    return confirmed;
  }

  /**
   * Fencing: every transition made by a worker names the attempt it was leased for. A worker whose lease
   * expired (and whose task was requeued, maybe re-claimed) can therefore never move the new attempt.
   */
  #fence(fence) {
    if (!fence) return {};
    const expect = { worker_id: fence.workerId, attempts: fence.attempt };
    if (fence.leaseExpiresAt !== undefined) expect.lease_expires_at = fence.leaseExpiresAt;
    return expect;
  }

  async heartbeat(taskId, workerId, now = Date.now(), attempt = undefined) {
    const task = await this.store.get('tasks', taskId);
    if (!task || task.status !== 'running' || task.worker_id !== workerId) return null;
    if (attempt !== undefined && task.attempts !== attempt) return null;
    return this.store.cas('tasks', taskId, {
      status: 'running', worker_id: workerId, ...(attempt === undefined ? {} : { attempts: attempt })
    }, { lease_expires_at: now + this.leaseMs });
  }

  /** Moves a running task to review (agent finished; the CTO must still verify). */
  async toReview(taskId, patch = {}, fence = null) {
    validateTaskTransition('running', 'review');
    return this.store.cas('tasks', taskId, { status: 'running', ...this.#fence(fence) }, {
      status: 'review', lease_expires_at: null, slot_state: null, ...patch
    });
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

  /**
   * Independent review found blocking problems: reopen the (done) implementation task with feedback
   * and reset the reviewers that depend on it. Idempotent: only acts on a task that is still `done`.
   */
  async reopenForRework(taskId, feedback) {
    const task = await this.store.get('tasks', taskId);
    if (!task || task.status !== 'done') return null;
    validateTaskTransition('done', 'queued');
    const reopened = await this.store.cas('tasks', taskId, { status: 'done' }, {
      status: 'queued', corrections: task.corrections + 1, feedback, not_before: null, finished_at: null
    });
    if (!reopened) return null;
    const all = await this.store.list('tasks', { mission_id: task.mission_id });
    for (const dep of all.filter((t) => t.depends_on === taskId && t.status === 'done')) {
      validateTaskTransition('done', 'waiting');
      await this.store.cas('tasks', dep.id, { status: 'done' }, { status: 'waiting', feedback: null, finished_at: null });
    }
    await emit(this.store, {
      mission_id: task.mission_id, task_id: taskId, type: 'rework_requested',
      detail: { role: task.role, round: reopened.corrections }
    });
    return reopened;
  }

  /**
   * Owner resume: reopens a failed task with fresh failure and correction counters (attempts stay monotonic, so
   * fencing still tells the old attempts apart). The last rejection feedback is kept for the specialist.
   */
  async retryFailed(taskId) {
    const task = await this.store.get('tasks', taskId);
    if (!task) return null;
    validateOwnerRetry(task.status);
    return this.store.cas('tasks', taskId, { status: 'failed' }, {
      status: validateOwnerRetry('failed'), failures: 0, corrections: 0, error: null, not_before: null,
      finished_at: null, lease_expires_at: null, worker_id: null, slot_state: null,
      feedback: task.feedback ?? (task.error ? `Previous attempt failed: ${task.error}` : null)
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

  /** Crash/timeout path: requeue with backoff until maxFailures is reached. Returns null when the attempt is no longer ours. */
  async retryOrFail(taskId, error, now = Date.now(), fence = null) {
    const task = await this.store.get('tasks', taskId);
    if (!task || task.status !== 'running') return null;
    if (fence && (task.worker_id !== fence.workerId || task.attempts !== fence.attempt)) return null;
    const failures = task.failures + 1;
    const expect = { status: 'running', worker_id: task.worker_id, attempts: task.attempts, ...this.#fence(fence) };
    if (failures >= this.maxFailures) {
      const failed = await this.store.cas('tasks', taskId, expect, {
        status: 'failed', failures, error, lease_expires_at: null, slot_state: null, finished_at: new Date(now).toISOString()
      });
      if (!failed) return null;
      await emit(this.store, { mission_id: task.mission_id, task_id: taskId, type: 'task_failed', detail: { error, failures } });
      return 'failed';
    }
    const requeued = await this.store.cas('tasks', taskId, expect, {
      status: 'queued',
      failures,
      error,
      lease_expires_at: null,
      slot_state: null,
      not_before: new Date(now + this.backoffMs * 2 ** (failures - 1)).toISOString()
    });
    if (!requeued) return null;
    await emit(this.store, { mission_id: task.mission_id, task_id: taskId, type: 'task_retry_scheduled', detail: { error, failures } });
    return 'requeued';
  }

  /**
   * Restart recovery: leases that expired belong to a dead (or stalled) worker. The recovery is fenced on the
   * lease value it observed, so a heartbeat that lands in between wins and the task stays with its worker.
   */
  async recoverExpired(now = Date.now()) {
    const running = await this.store.list('tasks', { status: 'running' });
    const recovered = [];
    for (const task of running) {
      if (!task.lease_expires_at || task.lease_expires_at > now) continue;
      const outcome = await this.retryOrFail(task.id, 'lease expired (worker lost)', now, {
        workerId: task.worker_id, attempt: task.attempts, leaseExpiresAt: task.lease_expires_at
      });
      if (!outcome) continue;
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

