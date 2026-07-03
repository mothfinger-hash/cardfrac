-- migration_card_prices_source_subtypes.sql
--
-- Phase 2 of the TCGCSV sync writes a price row per FINISH:
--   tcgplayer                  (base / Normal)
--   tcgplayer_reverse_holo
--   tcgplayer_foil
--   tcgplayer_holo
--   tcgplayer_1st_edition_holo
--   tcgplayer_<slug>           (generated for any other subtype)
--
-- card_prices was created back when only 'pricecharting' / 'tcgplayer' existed,
-- so its source CHECK constraint rejects the new subtype rows with a 23514
-- (card_prices_source_check violation). Widen it to a PATTERN so we never have
-- to migrate again when a new finish shows up.
--
-- Drops whatever source-related CHECK constraint exists on each table (by
-- definition, not by guessed name) and replaces it with the permissive pattern.
-- Idempotent. Existing rows only ever hold 'pricecharting'/'tcgplayer', which
-- both satisfy the new constraint, so the ADD can't fail on existing data.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conrelid::regclass AS tbl, conname
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid IN (
        'public.card_prices'::regclass,
        'public.card_prices_history'::regclass
      )
      AND pg_get_constraintdef(oid) ILIKE '%source%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE public.card_prices
  ADD CONSTRAINT card_prices_source_check
  CHECK (source = 'pricecharting' OR source LIKE 'tcgplayer%');

ALTER TABLE public.card_prices_history
  ADD CONSTRAINT card_prices_history_source_check
  CHECK (source = 'pricecharting' OR source LIKE 'tcgplayer%');
