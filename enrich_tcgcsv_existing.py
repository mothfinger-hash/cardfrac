#!/usr/bin/env python3
"""
enrich_tcgcsv_existing.py — link EXISTING catalog rows to TCGplayer via tcgcsv.

Unlike import_tcgcsv_set.py (which CREATES fresh `{prefix}-{set}-{num}` rows),
this MATCHES a tcgcsv group's products to catalog rows you ALREADY have — by
(set_code, card_number) — and writes `tcgplayer_product_id` + `tcgplayer_url`
+ a `card_prices(source='tcgplayer')` row, leaving the existing row id
untouched. No duplicates.

WHY (Japanese Pokemon)
----------------------
PriceCharting carries JP only per-console; TCGplayer carries JP under category
85 ("Pokemon Japan"). But our JP singles already exist as `pd-M2a-*` / `jp-*`
rows, so a fresh import_tcgcsv_set.py run would DUPLICATE them. This enriches
them in place so JP joins the TCGplayer price spine that English already uses.
After a run, re-run migration_current_value_from_tcgplayer.sql — it reseats
current_value from the new card_prices rows and stamps
market_price_source='tcgplayer' (which also shields them from the nightly PC
refresh). Generic: works for any (tcgcsv group -> existing set_code) pair.

USAGE
-----
    # Find the group id at https://tcgcsv.com/tcgplayer/85/groups (or the site).
    # Mega Dream = group 24499 (name "M2a: High Class Pack: MEGA Dream ex").
    python3 enrich_tcgcsv_existing.py --group 24499 --category 85 --set-code M2a --dry-run
    python3 enrich_tcgcsv_existing.py --group 24499 --category 85 --set-code M2a --commit

    --force              overwrite an existing tcgplayer_product_id (default:
                         skip rows that already have one).
    --min-name-ratio R   name-confirmation threshold, 0..1 (default 0.40;
                         0 = number-only matching).
    --limit N            stop after N matches (smoke test).

ENVIRONMENT
    SUPABASE_URL, SUPABASE_SERVICE_KEY   (service key — this WRITES on --commit)
"""

import argparse
import json
import re
import sys
from datetime import date

import sync_tcgcsv as tc


# Hiragana, katakana, CJK ideographs, half-width kana — detects a Japanese name.
_CJK = re.compile(r"[぀-ヿ㐀-鿿ｦ-ﾟ]")


def is_cjk(s):
    return bool(_CJK.search(s or ""))


# tcgcsv JP cleanNames often carry a trailing "NNN NNN" or "NNN/NNN" (number +
# set total): "Oddish 001 190" -> "Oddish", "Venusaur ex 003 165" -> "Venusaur
# ex". A bare "Parasect" or "Hisuian Electrode V" is left untouched.
_TRAIL_NUM = re.compile(r"\s+\d{1,4}\s*[/ ]\s*\d{1,4}\s*$")


def english_name(clean_name):
    if not clean_name:
        return None
    out = _TRAIL_NUM.sub("", clean_name).strip()
    return out or clean_name.strip()


def _base_product(cands):
    """Among same-number products, the BASE card has the shortest cleanName —
    variants only ADD tokens (' Mirror Holofoil', ' Poke Ball Pattern')."""
    return min(cands, key=lambda p: len(p.get("cleanName") or p.get("name") or ""))


# Finish/variant descriptors that are NOT part of a card's identity. Our JP rows
# carry some ("Pinsir 1st Edition", "Shaymin EX 1st Edition Holofoil") while
# tcgcsv's cleanName is bare ("Pinsir"); stripping these from BOTH sides lets
# them match. Deliberately does NOT touch 'EX'/'V'/'ex' — those ARE the name.
_VARIANT_RE = re.compile(
    r"\b(1st edition|first edition|reverse holofoil|reverse holo|holofoil|"
    r"cosmos holofoil|mirror holofoil|poke ball pattern|master ball pattern|"
    r"shadowless|unlimited)\b",
    re.IGNORECASE,
)


def strip_variant(s):
    return _VARIANT_RE.sub(" ", s or "")


def _match_name(s):
    """Name normalized for matching: drop tcgcsv's trailing 'NNN NNN', strip the
    finish/variant descriptors above, then tc.norm_name. Aligns our
    '<Card> 1st Edition' with tcgcsv's clean '<Card>'."""
    return tc.norm_name(strip_variant(english_name(s) or s or ""))


def product_number(product):
    """Normalized card number from a tcgcsv product's extendedData 'Number'."""
    for ed in product.get("extendedData", []):
        if ed.get("name") == "Number":
            return tc.norm_number(ed.get("value"))
    return None


