# PathBinder — Notes for Claude

Conventions and preferences for any AI assistant working on this codebase.
Read this before adding new UI, modules, or migrations.

## UI / Visual Style

### No emojis. Plain text labels only.

Do not add emojis to new UI — not flag emojis (🇺🇸 🇯🇵 etc.), not faces,
not objects, not anchors, not any pictographic character. Tabs, buttons,
toasts, modals, badges, status pills, console SQL banners, etc. all use
plain text.

Bad:
- `'🇺🇸 ENGLISH'`
- `'🎴 Cards'`
- `'⚓ ONE PIECE'`

Good:
- `'ENGLISH'`
- `'Cards'`
- `'ONE PIECE'`

### Existing decorative glyphs are intentional, not a license

The codebase uses a small palette of geometric Unicode shapes as part of
its hologram / cyberpunk aesthetic — `⬡` for menu items, `◈` for hologram
section headers, `◇`/`◆` for inline decoration, `⚠` for danger zones,
`✓` for success states. These are deliberate design choices made by the
project owner, not stylistic noise.

When in doubt, use plain text. Match the existing aesthetic only when
the surrounding UI clearly establishes the pattern (e.g., adding a new
admin section that sits next to "◈ Card Editor" can also use `◈`).
Never introduce new pictographic glyphs from outside that small palette.

Especially common temptations to resist:
- Camera / scanner UI: NO 📷, NO 📸, NO 🔍. Use an inline SVG icon if
  you want a visual cue, or just plain text "Take Photo" / "Scan".
- Product / packaging UI: NO 📦, NO 🎁, NO 🛒. Plain text.
- Status / alerts: NO ⚡, NO 🔥, NO 🚨, NO ✨, NO 🎯. Use `⚠` (existing
  palette) or color + plain text.
- Money / sales: NO 💰, NO 💵, NO 📈, NO 📊. Plain text + green/red.
- Reactions / feedback: NO 👍, NO ❤, NO ✅, NO ❌. Use `✓` (existing
  palette) for success, or just text.

Use the project's own SVG iconography when an icon is genuinely needed.
The Add Card / Sets / Market / Trade / Account nav row in index.html
contains canonical SVG icons for the common verbs — extend that pattern
rather than reach for emoji.

### Color palette

PathBinder uses a cyan + copper hologram theme. Key CSS variables:
- `--accent` — cyan, primary actions and active state
- `--copper` — copper, hologram callouts and admin headers
- `--copper-dim` / `--copper-glow` — supporting tones
- `--surface` / `--surface2` — dark panels
- `--text` / `--muted` — body / dim text
- `--red` / `--green` / `--gold` / `--yellow` — semantic accents

Use these variables, not hex literals.

### Number inputs — no spinner arrows

`<input type="number">` shows the native browser up/down spinner arrows
by default. We hide them globally via CSS (`input[type="number"]::-webkit-
inner-spin-button { -webkit-appearance: none }` plus `-moz-appearance:
textfield`). They clash with the hologram aesthetic and on touch they
hijack vertical scroll. Don't re-add `step="0.01"` either — it visually
gates non-multiples and on some browsers blocks integer entry; use
`step="any" inputmode="decimal"` for money fields, which still keeps the
numeric keyboard on mobile while accepting `5`, `5.5`, `5.99` all fine.

### Card image fit — the canonical solution

Card slots in lists, grids, and dashboard widgets render images from a
mix of sources with different aspect ratios:

- Catalog stock images pre-cropped to card aspect (245×342)
- Catalog stock images that were NOT pre-cropped (some sealed/product
  rows, some non-EN catalog imports come through wide or landscape)
- User-uploaded photos (`/card-photos/` Supabase bucket — arbitrary aspect)

We've fought this problem several times. The repeated mistake is
applying a one-size-fits-all rule (always `cover`, always `contain`, or
a static `object-position`). Each of those breaks at least one source:

- Always-cover with default center: wide images show a dead-center
  horizontal slice that's unrecognizable.
- Always-cover with top-bias `object-position: 50% 30%`: card-aspect
  images get their bottom clipped, hiding the card art.
- Always-contain: a 16:9 phone shot in a 44×60 portrait slot becomes a
  thin sliver letterboxed with huge empty bars.

**The right answer is the JS helper `_userPhotoAspectFit(imgEl)`.** It
reads `naturalWidth`/`naturalHeight` onload, compares against card
aspect (245/342 ≈ 0.716), and:

