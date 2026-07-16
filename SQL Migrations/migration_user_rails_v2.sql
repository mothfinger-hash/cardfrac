-- ============================================================
-- PathBinder — user_rails: every personalised Market rail in ONE call
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Supersedes user_gap_cards() (migration_user_gap_rails.sql), which only did
-- the "closest to done" rail. Same idea, five rails: a collection is a stated
-- intent, and the app already holds every fact needed to act on it.
--
-- RAIL KINDS
--   closest   set they're nearest finishing            (was user_gap_cards)
--   almost    sets with <= p_almost gaps left          "You're 2 away"
--   revholo   cards they own NORMAL of but not REVERSE HOLO
--   cheap     cheapest gaps across EVERY set           "under a dollar"
--   chase     single most valuable gap in the top set  aspiration
--   era       gaps in the era they actually collect    (needs release_date)
--
-- ONE call at Market load. Client groups by rail_kind. Same discipline as
-- CLAUDE.md's "Don't N+1 the marketplace render" — renderBrowse re-runs on
-- every keystroke and must never trigger a query.
--
-- Verified against a live account (117 cards) while designing:
--   closest -> MEP 7/49, then Ascended Heroes 8/295, Phantom Aria (Gundam)
--   cheap   -> Tyrantrum $0.15, Medicham $0.03 …
--   era     -> that account is 89% Modern; a generic "Vintage" rail would be
--              0% relevant to them, which is exactly why era is keyed to the
--              user's own skew rather than being a fixed shelf.
--
-- ERA IS EXPECTED TO RETURN NOTHING TODAY, by design, not by accident:
-- catalog.release_date is 0/11,099 on the en- shard (populated 90-100% for
-- jp-/mtg-/ygo-, which is why this still works for Magic and Yu-Gi-Oh
-- collectors). Backfilling it from tcgcsv's group publishedOn covers 62% of
-- en- rows and skews 87% Modern (5,984 modern / 508 mid / 357 vintage) — the
-- vintage cards live in the legacy bare-id shard. The rail lights up on its
-- own when the dates land; nothing here needs changing.
-- ============================================================

DROP FUNCTION IF EXISTS public.user_rails(uuid, int, int, int);

