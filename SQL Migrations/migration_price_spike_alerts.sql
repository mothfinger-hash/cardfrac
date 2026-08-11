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
--    least p_min_pct, worth at least p_min_value, and (when p_max_pct is set)
--    up by NO MORE than p_max_pct. The cron groups by user, dedups, sends one
--    push each.
--
-- SOURCE-CONSISTENCY (critical): current_value and catalog_price_history can be
-- fed by DIFFERENT price sources. After the TCGplayer-spine reseat, ~162k rows'
-- current_value is a TCGplayer price while their only recent history points are
-- PriceCharting ('pricecharting*'). Comparing a TCG current against a stale /
-- collided PC baseline fabricates enormous fake spikes (a $0.40 PC point vs a
-- $399 TCG value = +99,000%), which re-fire daily because the frozen PC point
-- is always >= 1 day old and never ages out. So a card on the TCGplayer spine
-- MUST baseline only against source='tcgplayer' history; non-spine cards keep
-- using whatever (PriceCharting) history they have. Mirrors the app's chart
-- read path, which filters source='tcgplayer' for market_price_source='tcgplayer'.
--
-- p_max_pct is an optional sanity ceiling: even within one source a bad/collided
-- link can jump wildly day-over-day; a physically-implausible 24h move (e.g.
-- > 500%) is almost always a data artifact, not a real spike, and a push is too
-- intrusive to fire on it. NULL = no ceiling.
drop function if exists public.get_owned_card_spikes(numeric, numeric, int);
create or replace function public.get_owned_card_spikes(
  p_min_pct   numeric default 20,
  p_min_value numeric default 10,
  p_days_back int     default 1,
  p_max_pct   numeric default null
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
          -- Baseline against the SAME source as current_value: TCGplayer-spine
          -- rows only see source='tcgplayer' history; everything else (NULL /
          -- pricecharting market_price_source) sees any history it has.
          and (c.market_price_source is distinct from 'tcgplayer'
               or h.source = 'tcgplayer')
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
    and (p_max_pct is null or ((cur - old_val) / old_val) * 100 <= p_max_pct)
  order by user_id, delta_pct desc;
$$;

grant execute on function public.get_owned_card_spikes(numeric, numeric, int, numeric) to service_role;
