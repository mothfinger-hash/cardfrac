-- ============================================================
-- PathBinder — clear COLLIDED pricecharting_ids (structural, no PC API)
-- Run in: Supabase Dashboard → SQL Editor → New query
-- RUN AFTER re-running migration_current_value_from_tcgplayer.sql (see NOTE).
--
-- WHY
-- ---
-- A pricecharting_id shared by >1 distinct catalog row is DEFINITIVELY wrong
-- for all-but-one of them — one PC product cannot be dozens of different cards.
-- This is the ~35% collision cohort from the fuzzy (console, number) match,
-- detectable purely from our own DB (GROUP BY ... HAVING count>1) — no ~30h of
-- PriceCharting API calls. Zero false positives.
--
-- SCOPE = ENGLISH ONLY (id NOT LIKE 'jp-%'). Two reasons:
--   1. The strict re-linker (enrich_from_pc_csv.py --strict) rebuilds cleared
--      ids from the ENGLISH pokemon-cards CSV, so English collisions can be
--      re-linked right away. Japanese cards aren't in that CSV.
--   2. Japanese cards have almost NO TCGplayer fallback (161 / 18,988), so PC
--      is their ONLY price source. Clearing them before the JP re-link pipeline
--      exists would blank ~thousands of prices with no near-term recovery.
-- Japanese collisions are handled in a Phase 2 pass once a JP console→set
-- crosswalk + the pokemon-japanese-cards CSV are wired. To include JP later,
-- delete the `AND c.id NOT LIKE 'jp-%'` line.
--
-- current_value: PRESERVED for TCGplayer-sourced rows (the spine); NULLed only
-- for English rows whose value came from the poisoned PC id (blank beats wrong).
--
-- NOTE: audit_pricecharting_ids.py --clear-bad NULLs current_value on every
-- suspect, including TCGplayer-backed rows. If you ran it, re-run
-- migration_current_value_from_tcgplayer.sql FIRST to restore those. Idempotent.
-- ============================================================

-- ── DRY RUN (run alone first — writes nothing) ─────────────────────────────
--   WITH dupe AS (
--     SELECT pricecharting_id FROM public.catalog
--     WHERE pricecharting_id IS NOT NULL
--     GROUP BY pricecharting_id HAVING count(*) > 1
--   )
--   SELECT
--     count(*) FILTER (WHERE c.id NOT LIKE 'jp-%')                         AS en_collided_rows,
--     count(*) FILTER (WHERE c.id LIKE 'jp-%')                             AS jp_collided_deferred,
--     count(*) FILTER (WHERE c.id NOT LIKE 'jp-%'
--                      AND c.market_price_source = 'tcgplayer')            AS en_keep_tcg_value,
--     count(*) FILTER (WHERE c.id NOT LIKE 'jp-%'
--                      AND c.market_price_source IS DISTINCT FROM 'tcgplayer') AS en_blank_pc_value
--   FROM public.catalog c JOIN dupe d ON d.pricecharting_id = c.pricecharting_id;

-- ── APPLY (English collisions only) ────────────────────────────────────────
WITH dupe AS (
  SELECT pricecharting_id
  FROM public.catalog
  WHERE pricecharting_id IS NOT NULL
  GROUP BY pricecharting_id
  HAVING count(*) > 1
)
UPDATE public.catalog c
SET pricecharting_id = NULL,
    current_value = CASE
      WHEN c.market_price_source = 'tcgplayer' THEN c.current_value  -- keep TCG spine
      ELSE NULL                                                       -- drop poisoned PC value
    END
FROM dupe
WHERE c.pricecharting_id = dupe.pricecharting_id
  AND c.id NOT LIKE 'jp-%';   -- Phase 1: English only; JP handled once its pipeline exists

-- Verify:
--   SELECT count(*) FROM catalog
--    WHERE id NOT LIKE 'jp-%' AND pricecharting_id IN (
--      SELECT pricecharting_id FROM catalog
--      WHERE pricecharting_id IS NOT NULL GROUP BY 1 HAVING count(*)>1
--    );
--   -- expect 0 English shared ids remain. Then run:
--   --   enrich_from_pc_csv.py --category pokemon-cards --tcg pokemon --strict
-- ============================================================
