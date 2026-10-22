import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planMission, validateTransition, validateTaskTransition, validateReport, summarize, ROLES
} from '../src/core.js';

test('plans four specialist tasks: architect, backend, then independent qa and security', () => {
  const m = planMission('Build API', 'owner/repo');
  assert.equal(m.tasks.length, 4);
  assert.deepEqual(m.tasks.map((x) => x.role), ['architect', 'backend', 'qa', 'security']);
  assert.equal(m.status, 'pending_approval');
  const backend = m.tasks[1];
  for (const reviewer of m.tasks.slice(2)) {
    assert.equal(reviewer.depends_on, backend.id);
    assert.equal(reviewer.status, 'waiting');
    assert.equal(reviewer.requires_approval, null);
  }
});

test('backend waits for the architect task and for the architecture approval', () => {
  const [architect, backend] = planMission('Build API', 'owner/repo').tasks;
  assert.equal(architect.status, 'queued');
  assert.equal(backend.status, 'waiting');
  assert.equal(backend.depends_on, architect.id);
  assert.equal(backend.requires_approval, 'architecture');
});

test('rejects empty mission, bad project and bad budget', () => {
  assert.throws(() => planMission('', 'owner/repo'));
  assert.throws(() => planMission('x', ''));
  assert.throws(() => planMission('x', 'not a repo'));
  assert.throws(() => planMission('x', '../../etc/passwd'));
  assert.throws(() => planMission('x', '../etc'));
  assert.throws(() => planMission('x', 'owner/..'));
  assert.equal(planMission('x', 'cortexAI-2025/CTO-AI-AIWORKPAY-').project, 'cortexAI-2025/CTO-AI-AIWORKPAY-');
  assert.throws(() => planMission('x', 'owner/repo', { budgetUsd: 0 }));
  assert.throws(() => planMission('x', 'owner/repo', { budgetUsd: 500 }));
});

test('objective is sanitized and bounded', () => {
  const m = planMission(`  hello\u0000\u0007 world${'a'.repeat(5000)}`, 'owner/repo');
  assert.ok(!m.objective.includes('\u0000'));
  assert.ok(m.objective.length <= 2000);
});

test('blocks unauthorized state jump', () => {
  assert.throws(() => validateTransition('pending_approval', 'completed'));
  assert.throws(() => validateTransition('completed', 'running'));
  assert.equal(validateTransition('awaiting_owner', 'running'), 'running');
  assert.throws(() => validateTaskTransition('waiting', 'running'));
  assert.equal(validateTaskTransition('review', 'queued'), 'queued');
});

test('consolidates blockers', () => {
  const m = planMission('X', 'owner/repo');
  assert.equal(summarize(m, [{ role: 'backend', status: 'blocked', summary: 'CI failed' }]).blockers[0], 'CI failed');
});

test('report contract', () => {
  const ok = {
    task_id: 't', status: 'DONE', progress_note: 'n', artifacts: [], tests: { passed: 1, failed: 0 },
    blockers: [], next_action: 'x', requires_human_approval: false
  };
  assert.equal(validateReport(ok), ok);
  assert.throws(() => validateReport({ ...ok, status: 'MAYBE' }), /status/);
  assert.throws(() => validateReport({ ...ok, tests: null }), /tests/);
  assert.throws(() => validateReport(null));
});

test('reviewers are read-only, have no write tool and run on a bounded budget', () => {
  for (const role of ['qa', 'security']) {
    assert.equal(ROLES[role].readOnly, true);
    assert.equal(ROLES[role].reviewer, true);
    assert.ok(!ROLES[role].tools.some((t) => /Write|Edit/.test(t)), role);
    assert.ok(ROLES[role].maxBudgetUsd <= 0.5);
  }
  assert.ok(!ROLES.security.tools.some((t) => /Bash/.test(t)), 'the security auditor never executes anything');
  assert.equal(validateTaskTransition('done', 'queued'), 'queued');
  assert.equal(validateTaskTransition('done', 'waiting'), 'waiting');
  assert.throws(() => validateTaskTransition('failed', 'queued'));
});

test('architect is read-only and has no write tool; backend can write but not use git or network', () => {
  assert.equal(ROLES.architect.readOnly, true);
  assert.ok(!ROLES.architect.tools.some((t) => /Write|Edit|Bash/.test(t)));
  assert.ok(ROLES.backend.tools.includes('Write'));
  assert.ok(!ROLES.backend.tools.some((t) => /git|curl|WebFetch/.test(t)));
  assert.ok(Object.isFrozen(ROLES));
});
