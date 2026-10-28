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
  /** Tasks set for the report day still pending. */
  openFromYesterday: BriefTask[];
  /** 0569: every task set the previous day, with its progress. */
  previousTasks?: { title: string; assignee: string | null; status: string; note: string | null }[];
  previousDate?: string;
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
  for (const t of d.openFromYesterday) items.push(`Still pending from yesterday — ${t.title}${t.assignee ? ` (${t.assignee})` : ""}.`);
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

  // ── 2. Previous day's tasks — progress (0569) ──
  const prev = d.previousTasks ?? [];
  if (prev.length) {
    sec += 1;
    heading(p, `${sec}.  Previous day's tasks${d.previousDate ? ` (${formatDate(d.previousDate)})` : ""}`);
    const C1 = 12, C3 = 40, C4 = 28, C2 = W - C1 - C3 - C4;
    const head = () => {
      p.need(8);
      doc.setDrawColor(...RULE); doc.line(M, p.y - 4.2, M + W, p.y - 4.2);
      p.font("bold", 10); p.color(INK);
      doc.text("S/No", M + 1, p.y); doc.text("Task", M + C1 + 2, p.y); doc.text("Responsible", M + C1 + C2 + 2, p.y); doc.text("Status", M + C1 + C2 + C3 + 2, p.y);
      p.y += 2; doc.line(M, p.y, M + W, p.y); p.y += 4.6;
    };
    head();
    prev.forEach((t, i) => {
      p.font("normal", 10.5);
      const lines = p.wrap(t.title.trim(), C2 - 4);
      const noteLines = t.note ? p.wrap(t.note, C2 - 4) : [];
      if (p.need((lines.length + noteLines.length) * LH + 2)) head();
      p.color(INK);
      doc.text(`${i + 1}.`, M + 1, p.y);
      lines.forEach((ln, k) => doc.text(ln, M + C1 + 2, p.y + k * LH));
      p.font(t.assignee ? "normal" : "italic", 10.5); p.color(t.assignee ? INK : SOFT);
      doc.text(t.assignee ?? "General", M + C1 + C2 + 2, p.y);
      const tone: RGB = t.status === "Completed" ? [30, 100, 50] : t.status === "In progress" ? [140, 90, 10] : t.status === "Pending" ? RED : SOFT;
      p.font("bold", 10.5); p.color(tone);
      doc.text(t.status, M + C1 + C2 + C3 + 2, p.y);
      let yy = p.y + lines.length * LH;
      if (noteLines.length) { p.font("italic", 10); p.color(SOFT); noteLines.forEach((ln) => { doc.text(ln, M + C1 + 2, yy); yy += LH; }); }
      p.y = yy + 1.6;
    });
    doc.setDrawColor(...RULE); doc.line(M, p.y - 3, M + W, p.y - 3);
    p.y += 4;
  }

  // ── 3. Tasks for tomorrow ──
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

  signOff(p);
}

