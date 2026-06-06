-- ============================================================
-- PathBinder — Listings ↔ Catalog Link
--
-- Adds api_card_id + card_number to public.listings so the
-- marketplace knows exactly which catalog row each listing
-- corresponds to, instead of fuzzy name-matching at render time.
--
-- Why now:
--   - Shop Inventory Step 1 backfill for listed_online_qty
--     needed this link and silently failed without it.
--   - Step 4 (auto-decrement on listing create / cancel) needs
--     a clean (user_id, api_card_id, variant) → collection_items
--     join to keep on_shelf_qty / listed_online_qty truthful.
--   - Marketplace search/filter by catalog row, "view all
--     listings of this card" lookups, and live price overlays
--     all become single-query operations.
--
-- Nullable: sealed / non-TCG product listings (Funko, Manga,
-- etc.) don't have a catalog row, so api_card_id MAY be null.
-- All new TCG single listings going forward SHOULD populate it.
--
-- Run in: Supabase Dashboard → SQL Editor → New query.
-- Idempotent.
-- ============================================================

alter table public.listings
  add column if not exists api_card_id text,
  add column if not exists card_number text;

-- Index — covers the two hot queries the inventory + browse
-- features will use:
--   "all active listings of card X for user Y"  (Step 4)
--   "all active listings of card X"             (browse filter)
create index if not exists idx_listings_api_card_id
  on public.listings (api_card_id)
  where api_card_id is not null;

create index if not exists idx_listings_seller_card
  on public.listings (seller_id, api_card_id, variant)
  where api_card_id is not null and status in ('active','available');

-- ── Best-effort backfill ───────────────────────────────────────────
-- Matches existing listings to catalog rows via (lower-cased name,
-- game_type). Single-row matches win; ambiguous matches (a name
-- printed in multiple sets) stay null and can be cleaned up later
-- by the seller editing the listing. Sealed / non-TCG listings
-- never match here because their `name` is the product name, not a
-- card name.
--
-- Implementation: aggregate per (listing_id) so we don't blow up
-- with "more than one row returned by a subquery used as an
-- expression" when a card name maps to several catalog rows. We
-- collect the min(c.id) as a stable representative AND count(*) as
-- the disambiguation signal; only update when count(*) = 1.
with candidates as (
  select l.id           as listing_id,
         min(c.id)      as match_id,
         count(*)::int  as match_count
    from public.listings l
    join public.catalog c
      on lower(c.name) = lower(l.name)
     and (
       -- Map listing.game_type (display name) to catalog.game_type
       -- (canonical key). Case-insensitive + tolerant of trademark
       -- / punctuation variants.
       (l.game_type ilike 'pok%mon%'    and c.game_type = 'pokemon')
       or (l.game_type ilike 'magic%'      and c.game_type = 'magic')
       or (l.game_type ilike 'yu%gi%'      and c.game_type = 'yugioh')
       or (l.game_type ilike 'one piece%'  and c.game_type = 'onepiece')
       or (l.game_type ilike 'gundam%'     and c.game_type = 'gundam')
       or (l.game_type ilike 'dragon ball%' and c.game_type = 'dbz')
     )
   where l.api_card_id is null
   group by l.id
)
update public.listings l
   set api_card_id = c.match_id
  from candidates c
 where c.listing_id  = l.id
   and c.match_count = 1
   and c.match_id is not null;

-- Card number backfill — once api_card_id is populated, copy the
-- catalog's card_number across so the listing has the same
-- collector number it'd display in the binder.
update public.listings l
   set card_number = c.card_number
  from public.catalog c
 where l.api_card_id = c.id
   and l.card_number is null
   and c.card_number is not null;

-- ── Shop inventory: re-run listed_online_qty backfill ──────────────
-- Now that listings have api_card_id we can do the join the
-- original migration_shop_inventory.sql skipped. Only touches
-- collection_items where the column is still 0 (i.e. wasn't
-- manually adjusted by the seller in the meantime).
--
-- Listings are 1 row = 1 card by convention (no quantity column —
-- total_slots is legacy fractional ownership), so qty = count(*).
with active_listed as (
  select l.seller_id,
         l.api_card_id,
         coalesce(l.variant, 'normal') as variant,
         count(*)::int as qty
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

-- Claw the same amount back out of on_shelf_qty so the invariant
-- (on_shelf_qty + listed_online_qty ≤ quantity) holds.
update public.collection_items
   set on_shelf_qty = greatest(0, on_shelf_qty - listed_online_qty)
 where listed_online_qty > 0
   and on_shelf_qty + listed_online_qty > coalesce(quantity, 0);

-- ============================================================
-- Verify:
--   SELECT count(*) AS total,
--          count(api_card_id) AS linked,
--          count(api_card_id)::float / nullif(count(*),0) AS pct
--     FROM public.listings;
--
--   -- Listings that couldn't be auto-matched (sealed / non-TCG +
--   -- ambiguous names). These need seller follow-up or a future
--   -- relisting flow that captures api_card_id at insert time.
--   SELECT name, game_type, count(*)
--     FROM public.listings
--    WHERE api_card_id IS NULL
--      AND status IN ('active','available')
--    GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20;
-- ============================================================
