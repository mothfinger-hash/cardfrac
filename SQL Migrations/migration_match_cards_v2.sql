-- ============================================================
-- PathBinder — match_cards_v2 (TCG + language-aware embedding match)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Why this exists
-- ---------------
-- The original match_cards() RPC searches the entire catalog's
-- embedding space and returns the top N most similar cards by raw
-- cosine similarity. That worked fine when the catalog was Pokemon
-- EN only (~25K rows). Now with 6 TCGs × 5 Pokemon languages (over
-- 250K rows total), the embedding space is dense enough that
-- mediocre matches from the wrong TCG / wrong language float to the
-- top — symptom: scanning a Pokemon EN card returns suggestions
-- including Magic cards, Pokemon JP cards, etc.
--
-- This RPC adds two optional filters the frontend can pass:
--   p_game_type    — restrict to a single game_type (pokemon, magic,
--                    yugioh, onepiece, gundam, dbz, topps). NULL = no
--                    filter.
--   p_id_prefixes  — text[] of id prefixes to accept (e.g.
--                    ARRAY['en-'] for Pokemon EN, ARRAY['jp-', 'pd-']
--                    for Pokemon JP). NULL or empty array = no filter.
--                    Match is "id starts with ANY of these".
--
-- Both filters compose. When both are set, rows must satisfy BOTH.
--
-- Backward-compatible: the legacy match_cards() function is left in
-- place. Frontend tries v2 first, falls back to v1 if missing.
--
-- Idempotent — re-running is safe.

CREATE OR REPLACE FUNCTION public.match_cards_v2(
  query_embedding  vector(512),
  match_threshold  float    DEFAULT 0.18,
  match_count      int      DEFAULT 10,
  p_game_type      text     DEFAULT NULL,
  p_id_prefixes    text[]   DEFAULT NULL
)
RETURNS TABLE (
  id          text,
  name        text,
  set_name    text,
  card_number text,
  rarity      text,
  image_url   text,
  game_type   text,
  similarity  float
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.id,
    c.name,
    c.set_name,
    c.card_number,
    c.rarity,
    c.image_url,
    c.game_type,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.catalog c
  WHERE c.embedding IS NOT NULL
    AND (p_game_type IS NULL OR c.game_type = p_game_type)
    AND (
      -- No prefix filter, OR id starts with any of the listed prefixes.
      -- The empty-array case (cardinality 0) also passes through, so
      -- frontend code can use NULL or `[]` interchangeably.
      p_id_prefixes IS NULL
      OR cardinality(p_id_prefixes) = 0
      OR EXISTS (
        SELECT 1 FROM unnest(p_id_prefixes) px
        WHERE c.id LIKE px || '%'
      )
    )
    AND 1 - (c.embedding <=> query_embedding) >= match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_cards_v2(vector, float, int, text, text[])
  TO anon, authenticated;

-- Verification (run after creating, optional):
--   SELECT id, name, similarity FROM match_cards_v2(
--     (SELECT embedding FROM catalog WHERE id = 'en-base1-4'),
--     0.18, 5, 'pokemon', ARRAY['en-']
--   );
-- ...should return Charizard variants from Pokemon EN catalog only.
