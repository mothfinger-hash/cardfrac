# PathBinder — Native shell (Capacitor)

This folder is the **native wrapper** for PathBinder. It loads the live site
(`https://pathbinder.gg`) inside a native iOS/Android WebView and ships to the
App Store + Google Play. The web app, service worker, and the Phase 2.5
offline data layer all do the real work — this is just the native container.

**Why remote-URL:** web deploys reach users instantly with no store
resubmission. Only changes in *this* folder (plugins, icons, permissions,
the native shell) require a rebuild + store review.

The native projects (`ios/`, `android/`) are **generated**, not committed —
you create them on your Mac with the steps below.

---

## Prerequisites (on your Mac)

- Node 18+ and npm
- **Xcode** + CocoaPods (`sudo gem install cocoapods`) for iOS
- **Android Studio** (with an SDK + a device/emulator) for Android
- Apple Developer Program ($99/yr) and Google Play Developer ($25 once) when
  you're ready to submit

## First-time setup

```bash
cd native
npm install
npx cap add ios
npx cap add android
npx cap sync
```

`cap sync` copies `www/` + the config into both native projects and installs
the native halves of the plugins.

## Open / run

```bash
npx cap open ios       # opens Xcode  → pick a device → Run
npx cap open android   # opens Android Studio → Run
```

After any change to `capacitor.config.ts`, `www/`, or the plugin list, re-run
`npx cap sync`.

---

## Native permissions to add

The scanner uses the camera (via the web `getUserMedia` API inside the
WebView), and photo upload may touch the library. Add these or the OS will
silently block them:

**iOS** — `ios/App/App/Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>PathBinder uses the camera to scan your trading cards.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>PathBinder lets you attach photos of your cards.</string>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>PathBinder can save card images to your library.</string>
```

**Android** — `android/app/src/main/AndroidManifest.xml` (INTERNET is already
there):

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

---

## App icon + splash

Put a 1024×1024 master at `native/assets/icon.png` (and an optional
`splash.png`), then:

```bash
npx capacitor-assets generate
```

It generates every icon/splash size for both platforms.

---

## Apple Sign-In (required if Google sign-in stays on iOS)

Apple rejects iOS apps that offer a third-party social login (you have Google
via Supabase) unless they **also** offer Sign in with Apple. To add it:

1. `npm install @capacitor-community/apple-sign-in`
2. Enable the **Sign in with Apple** capability in Xcode (Signing &
   Capabilities).
3. Configure Apple as an OAuth provider in Supabase (Auth → Providers →
   Apple) and add the Apple sign-in button on iOS only (gate with
   `window.Capacitor?.getPlatform() === 'ios'`).

The web app already detects the native shell via `_isNativeApp()` (now
includes `window.Capacitor.isNativePlatform()`), so you can branch native-only
UI off that.

---

## App Store gotchas (from APP_STORE_PLAN.md)

- **Minimum functionality (Apple 4.2):** a pure web wrapper can be rejected.
  The camera scanner is the native value that answers this — make sure it
  works in the build. (On-device ML Kit OCR for *offline* scanning is the
  planned follow-up; not required for first submission.)
- **Account deletion** must be reachable in-app (already supported via
  `/api/delete-account`).
- **Privacy + Terms URLs:** already live at `/privacy-policy`,
  `/terms-of-service`, etc.
- **Subscriptions / IAP:** web-only subscriptions are wired (`_isNativeApp()`
  routes native subscribe taps out to the web checkout). Confirm this still
  satisfies current App Review guidance before submitting — Apple's external-
  purchase rules shift; this is the one policy item to double-check.

## How updates work

- **Web change** (anything on pathbinder.gg): deploy → users get it next
  launch. No rebuild.
- **Native change** (plugin/icon/permission/shell): `npx cap sync` → rebuild
  in Xcode/Android Studio → upload → store review.

## Future: offline scanning

The camera scan is currently cloud OCR (`/api/vision-ocr`) + the
`match_cards_v2` embedding RPC, so it needs signal. To make POS scanning work
offline, add an on-device **ML Kit text recognition** plugin and match its
output against the already-cached collection (Phase 2.5a). That's a native-
only capability, which is why it lives here rather than in the PWA.
