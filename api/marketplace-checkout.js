// api/marketplace-checkout.js
// Creates a Stripe Checkout session for a marketplace card purchase.
//
// PAYMENT MODEL (post-escrow refactor):
//   - Sellers receive funds directly on Stripe's normal payout schedule
//   - PathBinder retains a tiered platform fee via application_fee_amount:
//       Enthusiast tier  -> 7%
//       Vendor tier      -> 6%
//       Shop tier        -> 5%
//       (Free/Collector cannot sell, so they never hit this path.)
//     Lower-tier sellers pay a higher commission because their subscription
//     contribution is smaller; higher-tier sellers pay less per sale because
//     they're already paying more in subscription up front.
//   - Implemented as a Connect "destination charge" — Stripe routes the sale
//     proceeds straight to the seller's connected account, minus the
//     application_fee_amount (platform commission). The platform never takes
//     custody of a third party's funds.
//   - A third-party seller who is NOT Connect-ready (charges_enabled false) is
//     REFUSED at checkout with a 409 — we do NOT fall back to holding their
//     money in the platform account. The only platform-only charges are
//     ADMIN/first-party listings (the platform selling its own inventory and
//     keeping its own proceeds), which is not money transmission.
//
// Required env vars (Vercel dashboard):
//   STRIPE_SECRET_KEY     — from Stripe Dashboard → Developers → API keys
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   NEXT_PUBLIC_SITE_URL  — your Vercel domain, e.g. https://pathbinder.vercel.app

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Server-side mirror of TIER_COMMISSION_RATES in index.html — keep these
// in sync. The client uses it for display ("you'll keep $X of this sale");
// the server uses it as the source of truth for the actual charge.
const TIER_COMMISSION_RATES = {
  free:       0.00,
  collector:  0.00,
  enthusiast: 0.08,
  vendor:     0.07,
  shop:       0.06,
};
// Default rate when the seller's tier is unknown or unset. Matches the
// old flat-rate behavior so legacy/edge cases don't accidentally pay 0%.
const DEFAULT_COMMISSION_RATE = 0.08;

// Buyer-side processing fee (in cents). Charged as a separate line
// item on the Stripe checkout page so the buyer sees it explicitly,
// and folded into application_fee_amount so the money lands in the
// platform account (not the seller's). Covers Stripe's $0.30 per-tx
// floor on cheap items.
//
// History: previously this $0.30 was deducted from the seller's payout
// (folded into the seller commission). We moved it to the buyer side
// so seller tier rates stay clean percentages.
const BUYER_PROCESSING_FEE_CENTS = 30;

function commissionRateFor(tier) {
  if (!tier) return DEFAULT_COMMISSION_RATE;
  const r = TIER_COMMISSION_RATES[String(tier).toLowerCase()];
  return (typeof r === 'number') ? r : DEFAULT_COMMISSION_RATE;
}

// Server mirror of TIER_PRICE_CEILINGS in index.html. Enforced here
// as a hard block — an over-ceiling listing CAN'T be checked out even
// if it somehow exists in the DB. Shop's high ceiling additionally
// requires profiles.verified_high_value=true (verification, not
// payment, unlocks it).
const TIER_PRICE_CEILINGS = {
  free:        0,
  collector:   0,
  enthusiast:  150,
  vendor:      1000,
  shop:        50000,
};
function priceCeilingFor(tier, verifiedHighValue) {
  const base = TIER_PRICE_CEILINGS[tier];
  if (typeof base !== 'number') return 0;
  if (tier === 'shop' && !verifiedHighValue) return TIER_PRICE_CEILINGS.vendor;
  return base;
}

