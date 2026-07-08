// api/_lib/push.js
// ──────────────────────────────────────────────────────────────────────
// Shared helper: send a push notification to a PathBinder user.
//
//   Android  → FCM (firebase-admin, HTTP v1) with the FCM registration token.
//   iOS      → APNs directly (HTTP/2 + provider JWT), because
//              @capacitor/push-notifications hands iOS an APNs *device* token,
//              NOT an FCM token, so firebase-admin's messaging().send() rejects
//              it (invalid-argument) and no notification is delivered.
//
// Server-side code imports { sendPushToUser } and calls it directly. The thin
// HTTP endpoint at api/send-push.js wraps this for cross-service callers.
//
// The device token + platform are read from profiles.push_token / push_platform
// (written by the native app via pb-push.js -> _pbStorePushToken). A dead token
// is NULLed so we stop trying.
//
// Required env vars (Vercel):
//   FIREBASE_SERVICE_ACCOUNT  — full Firebase service-account JSON (Android/FCM)
//   APNS_KEY                  — the .p8 auth-key contents (PEM), for iOS
//   APNS_KEY_ID               — the APNs key's Key ID (10 chars)
//   APNS_TEAM_ID              — your Apple Developer Team ID (10 chars)
//   APNS_BUNDLE_ID            — optional; defaults to 'gg.pathbinder.app'
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

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

// ── APNs (iOS) ──────────────────────────────────────────────────────────
function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Provider JWT for APNs token-based auth (ES256, signed with the .p8). Cached
// and reused — APNs accepts a token for 20–60 min, and minting one on every
// send trips TooManyProviderTokenUpdates.
let _apnsJwt = null, _apnsJwtAt = 0;
function apnsJwt() {
  const keyId  = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const p8     = (process.env.APNS_KEY || '').replace(/\\n/g, '\n'); // tolerate \n-escaped env values
  if (!keyId || !teamId || !p8) return null;
  const now = Math.floor(Date.now() / 1000);
  if (_apnsJwt && (now - _apnsJwtAt) < 40 * 60) return _apnsJwt;
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: now }));
  const signingInput = header + '.' + claims;
  // ES256 for a JWT must be raw r||s (JOSE/P1363), not DER.
  const sig = require('crypto').sign('SHA256', Buffer.from(signingInput), { key: p8, dsaEncoding: 'ieee-p1363' });
  _apnsJwt = signingInput + '.' + b64url(sig);
  _apnsJwtAt = now;
  return _apnsJwt;
}

// One HTTP/2 POST to APNs. Resolves { status, text } (never rejects).
function apnsPost(host, deviceToken, jwt, topic, bodyObj) {
  return new Promise((resolve) => {
    let client;
    try { client = require('http2').connect('https://' + host); }
    catch (e) { return resolve({ status: 0, text: String(e) }); }
    const body = Buffer.from(JSON.stringify(bodyObj));
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { client.close(); } catch (_) {} resolve(r); };
    client.on('error', (e) => done({ status: 0, text: String(e && e.message || e) }));
    const req = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + deviceToken,
      'authorization': 'bearer ' + jwt,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      'content-length': body.length,
    });
    let status = 0, text = '';
    req.on('response', (h) => { status = h[':status']; });
    req.setEncoding('utf8');
    req.on('data', (c) => { text += c; });
    req.on('end', () => done({ status, text }));
    req.on('error', (e) => done({ status: 0, text: String(e && e.message || e) }));
    req.end(body);
  });
}

async function sendViaApns(userId, deviceToken, payload) {
  const jwt = apnsJwt();
  if (!jwt) return { sent: false, reason: 'APNs not configured (APNS_KEY/APNS_KEY_ID/APNS_TEAM_ID)' };
  const { title, body, data } = payload;
  const topic = process.env.APNS_BUNDLE_ID || 'gg.pathbinder.app';
  const aps = { aps: { alert: { title, body: body || '' }, sound: 'default', badge: 1 } };
  // Custom keys sit at the payload top level → the push plugin surfaces them
  // to JS as notification.data (matching _pbHandlePushTap).
  Object.entries(data || {}).forEach(([k, v]) => { if (v != null) aps[k] = String(v); });

  // TestFlight / App Store builds use PRODUCTION APNs; Debug builds use SANDBOX.
  // We don't store which, so try production and fall back to sandbox when the
  // token is rejected as belonging to the other environment.
  let res = await apnsPost('api.push.apple.com', deviceToken, jwt, topic, aps);
  if (res.status === 400 && /BadDeviceToken/.test(res.text)) {
    res = await apnsPost('api.sandbox.push.apple.com', deviceToken, jwt, topic, aps);
  }
  if (res.status === 200) return { sent: true, id: 'apns' };
  // Unregistered / bad token → clear it so future sends don't keep failing.
  if (res.status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(res.text)) {
    try { await sb().from('profiles').update({ push_token: null }).eq('id', userId); } catch (_) {}
    return { sent: false, reason: 'apns token invalid (cleared): ' + (res.text || res.status) };
  }
  return { sent: false, reason: 'apns ' + res.status + ': ' + (res.text || '') };
}

// ── main ────────────────────────────────────────────────────────────────
// Send one notification to one user.
// payload: { title, body?, data? }  — data values are coerced to strings.
// Returns { sent: boolean, id?: string, reason?: string }.
async function sendPushToUser(userId, payload = {}) {
  const { title, body, data } = payload;
  if (!userId || !title) return { sent: false, reason: 'missing userId or title' };

  const { data: prof, error } = await sb()
    .from('profiles').select('push_token, push_platform').eq('id', userId).maybeSingle();
  if (error) return { sent: false, reason: 'profile lookup failed: ' + error.message };
  const token = prof && prof.push_token;
  if (!token) return { sent: false, reason: 'no push token for user' };
  const platform = (prof && prof.push_platform) || '';

  // iOS stores an APNs device token, which FCM can't send to — route via APNs.
  if (platform === 'ios') {
    return await sendViaApns(userId, token, payload);
  }

  // Android (and anything else / legacy) → FCM.
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return { sent: false, reason: 'FIREBASE_SERVICE_ACCOUNT not set' };
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