/** Prepared / Reviewed / Approved by. */
function signOff(p: Page) {
  const doc = p.doc;
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

/**
 * ATTENDANCE REPORT — same letter style (2026-10-28).
 *   opening line   strength, present %, absent, leave, unmarked, confirmed
 *   1. Client-wise attendance   ruled table, grouped by region with subtotals
 *   2. Absentees and leave      by client, by name
 *   3. Attendance not confirmed numbered, naming the open sites
 * "Unmarked" = deployed guards with no mark at all — counted as present by the
 * figures, so shown so nobody mistakes a blank register for a full one.
 */
function drawAttendanceSection(p: Page, s: AttendanceSummary, regionNames: Record<string, string>) {
  const doc = p.doc;
  const t = s.totals;
  const unmarked = (c: AttendanceSummary["clients"][number]) => Math.max(0, c.deployed - c.marked);
  const totalUnmarked = s.clients.reduce((n, c) => n + unmarked(c), 0);
  const pct = t.deployed ? Math.round(((t.present - totalUnmarked) / t.deployed) * 1000) / 10 : 0;

  p.font("normal", 10.5); p.color(INK);
  const opening = `On ${longDay(s.date)}, ${t.deployed} guards were deployed across ${s.clients.length} clients: ` +
    `${t.present - totalUnmarked} present (${pct}%), ${t.absent} absent, ${t.leave} on leave` +
    `${t.other ? `, ${t.other} other` : ""}${totalUnmarked ? `, ${totalUnmarked} not marked` : ""}. ` +
    `Attendance was confirmed for ${s.clients.length - s.unconfirmed.length} of ${s.clients.length} clients.`;
  p.wrap(opening, W).forEach((ln) => { p.need(LH); doc.text(ln, M, p.y); p.y += LH; });
  p.y += 4;

  // ── 1. client-wise ──
  heading(p, "1.  Client-wise attendance");
  const COLS = [
    { label: "S/No", w: 11, right: false },
    { label: "Client", w: 55, right: false },
    { label: "Deployed", w: 17, right: true },
    { label: "Present", w: 16, right: true },
    { label: "Absent", w: 15, right: true },
    { label: "Leave", w: 13, right: true },
    { label: "Unmarked", w: 18, right: true },
    { label: "Confirmed by", w: W - 145, right: false },
  ];
  const head = () => {
    p.need(8);
    doc.setDrawColor(...RULE); doc.line(M, p.y - 4.2, M + W, p.y - 4.2);
    p.font("bold", 9.5); p.color(INK);
    let x = M;
    for (const c of COLS) { if (c.right) doc.text(c.label, x + c.w - 1, p.y, { align: "right" }); else doc.text(c.label, x + 1, p.y); x += c.w; }
    p.y += 2; doc.line(M, p.y, M + W, p.y); p.y += 4.6;
  };
  const nums = (dep: number, pre: number, ab: number, lv: number, un: number, x0: number) => {
    let x = x0;
    [dep, pre, ab, lv, un].forEach((n, k) => {
      if (k === 4 && n) p.color(RED);
      doc.text(String(n), x + COLS[k + 2].w - 1, p.y, { align: "right" });
      p.color(INK);
      x += COLS[k + 2].w;
    });
    return x;
  };
  head();
  const groups = new Map<string, AttendanceSummary["clients"]>();
  for (const c of [...s.clients].sort((a, b) => a.client_name.localeCompare(b.client_name))) {
    const k = c.branch_id ?? "";
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const showGroups = groups.size > 1;
  let n = 0;
  for (const [bid, rows] of groups) {
    if (showGroups) {
      if (p.need(LH + 2)) head();
      p.font("bolditalic", 10); p.color(SOFT); doc.text(regionNames[bid] ?? "No region", M + 1, p.y); p.y += LH + 0.4;
    }
    for (const c of rows) {
      if (p.need(LH + 1)) head();
      n += 1;
      p.font("normal", 10); p.color(INK);
      let x = M;
      doc.text(`${n}.`, x + 1, p.y); x += COLS[0].w;
      doc.text(p.wrap(c.client_name, COLS[1].w - 2)[0], x + 1, p.y); x += COLS[1].w;
      x = nums(c.deployed, c.present - unmarked(c), c.absent, c.leave, unmarked(c), x);
      if (c.confirmed) { p.color(INK); doc.text(p.wrap(c.confirmed_by ?? "Yes", COLS[7].w - 2)[0], x + 1, p.y); }
      else { p.font("bold", 10); p.color(RED); doc.text(c.partial ? `Partly (${c.sites.filter((q) => q.confirmed).length}/${c.sites.length})` : "Not confirmed", x + 1, p.y); }
      p.y += LH + 0.5;
    }
    if (showGroups) {
      if (p.need(LH + 2)) head();
      const sub = rows.reduce((a, c) => ({ d: a.d + c.deployed, p: a.p + c.present - unmarked(c), ab: a.ab + c.absent, l: a.l + c.leave, u: a.u + unmarked(c) }), { d: 0, p: 0, ab: 0, l: 0, u: 0 });
      doc.setDrawColor(...RULE); doc.setLineWidth(0.1); doc.line(M + COLS[0].w, p.y - 3.6, M + W, p.y - 3.6); doc.setLineWidth(0.2);
      p.font("italic", 10); p.color(SOFT);
      doc.text(`Subtotal · ${regionNames[bid] ?? "No region"}`, M + COLS[0].w + 1, p.y);
      p.font("italic", 10);
      nums(sub.d, sub.p, sub.ab, sub.l, sub.u, M + COLS[0].w + COLS[1].w);
      p.y += LH + 2;
    }
  }
  p.need(10);
  doc.setDrawColor(...RULE); doc.line(M, p.y - 3.6, M + W, p.y - 3.6);
  p.font("bold", 10); p.color(INK);
  doc.text("Total", M + COLS[0].w + 1, p.y);
  const xe = nums(t.deployed, t.present - totalUnmarked, t.absent, t.leave, totalUnmarked, M + COLS[0].w + COLS[1].w);
  doc.text(`${s.clients.length - s.unconfirmed.length} of ${s.clients.length}`, xe + 1, p.y);
  p.y += 2; doc.line(M, p.y, M + W, p.y); doc.line(M, p.y + 0.8, M + W, p.y + 0.8);
  p.y += 9;

  // ── 2. absentees and leave ──
  const withNames = [...s.clients].filter((c) => (c.absentees ?? []).length || (c.onLeave ?? []).length)
    .sort((a, b) => a.client_name.localeCompare(b.client_name));
  heading(p, "2.  Absentees and leave");
  if (!withNames.length) { p.font("italic", 10.5); p.color(SOFT); doc.text("Nil.", M + 4, p.y); p.y += LH + 3; }
  const who = (l: { name: string; code: string | null }[]) => l.map((g) => (g.code ? `${g.name} (${g.code})` : g.name)).join(", ");
  withNames.forEach((c, i) => {
    p.need(LH * 3);
    p.font("bold", 10.5); p.color(INK);
    doc.text(`2.${i + 1}`, M + 4, p.y); doc.text(c.client_name, M + 14, p.y); p.y += LH;
    for (const [label, list] of [["Absent", c.absentees ?? []], ["Leave", c.onLeave ?? []]] as const) {
      if (!list.length) continue;
      p.font("normal", 10.5);
      const lines = p.wrap(who(list), W - 14 - 22);
      lines.forEach((ln, j) => {
        p.need(LH);
        if (j === 0) { p.font("italic", 10.5); p.color(SOFT); doc.text(`${label}:`, M + 14, p.y); p.font("normal", 10.5); p.color(INK); }
        doc.text(ln, M + 36, p.y);
        p.y += LH;
      });
    }
    p.y += 1.8;
  });
  p.y += 2;

  // ── 3. not confirmed ──
  heading(p, "3.  Attendance not confirmed");
  if (!s.unconfirmed.length) { p.font("italic", 10.5); p.color(SOFT); doc.text("Nil — every client's attendance was confirmed.", M + 4, p.y); p.y += LH + 3; }
  s.unconfirmed.forEach((c, i) => {
    p.font("normal", 10.5); p.color(INK);
    const lines = p.wrap(describeUnconfirmed(c), W - 14);
    p.need(lines.length * LH + 1);
    lines.forEach((ln, j) => { if (j === 0) doc.text(`${i + 1}.`, M + 4, p.y); doc.text(ln, M + 14, p.y); p.y += LH; });
    p.y += 0.8;
  });

  signOff(p);
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

type Part = { daily?: DailyBrief; attendance?: { summary: AttendanceSummary; regionLabel: string | null; regionNames?: Record<string, string> } };

/**
 * One PDF of one or more parts — a part is one region's daily report and/or
 * attendance report, each under its own letterhead on a new page. Under "All
 * regions" the caller passes one part per region, so a region is printed whole
 * before the next begins. The file name says which reports it holds.
 */
export function generateOperationsPdf(company: Company | null | undefined, parts: Part[], fileRegion: string | null = null) {
  const b = brandingFromCompany(company);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const p = new Page(doc, b);
  let first = true;
  const day = parts.map((pt) => pt.daily?.reportDate ?? pt.attendance?.summary.date).find(Boolean) ?? "";
  for (const pt of parts) {
    if (pt.daily) {
      if (!first) doc.addPage();
      letterhead(p, "Daily Operations Report", pt.daily.reportDate, pt.daily.regionLabel, refOf("DOR", pt.daily.reportDate));
      first = false;
      drawDaily(p, pt.daily);
    }
    if (pt.attendance) {
      const a = pt.attendance;
      if (!first) doc.addPage();
      letterhead(p, "Attendance Report", a.summary.date, a.regionLabel, refOf("ATR", a.summary.date));
      first = false;
      drawAttendanceSection(p, a.summary, a.regionNames ?? {});
    }
  }
  const anyDaily = parts.some((pt) => pt.daily), anyAtt = parts.some((pt) => pt.attendance);
  footer(doc, b, anyDaily ? refOf("DOR", day) : refOf("ATR", day));
  const kind = anyDaily && anyAtt ? "Daily and attendance report" : anyDaily ? "Daily operations report" : "Attendance report";
  void savePdf(doc, `${kind}${fileRegion ? ` ${fileRegion}` : ""} ${day}.pdf`);
}
