// api/_lib/beta-invite-template.js
//
// Email template for beta invitations. Extracted so both the API
// endpoint AND the local preview script (preview_beta_emails.js) pull
// from one source — no drift between preview and what gets sent.
//
// Exports:
//   TIER_COPY                  — per-tier headline + perks list
//   renderEmailHtml(opts)      — full HTML body
//   renderEmailText(opts)      — plain-text fallback
//
// `opts` shape: { email, tier, code, inviteeName?, siteOrigin }

// PathBinder elevator pitch — appears BEFORE the tier-specific section
// in every email. Invitees have likely never heard of us, so the tier
// copy can't assume context. This is the "what the hell is PathBinder
// and why am I getting this" answer in 2 short paragraphs.
const PATHBINDER_BLURB = [
  "PathBinder is where TCG collectors finally feel organized. Scan a card and it lands in your binder with live market value attached. Watch prices move on cards you don't own yet. Sell to other collectors with a flat low fee instead of the 12-30% the big platforms charge.",
  "We're hand-picking a small group of testers to break things, find rough edges, and tell us what's missing before we open it up to everyone. You're one of them.",
].join('|');   // joined with a pipe so the render fn can split + double-paragraph

const TIER_COPY = {
  founding: {
    title:    'Founding Beta — Vendor tier unlocked',
    pitch:    "You're a founder. The original promise was the most-feature-rich seller tier on the platform, and that's exactly what you're getting — permanently.",
    features: [
      'List sealed product, non-TCG items (Funko, manga, posters), AND TCG singles — 150 active listings',
      'Product scanner with OCR autofill for non-TCG items',
      'Bulk CSV import, sales archive, multi-binder, live price tracking, watchlist alerts',
    ],
  },
  enthusiast: {
    title:    'Enthusiast Beta',
    pitch:    "Enthusiasts go beyond tracking — you can actually sell on the marketplace, bulk-import a whole collection at once, and split things across multiple binders. Built for people who buy and trade often.",
    features: [
      'List up to 40 TCG singles on the marketplace at once',
      'Bulk CSV import, sales archive, multi-binder organization',
      'Live price tracking + watchlist alerts on every listing',
    ],
  },
  collector: {
    title:    'Collector Beta',
    pitch:    "Collector tier is for people who want to know what their collection is actually worth and get pinged when something they're watching moves. No selling required — just better visibility into a pile of cards.",
    features: [
      'Live price tracking on every card in your binder',
      'Watchlist alerts when prices on cards you want move',
      'Up to 3 card funds for goal-based collecting',
    ],
  },
  vendor: {
    title:    'Vendor Beta',
    pitch:    "Vendor tier is for people running an actual store-on-the-side. Sealed product, non-TCG items, product scanner, and a lower commission rate than Enthusiast.",
    features: [
      '150 active marketplace listings — sealed + non-TCG + singles',
      'Product scanner with OCR autofill for Funko Pops, manga, etc.',
      '6% commission (vs 7% on Enthusiast)',
    ],
  },
  shop: {
    title:    'Shop Beta — unlimited tier',
    pitch:    "Shop is the top tier — unlimited listings, the lowest commission on the platform, and a 1-year promotional window included with this beta.",
    features: [
      'Unlimited concurrent marketplace listings',
      '5% commission (lowest available)',
      '1-year promotional window included with this beta',
    ],
  },
};

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderEmailHtml({ email, tier, code, inviteeName, siteOrigin }) {
  const tierCopy = TIER_COPY[tier] || TIER_COPY.enthusiast;
  const redeemUrl = siteOrigin + '/?invite=' + encodeURIComponent(code);
  const discordUrl = 'https://discord.gg/JEwDTxWs4';
  const logoUrl = siteOrigin + '/pb_logo.png';
  const bgUrl   = siteOrigin + '/dashboard.jpg';
  const greeting = inviteeName ? ('Hey ' + escapeHtml(inviteeName) + ',') : 'Hey,';
  const blurbParas = PATHBINDER_BLURB.split('|').map(escapeHtml);

  const featuresHtml = tierCopy.features.map(f =>
    '<li style="margin:0 0 8px;color:#d8e0e8;font-size:14px;line-height:1.55">' +
      escapeHtml(f) +
    '</li>'
  ).join('');

  // Rounded corners use border-radius. Outlook strips it (squared
  // corners as fallback), Apple Mail / Gmail / iOS Mail honor it.
  // Acceptable graceful degradation.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You're invited to PathBinder</title>
</head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#d8e0e8;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0a0e1a;background-image:url('${bgUrl}');background-size:cover;background-position:center;background-repeat:no-repeat">
    <tr>
      <td align="center" style="padding:36px 16px">

        <!-- Centered card with rounded corners. Card sits on the navy
             background so when the dashboard.jpg renders, you see the
             card floating over the screenshot. -->
        <table role="presentation" width="580" cellspacing="0" cellpadding="0" border="0" style="max-width:580px;width:100%;background:rgba(10,14,26,0.94);border:1px solid #1AC7A0;border-radius:14px">
          <tr>
            <td style="padding:34px 30px 14px;text-align:center">
              <img src="${logoUrl}" alt="PathBinder" width="160" style="display:inline-block;max-width:160px;height:auto;margin-bottom:14px" />
              <!-- Larger, diamond-flanked banner. Letter-spaced for impact. -->
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:800;letter-spacing:0.22em;color:#B87333;text-transform:uppercase;margin-top:8px">
                &#9672;&nbsp; Beta Access Granted &nbsp;&#9672;
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:8px 36px 0">
              <h1 style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:0.04em;margin:14px 0 16px;text-align:center">
                ${escapeHtml(tierCopy.title)}
              </h1>
              <p style="font-size:14px;color:#d8e0e8;line-height:1.65;margin:0 0 18px;text-align:center">
                ${greeting}
              </p>
              <!-- PathBinder elevator pitch — context for invitees who've
                   never heard of us. -->
              <p style="font-size:14px;color:#d8e0e8;line-height:1.7;margin:0 0 14px">
                ${blurbParas[0]}
              </p>
              <p style="font-size:14px;color:#d8e0e8;line-height:1.7;margin:0 0 22px">
                ${blurbParas[1]}
              </p>
              <!-- Tier-specific pitch -->
              <p style="font-size:14px;color:#1AC7A0;line-height:1.65;margin:0 0 18px;text-align:center;font-style:italic">
                ${escapeHtml(tierCopy.pitch)}
              </p>
            </td>
          </tr>

          <!-- Tier perks box, rounded -->
          <tr>
            <td style="padding:0 36px">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(26,199,160,0.06);border:1px solid #1f2939;border-left:3px solid #1AC7A0;border-radius:10px">
                <tr>
                  <td style="padding:16px 20px">
                    <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;color:#1AC7A0;text-transform:uppercase;margin-bottom:10px;font-weight:700">
                      What you get
                    </div>
                    <ul style="margin:0;padding:0 0 0 18px">${featuresHtml}</ul>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Invite code + redeem CTA -->
          <tr>
            <td style="padding:28px 36px 8px;text-align:center">
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;color:#6a7888;text-transform:uppercase;margin-bottom:8px">
                Your invite code
              </div>
              <div style="font-family:'Courier New',monospace;font-size:20px;letter-spacing:0.16em;color:#1AC7A0;background:rgba(26,199,160,0.08);border:1px dashed #1AC7A0;border-radius:10px;padding:14px 20px;margin:0 auto 22px;display:inline-block;font-weight:700">
                ${escapeHtml(code)}
              </div>
              <br />
              <a href="${redeemUrl}" style="display:inline-block;background:#1AC7A0;color:#0a0e1a;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:800;text-decoration:none;padding:14px 34px;letter-spacing:0.06em;border-radius:10px">
                Start Your Path &rarr;
              </a>
              <div style="font-size:11px;color:#6a7888;margin-top:12px">
                One click claims the code and sets up your account. No card on file, no commitment.
              </div>
            </td>
          </tr>

          <!-- Discord section — prominent because feedback funnel is
               the whole point of the beta. URL shown as text below the
               button in case the button isn't clickable in some clients. -->
          <tr>
            <td style="padding:26px 36px 8px">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(184,115,51,0.06);border:1px solid #B87333;border-radius:10px">
                <tr>
                  <td style="padding:18px 22px">
                    <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;color:#B87333;text-transform:uppercase;margin-bottom:10px;font-weight:700">
                      &#9672;&nbsp; Join the PathBinder Discord
                    </div>
                    <p style="font-size:13px;color:#d8e0e8;line-height:1.65;margin:0 0 14px">
                      The Discord is where beta testers report bugs, request features, and hang out with the small team building this. If you join the beta, please join Discord too — it's the fastest path to actually shaping what ships next.
                    </p>
                    <a href="${discordUrl}" style="display:inline-block;border:1px solid #B87333;color:#B87333;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;text-decoration:none;padding:10px 22px;letter-spacing:0.06em;border-radius:8px">
                      Join Discord &rarr;
                    </a>
                    <!-- Plain-text fallback URL in case the link isn't
                         rendered as clickable (some corporate filters,
                         some older clients). -->
                    <div style="font-size:11px;color:#6a7888;margin-top:12px;line-height:1.5;word-break:break-all">
                      Or paste this into your browser:<br />
                      <span style="color:#d8e0e8;font-family:'Courier New',monospace;font-size:12px">${discordUrl}</span>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:26px 36px 32px;text-align:center">
              <div style="font-size:11px;color:#6a7888;line-height:1.65">
                You're receiving this because an admin invited you to the PathBinder beta.<br />
                Questions? Reply to this email or hit us up in Discord.<br /><br />
                <span style="color:#1AC7A0;letter-spacing:0.14em;font-weight:700">&#9697; PATHBINDER</span><br />
                <span style="color:#6a7888;font-size:10px">pathbinder.gg</span>
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

function renderEmailText({ email, tier, code, inviteeName, siteOrigin }) {
  const tierCopy = TIER_COPY[tier] || TIER_COPY.enthusiast;
  const redeemUrl = siteOrigin + '/?invite=' + encodeURIComponent(code);
  const greeting = inviteeName ? ('Hey ' + inviteeName + ',') : 'Hey,';
  const blurbParas = PATHBINDER_BLURB.split('|');
  return [
    greeting,
    '',
    '◈ BETA ACCESS GRANTED ◈',
    '',
    tierCopy.title,
    '',
    blurbParas[0],
    '',
    blurbParas[1],
    '',
    tierCopy.pitch,
    '',
    'WHAT YOU GET:',
    ...tierCopy.features.map(f => '  - ' + f),
    '',
    'YOUR INVITE CODE: ' + code,
    '',
    'START YOUR PATH:  ' + redeemUrl,
    '',
    '— Also, please join the Discord. It\'s where beta testers',
    'report bugs and shape what ships next:',
    '',
    '  https://discord.gg/JEwDTxWs4',
    '',
    '⬡ PATHBINDER',
    'pathbinder.gg',
  ].join('\n');
}

module.exports = { TIER_COPY, renderEmailHtml, renderEmailText };
