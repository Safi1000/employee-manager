import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { keepReport } from "./reportArchive";
import type { Company } from "./supabase";
import { brandingFromCompany } from "./pdfBranding";
import { INK, LH, M, Page, RED, RULE, SOFT, W, footer, heading, letterhead, longDay, refOf, signOff } from "./dailyBriefPdf";

/**
 * FINANCE REPORT (0632) — the accounting side's snapshot, in the same letter
 * style as the Daily Operations and Attendance reports and drawn by their
 * pieces. It prints what finance_report() returned for the period: everything
 * ENTERED since the last finance report (so a backdated entry still appears),
 * and the state now. The only arithmetic here is each table's total — the sum
 * of the rows printed above it.
 */

export type FinanceReportData = any;
type Col = { label: string; w: number; right?: boolean };

const amt = (n: unknown) => (n == null || n === "" ? "" : Math.round(Number(n)).toLocaleString("en-US"));
const short = (iso: string | null | undefined) =>
  iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
const monthOf = (iso: string | null | undefined) =>
  iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "";
/** "bank_transfer" → "Bank transfer", "whatsapp" → "WhatsApp": codes as words. */
export const label = (code: string | null | undefined) =>
  !code ? "" : code === "whatsapp" ? "WhatsApp" : code === "hand" ? "By hand" : code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, " ");
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** A ruled table in the house style; totals (optional) are the column sums of the rows given. */
export function ruledTable(p: Page, cols: Col[], rows: string[][], totals?: (string | null)[]) {
  const doc = p.doc;
  const head = () => {
    p.need(8);
    doc.setDrawColor(...RULE); doc.line(M, p.y - 4.2, M + W, p.y - 4.2);
    p.font("bold", 9.5); p.color(INK);
    let x = M;
    for (const c of cols) { if (c.right) doc.text(c.label, x + c.w - 1, p.y, { align: "right" }); else doc.text(c.label, x + 1, p.y); x += c.w; }
    p.y += 2; doc.line(M, p.y, M + W, p.y); p.y += 4.6;
  };
  head();
  for (const r of rows) {
    p.font("normal", 9.5);
    const wrapped = r.map((t, i) => p.wrap(String(t ?? ""), cols[i].w - 2));
    const h = Math.max(...wrapped.map((w) => w.length)) * (LH - 0.4);
    if (p.need(h + 1)) head();
    let x = M; p.color(INK);
    wrapped.forEach((lines, i) => {
      const c = cols[i];
      lines.forEach((ln, j) => doc.text(ln, c.right ? x + c.w - 1 : x + 1, p.y + j * (LH - 0.4), c.right ? { align: "right" } : undefined));
      x += c.w;
    });
    p.y += h + 0.6;
  }
  if (totals) {
    p.need(8);
    doc.setDrawColor(...RULE); doc.line(M, p.y - 3.6, M + W, p.y - 3.6);
    p.font("bold", 9.5); p.color(INK);
    let x = M;
    totals.forEach((t, i) => { const c = cols[i]; if (t) doc.text(t, c.right ? x + c.w - 1 : x + 1, p.y, c.right ? { align: "right" } : undefined); x += c.w; });
    p.y += 2; doc.line(M, p.y, M + W, p.y); doc.line(M, p.y + 0.8, M + W, p.y + 0.8);
  }
  p.y += 7;
}

function nil(p: Page, text: string) {
  p.font("italic", 10.5); p.color(SOFT); p.need(LH); p.doc.text(text, M + 4, p.y); p.y += LH + 3;
}

function para(p: Page, text: string, color = INK) {
  p.font("normal", 10.5); p.color(color);
  p.wrap(text, W).forEach((ln) => { p.need(LH); p.doc.text(ln, M, p.y); p.y += LH; });
  p.y += 2;
}

