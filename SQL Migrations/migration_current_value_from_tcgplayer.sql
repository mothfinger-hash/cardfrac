-- ============================================================
-- PathBinder — reseat catalog.current_value onto TCGplayer prices
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- WHY
-- ---
-- current_value has been sourced from PriceCharting, whose per-card linkage
-- (catalog.pricecharting_id) is fuzzy-matched by (console-name, card-number)
-- because PriceCharting publishes no set code. That collides: ~33% of
-- pc-linked Pokemon rows (14,526) share ONE pricecharting_id with unrelated
-- same-numbered cards, so one product's price is smeared across dozens of
-- cards. Even among non-collided rows, ~15% diverge >=3x from TCGplayer.
-- Symptom: marketplace "Mkt" and the "+/- % vs market" badge show absurd
-- numbers (Squirtle +388%, a $71 promo Riolu reading $0.40).
--
-- TCGplayer is the authoritative anchor: card_prices rows with
-- source='tcgplayer' come from tcgcsv, which is TCGplayer's OWN product feed
-- keyed by (set, number) — no fuzzy matching, no cross-set collision. This
-- reseats current_value onto that price for every row that has one.
--
-- PAIRING: ship the pb-app.js change that stops using current_value as the
-- "PriceCharting" row value together with this (see _loadExtraPricesByCatalogId).
-- After the reseat, current_value IS the TCGplayer market; the PriceCharting
-- comp row now reads only from a real PriceCharting card_price.
--
-- SCOPE: every catalog row (all games) that has a usable source='tcgplayer'
-- card_price. Rows without one are left untouched — the audit/clear-bad +
-- strict re-link steps handle those separately. Idempotent, re-run safe.
-- ============================================================

-- ── DRY RUN (run this block ALONE first — writes nothing) ──────────────────
-- How many rows would change, and the biggest corrections:
--
--   WITH latest AS (
--     SELECT DISTINCT ON (catalog_id) catalog_id, value
--     FROM public.card_prices
--     WHERE source = 'tcgplayer' AND value IS NOT NULL AND value > 0
--     ORDER BY catalog_id, recorded_at DESC NULLS LAST
--   )
--   SELECT count(*) AS rows_that_would_change
--   FROM public.catalog c JOIN latest l ON l.catalog_id = c.id
--   WHERE c.current_value IS DISTINCT FROM l.value;
--
--   WITH latest AS (
--     SELECT DISTINCT ON (catalog_id) catalog_id, value
--     FROM public.card_prices
--     WHERE source = 'tcgplayer' AND value IS NOT NULL AND value > 0
--     ORDER BY catalog_id, recorded_at DESC NULLS LAST
--   )
--   SELECT c.id, c.name, c.set_code, c.current_value AS old_pc, l.value AS new_tcg
--   FROM public.catalog c JOIN latest l ON l.catalog_id = c.id
--   WHERE c.current_value IS DISTINCT FROM l.value
--   ORDER BY abs(coalesce(c.current_value,0) - l.value) DESC
--   LIMIT 40;

-- ── APPLY ──────────────────────────────────────────────────────────────────
-- If this TIMED OUT: the cost was the DISTINCT ON sorting all ~150k+ TCGplayer
-- price rows plus the wide UPDATE. The partial index below turns "latest price
-- per card" into an index scan (no full sort), and the raised statement_timeout
-- covers the one-time bulk write. Run this whole block in ONE SQL-editor
-- execution so `SET` applies to the UPDATE. The index is permanent and also
-- speeds the nightly refresh + future reseats.

SET statement_timeout = '900s';

CREATE INDEX IF NOT EXISTS card_prices_tcg_catalog_recorded
  ON public.card_prices (catalog_id, recorded_at DESC)
  WHERE source = 'tcgplayer';
ANALYZE public.card_prices;

WITH latest AS (
  SELECT DISTINCT ON (catalog_id) catalog_id, value
  FROM public.card_prices
  WHERE source = 'tcgplayer' AND value IS NOT NULL AND value > 0
  ORDER BY catalog_id, recorded_at DESC NULLS LAST
)
UPDATE public.catalog c
SET current_value           = latest.value,
    market_price_source     = 'tcgplayer',
    market_price_updated_at  = now()
