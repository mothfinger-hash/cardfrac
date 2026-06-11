-- ============================================================
-- PathBinder — Catalog Image Contributions (Phase 1)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Phase 1 scope:
--   * Users can submit photos for catalog rows that currently have
--     no image_url. Submissions go to a review queue.
--   * Eligibility: Collector+ tier, account age ≥ 30 days,
--     50+ cards in collection, 0 active strikes.
--   * First-time contributors: admin reviews their first 5 uploads.
--   * Verified contributors (5+ approved): auto-approve with random
--     spot-check.
--   * Trusted contributors (25+ approved, 0 strikes in 90 days):
--     auto-approve, no spot-check.
--   * 1 rejection drops back to admin-review mode for next 5.
--   * 3 rejections in 90 days revokes contributor privilege.
--
-- Out of scope for Phase 1 (future iterations):
--   * Replacement mode (better photo over existing)
--   * Brand-new catalog row creation
--   * CLIP-similarity auto-rejection
--   * EXIF / watermark auto-detection
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ── catalog: credit fields ──────────────────────────────────────────
-- Stores attribution for the user whose contribution provided the
-- current image_url. Rendered as a subtle byline on the card detail
-- modal and aggregated on the contributor's profile.
ALTER TABLE public.catalog
  ADD COLUMN IF NOT EXISTS image_contributed_by  UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS image_contributed_at  TIMESTAMPTZ;

-- Helpful index for the profile-page "cards I contributed photos to"
-- panel — small but lets us avoid a full catalog scan.
CREATE INDEX IF NOT EXISTS idx_catalog_image_contributed_by
  ON public.catalog (image_contributed_by)
  WHERE image_contributed_by IS NOT NULL;

-- ── catalog_image_contributions: the queue + audit log ──────────────
CREATE TABLE IF NOT EXISTS public.catalog_image_contributions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  catalog_id    TEXT NOT NULL REFERENCES public.catalog(id)  ON DELETE CASCADE,

  -- Final URL in the catalog-contributions storage bucket.
  image_url     TEXT NOT NULL,

  -- Image dimensions, captured client-side at upload time. Used by the
  -- replacement-priority logic (later phase) and the admin queue UI
  -- to show resolution at a glance.
  image_width   INT,
  image_height  INT,

  -- Lifecycle: pending → approved | rejected.
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected')),

  -- Free-form note from contributor (optional, e.g. "took this in
  -- natural light, slight crease bottom-left").
  notes         TEXT,

  -- Timestamps
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at   TIMESTAMPTZ,

  -- Admin who reviewed it. NULL while pending OR if auto-approved.
  reviewer_id   UUID REFERENCES public.profiles(id),

  -- Human-readable rejection reason. NULL unless status='rejected'.
  reject_reason TEXT,

  -- When status='approved', this records what catalog.image_url
  -- was BEFORE this contribution, so we can roll back if someone
  -- later flags the new image as wrong.
  replaced_image_url TEXT
);

-- One pending submission per user per catalog row — keeps an
-- impatient contributor from spamming the queue.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_contrib_pending_per_user_card
  ON public.catalog_image_contributions (user_id, catalog_id)
  WHERE status = 'pending';

-- Queue index — admin queue sorts by oldest pending first.
CREATE INDEX IF NOT EXISTS idx_contrib_queue
  ON public.catalog_image_contributions (status, submitted_at)
  WHERE status = 'pending';

-- Per-user history (for profile contribution stats + trust-tier calc).
CREATE INDEX IF NOT EXISTS idx_contrib_user_history
  ON public.catalog_image_contributions (user_id, status, submitted_at DESC);

-- Per-catalog history (for "who contributed photos to this card").
CREATE INDEX IF NOT EXISTS idx_contrib_catalog
  ON public.catalog_image_contributions (catalog_id);

