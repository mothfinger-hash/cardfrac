// api/ebay-callback.js
// eBay OAuth callback. eBay redirects the seller here with ?code=…&state=…
// (or ?error=…). Validate + consume state, exchange the code for the seller's
// refresh + access tokens, store them (service-role) in ebay_connections, then
// bounce back to the app. Mirrors shippo-oauth-redirect.
//
// The RuName's "accepted URL" in the eBay developer portal must point at this
// endpoint: https://pathbinder.gg/api/ebay-callback
//
// Env: EBAY_APP_ID, EBAY_CERT_ID, EBAY_RU_NAME, EBAY_ENV, NEXT_PUBLIC_SITE_URL,
//      SUPABASE_URL, SUPABASE_SERVICE_KEY.

const { createClient } = require('@supabase/supabase-js');
const ebay = require('./_lib/ebay');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async function handler(req, res) {
  const site = (process.env.NEXT_PUBLIC_SITE_URL || 'https://pathbinder.gg').replace(/\/+$/, '');
  const q = req.query || {};
  const back = (params) => res.redirect(302, site + '/?page=account&' + params);
  const fail = (reason) => back('ebay=error&reason=' + encodeURIComponent(reason));

  if (q.error) return fail(q.error_description || q.error);
  const code = q.code;
  const state = q.state;
  if (!code || !state) return fail('missing_code_or_state');

  // Validate + consume the state (CSRF protection + maps to the user).
  const { data: row } = await sb.from('ebay_oauth_states')
    .select('user_id').eq('state', state).maybeSingle();
  if (!row) return fail('invalid_state');
  await sb.from('ebay_oauth_states').delete().eq('state', state);

  if (!ebay.isConfigured()) return fail('not_configured');

  try {
    const t = await ebay.exchangeCodeForToken(code);
    if (!t.ok || !t.data || !t.data.refresh_token) {
      console.error('[ebay-oauth] token exchange failed:', t.status, t.data);
      return fail((t.data && (t.data.error_description || t.data.error)) || 'token_exchange_failed');
    }

    const accessExp = new Date(Date.now() + (Number(t.data.expires_in || 7200) * 1000)).toISOString();
    const { error: upErr } = await sb.from('ebay_connections').upsert({
      user_id:          row.user_id,
      refresh_token:    t.data.refresh_token,
      access_token:     t.data.access_token || null,
      token_expires_at: accessExp,
      scopes:           ebay.SCOPES,
      status:           'active',
      last_error:       null,
      connected_at:     new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (upErr) { console.error('[ebay-oauth] save failed:', upErr.message); return fail('save_failed'); }

    return back('ebay=connected');
  } catch (e) {
    console.error('[ebay-oauth] exception:', e && e.message);
    return fail('exception');
  }
};
