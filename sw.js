// PathBinder Service Worker
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
const CACHE = 'pathbinder-v356';

const PRECACHE = [
  '/offline.html',
  '/404.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/pokedex.png',
  'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap'
];

// Install: cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
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

  // For static assets: cache first, then network.
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
