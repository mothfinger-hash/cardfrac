-- check_op16_price_coverage.sql
-- Shows exactly which OP16 catalog rows got a PriceCharting price source
-- from the sync_pc_singles_enrich.py run, and which did not.
-- Run in: Supabase Dashboard -> SQL Editor.

-- 1) Headline coverage: how many of the 155 OP16 rows are priced?
SELECT
  count(*)                                              AS total_rows,
  count(*) FILTER (WHERE price_source_url IS NOT NULL)  AS has_price_url,
  count(*) FILTER (WHERE pricecharting_id IS NOT NULL)  AS has_pcid,
  count(*) FILTER (WHERE price_source_url IS NULL)      AS missing_price_url
FROM public.catalog
WHERE game_type = 'onepiece' AND set_code = 'OP16';

-- 2) Base cards vs alt-art/parallel/reprint rows (the "_p" / non-OP16 codes),
--    split by whether they have a price source. This is the key view —
--    expect base cards mostly priced, parallels mostly NOT.
SELECT
  CASE
    WHEN card_number LIKE '%\_p%' ESCAPE '\' THEN 'parallel/alt-art (_pN)'
    WHEN card_number NOT LIKE 'OP16-%'       THEN 'SP reprint (foreign set#)'
    ELSE 'base OP16'
  END                                                   AS row_kind,
  count(*)                                               AS rows,
  count(*) FILTER (WHERE price_source_url IS NOT NULL)   AS priced,
  count(*) FILTER (WHERE price_source_url IS NULL)       AS unpriced
FROM public.catalog
WHERE game_type = 'onepiece' AND set_code = 'OP16'
GROUP BY row_kind
ORDER BY row_kind;

-- 3) The exact gap: every OP16 row with NO price source, newest issue first.
SELECT id, name, card_number, rarity
FROM public.catalog
WHERE game_type = 'onepiece' AND set_code = 'OP16'
  AND price_source_url IS NULL
ORDER BY card_number;

-- 4) (Optional) Sanity check the 6 SP reprints — these were tagged set_code
--    OP16 but their PC entry is numbered under the origin set, so they may
--    have enriched the ORIGINAL base rows instead. Compare:
SELECT id, name, set_code, card_number, price_source_url IS NOT NULL AS priced
FROM public.catalog
WHERE game_type = 'onepiece'
  AND name IN ('Bartholomew Kuma','Cavendish','Charlotte Katakuri',
               'Tashigi','Ms. All Sunday','Portgas.D.Ace')
  AND (card_number LIKE 'EB04-054%' OR card_number LIKE 'OP10-045%'
    OR card_number LIKE 'OP11-067%' OR card_number LIKE 'OP14-029%'
    OR card_number LIKE 'OP14-084%' OR card_number LIKE 'ST15-005%')
ORDER BY card_number;
