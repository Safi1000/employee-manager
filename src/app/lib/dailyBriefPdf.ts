import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { formatDate } from "./date";
import type { Company } from "./supabase";
import { describeUnconfirmed, type AttendanceSummary } from "./attendanceSummary";
import { brandingFromCompany, imageFormat, type PdfBranding } from "./pdfBranding";

/**
 * DAILY OPERATIONS REPORT — formal letter style (DECIDED 2026-10-28, Shayan:
 * "Formal letter style"; order "HR/admin updates, then tasks, then clients").
 *
 *   letterhead       logo, company name, a double rule; the title centred;
 *                    Date / Region / Ref on one line
 *   attention        "Matters requiring attention" — only when something was
 *                    entered: notes ticked urgent (0568), yesterday's
 *                    attendance not confirmed, yesterday's tasks not ticked done
 *   1. Updates       the region's other updates; every "Heading:" line becomes
 *                    a numbered sub-section (1.1, 1.2 …), "•" lines dashes —
 *                    printed in full, as typed
 *   2. Tasks for tomorrow   a numbered table: task, responsible
 *   3. Clients       one numbered paragraph per client with a note, urgent
 *                    first; then "Nil report" naming the rest
 *   sign-off         Prepared by / Reviewed by / Approved by
 *
 * Times (serif) throughout. The attendance report is its own section so the two
 * export apart or together — generateOperationsPdf takes either or both.
 */

const M = 20;
const W = 210 - M * 2;
const BOTTOM = 297 - 22;
const LH = 4.9;

type RGB = [number, number, number];
const INK: RGB = [20, 20, 20];
const SOFT: RGB = [90, 90, 90];
const RULE: RGB = [120, 120, 120];
const RED: RGB = [150, 20, 20];

export type BriefClient = { client_name: string; details: string | null; no_report?: boolean; urgent?: boolean };
export type BriefTask = { title: string; assignee: string | null; done?: boolean };
export type BriefRegion = { label: string; tasks: BriefTask[]; otherUpdates: string | null };
export type DailyBrief = {
  reportDate: string;
  regionLabel: string | null;
  clients: BriefClient[];
  regions: BriefRegion[];
  /** Tasks set for the report day not ticked done. */
  openFromYesterday: BriefTask[];
  /** The previous day's attendance — for "Matters requiring attention". */
  attendance: AttendanceSummary | null;
};

const hasNote = (c: BriefClient) => !c.no_report && (c.details ?? "").trim().length > 0;
const longDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

class Page {
  y = 0;
  constructor(public doc: jsPDF, public b: PdfBranding) {}
  font(style: "normal" | "bold" | "italic" | "bolditalic", size: number) { this.doc.setFont("times", style); this.doc.setFontSize(size); }
  color(c: RGB) { this.doc.setTextColor(c[0], c[1], c[2]); }
  wrap(t: string, w: number) { return this.doc.splitTextToSize(t, w) as string[]; }
  need(h: number) { if (this.y + h > BOTTOM) { this.doc.addPage(); this.y = M + 4; return true; } return false; }
  rule(double = false) {
    this.doc.setDrawColor(...RULE); this.doc.setLineWidth(0.4);
    this.doc.line(M, this.y, M + W, this.y);
    if (double) { this.doc.setLineWidth(0.15); this.doc.line(M, this.y + 1, M + W, this.y + 1); }
    this.doc.setLineWidth(0.2);
  }
}

/** Logo, company name, double rule, centred title, Date / Region / Ref. */
function letterhead(p: Page, title: string, dateIso: string, region: string | null, ref: string) {
  const { doc, b } = p;
  p.y = M;
  const fmt = b.logoUrl ? imageFormat(b.logoUrl) : null;
  let textX = M;
  if (b.logoUrl && fmt) {
    try {
      const props = (doc as unknown as { getImageProperties: (u: string) => { width: number; height: number } }).getImageProperties(b.logoUrl);
      const h = 15, w = Math.min(30, h * (props.width / props.height));
      doc.addImage(b.logoUrl, fmt, M, p.y - 2, w, h, undefined, "FAST");
      textX = M + w + 5;
    } catch { /* no logo */ }
  }
  p.font("bold", 15); p.color(INK); doc.text(b.legalName, textX, p.y + 5);
  p.font("italic", 9.5); p.color(SOFT); doc.text("Operations Department", textX, p.y + 10.5);
  p.y += 16;
  p.rule(true);
  p.y += 9;
  p.font("bold", 13); p.color(INK);
  doc.text(title.toUpperCase(), M + W / 2, p.y, { align: "center", charSpace: 0.6 });
  p.y += 7;
  p.font("normal", 10); p.color(INK);
  doc.text(`Date: ${longDay(dateIso)}`, M, p.y);
  doc.text(`Region: ${region ?? "All regions"}`, M + W / 2, p.y, { align: "center" });
  doc.text(`Ref: ${ref}`, M + W, p.y, { align: "right" });
  p.y += 3;
  p.rule();
  p.y += 8;
}

