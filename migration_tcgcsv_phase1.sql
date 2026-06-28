-- migration_tcgcsv_phase1.sql
--
-- TCGCSV integration, Phase 1: stable TCGplayer product IDs + canonical
-- product URLs on catalog rows, plus a persisted set-mapping table so we
-- never re-fuzzy groups on every sync.
--
-- No pricing changes here — prices land in a later phase via card_prices
-- (source = 'tcgplayer' / 'tcgplayer_reverse_holo' / ...). This migration
-- only adds the columns + table the Phase 1 backfill writes to.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- ── catalog: TCGplayer product linkage ──────────────────────────────────
-- product_id is TCGplayer's stable PK (safe to key on). url is the bare
-- product page; the affiliate wrapper is applied at render time in the app,
-- never stored, so links stay re-pointable if the partner prefix changes.
ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS tcgplayer_product_id bigint,
  ADD COLUMN IF NOT EXISTS tcgplayer_url        text;

-- Partial index — only the rows we've linked, used by "view all listings of
-- this card" / reverse lookups from a productId.
CREATE INDEX IF NOT EXISTS idx_catalog_tcgplayer_product_id
  ON public.catalog (tcgplayer_product_id)
  WHERE tcgplayer_product_id IS NOT NULL;

-- ── tcgplayer_group_map: TCGCSV group (set) -> PathBinder set ────────────
-- Resolved once by the sync script's fuzzy matcher, then reused. A one-time
-- manual cleanup pass fixes the stragglers fuzzy-match can't place.
--
--   group_id     TCGCSV/TCGplayer groupId (stable PK)
--   category_id  TCGCSV/TCGplayer categoryId (game)
--   game_type    PathBinder game_type ('pokemon','mtg','ygo','op',...)
--   abbreviation TCGplayer set abbreviation (e.g. 'SWSH12')
--   group_name   TCGplayer set name (for audit / manual review)
--   set_code     catalog.set_code this group maps to (the join key)
--   set_name     catalog.set_name (snapshot, for audit)
--   confidence   'exact' | 'fuzzy' | 'manual' | 'unmatched'
--   mapped_at    when this mapping was last written
CREATE TABLE IF NOT EXISTS public.tcgplayer_group_map (
  group_id     bigint PRIMARY KEY,
  category_id  integer NOT NULL,
  game_type    text    NOT NULL,
  abbreviation text,
  group_name   text,
  set_code     text,
  set_name     text,
  confidence   text    NOT NULL DEFAULT 'unmatched',
  mapped_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tcg_group_map_game
  ON public.tcgplayer_group_map (game_type);
CREATE INDEX IF NOT EXISTS idx_tcg_group_map_setcode
  ON public.tcgplayer_group_map (set_code)
  WHERE set_code IS NOT NULL;

-- The map is reference data the sync script (service role) maintains. Keep
-- it readable by the app if we ever want to surface "view set on TCGplayer",
-- but writes stay service-role only (no anon/authenticated policy = RLS
-- default-deny for them once enabled).
ALTER TABLE public.tcgplayer_group_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tcg_group_map_public_read ON public.tcgplayer_group_map;
CREATE POLICY tcg_group_map_public_read
  ON public.tcgplayer_group_map
  FOR SELECT USING (true);

COMMIT;
