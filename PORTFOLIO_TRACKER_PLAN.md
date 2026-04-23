# CardFrac → Portfolio Tracker: Transition Plan

## Overview

Pivot CardFrac from a fractional ownership platform to a **web-based PWA portfolio tracker** for raw and graded trading cards. Differentiated by grade-aware price tracking, a retro terminal aesthetic, and web-first (desktop) experience — a gap the current mobile-only competitors don't fill.

---

## What Carries Over (Don't Touch)

| Feature | Status | Notes |
|---|---|---|
| Auth system (Supabase) | ✅ Keep as-is | Login, register, sessions all reuse |
| User profiles | ✅ Keep as-is | Username, premium flag, avatar |
| Premium membership | ✅ Keep as-is | Reframes as Pro tier |
| Admin panel | ✅ Keep as-is | Manage users, listings, prices |
| Price scraper (`api/update-prices.js`) | ✅ Core feature | Now runs on user collection items |
| Leaderboard | ✅ Keep as-is | Reframes as "top collectors by portfolio value" |
| Price history chart | ✅ Keep as-is | Move to individual card detail pages |
| Retro UI theme | ✅ Keep as-is | Major differentiator |
| Vercel deployment | ✅ Keep as-is | Add PWA files alongside |
| Holdings overview | 🔄 Rework | Already 80% a portfolio dashboard |

---

## What Changes or Gets Removed

| Feature | Change |
|---|---|
| Fractional slots | Remove (or archive for existing users) |
| Admin-only card listings | Replace with user-searchable card catalog |
| Slot grid UI | Remove |
| Buy/trade/cashout flows | Remove |
| Browse page | Repurpose as card catalog search |

---

## New Database Tables (SQL Migrations)

### 1. `collection_items` — user's personal cards
```sql
CREATE TABLE collection_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,

  -- Card identity (from Pokémon TCG API or manual entry)
  api_card_id text,           -- e.g. "base1-4" from pokemontcg.io
  card_name text NOT NULL,    -- e.g. "Charizard"
  set_name text,              -- e.g. "Base Set"
  set_code text,              -- e.g. "base1"
  card_number text,           -- e.g. "4/102"
  card_image_url text,
  game_type text DEFAULT 'pokemon',  -- pokemon, sports, mtg, yugioh

  -- Condition
  condition text DEFAULT 'raw',       -- raw, psa, bgs, cgc, ace
  grade_value numeric,                -- 10, 9.5, 9, 8... null if raw
  cert_number text,                   -- grading cert for verification

  -- Financial tracking
  quantity integer DEFAULT 1,
  purchase_price numeric,             -- what user paid per card
  purchase_date date,
  current_value numeric,              -- last scraped/updated price
  last_price_update timestamptz,
  price_source_url text,              -- for the price scraper

  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Row level security: users only see their own cards
ALTER TABLE collection_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own collection"
  ON collection_items FOR ALL USING (auth.uid() = user_id);
```

### 2. `card_price_history` — track value over time
```sql
CREATE TABLE card_price_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  collection_item_id uuid REFERENCES collection_items(id) ON DELETE CASCADE,
  price numeric NOT NULL,
  recorded_at timestamptz DEFAULT now()
);
```

### 3. `price_alerts` — notify when card hits target (Premium)
```sql
CREATE TABLE price_alerts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  collection_item_id uuid REFERENCES collection_items(id) ON DELETE CASCADE,
  target_price numeric NOT NULL,
  direction text DEFAULT 'above',   -- 'above' or 'below'
  triggered boolean DEFAULT false,
  triggered_at timestamptz,
  created_at timestamptz DEFAULT now()
);
```

---

## External APIs

### Pokémon TCG API (free, no auth required)
- Base URL: `https://api.pokemontcg.io/v2`
- Card search: `GET /cards?q=name:charizard`
- Returns: name, set, number, images, legalities
- Rate limit: 1000 req/day without key, 20,000 with free key
- Sign up: https://dev.pokemontcg.io

### Sports Cards
- **Ludex API**: https://ludex.com — scanning + pricing
- **MLBAM / Fanatics**: for licensed player data
- Manual entry works fine for MVP

### Price Data
- **PriceCharting**: Already implemented, grade-aware
- **eBay sold listings**: Already implemented
- **TCGPlayer**: Already implemented

---

## Phase Plan

---

### Phase 1: PWA Foundation
**Time: 2–3 days**
**Goal: Make the current app installable on mobile**

Files to create:
- `manifest.json` — app name, icons, theme color, display mode
- `sw.js` — service worker for offline support and caching
- Link both in `index.html`

