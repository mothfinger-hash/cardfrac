-- ============================================================
-- PathBinder — Catalog Price History Migration
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Stores a daily snapshot of catalog.current_value per catalog row.
-- Populated by refresh_catalog_prices.py running at ~3am via cron
-- (launchd / crontab / GitHub Actions / Vercel cron). Front-end queries
-- this table for the dashboard Price Movers panel (global movers
-- across the whole catalog, not just the user's collection).
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.catalog_price_history (
  id              BIGSERIAL PRIMARY KEY,
  catalog_id      TEXT        NOT NULL REFERENCES public.catalog(id) ON DELETE CASCADE,
  recorded_value  NUMERIC(10,2) NOT NULL,
  recorded_at     DATE        NOT NULL DEFAULT CURRENT_DATE,
  source          TEXT        DEFAULT 'pricecharting',
  -- Optional context for future filtering / charting
  game_type       TEXT,
  set_code        TEXT,
  UNIQUE (catalog_id, recorded_at)
);

COMMENT ON TABLE public.catalog_price_history IS
  'Per-day catalog snapshots populated by refresh_catalog_prices.py. Used by dashboard Price Movers to surface global market moves across a TCG.';

-- Fast lookups for the trailing-window query the front-end makes
CREATE INDEX IF NOT EXISTS idx_cph_catalog_id
  ON public.catalog_price_history (catalog_id);
CREATE INDEX IF NOT EXISTS idx_cph_recorded_at
  ON public.catalog_price_history (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_cph_game_type_recorded_at
  ON public.catalog_price_history (game_type, recorded_at DESC)
  WHERE game_type IS NOT NULL;

-- Read access for the front-end (RLS — anyone authenticated can read,
-- only service-role can write).
ALTER TABLE public.catalog_price_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone authenticated can read catalog_price_history" ON public.catalog_price_history;
CREATE POLICY "Anyone authenticated can read catalog_price_history"
  ON public.catalog_price_history
  FOR SELECT
  TO authenticated, anon
  USING (true);

-- ============================================================
-- Verify after running:
--   select count(*) from catalog_price_history;
--   select recorded_at, count(*) from catalog_price_history
--     group by recorded_at order by recorded_at desc limit 7;
-- ============================================================
