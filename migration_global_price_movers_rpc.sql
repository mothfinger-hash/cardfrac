-- ============================================================
-- PathBinder — Global Price Movers RPC (v3)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Returns the top N up-movers + top N down-movers across a TCG's
-- catalog, computed entirely server-side. The dashboard widget calls
-- this instead of pulling all history + catalog rows to the client.
--
-- v2 changes:
--   - Default window shrunk from 8 to 1 day (24h moves are more useful
--     than 7d for live trading; 7d is still an option via p_days_back)
--   - Added p_sort: 'pct' (default) sorts by % change; 'dollar' sorts
--     by absolute $ change so cheap cards with huge % don't dominate
--
-- v3 changes:
--   - Added p_product_type: 'single' (default) returns TCG singles only;
--     'sealed' returns sealed product movers (booster_box, etb, utb,
--     tin, deck, etc.); 'all' skips the filter and returns both mixed.
--     The dashboard Price Movers toggle uses 'single' / 'sealed'.
--
-- Performance: returns ~20 rows in <500ms regardless of catalog size.
-- Idempotent — safe to re-run. Drops the old (5-arg v2) AND any prior
-- 6-arg variant first because CREATE OR REPLACE with a different param
-- signature creates a new overload alongside the old one, which causes
-- PostgREST PGRST203 ambiguity errors at the RPC call site.
-- ============================================================

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
  WITH oldest_per_card AS (
    SELECT DISTINCT ON (catalog_id)
      catalog_id,
      recorded_value AS old_value
    FROM catalog_price_history
    WHERE game_type = p_game_type
      AND recorded_at >= CURRENT_DATE - p_days_back
    ORDER BY catalog_id, recorded_at ASC
  ),
  moves AS (
    SELECT
      o.catalog_id,
      c.name,
      c.set_name,
      c.image_url,
      o.old_value,
      c.current_value,
      (c.current_value - o.old_value)::NUMERIC                              AS delta,
      ROUND(((c.current_value - o.old_value) / NULLIF(o.old_value, 0) * 100)::numeric, 2) AS delta_pct
    FROM oldest_per_card o
    JOIN catalog c ON c.id = o.catalog_id
    WHERE c.current_value IS NOT NULL
      AND o.old_value     IS NOT NULL
      AND ABS(c.current_value - o.old_value) > 0.01
      AND ABS((c.current_value - o.old_value) / NULLIF(o.old_value, 0) * 100) >= p_min_pct
      -- product_type filter: 'single' keeps TCG singles (or NULL legacy
      -- rows, which predate the column); 'sealed' keeps any non-single
      -- product (booster_box, etb, utb, tin, deck, etc.); 'all' skips
      -- the filter entirely so caller can mix.
      AND (
        p_product_type = 'all'
        OR (p_product_type = 'single' AND COALESCE(c.product_type, 'single') = 'single')
        OR (p_product_type = 'sealed' AND COALESCE(c.product_type, 'single') <> 'single')
      )
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

GRANT EXECUTE ON FUNCTION public.get_global_price_movers TO anon, authenticated;

-- ============================================================
-- Verify:
--   SELECT * FROM get_global_price_movers('pokemon', 1, 10, 0.5, 'dollar', 'single');
--   SELECT * FROM get_global_price_movers('pokemon', 7, 10, 0.5, 'dollar', 'sealed');
--   SELECT * FROM get_global_price_movers('pokemon', 1, 10, 0.5, 'dollar', 'all');
-- ============================================================
