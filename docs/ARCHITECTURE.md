# CTO IA architecture v0.1
## Boundaries
Owner -> CTO API -> mission planner -> durable job queue -> isolated Claude Code specialists -> QA/security review -> human approval -> GitHub PR. Supabase stores projects, missions, tasks, events, reports, approvals and cost ledger. MissionControl reads the API, never Supabase service credentials.
## State model
Mission: pending_approval -> approved -> running -> review -> completed; blocked and cancelled states supported. A task can start only when dependencies have succeeded and its required approval is recorded.
## Isolation
One workspace/worktree per task, least-privilege repository permissions, secret redaction, command allowlist and strict timeouts. Never let agent output directly authorize a sensitive action.
## Agents
First wave: architect (design/review) and backend (implementation/test). Next: frontend, QA, security, DevOps.
## Risks to resolve
CLI process isolation, concurrency and recovery, secure user authentication, cost accounting, real audit events, reliable idempotency, rate limiting, Supabase RLS, missing source specifications.
