-- ============================================================
-- PathBinder — Collection Item Units (per-unit metadata)
--
-- Vendor+ tier feature: when a single collection_items row carries
-- quantity > 1, this table stores per-unit overrides so each
-- physical card can have its own condition / grade / cert / notes /
-- photo. The parent row continues to hold the aggregate quantity
-- and any fields the vendor hasn't overridden per-unit.
--
-- Inheritance model:
--   Every column except (id, collection_item_id, ordinal, status,
--   created_at) is nullable. NULL means "fall back to parent row."
--   The vendor only fills in what differs unit-to-unit.
--
-- Lazy creation:
--   No backfill at migration time. The first time a vendor opens
--   the per-unit stack and edits a unit, the client calls a helper
--   that creates N rows (ordinals 1..N) inheriting parent data.
--   Existing rows with quantity > 1 that never get edited stay in
--   the consolidated single-row world and pay no cost.
--
-- Sales / listings (Phase B, not built here):
--   shop_sales will eventually carry a nullable unit_id so a vendor
--   can record "sold unit #3 (LP) for $X" instead of just
--   "decrement qty by 1." Listings will stay aggregate by quantity
--   (per the Phase 1 scope decision).
--
-- Run in: Supabase Dashboard → SQL Editor → New query.
-- Idempotent.
-- ============================================================

create table if not exists public.collection_item_units (
  id                  uuid          primary key default gen_random_uuid(),

  collection_item_id  uuid          not null
                                    references public.collection_items(id) on delete cascade,

  -- Position in the stack (1, 2, 3...). Unique per parent so the UI
  -- can navigate predictably. Re-numbered if a unit is removed.
  ordinal             integer       not null,

  -- Per-unit overrides. NULL = inherit from parent collection_items.
  condition           text,
  grade_value         numeric(4,1),
  cert_number         text,
  notes               text,
  card_image_url      text,
  card_back_image_url text,

  -- Lifecycle of THIS specific unit. The parent's `quantity` is
  -- still the source of truth for "how many do I own"; status here
  -- helps the UI strike out sold/listed units in the stack and
  -- powers the FIFO sale picker (Phase B).
  status              text          not null default 'in_stock'
                                    check (status in ('in_stock','sold','listed','reserved')),
  sold_at             timestamptz,

  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),

  unique (collection_item_id, ordinal)
);

-- Parent → units lookup (the hot path: opening the card detail
-- modal for a multi-unit card).
create index if not exists idx_civ_units_parent
  on public.collection_item_units (collection_item_id, ordinal);

-- Status filter for the FIFO sale picker (Phase B).
create index if not exists idx_civ_units_parent_status
  on public.collection_item_units (collection_item_id, status)
  where status = 'in_stock';

-- ── RLS ────────────────────────────────────────────────────────────
-- Units inherit their visibility from the parent collection_items
-- row's user_id. Owner-only read/write; the join lookup happens
-- per-query rather than via stored relation because Supabase RLS
-- can't directly reference joined tables in a policy.
alter table public.collection_item_units enable row level security;

drop policy if exists "civ_units owner read"   on public.collection_item_units;
drop policy if exists "civ_units owner write"  on public.collection_item_units;
drop policy if exists "civ_units owner update" on public.collection_item_units;
drop policy if exists "civ_units owner delete" on public.collection_item_units;

create policy "civ_units owner read"
  on public.collection_item_units for select
  using (
    exists (
      select 1 from public.collection_items ci
       where ci.id = collection_item_units.collection_item_id
         and ci.user_id = auth.uid()
    )
  );

create policy "civ_units owner write"
  on public.collection_item_units for insert
  with check (
    exists (
      select 1 from public.collection_items ci
       where ci.id = collection_item_units.collection_item_id
         and ci.user_id = auth.uid()
    )
  );

create policy "civ_units owner update"
  on public.collection_item_units for update
  using (
    exists (
      select 1 from public.collection_items ci
       where ci.id = collection_item_units.collection_item_id
         and ci.user_id = auth.uid()
    )
  );

create policy "civ_units owner delete"
  on public.collection_item_units for delete
  using (
    exists (
      select 1 from public.collection_items ci
       where ci.id = collection_item_units.collection_item_id
         and ci.user_id = auth.uid()
    )
  );

-- updated_at trigger so the front end can rely on it.
create or replace function public.touch_collection_item_units_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end$$;

drop trigger if exists trg_civ_units_updated_at on public.collection_item_units;
create trigger trg_civ_units_updated_at
  before update on public.collection_item_units
  for each row execute function public.touch_collection_item_units_updated_at();

-- ============================================================
-- Verify:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'collection_item_units'
--    ORDER BY ordinal_position;
--
--   SELECT count(*) FROM public.collection_item_units;
-- ============================================================
