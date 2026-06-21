# PathBinder — Stripe Test-Mode Plan of Action

Work top-to-bottom. Each phase builds on the last. Everything here is in
**Stripe TEST mode** — no real money moves. Claude will not execute any
charges; you drive the clicks, Claude helps read logs and fix code.

> **You are NOT blocked on the SOS license / EIN to do any of this.**
> Stripe test-mode Connect onboarding accepts fake identity + bank data
> (see Appendix C). The real EIN only matters when you flip to LIVE keys.

---

## Phase 0 — Environment & safety (do this first, once)

- [ ] Confirm the site is pointed at **test keys**: publishable `pk_test_…`,
      secret `sk_test_…`. Grep the deployed env — there should be **zero**
      `pk_live`/`sk_live` anywhere in the test environment.
- [ ] Confirm the **webhook signing secret** in `stripe-webhook.js`'s env is
      the **test** endpoint's secret (`whsec_…`), not live.
- [ ] Install the **Stripe CLI** and log in (`stripe login`). This is how you
      forward + trigger webhook events locally:
      `stripe listen --forward-to <your-test-url>/api/stripe-webhook`
      Leave this running in a terminal all day — it prints every event.
- [ ] In the Stripe **test dashboard**, recreate the Products + Prices for all
      four paid tiers (collector / enthusiast / vendor / shop). Note each
      **Price ID** (`price_…`).
- [ ] Create **two test accounts** in the app: one "buyer", one "seller".
      Keep their emails handy.
- [ ] Open three tabs: app, Stripe test **Dashboard → Developers → Events**,
      and the terminal running `stripe listen`.

**Test cards** (Appendix A) — `4242 4242 4242 4242` is your everyday success card.

---

## Phase 1 — Subscriptions (tier purchases)

Endpoint of record: `checkout.session.completed` + the `customer.subscription.*`
and `invoice.*` handlers in `stripe-webhook.js` (lines ~368–426).

For **each** tier (collector, enthusiast, vendor, shop):

- [ ] Start checkout from the pricing modal → pay with `4242…`.
- [ ] Confirm `checkout.session.completed` fires (CLI + Events tab).
- [ ] Confirm `profiles.subscription_tier` updates to the right tier for that user.
- [ ] **Price sanity:** the amount charged == the price shown in the UI. (This
      catches a Price-ID mismatch — easy to get wrong, costly if it ships.)
- [ ] Confirm the Stripe **Customer** + **Subscription** objects were created
      and linked to the user (customer id stored on the profile).

Then the lifecycle events:

- [ ] **Upgrade** (e.g. enthusiast → vendor): confirm `customer.subscription.updated`
      fires and the tier moves up; proration looks sane.
- [ ] **Downgrade** (vendor → enthusiast): same, tier moves down. Verify any
      **listing-cap** consequences (Phase 2).
- [ ] **Cancel**: confirm `customer.subscription.deleted` fires and the tier
      drops to free (or stays until period end, whichever your code intends —
      decide and verify it matches).
- [ ] **Renewal success**: `stripe trigger invoice.payment_succeeded` →
      tier stays active.
- [ ] **Renewal failure**: `stripe trigger invoice.payment_failed` (or use the
      `4000 0000 0000 0341` attach-then-fail card) → confirm your intended
      dunning behavior (grace period vs immediate downgrade).
- [ ] **Comped beta testers**: confirm a `beta_testers` user shows the right
      tier WITHOUT a Stripe subscription, and isn't double-charged or counted
      in MRR.

---

## Phase 2 — Tier gating actually enforces

Subscriptions are pointless if the gates don't hold. After setting a user to
each tier (you can fast-path via the DB), verify **client AND server**:

- [ ] **Listing caps** (`TIER_LISTING_CAPS`): enthusiast 40 / vendor 150 /
      shop unlimited. Try to exceed the cap — client should block via
      `canCreateListing()`, and the **server trigger `enforce_listing_cap`**
      should reject the INSERT even if you bypass the UI.
