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
| embed | `embed_catalog_rows.py --id-prefix <prefix>-<code>-` | Scanner CLIP embeddings. Needs `torch transformers Pillow supabase` locally; skipped with a message if missing. |
| enrich | `sync_pc_singles_enrich.py --tcg …`, `sync_sealed_products.py --tcg …` | Once per affected game, whole-game PriceCharting passes. Slow. Only games with a config in the manifest's `enrich` block. |
| fixes | REST `PATCH` | `set_name` backfills listed under `fixes` (currently JP M5 → Abyss Eye, M6 → Storm Emeralda). |
| verify | REST counts | Re-counts every set after writing; flags any set that ended with fewer rows than the preview promised. |

Logs: `ingest_logs/ingest_<timestamp>.log` (every subprocess line) and a
`.json` summary beside it. Exit code is non-zero if anything failed.

## Useful flags

```bash
--only MAMO,ST-31,AOV        # subset by manifest key or set_code
--stages singles,sealed,fixes # pick stages (default: all five)
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
- Gundam / DBZ / Topps sealed still need PriceCharting slugs hand-added to
  `TCG_CONFIG` in `sync_sealed_products.py` before their `--tcg` pass finds
  anything (see the note on each upcoming Gundam entry).
- If the pokedata feed later assigns a different code to a set imported here
  (e.g. 30th Celebration), rename `set_code` rather than re-importing —
  `pokedata_sync.py` keys on set code and would otherwise create duplicates.
