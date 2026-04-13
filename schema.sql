-- ============================================================
-- CardFrac — Supabase Database Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- Enable UUID generation
create extension if not exists "pgcrypto";


-- ============================================================
-- PROFILES (extends Supabase auth.users)
-- ============================================================
create table public.profiles (
  id              uuid references auth.users(id) on delete cascade primary key,
  name            text not null,
  username        text unique not null,
  membership_active boolean default false,
  membership_cycle  text default 'monthly',
  rating_count    int default 0,
  rating_total    int default 0,
  watchlist       uuid[] default '{}',          -- array of listing ids
  referral_code   text unique,
  referred_by     text,                          -- referral code of referrer
  referral_count  int default 0,
  referral_discount_used boolean default false,
  is_admin        boolean default false,
  created_at      timestamptz default now()
);

-- Automatically create a profile row when a new user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, name, username, referral_code)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', 'New User'),
    coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text, 1, 8)),
    coalesce(new.raw_user_meta_data->>'username', 'user') || '_' || substr(md5(random()::text), 1, 4)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- ============================================================
-- LISTINGS (the graded cards)
-- ============================================================
create table public.listings (
  id              uuid default gen_random_uuid() primary key,
  name            text not null,
  grade           text not null,               -- 'PSA 10', 'BGS Pristine 10', 'CGC 10'
  game_type       text default 'Other',        -- 'Pokémon', 'Magic: The Gathering', etc.
  card_type       text default '',
  value           int not null,                -- total card value in dollars
  total_slots     int default 100,
  status          text default 'public',       -- 'public', 'early_access', 'sold', 'archived'
  early_access_only boolean default false,
  cert_number     text default '',
  vault_location  text default '',
  insured         boolean default true,
  photos          text[] default '{}',         -- array of Supabase Storage URLs
  price_history   jsonb default '[]',          -- [{price, ts}]
  sell_votes      uuid[] default '{}',         -- array of user ids who voted to sell
  created_at      timestamptz default now()
);


-- ============================================================
-- SLOTS (fractional ownership records)
-- ============================================================
create table public.slots (
  id              uuid default gen_random_uuid() primary key,
  listing_id      uuid references public.listings(id) on delete cascade not null,
  idx             int not null,                -- slot number (1–100)
  user_id         uuid references auth.users(id) on delete set null,
  ask_price       int default 0,              -- 0 = not listed for sale
  trade_open      boolean default false,
  created_at      timestamptz default now(),
  unique (listing_id, idx)
);


-- ============================================================
-- TRANSACTIONS
-- ============================================================
create table public.transactions (
  id              uuid default gen_random_uuid() primary key,
  type            text not null,               -- 'buy', 'cashout', 'trade', 'buyout'
  listing_id      uuid references public.listings(id) on delete set null,
  slot_idx        int,
  user_id         uuid references auth.users(id) on delete set null,
  amount          int not null,
  fee             int default 0,
  note            text default '',
  created_at      timestamptz default now()
);


-- ============================================================
-- TRADE OFFERS
-- ============================================================
create table public.trade_offers (
  id              uuid default gen_random_uuid() primary key,
  from_user_id    uuid references auth.users(id) on delete cascade not null,
  to_user_id      uuid references auth.users(id) on delete cascade not null,
  from_slots      jsonb not null default '[]', -- [{listingId, idx}]
  to_slots        jsonb not null default '[]', -- [{listingId, idx}]
  cash_topup      int default 0,
  fee             int default 0,
  status          text default 'pending',      -- 'pending', 'accepted', 'declined', 'cancelled'
  created_at      timestamptz default now()
);


-- ============================================================
-- BUYOUT OFFERS
-- ============================================================
create table public.buyout_offers (
  id              uuid default gen_random_uuid() primary key,
  listing_id      uuid references public.listings(id) on delete cascade not null,
  from_user_id    uuid references auth.users(id) on delete cascade not null,
  amount          int not null,
  status          text default 'pending',      -- 'pending', 'accepted', 'declined'
  created_at      timestamptz default now()
);


