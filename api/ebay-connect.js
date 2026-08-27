// api/ebay-connect.js
// Begins the eBay OAuth connect flow for the logged-in seller. Mirrors
// shippo-oauth-start: verify the Supabase JWT, mint a CSRF `state` mapped to the
// user, and return the eBay consent URL for the client to redirect to. eBay
// then calls back to /api/ebay-callback.
//
// Env: EBAY_APP_ID, EBAY_CERT_ID, EBAY_RU_NAME, EBAY_ENV, SUPABASE_URL,
//      SUPABASE_SERVICE_KEY. Dormant (503) until the eBay keys are set.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const ebay = require('./_lib/ebay');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!ebay.isConfigured()) {
    return res.status(503).json({ error: 'eBay connect isn\'t configured yet', code: 'NOT_CONFIGURED' });
  }

  const jwt = (req.headers.authorization || '').replace('Bearer ', '');
  if (!jwt) return res.status(401).json({ error: 'Authentication required' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  const state = crypto.randomBytes(24).toString('hex');
  const { error: insErr } = await sb.from('ebay_oauth_states').insert({ state, user_id: user.id });
  if (insErr) return res.status(500).json({ error: 'Could not start OAuth: ' + insErr.message });

  return res.status(200).json({ url: ebay.authorizeUrl(state) });
};
