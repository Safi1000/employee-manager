# GGS Field — Google Play listing and Data Safety answers

Everything to paste into the Play Console when the account is approved. It
describes the app as built (0607–0625, build 9 onward). If the app starts
collecting something new, update this and the privacy page first.

- **Privacy policy URL:** `https://bastion.techxserve.com/privacy/field-app`
- **Package name:** `pk.ggs.field`
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

**Category:** Business · **Contact email:** *(the address you want shown publicly)*
**Graphics:** app icon 512×512 (from `mobile/assets/icon.png`), feature graphic
1024×500, and 2–8 phone screenshots — take them from the test phone (home,
attendance, visit, Daily Report, my expenses, Urdu home).

---

## App content

| Question | Answer |
|---|---|
| Privacy policy | the URL above |
| App access | **All or some functionality is restricted** → give a review login. Create a test office login with Field app keys and a test supervisor (code + PIN), approve the reviewer's phone when it appears, and write the steps in the box. |
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

1. Put the public contact email on the privacy page (tell me the address).
2. Make the review logins and keep their phone-approval in mind — Google's
   reviewer's phone will appear on Field Supervisors waiting for approval.
3. Start on **Internal testing** (up to 100 testers added by email, no review
   wait). To keep it staff-only for good, stay on a **closed testing** track
   with a tester list — Play's public Production track is visible to anyone
   who searches. (A fully private app needs Google Workspace / managed Google
   Play; not worth it for this.)
