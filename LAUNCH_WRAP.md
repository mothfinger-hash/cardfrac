# PathBinder — Launch Wrap

_Last updated: 2026-06-24_

Snapshot of where things stand heading into launch: what shipped, how to
deploy it, and what's left before the marketplace is fully live.

---

## 1. Shipped this session

- **Glyph cleanup.** Removed ~170 decorative/semantic glyphs across
  `index.html`, `pb-app.js`, `pb-admin.js`, `pb-styles.css`. Kept `★`
  ratings, `▾`/`▸` dropdown carets, `●` status dots, and arrows
  (`→` `←` `↩`). Icon boxes hidden via CSS; list/grid toggles are now SVG;
  feature checklists use a neutral `•`; owned-card badge shows `×N`.
- **Subsidiary-invite admin tracker.** Read-only panel in the **Beta**
  admin tab listing every friend-of-tester code (code, inviter + tier,
  granted tier/duration, status, who claimed it, dates) with summary
  counts. Admins already have SELECT on the table, so no new migration.
- **Order emails (Resend).** Buyer "your order shipped" + seller "you
  made a sale" emails, with the listing image. Buyer gets one email
  (shipped only) to avoid spam; seller gets the sale notice.
- **Order Confirmed modal** after checkout (replaces the old toast).
- **Marketplace fixes.** Sold listings no longer show in the "All" tab;
  Enthusiast→Vendor reads as an upgrade; listing-cap upgrade flow.
- **Security migrations.** Public read-only RLS on `catalog`/`set_map`;
  locked-down metrics views behind admin/self RPCs (fair-trade left
  as-is, per your call).
- **Legal docs** (5) built as standalone fast-loading pages at `/privacy`,
  `/terms-of-service`, `/marketplace-seller-terms`,
  `/refund-buyer-protection`, `/prohibited-items-acceptable-use`.
- **Shippo Phase 2 OAuth** ("sellers pay their own labels") — built and
  dormant, waiting on partner credentials.

SW is at **v605**. Committed as `76efbeb` on `main`.

---

## 2. Deploy (do these now)

1. **Push code** (from your machine — the sandbox has no GitHub creds):

   ```
   git push origin main
   ```

   Vercel auto-deploys on push.

2. **Run new migrations** in the Supabase SQL editor (copy-paste, your
   service key). If a table already exists the idempotent SQL is a no-op:

   - `migration_rls_public_reference.sql`
   - `migration_secure_metrics_views.sql`
   - `migration_shipping_addresses.sql`
   - `migration_subsidiary_invites.sql` _(skip if already run — the admin
     tracker will say "table not found" if it isn't)_
   - `migration_shippo_oauth.sql` _(harmless now; required for Phase 2)_

---

## 3. Marketplace → Stripe live

Subscriptions are already on live Stripe (Supabase edge functions).
The **marketplace** side (Vercel Node functions) is separate and still
needs the live switch:

- Set in **Vercel** env:
  - `STRIPE_SECRET_KEY` = `sk_live_…`
  - `STRIPE_WEBHOOK_SECRET` = signing secret from the **live**
    `https://pathbinder.gg/api/stripe-webhook` endpoint
- In **Stripe (live mode)**: create that webhook endpoint
  (`checkout.session.completed` at minimum) and **enable Connect**.
- Verify the **live** Collector price is **recurring** (the test one
  tripped us up); add live annual prices if you're offering them.
- Redeploy Vercel after setting env vars.

**Redeploy the Supabase edge functions** to pick up the trim /
profile-tier / customer self-heal / synchronous-tier fixes:

```
supabase functions deploy create-checkout-session
supabase functions deploy stripe-webhook
```

---

## 4. Shippo

- **Phase 1 (now):** labels buy against your **platform** Shippo token.
  Confirm `SHIPPO_MODE=live` + `SHIPPO_API_TOKEN_LIVE` are set in Vercel
  for real labels. Sellers can always fall back to manual tracking.
- **Phase 2 (later):** you've been told to apply for the **Shippo Partner
  Program** — this is the only gate for per-seller OAuth. **Not a launch
  blocker.** When approved:
  1. (migration already covered above)
  2. Set `SHIPPO_OAUTH_CLIENT_ID` + `SHIPPO_OAUTH_CLIENT_SECRET` in Vercel.
  3. Whitelist callback `https://pathbinder.gg/shippo-oauth-redirect/`.
  4. Redeploy. No code changes — it activates the dormant flow.

---

## 5. Before / right after go-live

- **Legal:** have a licensed attorney review the 5 docs before relying on
  them (arbitration / liability / subscription sections especially). The
  pages are live; the review is the open item.
- **App store:** web-only subscriptions via link are in place to sidestep
  IAP fees. Privacy Policy + Terms URLs are ready for submission.
- **Marketplace unlock:** the hidden marketplace opens with code
  `pathbinder-preview` for testing.
- **Smoke test live:** one real subscription, one real marketplace
  purchase end-to-end (checkout → seller email → buy label → buyer
  shipped email → Order Confirmed), then a refund via admin.

---

## Quick status

| Area | State |
|---|---|
| Code (this session) | Committed `76efbeb` — **push to deploy** |
| New migrations | **Run in Supabase** |
| Subscriptions (Stripe live) | Live; **redeploy edge functions** for fixes |
| Marketplace (Stripe live) | **Set Vercel env + live webhook + Connect** |
| Shippo Phase 1 | Verify live token set |
| Shippo Phase 2 (OAuth) | Dormant — waiting on partner program |
| Legal | Live; **attorney review pending** |
