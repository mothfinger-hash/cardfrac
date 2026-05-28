// api/_lib/password-reset-template.js
//
// HTML + plain-text template for the password-reset email. Used in two
// places:
//   • Standalone preview generator (preview_password_reset.js) so the
//     design can be iterated without trial-emailing
//   • Pasted into Supabase Dashboard → Authentication → Email Templates
//     → "Reset Password" so Supabase's auth flow sends this branded
//     email instead of its default
//
// Supabase substitutes these template variables when it sends:
//   {{ .ConfirmationURL }}  — one-time reset link (click → set new pw)
//   {{ .SiteURL }}          — pathbinder.gg
//   {{ .Email }}            — recipient's email address
//
// For the local preview we replace these with sample values via the
// PREVIEW_SUBSTITUTIONS object so the file renders directly in a browser.

const PREVIEW_SUBSTITUTIONS = {
  '{{ .ConfirmationURL }}': 'https://pathbinder.gg/?type=recovery&token=PREVIEW',
  '{{ .SiteURL }}':         'https://pathbinder.gg',
  '{{ .Email }}':           'you@example.com',
};

// `siteOrigin` controls where pb_logo.png + dash2.webp resolve from.
// Defaults to pathbinder.gg; the preview script overrides this to use
// relative paths so the images load from local disk.
function renderHtml({ siteOrigin, forPreview }) {
  siteOrigin = siteOrigin || 'https://pathbinder.gg';
  const logoUrl  = siteOrigin + '/pb_logo.png';
  const bgUrl    = siteOrigin + '/dash2.webp';
  const noiseUrl = siteOrigin + '/noise.png';

  // Template-variable placeholders. In Supabase context these get
  // substituted by the auth service. In preview context (forPreview=true)
  // we substitute locally so the HTML renders standalone.
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your PathBinder password</title>
</head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#d8e0e8;">
  <!-- Wrapper: dash2 background image with navy fallback + noise overlay
       (matches the account-page tab styling on the live site). -->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0a0e1a;background-image:url('${noiseUrl}'), url('${bgUrl}');background-size:300px 300px, cover;background-position:top left, center;background-repeat:repeat, no-repeat">
    <tr>
      <td align="center" style="padding:36px 16px">

        <!-- Centered card, rounded corners, teal halo glow. -->
        <table role="presentation" width="540" cellspacing="0" cellpadding="0" border="0" style="max-width:540px;width:100%;background:rgba(10,14,26,0.94);border:1px solid #1AC7A0;border-radius:14px;box-shadow:0 0 0 1px rgba(26,199,160,0.4), 0 0 28px rgba(26,199,160,0.35), 0 0 64px rgba(26,199,160,0.18)">
          <tr>
            <td style="padding:34px 30px 14px;text-align:center">
              <img src="${logoUrl}" alt="PathBinder" width="140" style="display:inline-block;max-width:140px;height:auto;margin-bottom:14px" />
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:800;letter-spacing:0.22em;color:#B87333;text-transform:uppercase;margin-top:8px">
                &#9672;&nbsp; Password Reset &nbsp;&#9672;
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:8px 36px 0">
              <h1 style="font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;color:#ffffff;letter-spacing:0.04em;margin:18px 0 16px;text-align:center">
                Let's get you back in.
              </h1>
              <p style="font-size:14px;color:#d8e0e8;line-height:1.65;margin:0 0 18px;text-align:center">
                We got a request to reset the password on your PathBinder account.
                If that was you, click the button below. If not, ignore this email
                &mdash; your password stays exactly as it is.
              </p>
            </td>
          </tr>

          <!-- CTA button with teal glow -->
          <tr>
            <td style="padding:8px 36px 8px;text-align:center">
              <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#1AC7A0;color:#0a0e1a;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:800;text-decoration:none;padding:14px 34px;letter-spacing:0.06em;border-radius:10px;box-shadow:0 0 20px rgba(26,199,160,0.5), 0 0 40px rgba(26,199,160,0.25)">
                Reset Password &rarr;
              </a>
              <div style="font-size:11px;color:#6a7888;margin-top:14px">
                This link is valid for <strong style="color:#d8e0e8">1 hour</strong>.
                After that, request a new reset link from the sign-in page.
              </div>
            </td>
          </tr>

          <!-- Plain-URL fallback in case the button isn't clickable -->
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

          <!-- Security reminder -->
          <tr>
            <td style="padding:18px 36px 8px">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:rgba(255,217,61,0.04);border:1px solid #1f2939;border-radius:10px">
                <tr>
                  <td style="padding:14px 18px">
                    <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;color:#FFD93D;text-transform:uppercase;margin-bottom:6px;font-weight:700">
                      &#9888; Didn&rsquo;t request this?
                    </div>
                    <div style="font-size:13px;color:#d8e0e8;line-height:1.6">
                      If you didn&rsquo;t ask to reset your password, someone may have
                      tried to access your account. Your current password still works
                      &mdash; no action needed on your end. Consider enabling 2FA on
                      your email account if you haven&rsquo;t already.
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
    // Substitute the Supabase placeholders with realistic sample values
    // so the file renders sensibly in a browser.
    for (const [needle, replacement] of Object.entries(PREVIEW_SUBSTITUTIONS)) {
      html = html.split(needle).join(replacement);
    }
  }
  return html;
}

function renderText({ forPreview }) {
  let text = [
    '◈ PATHBINDER — Password Reset ◈',
    '',
    "We got a request to reset the password on your PathBinder account.",
    "If that was you, open the link below. If not, ignore this email — your",
    "password stays exactly as it is.",
    '',
    '{{ .ConfirmationURL }}',
    '',
    'This link is valid for 1 hour.',
    '',
    "Didn't request this? Your current password still works. Consider",
    'enabling 2FA on your email account if you haven\'t already.',
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
