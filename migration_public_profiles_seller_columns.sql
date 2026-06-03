-- ============================================================
-- PathBinder — Extend public_profiles_display to include seller
-- shop fields so the marketplace "view seller profile" modal can
-- load other users' shop info without needing a cross-user SELECT
-- policy on the underlying `profiles` table.
--
-- Background:
--   - `profiles` has RLS enabled and (by design) no policy that
--     allows a user to SELECT another user's row. This keeps PII
--     like email / phone / stripe_connect_account_id private.
--   - The existing `public_profiles_display` view (from
--     migration_account_deletion.sql) was deliberately narrow —
--     just id, name, username, avatar_url, avatar_state,
--     is_deleted, subscription_tier — and grant-readable to
--     authenticated + anon.
--   - The seller profile modal also needs shop_name, shop_tagline,
--     shop_description, shop_instagram, shop_website, banner_url,
--     seller_rating, bio, social_links, vacation_mode_until.
--
-- Fix: replace the view with a wider one that adds those columns.
-- All added columns are intentionally-public (the seller chose to
-- publish them by setting them) — no PII leakage.
--
-- Idempotent. Safe to re-run. Uses dynamic SQL so it adapts to
-- whichever optional columns are actually present.
--
-- Run in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

do $$
declare
  has_username        boolean;
  has_name            boolean;
  has_display_name    boolean;
  has_avatar          boolean;
  has_avatar_state    boolean;
  has_is_deleted      boolean;
  has_sub_tier        boolean;
  has_shop_name       boolean;
  has_shop_tagline    boolean;
  has_shop_desc       boolean;
  has_shop_instagram  boolean;
  has_shop_website    boolean;
  has_banner_url      boolean;
  has_seller_rating   boolean;
  has_bio             boolean;
  has_social_links    boolean;
  has_vacation        boolean;
  name_expr      text;
  uname_expr     text;
  avatar_expr    text;
  avstate_expr   text;
  isdel_expr     text;
  subtier_expr   text;
  shopname_expr  text;
  shoptag_expr   text;
  shopdesc_expr  text;
  shopig_expr    text;
  shopweb_expr   text;
  banner_expr    text;
  rating_expr    text;
  bio_expr       text;
  social_expr    text;
  vac_expr       text;
  cols           text;
