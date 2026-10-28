import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { formatDate } from "./date";
import type { Company } from "./supabase";
import { describeUnconfirmed, type AttendanceSummary } from "./attendanceSummary";
import { brandingFromCompany, drawBrandedHeader, drawBrandedFooter, hexToRgb, type PdfBranding } from "./pdfBranding";

/**
 * DAILY OPERATIONS REPORT, rebuilt 2026-10-28.
 *
 * Reads top to bottom the way it is used:
 *   status strip     clients reported, tasks for tomorrow, yesterday's
 *                    attendance confirmed — is the day normal at a glance;
 *   needs attention  ONLY what was entered: notes ticked urgent (0568),
 *                    yesterday's attendance not confirmed, yesterday's tasks
 *                    not ticked done (0568). Nothing guessed;
 *   per region       tomorrow's tasks as a checklist with owners, then the
 *                    region's other updates ("Heading:" lines bold, "•" lines
 *                    as bullets — printed in full, as typed);
 *   clients          the written notes, urgent first, in full;
 *   no report        one muted line;
 *   sign-off.
 *
 * The attendance report is its own section (page) so the two can be exported
 * apart or together — generateOperationsPdf takes either or both.
 */

const M = 14;
const W = 210 - M * 2;
const BOTTOM = 297 - 20;
const LH = 4.3;

type RGB = [number, number, number];
const INK: RGB = [15, 23, 42];
const MUTED: RGB = [100, 116, 139];
const FAINT: RGB = [148, 163, 184];
const RULE: RGB = [226, 232, 240];
const AMBER_BG: RGB = [254, 247, 230];
const AMBER_TX: RGB = [146, 86, 12];
const RED: RGB = [185, 28, 28];
const GREEN_BG: RGB = [236, 247, 239];
const GREEN_TX: RGB = [22, 101, 52];

export type BriefClient = { client_name: string; details: string | null; no_report?: boolean; urgent?: boolean };
export type BriefTask = { title: string; assignee: string | null; done?: boolean };
export type BriefRegion = { label: string; tasks: BriefTask[]; otherUpdates: string | null };
export type DailyBrief = {
  reportDate: string;
  regionLabel: string | null;
  clients: BriefClient[];
  regions: BriefRegion[];
  /** Tasks set for the report day (yesterday's list) not ticked done. */
  openFromYesterday: BriefTask[];
  /** The previous day's attendance — for the strip and Needs attention. */
  attendance: AttendanceSummary | null;
};

const hasNote = (c: BriefClient) => !c.no_report && (c.details ?? "").trim().length > 0;
const longDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

class Pager {
  y = 0;
  constructor(public doc: jsPDF, public b: PdfBranding, public title: string, public subtitle: string) {}
  start() { this.y = drawBrandedHeader(this.doc, this.b, this.title, this.subtitle) + 2; }
  fresh() { this.doc.addPage(); this.start(); }
  need(h: number) { if (this.y + h > BOTTOM) { this.doc.addPage(); this.y = M + 4; return true; } return false; }
  color(c: RGB) { this.doc.setTextColor(c[0], c[1], c[2]); }
  font(style: "normal" | "bold" | "italic", size: number) { this.doc.setFont("helvetica", style); this.doc.setFontSize(size); }
  wrap(text: string, w: number) { return this.doc.splitTextToSize(text, w) as string[]; }
}

/** Free text as typed: "Heading:" lines bold, "•" / "-" lines hung as bullets, other lines plain. */
function writeRich(p: Pager, text: string, x: number, w: number) {
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) { p.y += 1.5; continue; }
    const bullet = /^[•\-–*]\s*/.test(line);
    const heading = !bullet && /:\s*$/.test(line) && line.length < 60;
    const body = bullet ? line.replace(/^[•\-–*]\s*/, "") : line;
    p.font(heading ? "bold" : "normal", 9);
    p.color(INK);
    const lines = p.wrap(body, w - (bullet ? 4 : 0));
    lines.forEach((ln, i) => {
      p.need(LH);
      if (bullet && i === 0) p.doc.text("•", x, p.y);
      p.doc.text(ln, x + (bullet ? 4 : 0), p.y);
      p.y += LH;
    });
    if (heading) p.y += 0.4;
  }
}

