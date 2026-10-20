-- ============================================================
-- PathBinder — Close the profiles PII leak (RLS lockdown)
-- Run in: Supabase Dashboard -> SQL Editor (SERVICE key). Idempotent.
--
-- THE LEAK: profiles had THREE permissive SELECT policies, all `using (true)`:
--     "Profiles are publicly readable"  (public)
--     "profiles are publicly readable"  (anon, authenticated)
--     "profiles_public_read"            (anon, authenticated)
--   Any of them let every role read EVERY row + column — email, shipping
--   address + phone (ship_from_*), Stripe ids, and shippo_oauth_token. The
--   earlier `revoke select ... from anon` stopgap closed the logged-OUT path,
--   but every authenticated (free) user could still read it all. There was
--   also NO own-row or admin SELECT policy — those three `true` policies were
--   the only read path, so they can't simply be dropped.
--
-- THE FIX: drop the three permissive policies and replace them with
--   own-row + admin SELECT. Cross-user PUBLIC reads go through the
--   public_profiles_display VIEW (safe columns only; it bypasses base RLS).
--
-- SEQUENCING (important): deploy the client repoints to public_profiles_display
--   FIRST (and run migration_public_profiles_seller_columns.sql to extend the
--   view), THEN run this migration. Running this before the client repoints
--   deploy will break cross-user features (seller profiles, storefronts,
--   leaderboards, referral links) until the deploy lands.
-- ============================================================

alter table public.profiles enable row level security;

-- 1. Drop the three permissive read policies (the leak). -------------------
drop policy if exists "Profiles are publicly readable" on public.profiles;
drop policy if exists "profiles are publicly readable" on public.profiles;
drop policy if exists "profiles_public_read"           on public.profiles;

-- 2. Admin check as a SECURITY DEFINER helper. A policy ON profiles that
--    subqueries profiles would recurse; a definer function runs as owner and
--    bypasses RLS, so the lookup is safe and recursion-free.
create or replace function public.is_admin_current()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;
grant execute on function public.is_admin_current() to authenticated, service_role;

-- 3. Own-row read (a user sees their own full profile). --------------------
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (auth.uid() = id);

-- 4. Admin read (user management, support tools see everyone). --------------
drop policy if exists "profiles_select_admin" on public.profiles;
create policy "profiles_select_admin" on public.profiles
  for select to authenticated
  using (public.is_admin_current());

-- 5. Referral-code resolver. 1937 used to read profiles by referral_code
--    cross-user; that column isn't in the public view, so expose a narrow
--    definer lookup that returns only the referrer's id for a given code.
create or replace function public.resolve_referral_code(p_code text)
returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.profiles where referral_code = p_code limit 1;
$$;
grant execute on function public.resolve_referral_code(text) to anon, authenticated;

-- ============================================================
-- Verify (as a NON-admin authenticated user, or anon):
--   select email from public.profiles where id <> auth.uid() limit 1;  -- expect 0 rows
--   select email from public.profiles where id =  auth.uid();          -- expect your own
--   select count(*) from public.public_profiles_display;               -- expect the public view still reads
--   select * from pg_policies where tablename='profiles' and cmd='SELECT';
--     -- expect only profiles_select_own + profiles_select_admin
-- ============================================================
