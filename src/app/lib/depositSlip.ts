import jsPDF from "jspdf";
import type { Company } from "./supabase";

// Cash deposit slip PDF. Mirrors the layout conventions of generateInvoicePdf
// (same jsPDF setup, margins, key/value writer) so slips look consistent.
export type DepositSlipData = {
  slipNumber: number;
  date: string;
  bankName: string;
  accountNumber: string;
  amount: number;
  depositedBy: string;
  reference?: string | null;
};

const fmtPkr = (n: number) => `PKR ${Number(n ?? 0).toLocaleString()}`;

export function generateDepositSlipPdf(data: DepositSlipData, company: Company | null) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text(company?.name ?? "Cash Deposit Slip", margin, y);
  y += 22;

  if (company?.contact_email || company?.contact_phone) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(
      [company?.contact_email, company?.contact_phone].filter(Boolean).join("  ·  "),
      margin,
      y,
    );
    y += 14;
  }

  doc.setDrawColor(220);
  doc.line(margin, y, pageWidth - margin, y);
  y += 18;

  doc.setTextColor(0);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("CASH DEPOSIT SLIP", margin, y);
  const slipLabel = `Slip #${data.slipNumber}`;
  doc.setFontSize(11);
  doc.setTextColor(110);
  doc.text(slipLabel, pageWidth - margin - doc.getTextWidth(slipLabel), y);
  y += 20;

  const writeKv = (title: string, value: string) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(title.toUpperCase(), margin, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(0);
    const lines = doc.splitTextToSize(value || "—", pageWidth - margin * 2);
    doc.text(lines, margin, y + 14);
    y += 14 + 14 * lines.length;
  };

  writeKv("Date", data.date);
  writeKv("Bank", data.bankName);
  writeKv("Account Number", data.accountNumber);
  writeKv("Deposited By", data.depositedBy || "—");
  if (data.reference) writeKv("Reference / Notes", data.reference);

  y += 8;
  doc.setDrawColor(220);
  doc.line(margin, y, pageWidth - margin, y);
  y += 18;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(0);
  doc.text("Amount Deposited", margin, y);
  const amt = fmtPkr(data.amount);
  doc.text(amt, pageWidth - margin - doc.getTextWidth(amt), y);

  doc.setFont("helvetica", "italic");
  doc.setFontSize(9);
  doc.setTextColor(140);
  doc.text(
    `Generated ${new Date().toLocaleString()}`,
    margin,
    doc.internal.pageSize.getHeight() - 30,
  );

  doc.save(`deposit_slip_${data.slipNumber}.pdf`);
}
