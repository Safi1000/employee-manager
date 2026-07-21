import jsPDF from "jspdf";
import { formatDate } from "./date";

// §22 — printable Client Service Report: service reviews + complaints history
// for a client, using the same jsPDF engine as the employee form / payslips.

const MARGIN = 14;
const PAGE_W = 210;
const CONTENT_W = PAGE_W - MARGIN * 2;

type ReportData = {
  companyName: string;
  clientName: string;
  reviews: Array<{ review_date: string; rating: number; summary?: string; action_items?: string }>;
  complaints: Array<{ raised_on: string; channel?: string; description?: string; status?: string; resolved_on?: string | null }>;
};

export function generateClientServiceReportPdf(data: ReportData) {
  const { companyName, clientName, reviews, complaints } = data;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = MARGIN;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text(companyName || "Client Service Report", MARGIN, y + 4);
  doc.setFontSize(11);
  doc.setTextColor(71, 85, 105);
  doc.text("Client Service Report", MARGIN, y + 10);
  doc.setFontSize(9);
  doc.text(`Client: ${clientName}`, MARGIN, y + 16);
  doc.text(`Generated: ${formatDate(new Date().toISOString().slice(0, 10))}`, MARGIN, y + 21);
  y += 30;

  const section = (title: string) => {
    if (y > 265) { doc.addPage(); y = MARGIN; }
    doc.setFillColor(241, 245, 249);
    doc.rect(MARGIN, y, CONTENT_W, 6, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);
    doc.text(title.toUpperCase(), MARGIN + 2, y + 4);
    y += 9;
  };

  const line = (text: string) => {
    if (y > 285) { doc.addPage(); y = MARGIN; }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(15, 23, 42);
    const parts = doc.splitTextToSize(text, CONTENT_W);
    doc.text(parts, MARGIN, y);
    y += parts.length * 4.5 + 1.5;
  };

  const avg = reviews.length ? (reviews.reduce((s, r) => s + Number(r.rating || 0), 0) / reviews.length).toFixed(1) : "—";
  section(`Service Reviews (avg ★${avg}, ${reviews.length})`);
  if (reviews.length === 0) line("No reviews recorded.");
  reviews.forEach((r) => {
    line(`${r.review_date} · ★${r.rating} — ${r.summary || "(no summary)"}${r.action_items ? `  [Actions: ${r.action_items}]` : ""}`);
  });
  y += 3;

  const open = complaints.filter((c) => c.status !== "resolved" && c.status !== "closed").length;
  section(`Complaints (${complaints.length} total, ${open} open)`);
  if (complaints.length === 0) line("No complaints recorded.");
  complaints.forEach((c) => {
    line(`${c.raised_on} · ${c.channel || "—"} · ${c.status || "open"} — ${c.description || ""}${c.resolved_on ? `  (resolved ${c.resolved_on})` : ""}`);
  });

  doc.setFontSize(7);
  doc.setTextColor(148, 163, 184);
  doc.text("Confidential — internal client relationship record.", MARGIN, 292);

  doc.save(`client-service-report-${clientName.replace(/\s+/g, "-").toLowerCase()}.pdf`);
}
