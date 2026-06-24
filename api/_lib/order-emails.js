// api/_lib/order-emails.js
//
// Transactional marketplace email (Resend): the buyer "your order shipped"
// notification. Intentionally the ONLY order email — no order-placed /
// you-sold mails, to avoid spamming.
//
//   renderBuyerShipped(opts) -> { subject, html, text }
//   sendOrderEmail({ to, subject, html, text })
//
// Uses the same RESEND_* env vars as the rest of the app (RESEND_API_KEY +
// RESEND_FROM | RESEND_FROM_NAME/EMAIL, optional RESEND_REPLY_TO). Sends are
// best-effort — callers wrap in try/catch so a mail hiccup never breaks
// shipping.

const { resolveResendFrom } = require('./resend-from');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function shortId(orderId) {
  return '#' + String(orderId || '').replace(/-/g, '').slice(0, 8).toUpperCase();
}

function renderShell(opts) {
  var siteOrigin = opts.siteOrigin || 'https://pathbinder.gg';
  var logoUrl  = siteOrigin + '/pb_logo.png';
  var bgUrl    = siteOrigin + '/dash2.webp';
  var noiseUrl = siteOrigin + '/noise.png';
  return '<!DOCTYPE html>\n' +
'<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>' + escapeHtml(opts.title || 'PathBinder') + '</title></head>' +
'<body style="margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,BlinkMacSystemFont,\'Helvetica Neue\',Arial,sans-serif;color:#d8e0e8;">' +
'<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0a0e1a;background-image:url(\'' + noiseUrl + '\'), url(\'' + bgUrl + '\');background-size:300px 300px, cover;background-position:top left, center;background-repeat:repeat, no-repeat">' +
'<tr><td align="center" style="padding:36px 16px">' +
'<table role="presentation" width="540" cellspacing="0" cellpadding="0" border="0" style="max-width:540px;width:100%;background:rgba(10,14,26,0.94);border:1px solid #1AC7A0;border-radius:14px;box-shadow:0 0 0 1px rgba(26,199,160,0.4), 0 0 28px rgba(26,199,160,0.35), 0 0 64px rgba(26,199,160,0.18)">' +
'<tr><td style="padding:34px 30px 6px;text-align:center">' +
'<img src="' + logoUrl + '" alt="PathBinder" width="140" style="display:inline-block;max-width:140px;height:auto;margin-bottom:14px" />' +
'<div style="font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:800;letter-spacing:0.22em;color:#B87333;text-transform:uppercase;margin-top:8px">&#9672;&nbsp; ' + escapeHtml(opts.badge || '') + ' &nbsp;&#9672;</div>' +
'</td></tr>' +
'<tr><td style="padding:8px 36px 0">' +
'<h1 style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:0.03em;margin:14px 0 14px;text-align:center">' + escapeHtml(opts.heading || '') + '</h1>' +
(opts.introHtml || '') +
'</td></tr>' +
(opts.imageUrl ? '<tr><td style="padding:4px 36px 10px;text-align:center"><img src="' + escapeHtml(opts.imageUrl) + '" alt="" width="150" style="display:inline-block;max-width:150px;width:150px;height:auto;border-radius:10px;border:1px solid #1f2939" /></td></tr>' : '') +
(opts.blocksHtml ? '<tr><td style="padding:6px 36px 0">' + opts.blocksHtml + '</td></tr>' : '') +
(opts.ctaHtml ? '<tr><td style="padding:18px 36px 6px;text-align:center">' + opts.ctaHtml + '</td></tr>' : '') +
'<tr><td style="padding:26px 36px 30px;text-align:center">' +
'<div style="border-top:1px solid #1f2939;padding-top:16px;font-size:11px;color:#6a7888;line-height:1.6">PathBinder &mdash; where TCG collectors finally feel organized.<br><a href="' + siteOrigin + '" style="color:#1AC7A0;text-decoration:none">' + siteOrigin.replace(/^https?:\/\//, '') + '</a></div>' +
'</td></tr>' +
'</table></td></tr></table></body></html>';
}

function para(text) {
  return '<p style="font-size:14px;color:#d8e0e8;line-height:1.65;margin:0 0 16px;text-align:center">' + text + '</p>';
}

function detailBox(label, rowsHtml, accent) {
  accent = accent || '#1AC7A0';
  return '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(26,199,160,0.06);border:1px solid #1f2939;border-left:3px solid ' + accent + ';border-radius:10px;margin:0 0 14px">' +
    '<tr><td style="padding:14px 18px">' +
    '<div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;color:' + accent + ';text-transform:uppercase;margin-bottom:8px;font-weight:700">' + escapeHtml(label) + '</div>' +
    rowsHtml +
    '</td></tr></table>';
}

function kv(k, v) {
  return '<div style="font-size:14px;color:#d8e0e8;line-height:1.6"><span style="color:#6a7888">' + escapeHtml(k) + ':</span> ' + v + '</div>';
}

function ctaButton(href, label) {
  return '<a href="' + href + '" style="display:inline-block;background:#1AC7A0;color:#0a0e1a;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:800;text-decoration:none;padding:13px 32px;letter-spacing:0.05em;border-radius:10px;box-shadow:0 0 20px rgba(26,199,160,0.5), 0 0 40px rgba(26,199,160,0.25)">' + escapeHtml(label) + ' &rarr;</a>';
}

function itemLine(o) {
  var name = escapeHtml(o.cardName || 'Your item');
  var set = o.setName ? ' <span style="color:#6a7888">&middot; ' + escapeHtml(o.setName) + '</span>' : '';
  return '<strong style="color:#ffffff">' + name + '</strong>' + set;
}

function money(n) {
  return '$' + Number(n || 0).toFixed(2);
}

function addressRows(o) {
  var a = o.shipTo || {};
  var lines = [a.name, a.street1, a.street2, [a.city, a.state].filter(Boolean).join(', ') + ' ' + (a.zip || '')];
  return lines.filter(function (p) { return p && String(p).trim(); })
    .map(function (p) { return '<div style="font-size:14px;color:#d8e0e8;line-height:1.6">' + escapeHtml(p) + '</div>'; })
    .join('');
}

// ── Seller: new sale ───────────────────────────────────────────────────────
function renderSellerNewOrder(o) {
  var shipUrl = (o.siteOrigin || 'https://pathbinder.gg') + '/?page=account';
  var blocks =
    detailBox('Sale', kv('Item', itemLine(o)) + kv('Order', escapeHtml(shortId(o.orderId))) + kv('Your payout', '<strong style="color:#1AC7A0">' + escapeHtml(money(o.payout != null ? o.payout : o.amount)) + '</strong>')) +
    (o.shipTo && o.shipTo.street1 ? detailBox('Ship to', addressRows(o), '#B87333') : '');
  var html = renderShell({
    siteOrigin: o.siteOrigin,
    imageUrl: o.imageUrl,
    title: 'You made a sale',
    badge: 'New Sale',
    heading: 'You sold a card!',
    introHtml: para('Nice one. Head to your orders to buy a prepaid shipping label (or add your own tracking) and get it on its way to the buyer.'),
    blocksHtml: blocks,
    ctaHtml: ctaButton(shipUrl, 'Ship This Order'),
  });
  var text = 'You made a sale!\n\n' +
    'Item: ' + (o.cardName || 'Your item') + (o.setName ? ' (' + o.setName + ')' : '') + '\n' +
    'Order: ' + shortId(o.orderId) + '\n' +
    'Your payout: ' + money(o.payout != null ? o.payout : o.amount) + '\n\n' +
    'Ship it from your orders: ' + shipUrl;
  return { subject: 'You sold ' + (o.cardName || 'a card') + '!', html: html, text: text };
}

// ── Buyer: shipped ─────────────────────────────────────────────────────────
function renderBuyerShipped(o) {
  var orderUrl = (o.siteOrigin || 'https://pathbinder.gg') + '/?page=account';
  var t = o.tracking || {};
  var trackRows = kv('Carrier', escapeHtml(t.carrier || '—')) +
    kv('Tracking', t.number ? (t.url ? '<a href="' + escapeHtml(t.url) + '" style="color:#1AC7A0;text-decoration:none">' + escapeHtml(t.number) + '</a>' : escapeHtml(t.number)) : '—');
  var blocks =
    detailBox('Item', kv('Item', itemLine(o)) + kv('Order', escapeHtml(shortId(o.orderId)))) +
    detailBox('Tracking', trackRows, '#B87333');
  var cta = (t.url) ? ctaButton(t.url, 'Track Your Package') : ctaButton(orderUrl, 'View Your Order');
  var html = renderShell({
    siteOrigin: o.siteOrigin,
    imageUrl: o.imageUrl,
    title: 'Your order shipped',
    badge: 'Shipped',
    heading: 'Your order is on the way!',
    introHtml: para('Good news &mdash; the seller has shipped your card. Use the tracking below to follow it to your door.'),
    blocksHtml: blocks,
    ctaHtml: cta,
  });
  var text = 'Your order is on the way!\n\n' +
    'Item: ' + (o.cardName || 'Your item') + (o.setName ? ' (' + o.setName + ')' : '') + '\n' +
    'Order: ' + shortId(o.orderId) + '\n' +
    'Carrier: ' + (t.carrier || '—') + '\n' +
    'Tracking: ' + (t.number || '—') + (t.url ? ' (' + t.url + ')' : '') + '\n\n' +
    'View your order: ' + orderUrl;
  return { subject: 'Your order shipped — ' + (o.cardName || 'your order'), html: html, text: text };
}

// ── Resend sender (best-effort) ────────────────────────────────────────────
async function sendOrderEmail({ to, subject, html, text }) {
  if (!to) return { ok: false, reason: 'no_recipient' };
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, reason: 'resend_not_configured' };
  const fromResult = resolveResendFrom();
  if (!fromResult.ok) return { ok: false, reason: fromResult.reason };
  const payload = { from: fromResult.from, to: to, subject: subject, html: html, text: text };
  const replyTo = (process.env.RESEND_REPLY_TO || '').trim();
  if (replyTo) payload.reply_to = replyTo;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[order-email] Resend error:', r.status, detail.slice(0, 200));
      return { ok: false, reason: 'resend_http_' + r.status };
    }
    return { ok: true };
  } catch (e) {
    console.error('[order-email] Resend exception:', e);
    return { ok: false, reason: 'resend_exception' };
  }
}

module.exports = { renderBuyerShipped, renderSellerNewOrder, sendOrderEmail, shortId };
