-- migration_listings_ships_to.sql
-- Per-listing shipping destinations for the marketplace.
--
-- Each listing declares which buyer countries may check out. The value is
-- passed to Stripe Checkout's shipping_address_collection.allowed_countries in
-- api/marketplace-checkout.js, replacing the old hardcoded ['US'].
--
-- Default is US-only ('{US}') so every existing listing and the US-only
-- marketplace behave exactly as before. v1 scope is US + Canada + Japan +
-- Australia; the server-side allowlist in marketplace-checkout.js (SUPPORTED
-- set) is the
-- hard cap on what codes actually take effect, so widening this column without
-- widening that set is a no-op.
--
-- Idempotent: safe to re-run.

alter table public.listings
  add column if not exists ships_to text[] not null default '{US}';

-- Defensive backfill for any pre-existing NULLs (e.g. if the column was added
-- nullable by a partial earlier run). New rows get '{US}' from the default.
update public.listings
  set ships_to = '{US}'
  where ships_to is null;
