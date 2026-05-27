// api/admin-notify-dispute.js
//
// Fans out an email to every admin when a marketplace order escalates
// to disputed status. Called by the client immediately after
// declineReturnRequest() commits the status flip. Best-effort — the
// in-app notification (admin_notifications row inserted by trigger)
// always fires; this endpoint just adds the email channel on top.
//
// Sending stack: Resend (resend.com). Chosen for simplest API + decent
// free tier (3,000 emails/month). To swap providers later, swap the
// sendEmail() helper and leave the rest alone.
//
// REQUIRED ENV (Vercel):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   RESEND_API_KEY    — get from resend.com/api-keys
//   RESEND_FROM       — verified sender, e.g. 'PathBinder Admin <alerts@pathbinder.gg>'
//                       Must be on a domain you've verified in Resend.
//
// If RESEND_API_KEY or RESEND_FROM is missing the endpoint succeeds with
// emailed=false rather than 500'ing — the in-app notification still
// fires regardless, and the admin sees "email not configured" in the
// response for debugging.
//
// REQUEST:
//   POST /api/admin-notify-dispute
//   headers: Authorization: Bearer <supabase-jwt>
//   body:    { orderId: '<uuid>' }
//
// RESPONSE:
//   200 { ok: true, emailed: <int>, skipped: <reason or null> }
//   400/401/404/500 with { error }

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    return { ok: false, reason: 'resend_not_configured' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from, to, subject, html, text,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[admin-notify] Resend error:', r.status, detail.slice(0, 200));
      return { ok: false, reason: 'resend_http_' + r.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('[admin-notify] Resend exception:', e);
    return { ok: false, reason: 'resend_exception' };
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth ────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || !token.startsWith('eyJ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  // ── Parse body ──────────────────────────────────────────────────────
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const orderId = body && body.orderId;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  // ── Verify the order really IS disputed ─────────────────────────────
  // Don't trust the caller — re-read from the DB so a stale or malicious
  // request can't trigger emails for orders that aren't actually disputed.
  const { data: order, error: orderErr } = await sb
    .from('orders')
    .select('id, status, seller_id, buyer_id, listing_id, return_reason, return_reason_detail, amount, created_at')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr || !order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'disputed') {
    return res.status(400).json({ error: 'Order is not disputed (status: ' + order.status + ')' });
  }

  // Only the seller (who escalated) OR an admin can trigger the email.
  // Prevents random users from causing email spam by poking the endpoint.
  if (order.seller_id !== user.id) {
    const { data: prof } = await sb
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .maybeSingle();
    if (!prof || !prof.is_admin) {
      return res.status(403).json({ error: 'Only the seller or an admin can trigger this notification' });
    }
  }

  // ── Recipients ──────────────────────────────────────────────────────
  // Service-role client bypasses RLS so we can query emails directly.
  const { data: admins, error: admErr } = await sb
    .from('profiles')
    .select('email, name, username')
    .eq('is_admin', true)
    .eq('is_deleted', false)
    .not('email', 'is', null);
  if (admErr) {
    console.error('[admin-notify] admin lookup failed:', admErr.message);
    return res.status(500).json({ error: 'Could not fetch admin list' });
  }
  const recipients = (admins || []).filter(a => a.email);
  if (recipients.length === 0) {
    return res.status(200).json({ ok: true, emailed: 0, skipped: 'no_admin_emails' });
  }

  // ── Pull a card name for the email body ────────────────────────────
  let cardName = 'Marketplace order';
  if (order.listing_id) {
    const { data: listing } = await sb
      .from('listings')
      .select('name')
      .eq('id', order.listing_id)
      .maybeSingle();
    if (listing && listing.name) cardName = listing.name;
  }

  const shortId = String(order.id).slice(0, 8).toUpperCase();
  const reason  = order.return_reason || 'unspecified';
  const detail  = order.return_reason_detail || '';
  const amount  = (order.amount || 0).toFixed(2);
  const site    = process.env.NEXT_PUBLIC_SITE_URL || 'https://pathbinder.gg';
  const deepLink = site + '/?admin=disputes&order=' + encodeURIComponent(order.id);

  const subject = '[PathBinder] Order #' + shortId + ' escalated to dispute';

  const html = ''
    + '<div style="font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px">'
    +   '<h2 style="margin:0 0 12px;font-size:18px">Order escalated to dispute</h2>'
    +   '<p style="margin:0 0 8px">A seller declined a buyer\'s return request. Admin review needed.</p>'
    +   '<table style="border-collapse:collapse;margin:16px 0;font-size:14px">'
    +     '<tr><td style="padding:4px 12px 4px 0;color:#666">Order</td><td style="padding:4px 0"><code>#' + shortId + '</code></td></tr>'
    +     '<tr><td style="padding:4px 12px 4px 0;color:#666">Item</td><td style="padding:4px 0">' + escapeHtml(cardName) + '</td></tr>'
    +     '<tr><td style="padding:4px 12px 4px 0;color:#666">Amount</td><td style="padding:4px 0">$' + amount + '</td></tr>'
    +     '<tr><td style="padding:4px 12px 4px 0;color:#666">Reason</td><td style="padding:4px 0">' + escapeHtml(reason) + '</td></tr>'
    +     (detail ? '<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top">Buyer detail</td><td style="padding:4px 0">' + escapeHtml(detail) + '</td></tr>' : '')
    +   '</table>'
    +   '<p style="margin:16px 0"><a href="' + deepLink + '" style="display:inline-block;background:#1AC7A0;color:#0a0a0a;text-decoration:none;padding:10px 18px;font-weight:700">Review dispute</a></p>'
    +   '<p style="font-size:12px;color:#888;margin-top:24px">You\'re receiving this because you\'re an admin on PathBinder.</p>'
    + '</div>';

  const text = ''
    + 'Order escalated to dispute\n'
    + '----------------------------\n'
    + 'Order:  #' + shortId + '\n'
    + 'Item:   ' + cardName + '\n'
    + 'Amount: $' + amount + '\n'
    + 'Reason: ' + reason + (detail ? '\nDetail: ' + detail : '') + '\n\n'
    + 'Review: ' + deepLink + '\n';

  // ── Send (in parallel, fail-individually) ───────────────────────────
  let emailed = 0;
  let skippedReason = null;
  const results = await Promise.all(recipients.map(r =>
    sendEmail({ to: r.email, subject, html, text })
  ));
  for (const r of results) {
    if (r.ok) emailed++;
    else if (!skippedReason) skippedReason = r.reason;
  }

  return res.status(200).json({
    ok:       true,
    emailed,
    skipped:  emailed === 0 ? skippedReason : null,
    total:    recipients.length,
  });
};
