import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { drawBrandedHeader, drawBrandedFooter, type PdfBranding } from "./pdfBranding";

/**
 * A guard's payslip for one month (2026-10-21, My Profile). Every figure is the
 * payslip row's own — present/absent/leave days, base, bonus, advance,
 * deductions, net, paid — laid out on the company's branded page. Nothing is
 * recomputed here.
 */
export function generatePayslipPdf(p: {
  branding: PdfBranding;
  monthLabel: string;
  employee: { full_name: string; code: string; posted_at?: string | null; region?: string | null; bank?: string | null };
  slip: {
    present_days: number; absent_days: number; leave_days: number;
    base_salary: number; bonus: number; advance: number; deductions: number;
    net_salary: number; amount_paid: number; disbursed: boolean; disbursed_at: string | null;
  };
}) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = drawBrandedHeader(doc, p.branding, "Payslip", `${p.monthLabel}  ·  ${p.employee.full_name}  ·  ${p.employee.code}`);
  y += 8;

  const money = (n: number) => `PKR ${Math.round(Number(n || 0)).toLocaleString()}`;
  const pair = (label: string, value: string, x: number) => {
    doc.setFontSize(9); doc.setTextColor(120); doc.text(label, x, y);
    doc.setFontSize(11); doc.setTextColor(0); doc.text(value, x, y + 5.5);
  };
  pair("Employee", p.employee.full_name, 14);
  pair("Code", p.employee.code || "—", 110);
  y += 14;
  pair("Posted at", p.employee.posted_at || "—", 14);
  pair("Region", p.employee.region || "—", 110);
  y += 14;
  if (p.employee.bank) { pair("Paid to", p.employee.bank, 14); y += 14; }

  // Attendance
  doc.setDrawColor(220); doc.line(14, y, 196, y); y += 7;
  doc.setFontSize(10); doc.setTextColor(90); doc.text("ATTENDANCE", 14, y); y += 6;
  doc.setFontSize(11); doc.setTextColor(0);
  doc.text(`Present ${p.slip.present_days}`, 14, y);
  doc.text(`Leave ${p.slip.leave_days}`, 70, y);
  doc.text(`Absent ${p.slip.absent_days}`, 126, y);
  y += 10;

  // Earnings and deductions
  doc.line(14, y, 196, y); y += 7;
  const line = (label: string, v: number, sign = "") => {
    doc.setFontSize(11); doc.setTextColor(40); doc.text(label, 14, y);
    doc.setTextColor(0); doc.text(`${sign}${money(v)}`, 196, y, { align: "right" });
    y += 7;
  };
  doc.setFontSize(10); doc.setTextColor(90); doc.text("EARNINGS", 14, y); y += 6;
  line("Base salary for the month", p.slip.base_salary);
  if (Number(p.slip.bonus)) line("Bonus", p.slip.bonus, "+ ");
  y += 2;
  doc.setFontSize(10); doc.setTextColor(90); doc.text("DEDUCTIONS", 14, y); y += 6;
  if (Number(p.slip.advance)) line("Advance recovered", p.slip.advance, "− ");
  if (Number(p.slip.deductions)) line("Other deductions", p.slip.deductions, "− ");
  if (!Number(p.slip.advance) && !Number(p.slip.deductions)) { doc.setFontSize(11); doc.setTextColor(120); doc.text("None", 14, y); y += 7; }

  // Net
  y += 2; doc.setDrawColor(30); doc.line(14, y, 196, y); y += 8;
  doc.setFontSize(13); doc.setTextColor(0);
  doc.text("Net pay", 14, y); doc.text(money(p.slip.net_salary), 196, y, { align: "right" });
  y += 8;
  doc.setFontSize(10); doc.setTextColor(90);
  doc.text(
    p.slip.disbursed
      ? `Paid ${money(p.slip.amount_paid)}${p.slip.disbursed_at ? ` on ${p.slip.disbursed_at.slice(0, 10)}` : ""}`
      : `Paid so far ${money(p.slip.amount_paid)} — ${money(Number(p.slip.net_salary) - Number(p.slip.amount_paid))} still to be paid`,
    14, y,
  );

  drawBrandedFooter(doc, p.branding, "System-generated payslip — the figures are the payroll record's own.");
  void savePdf(doc, `Payslip ${p.monthLabel} — ${p.employee.full_name}.pdf`);
}
