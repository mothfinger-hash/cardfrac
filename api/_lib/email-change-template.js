// api/_lib/email-change-template.js
//
// HTML + plain-text template for the email-change confirmation. Pasted
// into Supabase Dashboard → Authentication → Email Templates → "Change
// Email Address" so the confirmation matches PathBinder's aesthetic.
//
// Supabase delivers this to BOTH the old address (the current account
// holder) AND the new address. The template renders identically in
// both cases — Supabase's variables don't differentiate by recipient,
// so the copy is written to make sense for either reader.
//
// Substitutes:
//   {{ .ConfirmationURL }}  — link to confirm the change
//   {{ .SiteURL }}          — pathbinder.gg
//   {{ .Email }}            — current/old address on file
//   {{ .NewEmail }}         — requested new address (newer Supabase)
//
// {{ .NewEmail }} is best-effort — older Supabase versions don't
// substitute it. If it doesn't render, the copy still reads cleanly
// because we frame it as a generic "your address is changing" notice
// rather than a specific old→new diff.

const PREVIEW_SUBSTITUTIONS = {
  '{{ .ConfirmationURL }}': 'https://pathbinder.gg/?type=email_change&token=PREVIEW',
  '{{ .SiteURL }}':         'https://pathbinder.gg',
  '{{ .Email }}':           'old@example.com',
  '{{ .NewEmail }}':        'new@example.com',
};

