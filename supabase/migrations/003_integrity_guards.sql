-- CTO IA integrity guards (2026-10-26).
-- Apply ONLY to the dedicated CTO development project, never to an unrelated one. Idempotent.
-- Status: written and verified on a real local PostgreSQL 16 (test/migrations.test.js); NOT yet applied to any Supabase project.
--
-- The application already enforces these rules (deterministic approval ids, optimistic locking on `rev`, fencing).
-- This migration makes the database refuse what a buggy or stale client could still try, so that the rules do not
-- depend on every writer being correct.

-- 1. One decision per (mission, kind): a double submit or a retry can never leave two approvals.
create unique index if not exists cto_approvals_mission_kind_uidx
  on public.cto_approvals (mission_id, (data ->> 'kind'));

-- 2. The indexed columns must mirror the record they index (the store writes both in one statement).
do $$
declare
  t text;
begin
  foreach t in array array['cto_missions','cto_tasks','cto_reports','cto_events','cto_approvals','cto_costs']
  loop
    if not exists (select 1 from pg_constraint where conname = t || '_mirror_chk') then
      execute format(
        'alter table public.%I add constraint %I check (
           status is not distinct from (data ->> ''status'')
           and mission_id::text is not distinct from (data ->> ''mission_id''))',
        t, t || '_mirror_chk');
    end if;
  end loop;
end $$;

-- 3. Status vocabularies (see src/core.js).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cto_missions_status_chk') then
    alter table public.cto_missions add constraint cto_missions_status_chk check (status in
      ('pending_approval','approved','running','awaiting_owner','blocked','review','failed','completed','cancelled'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cto_tasks_status_chk') then
    alter table public.cto_tasks add constraint cto_tasks_status_chk check (status in
      ('waiting','queued','running','review','done','failed','cancelled'));
  end if;
end $$;

-- 4. Optimistic locking is enforced by the database: an update must carry rev = old rev + 1 and cannot move a row
--    to another mission. A stale writer that forgets the rev filter is rejected instead of overwriting newer state.
create or replace function public.cto_guard_update() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id or new.mission_id is distinct from old.mission_id then
    raise exception 'cto rows cannot change id or mission';
  end if;
  if new.rev is distinct from old.rev + 1 then
    raise exception 'stale write: rev must advance by exactly one (% -> %)', old.rev, new.rev;
  end if;
  return new;
end $$;
revoke execute on function public.cto_guard_update() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['cto_missions','cto_tasks','cto_reports','cto_approvals','cto_costs']
  loop
    execute format('drop trigger if exists cto_guard_update on public.%I', t);
    execute format('create trigger cto_guard_update before update on public.%I for each row execute function public.cto_guard_update()', t);
  end loop;
end $$;

-- 5. Indexes that match the store's paged reads: where mission_id|status = ? order by created_at, id.
do $$
declare
  t text;
begin
  foreach t in array array['cto_missions','cto_tasks','cto_reports','cto_events','cto_approvals','cto_costs']
  loop
    execute format('create index if not exists %I on public.%I (mission_id, created_at, id)', t || '_mission_created_idx', t);
    execute format('create index if not exists %I on public.%I (status, created_at, id)', t || '_status_created_idx', t);
  end loop;
end $$;
