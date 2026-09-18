# Runbook — Batch-ingest missing sets

`ingest_missing_sets.py` + `ingest_manifest.json` replace the one-set-at-a-time
`import_tcgcsv_set.py` ritual with a single run. The biweekly new-set probe
(`new_sets_<date>.md`) feeds the manifest; you run the batch.

## The one command

```bash
cd ~/Desktop/cardfrac
export SUPABASE_URL=https://xjamytrhxeaynywcwfun.supabase.co
export SUPABASE_SERVICE_KEY=…            # service-role key, never the publishable one

python3 ingest_missing_sets.py            # 1. dry-run: resolves groups, previews every set, writes nothing
python3 ingest_missing_sets.py --commit   # 2. writes singles + sealed, embeds, enriches, fixes, verifies
```

Read the dry-run scoreboard before committing. Every set shows the exact
`import_tcgcsv_set.py` command it will run, the first five ids it would
create, and the row count. Sets already in the catalog are skipped
automatically (singles and sealed are checked separately, so `OP17` skips its
130 present singles but still imports its missing sealed products).

The dry-run needs no secrets — it falls back to the public key in
`supabase.js` for read-only probes. `--commit` refuses to run without
`SUPABASE_SERVICE_KEY`.

## What a full `--commit` does, in order

| Stage | Tool | Notes |
|---|---|---|
| plan | tcgcsv `/categories` + `/groups` | Verifies each category by name and each group id by name; unresolved sets are listed and skipped, never guessed. |
| singles | `import_tcgcsv_set.py --group … --set-code … --set-name …` | `--set-name` is always passed (omitting it is how JP M5/M6 got named "M5"/"M6"). |
| sealed | `import_tcgcsv_set.py --sealed` | Booster boxes / packs / cases from the same group, as `sealed-<prefix>-tcg-<pid>`. Works before PriceCharting lists the set. |
| mirror | `mirror_tcgplayer_images.py --set-code … --game …` (singles), `mirror_sealed_from_tcgplayer.py --game … --group … --replace-hosted` (sealed) | The importer stores TCGplayer's CDN URL in `image_url`; this copies each image into the `card-images` bucket (WebP + 200/400 variants) and rewrites `image_url`, like every earlier import. Both scripts skip rows already on the bucket. Sealed rows match by `tcgplayer_product_id` (exact), never by name. |
| embed | `embed_catalog_rows.py --id-prefix <prefix>-<code>-` | Scanner CLIP embeddings. Needs `torch transformers Pillow supabase` locally; skipped with a message if missing. |
| enrich | `sync_pc_singles_enrich.py --tcg …`, `sync_sealed_products.py --tcg …` | Once per affected game, whole-game PriceCharting passes. Slow. Only games with a config in the manifest's `enrich` block. |
| fixes | REST `PATCH` | `set_name` backfills listed under `fixes` (currently JP M5 → Abyss Eye, M6 → Storm Emeralda). |
| verify | REST counts | Re-counts every set after writing; flags any set that ended with fewer rows than the preview promised. |

Logs: `ingest_logs/ingest_<timestamp>.log` (every subprocess line) and a
`.json` summary beside it. Exit code is non-zero if anything failed.

## Useful flags

```bash
--only MAMO,ST-31,AOV        # subset by manifest key or set_code
--stages mirror               # e.g. just mirror images for sets already imported
--stages singles,sealed,fixes # pick stages (default: all six)
--skip enrich                 # everything except the slow PriceCharting passes
--enrich-games onepiece       # limit the enrich stage to some games
--plan                        # resolve + probe only, no subprocesses at all
--include-disabled            # run entries with "enabled": false (the upcoming sets)
--force                       # import even if rows exist / set_code collides
--timeout 7200                # per-subprocess seconds (default 3600)
```

A set whose TCGplayer group exists but has no products yet (pre-release, or a
Japanese group that lags) is reported as **RETRY LATER**, not a failure.
Re-run `--only <key>` once it is live.

## Refreshing a set after launch day

TCGplayer keeps adding products to a group for days after release (and
tcgcsv rebuilds once a day, ~20:00 UTC). To pull in whatever appeared since
the first import:

```bash
python3 ingest_missing_sets.py --only 30C,30CC --force --skip enrich   # dry-run first
python3 ingest_missing_sets.py --only 30C,30CC --force --skip enrich --commit
```

