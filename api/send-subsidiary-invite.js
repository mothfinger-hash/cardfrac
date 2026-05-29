// api/send-subsidiary-invite.js
//
// Sends a subsidiary beta-invite email on behalf of a beta tester
// who's already generated a code via the create_subsidiary_invite
// RPC. The frontend dashboard panel calls this endpoint after the
// user types in their friend's email + clicks Send.
//
// REQUEST:
//   POST /api/send-subsidiary-invite
//   headers: Authorization: Bearer <supabase-jwt>
//   body:    { email: 'friend@example.com', code: 'ABCD-EFGH-IJKL' }
//
// RESPONSE:
//   200 { ok: true }
//   400 { error: 'missing fields' }
//   401 { error: 'auth' }
//   403 { error: 'not your code' }
//   500 { error: '...' }
//
// SECURITY:
//   • Caller's session must own the code (subsidiary_invites.inviter_id
//     === auth.uid()). Otherwise anyone could spam-send other people's
//     codes to arbitrary email addresses.
//   • Code must be unclaimed + unrevoked.
//
// REQUIRED ENV (same as send-beta-invite):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   RESEND_API_KEY
//   RESEND_FROM_NAME + RESEND_FROM_EMAIL  (or legacy RESEND_FROM)

const { createClient } = require('@supabase/supabase-js');
const { renderEmailHtml, renderEmailText } = require('./_lib/subsidiary-invite-template');
const { resolveResendFrom } = require('./_lib/resend-from');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, reason: 'resend_not_configured' };
  const fromResult = resolveResendFrom();
  if (!fromResult.ok) {
    console.error('[send-subsidiary-invite] from address invalid:', fromResult);
    return { ok: false, reason: fromResult.reason };
  }
  const from = fromResult.from;
  const replyTo = (process.env.RESEND_REPLY_TO || '').trim();
  const payload = { from, to, subject, html, text };
  if (replyTo) payload.reply_to = replyTo;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[send-subsidiary-invite] Resend error:', r.status, detail.slice(0, 300));
      return { ok: false, reason: 'resend_http_' + r.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('[send-subsidiary-invite] Resend exception:', e);
    return { ok: false, reason: 'resend_exception' };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth ───────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || !token.startsWith('eyJ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  // ── Body ───────────────────────────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const { email, code } = body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  if (!code)  return res.status(400).json({ error: 'Invite code required' });

  // ── Validate ownership + state of the code ────────────────────
  const { data: invite, error: inviteErr } = await sb
    .from('subsidiary_invites')
    .select('id, code, inviter_id, granted_tier, duration_months, claimed_at, revoked_at')
    .eq('code', String(code).trim().toUpperCase())
    .maybeSingle();
  if (inviteErr || !invite) return res.status(404).json({ error: 'Code not found' });
  if (invite.inviter_id !== user.id) return res.status(403).json({ error: 'Not your code' });
  if (invite.revoked_at)  return res.status(400).json({ error: 'Code revoked' });
  if (invite.claimed_at)  return res.status(400).json({ error: 'Code already claimed' });

  // ── Pull inviter's name to personalize the email ──────────────
  const { data: prof } = await sb
    .from('profiles')
    .select('name, username, email')
    .eq('id', user.id)
    .maybeSingle();
  const inviterName = (prof?.name || prof?.username || prof?.email || 'A friend').toString();

  // ── Compose + send ────────────────────────────────────────────
  const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL || 'https://pathbinder.gg';
  const grantedTier    = invite.granted_tier;
  const durationMonths = invite.duration_months;

  const subject = '[PathBinder] ' + inviterName + ' invited you — ' +
                  durationMonths + 'mo of ' + grantedTier + ' tier';

  const result = await sendEmail({
    to:      email,
    subject: subject,
    html:    renderEmailHtml({ inviterName, grantedTier, durationMonths, code: invite.code, siteOrigin }),
    text:    renderEmailText({ inviterName, grantedTier, durationMonths, code: invite.code, siteOrigin }),
  });

  if (!result.ok) {
    return res.status(500).json({ error: 'Email send failed', reason: result.reason });
  }
  return res.status(200).json({ ok: true });
};
