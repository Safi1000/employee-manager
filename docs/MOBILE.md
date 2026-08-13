# Bastion on Android and iOS

The mobile apps are the **same build** the website runs, wrapped in a native
shell by [Capacitor](https://capacitorjs.com). `vite build` produces `dist/`,
`cap sync` copies `dist/` into `android/` and `ios/`, and the shell loads it in
a WebView. There is no second codebase and no second API.

Anything that has to behave differently on a phone branches at runtime through
[`src/app/lib/platform.ts`](../src/app/lib/platform.ts) — never by forking a
component.

| | |
|---|---|
| App name | Bastion |
| App ID | `com.techxserve.bastion` |
| Website the app mirrors | `https://txs-crm.techxserve.com` |
| Android min / target SDK | 24 (Android 7) / 36 |
| iOS deployment target | 15.0 |

---

## Everyday commands

```bash
npm run dev            # browser, as always — unaffected by any of this
npm run cap:sync       # build web + copy into both native projects
npm run cap:android    # build, sync, open Android Studio
npm run cap:ios        # build, sync, open Xcode        (macOS only)
npm run cap:run:android # build, sync, install on the attached device
npm run assets:gen     # regenerate every icon and splash from the brand mark
```

`cap:sync` after **every** web change you want to see natively. The WebView
serves files copied at sync time; it does not read `dist/` live.

---

## What the native shell adds

| Concern | Where |
|---|---|
| Back button, deep links, status bar, keyboard | [`lib/nativeShell.ts`](../src/app/lib/nativeShell.ts) |
| `isNative` / `isIOS` / `isAndroid` / `canSellInApp` | [`lib/platform.ts`](../src/app/lib/platform.ts) |
| Session storage that survives an app restart | [`lib/authStorage.ts`](../src/app/lib/authStorage.ts) |
| Saving an export (Files/share sheet vs. a download) | [`lib/saveFile.ts`](../src/app/lib/saveFile.ts) |
| Opening a link outside the WebView | [`lib/openExternal.ts`](../src/app/lib/openExternal.ts) |
| Safe areas, tap targets, input zoom, `dvh` | [`styles/native.css`](../src/styles/native.css) |
| Wide tables → cards on a phone | [`components/ResponsiveTable.tsx`](../src/app/components/ResponsiveTable.tsx) |

All of it is inert on the web: `native.css` is scoped to `html.native`, a class
only the native shell sets, and every function in `nativeShell.ts` returns
immediately when `isNative` is false.

---

## Billing: the app cannot sell anything

Both stores require their own in-app purchase for digital subscriptions, and
both reject apps that merely *link out* to a web checkout from inside a purchase
flow (App Store Review Guideline 3.1.1, Google Play Payments policy).

So the app is **sign-in only**. `canSellInApp` is `false` on native, which hides
signup, plan changes, AI top-ups and "manage billing". Existing subscribers log
in; buying happens on the website. Read-only plan information — guards used,
renewal date — is still shown, which is permitted.

Do not "fix" this by adding a button that opens the pricing page. That is the
specific thing that gets a build rejected.

---

## Icons and splash screens

`npm run assets:gen` runs [`scripts/make-native-assets.mjs`](../scripts/make-native-assets.mjs),
which draws the Bastion shield as vector, rasterises the five source images into
`assets/`, fans them out to every Android density bucket and iOS slot via
`capacitor-assets`, and then repairs two things the generator gets wrong:

- it insets the adaptive icon's **background** layer as well as the foreground,
  which leaves transparent corners under any launcher mask wider than 66%;
- it emits a PWA icon set into `./icons` that this project does not use.

Edit the mark or the colours in that script, not the generated PNGs — they are
overwritten on the next run.

---

## Building Android for the Play Store

### One-time: create the upload key

```bash
keytool -genkey -v -keystore bastion-upload.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias bastion
```

Put it somewhere **outside** the repo, then create `android/keystore.properties`
(gitignored):

```properties
storeFile=../../secure/bastion-upload.jks
storePassword=…
keyAlias=bastion
keyPassword=…
```

> **Back this file and the `.jks` up off the machine.** Google Play identifies an
> app by its signing key. Lose the keystore and you cannot ship an update to the
> existing listing — ever. A new key means a new listing and every install lost.

### Each release

Bump both values in `android/app/build.gradle` — `versionCode` must increase by
at least 1 on every upload, `versionName` is what users see:

```gradle
versionCode 2
versionName "1.0.1"
```

Then:

```bash
npm run cap:sync
cd android && ./gradlew bundleRelease
```

The signed bundle lands at
`android/app/build/outputs/bundle/release/app-release.aab`. Upload that to the
Play Console. (`assembleRelease` gives an `.apk` instead, for sideloading or
testing — Play requires the `.aab`.)

### Deep links: `assetlinks.json`

`AndroidManifest.xml` declares `android:autoVerify="true"` for
`txs-crm.techxserve.com`, so a Supabase password-reset link opens the app rather
than the browser. That verification only passes once the site serves:

`https://txs-crm.techxserve.com/.well-known/assetlinks.json`

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.techxserve.bastion",
    "sha256_cert_fingerprints": ["<SHA-256 of the signing cert>"]
  }
}]
```

Get the fingerprint from **Play Console → Release → Setup → App integrity**, not
from your local keystore — Play re-signs uploads with its own key, and the
fingerprint that matters is Play's. Until this file is live, Android falls back
to an "open with" chooser; nothing breaks, the link just does not go straight to
the app.

Serve it from `public/.well-known/assetlinks.json` with `Content-Type:
application/json` and no redirect.

---

## Building iOS without a Mac

Xcode only runs on macOS, and there is no way around that — an iOS build must be
compiled and signed on an Apple machine. The realistic options, cheapest first:

1. **A hosted CI runner.** GitHub Actions gives free macOS minutes on public
   repos and paid ones on private; Codemagic and Bitrise both have free tiers
   aimed at exactly this. Push a tag, get an `.ipa` uploaded to TestFlight. This
   is the option to pick — no hardware, and the build is reproducible.
2. **A rented Mac.** MacStadium or Scaleway rent a Mac mini by the hour or
   month. Worth it only if you need to debug interactively on a device.
3. **Someone's MacBook.** Fine for a one-off `npm run cap:ios` to see the app on
   a simulator; a bad plan for shipping, because the signing certificates end up
   on a machine you do not control.

Whichever you choose you still need an **Apple Developer Program** membership
(USD 99/year) to put anything on a device that is not your own, and an App Store
Connect record for `com.techxserve.bastion`.

A minimal Codemagic / GitHub Actions job is:

```
npm ci
npm run build
npx cap sync ios
cd ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Release \
           -archivePath build/App.xcarchive archive
