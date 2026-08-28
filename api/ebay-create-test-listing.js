// api/ebay-create-test-listing.js
// SANDBOX SEEDING AID (temporary) — creates one active fixed-price listing on
// the connected seller's account via the Trading API AddFixedPriceItem, so we
// can test the listing PULL without fighting the flaky sandbox web UI.
//
// Returns { itemId, ack, errors } — on failure the eBay error messages come
// straight back so we can adjust the request (category/condition/specifics/
// policies are the usual culprits). REMOVE this endpoint + its client link
// before production.
//
// POST, Supabase JWT auth.

const { createClient } = require('@supabase/supabase-js');
const ebay = require('./_lib/ebay');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function _collectErrors(xml) {
  const out = [];
  const re = /<Errors>([\s\S]*?)<\/Errors>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const shortMsg = (m[1].match(/<ShortMessage>([^<]*)<\/ShortMessage>/) || [])[1];
    const longMsg  = (m[1].match(/<LongMessage>([^<]*)<\/LongMessage>/) || [])[1];
    const sev      = (m[1].match(/<SeverityCode>([^<]*)<\/SeverityCode>/) || [])[1];
    if (shortMsg || longMsg) out.push((sev ? sev + ': ' : '') + (longMsg || shortMsg));
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ebay.isConfigured()) return res.status(503).json({ error: 'eBay not configured', code: 'NOT_CONFIGURED' });

  const jwt = (req.headers.authorization || '').replace('Bearer ', '');
  if (!jwt) return res.status(401).json({ error: 'Authentication required' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  const tok = await ebay.getValidAccessToken(sb, user.id);
  if (tok.error) return res.status(400).json({ error: 'eBay not connected', code: tok.error });

  const suffix = Date.now().toString().slice(-6);
  const inner = ''
    + '<ErrorLanguage>en_US</ErrorLanguage>'
    + '<WarningLevel>High</WarningLevel>'
    + '<Item>'
    +   '<Title>PathBinder Test Card ' + suffix + '</Title>'
    +   '<Description>Sandbox test listing created via PathBinder to verify inventory sync.</Description>'
    +   '<PrimaryCategory><CategoryID>183454</CategoryID></PrimaryCategory>'  // CCG Individual Cards
    +   '<StartPrice>9.99</StartPrice>'
    +   '<ConditionID>4000</ConditionID>'
    +   '<Country>US</Country>'
    +   '<Currency>USD</Currency>'
    +   '<DispatchTimeMax>3</DispatchTimeMax>'
    +   '<ListingDuration>GTC</ListingDuration>'
    +   '<ListingType>FixedPriceItem</ListingType>'
    +   '<Quantity>3</Quantity>'
    +   '<Location>San Jose, CA</Location>'
    +   '<PostalCode>95125</PostalCode>'
    +   '<SKU>PB-TEST-' + suffix + '</SKU>'
    +   '<ItemSpecifics>'
    +     '<NameValueList><Name>Game</Name><Value>Pok&#233;mon TCG</Value></NameValueList>'
    +     '<NameValueList><Name>Card Name</Name><Value>Test Card</Value></NameValueList>'
    +   '</ItemSpecifics>'
    +   '<ReturnPolicy>'
    +     '<ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>'
    +     '<RefundOption>MoneyBack</RefundOption>'
    +     '<ReturnsWithinOption>Days_30</ReturnsWithinOption>'
    +     '<ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption>'
    +   '</ReturnPolicy>'
    +   '<ShippingDetails>'
    +     '<ShippingType>Flat</ShippingType>'
    +     '<ShippingServiceOptions>'
    +       '<ShippingServicePriority>1</ShippingServicePriority>'
    +       '<ShippingService>USPSFirstClass</ShippingService>'
    +       '<ShippingServiceCost>3.99</ShippingServiceCost>'
    +       '<ShippingServiceAdditionalCost>0.99</ShippingServiceAdditionalCost>'
    +     '</ShippingServiceOptions>'
    +   '</ShippingDetails>'
    + '</Item>';

  const call = await ebay.tradingCall(tok.token, 'AddFixedPriceItem', inner);
  const ack    = (call.text.match(/<Ack>([^<]*)<\/Ack>/) || [])[1] || 'Unknown';
  const itemId = (call.text.match(/<ItemID>([^<]*)<\/ItemID>/) || [])[1] || null;
  const errors = _collectErrors(call.text);

  if (ack === 'Failure' || !itemId) {
    console.error('[ebay-test-listing] failed:', ack, errors, (call.text || '').slice(0, 1500));
    // Include a raw snippet (dev aid) so the browser console has the full
    // eBay error without needing to dig into Vercel logs.
    return res.status(502).json({ error: 'eBay could not create the listing', ack, errors, raw: (call.text || '').slice(0, 2000) });
  }
  return res.status(200).json({ ok: true, ack, itemId, errors });
};