function heading(p: Page, text: string) {
  p.need(14);
  p.font("bold", 12); p.color(INK);
  p.doc.text(text, M, p.y);
  p.y += 6.5;
}

/** Free text as typed: "Heading:" lines numbered (1.1, 1.2 …), bullets as dashes, plain lines as paragraphs. */
function writeUpdates(p: Page, text: string, section: number) {
  let sub = 0;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) { p.y += 1.5; continue; }
    const bullet = /^[•\-–*]\s*/.test(line);
    const isHead = !bullet && /:\s*$/.test(line) && line.length < 70;
    if (isHead) {
      sub += 1;
      p.need(LH * 2);
      p.y += 1.2;
      p.font("bold", 10.5); p.color(INK);
      p.doc.text(`${section}.${sub}`, M + 4, p.y);
      p.doc.text(line.replace(/:\s*$/, ""), M + 14, p.y);
      p.y += LH;
      continue;
    }
    const body = bullet ? line.replace(/^[•\-–*]\s*/, "") : line;
    const indent = sub ? 14 : 4;
    p.font("normal", 10.5); p.color(INK);
    const lines = p.wrap(body, W - indent - (bullet ? 5 : 0));
    lines.forEach((ln, i) => {
      p.need(LH);
      if (bullet && i === 0) p.doc.text("–", M + indent, p.y);
      p.doc.text(ln, M + indent + (bullet ? 5 : 0), p.y);
      p.y += LH;
    });
  }
}

