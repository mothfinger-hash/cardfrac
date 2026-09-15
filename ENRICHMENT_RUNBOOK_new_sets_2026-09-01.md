# New-set ingestion runbook — 2026-09-01

From `new_sets_2026-09-01.md`. This cycle: **2 real ingests** (One Piece
`OP-17`, Dragon Ball Fusion World `ST01`), **1 sealed-sync** (dbfusion — slug
already in config), **1 metadata backfill** (Pokemon `M6`, carried over from
2026-08-15).

All DB writes need your **service role** key — the automated probe run does not
have it, which is why these are a manual step. Set credentials first:

```bash
export SUPABASE_URL="https://xjamytrhxeaynywcwfun.supabase.co"
export SUPABASE_SERVICE_KEY="<service-role key>"       # NOT the anon/publishable key
export PRICECHARTING_API_KEY="<pricecharting api key>"
```

Every importer is **dry-run by default** — inspect output, then re-run with
`--commit`.

## STEP 0 — group IDs (RESOLVED — no lookup needed)

**All group IDs below came from `tcgplayer_group_map` in Supabase**, which the
daily `sync-tcgcsv.yml` workflow (cron `0 9 * * *`) refreshes with `--tcg all`.
No curl against tcgcsv.com is required — the table is **anon-readable**:

```bash
K='sb_publishable_HeBrC8k5nKaBmqA9qMn6-Q_YqL8OEBV'
B='https://xjamytrhxeaynywcwfun.supabase.co/rest/v1/tcgplayer_group_map'
curl -s -H "apikey: $K" -H "Authorization: Bearer $K" \
  "$B?confidence=eq.unmatched&select=group_id,category_id,game_type,group_name&order=group_id.desc"
```

`confidence='unmatched'` means TCGCSV has the group but the sync could not tie
it to a catalog `set_code` — i.e. **exactly the new-set signal this whole probe
is trying to produce.** See §5 for why this should replace most of the skill's
current procedure.

**Search `group_name`, not `set_name`.** Unmatched rows have `set_code` and
`set_name` set to NULL; the human-readable name lives in `group_name`. Querying
`set_name=ilike.*Strongest*` returns nothing and looks like a clean negative.

Category IDs (resolved 2026-09-01): **One Piece = 68**, **Dragon Ball Super
Fusion World = 80**. Note 80 is Fusion World's own category — *not* 27
(Dragon Ball Super CCG → `dbsccg`) or 23 (legacy Panini DBZ TCG → `dbz`).

| TCG | Set | Code | Group ID | Released | In catalog? |
|-----|-----|------|----------|----------|-------------|
| One Piece | The World's Strongest Warriors | `OP17` | **24736** ✅ | 2026-08-28 | NO → ingest |
| One Piece | …Release Event Cards | `OP17 RE` | **24775** ✅ | 2026-08-28 | NO → ingest (see §1.2) |
| One Piece | Double Pack Set Vol.12 | `DP-12` | (sealed, auto-discovered) | 2026-08-28 | NO → optional |
| Dragon Ball FW | Story Booster 01 | `ST01` | **24680** ✅ | 2026-08-21 | NO → ingest |
| One Piece | The Time of Battle Release Event Cards | `OP16 RE` | **24677** ✅ | (prior cycle) | NO → backfill, see §1.2 |

---

## 1. One Piece OP-17 "The World's Strongest Warriors" — full ingest

Expected: ~135 card types landing as `op-op17-*`, `game_type=onepiece`.

```bash
# 1a) DATA + TCG IDs + IMAGES — dry-run, then --commit
python3 import_tcgcsv_set.py --group 24736 --set-code OP17 --game onepiece \
    --set-name "The World's Strongest Warriors"
python3 import_tcgcsv_set.py --group 24736 --set-code OP17 --game onepiece \
    --set-name "The World's Strongest Warriors" --commit

# 1b) PriceCharting numeric IDs (extract-based; no PC key needed)
python3 enrich_pricecharting_ids.py --tcg onepiece

# 1c) PriceCharting prices + source URLs (needs PRICECHARTING_API_KEY)
python3 enrich_from_pc_csv.py --category one-piece-cards --tcg onepiece --dry-run
python3 enrich_from_pc_csv.py --category one-piece-cards --tcg onepiece

# 1d) Sealed — auto-discovered from the PC category page; also picks up DP-12
python3 sync_sealed_products.py --tcg onepiece --dry-run
python3 sync_sealed_products.py --tcg onepiece

# 1e) Mirror images off the TCGplayer CDN into the card-images bucket
python3 mirror_tcgplayer_images.py --set-code OP17 --game onepiece --dry-run
python3 mirror_tcgplayer_images.py --set-code OP17 --game onepiece
python3 mirror_sealed_from_tcgplayer.py --group 24736 --game onepiece --dry-run
python3 mirror_sealed_from_tcgplayer.py --group 24736 --game onepiece

# 1f) Scanner embeddings — NOTE the flag is --id-prefix, NOT --only
python3 embed_catalog_rows.py --id-prefix op-op17- --dry-run
python3 embed_catalog_rows.py --id-prefix op-op17-
```

