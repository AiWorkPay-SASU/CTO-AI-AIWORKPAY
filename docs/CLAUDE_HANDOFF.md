# Claude Code — CTO IA handoff
## Objective
Complete MVP on `feat/cto-mvp-v1` only. Open/update PR #1; never merge or deploy without owner approval. This software engineering team is separate from AiWorkPay's business workforce.
## Existing work
Node HTTP API, CTO planner, architect/backend role descriptors, Supabase migration and store, Claude CLI adapter, dispatch function, minimal admin console, unit tests and CI.
## Mandatory next steps
1. Audit all nine original specifications; report absent documents instead of inventing their contents.
2. Run `npm install && npm test` and fix failing tests. Add integration tests for HTTP endpoints and Supabase repository.
3. Implement a durable mission/job queue, concurrency limits, task leasing, retries, cancellation, timeouts and restart recovery. No in-memory-only execution state.
4. Enforce architect -> owner approval -> backend dependency before dispatch. Make approvals explicit and audit logged.
5. Isolate every agent in a unique worktree/container, restrict GitHub repo access, sanitize prompts, and ensure Claude CLI cannot bypass approval policies. Add real execution evidence and cost/usage tracking.
6. Implement report ingestion, append-only events, blockers, consolidated CTO summaries and GitHub PR links.
7. Expand MissionControl with statuses, agents, approvals, audit trail and error states. Do not put service-role keys or long-lived admin secrets in browser storage.
8. Replace shared bearer token with real authenticated users and role-based access before public hosting. Harden input validation, rate limits, CSRF/CORS, and security headers.
9. Validate SQL RLS policies, server-only service role and development environment. Never modify an unrelated Supabase project.
10. Add full CI including lint/typecheck/security checks; document setup, smoke test evidence, limitations and release checklist.
## Definition of done
Real Claude invocation on isolated test repo; persisted mission and report; verified approvals; tests green; MissionControl reflects actual status; no production deployment; PR reviewed by owner.
## Status after MVP v0.2
Done and verified locally: durable queue with leases/retries/recovery, approval gates (mission → architecture → completion), isolated worktrees,
real Claude runner, CTO-side verification (git evidence, tests re-run, owner acceptance tests, secret/forbidden-path checks), cost ledger and budget stop,
append-only audit events, consolidated report + PR body, HTTP API with tokens/rate limit/headers, MissionControl UI, 80 automated tests, real demo (docs/DEMO_EVIDENCE.md).

Still open (do not claim otherwise):
1. Apply and test `supabase/migrations/001_init.sql` on a **dedicated dev project** (none exists; `zeeroo` is unrelated). Test RLS denial for `anon`/`authenticated`, and run `SupabaseStore` against it.
2. Replace the two static tokens by real authenticated users + roles before any public hosting; add TLS.
3. Make the concurrency limit atomic across worker processes (DB lock) before scaling out; `FileStore` is single-process.
4. Add frontend, QA, security and DevOps specialists; independent QA/security review agent for high-risk missions.
5. Open the GitHub PR automatically from a verified branch (needs an owner-approved credential scope).
6. Exercise MissionControl in a real browser; add dependency/SAST steps to CI if dependencies are introduced.
7. Fill docs/01…06 with real, approved specifications.
