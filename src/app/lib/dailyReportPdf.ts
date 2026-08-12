import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { formatDate } from "./date";
import type { Company } from "./supabase";
import { brandingFromCompany, drawBrandedHeader, drawBrandedFooter, hexToRgb } from "./pdfBranding";

// Daily Operations Report: one line per client for a given day, carrying whatever
// was written in that client's Details box. The per-post version (required vs
// present strength, silent-post alerting, exception notes) was dropped — the
// report is now a client-by-client written note, not a headcount reconciliation.
// Uses the shared branded jsPDF engine — no new library.

const MARGIN = 14;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;
const CLIENT_W = 58;
const DETAILS_W = CONTENT_W - CLIENT_W;
const LINE_H = 4.2;
const PAD_Y = 1.6;
const FOOTER_LIMIT = PAGE_H - 20;

export type DailyReportRow = {
  client_name: string;
  details: string | null;
};

export function generateDailyOperationsReportPdf(
  company: Company | null | undefined,
  reportDate: string,
  rows: DailyReportRow[],
) {
  const b = brandingFromCompany(company);
  const [r, g, bl] = hexToRgb(b.brandColor);
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  let y = drawBrandedHeader(doc, b, "Daily Operations Report", `For ${formatDate(reportDate)}`);
  y += 2;

  const withDetails = rows.filter((x) => (x.details ?? "").trim().length > 0).length;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(`${rows.length} clients   ·   ${withDetails} with details recorded`, MARGIN, y);
  y += 7;

  const drawHead = () => {
    doc.setFillColor(r, g, bl);
    doc.rect(MARGIN, y, CONTENT_W, 6, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.text("Client", MARGIN + 2, y + 4);
    doc.text("Details", MARGIN + CLIENT_W + 2, y + 4);
    y += 6;
  };
  drawHead();

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  rows.forEach((row, i) => {
    // Details is free text of any length, so the row grows to fit it rather than
    // clipping to one line — the note IS the report, and a truncated note is a
    // lost one. Client names wrap for the same reason.
    const detailText = (row.details ?? "").trim() || "—";
    const detailLines = doc.splitTextToSize(detailText, DETAILS_W - 4) as string[];
    const nameLines = doc.splitTextToSize(row.client_name, CLIENT_W - 4) as string[];
    const rowH = Math.max(detailLines.length, nameLines.length) * LINE_H + PAD_Y * 2;

    // A row taller than the page would loop forever if we tried to keep it whole,
    // so only break when there is a page left to break onto.
    if (y + rowH > FOOTER_LIMIT && y > MARGIN + 10) {
      doc.addPage();
      y = MARGIN;
      drawHead();
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
    }

    if (i % 2 === 1) {
      doc.setFillColor(248, 250, 252);
      doc.rect(MARGIN, y, CONTENT_W, rowH, "F");
    }
    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "bold");
    nameLines.forEach((ln, li) => doc.text(ln, MARGIN + 2, y + PAD_Y + 3 + li * LINE_H));
    doc.setFont("helvetica", "normal");
    doc.setTextColor((row.details ?? "").trim() ? 15 : 148, (row.details ?? "").trim() ? 23 : 163, (row.details ?? "").trim() ? 42 : 184);
    detailLines.forEach((ln, li) =>
      doc.text(ln, MARGIN + CLIENT_W + 2, y + PAD_Y + 3 + li * LINE_H),
    );
    y += rowH;
  });

  if (rows.length === 0) {
    doc.setTextColor(100, 116, 139);
    doc.text("No active clients for this date.", MARGIN, y + 4);
  }

  drawBrandedFooter(doc, b, "Daily Operations Report");
  void savePdf(doc, `daily-operations-report-${reportDate}.pdf`);
}
