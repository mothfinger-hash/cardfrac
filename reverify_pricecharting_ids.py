#!/usr/bin/env python3
"""
reverify_pricecharting_ids.py

Re-derive catalog.pricecharting_id from each row's price_source_url and
flag rows whose STORED id disagrees with the id on the linked page.

Why this exists
---------------
The normal enricher (enrich_pricecharting_ids.py) only processes rows
where pricecharting_id IS NULL — it never re-checks a row that already
has an id. So when a batch process mismaps an id, it stays wrong forever
and the daily refresh keeps pulling the WRONG product's price.

Concrete case that motivated this: catalog row `xyp-XY201` (Sharpedo
Spirit Link, English XY Black Star Promo, ~$3) had pricecharting_id
3473654, which is the *Japanese* "Best of XY" Sharpedo Spirit Link
(~$105). The price_source_url was correct (.../sharpedo-spirit-link-XY201,
product 844675) — only the id was wrong. The mismap happened on a single
date (the price history jumps from ~$3 to ~$15 on 2026-05-27), which
means a batch run that day likely mismapped a whole cohort of XY promos
that collide by name with the Japanese "Best of XY" set.

This script loads rows that have BOTH a price_source_url AND a
pricecharting_id, scrapes each url for its TRUE product id, and reports
every row where the stored id differs. Dry-run by default.

USAGE
  export SUPABASE_URL=...  SUPABASE_SERVICE_KEY=...

  # Dry-run the XY promo set (small, where the known mismaps live):
  python3 reverify_pricecharting_ids.py --id-prefix xyp-

  # Apply the fixes (sets the correct id AND NULLs current_value so the
  # next price refresh repopulates from the right product):
  python3 reverify_pricecharting_ids.py --id-prefix xyp- --apply

OPTIONS
  --tcg pokemon        scope by game_type
  --id-prefix xyp-     scope by catalog id prefix (recommended — keeps the
                       scrape count small; the full catalog is 160k+ rows)
  --limit N            stop after N rows (smoke test)
  --apply              write fixes (default: report only + CSV)
  --keep-value         on fix, leave current_value as-is (don't NULL it)

A scope (--tcg or --id-prefix) is REQUIRED — scraping the whole catalog
at PC-safe pacing would take days.
"""
import os, sys, re, time, random, argparse, json, csv
import requests
from urllib.parse import quote

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (SUPABASE_URL and SUPABASE_KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")

PC_BASE         = "https://www.pricecharting.com"
REQUEST_TIMEOUT = 25
RETRY_STATUSES  = (403, 429, 502, 503, 504)
MAX_RETRIES     = 5
# PC's Cloudflare WAF blocks aggressive scrapers — single worker, paced.
SCRAPE_MIN_S, SCRAPE_MAX_S = 2.5, 5.0

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}
# Same id-extraction patterns as enrich_pricecharting_ids.py.
PRODUCT_ID_RES = [
    re.compile(r'name=["\']product["\']\s+value=["\'](\d+)["\']', re.IGNORECASE),
    re.compile(r'data-product-id=["\'](\d+)["\']',                re.IGNORECASE),
    re.compile(r'/offers\?product=(\d+)',                          re.IGNORECASE),
]
_session = requests.Session(); _session.headers.update(HEADERS)
_last = [0.0]

# Optional PC API key — only used by --verify to confirm a freshly-derived
# id actually resolves to a real, priced product (and to show WHAT it is).
PC_API_KEY = os.environ.get("PRICECHARTING_API_KEY", "").strip() or None
_last_api = [0.0]


def _pace_api(min_s=0.05):
    now = time.time()
    if now - _last_api[0] < min_s:
        time.sleep(min_s - (now - _last_api[0]))
    _last_api[0] = time.time()


def api_product_info(pc_id):
    """Query /api/product?id=X. Returns:
         dict  — product exists (keys like product-name / console-name / loose-price)
         False — API reachable but rejected the id (error / removed product)
         None  — no API key, so we can't check."""
    if not PC_API_KEY:
        return None
    _pace_api()
    try:
        r = _session.get(f"{PC_BASE}/api/product",
                         params={"t": PC_API_KEY, "id": pc_id}, timeout=REQUEST_TIMEOUT)
        if not r.ok:
            return False
        data = r.json()
    except Exception:
        return False
    if isinstance(data, dict) and data.get("status") == "error":
        return False
    if isinstance(data, dict) and (data.get("id") or data.get("product-name")):
        return data
    return False


