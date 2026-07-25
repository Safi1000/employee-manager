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
};

export function brandingFromCompany(company: Company | null | undefined): PdfBranding {
  return {
    name: company?.name ?? "Company",
    legalName: company?.legal_name || company?.name || "Company",
    logoUrl: company?.logo_url ?? null,
    brandColor: ((company as { brand_color?: string } | null)?.brand_color?.trim()) || "#1e40af",
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
const PAGE_W = 210;

// Branded header: accent bar + aspect-preserved logo + legal name + doc title.
// Returns the y position to continue content from.
export function drawBrandedHeader(doc: jsPDF, b: PdfBranding, title: string, subtitle?: string): number {
  const [r, g, bl] = hexToRgb(b.brandColor);
  let y = MARGIN;
  // accent bar
  doc.setFillColor(r, g, bl);
  doc.rect(0, 0, PAGE_W, 3, "F");

  let logoW = 0;
  const fmt = b.logoUrl ? imageFormat(b.logoUrl) : null;
  if (b.logoUrl && fmt) {
    try {
      const boxH = 16;
      const props = (doc as any).getImageProperties(b.logoUrl);
      const ratio = props.width / props.height;
      const drawH = boxH;
      const drawW = Math.min(40, drawH * ratio);
      doc.addImage(b.logoUrl, fmt, MARGIN, y, drawW, drawH, undefined, "FAST");
      logoW = drawW + 6;
    } catch {
      logoW = 0;
    }
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text(b.legalName, MARGIN + logoW, y + 6);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(r, g, bl);
  doc.text(title, MARGIN + logoW, y + 13);
  if (subtitle) {
    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    doc.text(subtitle, MARGIN + logoW, y + 18);
  }
  return y + 22;
}

export function drawBrandedFooter(doc: jsPDF, b: PdfBranding, extra?: string) {
  doc.setFontSize(7);
  doc.setTextColor(148, 163, 184);
  const gen = `Generated ${new Date().toISOString().slice(0, 10)}`;
  doc.text(`${b.legalName}${extra ? "  ·  " + extra : ""}  ·  ${gen}`, MARGIN, 290);
}