- [ ] **Enthusiast = TCG singles only**: attempt to list a sealed product and a
      non-TCG product as enthusiast → blocked client-side (`canListSealed()` /
      `canListNonTCG()`) AND server-side (same trigger).
- [ ] **Vendor+ unlocks**: sealed + non-TCG listing, product scanner, per-unit
      metadata, shop inventory tab all appear.
- [ ] **Free / collector cannot sell**: no marketplace listing path, and any
      direct attempt is rejected.

---

## Phase 3 — Connect Express onboarding (seller side)

Endpoints: `connect-onboard.js`, `connect-status.js`, webhook `account.updated`
(line ~381). This is the "Phase 2" work that makes destination charges fire for
real instead of landing on the platform account.

- [ ] As the **seller** account, start Connect onboarding → completes the
      Stripe-hosted Express flow using **test data** (Appendix C).
- [ ] Confirm `account.updated` fires and `profiles.stripe_connect_account_id`
      gets populated for that seller.
- [ ] Hit `connect-status.js` → reports the account as charges-enabled /
      payouts-enabled.
- [ ] Re-open onboarding for an already-connected seller → it **reuses** the
      existing account (no duplicate).

---

## Phase 4 — Marketplace checkout (destination charges)

Endpoint: `marketplace-checkout.js`. Money math:
`platformFee = sellerCommission + BUYER_PROCESSING_FEE_CENTS(30)` →
sent as `application_fee_amount`; `transfer_data.destination` = seller's
connect id **when present**.

Run a purchase as the **buyer** against the **seller's** listing, once per
seller tier:

- [ ] **Enthusiast seller (8%)**: buy a $X listing. Verify in Stripe:
      `application_fee_amount == round(X * 0.08) + 30¢`, remainder routed to the
      seller's connected account via `transfer_data.destination`.
- [ ] **Vendor seller (7%)**: same check at 7% + 30¢.
- [ ] **Shop seller (6%)**: same check at 6% + 30¢.
- [ ] **Buyer-facing total**: item price + the 30¢ processing line item — confirm
      the buyer sees/pays exactly that.
- [ ] **No-Connect fallback**: with a seller who has **no**
      `stripe_connect_account_id`, confirm the charge lands on the **platform**
      account (no `transfer_data`) and is flagged for manual payout — per the
      eBay/Mercari model, **no escrow language anywhere**.
- [ ] Confirm `checkout.session.completed` for the marketplace charge updates
      the **order** row to `paid`.

---

## Phase 5 — Order lifecycle + inventory bookkeeping

Status flow: `pending_payment → paid → shipped → completed`
(+ `cancelled / disputed / return_requested / refunded`).

- [ ] `pending_payment` on order creation, → `paid` after the webhook.
- [ ] Seller adds tracking (`saveTracking`) → order `shipped`; confirm
      `_invOnListingShipped` decrements `listed_online_qty` **and** `quantity`.
- [ ] Buyer **"Mark Received"** → `paid`→`completed`, adds card to buyer's
      binder, opens rate-seller modal. **Confirm this moves NO money** (it's UX
      only — not a payout gate).
- [ ] Listing create → `_invOnListingCreated` moves N from `on_shelf_qty` →
      `listed_online_qty`. Deactivate listing → `_invOnListingReleased` reverses.
- [ ] Invariant holds throughout: `on_shelf_qty + listed_online_qty <= quantity`.

---

## Phase 6 — Refunds & disputes

Endpoints: `refund-order.js` (admin), `seller-refund.js` (seller); webhooks
`charge.refunded` (~414), `charge.dispute.created` (~402), `charge.dispute.closed` (~405).

- [ ] **Admin refund**: refund a paid test order via `refund-order.js` →
      `charge.refunded` fires → order → `refunded`.
- [ ] **Seller refund**: same via `seller-refund.js`; confirm permissions (only
      the seller/admin can trigger it).
