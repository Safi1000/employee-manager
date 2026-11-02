import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { keepReport } from "./reportArchive";
import type { Company } from "./supabase";
import { brandingFromCompany } from "./pdfBranding";
import { INK, LH, M, Page, RED, RULE, SOFT, W, footer, heading, letterhead, longDay, refOf, signOff } from "./dailyBriefPdf";
import { methodLabel, modeLabel, type FollowUpdates } from "./followUpData";

/**
 * PAYMENT FOLLOW-UP REPORT (0628) — the same formal letter style as the Daily
 * Operations Report and the Attendance Report, drawn by their own pieces
 * (dailyBriefPdf): letterhead, numbered sections, ruled table, sign-off, footer.
 *
 *   opening line   how many clients are late, how many next steps are due
 *   1. Updates (0634)          payments received, contacts logged, invoices
 *                              delivered in the period; invoices not delivered
 *                              or missing, promises missed, steps due — now
 *   2. Clients for follow-up   ruled table: client, how late, usual pay day,
 *                              last paid (0630), (owes, late amount — with
 *                              figures only), next step;
 *                              grouped by region under "All regions"
 *   2. Contact notes           one numbered paragraph per client contacted:
 *                              last contact, what they said, any promise
 *   3. Next steps              numbered: what, who, by when — overdue in red
 *   sign-off       Prepared by
 *
 * Two forms from the same rows: without figures (anyone) and with figures
 * (finance only — for anyone else the amounts are already null from
 * client_followup_list(), so this file could not print them anyway). The only
 * arithmetic here is the table's total: the sum of the rows printed above it.
 */
export type FollowUpPdfRow = {
  client: string;
  region: string | null;
  late: string;              // "12 days late", "From before Bastion", "Due 18 Nov"
  isLate: boolean;
  payDay: string;            // "5th" or ""
  lastPaidOn: string | null; // 0630
  lastPaid: string;          // "15 Oct · Cheque" (+ " · 510,151" with figures), or "Never"
  lastContactOn: string | null;
  lastContact: string | null; // "Call — cheque this week"
  promise: string | null;    // "by 9 Nov" (+ " · 548,550" with figures)
  nextStep: string | null;   // "Collect cheque"
  nextWho: string | null;
  nextBy: string | null;     // ISO date
  owes: number | null;
  overdue: number | null;
  invoice: string;           // 0634: "Delivered 2 Nov, by hand" / "Not delivered" / "No invoice" / ""
};

export type UpdatesPart = { data: FollowUpdates; label: string; regionId: string | null };
export type InvoiceGaps = { notDelivered: { client: string; number: string }[]; missing: string[] };

/**
 * The updates section (0634), shared with the Finance Report PDF so the two
 * print the same follow-up picture. `n` is the section number.
 */
export function drawFollowUpdates(p: Page, n: number, u: UpdatesPart, gaps: InvoiceGaps, invoiceMonth: string, withFigures: boolean) {
  const doc = p.doc;
  const keep = <T extends { branch_id: string | null }>(xs: T[]) => xs.filter((x) => !u.regionId || x.branch_id === u.regionId);
  const pay = keep(u.data.payments), con = keep(u.data.contacts), del = keep(u.data.delivered);
  const missed = keep(u.data.promises_missed), due = keep(u.data.steps_due), done = keep(u.data.steps_done);
  heading(p, `${n}.  Updates — ${u.label.toLowerCase()}`);
  const items: [string, string[]][] = [
    [`Payments received (${pay.length})`, pay.map((x) => `${x.client} — ${short(x.on)}${x.mode ? `, ${modeLabel(x.mode)}` : ""}${withFigures && x.amount != null ? `, ${amt(x.amount)}` : ""}`)],
    [`Contacts logged (${con.length})`, con.map((x) => `${x.client} — ${short(x.on)}: ${x.note}${x.promised_by ? ` Promised by ${short(x.promised_by)}.` : ""}`)],
    [`Invoices delivered (${del.length})`, del.map((x) => `${x.client} — ${x.number}, ${short(x.on)}, ${methodLabel(x.method)}`)],
    [`Next steps done (${done.length})`, done.map((x) => `${x.client} — ${x.step}${x.by ? ` (${x.by})` : ""}`)],
    [`${invoiceMonth} invoices not yet delivered (${gaps.notDelivered.length})`, gaps.notDelivered.map((x) => `${x.client} — ${x.number}`)],
    [`No ${invoiceMonth} invoice made (${gaps.missing.length})`, gaps.missing.length ? [gaps.missing.join(", ")] : []],
    [`Promises missed (${missed.length})`, missed.map((x) => `${x.client} — promised by ${short(x.promised_by)}${withFigures && x.promised_amount != null ? `, ${amt(x.promised_amount)}` : ""}`)],
    [`Next steps due (${due.length})`, due.map((x) => `${x.client} — ${x.step}, ${x.who ?? "anyone"}, due ${short(x.due)}`)],
  ];
  let sub = 0;
  for (const [label, lines] of items) {
    sub += 1;
    const warn = /not yet delivered|No .* invoice|missed|due/.test(label) && lines.length > 0;
    p.need(LH * 2);
    p.font("bold", 10.5); p.color(warn ? RED : INK);
    doc.text(`${n}.${sub}`, M + 4, p.y); doc.text(label, M + 14, p.y); p.y += LH;
    p.font("normal", 10); p.color(INK);
    if (!lines.length) { p.font("italic", 10); p.color(SOFT); doc.text("Nil.", M + 14, p.y); p.y += LH; continue; }
    for (const t of lines) p.wrap(`– ${t}`, W - 16).forEach((ln) => { p.need(LH); doc.text(ln, M + 14, p.y); p.y += LH; });
  }
  p.color(INK);
  p.y += 4;
}