-- ============================================================
-- PRICE ALERTS
-- ============================================================
create table public.price_alerts (
  id              uuid default gen_random_uuid() primary key,
  user_id         uuid references auth.users(id) on delete cascade not null,
  listing_id      uuid references public.listings(id) on delete cascade not null,
  target_price    int not null,
  triggered       boolean default false,
  created_at      timestamptz default now()
);


-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- Supabase requires you to explicitly allow access.
-- ============================================================

alter table public.profiles       enable row level security;
alter table public.listings        enable row level security;
alter table public.slots           enable row level security;
alter table public.transactions    enable row level security;
alter table public.trade_offers    enable row level security;
alter table public.buyout_offers   enable row level security;
alter table public.price_alerts    enable row level security;

-- PROFILES: users can read all profiles, only edit their own
create policy "Profiles are publicly readable"    on public.profiles for select using (true);
create policy "Users can update own profile"       on public.profiles for update using (auth.uid() = id);

-- LISTINGS: everyone can read; only admins can insert/update/delete
create policy "Listings are publicly readable"    on public.listings for select using (true);
create policy "Admins can manage listings"         on public.listings for all
  using (exists (select 1 from public.profiles where id = auth.uid() and is_admin = true));

-- SLOTS: everyone can read; owners and admins can update
create policy "Slots are publicly readable"       on public.slots for select using (true);
create policy "Slot owners can update their slots" on public.slots for update
  using (auth.uid() = user_id);
create policy "Admins can manage all slots"        on public.slots for all
  using (exists (select 1 from public.profiles where id = auth.uid() and is_admin = true));

-- TRANSACTIONS: users see their own; admins see all
create policy "Users can read own transactions"   on public.transactions for select
  using (auth.uid() = user_id);
create policy "Admins can read all transactions"   on public.transactions for select
  using (exists (select 1 from public.profiles where id = auth.uid() and is_admin = true));
create policy "System can insert transactions"     on public.transactions for insert
  with check (auth.uid() = user_id);

-- TRADE OFFERS: parties to the trade can see/act on it
create policy "Trade parties can read offers"     on public.trade_offers for select
  using (auth.uid() = from_user_id or auth.uid() = to_user_id);
create policy "Users can create trade offers"      on public.trade_offers for insert
  with check (auth.uid() = from_user_id);
create policy "Trade parties can update offers"    on public.trade_offers for update
  using (auth.uid() = from_user_id or auth.uid() = to_user_id);

-- BUYOUT OFFERS: submitter + admins
create policy "Users can read own buyout offers"  on public.buyout_offers for select
  using (auth.uid() = from_user_id);
create policy "Admins can manage buyout offers"    on public.buyout_offers for all
  using (exists (select 1 from public.profiles where id = auth.uid() and is_admin = true));
create policy "Users can create buyout offers"     on public.buyout_offers for insert
  with check (auth.uid() = from_user_id);

-- PRICE ALERTS: users manage their own
create policy "Users manage own price alerts"     on public.price_alerts for all
  using (auth.uid() = user_id);


-- ============================================================
-- SEED DATA — Demo listings (optional, run after schema)
-- ============================================================

insert into public.listings (name, grade, game_type, value, total_slots, status, cert_number, vault_location, insured)
values
  ('Charizard Base Set Holo', 'PSA 10', 'Pokémon', 450000, 100, 'public', 'PSA-12345678', 'Dallas Vault, TX', true),
  ('Black Lotus Alpha', 'BGS Pristine 10', 'Magic: The Gathering', 1200000, 100, 'public', 'BGS-87654321', 'New York Vault, NY', true),
  ('Blue-Eyes White Dragon 1st Ed', 'CGC 10', 'Yu-Gi-Oh!', 180000, 100, 'early_access', 'CGC-11223344', 'Los Angeles Vault, CA', true),
  ('LeBron James Rookie', 'PSA 10', 'Sports', 95000, 100, 'public', 'PSA-99887766', 'Chicago Vault, IL', true);
