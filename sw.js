// PathBinder Service Worker
// v376 — Sets modal: stop double-rendering the empty-state message:
//  v371-v374 left a race in the Pokemon Sets card-detail modal. The
//  "MARKET PRICES" block (which sources prices from pokemontcg.io's
//  tcgplayer.prices field on the card response) renders
//  synchronously. When pokemontcg.io had no prices for the card,
//  that block fell back to a centered "No price data available" line.
//  Separately, _renderSetsModalExtrasPlaceholder injects a div that
//  asynchronously loads PriceCharting + TCGplayer prices from our
//  own catalog + card_prices tables and renders them. For older or
//  promo cards (Charizard V SWSH260, most JP cards, etc.)
//  pokemontcg.io has no price data but our extras DO have it — so
//  the user saw "No price data available" stacked above the
//  PriceCharting price row, looking broken.
//  Fix: priceHtml's empty branch is now '' in both modal entry
//  points (search-results modal at ~23553 + binder/sets modal at
//  ~31970). _renderSetsModalExtrasPlaceholder now accepts a
//  `hadPokemontcgPrices` flag and renders its own "No price data
//  available" line only when both sources came up empty.
// v375 — Sets modal tiebreaker: prefer en- prefix over legacy prefix:
//  v374's merge logic scored catalog rows by "has explicit
//  price_source_url first, then alphabetical." That picked the wrong
//  row in cases where the legacy bare-prefix row (`swshp-SWSH260`)
//  had a price_source_url set from an older sync run while the newer
//  `en-swsd-SWSH260` row was using pricecharting_id only — Charizard
//  V SWSH260 kept showing $85.88 (stale) instead of $45.50 (fresh).
//  Verified via post-dedup query: catalog correctly held both rows
//  because they have different pricecharting_ids (3449523 vs
//  4246445). True duplicates were cleaned up (4633 rows deleted);
//  these false-duplicate pairs remain by design.
//  Fix: inverted the primary tiebreaker inside
//  _loadSetsModalExtraPrices. New sort order:
//    1) `en-` prefix wins (newer pokedata convention, active sync)
//    2) row with price_source_url wins (most-recent sync write)
//    3) alphabetical by id (stability)
//  Binder card detail (_loadExtraPricesByCatalogId) is unaffected —
//  it queries by a single catalog_id stored on the collection_items
//  row, so there's no merge step there.
// v374 — Sets modal handles duplicate catalog rows gracefully:
//  Diagnosed via console SQL: catalog often has TWO rows for the
//  same Pokemon EN card — `en-<set>-<num>` from the pokedata sync
//  and bare `<set>-<num>` from the pokemontcg.io sync. They can
//  carry different pricecharting_ids and different staleness.
//  Symptom: Sets modal hits the bare-id row (since pokemontcg.io
//  returns ids in that format) which had a stale $85.88 PC price,
//  while the parallel `en-` row had a fresh $46.94.
//  Fix: _loadSetsModalExtraPrices now fetches ALL candidate rows
//  in one query, then picks the freshest source per data source.
//  PriceCharting prefers the catalog row with an explicit
//  price_source_url (last written by an active sync run) over one
//  that only has pricecharting_id (synthesized URL = older row).
//  TCGplayer takes the freshest card_prices.recorded_at across
//  the candidate set. Final fix is a one-time SQL dedup of the
//  catalog (see today's chat for the GROUP BY ... HAVING COUNT > 1
//  query), but the helper now papers over existing dupes so the
//  app shows good data even before that cleanup lands.
// v373 — Binder card detail now matches the Sets modal:
//  v371's binder price-comps panel rendered as small grid cards;
//  v372 added a row-based prices list + TCGplayer/PriceCharting
//  buttons to the Sets modal. The two looked inconsistent.
//  Extracted a shared _buildExtrasHtml + _loadExtraPricesByCatalogId
//  pair, plus a thin _renderBinderExtrasPlaceholder wrapper for the
//  binder path. Binder detail now shows the same "PriceCharting:
//  $X / TCGplayer: $Y" rows + two-button (TCGPLAYER / PRICECHARTING)
//  row as the Sets modal. Single source of truth for both modals'
//  external-link presentation.
// v372 — Sets card detail: TCGplayer + PriceCharting buttons, extra prices:
//  The Sets-page card detail modal only rendered prices from
//  pokemontcg.io's live card response. For brand-new EN sets (Perfect
//  Order, May 2026) and all JP cards, pokemontcg.io has the metadata
//  but no tcgplayer.prices, so users saw "No price data available"
//  even though catalog.current_value (PriceCharting) and card_prices
//  (TCGplayer from our daily sync) both had data for many of those
//  rows.
//  New _loadSetsModalExtraPrices helper joins catalog + card_prices
//  by candidate id (en-X for EN, jp-X / pd-X for JP). Falls back to
//  the bare id for legacy catalog rows that pre-date the prefix
//  convention. Result merges into the modal as a secondary price
//  block below pokemontcg.io's results.
//  Single text "VIEW ON TCGPLAYER" link replaced with a two-button
//  row: TCGPLAYER (accent green) and PRICECHARTING (copper). Button
//  URLs prefer card_prices.source_url, then pokemontcg.io's
//  tcgplayer.url, then a TCGplayer name search as ultimate fallback.
//  Both Sets modal variants (search-by-name and set-card-list) wired
//  through the same _renderSetsModalExtrasPlaceholder helper.
// v371 — Multi-source price comps (TCGplayer secondary):
//  New card_prices table keyed by (catalog_id, source) lets us store
//  prices from multiple sources without schema churn. v1 sources:
//  'pricecharting' (mirrors catalog.current_value, written by the
//  daily CSV refresh) and 'tcgplayer' (written by the new
//  sync_tcgplayer_via_free_apis.py script which pulls from
//  pokemontcg.io / Scryfall / YGOPRODeck — all of which already
//  expose TCGplayer market price in their card response).
//  No scraping. Free APIs. Three of six TCGs covered immediately;
//  OP/Gundam/DBZ/Topps wait for TCGplayer Partner API approval.
//
//  Binder card detail modal now shows a "PRICE COMPS" panel below
//  the stats 2x2 grid with side-by-side cards for each source that
//  has data. Async-loads via _loadCardPrices (per-session in-memory
//  cache), synthesizes a pricecharting row from catalog.current_value
//  when card_prices hasn't yet been populated, hides the whole panel
//  when neither source has anything.
// v370 — Scanner tuned for the multi-TCG catalog:
//  The match_cards embedding RPC searched the entire catalog (250K+
//  rows across 6 TCGs × 5 Pokemon languages) without TCG or language
//  filters. After the catalog grew, mediocre matches from the wrong
//  TCG / language floated to the top — Pokemon scans surfaced Magic
//  cards as candidates, JP Pokemon scans returned EN, etc.
//  Two-tier fix:
//    1. New match_cards_v2 RPC (migration_match_cards_v2.sql) adds
//       optional p_game_type and p_id_prefixes filters. The vector
//       search is restricted to the relevant slice before scoring.
//    2. Frontend passes the detected TCG + an OCR-language-derived
//       prefix list (en- / jp-+pd- / cn- / kr-) so the embedding
//       search only considers candidates that could plausibly be
//       the right card. JA/ZH/KO OCR locks game_type to 'pokemon'
//       (only Pokemon has multi-language catalog coverage).
//    3. Threshold raised from 0.0 → 0.18, match_count dropped from
//       15 → 10. Trims the noise floor that the unfiltered v1 had
//       to tolerate.
//  Falls back to v1 match_cards (with the old loose settings) if
//  the migration hasn't been applied yet, with a console warn
//  pointing at the migration file.
// v369 — White body bg on mobile Account tabs:
//  The mobile @media block stripping the desktop landscape-art
//  backgrounds for Dashboard / My Listings / Orders / Sales Archive /
//  Watchlist / History / Trade History tabs was setting
//  `background-color: transparent`. With nothing painting the
//  html element either, `transparent` exposed the browser's
//  default white background. Switched to `background-color:
//  var(--bg)` so we explicitly fall back to the app's dark
//  surface color. Also added the missing `body[data-page-bg=
//  "payments"]` selector to the mobile rule so the Payments tab
//  matches the rest.
// v368 — Magic / YGO / OP / etc. Sets tabs now fast:
//  Non-Pokemon TCG paths in loadTcgSetsPage paginated the catalog
//  client-side in 1000-row chunks and did the GROUP BY in JS. Magic
//  took 14s, YGO 7s on cold visit. Two-tier fix:
//    1. New catalog_sets_summary_v2 RPC does the whole aggregation
//       server-side (one query, returns set_code, set_name, total,
//       has_singles, has_sealed, max_created_at). With the indexes
//       from migration_catalog_perf_indexes.sql, ~50ms instead of 14s.
//       Frontend tries the RPC first; falls back to the old pagination
//       loop if the migration hasn't been run, with a console warn
//       pointing at the migration file.
//    2. Per-TCG localStorage cache (pathbinder_tcg_sets_<gameKey>_v2)
//       with 24h TTL + background stale-while-revalidate. Once the
//       cache is warm, subsequent visits render instantly even if
//       the network is down. Re-renders only when the set count
//       changed so we don't flash the page on the common case.
// v367 — Subsidiary claimers also get the Discord prompt:
//  maybeShowBetaWelcome() only checked beta_testers rows, so friends
//  redeeming a subsidiary code skipped the Discord modal entirely.
//  Added maybeShowSubsidiaryWelcome() that queries subsidiary_invites
//  for a claimed_by row by the current user and fires the same Discord
//  modal with friend-invite variant copy ("Friend invite redeemed —
//  X tier for N months. Discord is where the testers share what
//  they're building. Worth a peek.").
//  showBetaDiscordPrompt(tier, opts) gained an opts.fromFriend flag
//  + opts.durationMonths so the modal copy matches the source.
//  Trigger sites: same three as the admin-beta prompt (initApp post-
//  hydrate, onAuthStateChange fresh path, onAuthStateChange dedup
//  path) + immediately after a successful subsidiary claim so the
//  user doesn't have to wait for a page reload.
//  Once-per-claim gating via localStorage key pb_subsidiary_welcome_seen_<id>.
// v366 — Subsidiary beta invites (friend-to-friend trial codes):
//  New feature: select beta testers can give time-limited invites to
//  friends. Quotas:
//    • Founding   → 3 invites of VENDOR tier,     3 months
//    • Enthusiast → 1 invite  of ENTHUSIAST tier, 6 months
//    • Collector  → 1 invite  of COLLECTOR tier,  6 months
//  (Vendor / Shop beta testers don't get subsidiary invites by design.)
//
//  Backed by:
//    - migration_subsidiary_invites.sql — table, RLS, helper RPCs
//      (beta_subsidiary_quota, create_subsidiary_invite,
//       claim_subsidiary_invite, expire_subsidiary_grants).
//    - api/send-subsidiary-invite.js — Resend email endpoint. Reuses
//      RESEND_FROM_NAME / RESEND_FROM_EMAIL env vars.
//    - api/_lib/subsidiary-invite-template.js — friend-to-friend email
//      template (distinct from the admin beta-invite copy).
//
//  Dashboard additions:
//    - Copper banner showing N/total invites left + Generate button for
//      eligible beta testers. Modal generates the code, copy-to-clip,
//      then optional Send Email field.
//    - Yellow warning banner when granted tier is within 14 days of
//      expiring with a "Subscribe to keep it" CTA.
//    - Post-expiry modal listing exactly which features are gone after
//      reverting to free. localStorage-gated so it shows once per
//      expiry, not on every page load.
//
//  Redeem flow update: the existing /redeem modal accepts either an
//  admin beta code OR a subsidiary invite code. Tries claim_beta_code
//  first, falls through to claim_subsidiary_invite. UX is identical
//  to the user.
// v365 — Set logos mirrored to Supabase, kills the 35 MB pokemontcg.io
// dependency on the Sets page:
//  Lighthouse showed pokemontcg.io transferring 35 MB on a single Sets
//  page visit — almost entirely set logo images. The new
//  set_metadata table (migration_set_metadata.sql) + mirror_set_logos.py
//  copies every logo + symbol into Supabase Storage and stamps the
//  mirrored URLs (plus release_date + totals) into set_metadata.
//  loadSetsPage now overlays those mirrored fields on the cached
//  pokemontcg.io response via the _enrichSetsWithMirrored helper.
//  Sets not yet mirrored keep their pokemontcg.io URLs as a fallback
//  so the page works during the initial migration window.
//  Mirrored set_metadata also stores release_date — so non-Pokemon
//  TCGs that get added later can render with real dates instead of
//  the catalog's created_at fallback.
// v364 — Console hygiene + migration completeness:
//  - SW install no longer fails atomically if one PRECACHE asset is
//    unreachable. cache.addAll([6 URLs]) was rejecting on a single
//    failure ("Failed to execute 'addAll' on 'Cache': Request
//    failed" — the red error in the console screenshot). Switched
//    to Promise.allSettled with per-URL cache.add so one dead URL
//    logs a warn but doesn't kill installation.
//  - Added <link rel="icon"> + <link rel="shortcut icon"> pointing
//    at /icons/icon-192.png so browsers stop 404'ing /favicon.ico.
//  - migration_catalog_perf_indexes.sql now also creates
//    catalog_id_prefix_idx (id text_pattern_ops). Without it the
//    catalog_sets_summary RPC seq-scans the whole catalog on every
//    TCG-tab switch, which is exactly the 7.66s call seen in the
//    network panel. With the index it's an index-range scan.
// v363 — Killed every duplicate Sets-page query on sign-in:
//  Network panel showed collection_items × 2, listings × 2, profiles × 2,
//  portfolio_snapshots × 2 firing on a single page load. Two code paths
//  were each independently doing the same Promise.all of loaders:
//    1. initApp() — runs on DOMContentLoaded
//    2. onAuthStateChange('SIGNED_IN') — fires the same event when the
//       page restores an existing session
//  With an active session both paths run, doubling every query.
//  Same fix as the syncUserDataFromCloud loop: per-user guard flags.
//  - loadUserDataOnce() wraps the 4-loader parallel block. The second
//    caller short-circuits if the same user id already triggered it.
//  - _profileListingsHydratedFor tracks the profile + listings fetch;
//    initApp stamps it after its parallel Promise.all, and the
//    SIGNED_IN handler bails before re-firing the queries.
//  Both guards reset on sign-out and on different-user sign-in, so a
//  fresh account always gets fresh data.
// v362 — Sets page no longer waits 6s on pokemontcg.io every visit:
//  The /v2/sets API was the single biggest Sets-page latency hit (3-6s
//  on cold load, every load). The in-memory _setsCache only survived
//  the session, so closing the tab or reloading reset the wait.
//  Switched to a 3-tier stale-while-revalidate strategy:
//    1. Session memory cache (10 min TTL) — fastest, unchanged
//    2. localStorage cache (24h TTL) — survives reloads + tab close.
//       Returning users render instantly from cache, fresh data
//       refreshes in the background.
//    3. Network — only on first-ever load or when the localStorage
//       cache has expired.
//  Background refresh updates the cache + re-renders ONLY when there's
//  a new set the cached version was missing, so we don't flash the
//  page when nothing changed.
//  Expected impact for return users: 6s → ~0ms initial render.
// v361 — Thumbnail fallback handlers no longer silently fail:
//  My v354 image-fallback patches interpolated PLACEHOLDER_IMG (a
//  data:image/svg+xml URI containing single quotes for xmlns / font-
//  family attrs) directly into HTML onerror="..." attributes. The
//  inner quotes collided with the outer quotes and broke the parser
//  on every fired error event, so when a -200.webp variant 404'd the
//  fallback never ran. Visible symptom: broken-image icons in set
//  detail rows + marketplace browse cards while the original full-
//  size image (in the modal / detail view) loaded fine.
//  Fix: replaced the inline onerror with a window._thumbFail(this)
//  helper that does the variant→fallback→placeholder cascade in JS.
//  PLACEHOLDER_IMG never enters the HTML attribute now, so the quote
//  collision is gone. Companion _thumbFailHide handler for the
//  visibility:hidden variant.
// v360 — Killed the syncUserDataFromCloud infinite loop:
//  updateAuthUI() called syncUserDataFromCloud(), which awaited a
//  Supabase profiles query, rendered the avatar, then called
//  updateAuthUI() back — kicking off the same chain again. Each
//  iteration was a ~3s network round-trip. The 712-request network
//  panel screenshot from a single session was exactly this loop
//  burning through ~3 minutes of bandwidth before the user closed
//  the tab.
//  Added a re-entrancy guard plus a per-user "already synced this
//  session" flag (_syncInProgress + _syncDoneFor). Nested calls
//  short-circuit immediately. The flag is reset on sign-out and
//  when a different user signs in on the same tab so we still
//  pull fresh data for legitimately new sessions.
// v359 — Sets page perf + free scans bumped + nightly refresh circuit breaker:
//  - Set detail card lookup switched from `.ilike('set_code', setId)`
//    (full-table regex scan, ~30s) to `.eq('set_code', setIdLower)`
//    with an ilike fallback for legacy uppercase rows. With the new
//    idx_catalog_set_code + idx_catalog_game_type_set_code indexes
//    (see migration_catalog_perf_indexes.sql) this is an index scan
//    instead of a seq scan over 48k rows.
//  - _buildCatalogSetCardRows replaced cards.indexOf(c) (O(n) per row,
//    O(n²) total) with an id→origIdx Map built once before the render
//    loop. Material savings on 200+ card sets.
//  - Free tier scanner limit bumped from 5 → 25 photo scans / month.
//    More room for new users to actually try the scanner before they
//    bump into the paywall. Pricing modal feature list updated.
//  - refresh_catalog_prices.py: added a circuit breaker that
//    fast-fails fetch_pc_api once consecutive 403/429s cross a
//    threshold (default 75). Prevents the nightly job from grinding
//    for 7+ hours when PC's Cloudflare flags our IP. Re-run after the
//    WAF cools off (a few hours).
// v358 — Avatar/badges no longer leak across accounts on the same device:
//  Profile picture + avatar state + badge list live in localStorage
//  under non-namespaced keys (pathbinder_avatar_pfp_v1,
//  pathbinder_avatar_v2, pathbinder_badges_v1). The sign-out handler
//  cleared in-memory state but left those keys intact, so when another
//  user signed up or signed in on the same device they inherited the
//  previous user's PFP and badges. Two-pronged fix:
//   - signOut handler now removes those three keys + blanks the
//     visible avatar chips so the old PFP doesn't linger in the UI
//     during the page transition.
//   - The onAuthStateChange SIGNED_IN handler stamps and compares the
//     user id against pathbinder_last_user_id. A mismatch wipes the
//     personal keys before syncUserDataFromCloud repopulates from the
//     incoming user's profiles row. This catches the case where
//     someone signs up on a device without going through sign-out
//     first, which is exactly what triggered the report.
// v357 — Admin tab on mobile + price tracking now FREE:
//  - Added 7th button to the mobile-nav for the Admin page, hidden by
//    default and revealed via updateAuthUI() when currentUser.is_admin
//    is true. Mirrors the desktop sidebar visibility pattern. Only
//    admins see the extra tab so the cramped 7-column layout impacts
//    a tiny user population.
//  - hasPriceTracking() now returns true unconditionally. Live market
//    prices, per-card trend charts, YTD portfolio chart, and the
//    biggest-movers dashboard are no longer gated behind Collector+.
//    A binder that doesn't update its values isn't worth using — we'd
//    rather give away the visualization and convert on the
//    marketplace / multi-binder / scanner features. Pricing modal
//    feature lists updated: "Live market prices" + "Price trend
//    charts" moved from Free's `locked` to its `features`; Collector
//    tier's redundant price-tracking lines were replaced with
//    "Watchlist price alerts" as a more distinct upgrade reason. Free
//    tier first-run copy no longer claims price tracking is an
//    Enthusiast+ perk.
// v356 — Hotfixes from v355 mobile QA:
//  - PLACEHOLDER_IMG ReferenceError: my v355 fallback handlers referenced
//    PLACEHOLDER_IMG, which was a const inside renderBrowse() and not
//    accessible to other render functions. Set detail pages crashed
//    with "Failed to load. Can't find variable: PLACEHOLDER_IMG"
//    instead of rendering cards. Hoisted to window.PLACEHOLDER_IMG +
//    var alias so every script-level callsite can reference it.
//  - Sales Archive → Shop Analytics: the 2-col grid (Top Cards |
//    Channel Breakdown) had a fixed grid-template-columns:1fr 1fr
//    inline so it didn't collapse on mobile. Channel Breakdown's
//    5-col Monthly Breakdown table overflowed horizontally past the
//    viewport edge. Added .tx-shop-analytics-grid class that drops
//    to single column under 900px; added min-width:0 to children so
//    table contents wrap rather than push the layout wider.
//  - Binder sidebar fallback labels (".bsb-fallback") had
//    word-break:break-all which split short binder names into single-
//    letter vertical columns ("Charizard" → "Chari / z"). Switched to
//    nowrap + ellipsis so longer names truncate cleanly with the
//    full name available via the title attribute. Slice trimmed to
//    4 chars (was 6 for the no-cover case) so it fits the 38px box.
// v355 — Thumbnail variants wired site-wide + mobile UX fixes:
//  Now that image_variants.py has finished pre-generating -200.webp and
//  -400.webp siblings for every catalog + user-photo upload, every <img>
//  render in the app calls _pickThumbVariant(url, targetWidth) with a
//  width matched to the rendered element. Variant is picked, falls back
//  to original on 404, then to PLACEHOLDER_IMG (or hides itself for
//  inline cases). Bandwidth savings vs. full-size on each grid is
//  roughly 70-90%, especially noticeable on mobile data.
//  Spots wired: all-cards list+grid, binder sidebar icons, binder shelf
//  covers, organize-view thumbs, binder card grid, wishlist detail,
//  set/catalog row, my-listings rows, admin card list.
//  Spots intentionally NOT wired: full-screen detail / lightbox / scan
//  preview — they want max resolution.
//  ALSO in this version:
//  - Landing page mobile: tightened .lp-pricing-section padding from
//    40px → 14px under 700px so single-column tiers don't get cropped
//    by the viewport edge. Footer strip switched to a real 2x2 grid
//    with the help button spanning both columns instead of sharing a
//    column with a wedge of weird whitespace.
//  - Global -webkit-tap-highlight-color:transparent kills the gray
//    flash mobile Safari shows on every tap (cards, buttons, toggles).
//  - html/body overflow-x:hidden so a child that overflows the viewport
//    doesn't expose a horizontal scroll strip.
//  - Sticky focus rings on buttons/links after a touch tap are dropped
//    via :focus:not(:focus-visible). Keyboard a11y focus still renders.
// v354 — Set/catalog browse rows: image fallback cascade
//  The `_renderCatalogCardRow` template (sets-detail card list, near
//  line 28823) was rendering `<img src="${card.image_url}">` raw with
//  no `onerror`. When a catalog row pointed at a stale Supabase Storage
//  path (e.g. an old .png that cleanup_png_storage.py later removed,
//  or a missing -200.webp variant), the user just saw a broken-image
//  icon. Marketplace browse already had the variant → original →
//  PLACEHOLDER_IMG cascade; set rows now match.
// v353 — Price movers "Yours" tab honors the 24h/7d toggle:
//  Personal-collection movers section was hardcoded to a 7-day window
//  regardless of which toggle was selected. The legacy in-memory log
//  cutoff, the periodLabel chip on each row, and the panel header all
//  said "7d" even when the user clicked 24h. Symptom: clicking 24h on
//  the Yours panel still showed the same gainers as 7d.
//  Fix: snapshot now keyed by period (`_priceHistorySnapshots[1]` vs
//  `[7]`), loader fetches the matching window, and every label /
//  cutoff in buildMovers derives from `_activePeriod`. Global Market
//  header now uses the shared `_periodLabel` so a 24h toggle reads
//  "last 24h" instead of "last 1d".
// v352 — Order messaging (buyer ↔ seller chat) + Payments empty state:
//  - New `order_messages` table + RLS scoped to the two parties on
//    the order. New "Message buyer/seller" button on every order card
//    opens a modal thread (SMS-style bubbles, teal=yours / slate=theirs).
//    Composer at the bottom; Cmd/Ctrl+Enter sends.
//  - Unread messages roll into the existing Orders nav badge so users
//    see one count for "things needing attention" (awaiting-ship orders
//    + unread messages). Mark-as-read fires on modal open via the
//    mark_order_messages_read RPC.
//  - Payments tab empty-state polish: when seller has zero sales, the
//    wall of $0 stat cards is replaced with a "Once your first sale
//    lands…" panel + "List your first item" CTA, with the commission
//    table still visible as reference.
// v351 — Payments tab (seller-side payouts dashboard):
//  New Account → Payments tab between Sales Archive and Watchlist.
//  Shows:
//   - Stripe Connect status banner (reused from My Listings)
//   - 4 stat cards: lifetime payouts, pending payout, platform fees
//     paid, refunded amount
//   - Commission-rate table highlighting the user's current tier
//   - Recent payouts table (last 20 sales) with status, fee, and net
//     payout per row
//  Free/Collector tiers see an upgrade prompt instead of the dashboard.
//  No new server endpoint — reads from in-memory orders array.
// v350 — Admin test-email button no longer needs a real disputed order:
//  /api/admin-notify-dispute now accepts { test: true } in the POST
//  body. Admin-only (re-checks profiles.is_admin), bypasses the order
//  DB lookup, fires a synthetic "wiring check" email to
//  ADMIN_EMAIL_RECIPIENTS with subject "[PathBinder] TEST — admin
//  alert wiring check". Lets admins verify Resend env vars work
//  without creating fake disputed orders in the DB. The button label
//  + behavior unchanged from the user's POV — toast wording slightly
//  updated to "Firing admin-notify-dispute test…".
// v349 — Password reset flow (Forgot Password):
//  Login modal now has a "Forgot password?" link below the Sign In
//  button. Click → forgotPasswordModal → enter email → fires
//  Supabase's resetPasswordForEmail with redirectTo=pathbinder.gg/?type=recovery.
//  User clicks the link in their email, lands on the site, and
//  checkPasswordRecoveryHash() detects the recovery token + opens
//  newPasswordModal so they can set a new password. updateUser() then
//  persists it and we route them to their dashboard.
//  Email currently comes from Supabase default sender — rebrand to
//  noreply@pathbinder.gg later by configuring Resend SMTP in Supabase
//  Dashboard → Auth → SMTP Settings.
// v348 — Vision OCR: client-side resize before POST
//  Phone photos at full resolution (4-8MB) were blowing Vercel's
//  4.5MB request body limit, returning HTTP 413 from /api/vision-ocr
//  before the proxy could even invoke Google Vision. Scanner logged
//  "API key may be rate-limited or expired" which was misleading.
//  Added _resizeForOcr() helper that decodes the dataURL into an
//  <img>, draws to a 1200px-max canvas, and re-encodes as JPEG q=0.85.
//  Drops typical card-photo payloads from 5-7MB → 100-200KB. Vision
//  reads them just fine at that resolution.
// v347 — Beta invite emails (Resend):
//  - New /api/send-beta-invite endpoint fires a branded HTML email
//    to a beta invitee right after admin_invite_beta creates the row.
//    Email uses dashboard.jpg as background, teal-bordered card on
//    navy bg, embedded pb_logo.png. Tier-specific feature list +
//    big "Accept Invite" CTA + prominent Discord callout. Plain-text
//    fallback included.
//  - Wired into the admin "send beta code" flow — when an email is
//    provided (vs code-only mode), the invite email auto-fires.
//    Surfaces clear toasts for the resend-not-configured / failure cases.
//  - Beta panel now renders all 5 tier sections (Founding, Enthusiast,
//    Collector, Vendor, Shop) instead of the original 3.
//  - showBetaDiscordPrompt() copy updated for all 5 tiers (was only
//    handling founding + collector).
// v346 — Admin nav badge + manual email test:
//  - Admin nav-tab now shows the same unread-count badge that the
//    dropdown "Admin Alerts" item shows, so the admin doesn't need to
//    open the avatar menu to notice something needs attention. Hidden
//    for non-admins.
//  - New "Send test email" button on the admin Disputes panel header.
//    POSTs to /api/admin-notify-dispute with the most recent disputed
//    orderId so the admin can verify Resend env vars + ADMIN_EMAIL_
//    RECIPIENTS are correctly configured without waiting for a real
//    seller-declines-return flow. Surfaces distinct toasts for the
//    common failure modes (resend_not_configured / no_admin_emails).
// v345 — Empty states + 404 + offline + error boundary:
//  - First-run welcome card on the dashboard when the user has zero
//    cards, zero listings, zero orders, zero binders. Replaces the
//    silent wall of $0/0/0 with a copper-bordered "Getting Started"
//    panel pointing at 3-4 next actions (scan, browse, binders,
//    list/upgrade).
//  - showPage() now SPA-404s on unknown page ids instead of throwing
//    a TypeError on null.classList. Routes to landing (signed-out)
//    or collection (signed-in) and toasts "Page not found".
//  - Static /404.html for any non-SPA path Vercel can't resolve.
//  - /offline.html rebranded from "CARDFRAC" to "PathBinder" with
//    the cyan + copper hologram theme.
//  - window.addEventListener('error') + 'unhandledrejection' as a
//    global boundary — logs full stack to console, surfaces a
//    rate-limited toast so the user knows something happened.
// v344 — Admin moderation tools (disputes, user ban, listing suspend):
//  Admin page gets three new panels above the existing ones:
//    1. Open Disputes — every orders.status='disputed' row with buyer/
//       seller names, reason + detail callout, photo, two actions:
//       Refund Buyer (POST /api/refund-order with Connect-aware fee
//       reversal) or Resolve for Seller (admin_resolve_dispute_for_seller
//       RPC, no money moves, audit note required).
//    2. User Management — search by email/username/name, ban/unban
//       with required reason. Ban cascades active listings to suspended
//       and blocks sign-in via is_account_banned() check on session
//       restore + handleLogin().
//    3. Suspended Listings — every listings.status='suspended' row with
//       reason and a Restore action. admin_set_listing_suspended() RPC.
//  Deep-link ?admin=disputes&order=<id> scrolls + pulses the specific
//  dispute card (used by admin email + in-app notification links).
//  All admin mutations go through SECURITY DEFINER RPCs that check
//  is_admin server-side, so a malicious user with a JWT can't toggle
//  bans / suspensions.
// v343 — Admin dispute notifications (in-app + email):
//  New admin_notifications table populated by trg_order_disputed
//  Postgres trigger on every status flip to 'disputed' — in-app
//  channel always fires regardless of client state. Admin avatar
//  dropdown gets a copper "Admin Alerts (N)" item showing unread
//  count; clicking opens a panel with per-notification dismiss + a
//  "Mark all read" action. Per-admin read/dismissed tracking via
//  uuid[] arrays on the row.
//
//  Email channel uses Resend: /api/admin-notify-dispute fans out an
//  HTML+text email to every admin (queried from profiles where
//  is_admin=true) right after the seller declines a return. Best-
//  effort — degrades to in-app-only when RESEND_API_KEY/RESEND_FROM
//  env vars aren't set. Requires verified sender domain in Resend.
// v342 — Refund + return flow end-to-end:
//  Buyer's "Report Issue" now opens a structured returnRequestModal
//  capturing a reason category (not_as_described / damaged /
//  never_arrived / wrong_item / other) plus a required detail field
//  instead of the old confirm() prompt. Stores into new orders columns
//  return_reason, return_reason_detail, return_requested_at.
//
//  Seller's Orders → Selling view now surfaces return requests with
//  the reason + detail in a yellow callout, plus two action buttons:
//    - Approve Refund   → /api/seller-refund (Stripe refund with
//                         reverse_transfer + refund_application_fee
//                         for destination charges, listing back to
//                         available, status=refunded)
//    - Decline & Dispute → status=disputed for admin mediation
//  Sellers can also issue a goodwill refund on shipped/delivered/
//  completed orders without a buyer request.
//
//  Admin /api/refund-order now also passes reverse_transfer +
//  refund_application_fee so Connect-routed refunds don't leave the
//  platform holding the fee.
//
//  Migration (migration_refund_return.sql) adds the new orders columns
//  + CHECK constraints on reason/decision enums + partial index for
//  the seller's pending-returns query.
// v341 — Edit marketplace listings:
//  Sellers can now edit a listing's name, condition/grade, price,
//  shipping, status (active/deactivated), and photo set without
//  deleting + recreating. New "Edit" button on every active row in My
//  Listings opens #editMarketplaceListingModal. Photos can be removed
//  individually; new ones get queued (NEW pill) and uploaded on save.
//  Lives alongside the create flow rather than reusing #listCardModal
//  so the create flow's three product-mode branches stay simple.
//  Includes the same live fee/payout preview the create flow has.
//  Update goes through the supabase client directly (RLS gates by
//  seller_id), no new endpoint needed.
// v340 — Self-service account deletion (App Store Guideline 5.1.1(v)):
//  New "Account Settings" item in the avatar dropdown opens a modal
//  that surfaces a Delete Account CTA. Two-step confirm — user types
//  DELETE into a box to enable the destructive button. Posts to
//  /api/delete-account which stamps a 30-day grace period on profiles,
//  cancels Stripe subscription at period end, and deactivates active
//  listings. Site-wide red sticky banner shown above nav whenever a
//  grace window is open, with one-click "Cancel Deletion" in both the
//  banner and the settings modal. Sign-in is blocked for accounts
//  whose 30-day window has elapsed and is_deleted=true. Migration
//  (migration_account_deletion.sql) adds the deletion columns plus
//  purge_user_profile() + list_pending_account_purges() SECURITY
//  DEFINER helpers for the sweep job.
// v339 — Stripe Connect Express onboarding (seller payouts):
//  My Listings tab now renders a payout-status banner above the cap
//  header. Three states:
//    1. No Connect account → big copper "Connect Stripe" CTA
//    2. Account exists but charges/payouts not enabled → yellow
//       "Finish Setup" CTA with Stripe's currently_due/past_due list
//    3. Fully onboarded → green "✓ Stripe Connected" pill + link to
//       the Express dashboard
//  Backed by new endpoints:
//    /api/connect-onboard  → creates Express account + onboarding link
//    /api/connect-status   → fetches + syncs charges/payouts/requirements
//  Webhook (api/stripe-webhook.js) now handles account.updated and
//  capability.updated so flag changes back-sync to profiles without
//  the user opening the app. Also fixed VALID_TIERS missing 'enthusiast'
//  which was silently no-op'ing enthusiast subscription updates.
// v338 — Tiered commission rates on the listing modal:
//  The "List Card" modal's fee box used to read a hardcoded "Platform
//  fee: 5%". Replaced with updateListingFeePreview() that pulls the
//  seller's tier (Enthusiast 7% / Vendor 6% / Shop 5%) and projects a
//  live "you receive $X" payout from ask + shipping. Buyer-side copy
//  on the listing detail dropped the "5%" specific phrasing to match.
//  Server side (/api/marketplace-checkout.js) reads subscription_tier
//  from profiles and computes application_fee_amount from the same
//  rate table so the actual charge matches what the seller saw.
// v222 — Image loading optimization:
//  Wired up the existing _thumbUrl() helper that was defined but
//  never called. Adds Supabase Storage render/image transforms
//  (?width=N&quality=80) on every grid thumbnail render site. Saves
//  ~70-90% bytes on thumbnails vs. shipping the full 480px WebP.
//   Sets singles row:        width=80   (36px element)
//   Marketplace browse:      width=400  (200px card)
//   Binder card grid:        width=400  (150-300px element)
//   Public binder:           width=320
//   All-cards list:          width=100
//   All-cards grid:          width=300
//   Sealed product grid:     width=300
//   Dashboard mini thumbs:   width=160-200
//  Lightbox + binder detail modal keep full resolution for zoom.
//  Plus missing decoding="async" added to several sites for consistency.
const CACHE = 'pathbinder-v561';