CREATE OR REPLACE FUNCTION public.user_rails(
  p_user     uuid,
  p_per_rail int DEFAULT 12,
  p_min_own  int DEFAULT 2,   -- 1 stray card is not a goal
  p_almost   int DEFAULT 12   -- "you're N away" threshold
)
RETURNS TABLE (
  rail_kind     text,
  rail_key      text,      -- set_code, era bucket, or '' for global rails
  rail_label    text,
  owned         int,
  total         int,
  gap_count     int,
  id            text,
  name          text,
  card_number   text,
  image_url     text,
  current_value numeric,
  game_type     text,
  variant       text,      -- 'reverse_holo' for the revholo rail, else 'normal'
  -- The CARD's own set, which is NOT rail_key: on the cheap/revholo/era rails
  -- the cards come from many sets, and the wishlist row needs each card's real
  -- set or it saves a ghost with a null set_name.
  card_set_code text,
  card_set_name text,
  ord           int
)
LANGUAGE sql
STABLE
AS $$
  WITH owned AS (
    -- DISTINCT cards, not rows: the two-row variant model means Normal +
    -- Reverse Holo of one card is two collection_items rows for one
    -- api_card_id. Counting rows would inflate every completion figure.
    SELECT DISTINCT ci.api_card_id AS cid
    FROM public.collection_items ci
    WHERE ci.user_id = p_user
      AND COALESCE(ci.is_ghost, false) = false      -- ghosts are the wishlist
      AND COALESCE(ci.sold_offline, false) = false
      AND ci.api_card_id IS NOT NULL
  ),
  -- Variant-aware: which cards do they hold in which finish? The revholo rail
  -- lives or dies on this distinction.
  owned_variants AS (
    SELECT ci.api_card_id AS cid, COALESCE(ci.variant, 'normal') AS variant
    FROM public.collection_items ci
    WHERE ci.user_id = p_user
      AND COALESCE(ci.is_ghost, false) = false
      AND COALESCE(ci.sold_offline, false) = false
      AND ci.api_card_id IS NOT NULL
    GROUP BY ci.api_card_id, COALESCE(ci.variant, 'normal')
  ),
  owned_sets AS (
    SELECT c.set_code, COUNT(*)::int AS owned
    FROM public.catalog c JOIN owned o ON o.cid = c.id
    WHERE c.set_code IS NOT NULL
    GROUP BY c.set_code
    HAVING COUNT(*) >= p_min_own
  ),
  set_totals AS (
    -- MIN(set_name) collapses sets whose rows disagree on the name (the
    -- '151' / '151.0' artifact). COALESCE(product_type,'single') is deliberate:
    -- `product_type <> 'single'` silently drops every NULL row, because
    -- NULL <> 'single' is NULL and WHERE rejects it. See CLAUDE.md.
    SELECT c.set_code, MIN(c.set_name) AS set_name, COUNT(*)::int AS total
    FROM public.catalog c
    WHERE c.set_code IN (SELECT set_code FROM owned_sets)
      AND COALESCE(c.product_type, 'single') IN ('single', 'tcg_single')
    GROUP BY c.set_code
  ),
  sets AS (
    SELECT t.set_code, t.set_name, os.owned, t.total,
           (t.total - os.owned) AS gap_count,
           (os.owned::numeric / NULLIF(t.total, 0)) AS pct
    FROM set_totals t JOIN owned_sets os ON os.set_code = t.set_code
    WHERE t.total > 0 AND os.owned < t.total
  ),
  -- every gap card the user could want, once — the base for most rails
  gaps AS (
    SELECT s.set_code, s.set_name, s.owned, s.total, s.gap_count, s.pct,
           c.id, c.name, c.card_number, c.image_url, c.current_value,
           c.game_type, c.release_date
    FROM sets s
    JOIN public.catalog c ON c.set_code = s.set_code
    WHERE COALESCE(c.product_type, 'single') IN ('single', 'tcg_single')
      AND c.current_value IS NOT NULL
      AND c.image_url IS NOT NULL
      -- NOT EXISTS, never NOT IN: NOT IN against a set holding a NULL
      -- returns zero rows and the whole rail silently vanishes.
      AND NOT EXISTS (SELECT 1 FROM owned o WHERE o.cid = c.id)
  ),
  -- the user's own era centre of gravity, so era is a mirror not a shelf
  my_era AS (
    SELECT CASE WHEN EXTRACT(YEAR FROM c.release_date) <= 2003 THEN 'vintage'
                WHEN EXTRACT(YEAR FROM c.release_date) <= 2015 THEN 'mid'
                ELSE 'modern' END AS era,
           COUNT(*) AS n
    FROM public.catalog c JOIN owned o ON o.cid = c.id
    WHERE c.release_date IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 1
  ),

  -- ── 1 · CLOSEST — the set they're nearest finishing
  r_closest AS (
    SELECT 'closest'::text AS rail_kind, g.set_code AS rail_key, g.set_name AS rail_label,
           g.owned, g.total, g.gap_count, g.id, g.name, g.card_number, g.image_url,
           g.current_value, g.game_type, 'normal'::text AS variant,
           g.set_code, g.set_name,
           ROW_NUMBER() OVER (ORDER BY g.current_value ASC)::int AS ord
    FROM gaps g
    WHERE g.set_code = (SELECT set_code FROM sets ORDER BY pct DESC, owned DESC LIMIT 1)
    ORDER BY g.current_value ASC LIMIT p_per_rail
  ),
  -- ── 2 · ALMOST — nothing motivates like 47 of 49
  r_almost AS (
    SELECT 'almost'::text, g.set_code, g.set_name, g.owned, g.total, g.gap_count,
           g.id, g.name, g.card_number, g.image_url, g.current_value, g.game_type,
           'normal'::text, g.set_code, g.set_name,
           ROW_NUMBER() OVER (ORDER BY g.gap_count ASC, g.current_value ASC)::int
    FROM gaps g
    WHERE g.gap_count <= p_almost
    ORDER BY g.gap_count ASC, g.current_value ASC LIMIT p_per_rail
  ),
  -- ── 3 · REVHOLO — a whole second collection they haven't started.
  -- Only PathBinder can build this: it needs catalog.has_reverse_holo AND the
  -- two-row variant model. 10,502 catalog cards have an RH printing.
  r_revholo AS (
    SELECT 'revholo'::text, c.set_code, MIN(c.set_name) OVER (PARTITION BY c.set_code),
           0, 0, 0,
           c.id, c.name, c.card_number, c.image_url, c.current_value, c.game_type,
           'reverse_holo'::text, c.set_code, c.set_name,
           ROW_NUMBER() OVER (ORDER BY c.current_value ASC)::int
    FROM public.catalog c
    WHERE c.has_reverse_holo = true
      AND c.image_url IS NOT NULL
      AND EXISTS (SELECT 1 FROM owned_variants ov
                   WHERE ov.cid = c.id AND ov.variant = 'normal')
      AND NOT EXISTS (SELECT 1 FROM owned_variants ov
                       WHERE ov.cid = c.id AND ov.variant = 'reverse_holo')
    ORDER BY c.current_value ASC NULLS LAST LIMIT p_per_rail
  ),
  -- ── 4 · CHEAP — cheapest gaps across EVERY set, not one. The impulse rail.
  r_cheap AS (
    SELECT 'cheap'::text, ''::text, 'Under a dollar'::text, 0, 0, 0,
           g.id, g.name, g.card_number, g.image_url, g.current_value, g.game_type,
           'normal'::text, g.set_code, g.set_name,
           ROW_NUMBER() OVER (ORDER BY g.current_value ASC)::int
    FROM gaps g
    WHERE g.current_value <= 1.00
    ORDER BY g.current_value ASC LIMIT p_per_rail
  ),
  -- ── 5 · CHASE — one card, the opposite of cheap. Aspiration, so it belongs
  -- LAST, after the shopping lists.
  r_chase AS (
    SELECT 'chase'::text, g.set_code, g.set_name, g.owned, g.total, g.gap_count,
           g.id, g.name, g.card_number, g.image_url, g.current_value, g.game_type,
           'normal'::text, g.set_code, g.set_name, 1::int
    FROM gaps g
    WHERE g.set_code = (SELECT set_code FROM sets ORDER BY pct DESC, owned DESC LIMIT 1)
    ORDER BY g.current_value DESC LIMIT 1
  ),
  -- ── 6 · ERA — keyed to THEIR skew. Returns nothing until release_date is
  -- backfilled on the en- shard; that is expected, not a failure.
  r_era AS (
    SELECT 'era'::text, (SELECT era FROM my_era),
           CASE (SELECT era FROM my_era)
             WHEN 'vintage' THEN 'Vintage you''re missing'
             WHEN 'mid'     THEN 'Mid-era you''re missing'
             ELSE                'Modern you''re missing' END,
           0, 0, 0,
           g.id, g.name, g.card_number, g.image_url, g.current_value, g.game_type,
           'normal'::text, g.set_code, g.set_name,
           ROW_NUMBER() OVER (ORDER BY g.current_value ASC)::int
    FROM gaps g
    WHERE (SELECT era FROM my_era) IS NOT NULL
      AND g.release_date IS NOT NULL
      AND (SELECT era FROM my_era) = CASE
            WHEN EXTRACT(YEAR FROM g.release_date) <= 2003 THEN 'vintage'
            WHEN EXTRACT(YEAR FROM g.release_date) <= 2015 THEN 'mid'
            ELSE 'modern' END
    ORDER BY g.current_value ASC LIMIT p_per_rail
  )
  SELECT * FROM r_closest
  UNION ALL SELECT * FROM r_almost
  UNION ALL SELECT * FROM r_revholo
  UNION ALL SELECT * FROM r_cheap
  UNION ALL SELECT * FROM r_era
  UNION ALL SELECT * FROM r_chase;   -- chase last: aspiration after the lists
$$;

GRANT EXECUTE ON FUNCTION public.user_rails(uuid, int, int, int) TO authenticated;

-- ============================================================
-- Verify (account d153555a-520a-4c57-9291-1b2653d56ffc, 117 cards):
--
--   SELECT rail_kind, rail_label, COUNT(*) AS cards,
--          ROUND(SUM(current_value),2) AS cost
--     FROM public.user_rails('d153555a-520a-4c57-9291-1b2653d56ffc')
--    GROUP BY rail_kind, rail_label ORDER BY rail_kind;
--   -- closest -> Mega Evolution Promos, 12 cards
--   -- cheap   -> Under a dollar
--   -- chase   -> 1 card, the priciest MEP gap
--   -- era     -> 0 rows TODAY (release_date empty on en-) — expected
--   -- revholo -> 0 rows unless they own a Normal whose card has_reverse_holo
--
--   -- a user with no collection returns zero rows, not an error:
--   SELECT COUNT(*) FROM public.user_rails('00000000-0000-0000-0000-000000000000');
--
-- COPY RULE: "10 cheapest gaps — $6.09" is true. "Close it for $6.09" is a lie
-- (that buys 10 of 42). Never write a cheque the number does not cash.
-- ============================================================
