-- ============================================================
-- PathBinder — Discord bot Phase 2 schema
-- Run AFTER migration_discord_bot.sql.
--
-- Two additions:
--   • profiles.leaderboard_optin — bool, default false. /leaderboard
--     only surfaces users who flipped this on (privacy-first default).
--   • price_alerts — per-(user, catalog_id) subscription. /track creates
--     a row; a separate scheduled job (price_alert_dispatcher.py, not
--     written yet) compares catalog.current_value against the row's
--     threshold and DMs the user via the bot when crossed.
-- ============================================================


-- ─── profiles.leaderboard_optin ─────────────────────────────
alter table public.profiles
  add column if not exists leaderboard_optin boolean default false not null;

-- Index helps the /leaderboard query enumerate opt-ins without a full
-- table scan as the user base grows.
create index if not exists profiles_leaderboard_optin_idx
  on public.profiles (leaderboard_optin)
  where leaderboard_optin = true;


-- ─── price_alerts ───────────────────────────────────────────
-- One row per (user, catalog card, direction). direction='above' fires
-- when price rises through threshold; 'below' fires when it drops
-- through. last_notified_at + cooldown_until prevent re-fire spam if
-- the price hovers around the threshold.
create table if not exists public.price_alerts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  catalog_id        text not null references public.catalog(id) on delete cascade,
  threshold         numeric(10,2) not null,
  direction         text not null default 'above'
                       check (direction in ('above', 'below')),
  last_notified_at  timestamptz,
  cooldown_until    timestamptz,
  created_at        timestamptz not null default now(),
  unique (user_id, catalog_id, direction)
);

create index if not exists price_alerts_user_idx
  on public.price_alerts (user_id);
create index if not exists price_alerts_catalog_idx
  on public.price_alerts (catalog_id);

-- RLS — users see + manage their own alerts. The bot uses service
-- key so RLS doesn't apply to its writes.
alter table public.price_alerts enable row level security;
drop policy if exists price_alerts_own_all on public.price_alerts;
create policy price_alerts_own_all on public.price_alerts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