- If the image is &gt;1.15× wider than card aspect → switch to `contain`
  (the whole subject fits, smaller but recognizable).
- Otherwise (card-aspect or narrower) → keep `cover` (fills the slot
  cleanly without distortion).

To use it: add `onload="_userPhotoAspectFit(this)"` to any `<img>` in a
fixed-size slot. The slot CSS keeps the base behavior (`object-fit:
cover` centered) so card-aspect images render correctly even before the
onload fires. Don't add a global `object-position` bias — it
disproportionately hurts the card-aspect majority to slightly help the
wide-image minority.

Same helper is appropriate for any new slot type — list rows, grid
cells, dashboard binder widget, scanner preview, etc.

### Fonts

- `'Orbitron', monospace` — display headers (panel titles, hologram callouts)
- `'Space Mono', 'Share Tech Mono', monospace` — body, buttons, data rows
- Avoid sans-serif system stacks — they break the aesthetic

## Editing index.html

`index.html` is the single-file app, ~24K lines. Some practical rules:

### Always `node --check` syntax-sensitive edits

A single bad escape (`'they\\'ll'` inside a single-quoted JS string) can
nuke the entire 900KB inline script block and produce a totally black
page on both mobile and desktop. After any non-trivial JS edit, extract
the script blocks and pass each through `node --check` before declaring
done. Example pipeline at the bottom of this file.

### Avoid apostrophes / quotes inside single-quoted JS strings

Either use double quotes, template literals, or rephrase. Backslash
escapes inside string concatenation are easy to get wrong.

### Service worker cache — you usually DON'T need to bump it

`sw.js` has a `CACHE = 'pathbinder-vXX'` constant. As of v523 the app-code
bundles (`pb-app.js`, `pb-styles.css`, `pb-critical.css`, `pb-scanner.js`,
anything matching `/pb-[\w-]+\.(js|css)$/`) are served
**stale-while-revalidate**: the SW returns the cached copy instantly but
always refetches in the background and updates the cache, so a deploy
reaches users within a load or two **without** a version bump. HTML is
already network-only (navigations never cache).

So for ordinary UI / JS / CSS changes you do **not** need to touch
`CACHE`. Only bump it when you genuinely need to force an *instant*,
same-load purge for every user — e.g. changing the SW's own caching
strategy, or shipping a fix that must not wait one extra load (a security
or data-corruption fix). Bumping needlessly just throws away every user's
warm cache for no benefit. Images/fonts/icons remain cache-first.

### Don't N+1 the marketplace render

The browse view renders many cards. Lookups for cross-cutting data
(beta tester status, vendor flags, etc.) should be backed by a JS-side
cache loaded once at app startup — not a query per row.

## Marketplace / Payments — Stripe ToS

PathBinder uses Stripe Connect destination charges in the eBay / Mercari
model. **Never** re-introduce escrow-style flows. Specifically:

### Forbidden

- Do not call the marketplace flow "escrow", "funds held", "release of
  funds", "pending payout", "buyer confirms delivery before payout", etc.
- Do not gate a seller's payout on a buyer's confirmation. Sellers are
  paid via Stripe's standard payout schedule.
- Do not hold buyer funds in the platform account custodially. Doing this
  triggers state money-transmitter laws and violates Stripe's ToS even
  when the UI calls it something other than escrow.

### Allowed

- 5% `application_fee_amount` on each marketplace charge → platform gets
  its cut, Stripe routes the rest to the seller's Connect account.
- 7-day buyer protection window — implemented as "if there's a problem,
  open a dispute" via standard Stripe chargeback flow. Not a custodial hold.
- Admin-initiated refunds via `stripe.refunds.create` (see
  `/api/refund-order.js`). Refunds are allowed; conditional non-payouts
  are not.
- "Mark Received" as a UX prompt to add the card to the buyer's binder
  and open the rate-seller modal. It does NOT release a payment.

### Order status flow

`pending_payment → paid → shipped → completed`, with `cancelled`,
`disputed`, `return_requested`, `refunded` as terminal/branch states.
There is no `delivered` gate before `completed` — the buyer's "Mark
Received" action just flips paid→completed for UX, not for money flow.

### When wiring new payments

- Read `/api/marketplace-checkout.js` — destination-charge scaffolding
  already exists. If `profiles.stripe_connect_account_id` is set,
  `transfer_data.destination` and `application_fee_amount` are sent;
  otherwise the charge falls back to platform-only (manual payout).