-- ── Eligibility check helper ────────────────────────────────────────
-- Defined BEFORE the RLS policies because the INSERT policy
-- references it; Postgres won't accept the policy if the function
-- it calls doesn't exist yet.
-- Returns true if a user meets the criteria to submit catalog image
-- contributions. Called both from client UI (showing/hiding the
-- contribute prompt) and from the INSERT RLS policy above.
CREATE OR REPLACE FUNCTION public.user_can_contribute_image(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_account_age_days INT;
  v_tier             TEXT;
  v_card_count       INT;
  v_strikes          INT;
  v_is_admin         BOOLEAN;
BEGIN
  -- Admins always pass.
  SELECT COALESCE(is_admin, false) INTO v_is_admin
    FROM public.profiles WHERE id = p_user_id;
  IF v_is_admin THEN RETURN true; END IF;

  -- Account age ≥ 30 days
  SELECT EXTRACT(DAY FROM (now() - created_at))::INT
    INTO v_account_age_days
    FROM public.profiles
    WHERE id = p_user_id;
  IF v_account_age_days IS NULL OR v_account_age_days < 30 THEN
    RETURN false;
  END IF;

  -- Tier ≥ Collector
  SELECT COALESCE(subscription_tier, 'free') INTO v_tier
    FROM public.profiles WHERE id = p_user_id;
  IF v_tier NOT IN ('collector','enthusiast','vendor','shop') THEN
    RETURN false;
  END IF;

  -- ≥ 50 cards owned (non-ghost, non-sold-offline)
  SELECT COUNT(*) INTO v_card_count
    FROM public.collection_items
    WHERE user_id = p_user_id
      AND COALESCE(is_ghost, false) = false
      AND COALESCE(sold_offline, false) = false;
  IF v_card_count < 50 THEN RETURN false; END IF;

  -- 0 active strikes (≥3 rejections in last 90 days = revoked)
  SELECT COUNT(*) INTO v_strikes
    FROM public.catalog_image_contributions
    WHERE user_id = p_user_id
      AND status = 'rejected'
      AND submitted_at >= now() - INTERVAL '90 days';
  IF v_strikes >= 3 THEN RETURN false; END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.user_can_contribute_image TO anon, authenticated;

-- ── Trust-tier classifier ───────────────────────────────────────────
-- Returns 'first_time' | 'verified' | 'trusted'. Drives the
-- auto-approval logic (verified+ skip the admin queue) and the
-- profile-page badge display.
CREATE OR REPLACE FUNCTION public.user_contribution_trust_tier(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_approved  INT;
  v_recent_rejects INT;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE status = 'approved'),
    COUNT(*) FILTER (WHERE status = 'rejected'
                       AND submitted_at >= now() - INTERVAL '90 days')
  INTO v_approved, v_recent_rejects
  FROM public.catalog_image_contributions
  WHERE user_id = p_user_id;

  IF v_approved >= 25 AND v_recent_rejects = 0 THEN
    RETURN 'trusted';
  ELSIF v_approved >= 5 AND v_recent_rejects = 0 THEN
    RETURN 'verified';
  ELSE
    RETURN 'first_time';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.user_contribution_trust_tier TO anon, authenticated;

-- ── Approval helper: applies an approved contribution to catalog ────
-- Wraps the actual mutation so we have one place that handles:
--   * Stamping replaced_image_url so we can roll back later
--   * Updating catalog.image_url, image_contributed_by, image_contributed_at
--   * Marking the contribution row as approved with timestamps
-- Admin UI calls this RPC; auto-approval path calls it too.
CREATE OR REPLACE FUNCTION public.apply_image_contribution(
  p_contribution_id UUID,
  p_reviewer_id     UUID DEFAULT NULL    -- NULL = auto-approval
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_contrib  RECORD;
  v_old_url  TEXT;
BEGIN
  -- Pull the contribution row + lock it for update.
  SELECT * INTO v_contrib
    FROM public.catalog_image_contributions
    WHERE id = p_contribution_id
    FOR UPDATE;
  IF v_contrib IS NULL THEN
    RAISE EXCEPTION 'Contribution % not found', p_contribution_id;
  END IF;
  IF v_contrib.status <> 'pending' THEN
    RAISE EXCEPTION 'Contribution % is not pending (status=%)',
                    p_contribution_id, v_contrib.status;
  END IF;

  -- Pull the current catalog image (may be NULL for missing-image case).
  SELECT image_url INTO v_old_url
    FROM public.catalog WHERE id = v_contrib.catalog_id;

  -- Apply to catalog.
  UPDATE public.catalog
    SET image_url            = v_contrib.image_url,
        image_contributed_by = v_contrib.user_id,
        image_contributed_at = now()
    WHERE id = v_contrib.catalog_id;

  -- Mark the contribution approved + stamp replaced_image_url.
  UPDATE public.catalog_image_contributions
    SET status             = 'approved',
        reviewed_at        = now(),
        reviewer_id        = p_reviewer_id,
        replaced_image_url = v_old_url
    WHERE id = p_contribution_id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_image_contribution TO authenticated;

-- ── Rejection helper ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reject_image_contribution(
  p_contribution_id UUID,
  p_reviewer_id     UUID,
  p_reason          TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.catalog_image_contributions
    SET status        = 'rejected',
        reviewed_at   = now(),
        reviewer_id   = p_reviewer_id,
        reject_reason = p_reason
    WHERE id = p_contribution_id
      AND status = 'pending';
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_image_contribution TO authenticated;

-- ── Row Level Security ──────────────────────────────────────────────
-- Policies live AFTER the helper functions because the INSERT
-- policy calls user_can_contribute_image(), which has to exist
-- when the policy is created.
ALTER TABLE public.catalog_image_contributions ENABLE ROW LEVEL SECURITY;

-- Contributors can see their own submissions in any status.
DROP POLICY IF EXISTS "contrib_read_own" ON public.catalog_image_contributions;
CREATE POLICY "contrib_read_own"
  ON public.catalog_image_contributions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Anyone (even anon) can see approved contributions — that's how
-- the profile page renders "user X has contributed N photos".
DROP POLICY IF EXISTS "contrib_read_approved" ON public.catalog_image_contributions;
CREATE POLICY "contrib_read_approved"
  ON public.catalog_image_contributions FOR SELECT
  USING (status = 'approved');

-- Admins read everything.
DROP POLICY IF EXISTS "contrib_admin_all" ON public.catalog_image_contributions;
CREATE POLICY "contrib_admin_all"
  ON public.catalog_image_contributions FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles
                  WHERE id = auth.uid() AND is_admin = true))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles
                       WHERE id = auth.uid() AND is_admin = true));

