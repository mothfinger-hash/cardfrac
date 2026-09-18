#!/usr/bin/env python3
"""
PathBinder — batch-ingest every missing set in one run
======================================================
Reads ingest_manifest.json (one entry per TCGplayer group) and drives the
existing per-set tools for ALL of them, in order:

    plan     resolve each group id against tcgcsv.com, verify the category
             by name, and probe the catalog so sets already present are
             skipped (singles and sealed are checked independently)
    singles  import_tcgcsv_set.py --group … --set-code … --set-name …
    sealed   import_tcgcsv_set.py --sealed   (same group; boxes / packs / ETBs)
    mirror   mirror_tcgplayer_images.py (singles) + mirror_sealed_from_tcgplayer.py
             --replace-hosted (sealed): copy the TCGplayer CDN images the
             importer hotlinks into the card-images bucket and rewrite image_url
    embed    embed_catalog_rows.py --id-prefix <prefix>-<set_code>-   (scanner CLIP)
    enrich   sync_pc_singles_enrich.py --tcg <game>  +  sync_sealed_products.py --tcg <game>
             once per affected game (whole-game PriceCharting passes)
    fixes    set_name backfills listed in the manifest (REST PATCH)
    verify   re-count every set after a commit and print the scoreboard

SAFETY
------
  * DRY-RUN BY DEFAULT. Nothing is written without --commit.
    In dry-run the import previews really run (cheap: one tcgcsv fetch per
    set, nothing written); embed / enrich only print the commands they
    would run, because those are long whole-game passes.
  * --set-name is ALWAYS passed to the importer. Omitting it is how the JP
    M5 / M6 rows ended up named "M5" / "M6".
  * A set whose set_code already exists under a DIFFERENT set_name is
    treated as a collision and skipped (use --force to override).
  * Every subprocess is logged verbatim to ingest_logs/<timestamp>.log and a
    JSON summary is written next to it.

USAGE
-----
    python3 ingest_missing_sets.py                       # plan + preview every enabled set
    python3 ingest_missing_sets.py --commit              # write everything (all stages)
    python3 ingest_missing_sets.py --plan                # resolve + probe only, no subprocesses
    python3 ingest_missing_sets.py --only MAMO,ST-31     # subset (manifest key or set_code)
    python3 ingest_missing_sets.py --commit --stages singles,sealed,fixes
    python3 ingest_missing_sets.py --commit --skip enrich
    python3 ingest_missing_sets.py --include-disabled --only ST11   # run a disabled entry

ENVIRONMENT
-----------
    SUPABASE_URL           (falls back to the value in supabase.js)
    SUPABASE_SERVICE_KEY   required for --commit and for embed/enrich.
                           Dry-runs / --plan work with the public key from
                           supabase.js (read-only), so you can preview
                           without any secrets in the shell.
    embed stage needs torch + transformers + Pillow installed locally.
"""

import os
import re
import sys
import json
import time
import argparse
import subprocess
import urllib.parse
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    sys.exit("Missing 'requests'. Run: pip3 install requests --break-system-packages")

HERE = os.path.dirname(os.path.abspath(__file__))
TCGCSV_BASE = "https://tcgcsv.com"
USER_AGENT = "PathBinderSync/1.0 (+https://pathbinder.gg)"
REQ_SLEEP = 0.15  # be polite to tcgcsv

# Mirrors GAME_PREFIX in import_tcgcsv_set.py. Not imported from there because
# that module pulls in sync_tcgcsv, which sys.exit()s at import time when the
# service key is absent — and --plan must work without it.
GAME_PREFIX = {
    "pokemon": "en", "magic": "mtg", "yugioh": "ygo", "onepiece": "op",
    "digimon": "dgm", "lorcana": "lor", "fab": "fab", "unionarena": "ua",
    "dbfusion": "dbf", "dbsccg": "dbs", "dbz": "dbz", "gundam": "gun",
    "grandarchive": "ga", "metazoo": "mz", "starwars": "sw", "sorcery": "sor",
}

