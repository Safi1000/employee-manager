import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { amountInWords, type Company } from "./supabase";
import { brandingFromCompany } from "./pdfBranding";
import { INK, LH, M, Page, SOFT, W, footer, heading, letterhead, longDay, signOff } from "./dailyBriefPdf";

/**
 * PAYMENT RECEIPT (3 Nov 2026) — the official receipt a client is given for a
 * payment, in the house letter style. 56% of payments since September were
 * cash and none produced a receipt; this prints one from the ledger line
 * itself (client_receivable_ledger), so it cannot say anything the books don't.
 */
export type ReceiptLine = {
  date: string;            // payment date, YYYY-MM-DD
  reference: string;       // invoice number(s) or "On account"
  mode: string | null;
  chequeNo: string | null;
  depositedTo: string | null;
  received: number;
  wht: number;
};

const amt = (n: number) => Math.round(n).toLocaleString("en-US");

export function receiptRef(l: ReceiptLine) {
  return `RCT/${l.date.replace(/-/g, "/")}/${Math.round(l.received + l.wht)}`;
}

export async function downloadReceiptPdf(opts: { company: Company | null | undefined; client: string; line: ReceiptLine; receivedBy: string }) {
  const { line: l } = opts;
  const b = brandingFromCompany(opts.company);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const p = new Page(doc, b);
  const ref = receiptRef(l);
  letterhead(p, "Payment Receipt", l.date, null, ref, "Accounts Department");

  const para = (t: string, style: "normal" | "bold" = "normal") => {
    p.font(style, 11); p.color(INK);
    p.wrap(t, W).forEach((ln) => { p.need(LH); doc.text(ln, M, p.y); p.y += LH; });
    p.y += 2.5;
  };
  const how = [l.mode, l.chequeNo ? `cheque no. ${l.chequeNo}` : null].filter(Boolean).join(", ");
  para(`Received with thanks from ${opts.client} the sum of PKR ${amt(l.received)} (${amountInWords(Math.round(l.received))}) on ${longDay(l.date)}${how ? `, by ${how}` : ""}${l.depositedTo ? `, into ${l.depositedTo}` : ""}.`);
  if (l.wht > 0.5) {
    para(`Income tax of PKR ${amt(l.wht)} was deducted at source. The gross amount settled is PKR ${amt(l.received + l.wht)}; we await the tax certificate for the deduction.`);
  }
  heading(p, "Applied to");
  para(l.reference || "On account");

  p.y += 2;
  p.font("italic", 9.5); p.color(SOFT);
  p.wrap("This receipt is issued from the company's books. A cheque payment is subject to realisation.", W).forEach((ln) => { p.need(LH); doc.text(ln, M, p.y); p.y += LH; });

  signOff(p, "Received by", opts.receivedBy ? [opts.receivedBy] : []);
  footer(doc, b, ref);
  await savePdf(doc, `Receipt ${opts.client} ${l.date}.pdf`);
}

/** A WhatsApp message for the same receipt, opened ready to send. */
export function receiptWhatsAppText(client: string, l: ReceiptLine, companyName: string) {
  const how = [l.mode, l.chequeNo ? `cheque ${l.chequeNo}` : null].filter(Boolean).join(", ");
  return `${companyName}: payment received with thanks from ${client} — PKR ${amt(l.received)} on ${l.date.split("-").reverse().join("/")}${how ? ` (${how})` : ""}${l.wht > 0.5 ? `, tax deducted PKR ${amt(l.wht)}` : ""}. Ref ${receiptRef(l)}.`;
}
