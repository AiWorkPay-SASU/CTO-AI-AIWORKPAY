import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { planMission, validateTransition, validateReport, ROLES, TERMINAL_MISSION, REVIEWER_ROLES } from './core.js';
import { JobQueue } from './queue.js';
import { emit } from './events.js';
import { runClaude } from './runner.js';
import { buildInstruction, systemPromptFor, validatePlan, validateReview } from './agents.js';
import {
  ensureWorkspace, removeWorkspace, collectEvidence, forbiddenChanges, commitAll,
  writeAcceptance, clearAcceptance, runTests, resetWorkspace, branchSummary, snapshotTree, inspectTree
} from './workspace.js';
import { redact, nowIso, sleep } from './util.js';

const APPROVAL_KINDS = ['mission', 'architecture', 'completion'];

/**
 * One decision per (mission, kind): the id is derived from both, so a double submit, a retry after a crash
 * or two concurrent requests all address the same row and can never record two decisions.
 */
export function approvalId(missionId, kind) {
  const h = createHash('sha256').update(`cto-approval:${missionId}:${kind}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function validateAcceptance(acceptance) {
  if (acceptance == null) return null;
  if (typeof acceptance !== 'object' || Array.isArray(acceptance)) throw new Error('acceptance must be an object');
  const entries = Object.entries(acceptance);
  if (entries.length > 5) throw new Error('At most 5 acceptance files');
  for (const [name, content] of entries) {
    if (!/^[A-Za-z0-9_.-]+\.test\.(c|m)?js$/.test(name)) throw new Error(`Invalid acceptance file name ${name}`);
    if (typeof content !== 'string' || content.length > 20000) throw new Error('Acceptance file must be a string under 20 KB');
  }
  return acceptance;
}

/**
 * The CTO IA. It plans missions, delegates to specialist agents through a durable queue,
 * never trusts an agent's own claim (it inspects git, runs the tests itself, scans the diff),
 * asks for corrections, escalates blockers and prepares a documented PR for the owner.
 */
export class Cto {
  constructor({
    store, runner = runClaude, testRunner = runTests, repoPath, repos = null, github = null, workspacesDir,
    workerId = 'cto-worker-1', limits = {}
  }) {
    if (!store) throw new Error('store required');
    if (!repoPath && !repos) throw new Error('repoPath required');
    this.store = store;
    this.runner = runner;
    this.testRunner = testRunner;
    // `repos` maps "owner/repo" to a local checkout and doubles as the allowlist of projects the CTO may work on.
    this.repos = repos ? new Map(Object.entries(repos).map(([project, dir]) => [project, path.resolve(dir)])) : null;
    if (this.repos && !this.repos.size) throw new Error('repos must not be empty');
    this.repoPath = path.resolve(repoPath ?? [...this.repos.values()][0]);
    this.github = github;
    this.workspacesDir = path.resolve(workspacesDir ?? path.join(this.repoPath, '..', '.cto-workspaces'));
    this.workerId = workerId;
    this.maxCorrections = limits.maxCorrections ?? 2;
    this.reconcileGraceMs = limits.reconcileGraceMs ?? 5000;
    this.queue = new JobQueue({
      store,
      leaseMs: limits.leaseMs ?? 120000,
      maxFailures: limits.maxFailures ?? 3,
      maxConcurrent: limits.maxConcurrent ?? 2,
      backoffMs: limits.backoffMs ?? 1000
    });
    this.controllers = new Map();
    this.inflight = new Set();
    this.deciding = new Set();
    this.timer = null;
  }

  // ---------------------------------------------------------------- missions

  #repoFor(project) {
    if (!this.repos) return this.repoPath;
    const dir = this.repos.get(project);
    if (!dir) throw new Error('Project is not an authorized repository');
    return dir;
  }

  async createMission({ objective, project, budgetUsd, acceptance }) {
    const plan = planMission(objective, project, {
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
      acceptance: validateAcceptance(acceptance)
    });
    this.#repoFor(plan.project);
    const { tasks, ...mission } = plan;
    await this.store.insert('missions', mission);
    for (const task of tasks) await this.queue.enqueue(task);
    await emit(this.store, { mission_id: mission.id, type: 'mission_created', detail: { project, tasks: tasks.map((t) => t.role) } });
    return this.getMission(mission.id);
  }

  async spent(missionId) {
    const costs = await this.store.list('costs', { mission_id: missionId });
    return Math.round(costs.reduce((sum, c) => sum + c.usd, 0) * 1e6) / 1e6;
  }

  async getMission(id) {
    const mission = await this.store.get('missions', id);
    if (!mission) return null;
    const [tasks, approvals, reports] = await Promise.all([
      this.store.list('tasks', { mission_id: id }),
      this.store.list('approvals', { mission_id: id }),
      this.store.list('reports', { mission_id: id })
    ]);
    const costs = await this.store.list('costs', { mission_id: id });
    const estimated = Math.round(costs.filter((c) => c.estimated).reduce((sum, c) => sum + c.usd, 0) * 1e6) / 1e6;
    return { ...mission, spent_usd: await this.spent(id), estimated_usd: estimated, tasks, approvals, reports };
  }

  async listMissions() {
    const missions = await this.store.list('missions');
    const out = [];
    for (const m of missions) out.push(await this.getMission(m.id));
    return out.reverse();
  }

  async #mission(id) {
    const m = await this.store.get('missions', id);
    if (!m) throw Object.assign(new Error('Mission not found'), { status: 404 });
    return m;
  }

  async #setMission(mission, to, patch = {}) {
    validateTransition(mission.status, to);
    const updated = await this.store.cas('missions', mission.id, { status: mission.status }, { status: to, ...patch });
    if (!updated) throw new Error(`Mission ${mission.id} changed concurrently`);
    await emit(this.store, { mission_id: mission.id, type: 'mission_status', detail: { from: mission.status, to } });
    return updated;
  }

  async #block(missionId, reason) {
    const mission = await this.#mission(missionId);
    if (TERMINAL_MISSION.has(mission.status) || mission.status === 'blocked') return mission;
    const blocked = await this.#setMission(mission, 'blocked', { blockers: [...(mission.blockers ?? []), redact(reason)] });
    await emit(this.store, { mission_id: missionId, type: 'escalation', detail: { reason, needs: 'owner decision' } });
    return blocked;
  }

  // --------------------------------------------------------------- approvals

  /**
   * Records an explicit, audited owner decision and applies its state change. Idempotent: the decision row has
   * a deterministic id, so repeating the same decision (retry after a crash, double click) resumes the
   * transition instead of recording a second decision; a different decision for the same kind is refused.
   */
  async approve(missionId, { kind, decision, by = 'owner', note = '', credentialId = null }) {
    if (!APPROVAL_KINDS.includes(kind)) throw new Error('Unknown approval kind');
    if (!['approve', 'reject'].includes(decision)) throw new Error('Decision must be approve or reject');
    const mission = await this.#mission(missionId);
    const required = { mission: 'pending_approval', architecture: 'awaiting_owner', completion: 'review' }[kind];
    if (mission.status !== required) {
      throw new Error(`Cannot record a ${kind} approval while the mission is ${mission.status}`);
    }
    const id = approvalId(missionId, kind);
    try {
      await this.store.insert('approvals', {
        id, mission_id: missionId, kind, decision, by, credential_id: credentialId, note: redact(String(note).slice(0, 500)), at: nowIso()
      });
      await emit(this.store, { mission_id: missionId, type: 'approval_recorded', actor: by, detail: { kind, decision } });
    } catch (error) {
      const existing = await this.store.get('approvals', id);
      if (!existing) throw error;
      if (existing.decision !== decision) {
        throw Object.assign(new Error(`A different ${kind} decision (${existing.decision}) is already recorded`), { status: 409 });
      }
      // Same decision already recorded: fall through and (re)apply the state change.
    }

    if (decision === 'reject') return this.cancelMission(missionId, { by, reason: `${kind} rejected` });
    if (kind === 'mission') await this.#setMission(mission, 'approved');
    if (kind === 'architecture') {
      await this.#setMission(mission, 'running');
      const tasks = await this.store.list('tasks', { mission_id: missionId });
      // Only the task gated by this approval is released; reviewers wait for a verified backend commit.
      for (const t of tasks.filter((x) => x.status === 'waiting' && x.requires_approval === 'architecture')) {
        await this.store.cas('tasks', t.id, { status: 'waiting' }, { status: 'queued' });
      }
    }
    if (kind === 'completion') {
      await this.#setMission(mission, 'completed');
      await this.cleanup(missionId);
    }
    return this.getMission(missionId);
  }

  async raiseBudget(missionId, budgetUsd, { by = 'owner' } = {}) {
    if (!(budgetUsd > 0) || budgetUsd > 50) throw new Error('Budget must be between 0 and 50 USD');
    const mission = await this.#mission(missionId);
    if (budgetUsd <= mission.budget_usd) throw new Error('New budget must exceed the current one');
    await this.store.update('missions', missionId, { budget_usd: budgetUsd });
    await emit(this.store, { mission_id: missionId, type: 'budget_raised', actor: by, detail: { budget_usd: budgetUsd } });
    if (mission.status === 'blocked') await this.#setMission(await this.#mission(missionId), 'running', { blockers: [] });
    return this.getMission(missionId);
  }

  /**
   * Owner decision that resolves an escalation: every failed task is reopened with fresh counters and the
   * mission goes back to running. The budget gate still applies, so a budget block simply escalates again
   * until the owner raises the budget.
   */
  async resumeMission(missionId, { by = 'owner', note = '', credentialId = null } = {}) {
    const mission = await this.#mission(missionId);
    if (mission.status !== 'blocked') throw new Error(`Only a blocked mission can be resumed, not ${mission.status}`);
    const tasks = await this.store.list('tasks', { mission_id: missionId });
    const requeued = [];
    for (const task of tasks.filter((t) => t.status === 'failed')) {
      if (await this.queue.retryFailed(task.id)) requeued.push(task.id);
    }
    await this.#setMission(mission, 'running', { blockers: [] });
    await emit(this.store, {
      mission_id: missionId, type: 'mission_resumed', actor: by,
      detail: { requeued, credential_id: credentialId, note: redact(String(note).slice(0, 500)) }
    });
    return this.getMission(missionId);
  }

  async cancelMission(missionId, { by = 'owner', reason = 'cancelled' } = {}) {
    const mission = await this.#mission(missionId);
    if (TERMINAL_MISSION.has(mission.status)) throw new Error(`Mission already ${mission.status}`);
    await this.#setMission(mission, 'cancelled', { cancel_reason: redact(reason) });
    const wasRunning = await this.queue.cancelMission(missionId);
    for (const id of wasRunning) this.controllers.get(id)?.abort();
    await emit(this.store, { mission_id: missionId, type: 'mission_cancelled', actor: by, detail: { reason } });
    await this.cleanup(missionId);
    return this.getMission(missionId);
  }

  async cleanup(missionId) {
    const mission = await this.store.get('missions', missionId);
    if (!mission) return;
    const tasks = await this.store.list('tasks', { mission_id: missionId });
    for (const t of tasks) {
      await removeWorkspace(this.#repoFor(mission.project), { path: path.join(this.workspacesDir, t.id.slice(0, 8)) });
    }
  }

  // --------------------------------------------------------------- execution

  async #releaseReservation(missionId, token) {
    for (;;) {
      const mission = await this.#mission(missionId);
      const reservations = { ...mission.budget_reservations };
      if (!reservations[token]) return;
      delete reservations[token];
      if (await this.store.cas('missions', missionId, { rev: mission.rev }, { budget_reservations: reservations })) return;
    }
  }

  async #affordable(task) {
    const cap = ROLES[task.role].maxBudgetUsd;
    for (;;) {
      const mission = await this.#mission(task.mission_id);
      if (!['approved', 'running'].includes(mission.status)) return false;
      const spent = mission.budget_accounted_usd ?? await this.spent(mission.id);
      const reservations = { ...mission.budget_reservations };
      const reserved = Object.values(reservations).reduce((sum, r) => sum + r.usd, 0);
      if (Math.round((spent + reserved + cap) * 1e6) <= Math.round(mission.budget_usd * 1e6)) {
        const token = randomUUID();
        reservations[token] = { task_id: task.id, usd: cap, created_at: Date.now() };
        const updated = await this.store.cas('missions', mission.id, { rev: mission.rev }, {
          budget_reservations: reservations, budget_accounted_usd: spent
        });
        if (updated) return { reservation_id: token, reserved_usd: cap };
        continue;
      }
      // An in-flight task can settle below its cap. Wait for it before escalating.
      if (reserved > 0) return false;
      await emit(this.store, {
        mission_id: mission.id, task_id: task.id, type: 'budget_exceeded',
        detail: { budget_usd: mission.budget_usd, spent_usd: spent, next_task_cap_usd: cap }
      });
      await this.#block(mission.id, 'Budget would be exceeded by the next task; owner arbitration required');
      return false;
    }
  }

  /** Launches every dispatchable task up to the concurrency limit. Returns how many were started. */
  async tick({ wait = false } = {}) {
    const recovered = await this.queue.recoverExpired();
    for (const { id } of recovered) {
      const task = await this.store.get('tasks', id);
      if (task.reservation_id) await this.#recordCost(await this.#mission(task.mission_id), task, null);
    }
    // A crash between reserving and claiming must neither refund unknown spend nor stall forever.
    for (const mission of await this.store.list('missions')) {
      for (const [token, reservation] of Object.entries(mission.budget_reservations ?? {})) {
        if (Date.now() - reservation.created_at <= this.queue.leaseMs) continue;
        const task = await this.store.get('tasks', reservation.task_id);
        if (task?.status === 'running' && task.reservation_id === token) continue;
        if (task) await this.#recordCost(mission, { ...task, reservation_id: token, reserved_usd: reservation.usd }, null);
      }
    }
    await this.reconcile();
    const launched = [];
    for (;;) {
      const task = await this.queue.claimNext({ workerId: this.workerId, accept: (t) => this.#affordable(t),
        release: (t, r) => this.#releaseReservation(t.mission_id, r.reservation_id) });
      if (!task) break;
      const p = this.#execute(task).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
      launched.push(p);
    }
    if (wait) await Promise.all([...this.inflight]);
    return launched.length;
  }

  /**
   * Repairs the windows where a crash (or a lost race) left the mission graph half-advanced: a step was written
   * (approval, task done) but the follow-up transition never happened. Every repair is an idempotent
   * compare-and-set derived only from persisted facts, so running it on every tick is safe, and a restarted
   * process picks missions up exactly where the persisted state says they are.
   */
  async reconcile() {
    const repaired = [];
    for (const mission of await this.store.list('missions')) {
      if (mission.status !== 'running') continue;
      if (Date.now() - Date.parse(mission.updated_at ?? 0) < this.reconcileGraceMs) continue;
      const tasks = await this.store.list('tasks', { mission_id: mission.id });
      if (tasks.some((t) => this.controllers.has(t.id))) continue; // this process is still concluding one of them
      try {
        const approvals = await this.store.list('approvals', { mission_id: mission.id });
        const granted = (kind) => approvals.some((a) => a.kind === kind && a.decision === 'approve');
        const byId = new Map(tasks.map((t) => [t.id, t]));
        const architect = tasks.find((t) => t.role === 'architect');
        const backend = tasks.find((t) => t.role === 'backend');

        // A plan was verified but the owner was never asked.
        if (architect?.status === 'done' && backend?.status === 'waiting' && !granted('architecture')) {
          await this.#setMission(mission, 'awaiting_owner');
          if (!(await this.store.list('events', { mission_id: mission.id })).some((e) => e.type === 'approval_requested' && e.detail?.kind === 'architecture')) {
            await emit(this.store, { mission_id: mission.id, type: 'approval_requested', detail: { kind: 'architecture' } });
          }
          repaired.push({ mission: mission.id, repair: 'architecture_approval_requested' });
          continue;
        }
        // The owner approved but the gated task was never released, or a verified backend never released its reviewers.
        for (const t of tasks.filter((x) => x.status === 'waiting')) {
          const dependencyDone = !t.depends_on || byId.get(t.depends_on)?.status === 'done';
          const gate = !t.requires_approval || granted(t.requires_approval);
          if (dependencyDone && gate && await this.store.cas('tasks', t.id, { status: 'waiting' }, { status: 'queued' })) {
            repaired.push({ mission: mission.id, task: t.id, repair: 'released' });
          }
        }
        // Every reviewer finished but nobody decided what happens next.
        const reviewers = tasks.filter((t) => REVIEWER_ROLES.includes(t.role));
        if (reviewers.length && reviewers.every((t) => t.status === 'done')) {
          await this.#decideAfterReviews(mission.id);
          repaired.push({ mission: mission.id, repair: 'review_decision' });
        }
      } catch (error) {
        await emit(this.store, { mission_id: mission.id, type: 'reconcile_error', detail: { error: redact(error.message) } });
      }
    }
    for (const r of repaired) await emit(this.store, { mission_id: r.mission, task_id: r.task ?? null, type: 'reconciled', detail: { repair: r.repair } });
    return repaired;
  }

  /** Runs until nothing is dispatchable (waiting for approval, blocked, or finished). */
  async drain({ maxIterations = 100 } = {}) {
    for (let i = 0; i < maxIterations; i += 1) {
      const started = await this.tick({ wait: true });
      if (started > 0) continue;
      const delay = await this.#nextRetryDelay();
      if (delay === null) return;
      await sleep(Math.min(delay + 5, 2000));
    }
    throw new Error('drain exceeded maxIterations');
  }

  async #nextRetryDelay() {
    const queued = await this.store.list('tasks', { status: 'queued' });
    let min = null;
    for (const t of queued) {
      if (!t.not_before) continue;
      const mission = await this.store.get('missions', t.mission_id);
      if (!mission || !['approved', 'running'].includes(mission.status)) continue;
      const wait = Math.max(0, Date.parse(t.not_before) - Date.now()); // 0 = due now, claim it on the next tick
      if (min === null || wait < min) min = wait;
    }
    return min;
  }

  startWorker(intervalMs = 2000) {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
  }

  async stopWorker({ waitForTasks = true } = {}) {
    clearInterval(this.timer);
    this.timer = null;
    if (waitForTasks) await Promise.all([...this.inflight]);
  }

  async #approvedPlan(missionId) {
    const reports = await this.store.list('reports', { mission_id: missionId });
    const plan = reports.filter((r) => r.role === 'architect' && r.verdict === 'accepted').at(-1);
    return plan?.artifact_text ?? null;
  }

  async #latestBackend(missionId) {
    const reports = await this.store.list('reports', { mission_id: missionId });
    return reports.filter((r) => r.role === 'backend' && r.verdict === 'accepted').at(-1) ?? null;
  }

  async #recordCost(mission, task, result) {
    const actual = Number(result?.total_cost_usd);
    const estimated = result == null || !Number.isFinite(actual) || actual < 0;
    const usd = estimated ? (task.reserved_usd ?? ROLES[task.role].maxBudgetUsd) : actual;
    const id = task.reservation_id ?? randomUUID();
    let recorded = await this.store.get('costs', id);
    if (!recorded) {
      try {
        recorded = await this.store.insert('costs', {
          id, mission_id: mission.id, task_id: task.id, role: task.role, usd, estimated,
          usage: result?.usage ?? null, model: Object.keys(result?.modelUsage ?? {})[0] ?? null, at: nowIso()
        });
      } catch (error) {
        recorded = await this.store.get('costs', id);
        if (!recorded) throw error;
      }
    }
    for (;;) {
      const current = await this.#mission(mission.id);
      const reservations = { ...current.budget_reservations };
      if (!reservations[id]) break;
      delete reservations[id];
      if (await this.store.cas('missions', mission.id, { rev: current.rev }, {
        budget_reservations: reservations,
        budget_accounted_usd: Math.round(((current.budget_accounted_usd ?? 0) + recorded.usd) * 1e6) / 1e6
      })) break;
    }
    if (recorded.usd > (task.reserved_usd ?? ROLES[task.role].maxBudgetUsd)) {
      await this.#block(mission.id, 'Provider reported a cost above the reserved task cap');
    }
    return recorded.usd;
  }

  async #execute(task) {
    const role = ROLES[task.role];
    let costRecorded = false;
    let runnerStarted = false;
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const fence = { workerId: this.workerId, attempt: task.attempts };
    let leaseLost = false;
    // The lease is only needed while the agent runs. A heartbeat that finds the task re-leased (or recovered)
    // means another attempt owns it: stop the agent instead of letting two of them work on the same task.
    const beat = setInterval(() => {
      this.queue.heartbeat(task.id, this.workerId, Date.now(), task.attempts).then((alive) => {
        if (!alive && !leaseLost && !controller.signal.aborted) { leaseLost = true; controller.abort(); }
      }).catch(() => {});
    }, Math.max(200, this.queue.leaseMs / 3));
    beat.unref?.();
    try {
      let mission = await this.#mission(task.mission_id);
      if (mission.status === 'approved') mission = await this.#setMission(mission, 'running');
      let baseRef = 'HEAD';
      let implementation = null;
      if (role.reviewer) {
        const impl = await this.#latestBackend(mission.id);
        if (!impl?.evidence?.commit) throw new Error('No verified implementation to review');
        baseRef = impl.evidence.commit;
        implementation = [
          `Commit ${impl.evidence.commit} on branch ${impl.evidence.branch}`,
          `Files changed by the branch:\n${(impl.evidence.branch_files ?? impl.evidence.changed_files).map((f) => `- ${f}`).join('\n')}`,
          impl.evidence.branch_diffstat ?? impl.evidence.diffstat ?? ''
        ].join('\n\n');
      }
      const ws = await ensureWorkspace({
        repoPath: this.#repoFor(mission.project), baseDir: this.workspacesDir, task, mission, baseRef, detached: role.readOnly
      });
      if (!task.base_commit && ws.base) {
        await this.store.update('tasks', task.id, { base_commit: ws.base });
        task.base_commit = ws.base;
      }
      const plan = task.role !== 'architect' ? await this.#approvedPlan(mission.id) : null;
      await emit(this.store, {
        mission_id: mission.id, task_id: task.id, type: 'task_started', actor: this.workerId,
        detail: { role: task.role, attempt: task.attempts, correction: task.corrections, workspace: path.basename(ws.path) }
      });
      runnerStarted = true;
      const result = await this.runner({
        instruction: buildInstruction(task.role, task, mission, { plan, feedback: task.feedback, implementation }),
        cwd: ws.path,
        tools: role.tools,
        permissionMode: role.permissionMode,
        maxBudgetUsd: role.maxBudgetUsd,
        timeoutMs: role.timeoutMs,
        signal: controller.signal,
        systemPrompt: systemPromptFor(task.role)
      });
      const cost = await this.#recordCost(mission, task, result);
      costRecorded = true;
      clearInterval(beat);
      if (leaseLost) throw new Error('lease lost');
      // Fenced: refused when the mission was cancelled or when this attempt no longer owns the task.
      if (!(await this.queue.toReview(task.id, {}, fence))) return;
      const verdict = await this.#verify(task, mission, ws, result);
      await this.#conclude(task, mission, ws, result, verdict, cost);
    } catch (error) {
      // Failed or interrupted CLI output cannot prove zero spend. Retain the full cap as an explicit estimate.
      if (!costRecorded) {
        if (runnerStarted) await this.#recordCost(await this.#mission(task.mission_id), task, null);
        else await this.#releaseReservation(task.mission_id, task.reservation_id);
      }
      if (leaseLost) {
        // The task belongs to another attempt now; this one must not touch its state.
        await emit(this.store, { mission_id: task.mission_id, task_id: task.id, type: 'lease_lost', actor: this.workerId, detail: { attempt: task.attempts } });
        return;
      }
      if (error.cancelled || controller.signal.aborted) {
        await emit(this.store, { mission_id: task.mission_id, task_id: task.id, type: 'task_cancelled' });
        return;
      }
      const message = redact(error.message);
      const currentTask = await this.store.get('tasks', task.id);
      if (currentTask?.status === 'review') {
        await this.queue.failPermanently(task.id, message);
        await this.#block(task.mission_id, `Verification failed safely: ${message}`);
        return;
      }
      const outcome = await this.queue.retryOrFail(task.id, message, Date.now(), fence);
      if (outcome === 'failed') await this.#block(task.mission_id, `Task ${task.role} failed after retries: ${message}`);
    } finally {
      clearInterval(beat);
      this.controllers.delete(task.id);
    }
  }

  // ------------------------------------------------------------ verification

  async #verify(task, mission, ws, result) {
    const text = typeof result?.result === 'string' ? result.result : '';
    if (task.role === 'architect') return this.#verifyArchitect(ws, text);
    if (ROLES[task.role].reviewer) return this.#verifyReviewer(ws, text);
    return this.#verifyBackend(task, mission, ws, text);
  }

  async #verifyArchitect(ws, text) {
    const problems = [];
    const plan = validatePlan(text);
    if (!plan.ok) problems.push(`Plan is missing: ${plan.missing.join(', ')}`);
    const ev = await collectEvidence(ws);
    if (ev.changed_files.length) {
      problems.push(`The architect is read-only but modified: ${ev.changed_files.join(', ')}`);
      await resetWorkspace(ws);
    }
    return {
      ok: problems.length === 0,
      problems,
      evidence: { plan_chars: text.length, changed_files: ev.changed_files },
      tests: { passed: 0, failed: 0 },
      artifact_text: redact(text)
    };
  }

  /** A reviewer must stay read-only and end with a well-formed verdict. Its verdict can only add blockers. */
  async #verifyReviewer(ws, text) {
    const problems = [];
    const parsed = validateReview(text);
    if (!parsed.ok) problems.push(`Malformed review: ${parsed.error}`);
    const ev = await collectEvidence(ws);
    if (ev.changed_files.length) {
      problems.push(`Reviewers are read-only but modified: ${ev.changed_files.join(', ')}`);
      await resetWorkspace(ws);
    }
    return {
      ok: problems.length === 0,
      problems,
      evidence: { review: parsed.ok ? parsed.review : null, changed_files: ev.changed_files, answer_chars: text.length },
      tests: { passed: 0, failed: 0 }
    };
  }

  async #verifyBackend(task, mission, ws, text) {
    const problems = [];
    const ev = await collectEvidence(ws);
    const beforeTests = await snapshotTree(ws);
    if (!ev.changed_files.length) problems.push('No file was changed: nothing to verify, the claim of completion is unsupported');
    const forbidden = forbiddenChanges(ev.changed_files);
    if (forbidden.length) problems.push(`Forbidden paths modified: ${forbidden.join(', ')}. Revert them.`);
    if (ev.secret_in_diff) problems.push('A secret-like value was found in the changes. Remove it.');

    let tests = { passed: 0, failed: 0 };
    let acceptance = null;
    if (ev.changed_files.length) {
      const run = await this.testRunner(ws);
      tests = { passed: run.passed, failed: run.failed };
      if (run.exit_code !== 0 || run.failed > 0 || run.passed < 1) {
        problems.push(`Project tests did not pass (exit ${run.exit_code}, passed ${run.passed}, failed ${run.failed}):\n${run.tail}`);
      }
      if (mission.acceptance) {
        const files = writeAcceptance(ws, mission.acceptance);
        try {
          acceptance = await this.testRunner(ws, files);
        } finally {
          clearAcceptance(ws);
        }
        if (acceptance.exit_code !== 0 || acceptance.failed > 0 || acceptance.passed < 1) {
          problems.push(`Owner acceptance tests failed (passed ${acceptance.passed}, failed ${acceptance.failed}):\n${acceptance.tail}`);
        }
      }
    }

    const verifiedTree = await snapshotTree(ws);
    const staged = await inspectTree(ws, verifiedTree, task.base_commit ?? 'HEAD');
    if (beforeTests !== verifiedTree) problems.push('Workspace changed during test execution; results do not verify the final tree');
    const finalForbidden = forbiddenChanges(staged.files);
    if (finalForbidden.length) problems.push(`Forbidden paths in final staged tree: ${finalForbidden.join(', ')}`);
    if (staged.secret) problems.push('A secret-like value was found in the final staged tree');
    ev.changed_files = staged.files;
    let commit = null;
    let branch = { files: [], diffstat: '' };
    if (!problems.length) {
      commit = await commitAll(ws, `feat: ${mission.objective.slice(0, 60).replace(/\s+/g, ' ')} [cto ${task.id.slice(0, 8)}]`, verifiedTree);
      branch = await branchSummary(ws, task.base_commit);
    }
    return {
      ok: problems.length === 0,
      problems,
      evidence: {
        changed_files: ev.changed_files,
        diffstat: ev.diffstat,
        branch_files: branch.files,
        branch_diffstat: branch.diffstat,
        tests_command: 'node --test',
        acceptance: acceptance && { passed: acceptance.passed, failed: acceptance.failed },
        commit,
        branch: ws.branch,
        agent_summary: redact(text).slice(0, 1500)
      },
      tests
    };
  }

  async #conclude(task, mission, ws, result, verdict, cost) {
    const accepted = verdict.ok;
    const exhausted = !accepted && task.corrections >= this.maxCorrections;
    const report = validateReport({
      task_id: task.id,
      status: accepted ? 'DONE' : exhausted ? 'FAILED' : 'REVIEW',
      progress_note: accepted ? 'Verified by the CTO' : `Rejected: ${verdict.problems[0]?.split('\n')[0] ?? 'verification failed'}`,
      artifacts: verdict.evidence.commit ? [`${verdict.evidence.branch}@${verdict.evidence.commit}`] : [],
      tests: verdict.tests,
      blockers: accepted ? [] : verdict.problems.map((p) => p.split('\n')[0]),
      next_action: accepted ? 'Await owner decision' : exhausted ? 'Escalate to owner' : 'Correction by the specialist',
      requires_human_approval: accepted || exhausted
    });
    await this.store.insert('reports', {
      id: randomUUID(),
      mission_id: mission.id,
      task_id: task.id,
      role: task.role,
      status: accepted ? 'review' : 'blocked',
      summary: report.progress_note,
      evidence: verdict.evidence,
      report,
      verdict: accepted ? 'accepted' : 'rejected',
      problems: verdict.problems.map((p) => redact(p).slice(0, 2000)),
      artifact_text: verdict.artifact_text ?? null,
      cost_usd: cost,
      cost_estimated: (await this.store.get('costs', task.reservation_id))?.estimated ?? false,
      created_at: nowIso()
    });

    if (accepted) {
      await this.queue.markDone(task.id);
      await emit(this.store, { mission_id: mission.id, task_id: task.id, type: 'task_verified', detail: { role: task.role, tests: verdict.tests } });
      const current = await this.#mission(mission.id);
      if (current.status !== 'running') return;
      if (task.role === 'architect') {
        await this.#setMission(current, 'awaiting_owner');
        await emit(this.store, { mission_id: mission.id, type: 'approval_requested', detail: { kind: 'architecture' } });
      } else if (task.role === 'backend') {
        // Independent reviewers start in parallel on the verified commit.
        const tasks = await this.store.list('tasks', { mission_id: mission.id });
        for (const t of tasks.filter((x) => REVIEWER_ROLES.includes(x.role) && x.status === 'waiting')) {
          await this.store.cas('tasks', t.id, { status: 'waiting' }, { status: 'queued' });
        }
      } else {
        await this.#decideAfterReviews(mission.id);
      }
      return;
    }

    if (exhausted) {
      await this.queue.failPermanently(task.id, 'verification failed after correction rounds');
      await this.#block(mission.id, `Task ${task.role} could not be verified after ${this.maxCorrections} correction rounds: ${verdict.problems[0]?.split('\n')[0]}`);
      return;
    }
    await this.queue.requestCorrection(task.id, verdict.problems.join('\n\n'));
    await emit(this.store, {
      mission_id: mission.id, task_id: task.id, type: 'correction_requested',
      detail: { role: task.role, round: task.corrections + 1, problems: verdict.problems.map((p) => p.split('\n')[0]) }
    });
  }

  /**
   * Runs once both independent reviewers are done. Blocking findings reopen the backend for rework
   * (bounded by maxCorrections); otherwise the mission goes to the owner. Reviewers can only add blockers:
   * a "pass" never replaces the CTO's own checks, which already ran.
   */
  async #decideAfterReviews(missionId) {
    if (this.deciding.has(missionId)) return;
    this.deciding.add(missionId);
    try {
      const tasks = await this.store.list('tasks', { mission_id: missionId });
      const reviewers = tasks.filter((t) => REVIEWER_ROLES.includes(t.role));
      if (!reviewers.length || !reviewers.every((t) => t.status === 'done')) return;
      const backend = tasks.find((t) => t.role === 'backend');
      const reports = await this.store.list('reports', { mission_id: missionId });
      const latest = reviewers.map((t) => reports.filter((r) => r.task_id === t.id && r.verdict === 'accepted').at(-1));
      const reviews = latest.filter(Boolean).map((r) => ({ role: r.role, ...r.evidence.review }));
      const blocking = reviews.filter((r) => r.blocking);
      const mission = await this.#mission(missionId);
      if (mission.status !== 'running') return;

      if (!blocking.length) {
        await this.#setMission(mission, 'review');
        await emit(this.store, { mission_id: missionId, type: 'approval_requested', detail: { kind: 'completion', reviews: reviews.map((r) => `${r.role}:${r.verdict}`) } });
        if (mission.pull_request && this.github) await this.#syncPullRequest(missionId);
        return;
      }
      const feedback = blocking
        .flatMap((r) => r.findings.filter((f) => f.severity !== 'low' || r.verdict === 'fail').map((f) => `[${r.role}/${f.severity}] ${f.file}: ${f.issue}`))
        .join('\n') || blocking.map((r) => `[${r.role}] reviewer failed the implementation without detailed findings`).join('\n');
      if (backend.corrections >= this.maxCorrections) {
        await this.#block(missionId, `Independent review still blocking after ${this.maxCorrections} rework rounds: ${feedback.split('\n')[0]}`);
        return;
      }
      await this.queue.reopenForRework(backend.id, `Independent review found blocking problems. Fix them, keep the tests green:\n${feedback}`);
    } catch (error) {
      await emit(this.store, { mission_id: missionId, type: 'decision_error', detail: { error: redact(error.message) } });
    } finally {
      this.deciding.delete(missionId);
    }
  }

  // ----------------------------------------------------------------- GitHub

  /**
   * Proposes the verified work to the owner: pushes the task branch (fast-forward, CTO branches only) and opens
   * a DRAFT pull request. Never merges and never deploys: the client has no such capability.
   */
  async submitPullRequest(missionId, { by = 'owner', credentialId = null } = {}) {
    if (!this.github) throw new Error('GitHub is not configured (CTO_GITHUB_TOKEN and CTO_ALLOWED_REPOS)');
    const mission = await this.#mission(missionId);
    if (!['review', 'completed'].includes(mission.status)) {
      throw new Error(`A pull request can only be opened for a mission in review or completed, not ${mission.status}`);
    }
    if (!this.github.isAllowed(mission.project)) throw new Error('Repository is not authorized for GitHub operations');
    const lock = Date.parse(mission.pull_request_lock ?? 0);
    if (Date.now() - lock < 60000) throw Object.assign(new Error('A pull request is already being opened for this mission'), { status: 409 });
    const locked = await this.store.cas('missions', missionId, { rev: mission.rev }, { pull_request_lock: nowIso() });
    if (!locked) throw Object.assign(new Error('Mission changed concurrently, retry'), { status: 409 });
    try {
      const backend = await this.#latestBackend(missionId);
      const ev = backend?.evidence;
      if (!ev?.commit || !ev?.branch) throw new Error('No verified commit to propose');
      await this.github.pushBranch({ repoPath: this.#repoFor(mission.project), project: mission.project, branch: ev.branch, commit: ev.commit });
      let pr = mission.pull_request;
      if (pr) {
        pr = { ...pr, commit: ev.commit };
        await emit(this.store, { mission_id: missionId, type: 'pull_request_updated', actor: by, detail: { number: pr.number, commit: ev.commit, credential_id: credentialId } });
      } else {
        const base = await this.github.defaultBranch(mission.project);
        const report = await this.consolidatedReport(missionId);
        const opened = await this.github.openDraftPullRequest({
          project: mission.project, head: ev.branch, base,
          title: `[CTO IA] ${mission.objective.slice(0, 80).replace(/\s+/g, ' ')}`, body: report.pull_request_body
        });
        pr = { ...opened, branch: ev.branch, base, commit: ev.commit, opened_at: nowIso() };
        await emit(this.store, { mission_id: missionId, type: 'pull_request_opened', actor: by, detail: { number: pr.number, url: pr.url, draft: pr.draft, commit: ev.commit, credential_id: credentialId } });
      }
      await this.store.update('missions', missionId, { pull_request: pr });
      return pr;
    } finally {
      await this.store.update('missions', missionId, { pull_request_lock: null });
    }
  }

  /** After a rework, the corrected commit goes to the already opened draft PR (same branch, fast-forward). */
  async #syncPullRequest(missionId) {
    try {
      await this.submitPullRequest(missionId, { by: 'cto' });
    } catch (error) {
      await emit(this.store, { mission_id: missionId, type: 'pull_request_sync_failed', detail: { error: redact(error.message) } });
    }
  }

  /**
   * Reads the CI result of the proposed commit. A failing CI sends the work back to the backend with the
   * failing checks as feedback (bounded by maxCorrections, then escalated). Missing or pending checks are
   * never treated as success.
   */
  async checkCi(missionId) {
    if (!this.github) throw new Error('GitHub is not configured (CTO_GITHUB_TOKEN and CTO_ALLOWED_REPOS)');
    const mission = await this.#mission(missionId);
    const pr = mission.pull_request;
    if (!pr) throw new Error('No pull request has been opened for this mission');
    const result = await this.github.commitChecks(mission.project, pr.commit);
    await emit(this.store, {
      mission_id: missionId, type: 'ci_status',
      detail: { state: result.state, commit: pr.commit, checks: result.checks.map((c) => `${c.name}:${c.state}`) }
    });
    if (result.state !== 'failure' || mission.status !== 'review') return { ...result, action: 'none' };

    const tasks = await this.store.list('tasks', { mission_id: missionId });
    const backend = tasks.find((t) => t.role === 'backend');
    const failing = result.checks.filter((c) => c.state === 'failure');
    const feedback = `Continuous integration failed on commit ${pr.commit}. Fix every failing check, keep the local tests green:\n${failing.map((c) => `- ${c.name}: ${c.detail}`).join('\n')}`;
    await this.#setMission(mission, 'running');
    if (backend.corrections >= this.maxCorrections) {
      await this.#block(missionId, `CI still failing after ${this.maxCorrections} rework rounds: ${failing[0].name}`);
      return { ...result, action: 'escalated' };
    }
    await this.queue.reopenForRework(backend.id, feedback);
    await emit(this.store, { mission_id: missionId, type: 'ci_rework_requested', detail: { failing: failing.map((c) => c.name), round: backend.corrections + 1 } });
    return { ...result, action: 'rework_requested' };
  }

  // --------------------------------------------------------------- reporting

  async consolidatedReport(missionId) {
    const mission = await this.getMission(missionId);
    if (!mission) throw Object.assign(new Error('Mission not found'), { status: 404 });
    const events = await this.store.list('events', { mission_id: missionId });
    const accepted = mission.reports.filter((r) => r.verdict === 'accepted');
    const backend = accepted.filter((r) => r.role === 'backend').at(-1);
    const pending = [];
    if (mission.status === 'pending_approval') pending.push('mission');
    if (mission.status === 'awaiting_owner') pending.push('architecture');
    if (mission.status === 'review') pending.push('completion');
    const corrections = events.filter((e) => e.type === 'correction_requested').length;
    const reworks = events.filter((e) => e.type === 'rework_requested').length;
    const reviews = ['qa', 'security'].flatMap((role) => {
      const r = accepted.filter((x) => x.role === role).at(-1);
      return r?.evidence?.review ? [{ role, verdict: r.evidence.review.verdict, findings: r.evidence.review.findings, blocking: r.evidence.review.blocking }] : [];
    });
    const report = {
      mission: { id: mission.id, project: mission.project, objective: mission.objective, status: mission.status, budget_usd: mission.budget_usd, spent_usd: mission.spent_usd, estimated_usd: mission.estimated_usd },
      tasks: mission.tasks.map((t) => ({ role: t.role, status: t.status, attempts: t.attempts, corrections: t.corrections, failures: t.failures })),
      approvals: mission.approvals.map((a) => ({ kind: a.kind, decision: a.decision, by: a.by, at: a.at })),
      pending_approvals: pending,
      blockers: mission.blockers ?? [],
      corrections_requested: corrections,
      rework_rounds: reworks,
      reviews,
      branch: backend?.evidence?.branch ?? null,
      commit: backend?.evidence?.commit ?? null,
      tests: backend?.report?.tests ?? null
    };
    report.pull_request_body = this.#pullRequestBody(mission, report, backend);
    return report;
  }

  #pullRequestBody(mission, report, backend) {
    const ev = backend?.evidence;
    return [
      `## Objective\n${mission.objective}`,
      `## Changes\n${ev ? `Branch \`${ev.branch}\` @ \`${ev.commit}\`\n\n${(ev.branch_files ?? ev.changed_files ?? []).map((f) => `- \`${f}\``).join('\n')}\n\n\`\`\`\n${ev.branch_diffstat ?? ev.diffstat ?? ''}\n\`\`\`` : '_No verified implementation yet._'}`,
      `## Independent reviews (advisory, can only add blockers)\n${report.reviews.length ? report.reviews.map((r) => `- ${r.role}: **${r.verdict}**, ${r.findings.length} finding(s)${r.findings.length ? `\n${r.findings.map((f) => `  - [${f.severity}] \`${f.file}\`: ${f.issue}`).join('\n')}` : ''}`).join('\n') : '_Not run yet._'}`,
      `## Tests actually executed by the CTO\n${backend ? `- project tests (\`${ev.tests_command}\`): ${backend.report.tests.passed} passed, ${backend.report.tests.failed} failed\n${ev.acceptance ? `- owner acceptance tests: ${ev.acceptance.passed} passed, ${ev.acceptance.failed} failed` : '- no owner acceptance tests were supplied'}` : '_None yet._'}`,
      `## CTO control\n- correction rounds requested: ${report.corrections_requested}, rework rounds after review: ${report.rework_rounds}\n- approvals: ${report.approvals.map((a) => `${a.kind}=${a.decision}`).join(', ') || 'none yet'}\n- cost: ${report.mission.spent_usd} USD of ${report.mission.budget_usd} USD budget (including ${report.mission.estimated_usd ?? 0} USD estimated after interrupted or missing cost output)`,
      '## Not done\nNo merge and no deployment: both require the owner\'s explicit approval.'
    ].join('\n\n');
  }
}

