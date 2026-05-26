// ── Google Cloud Vision OCR — server-side proxy ─────────────────────────
//
// Accepts a base64-encoded image from the client, calls Google Cloud
// Vision's TEXT_DETECTION endpoint with the server-held API key, returns
// the OCR'd text string.
//
// Why this exists: the client used to call Google directly with a
// hardcoded GCV_API_KEY in the HTML, which meant anyone scraping the
// site source could grab the key and burn through our quota / billing.
// Proxying through Vercel means the key never leaves the server.
//
// REQUIRED ENV (Vercel dashboard → Settings → Environment Variables):
//   GCV_API_KEY   The Google Cloud Vision API key. Restrict in Google
//                 Cloud Console: API restriction = Cloud Vision API only,
//                 HTTP referrer = leave open (server makes the call, no
//                 referrer applies), OR add IP restriction = Vercel's
//                 deployment IPs if you want belt-and-suspenders.
//
// CLIENT REQUEST:
//   POST /api/vision-ocr
//   body: { image: "<base64 without data: prefix>" }
//   response: { text: "<OCR text>" } on success
//             { error: "..." } on failure (4xx / 5xx)
//
// NOTES:
//   • We strip the "data:image/...;base64," prefix server-side if the
//     client accidentally sent the full data URL.
//   • Only TEXT_DETECTION is exposed — other Vision features (face
//     detection, label detection, etc.) need separate endpoints if ever
//     wanted. Keeps the attack surface tight.
//   • No auth check on the endpoint itself yet. Vision API calls are
//     cheap (~$1.50 / 1000 requests) but if abuse becomes a problem the
//     fix is to verify a Supabase JWT on the request before proxying.

module.exports = async (req, res) => {
  // CORS — same as our other /api/ endpoints
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed — POST only' });
    return;
  }

  const apiKey = process.env.GCV_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'GCV_API_KEY not configured. Add it in Vercel → Settings → Environment Variables.',
    });
    return;
  }

  // Parse body. Vercel's body parser handles JSON automatically when
  // Content-Type is application/json, but be defensive.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const raw = body && body.image;
  if (!raw || typeof raw !== 'string') {
    res.status(400).json({ error: 'Missing image (base64 string) in request body' });
    return;
  }

  // Strip data:image/...;base64, prefix if present.
  const base64 = raw.indexOf(',') >= 0 ? raw.split(',')[1] : raw;
  if (!base64) {
    res.status(400).json({ error: 'Empty image data after stripping prefix' });
    return;
  }

  try {
    const upstream = await fetch(
      'https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image:    { content: base64 },
            features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
          }],
        }),
      }
    );

    if (!upstream.ok) {
      // Don't leak the upstream response shape directly — could contain
      // API key fragments in error messages. Return a generic error
      // status + log the detail server-side for debugging.
      const detail = await upstream.json().catch(() => ({}));
      const reason = (detail && detail.error && detail.error.message) || ('HTTP ' + upstream.status);
      console.error('[vision-ocr] upstream error:', upstream.status, reason);
      res.status(upstream.status === 403 ? 502 : upstream.status).json({
        error: upstream.status === 403
          ? 'Vision API key or quota issue — check Google Cloud Console'
          : 'Vision API error: ' + reason,
      });
      return;
    }

    const json = await upstream.json();
    const text = (json.responses && json.responses[0] && json.responses[0].textAnnotations
      ? (json.responses[0].textAnnotations[0] && json.responses[0].textAnnotations[0].description) || ''
      : '');
    res.status(200).json({ text });
  } catch (e) {
    console.error('[vision-ocr] exception:', e);
    res.status(500).json({ error: 'Vision proxy failed: ' + (e.message || 'unknown') });
  }
};
