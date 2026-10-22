# CTO IA architecture v0.2

## Flow
Owner → HTTP API / MissionControl → **Cto** (planner, dispatcher, verifier) → **JobQueue** (durable leases) →
isolated Claude Code specialists (one git worktree per task): architect → *owner approval* → backend → CTO verification
(git evidence, tests re-run by the CTO, owner acceptance tests, secret scan) → **QA ∥ security** reviews on the verified commit →
CTO decision (blocking finding = rework of the backend, bounded) → owner approval → branch + PR body. Supabase (or the local file store) keeps
missions, tasks, reports, append-only events, approvals and the cost ledger.

## Modules
| File | Role |
|---|---|
| `src/core.js` | Mission/task state machines, role definitions (tool allowlists, budgets), report contract |
| `src/cto.js` | Orchestrator: plan, approvals, dispatch, verification, corrections, escalation, consolidated report |
| `src/queue.js` | Durable queue: leases, heartbeat, retry with backoff, restart recovery, cancellation, approval/dependency gates |
| `src/runner.js` | Real `claude -p` adapter: stdin prompt, tool allowlist + denylist, `--max-budget-usd`, timeout, abort, sanitized env |
| `src/workspace.js` | Worktree isolation, git evidence, acceptance tests, test runner, forbidden paths |
| `src/agents.js` | System prompts, fenced/sanitized instructions, plan contract |
| `src/store/` | `FileStore` (single process, dev/test) and `SupabaseStore` (PostgREST via `fetch`, optimistic locking) |
| `src/server.js`, `public/` | HTTP API (tokens, rate limit, headers) and MissionControl UI |

## State model
Mission: `pending_approval → approved → running → awaiting_owner → running → review → completed`;
`blocked`, `failed`, `cancelled` are reachable where it makes sense (see `MISSION_TRANSITIONS`).
Task: `waiting → queued → running → review → done` (`review → queued` = correction round; `done → queued` = backend rework after a
blocking review, which resets the reviewers to `waiting`).
Owner approvals are explicit records (`mission`, `architecture`, `completion`); the queue refuses to dispatch the backend
task without a recorded `architecture` approval and a `done` architect task, even if the task was queued by mistake.

## Isolation and safety
- One worktree per task (`cto/<mission8>/<role>-<task8>`), reused across correction rounds; the architect's is detached and read-only.
- Agent environment is an allowlist: GitHub, Supabase and admin credentials are never forwarded.
- Tool allowlist per role; `bypassPermissions`, git, network and package managers are denied.
- Prompts fence untrusted text (`<objective>`, `<approved_plan>`, `<review_feedback>`) and strip secrets; reports and events are redacted.
- Forbidden paths (`.github/`, `.env*`, `SECURITY.md`, `AGENTS.md`) and secret-like diffs are rejected.
- Budget is checked before every dispatch; exceeding it blocks the mission and escalates.
- Reviewers (QA, security) are read-only, detached worktrees pinned to the commit under review; a reviewer that edits a file or omits the JSON verdict is corrected and its edits are discarded. A review can only add blockers: a "pass" never skips a CTO check, and unverified work never reaches the reviewers.

## Known limits (see README "Verification status")
Static owner/viewer tokens (no per-user auth), `FileStore` is single-process, the concurrency check is not atomic across
several worker processes, Supabase migration not applied to any project, no TLS termination.


## Audit hardening (2026-10-22)

Tests now run only through the CTO in a mandatory bubblewrap sandbox with no provider credentials. Specialists have no Bash tool. The exact staged tree is checked both before and after tests and rescanned before commit. Per-call mission budget reservations use CAS; interrupted calls consume an explicit conservative estimate. See [hardening details](HARDENING_2026-10-22.md).
