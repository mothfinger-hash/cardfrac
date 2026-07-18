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


def _scalar(payload):
    """PostgREST returns a scalar function result directly, but tolerate the
    list/dict wrappings too."""
    if isinstance(payload, list):
        payload = payload[0] if payload else 0
    if isinstance(payload, dict):
        payload = next(iter(payload.values()), 0)
    return int(payload or 0)


def _run_loop(rpc_name, verb, batch, headers):
    """Loop a batched RPC (returns rows-affected) until it returns 0."""
    endpoint = f"{URL.rstrip('/')}/rest/v1/rpc/{rpc_name}"
    total = rounds = 0
    print(f"{verb} in batches of {batch:,}…")
    while True:
        try:
            r = requests.post(endpoint, headers=headers,
                              data=json.dumps({"p_limit": batch}), timeout=180)
        except requests.RequestException as e:
            print(f"  network blip ({type(e).__name__}); retrying in 3s…")
            time.sleep(3)
            continue
        if not r.ok:
            sys.exit(f"RPC {rpc_name} failed HTTP {r.status_code}: {r.text[:400]}\n"
                     "Did you run the CREATE FUNCTION + GRANT in the SQL editor first?")
        n = _scalar(r.json())
        total += n
        rounds += 1
        print(f"  batch {rounds:>3}: {n:>6,}   (total {total:,})")
        if n == 0:
            break
        time.sleep(0.2)
    print(f"  {verb.lower()} done — {total:,} rows across {rounds} batches.\n")
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=20000, help="rows per batch (default 20000)")
    ap.add_argument("--no-snapshot", action="store_true",
                    help="reseat only; skip the daily TCGplayer history snapshot")
    args = ap.parse_args()
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

    _run_loop("reseat_tcgplayer_batch", "Reseating current_value from TCGplayer", args.batch, headers)
    if not args.no_snapshot:
        _run_loop("snapshot_tcgplayer_history_batch", "Snapshotting today's TCGplayer history", args.batch, headers)

    print("Done. Marketplace Mkt + the '+/- % vs market' badge read TCGplayer for every card "
          "with a TCGplayer price, and the price-history chart's TCG series gains today's point.")


if __name__ == "__main__":
    main()
