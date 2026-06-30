# PathBinder — Design Notes

Distilled from the `ui-ux-pro-max` skill's stack-agnostic UX data (99 UX
guidelines + style/reasoning tables), filtered for what PathBinder actually is:
a **dark, data-heavy collection + marketplace PWA** that's also wrapped native,
on a **cyberpunk cyan + copper hologram** theme. The skill's React/Tailwind/
shadcn codegen and "light mode by default" advice is intentionally ignored —
PathBinder's dark aesthetic is a deliberate brand choice, not a smell.

## Aesthetic vocabulary that fits us

Use these names so design decisions stay consistent. PathBinder sits squarely
in the skill's **Cyberpunk UI / HUD-Sci-Fi-FUI / Terminal CLI** family:

- **Cyberpunk UI / Cyberpunk Mobile HUD** — neon glow, dark base, monospace.
- **HUD / Sci-Fi FUI** — the hologram panels, corner brackets, scanlines.
- **Terminal CLI (Mobile)** — the Space Mono / Share Tech Mono data rows.
- **Chromatic Aberration / RGB Split** — sparingly, for the holo-project glow.

The skill flags these effects as the right call for "Creative Agency /
Storytelling" products — which is exactly our brand register, so the theme is
on-target, not over-designed.

## Already nailed (don't regress these)

These guidelines are HIGH severity and PathBinder already handles them — keep
them when touching the relevant code:

- **`dvh` over `100vh` on mobile** — already converted.
- **Fixed-nav safe-area / overscroll** — fixed (bottom nav + `overscroll-behavior: contain`).
- **Reserve space for async content (CLS)** — hero min-widths, skeleton overlay; the `aspect-ratio` on `.card-thumb` is still bookmarked.
- **Loading feedback > 300ms** — auth skeleton + toasts.
- **WebP images** — card art + the new card-backs.
- **Toast auto-dismiss (3–5s)** — in place.
- **Transform/opacity for animation, not layout props** — holo animations use `transform`.

## Worth auditing — concrete gaps for our theme

Cyberpunk dark themes tend to miss these *specifically*, and they're the
highest-value fixes (several are also App/Play Store review items):

1. **`prefers-reduced-motion` (HIGH).** We run continuous `holo-flicker`,
   `holo-project`, and scanline animations. The guideline (and platform
   accessibility review) says heavy/continuous motion must be gated behind
   `@media (prefers-reduced-motion: reduce)`. Right now it almost certainly
   isn't. **Top priority** — both accessibility and store-safety.
2. **Visible focus states (HIGH).** Neon/dark themes love `outline: none`.
   Keyboard users need a visible focus ring on every interactive element
   (`:focus-visible` with a cyan ring fits the theme). Audit custom buttons/chips.
3. **ARIA labels on icon-only controls (HIGH).** The SVG nav row (Add / Sets /
   Market / Trade / Account) and icon buttons need `aria-label`s for screen readers.
4. **Don't signal with color alone (HIGH).** Money up/down and status dots lean
   on green/red. Pair them with an arrow/sign/word (we do in some spots — make
   it consistent) so colorblind users aren't lost.
5. **Muted-text contrast (HIGH).** `--muted` on the dark base is the classic
   cyberpunk readability trap. Check it clears 4.5:1 against `--surface`; bump
   it if not. Body text min 16px on mobile.
6. **Empty states (MEDIUM).** Collection / marketplace / search "nothing here"
   views should show a helpful line + an action, not a blank panel.
7. **Touch targets 44×44 + 8px spacing (HIGH/MED).** Audit the smaller chips
   (variant pickers, filter pills) on mobile.

## Ignore from the skill

- shadcn / Tailwind / Next.js / React codegen scripts — PathBinder is a vanilla
  single-file HTML/JS app; none of it applies.
- "Dark mode by default is an anti-pattern" — that's SaaS advice. Our dark
  cyberpunk base is the brand.
- The Gemini image-generation features — you don't use Gemini.

## Suggested order if we act on this

1. `prefers-reduced-motion` gate (fast, high-value, store-relevant).
2. `:focus-visible` rings + `aria-label`s on icon controls (accessibility pass).
3. Muted-text contrast check + bump.
4. Empty-state polish where it's blank today.