const short = (iso: string | null) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
const amt = (n: number | null) => (n == null ? "" : Math.round(n).toLocaleString("en-US"));

export async function downloadFollowUpPdf(opts: {
  company: Company | null | undefined;
  rows: FollowUpPdfRow[];
  withFigures: boolean;
  region: string | null;     // null = All regions
  scopeNote: string;         // "Late clients" / "Everyone who owes" / "My next steps"
  todayIso: string;
  preparedBy: string;
  updates?: UpdatesPart | null;
  invoiceMonth?: string;
  gaps?: InvoiceGaps;
}) {
  const b = brandingFromCompany(opts.company);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const p = new Page(doc, b);
  const { rows, withFigures, todayIso } = opts;
  const ref = refOf("PFR", todayIso);

  letterhead(p, "Payment Follow-up Report", todayIso, opts.region, ref, "Accounts Department");

  // ── opening line ──
  const late = rows.filter((r) => r.isLate).length;
  const due = rows.filter((r) => r.nextStep && r.nextBy && r.nextBy <= todayIso).length;
  p.font("normal", 10.5); p.color(INK);
  const opening = `As of ${longDay(todayIso)}, this report lists ${rows.length} client${rows.length === 1 ? "" : "s"} (${opts.scopeNote.toLowerCase()}); ` +
    `${late} ${late === 1 ? "is" : "are"} past their usual payment date. ` +
    (due ? `${due} next step${due === 1 ? " is" : "s are"} due today or overdue.` : "No next step is overdue.");
  p.wrap(opening, W).forEach((ln) => { p.need(LH); doc.text(ln, M, p.y); p.y += LH; });
  p.y += 4;

  // ── 1. updates (0634) ──
  const sec = opts.updates ? 1 : 0;
  if (opts.updates) drawFollowUpdates(p, 1, opts.updates, opts.gaps ?? { notDelivered: [], missing: [] }, opts.invoiceMonth ?? "Last month's", withFigures);

  // ── 2. the table ──
  heading(p, `${sec + 1}.  Clients for follow-up`);
  const COLS = withFigures
    ? [
        // Next steps have their own section; with figures the row has no room for them.
        { label: "S/No", w: 10, right: false },
        { label: "Client", w: 36, right: false },
        { label: "Status", w: 28, right: false },
        { label: "Last paid", w: 28, right: false },
        { label: "Invoice", w: 26, right: false },
        { label: "Owes", w: 21, right: true },
        { label: "Late amount", w: W - 149, right: true },
      ]
    : [
        { label: "S/No", w: 10, right: false },
        { label: "Client", w: 34, right: false },
        { label: "Status", w: 28, right: false },
        { label: "Pays on", w: 13, right: false },
        { label: "Last paid", w: 24, right: false },
        { label: "Invoice", w: 25, right: false },
        { label: "Next step", w: W - 134, right: false },
      ];
  const head = () => {
    p.need(8);
    doc.setDrawColor(...RULE); doc.line(M, p.y - 4.2, M + W, p.y - 4.2);
    p.font("bold", 9.5); p.color(INK);
    let x = M;
    for (const c of COLS) { if (c.right) doc.text(c.label, x + c.w - 1, p.y, { align: "right" }); else doc.text(c.label, x + 1, p.y); x += c.w; }
    p.y += 2; doc.line(M, p.y, M + W, p.y); p.y += 4.6;
  };
  head();

  const groups = new Map<string, FollowUpPdfRow[]>();
  for (const r of rows) {
    const k = opts.region ? "" : r.region ?? "No region";
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const showGroups = !opts.region && groups.size > 1;
  let n = 0;
  for (const [g, list] of groups) {
    if (showGroups) {
      if (p.need(LH + 2)) head();
      p.font("bolditalic", 10); p.color(SOFT); doc.text(g, M + 1, p.y); p.y += LH + 0.4;
    }
    for (const r of list) {
      n += 1;
      const step = r.nextStep ? `${r.nextStep}${r.nextWho ? ` — ${r.nextWho}` : ""}${r.nextBy ? `, ${short(r.nextBy)}` : ""}` : "—";
      const status = withFigures && r.payDay ? `${r.late} (pays on the ${r.payDay})` : r.late;
      const cells = withFigures
        ? [`${n}.`, r.client, status, r.lastPaid, r.invoice || "—", amt(r.owes), amt(r.overdue)]
        : [`${n}.`, r.client, status, r.payDay || "—", r.lastPaid, r.invoice || "—", step];
      p.font("normal", 10);
      const wrapped = cells.map((t, i) => p.wrap(t, COLS[i].w - 2));
      const h = Math.max(...wrapped.map((w) => w.length)) * LH;
      if (p.need(h + 1)) head();
      let x = M;
      wrapped.forEach((lines, i) => {
        const c = COLS[i];
        const lateCell = (i === 2 && r.isLate) || (c.label === "Invoice" && /Not|No invoice/.test(r.invoice));
        const overdueStep = c.label === "Next step" && r.nextStep && r.nextBy && r.nextBy <= todayIso;
        p.font(lateCell ? "bold" : "normal", 10);
        p.color(lateCell || overdueStep ? RED : INK);
        lines.forEach((ln, j) => doc.text(ln, c.right ? x + c.w - 1 : x + 1, p.y + j * LH, c.right ? { align: "right" } : undefined));
        x += c.w;
      });
      p.color(INK);
      p.y += h + 0.6;
    }
  }
  if (!rows.length) { p.font("italic", 10.5); p.color(SOFT); doc.text("Nil — no client in this list.", M + 1, p.y); p.y += LH; }

  // Total row (with figures): the sum of the rows printed above it, nothing else.
  p.need(10);
  doc.setDrawColor(...RULE); doc.line(M, p.y - 3.6, M + W, p.y - 3.6);
  if (withFigures && rows.length) {
    const owes = rows.reduce((s, r) => s + (r.owes ?? 0), 0);
    const over = rows.reduce((s, r) => s + (r.overdue ?? 0), 0);
    p.font("bold", 10); p.color(INK);
    doc.text("Total", M + COLS[0].w + 1, p.y);
    const xOwes = M + COLS[0].w + COLS[1].w + COLS[2].w + COLS[3].w + COLS[4].w;
    doc.text(amt(owes), xOwes + COLS[5].w - 1, p.y, { align: "right" });
    doc.text(amt(over), xOwes + COLS[5].w + COLS[6].w - 1, p.y, { align: "right" });
    p.y += 2; doc.line(M, p.y, M + W, p.y); doc.line(M, p.y + 0.8, M + W, p.y + 0.8);
  }
  p.y += 9;

  // ── 2. contact notes ──
  const contacted = rows.filter((r) => r.lastContactOn);
  heading(p, `${sec + 2}.  Contact notes`);
  if (!contacted.length) { p.font("italic", 10.5); p.color(SOFT); doc.text("Nil — no contact logged for these clients.", M + 4, p.y); p.y += LH + 3; }
  contacted.forEach((r, i) => {
    p.need(LH * 3);
    p.font("bold", 10.5); p.color(INK);
    doc.text(`${sec + 2}.${i + 1}`, M + 4, p.y); doc.text(r.client, M + 14, p.y); p.y += LH;
    p.font("normal", 10.5);
    const said = (r.lastContact ?? "").trim();
    const body = `${short(r.lastContactOn)} — ${said}${said && !/[.!?]$/.test(said) ? "." : ""}${r.promise ? ` Promised to pay ${r.promise}.` : ""}`;
    p.wrap(body, W - 14).forEach((ln) => { p.need(LH); doc.text(ln, M + 14, p.y); p.y += LH; });
    p.y += 1.5;
  });
  p.y += 2;

  // ── 3. next steps ──
  const steps = rows.filter((r) => r.nextStep).sort((a, b) => (a.nextBy ?? "9").localeCompare(b.nextBy ?? "9"));
  heading(p, `${sec + 3}.  Next steps`);
  if (!steps.length) { p.font("italic", 10.5); p.color(SOFT); doc.text("Nil — no open next step.", M + 4, p.y); p.y += LH + 3; }
  steps.forEach((r, i) => {
    const overdue = !!r.nextBy && r.nextBy <= todayIso;
    const text = `${r.client}: ${r.nextStep} — ${r.nextWho ?? "anyone"}${r.nextBy ? `, by ${short(r.nextBy)}` : ""}${overdue ? (r.nextBy === todayIso ? " (due today)" : " (overdue)") : ""}`;
    p.font("normal", 10.5); p.color(overdue ? RED : INK);
    p.wrap(text, W - 14).forEach((ln, j) => { p.need(LH); if (j === 0) doc.text(`${i + 1}.`, M + 4, p.y); doc.text(ln, M + 14, p.y); p.y += LH; });
    p.y += 0.8;
  });
  p.color(INK);

  signOff(p, "Prepared by", opts.preparedBy ? [opts.preparedBy] : []);
  footer(doc, b, ref);
  const fileName = `Payment follow-up ${opts.region ?? "All regions"} ${todayIso}${withFigures ? " (with figures)" : ""}.pdf`;
  await savePdf(doc, fileName);
  // 0633: kept for the CEO dashboard — the stamped copy, as downloaded.
  void keepReport(doc, { companyId: opts.company?.id, kind: "followup", reportDate: todayIso, region: opts.region, fileName });
}
