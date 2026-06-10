-- ============================================================
-- PathBinder — Global Price Movers RPC (v7)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- v7 changes — REAL PERFORMANCE FIX:
--   v6 pre-filtered catalog by game_type but still used
--   DISTINCT ON over the CTE join, which materialized ~283K
--   price_history rows for the 7-day window before deduping
--   them down to ~42K. The intermediate sort spilled to disk
--   (8888kB external merge in EXPLAIN ANALYZE), and the
--   resulting query still took ~4.7 seconds — well over the
--   3-second Discord ack window and close to the bot's 8s
--   per-RPC timeout.
--
--   v7 replaces the DISTINCT ON pattern with a LATERAL JOIN +
--   LIMIT 1. For each eligible catalog row, Postgres does a
--   single index seek to pull THE oldest in-window history
--   row, period. No big intermediate result set, no on-disk
--   sort. Index seeks all the way down.
--
--   Expected impact based on the EXPLAIN: 4700ms → ~300ms.
--   Should comfortably fit the Discord ack window AND have
--   plenty of headroom for catalog_price_history to keep
--   growing.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- Drop prior signatures so the new one takes effect cleanly --------
DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_global_price_movers(
  p_game_type    TEXT    DEFAULT 'pokemon',
  p_days_back    INT     DEFAULT 1,
  p_top_n        INT     DEFAULT 10,
  p_min_pct      NUMERIC DEFAULT 0.5,
  p_sort         TEXT    DEFAULT 'pct',
  p_product_type TEXT    DEFAULT 'single'
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
  WITH moves AS (
    -- For each eligible catalog row, do a SINGLE index seek into
    -- catalog_price_history to get the oldest snapshot in the
    -- baseline window. LATERAL turns this into N index lookups
    -- instead of "fetch everything, sort, dedupe" — which was
    -- v6's 283K-row sort-to-disk bottleneck.
    SELECT
      c.id   AS catalog_id,
      c.name,
      c.set_name,
      c.image_url,
      h.recorded_value AS old_value,
      c.current_value,
      (c.current_value - h.recorded_value)::NUMERIC                                       AS delta,
      ROUND(((c.current_value - h.recorded_value) / NULLIF(h.recorded_value, 0) * 100)::numeric, 2) AS delta_pct
    FROM catalog c
    JOIN LATERAL (
      SELECT recorded_value
      FROM catalog_price_history h2
      WHERE h2.catalog_id  = c.id
        AND h2.recorded_at >= CURRENT_DATE - p_days_back
        AND h2.recorded_at <  CURRENT_DATE
      ORDER BY h2.recorded_at ASC
      LIMIT 1
    ) h ON TRUE
    WHERE c.game_type      = p_game_type
      AND c.current_value IS NOT NULL
      AND h.recorded_value IS NOT NULL
      AND (
        p_product_type = 'all'
        OR (p_product_type = 'single' AND COALESCE(c.product_type, 'single') = 'single')
        OR (p_product_type = 'sealed' AND COALESCE(c.product_type, 'single') <> 'single')
      )
      AND ABS(c.current_value - h.recorded_value) > 0.01
      AND ABS((c.current_value - h.recorded_value) / NULLIF(h.recorded_value, 0) * 100) >= p_min_pct
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
-- After running this migration, verify with:
--   EXPLAIN ANALYZE
--   SELECT * FROM get_global_price_movers(
--     p_game_type    := 'pokemon', p_days_back := 7, p_top_n := 3,
--     p_min_pct      := 0.5, p_sort := 'pct', p_product_type := 'single'
--   );
--
-- Look for:
--   * "Nested Loop" instead of "Sort/Unique"
--   * "Index Scan using idx_catalog_price_history_catalog_recorded"
--     (with LIMIT 1)
--   * Execution Time under 1 second
--
-- If still slow, run ANALYZE to refresh planner stats:
--   ANALYZE public.catalog_price_history;
--   ANALYZE public.catalog;
-- ============================================================