FROM latest
WHERE latest.catalog_id = c.id
  AND (c.current_value IS DISTINCT FROM latest.value
       OR c.market_price_source IS DISTINCT FROM 'tcgplayer');  -- also stamp source-only rows

-- ── "Failed to fetch" / gateway drop on the big UPDATE? Use the batch FUNCTION ─
-- The browser<->Supabase request drops on any long query (independent of
-- statement_timeout, which you can't raise past the gateway cap). So do the
-- reseat in short, self-committing batches. This function reseats up to p_limit
-- rows in ONE fast statement and returns how many it changed.
--
-- Run the CREATE INDEX above once, then EITHER:
--   • In the SQL editor: run  SELECT public.reseat_tcgplayer_batch();  REPEATEDLY
--     until it returns 0 (each call is a short request that won't time out), OR
--   • Fully automated (no clicking): python3 reseat_tcgplayer.py   (loops the RPC).

CREATE OR REPLACE FUNCTION public.reseat_tcgplayer_batch(p_limit int DEFAULT 20000)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE n integer;
BEGIN
  SET LOCAL statement_timeout = '120s';
  WITH latest AS (
    SELECT DISTINCT ON (catalog_id) catalog_id, value
    FROM public.card_prices
    WHERE source = 'tcgplayer' AND value IS NOT NULL AND value > 0
    ORDER BY catalog_id, recorded_at DESC NULLS LAST
  ),
  todo AS (
    SELECT c.id, latest.value
    FROM public.catalog c JOIN latest ON latest.catalog_id = c.id
    WHERE c.current_value IS DISTINCT FROM latest.value
       OR c.market_price_source IS DISTINCT FROM 'tcgplayer'
    LIMIT p_limit
  )
  UPDATE public.catalog c
  SET current_value = todo.value,
      market_price_source = 'tcgplayer',
      market_price_updated_at = now()
  FROM todo WHERE c.id = todo.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;   -- PostgREST/each SELECT commits this batch on return
END $$;

GRANT EXECUTE ON FUNCTION public.reseat_tcgplayer_batch(int) TO service_role;

-- Editor path (repeat until it returns 0):
--   SELECT public.reseat_tcgplayer_batch();

-- ── Daily TCGplayer HISTORY snapshot ─────────────────────────────────────────
-- The marketplace price-history chart now prefers source='tcgplayer' for spine
-- cards (their PriceCharting history is the wrong number — a $71 card charted as
-- a flat $0.40). This builds that TCG series: one snapshot per spine card per
-- day, from current_value (which the reseat keeps = the TCGplayer price).
-- Batched like the reseat so the gateway can't time it out; idempotent per day.
-- reseat_tcgplayer.py calls this right after the reseat, and it should run daily
-- (add to the sync-tcgplayer-prices workflow) so the chart fills in over time.
CREATE OR REPLACE FUNCTION public.snapshot_tcgplayer_history_batch(p_limit int DEFAULT 20000)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE n integer;
BEGIN
  SET LOCAL statement_timeout = '120s';
  WITH todo AS (
    SELECT c.id, c.current_value, c.game_type, c.set_code
    FROM public.catalog c
    WHERE c.market_price_source = 'tcgplayer'
      AND c.current_value IS NOT NULL AND c.current_value > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.catalog_price_history h
        WHERE h.catalog_id = c.id AND h.recorded_at = CURRENT_DATE AND h.source = 'tcgplayer'
      )
    LIMIT p_limit
  )
  INSERT INTO public.catalog_price_history (catalog_id, recorded_value, recorded_at, source, game_type, set_code)
  SELECT id, current_value, CURRENT_DATE, 'tcgplayer', game_type, set_code FROM todo
  ON CONFLICT (catalog_id, recorded_at)
    DO UPDATE SET recorded_value = EXCLUDED.recorded_value, source = 'tcgplayer';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION public.snapshot_tcgplayer_history_batch(int) TO service_role;

-- Editor path (repeat until it returns 0):
--   SELECT public.snapshot_tcgplayer_history_batch();

-- Verify:
--   SELECT market_price_source, count(*) FROM catalog
--    WHERE market_price_source IS NOT NULL GROUP BY 1;
--   -- 'tcgplayer' row count == the dry-run rows_that_would_change (first run).
--   After this + a page reload: the marketplace Mkt and "+/- % vs market"
--   badge match TCGplayer for every card that has a TCGplayer price.
-- ============================================================
