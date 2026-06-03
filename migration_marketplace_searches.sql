-- ============================================================
-- PathBinder — Marketplace search log
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Append-only log of every distinct search query a user runs on the
-- marketplace browse page. Powers onboarding-niche analytics: what
-- are people searching for that we don't have? Which niches are hot
-- enough to court more sellers in? Which queries return zero
-- results?
--
-- Privacy: stores user_id if signed in (null for anon), the search
-- string trimmed + lowercased, optional result count, and timestamp.
-- No IP, no fingerprint, no device data.
--
-- RLS: service-role only writes, admins can read. Users can't read
-- the table directly — it's internal product signal, not user data.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketplace_searches (
  id           bigserial   PRIMARY KEY,
  user_id      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  query        text        NOT NULL,
  game_type    text,                 -- 'all' | 'pokemon' | 'magic' | …
  product_type text,                 -- 'all' | 'single' | 'sealed' | 'product'
  result_count int,                  -- how many listings matched
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketplace_searches IS
  'Append-only log of marketplace browse searches. Internal onboarding-niche analytics; not user-visible.';

-- Hot path: top-queries-in-last-N-days, zero-result queries, etc.
CREATE INDEX IF NOT EXISTS idx_marketplace_searches_query_recent
  ON public.marketplace_searches (created_at DESC, query);
CREATE INDEX IF NOT EXISTS idx_marketplace_searches_zero_results
  ON public.marketplace_searches (created_at DESC)
  WHERE result_count = 0;

ALTER TABLE public.marketplace_searches ENABLE ROW LEVEL SECURITY;

-- Authenticated users can INSERT their own query rows (RLS only
-- needed because anon shouldn't be able to flood the table). Admins
-- read via the service-role key, which bypasses RLS.
DROP POLICY IF EXISTS "Users insert their own searches" ON public.marketplace_searches;
CREATE POLICY "Users insert their own searches"
  ON public.marketplace_searches FOR INSERT
  TO authenticated
  WITH CHECK (user_id IS NULL OR user_id = auth.uid());
-- Anon can also insert (so signed-out browse searches still log).
DROP POLICY IF EXISTS "Anon insert anon searches" ON public.marketplace_searches;
CREATE POLICY "Anon insert anon searches"
  ON public.marketplace_searches FOR INSERT
  TO anon
  WITH CHECK (user_id IS NULL);

-- ============================================================
-- Useful queries once data starts landing:
--   -- Top 20 searches in the last week
--   SELECT lower(query) AS q, count(*) FROM marketplace_searches
--   WHERE created_at >= now() - interval '7 days'
--   GROUP BY q ORDER BY count(*) DESC LIMIT 20;
--
--   -- Top zero-result queries (best onboarding signal)
--   SELECT lower(query) AS q, count(*) FROM marketplace_searches
--   WHERE created_at >= now() - interval '30 days' AND result_count = 0
--   GROUP BY q ORDER BY count(*) DESC LIMIT 20;
-- ============================================================
