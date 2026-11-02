/**
 * Public: Bastion's legal and company pages — the ones the landing footer
 * names. /privacy, /terms, /data-processing, /security, /contact (also /about).
 * The GGS Field app keeps its own policy at /privacy/field-app, linked from here.
 *
 * Written 2 Nov 2026 from how Bastion is actually built: the processors listed
 * are the services the code calls (Supabase, Vercel, Stripe, Resend, Google
 * Drive, Expo/Firebase/Apple for push). Add one to the list before the code
 * starts calling it. The AI assistant was retired 29 Oct 2026 and is not listed.
 *
 * DEFERRED: these are plain-language terms written by the developers, not by a
 * lawyer. A review by counsel is owed; the governing-law clause (Pakistan) and
 * the absence of a postal address are the two points it should settle.
 */

import type { ReactNode } from "react";

const PUBLISHER = "TECHXSERVE Enterprise (Pvt) Ltd";
const CONTACT = "info@techxserve.com";
const UPDATED = "2 November 2026";

const NAV: [string, string][] = [
  ["/privacy", "Privacy"],
  ["/terms", "Terms"],
  ["/data-processing", "Data processing"],
  ["/security", "Security"],
  ["/contact", "Contact"],
];

function H({ children }: { children: ReactNode }) {
  return <h2 className="mt-8 text-lg font-semibold text-foreground">{children}</h2>;
}
function P({ children }: { children: ReactNode }) {
  return <p className="mt-2">{children}</p>;
}
function UL({ children }: { children: ReactNode }) {
  return <ul className="mt-2 list-disc space-y-1.5 pl-5">{children}</ul>;
}
const Mail = () => <a className="font-semibold underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>;

function Page({ title, children, updated = true }: { title: string; children: ReactNode; updated?: boolean }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-10 text-sm leading-relaxed text-foreground md:px-8">
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <a href="/" className="font-semibold text-foreground">Bastion</a>
          {NAV.map(([href, label]) => (
            <a key={href} href={href} className="hover:text-foreground hover:underline">{label}</a>
          ))}
        </nav>
        <h1 className="mt-8 text-2xl font-semibold">{title}</h1>
        {updated && <p className="mt-1 text-muted-foreground">Last updated {UPDATED} · {PUBLISHER}</p>}
        {children}
        <p className="mt-12 border-t border-border pt-4 text-xs text-muted-foreground">
          © {new Date().getFullYear()} {PUBLISHER}. Bastion is a product of {PUBLISHER}. Contact: {CONTACT}
        </p>
      </div>
    </div>
  );
}

const PROCESSORS: [string, string][] = [
  ["Supabase", "database, sign-in and file storage — where Bastion's data lives"],
  ["Vercel", "hosts the website and web app"],
  ["Stripe", "takes subscription payments; card details go to Stripe and never reach Bastion"],
  ["Resend", "sends Bastion's emails (alerts, sign-in and account messages)"],
  ["Google Drive", "stores documents uploaded to Bastion, and the weekly encrypted backup"],
  ["Expo, Google Firebase, Apple", "deliver push notifications to the mobile app, when allowed"],
];

