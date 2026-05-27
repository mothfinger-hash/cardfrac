// PathBinder Service Worker
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
const CACHE = 'pathbinder-v346';

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
