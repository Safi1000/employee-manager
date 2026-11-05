import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { drawBrandedHeader, drawBrandedFooter, hexToRgb, DARK, type PdfBranding } from "./pdfBranding";

/**
 * The client statement as a PDF (0626). It prints exactly the lines
 * client_receivable_ledger returned — the running balance is the database's,
 * not recomputed here.
 */
export type LedgerPdfLine = {
  date: string;
  details: string;
  reference: string;
  how: string;
  invoiced: number;
  received: number;
  wht: number;
  balance: number;
};

const fmt = (n: number) => (n ? Math.round(n).toLocaleString("en-US") : "");

export async function downloadClientLedgerPdf(opts: {
  companyName: string;
  /** House-style letterhead (6 Nov 2026). Without it the company name alone heads the page. */
  branding?: PdfBranding;
  clientName: string;
  scope: string;
  lines: LedgerPdfLine[];
  closing: number;
}) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 12;
  const cols = [
    { h: "Date", w: 22, align: "left" as const },
    { h: "Details", w: 70, align: "left" as const },
    { h: "Invoice", w: 34, align: "left" as const },
    { h: "How paid / where it went", w: 62, align: "left" as const },
    { h: "Invoiced", w: 22, align: "right" as const },
    { h: "Received", w: 22, align: "right" as const },
    { h: "Tax ded.", w: 20, align: "right" as const },
    { h: "Balance", w: 21, align: "right" as const },
  ];

  const brand: PdfBranding = opts.branding ?? { name: opts.companyName, legalName: opts.companyName, logoUrl: null, brandColor: "#111111" };
  const [br, bg, bb] = hexToRgb(brand.brandColor);
  let y = M;
  const header = () => {
    y = drawBrandedHeader(doc, brand, `Statement of account — ${opts.clientName}`, opts.scope) + 2;
    doc.setFillColor(...DARK);
    doc.rect(M, y, W - 2 * M, 7, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(255, 255, 255);
    let x = M;
    for (const c of cols) {
      doc.text(c.h, c.align === "right" ? x + c.w - 1.5 : x + 1.5, y + 4.8, { align: c.align });
      x += c.w;
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    y += 9;
  };
  header();

  for (const l of opts.lines) {
    const cells = [l.date, l.details, l.reference, l.how, fmt(l.invoiced), fmt(l.received), fmt(l.wht), Math.round(l.balance).toLocaleString("en-US")];
    const wrapped = cells.map((t, i) => doc.splitTextToSize(String(t ?? ""), cols[i].w - 3) as string[]);
    const h = Math.max(...wrapped.map((w) => w.length)) * 4 + 2;
    if (y + h > H - 16) {
      doc.addPage();
      y = M;
      header();
    }
    let x = M;
    wrapped.forEach((w, i) => {
      const c = cols[i];
      doc.text(w, c.align === "right" ? x + c.w - 1.5 : x + 1.5, y + 3.5, { align: c.align });
      x += c.w;
    });
    y += h;
    doc.setDrawColor(225, 225, 225);
    doc.line(M, y - 1, W - M, y - 1);
  }

  // Closing balance in a brand-edged box, then the footer on every page.
  if (y + 16 > H - 16) { doc.addPage(); y = M; header(); }
  y += 3;
  const closingText = opts.closing < 0
    ? `In credit: Rs ${Math.round(-opts.closing).toLocaleString("en-US")}`
    : `Balance due: Rs ${Math.round(opts.closing).toLocaleString("en-US")}`;
  doc.setFillColor(...DARK);
  doc.rect(W - M - 90, y, 90, 11, "F");
  doc.setFillColor(br, bg, bb);
  doc.rect(W - M - 90, y, 1.6, 11, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(255, 255, 255);
  doc.text(closingText, W - M - 4, y + 7.2, { align: "right" });
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) { doc.setPage(p); drawBrandedFooter(doc, brand, `Statement of account · ${opts.clientName} · page ${p} of ${pages}`); }

  await savePdf(doc, `${opts.clientName} statement.pdf`);
}