ALL_STAGES = ["singles", "sealed", "mirror", "embed", "enrich", "fixes"]

# game_type -> --game value for mirror_sealed_from_tcgplayer.py. Japanese
# Pokemon is a separate TCGplayer category there ('pokemon_japan').
SEALED_MIRROR_GAME = {
    "pokemon": "pokemon", "magic": "magic", "yugioh": "yugioh", "onepiece": "onepiece",
    "lorcana": "lorcana", "gundam": "gundam", "dbfusion": "dbfusion",
}


# ── small helpers ───────────────────────────────────────────────────────────
def log_line(msg, logf=None):
    print(msg, flush=True)
    if logf:
        logf.write(msg + "\n")
        logf.flush()


def norm(s):
    s = (s or "").lower()
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip()


def q(v):
    """URL-encode a PostgREST filter value; keep '*' (wildcard) intact."""
    return urllib.parse.quote(str(v), safe="*")


def parse_supabase_js():
    """Pull SUPABASE_URL / SUPABASE_ANON_KEY out of supabase.js (public values)."""
    out = {}
    try:
        src = open(os.path.join(HERE, "supabase.js"), encoding="utf-8").read()
    except OSError:
        return out
    for name in ("SUPABASE_URL", "SUPABASE_ANON_KEY"):
        m = re.search(rf"const\s+{name}\s*=\s*['\"]([^'\"]+)['\"]", src)
        if m:
            out[name] = m.group(1)
    return out


# ── HTTP: tcgcsv + Supabase REST ────────────────────────────────────────────
_tcg = requests.Session()
_tcg.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
_last = [0.0]


def tcg_get(path):
    dt = time.time() - _last[0]
    if dt < REQ_SLEEP:
        time.sleep(REQ_SLEEP - dt)
    for attempt in range(4):
        try:
            r = _tcg.get(f"{TCGCSV_BASE}{path}", timeout=60)
            _last[0] = time.time()
            if r.status_code == 429:
                time.sleep(10 * (attempt + 1))
                continue
            r.raise_for_status()
            return r.json()
        except requests.RequestException:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
    return None


class Rest:
    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1/"
        self.s = requests.Session()
        self.s.headers.update({"apikey": key, "Authorization": f"Bearer {key}"})

    def count(self, query):
        r = self.s.get(self.base + "catalog?" + query + "&limit=1",
                       headers={"Prefer": "count=exact"}, timeout=60)
        r.raise_for_status()
        cr = r.headers.get("Content-Range", "*/0")
        return int(cr.rsplit("/", 1)[-1])

    def get(self, query):
        r = self.s.get(self.base + "catalog?" + query, timeout=60)
        r.raise_for_status()
        return r.json()

    def patch(self, query, body):
        r = self.s.patch(self.base + "catalog?" + query, json=body,
                         headers={"Prefer": "return=representation"}, timeout=120)
        if not r.ok:
            raise RuntimeError(f"PATCH failed HTTP {r.status_code}: {r.text[:400]}")
        return r.json()


# ── manifest ────────────────────────────────────────────────────────────────
def load_manifest(path):
    with open(path, encoding="utf-8") as f:
        m = json.load(f)
    for e in m.get("sets", []):
        for k in ("key", "game", "category", "set_code", "set_name"):
            if not e.get(k):
                sys.exit(f"manifest entry missing '{k}': {e}")
        if e["game"] not in GAME_PREFIX:
            sys.exit(f"manifest entry {e['key']}: unknown game '{e['game']}' (add to GAME_PREFIX)")
        if not e.get("group") and not e.get("group_match"):
            sys.exit(f"manifest entry {e['key']}: needs 'group' or 'group_match'")
        e.setdefault("enabled", True)
        e.setdefault("sealed", False)
        e.setdefault("embed", True)
        e["prefix"] = "jp" if (e["game"] == "pokemon" and str(e.get("lang", "")).upper() in ("JA", "JP", "JAPANESE")) else GAME_PREFIX[e["game"]]
        e["id_prefix"] = f"{e['prefix']}-{e['set_code'].lower()}-"
        e["sealed_prefix"] = f"sealed-{e['prefix']}-tcg-"
    return m


