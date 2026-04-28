"""
PathBinder — Catalog Diagnostic
Run: python3 diagnose.py
"""
import os, sys, requests
from supabase import create_client

SUPABASE_URL = "https://xjamytrhxeaynywcwfun.supabase.co"
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or input("Service role key: ").strip()

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

print("\n══════════════════════════════════════")
print("  CATALOG STATS")
print("══════════════════════════════════════")

total_res = sb.table("catalog").select("id", count="exact").execute()
embed_res  = sb.table("catalog").select("id", count="exact").not_.is_("embedding", "null").execute()

total  = total_res.count or 0
embedded = embed_res.count or 0
print(f"  Total rows:        {total:,}")
print(f"  With embeddings:   {embedded:,}")
print(f"  Missing embeddings:{total - embedded:,}")

print("\n══════════════════════════════════════")
print("  IMAGE URL CHECK (sample 10 cards)")
print("══════════════════════════════════════")

sample = sb.table("catalog").select("id, name, image_url").limit(10).execute()
broken = []
for card in (sample.data or []):
    url = card.get("image_url", "")
    if not url:
        print(f"  ✗ {card['name'][:40]} — NO URL")
        broken.append(card)
        continue
    try:
        r = requests.head(url, timeout=6, allow_redirects=True)
        status = r.status_code
        ok = status == 200
        icon = "✓" if ok else "✗"
        print(f"  {icon} {card['name'][:40]} — {status}  {url[:60]}")
        if not ok:
            broken.append(card)
    except Exception as e:
        print(f"  ✗ {card['name'][:40]} — ERROR: {e}")
        broken.append(card)

print("\n══════════════════════════════════════")
print(f"  {len(broken)}/10 sample URLs broken")

if embedded == 0:
    print("\n  ⚠  No embeddings found. The script ran but all image")
    print("     downloads likely failed. Fix image URLs first,")
    print("     then re-run generate_embeddings.py.")
elif embedded < total:
    print(f"\n  ⚠  {total-embedded:,} cards still need embeddings.")
    print("     Set SKIP_EXISTING=True and re-run generate_embeddings.py.")
else:
    print("\n  ✓ All cards embedded — catalog looks good!")

print("══════════════════════════════════════\n")