xcodebuild -exportArchive -archivePath build/App.xcarchive \
           -exportOptionsPlist ExportOptions.plist -exportPath build
```

Note there is no `pod install` and no `.xcworkspace`: Capacitor 8 resolves its
plugins through Swift Package Manager (`ios/App/CapApp-SPM`), not CocoaPods.
Most iOS-build guides you will find online still say otherwise.

with the signing certificate and provisioning profile supplied by the CI
provider's code-signing integration rather than checked into the repo.

### Universal Links

The iOS equivalent of `assetlinks.json` is an **apple-app-site-association**
file, served (no extension, `Content-Type: application/json`) from
`https://txs-crm.techxserve.com/.well-known/apple-app-site-association`:

```json
{
  "applinks": {
    "details": [{
      "appID": "<TEAM_ID>.com.techxserve.bastion",
      "paths": ["*"]
    }]
  }
}
```

and requires the Associated Domains capability (`applinks:txs-crm.techxserve.com`)
enabled on the App ID in the Apple Developer portal and in Xcode. `TEAM_ID` is on
the Membership page of your developer account.

---

## Camera and the secure-context rule

[`CameraCapture.tsx`](../src/app/components/CameraCapture.tsx) uses
`getUserMedia`, which browsers only allow on a secure context — `https://` or
`localhost`. Production is HTTPS, so it works. The one case that fails is
opening the dev server from a phone by IP (`http://192.168.x.x:5173`); the
component detects it and says so instead of showing a dead frame.

Native builds are exempt from this entirely — they get the camera through the OS
permission prompt. Those prompts need:

