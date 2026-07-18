-- ============================================================
-- PathBinder — flag Reverse Holo printings for ME05 "Pitch Black"
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- WHY
-- ---
-- catalog.has_reverse_holo drives the "Reverse Holo" variant chip (add-to-
-- collection / binder) and the Reverse Holo line in set completion. It's
-- normally set by sync_tcgplayer_via_free_apis.py from pokemontcg.io's
-- `reverseHolofoil` price key — but that sync matches on set_code, and our
-- catalog stores this set as 'ME05' while pokemontcg uses 'me5', so a plain
-- `--game pokemon` run skips every ME05 row. pokemontcg.io's per-card
-- reverse-holo prices are also still sparse for this brand-new set.
--
-- RULE (reliable for modern SV-era main expansions): every Common, Uncommon,
-- and Rare has a Reverse Holo; the special rarities (Double Rare, Illustration
-- Rare, Ultra Rare, Special Illustration Rare, Mega Hyper Rare) are holo-only
-- and have none. ME05's rarities fit this exactly (37 Common + 26 Uncommon +
-- 11 Rare = 74 RH printings; 46 special-rarity cards with none).
--
-- Idempotent. Re-run safe.
-- ============================================================

UPDATE public.catalog
SET has_reverse_holo = TRUE
WHERE set_code = 'ME05'
  AND game_type = 'pokemon'
  AND rarity IN ('Common', 'Uncommon', 'Rare');

-- Belt-and-suspenders: make sure the special rarities are explicitly FALSE
-- (they should never have shown an RH chip, but don't leave them NULL).
UPDATE public.catalog
SET has_reverse_holo = FALSE
WHERE set_code = 'ME05'
  AND game_type = 'pokemon'
  AND (rarity IS NULL OR rarity NOT IN ('Common', 'Uncommon', 'Rare'))
  AND has_reverse_holo IS DISTINCT FROM FALSE;

-- Verify:
--   SELECT rarity, has_reverse_holo, count(*) FROM catalog
--    WHERE set_code='ME05' GROUP BY 1,2 ORDER BY 1;
--   -- Common/Uncommon/Rare -> true (74 total); everything else -> false.
--   After this + a page reload: the Reverse Holo chip appears on those cards,
--   and the set-detail bar shows "Reverse Holo: 0 / 74".
-- ============================================================
