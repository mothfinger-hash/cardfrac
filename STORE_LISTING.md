# PathBinder — Store Listing & Privacy Disclosures

Copy-paste reference for App Store Connect (iOS) and Google Play Console
(Android). Character limits are noted in brackets. Swap in your own wording
anywhere it doesn't sound like you.

---

## 1. Apple App Store

### Identity

- **App Name** [30]: `PathBinder: TCG Card Tracker`  *(28 chars)*
  - Alt: `PathBinder — Card Collection` (28)
- **Subtitle** [30]: `Scan, track & sell your cards`  *(29)*
- **Primary category:** Lifestyle
- **Secondary category:** Shopping  *(or Utilities)*
- **Support URL:** `https://pathbinder.gg`  *(add a /support page if you have one)*
- **Marketing URL:** `https://pathbinder.gg`
- **Privacy Policy URL:** `https://pathbinder.gg/privacy-policy`

### Promotional Text [170] — changeable any time, no review

```
Scan a card and it's logged in seconds. Track real-time market value across
every major TCG, build digital binders, and buy or sell in a collector-run
marketplace.
```

### Keywords [100, comma-separated, no spaces after commas]

```
pokemon,tcg,card,collection,scanner,binder,magic,yugioh,one piece,price,value,trading,marketplace,sell
```

### Description

```
PathBinder is where TCG collectors finally feel organized.

Scan your cards with your camera and they're logged instantly — name, set,
number, condition, and live market value. Build digital binders, track what
your collection is worth over time, and never lose track of a card again.

ONE APP FOR EVERY GAME
Pokémon, Magic: The Gathering, Yu-Gi-Oh!, One Piece, and more — all in a
single collection, with set checklists and variant tracking (normal, reverse
holo, and beyond).

KNOW WHAT IT'S WORTH
Live pricing and value history so you always know where your collection
stands. Set the cards you're chasing and watch the market.

A MARKETPLACE BUILT FOR COLLECTORS
Buy and sell singles and sealed product in a collector-run marketplace.
List in a tap straight from your binder, with secure checkout and prepaid
shipping labels.

BUILT FOR SHOPS & VENDORS
Run your booth or store with on-shelf inventory, a fast point-of-sale scan
mode, and a sales log — even offline at a card show, syncing when you're
back online.

WORKS OFFLINE
Your collection and POS keep working with no signal, so a dead spot at a
convention never slows you down.

Free to start. Upgrade any time for marketplace selling, bulk tools,
multi-binder organization, and shop features.
```

### App Review notes (private — to the reviewer)

```
Demo account:
  email: <create a review-only account>
  password: <...>

Subscriptions are sold via the web (not in-app purchases) and are optional;
all core collection features work on the free tier. The marketplace and
shop/POS tools are accessible from the account once signed in.
```

### Age rating
Likely **12+** (user-generated content + marketplace messaging). Answer the
questionnaire honestly — the marketplace + DMs push it above 4+.

---

## 2. Google Play Store

- **App title** [30]: `PathBinder: TCG Card Tracker`
- **Short description** [80]:
  ```
  Scan, track & value your trading cards. Build binders. Buy & sell.
  ```
- **Full description** [4000]: reuse the App Store description above.
- **Category:** Lifestyle  *(or Shopping)*
- **Tags:** trading card games, collection, scanner
- **Contact email:** support@pathbinder.gg
- **Privacy Policy:** `https://pathbinder.gg/privacy-policy`

---

## 3. Apple Privacy "Nutrition Label"

For each type: **collected? · linked to the user? · used for tracking?**
You do **no cross-app tracking / advertising**, so **Tracking = No** for all.

| Data type | Collected | Linked to user | Purpose |
|---|---|---|---|
| **Email Address** | Yes | Yes | App Functionality (account/login) |
| **Name / Username** | Yes | Yes | App Functionality |
| **Physical Address** (shipping, marketplace orders) | Yes | Yes | App Functionality |
| **User ID** | Yes | Yes | App Functionality |
| **Photos** (card images you upload) | Yes | Yes | App Functionality |
| **Other User Content** (collection, listings, messages, reviews) | Yes | Yes | App Functionality |
| **Purchase History** (subscriptions, marketplace orders) | Yes | Yes | App Functionality |
| **Product Interaction / Usage Data** (if you keep Vercel Speed Insights) | Yes | Yes/No* | Analytics |
| **Crash / Diagnostics** (if any) | Maybe | No | Analytics |

\* If analytics is anonymous, mark Usage Data as **not linked**. If you don't
run any analytics SDK, you can drop the last two rows.

**Payment card numbers:** handled entirely by **Stripe** — you never receive
or store card data, so you do **not** declare "Payment Info" as collected by
your app (Stripe discloses it as the processor).

**Data used to track you:** **None.**

---

## 4. Google Play Data Safety Form

**Does your app collect or share user data?** Yes.

**Is data encrypted in transit?** Yes (HTTPS).
**Can users request data deletion?** Yes — in-app account deletion.

### Data types — collected (all processed for app functionality, not for ads)

- **Personal info:** Email address, Name, **User IDs**, **Address** (shipping).
- **Photos and videos:** Photos (uploaded card images).
- **App activity:** In-app actions / other user-generated content (collection,
  listings, messages).
- **Financial info:** **Purchase history** (subscriptions + orders). Card
  numbers are processed by Stripe, not collected by the app.
- **App info & performance:** Crash logs / diagnostics *(only if you run
  analytics — otherwise omit).*

### Data shared with third parties (service providers)

These process data to run the service (payments, shipping, email, hosting):

- **Stripe** — payments
- **Shippo** — shipping labels/tracking
- **Supabase** — backend/database hosting
- **Resend** — transactional email

Disclose these as data **processing by service providers**; you are not
"sharing" for advertising. None is used for tracking or ad targeting.

---

## 5. Pre-submission checklist tie-ins

- [ ] Create a **review-only demo account** and put creds in App Review notes.
- [ ] Confirm **account deletion** is reachable in-app (you have
      `/api/delete-account` — make sure the button is easy to find; Apple
      checks this).
- [ ] **IAP policy:** subscriptions sell on the web, not via StoreKit. This is
      the one thing reviewers may flag — be ready to point out that all core
      features are free and subscriptions are an optional web service. Have a
      fallback plan if they push back (StoreKit IAP for the digital tiers).
- [ ] Screenshots: iPhone **6.7"** + **6.1"** (required), iPad if you support
      it; one **phone** size for Play.
- [ ] App icon (done) + version `1.0` / build `1`.
