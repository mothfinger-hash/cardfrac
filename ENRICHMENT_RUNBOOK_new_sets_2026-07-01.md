# New-set ingestion runbook — 2026-07-01

Six new sets to bring in this cycle (from `new_sets_2026-07-01.md`). All
commands write to Supabase, so set your service key first. TCGCSV steps
also need TCGplayer group IDs; the PriceCharting CSV steps need a PC API
key.

```bash
export SUPABASE_URL="https://xjamytrhxeaynywcwfun.supabase.co"
export SUPABASE_SERVICE_KEY="<service-role key>"       # NOT the anon/publishable key
export PRICECHARTING_API_KEY="<pricecharting api key>" # for enrich_from_pc_csv.py --category
```

Every importer here is **dry-run by default** — inspect output, then
re-run with `--commit`. Confirmed set codes are in the table below.

---

## What each step grabs

| Step | Script | Grabs |
|------|--------|-------|
| 1. Data + TCG IDs + images | `import_tcgcsv_set.py` | catalog rows **and** `tcgplayer_product_id` + `tcgplayer_url` + `image_url` (TCGplayer CDN, auto-upgraded to 1000×1000) — all in one pass |
| 2. PriceCharting numeric IDs | `enrich_pricecharting_ids.py` | `pricecharting_id` per row (extract-based; no PC API key unless `--verify`) |
| 3. PriceCharting prices + source URLs | `enrich_from_pc_csv.py --category` | `price_source_url` + prices (needs `PRICECHARTING_API_KEY`) |
| 4. Sealed products | `sync_sealed_products.py --tcg` | sealed booster/box/deck rows (Gundam via the `explicit_slugs` we added) |
| 5. Scanner embeddings | `embed_catalog_rows.py --only` | CLIP vectors so the scanner can match the new cards |

Images: step 1 already populates `image_url` from TCGplayer's CDN at
1000×1000, so cards render immediately. `mirror_singles_images.py` is
Pokemon-language-oriented (`--lang cn/…`) and does **not** cover
Magic/YGO/Gundam, so no separate mirror step is needed for these sets —
they serve straight from the TCGplayer CDN.

## Quick run order — all four sets (dry-run first, then add `--commit`)

```bash
# 1) DATA + TCG IDs + IMAGES  (dry-run — drop --commit to preview)
python3 import_tcgcsv_set.py --group 24553 --set-code MSH  --game magic  --commit
python3 import_tcgcsv_set.py --group 24621 --set-code BLGG --game yugioh --commit
python3 import_tcgcsv_set.py --group 24693 --set-code EB01 --game gundam --commit
python3 import_tcgcsv_set.py --group 24692 --set-code ST10 --game gundam --commit

# 2) PRICECHARTING NUMERIC IDs  (extract-based; no PC key needed)
python3 enrich_pricecharting_ids.py --tcg mtg
python3 enrich_pricecharting_ids.py --tcg yugioh
# Gundam has no PC category page — singles PC-ID match is unreliable; rely on
# TCGplayer prices for Gundam singles. Sealed is handled in step 4.

# 3) PRICECHARTING PRICES + source URLs  (needs PRICECHARTING_API_KEY)
python3 enrich_from_pc_csv.py --category magic-cards  --tcg magic  --dry-run
python3 enrich_from_pc_csv.py --category magic-cards  --tcg magic
python3 enrich_from_pc_csv.py --category yugioh-cards --tcg yugioh --dry-run
python3 enrich_from_pc_csv.py --category yugioh-cards --tcg yugioh

# 4) IMAGES — mirror TCGplayer-CDN art into our bucket as WebP (+200/400 variants)
python3 mirror_tcgplayer_images.py --set-code MSH,BLGG,EB01,ST10 --dry-run
python3 mirror_tcgplayer_images.py --set-code MSH,BLGG,EB01,ST10

# 5) SEALED PRODUCTS — scope to JUST the new sets with --only (bare --tcg
#    re-walks the entire category / all explicit_slugs, which is slow and
#    re-touches every existing set). Drop --dry-run once previews look right.
python3 sync_sealed_products.py --tcg magic  --only magic-marvel-super-heroes --dry-run
python3 sync_sealed_products.py --tcg yugioh --only yugioh-battles-of-legend-glorious-gallery --dry-run
python3 sync_sealed_products.py --tcg gundam --only gundam-eternal-nexus --dry-run
python3 sync_sealed_products.py --tcg gundam --only gundam-starter-deck-10-generation-pulse --dry-run
# If --only reports 0 products, the slug is off or PC hasn't listed the
# set's sealed yet — verify at https://www.pricecharting.com/console/<slug>

# 6) SCANNER EMBEDDINGS
python3 embed_catalog_rows.py --only MSH
python3 embed_catalog_rows.py --only BLGG
python3 embed_catalog_rows.py --only EB01
python3 embed_catalog_rows.py --only ST10

# 7) OP16 pricing (cards already loaded) — re-check PC availability, then:
python3 sync_pc_singles_enrich.py --tcg onepiece --only one-piece-the-time-of-battle --probe
python3 sync_pc_singles_enrich.py --tcg onepiece --only one-piece-the-time-of-battle
```

