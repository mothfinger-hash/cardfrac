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

Key fact: the **marketplace and subscriptions share the same Vercel
webhook** (`/api/stripe-webhook`) and the **same two env vars**
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`). That one function handles
subscription tier grants, marketplace purchases, Connect updates,
disputes, and refunds. So because subscriptions are already live, the
marketplace is almost entirely live too.

Verified 2026-06-24:

- **Connect:** active in **Live** mode (0 connected accounts yet — normal).
- **Live webhook** at `https://pathbinder.gg/api/stripe-webhook` has 9 of
  10 events. **TODO: add `capability.updated`** (Connect payout-readiness
  sync) — search it in the endpoint's event list and save.
- **TODO: confirm Vercel env** `STRIPE_SECRET_KEY` = `sk_live_…` and
  `STRIPE_WEBHOOK_SECRET` = the **live** endpoint's `whsec_…`. (If they
  weren't already live, set them and redeploy Vercel.)
- Marketplace charges are dynamic amounts, so **no Stripe price objects
  needed** for the marketplace (that's a subscription-only concern).

**Redeploy the Supabase edge functions** to pick up the trim /
profile-tier / customer self-heal / synchronous-tier fixes:

```
supabase functions deploy create-checkout-session
supabase functions deploy stripe-webhook
```

**Data cleanup — one stale listing.** A card "sold" during the earlier
405-webhook window never got flipped to sold, so it's still showing in
the marketplace. Run once in Supabase to reconcile any listing that has a
paid order (safe + idempotent):

```sql
update listings l
set status = 'sold',
    sold_to = o.buyer_id
from orders o
where o.listing_id = l.id
  and o.status in ('paid','shipped','completed')
  and l.status in ('active','available');
```

Then hard-refresh the marketplace (listings are cached client-side).

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
| Marketplace (Stripe live) | Connect live + webhook set; **add `capability.updated` + confirm Vercel keys** |
| Stale sold listing | **Run reconciliation SQL** (§3) |
| Shippo Phase 1 | Verify live token set |
| Shippo Phase 2 (OAuth) | Dormant — waiting on partner program |
| Legal | Live; **attorney review pending** |
