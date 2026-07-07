import { CapacitorConfig } from '@capacitor/cli';

// PathBinder native shell (Capacitor).
//
// Remote-URL wrap: the native app loads the live site at pathbinder.gg, so
// web deploys reach users instantly (no store resubmission for content).
// Offline is handled by the live service worker (caches the app shell) plus
// the IndexedDB data layer shipped in Phase 2.5 (collection + POS + outbox).
// The local `www/` bundle is only a first-launch fallback if the site and
// the SW cache are both unavailable.
//
// Change appId before the first build if you want a different bundle id —
// it must be globally unique and match what you register in App Store
// Connect / Google Play.

const config: CapacitorConfig = {
  appId: 'gg.pathbinder.app',
  appName: 'PathBinder',
  // Appended to the WebView user-agent from the first byte so the remote
  // pathbinder.gg bundle can detect the native shell synchronously (before
  // Capacitor's JS bridge initializes). _isNativeApp() matches /PathBinderApp/.
  appendUserAgent: 'PathBinderApp',
  webDir: 'www',
  server: {
    url: 'https://pathbinder.gg',
    cleartext: false,
    androidScheme: 'https',
    iosScheme: 'https',
    // If pathbinder.gg fails to load (airplane mode, dead signal, first launch
    // offline), Capacitor loads this local page from webDir instead of the raw
    // OS "could not connect" error. The page has a Try again button.
    errorPath: 'offline.html',
  },
  ios: {
    contentInset: 'always',
    backgroundColor: '#0F0D0A',
  },
  android: {
    backgroundColor: '#0F0D0A',
  },
  plugins: {
    SplashScreen: {
      // Remote-URL wrap loads pathbinder.gg over the network, so give the
      // splash long enough to cover the first load instead of flashing blank.
      launchShowDuration: 2500,
      backgroundColor: '#0A0E1A',
      showSpinner: false,
    },
    StatusBar: {
      // App is dark, so use light (white) status-bar content.
      style: 'LIGHT',
      backgroundColor: '#0F0D0A',
    },
  },
};

export default config;
