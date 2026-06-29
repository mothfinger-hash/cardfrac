-- ─────────────────────────────────────────────────────────────────────────
-- Shippo shipping — address storage.
--
-- Adds the from/to address fields a shipping label needs, plus the Shippo
-- label/transaction references on the order. No new RLS:
--   • orders ship_to_*  → written by the Stripe webhook (service role) from the
--     buyer's checkout shipping address; read by buyer + seller via existing
--     orders policies.
--   • profiles ship_from_* → the seller's return address, written by the seller
--     through the existing "auth.uid() = id" self-update policy on profiles.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- Buyer ship-to address on the order (captured at Stripe Checkout) ──────────
alter table public.orders add column if not exists ship_to_name    text;
alter table public.orders add column if not exists ship_to_street1 text;
alter table public.orders add column if not exists ship_to_street2 text;
alter table public.orders add column if not exists ship_to_city    text;
alter table public.orders add column if not exists ship_to_state    text;
alter table public.orders add column if not exists ship_to_zip      text;
alter table public.orders add column if not exists ship_to_country  text default 'US';
alter table public.orders add column if not exists ship_to_phone    text;
alter table public.orders add column if not exists ship_to_email    text;

-- Shippo references for the purchased label ─────────────────────────────────
alter table public.orders add column if not exists shippo_transaction_id text;
alter table public.orders add column if not exists shippo_label_url       text;
alter table public.orders add column if not exists shippo_rate_id         text;

-- Seller return / ship-from address on the profile ─────────────────────────
alter table public.profiles add column if not exists ship_from_name    text;
alter table public.profiles add column if not exists ship_from_street1 text;
alter table public.profiles add column if not exists ship_from_street2 text;
alter table public.profiles add column if not exists ship_from_city    text;
alter table public.profiles add column if not exists ship_from_state    text;
alter table public.profiles add column if not exists ship_from_zip      text;
alter table public.profiles add column if not exists ship_from_country  text default 'US';
alter table public.profiles add column if not exists ship_from_phone    text;
