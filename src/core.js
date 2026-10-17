import { randomUUID } from 'node:crypto';
import { sanitizeText } from './util.js';

export const DEFAULT_BUDGET_USD = 3;
export const MAX_OBJECTIVE_LENGTH = 2000;

export const MISSION_TRANSITIONS = Object.freeze({
  pending_approval: ['approved', 'cancelled'],
  approved: ['running', 'blocked', 'cancelled'],
  running: ['awaiting_owner', 'blocked', 'review', 'failed', 'cancelled'],
  awaiting_owner: ['running', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  review: ['completed', 'running', 'cancelled'],
  failed: [],
  completed: [],
  cancelled: []
});

export const TASK_TRANSITIONS = Object.freeze({
  waiting: ['queued', 'cancelled'],
  queued: ['running', 'cancelled', 'failed'],
  running: ['review', 'queued', 'failed', 'cancelled'],
  review: ['done', 'queued', 'failed'],
  // done -> queued reopens a task for rework after a failed independent review;
  // done -> waiting resets the reviewers that depend on it.
  done: ['queued', 'waiting'],
  failed: [],
  cancelled: []
});

export const TERMINAL_MISSION = new Set(['completed', 'failed', 'cancelled']);

export function validateTransition(from, to, table = MISSION_TRANSITIONS) {
  if (!table[from]?.includes(to)) throw new Error(`Invalid transition ${from} -> ${to}`);
  return to;
}

export const validateTaskTransition = (from, to) => validateTransition(from, to, TASK_TRANSITIONS);

/**
 * Specialist roles. `tools` is the Claude Code allowlist; everything else is denied because
 * the runner never prompts. `readOnly` roles must leave their worktree untouched.
 */
export const ROLES = Object.freeze({
  architect: Object.freeze({
    capabilities: ['design', 'review'],
    readOnly: true,
    permissionMode: 'default',
    tools: ['Read', 'Glob', 'Grep'],
    maxBudgetUsd: 0.5,
    timeoutMs: 180000
  }),
  backend: Object.freeze({
    capabilities: ['implement', 'test'],
    readOnly: false,
    permissionMode: 'acceptEdits',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node --test:*)', 'Bash(node --check:*)', 'Bash(ls:*)'],
    maxBudgetUsd: 1,
    timeoutMs: 300000
  }),
  // Independent reviewers: read-only, work on the backend's verified commit, can only make the CTO stricter.
  qa: Object.freeze({
    capabilities: ['review', 'test'],
    readOnly: true,
    reviewer: true,
    permissionMode: 'default',
    tools: ['Read', 'Glob', 'Grep', 'Bash(node --test:*)', 'Bash(ls:*)'],
    maxBudgetUsd: 0.4,
    timeoutMs: 240000
  }),
  security: Object.freeze({
    capabilities: ['audit'],
    readOnly: true,
    reviewer: true,
    permissionMode: 'default',
    tools: ['Read', 'Glob', 'Grep'],
    maxBudgetUsd: 0.4,
    timeoutMs: 240000
  })
});

export const REVIEWER_ROLES = Object.freeze(Object.keys(ROLES).filter((r) => ROLES[r].reviewer));

// GitHub-style owner/repo: the owner cannot start with a dot or hyphen, the repo cannot be "." or "..".
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

/**
 * Builds a mission with its two initial tasks. The mission starts pending owner approval,
 * the backend task waits for the architect and for the owner's architecture approval.
 */
export function planMission(objective, project, { budgetUsd = DEFAULT_BUDGET_USD, acceptance = null } = {}) {
  if (typeof objective !== 'string' || !objective.trim() || !project) {
    throw new Error('Objective and project required');
  }
  const cleanObjective = sanitizeText(objective, MAX_OBJECTIVE_LENGTH);
  if (!cleanObjective) throw new Error('Objective and project required');
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) {
    throw new Error('Project must look like owner/repo');
  }
  if (!(budgetUsd > 0) || budgetUsd > 50) throw new Error('Budget must be between 0 and 50 USD');

  const id = randomUUID();
  const architectId = randomUUID();
  const backendId = randomUUID();
  const reviewTask = (role, instruction) => ({
    id: randomUUID(),
    mission_id: id,
    role,
    instruction,
    status: 'waiting',
    depends_on: backendId,
    requires_approval: null,
    attempts: 0,
    failures: 0,
    corrections: 0
  });
  const created = new Date().toISOString();
  return {
    id,
    project,
    objective: cleanObjective,
    status: 'pending_approval',
    budget_usd: budgetUsd,
    spent_usd: 0,
    acceptance,
    created_at: created,
    tasks: [
      {
        id: architectId,
        mission_id: id,
        role: 'architect',
        instruction: `Analyze requirements and propose implementation plan for: ${cleanObjective}`,
        status: 'queued',
        depends_on: null,
        requires_approval: null,
        attempts: 0,
        failures: 0,
        corrections: 0
      },
      {
        id: backendId,
        mission_id: id,
        role: 'backend',
        instruction: `Implement and test approved architecture for: ${cleanObjective}`,
        status: 'waiting',
        depends_on: architectId,
        requires_approval: 'architecture',
        attempts: 0,
        failures: 0,
        corrections: 0
      },
      reviewTask('qa', `Independently validate the implementation of: ${cleanObjective}`),
      reviewTask('security', `Audit the security of the implementation of: ${cleanObjective}`)
    ]
  };
}

const REPORT_STATUSES = new Set(['IN_PROGRESS', 'REVIEW', 'DONE', 'BLOCKED', 'FAILED']);

/** Report contract from docs/06_IMPLEMENTATION_PLAN.md. */
export function validateReport(report) {
  const problems = [];
  if (!report || typeof report !== 'object') throw new Error('Report must be an object');
  if (typeof report.task_id !== 'string' || !report.task_id) problems.push('task_id');
  if (!REPORT_STATUSES.has(report.status)) problems.push('status');
  if (typeof report.progress_note !== 'string') problems.push('progress_note');
  if (!Array.isArray(report.artifacts)) problems.push('artifacts');
  if (!report.tests || typeof report.tests.passed !== 'number' || typeof report.tests.failed !== 'number') {
    problems.push('tests');
  }
  if (!Array.isArray(report.blockers)) problems.push('blockers');
  if (typeof report.next_action !== 'string') problems.push('next_action');
  if (typeof report.requires_human_approval !== 'boolean') problems.push('requires_human_approval');
  if (problems.length) throw new Error(`Invalid report fields: ${problems.join(', ')}`);
  return report;
}

export function summarize(mission, reports) {
  return {
    mission_id: mission.id,
    status: mission.status,
    reports: reports.map((r) => ({
      role: r.role,
      status: r.status,
      summary: r.summary,
      evidence: r.evidence || []
    })),
    blockers: reports.filter((r) => r.status === 'blocked').map((r) => r.summary)
  };
}