export async function downloadFinanceReportPdf(opts: { company: Company | null | undefined; data: FinanceReportData; region: string | null; preparedBy: string }) {
  const { data: d } = opts;
  const b = brandingFromCompany(opts.company);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const p = new Page(doc, b);
  const todayIso = new Date().toISOString().slice(0, 10);
  const ref = refOf("FIN", todayIso);
  letterhead(p, "Finance Report", todayIso, opts.region, ref, "Accounts Department");

  const receipts = d.receipts ?? [], raised = d.invoices_raised ?? [], delivered = d.invoices_delivered ?? [];
  const expenses = d.expenses ?? [], paid = d.salaries_paid ?? [], follow = d.followups ?? [];
  const sum = (xs: any[], k: string) => xs.reduce((s, x) => s + Number(x[k] ?? 0), 0);
  para(p, `This report covers everything entered from ${when(d.from)} to ${when(d.to)}, including any entry dated earlier. ` +
    `In that time: ${receipts.length} payment${receipts.length === 1 ? "" : "s"} received (${amt(sum(receipts, "amount"))}), ` +
    `${raised.length} invoice${raised.length === 1 ? "" : "s"} raised (${amt(sum(raised, "amount"))}), ` +
    `${expenses.length} expense${expenses.length === 1 ? "" : "s"} entered (${amt(sum(expenses, "amount"))}).`);

  // 1. Payments received
  heading(p, "1.  Payments received");
  if (!receipts.length) nil(p, "Nil.");
  else ruledTable(p,
    [{ label: "Date", w: 18 }, { label: "Client", w: 46 }, { label: "Mode", w: 18 }, { label: "Went to", w: 40 }, { label: "Received", w: 24, right: true }, { label: "Tax deducted", w: 24, right: true }],
    receipts.map((r: any) => [short(r.payment_date), r.client, label(r.mode), r.to ?? "", amt(r.amount), Number(r.wht) ? amt(r.wht) : ""]),
    ["", "Total", "", "", amt(sum(receipts, "amount")), amt(sum(receipts, "wht"))]);

  // 2. Invoices
  heading(p, "2.  Invoices");
  p.font("bold", 10.5); p.color(INK); p.need(LH); doc.text("2.1  Raised in this period", M + 4, p.y); p.y += LH + 2;
  if (!raised.length) nil(p, "Nil.");
  else ruledTable(p,
    [{ label: "Client", w: 46 }, { label: "Invoice", w: 32 }, { label: "For", w: 20 }, { label: "Made", w: 16 }, { label: "Delivered", w: 20 }, { label: "Amount", w: 36, right: true }],
    raised.map((r: any) => [r.client, r.number, monthOf(r.for_month), r.auto ? "Auto" : "Manual", r.delivered ? "Yes" : "No", amt(r.amount)]),
    ["Total", "", "", "", "", amt(sum(raised, "amount"))]);
  p.font("bold", 10.5); p.color(INK); p.need(LH); doc.text("2.2  Delivered in this period", M + 4, p.y); p.y += LH + 2;
  if (!delivered.length) nil(p, "Nil.");
  else ruledTable(p,
    [{ label: "Client", w: 56 }, { label: "Invoice", w: 36 }, { label: "How", w: 26 }, { label: "On", w: 20 }, { label: "Amount", w: 32, right: true }],
    delivered.map((r: any) => [r.client, r.number, label(r.method), short(r.delivered_on), amt(r.amount)]));
  const und = d.undelivered ?? [], miss = d.missing ?? [];
  p.font("bold", 10.5); p.color(INK); p.need(LH); doc.text("2.3  Not yet delivered", M + 4, p.y); p.y += LH + 2;
  if (!und.length) nil(p, "Nil — every recent invoice is marked delivered.");
  else ruledTable(p,
    [{ label: "Client", w: 60 }, { label: "Invoice", w: 36 }, { label: "For", w: 24 }, { label: "Amount", w: 50, right: true }],
    und.map((r: any) => [r.client, r.number, monthOf(r.for_month), amt(r.amount)]));
  p.font("bold", 10.5); p.color(INK); p.need(LH); doc.text(`2.4  Missing for ${monthOf(d.billing_month)}`, M + 4, p.y); p.y += LH + 1;
  if (!miss.length) nil(p, "Nil — every client with a running contract has an invoice.");
  else para(p, miss.map((m: any) => m.client).join(", ") + ".", RED);

  // 3. Expenses
  heading(p, "3.  Expenses entered");
  if (!expenses.length) nil(p, "Nil.");
  else ruledTable(p,
    [{ label: "Date", w: 18 }, { label: "Category", w: 36 }, { label: "Description", w: 76 }, { label: "Amount", w: 40, right: true }],
    expenses.map((e: any) => [short(e.date), e.category ?? "", e.description ?? "", amt(e.amount)]),
    ["", "Total", "", amt(sum(expenses, "amount"))]);

  // 4. Salaries
  heading(p, "4.  Salaries");
  const ps = d.payroll_status;
  if (paid.length) ruledTable(p,
    [{ label: "Disbursed in this period — month", w: 90 }, { label: "People", w: 30, right: true }, { label: "Paid", w: 50, right: true }],
    paid.map((s: any) => [monthOf(s.month), String(s.people), amt(s.paid)]));
  else nil(p, "No salaries disbursed in this period.");
  if (ps && ps.month) para(p, `${monthOf(ps.month)} payroll: ${ps.people} people, net ${amt(ps.net)}; paid ${amt(ps.paid)}; still to pay ${amt(ps.remaining)} to ${ps.unpaid_people} ${ps.unpaid_people === 1 ? "person" : "people"}.`,
    Number(ps.remaining) > 0.5 ? RED : INK);

  // 5. Receivables
  heading(p, "5.  Receivables and follow-up");
  const rc = d.receivables ?? {};
  para(p, `Clients owe ${amt(rc.owed)} in all (${rc.clients_owing ?? 0} clients); ${amt(rc.overdue)} of it is more than 30 days old and ${amt(rc.over_90)} more than 90. ` +
    (Number(rc.wht_awaiting) > 0.5 ? `Tax ${amt(rc.wht_awaiting)} is waiting for certificates.` : ""));
  const late = d.late_clients ?? [];
  if (late.length) ruledTable(p,
    [{ label: "Client", w: 52 }, { label: "Owes", w: 26, right: true }, { label: "Overdue", w: 26, right: true }, { label: "  Last paid", w: 22 }, { label: "Last contact", w: 22 }, { label: "Promise", w: 22 }],
    late.map((r: any) => [r.client, amt(r.owed), amt(r.overdue), `  ${short(r.last_paid_on)}`, short(r.last_contact_on), r.promised_by ? `by ${short(r.promised_by)}` : ""]));
  p.font("bold", 10.5); p.color(INK); p.need(LH); doc.text("Follow-ups logged in this period", M + 4, p.y); p.y += LH + 1;
  if (!follow.length) nil(p, "Nil.");
  else follow.forEach((f: any, i: number) => {
    p.font("normal", 10.5); p.color(INK);
    p.wrap(`${f.client} (${short(f.on)}, ${label(f.channel)}): ${f.note}${f.promised_by ? ` Promised by ${short(f.promised_by)}.` : ""}${f.next_step ? ` Next: ${f.next_step}.` : ""}`, W - 14)
      .forEach((ln, j) => { p.need(LH); if (j === 0) doc.text(`${i + 1}.`, M + 4, p.y); doc.text(ln, M + 14, p.y); p.y += LH; });
  });
  p.y += 3;

  // 6. Waiting on someone
  heading(p, "6.  Waiting on someone");
  const wt = d.waiting ?? {};
  const items = [
    und.length ? `${und.length} invoice${und.length === 1 ? "" : "s"} not yet marked delivered` : "",
    miss.length ? `${miss.length} client${miss.length === 1 ? "" : "s"} with no invoice for ${monthOf(d.billing_month)}` : "",
    wt.cheques_uncleared ? `${wt.cheques_uncleared} cheque${wt.cheques_uncleared === 1 ? "" : "s"} received and not cleared` : "",
    wt.write_offs_pending ? `${wt.write_offs_pending} write-off${wt.write_offs_pending === 1 ? "" : "s"} waiting for approval` : "",
    wt.certificates_awaiting ? `${wt.certificates_awaiting} payment${wt.certificates_awaiting === 1 ? "" : "s"} with tax waiting for a certificate` : "",
    wt.field_requests_pending ? `${wt.field_requests_pending} field-app money request${wt.field_requests_pending === 1 ? "" : "s"} waiting for a decision` : "",
    ps && Number(ps.remaining) > 0.5 ? `${monthOf(ps.month)} salaries still to pay: ${amt(ps.remaining)}` : "",
  ].filter(Boolean);
  if (!items.length) nil(p, "Nil.");
  else items.forEach((t, i) => { p.font("normal", 10.5); p.color(INK); p.need(LH); doc.text(`${i + 1}.`, M + 4, p.y); doc.text(t, M + 14, p.y); p.y += LH; });
  const wo = wt.write_offs_approved ?? [];
  if (wo.length) { p.y += 2; para(p, `Written off in this period: ${wo.map((w: any) => `${w.client} ${amt(w.amount)} (${w.reason})`).join("; ")}.`); }

  signOff(p, "Prepared by", opts.preparedBy ? [opts.preparedBy] : []);
  footer(doc, b, ref);
  const fileName = `Finance report${opts.region ? ` ${opts.region}` : ""} ${todayIso}.pdf`;
  await savePdf(doc, fileName);
  // 0633: kept for the CEO dashboard — the stamped copy, as downloaded.
  void keepReport(doc, { companyId: opts.company?.id, kind: "finance", reportDate: todayIso, region: opts.region, fileName });
  void longDay;
}
