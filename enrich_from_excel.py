#!/usr/bin/env python3
"""
PathBinder — Catalog URL Enrichment from Excel
================================================
Reads a spreadsheet of per-card PriceCharting URLs (col A) keyed by
set_code (col D) + card_number (col E), and PATCHes catalog rows that
are missing price_source_url. Way faster than scraping PC — the
mapping is already done in the file.

Idempotent — only updates rows where price_source_url IS NULL, so
re-running is safe.

The matcher tries multiple catalog id formats per row:
    en-{set_code}-{card_number}     ← pokedata sync convention
    {set_code}-{card_number}        ← raw TCG api id ('base1-1')
…and falls back to (name + set_code) match if neither id format hits.

PREREQUISITES:
    pip3 install requests openpyxl --break-system-packages

USAGE:
    # Probe — load file, show stats, no DB writes
    python3 enrich_from_excel.py path/to/combined_final.xlsx --probe

    # Dry-run, sample 50 rows
    python3 enrich_from_excel.py path/to/combined_final.xlsx --limit 50 --dry-run

    # Full enrichment (only fills NULL price_source_url)
    python3 enrich_from_excel.py path/to/combined_final.xlsx --workers 5

    # Overwrite even existing URLs (replaces stale URLs)
    python3 enrich_from_excel.py path/to/combined_final.xlsx --overwrite

ENVIRONMENT:
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
"""

import os, sys, time, argparse, threading, json
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

try:
    import openpyxl
except ImportError:
    sys.exit("Missing 'openpyxl'. Run: pip3 install openpyxl --break-system-packages")


SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")


# ─── Supabase REST ────────────────────────────────────────────────────────────
def _sb_headers(extra=None):
    h = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept":        "application/json",
    }
    if extra: h.update(extra)
    return h


def pg_check_exists(catalog_id, overwrite):
    """Returns ('exists', has_url) tuple. has_url == True means we'd
    skip this row unless --overwrite is set."""
    r = requests.get(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog",
        headers=_sb_headers(),
        params={"select": "id,price_source_url", "id": f"eq.{catalog_id}", "limit": "1"},
        timeout=20,
    )
    if not r.ok or not r.json():
        return ("missing", None)
    row = r.json()[0]
    return ("exists", bool(row.get("price_source_url")))


def pg_patch_url(catalog_id, url):
    body = json.dumps({"price_source_url": url}, ensure_ascii=False).encode("utf-8")
    r = requests.patch(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{quote(catalog_id)}",
        headers=_sb_headers({
            "Content-Type": "application/json; charset=utf-8",
            "Prefer":       "return=minimal",
        }),
        data=body, timeout=20,
    )
    if not r.ok:
        raise RuntimeError(f"PATCH HTTP {r.status_code}: {r.text[:200]}")


def pg_get_catalog_ids_in_set(set_code):
    """Returns dict {id: row_info} keyed by catalog id for the spreadsheet's
    set_code. Used for the same-format match path (raw base1-1 style)."""
    ids = {}
    offset = 0; PAGE = 1000
    while True:
        r = requests.get(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog",
            headers=_sb_headers(),
            params={
                "select":   "id,price_source_url,card_number,name,set_name",
                "set_code": f"eq.{set_code}",
                "limit":    str(PAGE),
                "offset":   str(offset),
            },
            timeout=30,
        )
        if not r.ok: break
        chunk = r.json() or []
        for row in chunk:
            ids[row["id"]] = {
                "has_url":      bool(row.get("price_source_url")),
                "card_number":  row.get("card_number"),
                "name":         row.get("name"),
                "set_name":     row.get("set_name"),
            }
        if len(chunk) < PAGE:
            break
        offset += PAGE
    return ids


def pg_load_all_missing_pokemon(game_type='pokemon'):
    """One-shot fetch of EVERY Pokemon catalog row missing a price_source_url.
    Lets us build a (set_name, card_number) index across all naming
    conventions in one pass — catalog uses different set_codes per
    source (spreadsheet 'me2pt5' vs pokedata 'ASC') but set_name aligns."""
    rows = []
    offset = 0; PAGE = 1000
    while True:
        r = requests.get(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog",
            headers=_sb_headers(),
            params={
                "select":           "id,name,set_code,set_name,card_number",
                "game_type":        f"eq.{game_type}",
                "price_source_url": "is.null",
                "limit":            str(PAGE),
                "offset":           str(offset),
            },
            timeout=30,
        )
        if not r.ok:
            raise RuntimeError(f"GET HTTP {r.status_code}: {r.text[:200]}")
        chunk = r.json() or []
        rows.extend(chunk)
        if len(chunk) < PAGE: break
        offset += PAGE
    return rows