- [ ] **Partial refund** (if supported): amounts reconcile.
- [ ] **Dispute opened**: buy with the dispute test card `4000 0000 0000 0259`
      (or `stripe trigger charge.dispute.created`) → order → `disputed`; confirm
      this rides the standard chargeback flow, **not** a custodial hold.
- [ ] **Dispute closed**: `stripe trigger charge.dispute.closed` → order state
      resolves correctly (won vs lost).
- [ ] **Return requested**: exercise the `return_requested` branch end-to-end.

---

## Phase 7 — Edge cases & failure modes

- [ ] **Declined card** `4000 0000 0000 0002` → graceful error, no order created,
      no tier granted.
- [ ] **Insufficient funds** `4000 0000 0000 9995` → same.
- [ ] **3-D Secure required** `4000 0027 6000 3184` → auth challenge completes,
      then succeeds.
- [ ] **Webhook signature failure**: send a bogus payload → `stripe-webhook.js`
      rejects it (400), no DB mutation. (Never trust an unsigned event.)
- [ ] **Idempotency / double-fire**: replay the same `checkout.session.completed`
      → tier/order is **not** applied twice.
- [ ] **Listing cap race**: try to exceed the cap via two near-simultaneous
      inserts → server trigger still holds the line.
- [ ] **Buy your own listing** → blocked.
- [ ] **Buy an already-sold / inactive listing** → blocked, clean message.
- [ ] **Double-submit checkout** (rapid double-click) → one charge, not two.

---

## Phase 8 — Reconciliation (the money has to add up)

For 2–3 completed marketplace orders, reconcile in the Stripe test dashboard:

- [ ] `buyer paid` == item price + 30¢ processing.
- [ ] `application_fee_amount` == tier-% of item + 30¢.
- [ ] `seller transfer/payout` == buyer paid − application_fee − Stripe's own
      processing fee. (Stripe's ~2.9%+30¢ comes off Stripe's side; make sure
      your fee model doesn't accidentally double-charge the buyer for it.)
- [ ] Subscription invoices: amount == displayed tier price, on the right cadence.
- [ ] Spot-check that **MRR math** (paid subs only, beta testers excluded)
      matches what the admin dashboard reports.

---

## Appendix A — Stripe test cards

| Scenario | Number |
|---|---|
| Success | `4242 4242 4242 4242` |
| Generic decline | `4000 0000 0000 0002` |
| Insufficient funds | `4000 0000 0000 9995` |
| 3-D Secure required | `4000 0027 6000 3184` |
| Dispute / chargeback | `4000 0000 0000 0259` |
| Attaches, fails on renewal | `4000 0000 0000 0341` |

Any future expiry, any CVC, any ZIP.

## Appendix B — Webhook → expected DB effect (verify each)

| Event | Expected effect |
|---|---|
| `checkout.session.completed` | sub: set `subscription_tier`; marketplace: order → `paid` |
| `customer.subscription.updated` | tier moves up/down |
| `customer.subscription.deleted` | tier → free (per your cancel policy) |
| `invoice.payment_succeeded` | subscription stays active |
| `invoice.payment_failed` | dunning / grace / downgrade (your choice) |
| `account.updated` | populate `stripe_connect_account_id`, enable seller |
| `charge.refunded` | order → `refunded` |
| `charge.dispute.created` | order → `disputed` |
| `charge.dispute.closed` | resolve won/lost |

## Appendix C — Connect test onboarding data

In **test mode** the Express form accepts:
- Test SSN last 4: `0000` — full SSN `000-00-0000`
- Test EIN: `00-0000000`
- Test routing #: `110000000` — account #: `000123456789`
- Use any test address; any DOB making the person 18+.

This is why the real SOS license / EIN doesn't block testing — only the LIVE
switch needs the real numbers.

---

### Suggested order for the morning
0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. If short on time, **Phases 1, 4, and the
webhook column in Appendix B are the non-negotiable core** — subscriptions in,
marketplace money out, and the webhooks that glue Stripe to your database.
