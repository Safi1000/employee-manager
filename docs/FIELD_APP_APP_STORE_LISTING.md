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
3. Archive with automatic signing for the team, raise `IOS_BUILD_NUMBER`, upload to App Store Connect.

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
