-- Marketplace open-up: let SELLERS manage their OWN listings.
--
-- Before this, the only write policy on public.listings was
-- "Admins can manage listings" (schema.sql), so once the marketplace opened
-- to Enthusiast+ sellers, every non-admin insert failed with
--   "new row violates row-level security policy for table listings".
--
-- Tier eligibility + per-tier listing caps are enforced separately by the
-- enforce_listing_cap BEFORE INSERT trigger (migration_listing_cap_rls.sql),
-- so these policies only assert row ownership. RLS policies are permissive
-- (OR'd), so the existing admin "for all" policy still lets admins manage any
-- listing. Idempotent: safe to re-run.

drop policy if exists "Sellers insert own listings" on public.listings;
create policy "Sellers insert own listings" on public.listings
  for insert to authenticated
  with check (auth.uid() = seller_id);

drop policy if exists "Sellers update own listings" on public.listings;
create policy "Sellers update own listings" on public.listings
  for update to authenticated
  using (auth.uid() = seller_id)
  with check (auth.uid() = seller_id);

drop policy if exists "Sellers delete own listings" on public.listings;
create policy "Sellers delete own listings" on public.listings
  for delete to authenticated
  using (auth.uid() = seller_id);
