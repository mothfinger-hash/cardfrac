-- ============================================================
-- PathBinder — personalised marketplace rails (user_gap_cards)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- What this is for
-- ----------------
-- The Market rails should be genuinely personal, not a taxonomy. A
-- collection IS a stated intent: owning 7 of the 49 Mega Evolution Promos
-- is a goal with 42 steps left. The app already holds that fact; it has
-- just never said it out loud.
--
-- This returns, in ONE call: the sets a user is closest to finishing, and
-- the cheapest cards in each that they do NOT own. No onboarding, no "pick
-- your goals" screen — it falls out of collection_items ∩ catalog.
--
-- Verified against a real account (117 cards) before writing this:
--     MEP   7/49  14%   Mega Evolution Promos   <- top rail
--     ASC   8/295  3%   Ascended Heroes
--     GD04  4/149  3%   Phantom Aria            <- Gundam; multi-TCG for free
--   cheapest MEP gaps: Tyrantrum $0.15, Mega Charizard Y ex $0.20,
--                      Chikorita Cosmos Holo $0.25 … 10 for $6.09
--
-- Why an RPC and not client-side
-- ------------------------------
-- collection_items is already in memory client-side, but set membership and
-- current_value live across ~193k catalog rows that are not. Doing this in
-- JS would mean shipping the catalog to the browser or an N+1 per set — the
-- exact thing CLAUDE.md's "Don't N+1 the marketplace render" warns about.
-- One RPC at Market load, same shape as catalog_sets_summary.
--
-- NOT filtered by game_type on purpose: the test account collects Pokemon,
-- Gundam AND One Piece. The rails should discover that, not assume Pokemon.
-- ============================================================

-- RE-RUN THIS IF YOU RAN THE FIRST VERSION. It gained a game_type column.
-- CREATE OR REPLACE cannot change a function's return type, so the old one
-- must be dropped first — without game_type the client files a Gundam gap
-- into the wishlist as 'pokemon' (saveToWishlist defaults it), and the test
-- account collects Pokemon, Gundam AND One Piece.
DROP FUNCTION IF EXISTS public.user_gap_cards(uuid, int, int, int);

