-- ============================================================
-- PathBinder — Listings Schema Sync
--
-- The frontend writes a few columns to public.listings that may
-- or may not exist depending on which historical migrations were
-- applied to a given environment. This migration is the
-- belt-and-suspenders pass that adds anything missing with safe
-- defaults so we stop tripping over "column X does not exist"
-- errors when we extend the marketplace.
--
-- Newly-meaningful: `quantity` — until now the marketplace has
-- assumed "1 listing = 1 card" by convention. Quantity makes that
-- explicit and unlocks vendor flows like "list 10 copies of this
-- Charizard at $4.99 each" without spawning 10 separate rows.
-- The Step 4 auto-decrement (when a sale ships, listed_online_qty
-- goes down) keys off this number.
--
-- Idempotent — every statement uses IF NOT EXISTS. Safe to run
-- repeatedly. Run in: Supabase Dashboard → SQL Editor → New query.
-- ============================================================

-- ── Schema sync (add anything potentially missing) ──────────────────
alter table public.listings
  -- Quantity of the SAME card (same condition, variant, grade) bundled
  -- into one listing row. Defaults to 1 so existing 1-row=1-card
  -- listings keep their semantics.
  add column if not exists quantity          integer       not null default 1,

  -- Who created the listing. Nullable on insert in some legacy flows;
  -- new flows always populate it.
  add column if not exists seller_id         uuid          references auth.users(id) on delete set null,

  -- Display name for the seller (shop name / username at list time).
  -- Snapshotted so seller renames don't rewrite history.
  add column if not exists seller_name       text,

  -- Was this listed via the vendor flow (vs. the legacy fractional
  -- ownership flow)? Drives the buyer-side UI in marketplace browse.
  add column if not exists is_vendor_listing boolean       not null default false,

  -- Shipping cost the buyer pays on top of `value`. Defaults to 0
  -- (free shipping) so legacy rows that never had this column don't
  -- start charging surprise fees.
  add column if not exists shipping_price    numeric(10,2) not null default 0,

  -- Long-form description / condition notes from the seller.
  add column if not exists description       text,

  -- Server timestamp of the last update — Step 4 will start writing
  -- this whenever the quantity decrements / the listing status flips.
  add column if not exists updated_at        timestamptz   not null default now();

-- Quantity >= 1 invariant. Block degenerate 0 / negative rows.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'listings_quantity_positive'
       and conrelid = 'public.listings'::regclass
  ) then
    alter table public.listings
      add constraint listings_quantity_positive check (quantity >= 1);
  end if;
end$$;

-- ── Indexes ─────────────────────────────────────────────────────────
-- Seller dashboard — "all my listings" hits this constantly.
create index if not exists idx_listings_seller_status
  on public.listings (seller_id, status)
  where seller_id is not null;

-- Cap enforcement — counting a seller's active listings is the
-- hottest query in the listing-creation flow.
create index if not exists idx_listings_seller_active
  on public.listings (seller_id)
  where status in ('active','available');

-- ── Backfill ────────────────────────────────────────────────────────
-- `is_vendor_listing` was implicitly true for any row that has a
-- seller_id (the legacy fractional flow used seller_id IS NULL +
-- total_slots > 1). Mark them so the buyer-side UI renders the
-- right badge / behavior.
update public.listings
   set is_vendor_listing = true
 where is_vendor_listing = false
   and seller_id is not null
   and total_slots = 1;

-- updated_at for legacy rows that didn't have the column at insert
-- time — anchor to created_at so the sort order stays sensible.
update public.listings
   set updated_at = created_at
 where updated_at < created_at;

-- ── Re-run listed_online_qty backfill with quantity awareness ──────
-- The previous backfill in migration_listings_catalog_link.sql used
-- count(*) under the assumption of 1 listing = 1 card. Now that
-- quantity exists, sum(quantity) is the truthful answer. Re-applies
-- only to rows where listed_online_qty is still 0 (i.e. wasn't
-- touched in the interim).
with active_listed as (
  select l.seller_id,
         l.api_card_id,
         coalesce(l.variant, 'normal') as variant,
         sum(coalesce(l.quantity, 1))::int as qty
    from public.listings l
   where l.status in ('active','available')
     and l.api_card_id is not null
   group by l.seller_id, l.api_card_id, coalesce(l.variant, 'normal')
)
update public.collection_items ci
   set listed_online_qty = least(al.qty, coalesce(ci.quantity, 1))
  from active_listed al
  join public.profiles p on p.id = al.seller_id
 where ci.user_id      = al.seller_id
   and ci.api_card_id  = al.api_card_id
   and coalesce(ci.variant, 'normal') = al.variant
   and p.subscription_tier in ('vendor','shop')
   and ci.listed_online_qty = 0;

-- ============================================================
-- Verify:
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'listings'
--    ORDER BY ordinal_position;
--
--   -- Spot-check quantity defaulting:
--   SELECT count(*) AS total,
--          count(*) FILTER (WHERE quantity = 1) AS qty1,
--          count(*) FILTER (WHERE quantity  > 1) AS qtyN
--     FROM public.listings;
-- ============================================================
