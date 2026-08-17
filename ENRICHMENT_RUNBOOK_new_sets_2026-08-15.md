# New-set ingestion runbook — 2026-08-15

From `new_sets_2026-08-15.md`. This cycle: **1 real ingest (Magic HOB)**,
**1 sealed-sync (Gundam GD05 — code already added)**, **1 metadata backfill
(Pokemon M6)**.

All DB writes need your **service role** key — the automated probe run does not
have it, which is why these are a manual step. Set credentials first:

```bash
export SUPABASE_URL="https://xjamytrhxeaynywcwfun.supabase.co"
export SUPABASE_SERVICE_KEY="<service-role key>"       # NOT the anon/publishable key
export PRICECHARTING_API_KEY="<pricecharting api key>" # for enrich_from_pc_csv.py --category
```

Every importer is **dry-run by default** — inspect output, then re-run with
`--commit`. Confirmed IDs below (group IDs cross-verified against tcgcsv.com and
the 2026-07-01 runbook, which pre-listed HOB=24683).

| TCG | Set | Code | Group ID | Released | In catalog? |
|-----|-----|------|----------|----------|-------------|
| Magic | The Hobbit | `HOB` | **24683** | 2026-08-14 | NO → ingest |
| Magic | The Hobbit: Eternal-Legal | `HOC` | 24691 | 2026-08-14 | NO → optional |
| Gundam | Freedom Ascension | `GD05` | (singles already in catalog) | 2026-07-24 | singles YES, sealed slug added |

---

## 1. Magic HOB "The Hobbit" — full ingest

```bash
# 1a) DATA + TCG IDs + IMAGES (TCGplayer CDN 1000x1000) — dry-run, then --commit
python3 import_tcgcsv_set.py --group 24683 --set-code HOB --game magic          # preview
python3 import_tcgcsv_set.py --group 24683 --set-code HOB --game magic --commit

# 1b) PriceCharting numeric IDs (extract-based; no PC key needed)
python3 enrich_pricecharting_ids.py --tcg mtg

# 1c) PriceCharting prices + source URLs (needs PRICECHARTING_API_KEY)
python3 enrich_from_pc_csv.py --category magic-cards --tcg magic --dry-run
python3 enrich_from_pc_csv.py --category magic-cards --tcg magic

# 1d) Sealed products for HOB (booster boxes / bundles / Collector Boosters)
python3 sync_sealed_products.py --tcg magic --only magic-the-hobbit --dry-run
python3 sync_sealed_products.py --tcg magic --only magic-the-hobbit

# 1e) Scanner embeddings so the scanner can match the new cards
python3 embed_catalog_rows.py --only HOB
```

Magic serves images straight from the TCGplayer CDN (step 1a fills `image_url`),
so no separate `mirror_tcgplayer_images.py` step is required for HOB.

**Optional — HOC (eternal-legal variant), group 24691.** Only if you want it as
a separate set_code; same recipe with `--group 24691 --set-code HOC`.

## 2. Gundam GD05 "Freedom Ascension" — sealed sync

The explicit slug `gundam-freedom-ascension` has **already been added** to
`TCG_CONFIG["gundam"]["explicit_slugs"]` in `sync_sealed_products.py` (this
session). Singles are already in the catalog (`gun-gd05-*`); this just pulls the
sealed boxes/packs.

```bash
python3 sync_sealed_products.py --tcg gundam --only gundam-freedom-ascension --dry-run
python3 sync_sealed_products.py --tcg gundam --only gundam-freedom-ascension
```

If the `--dry-run` returns 0 products, the PC slug differs from the guess —
verify the real slug on the PriceCharting Gundam console page and update the one
line in `sync_sealed_products.py`.

## 3. Pokemon M6 "Storm Emeralda" — set_name backfill

M6 is already ingested (115 rows, `jp-m6-*`) but every row's `set_name` is the
placeholder `"M6"`. Backfill the real name. Run in the Supabase SQL editor (or
psql) with a role that can write:

```sql
-- Idempotent: only rewrites the placeholder rows.
update public.catalog
set    set_name = 'Storm Emeralda'
where  set_code = 'M6'
  and  id like 'jp-m6-%'
  and  set_name = 'M6';
-- expect ~115 rows updated
```

---

## Post-ingest verification

```bash
# HOB rows landed?
curl -s "$SUPABASE_URL/rest/v1/catalog?set_code=eq.HOB&select=id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" -I | grep -i content-range
# M6 name fixed?
curl -s "$SUPABASE_URL/rest/v1/catalog?set_code=eq.M6&select=set_name&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"
```

Also confirm the Adding-a-new-TCG checklist items are **not** needed here — Magic
and Gundam are already fully wired (scanner detector, sets CFG, dropdowns, PC
enrichment). HOB is a new *set* within an existing game, so no code changes
beyond the sealed slug already added.
```
