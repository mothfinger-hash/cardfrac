-- ============================================================
-- PathBinder — converge ME05 "Pitch Black" onto the pokemontcg 'me5' id
-- Run in: Supabase Dashboard → SQL Editor → New query
-- RUN THIS *AFTER*:  python3 mirror_set_logos.py --only me5
--
-- WHY
-- ---
-- Pitch Black was first surfaced with a stopgap set_metadata row id='ME05'
-- (the catalog set_code) because pokemontcg.io hadn't ingested the set. It has
-- now — as 'me5', with a real logo (mirrored by `mirror_set_logos.py --only
-- me5`, which upserts a set_metadata row id='me5' with the mirrored logo_url,
-- release_date 2026-07-17 and total 120).
--
-- That leaves TWO "Pitch Black" rows (the stopgap 'ME05' + the canonical
-- 'me5'), which would show the set twice. This removes the stopgap.
--
-- Card loading is unaffected: loadSetDetail('me5', 'Pitch Black') resolves cards
-- by catalog.set_name = 'Pitch Black' (the name-bridge used for every set whose
-- pokemontcg id != catalog set_code, e.g. me4/Chaos Rising -> 'CRI'). The
-- catalog rows keep set_code='ME05'; only the set_metadata id changes to 'me5'.
--
-- GUARDED so order/idempotency is safe: the stopgap is deleted ONLY once the
-- canonical 'me5' row exists, so running this before the mirror leaves the set
-- visible (no gap) and a re-run is a no-op.
-- ============================================================

DELETE FROM public.set_metadata
WHERE id = 'ME05'
  AND game_type = 'pokemon'
  AND EXISTS (SELECT 1 FROM public.set_metadata WHERE id = 'me5');

-- Verify:
--   SELECT id, name, release_date, logo_url FROM set_metadata
--    WHERE game_type='pokemon' AND name='Pitch Black';
--   -- expect ONE row: id='me5', a logo_url on our set-logos bucket,
--   -- release_date 2026-07-17. It sorts to the top of the EN Sets list, and
--   -- clicking it loads the 120 en-me05- cards via the set_name bridge.
-- ============================================================