const PRECACHE = [
  '/offline.html',
  '/404.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/pokedex.webp',
  // /pb-app.js — the externalized inline-scripts bundle (~1.8 MB).
  // Precaching keeps repeat-visit FCP fast (no network round-trip
  // after first install). Cache invalidates when CACHE version bumps.
  '/pb-app.js',
  // /pb-styles.css — the externalized inline-styles bundle (~320 KB).
  // Same precache strategy: HTML parses fast, CSS comes from cache
  // on repeat visits, render-block is near-instant.
  '/pb-styles.css',
  // /pb-scanner.js — lazy-loaded scanner subsystem (~200 KB). Loaded
  // on first scanner-button click OR at browser idle (whichever first).
  // Precaching means even the first scanner click on a return visit
  // is instant — no network round-trip.
  '/pb-scanner.js',
  // /pb-avatar.js — lazy-loaded avatar engine (~43 KB). Sprite-based
  // renderer + cyberpunk palette + hat mask. Loaded at idle for
  // PFP painting, or on demand if user opens the avatar editor.
  '/pb-avatar.js',
  // /pb-photo.js — lazy-loaded Card Photo Update modal (~18 KB).
  // Crop + bg removal. Fires when user clicks Edit Photo on a card.
  '/pb-photo.js',
  // /pb-store.js — lazy-loaded My Store POS view (vendor+ only).
  // Square-style grid of active listings. Only loads when the user
  // activates the My Store tab.
  '/pb-store.js',
  'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap'
];