function tile(p: Pager, x: number, w: number, label: string, value: string, sub: string, tone: RGB = INK) {
  p.doc.setFillColor(246, 248, 251);
  p.doc.roundedRect(x, p.y, w, 17, 2, 2, "F");
  p.font("normal", 7.5); p.color(MUTED); p.doc.text(label, x + 3.5, p.y + 5);
  p.font("bold", 14); p.color(tone); p.doc.text(value, x + 3.5, p.y + 12.5);
  const vw = p.doc.getTextWidth(value);
  p.font("normal", 8); p.color(MUTED); p.doc.text(sub, x + 3.5 + vw + 2, p.y + 12.5);
}

function drawDaily(p: Pager, d: DailyBrief) {
  const written = d.clients.filter(hasNote);
  const quiet = d.clients.filter((c) => !hasNote(c));
  const urgent = written.filter((c) => c.urgent);
  const att = d.attendance;
  const tasksTomorrow = d.regions.reduce((n, r) => n + r.tasks.filter((t) => t.title.trim()).length, 0);

  // ── status strip ──
  const tw = (W - 6) / 3;
  tile(p, M, tw, "Clients reported", String(written.length), `of ${d.clients.length}`);
  tile(p, M + tw + 3, tw, "Tasks for tomorrow", String(tasksTomorrow), "");
  if (att) {
    const ok = att.clients.length - att.unconfirmed.length;
    tile(p, M + (tw + 3) * 2, tw, `${formatDate(att.date)} attendance`, String(ok), `of ${att.clients.length} confirmed`, att.unconfirmed.length ? AMBER_TX : GREEN_TX);
  }
  p.y += 22;

  // ── needs attention ──
  const items: { lead: string; text: string; tone: RGB }[] = [];
  for (const c of urgent) {
    const first = (c.details ?? "").split("\n").map((s) => s.replace(/^[•\-–*]\s*/, "").trim()).find(Boolean) ?? "";
    items.push({ lead: c.client_name, text: first, tone: RED });
  }
  if (att && att.unconfirmed.length) {
    items.push({ lead: `${formatDate(att.date)} attendance not confirmed`, text: att.unconfirmed.map((c) => c.partial ? describeUnconfirmed(c) : c.client_name).join(", "), tone: AMBER_TX });
  }
  for (const t of d.openFromYesterday) {
    items.push({ lead: "Not done from yesterday", text: `${t.title}${t.assignee ? ` — ${t.assignee}` : ""}`, tone: AMBER_TX });
  }
  p.font("normal", 9);
  const laid = items.map((it) => ({ ...it, lines: p.wrap(`${it.lead} · ${it.text}`, W - 10) }));
  const boxH = items.length ? 8 + laid.reduce((n, it) => n + it.lines.length * LH + 0.8, 0) + 2 : 10;
  p.need(boxH + 4);
  if (items.length) {
    p.doc.setFillColor(...AMBER_BG); p.doc.setDrawColor(234, 179, 8);
    p.doc.roundedRect(M, p.y, W, boxH, 2, 2, "FD");
    p.font("bold", 9); p.color(AMBER_TX); p.doc.text("Needs attention", M + 4, p.y + 5.5);
    let yy = p.y + 10.5;
    for (const it of laid) {
      p.font("normal", 9); p.color(it.tone);
      it.lines.forEach((ln, i) => {
        if (i === 0) { p.font("bold", 9); const lead = `${it.lead} · `; p.doc.text(lead, M + 4, yy); const lw = p.doc.getTextWidth(lead); p.font("normal", 9); p.doc.text(ln.slice(lead.length), M + 4 + lw, yy); }
        else p.doc.text(ln, M + 4, yy);
        yy += LH;
      });
      yy += 0.8;
    }
  } else {
    p.doc.setFillColor(...GREEN_BG);
    p.doc.roundedRect(M, p.y, W, boxH, 2, 2, "F");
    p.font("bold", 9); p.color(GREEN_TX); p.doc.text("Nothing needs attention", M + 4, p.y + 6.3);
  }
  p.y += boxH + 6;

  // ── per region: tomorrow, then other updates ──
  const regions = d.regions.filter((r) => r.tasks.some((t) => t.title.trim()) || (r.otherUpdates ?? "").trim());
  for (const r of regions) {
    const tasks = r.tasks.filter((t) => t.title.trim());
    if (tasks.length) {
      p.need(14);
      p.font("bold", 10); p.color(INK); p.doc.text(regions.length > 1 || d.regions.length > 1 ? `Tomorrow · ${r.label}` : "Tomorrow", M, p.y);
      p.y += 2.5;
      p.doc.setDrawColor(...RULE); p.doc.line(M, p.y, M + W, p.y); p.y += 4.5;
      for (const t of tasks) {
        p.font("normal", 9);
        const lines = p.wrap(t.title.trim(), W - 8 - 48);
        p.need(lines.length * LH + 1.5);
        p.doc.setDrawColor(...MUTED); p.doc.rect(M, p.y - 3, 3.2, 3.2);
        p.color(INK);
        lines.forEach((ln, i) => p.doc.text(ln, M + 6, p.y + i * LH));
        p.font(t.assignee ? "bold" : "italic", 8.5); p.color(t.assignee ? INK : MUTED);
        p.doc.text(t.assignee ?? "General", M + W, p.y, { align: "right" });
        p.y += lines.length * LH + 1.5;
      }
      p.y += 3;
    }
    const other = (r.otherUpdates ?? "").trim();
    if (other) {
      p.need(14);
      p.font("bold", 10); p.color(INK); p.doc.text(regions.length > 1 ? `Updates · ${r.label}` : "Updates", M, p.y);
      p.y += 2.5;
      p.doc.setDrawColor(...RULE); p.doc.line(M, p.y, M + W, p.y); p.y += 4.5;
      writeRich(p, other, M, W);
      p.y += 3;
    }
  }

  // ── clients: urgent first, then by name, in full ──
  p.need(14);
  p.font("bold", 10); p.color(INK); p.doc.text("Clients", M, p.y);
  p.font("normal", 8.5); p.color(MUTED); p.doc.text(`${written.length} with a note`, M + 16, p.y);
  p.y += 2.5;
  p.doc.setDrawColor(...RULE); p.doc.line(M, p.y, M + W, p.y); p.y += 4.5;
  const NAME_W = 46;
  const ordered = [...written].sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || a.client_name.localeCompare(b.client_name));
  for (const c of ordered) {
    p.font("bold", 9);
    const nameLines = p.wrap(c.client_name, NAME_W - 6);
    p.need(Math.max(nameLines.length, 2) * LH + 3);
    const top = p.y;
    if (c.urgent) { p.doc.setFillColor(...RED); } else { p.doc.setFillColor(...FAINT); }
    p.doc.circle(M + 1.4, top - 1.2, 1.1, "F");
    p.color(INK);
    nameLines.forEach((ln, i) => p.doc.text(ln, M + 5, top + i * LH));
    if (c.urgent) { p.font("bold", 7); p.color(RED); p.doc.text("URGENT", M + 5, top + nameLines.length * LH); }
    p.y = top;
    writeRich(p, (c.details ?? "").trim(), M + NAME_W, W - NAME_W);
    p.y = Math.max(p.y, top + (nameLines.length + (c.urgent ? 1 : 0)) * LH) + 1.5;
    p.doc.setDrawColor(...RULE); p.doc.line(M, p.y - 2.2, M + W, p.y - 2.2);
    p.y += 2;
  }
  if (!ordered.length) { p.font("italic", 9); p.color(MUTED); p.doc.text("No client notes were written for this day.", M, p.y); p.y += 6; }

  // ── no report ──
  if (quiet.length) {
    p.font("normal", 8.5);
    const lines = p.wrap(`No report (${quiet.length}): ${quiet.map((c) => c.client_name).join(", ")}`, W);
    p.need(lines.length * LH + 2);
    p.color(FAINT);
    lines.forEach((ln) => { p.doc.text(ln, M, p.y); p.y += LH; });
    p.y += 2;
  }

  // ── sign-off ──
  p.need(22);
  p.y += 12;
  p.doc.setDrawColor(...MUTED);
  p.doc.line(M, p.y, M + W / 2 - 6, p.y);
  p.doc.line(M + W / 2 + 6, p.y, M + W, p.y);
  p.font("normal", 8); p.color(MUTED);
  p.doc.text("Reported by", M, p.y + 4);
  p.doc.text("Reviewed by", M + W / 2 + 6, p.y + 4);
  p.y += 8;
}

