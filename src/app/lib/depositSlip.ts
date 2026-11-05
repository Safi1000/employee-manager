import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { amountInWords, type Company } from "./supabase";
import { brandingFromCompany, drawBrandedHeader, drawBrandedFooter, hexToRgb, DARK } from "./pdfBranding";

// Cash deposit slip PDF — house style (6 Nov 2026): the shared letterhead, the
// slip's particulars in a panel, the amount in figures and words, and the two
// signatures a deposit needs (deposited by / received by the bank).
export type DepositSlipData = {
  slipNumber: number;
  date: string;
  bankName: string;
  accountNumber: string;
  amount: number;
  depositedBy: string;
  reference?: string | null;
};

export function generateDepositSlipPdf(data: DepositSlipData, company: Company | null) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const b = brandingFromCompany(company);
  const [br, bg, bb] = hexToRgb(b.brandColor);
  const L = 14, R = 196, W = R - L;
  const day = /^\d{4}-\d{2}-\d{2}/.test(data.date)
    ? new Date(`${data.date.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : data.date;

  let y = drawBrandedHeader(doc, b, "Cash deposit slip", `Slip #${data.slipNumber}  ·  ${day}`) + 4;

  doc.setFillColor(248, 250, 252); doc.setDrawColor(226, 232, 240);
  const rows: [string, string][] = [
    ["Bank", data.bankName], ["Account number", data.accountNumber], ["Deposited by", data.depositedBy || "—"],
    ...(data.reference ? [["Reference / notes", data.reference] as [string, string]] : []),
  ];
  const panelH = 8 + rows.length * 11;
  doc.roundedRect(L, y, W, panelH, 2, 2, "FD");
  rows.forEach(([k, v], i) => {
    const yy = y + 7 + i * 11;
    doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(100, 116, 139); doc.text(k.toUpperCase(), L + 5, yy);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(15, 23, 42); doc.text(v || "—", L + 5, yy + 5, { maxWidth: W - 10 });
  });
  y += panelH + 8;

  doc.setFillColor(...DARK); doc.roundedRect(L, y, W, 22, 2, 2, "F");
  doc.setFillColor(br, bg, bb); doc.rect(L, y + 3, 1.6, 16, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.text("AMOUNT DEPOSITED", L + 6, y + 7);
  doc.setFont("helvetica", "bold"); doc.setFontSize(18);
  doc.text(`Rs ${Math.round(Number(data.amount ?? 0)).toLocaleString("en-PK")}`, R - 6, y + 10, { align: "right" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
  doc.text(amountInWords(Number(data.amount ?? 0)), L + 6, y + 16.5, { maxWidth: W - 12 });
  y += 40;

  const sigW = (W - 12) / 2;
  (["Deposited by (name & signature)", "Received by bank (stamp & signature)"] as const).forEach((label, i) => {
    const x = L + i * (sigW + 12);
    doc.setDrawColor(148, 163, 184); doc.line(x, y + 14, x + sigW, y + 14);
    doc.setFontSize(7.5); doc.setTextColor(100, 116, 139); doc.text(label, x, y + 18.5);
  });

  drawBrandedFooter(doc, b, `Cash deposit slip #${data.slipNumber}`);
  void savePdf(doc, `deposit_slip_${data.slipNumber}.pdf`);
}
