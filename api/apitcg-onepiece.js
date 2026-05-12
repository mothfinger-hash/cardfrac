// api/apitcg-onepiece.js
// Server-side proxy for apitcg One Piece search. The browser can't carry
// the apitcg API key safely, so the in-app _fallbackOnePiece function
// hits this endpoint instead. We forward the user's `name` query to
// apitcg with the secret key from APITCG_API_KEY (set in Vercel env),
// then return the raw JSON.
//
// Usage from the client:
//   GET /api/apitcg-onepiece?name=Luffy
//
// Required env: APITCG_API_KEY (Vercel → Settings → Environment Variables)

const https = require('https');

function fetchApitcg(name, apiKey) {
  return new Promise((resolve, reject) => {
    const url = 'https://www.apitcg.com/api/one-piece/cards?name=' + encodeURIComponent(name);
    const req = https.get(url, {
      headers: {
        'Accept':     'application/json',
        'User-Agent': 'PathBinder/1.0 (https://pathbinder.vercel.app)',
        'x-api-key':  apiKey,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('apitcg timeout')); });
  });
}

module.exports = async (req, res) => {
  // CORS for our own origin (Vercel handles this automatically for same-origin
  // requests, but be explicit so it works if served from a different host).
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
  res.setHeader('Content-Type', 'application/json');

  const name = (req.query && req.query.name) ? String(req.query.name).trim() : '';
  if (!name) {
    res.status(400).json({ error: 'Missing required query param: name' });
    return;
  }

  const apiKey = process.env.APITCG_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'APITCG_API_KEY not configured on server' });
    return;
  }

  try {
    const r = await fetchApitcg(name, apiKey);
    // Pass through apitcg's status code so the client can detect auth issues
    res.status(r.status);
    // The response is already JSON-encoded — just write it through unchanged
    res.send(r.body);
  } catch (e) {
    res.status(502).json({ error: 'apitcg upstream failed', detail: String(e.message || e) });
  }
};
