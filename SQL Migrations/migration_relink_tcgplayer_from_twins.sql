-- ============================================================
-- PathBinder — relink TCGplayer comps from dual-shard twins
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- THE PROBLEM
-- -----------
-- Modern EN cards exist TWICE in catalog: the canonical row the app shows
-- (en-/jp-/pd- prefix) and a stale legacy twin (bare id, e.g. 'base5-21').
-- The two share a pricecharting_id. TCGplayer data — catalog.tcgplayer_url +
-- the card_prices tcgplayer rows — often landed on the LEGACY twin, so the
-- binder/store card detail (which reads by the CANONICAL id) shows
-- PriceCharting but no TCGplayer comp.
--   Example: Dark Charizard is shown as 'en-tr-21' (tcgplayer_url NULL, no
--   card_prices) while its twin 'base5-21' (same pricecharting_id 1341826)
--   carries the tcgplayer_url (product 84573) AND the card_prices rows.
--
-- The client already renders a TCGplayer link from catalog.tcgplayer_url
-- (falling back to a name search) — this migration upgrades that to the EXACT
-- product link AND restores the market PRICE for the ~1.7–2.2k canonical rows
-- whose data sits on a twin.
--
-- Idempotent: fills only gaps (canonical rows still missing the data) and
-- never inserts a duplicate card_prices source. Re-running is a no-op.
-- The real long-term fix is retiring the legacy shard entirely (see the
-- "legacy catalog shard" task) — this is the surgical stopgap for comps.
-- ============================================================

-- ── Part 1: relink catalog.tcgplayer_url + tcgplayer_product_id ──────────
-- Copy the exact product link from the twin onto the canonical row. DISTINCT
-- ON picks one deterministic donor per pricecharting_id (lowest id) when a
-- pricecharting_id has several rows carrying a URL.
UPDATE public.catalog AS canon
SET tcgplayer_url        = t.tcgplayer_url,
    tcgplayer_product_id = t.tcgplayer_product_id
FROM (
  SELECT DISTINCT ON (pricecharting_id)
         pricecharting_id, tcgplayer_url, tcgplayer_product_id
  FROM public.catalog
  WHERE tcgplayer_url IS NOT NULL
    AND pricecharting_id IS NOT NULL
  ORDER BY pricecharting_id, id
) AS t
WHERE t.pricecharting_id = canon.pricecharting_id
  AND canon.tcgplayer_url IS NULL                 -- fill gaps only
  AND canon.pricecharting_id IS NOT NULL
  AND (canon.id LIKE 'en-%' OR canon.id LIKE 'jp-%' OR canon.id LIKE 'pd-%');

-- ── Part 2: copy the TCGplayer card_prices rows onto the canonical row ───
-- Gives the canonical row its market PRICE (not just a link). Takes the
-- FRESHEST card_prices row per (pricecharting_id, source) from any twin, and
-- skips a source the canonical row already has. currency/sample_size carried
-- through so the row is indistinguishable from a native sync write.
INSERT INTO public.card_prices
  (catalog_id, source, value, currency, source_url, recorded_at, sample_size)
SELECT canon.id, d.source, d.value, d.currency, d.source_url, d.recorded_at, d.sample_size
FROM public.catalog AS canon
JOIN (
  SELECT DISTINCT ON (c.pricecharting_id, cp.source)
         c.pricecharting_id, cp.source, cp.value, cp.currency,
         cp.source_url, cp.recorded_at, cp.sample_size
  FROM public.catalog AS c
  JOIN public.card_prices AS cp ON cp.catalog_id = c.id
  WHERE c.pricecharting_id IS NOT NULL
    AND cp.source LIKE 'tcgplayer%'
  ORDER BY c.pricecharting_id, cp.source, cp.recorded_at DESC
) AS d ON d.pricecharting_id = canon.pricecharting_id
WHERE (canon.id LIKE 'en-%' OR canon.id LIKE 'jp-%' OR canon.id LIKE 'pd-%')
  AND canon.pricecharting_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.card_prices AS x
    WHERE x.catalog_id = canon.id AND x.source = d.source
  );

-- ── Verify ──────────────────────────────────────────────────────────────
-- Dark Charizard should now carry the twin's link + a tcgplayer price:
--   SELECT id, tcgplayer_url, tcgplayer_product_id FROM catalog WHERE id='en-tr-21';
--     -> tcgplayer_url populated, tcgplayer_product_id = 84573
--   SELECT source, value FROM card_prices WHERE catalog_id='en-tr-21' AND source LIKE 'tcgplayer%';
--     -> at least one tcgplayer row with a value
-- Coverage (measured pre-migration): ~2.2k rows gain an exact link (Part 1),
-- ~1.7k rows gain a TCGplayer price (Part 2). Rows whose twin has no TCGplayer
-- data at all stay link-only via the client's name-search fallback.
-- ============================================================
