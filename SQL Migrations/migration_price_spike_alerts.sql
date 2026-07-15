-- migration_price_spike_alerts.sql
-- Server-side "your owned card spiked" push notifications.
--   1) an opt-in preference on profiles
--   2) a dedup ledger so a card that stays elevated doesn't re-push daily
--   3) the detector RPC (owned cards up >= X% over N days, for opted-in users)
-- Idempotent; safe to re-run.

-- 1) Opt-in preference. Default FALSE for v1 — we validate opt-in/engagement
--    before ever flipping the default on. A user must both grant push AND
--    toggle this on to receive spike alerts.
alter table public.profiles
  add column if not exists notify_price_spikes boolean not null default false;

-- 2) Dedup ledger — one row per (user, card) each time we notify.
create table if not exists public.price_spike_notifications (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  api_card_id   text not null,
  notified_pct  numeric,
  notified_at   timestamptz not null default now()
);
create index if not exists idx_spike_notif_user_card_at
  on public.price_spike_notifications (user_id, api_card_id, notified_at desc);

alter table public.price_spike_notifications enable row level security;
-- Users may read their own notification history; only the service role writes
-- (the cron uses the service key, which bypasses RLS).
drop policy if exists spike_notif_owner_read on public.price_spike_notifications;
create policy spike_notif_owner_read on public.price_spike_notifications
  for select using (auth.uid() = user_id);

-- 3) Detector RPC. For every owned (non-ghost, in-stock) catalog card held by
--    an opted-in user with a push token, compare the current catalog price to
--    the latest snapshot at/before (now - p_days_back). Returns cards up by at
--    least p_min_pct and worth at least p_min_value. The cron groups by user,
--    dedups, and sends one push each.
create or replace function public.get_owned_card_spikes(
  p_min_pct   numeric default 20,
  p_min_value numeric default 10,
  p_days_back int     default 1
)
returns table (
  user_id       uuid,
  api_card_id   text,
  card_name     text,
  current_value numeric,
  old_value     numeric,
  delta_pct     numeric
)
language sql
stable
as $$
  with owned as (
    select distinct ci.user_id, ci.api_card_id
    from public.collection_items ci
    join public.profiles p on p.id = ci.user_id
    where coalesce(ci.is_ghost, false) = false
      and coalesce(ci.quantity, 1) > 0
      and ci.api_card_id is not null
      and p.push_token is not null
      and coalesce(p.notify_price_spikes, false) = true
  ),
  priced as (
    select
      o.user_id,
      o.api_card_id,
      c.name          as card_name,
      c.current_value as cur,
      (select h.recorded_value
         from public.catalog_price_history h
        where h.catalog_id = o.api_card_id
          and h.recorded_at <= (now() - make_interval(days => p_days_back))
        order by h.recorded_at desc
        limit 1)      as old_val
    from owned o
    join public.catalog c on c.id = o.api_card_id
  )
  select
    user_id, api_card_id, card_name,
    cur     as current_value,
    old_val as old_value,
    round(((cur - old_val) / old_val) * 100, 1) as delta_pct
  from priced
  where old_val is not null and old_val > 0
    and cur >= p_min_value
    and ((cur - old_val) / old_val) * 100 >= p_min_pct
  order by user_id, delta_pct desc;
$$;

grant execute on function public.get_owned_card_spikes(numeric, numeric, int) to service_role;