Images note: step 1 already sets `image_url` to TCGplayer's CDN so cards
render immediately; step 4 self-hosts them (WebP + 200/400 variants) so you
don't depend on TCGplayer's CDN and so the browser's `_pickThumbVariant`
size-picker works. Run step 4 after step 1 for each set.

---

## Lorcana bootstrap (all released sets — data only)

Lorcana is wired at the data layer (`GAME_PREFIX['lorcana']='lor'`) but NOT
in the app UI yet (no scanner detection, no Sets tab, no listing dropdown) —
that wiring is deliberately deferred. This step just loads the catalog rows
+ images.

```bash
# 1) CARDS — all 17 released sets (dry-run first, then --commit)
./ingest_lorcana.sh            # preview every set
./ingest_lorcana.sh --commit   # write every set

# 2) IMAGES — mirror every Lorcana single's art into our bucket as WebP
python3 mirror_tcgplayer_images.py --game lorcana --all --dry-run
python3 mirror_tcgplayer_images.py --game lorcana --all
```

Set codes assigned (letter codes, not TCGCSV's numeric abbrs, so the
`ilike lor-<code>-*` probes stay unambiguous):

| Code | Set | Code | Set |
|------|-----|------|-----|
| TFC | The First Chapter (1) | WIW | Whispers in the Well (10) |
| ROF | Rise of the Floodborn (2) | WSP | Winterspell (11) |
| ITI | Into the Inklands (3) | WLU | Wilds Unknown (12) |
| URR | Ursula's Return (4) | QDT | Illumineer's Quest: Deep Trouble (Q1) |
| SSK | Shimmering Skies (5) | QPH | Illumineer's Quest: Palace Heist (Q2) |
| AZS | Azurite Sea (6) | D23 | D23 Promos |
| ARI | Archazia's Island (7) | D100 | Disney100 Promos |
| ROJ | Reign of Jafar (8) | DLPC | Disney Lorcana Promo Cards |
| FAB | Fabled (9) | | |

Excluded (not yet released as of 2026-07-01): set 13 "Attack of the Vine!"
(group 24666, 2026-07-17), set 14 "Hyperia City" (24740), Q3 (24734). The
biweekly probe will surface these when they drop.

Deferred for when you wire Lorcana into the UI (CLAUDE.md new-TCG checklist):
scanner `detectScanTcg` block, Sets-page CFG tab, listing/browse game
dropdowns, and PriceCharting price enrichment (verify PC has a
`lorcana-cards` category slug).

Any set_code above you don't like — change it in `ingest_lorcana.sh` before
committing; the dry-run shows exactly what each will create.

---

The per-set detail sections below expand on each of these.

| TCG | Set | Code | TCGplayer groupId | Released | In catalog | Work |
|-----|-----|------|-------------------|----------|------------|------|
| Pokemon EN | Chaos Rising | CRI | (pokedata) | 2026-05-22 | YES | none (done) |
| Magic | Marvel Super Heroes | MSH | **24553** | 2026-06-26 | NO | singles + sealed + embed |
| Yu-Gi-Oh | Battles of Legend: Glorious Gallery | BLGG | **24621** | 2026-06-05 | NO | singles + pricing + embed |
| One Piece | The Time of Battle | OP16 | (loaded) | 2026-06-12 | YES (cards) | PC pricing only |
| Gundam | Eternal Nexus (EB01) | EB01 | **24693** | 2026-06-26 | NO | singles + sealed + embed |
| Gundam | Starter Deck 10: Generation Pulse | ST10 | **24692** | 2026-06-26 | NO | singles + sealed + embed |
| Magic | The Hobbit | HOB | 24683 | **2026-08-14** | NO | **DEFER** — not out until Aug; Aug biweekly run will catch it |