function ProcessorList() {
  return (
    <UL>
      {PROCESSORS.map(([n, w]) => <li key={n}><b>{n}</b> — {w}.</li>)}
    </UL>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy policy">
      <P>
        Bastion is software that security-services companies use to run their operations: staff records, attendance,
        payroll, invoicing and accounts. It is built and run by {PUBLISHER}. This page explains what Bastion holds, why,
        and who it is shared with.
      </P>
      <P>
        Two kinds of information are involved. <b>Your company's records</b> — its employees, clients, sites and accounts —
        belong to your company; it decides what goes into Bastion and we process them on its behalf (see{" "}
        <a className="underline" href="/data-processing">Data processing</a>). <b>Account and billing details</b> — who
        signs up, who signs in, and how the subscription is paid — are ours to look after, and are covered here.
      </P>
      <P>
        The GGS Field mobile app has its own policy: <a className="underline" href="/privacy/field-app">GGS Field privacy policy</a>.
      </P>

      <H>What we collect</H>
      <UL>
        <li><b>Account details:</b> name, work email, role, and the company you belong to.</li>
        <li><b>Sign-in and security records:</b> sign-in times, two-factor enrolment, and an audit log of changes made in Bastion.</li>
        <li><b>Billing details:</b> company name, the plan chosen and the payment status. Card details are held by Stripe, not by us.</li>
        <li><b>Your company's records:</b> whatever your company enters — which can include its staff's personal details, attendance, pay and documents.</li>
        <li><b>Messages</b> you send us, for example to {CONTACT}.</li>
      </UL>

      <H>Why</H>
      <P>
        To provide Bastion: signing you in, keeping your company's data separate from every other company's, sending the
        alerts you have asked for, taking payment, keeping backups, and answering support requests. We do not sell data, we
        do not use it for advertising, and we do not use one company's data for another.
      </P>

      <H>Who it is shared with</H>
      <P>Only the services that run Bastion, each processing data on our behalf and for no other purpose:</P>
      <ProcessorList />
      <P>We disclose data to anyone else only where the law requires it.</P>

      <H>How long it is kept</H>
      <P>
        For as long as your company's subscription is active. When a company leaves, its data is deleted on written request,
        except what the law requires us or the company to keep. Encrypted backups roll off after eight weeks.
      </P>

      <H>Your rights</H>
      <P>
        You can ask to see, correct or delete personal information about you. If the information is part of your employer's
        records in Bastion, your employer decides on the request and we help it carry it out. Write to <Mail />.
      </P>

      <H>Changes</H>
      <P>We update this page before Bastion starts collecting anything new, and change the date at the top.</P>
    </Page>
  );
}

export function Terms() {
  return (
    <Page title="Terms of service">
      <P>
        These terms are between {PUBLISHER} ("we") and the company that subscribes to Bastion ("you"). By signing up or
        using Bastion you accept them on your company's behalf.
      </P>

      <H>The service</H>
      <P>
        Bastion is a web application, with a companion mobile app, for running a security-services company. We host it,
        maintain it and keep it secure. Features change over time; we do not remove a feature your subscription depends on
        without telling you first.
      </P>

      <H>Accounts</H>
      <UL>
        <li>You decide who in your company gets a login and what each login may do, and you keep that list current.</li>
        <li>Each login is for one person. Keep passwords and authenticator codes private.</li>
        <li>You are responsible for what is done through your company's logins.</li>
      </UL>

      <H>Your data</H>
      <P>
        Everything your company puts into Bastion remains yours. You confirm you have the right to enter it, including your
        staff's personal details. We process it only to provide Bastion, as set out in{" "}
        <a className="underline" href="/data-processing">Data processing</a>, and we never sell it.
      </P>

      <H>Acceptable use</H>
      <P>
        Do not use Bastion for anything unlawful, try to reach another company's data, probe or overload the service, or
        resell access without our written agreement.
      </P>

      <H>Subscription and payment</H>
      <UL>
        <li>Bastion is billed by subscription, priced on the number of guards, as shown at sign-up. Payment is taken through Stripe.</li>
        <li>Your plan covers a number of guards plus a small buffer; adding guards beyond it needs a larger plan.</li>
        <li>If payment lapses, access may be paused until it is settled. Your data is not deleted because of a lapse.</li>
      </UL>

      <H>Ending the subscription</H>
      <P>
        You can stop at any time; access continues to the end of the period already paid. Before you go, a super admin can
        export your data. After you leave we delete it on written request, except what the law requires to be kept.
      </P>

      <H>Availability and liability</H>
      <P>
        We work to keep Bastion available and your data safe, with daily operation checks and weekly encrypted backups, but
        we cannot promise it will never be interrupted. To the extent the law allows, our total liability is limited to the
        fees you paid in the twelve months before the claim, and we are not liable for indirect or consequential loss.
      </P>

      <H>Changes and law</H>
      <P>
        We may update these terms; material changes are announced to your super admins before they take effect. These terms
        are governed by the laws of Pakistan. Questions: <Mail />.
      </P>
    </Page>
  );
}