- **Android**: `android.permission.CAMERA` in `AndroidManifest.xml` (present).
- **iOS**: `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` in
  `Info.plist` (present). A missing string is not a warning — the app crashes
  the instant the camera is opened, and App Review rejects a string that does
  not say what the data is used for.

---

## How the UI adapts to a phone

Three rules, applied across the app:

**1. Every table sits in a horizontal scroll container.** A CRM table is 6–11
columns and none of that fits 390 logical pixels. Rather than let a wide table
drag the whole page sideways, each one scrolls inside its own box. Where a table
has a `sticky` header the `overflow-x` goes on the *existing* height-constrained
scroll parent, not a new wrapper — sticky positions against the nearest scroll
container, so a second one detaches the header.

**2. Form field grids stack.** `grid-cols-2` became `grid-cols-1 sm:grid-cols-2`
in 81 places. Two columns of inputs at the 16px minimum font size is unusable on
a phone; above 640px nothing changed.

**3. Record-list pages get a card layout on phones.**
[`MobileCardList`](../src/app/components/MobileCardList.tsx) renders a `md:hidden`
stack of cards next to the page's existing `hidden md:block` table — same rows,
same handlers, one card per record. Adding it is purely additive: no page gave up
its `<table>`, so there is no desktop regression anywhere.

Fifteen lists across twelve pages use it:

| Page | Lists |
|---|---|
| Employees | employee roster (phone number is a `tel:` link) |
| Assignments & Pay | posted employees, per group |
| Clients · Contracts · Invoices | the main record list on each |
| Incidents | incident register |
| Licences & Renewals · Compliance Calendar | expiry lists |
| Sites & Strength | strength reconciliation |
| Assets & Issuance | weapons, uniforms, issuance |
| Expenses & Advances | expenses, advances |
| Users & Permissions | user list |

**Where a page computed values inside its table's `.map()`, that derivation was
lifted out into a named function first** — `deriveContract` in Contracts,
`downloadInvoicePdf` in Invoices. Two copies of that arithmetic would drift, and
the failure would be silent: a contract reading "over by 2" on a laptop and fine
on a phone, with nothing to say which was right.

**Deliberately left as scrolling tables:**

- **The finance ledgers** — Accounting, Treasury, Cash Custody, Financial
  Reports, Receivables, Chart of Accounts, Profit Distribution. Desk work, and a
  nine-column trial balance does not become more readable as a stack of cards.
- **Attendance grids** — a month grid is days × employees. Horizontal scrolling
  *is* the correct interaction; turning a row into a card would destroy the
  thing that makes it readable. Same for the deployment roster.
- **Setup tables** — recurring expense definitions, fixed-expense approvals.
  Configured once, from a desk.

[`ResponsiveTable`](../src/app/components/ResponsiveTable.tsx) also exists and
owns *both* renderings from one column definition. It is the better shape for a
new page; `MobileCardList` is what the existing pages could adopt without
rewriting a working table.

---

## Things that will bite

- **`cap sync` overwrites `android/app/src/main/assets/public/` and
  `ios/App/App/public/`.** Never edit anything in those folders; they are
  build output and are gitignored.
- **`android/` and `ios/` themselves ARE committed.** They hold real
  configuration — manifest permissions, signing setup, deep-link filters, icons,
  Info.plist strings. Deleting and re-adding a platform silently discards all of
  it. If you must, diff before committing.
- **`h-screen` / `100vh` is wrong in a WebView** — it measures the viewport with
  the URL bar hidden, so the bottom of the page sits out of reach. The layout
  shells use `h-dvh` plus the `.app-shell` rule in `native.css`, which subtracts
  the safe-area insets the body already consumed.
- **Anything `fixed`-positioned needs `var(--safe-top)`.** `fixed` positions
  against the viewport, not the safe-area-padded body, so a plain `top-3` lands
  under the notch. The sidebar hamburger shows the pattern.
- **Android auto-backup is off on purpose** (`allowBackup="false"`). It would
  copy the Supabase session out of SharedPreferences into the user's Google
  Drive and restore it onto any device signing in with that account — a CRM
  session for a security company cloned to an unvetted phone. The app keeps no
  local state worth restoring.
