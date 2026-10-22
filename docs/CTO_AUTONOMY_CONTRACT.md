# CTO autonomy contract — acceptance criteria

The CTO owns the technical outcome, not merely task delegation. This development team is completely separate from AiWorkPay's business workforce.

## Operational loop
1. Owner submits a project objective and constraints.
2. CTO inspects the authorized GitHub repository and writes measurable acceptance criteria.
3. CTO creates a dependency graph and assigns tasks to isolated Claude Code workers.
4. Workers execute within their approved worktrees and emit structured reports: task_id, commit_sha, changed_files, tests_executed, test_results, blockers, duration, token_usage and cost where available.
5. CTO independently verifies artifacts, tests and CI status; agent self-report alone never marks a task complete.
6. On failure CTO diagnoses, retries within configured limits, or reassigns to another specialist. Escalate persistent blockers instead of infinite loops.
7. CTO prepares a documented PR and consolidated report; owner authorizes merge and production deployment.

## Mandatory invariants
- No task execution before required authorization.
- No concurrent writes to the same worktree.
- No transition to completed without verified evidence.
- All transitions, approvals, tool calls and failures are durable and attributable.
- Hard caps on parallelism, retries, runtime and spend; hard stop when budget is exceeded.
- Owner approval for spending, legal or sensitive operations, merges and production deploys.
- Credentials remain server-side; workers get least-privilege short-lived access.
- Reboot must not lose missions or create duplicate execution.
- Distinguish pending, running, blocked, review, failed, completed and cancelled.
- No fabricated tests, CI results, deployment or costs.

## MVP end-to-end acceptance
Create a mission against a disposable authorized repository; approve it; architect produces a plan; CTO verifies it; backend agent changes code; tests execute; CTO inspects results and requests correction when necessary; reports and event history survive server restart; MissionControl displays true status and approvals; PR remains unmerged pending owner decision.

## Next phase
Add frontend, QA, security and DevOps agents, multi-project scheduling, richer policies and metrics.
