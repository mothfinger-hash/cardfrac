#!/usr/bin/env python3
"""
audit_pricecharting_ids.py — find WRONG pricecharting_id mappings, catalog-wide

The problem (see reverify_pricecharting_ids.py): a row can have the CORRECT
price_source_url but a WRONG pricecharting_id, so the daily refresh pulls a
different product's price. reverify fixes it, but it SCRAPES each URL — far too
slow to run over the whole 160k-row catalog.

This auditor uses the fast PriceCharting **API** instead of scraping. For every
row that has a pricecharting_id, it asks the API what product that id actually
is (product-name + console-name) and compares to the catalog row's name + set.
A poor match means the stored id points at the wrong product. That lets us
screen the ENTIRE catalog in ~an hour instead of days.

Output: a CSV of suspects (always). With --clear-bad it also NULLs the bad
pricecharting_id AND current_value on flagged rows, so the next price refresh
recovers the right price from the (correct) price_source_url via the scrape
path — or enrich_pricecharting_ids.py can re-derive a fresh id. NULLing a
false-positive is harmless: the row just falls back to its correct URL.

PREREQUISITES
-------------
    pip3 install requests --break-system-packages

USAGE
-----
    # Audit everything, write suspects to CSV (no DB writes)
    python3 audit_pricecharting_ids.py

    # One game, custom output, more workers
    python3 audit_pricecharting_ids.py --tcg pokemon --workers 12 --out pokemon_suspects.csv

    # Audit + fix: NULL the bad ids so refresh recovers from the URL
    python3 audit_pricecharting_ids.py --clear-bad

    # Tighter/looser sensitivity (default 0.45 — lower = fewer flags)
    python3 audit_pricecharting_ids.py --threshold 0.5

ENVIRONMENT
-----------
    SUPABASE_URL, SUPABASE_SERVICE_KEY
    PRICECHARTING_API_KEY        (required — this tool is API-only)
"""

import os
import sys
import re
import time
import json
import csv
import argparse
import threading
from difflib import SequenceMatcher
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
PC_API_KEY   = os.environ.get("PRICECHARTING_API_KEY", "").strip() or None
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")
if not PC_API_KEY:
    sys.exit("Set PRICECHARTING_API_KEY — this auditor is API-only (no scraping).")

PC_BASE      = "https://www.pricecharting.com"
RATE_PER_SEC = float(os.environ.get("PC_API_RATE_PER_SEC", "12"))

_sb = requests.Session()
_sb.headers.update({"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"})
_pc = requests.Session()

# ── simple global rate limiter (tokenless; serialize the "next slot") ────────
_rate_lock = threading.Lock()
_next_slot = [0.0]


def _pace():
    with _rate_lock:
        now = time.time()
        wait = _next_slot[0] - now
        if wait > 0:
            time.sleep(wait)
        _next_slot[0] = max(now, _next_slot[0]) + (1.0 / RATE_PER_SEC)


_PUNCT = re.compile(r"[^a-z0-9]+")


def norm(s):
    return _PUNCT.sub(" ", (s or "").lower()).strip()


def ratio(a, b):
    return SequenceMatcher(None, a, b).ratio()


def sb_get(path):
    r = _sb.get(f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}", timeout=60)
    r.raise_for_status()
    return r.json()


def sb_clear_bad(cat_id):
    q = requests.utils.quote(cat_id, safe="")
    r = _sb.patch(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{q}",
        headers={"Content-Type": "application/json", "Prefer": "return=minimal"},
        data=json.dumps({"pricecharting_id": None, "current_value": None}),
        timeout=30,
    )
    r.raise_for_status()


def fetch_rows(game_type, limit):
    """Catalog rows that HAVE a pricecharting_id, paginated by id."""
    rows, page, last = [], 1000, None
    sel = "id,name,set_name,game_type,pricecharting_id,price_source_url"
    gt = f"&game_type=eq.{game_type}" if game_type and game_type != "all" else ""
    while True:
        cur = f"&id=gt.{requests.utils.quote(last, safe='')}" if last else ""
        batch = sb_get(
            f"catalog?select={sel}&pricecharting_id=not.is.null{gt}{cur}"
            f"&order=id.asc&limit={page}"
        )
        if not batch:
            break
        rows.extend(batch)
        last = batch[-1]["id"]
        if limit and len(rows) >= limit:
            return rows[:limit]
        if len(batch) < page:
            break
    return rows


