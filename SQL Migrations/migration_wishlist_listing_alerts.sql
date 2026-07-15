-- migration_wishlist_listing_alerts.sql
-- Opt-in (default ON) for the "wishlist card just listed near your target" push
-- that api/db-hook.js already sends on a listings INSERT. This just adds the
-- preference column so users can turn it OFF; the hook checks it before sending.
-- Idempotent; safe to re-run.
alter table public.profiles
  add column if not exists notify_wishlist_listings boolean not null default true;
