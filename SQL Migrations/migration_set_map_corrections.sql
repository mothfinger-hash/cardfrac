-- ============================================================
-- PathBinder — set_map corrections (2 rows)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- PREREQUISITE for the PokeData-shard preference in loadSetDetail.
-- Run this BEFORE deploying that change or the 1999 Base Set renders
-- Scarlet & Violet cards.
--
-- Why
-- ---
-- public.set_map bridges pokemontcg.io's set id (ptcg_code, e.g.
-- 'sv3pt5') to PokeData's set code (pd_code, e.g. 'MEW'). The catalog
-- stores most modern EN sets TWICE: a stale legacy shard keyed by
-- ptcg_code (ids like 'sv3pt5-24', truncated at card #99, unmirrored
-- images) and the canonical PokeData shard keyed by pd_code (ids like
-- 'en-mew-001', complete, mirrored images). set_map is how the app
-- finds the good one, and loadSetDetail takes whichever shard has MORE
-- cards.
--
-- build_set_map.py populated set_map with a fuzzy NAME matcher, which
-- collided. All 138 rows were audited by CONTENT — comparing card names
-- at each card number against combined_final.xlsx — not by name.
--
-- Only rows where the pd shard is LARGER than the legacy shard can
-- actually change what renders; a wrong mapping at a smaller target
-- never wins the comparison and stays inert. Exactly two rows are both
-- wrong AND larger. Those are the two fixed here.
-- ============================================================

-- ── 1. base1: the 1999 Base Set was mapped to Scarlet & Violet ──
-- 'SVI' = "Scarlet & Violet Base" (258 rows). Agreement 0/102 — card #1
--         is 'Alakazam' upstream and 'Pineco' in SVI. The fuzzy matcher
--         collided on the word "Base". SVI (258) BEATS base1's legacy
--         shard (102), so this one would really fire.
-- 'BS'  = "Base Set Unlimited" (101 rows). Agreement 79%, and every
--         mismatch is a Holo suffix ('Alakazam' vs 'Alakazam Holo').
--         101 < 102, so base1 correctly keeps serving its own shard.
UPDATE public.set_map
   SET pd_code = 'BS', set_name = 'Base Set Unlimited'
 WHERE ptcg_code = 'base1' AND pd_code IS DISTINCT FROM 'BS';

-- ── 2. sv1: Scarlet & Violet Base was mapped to its own Promos ──
-- 'SVP' = "Scarlet & Violet Promos". Agreement 3/217 — card #1 is
--         'Pineco' upstream and 'Sprigatito' in SVP.
-- 'SVI' = "Scarlet & Violet Base" (258 rows). Agreement 97%; the
--         mismatches are accents only ('Flabébé' vs 'Flabebe',
--         'Poké Ball' vs 'Poke Ball'). sv1's legacy shard is excluded
--         from EN queries entirely, so this set currently falls through
--         to the flaky pokemontcg.io backup; after this it serves 258
--         cards from our own catalog.
UPDATE public.set_map
   SET pd_code = 'SVI', set_name = 'Scarlet & Violet Base'
 WHERE ptcg_code = 'sv1' AND pd_code IS DISTINCT FROM 'SVI';

-- ============================================================
-- DELIBERATELY NOT CHANGED — these look wrong and are not.
-- Recorded so the next audit doesn't "fix" them:
--
--   dc1 -> DCR   Raw agreement scored 18%, but DCR IS Double Crisis.
--                PokeData drops the owner prefix: upstream "Team Magma's
--                Numel" is DCR's "Numel" at the same #1. Numbers run
--                1..34, matching the real 34-card set. Its 140 rows are
--                VARIANT rows (Reverse Holo etc.), which loadSetDetail's
--                existing padded/unpadded dedupe collapses back to 34.
--
--   col1 -> CL   Scored 35%, but CL IS Call of Legends — a holo-only
--                partial shard ('Clefable' vs 'Clefable Holo'), 35 rows
--                against the legacy shard's 73. Smaller, so it never wins
--                and col1 keeps serving its own 73.
--
--   ex3 -> M24   Genuinely WRONG: 'Dragon' (2003 EX era) matched to
--                "Mcdonald's Dragon Discovery" on the word "Dragon".
--                Left in place anyway: M24 has 15 rows against ex3's 100,
--                so it can never win the comparison. pd_code is NOT NULL,
--                so unmapping would mean deleting the row — and
--                cleanup_en_catalog.py treats the set of pd_codes as its
--                allowlist of valid set codes and DELETES catalog rows
--                outside it. Dropping this row would arm that script
--                against the 15 real en-m24-* McDonald's rows. Not worth
--                it for a mapping that is already inert.
--
-- WARNING: build_set_map.py upserts on ptcg_code and would re-introduce
-- both bugs above if re-run. Fix its matcher before running it again.
-- ============================================================

-- ============================================================
-- Verify — expect exactly:
--
--   SELECT ptcg_code, pd_code, set_name FROM public.set_map
--    WHERE ptcg_code IN ('base1','sv1','sv3pt5') ORDER BY ptcg_code;
--
--   base1  | BS   | Base Set Unlimited
--   sv1    | SVI  | Scarlet & Violet Base
--   sv3pt5 | MEW  | Pokemon Card 151      (was already correct)
-- ============================================================
