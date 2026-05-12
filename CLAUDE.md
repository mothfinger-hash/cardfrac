# PathBinder — Notes for Claude

Conventions and preferences for any AI assistant working on this codebase.
Read this before adding new UI, modules, or migrations.

## UI / Visual Style

### No emojis. Plain text labels only.

Do not add emojis to new UI — not flag emojis (🇺🇸 🇯🇵 etc.), not faces,
not objects, not anchors, not any pictographic character. Tabs, buttons,
toasts, modals, badges, status pills, console SQL banners, etc. all use
plain text.

Bad:
- `'🇺🇸 ENGLISH'`
- `'🎴 Cards'`
- `'⚓ ONE PIECE'`

Good:
- `'ENGLISH'`
- `'Cards'`
- `'ONE PIECE'`

### Existing decorative glyphs are intentional, not a license

The codebase uses a small palette of geometric Unicode shapes as part of
its hologram / cyberpunk aesthetic — `⬡` for menu items, `◈` for hologram
section headers, `◇`/`◆` for inline decoration, `⚠` for danger zones,
`✓` for success states. These are deliberate design choices made by the
project owner, not stylistic noise.

When in doubt, use plain text. Match the existing aesthetic only when
the surrounding UI clearly establishes the pattern (e.g., adding a new
admin section that sits next to "◈ Card Editor" can also use `◈`).
Never introduce new pictographic glyphs from outside that small palette.

### Color palette

PathBinder uses a cyan + copper hologram theme. Key CSS variables:
- `--accent` — cyan, primary actions and active state
- `--copper` — copper, hologram callouts and admin headers
- `--copper-dim` / `--copper-glow` — supporting tones
- `--surface` / `--surface2` — dark panels
- `--text` / `--muted` — body / dim text
- `--red` / `--green` / `--gold` / `--yellow` — semantic accents

Use these variables, not hex literals.

### Fonts

- `'Orbitron', monospace` — display headers (panel titles, hologram callouts)
- `'Space Mono', 'Share Tech Mono', monospace` — body, buttons, data rows
- Avoid sans-serif system stacks — they break the aesthetic

## Editing index.html

`index.html` is the single-file app, ~24K lines. Some practical rules:

### Always `node --check` syntax-sensitive edits

A single bad escape (`'they\\'ll'` inside a single-quoted JS string) can
nuke the entire 900KB inline script block and produce a totally black
page on both mobile and desktop. After any non-trivial JS edit, extract
the script blocks and pass each through `node --check` before declaring
done. Example pipeline at the bottom of this file.

### Avoid apostrophes / quotes inside single-quoted JS strings

Either use double quotes, template literals, or rephrase. Backslash
escapes inside string concatenation are easy to get wrong.

### Bump the service worker cache on UI changes

`sw.js` has a `CACHE = 'pathbinder-vXX'` constant. Increment it any time
HTML/JS/CSS visibly changes, otherwise users won't see the update.

### Don't N+1 the marketplace render

The browse view renders many cards. Lookups for cross-cutting data
(beta tester status, vendor flags, etc.) should be backed by a JS-side
cache loaded once at app startup — not a query per row.

## Schema / Supabase

- `profiles` is the canonical user table. Tier resolution goes through
  `subscription_tier` (text: `free` / `collector` / `vendor` / `shop`)
  with legacy boolean fallback (`is_premium`, `is_vendor`, `is_admin`).
- `catalog` is the canonical card table. Multi-TCG: id is prefixed by
  language/game (`en-`, `jp-`, `pd-` for Pokemon; `mtg-`, `ygo-`, `op-`
  for other TCGs). `game_type` column for explicit filtering.
- `collection_items` is per-user owned cards. `api_card_id` references
  the catalog id. `game_type` should match the catalog row's game.
- Migrations are printed to the browser console by admin "Print SQL"
  buttons — copy-paste pattern, not auto-run. Keep migrations idempotent
  (`create if not exists`, `create or replace`, `drop policy if exists`).
- Beta testers have their own table `beta_testers` with a public-read
  view `public_beta_testers` that exposes only `(user_id, tier)`.

## Background workers / sync scripts

- `pokedata_sync.py` is the consolidated multi-TCG sync. Use
  `--tcg <name>` to scope per game. Without it, the mirror would race
  across all games on the same row set.
- `cleanup_png_storage.py` is the destructive cleanup tool. Always
  `--dry-run` first.
- Image mirrors should be Ctrl-C-safe — the script filters by
  `image_url like '%pokedata.io%'` so already-mirrored rows are skipped
  on restart.

## Syntax check pipeline

After non-trivial JS edits to `index.html`:

```bash
cd /Users/charleshewitt/Desktop/cardfrac
python3 -c "
import re, subprocess
with open('index.html') as f:
    html = f.read()
scripts = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.DOTALL)
for i, s in enumerate(scripts):
    if not s.strip(): continue
    with open(f'/tmp/check_{i}.js', 'w') as f:
        f.write(s)
    r = subprocess.run(['node', '--check', f'/tmp/check_{i}.js'], capture_output=True, text=True)
    print(f'Block {i}: {\"OK\" if r.returncode == 0 else \"FAIL: \" + r.stderr[:500]}')
"
```

Every block must report OK.
