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
-- Safe to run this whole file in one SQL-editor execution: it's all fast DDL
-- (indexes + CREATE OR REPLACE functions). The actual reseat is NOT done here —
-- a one-shot UPDATE of ~150k rows gateway-drops ("Failed to fetch") — it's done
-- by the keyset RPC below via `python3 reseat_tcgplayer.py`, which cannot time
-- out. The partial index makes both the RPC's slice scan and the nightly refresh
-- fast.

CREATE INDEX IF NOT EXISTS card_prices_tcg_catalog_recorded
  ON public.card_prices (catalog_id, recorded_at DESC)
  WHERE source = 'tcgplayer';
ANALYZE public.card_prices;

-- ── Reseat via the batch FUNCTION (keyset — cannot time out) ─────────────────
-- The browser<->Supabase request drops on any long query, and the DB
-- statement_timeout (~8s) can't be raised from inside the call. So the reseat
-- runs in short, self-committing, keyset-paginated batches. Each call scans/
-- updates only its slice and returns (processed, updated, last_id).
--
-- After the CREATE FUNCTION below, run:  python3 reseat_tcgplayer.py
-- (or loop it by hand in the editor, feeding last_id back as p_after).

-- KEYSET-PAGINATED so each call does BOUNDED work: it scans only the next
-- p_limit card_prices rows (an index range scan on catalog_id) and updates the
-- drifted ones among them — never the whole 166k-row DISTINCT-ON + drift join.
-- The OLD version rebuilt that full join every call and blew past the ~8s
-- statement_timeout (57014) once drift grew; a function-local SET
-- statement_timeout does NOT help (the timer is armed at statement start and is
-- never re-armed mid-call). card_prices holds exactly ONE tcgplayer row per
-- catalog_id (upsert-merged on (catalog_id, source)), so no DISTINCT ON is
-- needed. The client loops passing back last_id until processed < p_limit.
DROP FUNCTION IF EXISTS public.reseat_tcgplayer_batch(int);
CREATE OR REPLACE FUNCTION public.reseat_tcgplayer_batch(
  p_after text DEFAULT '', p_limit int DEFAULT 10000)
RETURNS TABLE (processed int, updated int, last_id text)
LANGUAGE plpgsql
AS $$
DECLARE v_processed int; v_last text; v_updated int;
BEGIN
  -- Slice = the next p_limit tcgplayer prices by catalog_id (index range scan).
  -- Read its size + cursor first, then apply. Both touch only the slice.
  SELECT count(*)::int, max(catalog_id) INTO v_processed, v_last
  FROM (
    SELECT cp.catalog_id
    FROM public.card_prices cp
    WHERE cp.source = 'tcgplayer' AND cp.value > 0 AND cp.catalog_id > p_after
    ORDER BY cp.catalog_id
    LIMIT p_limit
  ) q;

  WITH slice AS (
    SELECT cp.catalog_id, cp.value
    FROM public.card_prices cp
    WHERE cp.source = 'tcgplayer' AND cp.value > 0 AND cp.catalog_id > p_after
    ORDER BY cp.catalog_id
    LIMIT p_limit
  )
  UPDATE public.catalog c
  SET current_value = slice.value,
      market_price_source = 'tcgplayer',
      market_price_updated_at = now()
  FROM slice
  WHERE c.id = slice.catalog_id
    AND (c.current_value IS DISTINCT FROM slice.value
         OR c.market_price_source IS DISTINCT FROM 'tcgplayer');
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN QUERY SELECT v_processed, v_updated, v_last;
END $$;

GRANT EXECUTE ON FUNCTION public.reseat_tcgplayer_batch(text, int) TO service_role;

-- Editor path (repeat, feeding last_id back as p_after, until processed = 0):
--   SELECT * FROM public.reseat_tcgplayer_batch('', 10000);

-- ── Daily TCGplayer HISTORY snapshot ─────────────────────────────────────────
-- The marketplace price-history chart now prefers source='tcgplayer' for spine
-- cards (their PriceCharting history is the wrong number — a $71 card charted as
-- a flat $0.40). This builds that TCG series: one snapshot per spine card per
-- day, from current_value (which the reseat keeps = the TCGplayer price).
-- Batched like the reseat so the gateway can't time it out; idempotent per day.
-- reseat_tcgplayer.py calls this right after the reseat, and it should run daily
-- (add to the sync-tcgplayer-prices workflow) so the chart fills in over time.
-- KEYSET-PAGINATED like the reseat. Drops the per-row NOT EXISTS (which made
-- every call re-scan history and was part of the timeout risk): ON CONFLICT
-- already makes the day idempotent, so we just walk spine catalog rows by id and
-- upsert today's snapshot. The partial index below keeps the walk a range scan.
DROP FUNCTION IF EXISTS public.snapshot_tcgplayer_history_batch(int);
CREATE OR REPLACE FUNCTION public.snapshot_tcgplayer_history_batch(
  p_after text DEFAULT '', p_limit int DEFAULT 10000)
RETURNS TABLE (processed int, inserted int, last_id text)
LANGUAGE plpgsql
AS $$
DECLARE v_processed int; v_last text; v_inserted int;
BEGIN
  SELECT count(*)::int, max(id) INTO v_processed, v_last
  FROM (
    SELECT c.id
    FROM public.catalog c
    WHERE c.market_price_source = 'tcgplayer' AND c.current_value > 0 AND c.id > p_after
    ORDER BY c.id
    LIMIT p_limit
  ) q;

  WITH slice AS (
    SELECT c.id, c.current_value, c.game_type, c.set_code
    FROM public.catalog c
    WHERE c.market_price_source = 'tcgplayer' AND c.current_value > 0 AND c.id > p_after
    ORDER BY c.id
    LIMIT p_limit
  )
  INSERT INTO public.catalog_price_history (catalog_id, recorded_value, recorded_at, source, game_type, set_code)
  SELECT id, current_value, CURRENT_DATE, 'tcgplayer', game_type, set_code FROM slice
  ON CONFLICT (catalog_id, recorded_at)
    DO UPDATE SET recorded_value = EXCLUDED.recorded_value, source = 'tcgplayer';
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN QUERY SELECT v_processed, v_inserted, v_last;
END $$;

GRANT EXECUTE ON FUNCTION public.snapshot_tcgplayer_history_batch(text, int) TO service_role;

-- Keeps the snapshot walk (spine rows by id) an index range scan.
CREATE INDEX IF NOT EXISTS catalog_tcgplayer_spine_id
  ON public.catalog (id)
  WHERE market_price_source = 'tcgplayer' AND current_value > 0;

-- NOTE: the batched RPCs no longer depend on a raised statement_timeout — the
-- keyset rewrite makes each call scan/update only p_limit rows, so a batch
-- finishes well under Supabase's ~8s service_role default. (A function-local or
-- role-level timeout bump is NOT needed and, for the function-local case, does
-- not even work: the timer is armed at statement start and never re-armed.)

-- Editor path (repeat, feeding last_id back as p_after, until processed = 0):
--   SELECT * FROM public.snapshot_tcgplayer_history_batch('', 10000);

-- Verify:
--   SELECT market_price_source, count(*) FROM catalog
--    WHERE market_price_source IS NOT NULL GROUP BY 1;
--   -- 'tcgplayer' row count == the dry-run rows_that_would_change (first run).
--   After this + a page reload: the marketplace Mkt and "+/- % vs market"
--   badge match TCGplayer for every card that has a TCGplayer price.
-- ============================================================
