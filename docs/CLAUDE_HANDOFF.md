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
## Current caveats
The UI is a minimal console, not a complete dashboard. Current dispatch is not connected to API. No live Claude execution, Supabase migration or CI pass has been verified.
