# GGS Field — Google Play listing and Data Safety answers

Everything to paste into the Play Console when the account is approved. It
describes the app as built (0607–0625, build 9 onward). If the app starts
collecting something new, update this and the privacy page first.

- **Privacy policy URL:** `https://bastion.techxserve.com/privacy/field-app`
- **Website:** `https://bastion.techxserve.com` — its footer links every page below
- **Terms of service:** `https://bastion.techxserve.com/terms`
- **Data processing:** `https://bastion.techxserve.com/data-processing`
- **Security:** `https://bastion.techxserve.com/security`
- **About and contact:** `https://bastion.techxserve.com/contact`
- **Bastion (web) privacy policy:** `https://bastion.techxserve.com/privacy` — not the one Play asks for; that is the field-app page above
- **Developer:** TECHXSERVE Enterprise (Pvt) Ltd · **Contact email:** info@techxserve.com
- **Package name:** `pk.ggs.field`
- **Version:** versionName `1.0.0` (`version` in `mobile/app.json`); versionCode = the GitHub run number, automatically. targetSdk 36 (React Native default).
- **Upload:** the `.aab` from the latest "Field app APK" run on GitHub
  (artifact `ggs-field-<n>-play-bundle`). Turn on **Play App Signing** when
  asked; our key is the *upload* key.

---

## Store listing

**App name** (30 max): `GGS Field`

**Short description** (80 max):
> Attendance, site visits, incidents and requests for GGS field and office staff.

**Full description:**
> GGS Field is the work app for GGS staff. It is not for the public: every login is created by GGS and each phone must be approved by the office.
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
> Everything sent from the app is reviewed by the office in Bastion. The app shows only what each role needs — never CNIC numbers, salaries or bank details. English and Urdu.

**Urdu short description** (add Urdu as a listing language):
> GGS فیلڈ اور دفتری عملے کے لیے حاضری، سائٹ دورے، واقعات اور درخواستیں۔

**Urdu full description:**
> GGS فیلڈ، GGS کے عملے کی کام کی ایپ ہے۔ یہ عام لوگوں کے لیے نہیں: ہر لاگ اِن GGS بناتا ہے اور ہر فون کی منظوری دفتر دیتا ہے۔
>
> سائٹ سپروائزر: اپنی سائٹ کے گارڈز دیکھیں، ہر شفٹ کی حاضری کی تصدیق کریں، دفتر کے بھیجے ریلیور کی تصدیق کریں، جس گارڈ کی تصویر نہ ہو اس کی تصویر لیں۔
>
> دفتری عملہ (دفتر کی اجازت سے): چیک لسٹ اور تصاویر کے ساتھ سائٹ دورے، واقعات کی رپورٹ اور SOS، آج کی روزانہ رپورٹ PDF میں، اپنے اخراجات اور ایڈوانس کی درخواستیں، میٹر کی تصاویر سے سفر، ملازمین کی فائل مکمل کرنا اور دستاویزات اسکین کرنا۔
>
> ایپ سے بھیجی گئی ہر چیز دفتر Bastion میں دیکھتا ہے۔ ایپ ہر کردار کو صرف ضروری معلومات دکھاتی ہے — شناختی کارڈ نمبر، تنخواہ یا بینک کی تفصیل کبھی نہیں۔

**Category:** Business · **Developer:** TECHXSERVE Enterprise (Pvt) Ltd · **Contact email:** info@techxserve.com
**Graphics** (in `mobile/store-assets/`, each rendered from the `.html` beside it with headless Chrome):
- App icon 512×512 — `icon-512.png`, the Bastion shield. Note `mobile/assets/icon.png`
  and the launcher icons are still Expo's placeholders; replace them before the first
  upload so the installed app matches the store icon.
- Feature graphic 1024×500 — `feature-1024x500.png`.
- 2–8 phone screenshots — take them on the test phone signed in to the **demo
  company** (below), never GGS: sites, attendance sheet, a guard's card, Urdu home.

## Demo company (screenshots and the reviewer)

`Northgate Security (Demo)` on prod, seeded 2 Nov 2026 by `scripts/seed-play-demo.sql`
(approved by name). Every person, client, site and phone number is invented:
Lahore region; Aurora Business Park (Tower A, Tower B) and Riverside Medical
Centre (Main Gate); guards NGS-101 to NGS-110.

