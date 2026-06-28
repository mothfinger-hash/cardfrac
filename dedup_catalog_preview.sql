-- dedup_catalog_preview.sql  — READ ONLY. Two standalone queries, no temp
-- tables, no writes. Shows what dedup_catalog_apply.sql WOULD do for the
-- "safe" duplicate card rows (same game_type + set_name + card_number, and NOT
-- two distinct non-null pricecharting_ids — those stay as possible EN/JP prints).
--
-- Canonical row kept per group: prefer an 'en-' id, then one that already has a
-- tcgplayer_product_id, then an image, then a price, then lowest id. Everything
-- else in the group is a dupe to be absorbed.

-- ============================================================
-- QUERY 1 — headline counts, per-table references on the dupe rows, collisions
-- ============================================================
WITH dup_groups AS (
  SELECT game_type, set_name, card_number
  FROM public.catalog
  WHERE card_number IS NOT NULL AND set_name IS NOT NULL
  GROUP BY game_type, set_name, card_number
  HAVING COUNT(*) > 1
     AND COUNT(DISTINCT pricecharting_id) FILTER (WHERE pricecharting_id IS NOT NULL) <= 1
),
m AS (
  SELECT c.id,
         FIRST_VALUE(c.id) OVER (
           PARTITION BY c.game_type, c.set_name, c.card_number
           ORDER BY (c.id LIKE 'en-%') DESC,
                    (c.tcgplayer_product_id IS NOT NULL) DESC,
                    (c.image_url IS NOT NULL) DESC,
                    (c.current_value IS NOT NULL) DESC,
                    c.id ASC
         ) AS canonical_id
  FROM public.catalog c
  JOIN dup_groups g
    ON g.game_type = c.game_type AND g.set_name = c.set_name AND g.card_number = c.card_number
),
dupes AS (
  SELECT id AS dupe_id, canonical_id FROM m WHERE id <> canonical_id
)
SELECT 'dupes_to_delete'                      AS item, COUNT(*)::text AS value FROM dupes
UNION ALL SELECT 'canonical_rows_kept',                COUNT(DISTINCT canonical_id)::text FROM dupes
UNION ALL SELECT 'collection_items (re-point)',        COUNT(*)::text FROM public.collection_items            WHERE api_card_id IN (SELECT dupe_id FROM dupes)
UNION ALL SELECT 'listings (re-point)',                COUNT(*)::text FROM public.listings                    WHERE api_card_id IN (SELECT dupe_id FROM dupes)
UNION ALL SELECT 'shop_sales (re-point)',              COUNT(*)::text FROM public.shop_sales                  WHERE api_card_id IN (SELECT dupe_id FROM dupes)
UNION ALL SELECT 'card_overrides (re-point)',          COUNT(*)::text FROM public.card_overrides              WHERE api_card_id IN (SELECT dupe_id FROM dupes)
UNION ALL SELECT 'card_price_urls (re-point)',         COUNT(*)::text FROM public.card_price_urls             WHERE api_card_id IN (SELECT dupe_id FROM dupes)
UNION ALL SELECT 'card_reports (re-point)',            COUNT(*)::text FROM public.card_reports                WHERE api_card_id IN (SELECT dupe_id FROM dupes)
UNION ALL SELECT 'price_alerts (re-point)',            COUNT(*)::text FROM public.price_alerts                WHERE catalog_id  IN (SELECT dupe_id FROM dupes)
UNION ALL SELECT 'catalog_image_contributions (re-pt)',COUNT(*)::text FROM public.catalog_image_contributions WHERE catalog_id  IN (SELECT dupe_id FROM dupes)
UNION ALL SELECT 'card_prices (cascade-delete)',       COUNT(*)::text FROM public.card_prices                 WHERE catalog_id  IN (SELECT dupe_id FROM dupes)
UNION ALL SELECT 'catalog_price_history (cascade-del)',COUNT(*)::text FROM public.catalog_price_history        WHERE catalog_id  IN (SELECT dupe_id FROM dupes)
UNION ALL SELECT 'collection_item_collisions',         COUNT(*)::text
  FROM public.collection_items d
  JOIN dupes mm ON d.api_card_id = mm.dupe_id
  JOIN public.collection_items ci
    ON ci.api_card_id = mm.canonical_id
   AND ci.user_id = d.user_id
   AND ci.variant IS NOT DISTINCT FROM d.variant;


-- ============================================================
-- QUERY 2 — sample of the actual merges (dupe id -> canonical id). Run separately.
-- ============================================================
WITH dup_groups AS (
  SELECT game_type, set_name, card_number
  FROM public.catalog
  WHERE card_number IS NOT NULL AND set_name IS NOT NULL
  GROUP BY game_type, set_name, card_number
  HAVING COUNT(*) > 1
     AND COUNT(DISTINCT pricecharting_id) FILTER (WHERE pricecharting_id IS NOT NULL) <= 1
),
m AS (
  SELECT c.id, c.set_name, c.card_number,
         FIRST_VALUE(c.id) OVER (
           PARTITION BY c.game_type, c.set_name, c.card_number
           ORDER BY (c.id LIKE 'en-%') DESC,
                    (c.tcgplayer_product_id IS NOT NULL) DESC,
                    (c.image_url IS NOT NULL) DESC,
                    (c.current_value IS NOT NULL) DESC,
                    c.id ASC
         ) AS canonical_id
  FROM public.catalog c
  JOIN dup_groups g
    ON g.game_type = c.game_type AND g.set_name = c.set_name AND g.card_number = c.card_number
)
SELECT set_name, card_number, id AS dupe_id, canonical_id
FROM m
WHERE id <> canonical_id
ORDER BY set_name, card_number
LIMIT 60;