def _norm_set_name(s):
    """Aggressive normalization for cross-source set_name comparison.
    Pokedata adds qualifiers like '1st Edition', 'Unlimited', 'Base Set',
    that the spreadsheet's bare names don't have. Strip those, normalize
    '&' ↔ 'and', drop parentheticals, then alphanumeric-lowercase.
        'Base'                    → 'base'
        'Base Set Unlimited'      → 'base'
        'Black & White'           → 'blackwhite'
        'Black and White'         → 'blackwhite'
        'Ruby & Sapphire'         → 'rubysapphire'
        'Gym Heroes'              → 'gymheroes'
        'Gym Heroes 1st Edition'  → 'gymheroes'
        'XY'                      → 'xy'
        'XY Base'                 → 'xy'
    """
    if not s: return ""
    import re as _re
    s = s.lower()
    s = _re.sub(r'\([^)]*\)', '', s)
    # Canonicalize ampersand
    s = s.replace(' and ', ' & ')
    # Drop edition qualifiers pokedata adds
    s = _re.sub(r'\b(1st\s+edition|first\s+edition|unlimited|shadowless|english)\b', '', s)
    # Drop trailing "set" / "base" qualifiers that pokedata appends
    s = _re.sub(r'\s+set\s*$', '', s)
    s = _re.sub(r'\s+base\s*$', '', s)
    s = _re.sub(r'^base\s+set\b', 'base', s)   # "Base Set" → "Base"
    return _re.sub(r'[^a-z0-9]', '', s).strip()


def _norm_card_num(s):
    """Normalize card_number: strip leading zeros so '001' == '1', but
    preserve a literal '0' for trainer/promo cards with that number."""
    s = str(s or "").strip()
    if not s: return ""
    return s.lstrip("0") or "0"


# ─── Spreadsheet loader ───────────────────────────────────────────────────────
def load_excel(path):
    """Returns list of dicts: {url, name, set_code, card_number}."""
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    header = rows[0]
    data = []
    def _cell(r, i):
        """Safe cell extractor — coerces ints/floats to strings, handles
        None, strips whitespace. openpyxl's read_only mode returns
        whatever Python type matches the cell value, so a numeric
        set_name cell comes back as a float."""
        if i >= len(r) or r[i] is None:
            return ""
        return str(r[i]).strip()

    for r in rows[1:]:
        if not r or not r[0]:    # skip rows without a URL
            continue
        data.append({
            "url":         _cell(r, 0),
            "name":        _cell(r, 1),
            "set_name":    _cell(r, 2),
            "set_code":    _cell(r, 3),
            "card_number": _cell(r, 4),
        })
    return data


def candidate_ids(row):
    """Try multiple catalog id formats this row might match. Order
    matters — most-specific first."""
    sc  = row["set_code"]
    cn  = row["card_number"]
    if not (sc and cn):
        return []
    cn_norm = cn.lstrip("0") or "0"   # 001 → 1, but keep '0' for the literal zero
    candidates = []
    # pokedata convention
    candidates.append(f"en-{sc}-{cn}")
    if cn_norm != cn:
        candidates.append(f"en-{sc}-{cn_norm}")
    # raw TCG-api id (the existing 20K "other" prefix)
    candidates.append(f"{sc}-{cn}")
    if cn_norm != cn:
        candidates.append(f"{sc}-{cn_norm}")
    # promo / pd- prefix
    candidates.append(f"pd-{sc}-{cn}")
    return candidates


# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("excel_path", help="Path to the .xlsx file")
    ap.add_argument("--probe",     action="store_true",
                    help="Load file + show set/row stats, no DB activity.")
    ap.add_argument("--dry-run",   action="store_true", help="No DB writes.")
    ap.add_argument("--limit",     type=int, default=0, help="Stop after N rows.")
    ap.add_argument("--workers",   type=int, default=5,
                    help="Parallel PATCH workers (default 5).")
    ap.add_argument("--overwrite", action="store_true",
                    help="Replace existing price_source_url values. "
                         "Default only fills NULLs.")
    ap.add_argument("--only-set",
                    help="Process only rows with this set_code.")
    args = ap.parse_args()

    print(f"\n  Loading {args.excel_path}…")
    data = load_excel(args.excel_path)
    print(f"  {len(data):,} rows with URLs.")

    if args.only_set:
        data = [r for r in data if r["set_code"] == args.only_set]
        print(f"  --only-set {args.only_set} → {len(data):,} rows.")
    if args.limit:
        data = data[:args.limit]

    # Group by set_code so we can bulk-check existing IDs once per set
    by_set = {}
    for r in data:
        by_set.setdefault(r["set_code"], []).append(r)
    print(f"  Spanning {len(by_set)} unique set_codes.")

    if args.probe:
        # Show top sets by count
        print(f"\n  Top 10 sets by row count:")
        ranked = sorted(by_set.items(), key=lambda kv: -len(kv[1]))[:10]
        for sc, rs in ranked:
            print(f"     {sc:<12} {len(rs):>4} rows  (e.g. {rs[0]['name']})")
        return

    # ── Build a global Pokemon catalog index keyed by (set_name, num)
    # The spreadsheet's set_code ('me2pt5') and pokedata's set_code
    # ('ASC') are different naming systems for the same set, but both
    # sources fill set_name with roughly the same human-readable string
    # ("Ascended Heroes"). That's our only reliable join key.
    # ────────────────────────────────────────────────────────────────
    print(f"\n  Loading ALL Pokemon catalog rows missing price_source_url…")
    try:
        missing_rows = pg_load_all_missing_pokemon()
    except Exception as e:
        sys.exit(f"  Failed to load catalog: {e}")
    print(f"  {len(missing_rows):,} catalog rows missing URL.")

    # Index: (norm_set_name, norm_card_number) → [catalog_row, ...]
    # Plus a secondary index by (norm_card_name, norm_card_number) for
    # fallback when set_name doesn't align cleanly.
    by_set_num  = {}
    by_name_num = {}
    for cr in missing_rows:
        snk = _norm_set_name(cr.get("set_name"))
        ncn = _norm_card_num(cr.get("card_number"))
        if snk and ncn:
            by_set_num.setdefault((snk, ncn), []).append(cr)
        nn = (cr.get("name") or "").lower().strip()
        if nn and ncn:
            by_name_num.setdefault((nn, ncn), []).append(cr)
    print(f"  Indexed {len(by_set_num):,} (set_name, card_number) keys.")

    print(f"\n  Processing with {args.workers} workers — "
          f"{'DRY RUN' if args.dry_run else 'WRITING'}\n")
    time.sleep(2)

    _lock = threading.Lock()
    stats = {
        "patched":    0,
        "skipped":    0,
        "no_match":   0,
        "failed":     0,
    }

    def process_set(set_code, rows):
        """For one spreadsheet set: also bulk-fetch the same-set_code
        catalog rows (for the raw-id duplicate case), then for each
        spreadsheet row, try matches in three tiers:
          1. catalog row with the same set_code (raw IDs)
          2. global index by (set_name, card_number)
          3. fallback global index by (card_name, card_number)"""
        try:
            same_set = pg_get_catalog_ids_in_set(set_code)
        except Exception as e:
            same_set = {}   # graceful — index path still runs

        local = {"patched": 0, "skipped": 0, "no_match": 0, "failed": 0}
        for row in rows:
            matches = []   # list of {id, has_url, source}

            # Tier 1 — same-set_code catalog rows (raw base1-1 case)
            for cid in candidate_ids(row):
                if cid in same_set:
                    info = same_set[cid]
                    matches.append({"id": cid, "has_url": info["has_url"], "src": "id"})

            # Tier 2 — (set_name, card_number) global index. Catches the
            # pokedata-prefixed en- rows where set_code differs.
            snk = _norm_set_name(row.get("set_name") or "")
            ncn = _norm_card_num(row.get("card_number") or "")
            for cr in by_set_num.get((snk, ncn), []):
                if not any(m["id"] == cr["id"] for m in matches):
                    matches.append({"id": cr["id"], "has_url": False, "src": "set_name"})

            # Tier 3 — (card_name, card_number) fallback for set_name drift
            if not matches:
                nn = (row.get("name") or "").lower().strip()
                for cr in by_name_num.get((nn, ncn), []):
                    if not any(m["id"] == cr["id"] for m in matches):
                        matches.append({"id": cr["id"], "has_url": False, "src": "card_name"})

            if not matches:
                local["no_match"] += 1
                continue
            for m in matches:
                if m["has_url"] and not args.overwrite:
                    local["skipped"] += 1
                    continue
                if args.dry_run:
                    local["patched"] += 1
                    continue
                try:
                    pg_patch_url(m["id"], row["url"])
                    local["patched"] += 1
                except Exception:
                    local["failed"] += 1
        return ("ok", set_code, None, local)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(process_set, sc, rs): sc for sc, rs in by_set.items()}
        done = 0
        for f in as_completed(futs):
            status, sc, err, local = f.result()
            done += 1
            with _lock:
                if status == "ok":
                    for k, v in local.items():
                        stats[k] += v
                    print(f"  [{done:>3}/{len(by_set)}] {sc:<12} "
                          f"patched={local['patched']} skipped={local['skipped']} "
                          f"no_match={local['no_match']} failed={local['failed']}")
                else:
                    print(f"  [{done:>3}/{len(by_set)}] {sc:<12} SET-FETCH-FAIL {err}")

    print(f"\n  Done. {' '.join(f'{k}={v}' for k,v in stats.items())}")
    if args.dry_run:
        print(f"  --dry-run: no writes. Re-run without --dry-run to commit.")


if __name__ == "__main__":
    main()
