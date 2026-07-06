// api/_lib/push.js
// ──────────────────────────────────────────────────────────────────────
// Shared helper: send a push notification to a PathBinder user via FCM
// (Firebase Cloud Messaging, HTTP v1) using firebase-admin.
//
// Server-side code (the Stripe webhook, other API routes, cron) imports
// { sendPushToUser } and calls it directly. The thin HTTP endpoint at
// api/send-push.js wraps this for cross-service / trusted callers.
//
// The device token is read from profiles.push_token (written by the native
// app via pb-push.js -> _pbStorePushToken). If FCM reports the token is dead,
// we NULL it out so we stop trying.
//
// Required env vars (Vercel):
//   FIREBASE_SERVICE_ACCOUNT  — the full Firebase service-account JSON, as a string
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

let _admin = null;
function admin() {
  if (_admin) return _admin;
  const a = require('firebase-admin');
  if (!a.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    a.initializeApp({ credential: a.credential.cert(svc) });
  }
  _admin = a;
  return a;
}

let _sb = null;
function sb() {
  if (_sb) return _sb;
  const { createClient } = require('@supabase/supabase-js');
  _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return _sb;
}

// Send one notification to one user.
// payload: { title, body?, data? }  — data values are coerced to strings (FCM requirement).
// Returns { sent: boolean, id?: string, reason?: string }.
async function sendPushToUser(userId, payload = {}) {
  const { title, body, data } = payload;
  if (!userId || !title) return { sent: false, reason: 'missing userId or title' };
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return { sent: false, reason: 'FIREBASE_SERVICE_ACCOUNT not set' };

  const { data: prof, error } = await sb()
    .from('profiles').select('push_token, push_platform').eq('id', userId).maybeSingle();
  if (error) return { sent: false, reason: 'profile lookup failed: ' + error.message };
  const token = prof && prof.push_token;
  if (!token) return { sent: false, reason: 'no push token for user' };

  // FCM data payload must be a flat map of strings.
  const strData = {};
  Object.entries(data || {}).forEach(([k, v]) => { if (v != null) strData[k] = String(v); });

  try {
    const id = await admin().messaging().send({
      token,
      notification: { title, body: body || '' },
      data: strData,
      apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
      android: { priority: 'high', notification: { sound: 'default', channelId: 'pathbinder' } },
    });
    return { sent: true, id };
  } catch (e) {
    const code = (e && e.errorInfo && e.errorInfo.code) || (e && e.code) || '';
    // Dead/unregistered token — clear it so future sends don't keep failing.
    if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) {
      try { await sb().from('profiles').update({ push_token: null }).eq('id', userId); } catch (_) {}
      return { sent: false, reason: 'token invalid (cleared): ' + code };
    }
    return { sent: false, reason: (e && e.message) || 'send failed' };
  }
}

module.exports = { sendPushToUser };
