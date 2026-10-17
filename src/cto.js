import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { planMission, validateTransition, validateReport, ROLES, TERMINAL_MISSION } from './core.js';
import { JobQueue } from './queue.js';
import { emit } from './events.js';
import { runClaude } from './runner.js';
import { buildInstruction, systemPromptFor, validatePlan } from './agents.js';
import {
  ensureWorkspace, removeWorkspace, collectEvidence, forbiddenChanges, commitAll,
  writeAcceptance, clearAcceptance, runTests, resetWorkspace
} from './workspace.js';
import { redact, nowIso, sleep } from './util.js';

const APPROVAL_KINDS = ['mission', 'architecture', 'completion'];

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
    store, runner = runClaude, repoPath, workspacesDir, workerId = 'cto-worker-1', limits = {}
  }) {
    if (!store) throw new Error('store required');
    if (!repoPath) throw new Error('repoPath required');
    this.store = store;
    this.runner = runner;
    this.repoPath = path.resolve(repoPath);
    this.workspacesDir = path.resolve(workspacesDir ?? path.join(this.repoPath, '..', '.cto-workspaces'));
    this.workerId = workerId;
    this.maxCorrections = limits.maxCorrections ?? 2;
    this.queue = new JobQueue({
      store,
      leaseMs: limits.leaseMs ?? 120000,
      maxFailures: limits.maxFailures ?? 3,
      maxConcurrent: limits.maxConcurrent ?? 2,
      backoffMs: limits.backoffMs ?? 1000
    });
    this.controllers = new Map();
    this.inflight = new Set();
    this.timer = null;
  }

  // ---------------------------------------------------------------- missions

  async createMission({ objective, project, budgetUsd, acceptance }) {
    const plan = planMission(objective, project, {
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
      acceptance: validateAcceptance(acceptance)
    });
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
    return { ...mission, spent_usd: await this.spent(id), tasks, approvals, reports };
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

  /** Records an explicit, audited owner decision and applies its state change. */
  async approve(missionId, { kind, decision, by = 'owner', note = '' }) {
    if (!APPROVAL_KINDS.includes(kind)) throw new Error('Unknown approval kind');
    if (!['approve', 'reject'].includes(decision)) throw new Error('Decision must be approve or reject');
    const mission = await this.#mission(missionId);
    const required = { mission: 'pending_approval', architecture: 'awaiting_owner', completion: 'review' }[kind];
    if (mission.status !== required) {
      throw new Error(`Cannot record a ${kind} approval while the mission is ${mission.status}`);
    }
    await this.store.insert('approvals', {
      id: randomUUID(), mission_id: missionId, kind, decision, by, note: redact(String(note).slice(0, 500)), at: nowIso()
    });
    await emit(this.store, { mission_id: missionId, type: 'approval_recorded', actor: by, detail: { kind, decision } });

    if (decision === 'reject') return this.cancelMission(missionId, { by, reason: `${kind} rejected` });
    if (kind === 'mission') await this.#setMission(mission, 'approved');
    if (kind === 'architecture') {
      await this.#setMission(mission, 'running');
      const tasks = await this.store.list('tasks', { mission_id: missionId });
      for (const t of tasks.filter((x) => x.status === 'waiting')) {
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
    const tasks = await this.store.list('tasks', { mission_id: missionId });
    for (const t of tasks) {
      await removeWorkspace(this.repoPath, { path: path.join(this.workspacesDir, t.id.slice(0, 8)) });
    }
  }

  // --------------------------------------------------------------- execution

  async #affordable(task) {
    const mission = await this.#mission(task.mission_id);
    const cap = ROLES[task.role].maxBudgetUsd;
    if ((await this.spent(mission.id)) + cap <= mission.budget_usd) return true;
    await emit(this.store, {
      mission_id: mission.id, task_id: task.id, type: 'budget_exceeded',
      detail: { budget_usd: mission.budget_usd, spent_usd: await this.spent(mission.id), next_task_cap_usd: cap }
    });
    await this.#block(mission.id, 'Budget would be exceeded by the next task; owner arbitration required');
    return false;
  }

  /** Launches every dispatchable task up to the concurrency limit. Returns how many were started. */
  async tick({ wait = false } = {}) {
    await this.queue.recoverExpired();
    const launched = [];
    for (;;) {
      const task = await this.queue.claimNext({ workerId: this.workerId, accept: (t) => this.#affordable(t) });
      if (!task) break;
      const p = this.#execute(task).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
      launched.push(p);
    }
    if (wait) await Promise.all([...this.inflight]);
    return launched.length;
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

  async #recordCost(mission, task, result) {
    const usd = Number(result?.total_cost_usd) || 0;
    await this.store.insert('costs', {
      id: randomUUID(), mission_id: mission.id, task_id: task.id, role: task.role, usd,
      usage: result?.usage ?? null, model: Object.keys(result?.modelUsage ?? {})[0] ?? null, at: nowIso()
    });
    return usd;
  }

  async #execute(task) {
    const role = ROLES[task.role];
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const beat = setInterval(() => { this.queue.heartbeat(task.id, this.workerId).catch(() => {}); }, Math.max(200, this.queue.leaseMs / 3));
    beat.unref?.();
    try {
      let mission = await this.#mission(task.mission_id);
      if (mission.status === 'approved') mission = await this.#setMission(mission, 'running');
      const ws = await ensureWorkspace({
        repoPath: this.repoPath, baseDir: this.workspacesDir, task, mission, detached: role.readOnly
      });
      const plan = task.role === 'backend' ? await this.#approvedPlan(mission.id) : null;
      await emit(this.store, {
        mission_id: mission.id, task_id: task.id, type: 'task_started', actor: this.workerId,
        detail: { role: task.role, attempt: task.attempts, correction: task.corrections, workspace: path.basename(ws.path) }
      });
      const result = await this.runner({
        instruction: buildInstruction(task.role, task, mission, { plan, feedback: task.feedback }),
        cwd: ws.path,
        tools: role.tools,
        permissionMode: role.permissionMode,
        maxBudgetUsd: role.maxBudgetUsd,
        timeoutMs: role.timeoutMs,
        signal: controller.signal,
        systemPrompt: systemPromptFor(task.role)
      });
      const cost = await this.#recordCost(mission, task, result);
      if (!(await this.queue.toReview(task.id))) return; // cancelled while running
      const verdict = await this.#verify(task, mission, ws, result);
      await this.#conclude(task, mission, ws, result, verdict, cost);
    } catch (error) {
      if (error.cancelled || controller.signal.aborted) {
        await emit(this.store, { mission_id: task.mission_id, task_id: task.id, type: 'task_cancelled' });
        return;
      }
      const message = redact(error.message);
      const outcome = await this.queue.retryOrFail(task.id, message);
      if (outcome === 'failed') await this.#block(task.mission_id, `Task ${task.role} failed after retries: ${message}`);
    } finally {
      clearInterval(beat);
      this.controllers.delete(task.id);
    }
  }

  // ------------------------------------------------------------ verification

  async #verify(task, mission, ws, result) {
    const text = typeof result?.result === 'string' ? result.result : '';
    return task.role === 'architect'
      ? this.#verifyArchitect(ws, text)
      : this.#verifyBackend(task, mission, ws, text);
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

  async #verifyBackend(task, mission, ws, text) {
    const problems = [];
    const ev = await collectEvidence(ws);
    if (!ev.changed_files.length) problems.push('No file was changed: nothing to verify, the claim of completion is unsupported');
    const forbidden = forbiddenChanges(ev.changed_files);
    if (forbidden.length) problems.push(`Forbidden paths modified: ${forbidden.join(', ')}. Revert them.`);
    if (ev.secret_in_diff) problems.push('A secret-like value was found in the changes. Remove it.');

    let tests = { passed: 0, failed: 0 };
    let acceptance = null;
    if (ev.changed_files.length) {
      const run = await runTests(ws);
      tests = { passed: run.passed, failed: run.failed };
      if (run.exit_code !== 0 || run.failed > 0 || run.passed < 1) {
        problems.push(`Project tests did not pass (exit ${run.exit_code}, passed ${run.passed}, failed ${run.failed}):\n${run.tail}`);
      }
      if (mission.acceptance) {
        const files = writeAcceptance(ws, mission.acceptance);
        acceptance = await runTests(ws, files);
        clearAcceptance(ws);
        if (acceptance.exit_code !== 0 || acceptance.failed > 0 || acceptance.passed < 1) {
          problems.push(`Owner acceptance tests failed (passed ${acceptance.passed}, failed ${acceptance.failed}):\n${acceptance.tail}`);
        }
      }
    }

    let commit = null;
    if (!problems.length) {
      commit = await commitAll(ws, `feat: ${mission.objective.slice(0, 60).replace(/\s+/g, ' ')} [cto ${task.id.slice(0, 8)}]`);
    }
    return {
      ok: problems.length === 0,
      problems,
      evidence: {
        changed_files: ev.changed_files,
        diffstat: ev.diffstat,
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
      } else {
        await this.#setMission(current, 'review');
        await emit(this.store, { mission_id: mission.id, type: 'approval_requested', detail: { kind: 'completion' } });
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
    const report = {
      mission: { id: mission.id, project: mission.project, objective: mission.objective, status: mission.status, budget_usd: mission.budget_usd, spent_usd: mission.spent_usd },
      tasks: mission.tasks.map((t) => ({ role: t.role, status: t.status, attempts: t.attempts, corrections: t.corrections, failures: t.failures })),
      approvals: mission.approvals.map((a) => ({ kind: a.kind, decision: a.decision, by: a.by, at: a.at })),
      pending_approvals: pending,
      blockers: mission.blockers ?? [],
      corrections_requested: corrections,
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
      `## Changes\n${ev ? `Branch \`${ev.branch}\` @ \`${ev.commit}\`\n\n${(ev.changed_files ?? []).map((f) => `- \`${f}\``).join('\n')}\n\n\`\`\`\n${ev.diffstat ?? ''}\n\`\`\`` : '_No verified implementation yet._'}`,
      `## Tests actually executed by the CTO\n${backend ? `- project tests (\`${ev.tests_command}\`): ${backend.report.tests.passed} passed, ${backend.report.tests.failed} failed\n${ev.acceptance ? `- owner acceptance tests: ${ev.acceptance.passed} passed, ${ev.acceptance.failed} failed` : '- no owner acceptance tests were supplied'}` : '_None yet._'}`,
      `## CTO control\n- correction rounds requested: ${report.corrections_requested}\n- approvals: ${report.approvals.map((a) => `${a.kind}=${a.decision}`).join(', ') || 'none yet'}\n- cost: ${report.mission.spent_usd} USD of ${report.mission.budget_usd} USD budget`,
      '## Not done\nNo merge and no deployment: both require the owner\'s explicit approval.'
    ].join('\n\n');
  }
}
