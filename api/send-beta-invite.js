// api/send-beta-invite.js
//
// Sends a beta invitation email via Resend after an admin creates a beta
// invite row. Called from the admin beta panel right after the
// admin_invite_beta RPC succeeds.
//
// REQUEST:
//   POST /api/send-beta-invite
//   headers: Authorization: Bearer <supabase-jwt>   (must be is_admin=true)
//   body:    { email, tier, code, inviteeName? }
//
// RESPONSE:
//   200 { ok: true, emailed: 1 }                   — sent
//   200 { ok: true, emailed: 0, skipped: '...' }   — Resend not configured
//   400 / 401 / 403 / 500 { error } on auth or input failure
//
// REQUIRED ENV (same as admin-notify-dispute):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   RESEND_API_KEY
//   RESEND_FROM          — verified sender, e.g. 'PathBinder <invites@pathbinder.gg>'

const { createClient } = require('@supabase/supabase-js');
const { TIER_COPY, renderEmailHtml, renderEmailText } = require('./_lib/beta-invite-template');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);


// (TIER_COPY, renderEmailHtml, renderEmailText all live in
//  api/_lib/beta-invite-template.js — imported above. Single source of
//  truth so preview_beta_emails.js stays in sync with what gets sent.)

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.RESEND_FROM;
  if (!apiKey || !from) return { ok: false, reason: 'resend_not_configured' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[send-beta-invite] Resend error:', r.status, detail.slice(0, 300));
      return { ok: false, reason: 'resend_http_' + r.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('[send-beta-invite] Resend exception:', e);
    return { ok: false, reason: 'resend_exception' };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth: admin only ───────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || !token.startsWith('eyJ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  const { data: prof } = await sb
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .maybeSingle();
  if (!prof || !prof.is_admin) {
    return res.status(403).json({ error: 'Admin only' });
  }

  // ── Parse body ──────────────────────────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const { email, tier, code, inviteeName } = body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (!code) {
    return res.status(400).json({ error: 'Invite code required' });
  }
  if (!TIER_COPY[tier]) {
    return res.status(400).json({ error: 'Invalid tier: ' + tier });
  }

  const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL || 'https://pathbinder.gg';
  const tierCopy = TIER_COPY[tier];
  const subject = '[PathBinder] You\'re invited to the ' + tierCopy.title;

  const result = await sendEmail({
    to:      email,
    subject: subject,
    html:    renderEmailHtml({ email, tier, code, inviteeName, siteOrigin }),
    text:    renderEmailText({ email, tier, code, inviteeName, siteOrigin }),
  });

  if (result.ok) {
    return res.status(200).json({ ok: true, emailed: 1 });
  }
  return res.status(200).json({ ok: true, emailed: 0, skipped: result.reason });
};
