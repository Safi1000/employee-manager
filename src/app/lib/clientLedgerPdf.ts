import jsPDF from "jspdf";
import { saveBlob } from "./saveFile";
import { exportStamp } from "./exportStamp";

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
    { h: "Tax deducted", w: 20, align: "right" as const },
    { h: "Balance", w: 21, align: "right" as const },
  ];

  let y = M;
  const header = () => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`${opts.clientName} — statement of account`, M, y + 4);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(`${opts.companyName} · ${opts.scope}`, M, y + 10);
    y += 16;
    doc.setFillColor(238, 238, 238);
    doc.rect(M, y, W - 2 * M, 7, "F");
    doc.setFont("helvetica", "bold");
    let x = M;
    for (const c of cols) {
      doc.text(c.h, c.align === "right" ? x + c.w - 1.5 : x + 1.5, y + 4.8, { align: c.align });
      x += c.w;
    }
    doc.setFont("helvetica", "normal");
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

  y += 4;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  const closingText = opts.closing < 0
    ? `In credit: ${Math.round(-opts.closing).toLocaleString("en-US")}`
    : `Balance due: ${Math.round(opts.closing).toLocaleString("en-US")}`;
  doc.text(closingText, W - M, y, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.text(exportStamp(), M, H - 6);

  await saveBlob(doc.output("blob"), `${opts.clientName} statement.pdf`);
}