**Set-code shape:** use `OP17` (no hyphen). Confirmed against the sibling set —
OP-16 is stored as `set_code=OP16`, ids `op-op16-*`. Bandai's marketing writes
it `OP-17`; the catalog does not.

### 1.2 — OP17 RE "Release Event Cards" (group 24775)

**Recommended, not optional.** These are routinely carried: the catalog already
has `OP10 RE` (75), `OP11 RE` (75), `OP12 RE` (75), `OP14 RE` (89), `OP15 RE`
(82), plus the older `OP02 PRE`–`OP08 PRE` series. Skipping OP17 RE would break
an established pattern.

```bash
python3 import_tcgcsv_set.py --group 24775 --set-code "OP17 RE" --game onepiece \
    --set-name "The World's Strongest Warriors Release Event Cards"
python3 import_tcgcsv_set.py --group 24775 --set-code "OP17 RE" --game onepiece \
    --set-name "The World's Strongest Warriors Release Event Cards" --commit

python3 mirror_tcgplayer_images.py --set-code "OP17 RE" --game onepiece --dry-run
python3 mirror_tcgplayer_images.py --set-code "OP17 RE" --game onepiece
python3 embed_catalog_rows.py --id-prefix "op-op17 re-" --dry-run
python3 embed_catalog_rows.py --id-prefix "op-op17 re-"
```

**The set code contains a literal space — quote it.** The existing rows are
`set_code="OP14 RE"` with ids `op-op14 re-OP14-085`, i.e. the space survives
into the id. It's ugly, but it is the established convention (it falls out of
lowercasing the TCGCSV abbreviation), and matching it keeps the Sets page
grouping consistent. Do **not** "clean it up" to `OP17_RE` or `OP17-RE` for
this one set — that would make it the odd one out. If you want the convention
changed, that's a separate migration across all six existing RE/PRE sets.

> **Bonus finding — `OP16 RE` is a confirmed missed ingest.** Every recent
> booster has a release-event companion in the catalog *except* OP16: `OP16`
> "The Time of Battle" is present (149 rows) with no `OP16 RE`. The group
> **does** exist on TCGCSV — `24677`, "The Time of Battle Release Event Cards",
> sitting `unmatched` in the group map. Backfill it with the same recipe:
> ```bash
> python3 import_tcgcsv_set.py --group 24677 --set-code "OP16 RE" --game onepiece \
>     --set-name "The Time of Battle Release Event Cards"          # then --commit
> ```
> The probe skill missed this because it only checks *new releases in-window* —
> it has no "is the previous set fully ingested" check. The unmatched-group
> query in §5 catches this class for free.

## 2. Dragon Ball Fusion World ST01 "Story Booster 01" — full ingest

Expected: landing as `dbf-st01-*`, `game_type=dbfusion`.

```bash
# 2a) DATA + TCG IDs + IMAGES
python3 import_tcgcsv_set.py --group 24680 --set-code ST01 --game dbfusion \
    --set-name "Story Booster 01"
python3 import_tcgcsv_set.py --group 24680 --set-code ST01 --game dbfusion \
    --set-name "Story Booster 01" --commit

# 2b) Sealed — slug is ALREADY in TCG_CONFIG, just never synced
python3 sync_sealed_products.py --tcg dbfusion --only dragon-ball-fusion-world-story-booster-01 --dry-run
python3 sync_sealed_products.py --tcg dbfusion --only dragon-ball-fusion-world-story-booster-01

# 2c) Mirror images
python3 mirror_tcgplayer_images.py --set-code ST01 --game dbfusion --dry-run
python3 mirror_tcgplayer_images.py --set-code ST01 --game dbfusion

# 2d) Scanner embeddings
python3 embed_catalog_rows.py --id-prefix dbf-st01- --dry-run
python3 embed_catalog_rows.py --id-prefix dbf-st01-
```

