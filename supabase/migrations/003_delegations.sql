-- Human delegations (AIWORKPAY MCP integration). WRITTEN, NOT APPLIED: applying it to any project needs the owner's authorization.
-- Same generic row shape and access model as 001_init.sql: RLS enabled and forced, no policy, no grants to anon/authenticated;
-- only the server (service_role) reads or writes. `mission_id` is optional (a delegation may exist without a CTO mission).
create table if not exists public.cto_delegations (
  id uuid primary key,
  mission_id uuid references public.cto_missions(id),
  status text,
  data jsonb not null,
  rev integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cto_delegations_mission_idx on public.cto_delegations (mission_id);
create index if not exists cto_delegations_status_idx on public.cto_delegations (status);
alter table public.cto_delegations enable row level security;
alter table public.cto_delegations force row level security;
revoke all on public.cto_delegations from public, anon, authenticated;
