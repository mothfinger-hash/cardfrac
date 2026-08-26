// api/expire-grants-cron.js
// Daily sweep that reverts EXPIRED granted tiers back to Free — both the
// activation trial ("50 cards → 1 free month of Enthusiast") and friend-invite
// (subsidiary_invite) grants. This is the ONLY thing that ends a temporary
// grant; without it a "free month" or an invited friend's tier lasts forever.
//
// The heavy lifting + safety guards live in the RPC (migration_activation_
// trial_and_grant_expiry.sql): it only touches granted_tier_source IN
// ('subsidiary_invite','activation_trial') that are past due, and skips anyone
// with a live Stripe subscription so a mid-grant upgrade is never clobbered.
//
// Env (Vercel): SUPABASE_URL, SUPABASE_SERVICE_KEY, CRON_SECRET (optional).
// Vercel sends `Authorization: Bearer $CRON_SECRET` on scheduled runs; ?secret=
// is accepted for manual testing. Schedule: vercel.json cron at 16:00 UTC.

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const ok = req.headers.authorization === 'Bearer ' + secret
      || String((req.query && req.query.secret) || '') === secret;
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const { data, error } = await sb.rpc('expire_granted_tiers');
    if (error) {
      console.error('[expire-grants-cron] RPC error', error.message);
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ ok: true, downgraded: data || 0 });
  } catch (e) {
    console.error('[expire-grants-cron]', e && e.message);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
