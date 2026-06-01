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

### Bump the service worker cache on UI changes

`sw.js` has a `CACHE = 'pathbinder-vXX'` constant. Increment it any time
HTML/JS/CSS visibly changes, otherwise users won't see the update.

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
  dropped to $20/mo, added a 40-listing concurrent active marketplace
  cap. The NEW `vendor` tier sits between enthusiast and shop at $75/mo,
  150-listing cap, and unlocks non-TCG product listing + product scanner
  access. `shop` is unchanged at $200/mo / unlimited. Anywhere old code
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
