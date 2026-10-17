# CTO IA — Multiagent Development Control

Autonomous software-development team supervised by an AI CTO. **Independent from the AiWorkPay business workforce.**

The owner gives an objective. The CTO plans it, delegates to specialist agents (real Claude Code sessions in isolated git
worktrees), verifies their output itself (git evidence, tests re-run by the CTO, owner acceptance tests, secret scan),
requests corrections, escalates blockers, and prepares a documented branch/PR for the owner. It never merges or deploys.

## Quick start
No runtime dependency (Node ≥ 20, the `claude` CLI for real agent runs).

```
npm run check                 # lint + secret scan + tests
node scripts/demo.js          # real end-to-end demo with the actual Claude CLI (spends real money, capped at 2 USD)
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
`POST /api/missions/:id/budget {budget_usd}` · `POST /api/missions/:id/cancel` · `POST /api/missions/:id/run[?wait=1]` · `GET /api/agents` · `GET /api/whoami`.
`GET /health` is public. MissionControl is served on `/` (token kept in memory only).

## Verification status (what was really run, what was not)
| Item | Status |
|---|---|
| `npm run lint`, `npm run scan`, `npm test` (80 tests) | **Run locally, green** (Node 22.22). Not yet confirmed on GitHub Actions at the time of writing — see the PR checks. |
| Real Claude invocation on an isolated test repo, objective → delegation → execution → report → CTO control → verified commit | **Run, succeeded** — evidence in [docs/DEMO_EVIDENCE.md](docs/DEMO_EVIDENCE.md) |
| Correction loop | Covered by tests with scripted agent doubles that modify real worktrees. **Not triggered in the live run** (the agent passed first time). |
| Restart recovery, cancellation, retries, budget stop, approval gates, concurrency limit | Covered by tests (real git worktrees, real files; agents scripted) |
| `SupabaseStore` | Tested only against a **simulated PostgREST** server (`testkit/fake-postgrest.js`). **Never run against a real Supabase project.** |
| `supabase/migrations/001_init.sql` | Written, **not applied** to any project. The only project reachable from this session (`zeeroo`) is unrelated and was not touched. A dedicated dev project is needed (creating one has a cost: owner decision). |
| MissionControl UI | Served and CSP-tested over HTTP, lint-checked (no `innerHTML`, no browser storage). **Not exercised in a real browser.** |
| `npm install` | Not needed (no dependencies). The previous `@supabase/supabase-js` dependency was removed because the session's network policy blocks the npm registry. |

## Limitations
- Authentication is two static bearer tokens (owner / viewer), not per-user accounts. Do not expose publicly; bind to localhost or put it behind an authenticating reverse proxy with TLS.
- `FileStore` is single-process. The concurrency limit check is not atomic across several worker processes (use one worker or add a DB-side lock before scaling out).
- Only two specialists exist (architect, backend). Frontend, QA, security and DevOps agents are not implemented.
- The CTO prepares the branch and PR body locally; opening the GitHub PR and merging are left to the owner.
- `docs/01…06` are still empty templates, not approved specifications: they were not invented.
- CI has no dependency audit or SAST step (there are no dependencies); actions are pinned by major tag, not by SHA.

## Release checklist
Owner reviews PR · dedicated Supabase dev project created and migration applied and tested (including RLS denial for `anon`) · per-user auth in front of the API · TLS · budget ceilings confirmed · only then consider hosting. No production deployment without explicit owner approval.