// Install: cache core assets.
// Why not cache.addAll(PRECACHE)? It rejects atomically if ANY single
// URL fails — one dead asset (e.g. the Google Fonts CSS during a brief
// network blip, or a missing icon path) blocks the entire SW install.
// The DevTools error "Failed to execute 'addAll' on 'Cache': Request
// failed" was that. Switched to Promise.allSettled with per-URL
// cache.add so a single 404 logs but doesn't kill installation. Other
// failures get a console.warn so we can spot bad PRECACHE entries.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(
        PRECACHE.map(url =>
          cache.add(url).catch(err => {
            console.warn('[SW] PRECACHE skipped (failed to fetch):', url, err && err.message);
            // Re-throw so allSettled records the rejection — caller
            // doesn't act on individual failures.
            throw err;
          })
        )
      ))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches + purge any previously-cached
// pokemontcg.io responses from the current cache (the new fetch
// handler skips that hostname going forward, but any leftover
// entries from before this SW version need to be flushed once so
// users don't keep seeing the stale set list).
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() =>
      caches.open(CACHE).then(cache =>
        cache.keys().then(reqs =>
          Promise.all(
            reqs
              .filter(req => /api\.pokemontcg\.io|pricecharting\.com/i.test(req.url))
              .map(req => cache.delete(req))
          )
        )
      )
    ).then(() => self.clients.claim())
  );
});

