// api/send-giveaway-winner.js
//
// Sends the "you won" email to the winner(s) of a drawn giveaway. Triggered
// by an admin from the Giveaways panel ("Email winners"). Admin-gated: the
// caller's session must belong to a profile with is_admin = true, because the
// handler reads winner email addresses (service key, bypasses RLS) and sends
// mail on the platform's behalf.
//
// REQUEST:
//   POST /api/send-giveaway-winner
//   headers: Authorization: Bearer <supabase-jwt>   (an admin's session)
//   body:    { giveaway_id: '<uuid>',
//              claimDays?: 5, highValue?: false, prizeLabel?: '...' }
//
// RESPONSE:
//   200 { ok: true, sent: n, failed: m, details: [...] }
//   400 { error: '...' }   401 { error: 'auth' }   403 { error: 'admin only' }
//
// REQUIRED ENV (same as the other Resend senders):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY,
//   RESEND_API_KEY, RESEND_FROM_NAME + RESEND_FROM_EMAIL (or RESEND_FROM),
//   optional RESEND_REPLY_TO, NEXT_PUBLIC_SITE_URL

const { createClient } = require('@supabase/supabase-js');
const { renderEmailHtml, renderEmailText } = require('./_lib/giveaway-winner-template');
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
    console.error('[send-giveaway-winner] from address invalid:', fromResult);
    return { ok: false, reason: fromResult.reason };
  }
  const replyTo = (process.env.RESEND_REPLY_TO || '').trim();
  const payload = { from: fromResult.from, to, subject, html, text };
  if (replyTo) payload.reply_to = replyTo;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[send-giveaway-winner] Resend error:', r.status, detail.slice(0, 300));
      return { ok: false, reason: 'resend_http_' + r.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('[send-giveaway-winner] Resend exception:', e);
    return { ok: false, reason: 'resend_exception' };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth: must be a signed-in admin ───────────────────────────
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token || !token.startsWith('eyJ')) return res.status(401).json({ error: 'Authentication required' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });
  const { data: caller } = await sb.from('profiles').select('is_admin').eq('id', user.id).maybeSingle();
  if (!caller || !caller.is_admin) return res.status(403).json({ error: 'admin only' });

  // ── Body ──────────────────────────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const giveawayId = (body && body.giveaway_id) || '';
  if (!giveawayId) return res.status(400).json({ error: 'giveaway_id required' });
  const claimDays  = parseInt(body.claimDays, 10) || 5;
  const highValue  = !!body.highValue;
  const prizeOverride = body.prizeLabel ? String(body.prizeLabel) : null;

  // ── Load giveaway + its winners ───────────────────────────────
  const { data: giveaway, error: gErr } = await sb
    .from('giveaways').select('id, name, prize, num_winners, status').eq('id', giveawayId).maybeSingle();
  if (gErr || !giveaway) return res.status(404).json({ error: 'Giveaway not found' });

  const { data: winners, error: wErr } = await sb
    .from('giveaway_winners').select('id, user_id, email, prize_rank').eq('giveaway_id', giveawayId).order('prize_rank');
  if (wErr) return res.status(500).json({ error: 'Could not load winners', detail: wErr.message });
  if (!winners || !winners.length) return res.status(400).json({ error: 'No winners drawn for this giveaway yet' });

  // ── Resolve names + emails for account winners in one query ───
  const ids = winners.filter(w => w.user_id).map(w => w.user_id);
  const profMap = {};
  if (ids.length) {
    const { data: profs } = await sb.from('profiles').select('id, name, username, email').in('id', ids);
    (profs || []).forEach(p => { profMap[p.id] = p; });
  }

  const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL || 'https://pathbinder.gg';
  const giveawayName = giveaway.name || 'our giveaway';
  const prizeLabel   = prizeOverride || giveaway.prize || giveawayName;

  let sent = 0, failed = 0;
  const details = [];
  for (const w of winners) {
    const prof = w.user_id ? (profMap[w.user_id] || {}) : {};
    // Email: AMOE entrant's email, else profile email, else auth lookup.
    let to = w.email || prof.email || null;
    if (!to && w.user_id) {
      try {
        const { data: au } = await sb.auth.admin.getUserById(w.user_id);
        to = au && au.user && au.user.email ? au.user.email : null;
      } catch (_) {}
    }
    if (!to) { failed++; details.push({ prize_rank: w.prize_rank, status: 'no_email' }); continue; }

    const winnerName = prof.name || prof.username || 'PathBinder Collector';
    const result = await sendEmail({
      to,
      subject: '[PathBinder] You won ' + giveawayName + '!',
      html: renderEmailHtml({ winnerName, prizeLabel, giveawayName, prizeRank: w.prize_rank, numWinners: giveaway.num_winners, claimDays, highValue, siteOrigin }),
      text: renderEmailText({ winnerName, prizeLabel, giveawayName, prizeRank: w.prize_rank, numWinners: giveaway.num_winners, claimDays, highValue, siteOrigin }),
    });
    if (result.ok) { sent++; details.push({ prize_rank: w.prize_rank, status: 'sent' }); }
    else { failed++; details.push({ prize_rank: w.prize_rank, status: 'failed', reason: result.reason }); }
  }

  return res.status(200).json({ ok: failed === 0, sent, failed, details });
};