function drawDaily(p: Page, d: DailyBrief) {
  const doc = p.doc;
  const written = d.clients.filter(hasNote);
  const nil = d.clients.filter((c) => !hasNote(c));

  // ── Matters requiring attention (only what was entered) ──
  const att = d.attendance;
  const items: string[] = [];
  for (const c of written.filter((x) => x.urgent)) {
    const first = (c.details ?? "").split("\n").map((s) => s.replace(/^[•\-–*]\s*/, "").trim()).find(Boolean) ?? "";
    items.push(`${c.client_name} (urgent) — ${first}`);
  }
  if (att && att.unconfirmed.length) {
    items.push(`Attendance for ${formatDate(att.date)} not confirmed — ${att.unconfirmed.map((c) => (c.partial ? describeUnconfirmed(c) : c.client_name)).join(", ")}.`);
  }
  for (const t of d.openFromYesterday) items.push(`Not completed from yesterday — ${t.title}${t.assignee ? ` (${t.assignee})` : ""}.`);
  if (items.length) {
    p.font("normal", 10.5);
    const laid = items.map((t) => p.wrap(t, W - 12));
    const h = 9 + laid.reduce((n, l) => n + l.length * LH, 0) + 2;
    p.need(h + 4);
    doc.setDrawColor(...RED); doc.setLineWidth(0.35);
    doc.rect(M, p.y - 4, W, h);
    doc.setLineWidth(0.2);
    p.font("bold", 10.5); p.color(RED); doc.text("Matters requiring attention", M + 4, p.y + 1);
    let yy = p.y + 7;
    p.font("normal", 10.5); p.color(INK);
    laid.forEach((lines, i) => {
      lines.forEach((ln, j) => { if (j === 0) doc.text(`${i + 1}.`, M + 4, yy); doc.text(ln, M + 10, yy); yy += LH; });
    });
    p.y += h + 4;
  }

  let sec = 0;
  const regionsWith = d.regions.filter((r) => (r.otherUpdates ?? "").trim());
  const many = d.regions.length > 1;

  // ── 1. Updates ──
  if (regionsWith.length) {
    sec += 1;
    heading(p, `${sec}.  Updates`);
    for (const r of regionsWith) {
      if (many) { p.need(LH * 2); p.font("bolditalic", 10.5); p.color(SOFT); doc.text(r.label, M + 4, p.y); p.y += LH + 0.5; }
      writeUpdates(p, (r.otherUpdates ?? "").trim(), sec);
      p.y += 3;
    }
  }

  // ── 2. Tasks for tomorrow ──
  const regionsTasks = d.regions.filter((r) => r.tasks.some((t) => t.title.trim()));
  if (regionsTasks.length) {
    sec += 1;
    heading(p, `${sec}.  Tasks for tomorrow`);
    const C1 = 12, C3 = 52, C2 = W - C1 - C3;
    const head = () => {
      p.need(8);
      doc.setDrawColor(...RULE);
      doc.line(M, p.y - 4.2, M + W, p.y - 4.2);
      p.font("bold", 10); p.color(INK);
      doc.text("S/No", M + 1, p.y); doc.text("Task", M + C1 + 2, p.y); doc.text("Responsible", M + C1 + C2 + 2, p.y);
      p.y += 2; doc.line(M, p.y, M + W, p.y); p.y += 4.6;
    };
    let n = 0;
    for (const r of regionsTasks) {
      if (many) { p.need(LH * 2); p.font("bolditalic", 10.5); p.color(SOFT); doc.text(r.label, M + 4, p.y); p.y += LH + 1.5; }
      head();
      for (const t of r.tasks.filter((x) => x.title.trim())) {
        n += 1;
        p.font("normal", 10.5);
        const lines = p.wrap(t.title.trim(), C2 - 4);
        if (p.need(lines.length * LH + 2)) head();
        p.color(INK);
        doc.text(`${n}.`, M + 1, p.y);
        lines.forEach((ln, i) => doc.text(ln, M + C1 + 2, p.y + i * LH));
        p.font(t.assignee ? "normal" : "italic", 10.5); p.color(t.assignee ? INK : SOFT);
        doc.text(t.assignee ?? "General", M + C1 + C2 + 2, p.y);
        p.y += lines.length * LH + 1.6;
      }
      doc.setDrawColor(...RULE); doc.line(M, p.y - 3, M + W, p.y - 3);
      p.y += 4;
    }
  }

  // ── 3. Clients ──
  sec += 1;
  heading(p, `${sec}.  Clients`);
  const ordered = [...written].sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || a.client_name.localeCompare(b.client_name));
  if (!ordered.length) { p.font("italic", 10.5); p.color(SOFT); doc.text("No client notes were recorded for this day.", M + 4, p.y); p.y += LH + 2; }
  ordered.forEach((c, i) => {
    p.need(LH * 3);
    p.font("bold", 10.5); p.color(INK);
    const label = `${sec}.${i + 1}`;
    doc.text(label, M + 4, p.y);
    doc.text(c.client_name, M + 14, p.y);
    if (c.urgent) { const w = doc.getTextWidth(c.client_name); p.font("bolditalic", 10); p.color(RED); doc.text("(Urgent)", M + 14 + w + 2, p.y); }
    p.y += LH;
    p.font("normal", 10.5); p.color(INK);
    for (const raw of (c.details ?? "").replace(/\r/g, "").split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const bullet = /^[•\-–*]\s*/.test(line);
      const body = bullet ? line.replace(/^[•\-–*]\s*/, "") : line;
      const lines = p.wrap(body, W - 14 - 5);
      lines.forEach((ln, j) => {
        p.need(LH);
        if (j === 0) doc.text("–", M + 14, p.y);
        doc.text(ln, M + 19, p.y);
        p.y += LH;
      });
    }
    p.y += 2.2;
  });
  if (nil.length) {
    p.font("normal", 10.5);
    const lines = p.wrap(`${nil.map((c) => c.client_name).join(", ")}.`, W - 14);
    p.need(lines.length * LH + LH + 2);
    p.font("bold", 10.5); p.color(INK); doc.text("Nil report", M + 4, p.y); p.y += LH;
    p.font("normal", 10.5); p.color(SOFT);
    lines.forEach((ln) => { doc.text(ln, M + 14, p.y); p.y += LH; });
  }

  // ── sign-off ──
  p.need(34);
  p.y += 20;
  const col = W / 3;
  ["Prepared by", "Reviewed by", "Approved by"].forEach((t, i) => {
    const x = M + i * col;
    doc.setDrawColor(...RULE); doc.line(x + 2, p.y, x + col - 6, p.y);
    p.font("normal", 10); p.color(INK); doc.text(t, x + 2, p.y + 5);
    p.font("italic", 9); p.color(SOFT); doc.text("Name, designation and date", x + 2, p.y + 9.5);
  });
  p.y += 12;
}

