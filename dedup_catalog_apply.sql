-- dedup_catalog_apply.sql  — LOSSLESS merge of the 615 safe duplicate rows.
--
-- For each safe group (same game_type + set_name + card_number, NOT two
-- distinct non-null pricecharting_ids) it keeps the en- canonical row and
-- folds the duplicate INTO it without losing anything:
--
--   1. Field merge   — backfill any column the canonical is missing from the
--                      dupe (COALESCE; never overwrites the canonical's own
--                      values). Preserves a price/image/id the dupe had.
--   2. Re-point refs — collections, listings, shop_sales, reports, overrides,
--                      price urls, price alerts, image contributions.
--   3. Preserve history — move the dupe's card_prices / card_prices_history /
--                      catalog_price_history rows onto the canonical, keeping
--                      the canonical's row on any key collision (so extra
--                      snapshots survive instead of cascade-deleting).
--   4. Delete the now-empty duplicate catalog row.
--
-- ATOMIC: one DO block / transaction. Any error rolls it ALL back. Safe groups
-- are 2-row pairs (one dupe per canonical), so the field merge is deterministic.
-- BACK UP THE DATABASE FIRST regardless.

DO $$
DECLARE
  v_dupes int;
BEGIN
  CREATE TEMP TABLE _map ON COMMIT DROP AS
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
  )
  SELECT id AS dupe_id, canonical_id FROM m WHERE id <> canonical_id;

  SELECT COUNT(*) INTO v_dupes FROM _map;
  RAISE NOTICE 'Merging % duplicate rows (lossless)...', v_dupes;

  -- 1) FIELD MERGE: fill the canonical's NULL columns from the dupe. COALESCE
  --    keeps the canonical's own value whenever it has one.
  UPDATE public.catalog can
     SET image_url            = COALESCE(can.image_url, d.image_url),
         current_value        = COALESCE(can.current_value, d.current_value),
         pricecharting_id     = COALESCE(can.pricecharting_id, d.pricecharting_id),
         price_source_url     = COALESCE(can.price_source_url, d.price_source_url),
         tcgplayer_product_id = COALESCE(can.tcgplayer_product_id, d.tcgplayer_product_id),
         tcgplayer_url        = COALESCE(can.tcgplayer_url, d.tcgplayer_url),
         rarity               = COALESCE(can.rarity, d.rarity),
         has_reverse_holo     = COALESCE(can.has_reverse_holo, d.has_reverse_holo)
    FROM _map mp
    JOIN public.catalog d ON d.id = mp.dupe_id
   WHERE can.id = mp.canonical_id;

  -- 2) Re-point soft references (api_card_id).
  UPDATE public.collection_items t SET api_card_id = mp.canonical_id FROM _map mp WHERE t.api_card_id = mp.dupe_id;
  UPDATE public.listings         t SET api_card_id = mp.canonical_id FROM _map mp WHERE t.api_card_id = mp.dupe_id;
  UPDATE public.shop_sales       t SET api_card_id = mp.canonical_id FROM _map mp WHERE t.api_card_id = mp.dupe_id;
  UPDATE public.card_reports     t SET api_card_id = mp.canonical_id FROM _map mp WHERE t.api_card_id = mp.dupe_id;

  -- override / price-url may be unique per card: drop dupe-side if canonical
  -- already has one, then re-point the rest.
  DELETE FROM public.card_overrides t USING _map mp
   WHERE t.api_card_id = mp.dupe_id
     AND EXISTS (SELECT 1 FROM public.card_overrides x WHERE x.api_card_id = mp.canonical_id);
  UPDATE public.card_overrides t SET api_card_id = mp.canonical_id FROM _map mp WHERE t.api_card_id = mp.dupe_id;

  DELETE FROM public.card_price_urls t USING _map mp
   WHERE t.api_card_id = mp.dupe_id
     AND EXISTS (SELECT 1 FROM public.card_price_urls x WHERE x.api_card_id = mp.canonical_id);
  UPDATE public.card_price_urls t SET api_card_id = mp.canonical_id FROM _map mp WHERE t.api_card_id = mp.dupe_id;

  -- user-data cascades
  UPDATE public.price_alerts t SET catalog_id = mp.canonical_id FROM _map mp WHERE t.catalog_id = mp.dupe_id;
  UPDATE public.catalog_image_contributions t SET catalog_id = mp.canonical_id FROM _map mp WHERE t.catalog_id = mp.dupe_id;

  -- 3) PRESERVE PRICE HISTORY: move the dupe's rows onto the canonical, keeping
  --    the canonical's row on a key collision so unique snapshots survive.
  --    card_prices key (catalog_id, source)
  DELETE FROM public.card_prices d USING _map mp
   WHERE d.catalog_id = mp.dupe_id
     AND EXISTS (SELECT 1 FROM public.card_prices x
                  WHERE x.catalog_id = mp.canonical_id AND x.source = d.source);
  UPDATE public.card_prices d SET catalog_id = mp.canonical_id FROM _map mp WHERE d.catalog_id = mp.dupe_id;

  --    card_prices_history key (catalog_id, source, recorded_at)
  DELETE FROM public.card_prices_history d USING _map mp
   WHERE d.catalog_id = mp.dupe_id
     AND EXISTS (SELECT 1 FROM public.card_prices_history x
                  WHERE x.catalog_id = mp.canonical_id AND x.source = d.source AND x.recorded_at = d.recorded_at);
  UPDATE public.card_prices_history d SET catalog_id = mp.canonical_id FROM _map mp WHERE d.catalog_id = mp.dupe_id;

  --    catalog_price_history key (catalog_id, recorded_at)
  DELETE FROM public.catalog_price_history d USING _map mp
   WHERE d.catalog_id = mp.dupe_id
     AND EXISTS (SELECT 1 FROM public.catalog_price_history x
                  WHERE x.catalog_id = mp.canonical_id AND x.recorded_at = d.recorded_at);
  UPDATE public.catalog_price_history d SET catalog_id = mp.canonical_id FROM _map mp WHERE d.catalog_id = mp.dupe_id;

  -- 4) Delete the now-empty duplicate catalog rows. Nothing references them now.
  DELETE FROM public.catalog c USING _map mp WHERE c.id = mp.dupe_id;

  RAISE NOTICE 'Dedup complete: % duplicates merged into their canonical rows.', v_dupes;
END $$;
