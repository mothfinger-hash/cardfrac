// ── Signup-country stamp ────────────────────────────────────────────────
//
// Writes profiles.signup_country from Vercel's edge geo header
// (x-vercel-ip-country) ONCE per account. JWT-gated: same Supabase
// service-key pattern as vision-ocr.js / marketplace-checkout.js.
//
// Why a server endpoint: the client signup (sb.auth.signUp / signInWithOtp)
// talks to Supabase directly and never hits a Vercel function, so the only
// place the end-user's edge-geo header is visible is a request that lands on
// Vercel. The client calls THIS endpoint once after sign-in; Vercel injects
// x-vercel-ip-country for that request, and we persist the country.
//
// Write-once: we only set the column when it is still NULL, so a genuine
// signup-origin country is never overwritten by a later login from a
// different place. Reading/writing is server-side (service key) so the
// value can't be spoofed from the browser.
//
// REQUIRED ENV: SUPABASE_URL + SUPABASE_SERVICE_KEY (same vars the
// marketplace endpoints already use).
//
// CLIENT REQUEST:
//   POST /api/stamp-geo       (Authorization: Bearer <access_token>)
//   response: { country: "US", stamped: true|false }
//
// Non-fatal by design: this is analytics, never block the app over it —
// any failure returns 200 with stamped:false.

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  // Auth gate — only a real session may stamp its own profile.
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token || !token.startsWith('eyJ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }

  // Vercel injects this at the edge for the end-user's request. Absent in
  // local dev or if geo can't be resolved -> null (harmless no-op).
  const country = String(req.headers['x-vercel-ip-country'] || '').toUpperCase() || null;
  if (!country) {
    res.status(200).json({ country: null, stamped: false, note: 'no edge-geo header' });
    return;
  }

  try {
    // Write-once: only rows where signup_country IS NULL are touched.
    const { data, error } = await sb
      .from('profiles')
      .update({ signup_country: country })
      .eq('id', user.id)
      .is('signup_country', null)
      .select('id');
    if (error) throw error;
    res.status(200).json({ country, stamped: Array.isArray(data) && data.length > 0 });
  } catch (e) {
    // Graceful if the column isn't migrated yet, or any other DB hiccup.
    console.error('[stamp-geo]', e && e.message);
    res.status(200).json({ country, stamped: false, note: 'not stored' });
  }
};