def price_map(category, group):
    """productId -> market price, preferring the 'Normal' subtype."""
    out = {}
    for pr in tc.tcg_get(f"/tcgplayer/{category}/{group}/prices").get("results", []):
        pid = pr.get("productId")
        mp = pr.get("marketPrice") or pr.get("midPrice")
        if pid and mp and (pid not in out or pr.get("subTypeName") == "Normal"):
            out[pid] = mp
    return out


def _emit_link(r, product, prices, link_rows, price_rows, today):
    """Append a catalog-link row (+ a card_prices row if the product is priced)."""
    pid = product["productId"]
    url = product.get("url")
    link_rows.append({"id": r["id"], "tcgplayer_product_id": pid, "tcgplayer_url": url})
    mp = prices.get(pid)
    if mp:
        price_rows.append({"catalog_id": r["id"], "source": "tcgplayer", "value": mp,
                           "currency": "USD", "source_url": url, "recorded_at": today})
    return mp


def match_products(prods, prices, ours, min_name_ratio=0.40, force=False, limit=0,
                   name_fallback=False, cjk_trust=False):
    """Pure matcher (no network) — returns (link_rows, price_rows, name_rows, stats, samples, misses).

    ROW-CENTRIC. Pass 1: (set, number) then best name among same-number products
    (a set page carries several products per number — base + holo + stamped 'Ball
    Pattern' reverse variants — and we hold one row per (set, number); picking the
    best product PER ROW keeps the base card on the base product). A row whose
    number resolves to a product with a mismatched name is REFUSED, not linked —
    that guard is load-bearing (deck 'BK' numbers our Cottonee #3 as tcgcsv's
    Ferroseed #3; blindly trusting the number would mis-price it).

    Pass 2 (opt-in name_fallback): for rows Pass 1 couldn't resolve, link by EXACT
    normalized name when exactly ONE still-unclaimed product in the group carries
    that name. Recovers sets whose local numbering diverges from tcgcsv without the
    mis-link risk of a bad number. Ambiguous names (duplicates, already-claimed)
    stay refused.
    """
    by_num = {}
    card_prods = []
    for p in prods:
        if not tc.is_card_product(p):
            continue
        card_prods.append(p)
        num = product_number(p)
        if num:
            by_num.setdefault(num, []).append(p)

    # Is our numbering the SAME as tcgcsv's for this set? Gate for cjk_trust:
    # only trust a Japanese-named row's number when >=90% of our numbers exist
    # in tcgcsv (proof the schemes align — a divergent set fails this and its
    # CJK rows stay refused rather than mis-linking blind).
    our_nums = {n for n in (tc.norm_number(r.get("card_number")) for r in ours) if n}
    aligned = bool(our_nums) and (len(our_nums & set(by_num)) / len(our_nums)) >= 0.90

    link_rows, price_rows, name_rows = [], [], []
    stats = {"matched": 0, "matched_by_name": 0, "matched_cjk": 0, "already": 0,
             "name_mismatch": 0, "no_product": 0}
    samples, misses = [], []
    today = date.today().isoformat()
    claimed = set()      # productIds linked in Pass 1 (Pass 2 must not reuse)
    unresolved = []      # rows Pass 1 couldn't link (candidates for Pass 2)

    def _linked():
        return stats["matched"] + stats["matched_by_name"] + stats["matched_cjk"]

    for r in ours:
        if limit and _linked() >= limit:
            break
        if r.get("tcgplayer_product_id") and not force:
            stats["already"] += 1
            continue
        num = tc.norm_number(r.get("card_number"))
        cands = by_num.get(num) if num else None
        if not cands:
            stats["no_product"] += 1
            unresolved.append(r)
            continue
        # CJK number-trust: our name is Japanese, so English-name confirmation
        # can't work — but the set's numbering is verified to align, so the
        # number IS the identity. Link the base product and replace the JP name
        # with tcgcsv's English one (dry-run [jp] lines let you eyeball the map).
        if cjk_trust and aligned and is_cjk(r.get("name")):
            base = _base_product(cands)
            mp = _emit_link(r, base, prices, link_rows, price_rows, today)
            claimed.add(base["productId"])
            eng = english_name(base.get("cleanName") or base.get("name"))
            if eng and eng != (r.get("name") or ""):
                name_rows.append({"id": r["id"], "name": eng})
            stats["matched_cjk"] += 1
            if len(samples) < 24:
                samples.append(f"    [jp] {r['id']:<14} #{num:<5} {(r.get('name') or '')[:8]:<8} "
                               f"-> tcg {base['productId']}  {eng}  ${mp}")
            continue
        rname = _match_name(r.get("name") or "")
        best = max(cands, key=lambda p: tc.ratio(_match_name(p.get("cleanName") or p.get("name") or ""), rname))
        p_ratio = tc.ratio(_match_name(best.get("cleanName") or best.get("name") or ""), rname)
        if min_name_ratio and p_ratio < min_name_ratio:
            stats["name_mismatch"] += 1
            unresolved.append(r)
            if len(misses) < 14:
                misses.append(f"{r['id']} #{num} NAME? '{r.get('name')}' vs "
                              f"'{best.get('cleanName') or best.get('name')}' ({p_ratio:.2f})")
            continue
        mp = _emit_link(r, best, prices, link_rows, price_rows, today)
        claimed.add(best["productId"])
        stats["matched"] += 1
        if len(samples) < 20:
            samples.append(f"    {r['id']:<15} #{num:<5} {(r.get('name') or '')[:22]:<22} "
                           f"-> tcg {best['productId']}  ${mp}")

    # ── Pass 2: exact-name fallback over UNCLAIMED products ──────────────────
    if name_fallback and unresolved:
        by_name = {}
        for p in card_prods:
            if p["productId"] in claimed:
                continue
            nm = _match_name(p.get("cleanName") or p.get("name") or "")
            if nm:
                by_name.setdefault(nm, []).append(p)
        for r in unresolved:
            if limit and _linked() >= limit:
                break
            rname = _match_name(r.get("name") or "")
            pool = by_name.get(rname) if rname else None
            uniq = list({p["productId"]: p for p in (pool or [])}.values())
            if len(uniq) != 1:
                continue   # 0 = no name match; >1 = ambiguous — stay refused
            p = uniq[0]
            mp = _emit_link(r, p, prices, link_rows, price_rows, today)
            # consume it so no other row can claim the same product
            by_name[rname] = [x for x in by_name[rname] if x["productId"] != p["productId"]]
            stats["matched_by_name"] += 1
            if len(samples) < 40:
                samples.append(f"    [name] {r['id']:<13} {(r.get('name') or '')[:20]:<20} "
                               f"-> tcg {p['productId']}  ${mp}")

    return link_rows, price_rows, name_rows, stats, samples, misses