- **Field login:** supervisor code `NGS-001` + a 6-digit PIN.
- **Web login** `demo-admin@techxserve.com`, super admin of the demo company only —
  used to approve phones (Operations › Field Supervisors).
- The PIN and password are **not** in the repo; they were handed over separately.
  Reset the PIN on Field Supervisors as the demo admin if it is lost.

## First release

- **Release name** (seen only in Play Console): `1.0.0 (build N)`, N = the run number on the `.aab`.
- **Release notes:**

```
<en-US>
First release of GGS Field.
• Supervisors: see your site's guards, confirm shift attendance and relievers, photograph guards without a photo
• Office staff: site visits with checklists and photos, incident reports and SOS, Daily Report as PDF, expense and advance requests, trips by odometer photo, staff file updates
• English and Urdu
Login is created by GGS; each phone is approved by the office.
</en-US>
<ur>
GGS فیلڈ کا پہلا ورژن۔
• سپروائزر: اپنی سائٹ کے گارڈز دیکھیں، شفٹ کی حاضری اور ریلیور کی تصدیق کریں، گارڈ کی تصویر لیں
• دفتری عملہ: سائٹ دورے، واقعات کی رپورٹ اور SOS، روزانہ رپورٹ PDF میں، اخراجات اور ایڈوانس کی درخواستیں، سفر، ملازمین کی فائل
• انگریزی اور اردو
لاگ اِن GGS بناتا ہے؛ ہر فون کی منظوری دفتر دیتا ہے۔
</ur>
```

---

## App content

| Question | Answer |
|---|---|
| Privacy policy | the URL above |
| App access | **All or some functionality is restricted** → give the demo company's supervisor login: choose "Supervisor", code `NGS-001`, the PIN. Say in the box that the phone then waits for approval by the office; approve it as `demo-admin@techxserve.com` when it appears. |
| Ads | No ads |
| Content rating | Questionnaire → *Utility / productivity*, no violence, no user-to-user content → rated Everyone |
| Target audience | 18 and over |
| News app | No |
| Government app | No |
| Financial features | None of the listed (no payments, loans or trading — requests are recorded, not paid, in the app) |
| Health | No |

---

## Data Safety

**Does the app collect or share user data?** Yes, collects. **Shares?** No
(service providers processing on our behalf do not count as sharing).
**Encrypted in transit?** Yes. **Can users request deletion?** Yes — through the
GGS office (the privacy page says so).

| Data type | Collected | Purpose | Optional? |
|---|---|---|---|
| **Location → Precise location** | Yes | App functionality (stored with attendance, visits, incidents, trips, requests; compared with the site's area) | Optional — the app works if refused |
| **Personal info → Name** | Yes | App functionality, Account management | Required |
| **Personal info → Email address** | Yes (office logins) | Account management | Required for office logins |
| **Personal info → Phone number** | Yes (staff details corrected in the app) | App functionality | Optional |
| **Personal info → Address** | Yes (staff details corrected in the app) | App functionality | Optional |
| **Personal info → Other info** | Yes (date of birth, blood group, emergency contact, licence numbers and expiries; scanned documents) | App functionality | Optional |
| **Photos and videos → Photos** | Yes | App functionality (visit, incident, receipt, odometer, document and staff photos) | Optional |
| **Financial info → Other financial info** | Yes (amounts of the user's own expense and advance requests) | App functionality | Optional |
| **App activity → Other user-generated content** | Yes (reports, notes, checklists, attendance marks) | App functionality | Required for those features |
| **Device or other IDs** | Yes (phone identifier for phone approval; notification token) | App functionality, Fraud prevention / security | Required |

Not collected: contacts, messages, calendar, audio, files outside the app,
health, browsing history, payment card details, background location.

---

## Before submitting

1. Privacy page names TECHXSERVE Enterprise (Pvt) Ltd as publisher and info@techxserve.com as contact — done.
2. Review login — done: the demo company's `NGS-001`. Google's reviewer's phone
   appears on the demo company's Field Supervisors waiting for approval.
3. Start on **Internal testing** (up to 100 testers added by email, no review
   wait). To keep it staff-only for good, stay on a **closed testing** track
   with a tester list — Play's public Production track is visible to anyone
   who searches. (A fully private app needs Google Workspace / managed Google
   Play; not worth it for this.)
