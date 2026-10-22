-- Applied to dedicated CTO Supabase dev project on 2026-10-22 as
-- restrict_cto_audit_trigger_execution.
-- Trigger function is not an external API; do not grant EXECUTE to public clients.
revoke execute on function public.cto_events_append_only() from public, anon, authenticated;
