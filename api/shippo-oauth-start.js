// api/shippo-oauth-start.js
// Phase 2 — begins the Shippo OAuth connect flow for the logged-in seller.
// Returns the Shippo authorize URL the client should redirect to. After the
// seller authorizes, Shippo calls back to /shippo-oauth-redirect/.
//
// Required env vars (Vercel):
//   SHIPPO_OAUTH_CLIENT_ID      partner id from Shippo (the "client_id")
//   SHIPPO_OAUTH_UTM_SOURCE     optional app id from Shippo
//   NEXT_PUBLIC_SITE_URL        e.g. https://pathbinder.gg
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//
// Dormant until SHIPPO_OAUTH_CLIENT_ID is set — returns a clean error otherwise.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const clientId = process.env.SHIPPO_OAUTH_CLIENT_ID;
  if (!clientId) return res.status(503).json({ error: 'Shippo Connect isn\'t configured yet', code: 'NOT_CONFIGURED' });

  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace('Bearer ', '');
  if (!jwt) return res.status(401).json({ error: 'Authentication required' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  const state = crypto.randomBytes(24).toString('hex');
  const { error: insErr } = await sb.from('shippo_oauth_states').insert({ state, user_id: user.id });
  if (insErr) return res.status(500).json({ error: 'Could not start OAuth: ' + insErr.message });

  const site = (process.env.NEXT_PUBLIC_SITE_URL || 'https://pathbinder.gg').replace(/\/+$/, '');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: '*',
    state: state,
    redirect_uri: site + '/shippo-oauth-redirect/',
  });
  if (process.env.SHIPPO_OAUTH_UTM_SOURCE) params.set('utm_source', process.env.SHIPPO_OAUTH_UTM_SOURCE);

  return res.status(200).json({ url: 'https://goshippo.com/oauth/authorize?' + params.toString() });
};