def _pace():
    now = time.time(); delay = random.uniform(SCRAPE_MIN_S, SCRAPE_MAX_S)
    if now - _last[0] < delay:
        time.sleep(delay - (now - _last[0]))
    _last[0] = time.time()


def fetch(url):
    _pace(); last_err = None
    for a in range(MAX_RETRIES):
        try:
            r = _session.get(url, timeout=REQUEST_TIMEOUT)
        except Exception as e:
            last_err = f"network: {e}"; time.sleep(2 ** a + random.uniform(0, 1)); continue
        if r.ok:
            return r.text
        if r.status_code in RETRY_STATUSES:
            time.sleep((2 ** (a + 1) - 1) + random.uniform(0, 3))
            last_err = f"HTTP {r.status_code}"; continue
        raise RuntimeError(f"HTTP {r.status_code}")
    raise RuntimeError(last_err or "exhausted retries")


def extract_id(html):
    for rx in PRODUCT_ID_RES:
        m = rx.search(html or "")
        if m:
            return m.group(1)
    return None


def _hdr(extra=None):
    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Accept": "application/json"}
    if extra:
        h.update(extra)
    return h


def load_rows(tcg, id_prefix, limit, ids=None, require_url=True, missing_only=False):
    base = f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog"
    sel  = "id,name,set_name,card_number,price_source_url,pricecharting_id,current_value"
    if ids:
        return _load_by_ids(base, sel, ids)
    flt  = "pricecharting_id=is.null" if missing_only else "pricecharting_id=not.is.null"
    if require_url and not missing_only:
        flt += "&price_source_url=not.is.null"
    if tcg and tcg != "all":
        flt += f"&game_type=eq.{quote(tcg)}"
    if id_prefix:
        flt += f"&id=like.{quote(id_prefix)}*"
    rows = []; page = 0; ps = 1000
    while True:
        params = f"?select={sel}&{flt}&order=id.asc&limit={ps}&offset={page*ps}"
        r = requests.get(base + params, headers=_hdr(), timeout=60); r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        if limit and len(rows) >= limit:
            return rows[:limit]
        if len(batch) < ps:
            break
        page += 1
    return rows


def _load_by_ids(base, sel, ids):
    rows = []
    safe_chars = '(),"'
    for k in range(0, len(ids), 150):
        chunk  = ids[k:k+150]
        inlist = "(" + ",".join('"' + c.replace('"', '') + '"' for c in chunk) + ")"
        params = f"?select={sel}&id=in.{quote(inlist, safe=safe_chars)}"
        r = requests.get(base + params, headers=_hdr(), timeout=60); r.raise_for_status()
        rows.extend(r.json())
    return rows