def select_entries(m, only, include_disabled):
    wanted = None
    if only:
        wanted = {norm(x) for x in only.split(",") if x.strip()}
    out = []
    for e in m["sets"]:
        if wanted is not None:
            if norm(e["key"]) not in wanted and norm(e["set_code"]) not in wanted:
                continue
        elif not e["enabled"] and not include_disabled:
            continue
        out.append(e)
    if wanted is not None:
        found = {norm(e["key"]) for e in out} | {norm(e["set_code"]) for e in out}
        missing = wanted - found
        if missing:
            sys.exit(f"--only: no manifest entry matches {sorted(missing)}")
    return out


# ── plan stage ──────────────────────────────────────────────────────────────
def resolve_groups(entries, logf):
    cats = {c["categoryId"]: c["name"] for c in tcg_get("/tcgplayer/categories").get("results", [])}
    cache = {}
    for e in entries:
        e["problems"] = []
        cat = int(e["category"])
        cname = cats.get(cat)
        if cname is None:
            e["problems"].append(f"TCGplayer category {cat} not found")
            continue
        if e.get("category_name") and norm(e["category_name"]) != norm(cname):
            e["problems"].append(f"category {cat} is '{cname}', manifest expects '{e['category_name']}'")
            continue
        if cat not in cache:
            cache[cat] = tcg_get(f"/tcgplayer/{cat}/groups").get("results", [])
        groups = cache[cat]
        match = [norm(x) for x in (e.get("group_match") or [])]
        if e.get("group"):
            g = next((g for g in groups if g["groupId"] == int(e["group"])), None)
            if not g:
                e["problems"].append(f"group {e['group']} not in category {cat}")
                continue
            if match and not all(x in norm(g["name"]) for x in match):
                e["problems"].append(f"group {e['group']} is '{g['name']}' — does not match group_match {e['group_match']}")
                continue
        else:
            hits = [g for g in groups if all(x in norm(g["name"]) for x in match)]
            if len(hits) != 1:
                cand = "; ".join(f"{g['groupId']} '{g['name']}'" for g in hits[:6]) or "none"
                e["problems"].append(f"group_match {e['group_match']} hit {len(hits)} groups (need exactly 1): {cand}")
                continue
            g = hits[0]
            e["group"] = g["groupId"]
        e["group_name"] = g["name"]
        e["group_abbr"] = g.get("abbreviation") or ""
        e["published"] = str(g.get("publishedOn") or "")[:10]
    return cats


def preflight(entries, rest, force, logf):
    for e in entries:
        if e["problems"]:
            e["singles_status"] = e["sealed_status"] = "unresolved"
            continue
        game, code = e["game"], e["set_code"]
        n_code = rest.count(f"select=id&game_type=eq.{game}&set_code=eq.{q(code)}&product_type=eq.single")
        n_pref = rest.count(f"select=id&id=ilike.{q(e['id_prefix'])}*")
        names = {(r.get("set_name") or "").strip()
                 for r in rest.get(f"select=set_name&game_type=eq.{game}&set_code=eq.{q(code)}&limit=20")}
        names.discard("")
        n_sealed = rest.count(f"select=id&id=like.{q(e['sealed_prefix'])}*&set_code=eq.{q(code)}")
        e["existing_singles"] = max(n_code, n_pref)
        e["existing_sealed"] = n_sealed
        e["existing_names"] = sorted(names)
        if names and e["set_name"] not in names and not force:
            e["problems"].append(f"set_code '{code}' already exists for {game} as {sorted(names)} (collision)")
            e["singles_status"] = e["sealed_status"] = "collision"
            continue
        if e["existing_singles"] and not force:
            e["singles_status"] = "present"
        else:
            e["singles_status"] = "todo"
        if not e["sealed"]:
            e["sealed_status"] = "off"
        elif n_sealed and not force:
            e["sealed_status"] = "present"
        else:
            e["sealed_status"] = "todo"


