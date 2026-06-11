-- ============================================================
-- PathBinder — Fix corrupted McDonald's Promos catalog prices
--
-- Background:
--   The catalog had ~134 McDonald's Promos rows where cards with
--   the same card number across DIFFERENT years all shared an
--   identical current_value. e.g. every `-7` card (m11-7, m12-7,
--   m14-7, m15-7, m16-7, m17-7, m18-7, m19-7, m21-7, m22-7) was
--   stamped $1182.60. Every `-1` card was $92.42. Etc.
--
--   Root cause: the PriceCharting sync was keying off card number
--   alone (or some other set-blind heuristic) within the McDonald's
--   Promos family, so distinct cards inherited the same upstream
--   row. The website's movers panel surfaced these as +175% gains
--   ($1182.60 vs prior $430.06), making the panel useless.
--
-- This migration:
--   1. NULLs current_value + price_source_url for every McDonald's
--      Promos catalog row whose current_value is duplicated across
--      2+ rows (the corruption signature).
--   2. NULLs pricecharting_id for the same rows so the next sync
--      doesn't immediately re-stamp the bad value.
--   3. Trims catalog_price_history for the nulled rows so the
--      movers RPC's LATERAL JOIN doesn't keep finding phantom
--      old_values to compare against.
--
-- Safe to re-run (idempotent — nothing to do once cleaned).
-- ============================================================

-- Diagnostic: print how many rows about to be touched.
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM catalog c
  WHERE c.game_type = 'pokemon'
    AND c.set_name ILIKE '%McDonald%'
    AND c.current_value IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM catalog c2
      WHERE c2.game_type = 'pokemon'
        AND c2.set_name ILIKE '%McDonald%'
        AND c2.current_value = c.current_value
        AND c2.id <> c.id
    );
  RAISE NOTICE 'About to NULL current_value on % McDonald''s Promos rows', v_count;
END $$;

-- Step 1: clear corrupted current_value + price_source_url.
UPDATE catalog c
SET current_value = NULL,
    price_source_url = NULL
WHERE c.game_type = 'pokemon'
  AND c.set_name ILIKE '%McDonald%'
  AND c.current_value IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM catalog c2
    WHERE c2.game_type = 'pokemon'
      AND c2.set_name ILIKE '%McDonald%'
      AND c2.current_value = c.current_value
      AND c2.id <> c.id
  );

-- Step 2: clear bad pricecharting_id mappings so the next sync
-- rebuild starts from scratch instead of re-stamping the same
-- bogus value.
UPDATE catalog c
SET pricecharting_id = NULL
WHERE c.game_type = 'pokemon'
  AND c.set_name ILIKE '%McDonald%'
  AND c.pricecharting_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM catalog c2
    WHERE c2.game_type = 'pokemon'
      AND c2.set_name ILIKE '%McDonald%'
      AND c2.pricecharting_id = c.pricecharting_id
      AND c2.id <> c.id
  );

-- Step 3: trim history for the nulled rows. The movers RPC reads
-- catalog_price_history via LATERAL JOIN for the old_value side
-- of the delta. Leaving the bad rows in history means as soon as
-- current_value gets repopulated (correctly) by the next sync,
-- the RPC will compute (real - corrupt) and produce another wave
-- of phantom movers. Wipe the bad history now so future deltas
-- compute against the next legitimate snapshot.
DELETE FROM catalog_price_history h
WHERE h.catalog_id IN (
  SELECT id FROM catalog
  WHERE game_type = 'pokemon'
    AND set_name ILIKE '%McDonald%'
    AND current_value IS NULL
);

-- ============================================================
-- Post-migration sanity check:
--   SELECT current_value, COUNT(*) AS dup_count
--   FROM catalog
--   WHERE game_type = 'pokemon' AND set_name ILIKE '%McDonald%'
--     AND current_value IS NOT NULL
--   GROUP BY current_value
--   HAVING COUNT(*) > 1;
--
-- Should return ZERO rows after this migration runs.
-- ============================================================