Optional related groups (decide whether to carry as separate set_codes): Magic `HOC` The Hobbit: Eternal-Legal = **24691**, Promo Pack: The Hobbit = **24690**; Magic `MSC` Commander: Marvel Super Heroes = **24554**, Art Series `AAMSH` = **24725**.

---

## 1. Magic — Marvel Super Heroes (MSH)   [The Hobbit deferred — see below]

Singles come from TCGCSV (`import_tcgcsv_set.py`), not `pokedata_sync.py`.

```bash
# preview (dry-run)
python3 import_tcgcsv_set.py --group 24553 --set-code MSH --game magic
# write
python3 import_tcgcsv_set.py --group 24553 --set-code MSH --game magic --commit
```

Then sealed + prices (Magic is auto-discovered on PC — no slug edits):

```bash
python3 sync_sealed_products.py --tcg magic
python3 enrich_from_pc_csv.py --category magic-cards --tcg magic --dry-run
python3 enrich_from_pc_csv.py --category magic-cards --tcg magic
```

Embeddings so the scanner can match them:

```bash
python3 embed_catalog_rows.py --only MSH
```

Optional related MSH groups if you carry them separately: Commander
`MSC` (group 24554), Art Series `AAMSH` (group 24725).

**The Hobbit (HOB, group 24683) is DEFERRED** — TCGCSV lists it as
`publishedOn 2026-08-14`, i.e. it releases in August 2026, not this
window. The August biweekly probe will surface it. When it's out:
`import_tcgcsv_set.py --group 24683 --set-code HOB --game magic --commit`
(+ Eternal-Legal `HOC` group 24691, Promo Pack group 24690 if wanted).

---

## 2. Yu-Gi-Oh — Battles of Legend: Glorious Gallery (BLGG)

```bash
# singles via TCGCSV
python3 import_tcgcsv_set.py --group 24621 --set-code BLGG --game yugioh          # dry-run
python3 import_tcgcsv_set.py --group 24621 --set-code BLGG --game yugioh --commit

# rarity fill (YGOPRODeck source)
python3 pokedata_sync.py --enrich-rarity --tcg 'Yu-Gi-Oh'

# pricing (auto-discovered category — picks up BLGG rows)
python3 enrich_from_pc_csv.py --category yugioh-cards --tcg yugioh --dry-run
python3 enrich_from_pc_csv.py --category yugioh-cards --tcg yugioh

# embeddings
python3 embed_catalog_rows.py --only BLGG
```

---

## 3. One Piece — OP16 "The Time of Battle"  (cards already loaded)

Only PriceCharting pricing is pending. The 2026-06-12 runbook noted PC
had the OP16 page but 0 cards listed. Re-check now (3 weeks post-release):

```bash
python3 sync_pc_singles_enrich.py --tcg onepiece --only one-piece-the-time-of-battle --probe
python3 sync_pc_singles_enrich.py --tcg onepiece --only one-piece-the-time-of-battle
```

Re-check PC availability first:
https://www.pricecharting.com/console/one-piece-the-time-of-battle

---

## 4. Gundam — Eternal Nexus (EB01) + Generation Pulse (ST10)

Config already updated: both slugs added to
`TCG_CONFIG['gundam'].explicit_slugs` in `sync_sealed_products.py`
(`gundam-eternal-nexus` confirmed on PC; `gundam-starter-deck-10-generation-pulse`
follows the ST01 slug convention — confirm on PC before relying on it).

```bash
# singles via TCGCSV
python3 import_tcgcsv_set.py --group 24693 --set-code EB01 --game gundam          # dry-run
python3 import_tcgcsv_set.py --group 24692 --set-code ST10 --game gundam          # dry-run
python3 import_tcgcsv_set.py --group 24693 --set-code EB01 --game gundam --commit
python3 import_tcgcsv_set.py --group 24692 --set-code ST10 --game gundam --commit

# sealed (now that explicit_slugs includes both)
python3 sync_sealed_products.py --tcg gundam

# embeddings
python3 embed_catalog_rows.py --only EB01
python3 embed_catalog_rows.py --only ST10
```

---

## Post-ingest checklist

- [ ] `refresh_catalog_prices.py` (or nightly) picks up the new
      `price_source_url` rows.
- [ ] Sets page CFG / scanner `detectScanTcg` already cover these games
      (Magic/YGO/OP/Gundam are established) — no new-TCG checklist needed.
- [ ] Spot-check each set in the app: Sets page tab + a scan test.
- [ ] Verify Gundam `gundam-generation-pulse` actually matched sealed
      products; if 0 hits, swap to the starter-deck-NN slug form.
