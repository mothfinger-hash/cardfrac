// api/keepalive.js
// ──────────────────────────────────────────────────────────────────────
// Vercel cron pings this every 4 minutes to keep the serverless
// function instance warm. Discord interactions have a 3-second
// ACK window, and a cold Vercel start (require @supabase/supabase-js
// + tweetnacl + ed25519 verification setup) routinely takes >3s on
// the first invocation after the function has been idle. By bumping
// the function on a regular schedule, the runtime stays in cache and
// /api/discord-bot ack returns instantly.
//
// IMPORTANT: this endpoint MUST stay lightweight. No DB calls, no
// imports beyond what the runtime already needs. If we made it
// expensive, we'd be paying for compute on the cron schedule for no
// real benefit. As written, the response is a static JSON object —
// the only cost is the function boot itself, which is what we want
// to amortize across real user requests.
//
// Cron schedule is defined in vercel.json. The default is every
// 4 minutes (cron expression `*/4 * * * *`). Vercel cron jobs on the
// Pro plan support sub-hourly schedules. On Hobby, cron is daily-only
// — in that case use an external pinger (UptimeRobot, cron-job.org)
// hitting https://pathbinder.gg/api/keepalive every 4-5 minutes.

module.exports = (req, res) => {
  // Lock down to GET-only — Vercel cron uses GET, and we don't want
  // accidental POSTs triggering anything.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    service: 'pathbinder-discord-bot',
    warmed_at: new Date().toISOString(),
  });
};