def patch_catalog_names(name_rows):
    """Overwrite catalog.name for the given rows (used to swap a Japanese name
    for tcgcsv's English one on a CJK number-trust match). Per-row PATCH — the
    apply_tcgplayer_links RPC only touches the link columns."""
    for i, row in enumerate(name_rows, 1):
        rid = tc.requests.utils.quote(row["id"], safe="")
        tc._sb.patch(
            f"{tc.SUPABASE_URL.rstrip('/')}/rest/v1/catalog?id=eq.{rid}",
            headers={"Content-Type": "application/json", "Prefer": "return=minimal"},
            data=json.dumps({"name": row["name"]}),
            timeout=30,
        )
        if i % 200 == 0:
            print(f"      …renamed {i}/{len(name_rows)}")


def load_existing(set_code):
    """Existing catalog rows for a set_code. NO game_type filter — legacy JP
    rows can have game_type=NULL; set_code is the set identity."""
    q = tc.requests.utils.quote(set_code, safe="")
    sel = "id,name,card_number,tcgplayer_product_id"
    rows = tc.sb_get(f"catalog?select={sel}&set_code=eq.{q}")
    if not rows:  # tolerate case drift (M2a vs m2a)
        rows = tc.sb_get(f"catalog?select={sel}&set_code=ilike.{q}")
    return rows


# Every Pokemon-Japan group name starts with the TCGplayer set code, e.g.
# "M2a: High Class Pack: MEGA Dream ex", "BW9: Megalo Cannon". The code is the
# token before the first ':' — short, no spaces. Deck/box groups without a code
# prefix ("Meganium Constructed Starter Deck") yield None and are skipped.
_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,11}$")


def derive_set_code(group_name):
    if not group_name or ":" not in group_name:
        return None
    code = group_name.split(":", 1)[0].strip()
    if " " in code or not _CODE_RE.match(code):
        return None
    return code