- Phase 2 (Connect Express onboarding) is the remaining work to make
  destination charges fire for real. Until then, charges land on the
  platform account and require admin action to forward to sellers.

## Schema / Supabase

- `profiles` is the canonical user table. Tier resolution goes through
  `subscription_tier` (text: `free` / `collector` / `enthusiast` / `vendor` / `shop`)
  with legacy boolean fallback (`is_premium`, `is_vendor`, `is_admin`).
  **The old `vendor` tier was renamed to `enthusiast`** (see migration
  `migration_tier_rename_vendor_to_enthusiast.sql`) — same feature set,
  dropped to $10/mo, added a 40-listing concurrent active marketplace
  cap. The NEW `vendor` tier sits between enthusiast and shop at $50/mo,
  150-listing cap, and unlocks non-TCG product listing + product scanner
  access. `shop` is $150/mo / unlimited. (Collector is $5/mo.) Anywhere old code
  wrote `tierAtLeast('vendor')` for OLD vendor features (bulk CSV, sales
  archive, multi-binder, etc.) has been retargeted to
  `tierAtLeast('enthusiast')`. New `tierAtLeast('vendor')` references
  now mean the new vendor tier. Listing caps live in `TIER_LISTING_CAPS`
  and are enforced via `canCreateListing()` / `listingsRemaining()`.
  Enthusiast tier is restricted to TCG SINGLES only — sealed products
  (booster boxes, ETBs, tins, decks) and non-TCG products (Funko, Manga,
  etc.) are vendor+ exclusives. Client check: `canListSealed()` /
  `canListNonTCG()`. Server-side: same trigger
  (`enforce_listing_cap`) in `migration_listing_cap_rls.sql` also
  enforces this — an enthusiast cannot insert a listing whose
  `product_type` is anything other than `'single'` or `'tcg_single'`.
- `catalog` is the canonical card table. Multi-TCG: id is prefixed by
  language/game (`en-`, `jp-`, `pd-` for Pokemon; `mtg-`, `ygo-`, `op-`
  for other TCGs). `game_type` column for explicit filtering.
  `has_reverse_holo` (bool) marks rows whose printing has a Reverse Holo
  variant — see "Variants" below.
- `collection_items` is per-user owned cards. `api_card_id` references
  the catalog id. `game_type` should match the catalog row's game.
  `variant` (text, default `'normal'`) records which finish the user
  owns — each `(api_card_id, variant)` pair is its own row per the
  two-row binder model. See "Variants" below.
- `listings` carries the same `variant` column so marketplace listings
  can disambiguate finish (a Normal Charizard and a Reverse Holo
  Charizard are different products with different prices).