`--force` means "re-import even though the set is present". The importer
upserts by id, so this is safe to repeat: new products become new rows,
existing rows get their metadata refreshed, and **rows that already carry a
mirrored image keep it** (the importer strips `image_url` from the payload
for those, so a refresh never un-mirrors a set). The mirror and embed stages
then only touch the genuinely new rows. `--skip enrich` avoids re-running
the whole-game PriceCharting passes for a handful of cards.

Numbering collisions: reprint sets that keep original numbering (30th
Celebration Classic Collection: Palkia LV.X `106/106`, M Gardevoir EX
`106/160`, Shining Celebi `106/105`) used to fold into one row. The importer
now folds only when the *full* printed number matches (true variants —
rarities, borderless, parallels); distinct cards sharing a prefix get
`{id}-{denominator}` ids (`en-30cc-106-160`) and store the full number in
`card_number`. The plain id always goes to the same row it did before, so
re-runs never move existing rows.

## Editing the manifest

One entry per TCGplayer group. Minimum fields: `key`, `game`, `category`,
`category_name`, `set_code`, `set_name`, and either `group` (explicit id) or
`group_match` (substrings that must all appear in exactly one group name).
Set `"sealed": true` to also import the group's sealed products. Keep
`"enabled": false` on future sets and flip it (or use `--only KEY
--include-disabled`) when they ship.

To find a group id by hand:

```bash
curl -s https://tcgcsv.com/tcgplayer/68/groups | python3 -m json.tool | grep -B2 -A6 '"Set Sail'
```

Category ids as of 2026-09: Magic 1 · YuGiOh 2 · Pokemon 3 · One Piece 68 ·
Lorcana 71 · DBS Fusion World 80 · Pokemon Japan 85 · Gundam 86.

## Set-code conventions the manifest follows

- Pokemon EN: TCGplayer abbreviation upper-case (`ME05`, `30C`); id lower-case
  (`en-30c-021`). Subsets get their own code (`30CC` for the Classic
  Collection, mirroring `cel25` / `cel25c`).
- Pokemon JP: `--lang JA` → `jp-` prefix (`jp-m6a-001`).
- One Piece: hyphenated starter decks (`ST-31` → `op-st-31-ST31-001`), release
  event sets with a space (`OP17 RE` → `op-op17 re-OP17-001`) — both match the
  existing rows.
- Lorcana: three-letter codes (`AOV`), not TCGplayer's bare number.
- Yu-Gi-Oh: TCGplayer abbreviation (`MAMO` → `ygo-mamo-MAMO-EN001`).

## After the run

- Bump nothing — catalog-only change, no app-code bundle touched.
- The embed stage only covers the sets in the manifest. As of 2026-09-15 the
  catalog had ~70K rows with an image but no embedding (ME05, OP16, HOB,
  MSH, GD05, WLU, CORI, JP M5/M6 among them — every set imported between
  July and September was never embedded). The scanner's `match_cards` RPCs
  read `catalog.embedding`, so those cards are invisible to visual matching
  until the backlog is embedded:

  ```bash
  python3 embed_catalog_rows.py --all-missing --download-workers 4
  ```

  Expect several hours. Supabase Storage rate-limits downloads per IP; the
  script now backs off on 429 (honoring `Retry-After`), pauses all workers
  during the cool-down, halves the worker count when throttling persists,
  and re-tries throttled rows in a slow second pass. Rows it still could not
  fetch stay `NULL` and are picked up by the next `--all-missing` run, so
  Ctrl-C and re-run is always safe (pending embeddings are flushed on
  Ctrl-C). Permanent failures (400 = object missing from the bucket, 403 =
  TCGplayer has no image for the product) are written to
  `embed_failures_<timestamp>.json` — fix those as data, not by re-running.
- Some TCGplayer products have no image at all (the CDN answers 403): the
  `OP16 RE` release-event cards, the "Starter Decks 31–36 [Set of 6]" box,
  a handful of 30CC and sealed rows. They stay hotlinked and un-embedded
  until another image source is wired up (PriceCharting via
  `sync_pc_singles_enrich.py` for One Piece).
- Gundam / DBZ / Topps sealed still need PriceCharting slugs hand-added to
  `TCG_CONFIG` in `sync_sealed_products.py` before their `--tcg` pass finds
  anything (see the note on each upcoming Gundam entry).
- If the pokedata feed later assigns a different code to a set imported here
  (e.g. 30th Celebration), rename `set_code` rather than re-importing —
  `pokedata_sync.py` keys on set code and would otherwise create duplicates.
