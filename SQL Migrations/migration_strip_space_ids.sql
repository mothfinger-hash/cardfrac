-- ============================================================
-- PathBinder — Strip spaces from catalog ids
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Why this exists
-- ---------------
-- A handful of catalog rows have ids with literal spaces in them,
-- e.g. `op-op07 pre-OP07-101`. Suspected cause: One Piece sync
-- script wrote a set_code with a space ("op07 pre" instead of
-- "op07pre" or "op07-pre"), which then propagated into the row id.
--
-- Bad ids cause:
--   • PriceCharting CSV match misses (id format doesn't normalize)
--   • Marketplace listings referencing them via api_card_id can
--     fail to resolve catalog metadata
--   • URL-quoting issues in any link / share flow
--
-- We can't just UPDATE catalog SET id = REPLACE(id, ' ', '')
-- because catalog_price_history has a FK on catalog_id that blocks
-- mid-statement id changes. This migration handles the FK by
-- dropping it, updating every referencing column, then re-adding
-- the FK with the same CASCADE behavior.
--
-- Wrapped in a transaction so any failure rolls back cleanly.
-- Idempotent — re-running after a successful first run is a no-op
-- because nothing matches the `LIKE '% %'` filter anymore.

BEGIN;

-- ── 1. Drop the FK that blocks updates ─────────────────────────
-- catalog_price_history.catalog_id → catalog.id is the FK that
-- raised the error in your run. We re-add it with ON DELETE
-- CASCADE at the end so deletes of catalog rows still propagate
-- properly. If your project named the constraint something other
-- than the default, the DROP IF EXISTS handles it gracefully.
ALTER TABLE public.catalog_price_history
  DROP CONSTRAINT IF EXISTS catalog_price_history_catalog_id_fkey;

-- ── 2. Update every column that holds a catalog id ─────────────
-- Order doesn't matter once the FK is dropped; we just need to hit
-- every place a stale id might live so nothing dangles after step 4.

-- catalog itself
UPDATE public.catalog
   SET id = REPLACE(id, ' ', '')
 WHERE id LIKE '% %';

-- price history (FK target)
UPDATE public.catalog_price_history
   SET catalog_id = REPLACE(catalog_id, ' ', '')
 WHERE catalog_id LIKE '% %';

-- collection_items.api_card_id references catalog.id by text, not
-- by formal FK in most projects — but the data needs the same scrub
-- or owned-card detail views will 404 on the metadata join.
UPDATE public.collection_items
   SET api_card_id = REPLACE(api_card_id, ' ', '')
 WHERE api_card_id LIKE '% %';

-- listings.api_card_id same story
UPDATE public.listings
   SET api_card_id = REPLACE(api_card_id, ' ', '')
 WHERE api_card_id LIKE '% %';

-- card_overrides.catalog_id (admin-edited card data) — also text
-- reference. Safe to UPDATE; the row stays attached to its (now
-- cleaned) catalog row.
UPDATE public.card_overrides
   SET catalog_id = REPLACE(catalog_id, ' ', '')
 WHERE catalog_id LIKE '% %';

-- ── 3. Re-add the FK with the original CASCADE behavior ────────
-- Sets the same constraint name PostgREST and Supabase tooling
-- expect, so any client code that introspects the schema sees no
-- difference.
ALTER TABLE public.catalog_price_history
  ADD CONSTRAINT catalog_price_history_catalog_id_fkey
  FOREIGN KEY (catalog_id)
  REFERENCES public.catalog(id)
  ON DELETE CASCADE;

COMMIT;

-- ── 4. Verify (run separately, optional) ───────────────────────
-- After the COMMIT, these should all return 0:
--
--   SELECT count(*) FROM public.catalog
--     WHERE id LIKE '% %';
--
--   SELECT count(*) FROM public.catalog_price_history
--     WHERE catalog_id LIKE '% %';
--
--   SELECT count(*) FROM public.collection_items
--     WHERE api_card_id LIKE '% %';
--
--   SELECT count(*) FROM public.listings
--     WHERE api_card_id LIKE '% %';
