import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import type { Company } from "./supabase";
import { brandingFromCompany, drawBrandedFooter, drawBrandedHeader } from "./pdfBranding";

/**
 * The Payment follow-up report (0628) — shared whenever it is wanted, not daily.
 * Two forms from the same rows: WITHOUT figures (client, how late, usual pay
 * day, last contact, promise date, next step) and WITH figures (adds what they
 * owe and how much of it is late, and promise amounts). The with-figures form is
 * offered only to logins that can see amounts; for anyone else the amounts are
 * already null from client_followup_list(), so it could not print them anyway.
 */
export type FollowUpPdfRow = {
  client: string;
  region: string;
  late: string;            // "12 days late", "From before Bastion", "Not late yet"
  payDay: string;          // "5th" or ""
  lastContact: string;     // "2 Nov · Call — cheque this week"
  promise: string;         // "by 9 Nov" (+ " · 548,550" with figures)
  nextStep: string;        // "Collect cheque — Zafar, 5 Nov"
  owes: number | null;
  overdue: number | null;
};

export async function downloadFollowUpPdf(opts: {
  company: Company | null | undefined;
  rows: FollowUpPdfRow[];
  withFigures: boolean;
  scope: string;            // "All regions" / region name, and the filter
  asOf: string;             // "2 Nov 2026"
}) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const b = brandingFromCompany(opts.company);
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 14;

  const cols = opts.withFigures
    ? [{ h: "Client", w: 34 }, { h: "Late", w: 24 }, { h: "Owes", w: 20, r: true }, { h: "Late amount", w: 20, r: true }, { h: "Last contact", w: 40 }, { h: "Promise", w: 20 }, { h: "Next step", w: 24 }]
    : [{ h: "Client", w: 38 }, { h: "Late", w: 26 }, { h: "Pays on", w: 14 }, { h: "Last contact", w: 50 }, { h: "Promise", w: 18 }, { h: "Next step", w: 36 }];

  const startPage = () => {
    let y = drawBrandedHeader(doc, b, "Payment follow-up", `${opts.scope} · as of ${opts.asOf}${opts.withFigures ? " · with figures" : ""}`);
    y += 2;
    doc.setFillColor(241, 245, 249);
    doc.rect(M, y, W - 2 * M, 7, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(30, 41, 59);
    let x = M;
    for (const c of cols) {
      doc.text(c.h, "r" in c && c.r ? x + c.w - 1.5 : x + 1.5, y + 4.8, { align: "r" in c && c.r ? "right" : "left" });
      x += c.w;
    }
    doc.setFont("helvetica", "normal");
    return y + 9;
  };

  let y = startPage();
  const fmt = (n: number | null) => (n == null ? "" : Math.round(n).toLocaleString("en-US"));
  for (const r of opts.rows) {
    const cells = opts.withFigures
      ? [`${r.client}${r.region ? `\n${r.region}` : ""}`, `${r.late}${r.payDay ? `\nPays on the ${r.payDay}` : ""}`, fmt(r.owes), fmt(r.overdue), r.lastContact, r.promise, r.nextStep]
      : [`${r.client}${r.region ? `\n${r.region}` : ""}`, r.late, r.payDay, r.lastContact, r.promise, r.nextStep];
    doc.setFontSize(8);
    const wrapped = cells.map((t, i) => doc.splitTextToSize(String(t ?? ""), cols[i].w - 3) as string[]);
    const h = Math.max(...wrapped.map((w) => w.length)) * 3.6 + 2.5;
    if (y + h > H - 18) {
      drawBrandedFooter(doc, b);
      doc.addPage();
      y = startPage();
    }
    let x = M;
    wrapped.forEach((w, i) => {
      const c = cols[i];
      const right = "r" in c && c.r;
      doc.text(w, right ? x + c.w - 1.5 : x + 1.5, y + 3.2, { align: right ? "right" : "left" });
      x += c.w;
    });
    y += h;
    doc.setDrawColor(226, 232, 240);
    doc.line(M, y - 1, W - M, y - 1);
  }
  if (opts.rows.length === 0) {
    doc.setFontSize(10);
    doc.text("No client is late.", M, y + 6);
  }
  drawBrandedFooter(doc, b);
  await savePdf(doc, `Payment follow-up ${opts.asOf}${opts.withFigures ? " (with figures)" : ""}.pdf`);
}
