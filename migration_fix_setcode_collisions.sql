-- ============================================================
-- PathBinder — Fix same-game set_code collisions
--
-- Background: the catalog has ~75 set_code collisions where two
-- different sets share the same code. The HIGHEST-IMPACT subset is
-- the ~12 cases where BOTH colliding sets are in the same game AND
-- the same language, so they share the same image storage path
-- (card-images/<lang>/<set_code>/<num>.webp). When the image mirror
-- script runs for set X, it overwrites set Y's image at the shared
-- path → users see the wrong card art for one of the two sets.
--
-- The visible symptom you spotted: "Charizard-EX (Generations #11)"
-- displays the Rocket's Hitmonchan (Gym Heroes 1st Edition #11)
-- artwork because both sets use set_code='g1' and Gym Heroes was
-- mirrored last.
--
-- This migration:
--   1. Re-tags one side of each colliding pair to a distinct
--      set_code that follows pokemontcg.io / Scryfall convention.
--   2. Clears image_url on BOTH sides of each pair so the next
--      backfill_image_variants.py run re-pulls fresh art to the
--      now-distinct paths.
--
-- The `id` column is NOT changed (keeps FK references to
-- collection_items.api_card_id, listings.api_card_id, etc. intact).
-- Only set_code + image_url change.
--
-- Cross-game collisions (Magic vs Pokemon, YGO vs One Piece, etc.)
-- are NOT in scope here. Those collide on set_code but live in
-- different image-storage namespaces because their language/game
-- prefix differs. They're cosmetically wrong in admin views but
-- don't break user-facing card art.
--
-- Run in: Supabase Dashboard → SQL Editor → New query.
-- Wrap in BEGIN/COMMIT manually if you want to inspect rowcounts
-- before persisting; each statement reports its rowcount via the
-- editor's status line.
-- ============================================================


-- ─── PHASE 1: g1 (Generations + Gym Heroes 1st Edition) ─────────────
-- Generations keeps g1 (matches pokemontcg.io).
-- Gym Heroes 1st Edition moves to gh1 (matches pokemontcg.io
-- shorthand; pokemontcg.io itself uses "gym1" but gh1 is internally
-- consistent with the pattern jungle→jg1, fossil→fo1, etc.).

update public.catalog
   set set_code = 'gh1',
       image_url = null
 where set_name = 'Gym Heroes 1st Edition'
   and set_code = 'g1';
-- expect: 83 rows updated

update public.catalog
   set image_url = null
 where set_name = 'Generations'
   and set_code = 'g1';
-- expect: 83 rows updated


-- ─── PHASE 2: same-game collisions (visible bugs) ──────────────────


-- PR — SEVEN different Pokemon promo sets share this code. Split
-- into per-era codes following pokemontcg.io convention.
update public.catalog set set_code = 'wp',    image_url = null
 where set_name = 'WOTC Promo' and set_code = 'PR';
update public.catalog set set_code = 'np',    image_url = null
 where set_name = 'Nintendo Black Star Promo' and set_code = 'PR';
update public.catalog set set_code = 'dpp',   image_url = null
 where set_name = 'Diamond and Pearl Promo' and set_code = 'PR';
update public.catalog set set_code = 'hsp',   image_url = null
 where set_name = 'HGSS Black Star Promo' and set_code = 'PR';
update public.catalog set set_code = 'bwp',   image_url = null
 where set_name = 'Black and White Promos' and set_code = 'PR';
update public.catalog set set_code = 'xyp',   image_url = null
 where set_name = 'XY Black Star Promos' and set_code = 'PR';
update public.catalog set set_code = 'aap',   image_url = null
 where set_name = 'Alternate Art Promos' and set_code = 'PR';


-- B — four Pokemon Battle Starter Decks share this code.
-- Each gets a distinct slug suffix.
update public.catalog set set_code = 'bsd-blastoise', image_url = null
 where set_name = 'Battle Starter Deck (Blastoise)' and set_code = 'B';
update public.catalog set set_code = 'bsd-magmortar', image_url = null
 where set_name = 'Battle Starter Deck (Magmortar)' and set_code = 'B';
update public.catalog set set_code = 'bsd-raichu',    image_url = null
 where set_name = 'Battle Starter Deck (Raichu)' and set_code = 'B';
update public.catalog set set_code = 'bsd-blastoise-2', image_url = null
 where set_name = 'Blastoise Starter Deck' and set_code = 'B';


-- HS+ — three Beginning Set Plus starter decks (Pokemon).
update public.catalog set set_code = 'hsp-oshawott', image_url = null
 where set_name = 'Beginning Set Plus (Oshawott)' and set_code = 'HS+';
update public.catalog set set_code = 'hsp-snivy',    image_url = null
 where set_name = 'Beginning Set Plus (Snivy)' and set_code = 'HS+';
update public.catalog set set_code = 'hsp-tepig',    image_url = null
 where set_name = 'Beginning Set Plus (Tepig)' and set_code = 'HS+';

-- HSP — collides with the now-renamed HGSS Black Star Promo above
-- as well as the three Beginning Set Pikachu starter decks (Pokemon).
-- Re-tag the Beginning Set Pikachu group; HGSS Promo above already
-- got the bare 'hsp' code.
update public.catalog set set_code = 'bsp-oshawott', image_url = null
 where set_name = 'Beginning Set Pikachu (Oshawott)' and set_code = 'HSP';
update public.catalog set set_code = 'bsp-snivy',    image_url = null
 where set_name = 'Beginning Set Pikachu (Snivy)' and set_code = 'HSP';
update public.catalog set set_code = 'bsp-tepig',    image_url = null
 where set_name = 'Beginning Set Pikachu (Tepig)' and set_code = 'HSP';


