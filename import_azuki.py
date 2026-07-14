#!/usr/bin/env python3
"""
PathBinder — Azuki TCG catalog import (STAGED by default; nothing goes live
until --commit).

Source: https://tcg.azuki.com/api/cards  — Azuki's own first-party gallery API.
This is NOT an open fan API (unlike pokemontcg.io / Scryfall), so we are asking
Azuki for permission before shipping anything that uses it (see the outreach
draft). Their card ART is Azuki's copyright — do NOT re-host it (--mirror) until
you have the OK.

WHY THIS CAN'T AFFECT APP STORE REVIEW:
  Default mode fetches + maps all cards to catalog rows and writes them to a
  local JSON. It writes NOTHING to the database, re-hosts NO images, and needs
  no credentials. And even after --commit, nothing SURFACES in the app until you
  also wire the "new TCG" config (game_type/prefix in pokedata_sync, the sets
  CFG block, the scanner detector, the game dropdowns). So the staged data is
  invisible end-to-end.

USAGE:
    # GRAB (staged, no creds, nothing live) — inspect azuki_cards_staged.json
    python3 import_azuki.py

    # GO LIVE (after permission + App Store clears): upsert rows into catalog.
    # Needs SUPABASE_URL + SUPABASE_SERVICE_KEY.
    python3 import_azuki.py --commit

    # GO LIVE + re-host the card art into card-images/azuki/ (only after you
    # have permission — this copies Azuki's copyrighted images to our storage).
    python3 import_azuki.py --commit --mirror
"""

import os, sys, io, json, argparse

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

API_URL     = "https://tcg.azuki.com/api/cards"
UA          = "PathBinderSync/1.0 (+https://pathbinder.gg)"
STAGE_FILE  = "azuki_cards_staged.json"
STORAGE_BUCKET = "card-images"


def fetch_cards():
    r = requests.get(API_URL, headers={
        "User-Agent": UA,
        "Referer": "https://tcg.azuki.com/gallery",
        "Accept": "application/json",
    }, timeout=30)
    r.raise_for_status()
    d = r.json()
    return d.get("cards", d if isinstance(d, list) else [])


def to_row(c):
    """Map one Azuki API card -> a PathBinder catalog row."""
    cid = (c.get("cardId") or c.get("id") or "").strip()
    set_code = cid.split("-")[0] if "-" in cid else ""          # AZK01
    number   = cid.split("-", 1)[1] if "-" in cid else ""       # 001
    sets = c.get("set") or []
    set_name = ", ".join(sets) if isinstance(sets, list) else str(sets or "")
    return {
        "id":           "azk-" + cid,
        "game_type":    "azuki",
        "name":         c.get("name") or "",
        "set_name":     set_name or "Azuki TCG",
        "set_code":     set_code,
        "card_number":  number,
        "rarity":       c.get("rarity") or "",
        "image_url":    c.get("image") or "",   # Azuki CDN; re-hosted only with --mirror
        "product_type": "single",
        "supertype":    c.get("category") or "",
    }


# ── go-live helpers (only used with --commit) ───────────────────────────────
def _sb_env():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not (url and key):
        sys.exit("--commit needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.")
    return url.rstrip("/"), key


def upsert_catalog(rows):
    url, key = _sb_env()
    r = requests.post(f"{url}/rest/v1/catalog?on_conflict=id", headers={
        "apikey": key, "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }, data=json.dumps(rows, ensure_ascii=False).encode("utf-8"), timeout=120)
    if not r.ok:
        sys.exit(f"catalog upsert failed HTTP {r.status_code}: {r.text[:400]}")
    print(f"  upserted {len(rows)} rows into public.catalog")


def mirror_images(rows):
    """Re-host Azuki card art into card-images/azuki/<cardId>.webp. ONLY run this
    once you have Azuki's permission — it copies their copyrighted images."""
    try:
        from PIL import Image
        from supabase import create_client
    except ImportError:
        sys.exit("--mirror needs pillow + supabase: pip3 install pillow supabase --break-system-packages")
    url, key = _sb_env()
    sb = create_client(url, key)
    sess = requests.Session(); sess.headers.update({"User-Agent": UA})
    done = 0
    for row in rows:
        src = row.get("image_url") or ""
        if not src or "azuki.com" not in src:
            continue
        cid = row["id"].replace("azk-", "")
        path = f"azuki/{cid}.webp"
        try:
            raw = sess.get(src, timeout=25).content
            im = Image.open(io.BytesIO(raw))
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            out = io.BytesIO(); im.save(out, format="WEBP", quality=82, method=6)
            sb.storage.from_(STORAGE_BUCKET).upload(
                path, out.getvalue(), file_options={"content-type": "image/webp", "upsert": "true"})
            new_url = f"{url}/storage/v1/object/public/{STORAGE_BUCKET}/{path}"
            requests.patch(f"{url}/rest/v1/catalog?id=eq.{requests.utils.quote(row['id'])}", headers={
                "apikey": key, "Authorization": f"Bearer {key}",
                "Content-Type": "application/json", "Prefer": "return=minimal",
            }, data=json.dumps({"image_url": new_url}).encode("utf-8"), timeout=30)
            done += 1
            if done % 25 == 0:
                print(f"    mirrored {done}/{len(rows)}")
        except Exception as e:
            print(f"    ! {row['id']}: {e}")
    print(f"  mirrored {done} images into {STORAGE_BUCKET}/azuki/")


def main():
    ap = argparse.ArgumentParser(description="Azuki TCG catalog import (staged unless --commit).")
    ap.add_argument("--commit", action="store_true", help="Go live: upsert rows into catalog (needs SUPABASE creds).")
    ap.add_argument("--mirror", action="store_true", help="With --commit: re-host card art to storage (needs permission).")
    ap.add_argument("--out", default=STAGE_FILE, help="Staged JSON path (default azuki_cards_staged.json).")
    args = ap.parse_args()

    cards = fetch_cards()
    rows = [to_row(c) for c in cards]
    print(f"fetched {len(cards)} Azuki cards -> {len(rows)} catalog rows")

    rar = {}
    for r in rows:
        rar[r["rarity"]] = rar.get(r["rarity"], 0) + 1
    print("  rarities:", rar)
    print("  sets:    ", sorted(set(r["set_name"] for r in rows)))
    print("  sample:  ", {k: rows[0][k] for k in ("id", "name", "set_code", "rarity")} if rows else "-")

    if not args.commit:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump({"source": API_URL, "count": len(rows), "rows": rows, "raw": cards},
                      f, indent=2, ensure_ascii=False)
        print(f"\nSTAGED -> {args.out}")
        print("Nothing is live. Review the file; run --commit (with SUPABASE creds) + wire the")
        print("app's new-TCG config to go live. Re-host art (--mirror) only after Azuki's OK.")
        return

    print("\n--commit: writing to the LIVE catalog in 3s (Ctrl-C to abort)…")
    import time; time.sleep(3)
    upsert_catalog(rows)
    if args.mirror:
        mirror_images(rows)
    print("Done. Rows are in catalog but still invisible until the app's new-TCG config is wired.")


if __name__ == "__main__":
    main()
