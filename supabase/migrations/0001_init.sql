-- Bimpee: player memory, run history and leaderboard.
--
-- Access model: the Cloudflare worker talks to these tables with the
-- service-role key (which bypasses RLS). RLS is still enabled everywhere so
-- that a leaked anon key / user JWT can at most read the caller's own rows.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Wanderer' check (char_length(display_name) between 1 and 24),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

-- Create a profile row for every new auth user (anonymous sign-ins included).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 'Wanderer'), 24)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- player_memory: one JSON document per player (shape: PlayerMemorySchema)
-- ---------------------------------------------------------------------------
create table if not exists public.player_memory (
  user_id uuid primary key references auth.users (id) on delete cascade,
  memory jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.player_memory enable row level security;

create policy "player_memory: read own" on public.player_memory
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- run_summaries: one row per finished run (also the leaderboard source)
-- ---------------------------------------------------------------------------
create table if not exists public.run_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  run_id text not null,
  world_name text not null,
  biome text not null,
  world_seed bigint not null,
  outcome text not null check (outcome in ('victory', 'death', 'quit')),
  score int not null check (score >= 0),
  kills int not null default 0 check (kills >= 0),
  duration_sec real not null default 0,
  summary text not null default '',
  highlights jsonb not null default '[]'::jsonb,
  report jsonb not null,
  created_at timestamptz not null default now(),
  -- A run can only be reported once per player.
  unique (user_id, run_id)
);

create index if not exists run_summaries_user_created_idx on public.run_summaries (user_id, created_at desc);
create index if not exists run_summaries_score_idx on public.run_summaries (score desc);
create index if not exists run_summaries_created_score_idx on public.run_summaries (created_at desc, score desc);

alter table public.run_summaries enable row level security;

create policy "run_summaries: read own" on public.run_summaries
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- leaderboard: public-safe columns only. Served through the worker
-- (service role); not exposed to anon/authenticated via PostgREST.
-- security_invoker makes the view respect the caller's RLS, so even if a
-- grant were added later it would not leak other players' rows.
-- ---------------------------------------------------------------------------
create or replace view public.leaderboard
with (security_invoker = true) as
select
  coalesce(p.display_name, 'Wanderer') as display_name,
  r.score,
  r.world_name,
  r.outcome,
  r.created_at
from public.run_summaries r
left join public.profiles p on p.id = r.user_id;

revoke all on public.leaderboard from anon, authenticated, public;
grant select on public.leaderboard to service_role;

-- Clients never write directly; the worker (service role) does.
revoke insert, update, delete on public.profiles, public.player_memory, public.run_summaries from anon, authenticated;

-- ---------------------------------------------------------------------------
-- TODO (deferred): semantic recall over past runs with pgvector.
-- Intentionally not enabled yet: no embedding provider has been chosen.
-- Sketch:
--
--   create extension if not exists vector with schema extensions;
--   alter table public.run_summaries add column embedding extensions.vector(1024);
--   create index on public.run_summaries using hnsw (embedding extensions.vector_cosine_ops);
--   create or replace function public.match_runs(p_user uuid, p_query extensions.vector(1024), p_limit int default 5)
--   returns setof public.run_summaries language sql stable as $$
--     select * from public.run_summaries
--     where user_id = p_user and embedding is not null
--     order by embedding <=> p_query limit p_limit;
--   $$;
-- ---------------------------------------------------------------------------