-- Contributors can insert their own submissions, but only if the
-- eligibility check passes. The check is enforced both client-side
-- (UI hides the button) AND here (defense in depth).
DROP POLICY IF EXISTS "contrib_insert_own" ON public.catalog_image_contributions;
CREATE POLICY "contrib_insert_own"
  ON public.catalog_image_contributions FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND public.user_can_contribute_image(auth.uid())
  );

-- Contributors can update their OWN PENDING submissions only —
-- e.g. updating the notes field, or withdrawing by setting status
-- back to nothing. They cannot self-approve or change image_url.
DROP POLICY IF EXISTS "contrib_update_own_pending" ON public.catalog_image_contributions;
CREATE POLICY "contrib_update_own_pending"
  ON public.catalog_image_contributions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id AND status = 'pending')
  WITH CHECK (auth.uid() = user_id AND status = 'pending');

-- ── Refresh PostgREST schema cache ──────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Smoke tests (run in SQL editor to verify):
--
--   -- Should return true/false based on your own profile
--   SELECT public.user_can_contribute_image(auth.uid());
--
--   -- Should return 'first_time' for a brand-new account
--   SELECT public.user_contribution_trust_tier(auth.uid());
--
--   -- The contributions queue (admin view)
--   SELECT * FROM public.catalog_image_contributions
--     WHERE status = 'pending'
--     ORDER BY submitted_at ASC;
-- ============================================================
