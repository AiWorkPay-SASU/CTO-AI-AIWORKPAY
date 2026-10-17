create table if not exists public.cto_missions(id uuid primary key,project text not null,objective text not null,status text not null,payload jsonb not null,created_at timestamptz not null default now());
create table if not exists public.cto_reports(id bigint generated always as identity primary key,mission_id uuid not null references public.cto_missions(id),role text not null,status text not null,summary text not null,evidence jsonb not null default '[]'::jsonb,created_at timestamptz not null default now());
create index if not exists cto_reports_mission_idx on public.cto_reports(mission_id);
alter table public.cto_missions enable row level security;
alter table public.cto_reports enable row level security;
