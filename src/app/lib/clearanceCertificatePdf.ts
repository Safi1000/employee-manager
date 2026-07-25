import jsPDF from "jspdf";
import { formatDate } from "./date";
import { drawBrandedHeader, drawBrandedFooter, hexToRgb, type PdfBranding } from "./pdfBranding";

// §11.2 / §9.3 — branded Exit Clearance Certificate. Reproduces the clearance
// gates (kit / advance / incidents / dues) from clearance_certificates.
export function generateClearanceCertificatePdf(opts: {
  branding: PdfBranding;
  full_name: string;
  guard_code: string;
  display_code?: string | null;
  last_working_day?: string | null;
  separation_reason?: string | null;
  clearance: {
    status?: string | null;
    kit_returned?: boolean | null;
    outstanding_kit_count?: number | null;
    advance_settled?: boolean | null;
    outstanding_advance?: number | null;
    incidents_reviewed?: boolean | null;
    open_incident_count?: number | null;
    dues_released?: boolean | null;
    dues_released_on?: string | null;
    cleared_by_name?: string | null;
  };
  doc?: jsPDF;
}): jsPDF {
  const appending = !!opts.doc;
  const doc = opts.doc ?? new jsPDF({ unit: "mm", format: "a4" });
  const c = opts.clearance;

  let y = drawBrandedHeader(doc, opts.branding, "Exit Clearance Certificate",
    `${opts.full_name}  ·  ${opts.display_code ?? opts.guard_code}`);
  y += 4;

  doc.setFontSize(9);
  const kv = (label: string, val: string) => {
    doc.setFont("helvetica", "bold"); doc.setTextColor(100, 116, 139); doc.text(label, 14, y);
    doc.setFont("helvetica", "normal"); doc.setTextColor(15, 23, 42); doc.text(val, 70, y);
    y += 6;
  };
  kv("Guard code (permanent)", opts.guard_code);
  kv("Last working day", opts.last_working_day ? formatDate(opts.last_working_day) : "—");
  kv("Separation reason", opts.separation_reason ?? "—");
  kv("Clearance status", (c.status ?? "—").toString());
  y += 4;

  // Gate table
  const gate = (label: string, pass: boolean | null | undefined, detail: string) => {
    const [gr, gg, gb] = pass ? [22, 163, 74] : [220, 38, 38];
    doc.setDrawColor(226, 232, 240);
    doc.rect(14, y - 4, 182, 9);
    doc.setFont("helvetica", "bold"); doc.setTextColor(30, 41, 59); doc.setFontSize(9);
    doc.text(label, 17, y + 1.5);
    doc.setTextColor(gr, gg, gb);
    doc.text(pass ? "CLEARED" : "OUTSTANDING", 120, y + 1.5);
    doc.setFont("helvetica", "normal"); doc.setTextColor(100, 116, 139); doc.setFontSize(8);
    doc.text(detail, 150, y + 1.5);
    y += 9;
  };
  gate("Kit returned", c.kit_returned, `${c.outstanding_kit_count ?? 0} outstanding`);
  gate("Advances settled", c.advance_settled, c.outstanding_advance != null ? c.outstanding_advance.toLocaleString() : "0");
  gate("Incidents reviewed", c.incidents_reviewed, `${c.open_incident_count ?? 0} open`);
  gate("Final dues released", c.dues_released, c.dues_released_on ? formatDate(c.dues_released_on) : "—");

  y += 10;
  const [r, g, b] = hexToRgb(opts.branding.brandColor);
  doc.setTextColor(r, g, b);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  const cleared = c.status === "cleared";
  doc.text(cleared ? "This guard is CLEARED for exit." : "Clearance PENDING — gates outstanding.", 14, y);
  y += 20;

  doc.setDrawColor(148, 163, 184);
  doc.line(14, y, 90, y);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(71, 85, 105);
  doc.text(`Cleared by: ${c.cleared_by_name ?? "________________"}`, 14, y + 5);
  doc.line(120, y, 196, y);
  doc.text("Authorised signatory", 120, y + 5);

  drawBrandedFooter(doc, opts.branding);
  if (!appending) doc.save(`clearance-${opts.guard_code}.pdf`);
  return doc;
}
