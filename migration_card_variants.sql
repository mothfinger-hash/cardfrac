-- ============================================================
-- PathBinder — card variants (Normal / Reverse Holo / Holo)
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- Why this exists
-- ---------------
-- Pokemon cards exist in multiple FINISHES (Normal, Reverse Holo, and
-- sometimes a separate Holo printing for the same card number). Up
-- until this migration our catalog stored one row per (set, number)
-- and tracked finishes only as TCGplayer price-object keys
-- (tcgplayer.prices.reverseHolofoil.market). That meant:
--   • Set completion percentages were wrong — a "200-card set" actually
--     has ~350+ slots to fill when you count reverse holos.
--   • Users who owned both finishes had no way to record both.
--   • Marketplace listings couldn't disambiguate finish.
--
-- New model
-- ---------
-- catalog.has_reverse_holo  BOOL — does this card's set print a
--                                  reverse-holo variant of THIS card?
-- collection_items.variant  TEXT — 'normal' (default) | 'reverse_holo'
--                                  | 'holo' | '1st_edition_holo'
--                                  Each (api_card_id, variant) gets
--                                  its own row, so a user can own
--                                  both finishes with separate qty /
--                                  cost basis / cert numbers.
-- listings.variant          TEXT — same enum, defaulted to 'normal'.
--                                  Marketplace browse filters by it.
--
-- AUDIT then APPLY
-- ----------------
-- Section 1 reports current state (read-only).
-- Section 2 mutates: adds columns, builds indexes, backfills.
-- Section 3 verifies.
-- ============================================================


-- ─── Section 1 — Pre-audit (read-only). ────────────────────────
select 'catalog has_reverse_holo column?' as check_,
       exists(select 1 from information_schema.columns
              where table_schema='public' and table_name='catalog'
                and column_name='has_reverse_holo') as present;

select 'collection_items.variant column?' as check_,
       exists(select 1 from information_schema.columns
              where table_schema='public' and table_name='collection_items'
                and column_name='variant') as present;

select 'listings.variant column?' as check_,
       exists(select 1 from information_schema.columns
              where table_schema='public' and table_name='listings'
                and column_name='variant') as present;

-- How many distinct Pokemon catalog rows have a TCGplayer reverseHolofoil
-- price entry? That's our backfill candidate count for has_reverse_holo.
select 'pokemon rows with TCGplayer reverseHolofoil price' as check_,
       count(distinct cp.catalog_id) as count_
  from public.card_prices cp
  join public.catalog c on c.id = cp.catalog_id
 where cp.source = 'tcgplayer'
   and c.game_type = 'pokemon'
   and cp.value is not null and cp.value > 0;


-- ─── Section 2 — Schema changes + backfill (mutates rows). ─────

-- Catalog: did this printing get a reverse-holo variant?
alter table public.catalog
  add column if not exists has_reverse_holo boolean default false not null;

-- Index supports set-completion queries that count reverse-holo slots
-- per set ("how many of this set's cards have an RH variant?").
create index if not exists catalog_set_rh_idx
  on public.catalog (game_type, set_code)
  where has_reverse_holo = true;

-- Collection items: which finish of the card the user owns.
-- Default 'normal' so existing rows continue to behave exactly as
-- they did before this migration (each is treated as the base finish).
alter table public.collection_items
  add column if not exists variant text default 'normal' not null;

-- Listings: which finish the seller is offering. Default normal so
-- existing listings carry forward unchanged.
alter table public.listings
  add column if not exists variant text default 'normal' not null;

-- Index for marketplace browse: filter by variant.
create index if not exists listings_variant_idx
  on public.listings (variant)
  where status = 'active';

-- ── Backfill catalog.has_reverse_holo from card_prices ────────
-- Any catalog row that already has a tcgplayer reverseHolofoil price
-- recorded MUST have an RH variant (TCGplayer doesn't track a price
-- for a finish that doesn't exist). Flip the flag for those rows.
-- Idempotent — only flips false→true, never the other direction.
--
-- Note: card_prices doesn't currently break out price BY finish — it
-- stores one value per (catalog_id, source). To detect the presence
-- of an RH printing reliably we'd need either a finish column on
-- card_prices, or a separate lookup against pokemontcg.io. Until the
-- sync script is updated (next migration step), this backfill is a
-- no-op safety net. Going forward, sync_tcgplayer_via_free_apis.py
-- writes the flag directly when it sees the price entry.
--
-- For now: also fall back to any rarity hint that includes "Reverse"
-- or "Holo" in the rarity string itself — catches PriceCharting-sourced
-- rows where rarity is explicit.
update public.catalog
   set has_reverse_holo = true
 where has_reverse_holo = false
   and game_type = 'pokemon'
   and (
     lower(coalesce(rarity, '')) like '%reverse%holo%'
     or lower(coalesce(rarity, '')) like '%rh%'
   );


-- ─── Section 3 — Post-audit (verify). ──────────────────────────
select 'catalog has_reverse_holo present' as check_,
       count(*) filter (where has_reverse_holo) as flagged_true,
       count(*)                                  as total_pokemon
  from public.catalog
 where game_type = 'pokemon';

select 'collection_items.variant distribution' as check_, variant, count(*)
  from public.collection_items
 group by variant
 order by 3 desc;

select 'listings.variant distribution' as check_, variant, count(*)
  from public.listings
 group by variant
 order by 3 desc;

-- Spot-check the indexes exist.
select indexname
  from pg_indexes
 where schemaname = 'public'
   and indexname in ('catalog_set_rh_idx','listings_variant_idx');
