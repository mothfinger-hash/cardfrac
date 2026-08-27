// api/_lib/ebay.js
// Shared eBay OAuth + config for the PathBinder <-> eBay integration.
//
// Env (Vercel):
//   EBAY_APP_ID   — App ID (OAuth client_id)
//   EBAY_CERT_ID  — Cert ID (OAuth client_secret)
//   EBAY_RU_NAME  — the RuName (redirect URL *name*, NOT the literal URL — eBay
//                   passes this as redirect_uri and maps it to the accepted URL
//                   you configured in the developer portal → /api/ebay-callback)
//   EBAY_ENV      — 'sandbox' (default here for testing) or 'production'
//
// Sandbox and production have SEPARATE keysets + RuNames, so flip EBAY_ENV and
// the three values together when moving to production.

const ENV        = (process.env.EBAY_ENV || 'sandbox').toLowerCase();
const IS_SANDBOX = ENV !== 'production';

const HOSTS = IS_SANDBOX
  ? { auth: 'https://auth.sandbox.ebay.com', api: 'https://api.sandbox.ebay.com' }
  : { auth: 'https://auth.ebay.com',          api: 'https://api.ebay.com' };

// Scopes for reading + managing a seller's listings and reading their orders.
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.account',
].join(' ');

function config() {
  return {
    appId:  process.env.EBAY_APP_ID,
    certId: process.env.EBAY_CERT_ID,
    ruName: process.env.EBAY_RU_NAME,
    env: ENV, isSandbox: IS_SANDBOX,
  };
}

function isConfigured() {
  const c = config();
  return !!(c.appId && c.certId && c.ruName);
}

// The consent URL the seller is sent to. eBay uses the RuName as redirect_uri.
function authorizeUrl(state) {
  const c = config();
  const params = new URLSearchParams({
    client_id: c.appId,
    redirect_uri: c.ruName,
    response_type: 'code',
    scope: SCOPES,
    state: state,
  });
  return HOSTS.auth + '/oauth2/authorize?' + params.toString();
}

function _basicAuth() {
  const c = config();
  return 'Basic ' + Buffer.from(c.appId + ':' + c.certId).toString('base64');
}

async function _tokenRequest(bodyParams) {
  const r = await fetch(HOSTS.api + '/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: _basicAuth() },
    body: new URLSearchParams(bodyParams).toString(),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// One-time: trade the authorization code for the refresh + access tokens.
async function exchangeCodeForToken(code) {
  const c = config();
  return _tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: c.ruName });
}

// Mint a fresh access token from the long-lived refresh token (used by the
// sync worker; access tokens live ~2h, refresh ~18 months).
async function refreshUserToken(refreshToken) {
  return _tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPES });
}

// Return a valid access token for a connected user, refreshing (and caching the
// new access token on the row) if the cached one is missing or within 2 min of
// expiry. `sb` is a service-role Supabase client. Returns { token } or { error }.
async function getValidAccessToken(sb, userId) {
  const { data: conn, error } = await sb.from('ebay_connections')
    .select('refresh_token, access_token, token_expires_at').eq('user_id', userId).maybeSingle();
  if (error || !conn) return { error: 'not_connected' };

  const now = Date.now();
  if (conn.access_token && conn.token_expires_at
      && new Date(conn.token_expires_at).getTime() - now > 120000) {
    return { token: conn.access_token };
  }
  const r = await refreshUserToken(conn.refresh_token);
  if (!r.ok || !r.data || !r.data.access_token) {
    await sb.from('ebay_connections')
      .update({ status: 'error', last_error: 'refresh_failed', updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    return { error: 'refresh_failed', detail: r.data };
  }
  const accessExp = new Date(now + (Number(r.data.expires_in || 7200) * 1000)).toISOString();
  await sb.from('ebay_connections').update({
    access_token: r.data.access_token,
    token_expires_at: accessExp,
    status: 'active', last_error: null,
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId);
  return { token: r.data.access_token };
}

// Low-level Trading API (XML) call. eBay accepts the OAuth user token via the
// X-EBAY-API-IAF-TOKEN header, so both REST and Trading run off one consent.
async function tradingCall(accessToken, callName, innerXml) {
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<' + callName + 'Request xmlns="urn:ebay:apis:eBLBaseComponents">'
    + (innerXml || '')
    + '</' + callName + 'Request>';
  const r = await fetch(HOSTS.api + '/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': '0',                    // 0 = eBay US
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
      'X-EBAY-API-IAF-TOKEN': accessToken,
      'Content-Type': 'text/xml',
    },
    body,
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

module.exports = {
  HOSTS, SCOPES, config, isConfigured, authorizeUrl,
  exchangeCodeForToken, refreshUserToken, getValidAccessToken, tradingCall,
};
