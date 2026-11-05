import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { hexToRgb, imageFormat, type PdfBranding } from "./pdfBranding";
import { amountInWords, type Company } from "./supabase";

/**
 * A guard's payslip for one month — redesigned 6 Nov 2026 to the document
 * standard: letterhead, a reference, the employee panel, attendance, earnings
 * beside deductions, net pay in figures and words, payment status, and three
 * signature lines (prepared / approved / received) for a printed slip handed
 * to a guard.
 *
 * Every figure is the payslip row's own; nothing is recomputed except the two
 * column totals, which are the sum of the lines printed above them — a total
 * that could disagree with its own column would be worse than none.
 */
export function generatePayslipPdf(p: {
  branding: PdfBranding;
  /** For the letterhead's address / phones line. Optional: older callers pass only branding. */
  company?: Company | null;
  monthLabel: string;
  employee: { full_name: string; code: string; posted_at?: string | null; region?: string | null; bank?: string | null };
  slip: {
    present_days: number; absent_days: number; leave_days: number;
    base_salary: number; bonus: number; advance: number; deductions: number;
    net_salary: number; amount_paid: number; disbursed: boolean; disbursed_at: string | null;
    period_month?: string | null;
  };
}) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const [br, bg, bb] = hexToRgb(p.branding.brandColor);
  const L = 16, R = 194, W = R - L;
  const INK: [number, number, number] = [15, 23, 42], SOFT: [number, number, number] = [100, 116, 139], RULE: [number, number, number] = [226, 232, 240];
  const n = (v: unknown) => Math.round(Number(v || 0));
  const rs = (v: number) => `Rs ${n(v).toLocaleString("en-PK")}`;
  const ink = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2]);
  const font = (style: "normal" | "bold", size: number) => { doc.setFont("helvetica", style); doc.setFontSize(size); };

  // ── Letterhead ────────────────────────────────────────────────────────────
  doc.setFillColor(br, bg, bb); doc.rect(0, 0, 210, 4, "F");
  let y = 14, textX = L;
  const fmt = p.branding.logoUrl ? imageFormat(p.branding.logoUrl) : null;
  if (p.branding.logoUrl && fmt) {
    try {
      const props = (doc as unknown as { getImageProperties: (u: string) => { width: number; height: number } }).getImageProperties(p.branding.logoUrl);
      const h = 18, w = Math.min(36, h * (props.width / props.height));
      doc.addImage(p.branding.logoUrl, fmt, L, y - 4, w, h, undefined, "FAST");
      textX = L + w + 5;
    } catch { /* no logo is better than a broken one */ }
  }
  font("bold", 13); ink(INK); doc.text(p.branding.legalName, textX, y + 1, { maxWidth: 110 });
  const contact = [p.company?.registration_line, p.company?.legal_address, (p.company?.contact_phones ?? []).filter(Boolean).join(", ") || p.company?.contact_phone]
    .filter((s): s is string => !!s && !!s.trim());
  font("normal", 7.5); ink(SOFT);
  contact.slice(0, 3).forEach((line, i) => doc.text(line, textX, y + 6 + i * 3.6, { maxWidth: 110 }));

  font("bold", 20); doc.setTextColor(br, bg, bb); doc.text("PAYSLIP", R, y + 2, { align: "right" });
  font("normal", 9); ink(INK); doc.text(p.monthLabel, R, y + 8, { align: "right" });
  const period = (p.slip.period_month ?? "").slice(0, 7);
  const ref = `PS-${period || p.monthLabel.replace(/\s+/g, "-")}-${p.employee.code || "—"}`;
  font("normal", 7.5); ink(SOFT); doc.text(`Ref ${ref}`, R, y + 12.5, { align: "right" });

  y = 38;
  doc.setDrawColor(br, bg, bb); doc.setLineWidth(0.6); doc.line(L, y, R, y); doc.setLineWidth(0.2);

  // ── Employee panel ────────────────────────────────────────────────────────
  y += 6;
  doc.setFillColor(248, 250, 252); doc.setDrawColor(...RULE); doc.roundedRect(L, y, W, 30, 2, 2, "FD");
  const field = (label: string, value: string, x: number, yy: number) => {
    font("normal", 7); ink(SOFT); doc.text(label.toUpperCase(), x, yy);
    font("bold", 10); ink(INK); doc.text(value || "—", x, yy + 5, { maxWidth: W / 2 - 10 });
  };
  const periodText = period
    ? (() => { const [yy, mm] = period.split("-").map(Number); const last = new Date(yy, mm, 0).getDate(); const mon = new Date(yy, mm - 1, 1).toLocaleDateString("en-GB", { month: "short" }); return `1 – ${last} ${mon} ${yy}`; })()
    : p.monthLabel;
  field("Employee", p.employee.full_name, L + 5, y + 7);
  field("Code", p.employee.code, L + W / 2 + 3, y + 7);
  field("Posted at", [p.employee.posted_at, p.employee.region].filter(Boolean).join(" · "), L + 5, y + 20);
  field("Pay period", periodText, L + W / 2 + 3, y + 20);
  y += 36;

  // ── Attendance ────────────────────────────────────────────────────────────
  const boxW = (W - 8) / 3;
  ([["Present", p.slip.present_days], ["Leave", p.slip.leave_days], ["Absent", p.slip.absent_days]] as const).forEach(([label, v], i) => {
    const x = L + i * (boxW + 4);
    doc.setDrawColor(...RULE); doc.roundedRect(x, y, boxW, 15, 2, 2, "S");
    font("normal", 7); ink(SOFT); doc.text(`${label.toUpperCase()} DAYS`, x + 4, y + 5.5);
    font("bold", 13); ink(INK); doc.text(String(n(v)), x + boxW - 4, y + 11, { align: "right" });
  });
  y += 22;

  // ── Earnings | Deductions ────────────────────────────────────────────────
  const colW = (W - 6) / 2, xE = L, xD = L + colW + 6;
  const earnings: [string, number][] = [["Base salary for the month", n(p.slip.base_salary)]];
  if (n(p.slip.bonus)) earnings.push(["Bonus", n(p.slip.bonus)]);
  const deductions: [string, number][] = [];
  if (n(p.slip.advance)) deductions.push(["Advance recovered", n(p.slip.advance)]);
  if (n(p.slip.deductions)) deductions.push(["Other deductions", n(p.slip.deductions)]);

  const table = (x: number, title: string, lines: [string, number][], totalLabel: string) => {
    let yy = y;
    doc.setFillColor(br, bg, bb); doc.rect(x, yy, colW, 7, "F");
    font("bold", 8); doc.setTextColor(255, 255, 255);
    doc.text(title, x + 3, yy + 4.8); doc.text("Rs", x + colW - 3, yy + 4.8, { align: "right" });
    yy += 7;
    const rowsShown = Math.max(earnings.length, deductions.length, 1);
    for (let i = 0; i < rowsShown; i++) {
      const line = lines[i];
      font("normal", 9.5); ink(line ? INK : SOFT);
      if (line) { doc.text(line[0], x + 3, yy + 5.5); doc.text(n(line[1]).toLocaleString("en-PK"), x + colW - 3, yy + 5.5, { align: "right" }); }
      else if (i === 0) doc.text("None", x + 3, yy + 5.5);
      doc.setDrawColor(...RULE); doc.line(x, yy + 8, x + colW, yy + 8);
      yy += 8;
    }
    const total = lines.reduce((t, l) => t + l[1], 0);
    doc.setFillColor(241, 245, 249); doc.rect(x, yy, colW, 8, "F");
    font("bold", 9.5); ink(INK);
    doc.text(totalLabel, x + 3, yy + 5.5); doc.text(total.toLocaleString("en-PK"), x + colW - 3, yy + 5.5, { align: "right" });
    return yy + 8;
  };
  const endE = table(xE, "EARNINGS", earnings, "Total earnings");
  const endD = table(xD, "DEDUCTIONS", deductions, "Total deductions");
  y = Math.max(endE, endD) + 8;

  // ── Net pay ──────────────────────────────────────────────────────────────
  doc.setFillColor(br, bg, bb); doc.roundedRect(L, y, W, 22, 2, 2, "F");
  doc.setTextColor(255, 255, 255);
  font("normal", 8); doc.text("NET PAY", L + 6, y + 7);
  font("bold", 18); doc.text(rs(p.slip.net_salary), R - 6, y + 10, { align: "right" });
  font("normal", 8.5);
  doc.text(`${amountInWords(n(p.slip.net_salary))}`, L + 6, y + 16.5, { maxWidth: W - 12 });
  y += 28;

  // ── Payment status ───────────────────────────────────────────────────────
  const outstanding = n(p.slip.net_salary) - n(p.slip.amount_paid);
  const paidOn = p.slip.disbursed_at ? new Date(p.slip.disbursed_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;
  font("bold", 9.5);
  if (p.slip.disbursed) doc.setTextColor(21, 128, 61); else doc.setTextColor(180, 83, 9);
  doc.text(p.slip.disbursed ? `PAID — ${rs(p.slip.amount_paid)}${paidOn ? ` on ${paidOn}` : ""}` : `NOT FULLY PAID — ${rs(p.slip.amount_paid)} paid, ${rs(outstanding)} still to be paid`, L, y);
  if (p.employee.bank) { font("normal", 8.5); ink(SOFT); doc.text(`Paid to: ${p.employee.bank}`, L, y + 5); }
  y += 18;

  // ── Signatures ───────────────────────────────────────────────────────────
  const sigY = Math.max(y + 14, 236);
  const sigW = (W - 16) / 3;
  (["Prepared by (Accounts)", "Approved by", "Received by (signature / thumb)"] as const).forEach((label, i) => {
    const x = L + i * (sigW + 8);
    doc.setDrawColor(148, 163, 184); doc.line(x, sigY, x + sigW, sigY);
    font("normal", 7.5); ink(SOFT); doc.text(label, x, sigY + 4.5);
  });
  font("normal", 7); ink(SOFT);
  doc.text("Date: ____________", L + 2 * (sigW + 8), sigY + 9);

  // ── Footer ───────────────────────────────────────────────────────────────
  doc.setDrawColor(...RULE); doc.line(L, 280, R, 280);
  font("normal", 7); ink(SOFT);
  doc.text(`${p.branding.legalName}  ·  System-generated payslip — the figures are the payroll record's own.`, L, 284.5);
  doc.text(ref, R, 284.5, { align: "right" });

  void savePdf(doc, `Payslip ${p.monthLabel} — ${p.employee.full_name}${p.employee.code ? ` (${p.employee.code})` : ""}.pdf`);
}
