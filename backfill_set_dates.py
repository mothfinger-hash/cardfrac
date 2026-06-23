#!/usr/bin/env python3
"""
PathBinder — Backfill catalog.release_date from set_metadata
============================================================
set_metadata already holds set release dates for the games whose mirror
scripts have run:
    • MTG     → Scryfall          (set_metadata.id = scryfall set code)
    • YGO     → YGOPRODeck        (set_metadata.id = "ygo-<code>")
    • Pokémon → pokemontcg.io     (set_metadata.id = pokemontcg.io set id)  [EN]

This copies those dates onto the matching catalog rows (catalog.release_date)
so the Sets lists can sort newest→oldest. It also REPORTS:
    • catalog sets that got no date (no source match), and
    • sets present in set_metadata but MISSING from our catalog.

JP dates: use  fetch_jp_pokedata.py --set-dates  (pokedata source).
One Piece: no set_metadata yet — flagged as unsupported until a source is added.

Matching is per-game (set_metadata.id ↔ catalog.set_code), tried with a couple
of normalizations. DRY-RUN by default; pass --apply to write.

USAGE:
    python3 backfill_set_dates.py                 # dry-run, all games
    python3 backfill_set_dates.py --game magic    # one game
    python3 backfill_set_dates.py --apply         # write

ENV: SUPABASE_SERVICE_KEY  (SUPABASE_URL defaults to the project below)
"""
import os, sys, re, argparse

try:
    from supabase import create_client
except ImportError:
    sys.exit("Missing supabase. Run: pip3 install supabase --break-system-packages")

SUPABASE_URL = os.environ.get("SUPABASE_URL") or "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not SUPABASE_KEY:
    sys.exit("Set SUPABASE_SERVICE_KEY in your environment.")
sb = create_client(SUPABASE_URL, SUPABASE_KEY)

# game key → how to find its rows on each side.
#   sm_game      : set_metadata.game_type value
#   id_prefix    : catalog id prefix that scopes this game's rows
#   sm_strip     : prefix to strip off set_metadata.id before matching (or None)
GAMES = {
    # set_metadata.id is prefixed "mtg-"/"ygo-"; strip it to match catalog.set_code.
    "magic":   {"sm_game": "magic",   "id_prefix": "mtg-", "sm_strip": "mtg-"},
    "yugioh":  {"sm_game": "yugioh",  "id_prefix": "ygo-", "sm_strip": "ygo-"},
    # EN Pokémon — report-only (not in the default run). The EN set list loads
    # live from pokemontcg.io (already dated/sorted), and catalog en- codes are
    # abbreviations that don't match pokemontcg.io ids, so dating it is low value.
    "pokemon": {"sm_game": "pokemon", "id_prefix": "en-",  "sm_strip": None},
}
# Games included when --game is not specified.
DEFAULT_GAMES = ["magic", "yugioh"]

def _norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or "").lower())

def _load_set_metadata(sm_game):
    rows, off = [], 0
    while True:
        r = sb.table("set_metadata").select("id,name,release_date") \
              .eq("game_type", sm_game).range(off, off + 999).execute()
        chunk = r.data or []
        rows += chunk
        if len(chunk) < 1000:
            break
        off += 1000
    return rows

def _load_catalog_setcodes(id_prefix):
    """Distinct {norm(set_code): (set_code, sample_name)} for an id prefix."""
    out, off = {}, 0
    while True:
        r = sb.table("catalog").select("set_code,set_name") \
              .like("id", id_prefix + "%").range(off, off + 999).execute()
        chunk = r.data or []
        for row in chunk:
            sc = (row.get("set_code") or "").strip()
            if not sc:
                continue
            out.setdefault(_norm(sc), (sc, row.get("set_name") or ""))
        if len(chunk) < 1000:
            break
        off += 1000
    return out

def run_game(game, apply):
    cfg = GAMES[game]
    print(f"\n══ {game.upper()} ══════════════════════════════════")
    sm_rows = _load_set_metadata(cfg["sm_game"])
    print(f"  set_metadata: {len(sm_rows)} sets")
    cat = _load_catalog_setcodes(cfg["id_prefix"])
    print(f"  catalog ({cfg['id_prefix']}*): {len(cat)} distinct set_codes")

    # Build source lookup: normalized key → (date, name, id)
    src = {}
    for r in sm_rows:
        sid = r.get("id") or ""
        key = sid
        if cfg["sm_strip"] and key.lower().startswith(cfg["sm_strip"]):
            key = key[len(cfg["sm_strip"]):]
        src[_norm(key)] = (r.get("release_date"), r.get("name") or "", sid)

    updated = 0
    missing_from_catalog = []   # in set_metadata, not in catalog  ← the flag
    no_date_in_catalog = []     # catalog set with no source match

    # 1) For every source set, either apply its date or flag it missing.
    for nkey, (date, name, sid) in sorted(src.items()):
        if nkey in cat:
            sc = cat[nkey][0]
            if date:
                if apply:
                    sb.table("catalog").update({"release_date": date}) \
                      .eq("set_code", sc).like("id", cfg["id_prefix"] + "%").execute()
                updated += 1
        else:
            missing_from_catalog.append((sid, name, date))

    # 2) Catalog sets the source didn't cover.
    for nkey, (sc, name) in sorted(cat.items()):
        if nkey not in src:
            no_date_in_catalog.append((sc, name))

    print(f"  {'APPLIED' if apply else 'WOULD UPDATE'}: {updated} sets dated")
    print(f"  catalog sets with NO source date: {len(no_date_in_catalog)}")
    for sc, name in no_date_in_catalog[:40]:
        print(f"      · {sc:24s} {name[:40]}")
    if len(no_date_in_catalog) > 40:
        print(f"      … +{len(no_date_in_catalog) - 40} more")
    print(f"  ⚑ sets in {game} source MISSING from catalog: {len(missing_from_catalog)}")
    for sid, name, date in missing_from_catalog[:40]:
        print(f"      ⚑ {sid:24s} {date or '----------':10s} {name[:40]}")
    if len(missing_from_catalog) > 40:
        print(f"      … +{len(missing_from_catalog) - 40} more")
    return updated, len(no_date_in_catalog), len(missing_from_catalog)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", choices=list(GAMES.keys()), help="Only this game (default: all).")
    ap.add_argument("--apply", action="store_true", help="Write changes (default: dry-run).")
    ap.add_argument("--dry-run", action="store_true", help="No-op; this tool is dry-run unless --apply is given. Accepted for consistency.")
    args = ap.parse_args()

    print(f"MODE: {'APPLY (writing)' if args.apply else 'DRY-RUN (no writes)'}")
    games = [args.game] if args.game else DEFAULT_GAMES
    tot_u = tot_nd = tot_miss = 0
    for g in games:
        u, nd, miss = run_game(g, args.apply)
        tot_u += u; tot_nd += nd; tot_miss += miss

    print(f"""
════════════════════════════════════════
  Set-date backfill {'(applied)' if args.apply else '(dry-run)'}
  ✓ Sets dated:                 {tot_u}
  · Catalog sets w/o source:    {tot_nd}
  ⚑ Source sets missing in cat: {tot_miss}
════════════════════════════════════════
  JP  → run: python3 fetch_jp_pokedata.py --set-dates
  OP  → no set_metadata source yet (needs an API).
""")

if __name__ == "__main__":
    main()
