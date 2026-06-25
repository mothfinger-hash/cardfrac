-- migration_catalog_set_name_index.sql
--
-- The Sets list now sources from set_metadata, whose ids (e.g. 'me4') do NOT
-- match the catalog's set_code (e.g. 'CRI'), so opening a set falls back to
-- matching cards by set_name. That fallback runs for nearly every EN Pokemon
-- set, so set_name needs to be indexed or each open is a full-table scan.
--
-- Idempotent.
CREATE INDEX IF NOT EXISTS idx_catalog_set_name
  ON public.catalog (set_name);

ANALYZE public.catalog;