**Two collision traps — read before running:**

1. **`--set-code ST01` collides with Gundam.** `set_code=eq.ST01` already
   returns `gun-st01-ST01-*` ("Starter Deck 01: Heroic Beginnings").
   `import_tcgcsv_set.py` will **warn** about this on the dry-run — that
   warning is expected and safe to proceed past, because the ids are
   namespaced by prefix (`dbf-` vs `gun-`) and the rows are discriminated by
   `game_type`. Do **not** "fix" it by renaming the set code.
2. **Do not use `SB01`.** `SB01_PR` is already taken in `dbfusion` by
   "Manga Booster 01 Release Event Cards" — unrelated to Story Booster 01.

**No PC price step for dbfusion.** `enrich_from_pc_csv.py` does not carry a
confirmed PriceCharting category slug for Fusion World — the source comments
list `dragon-ball-super-cards` as *probable* only, and the auto-category list
explicitly excludes it. Skipping the PC enrich means ST01 singles land without
PriceCharting prices; TCGplayer linkage from step 2a still applies. If you want
PC prices, confirm the slug first with:
`python3 sync_sealed_products.py --tcg dbfusion --debug-dump`.

## 3. Pokemon M6 "Storm Emeralda" — set_name backfill (carry-over)

Still open from the 2026-08-15 cycle. All 113 rows carry the placeholder
`set_name = 'M6'`.

```sql
update catalog set set_name = 'Storm Emeralda'
where id like 'jp-m6-%' and set_name = 'M6';
-- expect 113 rows
```

## 4. Pre-stage Gundam slugs (before 2026-09-25)

Not an ingest — a config edit that must land *before* the sets release, since
Gundam has no PriceCharting category page and sealed sync silently no-ops
without an explicit slug. Add to `TCG_CONFIG["gundam"]["explicit_slugs"]` in
`sync_sealed_products.py`:

```python
"gundam-starter-deck-11-aquatic-assault",   # ST11, 2026-09-25 — CONFIRM ON PC
"gundam-starter-deck-12-raging-onslaught",  # ST12, 2026-09-25 — CONFIRM ON PC
"gundam-starter-deck-13-silent-barrage",    # ST13, 2026-09-25 — CONFIRM ON PC
"gundam-starter-deck-14-heavy-dominion",    # ST14, 2026-09-25 — CONFIRM ON PC
"gundam-stardust-trails",                   # GD06, 2026-10-30 — CONFIRM ON PC
```

These follow the existing `gundam-starter-deck-01-heroic-beginnings` /
`gundam-freedom-ascension` convention but are **inferred, not verified** —
same caveat already carried inline on the GD05 and ST10 entries. Check each
against its live PriceCharting console page before relying on it.

**But you may not need PriceCharting at all here.** TCGplayer group IDs for
every one of these already exist in the group map (all `unmatched`), so the
singles can be imported the normal way the moment each set drops — no slug
guessing, no PC dependency:

| Set | Code | Group ID | Releases |
|---|---|---|---|
| Aquatic Assault | `ST11` | 24800 | 2026-09-25 |
| Raging Onslaught | `ST12` | 24801 | 2026-09-25 |
| Silent Barrage | `ST13` | 24802 | 2026-09-25 |
| Heavy Dominion | `ST14` | 24803 | 2026-09-25 |
| Stardust Trails | `GD06` | 24804 | 2026-10-30 |
| Blazing Fist | `GD07` | 24826 | 2027-01-29 |

The PC slugs are still worth adding for *sealed* products (boxes/decks), which
TCGCSV covers less consistently — but singles no longer block on them.

---

## Post-ingest verification

```bash
K="$SUPABASE_SERVICE_KEY"
B="https://xjamytrhxeaynywcwfun.supabase.co/rest/v1/catalog"
cnt () { echo -n "$1 = "; curl -s -H "apikey: $K" -H "Authorization: Bearer $K" \
  -H "Prefer: count=exact" -H "Range: 0-0" -I "$B?$2&select=id" | grep -i content-range; }

# OP-17 singles landed? (expect ~135)
cnt "op17 singles"  "game_type=eq.onepiece&id=like.op-op17-*"
# ST01 singles landed?
cnt "st01 singles"  "game_type=eq.dbfusion&id=like.dbf-st01-*"
# dbfusion sealed for Story Booster landed? (was 0 before)
cnt "dbf sealed SB" "id=like.sealed-dbf-*&set_name=ilike.*Story*"
# M6 name fixed? (expect 113 / 0)
cnt "m6 fixed"      "id=like.jp-m6-*&set_name=ilike.*Emeralda*"
cnt "m6 placeholder" "id=like.jp-m6-*&set_name=eq.M6"
# Collision guard — these must NOT have moved:
cnt "gundam ST01 intact" "game_type=eq.gundam&set_code=eq.ST01"   # expect unchanged
cnt "ygo OP17 intact"    "game_type=eq.yugioh&set_code=eq.OP17"   # expect 26
```

