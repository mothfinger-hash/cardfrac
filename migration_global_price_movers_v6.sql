-- ============================================================
-- PathBinder — Global Price Movers RPC (v6)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- v6 changes — PERFORMANCE FIX:
--   The v5 CTE scanned EVERY catalog_id with price history in the
--   time window, then filtered by game_type later. As
--   catalog_price_history grew (every priced row × every day), this
--   went from ~2s when the bot launched to >60s today, blowing past
--   the Vercel function maxDuration and leaving Discord stuck on
--   "thinking…" forever.
--
--   v6 pushes the game_type filter (and the product_type filter)
--   INTO the CTE so the price-history scan only touches rows for
--   the requested game from the start. Working-set goes from
--   "everything" to "~1/6th of catalog" with a single index hit.
--
--   Also adds two supporting indexes:
--     idx_catalog_price_history_catalog_recorded  — already exists
--       in most deployments but re-created with IF NOT EXISTS to be safe
--     idx_catalog_game_type_with_value            — catalog scan
--       constrained to a single game with non-null current_value
--
--   Expected impact: 30s → <2s for /movers RPC, regardless of how
--   large catalog_price_history grows.
--
-- Idempotent — safe to re-run. Drops the prior function signature
-- and recreates indexes with IF NOT EXISTS.
-- ============================================================

-- Supporting indexes -------------------------------------------------
-- Composite index on (catalog_id, recorded_at) lets the planner
-- choose an index-scan + skip-scan pattern instead of a sequential
-- scan when the CTE filters by recorded_at + ORDER BY catalog_id.
CREATE INDEX IF NOT EXISTS idx_catalog_price_history_catalog_recorded
  ON public.catalog_price_history (catalog_id, recorded_at);

-- Partial index on catalog scoped by game_type with a current_value.
-- Without this, the join in the new CTE still has to scan every
-- catalog row matching the game_type, including unpriced ones.
CREATE INDEX IF NOT EXISTS idx_catalog_game_type_priced
  ON public.catalog (game_type, id)
  WHERE current_value IS NOT NULL;

-- Drop prior signatures so the new one takes effect cleanly --------
DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_global_price_movers(
  p_game_type    TEXT    DEFAULT 'pokemon',
  p_days_back    INT     DEFAULT 1,
  p_top_n        INT     DEFAULT 10,
  p_min_pct      NUMERIC DEFAULT 0.5,
  p_sort         TEXT    DEFAULT 'pct',     -- 'pct' or 'dollar'
  p_product_type TEXT    DEFAULT 'single'   -- 'single' | 'sealed' | 'all'
)
RETURNS TABLE (
  catalog_id    TEXT,
  name          TEXT,
  set_name      TEXT,
  image_url     TEXT,
  old_value     NUMERIC,
  current_value NUMERIC,
  delta         NUMERIC,
  delta_pct     NUMERIC,
  direction     TEXT
) LANGUAGE SQL STABLE SECURITY INVOKER AS $$
  WITH eligible_catalog AS (
    -- Pre-filter catalog FIRST. This is the table that's small and
    -- already indexed by game_type. We want price_history to only
    -- look at history rows belonging to ids in this short list.
    SELECT
      c.id,
      c.name,
      c.set_name,
      c.image_url,
      c.current_value,
      COALESCE(c.product_type, 'single') AS ptype
    FROM catalog c
    WHERE c.game_type      = p_game_type
      AND c.current_value IS NOT NULL
      AND (
        p_product_type = 'all'
        OR (p_product_type = 'single' AND COALESCE(c.product_type, 'single') = 'single')
        OR (p_product_type = 'sealed' AND COALESCE(c.product_type, 'single') <> 'single')
      )
  ),
  oldest_per_card AS (
    -- Now scan price_history for ONLY the catalog ids that survived
    -- the game_type + product_type filter. Working-set size went
    -- from "every priced catalog row" to "every priced row in this
    -- one game". For a 6-game catalog, that's a ~6× reduction at
    -- the worst, and the partial index on catalog turns the JOIN
    -- into a clean index lookup.
    SELECT DISTINCT ON (h.catalog_id)
      h.catalog_id,
      h.recorded_value AS old_value
    FROM catalog_price_history h
    INNER JOIN eligible_catalog ec ON ec.id = h.catalog_id
    WHERE h.recorded_at >= CURRENT_DATE - p_days_back
      AND h.recorded_at <  CURRENT_DATE
    ORDER BY h.catalog_id, h.recorded_at ASC
  ),
  moves AS (
    SELECT
      ec.id   AS catalog_id,
      ec.name,
      ec.set_name,
      ec.image_url,
      o.old_value,
      ec.current_value,
      (ec.current_value - o.old_value)::NUMERIC                                       AS delta,
      ROUND(((ec.current_value - o.old_value) / NULLIF(o.old_value, 0) * 100)::numeric, 2) AS delta_pct
    FROM oldest_per_card o
    JOIN eligible_catalog ec ON ec.id = o.catalog_id
    WHERE o.old_value IS NOT NULL
      AND ABS(ec.current_value - o.old_value) > 0.01
      AND ABS((ec.current_value - o.old_value) / NULLIF(o.old_value, 0) * 100) >= p_min_pct
  )
  (SELECT catalog_id, name, set_name, image_url, old_value, current_value,
          delta, delta_pct, 'up'::TEXT AS direction
   FROM moves
   WHERE delta > 0
   ORDER BY
     CASE WHEN p_sort = 'dollar' THEN ABS(delta)    ELSE NULL END DESC NULLS LAST,
     CASE WHEN p_sort = 'pct'    THEN ABS(delta_pct) ELSE NULL END DESC NULLS LAST
   LIMIT p_top_n)
  UNION ALL
  (SELECT catalog_id, name, set_name, image_url, old_value, current_value,
          delta, delta_pct, 'down'::TEXT AS direction
   FROM moves
   WHERE delta < 0
   ORDER BY
     CASE WHEN p_sort = 'dollar' THEN ABS(delta)    ELSE NULL END DESC NULLS LAST,
     CASE WHEN p_sort = 'pct'    THEN ABS(delta_pct) ELSE NULL END DESC NULLS LAST
   LIMIT p_top_n);
$$;

GRANT EXECUTE ON FUNCTION public.get_global_price_movers TO anon, authenticated, service_role;

-- Force PostgREST to drop its cached function definition.
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verify (should now return data in milliseconds rather than minutes):
--   EXPLAIN ANALYZE SELECT * FROM get_global_price_movers(
--     p_game_type := 'pokemon', p_days_back := 1, p_top_n := 3,
--     p_min_pct := 0.5, p_sort := 'pct', p_product_type := 'single'
--   );
--
-- Look for "Index Scan using idx_catalog_price_history_catalog_recorded"
-- in the EXPLAIN output. If you see "Seq Scan on catalog_price_history"
-- the index isn't being used and we need to ANALYZE the table:
--   ANALYZE public.catalog_price_history;
--   ANALYZE public.catalog;
-- ============================================================
