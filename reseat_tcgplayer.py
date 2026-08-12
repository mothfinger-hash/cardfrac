#!/usr/bin/env python3
"""
reseat_tcgplayer.py — reseat catalog.current_value onto TCGplayer prices, in
short batches via the reseat_tcgplayer_batch() RPC, looping until done.

Use this when the Supabase SQL editor drops the big UPDATE with
"Failed to fetch (api.supabase.com)" — that's the browser<->gateway request
timing out on a long query, which you can't raise from SQL. Each RPC call here
is a short request that commits its own batch, so nothing times out and it runs
unattended to completion.

PREREQ — run once in the SQL editor (both are fast, no timeout):
  1. the CREATE INDEX  in  migration_current_value_from_tcgplayer.sql
  2. the CREATE FUNCTION public.reseat_tcgplayer_batch(...)  in the same file

ENV:   SUPABASE_URL, SUPABASE_SERVICE_KEY
USAGE: python3 reseat_tcgplayer.py [--batch 20000]
"""
import argparse
import json
import os
import sys
import time

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

URL = os.environ.get("SUPABASE_URL")
KEY = os.environ.get("SUPABASE_SERVICE_KEY")
if not (URL and KEY):
    sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.")


def _run_keyset(rpc_name, verb, batch, headers, changed_key):
    """Loop a KEYSET-paginated RPC that returns (processed, <changed_key>,
    last_id) per call. Feed last_id back as p_after each round; stop when a
    short slice (processed < batch) or a null cursor signals the end. Each call
    scans/updates only its slice, so no batch trips the statement timeout."""
    endpoint = f"{URL.rstrip('/')}/rest/v1/rpc/{rpc_name}"
    after, total, rounds = "", 0, 0
    print(f"{verb} in keyset batches of {batch:,}…")
    while True:
        try:
            r = requests.post(endpoint, headers=headers,
                              data=json.dumps({"p_after": after, "p_limit": batch}),
                              timeout=180)
        except requests.RequestException as e:
            print(f"  network blip ({type(e).__name__}); retrying in 3s…")
            time.sleep(3)
            continue
        if not r.ok:
            sys.exit(f"RPC {rpc_name} failed HTTP {r.status_code}: {r.text[:400]}\n"
                     "Did you run the latest migration_current_value_from_tcgplayer.sql "
                     "(keyset functions) in the SQL editor first?")
        rows = r.json()
        row = rows[0] if isinstance(rows, list) and rows else (rows if isinstance(rows, dict) else {})
        processed = int(row.get("processed") or 0)
        changed = int(row.get(changed_key) or 0)
        last = row.get("last_id")
        total += changed
        rounds += 1
        print(f"  batch {rounds:>3}: scanned {processed:>6,}  changed {changed:>6,}   (total {total:,})")
        if processed < batch or not last:
            break
        after = last
        time.sleep(0.2)
    print(f"  {verb.lower()} done — {total:,} rows changed across {rounds} batches.\n")
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=10000, help="rows per keyset batch (default 10000)")
    ap.add_argument("--no-snapshot", action="store_true",
                    help="reseat only; skip the daily TCGplayer history snapshot")
    args = ap.parse_args()
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

    _run_keyset("reseat_tcgplayer_batch", "Reseating current_value from TCGplayer", args.batch, headers, "updated")
    if not args.no_snapshot:
        _run_keyset("snapshot_tcgplayer_history_batch", "Snapshotting today's TCGplayer history", args.batch, headers, "inserted")

    print("Done. Marketplace Mkt + the '+/- % vs market' badge read TCGplayer for every card "
          "with a TCGplayer price, and the price-history chart's TCG series gains today's point.")


if __name__ == "__main__":
    main()
