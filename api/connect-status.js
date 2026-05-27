// api/connect-status.js
//
// Returns (and re-syncs) the seller's Stripe Connect Express status. The
// webhook (account.updated) is the primary path for keeping
// profiles.stripe_connect_* in sync, but webhooks can lag or get dropped,
// and the Account page wants to show authoritative state the moment the
// seller returns from onboarding. This endpoint pulls live state from
// Stripe and writes it back to profiles.
//
// REQUIRED ENV:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// REQUEST:
//   GET  /api/connect-status   (auth required)
//   POST /api/connect-status   (same — POST so the client can use the
//                               same fetch() pattern as other endpoints)
//   headers: Authorization: Bearer <supabase-jwt>
//
// RESPONSE:
//   200 {
//     accountId,                    // null if onboarding never started
//     chargesEnabled,
//     payoutsEnabled,
//     detailsSubmitted,
//     requirements: { currently_due, past_due, pending_verification, disabled_reason },
//     payoutsToBank,                // boolean — has at least one external_account?
//     dashboardUrl,                 // Express dashboard link for the seller
//   }
//   401 / 404 / 500 as appropriate

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth ────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || !token.startsWith('eyJ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  // ── Pull the stored account id ──────────────────────────────────────
  const { data: profile, error: profErr } = await sb
    .from('profiles')
    .select('stripe_connect_account_id')
    .eq('id', user.id)
    .maybeSingle();
  if (profErr) return res.status(500).json({ error: 'Profile lookup failed' });

  const accountId = profile && profile.stripe_connect_account_id;
  if (!accountId) {
    // Not onboarded — return a "blank" status object instead of 404 so the
    // client can render the "Connect your Stripe account" CTA without an
    // error path.
    return res.status(200).json({
      accountId:        null,
      chargesEnabled:   false,
      payoutsEnabled:   false,
      detailsSubmitted: false,
      requirements:     null,
      payoutsToBank:    false,
      dashboardUrl:     null,
    });
  }

  try {
    const account = await stripe.accounts.retrieve(accountId);

    const chargesEnabled   = !!account.charges_enabled;
    const payoutsEnabled   = !!account.payouts_enabled;
    const detailsSubmitted = !!account.details_submitted;
    const requirements     = account.requirements || {};
    const payoutsToBank    = !!(account.external_accounts &&
                                account.external_accounts.data &&
                                account.external_accounts.data.length);

    // Persist back to profiles. If the user just finished onboarding, this
    // is the moment stripe_connect_onboarded_at gets a timestamp.
    const patch = {
      stripe_connect_charges_enabled:   chargesEnabled,
      stripe_connect_payouts_enabled:   payoutsEnabled,
      stripe_connect_details_submitted: detailsSubmitted,
      stripe_connect_requirements:      {
        currently_due:         requirements.currently_due         || [],
        past_due:              requirements.past_due              || [],
        pending_verification:  requirements.pending_verification  || [],
        disabled_reason:       requirements.disabled_reason       || null,
      },
      stripe_connect_synced_at: new Date().toISOString(),
    };
    // Only stamp onboarded_at the first time details_submitted flips true.
    if (detailsSubmitted) {
      patch.stripe_connect_onboarded_at = new Date().toISOString();
    }
    // Update is best-effort; failing to persist doesn't change what we
    // return to the client (the live Stripe state is the source of truth
    // for this single request — the webhook will catch up later).
    await sb.from('profiles').update(patch).eq('id', user.id);

    // Express dashboard link — short-lived, so we mint a fresh one per call
    // rather than caching. Sellers click this from the Account page to view
    // payouts, transactions, and update banking info.
    let dashboardUrl = null;
    try {
      const login = await stripe.accounts.createLoginLink(accountId);
      dashboardUrl = login.url;
    } catch (e) {
      // Login links require the account to be onboarded. Not an error worth
      // bubbling — just leave dashboardUrl null and let the UI hide the button.
      dashboardUrl = null;
    }

    return res.status(200).json({
      accountId,
      chargesEnabled,
      payoutsEnabled,
      detailsSubmitted,
      requirements: patch.stripe_connect_requirements,
      payoutsToBank,
      dashboardUrl,
    });
  } catch (e) {
    console.error('[connect-status] stripe error:', e);
    return res.status(500).json({ error: e.message || 'Stripe lookup failed' });
  }
};