// Handle SKIP_WAITING messages from the page. The page-side registers
// an updatefound listener and posts this message when a new SW finishes
// installing but is stuck waiting for the old controller to die. Without
// this handler the new SW sits in "waiting" forever until every tab
// closes; with it, the new SW takes over immediately and the page's
// controllerchange listener triggers a reload.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch: network-first for API/Supabase calls, cache-first for static assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go network for Supabase, API calls, auth, and any
  // upstream pricing/catalog data sources. pokemontcg.io serves the
  // master set list — if we cache it, newly-released sets (e.g.
  // Chaos Rising for Pokemon EN) won't appear on mobile until the
  // user manually clears storage. Same logic applies to PriceCharting
  // and any other live catalog endpoint we add later.
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('api.pokemontcg.io') ||
    url.hostname.includes('pricecharting.com') ||
    url.pathname.startsWith('/api/') ||
    e.request.method !== 'GET'
  ) {
    return; // Let browser handle normally
  }

  // For navigation requests (page loads): network ONLY. Never cache the
  // HTML and never serve stale HTML from cache — go straight to network.
  // If the network is completely down, fall back to /offline.html. This
  // is the dev-friendly mode: a deploy is visible on the very next load.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // App-code bundles (pb-app.js, pb-styles.css, pb-critical.css,
  // pb-scanner.js, …): intentionally CACHE-FIRST. They fall through to the
  // generic static-asset handler below and are pinned to whatever is cached
  // until the CACHE version constant is bumped. We deliberately do NOT
  // auto-revalidate these — the stale-while-revalidate path proved
  // unreliable in practice. Shipping new JS/CSS to users REQUIRES bumping
  // CACHE, and every bump is coordinated explicitly. The vercel.json
  // `max-age=0, must-revalidate` header on /pb-*.{js,css} ensures that the
  // post-bump fetch (a cache miss under the new CACHE name) pulls fresh
  // bytes from the origin rather than a stale HTTP-cached copy.

  // For other static assets (images, fonts, icons): cache first, then network.
  // Only cache fully-formed 200 responses. `res.ok` is true for the whole
  // 200-299 range, which includes 206 Partial Content — the response type
  // browsers return for ranged audio/video requests. cache.put rejects 206
  // with "Partial response (status code 206) is unsupported", surfacing as
  // an uncaught TypeError in the console. Filtering to status === 200 also
  // skips redirects (3xx) and opaque cross-origin responses.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.status === 200 && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone)).catch(() => {});
        }
        return res;
      }).catch(() => new Response('', { status: 408, statusText: 'Network unavailable' }));
    })
  );
});
