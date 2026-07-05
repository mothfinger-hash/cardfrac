# PathBinder — Morning Verification Checklist

Everything changed in this session, in the order to do it. All JS was
`node --check`'d as it was written, but **nothing has been clicked-through in a
real browser yet** — that's what this list is for.

---

## STEP 1 — Backend first (Supabase + Stripe), before you deploy the web code

These make the new web features actually work. Run the SQL in **Supabase → SQL
Editor** (this repo keeps migrations in the `SQL Migrations/` folder, copy-paste
style — they are NOT auto-run).

- [ ] **`migration_listings_seller_rls.sql`** — CRITICAL. Without it, sellers get
      "new row violates row-level security policy for table listings" (the bug you
      already hit). Lets Enthusiast+ sellers create/edit/delete their own listings.
- [ ] **`migration_content_reports.sql`** — powers the new in-app Report feature +
      admin Moderation queue (Apple 1.2 requirement).
- [ ] **`migration_push_tokens.sql`** — adds `profiles.push_token` columns (only
      needed once you wire up push; harmless to run now).
- [ ] **Drop legacy tables** (closes the anon-readable `slots` data leak):
      `drop table if exists public.transactions, public.trade_offers,
      public.buyout_offers, public.slots, public.pending_checkouts cascade;`
      (each on its own line with CASCADE — see the earlier message).
- [ ] **(Optional) game_type backfill** — repairs collection rows mis-tagged as
      `pokemon` before the scanner fix (the One Piece Luffy issue). The
      `update public.collection_items set game_type = 'onepiece' where
      game_type='pokemon' and api_card_id ilike 'op%';` block (+ mtg/ygo/gundam/dbz).
- [ ] **Undeploy dead edge functions:**
      `supabase functions delete process-buy process-cashout process-buyout process-trade`
- [ ] **Deploy the updated function:**
      `supabase functions deploy create-checkout-session` (ships the 25%-off
      coupon wiring + the Manage-subscription billing portal).
- [ ] **Stripe Dashboard → Settings → Billing → Customer portal → Enable it**
      (cancel = "at end of billing period"). Required for "Manage subscription".
- [x] Stripe coupon `ukgWK5jy` — already created by you.

Then **deploy the web code to Vercel** as usual.

---

## STEP 2 — Verify in the web app (after deploy)

### Marketplace / money path
- [ ] Browse the marketplace as a **non-admin** account → it loads (no "Coming
      Soon" wall). Free/Collector can browse + buy.
- [ ] As Enthusiast+ → **List a card** → it **saves** (toast "… listed for sale!").
      It should also fire the **"SET UP PAYOUTS"** prompt if Connect isn't set up.
- [ ] List a **One Piece** card from the binder → the modal shows **One Piece**,
      not Pokémon (the id-prefix fix).
- [ ] Game-type **filter** shows on browse (when >1 game present); search a set
      name like "151" → returns results.
- [ ] Open a listing → **"Report this listing"** link; open a seller → **"Report
      this user"** → submit → appears in **Admin → Moderation → Content Reports**.
- [ ] Account settings (on a **paid** account) → **Manage subscription** opens the
      Stripe portal. (Beta/free accounts correctly won't see it.)

### Sets — Multi-Add (the feature you tested)
- [ ] Pokémon set → **+ MULTI-ADD** → select cards / **Select all missing** →
      the centered **"Add N cards"** pill → adds + flips to owned.
- [ ] A **multi-TCG** set (One Piece / Magic / YGO) → same flow works, and cards
      save with the **correct game** (not pokemon).

### Scanner
- [ ] Scan a card → saves with the right game_type. Trigger an error/offline → you
      get a friendly message ("temporarily unavailable" / "you're offline"), NOT
      raw SQL. A failed/offline scan should NOT burn a free scan.

### Look & feel (the design-visual stuff I couldn't verify)
- [ ] **Mobile bottom nav** labels bigger (~9px) but still fit their buttons.
- [ ] **Sidebar** section headers (COLLECTION/MARKET/ACCOUNT) bigger, not clipped;
      collapse the sidebar → they still hide cleanly.
- [ ] **Avatar dropdown → badges** now 3-per-row with legible names.
- [ ] Landing page: Trade Analyzer says "Live TCGplayer + PriceCharting…" (no "AI").
- [ ] Public binder / storefront that fails to load shows a **Retry** button, not a
      dead "Failed to load".
- [ ] Error toasts stay long enough to read + tap-to-dismiss.

### PWA (add to home screen)
- [ ] Installed PWA shows **"PathBinder"** (not "CardFrac").

---

## STEP 3 — Native build (Capacitor) + device test

```bash
cd native
npm install        # picks up @capacitor/browser + @capacitor/push-notifications
npx cap sync
npx cap open ios   # and/or: npx cap open android
```

Then on a **real device / simulator**:
- [ ] **Airplane mode → first launch** → shows the branded **offline.html** ("You're
      offline" + Try again), NOT the OS "could not connect" page.
- [ ] **Subscription pricing** in-app shows **no prices / no Buy CTAs** — just
      benefits + "Manage on the web" (Apple IAP compliance).
- [ ] **Buy a card / Connect onboarding** → Stripe opens in an **in-app browser with
      a Done button**, not a stranded WebView.
- [ ] **Share your binder** → native **share sheet** appears (not silent copy).
- [ ] **Scan a card** → real **haptic** buzz on match (iOS).
- [ ] **Android**: the camera actually opens on scan (new CAMERA permission).
- [ ] iOS upload to App Store Connect succeeds (encryption + mic-permission fixes).

### Push (only after Firebase is set up)
- [ ] Create a Firebase project, upload the **APNs auth key** (iOS), add
      `google-services.json` (Android) + `GoogleService-Info.plist` (iOS) to the
      native projects.
- [ ] Build `/api/send-push` (FCM HTTP v1 via a service account) wired to the
      in-app events (order sold/shipped, unread DM, trade offer, wishlist-listed).
      The client half (`pb-push.js`, token storage) is already done.

---

## NOT done yet (need your Mac / eyes / a decision — let's do these together)

- **#19 keyboard-accessible cards** — ~47 clickable `<div onclick>` can't be reached
  by keyboard/VoiceOver. Fixable but risky blind (drag handlers). Preview pass.
- **#21 color unification** — teal vs copper: a "which accent wins" design call.
- **#26 minify build step** — changes the deploy pipeline; shouldn't do blind.
- **#27 bulk binder actions** — multi-select delete/move in the binder; best built
  with the preview open so we confirm drag-reorder still works.
- **#28 phase-2 legacy excision** — remove the (already-hidden) dead CardFrac code;
  careful removal, safe to do post-launch.
- **#24 push server + Firebase** — the server half of push (see Step 3).
