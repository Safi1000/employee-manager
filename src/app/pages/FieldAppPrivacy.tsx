/**
 * Public: the Bastion Field app's privacy policy, at /privacy/field-app — the
 * page Google Play and the App Store link to. It describes what the app actually
 * does as built (0607–0625), and must change whenever the app collects
 * something new.
 *
 * The app is published on the stores by TECHXSERVE Enterprise (Pvt) Ltd, the
 * developer of Bastion, for the security companies that run on Bastion; each
 * company's staff use it. Renamed from "GGS Field" and written for any such
 * company rather than GGS alone (Shayan, 4 Nov 2026: the app is "Bastion" on the
 * phone and "Bastion Field" on the App Store). Contact given by Shayan, 30 Oct
 * 2026; publisher's name matched to the registered name on the Play account,
 * 2 Nov 2026.
 */

const APP = "Bastion Field";
const PUBLISHER = "TECHXSERVE Enterprise (Pvt) Ltd";
const CONTACT: string | null = "info@techxserve.com";
const UPDATED = "4 November 2026";

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-8 text-lg font-semibold text-foreground">{children}</h2>;
}

export default function FieldAppPrivacy() {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-10 text-sm leading-relaxed text-foreground md:px-8">
        <p className="lbl">Bastion</p>
        <h1 className="mt-2 text-2xl font-semibold">{APP} — privacy policy</h1>
        <p className="mt-1 text-muted-foreground">Last updated {UPDATED} · published by {PUBLISHER}</p>

        <p className="mt-6">
          {APP} (shown on the phone as "Bastion") is a work app for the staff of security companies that run on Bastion —
          site supervisors and office staff. It is not for the public: every login is created by the company you work for,
          and each phone must be approved by that company before it can be used. This page explains what the app collects,
          why, and what happens to it.
        </p>

        <H>What the app collects</H>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li><b>Your login and phone.</b> Your name, employee code or work email, and an identifier for the phone, so your company can approve the phone and know who did what.</li>
          <li><b>Where you are, at the moment you act.</b> When you confirm attendance, record a visit, report an incident or SOS, start or end a trip, or send a request, the app reads the phone's location once and stores it with that record. It does <b>not</b> track you in the background or between those moments.</li>
          <li><b>Photos you take.</b> Photos are taken with the camera inside the app (the app never opens your gallery): visit and incident photos, receipts, odometer readings, scanned staff documents, and staff photos.</li>
          <li><b>What you enter.</b> Attendance marks, visit checklists, incident reports, warnings, tasks, daily report notes, expense and advance requests, trips, and corrections to staff details.</li>
          <li><b>A notification token</b>, if you allow notifications, so the app can tell you when a request is decided.</li>
        </ul>

        <H>What the app shows you</H>
        <p className="mt-2">
          Only what your role needs. Guards' names, codes, shifts, phone numbers and document expiry dates; office staff given
          access to staff files also see contact details, addresses and licence details, to keep those files complete. Never
          national ID card (CNIC) numbers, salaries or bank details. Your own expense and advance requests — never anyone else's.
        </p>

        <H>Why</H>
        <p className="mt-2">
          To run your company's guarding operations: attendance, site supervision, incidents, staff records, and the company's
          own expenses and travel. Nothing is used for advertising, and nothing is sold.
        </p>

        <H>Who it is shared with</H>
        <p className="mt-2">
          It stays inside the company you work for. Your office reviews what is sent from the app in Bastion, the company's
          management system; one company never sees another's records. It is stored with the services that run the app: our
          database host (Supabase), and — only for notifications — Expo, Google (Firebase) and Apple, which deliver them. These
          services process it on your company's behalf and for no other purpose. It is not shared with clients or anyone else
          unless the law requires it.
        </p>

        <H>How long it is kept, and security</H>
        <p className="mt-2">
          Records are kept as part of your company's employment and operational records for as long as those records must be
          kept. Everything travels encrypted, each login reaches only what its role allows, and a phone the company has not
          approved cannot use the app.
        </p>

        <H>Your choices</H>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>You can refuse location or notifications in your phone's settings; the app still works, without them.</li>
          <li>Camera access is needed only for the features that take photos.</li>
          <li>To see, correct or delete what the app holds about you, or to close your login, ask your company's office{CONTACT ? <>, or write to <b>{CONTACT}</b></> : ""}.</li>
        </ul>

        <H>Who we are</H>
        <p className="mt-2">
          The app is built and published by {PUBLISHER}, the developer of Bastion. The company you work for decides what the
          app is used for and controls its own records; {PUBLISHER} runs the app and Bastion on that company's behalf.
          {CONTACT ? <> Questions about this policy: <b>{CONTACT}</b>.</> : null}
        </p>

        <H>Changes</H>
        <p className="mt-2">If the app starts collecting anything new, this page is updated first.</p>
      </div>
    </div>
  );
}
