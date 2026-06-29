-- ============================================================
-- PathBinder — Pokemon EN legacy-id awareness for sets RPCs
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Background: the catalog adopted an 'en-' / 'jp-' / 'mtg-' / etc.
-- id prefix convention partway through development. Pokemon EN
-- rows synced BEFORE that convention still live with their bare
-- pokemontcg.io set-code id (e.g. 'sm12-45', 'swsh7-22', 'base4-12').
-- The newer convention writes 'en-{set}-{num}'.
--
-- The Sets page RPCs (catalog_sets_summary, catalog_cards_in_set)
-- previously filtered the EN tab with `id ilike 'en-%'`, which
-- silently dropped every legacy row from the Sets list AND from
-- set-detail card lists. After this migration, when called with
-- p_prefix = 'en-', the RPCs also include any id beginning with
-- one of the legacy pokemontcg.io set-code stems.
--
-- Idempotent — CREATE OR REPLACE drops the old version.
-- ============================================================

-- Helper: returns true if the given id looks like a Pokemon EN
-- catalog row, regardless of which id convention it was synced under.
-- The IMMUTABLE PARALLEL SAFE markers let the planner inline this in
-- WHERE clauses without extra round-trips.
CREATE OR REPLACE FUNCTION public.is_pokemon_en_id(p_id text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $$
  SELECT p_id LIKE 'en-%'
      OR p_id ~ '^(sm|swsh|xy|bw|ex|dp|pl|neo|base|gym|pop|ecard|col1|cel25|det1|g1)(\d|-)';
$$;

GRANT EXECUTE ON FUNCTION public.is_pokemon_en_id(text) TO anon, authenticated;

-- ============================================================
-- catalog_sets_summary — Sets-page aggregate. EN prefix path now
-- includes legacy bare-set-code rows via is_pokemon_en_id.
-- ============================================================
CREATE OR REPLACE FUNCTION public.catalog_sets_summary(p_prefix text)
RETURNS TABLE(set_code text, set_name text, total bigint)
LANGUAGE sql STABLE AS $$
  SELECT set_code, set_name, COUNT(*) AS total
  FROM catalog
  WHERE set_code IS NOT NULL
    AND set_name IS NOT NULL
    AND (
      -- EN-prefix case: include legacy bare-set-code rows too
      (p_prefix = 'en-' AND is_pokemon_en_id(id))
      -- All other prefixes (jp-, pd-, mtg-, ygo-, op-, gun-, dbz-, cn-, kr-, …)
      -- behave as before: simple ILIKE.
      OR (p_prefix <> 'en-' AND id ILIKE p_prefix || '%')
    )
  GROUP BY set_code, set_name;
$$;

GRANT EXECUTE ON FUNCTION public.catalog_sets_summary(text) TO anon, authenticated;

-- ============================================================
-- catalog_cards_in_set — Set-detail card list. EN prefix path also
-- includes legacy rows so clicking an old set (e.g. "EX Holon Phantoms")
-- returns its cards even though their ids look like `exhp-42`.
-- ============================================================
CREATE OR REPLACE FUNCTION public.catalog_cards_in_set(p_prefix text, p_set_code text)
RETURNS TABLE(id text, name text, card_number text, rarity text,
              set_code text, set_name text, image_url text, game_type text)
LANGUAGE sql STABLE AS $$
  SELECT id, name, card_number, rarity, set_code, set_name, image_url, game_type
  FROM catalog
  WHERE set_code ILIKE p_set_code
    AND (
      (p_prefix = 'en-' AND is_pokemon_en_id(id))
      OR (p_prefix <> 'en-' AND id ILIKE p_prefix || '%')
    )
  ORDER BY card_number;
$$;

GRANT EXECUTE ON FUNCTION public.catalog_cards_in_set(text, text) TO anon, authenticated;

-- ============================================================
-- Verify:
--   -- Should include sm12, swsh7, base4, etc. in addition to en-* sets
--   SELECT * FROM catalog_sets_summary('en-') ORDER BY total DESC LIMIT 20;
--   -- Should return cards for legacy bare-set-code sets too
--   SELECT * FROM catalog_cards_in_set('en-', 'sm12') LIMIT 5;
--   -- Counts before/after should diverge for EN, match for everything else
--   SELECT COUNT(*) FROM catalog WHERE is_pokemon_en_id(id);
--   SELECT COUNT(*) FROM catalog WHERE id ILIKE 'en-%';
-- ============================================================
