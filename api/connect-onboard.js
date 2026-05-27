// api/connect-onboard.js
//
// Starts (or resumes) a Stripe Connect Express onboarding session for
// the authenticated seller and returns the hosted-onboarding URL. The
// client redirects the user to that URL; when they finish, Stripe
// bounces them back to the return_url with their account fully (or
// partially) onboarded.
//
// FLOW:
//   1. Client POSTs { returnUrl, refreshUrl } with the seller's JWT
//      in Authorization: Bearer <token>.
//   2. We look up profiles.stripe_connect_account_id — if present, reuse
//      it; otherwise call stripe.accounts.create({ type: 'express', ... })
//      and persist the new account id.
//   3. Call stripe.accountLinks.create({ account, type: 'account_onboarding',
//      return_url, refresh_url }) and return the link.url.
//
// REQUIRED ENV (Vercel):
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   NEXT_PUBLIC_SITE_URL  — fallback origin for default return/refresh URLs
//
// REQUEST:
//   POST /api/connect-onboard
//   headers: Authorization: Bearer <supabase-jwt>
//   body:    { returnUrl?: string, refreshUrl?: string }
//
// RESPONSE:
//   200 { url: 'https://connect.stripe.com/setup/e/acct_…/<token>',
//         accountId: 'acct_…' }
//   401 { error } on auth failure
//   403 { error } when the user's tier isn't allowed to sell
//   500 { error } on Stripe / DB failure

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Tiers that are allowed to sell on the marketplace. Matches the client
// check inside openListCardModal() — keep these in sync.
const SELLER_TIERS = new Set(['enthusiast', 'vendor', 'shop']);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  }

  // ── Auth ────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || !token.startsWith('eyJ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  // ── Tier gate ───────────────────────────────────────────────────────
  // Don't waste a Stripe account on a user who can't sell. Pull tier + any
  // existing Connect account id in one round trip.
  const { data: profile, error: profErr } = await sb
    .from('profiles')
    .select('subscription_tier, is_vendor, is_premium, is_admin, stripe_connect_account_id, email')
    .eq('id', user.id)
    .maybeSingle();
  if (profErr || !profile) {
    return res.status(500).json({ error: 'Profile lookup failed' });
  }

  // Same tier-resolution fallback chain as userTier() on the client.
  let tier = (profile.subscription_tier || '').toLowerCase();
  if (!tier) {
    if (profile.is_admin)   tier = 'shop';
    else if (profile.is_vendor)  tier = 'enthusiast';
    else if (profile.is_premium) tier = 'collector';
    else                          tier = 'free';
  }
  if (!SELLER_TIERS.has(tier)) {
    return res.status(403).json({
      error: 'Marketplace selling requires Enthusiast tier or higher',
      tier,
    });
  }

  // ── Reuse existing account if we already created one ────────────────
  let accountId = profile.stripe_connect_account_id || null;

  try {
    if (!accountId) {
      // Express account — Stripe-hosted onboarding + dashboard. We pre-fill
      // the email so the seller doesn't have to retype it. Email is the only
      // PII we send; everything else (legal name, DOB, SSN-4, bank acct) is
      // collected by Stripe directly so we never see it.
      //
      // capabilities: card_payments + transfers are the two we need for
      // destination charges. Stripe will gate them behind the requirements
      // it collects during onboarding.
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US', // tighten later when we expand
        email: profile.email || user.email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers:     { requested: true },
        },
        business_type: 'individual', // sellers can override during onboarding
        metadata: {
          pathbinder_user_id: user.id,
          tier_at_create:     tier,
        },
      });

      accountId = account.id;

      // Persist immediately — if the next call (accountLinks.create) fails
      // we still want the account id on the profile so the next attempt
      // reuses it instead of creating a duplicate Stripe account.
      const { error: updErr } = await sb
        .from('profiles')
        .update({
          stripe_connect_account_id: accountId,
          stripe_connect_synced_at:  new Date().toISOString(),
        })
        .eq('id', user.id);
      if (updErr) {
        console.error('[connect-onboard] profile update failed:', updErr.message);
        // Non-fatal — proceed to give the user a working onboarding link;
        // we'll back-sync via the webhook handler later.
      }
    }

    // ── Onboarding link ──────────────────────────────────────────────
    const origin =
      (req.body && req.body.returnUrl  ? new URL(req.body.returnUrl ).origin : null) ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      'https://pathbinder.gg';

    const returnUrl  = (req.body && req.body.returnUrl)  || (origin + '/?connect=success');
    const refreshUrl = (req.body && req.body.refreshUrl) || (origin + '/?connect=refresh');

    const link = await stripe.accountLinks.create({
      account:     accountId,
      type:        'account_onboarding',
      return_url:  returnUrl,
      refresh_url: refreshUrl,
      // collect: 'eventually_due' would let the seller skip future-required
      // fields. We use 'currently_due' (the default) to push them through
      // everything Stripe wants right now — fewer "your account needs
      // attention" emails down the line.
    });

    return res.status(200).json({ url: link.url, accountId });
  } catch (e) {
    console.error('[connect-onboard] stripe error:', e);
    return res.status(500).json({ error: e.message || 'Stripe Connect onboarding failed' });
  }
};
