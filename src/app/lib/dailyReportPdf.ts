import jsPDF from "jspdf";
import { formatDate } from "./date";
import type { Company } from "./supabase";
import { brandingFromCompany, drawBrandedHeader, drawBrandedFooter, hexToRgb } from "./pdfBranding";

// Daily Operations Report (repurposed Field Ops → Daily Reports): a date-wise,
// per-post snapshot of who reported, present-vs-required strength, and which
// posts went silent. Uses the shared branded jsPDF engine — no new library.

const MARGIN = 14;
const PAGE_W = 210;
const CONTENT_W = PAGE_W - MARGIN * 2;

export type DailyReportRow = {
  post_name?: string | null;
  region_name?: string | null;
  reported_today?: boolean | null;
  strength_present?: number | null;
  strength_required?: number | null;
  is_silent?: boolean | null;
  all_ok?: boolean | null;
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

  // Summary strip.
  const total = rows.length;
  const reported = rows.filter((x) => x.reported_today).length;
  const silent = rows.filter((x) => x.is_silent).length;
  const exceptions = rows.filter((x) => x.reported_today && x.all_ok === false).length;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(
    `${total} active posts   ·   ${reported} reported   ·   ${silent} silent   ·   ${exceptions} exceptions`,
    MARGIN,
    y,
  );
  y += 7;

  // Table header.
  const cols: Array<{ label: string; w: number; align?: "left" | "center" | "right" }> = [
    { label: "Post", w: 62 },
    { label: "Region", w: 40 },
    { label: "Reported", w: 24, align: "center" },
    { label: "Present / Req", w: 30, align: "right" },
    { label: "Status", w: CONTENT_W - 62 - 40 - 24 - 30, align: "center" },
  ];
  const drawHead = () => {
    doc.setFillColor(r, g, bl);
    doc.rect(MARGIN, y, CONTENT_W, 6, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    let x = MARGIN + 2;
    cols.forEach((c) => {
      const tx = c.align === "right" ? x + c.w - 2 : c.align === "center" ? x + c.w / 2 : x;
      doc.text(c.label, tx, y + 4, { align: c.align ?? "left" });
      x += c.w;
    });
    y += 6;
  };
  drawHead();

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  rows.forEach((row, i) => {
    if (y > 282) { doc.addPage(); y = MARGIN; drawHead(); doc.setFont("helvetica", "normal"); doc.setFontSize(8); }
    if (row.is_silent) {
      doc.setFillColor(254, 242, 242);
      doc.rect(MARGIN, y, CONTENT_W, 6, "F");
    } else if (i % 2 === 1) {
      doc.setFillColor(248, 250, 252);
      doc.rect(MARGIN, y, CONTENT_W, 6, "F");
    }
    const status = row.is_silent
      ? "SILENT"
      : row.reported_today
        ? (row.all_ok === false ? "Exception" : "All OK")
        : "Awaiting";
    const cells = [
      row.post_name ?? "—",
      row.region_name ?? "—",
      row.reported_today ? "Yes" : "—",
      `${row.strength_present ?? "—"} / ${row.strength_required ?? "—"}`,
      status,
    ];
    if (row.is_silent) doc.setTextColor(185, 28, 28);
    else doc.setTextColor(15, 23, 42);
    let x = MARGIN + 2;
    cells.forEach((val, ci) => {
      const c = cols[ci];
      const tx = c.align === "right" ? x + c.w - 2 : c.align === "center" ? x + c.w / 2 : x;
      const clipped = doc.splitTextToSize(String(val), c.w - 3)[0] ?? "";
      doc.text(clipped, tx, y + 4, { align: c.align ?? "left" });
      x += c.w;
    });
    y += 6;
  });

  if (rows.length === 0) {
    doc.setTextColor(100, 116, 139);
    doc.text("No active posts for this date.", MARGIN, y + 4);
  }

  drawBrandedFooter(doc, b, "Daily Operations Report");
  doc.save(`daily-operations-report-${reportDate}.pdf`);
}
