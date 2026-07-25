import jsPDF from "jspdf";
import { hexToRgb, imageFormat, type PdfBranding } from "./pdfBranding";

// §11.2 — printable company ID card: guard photo, permanent guard_code,
// client-prefixed display code, company ID-card number, per-company branding.
// Returns the jsPDF doc; when `doc` is passed the card is appended (bulk).
export function generateIdCardPdf(opts: {
  branding: PdfBranding;
  full_name: string;
  guard_code: string;
  display_code: string;
  company_id_card_number?: string | null;
  designation?: string | null;
  client_name?: string | null;
  cnic_number?: string | null;
  photo_url?: string | null;
  doc?: jsPDF;
}): jsPDF {
  const appending = !!opts.doc;
  const doc = opts.doc ?? new jsPDF({ unit: "mm", format: "a4" });
  const [r, g, b] = hexToRgb(opts.branding.brandColor);

  const x = 20, y = 30, w = 90, h = 56;
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(x, y, w, h, 3, 3, "F");
  doc.setDrawColor(r, g, b);
  doc.setLineWidth(0.8);
  doc.roundedRect(x, y, w, h, 3, 3, "S");
  doc.setLineWidth(0.2);

  // Brand bar with legal name (+ logo when present)
  doc.setFillColor(r, g, b);
  doc.rect(x, y, w, 11, "F");
  let tx = x + 3;
  const fmt = opts.branding.logoUrl ? imageFormat(opts.branding.logoUrl) : null;
  if (opts.branding.logoUrl && fmt) {
    try { doc.addImage(opts.branding.logoUrl, fmt, x + 2, y + 1.5, 8, 8, undefined, "FAST"); tx = x + 12; } catch { /* ignore */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text(opts.branding.legalName.slice(0, 30), tx, y + 7);

  // Photo
  doc.setDrawColor(203, 213, 225);
  doc.rect(x + 3, y + 15, 22, 28);
  const pfmt = opts.photo_url ? imageFormat(opts.photo_url) : null;
  if (opts.photo_url && pfmt) {
    try { doc.addImage(opts.photo_url, pfmt, x + 3, y + 15, 22, 28, undefined, "FAST"); } catch { /* ignore */ }
  } else {
    doc.setFontSize(6);
    doc.setTextColor(148, 163, 184);
    doc.text("PHOTO", x + 9, y + 30);
  }

  // Details
  let ty = y + 19;
  const dx = x + 28;
  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(opts.full_name.slice(0, 26), dx, ty);
  ty += 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(r, g, b);
  doc.text(opts.display_code, dx, ty);
  ty += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(71, 85, 105);
  const line = (t: string | null | undefined) => { if (t) { doc.text(t, dx, ty); ty += 4.2; } };
  line(`Guard code: ${opts.guard_code}`);
  line(opts.designation);
  line(opts.client_name ? `Client: ${opts.client_name}` : null);
  line(opts.cnic_number ? `CNIC: ${opts.cnic_number}` : null);
  line(opts.company_id_card_number ? `Card #: ${opts.company_id_card_number}` : null);

  doc.setFontSize(6);
  doc.setTextColor(148, 163, 184);
  doc.text("If found, please return to the issuing company.", x + 3, y + h - 2.5);

  if (!appending) doc.save(`id-card-${opts.guard_code}.pdf`);
  return doc;
}
