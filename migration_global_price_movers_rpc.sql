-- ============================================================
-- PathBinder — Global Price Movers RPC
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Returns the top N up-movers + top N down-movers across a TCG's
-- catalog, computed entirely server-side. The dashboard widget calls
-- this instead of pulling all history + catalog rows to the client.
--
-- Performance: returns ~20 rows in <500ms regardless of catalog size.
-- The previous client-side approach pulled 30K+ history rows + 30K+
-- catalog rows across ~180 paginated requests.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_global_price_movers(
  p_game_type TEXT    DEFAULT 'pokemon',
  p_days_back INT     DEFAULT 8,
  p_top_n     INT     DEFAULT 10,
  p_min_pct   NUMERIC DEFAULT 0.5
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
    -- Pick the EARLIEST recorded_value per catalog_id in the trailing
    -- window. DISTINCT ON keeps just the first row per partition by
    -- the ORDER BY clause inside.
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
   FROM moves WHERE delta > 0 ORDER BY delta_pct DESC LIMIT p_top_n)
  UNION ALL
  (SELECT catalog_id, name, set_name, image_url, old_value, current_value,
          delta, delta_pct, 'down'::TEXT AS direction
   FROM moves WHERE delta < 0 ORDER BY delta_pct ASC  LIMIT p_top_n);
$$;

-- Allow anon + authenticated to call it (read-only function)
GRANT EXECUTE ON FUNCTION public.get_global_price_movers TO anon, authenticated;

-- ============================================================
-- Verify after running:
--   SELECT * FROM get_global_price_movers('pokemon', 8, 10, 0.5);
-- Should return up to 20 rows (10 up + 10 down) of Pokemon movers.
-- ============================================================
