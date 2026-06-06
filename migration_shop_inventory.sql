-- ============================================================
-- PathBinder — Shop Inventory (Step 1)
--
-- Adds an in-store / listed-online stock split to collection_items
-- for Vendor+ tier users, and a durable shop_sales log for in-store
-- transactions.
--
-- Concepts:
--   collection_items.quantity         = TOTAL units the seller owns
--   collection_items.on_shelf_qty     = units physically in the store
--   collection_items.listed_online_qty = units currently listed on PathBinder
--   collection_items.shop_sku          = optional user-defined SKU/barcode
--
--   Invariant: on_shelf_qty + listed_online_qty <= quantity
--   (Difference = units reserved in an in-progress order or
--   intentionally held back.)
--
-- shop_sales is the append-only ledger of in-store transactions —
-- the same way "orders" is the ledger of PathBinder transactions.
-- A sale row decrements on_shelf_qty AND quantity at write time
-- (via a trigger below), and is what powers the Sales Log report.
--
-- Run in: Supabase Dashboard → SQL Editor → New query.
-- Idempotent.
-- ============================================================

-- ── collection_items columns ────────────────────────────────────────
alter table public.collection_items
  add column if not exists on_shelf_qty       integer not null default 0,
  add column if not exists listed_online_qty  integer not null default 0,
  add column if not exists shop_sku           text;

-- Helpful index for the Inventory tab: shop owners pull "everything
-- I have on shelf" filtered by user_id, so a covering index keeps
-- that query fast as catalogs grow into the tens-of-thousands.
create index if not exists idx_collection_items_user_on_shelf
  on public.collection_items (user_id)
  where on_shelf_qty > 0;

create index if not exists idx_collection_items_shop_sku
  on public.collection_items (shop_sku)
  where shop_sku is not null;

-- Backfill: for every existing row owned by a Vendor+ tier user
-- that isn't a ghost/sold-offline placeholder, treat the entire
-- quantity as on-shelf.
--
-- We DO NOT backfill listed_online_qty from public.listings here —
-- the `listings` table stores cards by text name (no FK to the
-- catalog or to collection_items), so a clean join doesn't exist.
-- New listings going forward will increment listed_online_qty via
-- the Step 4 listing-flow patch. Until then, vendors with existing
-- listings will see those units double-counted as on-shelf — they
-- can either ignore it, manually adjust via the future "Adjust"
-- UI, or wait for those listings to sell/expire.
update public.collection_items ci
   set on_shelf_qty = coalesce(ci.quantity, 1)
  from public.profiles p
 where ci.user_id = p.id
   and ci.on_shelf_qty = 0
   and coalesce(ci.is_ghost, false)     = false
   and coalesce(ci.sold_offline, false) = false
   and p.subscription_tier in ('vendor','shop');

-- ── shop_sales — durable in-store transaction log ───────────────────
create table if not exists public.shop_sales (
  id                  uuid          primary key default gen_random_uuid(),

  -- Who sold it. Vendor+ tier users only (enforced via RLS + insert
  -- check on the client; trigger below also guards against
  -- decrementing a row the user doesn't own).
  user_id             uuid          not null references auth.users(id) on delete cascade,

  -- What was sold. collection_item_id is the row whose on_shelf_qty
  -- we decrement; api_card_id + variant are denormalized so the
  -- ledger survives even after the underlying collection row is
  -- deleted or merged.
  collection_item_id  uuid          references public.collection_items(id) on delete set null,
  api_card_id         text          not null,
  variant             text          not null default 'normal',

  -- Quantity + pricing. unit_price is the per-card sale price the
  -- shop logged at point of sale (may differ from listed price for
  -- haggling / discounts). total_price is unit_price * qty.
  qty                 integer       not null check (qty >= 1),
  unit_price          numeric(10,2) not null check (unit_price >= 0),
  total_price         numeric(10,2) not null check (total_price >= 0),

  -- Cash / Card / Trade / Other — optional, defaults to 'card'.
  -- Free-form text rather than an enum so adding 'venmo', 'check'
  -- etc. doesn't need a schema migration.
  payment_method      text          not null default 'card',

  notes               text,

  -- When the sale happened (user-editable) vs. when it was logged.
  sold_at             timestamptz   not null default now(),
  created_at          timestamptz   not null default now()
);

create index if not exists idx_shop_sales_user_sold_at
  on public.shop_sales (user_id, sold_at desc);

create index if not exists idx_shop_sales_collection_item
  on public.shop_sales (collection_item_id);

-- ── Trigger: decrement on_shelf_qty + quantity on sale insert ───────
-- Keeps the inventory counters truthful without forcing the client
-- to run a multi-statement transaction. If on_shelf_qty < qty the
-- insert fails with a clear error.
create or replace function public.apply_shop_sale_to_inventory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_shelf integer;
  v_total integer;
begin
  if new.collection_item_id is null then
    return new;  -- detached sale (eg quick scan that didn't bind to a row)
  end if;

  select user_id, coalesce(on_shelf_qty, 0), coalesce(quantity, 0)
    into v_owner, v_shelf, v_total
    from public.collection_items
   where id = new.collection_item_id
   for update;

  if v_owner is null then
    raise exception 'shop_sales: collection_item_id % not found', new.collection_item_id;
  end if;

  if v_owner <> new.user_id then
    raise exception 'shop_sales: cannot record sale against another user''s inventory';
  end if;

  if v_shelf < new.qty then
    raise exception 'shop_sales: only % on shelf, cannot sell %', v_shelf, new.qty;
  end if;

  update public.collection_items
     set on_shelf_qty = on_shelf_qty - new.qty,
         quantity     = greatest(0, coalesce(quantity, 0) - new.qty)
   where id = new.collection_item_id;

  return new;
end;
$$;

drop trigger if exists trg_apply_shop_sale on public.shop_sales;
create trigger trg_apply_shop_sale
  before insert on public.shop_sales
  for each row execute function public.apply_shop_sale_to_inventory();

-- ── RLS ─────────────────────────────────────────────────────────────
alter table public.shop_sales enable row level security;

drop policy if exists "shop_sales owner read"   on public.shop_sales;
drop policy if exists "shop_sales owner insert" on public.shop_sales;
drop policy if exists "shop_sales owner update" on public.shop_sales;
drop policy if exists "shop_sales owner delete" on public.shop_sales;

create policy "shop_sales owner read"
  on public.shop_sales for select
  using (auth.uid() = user_id);

create policy "shop_sales owner insert"
  on public.shop_sales for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.subscription_tier in ('vendor','shop')
    )
  );

create policy "shop_sales owner update"
  on public.shop_sales for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "shop_sales owner delete"
  on public.shop_sales for delete
  using (auth.uid() = user_id);

-- ============================================================
-- Verify:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'collection_items'
--      AND column_name IN ('on_shelf_qty','listed_online_qty','shop_sku')
--    ORDER BY column_name;
--
--   SELECT count(*) FROM public.shop_sales;
--
--   -- Spot-check backfill (replace UUID with a vendor user):
--   SELECT id, quantity, on_shelf_qty, listed_online_qty
--     FROM public.collection_items
--    WHERE user_id = '<vendor-user-uuid>'
--    ORDER BY created_at DESC
--    LIMIT 20;
-- ============================================================
