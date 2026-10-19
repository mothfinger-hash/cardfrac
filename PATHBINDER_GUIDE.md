# PathBinder — App Guide & Handoff

A practical breakdown of what PathBinder is, how to add new card sets, and the
things that have bitten us before (with the fix we landed on each time). For the
exhaustive detail, `CLAUDE.md` is the source of truth — this is the digestible
version. Absolute dates are used throughout; "recently" is avoided on purpose.

---

## 1. What the app is

PathBinder (**pathbinder.gg**) is a **multi-TCG card collection tracker + peer-to-peer
marketplace**. Supports Magic, Pokémon, Yu-Gi-Oh!, One Piece, Lorcana, Dragon Ball,
Gundam, and more in one binder.

**Core features**
- **Collection tracking** — free and unlimited (no card cap). Scanner (camera OCR +
  CLIP embeddings), live market prices, set-completion tracking, variants (Normal /
  Reverse Holo / Holo / 1st Ed).
- **Marketplace** — list and sell your own cards P2P. Stripe Connect destination
  charges (NOT escrow — see gotchas). Buyer protection = standard Stripe dispute.
- **Shop tools (Vendor/Shop tiers)** — inventory (on-shelf vs listed-online split),
  in-store POS with scan-to-sell, sales log + CSV, per-unit metadata, bulk CSV import.
- **Signals** — price movers (daily), owned-card spike push alerts, wishlist/ghost
  cards with "listed near target" alerts, a Discord bot (`/movers` etc.).
- **Integrations** — eBay (OAuth, pull listings, sync-on-sale), catalog photo
  contributions, SEO comparison pages (`/collectr-alternative`, etc.).

**Tiers** (`profiles.subscription_tier`): `free` / `enthusiast` ($10) / `vendor`
($29) / `shop` ($99). Commissions 8% / 7% / 6%. (The `collector` tier was removed in
2026; free became unlimited.)

---

## 2. Codebase layout

| Path | What it is |
|---|---|
| `index.html` | The single-file app shell (~24K lines) + inline `<script>`. Loads the bundles below. |
| `pb-app.js` | The main app logic (this is the live source — edit it directly). Global functions, no IIFE. |
| `pb-store.js` | "My Store" / seller-side logic. |
| `pb-admin.js` | Admin panel (MRR, beta testers, contribution queue). |
| `pb-styles.css` / `pb-critical.css` | Styles (cyan+copper "hologram" theme; use CSS vars, not hex). |
| `sw.js` | Service worker. **Bump `CACHE = 'pathbinder-vNN'` on every bundle change** (see gotchas). |
| `api/` | Vercel serverless functions (checkout, webhooks, crons, eBay, etc.). |
| `SQL Migrations/` | Idempotent SQL, run by hand with the **service key** (never auto-run). |
| `*.py` (sync scripts) | Catalog ingest / image mirroring / price refresh (run locally with the service key). |
| `supabase/functions/` | Supabase edge functions (Stripe checkout session). |

Backend = **Supabase** (Postgres + Storage + RLS + RPCs). Front door = **Vercel**.
`catalog` is the canonical card table; `collection_items` is per-user owned cards;
`listings` is the marketplace; `profiles` is users.

**Two keys, do not mix them up:**
- `SUPABASE_ANON_KEY` (publishable, `sb_publishable_…`) — read-only-ish, safe in the
  browser and for diagnostics.
- `SUPABASE_SERVICE_KEY` — full access. **Only used for migrations and the sync
  scripts.** Never paste it in chat; never ship it to the browser.

---

## 3. How to add new card sets

The pipeline pulls set data from **tcgcsv** (a TCGplayer data mirror), imports it to
`catalog`, mirrors the images into our own storage, and enriches prices. There is
**one extra manual step the pipeline does NOT do** (set ordering) — call it out below.

### 3a. Identify the gap
A biweekly probe file, `new_sets_<date>.md`, lists sets that are out and NOT yet in
the catalog, each with its **tcgcsv group id** and reported **release date**.

### 3b. Add to the manifest
Edit `ingest_manifest.json` — one entry per set:
```json
{ "game": "onepiece", "set_code": "ST-31", "set_name": "Starter Deck 31: RED Monkey.D.Luffy",
  "group": 24749, "group_match": ["starter deck 31"], "enabled": true }
```
- `group` = the tcgcsv group id (preferred), or `group_match` = a phrase that hits
  exactly one group name.