What this gives you:
- Users can "Add to Home Screen" on iOS and Android
- App icon, splash screen, standalone window (no browser chrome)
- Offline fallback page
- Groundwork for later push notifications

No backend changes. No UI changes. Just two new files and three lines in `index.html`.

---

### Phase 2: Card Catalog + Add to Collection
**Time: 1 week**
**Goal: Users can search for any Pokémon card and add it to their collection**

New UI components:
- Search bar that hits the Pokémon TCG API live
- Card result cards showing image, name, set, number
- "Add to Collection" modal with fields:
  - Condition: Raw / PSA / BGS / CGC / ACE
  - Grade (if graded): 10, 9.5, 9, 8, 7... dropdown
  - Cert number (optional)
  - Quantity
  - Purchase price (optional)
  - Purchase date (optional)
  - Price source URL (optional, for auto-tracking)
- Saves to `collection_items` table in Supabase

Backend changes:
- New Supabase table: `collection_items`
- RLS policies so users only see their own cards

---

### Phase 3: Portfolio Dashboard
**Time: 1 week**
**Goal: Replace Holdings Overview with a full personal portfolio view**

Dashboard components:
- **Summary bar**: Total value, total cost basis, total gain/loss ($  and %), number of cards
- **Portfolio mix pie chart**: By game type, by condition (raw vs graded), by set
- **Card list table**: Name | Set | Condition/Grade | Qty | Cost | Current Value | Gain/Loss
- **Individual card detail**: Price history chart, cert number link to PSA/BGS lookup, edit/delete
- **Sorting + filtering**: By value, by gain/loss, by date added, by game

This is a direct evolution of the Holdings Overview that already exists.

---

### Phase 4: Price Tracking
**Time: 1 week**
**Goal: Auto-update card values on a schedule**

Changes to `api/update-prices.js`:
- Query `collection_items` instead of `listings`
- Match grade from `condition` + `grade_value` fields
- Write updated price back to `collection_items.current_value`
- Append a row to `card_price_history` on every update (even if unchanged)
- Trigger via Vercel cron (already configured) + manual "Refresh" button

Per-card price source URL: users who want auto-tracking paste a PriceCharting or eBay URL when adding the card. Users who don't will need to update manually or rely on a future "auto-lookup" feature.

---

### Phase 5: Premium Features
**Time: 1 week**
**Goal: Give the Pro tier real value**

Free tier:
- Up to 50 cards in collection
- Manual price updates only
- Basic portfolio summary

Pro tier ($8–10/month — existing premium system reused):
- Unlimited cards
- Daily automatic price updates
- Price alerts (above/below target)
- Historical price charts (90 days+)
- CSV export
- Multiple portfolios / "binders"

Price alerts flow:
- User sets a target price on any card
- Cron job checks `price_alerts` after each price update
- Sends email via Supabase's built-in email or a service like Resend

---

### Phase 6: Polish + Launch
**Time: 3–5 days**

- Landing page rewrite (already has good bones)
- Onboarding flow for new users (add your first card)
- Public collection sharing (shareable link to view someone's portfolio)
- SEO basics (meta tags, card detail pages indexable)
- App Store submission via Capacitor (optional, adds ~1 week)

---

## Realistic Timeline

| Phase | Work | Estimate |
|---|---|---|
| Phase 1: PWA | 2 files + 3 lines | 2–3 days |
| Phase 2: Card Catalog | Search UI + Supabase table | 1 week |
| Phase 3: Portfolio Dashboard | Rework Holdings | 1 week |
| Phase 4: Price Tracking | Update scraper | 1 week |
| Phase 5: Premium Features | Alerts + limits | 1 week |
| Phase 6: Polish | Landing + onboarding | 3–5 days |
| **Total** | | **~6 weeks** |

---

## Competitive Positioning

| Feature | CardFrac | Collectr | Dex | pkmn.gg |
|---|---|---|---|---|
| Web-based | ✅ | ❌ mobile only | ❌ mobile only | ✅ |
| Graded card support | ✅ grade-aware | Partial | ❌ | ❌ |
| Desktop-first | ✅ | ❌ | ❌ | Partial |
| Retro/collector aesthetic | ✅ | ❌ generic fintech | ❌ | ❌ |
| Price history tracking | ✅ | ✅ (Pro) | Partial | ❌ |
| Sports cards | Roadmap | ✅ | ❌ | ❌ |
| Free tier | ✅ | ✅ | ✅ | ✅ |

---

## First Step

Run this SQL in Supabase to create the `collection_items` table, then start Phase 1 (PWA files).
