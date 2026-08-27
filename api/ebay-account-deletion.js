// api/ebay-account-deletion.js
// eBay "Marketplace Account Deletion/Closure" notification endpoint.
//
// eBay REQUIRES every app that stores eBay user data to expose this before it
// will activate a PRODUCTION keyset. Two jobs:
//
//   1. GET  ?challenge_code=... — endpoint validation. eBay hits this when you
//      save the endpoint URL in the developer portal. We must reply 200 with
//      { "challengeResponse": sha256hex(challengeCode + verificationToken + endpoint) }.
//      The hash inputs must be in THAT order, and `endpoint` must EXACTLY match
//      the URL registered with eBay (set EBAY_ACCOUNT_DELETION_ENDPOINT to it).
//
//   2. POST — an actual account-deletion/closure notification. We acknowledge
//      with 200 and best-effort delete any stored eBay tokens/links for that
//      eBay user (honoring their deletion). eBay retries on non-200, so always
//      return 200 once received.
//
// Env (Vercel):
//   EBAY_VERIFICATION_TOKEN            — a secret 32–80 char [A-Za-z0-9_-] string;
//                                        set the SAME value here and in eBay's portal.
//   EBAY_ACCOUNT_DELETION_ENDPOINT     — the exact public URL of THIS endpoint,
//                                        e.g. https://pathbinder.gg/api/ebay-account-deletion
//                                        (must match the portal exactly; falls back
//                                        to reconstructing from the request host).
//   SUPABASE_URL, SUPABASE_SERVICE_KEY — for the best-effort token cleanup.

const crypto = require('crypto');

function _endpointUrl(req) {
  if (process.env.EBAY_ACCOUNT_DELETION_ENDPOINT) return process.env.EBAY_ACCOUNT_DELETION_ENDPOINT;
  // Fallback — reconstruct from the request. Set the env var to avoid any
  // host/proxy mismatch, since the hash must match eBay's copy of the URL.
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const path = (req.url || '/api/ebay-account-deletion').split('?')[0];
  return 'https://' + host + path;
}

module.exports = async function handler(req, res) {
  const verificationToken = process.env.EBAY_VERIFICATION_TOKEN;

  // ── 1. Endpoint validation challenge ────────────────────────────────────
  if (req.method === 'GET') {
    const challengeCode = (req.query && req.query.challenge_code) || '';
    if (!challengeCode) return res.status(400).json({ error: 'missing challenge_code' });
    if (!verificationToken) {
      console.error('[ebay-del] EBAY_VERIFICATION_TOKEN not set');
      return res.status(500).json({ error: 'server not configured' });
    }
    const endpoint = _endpointUrl(req);
    const hash = crypto.createHash('sha256');
    hash.update(challengeCode);
    hash.update(verificationToken);
    hash.update(endpoint);
    const challengeResponse = hash.digest('hex');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ challengeResponse });
  }

  // ── 2. Actual account-deletion notification ─────────────────────────────
  if (req.method === 'POST') {
    // Acknowledge fast; do the cleanup best-effort. eBay only needs a 200.
    try {
      const body = req.body || {};
      const data = (body.notification && body.notification.data) || {};
      const username = data.username || null;
      const userId   = data.userId || null;

      if ((username || userId) && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
        const { createClient } = require('@supabase/supabase-js');
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        // ebay_user_id may hold either the username or the numeric user id
        // depending on what we captured at connect time — match either.
        const ors = [];
        if (username) ors.push('ebay_user_id.eq.' + username);
        if (userId)   ors.push('ebay_user_id.eq.' + userId);
        const del = await sb.from('ebay_connections').delete().or(ors.join(','));
        if (del.error) console.warn('[ebay-del] cleanup error:', del.error.message);
      }
    } catch (e) {
      console.warn('[ebay-del] notification handling error:', e && e.message);
    }
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
};
