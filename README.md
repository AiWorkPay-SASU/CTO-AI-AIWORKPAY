# CTO IA — Multiagent Development Control

Independent from the AiWorkPay business workforce.

## Initial scaffold
Node.js 20+ API; CTO mission planner; architect and backend role definitions; Supabase SQL schema and server-side repository; approval-gated Claude Code CLI adapter; unit tests and GitHub Actions.

## Run locally
1. Run `npm install && npm test`.
2. Apply `supabase/migrations/001_init.sql` to a dedicated Supabase development project.
3. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `CTO_ADMIN_TOKEN` (24+ characters) in the server environment. Never put the service-role key in client code.
4. Run `npm start`. `GET /health` is public. `GET /api/missions`, `POST /api/missions` with `{ "project":"owner/repo", "objective":"..." }`, and `POST /api/missions/:id/status` with `{ "status":"approved" }` require `Authorization: Bearer <CTO_ADMIN_TOKEN>`.

## Scope boundaries
The initial planner defines two specialist tasks, but actual Claude dispatch, concurrent workers, reporting API, graphical MissionControl and end-to-end integration tests are **not yet implemented**. No real agent run or deployment is claimed. No production deployment without owner approval.

## Next development milestones
Implement isolated agent workspaces and job queue, auditable reports, MissionControl UI, integration tests, and cost tracking. Review the nine specification documents when available.