begin
  -- Probe each optional column. We rebuild the SELECT list from only
  -- the columns that actually exist so the view definition stays valid
  -- on partially-migrated databases.
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='username')
                 into has_username;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='name')
                 into has_name;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='display_name')
                 into has_display_name;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='avatar_url')
                 into has_avatar;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='avatar_state')
                 into has_avatar_state;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='is_deleted')
                 into has_is_deleted;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='subscription_tier')
                 into has_sub_tier;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='shop_name')
                 into has_shop_name;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='shop_tagline')
                 into has_shop_tagline;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='shop_description')
                 into has_shop_desc;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='shop_instagram')
                 into has_shop_instagram;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='shop_website')
                 into has_shop_website;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='banner_url')
                 into has_banner_url;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='seller_rating')
                 into has_seller_rating;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='bio')
                 into has_bio;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='social_links')
                 into has_social_links;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='profiles' and column_name='vacation_mode_until')
                 into has_vacation;

  -- Name: prefer display_name, then name, then username. Mask if
  -- the row is soft-deleted (so the marketplace shows "[deleted]"
  -- instead of leaking the original handle).
  if has_display_name then
    name_expr := 'case when p.is_deleted then ''[deleted]'' else coalesce(p.display_name, p.username) end as name';
  elsif has_name then
    name_expr := 'case when p.is_deleted then ''[deleted]'' else coalesce(p.name, p.username) end as name';
  elsif has_username then
    name_expr := 'case when p.is_deleted then ''[deleted]'' else p.username end as name';
  else
    name_expr := 'null::text as name';
  end if;

  if has_username then
    uname_expr := 'case when p.is_deleted then ''[deleted]'' else p.username end as username';
  else
    uname_expr := 'null::text as username';
  end if;

  if has_avatar then
    avatar_expr := 'case when p.is_deleted then null else p.avatar_url end as avatar_url';
  else
    avatar_expr := 'null::text as avatar_url';
  end if;

  if has_avatar_state then
    avstate_expr := 'case when p.is_deleted then null else p.avatar_state end as avatar_state';
  else
    avstate_expr := 'null::jsonb as avatar_state';
  end if;

  if has_is_deleted then
    isdel_expr := 'p.is_deleted';
  else
    isdel_expr := 'false as is_deleted';
  end if;

  if has_sub_tier then
    subtier_expr := 'p.subscription_tier';
  else
    subtier_expr := 'null::text as subscription_tier';
  end if;

  if has_shop_name then
    shopname_expr := 'case when p.is_deleted then null else p.shop_name end as shop_name';
  else
    shopname_expr := 'null::text as shop_name';
  end if;

  if has_shop_tagline then
    shoptag_expr := 'case when p.is_deleted then null else p.shop_tagline end as shop_tagline';
  else
    shoptag_expr := 'null::text as shop_tagline';
  end if;

  if has_shop_desc then
    shopdesc_expr := 'case when p.is_deleted then null else p.shop_description end as shop_description';
  else
    shopdesc_expr := 'null::text as shop_description';
  end if;

  if has_shop_instagram then
    shopig_expr := 'case when p.is_deleted then null else p.shop_instagram end as shop_instagram';
  else
    shopig_expr := 'null::text as shop_instagram';
  end if;

  if has_shop_website then
    shopweb_expr := 'case when p.is_deleted then null else p.shop_website end as shop_website';
  else
    shopweb_expr := 'null::text as shop_website';
  end if;

  if has_banner_url then
    banner_expr := 'case when p.is_deleted then null else p.banner_url end as banner_url';
  else
    banner_expr := 'null::text as banner_url';
  end if;

  if has_seller_rating then
    rating_expr := 'case when p.is_deleted then null else p.seller_rating end as seller_rating';
  else
    rating_expr := 'null::numeric as seller_rating';
  end if;

  if has_bio then
    bio_expr := 'case when p.is_deleted then null else p.bio end as bio';
  else
    bio_expr := 'null::text as bio';
  end if;

  if has_social_links then
    social_expr := 'case when p.is_deleted then null else p.social_links end as social_links';
  else
    social_expr := 'null::jsonb as social_links';
  end if;

  if has_vacation then
    vac_expr := 'case when p.is_deleted then null else p.vacation_mode_until end as vacation_mode_until';
  else
    vac_expr := 'null::timestamptz as vacation_mode_until';
  end if;

  cols := 'p.id, '
       || name_expr     || ', ' || uname_expr     || ', '
       || avatar_expr   || ', ' || avstate_expr   || ', '
       || isdel_expr    || ', ' || subtier_expr   || ', '
       || shopname_expr || ', ' || shoptag_expr   || ', '
       || shopdesc_expr || ', ' || shopig_expr    || ', '
       || shopweb_expr  || ', ' || banner_expr    || ', '
       || rating_expr   || ', ' || bio_expr       || ', '
       || social_expr   || ', ' || vac_expr;

  execute 'create or replace view public.public_profiles_display as
             select ' || cols || ' from public.profiles p';
end $$;

-- Re-grant just in case the view was dropped + recreated.
grant select on public.public_profiles_display to authenticated, anon;

-- ============================================================
-- Verify:
--   SELECT column_name FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='public_profiles_display'
--     ORDER BY ordinal_position;
--   -- should include shop_name, banner_url, bio, social_links,
--   -- vacation_mode_until, seller_rating, etc.
--
--   -- Cross-user read smoke test (run as a regular user):
--   SELECT id, username, shop_name, vacation_mode_until
--     FROM public.public_profiles_display
--     LIMIT 5;
-- ============================================================
