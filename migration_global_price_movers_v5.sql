-- ============================================================
-- PathBinder — Global Price Movers RPC (v5)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- v5 changes:
--   - Exclude TODAY'S snapshot from the "old value" baseline. The
--     v4 query picked the oldest row in [CURRENT_DATE - N, today],
--     but today's snapshot is essentially equal to catalog.current_value
--     (the cron writes the same value to both), so when today was the
--     only row in the window the computed delta was always 0 and the
--     threshold filter dropped every card. v5 restricts the baseline
--     window to [CURRENT_DATE - N, CURRENT_DATE), so 24h movers
--     compare against yesterday's snapshot, 7d movers against a-week-
--     ago, and so on.
--
-- Idempotent — safe to re-run. Drops every prior signature first.
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
    -- Pick the oldest in-window price for each catalog row, EXCLUDING
    -- today's snapshot. Today's row mirrors catalog.current_value
    -- (same cron writes both), so if it ends up as the baseline the
    -- delta is structurally zero and every card gets filtered out.
    SELECT DISTINCT ON (catalog_id)
      catalog_id,
      recorded_value AS old_value
    FROM catalog_price_history
    WHERE recorded_at >= CURRENT_DATE - p_days_back
      AND recorded_at <  CURRENT_DATE
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
    WHERE c.game_type      = p_game_type
      AND c.current_value IS NOT NULL
      AND o.old_value     IS NOT NULL
      AND ABS(c.current_value - o.old_value) > 0.01
      AND ABS((c.current_value - o.old_value) / NULLIF(o.old_value, 0) * 100) >= p_min_pct
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

GRANT EXECUTE ON FUNCTION public.get_global_price_movers TO anon, authenticated, service_role;

-- Force PostgREST to drop its cached function definition.
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verify (should now return data for the 1-day window):
--   SELECT * FROM get_global_price_movers(
--     p_game_type := 'pokemon', p_days_back := 1, p_top_n := 3,
--     p_min_pct := 0.5, p_sort := 'pct', p_product_type := 'single'
--   );
-- ============================================================
