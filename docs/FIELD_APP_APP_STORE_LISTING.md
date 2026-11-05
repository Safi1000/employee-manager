# Bastion Field — App Store listing, review notes and App Privacy

Everything to paste into App Store Connect for the iPhone app. Same app and
same data as Android (see `FIELD_APP_PLAY_LISTING.md`); if the app starts
collecting something new, update both and the privacy page first.

- **Name on the App Store:** `Bastion Field` (Shayan, 3 Nov 2026). The name under
  the icon on the phone is `Bastion` (`name` in `mobile/app.json`).
- **Bundle ID:** `pk.ggs.field` (same as Android's package; never changes)
- **SKU:** anything unique to you, e.g. `bastion-field-ios`
- **Primary language:** English (U.K.) or English (U.S.)
- **Version:** `1.0.0` (`version` in `mobile/app.json`); build number = `IOS_BUILD_NUMBER`, raised for every upload
- **Privacy policy URL:** `https://bastion.techxserve.com/privacy/field-app`
- **Support URL:** `https://bastion.techxserve.com/contact`
- **Marketing URL** (optional): `https://bastion.techxserve.com`
- **Copyright:** `2026 TECHXSERVE Enterprise (Pvt) Ltd`
- **Category:** Business (secondary: Productivity)
- **Price:** Free · **Availability:** Pakistan (add others only if Bastion is sold there)

---

## Building and uploading (on the Mac, not Expo's cloud)

The repo's path contains a space, which React Native's bundling script cannot
take, so the iPhone build runs from a copy at `~/Developer/ggs-field-ios`
(`.env` there holds the two public Supabase settings, copied from
`.github/workflows/field-app.yml`; `ios/.xcode.env.local` points at
`~/Developer/ggs-node`, a link to `.tools/node-…`). To rebuild:

1. `rsync -a --delete --exclude /ios --exclude /android --exclude /.expo --exclude /.env mobile/ ~/Developer/ggs-field-ios/`
2. In the copy: `CI=1 npx expo prebuild -p ios --clean`, then rewrite `ios/.xcode.env.local`.
3. Archive with automatic signing for the team, raise `IOS_BUILD_NUMBER`, upload to App Store Connect:
   - Team **TECHXSERVE Enterprise LLC**, ID `N98K65Q4N4` (signed in to Xcode → Settings → Accounts).
   - `xcodebuild -workspace Bastion.xcworkspace -scheme Bastion -configuration Release -destination 'generic/platform=iOS' -archivePath build/Bastion.xcarchive DEVELOPMENT_TEAM=N98K65Q4N4 CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates archive`
   - then `xcodebuild -exportArchive … -exportOptionsPlist ~/Developer/ggs-field-ios-export/ExportOptions-upload.plist -allowProvisioningUpdates` (method `app-store-connect`, destination `upload`).
   - Automatic signing needs at least ONE device registered to the team, even for an App Store build — Shayan's iPhone (`00008160-000C193A28E14036`) was added on developer.apple.com → Devices on 3 Nov 2026.
   - Build 1 (1.0.0) uploaded 3 Nov 2026 23:51. The next upload needs `IOS_BUILD_NUMBER=2` before `prebuild`.

iOS 27 refuses to launch an app that has not adopted the scene life cycle;
`expo-build-properties` → `ios.enableSceneSupport: true` in `app.json` does it
for SDK 57 (remove it on SDK 58, where it is the default).

---

## Store listing

**Subtitle** (30 max):
> Site attendance for guards

**Promotional text** (170 max, can change any time without review):
> The field app for security companies on Bastion: guard rosters, shift attendance, site visits and incident reports, in English and Urdu.

**Description:**
> Bastion Field is the work app for the staff of security companies that run on Bastion. It is not for the public: every login is created by the company, and each phone is approved by its office.
>
> Site supervisors
> • See the guards posted at their sites
> • Confirm each shift's attendance — present, absent, leave, double duty
> • Confirm the relievers the office sent
> • Take a photo for a guard who has none
>
> Office staff (each feature given by the office)
> • Site visits with a checklist and photos
> • Report incidents, and an SOS button that alerts the office
> • Today's Daily Report, shared as a PDF
> • Own expense and advance requests, with receipt photos
> • Trips by odometer photos
> • Staff files: fill in missing details and scan documents for HR
>
> Everything sent from the app is reviewed by the office in Bastion. The app shows only what each role needs — never ID card numbers, salaries or bank details. English and Urdu.

**Keywords** (100 max, comma-separated, no spaces needed):
> security,guard,attendance,roster,supervisor,site,patrol,incident,shift,field,staff,Urdu,Pakistan

**Screenshots:** 6.9″ iPhone, 1320 × 2868 (taken on the iPhone 18 Pro Max simulator),
3–10 of them, **from the demo company only** (Northgate Security, supervisor
`NGS-001`) — never GGS's real clients, sites or guards. Suggested: sites list,
a site's guards, today's attendance sheet, a guard's card, the Urdu home.
Apple uses the 6.9″ set for every smaller iPhone; no iPad set is needed
(`supportsTablet: false`).

---

## App Review Information

- **Sign-in required:** Yes
- **User name:** `NGS-001` (choose the **Supervisor** tab)
- **Password:** the demo PIN — handed over separately, never in the repo
- **Contact:** your name, phone, `info@techxserve.com`
- **Notes:**

```
Bastion Field is an internal work app for the staff of security companies using
Bastion. Accounts are created by the company; there is no public sign-up.

Demo login (a demo company, every person and site in it is invented):
  Supervisor tab → employee code NGS-001 → the PIN above.

Normally each new phone must be approved by the company's office before the app
can be used. For this demo company the phone is approved automatically, so you
will go straight in.

What to try: open a site → see its guards → "Today's attendance" → confirm a
shift. Location is asked for only when confirming attendance; the app works if
it is refused. The camera is used only for guard / visit / incident photos.

We request Unlisted App Distribution: the app is meant only for these companies'
staff and should not appear in App Store search.
```

## Unlisted distribution

After the first approval, request it at
`https://developer.apple.com/support/unlisted/app-request/` (needs the App Store
Connect app ID). Once granted, the app is reachable only by its direct link,
which the office sends to staff; it does not appear in search or charts.

## Age rating

Questionnaire: every item **None** / **No** (no violence, no user-generated
content shared publicly, no web browsing, no gambling, no medical advice) → **4+**.
"Made for Kids": No.

## Encryption (export compliance)

Answered in the app itself: `ITSAppUsesNonExemptEncryption = false` in
Info.plist (HTTPS only), so App Store Connect does not ask on each upload.

---

## App Privacy ("nutrition label")

**Do you or your third-party partners collect data from this app?** Yes.
For every type below: **Linked to the user: Yes · Used for tracking: No.**
Purpose for all: **App Functionality** (plus the extra purpose noted).

| Apple category → type | Collected | What it is |
|---|---|---|
| Contact Info → **Name** | Yes | the login's name |
| Contact Info → **Email Address** | Yes | office logins only |
| Contact Info → **Phone Number** | Yes | staff details corrected in the app |
| Contact Info → **Physical Address** | Yes | staff details corrected in the app |
| Health & Fitness → **Health** | Yes | blood group, entered with staff details (optional) |
| Financial Info → **Other Financial Info** | Yes | amounts of the user's own expense / advance requests |
| Location → **Precise Location** | Yes | stored with attendance, visits, incidents, trips |
| User Content → **Photos or Videos** | Yes | visit, incident, receipt, odometer, document and guard photos |
| User Content → **Other User Content** | Yes | reports, notes, checklists, attendance marks |
| Identifiers → **Device ID** | Yes | phone identifier for phone approval; notification token. Extra purpose: **App Functionality** only (it is security, not advertising) |

Not collected: contacts, messages/emails, browsing or search history,
purchases, payment info, credit info, audio, fitness, sensitive info beyond the
above, diagnostics, advertising data.

---

## Resubmission after Guideline 2.1 "Information Needed" (5 Nov 2026)

Apple asked for six things in the Notes field, plus a screen recording. Also
remove `1-sign-in` from the screenshots (Guideline 2.3.3: screenshots must show
the app in use, not the login page). Paste this into **App Review Information →
Notes**, replacing the earlier notes:

```
1. SCREEN RECORDING
A recording made on a physical iPhone running the latest iOS is here: https://drive.google.com/file/d/1McKXcVxiId9ss7VjM_9FFUDRvk3W2A4Z/view
It starts at launch and shows: signing in with the demo supervisor account, the
supervisor's sites, a site's guard list, today's attendance sheet, confirming a
shift, switching the app to Urdu, and signing out.
The app has no account registration: every login is created by the employer's
office in the Bastion web system, so there is no in-app sign-up and account
deletion is handled by the employer (described in the privacy policy). The app
has no user-generated content shared between users, no public posting, and no
paid content or in-app purchases.

2. PURPOSE AND AUDIENCE
Bastion Field is the mobile companion to Bastion, an operations system used by
private security (guarding) companies in Pakistan. Its users are the company's
own staff: site supervisors confirm each shift's attendance for the guards at
their sites and photograph guards; office staff record site visits, incidents,
their own expense requests and trips. It replaces paper registers and WhatsApp
messages, so attendance and payroll in the office are based on what was
confirmed at the site. It is not for the general public.

3. HOW TO ACCESS IT
Choose the "Supervisor" tab and sign in with the employee code and PIN given in
the Sign-In Information above (code NGS-001). This is a demo company,
"Northgate Security (Demo)" — every person, site and phone number is invented.
After sign-in you see three sites; open one to see its guards, then
"Today's attendance" to mark present / absent / leave and confirm the shift.
The Urdu button switches the language. In real companies a new phone must be
approved by the office; for this demo account the phone is approved
automatically, so no waiting is involved.

4. EXTERNAL SERVICES
- Supabase (database, authentication and file storage) — hosts the Bastion data
  the app reads and writes.
- Expo Push Service with Apple Push Notification service (and Firebase Cloud
  Messaging on Android) — delivers notifications when a request is decided.
- Apple's on-device location and camera APIs (no third-party mapping or AI services).
No payment processors, advertising or analytics SDKs are used.

5. REGIONAL DIFFERENCES
None. The app works the same in every region. It is built for security companies
in Pakistan and offers English and Urdu.

6. REGULATED INDUSTRY / THIRD-PARTY MATERIAL
The app does not provide a regulated service to the public and contains no
protected third-party content. It is an internal operations tool used by the
employer's own staff. Published by TECHXSERVE Enterprise (Pvt) Ltd, the developer
of Bastion.

DISTRIBUTION: the app is meant only for these companies' staff; we would like it
distributed as an Unlisted App once approved.
```
