# CTO IA — Supabase development integration

## Verified project (2026-10-22)
- Supabase project: `cto-ai-multiagents`
- Project ref: `wdfvaxdesxqwipqsavqm`
- URL: `https://wdfvaxdesxqwipqsavqm.supabase.co`
- Actual region: `eu-west-1` (Ireland), **not** Paris
- Migration `cto_initial_schema` applied successfully (version `20261022205413`)
- Tables: `cto_missions`, `cto_tasks`, `cto_reports`, `cto_events`, `cto_approvals`, `cto_costs`
- Verified all six have RLS enabled and forced; anon and authenticated have no SELECT privilege, service_role has SELECT.
- No real mission or live Claude Code execution has yet been verified against this database.

## Connect the Node server (private local environment only)
The repository already has a `SupabaseStore` implemented using PostgREST; no npm dependency is needed.

Set the following environment variables **outside GitHub and outside the browser**:

```sh
export SUPABASE_URL=https://wdfvaxdesxqwipqsavqm.supabase.co
export SUPABASE_SERVICE_ROLE_KEY='<retrieve privately from Supabase project API settings>'
export CTO_ADMIN_TOKEN='<unique random secret at least 24 characters>'
export CTO_REPO_PATH='<absolute path to authorized disposable test repository>'
npm run check
npm start
```

Never commit secrets or expose the service role key in MissionControl. The API should be localhost-only until proper per-user authentication is implemented.

## Required real integration checks
1. Start with a disposable authorized Git repository and a strict budget.
2. Create a mission via the API; inspect the row in `cto_missions` and its tasks in `cto_tasks`.
3. Verify `cto_events` audit trail, explicit approvals and costs.
4. Restart the server; confirm missions and task leases are recovered without duplicate execution.
5. Test parallel claims, cancellation and bounded retries with actual Supabase persistence.
6. Test denied anonymous/authenticated access using non-privileged keys, and verify no browser receives the service role key.
7. Record actual test commands and outcomes in an evidence document.

## Important limitation
Supabase was provisioned and schema verified, but the application runtime has **not** been connected to a live service-role credential in this session. No production deployment, PR merge or paid agent execution is authorized by this document.