/** Interim attendance section — replaced once the previous house style is in. */
function drawAttendanceSection(p: Pager, s: AttendanceSummary) {
  const COLS = [
    { label: "Client", w: 60, right: false },
    { label: "Deployed", w: 20, right: true },
    { label: "Present", w: 20, right: true },
    { label: "Absent", w: 18, right: true },
    { label: "Leave", w: 18, right: true },
    { label: "Confirmed", w: W - 136, right: false },
  ];
  const head = () => {
    p.doc.setFillColor(241, 245, 249); p.doc.rect(M, p.y, W, 6.5, "F");
    p.font("bold", 7.5); p.color(MUTED);
    let x = M;
    for (const c of COLS) { if (c.right) p.doc.text(c.label, x + c.w - 2, p.y + 4.3, { align: "right" }); else p.doc.text(c.label, x + 2, p.y + 4.3); x += c.w; }
    p.y += 6.5;
  };
  head();
  s.clients.forEach((c) => {
    if (p.need(7)) head();
    if (!c.confirmed) { p.doc.setFillColor(254, 242, 242); p.doc.rect(M, p.y, W, 6.5, "F"); }
    p.font("normal", 8.5); p.color(INK);
    let x = M;
    p.doc.text(p.wrap(c.client_name, COLS[0].w - 4)[0], x + 2, p.y + 4.4); x += COLS[0].w;
    [c.deployed, c.present, c.absent, c.leave].forEach((n, i) => { p.doc.text(String(n), x + COLS[i + 1].w - 2, p.y + 4.4, { align: "right" }); x += COLS[i + 1].w; });
    if (c.confirmed) { p.color(GREEN_TX); p.doc.text(c.confirmed_by ? `Yes · ${c.confirmed_by}` : "Yes", x + 2, p.y + 4.4); }
    else { p.font("bold", 8.5); p.color(RED); p.doc.text(c.partial ? `Partly (${c.sites.filter((t) => t.confirmed).length}/${c.sites.length})` : "Not confirmed", x + 2, p.y + 4.4); }
    p.doc.setDrawColor(...RULE); p.doc.line(M, p.y + 6.5, M + W, p.y + 6.5);
    p.y += 6.5;
  });
  const t = s.totals;
  p.need(8);
  p.font("bold", 8.5); p.color(INK);
  let x = M; p.doc.text("All clients", x + 2, p.y + 4.6); x += COLS[0].w;
  [t.deployed, t.present, t.absent, t.leave].forEach((n, i) => { p.doc.text(String(n), x + COLS[i + 1].w - 2, p.y + 4.6, { align: "right" }); x += COLS[i + 1].w; });
  p.doc.text(`${s.clients.length - s.unconfirmed.length}/${s.clients.length}`, x + 2, p.y + 4.6);
  p.y += 9;
}

