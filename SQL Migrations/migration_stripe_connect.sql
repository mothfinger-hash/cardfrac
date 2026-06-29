-- migration_stripe_connect.sql
--
-- Stripe Connect Express onboarding columns on profiles.
--
-- Sellers (enthusiast / vendor / shop tiers) connect a Stripe Express
-- account so we can route their marketplace payouts via destination
-- charges with transfer_data.destination. Before this migration, the
-- marketplace-checkout endpoint already referenced stripe_connect_account_id
-- but no column existed — every lookup silently fell through to platform-only
-- mode (funds held on platform account, manual admin payout). That's fine
-- for the soft launch, but Phase 2 is making destination charges actually
-- fire.
--
-- Columns added:
--   stripe_connect_account_id        — acct_xxx returned by accounts.create
--   stripe_connect_charges_enabled   — synced from Stripe via webhook + status poll
--   stripe_connect_payouts_enabled   — synced from Stripe; when false we can
--                                      accept payments but Stripe won't pay out
--   stripe_connect_details_submitted — true after the seller finishes the
--                                      onboarding wizard at least once
--   stripe_connect_onboarded_at      — timestamp of the first details_submitted=true
--                                      event; sticks for analytics even if the
--                                      account is later disabled
--   stripe_connect_requirements      — JSON snapshot of Stripe's currently_due /
--                                      past_due / pending_verification arrays so
--                                      the Account page can tell the seller
--                                      exactly what's still needed
--   stripe_connect_synced_at         — last time we refreshed the above from Stripe
--
-- All additions are idempotent (`if not exists`) so re-running is safe.

alter table public.profiles
  add column if not exists stripe_connect_account_id         text,
  add column if not exists stripe_connect_charges_enabled    boolean not null default false,
  add column if not exists stripe_connect_payouts_enabled    boolean not null default false,
  add column if not exists stripe_connect_details_submitted  boolean not null default false,
  add column if not exists stripe_connect_onboarded_at       timestamptz,
  add column if not exists stripe_connect_requirements       jsonb,
  add column if not exists stripe_connect_synced_at          timestamptz;

-- Unique index on the account id (when present). Two profiles should never
-- map to the same Express account. Partial index so unset rows don't conflict.
create unique index if not exists profiles_stripe_connect_account_id_uniq
  on public.profiles (stripe_connect_account_id)
  where stripe_connect_account_id is not null;

-- RLS — sellers can read their OWN Connect status, never anyone else's.
-- The existing profiles policies already allow self-read of the row, so
-- these columns ride along on those policies. No new policy needed unless
-- you want to scope visibility per-column (you don't — the row is yours).
--
-- Writes to these columns go through the service-role webhook endpoint,
-- never the user. Confirming with a deny-all CLIENT-side write policy would
-- belt-and-suspenders this, but profiles already has a generic update policy
-- limited to `auth.uid() = id` and the webhook bypasses RLS via the service
-- key. If you ever loosen that, lock these columns down here.

comment on column public.profiles.stripe_connect_account_id is
  'Stripe Connect Express account id (acct_xxx). NULL until the seller starts onboarding.';
comment on column public.profiles.stripe_connect_charges_enabled is
  'Mirrored from Stripe Account.charges_enabled. True once the account can accept charges.';
comment on column public.profiles.stripe_connect_payouts_enabled is
  'Mirrored from Stripe Account.payouts_enabled. True once Stripe will actually pay out.';
comment on column public.profiles.stripe_connect_requirements is
  'JSONB snapshot of Stripe requirements (currently_due, past_due, pending_verification, disabled_reason). Drives the "what to fix" UI on the Account page.';
