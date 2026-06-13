-- ============================================================
-- PathBinder — Global Price Movers RPC (v9)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- v9 change — ANCHOR ON LATEST SNAPSHOT, NOT CURRENT_DATE
-- ------------------------------------------------------
-- v8 computed the comparison window relative to CURRENT_DATE:
--     recorded_at >= CURRENT_DATE - p_days_back
--     recorded_at <  CURRENT_DATE
-- and compared the in-window "old" snapshot to catalog.current_value.
--
-- The bug: catalog_price_history.recorded_at is stamped with the
-- refresh machine's LOCAL date (date.today() in refresh_catalog_
-- prices_csv.py), while CURRENT_DATE is Supabase's UTC date. Once UTC
-- rolls to the next day before that day's refresh has run, the newest
-- snapshot is dated CURRENT_DATE - 1. The 24h window [CURRENT_DATE-1,
-- CURRENT_DATE) then lands on that newest snapshot — the SAME values
-- current_value already holds — so every delta is 0 and the 24h movers
-- panel goes empty. 7d still worked because its window reached an older,
-- genuinely different snapshot. This produced a daily "dead zone" for
-- the 24h panel between the UTC rollover and the next refresh.
--
-- v9 anchors the window on the latest snapshot date that actually
-- exists for the game (max(recorded_at)), so:
--     "24h"  = newest snapshot vs the snapshot one day earlier
--     "7d"   = newest snapshot vs the snapshot ~7 days earlier
-- regardless of timezone skew or whether today's refresh has landed.
-- If a refresh is missed, it gracefully compares the two most recent
-- snapshots that DO exist instead of returning nothing.
--
-- Everything else (p_min_value floor, product_type, sort, thresholds,
-- the idx_catalog_game_value index) is unchanged from v8.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_catalog_game_value
  ON public.catalog (game_type, current_value DESC, id)
  WHERE current_value IS NOT NULL;

DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_global_price_movers(TEXT, INT, INT, NUMERIC, TEXT, TEXT, NUMERIC);

CREATE OR REPLACE FUNCTION public.get_global_price_movers(
  p_game_type    TEXT    DEFAULT 'pokemon',
  p_days_back    INT     DEFAULT 1,
  p_top_n        INT     DEFAULT 10,
  p_min_pct      NUMERIC DEFAULT 0.5,
  p_sort         TEXT    DEFAULT 'pct',
  p_product_type TEXT    DEFAULT 'single',
  p_min_value    NUMERIC DEFAULT 1.0
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
  WITH anchor AS (
    -- Newest snapshot date that actually exists for this game.
    -- Uses idx_cph_game_type_recorded_at — single-row, fast.
    SELECT max(recorded_at) AS latest
    FROM catalog_price_history
    WHERE game_type = p_game_type
  ),
  moves AS (
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
    CROSS JOIN anchor a
    JOIN LATERAL (
      SELECT recorded_value
      FROM catalog_price_history h2
      WHERE h2.catalog_id  = c.id
        AND h2.recorded_at >= a.latest - p_days_back   -- window anchored on newest snapshot
        AND h2.recorded_at <  a.latest
      ORDER BY h2.recorded_at ASC
      LIMIT 1
    ) h ON TRUE
    WHERE c.game_type      = p_game_type
      AND c.current_value IS NOT NULL
      AND c.current_value >= p_min_value
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
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verify (should now return rows for 24h even when today's refresh
-- hasn't landed yet, because it anchors on the newest snapshot):
--   SELECT count(*) FROM get_global_price_movers('pokemon', 1, 1000, 0.5, 'pct', 'single', 0);
--   SELECT count(*) FROM get_global_price_movers('pokemon', 7, 1000, 0.5, 'pct', 'single', 0);
-- And a spot check of the top movers:
--   SELECT name, old_value, current_value, delta, delta_pct, direction
--   FROM get_global_price_movers('pokemon', 1, 5, 0.5, 'dollar', 'single', 1.0);
-- ============================================================