def print_plan(entries, logf):
    log_line("", logf)
    log_line(f"{'key':<9} {'game':<9} {'group':>6}  {'code':<8} {'singles':<13} {'sealed':<12} group name", logf)
    log_line("-" * 110, logf)
    for e in entries:
        s = e["singles_status"]
        if s == "present":
            s = f"present({e['existing_singles']})"
        d = e["sealed_status"]
        if d == "present":
            d = f"present({e['existing_sealed']})"
        gname = e.get("group_name") or "?"
        pub = e.get("published") or e.get("released") or ""
        log_line(f"{e['key']:<9} {e['game']:<9} {str(e.get('group') or '?'):>6}  {e['set_code']:<8} {s:<13} {d:<12} {gname}  [{pub}]", logf)
        for p in e["problems"]:
            log_line(f"{'':<9} ! {p}", logf)
    log_line("", logf)


# ── subprocess runner ───────────────────────────────────────────────────────
def run(cmd, env, logf, timeout):
    log_line(f"$ {' '.join(cmd)}", logf)
    out_lines = []
    try:
        p = subprocess.Popen(cmd, cwd=HERE, env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, bufsize=1)
    except OSError as ex:
        log_line(f"  !! could not start: {ex}", logf)
        return 127, ""
    start = time.time()
    try:
        for line in p.stdout:
            line = line.rstrip("\n")
            out_lines.append(line)
            log_line("  | " + line, logf)
            if timeout and time.time() - start > timeout:
                p.kill()
                log_line(f"  !! killed after {timeout}s", logf)
                break
        rc = p.wait()
    except KeyboardInterrupt:
        p.kill()
        raise
    return rc, "\n".join(out_lines)


def import_cmd(py, e, commit, sealed=False):
    cmd = [py, "import_tcgcsv_set.py", "--group", str(e["group"]), "--set-code", e["set_code"],
           "--set-name", e["set_name"], "--game", e["game"], "--category", str(e["category"])]
    if e["prefix"] == "jp":
        cmd += ["--lang", "JA"]
    if sealed:
        cmd.append("--sealed")
    if commit:
        cmd.append("--commit")
    return cmd


RE_READY = re.compile(r"(\d+) card rows ready")
RE_WROTE = re.compile(r"Wrote (\d+) catalog rows")
RE_EMPTY = re.compile(r"No products returned for group")


def classify(rc, out, commit):
    """Map an importer run to a status. A group that exists but has no
    products yet (pre-release sets, JP groups that lag) is 'no-products' —
    reported as retry-later, not counted as a failure."""
    if rc != 0 and RE_EMPTY.search(out):
        return "no-products"
    if rc != 0:
        return "FAILED"
    return "written" if commit else "previewed"