/** Interim attendance section, in the same letter style — replaced once the previous house style is in. */
function drawAttendanceSection(p: Page, s: AttendanceSummary) {
  const doc = p.doc;
  const COLS = [
    { label: "S/No", w: 12, right: false },
    { label: "Client", w: 56, right: false },
    { label: "Deployed", w: 20, right: true },
    { label: "Present", w: 18, right: true },
    { label: "Absent", w: 17, right: true },
    { label: "Leave", w: 15, right: true },
    { label: "Confirmed", w: W - 138, right: false },
  ];
  const head = () => {
    p.need(8);
    doc.setDrawColor(...RULE); doc.line(M, p.y - 4.2, M + W, p.y - 4.2);
    p.font("bold", 10); p.color(INK);
    let x = M;
    for (const c of COLS) { if (c.right) doc.text(c.label, x + c.w - 1, p.y, { align: "right" }); else doc.text(c.label, x + 1, p.y); x += c.w; }
    p.y += 2; doc.line(M, p.y, M + W, p.y); p.y += 4.6;
  };
  head();
  s.clients.forEach((c, i) => {
    if (p.need(LH + 1)) head();
    p.font("normal", 10.5); p.color(INK);
    let x = M;
    doc.text(`${i + 1}.`, x + 1, p.y); x += COLS[0].w;
    doc.text(p.wrap(c.client_name, COLS[1].w - 2)[0], x + 1, p.y); x += COLS[1].w;
    [c.deployed, c.present, c.absent, c.leave].forEach((n, k) => { doc.text(String(n), x + COLS[k + 2].w - 1, p.y, { align: "right" }); x += COLS[k + 2].w; });
    if (c.confirmed) doc.text("Yes", x + 1, p.y);
    else { p.font("bold", 10.5); p.color(RED); doc.text(c.partial ? `Partly (${c.sites.filter((t) => t.confirmed).length}/${c.sites.length})` : "Not confirmed", x + 1, p.y); }
    p.y += LH + 0.6;
  });
  const t = s.totals;
  p.need(10);
  doc.setDrawColor(...RULE); doc.line(M, p.y - 3.6, M + W, p.y - 3.6);
  p.font("bold", 10.5); p.color(INK);
  let x = M + COLS[0].w; doc.text("Total", x + 1, p.y); x += COLS[1].w;
  [t.deployed, t.present, t.absent, t.leave].forEach((n, k) => { doc.text(String(n), x + COLS[k + 2].w - 1, p.y, { align: "right" }); x += COLS[k + 2].w; });
  doc.text(`${s.clients.length - s.unconfirmed.length} of ${s.clients.length}`, x + 1, p.y);
  p.y += 2; doc.line(M, p.y, M + W, p.y); doc.line(M, p.y + 0.8, M + W, p.y + 0.8);
  p.y += 8;
}

function footer(doc: jsPDF, b: PdfBranding, ref: string) {
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...RULE); doc.setLineWidth(0.2); doc.line(M, 297 - 15, M + W, 297 - 15);
    doc.setFont("times", "italic"); doc.setFontSize(8.5); doc.setTextColor(...SOFT);
    doc.text(`${b.legalName}  ·  ${ref}`, M, 297 - 10.5);
    doc.text(`Page ${i} of ${pages}`, M + W, 297 - 10.5, { align: "right" });
  }
}

const refOf = (prefix: string, iso: string) => `${prefix}/${iso.replace(/-/g, "/")}`;

/**
 * One PDF: the daily report, the attendance report, or both (each starting on
 * its own page under its own letterhead). The file name says which.
 */
export function generateOperationsPdf(
  company: Company | null | undefined,
  parts: { daily?: DailyBrief; attendance?: { summary: AttendanceSummary; regionLabel: string | null } },
) {
  const b = brandingFromCompany(company);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const p = new Page(doc, b);
  let first = true;
  const day = parts.daily?.reportDate ?? parts.attendance?.summary.date ?? "";
  if (parts.daily) {
    letterhead(p, "Daily Operations Report", parts.daily.reportDate, parts.daily.regionLabel, refOf("DOR", parts.daily.reportDate));
    first = false;
    drawDaily(p, parts.daily);
  }
  if (parts.attendance) {
    const a = parts.attendance;
    if (!first) doc.addPage();
    letterhead(p, "Attendance Report", a.summary.date, a.regionLabel, refOf("ATR", a.summary.date));
    drawAttendanceSection(p, a.summary);
  }
  footer(doc, b, parts.daily ? refOf("DOR", day) : refOf("ATR", day));
  const kind = parts.daily && parts.attendance ? "Daily and attendance report" : parts.daily ? "Daily operations report" : "Attendance report";
  void savePdf(doc, `${kind} ${day}.pdf`);
}
