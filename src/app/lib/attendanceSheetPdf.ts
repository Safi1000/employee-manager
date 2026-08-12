import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { drawBrandedHeader, drawBrandedFooter, hexToRgb, type PdfBranding } from "./pdfBranding";

// §8.9 / §11.2 — branded attendance PDF templates (not raw data dumps):
// (a) per-client attendance sheet, (b) per-guard sheet for payroll.

export type ClientAttRow = {
  client_name: string; site_name: string; shift_code: string;
  contracted: number; on_roster: number; status: string;
  exceptions: string; supervisor: string;
};
export type GuardAttRow = {
  full_name: string; code: string; client_name: string; site_name: string;
  shift_code: string; status: string;
};

function table(doc: jsPDF, b: PdfBranding, cols: { title: string; w: number }[], rows: string[][], startY: number) {
  const [r, g, bl] = hexToRgb(b.brandColor);
  const margin = 14;
  let y = startY;
  const header = () => {
    doc.setFillColor(r, g, bl);
    doc.rect(margin, y, cols.reduce((a, c) => a + c.w, 0), 7, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    let x = margin;
    for (const c of cols) { doc.text(c.title, x + 1.5, y + 4.7); x += c.w; }
    y += 7;
  };
  header();
  doc.setFont("helvetica", "normal");
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(8);
  for (const row of rows) {
    if (y > 280) { doc.addPage(); y = 14; header(); doc.setFont("helvetica", "normal"); doc.setTextColor(15, 23, 42); doc.setFontSize(8); }
    let x = margin;
    doc.setDrawColor(226, 232, 240);
    doc.line(margin, y + 5.5, margin + cols.reduce((a, c) => a + c.w, 0), y + 5.5);
    for (let i = 0; i < cols.length; i++) {
      doc.text(doc.splitTextToSize(row[i] ?? "", cols[i].w - 3)[0] ?? "", x + 1.5, y + 4);
      x += cols[i].w;
    }
    y += 6;
  }
  return y;
}

export function generateClientAttendancePdf(branding: PdfBranding, date: string, rows: ClientAttRow[]) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const y = drawBrandedHeader(doc, branding, "Attendance Sheet — by client-shift", date);
  table(doc, branding,
    [{ title: "Client", w: 40 }, { title: "Site", w: 34 }, { title: "Shift", w: 16 }, { title: "Contr.", w: 14 }, { title: "Roster", w: 14 }, { title: "Status", w: 20 }, { title: "Exceptions", w: 30 }, { title: "Supervisor", w: 30 }],
    rows.map((r) => [r.client_name, r.site_name, r.shift_code, String(r.contracted), String(r.on_roster), r.status, r.exceptions, r.supervisor]),
    y);
  drawBrandedFooter(doc, branding, `Attendance ${date}`);
  void savePdf(doc, `attendance-by-client-${date}.pdf`);
}

export function generateGuardAttendancePdf(branding: PdfBranding, date: string, rows: GuardAttRow[]) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const y = drawBrandedHeader(doc, branding, "Attendance Sheet — by guard (payroll)", date);
  table(doc, branding,
    [{ title: "Guard", w: 46 }, { title: "Code", w: 28 }, { title: "Client", w: 40 }, { title: "Site", w: 30 }, { title: "Shift", w: 16 }, { title: "Status", w: 22 }],
    rows.map((r) => [r.full_name, r.code, r.client_name, r.site_name, r.shift_code, r.status]),
    y);
  drawBrandedFooter(doc, branding, `Attendance ${date}`);
  void savePdf(doc, `attendance-by-guard-${date}.pdf`);
}
