import type jsPDF from "jspdf";
import type { Company } from "./supabase";

// §11 — shared per-company branding for all generated guard PDFs (data form,
// discharge sheet, clearance certificate, attendance sheets, ID card). Uses the
// SAME jsPDF engine as invoices/payslips — no new library, nothing hardcoded.

export type PdfBranding = {
  name: string;
  legalName: string;
  logoUrl: string | null;
  brandColor: string; // hex
  /** Letterhead contact lines (6 Nov 2026). Never the registration line or NTN. */
  address?: string | null;
  phones?: string | null;
};

/** The second colour of the house style: near-black, for table headers and heavy blocks (like the GGS logo's black). */
export const DARK: [number, number, number] = [17, 17, 17];

export function brandingFromCompany(company: Company | null | undefined): PdfBranding {
  return {
    name: company?.name ?? "Company",
    legalName: company?.legal_name || company?.name || "Company",
    logoUrl: company?.logo_url ?? null,
    // 6 Nov 2026: the colour a company actually set lives in its Invoice
    // Structure settings (GGS: #b51a00, its logo red); companies.brand_color is
    // unset, so every document fell back to a default blue.
    brandColor: ((company as { brand_color?: string } | null)?.brand_color?.trim())
      || ((company?.invoice_settings as { brand_color?: string } | null | undefined)?.brand_color?.trim())
      || "#1e40af",
    address: company?.legal_address?.trim() || null,
    phones: ((company?.contact_phones ?? []).filter(Boolean).join(", ") || company?.contact_phone || "").trim() || null,
  };
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [30, 64, 175];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Detect image format from a data URL / extension for jsPDF.addImage.
export function imageFormat(url: string): "PNG" | "JPEG" | null {
  const u = url.toLowerCase();
  if (u.startsWith("data:image/png") || u.endsWith(".png")) return "PNG";
  if (u.startsWith("data:image/jpeg") || u.startsWith("data:image/jpg") || u.endsWith(".jpg") || u.endsWith(".jpeg")) return "JPEG";
  if (u.startsWith("data:image/")) return "PNG";
  return null;
}

const MARGIN = 14;

/**
 * THE LETTERHEAD (redesigned 6 Nov 2026, house style): brand bar, logo, legal
 * name with address and phones, a brand rule, then the document's title in the
 * brand colour and its subtitle. Returns the y to continue from (~44 mm).
 */
export function drawBrandedHeader(doc: jsPDF, b: PdfBranding, title: string, subtitle?: string): number {
  const [r, g, bl] = hexToRgb(b.brandColor);
  const pageW = doc.internal.pageSize.getWidth();
  const R = pageW - MARGIN;
  doc.setFillColor(r, g, bl);
  doc.rect(0, 0, pageW, 3, "F");

  let textX = MARGIN;
  const fmt = b.logoUrl ? imageFormat(b.logoUrl) : null;
  if (b.logoUrl && fmt) {
    try {
      const props = (doc as any).getImageProperties(b.logoUrl);
      const h = 15, w = Math.min(30, h * (props.width / props.height));
      doc.addImage(b.logoUrl, fmt, MARGIN, 7.5, w, h, undefined, "FAST");
      textX = MARGIN + w + 4;
    } catch {
      textX = MARGIN;
    }
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12.5);
  doc.setTextColor(15, 23, 42);
  doc.text(b.legalName, textX, 13, { maxWidth: R - textX });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  [b.address, b.phones].filter((x): x is string => !!x).forEach((line, i) => doc.text(line, textX, 17.5 + i * 3.6, { maxWidth: R - textX }));

  doc.setDrawColor(r, g, bl);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, 26.5, R, 26.5);
  doc.setLineWidth(0.2);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(r, g, bl);
  doc.text(title, MARGIN, 34);
  if (subtitle) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    doc.text(subtitle, MARGIN, 39, { maxWidth: R - MARGIN });
  }
  doc.setTextColor(15, 23, 42);
  return subtitle ? 43 : 38;
}

export function drawBrandedFooter(doc: jsPDF, b: PdfBranding, extra?: string) {
  const pageW = doc.internal.pageSize.getWidth();
  const y = doc.internal.pageSize.getHeight() - 8;
  doc.setDrawColor(226, 232, 240);
  doc.line(MARGIN, y - 3.5, pageW - MARGIN, y - 3.5);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(148, 163, 184);
  doc.text(`${b.legalName}${extra ? "  ·  " + extra : ""}`, MARGIN, y, { maxWidth: pageW - 2 * MARGIN - 32 });
  doc.text(`Generated ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`, pageW - MARGIN, y, { align: "right" });
}