def patch(row_id, correct_id, reset_value):
    payload = {"pricecharting_id": correct_id}
    if reset_value:
        payload["current_value"] = None   # next refresh repopulates from the right product
    r = requests.patch(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{quote(row_id)}",
        headers=_hdr({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        data=json.dumps(payload), timeout=30,
    )
    r.raise_for_status()


def row_lang(cid):
    """Expected language of a catalog row from its id prefix."""
    c = (cid or "").lower()
    if c.startswith(("jp-", "pd-")): return "JA"
    if c.startswith("cn-"):          return "ZH"
    if c.startswith("kr-"):          return "KO"
    return "EN"   # en-, xyp-, mtg-, ygo-, op-, gun-, dbz-, topps-, …


def console_lang(console_name):
    """Language implied by a PC console-name (e.g. 'Pokemon Japanese Best of XY')."""
    n = (console_name or "").lower()
    if "japanese" in n: return "JA"
    if "chinese" in n:  return "ZH"
    if "korean" in n:   return "KO"
    return "EN"


def run_api_scan(rows):
    """Fast survey: for each row, ask the PC API what its STORED id is, and
    flag rows where the id's product language disagrees with the row's
    (e.g. an English `xyp-`/`en-` row whose id resolves to a Japanese
    product). No page scraping — ~30 ids/sec — so it can sweep the whole
    catalog in a fraction of the scrape time. Detection only; fix the
    flagged ids afterwards with --ids-file (which scrapes their correct id)."""
    suspects = []; checked = 0; nodata = 0
    for i, row in enumerate(rows, 1):
        stored = str(row.get("pricecharting_id") or "").strip()
        if not stored:
            continue
        info = api_product_info(stored)
        if not isinstance(info, dict):
            nodata += 1; continue
        checked += 1
        rl = row_lang(row["id"]); cl = console_lang(info.get("console-name"))
        if rl != cl:
            pname = info.get("product-name") or "?"; cname = info.get("console-name") or "?"
            suspects.append((row, stored, rl, cl, pname, cname))
            print(f"  SUSPECT {row['id']:<18} {rl}->{cl}  id={stored:<10} "
                  f"cur=${row.get('current_value')}  {row.get('name')}  [id is: {pname} / {cname}]")
        if i % 200 == 0:
            print(f"  ...{i}/{len(rows)} checked={checked} suspects={len(suspects)} nodata={nodata}")

    print(f"\nAPI scan done. rows={len(rows)} checked={checked} "
          f"suspects={len(suspects)} no_api_data={nodata}")
    if suspects:
        with open("reverify_api_suspects.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["id", "name", "set_name", "stored_id", "row_lang", "id_lang",
                        "id_product", "id_console", "current_value", "price_source_url"])
            for row, stored, rl, cl, pname, cname in suspects:
                w.writerow([row["id"], row.get("name"), row.get("set_name"), stored, rl, cl,
                            pname, cname, row.get("current_value"), row.get("price_source_url")])
        with open("reverify_api_suspect_ids.txt", "w") as f:
            for row, *_ in suspects:
                f.write(row["id"] + "\n")
        print("Wrote reverify_api_suspects.csv + reverify_api_suspect_ids.txt")
        print("Fix them with ground-truth ids:")
        print("  python3 reverify_pricecharting_ids.py --ids-file reverify_api_suspect_ids.txt --verify --apply")


def _norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


_SET_STOP = {"the", "of", "and", "pokemon", "magic", "yugioh", "yu", "gi", "oh",
             "card", "cards", "game", "tcg", "english", "japanese", "edition", "set"}


def _set_tokens(s):
    return {t for t in re.findall(r'[a-z0-9]+', (s or '').lower())
            if len(t) >= 3 and t not in _SET_STOP}


def set_agrees(row_set, console_name):
    """True if the row's set and the matched product's console plausibly
    refer to the same set. Lenient: only returns False on a CLEAR conflict
    (both sides have meaningful set tokens and share none). When either
    side has no distinctive token, we can't judge, so we allow it."""
    a, b = _set_tokens(row_set), _set_tokens(console_name)
    if not a or not b:
        return True
    return bool(a & b)


def api_search(query):
    """PC API name search: /api/product?q=<query> returns the single
    closest-matching product. Returns dict / False (rejected) / None (no key)."""
    if not PC_API_KEY:
        return None
    _pace_api()
    try:
        r = _session.get(f"{PC_BASE}/api/product",
                         params={"t": PC_API_KEY, "q": query}, timeout=REQUEST_TIMEOUT)
        if not r.ok:
            return False
        data = r.json()
    except Exception:
        return False
    if isinstance(data, dict) and data.get("status") == "error":
        return False
    if isinstance(data, dict) and (data.get("id") or data.get("product-name")):
        return data
    return False


def patch_found(row_id, pc_id, url):
    """Set pricecharting_id + price_source_url on a row that had neither."""
    r = requests.patch(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{quote(row_id)}",
        headers=_hdr({"Content-Type": "application/json", "Prefer": "return=minimal"}),
        data=json.dumps({"pricecharting_id": pc_id, "price_source_url": url}), timeout=30,
    )
    r.raise_for_status()


def run_find_missing(rows, apply):
    """For rows with NO pricecharting_id, search the PC API by name+set and
    propose an id. Two guards keep bad matches out:
      * LANGUAGE — the matched product's console language must equal the
        row's (no English row gets a Japanese product, the bug we just fixed).
      * NAME — the matched product-name must share the card name (normalized),
        so a fuzzy q-search that drifts to a different card is rejected.
    Anything that fails a guard is reported but NOT written. Dry-run by default."""
    found = []; nomatch = 0; lang_skip = 0; name_skip = 0; set_skip = 0
    for i, row in enumerate(rows, 1):
        name = row.get("name") or ""
        q = " ".join(x for x in [name, row.get("set_name") or "", row.get("card_number") or ""] if x).strip()
        if not q:
            continue
        info = api_search(q)
        if not isinstance(info, dict):
            nomatch += 1
        else:
            pid   = str(info.get("id") or "").strip()
            pname = info.get("product-name") or ""
            cname = info.get("console-name") or ""
            rl, cl = row_lang(row["id"]), console_lang(cname)
            # Set guard only for the multi-printing-heavy games (Magic /
            # Yu-Gi-Oh), where the SAME card name exists across many sets
            # and PC's console-name IS the specific set. For Pokémon promos
            # the console is generic ("Pokemon Promo"), so the set guard
            # would mis-fire — language + name guards cover those.
            set_guarded = row["id"].lower().startswith(("mtg-", "ygo-"))
            if not pid:
                nomatch += 1
            elif rl != cl:
                lang_skip += 1
                print(f"  LANG-SKIP {row['id']:<18} {rl}!={cl}  {name}  -> {pname} / {cname}")
            elif _norm(name) and _norm(name) not in _norm(pname) and _norm(pname) not in _norm(name):
                name_skip += 1
                print(f"  NAME-SKIP {row['id']:<18} '{name}' != '{pname}'")
            elif set_guarded and not set_agrees(row.get("set_name"), cname):
                set_skip += 1
                print(f"  SET-SKIP  {row['id']:<18} set='{row.get('set_name')}' != console='{cname}'  ({name})")
            else:
                url = f"{PC_BASE}/offers?product={pid}"
                found.append((row, pid, pname, cname))
                print(f"  FOUND {row['id']:<18} -> id={pid:<10} {pname} / {cname}")
                if apply:
                    try:
                        patch_found(row["id"], pid, url); print("        ^ set")
                    except Exception as e:
                        print(f"        ^ FAIL: {e}")
        if i % 200 == 0:
            print(f"  ...{i}/{len(rows)} found={len(found)} nomatch={nomatch} "
                  f"lang_skip={lang_skip} name_skip={name_skip} set_skip={set_skip}")

    print(f"\nfind-missing done. rows={len(rows)} found={len(found)} nomatch={nomatch} "
          f"lang_skip={lang_skip} name_skip={name_skip} set_skip={set_skip}")
    if found and not apply:
        with open("find_missing_proposals.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["id", "name", "set_name", "card_number", "proposed_id", "matched_product", "matched_console"])
            for row, pid, pname, cname in found:
                w.writerow([row["id"], row.get("name"), row.get("set_name"),
                            row.get("card_number"), pid, pname, cname])
        print(f"\nDRY-RUN — wrote find_missing_proposals.csv ({len(found)} proposals). "
              "Review, then re-run with --apply.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tcg", default=None, help="game_type scope (e.g. pokemon)")
    ap.add_argument("--id-prefix", default=None, help="catalog id prefix scope, e.g. 'xyp-' (recommended)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--apply", action="store_true", help="write fixes (default: dry-run report)")
    ap.add_argument("--keep-value", action="store_true", help="on fix, don't NULL current_value")
    ap.add_argument("--verify", action="store_true",
                    help="confirm each new id via PC /api/product before trusting it "
                         "(needs PRICECHARTING_API_KEY); a new id the API rejects is NOT applied")
    ap.add_argument("--api-scan", action="store_true",
                    help="FAST survey via PC API only (no page scraping): flag rows whose "
                         "STORED id resolves to a different-language product. Detection only; "
                         "writes a suspects CSV + an ids file you then fix with --ids-file.")
    ap.add_argument("--ids-file", default=None,
                    help="process only the catalog ids listed in this file (one per line). "
                         "Use it to fix the suspects an --api-scan turned up.")
    ap.add_argument("--find-missing", action="store_true",
                    help="fill rows that have NO pricecharting_id: search the PC API by "
                         "name+set, language- and name-guarded. Dry-run writes proposals CSV.")
    args = ap.parse_args()

    ids = None
    if args.ids_file:
        with open(args.ids_file) as f:
            ids = [ln.strip() for ln in f if ln.strip()]
        if not ids:
            sys.exit(f"{args.ids_file} has no ids.")

    if not (args.tcg or args.id_prefix or ids):
        sys.exit("Refusing to run against the ENTIRE catalog unscoped.\n"
                 "Scope it, e.g.:  --id-prefix xyp-   |   --tcg pokemon   |   --ids-file <file>")

    if (args.verify or args.api_scan or args.find_missing) and not PC_API_KEY:
        sys.exit("--verify / --api-scan / --find-missing need PRICECHARTING_API_KEY in your environment.")

    # ── Fill rows that have no pricecharting_id (PC API name search). ──
    if args.find_missing:
        rows = load_rows(args.tcg, args.id_prefix, args.limit, ids=ids,
                         require_url=False, missing_only=True)
        est_min = max(1, len(rows) // 30 // 60 + 1)
        print(f"find-missing across {len(rows):,} id-less rows (~30/sec — ~{est_min} min)"
              f"{'' if args.apply else ' — DRY-RUN'}.\n")
        run_find_missing(rows, args.apply)
        return

    # ── Fast detection-only pass: no scraping, no writes. ──
    if args.api_scan:
        rows = load_rows(args.tcg, args.id_prefix, args.limit, ids=ids, require_url=False)
        est_min = max(1, len(rows) // 30 // 60 + 1)
        print(f"API-scan {len(rows):,} rows by stored id (~30/sec — ~{est_min} min). No writes.\n")
        run_api_scan(rows)
        return

    rows = load_rows(args.tcg, args.id_prefix, args.limit, ids=ids)
    est_min = max(1, len(rows) * 4 // 60)
    print(f"Loaded {len(rows):,} rows with both a URL and an id.")
    print(f"Scraping to re-verify (~{SCRAPE_MIN_S:.0f}-{SCRAPE_MAX_S:.0f}s/row, single worker — ~{est_min} min)\n")

    mism = []; ok = 0; unresolved = 0; errors = 0; unverified = 0
    for i, row in enumerate(rows, 1):
        url    = (row.get("price_source_url") or "").strip()
        stored = str(row.get("pricecharting_id") or "").strip()
        if "pricecharting.com" not in url:
            continue
        try:
            true_id = extract_id(fetch(url))
        except Exception as e:
            errors += 1; print(f"  [{i}/{len(rows)}] ERROR {row['id']}: {e}"); continue
        if not true_id:
            unresolved += 1; continue
        if true_id != stored:
            # Optional spot-check: does the new id resolve to a real,
            # priced product? Tag the line and gate the write on it.
            info = api_product_info(true_id) if args.verify else None
            tag = ""
            if args.verify:
                if isinstance(info, dict):
                    pname = info.get("product-name") or "?"
                    cname = info.get("console-name") or "?"
                    lp    = info.get("loose-price")
                    price = f" ${lp/100:.2f}" if isinstance(lp, (int, float)) else ""
                    tag = f"  [verified: {pname} / {cname}{price}]"
                elif info is False:
                    tag = "  [API REJECTED new id — NOT applied]"
            mism.append((row, stored, true_id, info))
            print(f"  MISMATCH {row['id']:<16} stored={stored:<10} -> page={true_id:<10} "
                  f"cur=${row.get('current_value')}  {row.get('name')}{tag}")
            if args.apply:
                if args.verify and info is False:
                    unverified += 1
                    print("           ^ skipped (new id failed API verification)")
                else:
                    try:
                        patch(row["id"], true_id, not args.keep_value)
                        print("           ^ fixed")
                    except Exception as e:
                        print(f"           ^ PATCH FAILED: {e}")
        else:
            ok += 1
        if i % 25 == 0:
            print(f"  ...{i}/{len(rows)}  ok={ok} mismatch={len(mism)} err={errors}")

    print(f"\nDone. rows={len(rows)} ok={ok} mismatches={len(mism)} "
          f"unverified={unverified} unresolved={unresolved} errors={errors}")
    if mism and not args.apply:
        out = "reverify_mismatches.csv"
        with open(out, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["id", "name", "set_name", "stored_id", "correct_id",
                        "verified_as", "current_value", "price_source_url"])
            for row, stored, true_id, info in mism:
                verified_as = ""
                if isinstance(info, dict):
                    verified_as = f"{info.get('product-name','?')} / {info.get('console-name','?')}"
                elif info is False:
                    verified_as = "API REJECTED"
                w.writerow([row["id"], row.get("name"), row.get("set_name"), stored, true_id,
                            verified_as, row.get("current_value"), row.get("price_source_url")])
        print(f"\nDRY-RUN — nothing written. Wrote {out} ({len(mism)} rows) for review.")
        print("Re-run with --apply to correct them (also NULLs current_value unless --keep-value).")


if __name__ == "__main__":
    main()
