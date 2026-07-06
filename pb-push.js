/* PathBinder — native push registration (@capacitor/push-notifications, FCM/APNs).
 *
 * Loaded LAZILY and ONLY inside the native shell (see the loader in pb-app.js),
 * so it has ZERO impact on the web build — this file is never fetched on web.
 *
 * Requires: a Firebase project (FCM) with an APNs auth key uploaded for iOS,
 * google-services.json (Android) + GoogleService-Info.plist (iOS) in the native
 * projects, and `npm i @capacitor/push-notifications` + `npx cap sync`. Tokens
 * land on profiles.push_token (migration_push_tokens.sql); send via /api/send-push.
 */
(function () {
  function cap()      { return window.Capacitor; }
  function isNative() { var c = cap(); return !!(c && c.isNativePlatform && c.isNativePlatform()); }
  function platform() { var c = cap(); return (c && c.getPlatform && c.getPlatform()) || 'unknown'; }

  async function register() {
    if (!isNative()) return;
    var P = cap().Plugins && cap().Plugins.PushNotifications;
    if (!P) { console.warn('[push] @capacitor/push-notifications not installed'); return; }
    try {
      var perm = await P.checkPermissions();
      if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
        perm = await P.requestPermissions();
      }
      if (perm.receive !== 'granted') { console.log('[push] permission not granted'); return; }

      // Android 8+ requires a notification channel for the system-tray
      // notification to display. Its id MUST match the channelId our server
      // sends (see api/_lib/push.js android.notification.channelId).
      if (platform() === 'android' && P.createChannel) {
        try {
          await P.createChannel({
            id: 'pathbinder', name: 'PathBinder',
            description: 'Sales, orders, messages, and wishlist alerts',
            importance: 5, visibility: 1,
          });
        } catch (e) { console.warn('[push] createChannel failed', e && e.message); }
      }

      // Persist the device token to the user's profile for the server sender.
      P.addListener('registration', function (tok) {
        if (tok && tok.value && typeof window._pbStorePushToken === 'function') {
          window._pbStorePushToken(tok.value, platform());
        }
      });
      P.addListener('registrationError', function (err) { console.warn('[push] registration error', err); });

      // Deep-link when the user taps a notification (data: { page, order, ... }).
      P.addListener('pushNotificationActionPerformed', function (action) {
        try {
          var data = action && action.notification && action.notification.data;
          if (data && typeof window._pbHandlePushTap === 'function') window._pbHandlePushTap(data);
        } catch (_) {}
      });

      await P.register();
    } catch (e) { console.warn('[push] init failed', e && e.message); }
  }

  window._pbInitNativePush = register;
  register();
})();