def load_existing_bulk(set_codes):
    """Existing catalog rows for many set_codes in one sweep (batched IN()).
    Returns {set_code: [rows]} keyed by the set_code exactly as stored. NOTE:
    PostgREST IN() is case-sensitive, so a group whose code case differs from
    our stored set_code won't match here — those are reported as not-carried
    and can be pinned with the per-group command."""
    out = {}
    codes = [c for c in set_codes if c]
    sel = "id,name,card_number,set_code,tcgplayer_product_id"
    PAGE = 1000   # PostgREST caps a response at 1000 rows — MUST paginate or a
                  # code-batch summing to >1000 rows silently drops whole sets.
    for i in range(0, len(codes), 40):
        inlist = ",".join(codes[i:i + 40])  # codes are alphanumeric — safe unquoted
        off = 0
        while True:
            rows = tc.sb_get(f"catalog?select={sel}&set_code=in.({inlist})"
                             f"&order=id.asc&limit={PAGE}&offset={off}")
            for r in rows:
                out.setdefault(r.get("set_code"), []).append(r)
            if len(rows) < PAGE:
                break
            off += PAGE
    return out


def run_bulk(args):
    """Walk every group in the category, auto-derive set_code from the group
    name, and enrich each set we already carry. One command for all of JP."""
    cat = args.category
    print(f"\n  BULK cat={cat} — enrich every group whose set_code you already carry.\n")
    groups = tc.tcg_get(f"/tcgplayer/{cat}/groups").get("results", [])
    code_group = {}   # set_code -> (groupId, group_name)  (first group wins per code)
    no_code = []
    for g in groups:
        code = derive_set_code(g.get("name"))
        if not code:
            no_code.append(g.get("name"))
            continue
        code_group.setdefault(code, (g.get("groupId"), g.get("name")))
    print(f"  {len(groups)} groups; derived a code for {len(code_group)}; "
          f"{len(no_code)} had no code prefix.")

    existing = load_existing_bulk(list(code_group.keys()))
    carried = sorted(c for c in code_group if existing.get(c))
    print(f"  You carry {len(carried)} of those sets. Enriching…\n")

    all_links, all_prices, all_names, report = [], [], [], []
    for code in carried:
        if args.max_sets and len(report) >= args.max_sets:
            break
        gid, gname = code_group[code]
        ours = existing[code]
        try:
            prods = tc.tcg_get(f"/tcgplayer/{cat}/{gid}/products").get("results", [])
            prices = price_map(cat, gid)
        except Exception as e:
            print(f"    {code:<10} group {gid:<7} FETCH FAILED: {e}")
            report.append((code, gid, len(ours), None))
            continue
        link, price, names, stats, _s, _m = match_products(
            prods, prices, ours, args.min_name_ratio, args.force, 0,
            args.name_fallback, args.cjk_number_trust)
        all_links.extend(link)
        all_prices.extend(price)
        all_names.extend(names)
        report.append((code, gid, len(ours), stats))
        linked = stats["matched"] + stats["matched_by_name"] + stats["matched_cjk"]
        refused = stats["no_product"] + stats["name_mismatch"] - stats["matched_by_name"]
        print(f"    {code:<10} group {gid:<7} rows={len(ours):<4} link={linked:<4} "
              f"(num={stats['matched']} name={stats['matched_by_name']} jp={stats['matched_cjk']})  "
              f"have={stats['already']:<3} refused={refused}")

    # A row must appear once per write batch (a code could map to >1 product
    # across quirks; the RPC can't update the same id twice in one call).
    all_links = list({l["id"]: l for l in all_links}.values())
    all_prices = list({(p["catalog_id"], p["source"]): p for p in all_prices}.values())
    all_names = list({n["id"]: n for n in all_names}.values())

    tot = sum(r[3]["matched"] + r[3]["matched_by_name"] + r[3]["matched_cjk"] for r in report if r[3])
    tot_name = sum(r[3]["matched_by_name"] for r in report if r[3])
    tot_jp = sum(r[3]["matched_cjk"] for r in report if r[3])
    print(f"\n  TOTAL: {len([r for r in report if r[3]])} sets · {tot} rows to link "
          f"({tot_name} via name-fallback, {tot_jp} via JP number-trust) · "
          f"{len(all_prices)} prices · {len(all_names)} JP→EN renames.")
    if no_code:
        print(f"  ({len(no_code)} groups had no code prefix — pin any you carry with "
              f"--group/--set-code.)")

    if args.commit:
        if not all_links:
            print("\n  Nothing to write.")
            return
        print(f"\n  Writing {len(all_links)} links + {len(all_prices)} prices…")
        tc.sb_upsert_catalog_links(all_links)
        if all_prices:
            tc.sb_upsert_card_prices(all_prices)
        if all_names:
            print(f"  Renaming {len(all_names)} Japanese names to English…")
            patch_catalog_names(all_names)
        print("  Done. Re-run migration_current_value_from_tcgplayer.sql (or "
              "reseat_tcgplayer.py) to reseat current_value for the JP rows.")
    else:
        print(f"\n  DRY-RUN — no writes. Would link {len(all_links)}, price "
              f"{len(all_prices)}, rename {len(all_names)}.")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all-groups", action="store_true",
                    help="BULK: walk every group in --category, auto-derive set_code from "
                         "each group name, and enrich every set you already carry. One "
                         "command for all of Japanese Pokemon.")
    ap.add_argument("--group", type=int, default=None, help="tcgcsv/TCGplayer groupId (single-set mode)")
    ap.add_argument("--category", type=int, default=85,
                    help="TCGplayer categoryId (default 85 = Pokemon Japan)")
    ap.add_argument("--set-code", dest="set_code", default=None,
                    help="Our catalog set_code to match against (e.g. M2a). Single-set mode.")
    ap.add_argument("--max-sets", type=int, default=0,
                    help="BULK only: stop after N sets (smoke test).")
    ap.add_argument("--force", action="store_true",
                    help="Overwrite an existing tcgplayer_product_id (default: skip).")
    ap.add_argument("--min-name-ratio", type=float, default=0.40,
                    help="Name-confirmation threshold 0..1 (0 = number-only). Leave at "
                         "0.40 — it's what stops divergent-numbering sets mis-linking.")
    ap.add_argument("--name-fallback", action="store_true",
                    help="Second pass: for rows whose NUMBER didn't resolve, link by "
                         "EXACT name when exactly one still-unclaimed product carries it. "
                         "Recovers sets whose local numbering diverges from tcgcsv (decks, "
                         "some older JP sets) without the mis-link risk of a bad number.")
    ap.add_argument("--cjk-number-trust", action="store_true",
                    help="For rows with a JAPANESE name, skip English-name confirmation and "
                         "trust the number (gated: only when >=90%% of the set's numbers exist "
                         "in tcgcsv, proving alignment). Also REWRITES the Japanese name to "
                         "tcgcsv's English one. Recovers the SV/S-era JP sets. Dry-run first "
                         "and eyeball the [jp] lines (JP name -> English) before --commit.")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--commit", action="store_true")
    args = ap.parse_args()
    if not (args.dry_run or args.commit):
        sys.exit("Pass --dry-run (report only) or --commit (write).")

    if args.all_groups:
        run_bulk(args)
        return
    if args.group is None or not args.set_code:
        sys.exit("Single-set mode needs --group and --set-code (or use --all-groups).")

    cat, grp, sc = args.category, args.group, args.set_code.strip()
    print(f"\n  tcgcsv cat={cat} group={grp}  ->  catalog set_code={sc!r}")

    prods = tc.tcg_get(f"/tcgplayer/{cat}/{grp}/products").get("results", [])
    prices = price_map(cat, grp)
    print(f"  tcgcsv: {len(prods)} products, {len(prices)} priced.")

    ours = load_existing(sc)
    print(f"  catalog: {len(ours)} existing rows with set_code={sc!r}.")
    if not ours:
        sys.exit("No existing rows for that set_code. This tool enriches EXISTING "
                 "rows; to CREATE a new set use import_tcgcsv_set.py instead.")

    link_rows, price_rows, name_rows, stats, samples, misses = match_products(
        prods, prices, ours, args.min_name_ratio, args.force, args.limit,
        args.name_fallback, args.cjk_number_trust)

    refused = stats["no_product"] + stats["name_mismatch"] - stats["matched_by_name"]
    print(f"\n  matched={stats['matched']}  by_name={stats['matched_by_name']}  "
          f"jp_number_trust={stats['matched_cjk']}  already_linked={stats['already']}  "
          f"refused={refused} (no_product={stats['no_product']} name_mismatch={stats['name_mismatch']})")
    if samples:
        print("  sample links (catalog -> tcgplayer):")
        print("\n".join(samples))
    if misses:
        print("  sample unmatched / name-check:")
        for m in misses[:10]:
            print(f"    {m}")

    if args.commit:
        if not link_rows:
            print("\n  Nothing to write.")
            return
        print(f"\n  Writing {len(link_rows)} links + {len(price_rows)} prices…")
        tc.sb_upsert_catalog_links(link_rows)
        if price_rows:
            tc.sb_upsert_card_prices(price_rows)
        if name_rows:
            print(f"  Renaming {len(name_rows)} Japanese names to English…")
            patch_catalog_names(name_rows)
        print("  Done. Now re-run migration_current_value_from_tcgplayer.sql (or "
              "reseat_tcgplayer.py) to reseat current_value from the new TCGplayer prices.")
    else:
        print(f"\n  DRY-RUN — no writes. Would link {len(link_rows)} rows, "
              f"write {len(price_rows)} prices, rename {len(name_rows)}.")


if __name__ == "__main__":
    main()
