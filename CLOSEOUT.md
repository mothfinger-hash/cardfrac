# PathBinder — Session Close-Out Checklist

Single source of truth for shipping everything built this session. Work top
to bottom.

---

## 1. Deploy the web  ← DO THIS FIRST

The offline layer (`pb-app.js`), `sw.js` v611, `.gitignore`, the plan, and the
`native/` scaffold are **still uncommitted** — so offline is NOT live yet.

```bash
cd ~/Desktop/cardfrac
git add -A
git commit -m "Offline layer (2.5a-c), beta + marketplace fixes, Capacitor scaffold, SW v611"
git push origin main
```

Vercel auto-deploys on push. After it lands, hard-refresh once to pick up SW
v611.

What this ships: offline binder + POS + download-a-set, the marketplace
sold-listing webhook fix, founding→vendor claim mapping, the Invite Friends
menu, the admin subsidiary tracker, order emails, glyph cleanup, and the
Capacitor `_isNativeApp()` detection.

---

## 2. Supabase migrations (SQL editor — git does NOT run these)

Already run (confirmed working):
- [x] `migration_subsidiary_invites.sql` (RPCs exist)
- [x] `migration_beta_testers_dedupe_unique.sql`
- [x] `migration_fix_subsidiary_quota_ambiguity.sql` (invite menu works)

Run now (verify each — idempotent, safe to re-run):
- [ ] `migration_subsidiary_invite_config_v2.sql` — founding 3 / vendor 2 /
      others 1 invite, all 1-year, founding→vendor
- [ ] `migration_order_listing_sold_trigger.sql` — durable sold-listing trigger
      (also auto-clears the stranded Pikachu δ listing)
- [ ] `migration_rls_public_reference.sql` — security (if not already run)
- [ ] `migration_secure_metrics_views.sql` — security (if not already run)
- [ ] `migration_shipping_addresses.sql` — shipping (if not already run)

Dormant (run only when Shippo partner creds arrive):
- [ ] `migration_shippo_oauth.sql`

---

## 3. Stripe

Subscriptions (already live) — redeploy the edge functions for this session's
fixes (trim / profile-tier / customer self-heal / synchronous tier):
- [ ] `supabase functions deploy create-checkout-session`
- [ ] `supabase functions deploy stripe-webhook`

Marketplace (Connect is live + active):
- [ ] Add **`capability.updated`** to the live `/api/stripe-webhook` endpoint
      (you confirmed the other 9 events are set)
- [ ] Confirm Vercel `STRIPE_SECRET_KEY` = `sk_live_…` and
      `STRIPE_WEBHOOK_SECRET` = the live endpoint's `whsec_…`

---

## 4. Shippo

- [ ] Phase 1: confirm Vercel `SHIPPO_MODE=live` + `SHIPPO_API_TOKEN_LIVE`
- [ ] Phase 2 (per-seller OAuth): dormant — waiting on Shippo Partner Program.
      When approved: run `migration_shippo_oauth.sql`, set
      `SHIPPO_OAUTH_CLIENT_ID` / `SHIPPO_OAUTH_CLIENT_SECRET` in Vercel,
      whitelist `https://pathbinder.gg/shippo-oauth-redirect/`, redeploy.

---

## 5. Native build (`native/` folder — Capacitor)

Already done: `npx cap add ios` + `android`, Xcode installed, iOS synced.

- [ ] **Android:** finish Android Studio install → `npx cap open android` → Run
- [ ] **iOS:** `npx cap open ios` → set Signing Team → Run on device/simulator
- [ ] Add native permission strings (camera + photo) per `native/README.md`
- [ ] **Apple Sign-In** — required since Google login is offered on iOS
      (`@capacitor-community/apple-sign-in` + Supabase Apple provider)
- [ ] App icon: 1024px master at `native/assets/icon.png` → `npx capacitor-assets generate`
- [ ] Re-run `npx cap sync` after any plugin/permission/icon change

Run all `npx cap …` commands from inside `native/`.

---

## 6. App Store submission prep

- [ ] Apple Developer Program ($99/yr) + Google Play Developer ($25 once)
- [ ] Screenshots from 3+ device sizes (use the simulator)
- [ ] Privacy + Terms URLs — already live (`/privacy-policy`, `/terms-of-service`)
- [ ] Account deletion reachable in-app — already supported
- [ ] Double-check the web-only subscription sidestep against current App
      Review external-purchase guidance (the one policy risk)
- [ ] TestFlight (iOS) + Play internal testing → invite testers before public

---

## 7. Legal

- [ ] Have a licensed attorney review the 5 legal docs before relying on them
      (arbitration / liability / subscription sections). Pages are live.

---

## Reference: one-off data fixes already applied this session

- moth@pathbinder.gg: profile → vendor, beta row un-revoked, single founding row
- Pikachu δ listing marked sold (or auto-cleared by the sold-listing trigger)

## Still online-only (by design)

The camera **scanner** (cloud OCR + embedding match). Offline POS scanning
needs on-device ML Kit OCR — a native-wrap follow-up matching against the
already-cached collection.
