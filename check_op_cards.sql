-- Now that we know OP12 (127 rows) and OP-PR (419 rows) both exist,
-- check whether the specific cards we want are there. Both number
-- formats — padded ('108') and the full SETCODE-NUMBER string.

-- ── 1. Trafalgar Law in OP-PR / op-promo ────────────────────────────
SELECT id, name, set_name, set_code, card_number, rarity, image_url
FROM public.catalog
WHERE game_type = 'onepiece'
  AND name ILIKE '%trafalgar%law%'
  AND set_code IN ('OP-PR', 'op-promo')
ORDER BY card_number;

-- ── 2. Rosinante in OP12 (any variant) ──────────────────────────────
SELECT id, name, set_name, set_code, card_number, rarity, image_url
FROM public.catalog
WHERE game_type = 'onepiece'
  AND name ILIKE '%rosinante%'
  AND set_code IN ('OP12', 'OP12 RE')
ORDER BY card_number;

-- ── 3. Bonus — every Rosinante anywhere in OP catalog ───────────────
-- This tells us if the v473/v474 dedupe might be over-collapsing
-- across sets. If you see 12+ rows here, the scan's 12 name-only
-- hits matches and nothing was wrongly dropped.
SELECT id, name, set_name, set_code, card_number
FROM public.catalog
WHERE game_type = 'onepiece'
  AND name ILIKE '%rosinante%'
ORDER BY set_code, card_number;
