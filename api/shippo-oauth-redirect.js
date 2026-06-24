// api/shippo-oauth-redirect.js
// Phase 2 — Shippo OAuth callback. Shippo redirects the seller here with
// ?code=…&state=… (or ?error=…). We validate state, exchange the code for the
// seller's access token, store it on their profile, then bounce back to the app.
//
// Reached via the vercel rewrite: /shippo-oauth-redirect[/] -> this function.
// (Shippo must have this exact callback URL whitelisted on the partner account.)
//
// Required env vars (Vercel):
//   SHIPPO_OAUTH_CLIENT_ID, SHIPPO_OAUTH_CLIENT_SECRET
//   NEXT_PUBLIC_SITE_URL
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async function handler(req, res) {
  const site = (process.env.NEXT_PUBLIC_SITE_URL || 'https://pathbinder.gg').replace(/\/+$/, '');
  const q = req.query || {};
  const back = (params) => res.redirect(302, site + '/?page=account&' + params);
  const fail = (reason) => back('shippo=error&reason=' + encodeURIComponent(reason));

  if (q.error) return fail(q.error_description || q.error);
  const code = q.code;
  const state = q.state;
  if (!code || !state) return fail('missing_code_or_state');

  // Validate + consume the state (CSRF protection + maps to the user).
  const { data: row } = await sb.from('shippo_oauth_states')
    .select('user_id').eq('state', state).maybeSingle();
  if (!row) return fail('invalid_state');
  await sb.from('shippo_oauth_states').delete().eq('state', state);

  const clientId = process.env.SHIPPO_OAUTH_CLIENT_ID;
  const clientSecret = process.env.SHIPPO_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail('not_configured');

  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      grant_type: 'authorization_code',
    });
    const r = await fetch('https://goshippo.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      console.error('[shippo-oauth] token exchange failed:', r.status, j);
      return fail(j.error_description || j.error || 'token_exchange_failed');
    }

    const { error: upErr } = await sb.from('profiles').update({
      shippo_oauth_token: j.access_token,
      shippo_connected_at: new Date().toISOString(),
    }).eq('id', row.user_id);
    if (upErr) { console.error('[shippo-oauth] profile update failed:', upErr.message); return fail('save_failed'); }

    return back('shippo=connected');
  } catch (e) {
    console.error('[shippo-oauth] exception:', e && e.message);
    return fail('exception');
  }
};