export function DataProcessing() {
  return (
    <Page title="Data processing">
      <P>
        When your company uses Bastion, your company is the <b>controller</b> of the personal data it enters — its staff,
        clients and contacts — and {PUBLISHER} is its <b>processor</b>. These are the terms on which we process it.
      </P>

      <H>What we do with your data</H>
      <UL>
        <li>Process it only to provide Bastion, and only on your company's instructions as given through the software or in writing.</li>
        <li>Never sell it, never use it for advertising, and never combine it with another company's data.</li>
        <li>Allow access only to the people who run Bastion, each bound to keep it confidential.</li>
        <li>Help you answer requests from your staff to see, correct or delete their data.</li>
        <li>Tell you without undue delay if we learn of a breach affecting your data.</li>
        <li>When the subscription ends, delete your data on written request, except what the law requires to be kept.</li>
      </UL>

      <H>Kinds of data</H>
      <P>
        Whatever your company records in Bastion, typically: staff names, codes, contact details, identity and licence
        documents, attendance, pay and deductions; client and site details; invoices, expenses and accounts.
      </P>

      <H>Sub-processors</H>
      <P>We use these services to run Bastion. Each processes data only for that purpose:</P>
      <ProcessorList />
      <P>We will list any new sub-processor here before it starts receiving your data.</P>

      <H>Security</H>
      <P>
        The measures we take are described on the <a className="underline" href="/security">Security</a> page.
      </P>

      <P>Questions or a signed copy for your records: <Mail />.</P>
    </Page>
  );
}

export function Security() {
  return (
    <Page title="Security">
      <P>How Bastion protects your company's data, in plain terms.</P>

      <H>Separation between companies</H>
      <P>
        Every row in Bastion's database carries the company it belongs to, and the database itself — not only the screens —
        refuses to return another company's rows. A bug in a screen cannot show you someone else's data.
      </P>

      <H>Sign-in</H>
      <UL>
        <li>Two-factor sign-in with an authenticator app is required for office logins.</li>
        <li>Sessions end after a fixed time and must be signed into again; an administrator can end any session at once.</li>
        <li>Passwords found in known data breaches are refused.</li>
        <li>Mobile-app logins work only on a phone your company has approved.</li>
      </UL>

      <H>Permissions</H>
      <P>
        Each login can do only what its permissions allow, and the database enforces them. Steps that should need two
        people — such as verifying a staff record and then approving it — are given to two different permissions.
      </P>

      <H>Encryption and backups</H>
      <UL>
        <li>All traffic is encrypted (HTTPS, with strict transport security).</li>
        <li>A full backup is taken every week, encrypted with AES-256 before it leaves the database, and kept for eight weeks.</li>
      </UL>

      <H>Audit</H>
      <P>
        Changes to records are logged with who made them and when. Money moves only through controlled operations that
        record each movement, never by editing a balance directly.
      </P>

      <H>Reporting a problem</H>
      <P>
        If you think you have found a security issue, write to <Mail /> with the details. Please do not test against another
        company's data.
      </P>
    </Page>
  );
}

export function Contact() {
  return (
    <Page title="About and contact" updated={false}>
      <H>About Bastion</H>
      <P>
        Bastion is the command system for security-services companies: staff, deployments, attendance, payroll, invoicing
        and accounts in one place, on one ledger. It is built and run by {PUBLISHER}, which also publishes the GGS Field
        mobile app.
      </P>

      <H>Contact</H>
      <UL>
        <li>Company: <b>{PUBLISHER}</b></li>
        <li>Email: <Mail /> — sales, support, privacy and security questions</li>
        <li>Website: <a className="underline" href="https://techxserve.com">techxserve.com</a></li>
      </UL>

      <H>Policies</H>
      <UL>
        <li><a className="underline" href="/privacy">Privacy policy</a></li>
        <li><a className="underline" href="/privacy/field-app">GGS Field app privacy policy</a></li>
        <li><a className="underline" href="/terms">Terms of service</a></li>
        <li><a className="underline" href="/data-processing">Data processing</a></li>
        <li><a className="underline" href="/security">Security</a></li>
      </UL>
    </Page>
  );
}
