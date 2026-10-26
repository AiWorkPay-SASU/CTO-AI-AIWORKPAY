# CTO IA — Multiagent Development Control

Autonomous software-development team supervised by an AI CTO. **Independent from the AiWorkPay business workforce.**

The owner gives an objective. The CTO plans it, delegates to four specialists (architect, backend, then QA and security in parallel; real Claude Code sessions in isolated git
worktrees), verifies their output itself (git evidence, tests re-run by the CTO, owner acceptance tests, secret scan),
requests corrections or rework, escalates blockers, and prepares a documented branch/PR for the owner. It never merges or deploys.

## Quick start
No npm runtime dependency. The worker requires Linux, Node ≥ 20, bubblewrap (`bwrap`) with namespace support, and the `claude` CLI for real agent runs. Generated tests fail closed if isolation is unavailable.

```
npm run check                 # lint + secret scan + tests
node scripts/demo.js          # real end-to-end demo with the actual Claude CLI (spends real money, about 0.30 USD, capped at 3 USD)
CTO_ADMIN_TOKEN=<24+ chars> CTO_REPO_PATH=/path/to/repo npm start     # API + MissionControl on http://127.0.0.1:3000
```

### Configuration
| Variable | Purpose |
|---|---|
| `CTO_ADMIN_TOKEN` (24+ chars, required) | Owner bearer token |
| `CTO_VIEWER_TOKEN` (optional, 24+ chars, must differ) | Read-only token |
| `CTO_REPO_PATH` | Local checkout the agents work on (default: cwd) |
| `CTO_WORKSPACES_DIR`, `CTO_DATA_DIR` | Worktrees and local file-store location |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Use Supabase instead of the file store (server-side only, never in a browser) |
| `CTO_MAX_CONCURRENT`, `CTO_WORKER=0`, `HOST`, `PORT` | Concurrency limit, disable the background worker, bind address |

### API (all `/api` routes need `Authorization: Bearer <token>`)
`GET /api/missions` · `POST /api/missions {project, objective, budget_usd?, acceptance?}` · `GET /api/missions/:id` ·
`GET /api/missions/:id/events` · `GET /api/missions/:id/report` · `POST /api/missions/:id/approvals {kind: mission|architecture|completion, decision: approve|reject, note?}` ·
`POST /api/missions/:id/budget {budget_usd}` · `POST /api/missions/:id/cancel` · `POST /api/missions/:id/run[?wait=1]` · `POST /api/missions/:id/resume` (owner, after an escalation) · `POST /api/missions/:id/pr` (draft PR) · `POST /api/missions/:id/ci` (read CI, rework on failure) · `GET /api/agents` · `GET /api/whoami`.
Environment for several projects / GitHub: `CTO_REPOS` (JSON `{"owner/name": "/path/to/clone"}`, doubles as the project allowlist), `CTO_GITHUB_TOKEN`, `CTO_ALLOWED_REPOS`. See [docs/OPERATIONS.md](docs/OPERATIONS.md).
`GET /health` is public. MissionControl is served on `/` (token kept in memory only).

## Verification status (what was really run, what was not)
Measured on branch `audit/cto-reliability-2026-10-26`, Node 22.23: `npm run check` = 144 tests, 142 pass, 0 fail, 2 skipped (see below). Details and the mapping of the 12 acceptance scenarios: [docs/RECETTE.md](docs/RECETTE.md); audit findings: [docs/AUDIT_2026-10-26.md](docs/AUDIT_2026-10-26.md).

| Item | Status |
|---|---|
| `npm run lint`, `npm run scan`, `npm test` | **Run locally, green** (142 pass / 2 skipped). GitHub Actions cannot run: the account's billing blocks the jobs (not a code failure). |
| Concurrency, leases, fencing, crash windows, idempotent approvals, Supabase pagination | Defects D1–D6 of the audit reproduced red, fixed, covered by `test/reliability.test.js`, `test/recette.test.js` (two concurrent workers; real `SIGKILL` of a worker process). Mutation checks confirmed the tests fail when the fix is removed. |
| MissionControl | **Exercised in real headless Chromium** (`test/e2e.test.js`, 5 tests): login, mission, approvals, blocked + resume, viewer read-only, reload and history. |
| GitHub draft PR + CI feedback loop | Tested against a **simulated GitHub API** (`testkit/fake-github.js`) with a real bare git remote. **Never run against github.com.** |
| `supabase/migrations/001–003` | Applied and tested on a **real local PostgreSQL 16** (`test/migrations.test.js`: RLS denial, append-only events, unique approval, rev guard, replay of real engine output). **Not applied to any Supabase project** (no dedicated project reachable with credentials from here). |
| `SupabaseStore` over the network | Simulated PostgREST only. The opt-in live test (`test/supabase-live.test.js`) was **skipped**: no credentials. |
| Real bubblewrap isolation test | **Skipped here**: `bwrap` is not installable in this environment. It stays mandatory in CI (`CTO_REQUIRE_SANDBOX_TESTS=1`). Do not treat the isolation as proven until it ran green somewhere. |
| Real Claude invocation | Historical run: [docs/DEMO_EVIDENCE.md](docs/DEMO_EVIDENCE.md). No new spend was engaged; a real correction loop needs an approved budget. |

## Audit corrections

[Hardening details and validation limits](docs/HARDENING_2026-10-22.md): final staged-tree checks after tests, persisted budget reservations, and mandatory credential-free Linux test isolation. Agents submit tests; the CTO executes them. Interrupted calls retain an explicitly labelled cost estimate. CI requires the real sandbox integration check.

## Limitations
- Authentication is two static bearer tokens (owner / viewer), not per-user accounts. Do not expose publicly; bind to localhost or put it behind an authenticating reverse proxy with TLS.
- `FileStore` is single-process; use `SupabaseStore` for several workers (claim-then-verify slot protocol, covered by tests against the simulated PostgREST and the 003 guards on real PostgreSQL, but not against a live Supabase).
- Four specialists exist (architect, backend, QA, security). Frontend, DevOps and a separate CTO quality-control agent are **not implemented** (engine reliability was prioritised).
- QA and security verdicts come from an LLM reading code that another LLM wrote: they are advisory and can be manipulated. By design they can only add blockers; they never replace the CTO's own checks (git evidence, tests re-run, acceptance tests, secret scan).
- The CTO can push its task branch and open a **draft** PR (restricted GitHub client, allowlisted repositories). Merging and deploying are never done by the CTO.
- `docs/01…06` are still empty templates, not approved specifications: they were not invented.
- CI has no dependency audit or SAST step (there are no npm dependencies); actions are pinned by major tag, not by SHA.

## Release checklist
Owner reviews PR · dedicated Supabase dev project created and migration applied and tested (including RLS denial for `anon`) · per-user auth in front of the API · TLS · budget ceilings confirmed · only then consider hosting. No production deployment without explicit owner approval.

