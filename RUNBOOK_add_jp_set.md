# Runbook — Add a new Japanese Pokémon set (singles + sealed)

Example: **Abyss Eye**
- PriceCharting: https://www.pricecharting.com/console/pokemon-japanese-abyss-eye
- pokedata (singles images): https://www.pokedata.io/set/Abyss+Eye#cards

**Model (Option B):**
- **Singles** → *data* (ids, price links, prices) from **PriceCharting**, *images* from **pokedata**.
- **Sealed** → *data* and *images* both from **PriceCharting** (pokedata has no box art).

Run these yourself (they need `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` and network
to PC/pokedata). **Always `--dry-run` first** — eyeball the parse before writing.

---

## 1. Singles — DATA from PriceCharting (ids + price links up front)

```
# DRY RUN FIRST — check the card-number parse looks right (#173 → "173", etc.)
python3 sync_pc_singles_enrich.py --tcg pokemon-jp \
    --only "pokemon-japanese-abyss-eye" --create-missing --dry-run

# real
python3 sync_pc_singles_enrich.py --tcg pokemon-jp \
    --only "pokemon-japanese-abyss-eye" --create-missing
```
- Inserts each card as `jp-pc-{pricecharting_id}` (matches the app's `id like 'jp-%'`
  JP Sets view) with `pricecharting_id` + `price_source_url` already set — no backfill.
- The `pokemon-japanese-` slug prefix is stripped, so this set lands as
  `set_code="abyss-eye"`, `set_name="Abyss Eye"` automatically.
- If a set's slug is messy and the derived name is wrong, pin it:
  `--set-name "Abyss Eye" --set-code "abyss-eye"` (must match pokedata's set name
  so step 2 can find the images).

> ⚠ The card-number extractor was tuned for Gundam/DBZ codes. Pokémon JP uses
> `#173` / `#001/064` style. The `--dry-run` prints each `[dry-insert]` — confirm
> the numbers look right. If any are blank/wrong, tell me the PC title format and
> I'll widen `NUMBER_RE`.

## 2. Singles — IMAGES from pokedata (matched by set_name + card_number)

```
python3 fetch_jp_pokedata.py --only "Abyss Eye" --upload --dry-run
python3 fetch_jp_pokedata.py --only "Abyss Eye" --upload
```
Swaps each single's image to the pokedata CDN (and mirrors to your `card-images`
bucket with `--upload`). It also overwrites `set_name` with pokedata's exact name,
keeping the singles + (future) image rows consistent.

---

## 3. Sealed — PriceCharting data + box images

```
python3 sync_sealed_products.py --tcg pokemon --only "pokemon-japanese-abyss-eye" --dry-run
python3 sync_sealed_products.py --tcg pokemon --only "pokemon-japanese-abyss-eye"

# mirror PC box images into Storage
python3 mirror_sealed_images.py --tcg pokemon --dry-run
python3 mirror_sealed_images.py --tcg pokemon
```
Sealed rows land as `sealed-jp-pc-{pricecharting_id}`.

---

## 4. Prices (optional refresh later)
```
python3 refresh_catalog_prices.py --tcg pokemon
```

---

## 5. Verify (Supabase SQL)
```sql
-- singles (PC-sourced)
select id, name, card_number, set_name, pricecharting_id, price_source_url, image_url
from catalog
where id like 'jp-pc-%' and set_name ilike '%abyss%'
order by card_number;

-- sealed
select id, name, set_name, product_type, price_source_url
from catalog
where id like 'sealed-jp-%' and (set_name ilike '%abyss%' or set_code ilike '%abyss%')
order by name;
```

---

## Notes / gotchas
- **game_type:** existing JP rows from older scripts have `game_type = NULL`; the
  `pokemon-jp` config writes `game_type='pokemon'` on new rows (more correct going
  forward). Re-running upserts by `id` (`jp-pc-{pcid}`), so no duplicates.
- **Set grouping:** the JP Sets page lists distinct `set_code`s from `jp-`/`pd-`
  catalog rows, so this set appears once you've inserted the singles. Sealed shows
  under it via the lenient `set_name ILIKE` match.
- If sealed doesn't appear under the set after syncing, align names:
  `update catalog set set_name='Abyss Eye' where id like 'sealed-jp-%' and set_name ilike '%abyss eye%';`
