# Price-tracking enrichment runbook — new sets (2026-06-12)

Three new sets need PriceCharting price tracking. All commands write to
Supabase, so set your service key first (and a PriceCharting API key for
the CSV-based steps):

```bash
export SUPABASE_SERVICE_KEY="<service-role key>"
export PRICECHARTING_API_KEY="<pricecharting api key>"   # for enrich_from_pc_csv.py --category
```

Always run a `--dry-run` / `--probe` pass first where offered.

---

## 1. Pokemon — Chaos Rising (set_code `CRI`)  ✅ ready now

Cards are already in the catalog (`en-cri-*`). They just need a
`price_source_url`. Released 2026-05-22, so PriceCharting has the data.

```bash
python3 enrich_pokemon_pc_urls.py --lang en --only-set CRI --probe   # preview matches
python3 enrich_pokemon_pc_urls.py --lang en --only-set CRI           # write URLs
```

Then resolve numeric IDs + pull prices on the next nightly
`refresh_catalog_prices.py` run (or run it manually scoped to Pokemon).

---

## 2. Yu-Gi-Oh — Blazing Dominion (set_code `BLZD`)  ✅ ready now

Cards are already loaded. Two passes: rarity, then pricing.

### 2a. Rarity (fills NULL rarities for all YGO rows, incl. BLZD)

Source is YGOPRODeck, not pokedata (pokedata's feed is Pokemon-only) —
same command, just noting the real source:

```bash
python3 pokedata_sync.py --enrich-rarity --tcg 'Yu-Gi-Oh'
```

Add `--enrich-overwrite` only if you want to replace existing rarities;
default fills NULLs only.

### 2b. Pricing (sets price_source_url + ingests prices in one pass)

`enrich_from_pc_csv.py` fetches the whole `yugioh-cards` category CSV
from PriceCharting and matches by name + set, so it picks up BLZD's rows:

```bash
python3 enrich_from_pc_csv.py --category yugioh-cards --tcg yugioh --dry-run
python3 enrich_from_pc_csv.py --category yugioh-cards --tcg yugioh
```

(If you'd rather not pull the full category, download the Blazing
Dominion CSV from PriceCharting and pass `--csv ~/Downloads/blzd.csv`.)

---

## 3. One Piece — OP16 "The Time of Battle"  ⏳ wait for PriceCharting

Cards + images are loaded and rarities are already set from the official
list. The PC slug `one-piece-the-time-of-battle` is already configured in
`sync_pc_singles_enrich.py`.

BLOCKER: PriceCharting has the OP16 page (Set Code OP16) but **0 cards
listed** — it shows "This set will release 2026-06-12, check back soon."
Enrichment today would match nothing. Wait until PC publishes the
checklist (typically days–weeks after release), confirm with `--probe`,
then run:

```bash
python3 sync_pc_singles_enrich.py --tcg onepiece --only one-piece-the-time-of-battle --probe
python3 sync_pc_singles_enrich.py --tcg onepiece --only one-piece-the-time-of-battle
```

Re-check PC availability before running:
https://www.pricecharting.com/console/one-piece-the-time-of-battle

---

## Summary

| Set | In catalog | Rarity | Pricing | Status |
|-----|-----------|--------|---------|--------|
| Pokemon CRI | yes | n/a | `enrich_pokemon_pc_urls.py --lang en --only-set CRI` | ready |
| YGO BLZD | yes | `pokedata_sync.py --enrich-rarity --tcg 'Yu-Gi-Oh'` | `enrich_from_pc_csv.py --category yugioh-cards --tcg yugioh` | ready |
| OP16 | yes | already set | `sync_pc_singles_enrich.py --tcg onepiece --only one-piece-the-time-of-battle` | wait for PC |
