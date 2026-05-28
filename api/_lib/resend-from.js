/*
 * Resolve the Resend `from` address from env vars, with two acceptable
 * configurations:
 *
 *   1. RESEND_FROM            = "Moth <dev@send.pathbinder.gg>"    (single)
 *   2. RESEND_FROM_NAME       = "Moth"                              (split)
 *      RESEND_FROM_EMAIL      = "dev@send.pathbinder.gg"
 *
 * The split form exists because copying angle-bracket-wrapped strings
 * through chat / browser UIs has a habit of dropping the bit between
 * the brackets (the recipient sees `Moth <dev@>` because the domain
 * portion was eaten as HTML). Splitting into two plain strings dodges
 * that entire class of error.
 *
 * Returns { ok: true, from } on success, or { ok: false, reason } if
 * the resolved address fails a basic sanity check.
 */
module.exports.resolveResendFrom = function resolveResendFrom() {
  const single = (process.env.RESEND_FROM || '').trim();
  const name   = (process.env.RESEND_FROM_NAME  || '').trim();
  const email  = (process.env.RESEND_FROM_EMAIL || '').trim();

  let from = '';
  if (single) {
    from = single;
  } else if (email) {
    from = name ? `${name} <${email}>` : email;
  } else {
    return { ok: false, reason: 'resend_from_missing' };
  }

  // Sanity: the resolved value must contain a recognizable email address.
  // Catches the "Moth <dev@>" failure mode where the domain got eaten in
  // transit. We don't validate the whole RFC 5322 grammar — just enough
  // to detect the common copy-paste truncations.
  const m = from.match(/<?([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>?/);
  if (!m) {
    return { ok: false, reason: 'resend_from_malformed', value: from };
  }
  return { ok: true, from };
};