// Buyer risk thresholds — when to force manual capture so Stripe Radar
// gets a look before the card is actually charged. Triggers when a
// brand-new buyer tries to spend real money: a fraud red flag we'd
// rather wait 10 minutes on than refund a week later.
const MANUAL_CAPTURE_NEW_BUYER_THRESHOLD_CENTS = 20000; // $200
const NEW_BUYER_MAX_AGE_DAYS                   = 14;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured. Add it in Vercel → Settings → Environment Variables.' });
  }

  // NOTE: sellerId is deliberately NOT read from the body. Seller identity is
  // derived from the listing row below — trusting a client-supplied sellerId
  // let a crafted checkout aim the readiness gate and payout routing at a
  // different profile than the card's real owner. See the authoritative lookup.
  const { listingId, amount, cardName, successUrl, cancelUrl } = req.body || {};

  if (!listingId || !amount || amount < 100) {
    return res.status(400).json({ error: 'listingId and amount (cents) required' });
  }

  // Verify buyer is authenticated
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || !token.startsWith('eyJ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  // ── Authoritative listing lookup ─────────────────────────────────────
  // SECURITY: seller identity, shipping, and the expected price all come from
  // the LISTING row — never from the request body. The buyer controls only
  // which listing they are buying. (A prior version trusted req.body.sellerId,
  // which let a crafted request point the Connect readiness gate and the
  // destination-charge routing at a DIFFERENT profile than the card's owner —
  // e.g. an admin uuid to slip past the gate, or another seller's uuid to
  // misdirect the payout.)
  let listingRow = null;
  try {
    const { data: lr, error: lrErr } = await sb
      .from('listings')
      .select('seller_id, value, shipping_price, ships_to, status')
      .eq('id', listingId)
      .maybeSingle();
    if (lrErr) throw lrErr;
    listingRow = lr;
  } catch (e) {
    console.error('[marketplace-checkout] listing lookup failed:', e);
    return res.status(503).json({ error: 'Could not verify this listing right now. Please try again in a moment.' });
  }
  if (!listingRow) {
    return res.status(404).json({ error: 'This listing is no longer available.' });
  }
  // Only a live listing can be bought. NULL / 'active' / 'available' = live
  // (matches enforce_listing_cap's notion of a slot-consuming listing).
  if (listingRow.status && !['active', 'available'].includes(String(listingRow.status))) {
    return res.status(409).json({ error: 'This listing is no longer available.' });
  }
  const sellerId = listingRow.seller_id || null;

  // Server-recomputed expected total (card value + shipping) in cents. The
  // buyer processing fee is a separate Stripe line item, so it is excluded
  // here — matching what the client sends as `amount`. Reject UNDERPAYMENT so
  // a crafted request can't buy a $440 card for $1; overpayment (e.g. a stale-
  // high client price) is harmless and allowed through.
  const expectedAmount = Math.round(((Number(listingRow.value) || 0) + (Number(listingRow.shipping_price) || 0)) * 100);
  if (expectedAmount > 0 && amount < expectedAmount) {
    return res.status(400).json({ error: 'Price mismatch — please reopen the listing and try again.' });
  }

  // Look up the SELLER's Stripe Connect account id + subscription tier (drives
  // the commission rate) + verified_high_value (Shop high-ceiling gate), keyed
  // on the authoritative sellerId resolved from the listing above.
  let sellerConnectId = null;
  let sellerTier      = null;
  let sellerVerifiedHighValue = false;
  let sellerIsAdmin   = false;
  if (sellerId) {
    try {
      const { data: profile, error: profErr } = await sb
        .from('profiles')
        .select('stripe_connect_account_id, stripe_connect_charges_enabled, is_admin, subscription_tier, is_vendor, is_premium, verified_high_value, vacation_mode_until')
        .eq('id', sellerId)
        .maybeSingle();
      // A READ error is transient — surface 503 (retryable) rather than
      // silently falling through to the readiness gate, which would 409 and
      // wrongly tell the buyer the SELLER isn't set up. (A genuinely-missing
      // profile leaves `profile` null and correctly reaches the 409.)
      if (profErr) {
        console.error('[marketplace-checkout] seller profile lookup error:', profErr);
        return res.status(503).json({ error: 'Could not verify the seller right now. Please try again in a moment.' });
      }
      if (profile) {
        // Hard block: seller paused their shop. Refuse the checkout
        // so a buyer who sees a stale browse cache can't sneak through.
        if (profile.vacation_mode_until && new Date(profile.vacation_mode_until) > new Date()) {
          return res.status(409).json({
            error: 'This seller has paused their shop. Please try again later.',
          });
        }
        sellerIsAdmin = !!profile.is_admin;
        // Only route a destination charge when the seller can ACTUALLY receive
        // it. The account id is written the instant onboarding STARTS
        // (connect-onboard.js persists it before minting the onboarding link),
        // so id-presence is not readiness — a destination charge to an account
        // whose `transfers` capability is still inactive is rejected by Stripe,
        // and the raw error used to reach the buyer. charges_enabled is the
        // mirrored capability flag (stripe-webhook.js account.updated), true
        // only once Stripe has cleared the account to transact.
        if (profile.stripe_connect_account_id && profile.stripe_connect_charges_enabled) {
          sellerConnectId = profile.stripe_connect_account_id;
        }
        sellerVerifiedHighValue = !!profile.verified_high_value;
        // Prefer the new subscription_tier column; fall back to legacy
        // booleans so sellers who haven't been migrated still get charged
        // a reasonable rate. is_vendor + is_premium were the old
        // "enthusiast equivalent" flags before the tier rename.
        if (profile.subscription_tier) {
          sellerTier = String(profile.subscription_tier).toLowerCase();
        } else if (profile.is_vendor || profile.is_premium) {
          sellerTier = 'enthusiast';
        }
      }
    } catch (_) {
      // Profile lookup failed — leave sellerConnectId null and sellerIsAdmin
      // false so the readiness gate below fails CLOSED. We must not fall back
      // to a platform-only charge for a third-party seller: holding a third
      // party's sale proceeds in the platform account is custodial money
      // transmission (see CLAUDE.md Stripe ToS), regardless of intent to pay
      // out manually later.
    }
  }

  // Readiness gate. A third-party seller MUST have a live Connect account
  // (charges_enabled) before we take a buyer's money — otherwise the funds
  // land in the platform account with no compliant way out. Admins are the
  // one exception: an admin/platform listing is FIRST-PARTY (the platform is
  // the actual merchant keeping its own proceeds), which is not money
  // transmission, so platform-only is legitimate there. This is the load-
  // bearing money-safety check; the client listing gate and the DB trigger
  // are the earlier layers, this is the one that actually guards the charge.
  if (!sellerConnectId && !sellerIsAdmin) {
    return res.status(409).json({
      error: 'This seller has not finished payment setup yet, so their items cannot be purchased right now. Please check back soon.',
    });
  }

  // Per-listing shipping destinations decide which countries the buyer may
  // enter at checkout. Defaults to US-only when the row/column is missing so
  // behavior matches the original hardcoded ['US']. The SUPPORTED allowlist
  // is the hard server-side cap regardless of what the listing row claims —
  // widen it (and the client-side picker) when a new market opens.
  let allowedShipCountries = ['US'];
  if (listingRow && Array.isArray(listingRow.ships_to) && listingRow.ships_to.length) {
    const SUPPORTED = new Set(['US', 'CA', 'JP', 'AU']);
    const codes = listingRow.ships_to
      .map(c => String(c || '').toUpperCase().trim())
      .filter(c => SUPPORTED.has(c));
    allowedShipCountries = Array.from(new Set(['US', ...codes]));
  }

  // Hard block: item price (in dollars) over the seller's tier ceiling.
  // This is the server-side guard that backs up the client-side check
  // in index.html and any DB-trigger enforcement. amount is in cents.
  const ceilingDollars = priceCeilingFor(sellerTier, sellerVerifiedHighValue);
  if (ceilingDollars > 0 && amount > ceilingDollars * 100) {
    return res.status(403).json({
      error: `Listing exceeds the seller's tier price ceiling of $${ceilingDollars}.`,
    });
  }

  const feeRate     = commissionRateFor(sellerTier);
  // Seller commission — percentage of the listing price, no per-tx fee.
  const sellerCommission = Math.round(amount * feeRate);
  // Total platform take = seller commission + the buyer's processing
  // fee. We want the entire processing fee to land in the platform
  // account (not the seller's), which is exactly what
  // application_fee_amount does — Stripe deducts this from the buyer
  // charge before transferring the rest to the seller.
  const platformFee  = sellerCommission + BUYER_PROCESSING_FEE_CENTS;

  // Manual-capture risk gate. Brand-new buyer + high-value order = the
  // single highest-risk combo for friendly-fraud chargebacks (account
  // created today, $400 order, expedited shipping is the classic
  // pattern). Setting capture_method=manual on the underlying
  // PaymentIntent means Stripe AUTHORIZES the card but doesn't actually
  // charge it — gives us up to 7 days to review (or let Radar review)
  // before either capturing or canceling. Standard "secure" Stripe
  // pattern, no special approval needed.
  let isRiskyOrder = false;
  try {
    const buyerProfile = await sb.from('profiles')
      .select('created_at')
      .eq('id', user.id).maybeSingle();
    const ageDays = buyerProfile.data
      ? (Date.now() - new Date(buyerProfile.data.created_at).getTime()) / 86400000
      : 999;
    const priorOrders = await sb.from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('buyer_id', user.id);
    const orderCount = priorOrders.count || 0;
    const isNewBuyer = ageDays < NEW_BUYER_MAX_AGE_DAYS || orderCount === 0;
    if (isNewBuyer && amount >= MANUAL_CAPTURE_NEW_BUYER_THRESHOLD_CENTS) {
      isRiskyOrder = true;
    }
  } catch (e) {
    console.warn('[checkout] risk check failed, defaulting to auto-capture:', e.message);
  }

  const sessionParams = {
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: cardName || 'Trading Card',
            description: 'PathBinder Marketplace Purchase',
          },
          unit_amount: amount,
        },
        quantity: 1,
      },
      // Buyer-side processing fee — surfaces as its own line on the
      // Stripe checkout page ("Processing fee … $0.30") so the buyer
      // sees what they're paying for. Goes to the platform via the
      // application_fee_amount above.
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Processing fee',
            description: 'Per-transaction processing fee',
          },
          unit_amount: BUYER_PROCESSING_FEE_CENTS,
        },
        quantity: 1,
      },
    ],
    metadata: {
      listing_id: listingId,
      buyer_id: user.id,
      seller_id: sellerId || '',
      // Stripe metadata values are stringified — keep the numbers as strings
      // so downstream webhook consumers can parse them unambiguously.
      platform_fee:        String(platformFee),
      platform_fee_pct:    String(feeRate),
      seller_commission:   String(sellerCommission),
      buyer_processing_fee:String(BUYER_PROCESSING_FEE_CENTS),
      seller_tier:         sellerTier || 'unknown',
      risky_order:         isRiskyOrder ? '1' : '0',
      type: 'marketplace_purchase',
      // Track which payment route was used so the webhook can act accordingly.
      payment_route: sellerConnectId ? 'destination_charge' : 'platform_only',
    },
    success_url: successUrl || process.env.NEXT_PUBLIC_SITE_URL + '?payment=success&type=purchase',
    cancel_url: cancelUrl || process.env.NEXT_PUBLIC_SITE_URL + '?payment=cancelled',
    // Collect the buyer's shipping address so the seller can buy a label.
    // Saved onto the order by the webhook (ship_to_* columns). Allowed
    // countries come from the listing's ships_to (US-only default; sellers
    // can opt into Canada, Japan, Australia). Non-US orders ship via the
    // seller's own carrier + manual tracking — Shippo labels are US-domestic.
    shipping_address_collection: { allowed_countries: allowedShipCountries },
    phone_number_collection: { enabled: true },
  };

  // Destination-charge wiring — set only when the seller is Connect-ready
  // (charges_enabled, resolved above). A non-admin seller without this has
  // already been 409'd, so reaching here with no sellerConnectId means an
  // admin/first-party listing charging platform-only, which is intended.
  if (sellerConnectId) {
    sessionParams.payment_intent_data = {
      application_fee_amount: platformFee,
      transfer_data: { destination: sellerConnectId },
    };
  }

  // Manual capture for risky orders. We attach capture_method=manual to
  // the PaymentIntent so the card is AUTHORIZED but not actually
  // charged at checkout — Radar evaluates it, admin can review, and we
  // capture (or release) within Stripe's 7-day auth window. Works in
  // both the destination-charge and platform-only branches.
  if (isRiskyOrder) {
    sessionParams.payment_intent_data = Object.assign(
      {},
      sessionParams.payment_intent_data || {},
      { capture_method: 'manual' }
    );
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ url: session.url, sessionId: session.id });
  } catch(e) {
    // Log the real Stripe error for us; never forward e.message to the buyer.
    // Raw Stripe messages (e.g. an inactive-capability rejection) are confusing
    // at best and information-leaking at worst.
    console.error('[marketplace-checkout] Stripe error:', e);
    return res.status(500).json({ error: 'Could not start checkout. Please try again in a moment.' });
  }
};
