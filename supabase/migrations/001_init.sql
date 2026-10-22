-- CTO IA schema.
-- Apply ONLY to a dedicated development project, never to an unrelated one.
-- Status: written, NOT yet applied to any Supabase project (see README, "Verification status").
--
-- All tables share one generic shape so the server store can use optimistic locking:
--   id uuid, mission_id uuid, status text, data jsonb (full record), rev int (version), timestamps.
-- Access model: RLS is enabled with NO policy, and privileges are revoked from anon/authenticated,
-- so only the server (service_role key, which bypasses RLS) can read or write. Browsers never talk to Supabase.

do $$
declare
  t text;
begin
  foreach t in array array['cto_missions','cto_tasks','cto_reports','cto_events','cto_approvals','cto_costs']
  loop
    execute format($f$
      create table if not exists public.%I (
        id uuid primary key,
        mission_id uuid,
        status text,
        data jsonb not null,
        rev integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )$f$, t);
    execute format('create index if not exists %I on public.%I (mission_id)', t || '_mission_idx', t);
    execute format('create index if not exists %I on public.%I (status)', t || '_status_idx', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- Referential integrity for everything that belongs to a mission.
do $$
declare
  t text;
begin
  foreach t in array array['cto_tasks','cto_reports','cto_events','cto_approvals','cto_costs']
  loop
    if not exists (select 1 from pg_constraint where conname = t || '_mission_fk') then
      execute format(
        'alter table public.%I add constraint %I foreign key (mission_id) references public.cto_missions(id)',
        t, t || '_mission_fk');
    end if;
  end loop;
end $$;

-- The audit trail is append-only: no update, no delete, no truncate.
create or replace function public.cto_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'cto_events is append-only';
end $$;

drop trigger if exists cto_events_no_mutation on public.cto_events;
create trigger cto_events_no_mutation
  before update or delete on public.cto_events
  for each row execute function public.cto_events_append_only();

drop trigger if exists cto_events_no_truncate on public.cto_events;
create trigger cto_events_no_truncate
  before truncate on public.cto_events
  for each statement execute function public.cto_events_append_only();
