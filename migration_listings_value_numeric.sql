-- ============================================================
-- PathBinder — Listings price columns to NUMERIC
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- The listings.value column was created as INTEGER, which rejects
-- decimal prices like 32.25 with the Postgres error:
--   invalid input syntax for type integer: "32.25"
--
-- Marketplace listings need cents — alter to NUMERIC(10,2) so
-- prices like 0.99 / 5.50 / 32.25 / 1299.99 all save cleanly.
--
-- shipping_price gets the same treatment (likely same column type).
--
-- Idempotent: ALTER TYPE NUMERIC is a safe upcast from INTEGER —
-- no data loss, existing integer values become 5 → 5.00 etc.
-- ============================================================

ALTER TABLE public.listings
  ALTER COLUMN value         TYPE NUMERIC(10,2)
    USING (value::NUMERIC(10,2));

ALTER TABLE public.listings
  ALTER COLUMN shipping_price TYPE NUMERIC(10,2)
    USING (shipping_price::NUMERIC(10,2));

-- Belt and suspenders: list_price + market_price may have been
-- created INTEGER too. Alter those if they exist (the IF EXISTS
-- guard via DO block skips silently when the columns aren't there).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='listings' AND column_name='list_price') THEN
    EXECUTE 'ALTER TABLE public.listings ALTER COLUMN list_price TYPE NUMERIC(10,2) USING (list_price::NUMERIC(10,2))';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='listings' AND column_name='market_price') THEN
    EXECUTE 'ALTER TABLE public.listings ALTER COLUMN market_price TYPE NUMERIC(10,2) USING (market_price::NUMERIC(10,2))';
  END IF;
END $$;

-- ============================================================
-- Verify:
--   SELECT column_name, data_type, numeric_precision, numeric_scale
--   FROM information_schema.columns
--   WHERE table_name='listings' AND column_name IN ('value','shipping_price','list_price','market_price');
-- Expected: all rows show data_type = 'numeric'
-- ============================================================