CREATE OR REPLACE FUNCTION public.user_gap_cards(
  p_user     uuid,
  p_sets     int DEFAULT 4,    -- how many rails
  p_per_set  int DEFAULT 12,   -- cards per rail
  p_min_own  int DEFAULT 2     -- ignore sets with 1 stray card — not a goal
)
RETURNS TABLE (
  set_code      text,
  set_name      text,
  owned         int,
  total         int,
  pct           numeric,
  gap_count     int,
  id            text,
  name          text,
  card_number   text,
  image_url     text,
  current_value numeric,
  game_type     text          -- so "notify me" writes the right game on the ghost row
)
LANGUAGE sql
STABLE
AS $$
  WITH owned AS (
    -- Distinct CARDS, not rows: the two-row variant model means a user who
    -- owns Normal + Reverse Holo of one card has two collection_items rows
    -- for a single api_card_id. Counting rows would inflate completion.
    SELECT DISTINCT ci.api_card_id AS cid
    FROM public.collection_items ci
    WHERE ci.user_id = p_user
      AND COALESCE(ci.is_ghost, false) = false     -- ghosts are the WISHLIST, not owned
      AND COALESCE(ci.sold_offline, false) = false
      AND ci.api_card_id IS NOT NULL
  ),
  owned_sets AS (
    SELECT c.set_code, COUNT(*)::int AS owned
    FROM public.catalog c
    JOIN owned o ON o.cid = c.id
    WHERE c.set_code IS NOT NULL
    GROUP BY c.set_code
    HAVING COUNT(*) >= p_min_own
  ),
  set_totals AS (
    -- MIN(set_name) collapses sets whose rows disagree on the name (e.g. the
    -- '151' / '151.0' float-coercion artifact) so one set_code = one rail.
    -- COALESCE(product_type,'single') is deliberate: product_type IS NULL is
    -- common, and `product_type <> 'single'` would silently drop every NULL
    -- row (NULL <> 'single' is NULL, which WHERE rejects). See the
    -- product_type trap in CLAUDE.md.
    SELECT c.set_code, MIN(c.set_name) AS set_name, COUNT(*)::int AS total
    FROM public.catalog c
    WHERE c.set_code IN (SELECT set_code FROM owned_sets)
      AND COALESCE(c.product_type, 'single') IN ('single', 'tcg_single')
    GROUP BY c.set_code
  ),
  ranked AS (
    SELECT t.set_code, t.set_name, os.owned, t.total,
           ROUND(os.owned::numeric / NULLIF(t.total, 0), 4) AS pct,
           (t.total - os.owned) AS gap_count
    FROM set_totals t
    JOIN owned_sets os ON os.set_code = t.set_code
    WHERE t.total > 0
      AND os.owned < t.total          -- a finished set is not a rail
    ORDER BY (os.owned::numeric / NULLIF(t.total, 0)) DESC, os.owned DESC
    LIMIT p_sets
  )
  SELECT r.set_code, r.set_name, r.owned, r.total, r.pct, r.gap_count,
         g.id, g.name, g.card_number, g.image_url, g.current_value, g.game_type
  FROM ranked r
  CROSS JOIN LATERAL (
    -- Cheapest-first: "10 gaps for $6.09" is a shopping list. A random 12
    -- gaps is just a filter. NOT EXISTS rather than NOT IN — NOT IN against
    -- a set containing a NULL returns no rows at all.
    SELECT c.id, c.name, c.card_number, c.image_url, c.current_value, c.game_type
    FROM public.catalog c
    WHERE c.set_code = r.set_code
      AND COALESCE(c.product_type, 'single') IN ('single', 'tcg_single')
      AND c.current_value IS NOT NULL
      AND c.image_url IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM owned o WHERE o.cid = c.id)
    ORDER BY c.current_value ASC
    LIMIT p_per_set
  ) g
  ORDER BY r.pct DESC, g.current_value ASC;
$$;

GRANT EXECUTE ON FUNCTION public.user_gap_cards(uuid, int, int, int) TO authenticated;

-- Deliberately NOT granted to anon: this reads one user's collection. RLS on
-- collection_items already scopes rows to the owner, but a STABLE SQL function
-- runs as the caller, so an anon caller would simply get an empty set — no
-- point advertising it. authenticated only.

-- ============================================================
-- Verify — against the account used to design this (117 cards):
--
--   SELECT DISTINCT set_code, set_name, owned, total, pct, gap_count
--     FROM public.user_gap_cards('d153555a-520a-4c57-9291-1b2653d56ffc')
--    ORDER BY pct DESC;
--   -- expect MEP 7/49 (~0.14) at the top, then ASC 8/295, GD04 4/149
--
--   -- the top rail's actual contents, cheapest first:
--   SELECT name, card_number, current_value
--     FROM public.user_gap_cards('d153555a-520a-4c57-9291-1b2653d56ffc')
--    WHERE set_code = 'MEP' ORDER BY current_value ASC;
--   -- expect Tyrantrum 0.15, Mega Charizard Y ex 0.20, Chikorita 0.25 …
--
--   -- the headline number for the rail subtitle:
--   SELECT set_name, COUNT(*) AS shown, ROUND(SUM(current_value),2) AS cost
--     FROM public.user_gap_cards('d153555a-520a-4c57-9291-1b2653d56ffc')
--    GROUP BY set_name;
--
--   -- a user with no collection must return zero rows, not error:
--   SELECT COUNT(*) FROM public.user_gap_cards('00000000-0000-0000-0000-000000000000');
--
-- COPY WARNING for whoever builds the UI: "10 cheapest gaps — $6.09" is TRUE.
-- "close it for $6.09" is a LIE — that buys 10 of 42. Do not write cheques the
-- number does not cash; an over-promising rail is how a clever feature becomes
-- one users stop trusting.
-- ============================================================
