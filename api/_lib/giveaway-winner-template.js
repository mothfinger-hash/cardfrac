// api/_lib/giveaway-winner-template.js
//
// HTML + plain-text template for the "you won a giveaway" email, sent from
// PathBinder to a confirmed winner after an admin draws a giveaway and clicks
// "Email winners" in the admin Giveaways panel.
//
// Mirrors the subsidiary-invite template's dark hologram aesthetic and the
// same RESEND_* send path. Deliberately NON-custodial / no money language —
// this is a prize-claim logistics email, not a marketplace payout.
//
// The copy tracks the Official Rules:
//   • Winner must respond within a claim window (default 5 days) with a
//     shipping address or the prize may be forfeited (Rules §7).
//   • If a winner's prize ARV reaches $600 in a calendar year, a W-9 is
//     required and a 1099 will be issued (Rules §8) — shown only when the
//     caller flags highValue.
//   • Accepting the prize permits announcing the winner's first name /
//     username (Rules §9).
//
// USAGE
//   const { renderEmailHtml, renderEmailText } = require('./giveaway-winner-template');
//   const html = renderEmailHtml({
//     winnerName:  'Moth',
//     prizeLabel:  'Sealed SV10 Team Rocket Gang Briefcase',
//     giveawayName:'October Team Rocket Briefcase',
//     prizeRank:   1,
//     numWinners:  5,
//     claimDays:   5,
//     highValue:   false,
//     siteOrigin:  'https://pathbinder.gg',
//   });

function _rankLabel(prizeRank, numWinners) {
  if (!prizeRank || !numWinners || numWinners <= 1) return '';
  return ' (prize #' + prizeRank + ')';
}

function _sanitize(s, fallback) {
  var v = (s == null ? '' : String(s)).replace(/[<>]/g, '').trim();
  return v || fallback;
}

function renderEmailHtml(opts) {
  opts = opts || {};
  var siteOrigin = opts.siteOrigin || 'https://pathbinder.gg';
  var winnerName = _sanitize(opts.winnerName, 'PathBinder Collector');
  var giveaway   = _sanitize(opts.giveawayName, 'our giveaway');
  var prizeLabel = _sanitize(opts.prizeLabel, giveaway);
  var rankLabel  = _rankLabel(opts.prizeRank, opts.numWinners);
  var claimDays  = parseInt(opts.claimDays, 10) || 5;
  var highValue  = !!opts.highValue;
  var logoUrl    = siteOrigin + '/pb_logo.png';
  var bgUrl      = siteOrigin + '/dash2.webp';
  var noiseUrl   = siteOrigin + '/noise.png';

  var taxRow = highValue ? `
          <tr>
            <td style="padding:16px 36px 0">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(184,115,51,0.06);border:1px solid #1f2939;border-left:3px solid #B87333;border-radius:10px">
                <tr>
                  <td style="padding:14px 18px">
                    <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;color:#B87333;text-transform:uppercase;margin-bottom:6px;font-weight:700">
                      One quick tax step
                    </div>
                    <div style="font-size:13px;color:#d8e0e8;line-height:1.6">
                      Because this prize's value reaches the $600 IRS reporting threshold, we'll need a
                      completed <strong style="color:#ffffff">W-9</strong> before we ship, and we'll issue a
                      Form 1099 for the year. We'll send the W-9 form when you reply.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You won ${giveaway} on PathBinder</title>
</head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#d8e0e8;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0a0e1a;background-image:url('${noiseUrl}'), url('${bgUrl}');background-size:300px 300px, cover;background-position:top left, center;background-repeat:repeat, no-repeat">
    <tr>
      <td align="center" style="padding:36px 16px">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;background:rgba(10,14,26,0.94);border:1px solid #D4AF37;border-radius:14px;box-shadow:0 0 0 1px rgba(212,175,55,0.4), 0 0 28px rgba(212,175,55,0.3), 0 0 64px rgba(212,175,55,0.15)">
          <tr>
            <td style="padding:34px 30px 14px;text-align:center">
              <img src="${logoUrl}" alt="PathBinder" width="140" style="display:inline-block;max-width:140px;height:auto;margin-bottom:14px" />
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:800;letter-spacing:0.22em;color:#D4AF37;text-transform:uppercase;margin-top:8px">
                &#9670;&nbsp; You won${rankLabel} &nbsp;&#9670;
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 36px 0">
              <h1 style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:0.04em;margin:18px 0 12px;text-align:center">
                ${prizeLabel}
              </h1>
              <p style="font-size:14px;color:#d8e0e8;line-height:1.65;margin:0 0 18px;text-align:center">
                Congratulations, ${winnerName} &mdash; your entry was drawn in
                <strong style="color:#D4AF37">${giveaway}</strong>. Here's how to claim it.
              </p>
            </td>
          </tr>

          <!-- Claim box -->
          <tr>
            <td style="padding:8px 36px 0">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(26,199,160,0.06);border:1px solid #1f2939;border-left:3px solid #1AC7A0;border-radius:10px">
                <tr>
                  <td style="padding:16px 20px">
                    <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;color:#1AC7A0;text-transform:uppercase;margin-bottom:8px;font-weight:700">
                      How to claim
                    </div>
                    <div style="font-size:14px;color:#d8e0e8;line-height:1.65">
                      <strong style="color:#ffffff">Reply to this email within ${claimDays} days</strong>
                      with your full name and shipping address. We'll confirm the details and get your
                      prize on its way. If we don't hear back within ${claimDays} days, an alternate
                      winner may be drawn.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
${taxRow}
          <!-- Footer -->
          <tr>
            <td style="padding:24px 36px 32px;text-align:center">
              <div style="font-size:11px;color:#6a7888;line-height:1.65">
                By accepting, you allow us to announce your first name or PathBinder username as a winner.
                No purchase was ever necessary to enter. Prizes are non-transferable with no cash substitution.<br /><br />
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

function renderEmailText(opts) {
  opts = opts || {};
  var siteOrigin = opts.siteOrigin || 'https://pathbinder.gg';
  var winnerName = _sanitize(opts.winnerName, 'PathBinder Collector');
  var giveaway   = _sanitize(opts.giveawayName, 'our giveaway');
  var prizeLabel = _sanitize(opts.prizeLabel, giveaway);
  var rankLabel  = _rankLabel(opts.prizeRank, opts.numWinners);
  var claimDays  = parseInt(opts.claimDays, 10) || 5;
  var highValue  = !!opts.highValue;
  var lines = [
    'You won' + rankLabel + ' — ' + giveaway,
    '',
    prizeLabel,
    '',
    'Congratulations, ' + winnerName + '. Your entry was drawn in ' + giveaway + '.',
    '',
    'HOW TO CLAIM',
    'Reply to this email within ' + claimDays + ' days with your full name and shipping',
    'address. We\'ll confirm and ship your prize. If we don\'t hear back within ' + claimDays,
    'days, an alternate winner may be drawn.',
  ];
  if (highValue) {
    lines.push(
      '',
      'TAX STEP',
      'This prize reaches the $600 IRS reporting threshold, so we\'ll need a completed',
      'W-9 before shipping and will issue a Form 1099. We\'ll send the W-9 when you reply.'
    );
  }
  lines.push(
    '',
    'By accepting, you allow us to announce your first name or username as a winner.',
    'No purchase was necessary to enter. Prizes are non-transferable, no cash substitution.',
    '',
    '— PathBinder',
    siteOrigin
  );
  return lines.join('\n');
}

module.exports = { renderEmailHtml, renderEmailText };
