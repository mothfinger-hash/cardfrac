#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────
# Refuse a commit that changes an app-code bundle without bumping the
# service worker's CACHE constant.
#
# Why this exists: sw.js serves pb-*.js|css CACHE-FIRST with no
# revalidation (see the generic static-asset handler at the bottom of its
# fetch listener). Without a CACHE bump, `git push` deploys the file to the
# website and every existing user keeps executing the OLD bytes forever.
# There is no error, no console warning, nothing to notice.
#
# This is not hypothetical. Between 2026-06-30 (v633) and 2026-07-16, 36
# commits changed pb-app.js with no bump — multi-add, push notifications,
# wishlist, price spike alerts, movers, marketplace fixes. Sixteen days of
# work reached the website and stopped at the cache. Every beta tester was
# running the June 30 build and nobody could tell.
#
# index.html is exempt: navigations are network-only, so HTML lands without
# a bump. That is precisely why the shell looked fresh while the app was
# frozen.
#
# Install:  git config core.hooksPath .githooks
# Bypass:   git commit --no-verify   (only when you truly mean it)
# ─────────────────────────────────────────────────────────────────────────

BUNDLES='^(pb-app\.js|pb-styles\.css|pb-critical\.css|pb-scanner\.js|pb-avatar\.js|pb-photo\.js|pb-store\.js)$'

staged=$(git diff --cached --name-only --diff-filter=ACM)
touched=$(printf '%s\n' "$staged" | grep -E "$BUNDLES")

# No app-code bundle staged → nothing to enforce.
[ -z "$touched" ] && exit 0

fail() {
  cur=$(git show HEAD:sw.js 2>/dev/null | sed -n 's/^const CACHE = .pathbinder-v\([0-9]*\).;/\1/p')
  next=$((cur + 1))
  echo ""
  echo "  ✗ Service worker CACHE not bumped."
  echo ""
  echo "    Staged app-code bundle(s):"
  printf '%s\n' "$touched" | sed 's/^/      /'
  echo ""
  echo "    $1"
  echo ""
  echo "    These files are served CACHE-FIRST with no revalidation. Without a"
  echo "    bump this deploys to the website but existing users keep running the"
  echo "    old bytes indefinitely — silently, with no error."
  echo ""
  echo "    Fix:"
  echo "      sed -i '' \"s/pathbinder-v${cur}/pathbinder-v${next}/\" sw.js && git add sw.js"
  echo ""
  echo "    Or, if you really mean it:  git commit --no-verify"
  echo ""
  exit 1
}

printf '%s\n' "$staged" | grep -qx 'sw.js' || fail "sw.js is not staged."

# sw.js is staged — but did CACHE actually change? Staging sw.js for an
# unrelated edit must not satisfy the check.
old_cache=$(git show HEAD:sw.js 2>/dev/null | grep -m1 '^const CACHE')
new_cache=$(git show :sw.js  2>/dev/null | grep -m1 '^const CACHE')

[ -n "$new_cache" ] || fail "Could not read CACHE from the staged sw.js."
[ "$old_cache" != "$new_cache" ] || fail "sw.js is staged, but CACHE is unchanged (${new_cache})."

exit 0
