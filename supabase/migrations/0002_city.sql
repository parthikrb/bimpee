-- Bimpee City: per-game memory, city saves and the landmark model cache.
--
-- Same access model as 0001: the worker uses the service-role key (bypasses
-- RLS). RLS is enabled everywhere so that a leaked anon key / user JWT can at
-- most read the caller's own rows; clients never write directly.

-- ---------------------------------------------------------------------------
-- game_memory: one JSON document per (player, game).
--   game = 'city'      -> CityMemorySchema (packages/shared/src/city/memory.ts)
--   game = 'city_meta' -> worker bookkeeping: reported city ids, recent
--                         climates, landmark generation quota
-- ---------------------------------------------------------------------------
create table if not exists public.game_memory (
  user_id uuid not null references auth.users (id) on delete cascade,
  game text not null check (char_length(game) between 1 and 32),
  memory jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, game)
);

alter table public.game_memory enable row level security;

create policy "game_memory: read own" on public.game_memory
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- city_saves: up to 10 saved cities per player (body = CitySaveBodySchema)
-- ---------------------------------------------------------------------------
create table if not exists public.city_saves (
  id text not null check (id ~ '^[a-z0-9-]{3,64}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  city_name text not null default '' check (char_length(city_name) <= 60),
  day int not null default 0 check (day >= 0),
  population int not null default 0 check (population >= 0),
  body jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists city_saves_user_updated_idx on public.city_saves (user_id, updated_at desc);

alter table public.city_saves enable row level security;

create policy "city_saves: read own" on public.city_saves
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Hard cap of 10 saves per player, also under concurrent inserts (the worker
-- checks first and maps this error to HTTP 409).
create or replace function public.city_saves_enforce_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('city_saves:' || new.user_id::text));
  -- Upserts of an existing save (INSERT .. ON CONFLICT) also fire this trigger: allow them.
  if exists (select 1 from public.city_saves where user_id = new.user_id and id = new.id) then
    return new;
  end if;
  if (select count(*) from public.city_saves where user_id = new.user_id) >= 10 then
    raise exception 'city_saves_limit: at most 10 saves per player';
  end if;
  return new;
end;
$$;

drop trigger if exists city_saves_limit on public.city_saves;
create trigger city_saves_limit
  before insert on public.city_saves
  for each row execute function public.city_saves_enforce_limit();

-- ---------------------------------------------------------------------------
-- landmark_models: text-to-3D cache keyed by sha256(normalised prompt).
-- The GLB itself lives in R2 (r2_key). Shared across players and written only
-- by the worker: no policies, so anon/authenticated cannot read it at all.
-- ---------------------------------------------------------------------------
create table if not exists public.landmark_models (
  hash text primary key check (hash ~ '^[0-9a-f]{64}$'),
  prompt text not null check (char_length(prompt) <= 300),
  status text not null check (status in ('pending', 'ready', 'failed')),
  provider_job text,
  r2_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists landmark_models_created_idx on public.landmark_models (created_at desc);

alter table public.landmark_models enable row level security;

revoke all on public.landmark_models from anon, authenticated, public;
grant select, insert, update, delete on public.landmark_models to service_role;

-- Clients never write directly; the worker (service role) does.
revoke insert, update, delete on public.game_memory, public.city_saves from anon, authenticated;
