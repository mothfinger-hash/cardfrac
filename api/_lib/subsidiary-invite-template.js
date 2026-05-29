// api/_lib/subsidiary-invite-template.js
//
// HTML + plain-text template for the friend-to-friend beta invite
// email. Sent when a Founder/Enthusiast/Collector beta tester clicks
// "Generate Invite" + "Send Email" in their dashboard panel.
//
// Distinct from the admin beta-invite template:
//   • From a friend, not from PathBinder
//   • Carries duration-limited terms (3 or 6 months → expires)
//   • Lighter on the "what is PathBinder" pitch since the inviter
//     presumably has context
//
// USAGE
//   const { renderEmailHtml, renderEmailText } = require('./subsidiary-invite-template');
//
//   const html = renderEmailHtml({
//     inviterName:    'Moth',
//     inviterEmail:   'moth@pathbinder.gg',     // shown as Reply-To if app sets it
//     grantedTier:    'collector',              // collector | enthusiast | vendor
//     durationMonths: 6,
//     code:           'ABCD-EFGH-IJKL',
//     siteOrigin:     'https://pathbinder.gg',
//   });

const TIER_LABEL = {
  collector:  'Collector',
  enthusiast: 'Enthusiast',
  vendor:     'Vendor',
};

const TIER_BLURB = {
  collector:
    "Unlimited cards in your binder, 1,000 photo card scans / month, " +
    "live market price tracking, watchlist alerts, and Marketplace access.",
  enthusiast:
    "Everything in Collector, plus bulk CSV import, multi-binder organization, " +
    "sales archive across every channel, and a 40-listing concurrent active cap " +
    "on the marketplace.",
  vendor:
    "Everything in Enthusiast, plus sealed product + non-TCG product listings, " +
    "the product scanner, and a 150-listing concurrent active cap on the marketplace.",
};

function renderEmailHtml({ inviterName, inviterEmail, grantedTier, durationMonths, code, siteOrigin }) {
  siteOrigin = siteOrigin || 'https://pathbinder.gg';
  const tier      = TIER_LABEL[grantedTier]  || 'Collector';
  const blurb     = TIER_BLURB[grantedTier]  || TIER_BLURB.collector;
  const durLabel  = durationMonths + ' month' + (durationMonths === 1 ? '' : 's');
  const claimUrl  = siteOrigin + '/?invite=' + encodeURIComponent(code);
  const logoUrl   = siteOrigin + '/pb_logo.png';
  const bgUrl     = siteOrigin + '/dash2.webp';
  const noiseUrl  = siteOrigin + '/noise.png';
  const safeName  = (inviterName || 'A friend').toString().replace(/[<>&]/g, '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeName} invited you to PathBinder</title>
</head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#d8e0e8;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0a0e1a;background-image:url('${noiseUrl}'), url('${bgUrl}');background-size:300px 300px, cover;background-position:top left, center;background-repeat:repeat, no-repeat">
    <tr>
      <td align="center" style="padding:36px 16px">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;background:rgba(10,14,26,0.94);border:1px solid #1AC7A0;border-radius:14px;box-shadow:0 0 0 1px rgba(26,199,160,0.4), 0 0 28px rgba(26,199,160,0.35), 0 0 64px rgba(26,199,160,0.18)">
          <tr>
            <td style="padding:34px 30px 14px;text-align:center">
              <img src="${logoUrl}" alt="PathBinder" width="140" style="display:inline-block;max-width:140px;height:auto;margin-bottom:14px" />
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:800;letter-spacing:0.22em;color:#B87333;text-transform:uppercase;margin-top:8px">
                &#9672;&nbsp; ${safeName} thinks you'd dig it &nbsp;&#9672;
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 36px 0">
              <h1 style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:0.04em;margin:18px 0 12px;text-align:center">
                ${durLabel} of ${tier} tier, on the house.
              </h1>
              <p style="font-size:14px;color:#d8e0e8;line-height:1.65;margin:0 0 18px;text-align:center">
                ${safeName} sent you an invite to PathBinder. Redeem the code below
                and you'll get <strong style="color:#1AC7A0">${durLabel} of ${tier} tier</strong>
                with no card on file. After that, you can subscribe or revert to free
                &mdash; your binder data stays either way.
              </p>
            </td>
          </tr>

          <!-- Code box -->
          <tr>
            <td style="padding:8px 36px 0;text-align:center">
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;color:#6a7888;text-transform:uppercase;margin-bottom:8px">
                Your invite code
              </div>
              <div style="font-family:'Courier New',monospace;font-size:20px;letter-spacing:0.16em;color:#1AC7A0;background:rgba(26,199,160,0.08);border:1px dashed #1AC7A0;border-radius:10px;padding:14px 20px;margin:0 auto 22px;display:inline-block;font-weight:700;box-shadow:0 0 12px rgba(26,199,160,0.25)">
                ${code}
              </div>
              <br />
              <a href="${claimUrl}" style="display:inline-block;background:#1AC7A0;color:#0a0e1a;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:800;text-decoration:none;padding:14px 34px;letter-spacing:0.06em;border-radius:10px;box-shadow:0 0 20px rgba(26,199,160,0.5), 0 0 40px rgba(26,199,160,0.25)">
                Claim Your Trial &rarr;
              </a>
              <div style="font-size:11px;color:#6a7888;margin-top:12px">
                One click claims the code and sets up your account.
              </div>
            </td>
          </tr>

          <!-- What you get -->
          <tr>
            <td style="padding:26px 36px 0">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(26,199,160,0.06);border:1px solid #1f2939;border-left:3px solid #1AC7A0;border-radius:10px">
                <tr>
                  <td style="padding:16px 20px">
                    <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;color:#1AC7A0;text-transform:uppercase;margin-bottom:8px;font-weight:700">
                      What you get for ${durLabel}
                    </div>
                    <div style="font-size:14px;color:#d8e0e8;line-height:1.65">
                      ${blurb}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 36px 32px;text-align:center">
              <div style="font-size:11px;color:#6a7888;line-height:1.65">
                Questions? Reply to this email or hit up ${safeName} directly.<br /><br />
                <span style="color:#1AC7A0;letter-spacing:0.14em;font-weight:700">&#9697; PATHBINDER</span><br />
                <span style="color:#6a7888;font-size:10px">${siteOrigin}</span>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderEmailText({ inviterName, grantedTier, durationMonths, code, siteOrigin }) {
  siteOrigin = siteOrigin || 'https://pathbinder.gg';
  const tier      = TIER_LABEL[grantedTier]  || 'Collector';
  const blurb     = TIER_BLURB[grantedTier]  || TIER_BLURB.collector;
  const durLabel  = durationMonths + ' month' + (durationMonths === 1 ? '' : 's');
  const claimUrl  = siteOrigin + '/?invite=' + encodeURIComponent(code);
  const safeName  = (inviterName || 'A friend').toString();
  return [
    `${safeName} invited you to PathBinder`,
    '',
    `${durLabel} of ${tier} tier, on the house.`,
    '',
    `${safeName} sent you an invite. Redeem the code below for ${durLabel} of ${tier}`,
    "tier with no card on file. After that, subscribe or revert to free —",
    "your binder data stays either way.",
    '',
    `Your invite code: ${code}`,
    '',
    `Claim: ${claimUrl}`,
    '',
    `What you get for ${durLabel}:`,
    blurb,
    '',
    '— PathBinder',
    siteOrigin,
  ].join('\n');
}

module.exports = { renderEmailHtml, renderEmailText, TIER_LABEL, TIER_BLURB };
