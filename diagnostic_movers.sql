-- ============================================================
-- /movers diagnostic — run each block, paste the output back.
-- These read-only queries narrow down why global returns "no data".
-- ============================================================

-- 1) Is the v4 function actually in place?
SELECT proname, pronargs, pg_get_function_arguments(oid) AS args
FROM pg_proc
WHERE proname = 'get_global_price_movers';

-- 2) How much price history exists, and how recent?
SELECT COUNT(*) AS total_rows,
       MIN(recorded_at) AS oldest,
       MAX(recorded_at) AS newest
FROM catalog_price_history;

-- 3) Rows in the windows the bot actually queries:
SELECT '24h window' AS window,
       COUNT(*) AS rows
FROM catalog_price_history
WHERE recorded_at >= CURRENT_DATE - 1
UNION ALL
SELECT '7d window', COUNT(*)
FROM catalog_price_history
WHERE recorded_at >= CURRENT_DATE - 7;

-- 4) Does the JOIN to catalog actually find anything? If history rows
--    have catalog_ids that don't match any catalog.id (orphans), the
--    RPC's inner JOIN drops them silently.
SELECT COUNT(*) AS joinable_rows
FROM catalog_price_history h
JOIN catalog c ON c.id = h.catalog_id
WHERE h.recorded_at >= CURRENT_DATE - 7;

-- 5) Breakdown by game_type in the catalog rows that have recent history:
SELECT c.game_type, COUNT(*) AS rows
FROM catalog_price_history h
JOIN catalog c ON c.id = h.catalog_id
WHERE h.recorded_at >= CURRENT_DATE - 7
GROUP BY c.game_type
ORDER BY rows DESC;

-- 6) The actual RPC call — does it return rows for pokemon over 7 days?
SELECT * FROM get_global_price_movers('pokemon', 7, 10, 0.5, 'pct', 'single');

-- 7) Same RPC, 1 day window:
SELECT * FROM get_global_price_movers('pokemon', 1, 10, 0.5, 'pct', 'single');

-- 8) Drop the min_pct threshold completely — maybe the cards moved but
--    by less than 0.5%:
SELECT * FROM get_global_price_movers('pokemon', 7, 10, 0.0, 'pct', 'single');
