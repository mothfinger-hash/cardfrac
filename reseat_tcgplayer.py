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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=20000, help="rows per batch (default 20000)")
    args = ap.parse_args()

    endpoint = f"{URL.rstrip('/')}/rest/v1/rpc/reseat_tcgplayer_batch"
    headers = {
        "apikey": KEY,
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
    }
    total = 0
    rounds = 0
    print(f"Reseating current_value from TCGplayer in batches of {args.batch:,}…")
    while True:
        try:
            r = requests.post(endpoint, headers=headers,
                              data=json.dumps({"p_limit": args.batch}), timeout=180)
        except requests.RequestException as e:
            print(f"  network blip ({type(e).__name__}); retrying in 3s…")
            time.sleep(3)
            continue
        if not r.ok:
            sys.exit(f"RPC failed HTTP {r.status_code}: {r.text[:400]}\n"
                     "Did you run the CREATE FUNCTION + GRANT in the SQL editor first?")
        n = _scalar(r.json())
        total += n
        rounds += 1
        print(f"  batch {rounds:>3}: reseated {n:>6,}   (total {total:,})")
        if n == 0:
            break
        time.sleep(0.2)

    print(f"\nDone — reseated {total:,} rows across {rounds} batches.")
    print("Marketplace Mkt + the '+/- % vs market' badge now read TCGplayer for "
          "every card with a TCGplayer price (JP included).")


if __name__ == "__main__":
    main()