- Upcoming/unreleased sets: `"enabled": false` (they run only with `--include-disabled`).
- **Always keep `set_name` accurate** — the importer falls back to the set code
  otherwise (that's how JP `M5`/`M6` shipped named "M5"/"M6").

### 3c. Run the batch ingest
```bash
cd ~/Desktop/cardfrac
export SUPABASE_URL=https://xjamytrhxeaynywcwfun.supabase.co
export SUPABASE_SERVICE_KEY=…            # service key, not the publishable one

python3 ingest_missing_sets.py           # dry-run: previews every set, writes nothing
python3 ingest_missing_sets.py --commit  # does the work
```
Read the dry-run scoreboard first (each set shows its exact command, first 5 ids, row
count). A `--commit` runs six stages in order: **plan → singles → sealed → mirror →
embed → enrich → fixes → verify**. Logs land in `ingest_logs/`.

Useful flags: `--only MAMO,ST-31` (subset), `--stages mirror` (just re-mirror images),
`--skip enrich` (skip the slow PriceCharting pass), `--force` (re-import a present set
— safe; upserts by id and never un-mirrors an image).

A set whose group has no products yet is reported **RETRY LATER** — re-run
`--only <key>` once tcgcsv lists it (tcgcsv rebuilds ~20:00 UTC daily).

### 3d. THE EXTRA STEP — make the set appear and sort correctly (`set_metadata`)
**The ingest pipeline does not touch `set_metadata`, and the Sets page reads its order
from there.** Skip this and the new set either sorts to the bottom or doesn't show at
all. Add a `set_metadata` row per set (service key), then hard-refresh (the Sets list
is cached 24h in the browser):

- **Pokémon EN** → `id` = the **bare set_code** (e.g. `30C`). The Pokémon Sets page is
  driven *only* by `set_metadata`; **a set with no row is invisible there** even though
  its cards are in `catalog`. Set the `id` to the exact catalog `set_code` so
  `loadSetDetail` resolves the cards.
- **Every other TCG** (One Piece / Magic / Yu-Gi-Oh! / Lorcana / Dragon Ball / Gundam)
  → `id` = **`<prefix><set_code>` lower-cased** (e.g. `op-st-31`, `lor-aov`, `dbf-st01`,
  `ygo-mamo`). Those pages list from `catalog` but pull each set's release_date from a
  `set_metadata` row matched on that key. No row = the set sorts to the bottom as
  "undated".

Template (see `SQL Migrations/migration_new_sets_release_dates_2026-09.sql` for a full
worked example):
```sql
insert into public.set_metadata (id, name, game_type, release_date)
values ('op-st-31', 'Starter Deck 31: RED Monkey.D.Luffy', 'onepiece', date '2026-07-31')
on conflict (id) do update set release_date = excluded.release_date, name = excluded.name, updated_at = now();
```

### 3e. Verify
- Ingest `verify` stage flags any set that ended with fewer rows than promised.
- **Images:** confirm the set's cards show a mirrored URL (`…supabase.co/…/card-images/…`),
  not `tcgplayer-cdn.tcgplayer.com` (those 403 — see gotchas). Re-run `--stages mirror`
  if any slipped through.
- **Sets page:** hard-refresh, confirm the new set appears and sorts by release date.

### Adding a whole new *game* (not just a set)
Follow the "Adding a new TCG" checklist in `CLAUDE.md` — the easy-to-forget one is the
**scanner TCG detector** (`detectScanTcg` in `index.html`): add the game to its scoring
blocks AND the winner loop, or scans of the new game silently route to Pokémon.

---

## 4. Things that have bitten us — and the fix

### Images
- **Broken card images = `tcgplayer-cdn.tcgplayer.com` URLs.** TCGplayer hard-blocks
  hotlinking (403 to browsers *and* servers), so any catalog row still pointing at their
  CDN shows a broken image. **Fix:** the `mirror` stage copies images into our
  `card-images` bucket and rewrites `image_url`. If images break, it's un-mirrored rows —
  re-run `--stages mirror`. **Caveat:** sealed products have no free image source
  (pokemontcg.io/Scryfall are singles-only), so if the mirror can't fetch them they need
  the TCGplayer partner API or a manual upload. Singles can be re-sourced free.
- **Card image fit** (wide vs card-aspect photos): don't hard-code `cover`/`contain`.
  Use the `_userPhotoAspectFit(img)` helper via `onload` — it picks per-image.

### Sets page
- **New set missing or out of order** → `set_metadata` not populated. See §3d. This is
  the single most common "I added a set but it's wrong" cause.
- **Pokémon sets stored twice** (a stale legacy shard keyed by pokemontcg.io id like
  `sv3pt5-24`, capped at card #99, unmirrored; and the canonical PokeData shard like
  `en-mew-001`, complete, mirrored). `set_map` bridges ptcg→pd codes; `loadSetDetail`
  takes whichever shard has *more* cards. Don't "fix" the legacy prefix list — it's not
  a rotted allowlist.

### Deploys / caching
- **Stale code after a push** → forgot to bump `sw.js`. The `pb-*` bundles are cached
  **cache-first** by the service worker; **bump `CACHE = 'pathbinder-vNN'` on every
  change** to `pb-app.js` / `pb-store.js` / `pb-styles.css` / `pb-critical.css` /
  `pb-scanner.js` / etc., or users keep the old bytes forever. (HTML is network-only, so
  `index.html` lands without a bump.)
- **Whole page goes black after an `index.html` JS edit** → a bad quote/escape inside the
  900KB inline script. **Always `node --check`** the extracted script blocks after a
  non-trivial edit (pipeline at the bottom of `CLAUDE.md`).

### Supabase / query traps
- **`.or()` matches nothing** → in supabase-js `.or()` strings, use `*` not `%` for
  ilike wildcards (`name.ilike.*chaos*`). `%` is sent literally.
- **A filter silently drops rows** → `.neq('product_type','single')` drops every
  `product_type IS NULL` row (Postgres `NULL != x` is NULL). Filter client-side for
  "anything except single".
- **Wrong set / duplicate sets** → `set_code` is **not unique across games** (`OP17` is
  also a Yu-Gi-Oh set; `ST01` is also Gundam). **Always pair `set_code` with `game_type`.**

### Prices / movers
- **Fake giant movers/spikes** → `current_value` and `catalog_price_history` can come
  from different sources (TCGplayer spine vs PriceCharting); dividing one by the other
  invented "+559,868%" movers. Any surface that deltas value against history must filter
  to a **single source** (`source='tcgplayer'` for spine cards). The movers RPC (v10)
  already does; new surfaces must too.
- **Movers RPC times out** → don't pass `p_min_value: 0` (scans ~42K rows). All callers
  use the `1.0` default.
- **Wrong prices on ~a third of cards** (historical) → PriceCharting ids were fuzzy-
  matched and collided. Remediation reseated `current_value` on the TCGplayer spine;
  marketplace comps now resolve by `apiCardId`. See `pricing-linkage-architecture` memory.

### Money / tiers
- **Never reintroduce escrow.** Stripe Connect destination charges only; sellers paid on
  Stripe's normal schedule; "buyer protection" = open a dispute, not a held payout.
  Calling a held-funds flow anything else still violates Stripe ToS.
- **A temporary tier grant lasts forever** unless the daily `expire-grants-cron` reverts
  it. Every temp grant (activation trial, friend invite) must set `granted_tier_source`
  to a value the sweep recognizes, or it never expires (this was a real revenue leak).

### Migrations / beta
- Migrations are **idempotent, run by hand** with the service key (copy-paste from the
  admin "Print SQL" buttons or the `SQL Migrations/` files). Keep them
  `create … if not exists` / `create or replace` / `on conflict … do update`.
- **Beta grant logic lives in the migration**, not the stale `printBetaTesterSQL()`
  button in `pb-app.js`. Founding → permanent Vendor (cap 25); founding_shop → permanent
  Shop (cap 1); enthusiast/vendor/shop → 1 year then Free.

---

## 5. Day-to-day cheat sheet

- Editing app code → edit `pb-app.js` (or the relevant `pb-*.js`) directly, then **bump `sw.js`**.
- Editing `index.html` inline JS → **`node --check`** before declaring done.
- Any DB write / migration / sync script → **service key**, run by hand. Diagnostics →
  publishable key.
- Added a set → run the ingest, **then add the `set_metadata` row(s)** (§3d), then verify
  images + Sets-page order.
- Commit/push only when asked; bump the service-worker cache in the same change.
