-- ============================================================
-- PathBinder — Multi-source card_prices table
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Why this exists
-- ---------------
-- Catalog already stores a single `current_value` from PriceCharting.
-- Adding TCGplayer (or any future source — CardKingdom, eBay last-sold,
-- etc.) as a second column would mean a schema change every time a
-- new source comes online. A separate prices table keyed by
-- (catalog_id, source) lets us register new sources without DDL.
--
-- The app's existing `catalog.current_value` stays unchanged; it
-- remains the "primary" displayed value. card_prices is additive —
-- if a card has a row here for source='tcgplayer', the detail panel
-- shows it as a secondary comp.
--
-- Source values are normalized lowercase identifiers:
--   'pricecharting' — from PC bulk CSV refresh (mirrors current_value)
--   'tcgplayer'     — TCGplayer market price (via partner API or via
--                     intermediaries like pokemontcg.io / Scryfall /
--                     YGOPRODeck which expose TCGplayer prices)
--   'cardmarket'    — Cardmarket / MKM (reserved for future EU pull)
--   'cardkingdom'   — Card Kingdom retail (reserved for future)

CREATE TABLE IF NOT EXISTS public.card_prices (
  -- Composite primary key — one row per (card, source). Latest write
  -- wins for that source.
  catalog_id    text NOT NULL REFERENCES public.catalog(id) ON DELETE CASCADE,
  source        text NOT NULL CHECK (source IN ('pricecharting','tcgplayer','cardmarket','cardkingdom')),
  -- The headline price. We always store the "market" / "fair" value
  -- the source publishes — not low, not high. UI compares these
  -- like-for-like.
  value         numeric(10,2) NOT NULL,
  currency      text NOT NULL DEFAULT 'USD',
  -- Optional metadata. sample_size is how many recent sales the
  -- source averaged to get the value (when available — pokemontcg.io
  -- doesn't ship this, Scryfall doesn't either, but TCGplayer's
  -- direct API does for some products).
  sample_size   int,
  -- Source-specific URL we can link the user to so they can verify.
  source_url    text,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (catalog_id, source)
);

-- Idle index for "show me all sources for this card" lookups. The
-- primary key covers (catalog_id, source) lookups; this one supports
-- the reverse: "which source has the most recent data?"
CREATE INDEX IF NOT EXISTS idx_card_prices_recorded
  ON public.card_prices (source, recorded_at DESC);

-- Public read so the app can display prices without auth. Writes
-- happen only via the service-role key from the daily sync scripts,
-- so no insert/update policy is needed.
ALTER TABLE public.card_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "card_prices_public_read" ON public.card_prices;
CREATE POLICY "card_prices_public_read"
  ON public.card_prices
  FOR SELECT
  USING (true);

-- ── History table (parallel to catalog_price_history) ─────────────
-- Optional snapshots for future dashboard widgets ("TCGplayer 30-day
-- chart"). Not used by the v1 sync — we just overwrite card_prices —
-- but the schema is here for the day we want timeseries per source.
CREATE TABLE IF NOT EXISTS public.card_prices_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id    text NOT NULL REFERENCES public.catalog(id) ON DELETE CASCADE,
  source        text NOT NULL,
  value         numeric(10,2) NOT NULL,
  currency      text NOT NULL DEFAULT 'USD',
  recorded_at   date NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE (catalog_id, source, recorded_at)
);
CREATE INDEX IF NOT EXISTS idx_card_prices_history_recorded
  ON public.card_prices_history (recorded_at DESC, catalog_id);

ALTER TABLE public.card_prices_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "card_prices_history_public_read" ON public.card_prices_history;
CREATE POLICY "card_prices_history_public_read"
  ON public.card_prices_history
  FOR SELECT
  USING (true);

COMMENT ON TABLE public.card_prices IS
  'Multi-source current price per catalog row. One row per (catalog_id, source). Read by the card detail UI to show side-by-side comps.';
COMMENT ON TABLE public.card_prices_history IS
  'Daily snapshots of card_prices for future timeseries charts. Not populated by v1 sync; reserved for future use.';