function renderHtml({ siteOrigin, forPreview }) {
  siteOrigin = siteOrigin || 'https://pathbinder.gg';
  const logoUrl  = siteOrigin + '/pb_logo.png';
  const bgUrl    = siteOrigin + '/dash2.webp';
  const noiseUrl = siteOrigin + '/noise.png';

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Confirm your PathBinder email change</title>
</head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#d8e0e8;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0a0e1a;background-image:url('${noiseUrl}'), url('${bgUrl}');background-size:300px 300px, cover;background-position:top left, center;background-repeat:repeat, no-repeat">
    <tr>
      <td align="center" style="padding:36px 16px">

        <table role="presentation" width="540" cellspacing="0" cellpadding="0" border="0" style="max-width:540px;width:100%;background:rgba(10,14,26,0.94);border:1px solid #1AC7A0;border-radius:14px;box-shadow:0 0 0 1px rgba(26,199,160,0.4), 0 0 28px rgba(26,199,160,0.35), 0 0 64px rgba(26,199,160,0.18)">
          <tr>
            <td style="padding:34px 30px 14px;text-align:center">
              <img src="${logoUrl}" alt="PathBinder" width="140" style="display:inline-block;max-width:140px;height:auto;margin-bottom:14px" />
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:800;letter-spacing:0.22em;color:#B87333;text-transform:uppercase;margin-top:8px">
                &#9672;&nbsp; Email Change Request &nbsp;&#9672;
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:8px 36px 0">
              <h1 style="font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;color:#ffffff;letter-spacing:0.04em;margin:18px 0 16px;text-align:center">
                Confirm the new address.
              </h1>
              <p style="font-size:14px;color:#d8e0e8;line-height:1.65;margin:0 0 18px;text-align:center">
                Someone &mdash; hopefully you &mdash; asked to update the email
                address on your PathBinder account. Click below to finalize the
                change. Both your old and new addresses get this email so the
                change is hard to do quietly.
              </p>
            </td>
          </tr>

          <!-- Old → new address diff box (only renders cleanly when
               Supabase substitutes {{ .NewEmail }}; otherwise it looks
               redundant but harmless). -->
          <tr>
            <td style="padding:0 36px">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(26,199,160,0.06);border:1px solid #1f2939;border-left:3px solid #1AC7A0;border-radius:10px">
                <tr>
                  <td style="padding:14px 18px">
                    <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;color:#1AC7A0;text-transform:uppercase;margin-bottom:8px;font-weight:700">
                      Account email
                    </div>
                    <div style="font-size:13px;color:#d8e0e8;line-height:1.7">
                      <span style="color:#6a7888">Old:</span> <span style="font-family:'Courier New',monospace;color:#d8e0e8">{{ .Email }}</span><br />
                      <span style="color:#6a7888">New:</span> <span style="font-family:'Courier New',monospace;color:#1AC7A0">{{ .NewEmail }}</span>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA button -->
          <tr>
            <td style="padding:22px 36px 8px;text-align:center">
              <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#1AC7A0;color:#0a0e1a;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:800;text-decoration:none;padding:14px 34px;letter-spacing:0.06em;border-radius:10px;box-shadow:0 0 20px rgba(26,199,160,0.5), 0 0 40px rgba(26,199,160,0.25)">
                Confirm Email Change &rarr;
              </a>
              <div style="font-size:11px;color:#6a7888;margin-top:14px">
                This link is valid for <strong style="color:#d8e0e8">24 hours</strong>.
              </div>
            </td>
          </tr>

          <!-- Plain-URL fallback -->
          <tr>
            <td style="padding:22px 36px 8px">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(26,199,160,0.04);border:1px solid #1f2939;border-radius:10px">
                <tr>
                  <td style="padding:14px 18px">
                    <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;color:#6a7888;text-transform:uppercase;margin-bottom:8px">
                      If the button isn&rsquo;t clickable
                    </div>
                    <div style="font-size:11px;color:#d8e0e8;line-height:1.55;word-break:break-all;font-family:'Courier New',monospace">
                      {{ .ConfirmationURL }}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Security: didn't request? -->
          <tr>
            <td style="padding:18px 36px 8px">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(255,217,61,0.04);border:1px solid #1f2939;border-radius:10px">
                <tr>
                  <td style="padding:14px 18px">
                    <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;color:#FFD93D;text-transform:uppercase;margin-bottom:6px;font-weight:700">
                      &#9888; Didn&rsquo;t request this?
                    </div>
                    <div style="font-size:13px;color:#d8e0e8;line-height:1.6">
                      Don&rsquo;t click the link. The change won&rsquo;t happen
                      without confirmation from both addresses. Then sign in and
                      change your password &mdash; someone with access to your
                      account triggered this request.
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
                Sent to <span style="color:#d8e0e8">{{ .Email }}</span><br />
                Questions? Reply to this email.<br /><br />
                <span style="color:#1AC7A0;letter-spacing:0.14em;font-weight:700">&#9697; PATHBINDER</span><br />
                <span style="color:#6a7888;font-size:10px">{{ .SiteURL }}</span>
              </div>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;

  if (forPreview) {
    for (const [needle, replacement] of Object.entries(PREVIEW_SUBSTITUTIONS)) {
      html = html.split(needle).join(replacement);
    }
  }
  return html;
}

function renderText({ forPreview }) {
  let text = [
    '◈ PATHBINDER — Email Change Request ◈',
    '',
    "Someone — hopefully you — asked to update the email address on",
    "your PathBinder account. Click below to finalize the change.",
    "Both your old and new addresses get this email so the change",
    "is hard to do quietly.",
    '',
    'Old: {{ .Email }}',
    'New: {{ .NewEmail }}',
    '',
    '{{ .ConfirmationURL }}',
    '',
    'This link is valid for 24 hours.',
    '',
    "Didn't request this? Don't click. The change won't happen without",
    'confirmation from both addresses. Then sign in and change your',
    'password — someone with access to your account triggered this.',
    '',
    '— PathBinder',
    '{{ .SiteURL }}',
  ].join('\n');
  if (forPreview) {
    for (const [needle, replacement] of Object.entries(PREVIEW_SUBSTITUTIONS)) {
      text = text.split(needle).join(replacement);
    }
  }
  return text;
}

module.exports = { renderHtml, renderText, PREVIEW_SUBSTITUTIONS };