/**
 * One PDF, the daily report, the attendance report, or both (each starting on
 * its own page). File name says which.
 */
export function generateOperationsPdf(
  company: Company | null | undefined,
  parts: { daily?: DailyBrief; attendance?: { summary: AttendanceSummary; regionLabel: string | null } },
) {
  const b = brandingFromCompany(company);
  hexToRgb(b.brandColor);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let first = true;
  if (parts.daily) {
    const d = parts.daily;
    const p = new Pager(doc, b, "Daily operations report", `${longDay(d.reportDate)}${d.regionLabel ? `  ·  ${d.regionLabel}` : "  ·  all regions"}`);
    p.start(); first = false;
    drawDaily(p, d);
  }
  if (parts.attendance) {
    const a = parts.attendance;
    const p = new Pager(doc, b, "Attendance report", `${longDay(a.summary.date)}${a.regionLabel ? `  ·  ${a.regionLabel}` : "  ·  all regions"}`);
    if (first) p.start(); else p.fresh();
    drawAttendanceSection(p, a.summary);
  }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); drawBrandedFooter(doc, b, `page ${i} of ${pages}`); }
  const day = parts.daily?.reportDate ?? parts.attendance?.summary.date ?? "";
  const kind = parts.daily && parts.attendance ? "Daily and attendance report" : parts.daily ? "Daily operations report" : "Attendance report";
  void savePdf(doc, `${kind} ${day}.pdf`);
}