def pc_lookup(pc_id):
    """Return (product_name, console_name) for a PriceCharting id, or (None, None)."""
    for attempt in range(3):
        _pace()
        try:
            r = _pc.get(f"{PC_BASE}/api/product",
                        params={"t": PC_API_KEY, "id": pc_id}, timeout=25)
            if r.status_code in (403, 429, 502, 503, 504):
                time.sleep(2 * (attempt + 1))
                continue
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict) and data.get("status") != "error":
                return data.get("product-name"), data.get("console-name")
            return None, None
        except (requests.RequestException, ValueError):
            if attempt == 2:
                return None, None
            time.sleep(2 * (attempt + 1))
    return None, None


def audit_row(row, threshold):
    """Return a suspect dict if the stored id looks wrong, else None."""
    pname, cname = pc_lookup(row["pricecharting_id"])
    if pname is None and cname is None:
        # API had nothing for this id — that itself is suspicious (dead id).
        return {
            "id": row["id"], "name": row.get("name"), "set_name": row.get("set_name"),
            "pricecharting_id": row["pricecharting_id"],
            "pc_product_name": "", "pc_console_name": "",
            "name_score": 0.0, "set_score": 0.0, "reason": "id_not_found",
        }
    n_cat, n_pc = norm(row.get("name")), norm(pname)
    name_score  = ratio(n_cat, n_pc)
    # Containment rescues legit near-misses (alt-art suffixes, punctuation).
    name_ok = name_score >= threshold or (n_cat and (n_cat in n_pc or n_pc in n_cat))

    # Set check via containment — PC's console-name is usually "Pokemon <Set>",
    # so a plain ratio under-scores a correct match; substring is robust. This
    # is what catches the same-name / wrong-set mismaps (e.g. an EN promo whose
    # id points at the JP "Best of XY" print of the same card).
    s_cat, s_pc = norm(row.get("set_name")), norm(cname)
    set_known = bool(s_cat and s_pc)
    set_score = ratio(s_cat, s_pc) if set_known else 0.0
    set_ok = (not set_known) or (s_cat in s_pc) or (s_pc in s_cat) or set_score >= 0.6

    if name_ok and set_ok:
        return None
    return {
        "id": row["id"], "name": row.get("name"), "set_name": row.get("set_name"),
        "pricecharting_id": row["pricecharting_id"],
        "pc_product_name": pname or "", "pc_console_name": cname or "",
        "name_score": round(name_score, 2), "set_score": round(set_score, 2),
        "reason": ("name_mismatch" if not name_ok else "set_mismatch"),
    }


def main():
    ap = argparse.ArgumentParser(description="Audit pricecharting_id mappings via the PC API")
    ap.add_argument("--tcg", default="all", help="game_type scope, or all (default)")
    ap.add_argument("--limit", type=int, default=0, help="cap rows (testing)")
    ap.add_argument("--workers", type=int, default=10, help="concurrent API workers")
    ap.add_argument("--threshold", type=float, default=0.45,
                    help="name-match below this = suspect (default 0.45)")
    ap.add_argument("--clear-bad", action="store_true",
                    help="NULL pricecharting_id + current_value on flagged rows")
    ap.add_argument("--out", default="pricecharting_id_suspects.csv", help="CSV output path")
    args = ap.parse_args()

    print(f"Loading catalog rows with a pricecharting_id (tcg={args.tcg})…")
    rows = fetch_rows(args.tcg, args.limit)
    print(f"  {len(rows)} rows to audit at ~{RATE_PER_SEC:.0f} req/s "
          f"(~{len(rows) / max(RATE_PER_SEC, 1) / 60:.0f} min)")
    if not rows:
        return

    suspects, done = [], 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(audit_row, r, args.threshold): r for r in rows}
        for fut in as_completed(futs):
            done += 1
            s = fut.result()
            if s:
                suspects.append(s)
            if done % 500 == 0 or done == len(rows):
                print(f"  …{done}/{len(rows)} checked, {len(suspects)} suspect so far")

    cols = ["id", "name", "set_name", "pricecharting_id", "pc_product_name",
            "pc_console_name", "name_score", "set_score", "reason"]
    with open(args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(sorted(suspects, key=lambda x: x["name_score"]))
    print(f"\n{len(suspects)} suspect(s) of {len(rows)} -> {args.out}")

    if args.clear_bad and suspects:
        print(f"Clearing {len(suspects)} bad id(s) (NULL pricecharting_id + current_value)…")
        n = 0
        for s in suspects:
            try:
                sb_clear_bad(s["id"])
                n += 1
            except Exception as e:
                print(f"  ! {s['id']}: {e}")
        print(f"Cleared {n}. Next price refresh will recover from each row's URL.")
    elif suspects:
        print("Review the CSV, then re-run with --clear-bad to NULL the bad ids "
              "(refresh then recovers the correct price from the URL).")


if __name__ == "__main__":
    main()
