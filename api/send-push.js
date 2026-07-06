// api/send-push.js
// ──────────────────────────────────────────────────────────────────────
// Trusted server-to-server endpoint to send a push notification to a user.
// Gated by a shared secret (x-push-secret header) so ONLY our own server
// code / Supabase DB webhooks / cron can trigger sends — clients never call
// this directly (push originates from server-side events like order paid,
// order shipped, new DM, trade offer, wishlist-listed).
//
// POST body: { userId, title, body?, data? }
// Header:    x-push-secret: <PUSH_SEND_SECRET>
// Returns:   { sent: true, id } | { sent: false, reason } | { error }
//
// Required env vars (Vercel):
//   PUSH_SEND_SECRET          — shared secret for callers
//   FIREBASE_SERVICE_ACCOUNT  — Firebase service-account JSON (used by _lib/push)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

const { sendPushToUser } = require('./_lib/push');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.PUSH_SEND_SECRET) {
    return res.status(500).json({ error: 'PUSH_SEND_SECRET not configured' });
  }
  if (req.headers['x-push-secret'] !== process.env.PUSH_SEND_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const b = (typeof req.body === 'string' ? safeParse(req.body) : req.body) || {};
  const { userId, title, body, data } = b;
  if (!userId || !title) return res.status(400).json({ error: 'userId and title required' });

  try {
    const r = await sendPushToUser(userId, { title, body, data });
    // 200 on a real send, 202 when there's simply nothing to send (no token, etc.).
    return res.status(r.sent ? 200 : 202).json(r);
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'send failed' });
  }
};

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return {}; } }