- `listings.api_card_id` (and `listings.card_number`) link a
  marketplace listing back to the canonical `catalog` row — same
  shape as `collection_items.api_card_id`. Nullable: sealed-product
  and non-TCG product listings (Funko, manga) don't have a catalog
  row. All NEW TCG single listings must populate it. The
  binder-detail "+ List for Sale" button passes `apiCardId` +
  `cardNumber` + `variant` through `openListCardModal`'s prefill,
  which stashes them in `_lcPrefillCatalog` for the insert. Schema
  is in `migration_listings_catalog_link.sql` (also includes a
  best-effort name+game backfill for pre-existing listings, and
  re-runs the inventory listed_online_qty backfill that the original
  shop-inventory migration couldn't do).

### Variants (Normal / Reverse Holo / Holo / 1st Edition Holo)

Pokemon cards exist in multiple FINISHES. Originally the catalog stored
one row per `(set, number)` and finishes lived only as pokemontcg.io
price-object keys. That made master-set tracking impossible — a "200-
card set" actually has ~350+ collector slots when reverse-holos count.

The model now:
- **`catalog.has_reverse_holo`** — does this card's printing have a
  Reverse Holo variant? Populated by
  `sync_tcgplayer_via_free_apis.py` (looks for `reverseHolofoil` in
  pokemontcg.io's `tcgplayer.prices` object). Migration
  `migration_card_variants.sql` adds the column + a partial index.
- **`collection_items.variant`** — `'normal'` (default), `'reverse_holo'`,
  `'holo'`, `'1st_edition_holo'`. Two-row model: a user who owns both
  Normal and Reverse Holo of the same card has TWO `collection_items`
  rows, one per variant.
- **`listings.variant`** — same enum. Marketplace browse filters by it
  via `browseVariantFilter`.

JS touchpoints:
- `pendingCollectionCard.variant` flows into `saveToCollection` and
  `quickAddScannedCard`. Default `'normal'`.
- `_atcRefreshVariantChips()` renders the picker in the add modal.
  Fired automatically by `openModal('addToCollectionModal')`.
- `_renderBinderVariantChips()` renders the picker in the card detail
  modal. Clicking an un-owned variant chip calls `_addVariantOfCard()`
  which inserts a new `collection_items` row for that variant.
- `_promptVariantChoice()` is a lightweight overlay used by the scanner
  save path to ask Normal vs Reverse Holo before the silent insert.
- Set completion (`#setsDetailProgress`) shows "Base: X/total · Reverse
  Holo: Y/RH-total" when the set has any RH printings.
- `ownedMap` in set-detail loaders is the variant-aware shape:
  `{ card_id: { normal: row?, reverse_holo: row?, item: legacyRow } }`.
  `.item` is the legacy single-row pointer so renderers that haven't
  been migrated still find a truthy "is owned" signal.

When adding a new finish (e.g. `'cosmos_holo'`, `'reverse_holo_promo'`):
1. Add a flag column on catalog (`has_cosmos_holo` etc.) if the variant
   is set-specific.
2. Add the value to the `lcVariant` `<select>` and `_atcRefreshVariantChips`
   chip list.
3. Add it to the marketplace `variantFilter` select.
4. Update `_renderBinderVariantChips` if you want a clickable chip.
5. Bump the sync script to detect the new finish from the upstream
   data source.
- Migrations are printed to the browser console by admin "Print SQL"
  buttons — copy-paste pattern, not auto-run. Keep migrations idempotent
  (`create if not exists`, `create or replace`, `drop policy if exists`).
- Beta testers have their own table `beta_testers` with a public-read
  view `public_beta_testers` that exposes only `(user_id, tier)`.

### Per-unit metadata (Vendor+ tier)

Vendor and Shop tiers can mark each physical copy of a multi-quantity
card with its own condition / grade / cert / notes / photo. Lives in
`public.collection_item_units` (see `migration_collection_item_units.sql`).

Model:

- One row per physical card. `collection_item_id` references the
  parent `collection_items` row; `ordinal` is the 1..N stack position.
- Every override column is **NULL = inherit from parent**. The vendor
  only fills in what differs unit-to-unit.
- `status` is `in_stock` (default) / `sold` / `listed` / `reserved`.
  The parent's `quantity` is still the aggregate "how many do I own."

Lazy creation: rows are NOT backfilled at migration time. The first
time a vendor opens the per-unit stack on a card with `qty > 1`,
`_ensureUnitsForItem` creates N inheriting rows. Cards that never
get opened stay in the consolidated single-row world.

UI: `_mountUnitStackIntoBinderDetail` swaps the binder detail modal's
single photo slot for a swipeable stack (CSS in `.pb-unit-stack-*`,
JS helpers `_renderUnitStack` / `_advanceUnitStack` /
`_attachUnitStackSwipe`). Each slide shows the unit's effective
condition badge (top-left) + ordinal (top-right) + EDIT button
(bottom-right). The Edit Unit modal saves a patch via `_updateUnit`.

Touch points to remember when extending:

- `_resolveUnitDisplay(unit, parent)` computes the effective values
  (override OR parent). Use this everywhere a unit needs to be
  rendered consistently with parent fallbacks.
- The stack only mounts when `tierAtLeast('vendor')` AND `qty > 1`.
  Lower tiers see the original single photo slot.
- Future Phase B: `shop_sales` will gain a nullable `unit_id` and
  the Mark N Sold modal will surface a "pick specific unit" link
  (defaults to FIFO oldest in_stock unit). Listings stay aggregate
  per the v1 scope decision.

### Shop inventory (Vendor+ tier)

Vendor and Shop tiers see an Inventory tab on the Account page that
splits each `collection_items.quantity` into:

- **`on_shelf_qty`** — units physically in the shop
- **`listed_online_qty`** — units currently active on the PathBinder
  marketplace (sum of `listings.quantity` for that `(user_id,
  api_card_id, variant)`)
- **`shop_sku`** — optional user-defined SKU / barcode

Invariant: `on_shelf_qty + listed_online_qty <= quantity`. The
difference covers units reserved in an in-progress order or
intentionally held back.

In-store sales go through a dedicated append-only ledger,
`shop_sales` (id, user_id, collection_item_id, api_card_id, variant,
qty, unit_price, total_price, payment_method, notes, sold_at,
created_at). An INSERT trigger `apply_shop_sale_to_inventory`
decrements `on_shelf_qty` AND `quantity` on the matching
`collection_items` row in the same transaction — clients do not
update the counters themselves.

Schema is in `migration_shop_inventory.sql`. RLS scopes
`shop_sales` to the row owner and gates INSERT on
`subscription_tier IN ('vendor','shop')`.

UI surfaces, by phase:

1. **Step 1 (shipped):** read-only Inventory tab + Add Card defaults
   `on_shelf_qty = quantity` for vendor+ users.
2. **Step 2 (shipped):** `$ SOLD` button per row → Mark N Sold modal
   (qty / unit price / payment method / notes / sold_at) → writes
   `shop_sales`, trigger decrements `on_shelf_qty` + `quantity` in
   the same transaction. Sales Log tab (vendor+, sibling of
   Inventory) with date-range filter + summary tiles + CSV export
   (`pathbinder-sales-YYYY-MM-DD.csv`).
3. **Step 3 (shipped):** POS scan mode — `⊞ POS SCAN` button on the
   Inventory header sets `window._posSaleMode = true` and opens the
   existing card scanner. `confirmScanMatch` short-circuits when
   the flag is set, routing to `_posSaleFromMatch(cardId)` which
   finds the matching `collection_items` row (prefer Normal variant
   with on-shelf stock) and opens the Mark N Sold modal. After
   submit, the modal closes and the scanner reopens for the next
   sale until the vendor taps EXIT POS. `closeCardScanner` clears
   POS mode on direct close (X / backdrop); `_posSaleFromMatch`
   inlines the hide so the loop survives across the modal handoff.
4. **Step 4 (shipped):** Cross-channel reconciliation. Two halves:
   - **Bookkeeping hooks** — on listing insert, `_invOnListingCreated`
     moves N from `on_shelf_qty` → `listed_online_qty`. On
     `deactivateListing`, `_invOnListingReleased` reverses it. On
     `saveTracking` (order → shipped), `_invOnListingShipped`
     decrements both `listed_online_qty` and `quantity`.
   - **POS pre-flight** — `_posPreflightListings` runs at
     `submitMarkSold` when `qty > on_shelf_qty`. If a paid-but-
     unshipped order exists against any matching listing the sale
     is BLOCKED with "ship the order instead." If only active
     unsold listings exist, the delist confirmation modal prompts:
     "Pull N from your listing(s)?" with a don't-ask-again checkbox
     that flips `localStorage['pb_auto_delist_on_pos'] = '1'`. On
     confirm, `_executeDelistAndSell` pulls from the smallest
     listing first (clears single-card listings cleanly) — partial
     pulls reduce `listings.quantity`, full pulls flip to inactive.
     Then `_invOnListingReleased` puts the pulled units back on
     shelf and the `shop_sales` insert fires normally. Vendor never
     deals with money flow — Stripe is untouched.

Touch points to remember when extending:

- `saveToCollection` (search for `_insertBase.on_shelf_qty`) defaults
  on-shelf to `quantity` for vendor+. Has a graceful schema-error
  fallback that strips `on_shelf_qty` when the migration isn't
  installed.
- `renderInventory` / `_invRowHtml` / `_invSummaryTile` render the
  read-only table.
- `_showInventoryTab` toggles `.js-vendor-only` elements based on
  `tierAtLeast('vendor')`. Called from `renderAccount`.
- POS / sale-recording should NEVER touch Stripe — see Stripe ToS
  section above. In-store sales are cash/card-on-shop's-own-terminal;
  PathBinder just logs them for the shop's records.

## Adding a new TCG

When a new game (e.g. Flesh and Blood, Lorcana, Digimon) gets added to the
catalog, several places need a matching update or the app silently degrades.
Treat this list as the required checklist for any TCG addition:

1. **`pokedata_sync.py`** — add the game to `get_game_type()` and
   `get_id_prefix()`. The `game_type` column value (lowercase, no spaces)
   and the id prefix (e.g. `gun-`, `dbz-`) must match what gets used
   everywhere else.

2. **Scanner TCG detector** (`detectScanTcg` in `index.html`, near
   `detectOcrLanguage`). Add a signal block scoring keywords / format
   patterns unique to that game. Add the new game key to the `scores`
   object initialiser AND to the `forEach(['magic','yugioh',…])` loop
   that picks the winner. Without this, scans of the new game will
   route to Pokemon search and surface nothing.

3. **Sets page CFG** (`{ key, prefix, label, name }` block in the
   sets-detail view) — controls the TCG tab + browse filter.

4. **Game dropdowns** — listing modal, marketplace browse filter, and
   anywhere else a `<option value="…">` enumerates games.

5. **PriceCharting URL enrichment** — extend
   `sync_pc_singles_enrich.py` / `sync_sealed_products.py` with the
   game's PC category slug so price refresh can include those rows.

6. **Add to nightly refresh** — verify `refresh_catalog_prices.py`
   picks up the new game_type (it does by default if the rows have
   `price_source_url` set, but confirm the workflow's `--tcg` arg).

Forgetting #2 is the most common silent failure — scans for the new
game return Pokemon false positives instead of relevant cards.

## Background workers / sync scripts

- `pokedata_sync.py` is the consolidated multi-TCG sync. Use
  `--tcg <name>` to scope per game. Without it, the mirror would race
  across all games on the same row set.
- `cleanup_png_storage.py` is the destructive cleanup tool. Always
  `--dry-run` first.
- Image mirrors should be Ctrl-C-safe — the script filters by
  `image_url like '%pokedata.io%'` so already-mirrored rows are skipped
  on restart.

## Scanner — catalog match cascade

The scanner's catalog query for sealed/product scans uses a
three-tier cascade that runs **per candidate phrase**:

1. **Tier 1** — `game_type` + `product_type` + name match (strictest)
2. **Tier 2** — drop `product_type`
3. **Tier 3** — drop `game_type` (name-only)

Tier 3 always runs for every candidate. Earlier versions gated it
to "only on the last candidate after all earlier tiers returned
empty," which meant a brand-line OCR garble (e.g. `KU GAM` instead
of `POKEMON`) would leave `game_type=null` for the whole call and
the GOOD candidates (`CHAOS RISING`, `MEGA EVOLUTION`) would never
get a search — only the OCR garbage at the end would. Fix: every
candidate gets at least the name-only search, scoring handles the
rest.

**PostgREST `.or()` wildcard gotcha.** When writing `.or(...)`
clauses in supabase-js, use `*` not `%` for ilike wildcards:

```js
// BROKEN — sends literal % chars to Postgres; matches nothing.
.or('name.ilike.%CHAOS%,set_name.ilike.%CHAOS%')

// CORRECT — translates to ILIKE '%CHAOS%' in SQL.
.or('name.ilike.*CHAOS*,set_name.ilike.*CHAOS*')
```

`sb.from(...).ilike('col', '%term%')` does the conversion for you,
but raw `.or()` strings are sent through as-is. Strip commas and
parens from interpolated values too — both are PostgREST clause
syntax.

**`product_type IS NULL` filter trap.** A naive
`.neq('product_type', 'single')` silently drops every row where
`product_type IS NULL` — Postgres treats `NULL != 'single'` as NULL
(unknown), which the WHERE filter rejects. If you need "anything
except single," filter client-side in JS after the query (where
`pt === 'single'` evaluates honestly on NULL):

```js
rows.filter(r => {
  const pt = String(r.product_type || '').toLowerCase();
  return pt !== 'single' && pt !== 'tcg_single';
});
```

**Stitched OCR composite.** `_stitchForOcr(dataURL)` builds a
single composite that contains the top ~38% of the card + a 2×
upscaled bottom ~30%, dropping the middle artwork. This lets Vision
spend its text-detection budget on the two regions that actually
carry text (title/HP/stage at top; rules + set code at bottom)
instead of being eaten by holo sparkle in the artwork. Reliably
catches tiny bottom-corner identifiers like `MEP EN 023`,
`OP12-108`, `SVP IN 237` that the original full-image OCR pass
routinely missed.

**Sealed extractor buzzword dictionary.** `SET_BUZZWORDS` in
`_extractSealedFromOcr` is a ~400-word list of TCG set-name
vocabulary (Pokemon, MTG, OP, YGO, Digimon, Flesh and Blood,
Gundam, DBZ). Each token a candidate phrase hits scores +5. Real
set names hit multiple tokens (`OUTLAWS OF THUNDER JUNCTION` hits
`outlaws +5`, `thunder +5`, `junction +5` = +15) while OCR garbage
hits zero. When a new TCG release ships, just add its distinctive
words to the list — no other code changes needed.

## Discord bot

**Deferral is OFF by default.** Both `DEFER_PUBLIC_SLASH` and
`DEFER_EPHEMERAL_SLASH` are empty sets. Every command responds
synchronously. Rationale: the bot is kept warm by the
`/api/discord-bot?warm=1` Vercel cron (every 4 min), the lazy
Supabase client init caches after first use, and even the heaviest
handler (`/movers`) is well under the 3-second Discord ack window
after the v8 RPC migration. The deferred-PATCH path is still wired
but unused; if a future handler legitimately needs >3s, add its
name to the appropriate Set and it'll switch to deferred-ack mode
without other changes.

**Lazy Supabase client.** `sb` at the top of `api/discord-bot.js`
is a `Proxy` that calls `require('@supabase/supabase-js') +
createClient()` on first property access, not at module load time.
Saves ~300-500ms of cold-start that would otherwise eat into the
3-second window. Cached after first hit. PING interactions (Discord
verifies the endpoint every few seconds) never trigger the import.

**`maxDuration: 60`.** Set in two places —
`module.exports.config` at the top of the file AND re-attached
after `module.exports = handler` overwrites it later. Without this
the Hobby plan's 10-second default kills any handler that runs
long, leaving Discord stuck on "thinking…" forever.

**Per-RPC timeout.** `handleMovers` wraps each `sb.rpc(...)` in
`_withTimeout(..., 8000)` and uses `Promise.allSettled` instead of
`Promise.all` so one slow game can't block the others. Tunable via
the `MOVERS_RPC_TIMEOUT_MS` env var.

**Movers RPC scaling.** `get_global_price_movers` v8 takes
`p_min_value` (defaults to `1.0`) — skips catalog rows under $X
before the LATERAL join into `catalog_price_history`. Drops scan
work from ~42K rows to ~5-8K and execution time from ~4.7s to
~380ms. The website's call sites can override with `p_min_value:
0` to include cheap commons; the bot keeps the default.

## Catalog photo contributions

User-submitted catalog images. Phase 1 ships missing-image fill
only (replacement / new-row creation is bookmarked).

**Schema** (`migration_catalog_image_contributions.sql`):
- `catalog.image_contributed_by` / `image_contributed_at` — attribution
- `catalog_image_contributions` — pending/approved/rejected queue
- `user_can_contribute_image(uuid)` — eligibility check
- `user_contribution_trust_tier(uuid)` — `first_time` / `verified` (5+ approved) / `trusted` (25+ approved, 0 strikes in 90d)
- `apply_image_contribution(uuid, uuid)` — approval transaction (atomic update of `catalog.image_url` + credit stamping)
- `reject_image_contribution(uuid, uuid, text)` — rejection w/ reason

**Eligibility:** Collector+ tier, account age ≥ 30 days, ≥50 cards
in collection, 0 active strikes (3 rejections in 90 days = revoked
for 90 more days). Admins always pass.

**Storage:** bucket `catalog-contributions` (public read), policies
in `migration_catalog_contributions_storage_policies.sql`. INSERT
gated by `user_can_contribute_image()`.

**Scanner integration:** when a catalog hit has NULL `image_url`
AND the user passes the eligibility check (cached per page load),
the scan preview sheet surfaces a "CONTRIBUTE THIS PHOTO" CTA.
Click → uploads the existing scan capture to the bucket, inserts
the row, and either auto-approves (verified+ contributors via
`apply_image_contribution`) or queues for admin review (first-time
contributors).

**Admin UI:** Account → Admin → Catalog Image Contributions.
Renderer is `renderAdminContributionQueue()` in pb-app.js. Sorted
oldest-first, side-by-side: submission + card meta + current image
(if any) + APPROVE / REJECT buttons.

**Display:** subtle italic byline on the binder detail modal
(`_loadContributorByline`) links to the contributor's public
profile. Profile stats row in the seller-profile modal shows
"N photos contributed" with `Curator` / `Trusted Curator` /
`Archivist` badge (`_fillProfileContribStat`). Both async-loaded
after the modal opens.

## Bulk CSV vendor import — two sheets

`PathBinder_Vendor_Template.xlsx` has TWO sheets:

- **Singles** — Card Name, Set Name, Card Number, Condition, Grade,
  Cert #, Cost, Price, **Quantity**, Notes. Game defaults to
  Pokemon, product_type to single. Grade/Cert columns are
  first-class because graded singles are the main use case.

- **Sealed** — Product Name, Set Name, **Game**, **Product Type**,
  Cost, Price, **Quantity**, Notes. No Grade/Cert (don't apply).
  Game + Product Type are required per row.

`handleVendorImportFile` reads both sheets and tags each row with
`_sourceSheet` (`singles` / `sealed`). The import loop branches on
that tag — singles default `condition='raw'`, sealed default
`condition='sealed'`. Backward-compat: old single-sheet templates
named `Inventory` still import as singles.

`VALID_PRODUCT_TYPES` set in the import code matches
`SEALED_PATTERNS` enum values from `sync_sealed_products.py`.
Unknown values fall back to `single`. Adding a new sealed format
means adding it to both lists.

`on_shelf_qty = quantity` defaulted for vendor+ users (Phase 1 shop
inventory pattern). Same schema-fallback cascade as
`quickAddScannedCard` — strips `on_shelf_qty` then `product_type`
if the DB is on an older schema.

## Service worker — must-revalidate strategy

`vercel.json` serves `/sw.js` with
`Cache-Control: public, max-age=0, must-revalidate`. Browser caches
the file but re-validates with the server on every page load, so
new SW deploys land within seconds instead of the 24-hour default
SW re-check window.

**Skip-waiting + claim** in `sw.js` install handler activates new
SWs immediately without requiring all old tabs to close.

**Page-side polling** in pb-app.js calls `reg.update()` every 5
minutes (only when the tab is visible) and listens for
`updatefound` to post `{type:'SKIP_WAITING'}` to a waiting SW. When
the new SW takes control, a non-disruptive toast offers REFRESH
instead of auto-reloading mid-task.

**Vercel cron** at `*/4 * * * *` hits `/api/keepalive` (and
separately `/api/discord-bot?warm=1`) to keep the serverless
function instances warm. Both endpoints return a tiny `{ok:true}`
without touching Supabase.

## CLS / Speed Insights audit

Fixed (from the original 0.42 audit):
- Removed `padding-left/right` transitions from `body` and `width`
  transition from `nav` (`pb-critical.css`). Sidebar collapse used
  to animate the entire content area sliding 140px on every toggle.
- Added `min-width:80px; display:inline-block` to the hero stat
  values (`heroTotalCards`, `heroMarketCap`). The em-dash → number
  swap on data load used to cause a 70px horizontal reflow.

Bookmarked for later:
- Card grid: add `aspect-ratio: 245/342` to `.card-thumb` /
  `.listing-card .lc-thumb-wrap` to reserve space before images
  load.
- Sidebar avatar: use `flex: 0 0 200px` instead of `flex: 0 1 auto`
  so the avatar slot doesn't grow when the image arrives.
- Landing hero `pokedex.webp`: add `aspect-ratio: 600/400` in CSS.

## Auth-state hint script (no landing-page flash)

Inline `<script>` at the top of `<body>` in `index.html`
synchronously checks `localStorage` for any
`sb-<projectref>-auth-token` key with an `access_token` field
present. If found, removes `body.on-landing` and injects a
fixed-position skeleton overlay (PathBinder wordmark + animated
cyan dots) that covers the landing page. Polls for
`#accountPage.active` to drop the skeleton; 6-second hard timeout
as a safety valve.

Zero overhead for signed-out users (no token → script returns
immediately). For signed-in users, hides the flash between initial
HTML paint and `initApp()` restoring the session.

## Syntax check pipeline

After non-trivial JS edits to `index.html`:

```bash
cd /Users/charleshewitt/Desktop/cardfrac
python3 -c "
import re, subprocess
with open('index.html') as f:
    html = f.read()
scripts = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.DOTALL)
for i, s in enumerate(scripts):
    if not s.strip(): continue
    with open(f'/tmp/check_{i}.js', 'w') as f:
        f.write(s)
    r = subprocess.run(['node', '--check', f'/tmp/check_{i}.js'], capture_output=True, text=True)
    print(f'Block {i}: {\"OK\" if r.returncode == 0 else \"FAIL: \" + r.stderr[:500]}')
"
```

Every block must report OK.