# ── main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Batch-ingest every missing set listed in the manifest.")
    ap.add_argument("--manifest", default=os.path.join(HERE, "ingest_manifest.json"))
    ap.add_argument("--commit", action="store_true", help="actually write (default: dry-run)")
    ap.add_argument("--plan", action="store_true", help="resolve groups + probe catalog only; no subprocesses")
    ap.add_argument("--only", help="comma-separated manifest keys or set_codes to process")
    ap.add_argument("--stages", default=",".join(ALL_STAGES), help=f"comma list from {ALL_STAGES}")
    ap.add_argument("--skip", default="", help="comma list of stages to skip")
    ap.add_argument("--include-disabled", action="store_true", help="also process entries with enabled=false")
    ap.add_argument("--force", action="store_true", help="import even if the set already has rows / collides")
    ap.add_argument("--enrich-games", default="", help="restrict the enrich stage to these game_types")
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--log-dir", default=os.path.join(HERE, "ingest_logs"))
    ap.add_argument("--timeout", type=int, default=3600, help="per-subprocess timeout in seconds")
    args = ap.parse_args()

    stages = [s.strip() for s in args.stages.split(",") if s.strip()]
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}
    bad = [s for s in stages if s not in ALL_STAGES] + [s for s in skip if s not in ALL_STAGES]
    if bad:
        sys.exit(f"unknown stage(s) {bad}; valid: {ALL_STAGES}")
    stages = [s for s in stages if s not in skip]

    # Environment.
    pub = parse_supabase_js()
    url = os.environ.get("SUPABASE_URL") or pub.get("SUPABASE_URL")
    svc = os.environ.get("SUPABASE_SERVICE_KEY")
    anon = os.environ.get("SUPABASE_ANON_KEY") or pub.get("SUPABASE_ANON_KEY")
    if not url:
        sys.exit("SUPABASE_URL not set and not found in supabase.js")
    if args.commit and not svc:
        sys.exit("--commit needs SUPABASE_SERVICE_KEY in the environment.")
    read_key = svc or anon
    if not read_key:
        sys.exit("Need SUPABASE_SERVICE_KEY (or SUPABASE_ANON_KEY / supabase.js) for catalog probes.")

    os.makedirs(args.log_dir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    log_path = os.path.join(args.log_dir, f"ingest_{stamp}.log")
    logf = open(log_path, "w", encoding="utf-8")

    mode = "COMMIT" if args.commit else ("PLAN" if args.plan else "DRY-RUN")
    log_line(f">>> ingest_missing_sets — {mode} — {datetime.now().isoformat(timespec='seconds')}", logf)
    log_line(f"    manifest: {args.manifest}", logf)
    log_line(f"    log:      {log_path}", logf)
    if not svc:
        log_line("    key:      public read-only key (no SUPABASE_SERVICE_KEY in env)", logf)

    m = load_manifest(args.manifest)
    entries = select_entries(m, args.only, args.include_disabled)
    if not entries:
        sys.exit("No manifest entries selected.")
    log_line(f"    sets:     {len(entries)} selected; stages: {', '.join(stages)}", logf)

    # ── plan ────────────────────────────────────────────────────────────
    log_line("\n=== PLAN: resolving TCGplayer groups + probing the catalog ===", logf)
    rest = Rest(url, read_key)
    resolve_groups(entries, logf)
    preflight(entries, rest, args.force, logf)
    print_plan(entries, logf)

    results = {e["key"]: {"key": e["key"], "set_code": e["set_code"], "game": e["game"],
                          "group": e.get("group"), "singles": e["singles_status"],
                          "sealed": e["sealed_status"], "problems": list(e["problems"])}
               for e in entries}
    fails = 0
    retry_later = []   # groups that exist on TCGplayer but carry no products yet

    if args.plan:
        logf.close()
        unresolved = sum(1 for e in entries if e["problems"])
        print(f"Plan only. {len(entries)} sets, {unresolved} with problems. Log: {log_path}")
        sys.exit(1 if unresolved else 0)

    # Subprocess environment: the importer needs SUPABASE_SERVICE_KEY to even
    # import its module. In dry-run the public key is enough (reads only).
    env = dict(os.environ)
    env["SUPABASE_URL"] = url
    env["SUPABASE_SERVICE_KEY"] = svc or anon
    env["PYTHONUNBUFFERED"] = "1"
    py = args.python

    # ── singles ─────────────────────────────────────────────────────────
    if "singles" in stages:
        log_line("\n=== SINGLES ===", logf)
        for e in entries:
            r = results[e["key"]]
            if e["singles_status"] != "todo":
                log_line(f"-- {e['key']}: singles {e['singles_status']}, skipping", logf)
                continue
            log_line(f"\n-- {e['key']} — {e['set_name']} (group {e['group']})", logf)
            rc, out = run(import_cmd(py, e, args.commit), env, logf, args.timeout)
            ready = RE_READY.search(out)
            wrote = RE_WROTE.search(out)
            r["singles_ready"] = int(ready.group(1)) if ready else None
            r["singles_written"] = int(wrote.group(1)) if wrote else 0
            r["singles"] = classify(rc, out, args.commit)
            if r["singles"] == "FAILED":
                fails += 1
            elif r["singles"] == "no-products":
                retry_later.append(e["key"])

    # ── sealed ──────────────────────────────────────────────────────────
    if "sealed" in stages:
        log_line("\n=== SEALED (tcgcsv products from the same groups) ===", logf)
        for e in entries:
            r = results[e["key"]]
            if e["sealed_status"] != "todo":
                if e["sealed_status"] != "off":
                    log_line(f"-- {e['key']}: sealed {e['sealed_status']}, skipping", logf)
                continue
            log_line(f"\n-- {e['key']} — {e['set_name']} sealed (group {e['group']})", logf)
            rc, out = run(import_cmd(py, e, args.commit, sealed=True), env, logf, args.timeout)
            ready = RE_READY.search(out)
            wrote = RE_WROTE.search(out)
            r["sealed_ready"] = int(ready.group(1)) if ready else None
            r["sealed_written"] = int(wrote.group(1)) if wrote else 0
            r["sealed"] = classify(rc, out, args.commit)
            if r["sealed"] == "FAILED":
                fails += 1
            elif r["sealed"] == "no-products" and e["key"] not in retry_later:
                retry_later.append(e["key"])

    # ── mirror ──────────────────────────────────────────────────────────
    # import_tcgcsv_set.py stores TCGplayer's CDN URL in image_url. Every
    # earlier import was then mirrored into the card-images bucket, so do the
    # same here: singles by set_code (per game), sealed by group with
    # --replace-hosted (our sealed-*-tcg-* rows are CDN-hosted, not
    # PriceCharting-hosted, so the default filter would skip them). Both
    # scripts skip rows already on the bucket, so re-runs are cheap. Runs
    # before embed so the scanner embeds from the hosted copies.
    if "mirror" in stages:
        log_line("\n=== MIRROR (TCGplayer CDN -> card-images bucket) ===", logf)
        targets = [e for e in entries if not e["problems"]
                   and results[e["key"]]["singles"] not in ("no-products", "FAILED")]
        by_game = {}
        for e in targets:
            by_game.setdefault(e["game"], []).append(e)
        for g, es in by_game.items():
            codes = ",".join(e["set_code"] for e in es)
            cmd = [py, "mirror_tcgplayer_images.py", "--set-code", codes, "--game", g]
            if not args.commit:
                cmd.append("--dry-run")
            log_line(f"\n-- {g} singles: {codes}", logf)
            rc, _ = run(cmd, env, logf, args.timeout)
            for e in es:
                results[e["key"]]["mirror_singles"] = "ok" if rc == 0 else "FAILED"
            if rc != 0:
                fails += 1
        # Sealed: one call per (mirror game, group list). Japanese Pokemon
        # groups live in TCGplayer category 85 -> 'pokemon_japan'.
        sealed_groups = {}
        for e in targets:
            if not e["sealed"] or results[e["key"]]["sealed"] in ("no-products", "FAILED", "off"):
                continue
            mg = "pokemon_japan" if e["prefix"] == "jp" else SEALED_MIRROR_GAME.get(e["game"])
            if not mg:
                log_line(f"-- {e['key']}: no sealed-mirror game mapping for {e['game']}, skipping", logf)
                continue
            sealed_groups.setdefault(mg, []).append(str(e["group"]))
        for mg, gids in sealed_groups.items():
            cmd = [py, "mirror_sealed_from_tcgplayer.py", "--game", mg, "--group", ",".join(gids), "--replace-hosted"]
            if not args.commit:
                cmd.append("--dry-run")
            log_line(f"\n-- {mg} sealed: groups {','.join(gids)}", logf)
            rc, _ = run(cmd, env, logf, args.timeout)
            for e in targets:
                if str(e.get("group")) in gids:
                    results[e["key"]]["mirror_sealed"] = "ok" if rc == 0 else "FAILED"
            if rc != 0:
                fails += 1

    # ── embed ───────────────────────────────────────────────────────────
    if "embed" in stages:
        log_line("\n=== EMBED (scanner CLIP embeddings) ===", logf)
        targets = [e for e in entries if e.get("embed") and not e["problems"]
                   and results[e["key"]]["singles"] in ("written", "previewed", "present")]
        if not targets:
            log_line("nothing to embed", logf)
        elif not args.commit:
            for e in targets:
                log_line(f"would run: {py} embed_catalog_rows.py --id-prefix {e['id_prefix']}", logf)
        else:
            probe = subprocess.run([py, "-c", "import torch, transformers, PIL"], capture_output=True, text=True)
            if probe.returncode != 0:
                log_line("!! torch/transformers/Pillow not importable — skipping embed stage. "
                         "Install with: pip3 install torch transformers Pillow supabase --break-system-packages", logf)
                for e in targets:
                    results[e["key"]]["embed"] = "skipped (deps)"
            else:
                for e in targets:
                    log_line(f"\n-- {e['key']} embed {e['id_prefix']}*", logf)
                    rc, _ = run([py, "embed_catalog_rows.py", "--id-prefix", e["id_prefix"]], env, logf, args.timeout)
                    results[e["key"]]["embed"] = "ok" if rc == 0 else "FAILED"
                    if rc != 0:
                        fails += 1

    # ── enrich ──────────────────────────────────────────────────────────
    if "enrich" in stages:
        log_line("\n=== ENRICH (PriceCharting singles + sealed, per game) ===", logf)
        cfg = m.get("enrich", {})
        games = []
        for e in entries:
            if not e["problems"] and e["game"] not in games:
                games.append(e["game"])
        if args.enrich_games:
            allow = {g.strip() for g in args.enrich_games.split(",")}
            games = [g for g in games if g in allow]
        for g in games:
            c = cfg.get(g)
            if not c:
                log_line(f"-- {g}: no enrich config in manifest, skipping", logf)
                continue
            cmds = []
            if c.get("pc_singles"):
                cmds.append([py, "sync_pc_singles_enrich.py", "--tcg", c["pc_singles"]])
            else:
                log_line(f"-- {g}: no sync_pc_singles_enrich config for this game (prices come from the TCGplayer spine)", logf)
            if c.get("sealed"):
                cmds.append([py, "sync_sealed_products.py", "--tcg", c["sealed"]])
            for cmd in cmds:
                if not args.commit:
                    log_line(f"would run: {' '.join(cmd)}", logf)
                    continue
                rc, _ = run(cmd, env, logf, args.timeout)
                if rc != 0:
                    fails += 1
                    log_line(f"  !! {cmd[1]} --tcg {cmd[3]} exited {rc}", logf)

    # ── fixes ───────────────────────────────────────────────────────────
    fix_results = []
    if "fixes" in stages and m.get("fixes"):
        log_line("\n=== FIXES ===", logf)
        for f in m["fixes"]:
            if f.get("type") != "set_name_backfill":
                log_line(f"-- unknown fix type {f.get('type')}, skipping", logf)
                continue
            query = f"game_type=eq.{f['game']}&set_code=eq.{q(f['set_code'])}&set_name=eq.{q(f['from'])}"
            n = rest.count("select=id&" + query)
            exp = f.get("expect")
            note = f" (manifest expects {exp})" if exp is not None and exp != n else ""
            if n == 0:
                log_line(f"-- {f['set_code']}: 0 rows still named '{f['from']}' — already fixed", logf)
                fix_results.append({"set_code": f["set_code"], "matched": 0, "updated": 0})
                continue
            if not args.commit:
                log_line(f"-- {f['set_code']}: would rename {n} rows '{f['from']}' -> '{f['to']}'{note}", logf)
                fix_results.append({"set_code": f["set_code"], "matched": n, "updated": 0})
                continue
            rows = rest.patch(query + "&select=id", {"set_name": f["to"]})
            log_line(f"-- {f['set_code']}: renamed {len(rows)} rows '{f['from']}' -> '{f['to']}'{note}", logf)
            fix_results.append({"set_code": f["set_code"], "matched": n, "updated": len(rows)})

    # ── verify ──────────────────────────────────────────────────────────
    if args.commit:
        log_line("\n=== VERIFY (live counts after commit) ===", logf)
        log_line(f"{'key':<9} {'code':<8} {'singles':>8} {'sealed':>7}  status", logf)
        for e in entries:
            r = results[e["key"]]
            if e["problems"]:
                log_line(f"{e['key']:<9} {e['set_code']:<8} {'-':>8} {'-':>7}  unresolved", logf)
                continue
            n_s = rest.count(f"select=id&id=ilike.{q(e['id_prefix'])}*&product_type=eq.single")
            n_d = rest.count(f"select=id&id=like.{q(e['sealed_prefix'])}*&set_code=eq.{q(e['set_code'])}")
            r["verify_singles"], r["verify_sealed"] = n_s, n_d
            flag = ""
            if r["singles"] == "written" and r.get("singles_ready") and n_s < r["singles_ready"]:
                flag = f"  !! expected >= {r['singles_ready']} singles"
            if r["singles"] == "written" and n_s == 0:
                flag = "  !! 0 singles after commit"
            log_line(f"{e['key']:<9} {e['set_code']:<8} {n_s:>8} {n_d:>7}  singles={r['singles']} sealed={r['sealed']}{flag}", logf)
            if flag:
                fails += 1

    # ── summary ─────────────────────────────────────────────────────────
    summary = {"mode": mode, "started": stamp, "manifest": args.manifest, "stages": stages,
               "sets": list(results.values()), "fixes": fix_results, "failures": fails}
    with open(os.path.join(args.log_dir, f"ingest_{stamp}.json"), "w", encoding="utf-8") as jf:
        json.dump(summary, jf, indent=2)

    log_line("\n=== SUMMARY ===", logf)
    for r in results.values():
        extra = ""
        if r.get("singles_ready") is not None:
            extra += f" singles_rows={r['singles_ready']}"
        if r.get("sealed_ready") is not None:
            extra += f" sealed_rows={r['sealed_ready']}"
        if r.get("mirror_singles") or r.get("mirror_sealed"):
            extra += f" mirror={r.get('mirror_singles', '-')}/{r.get('mirror_sealed', '-')}"
        if r.get("embed"):
            extra += f" embed={r['embed']}"
        log_line(f"  {r['key']:<9} singles={r['singles']:<10} sealed={r['sealed']:<10}{extra}", logf)
    for fr in fix_results:
        log_line(f"  fix {fr['set_code']:<6} matched={fr['matched']} updated={fr['updated']}", logf)
    if retry_later:
        log_line(f"\nRETRY LATER — TCGplayer group exists but has no products yet: {', '.join(retry_later)}. "
                 f"Re-run with --only {','.join(retry_later)} once the set is live.", logf)
    if not args.commit:
        log_line("\nDRY RUN — nothing written. Re-run with --commit to write.", logf)
    log_line(f"{fails} failure(s). Log: {log_path}", logf)
    logf.close()
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
