-- ============================================================
-- PathBinder — Follow system
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Per-direction follows. follower_id is following followed_id. Order
-- preserved via sort_order so users can drag-rank their "favorite
-- sellers / friends" list the same way they rank user binders.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.follows (
  follower_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  followed_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  sort_order   int         NOT NULL DEFAULT 0,
  nickname     text,                  -- optional user-set label for grouping
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);

COMMENT ON TABLE public.follows IS
  'Per-direction follow relationship. sort_order persists the user-defined rank for their personal Follows list.';

CREATE INDEX IF NOT EXISTS idx_follows_follower ON public.follows (follower_id, sort_order ASC);
CREATE INDEX IF NOT EXISTS idx_follows_followed ON public.follows (followed_id);

ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

-- A user manages their own follow rows (insert/update/delete). Anyone
-- authenticated can READ any follow row (so follow counts work).
DROP POLICY IF EXISTS "Users manage their own follows" ON public.follows;
CREATE POLICY "Users manage their own follows"
  ON public.follows FOR ALL
  TO authenticated
  USING (follower_id = auth.uid())
  WITH CHECK (follower_id = auth.uid());

DROP POLICY IF EXISTS "Anyone reads follows" ON public.follows;
CREATE POLICY "Anyone reads follows"
  ON public.follows FOR SELECT
  TO anon, authenticated USING (true);


-- Convenience view for follower counts. Cheap; cached by Postgres.
CREATE OR REPLACE VIEW public.follow_counts AS
  SELECT followed_id AS user_id, count(*)::int AS follower_count
  FROM public.follows
  GROUP BY followed_id;

GRANT SELECT ON public.follow_counts TO anon, authenticated;


-- ============================================================
-- Verify:
--   SELECT count(*) FROM follows;
--   SELECT * FROM follow_counts LIMIT 5;
-- ============================================================
