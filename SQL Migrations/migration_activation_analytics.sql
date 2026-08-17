-- migration_activation_analytics.sql
-- Activation funnel instrumentation.
--   1) user_events — a lightweight, insert-only event log for actions that
--      aren't otherwise a row (scanner opened, share card generated, etc.).
--   2) activation_funnel() — the drop-off funnel, computed mostly from data
--      you ALREADY have (profiles / collection_items / listings), so it works
--      retroactively on your current users the moment you run it.
-- Idempotent; safe to re-run. Mirrors the marketplace_searches telemetry pattern.

-- 1) Event log ---------------------------------------------------------------
create table if not exists public.user_events (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.profiles(id) on delete set null,
  event       text not null,
  meta        jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_user_events_event_created
  on public.user_events (event, created_at desc);
create index if not exists idx_user_events_user_created
  on public.user_events (user_id, created_at desc);

alter table public.user_events enable row level security;
-- Clients may insert their OWN events (or anon events); nobody reads via the
-- API — the funnel RPC (security definer) is the only read path.
drop policy if exists "insert own events" on public.user_events;
create policy "insert own events" on public.user_events
  for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

-- 2) Funnel RPC --------------------------------------------------------------
-- Returns ordered milestones. Card milestones come straight from
-- collection_items (owned, non-ghost) so historical users are counted without
-- any client changes. shared_card / scanner come from user_events once the
-- client starts firing them.
create or replace function public.activation_funnel()
returns table (step text, users bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Aggregate-only (no PII), but still gate authenticated callers to admins.
  -- auth.uid() is NULL in the SQL editor (runs as postgres) — allow that path.
  if auth.uid() is not null
     and not exists (select 1 from public.profiles p
                     where p.id = auth.uid() and coalesce(p.is_admin, false)) then
    raise exception 'admin only';
  end if;

  return query
  with cards as (
    select user_id, count(*) as n
    from public.collection_items
    where coalesce(is_ghost, false) = false
    group by user_id
  )
  select '1_signups'::text,        (select count(*)::bigint from public.profiles)
  union all
  select '2_added_1_card',         (select count(*)::bigint from cards where n >= 1)
  union all
  select '3_added_10_cards',       (select count(*)::bigint from cards where n >= 10)
  union all
  select '4_added_25_cards',       (select count(*)::bigint from cards where n >= 25)
  union all
  select '5_shared_card',          (select count(distinct user_id)::bigint from public.user_events where event = 'share_card')
  union all
  select '6_created_listing',      (select count(distinct seller_id)::bigint from public.listings);
end $$;

grant execute on function public.activation_funnel() to authenticated, service_role;

-- View the funnel any time (SQL editor):
--   select * from public.activation_funnel();
--   -> 1_signups 10 / 2_added_1_card 4 / 3_added_10_cards 1 / ... — where they drop.
