// api/delete-account.js
//
// Self-service account deletion (App Store Guideline 5.1.1(v) — required
// for any app that creates accounts).
//
// Two actions, picked by request body:
//   { action: 'request' }  → start the 30-day grace period
//   { action: 'cancel'  }  → user changed their mind during the grace
//
// What "request" does:
//   1. Stamps profiles.deletion_requested_at = now(),
//      profiles.deletion_scheduled_for = now() + 30 days.
//   2. Cancels any active Stripe subscription at period end (so they
//      don't get billed again during the grace, but keep the features
//      they paid for).
//   3. Deactivates active marketplace listings so nobody can buy from
//      an account that's about to vanish.
//   4. Returns the scheduled date so the client can show it.
//
// What "cancel" does:
//   Clears deletion_requested_at + deletion_scheduled_for. We don't
//   automatically resume the cancelled subscription — that's the user's
//   call via the pricing modal.
//
// The HARD purge (PII strip + auth.users delete) runs separately via a
// daily sweep job — see purge_user_profile() in
// migration_account_deletion.sql. Keeping the purge out of the request
// path means an accidental click is always recoverable for 30 days.
//
// REQUIRED ENV:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// REQUEST:
//   POST /api/delete-account
//   headers: Authorization: Bearer <supabase-jwt>
//   body:    { action: 'request' | 'cancel' }
//
// RESPONSE:
//   200 { ok: true, scheduledFor?: ISO-8601 }
//   400 { error } on bad input
//   401 { error } on auth failure
//   500 { error } on DB / Stripe failure

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const GRACE_DAYS = 30;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth ────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || !token.startsWith('eyJ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  // Parse body — Vercel handles JSON, but be defensive in case the client
  // sent a string.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const action = (body && body.action) || '';

  if (action === 'cancel') {
    // ── Cancel pending deletion ────────────────────────────────────────
    const { error } = await sb.from('profiles').update({
      deletion_requested_at:  null,
      deletion_scheduled_for: null,
    }).eq('id', user.id);
    if (error) {
      console.error('[delete-account] cancel failed:', error.message);
      return res.status(500).json({ error: 'Could not cancel deletion' });
    }
    return res.status(200).json({ ok: true });
  }

  if (action !== 'request') {
    return res.status(400).json({ error: 'action must be "request" or "cancel"' });
  }

  // ── Request deletion ──────────────────────────────────────────────────
  const now = new Date();
  const scheduledFor = new Date(now.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);

  // Pull the profile to see if there's a Stripe subscription to cancel.
  // We do this BEFORE the update so a Stripe failure doesn't leave the
  // user in a half-state.
  const { data: profile, error: profErr } = await sb
    .from('profiles')
    .select('stripe_subscription_id')
    .eq('id', user.id)
    .maybeSingle();
  if (profErr) {
    console.error('[delete-account] profile lookup failed:', profErr.message);
    return res.status(500).json({ error: 'Profile lookup failed' });
  }

  // Cancel the subscription at period end so the user keeps the tier
  // they paid for through the end of the cycle (matches the rest of our
  // downgrade UX — see CLAUDE.md "downgrades keep tier through period
  // end"). Failure here is logged but non-fatal — the deletion proceeds.
  if (profile && profile.stripe_subscription_id) {
    try {
      await stripe.subscriptions.update(profile.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
    } catch (e) {
      console.warn('[delete-account] subscription cancel failed (non-fatal):', e.message);
    }
  }

  // Persist the deletion stamps + flip listing visibility off in the same
  // transaction-ish window. Two separate updates because the service-role
  // client doesn't expose a transaction wrapper — the second is a
  // best-effort cleanup; the first is what matters for App Store compliance.
  const { error: updErr } = await sb.from('profiles').update({
    deletion_requested_at:  now.toISOString(),
    deletion_scheduled_for: scheduledFor.toISOString(),
  }).eq('id', user.id);
  if (updErr) {
    console.error('[delete-account] profile update failed:', updErr.message);
    return res.status(500).json({ error: 'Could not mark account for deletion' });
  }

  // Pull active listings off the market so nobody buys from a soon-to-be-
  // deleted seller. Sold listings stay as-is for the buyer's history.
  await sb
    .from('listings')
    .update({ status: 'deactivated' })
    .eq('seller_id', user.id)
    .in('status', ['active', 'available']);

  return res.status(200).json({
    ok: true,
    scheduledFor: scheduledFor.toISOString(),
  });
};
