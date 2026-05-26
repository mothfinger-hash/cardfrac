-- ============================================================
-- PathBinder — Server-side marketplace listing cap enforcement
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- The client-side cap check (canCreateListing in index.html) is the
-- primary UX gate, but a determined seller could bypass it by hitting
-- the Supabase REST API directly with a service-key-like token or by
-- patching the JS. This migration adds a Postgres trigger that
-- enforces the per-tier cap at insert time so the rule can't be
-- circumvented from the client.
--
-- Tier caps (matches TIER_LISTING_CAPS in index.html):
--   free        → 0   (no marketplace selling)
--   collector   → 0   (no marketplace selling)
--   enthusiast  → 40
--   vendor      → 150
--   shop        → unlimited (NULL = no cap)
--
-- Counts CONCURRENT active listings (status = 'active' / 'available'
-- / NULL — i.e. unsold + not cancelled). Sold / cancelled / completed
-- listings free up a slot.
--
-- Idempotent. Re-running drops and recreates the trigger + helper.
-- ============================================================

-- 1. Helper function — returns the cap for a given tier (NULL = unlimited).
CREATE OR REPLACE FUNCTION public.listing_cap_for_tier(p_tier TEXT)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE COALESCE(p_tier, 'free')
    WHEN 'free'        THEN 0
    WHEN 'collector'   THEN 0
    WHEN 'enthusiast'  THEN 40
    WHEN 'vendor'      THEN 150
    WHEN 'shop'        THEN NULL  -- unlimited
    ELSE 0
  END;
$$;

GRANT EXECUTE ON FUNCTION public.listing_cap_for_tier(TEXT) TO anon, authenticated;

-- 2. Trigger function — fires BEFORE INSERT on listings. Reads the
--    seller's tier and enforces both:
--      (a) per-tier concurrent listing cap
--      (b) per-tier product-type restrictions:
--          - Enthusiast: TCG singles ONLY (product_type IN ('single', NULL))
--          - Vendor+:    singles + sealed + non-TCG products (everything)
--          - Shop:       unlimited + everything
--
--    Status filter: any listing whose status is NULL, 'active', or
--    'available' counts as "live" and consumes a slot. Sold /
--    cancelled / completed don't.
CREATE OR REPLACE FUNCTION public.enforce_listing_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier      TEXT;
  v_cap       INTEGER;
  v_count     INTEGER;
  v_ptype     TEXT;
  v_is_admin  BOOLEAN;
BEGIN
  -- Resolve the seller's tier + admin status. Tier falls back to the
  -- legacy boolean if subscription_tier is NULL (mirrors client-side
  -- userTier()).
  SELECT
    COALESCE(
      subscription_tier,
      CASE
        WHEN is_admin   THEN 'shop'
        WHEN is_vendor  THEN 'enthusiast'  -- legacy flag → enthusiast post-rename
        WHEN is_premium THEN 'collector'
        ELSE 'free'
      END
    ),
    is_admin
  INTO v_tier, v_is_admin
  FROM public.profiles
  WHERE id = NEW.seller_id;

  -- Admins are exempt from every gate.
  IF v_is_admin = TRUE OR v_tier = 'shop' THEN
    RETURN NEW;
  END IF;

  v_cap   := public.listing_cap_for_tier(v_tier);
  v_ptype := COALESCE(NEW.product_type, 'single');

  -- Zero cap = tier doesn't allow selling at all.
  IF v_cap = 0 THEN
    RAISE EXCEPTION 'Tier ''%'' does not allow marketplace selling. Upgrade to enthusiast or higher.', v_tier
      USING ERRCODE = 'check_violation';
  END IF;

  -- Enthusiast tier: singles only. Any non-single product_type is a
  -- vendor+ feature (sealed boxes, ETBs, Funko Pops, manga, etc.).
  -- 'single' and 'tcg_single' both count as TCG singles.
  IF v_tier = 'enthusiast' AND v_ptype NOT IN ('single', 'tcg_single') THEN
    RAISE EXCEPTION 'Enthusiast tier is limited to TCG single-card listings. Sealed and non-TCG products require Vendor tier or higher.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- NULL cap = unlimited (shop, but handled above as belt-and-suspenders).
  IF v_cap IS NULL THEN
    RETURN NEW;
  END IF;

  -- Count active listings for this seller. Status NULL / 'active' /
  -- 'available' = live. Anything else = doesn't consume a slot.
  SELECT COUNT(*)
  INTO v_count
  FROM public.listings
  WHERE seller_id = NEW.seller_id
    AND (status IS NULL OR status IN ('active', 'available'));

  IF v_count >= v_cap THEN
    RAISE EXCEPTION 'Listing cap reached for tier ''%'' (% / %). Upgrade for more slots.', v_tier, v_count, v_cap
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- 3. Wire the trigger. DROP + CREATE so a re-run replaces the prior version.
DROP TRIGGER IF EXISTS trg_enforce_listing_cap ON public.listings;
CREATE TRIGGER trg_enforce_listing_cap
  BEFORE INSERT ON public.listings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_listing_cap();

-- ============================================================
-- Notes:
--
-- • The trigger fires on INSERT only. Updating an existing row's
--   status from 'sold' back to 'active' could technically bypass the
--   cap by reviving an old listing — if that ever becomes a real
--   pattern, add a separate BEFORE UPDATE trigger that re-checks
--   the cap when status transitions from inactive → active.
--
-- • SECURITY DEFINER lets the trigger read profiles regardless of
--   the calling user's RLS policies. The trigger only reads
--   subscription_tier + the legacy booleans — no sensitive fields
--   are exposed via this path.
--
-- • Caps are kept in sync between this SQL function and the client
--   helper TIER_LISTING_CAPS in index.html. If you change one, update
--   both — there's no shared source of truth (Supabase doesn't make
--   it easy to share constants between Postgres and the browser).
--
-- ============================================================
-- Verify:
--
--   -- Helper returns sensible values
--   SELECT
--     listing_cap_for_tier('free'),        -- 0
--     listing_cap_for_tier('collector'),   -- 0
--     listing_cap_for_tier('enthusiast'),  -- 40
--     listing_cap_for_tier('vendor'),      -- 150
--     listing_cap_for_tier('shop');        -- NULL (unlimited)
--
--   -- An enthusiast at 39 active listings should be able to add #40,
--   -- and #41 should raise: "Listing cap reached for tier 'enthusiast' (40 / 40)".
--   --
--   -- An enthusiast trying to list a 'booster_box' / 'sealed' /
--   -- 'funko_pop' / etc. should raise:
--   --   "Enthusiast tier is limited to TCG single-card listings.
--   --    Sealed and non-TCG products require Vendor tier or higher."
--   --
--   -- A vendor or shop user listing the same products succeeds.
--   --
--   -- Test as a non-admin enthusiast user via your normal listing flow.
-- ============================================================
