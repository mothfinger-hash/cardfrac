# TCGCSV Integration Plan

Scoping doc for ingesting TCGplayer pricing + product IDs from
[tcgcsv.com](https://tcgcsv.com/docs) into PathBinder. No code yet — this is
the matching strategy, schema touch points, request budget, and a phased
rollout for review.

## What TCGCSV gives us

A once-daily, server-side cache of TCGplayer's own API, free, no Partner API
approval:

- **Categories** = games. Pokemon = categoryId 3; Magic, Yu-Gi-Oh, One Piece,
  etc. all present.
- **Groups** = sets. `groupId` (stable PK), `name`, `abbreviation`,
  `publishedOn`.
- **Products** = cards + sealed. `productId` (stable PK), `name`, `cleanName`,
  `imageUrl`, `url`, and `extendedData` (Number, Rarity, HP, etc.).
- **Prices** = `lowPrice / midPrice / highPrice / marketPrice / directLowPrice`,
  one row **per `subTypeName`** (Normal / Holofoil / **Reverse Holofoil**),
  joined to products by `productId`.

This is the same shape `sync_tcgplayer_via_free_apis.py` already consumes from
pokemontcg.io — except it covers every game, not just the three with a free
upstream, and it carries the Reverse Holo split natively.

## The wins (recap)

1. Real TCGplayer market prices for **OP / Gundam / DBZ / Topps** — the games
   currently blocked on Partner API approval.
2. A genuine **Reverse Holofoil** price instead of just the `has_reverse_holo`
   boolean.
3. Stable `productId` + canonical buy URL → the Sets/binder modal stops
   falling back to a TCGplayer name search.
4. A second sealed-pricing source to sanity-check PriceCharting.

## Matching strategy (the hard part)

The whole integration lives or dies on mapping a TCGCSV product to the right
`catalog` row. Three nested joins:

### 1. Category to game_type

Static dict in the script, mirroring `get_game_type()`:
`{3: 'pokemon', <magic>: 'mtg', <ygo>: 'ygo', <op>: 'op', ...}`. One-time
lookup; only need the ~6 categories we carry. Pull the full categories list
once to grab the current IDs and hardcode them with a comment.

### 2. Group to set (catalog set_code / set_name)

This is the messy one. TCGCSV `groupId` / `abbreviation` (e.g. `SWSH12`) do not
match our `set_code` (e.g. `CRI`) or `set_metadata.id` (e.g. `me4`) — the same
mismatch that already forced the set_name fallback in `loadSetDetail`.

Proposal: a small persisted mapping table `tcgplayer_group_map
(group_id int pk, category_id int, game_type text, set_code text, set_name
text, confidence text, mapped_at timestamptz)`. Resolve once by fuzzy-matching
group `name`/`abbreviation` against `set_metadata.name` + `catalog.set_name`
within the same game, write the result, and reuse it on every later run so we
never re-fuzzy. Unmapped groups get logged for a quick manual pass — far
cheaper than re-guessing nightly.

### 3. Product to card (catalog row)

Within a resolved set, match by **card number first** (TCGCSV
`extendedData.Number` like `139/195` → strip to `139`, compare to
`catalog.card_number`), then disambiguate by `cleanName`. Number-in-set is the
strongest signal and avoids name-normalization fights (punctuation, "VSTAR" vs
"V-STAR", promos). Products with no `Number`/`Rarity` in `extendedData` are
sealed — route those to the sealed path, not singles.

## Schema touch points

- **`catalog`**: add `tcgplayer_product_id bigint` (nullable) + optional
  `tcgplayer_url text`. Partial index on `tcgplayer_product_id`. New migration,
  idempotent (`add column if not exists`). The buy-URL can also be synthesized
  from the product id, so storing the id alone may be enough. The affiliate
  wrapper (below) is applied at render time, not stored, so links stay
  re-pointable if the affiliate prefix ever changes.
- **`card_prices`**: already keyed `(catalog_id, source)`. Write
  `source = 'tcgplayer'` from `marketPrice` (Normal subtype). **TCGCSV replaces
  `sync_tcgplayer_via_free_apis.py` as the sole writer of the `tcgplayer`
  source** for all games — the free-API script is retired (kept in the repo,
  removed from the nightly schedule) once TCGCSV is proven. One writer, one
  source, no freshest-wins reconciliation needed.
- **Subtype prices stored separately** (decided): each `subTypeName` is its own
  `card_prices` source string — `tcgplayer` (Normal), `tcgplayer_reverse_holo`,
  `tcgplayer_holo`, etc. The existing `(catalog_id, source)` key holds them all
  with no schema change, and the binder's RH variant chip reads its own source.
- **`tcgplayer_group_map`**: new small table above. Set-level, a few hundred
  rows total.

## Affiliate links (TCGplayer / Impact)

TCGplayer's affiliate program runs through Impact.com on a branded vanity
domain (`partner.tcgplayer.com`, equivalently `tcgplayer.pxf.io`). A deep link
wraps the destination product URL in a percent-encoded `u` parameter behind
your tracking prefix.

**Your prefix (confirmed):**

```
TCGPLAYER_AFFILIATE_PREFIX = "https://partner.tcgplayer.com/c/7431583/1780961/21018"
```

Final link shape:

```
{PREFIX}?u={percent-encoded product URL}
```

Worked example — Lugia VSTAR (productId 451396):

```
https://partner.tcgplayer.com/c/7431583/1780961/21018?u=https%3A%2F%2Fwww.tcgplayer.com%2Fproduct%2F451396%2Fpokemon-swsh12-silver-tempest-lugia-vstar
```

(Paste that in a browser to confirm it redirects and registers a click in
Impact before we ship.)

Implementation:

- Store **only the bare TCGplayer product URL / `productId`** on the catalog row.
  Never bake the affiliate prefix into stored data.
- Add the `TCGPLAYER_AFFILIATE_PREFIX` config constant above plus one helper
  `tcgAffiliateUrl(productUrl)` returning
  `PREFIX + '?u=' + encodeURIComponent(productUrl)`.
- Route every TCGplayer link in the app through that helper — the Sets modal,
  binder detail, and price-comp buttons. This is pure URL construction at
  render time, so CORS / server-side rules don't apply; it's safe client-side.
- Optional: append a `sharedid` param (e.g. `binder`, `sets-modal`) per surface
  so the Impact dashboard shows which screen drives clicks.

## Request budget + etiquette

Per the docs: ≤10k requests / 24h, 100ms sleep between calls, custom
`User-Agent` (e.g. `PathBinderSync/1.0`), and check `last-updated.txt` before
doing anything.

For our ~6 games: 1 (categories) + ~6 (groups, one per category) + 2 per group
(products + prices). Even at ~150 groups/game that is roughly
`6 + 900 groups x 2 = ~1,800` requests — comfortably under the 10k ceiling, and
about 4-5 minutes wall-clock at 100ms spacing. We can also skip groups whose
`modifiedOn` hasn't advanced since last run to shrink it further.

Hard rule: **server-side only**. CORS blocks browser fetch by design, and that
matches how every other PathBinder price source already works — this never
touches client code.

## Where it plugs into existing jobs

- New script `sync_tcgcsv.py`, `--tcg <name>` scoped like `pokedata_sync.py`,
  with a `--last-updated-guard` that no-ops when `last-updated.txt` is stale.
- The nightly `refresh_catalog_prices.py` workflow gains it as a step (or it
  runs as its own daily cron, since TCGCSV only rebuilds once/day anyway).
- First run is a backfill (product IDs + group map); subsequent runs are
  price-only deltas.

## Decisions (locked)

1. **Subtype prices stored separately** — one `card_prices` source per
   `subTypeName` (`tcgplayer`, `tcgplayer_reverse_holo`, ...). No schema change.
2. **TCGCSV replaces the free-API script** — it becomes the sole `tcgplayer`
   price writer for all games; `sync_tcgplayer_via_free_apis.py` is dropped from
   the nightly schedule once TCGCSV is verified.
3. **Group-map seeding + one-time cleanup** — fuzzy-resolve groups into
   `tcgplayer_group_map`, then a single manual pass to fix the stragglers.
4. **Sealed folded in** — ingest TCGCSV sealed-product prices too (separate
   source so they never collide with singles).
5. **Affiliate links** — store bare product URL; wrap through a
   `TCGPLAYER_AFFILIATE_PREFIX` config + helper at render time.

## Suggested phasing

- **Phase 1** — categories + group map + product-ID + bare-URL backfill. No
  price writes. Proves the matching and lights up affiliate links immediately
  (links don't need prices). Wire `tcgAffiliateUrl()` here.
- **Phase 2** — write `tcgplayer` market prices for the 4 previously blocked
  games (OP/Gundam/DBZ/Topps). High-value, low-risk.
- **Phase 3** — cut Pokemon/MTG/YGO over to TCGCSV as the `tcgplayer` source
  and retire `sync_tcgplayer_via_free_apis.py` from the schedule; add the
  Reverse Holo + other subtype sources.
- **Phase 4** — TCGCSV sealed-product prices.

## Ready to build

All decisions locked and the affiliate prefix is in hand
(`partner.tcgplayer.com/c/7431583/1780961/21018`). Nothing outstanding — Phase 1
can start whenever you give the word.
