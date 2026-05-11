# PathBinder — App Store Launch Plan

## TL;DR — The Strategy

Wrap the existing web app in **Capacitor** (Ionic's native shell), submit to the App Store and Google Play, and **load the live `pathbinder.vercel.app` URL from inside the shell** rather than bundling all the HTML/CSS/JS into the binary.

This is the same architecture Twitter, LinkedIn, Spotify, and most "web-based" mobile apps use. It gives you two huge wins:

1. **Most updates ship instantly** — you push to Vercel and users get the new version on their next launch. No App Store review, no waiting.
2. **You don't rewrite the codebase** — Capacitor takes the existing `index.html` and renders it inside a native WebView with full access to native APIs (camera, push, biometrics, file system, etc.) via plugins.

---

## Phase 1 — PWA Hardening (~1–2 days)

Before wrapping it as a native app, make sure the web app feels like an app when installed.

- **`manifest.json`** — needs name, short_name, theme_color (`#0a0d1a` matches your dark theme), background_color, display: `standalone`, all required icon sizes (192×192 and 512×512 minimum, ideally up to 1024×1024).
- **iOS meta tags** — `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-touch-icon` link tags.
- **Service worker** — already in place at `sw.js`. Verify it handles offline gracefully with the `offline.html` fallback that's already cached.
- **Splash screens** — generate via Capacitor's `@capacitor/assets` plugin once you have the project set up.
- **Test on real devices** — open the site in iOS Safari and Android Chrome, "Add to Home Screen", verify it launches cleanly without browser chrome.

The work here mostly translates 1:1 into the Capacitor app, so it's not wasted effort.

---

## Phase 2 — Capacitor Wrapper (~3–7 days)

Capacitor is a thin native shell. You'll create a tiny new project that does basically nothing except point at your web app and add native capabilities.

### Setup

```bash
mkdir pathbinder-native && cd pathbinder-native
npm init @capacitor/app
npm install @capacitor/core @capacitor/cli
npx cap add ios       # requires macOS + Xcode
npx cap add android   # requires Android Studio
```

### Configure to load the live site

`capacitor.config.ts`:

```typescript
import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.pathbinder',   // reverse-DNS, must be unique
  appName: 'PathBinder',
  webDir: 'public',          // local fallback bundle
  server: {
    url: 'https://pathbinder.vercel.app',
    cleartext: false,
    androidScheme: 'https'
  },
  plugins: {
    SplashScreen: { launchShowDuration: 1200, backgroundColor: '#0a0d1a' },
    StatusBar:    { style: 'DARK', backgroundColor: '#0a0d1a' }
  }
};
export default config;
```

The `server.url` makes the native app load your Vercel site directly. The `webDir` can hold a static fallback (e.g. an offline page) for when there's no connectivity.

### Plugins to add

- `@capacitor/camera` — for the card scanner (better UX than `<input type="file">`)
- `@capacitor/push-notifications` — when you're ready to add notifications
- `@capacitor/preferences` — durable storage that survives WebView wipes (use alongside `localStorage`)
- `@capacitor/share` — native "Share" sheet for binders / public links
- `@capacitor/status-bar` — control the iOS/Android status bar styling
- `@capacitor/sign-in-with-apple` — **mandatory** if you offer any social sign-in on iOS (Apple's rule)
- `@capacitor/haptics` — taps/buzzes on actions like coin flip results

You wire these into your existing JS by feature-detecting:

```js
if (window.Capacitor?.Plugins?.Camera) {
  // use native camera
} else {
  // fall back to <input type="file">
}
```

### Build pipeline

- iOS: `npx cap open ios` → opens Xcode → archive → upload to App Store Connect
- Android: `npx cap open android` → opens Android Studio → build AAB → upload to Play Console

---

## Phase 3 — App Store Submission

### Apple App Store

| Item | Cost / Effort |
|---|---|
| Apple Developer Program | **$99/year** |
| App icon (1024×1024 + many smaller) | A few hours of design |
| Screenshots (iPhone 6.7", 6.1", 5.5" + iPad if supporting) | Use the live app on a simulator |
| App description, keywords, support URL, privacy URL | A few hours |
| Privacy nutrition label | Required — declare what data you collect |
| Review timeline | **24h – 7 days** typical |

**Critical gotcha:** Apple will reject apps that are "essentially a wrapped website" with no native value. PathBinder is fine here because the camera scanning is a legitimate native feature. You'll want to make sure:
- The scanner uses `@capacitor/camera` (native), not just the web `<input type="file">`
- Push notifications are wired up at least minimally
- The app works at least somewhat offline (cached pages from the service worker)

**Apple Sign-In requirement:** Currently you support Google sign-in (probably via Supabase). On iOS, if you offer ANY social sign-in, you MUST also offer Sign in with Apple. Wire up `@capacitor/sign-in-with-apple` + Supabase's Apple OAuth provider.

### Google Play Store

| Item | Cost / Effort |
|---|---|
| Google Play Developer account | **$25 one-time** |
| AAB (Android App Bundle) | Built via Android Studio |
| Store listing assets | Same screenshots you made for iOS |
| Content rating questionnaire | Short form |
| Data safety form | Similar to Apple privacy labels |
| Review timeline | **A few hours – 3 days** typical |

Google's review is much faster and less strict than Apple's.

---

## Phase 4 — How Updates Actually Work

This is the part where the architecture pays off.

### Two kinds of updates

**A. Web content updates — instant, no review**

If you change anything in `index.html`, `sw.js`, or any other web asset:

1. Edit the file locally (like we've been doing)
2. Push / deploy to Vercel
3. Bump the SW cache version (`pathbinder-v20` → `v21`) — we've been doing this already, so it's a habit
4. Users get the update on their **next app launch** automatically

This includes: new features, UI changes, bug fixes, copy edits, even most new pages. The service worker fetches the new index, the cache invalidates, and the user is on the latest version.

Timeline: **5 minutes from commit to "in users' hands"**.

This is allowed by both Apple and Google as long as you're not downloading new executable code that fundamentally changes what the app does (e.g. you can't ship a totally different app to bypass review). Adding features, fixing bugs, redesigning screens — all fine.

**B. Native binary updates — slow, requires review**

If you change anything in the Capacitor shell itself:
- Adding or upgrading a native plugin
- Bumping the iOS/Android target version
- Changing the app icon, name, or splash screen
- Updating the app's permissions (e.g. "needs camera access" string)
- Fixing a bug in the native shell

…you have to rebuild the AAB / IPA, upload to App Store Connect / Play Console, and wait for review.

Timeline: **24h–7 days for iOS, hours–3 days for Android.**

### Practical cadence

In practice, you'll probably do:

- Native binary submission **once every 1–3 months** when you add a new native plugin or do a significant version bump
- Web deploys **as often as you want** — multiple per day during active development, weekly when stable

We've been on a weekly-ish cadence already (the recent bg-removal fix, gauge work, coin flip fix, badge fixes, etc. would all have shipped instantly to users on the native app).

### Version compatibility

When you do ship a native update, some users will be on the new shell and some still on the old. The web code has to handle both:

```js
const hasNativeCamera = !!window.Capacitor?.Plugins?.Camera;
```

Feature detection like that means a single web codebase works for all native shell versions plus the regular web app at pathbinder.vercel.app. We already do this kind of branching for `currentUser` / guest mode — same pattern.

---

## Pre-Launch Checklist

Things to nail before submitting:

- [ ] Privacy policy URL (Apple and Google both require one) — host a `privacy.html` on Vercel
- [ ] Terms of service URL
- [ ] Account deletion flow accessible from inside the app (Apple requires this since iOS 17)
- [ ] Sign in with Apple (if you keep Google sign-in on iOS)
- [ ] All `localStorage` keys also persisted to Supabase so a fresh install restores state
- [ ] App icon design (1024×1024 master) + adaptive icon variants for Android
- [ ] Screenshots from 3+ device sizes
- [ ] Support email / URL
- [ ] Test the IAP flow if you're putting subscription tiers behind native purchases (Apple takes 15–30% on digital goods — there are carve-outs for "real-world goods/services" worth researching since PathBinder is partly that)
- [ ] Marketing copy: short description, full description, keywords (iOS only — 100 chars)

---

## Costs Summary

| Item | One-time | Recurring |
|---|---|---|
| Apple Developer Program | — | **$99 / year** |
| Google Play Developer | **$25** | — |
| App icon + screenshots design (if outsourced) | $200–800 | — |
| Capacitor + native plugins | Free (open source) | — |
| Vercel hosting | — | Already paying |
| Supabase | — | Already paying |
| Apple/Google in-app purchase fees | — | **15–30%** of digital sales (if you sell subs through stores) |

Skipping the IAP requirement (e.g. taking payment through your own Stripe instead) saves you the 15–30% but Apple is increasingly strict about this. Worth researching the "reader app" and "marketplace" carve-outs in their guidelines.

---

## Realistic Timeline

Assuming part-time work alongside other dev:

- **Week 1:** PWA hardening + Capacitor project setup, ship to a Vercel preview, sideload onto your phone
- **Week 2:** Wire up camera plugin (replace the scanner's `<input type="file">`), test thoroughly
- **Week 3:** Apple Developer enrollment (can take a few days for individual / 1–2 weeks for LLC), Google Play account, icon + screenshots
- **Week 4:** Submit to TestFlight (iOS beta) + Play Console internal testing, invite friends
- **Week 5–6:** Iterate based on tester feedback, fix anything weird in the WebView
- **Week 7:** Production submission. Apple may push back once or twice — budget for one re-submission

So **~6–8 weeks** to live in stores from a standing start. Could be faster with focused work.

---

## What we can do right now in the existing codebase

A few small things that'd make the eventual port easier (low effort, do anytime):

- Make sure all storage goes through a wrapper function instead of raw `localStorage` calls, so we can swap in `@capacitor/preferences` later with one edit
- Add proper iOS PWA meta tags to `<head>`
- Verify `manifest.json` has all required icon sizes
- Centralize the user-agent / platform detection so feature-gating native vs. web is one switch

I can do any of these whenever you want — just say the word.
