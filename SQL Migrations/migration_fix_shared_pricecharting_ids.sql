-- migration_fix_shared_pricecharting_ids.sql
--
-- A batch enrichment stamped single pricecharting_id values onto whole cohorts
-- of unrelated cards (one id shared by 30-58 different cards). A PriceCharting
-- id maps to exactly one product, so ANY id shared across more than one distinct
-- card (set_name + card_number) is wrong. Those wrong ids make the daily refresh
-- paint dozens of cards with one product's price (the Blastoise=$373 / Gengar=
-- $1341 / triplicate Price Movers bug).
--
-- This NULLs the bad pricecharting_id AND current_value on every affected row,
-- so the wrong prices stop showing immediately. Recovery: enrich_pricecharting_
-- ids.py re-derives correct ids from each row's price_source_url, and the next
-- refresh_catalog_prices.py repopulates from the right product (rows with a
-- valid price_source_url but no id fall back to the scrape path automatically).
--
-- en-/bare- DUPLICATE rows of the SAME card legitimately share an id — they key
-- to one (set_name, card_number), so they are NOT touched. Correct single-mapped
-- ids are also left alone. BACK UP FIRST. Re-runnable.

WITH bad_ids AS (
  SELECT pricecharting_id
  FROM public.catalog
  WHERE pricecharting_id IS NOT NULL
  GROUP BY pricecharting_id
  HAVING COUNT(DISTINCT coalesce(set_name,'') || '|' || coalesce(card_number,'')) > 1
)
UPDATE public.catalog
   SET pricecharting_id = NULL,
       current_value    = NULL
 WHERE pricecharting_id IN (SELECT pricecharting_id FROM bad_ids);

-- Confirm none remain:
SELECT count(*) AS still_shared FROM (
  SELECT pricecharting_id
  FROM public.catalog
  WHERE pricecharting_id IS NOT NULL
  GROUP BY pricecharting_id
  HAVING COUNT(DISTINCT coalesce(set_name,'') || '|' || coalesce(card_number,'')) > 1
) t;