-- sA — three V Starter Sets (Pokemon).
update public.catalog set set_code = 'sa-grass',     image_url = null
 where set_name = 'V Starter Set (Grass)' and set_code = 'sA';
update public.catalog set set_code = 'sa-lightning', image_url = null
 where set_name = 'V Starter Set (Lightning)' and set_code = 'sA';
update public.catalog set set_code = 'sa-water',     image_url = null
 where set_name = 'V Starter Set (Water)' and set_code = 'sA';


-- promo — three sets across DIFFERENT games (Magic, OP, Pokemon)
-- using the literal slug 'promo'. They likely DON'T share image
-- paths (different game_types → different image namespaces) but
-- still worth disambiguating for admin clarity.
update public.catalog set set_code = 'mtg-promo', image_url = null
 where set_name = 'Magic Promo' and set_code = 'promo';
update public.catalog set set_code = 'op-promo',  image_url = null
 where set_name = 'One Piece Promotion' and set_code = 'promo';
update public.catalog set set_code = 'pkm-promo', image_url = null
 where set_name = 'Pokemon Promo' and set_code = 'promo';


-- WHO — both are Magic, both reference Doctor Who. The Planechase
-- variant gets a suffixed code.
update public.catalog set set_code = 'who-pch', image_url = null
 where set_name = 'Planechase: Universes Beyond: Doctor Who' and set_code = 'WHO';


-- MOC — both are Magic, both reference March of the Machine.
-- The Planechase variant gets a suffixed code.
update public.catalog set set_code = 'moc-pch', image_url = null
 where set_name = 'Planechase: March of the Machine' and set_code = 'MOC';


-- M21, M19, M15, M14, M11, M12 — Magic Core Sets keep the bare
-- code; McDonald's promos get a 'mcd-' suffix.
update public.catalog set set_code = 'mcd-2021', image_url = null
 where set_name = 'Mcdonald''s 25th Anniversary' and set_code = 'M21';
update public.catalog set set_code = 'mcd-2019', image_url = null
 where set_name = 'McDonald''s Promos 2019' and set_code = 'M19';
update public.catalog set set_code = 'mcd-2015', image_url = null
 where set_name = 'McDonald''s Promos 2015' and set_code = 'M15';
update public.catalog set set_code = 'mcd-2014', image_url = null
 where set_name = 'McDonald''s Promos 2014' and set_code = 'M14';
update public.catalog set set_code = 'mcd-2011', image_url = null
 where set_name = 'McDonald''s Promos 2011' and set_code = 'M11';
update public.catalog set set_code = 'mcd-2012', image_url = null
 where set_name = 'McDonald''s Promos 2012' and set_code = 'M12';


-- PRE — Prerelease Cards (legacy Magic) vs Prismatic Evolutions
-- (Pokemon). Different games but worth disambiguating.
update public.catalog set set_code = 'prer', image_url = null
 where set_name = 'Prerelease Cards' and set_code = 'PRE';


-- XY — Pokemon. "The Best of XY" is a smaller anthology vs XY Base.
update public.catalog set set_code = 'xy-best', image_url = null
 where set_name = 'The Best of XY' and set_code = 'XY';


-- swsh7, swsh8, swsh9, swsh10, swsh11, swsh12, swsh12pt5 — all
-- Pokemon duplicates where one row has the "Pokemon " prefix and
-- the other doesn't. These are TRUE DUPLICATES that should be
-- merged in Phase 3 (data dedup), not just renamed. Skipping in
-- this migration to avoid hiding the problem with cosmetic renames.

-- sv1, sv2, sv3, sv4, sv4pt5, sv5, sv6, sv6pt5, sv7, sv8, sv8pt5,
-- svp, SSP — same true-duplicate pattern as above. Out of scope
-- for Phase 1+2; will get a separate dedup pass.

-- 1999-topps-movie, 1999-topps-tv, 2000-topps-chrome, 2000-topps-tv —
-- same true-duplicate pattern.

-- S12a (VSTAR Universe + VSTARユニバース) — true duplicate, EN/JP
-- pair that should be merged into per-language rows. Skipping.

-- LODT, RDS, DPCT, GBR, DPt, BPT, MOV, DP1, DP2, DP4, PCY, SOI,
-- SM9, DCR, YS13, Vs, Pt, KLD, CLB, LTR, MRD, OP01-14, WHO (above),
-- adventures-in-the-forgotten-real, legend-of-blue-eyes-white-dragon,
-- 25th-anniversary-rarity-collecti — cross-game OR genuinely
-- different products. They don't visibly collide because their
-- image paths are in different language/game namespaces. Left
-- alone for now; the disambiguation matters only for admin views.


-- ============================================================
-- Sanity check — after running, re-run this to confirm no
-- same-game collisions remain in the codes we touched:
--
--   select set_code, array_agg(distinct set_name) as set_names
--     from public.catalog
--    where set_code in ('g1','gh1','wp','np','dpp','hsp','bwp',
--                       'xyp','aap','bsd-blastoise','bsd-magmortar',
--                       'bsd-raichu','bsd-blastoise-2','hsp-oshawott',
--                       'hsp-snivy','hsp-tepig','bsp-oshawott',
--                       'bsp-snivy','bsp-tepig','sa-grass','sa-lightning',
--                       'sa-water','mtg-promo','op-promo','pkm-promo',
--                       'who-pch','moc-pch','mcd-2021','mcd-2019',
--                       'mcd-2015','mcd-2014','mcd-2011','mcd-2012',
--                       'prer','xy-best')
--    group by set_code
--   having count(distinct set_name) > 1;
--
-- Should return ZERO rows.
-- ============================================================
