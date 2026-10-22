# CTO IA — release gates (2026-10-22)

## Verified from current repository source
- Existing CTO orchestration, durable queue abstraction, approval gates, isolated worktrees, four roles (architect/backend/QA/security), CLI runner and MissionControl server/UI.
- README reports 93 tests and a real four-agent demonstration. These are repository claims, not independently re-executed in this review.
- docs/DEMO_EVIDENCE.md reports a disposable-repository Claude Code run on 2026-10-17, 10 project tests, 6 acceptance tests, and $0.300 cost.
- Real Supabase project migration/integration is **not** verified. MissionControl browser end-to-end is **not** verified.
- Frontend and DevOps agents are not implemented. Per-user authentication and cross-process locking are not implemented.

## Blocking gates before public launch
1. Run current CI on exact head commit; archive links and failure details.
2. Use a **dedicated** Supabase dev project after owner approval of any cost. Apply versioned migrations and run actual PostgREST/RLS/integration tests, including anon denial and restart recovery.
3. Replace static bearer tokens with per-user auth and authorization; test ownership and approval provenance.
4. Ensure worker concurrency is safe across processes (DB leasing/locks); validate idempotency, cancellation, stale leases and crash recovery against real database.
5. Run MissionControl browser E2E with real API, auth, approvals, blockers and refresh.
6. Prove an actual correction loop with a disposable repository and Claude CLI, bounded by budget.
7. Require explicit owner approval for spending, PR merges, sensitive operations and production deployments.

## Execution order
P0: tests/CI baseline, Supabase dev integration, reliable multiworker leases.
P1: per-user auth, MissionControl E2E, correction-loop demonstration.
P2: frontend/DevOps agents, multi-repository scheduler, metrics and audit export.

## Non-negotiable
Do not touch ZEEROO or any unrelated Supabase project. Do not invent test results. Do not merge or deploy without owner approval.
