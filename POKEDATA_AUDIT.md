# Pokedata Scripts — Audit & Plan

## What's there today

Three scripts that work together but with notable seams between them:

### 1. `fetch_jp_pokedata.py` (398 lines)
- Scrapes JP set list from Pokedata's `__NEXT_DATA__` (rendered Next.js page state)
- For each JP card already in `catalog`, probes the public Pokedata CDN
  (`pokemoncardimages.pokedata.io/images/{Set}/{N}.webp`) and updates
  `image_url` to match
- `--fill-missing` flag: for sets Pokedata has but catalog doesn't, probes the
  CDN numerically (1, 2, 3…) and creates new catalog rows with `pd-` prefix
- Creates entries with **blank `name` and `rarity`** — needs API or manual fix

### 2. `fetch_en_pokedata.py` (309 lines)
- Same scraping approach for EN sets
- Probes CDN with EN's quirks: `+` for spaces, zero-padded numbers (`001`)
- Downloads images, uploads to Supabase Storage (so the live app can serve
  from `xjamy…supabase.co/.../card-images/...` instead of the Pokedata CDN)
- Creates `en-{code}-{num}` catalog rows, **also blank name + rarity**

### 3. `generate_jp_catalog.py` (407 lines)
- **Different source entirely** — uses TCGdex API (not Pokedata)
- Generates CLIP embeddings for the scanner (`pip install transformers torch`)
- This is what populates the `name` and `rarity` fields that the Pokedata
  scripts leave blank — but only when the card is in TCGdex
- Has checkpointing (`jp_catalog_checkpoint.txt`) so a Ctrl+C resumes

## Gaps the audit found

1. **Blank `name`/`rarity` on every `en-*` and `pd-*` entry.** The scripts
   literally have a comment that says "fill in manually or via pokedata paid
   API later." This is the single biggest reason to want the API key.

2. **No pricing data ever gets written.** Pokedata's API exposes prices on
   their paid tiers; right now we get zero of that into our DB.

3. **No "enrich existing catalog row" mode.** The current `fetch_*` scripts
   only fix images on rows that already have data, or create fresh rows.
   Nothing fills missing fields on existing rows (e.g. an `en-sv1-046` that
   has an image but blank name — there's no script that says "go ask the
   API for this card's name and patch it in").

4. **Three copies of the same Supabase boilerplate.** Each script duplicates
   the connection setup, HTTP session, retry logic, upsert helper. Worth
   factoring into a `_pb_common.py` later.

5. **CDN URL schemes are brittle.** JP uses raw set name, EN uses `+`-encoded
   set name with zero-padded numbers. If Pokedata changes the CDN structure,
   both scripts break silently (they just return zero matches). The API will
   give us authoritative image URLs to use instead.

6. **No rate-limit handling.** Current scripts use a hardcoded 50ms delay.
   The API will have a documented RPS limit per tier — needs to respect it.

7. **Set codes don't always match between sources.** Pokedata uses one set of
   codes (`sv1`, `s12a`), TCGdex uses another, your catalog uses a third for
   `pd-` cards. The `JP_SET_TRANSLATIONS` map in `index.html` handles display,
   but the import scripts need to be aware too so they don't create
   duplicates with different codes for the same set.

## What the API key changes

| Today (scraping)              | With API key                            |
|-------------------------------|-----------------------------------------|
| Set list from HTML scrape     | `/v0/sets` — clean JSON, with codes     |
| Image URLs from CDN probe     | Card response includes authoritative URL|
| **No card metadata**          | `/v0/set?set_id=N` — names, rarities    |
| **No prices**                 | `/v0/pricing?card_id=X`                 |
| No rate limit awareness       | Tier-based RPS, documented              |
| Brittle to site redesigns     | Stable contract                         |

The path forward:
- Keep the scraping scripts as they are (they work, no key required, useful as a fallback)
- Add `pokedata_api.py` for everything the key unlocks
- New script's primary jobs: (a) enrich blank rows, (b) ingest brand-new sets, (c) populate prices