Then in the app: Sets page should show both new sets, and the scanner should
match a card from each (embeddings from steps 1f / 2d).

---

## 5. The probe procedure should change

The daily `sync-tcgcsv.yml` job already writes `tcgplayer_group_map` with
`--tcg all`, and `confidence='unmatched'` flags every TCGCSV group with no
catalog counterpart. That single anon-readable query is a **better new-set
detector than the skill's entire current procedure** for every TCGplayer-
carried game — no pokedata feed, no release-calendar web searches, no
tcgcsv.com fetch, no group-ID lookup step.

What this cycle's probe missed that the query surfaces immediately (all
`unmatched`, newest first):

| Game | Group | ID |
|---|---|---|
| Pokemon | ME06: Delta Reign | 24831 |
| Magic | Star Trek / Star Trek: Stardates | 24766 / 24771 |
| Magic | Mystery Booster Commander Edition | 24777 |
| Magic | Secret Lair x MSCHF: The Zeta Set | 24836 |
| Magic | Box Toppers - Retail | 24856 |
| Yu-Gi-Oh | Ultimate Tournament Pack 1 / 2 | 24704 / 24806 |
| Yu-Gi-Oh | Winner's Pack 2026-2027 | 24789 |
| Yu-Gi-Oh | Glorious Victors / Beyond the Brave | 24822 / 24815 |
| Yu-Gi-Oh | Magnificent Maestros / Maze of Muertos | 24808 / 24559 |
| One Piece | Starter Decks 33–36 | 24751–24754 |
| One Piece | Set Sail Deck Set / Starter Deck EX: Luffy & Ace | 24708 / 24678 |
| One Piece | The Dominance of God (+ RE) | 24833 / 24834 |
| Lorcana | Attack of the Vine! / Hyperia City | 24666 / 24740 |
| Lorcana | Illumineer's Quest: The Great Hunny Rescue | 24734 |
| dbfusion | Brightness of Hope / Reach the God | 24716 / 24783 |

Note **Lorcana is missing from the skill's step 4b entirely**, despite having a
`TCG_CONFIG` entry — three unmatched Lorcana sets have been accumulating with
no probe coverage at all. Pokemon `ME06: Delta Reign` also isn't in the
pokedata feed yet, so the group map is *ahead* of the current primary source.

**Important caveat — `unmatched` is a candidate list, not a gap list.** It
means "the sync couldn't name-match this group to a catalog `set_code`," which
also fires when a set IS in the catalog under a different code shape. One Piece
starter decks are the obvious case: the catalog stores them as slugs
(`starter-deck-29-egghead`), so they'd read `unmatched` while being fully
present. **Every row above still needs the same catalog cross-check** before it
counts as a gap — the query replaces the *discovery* step, not the
*verification* step.

Suggested skill rewrite: query unmatched groups → cross-check each against the
catalog by `id like <prefix>-*` + `game_type` → keep pokedata and the release
calendars only as a secondary check for non-TCGplayer sources (JP/CN Pokemon,
sealed-only products).

## Errata against the skill file

`SKILL.md`'s ingest-pipeline note documents
`embed_catalog_rows.py --only <code>`. **That flag does not exist.** The
script's source selector is a required mutually-exclusive group of
`--id-prefix` / `--all-missing` (embed_catalog_rows.py:63–64), and `--only`
appears nowhere in the file — the command as documented exits with an argparse
error. All embed commands above use `--id-prefix` with the full id prefix
(trailing hyphen included). Worth fixing in the skill file so the next cycle's
runbook doesn't inherit it.

Also note `embed_catalog_rows.py` **prompts interactively** for the service key
if `SUPABASE_SERVICE_KEY` is unset (`os.environ.get(...) or input(...)`),
rather than exiting like the other scripts — so it can appear to hang in a
non-interactive shell.
