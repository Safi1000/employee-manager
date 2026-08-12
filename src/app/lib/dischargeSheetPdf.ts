import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { drawBrandedHeader, drawBrandedFooter, type PdfBranding } from "./pdfBranding";

// Phase 7 §9.4 / Phase 8 §11.2 — branded discharge sheet, generated on separation
// using the shared jsPDF branding. Returns the doc; when `doc` is passed the page
// is appended (bulk). Filed into guard_documents as doc_type = discharge_sheet.
export function generateDischargeSheet(g: {
  branding: PdfBranding;
  full_name: string;
  guard_code?: string | null;
  display_code?: string | null;
  cnic_number?: string | null;
  join_date?: string | null;
  last_working_day: string;
  termination_date?: string | null;
  separation_reason: string;
  rehire_eligible: boolean;
  note?: string | null;
  doc?: jsPDF;
}): jsPDF {
  const appending = !!g.doc;
  const doc = g.doc ?? new jsPDF({ unit: "mm", format: "a4" });

  let y = drawBrandedHeader(doc, g.branding, "Discharge Sheet",
    `${g.full_name}  ·  ${g.display_code ?? g.guard_code ?? ""}`);
  y += 6;
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text("System-generated on separation — full service history is retained.", 14, y);
  doc.setTextColor(0);
  y += 10;

  doc.setFontSize(11);
  const row = (label: string, val: string | null | undefined) => {
    if (val == null || val === "") return;
    doc.setTextColor(110); doc.text(label, 14, y);
    doc.setTextColor(0); doc.text(String(val), 75, y);
    y += 9;
  };
  row("Guard", g.full_name);
  row("Guard code (permanent)", g.guard_code);
  row("Display code", g.display_code);
  row("CNIC", g.cnic_number);
  row("Joining date", g.join_date);
  row("Last working day", g.last_working_day);
  row("Termination date", g.termination_date);
  row("Separation reason", g.separation_reason);
  row("Eligible for rehire", g.rehire_eligible ? "Yes" : "No");
  row("Note", g.note);

  y += 10;
  doc.setDrawColor(200);
  doc.line(14, y, 120, y);
  y += 6;
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text("Authorised signatory", 14, y);

  drawBrandedFooter(doc, g.branding);
  if (!appending) void savePdf(doc, `discharge_${g.guard_code ?? g.full_name}.pdf`);
  return doc;
}
