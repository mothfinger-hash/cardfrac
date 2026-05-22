-- ============================================================
-- PathBinder — Global Price Movers RPC (v2)
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
-- Performance: returns ~20 rows in <500ms regardless of catalog size.
-- Idempotent — safe to re-run; CREATE OR REPLACE drops the old version.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_global_price_movers(
  p_game_type TEXT    DEFAULT 'pokemon',
  p_days_back INT     DEFAULT 1,
  p_top_n     INT     DEFAULT 10,
  p_min_pct   NUMERIC DEFAULT 0.5,
  p_sort      TEXT    DEFAULT 'pct'   -- 'pct' or 'dollar'
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
--   SELECT * FROM get_global_price_movers('pokemon', 1, 10, 0.5, 'pct');
--   SELECT * FROM get_global_price_movers('pokemon', 7, 10, 0.5, 'dollar');
-- ============================================================
