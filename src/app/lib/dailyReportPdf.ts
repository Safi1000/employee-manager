import jsPDF from "jspdf";
import { savePdf } from "./saveFile";
import { formatDate } from "./date";
import type { Company } from "./supabase";
import { describeUnconfirmed, type AttendanceSummary } from "./attendanceSummary";
import { brandingFromCompany, drawBrandedHeader, drawBrandedFooter, hexToRgb } from "./pdfBranding";

// Daily Operations Report: one line per client for a given day, carrying whatever
// was written in that client's Details box. The per-post version (required vs
// present strength, silent-post alerting, exception notes) was dropped — the
// report is now a client-by-client written note, not a headcount reconciliation.
// Uses the shared branded jsPDF engine — no new library.
//
// Three things the page supplies and this file prints:
//   * the day's Next Day Tasks (each general or assigned), at the head, because
//     they are read before the detail;
//   * the clients WITH a note first and the "No report" ones underneath, so the
//     reader reaches the substance without scrolling past the silence;
//   * an attendance summary for the PREVIOUS day, since the day being reported
//     on has not been confirmed yet when the report goes out. Clients whose
//     previous day was never confirmed are flagged by name — an unflagged
//     client reads as confirmed, and that is the failure worth printing.

const MARGIN = 14;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;
const CLIENT_W = 58;
const DETAILS_W = CONTENT_W - CLIENT_W;
const LINE_H = 4.2;
const PAD_Y = 1.6;
const FOOTER_LIMIT = PAGE_H - 20;

export type DailyReportRow = {
  client_name: string;
  details: string | null;
  /** Explicitly marked "nothing to report" — sorted to the bottom, labelled. */
  no_report?: boolean;
};

export type DailyReportPdfOptions = {
  /** Region the page was filtered to when the PDF was produced, or null for all. */
  regionLabel?: string | null;
  /** The day's Next Day Tasks; `assignee` null = a general task. */
  nextDayTasks?: { title: string; assignee: string | null }[];
  /** Previous day's attendance, already filtered to the same region. */
  attendance?: AttendanceSummary | null;
};

const hasNote = (r: DailyReportRow) => !r.no_report && (r.details ?? "").trim().length > 0;

export function generateDailyOperationsReportPdf(
  company: Company | null | undefined,
  reportDate: string,
  rows: DailyReportRow[],
  options: DailyReportPdfOptions = {},
) {
  const b = brandingFromCompany(company);
  const [r, g, bl] = hexToRgb(b.brandColor);
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  let y = drawBrandedHeader(doc, b, "Daily Operations Report", `For ${formatDate(reportDate)}`);
  y += 2;

  /** Page break helper: every section below grows by an unknown number of lines. */
  const ensure = (needed: number) => {
    if (y + needed <= FOOTER_LIMIT) return false;
    doc.addPage();
    y = MARGIN;
    return true;
  };

  const withDetails = rows.filter(hasNote).length;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  const scope = options.regionLabel ? `${options.regionLabel}   ·   ` : "";
  doc.text(
    `${scope}${rows.length} clients   ·   ${withDetails} with details recorded   ·   ${rows.length - withDetails} no report`,
    MARGIN,
    y,
  );
  y += 7;

  // ── Next Day Task ─────────────────────────────────────────────────────────
  const tasks = (options.nextDayTasks ?? []).filter((t) => t.title.trim());
  if (tasks.length > 0) {
    // Each task on its own line(s), numbered, with who it is for. Wrapped per
    // task so a long one indents under its own number instead of the margin.
    const ASSIGNEE_W = 48;
    const TITLE_W = CONTENT_W - 6 - 8 - ASSIGNEE_W;
    doc.setFontSize(9);
    const laid = tasks.map((t) => ({
      lines: doc.splitTextToSize(t.title.trim(), TITLE_W) as string[],
      who: t.assignee ?? "General",
      general: !t.assignee,
    }));
    const bodyH = laid.reduce((h, t) => h + t.lines.length * LINE_H + 1, 0);
    const boxH = bodyH + 10;
    ensure(Math.min(boxH, 60) + 4);
    doc.setFillColor(254, 249, 231);
    doc.setDrawColor(r, g, bl);
    doc.rect(MARGIN, y, CONTENT_W, boxH, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(r, g, bl);
    doc.text(`NEXT DAY TASKS (${tasks.length})`, MARGIN + 3, y + 5);
    doc.text("ASSIGNED TO", MARGIN + CONTENT_W - 3 - ASSIGNEE_W, y + 5);
    let ty = y + 9.5;
    laid.forEach((t, i) => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(15, 23, 42);
      doc.text(`${i + 1}.`, MARGIN + 3, ty);
      t.lines.forEach((ln, li) => doc.text(ln, MARGIN + 3 + 8, ty + li * LINE_H));
      doc.setFont("helvetica", t.general ? "italic" : "bold");
      if (t.general) doc.setTextColor(100, 116, 139);
      doc.text(
        doc.splitTextToSize(t.who, ASSIGNEE_W)[0] as string,
        MARGIN + CONTENT_W - 3 - ASSIGNEE_W,
        ty,
      );
      ty += t.lines.length * LINE_H + 1;
    });
    doc.setFont("helvetica", "normal");
    y += boxH + 6;
  }

  // ── Client notes ──────────────────────────────────────────────────────────
  // Written notes first, "No report" underneath. Within each group the page's
  // own order (client name) is preserved — a stable sort, so the report reads
  // the same way twice.
  const ordered = [...rows].sort((a, c) => Number(hasNote(c)) - Number(hasNote(a)));

  const drawHead = () => {
    doc.setFillColor(r, g, bl);
    doc.rect(MARGIN, y, CONTENT_W, 6, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.text("Client", MARGIN + 2, y + 4);
    doc.text("Details", MARGIN + CLIENT_W + 2, y + 4);
    y += 6;
  };
  drawHead();

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  ordered.forEach((row, i) => {
    // Details is free text of any length, so the row grows to fit it rather than
    // clipping to one line — the note IS the report, and a truncated note is a
    // lost one. Client names wrap for the same reason.
    const written = hasNote(row);
    const detailText = written
      ? (row.details ?? "").trim()
      : row.no_report
        ? "No report"
        : "—";
    const detailLines = doc.splitTextToSize(detailText, DETAILS_W - 4) as string[];
    const nameLines = doc.splitTextToSize(row.client_name, CLIENT_W - 4) as string[];
    const rowH = Math.max(detailLines.length, nameLines.length) * LINE_H + PAD_Y * 2;

    // A row taller than the page would loop forever if we tried to keep it whole,
    // so only break when there is a page left to break onto.
    if (y + rowH > FOOTER_LIMIT && y > MARGIN + 10) {
      doc.addPage();
      y = MARGIN;
      drawHead();
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
    }

    if (i % 2 === 1) {
      doc.setFillColor(248, 250, 252);
      doc.rect(MARGIN, y, CONTENT_W, rowH, "F");
    }
    doc.setTextColor(15, 23, 42);
    doc.setFont("helvetica", "bold");
    nameLines.forEach((ln, li) => doc.text(ln, MARGIN + 2, y + PAD_Y + 3 + li * LINE_H));
    doc.setFont("helvetica", "normal");
    if (written) doc.setTextColor(15, 23, 42);
    else doc.setTextColor(148, 163, 184);
    detailLines.forEach((ln, li) =>
      doc.text(ln, MARGIN + CLIENT_W + 2, y + PAD_Y + 3 + li * LINE_H),
    );
    y += rowH;
  });

  if (rows.length === 0) {
    doc.setTextColor(100, 116, 139);
    doc.text("No active clients for this date.", MARGIN, y + 4);
    y += 8;
  }

  // ── Attendance summary (previous day) ─────────────────────────────────────
  if (options.attendance) drawAttendance(doc, options.attendance, [r, g, bl], ensure, () => y, (v) => { y = v; });

  drawBrandedFooter(doc, b, "Daily Operations Report");
  void savePdf(doc, `daily-operations-report-${reportDate}.pdf`);
}

/**
 * The attendance block. Columns are fixed-width so the numbers line up; the
 * confirmation column carries the word rather than a tick, because "not
 * confirmed" has to survive being printed in black and white.
 */
function drawAttendance(
  doc: jsPDF,
  summary: AttendanceSummary,
  brand: [number, number, number],
  ensure: (n: number) => boolean,
  getY: () => number,
  setY: (v: number) => void,
) {
  const [r, g, bl] = brand;
  const COLS = [
    { label: "Client", w: 54, align: "left" as const },
    { label: "Deployed", w: 18, align: "right" as const },
    { label: "Present", w: 18, align: "right" as const },
    { label: "Absent", w: 16, align: "right" as const },
    { label: "Leave", w: 15, align: "right" as const },
    { label: "Other", w: 15, align: "right" as const },
    { label: "Attendance", w: CONTENT_W - 54 - 18 - 18 - 16 - 15 - 15, align: "left" as const },
  ];

  let y = getY() + 8;
  setY(y);
  ensure(30);
  y = getY();

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text("Attendance Summary", MARGIN, y);
  y += 4.5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text(
    `For ${formatDate(summary.date)} (the day before this report) · ${summary.clients.length} clients · ` +
      `${summary.unconfirmed.length} not confirmed`,
    MARGIN,
    y,
  );
  y += 5;

  const head = () => {
    doc.setFillColor(r, g, bl);
    doc.rect(MARGIN, y, CONTENT_W, 6, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(255, 255, 255);
    let x = MARGIN;
    for (const c of COLS) {
      if (c.align === "right") doc.text(c.label, x + c.w - 2, y + 4, { align: "right" });
      else doc.text(c.label, x + 2, y + 4);
      x += c.w;
    }
    y += 6;
  };
  head();

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  summary.clients.forEach((c, i) => {
    const nameLines = doc.splitTextToSize(c.client_name, COLS[0].w - 4) as string[];
    // A partly confirmed client lists its sites under the status, one per line,
    // each saying whether it was confirmed — the open ones are the instruction.
    const attW = COLS[COLS.length - 1].w - 4;
    const siteLines: { text: string; ok: boolean }[] = c.partial
      ? c.sites.flatMap((site) =>
          (doc.splitTextToSize(
            // Plain ASCII: jsPDF's built-in Helvetica has no tick or cross glyph.
            `${site.site_name}: ${site.confirmed ? "confirmed" : "NOT confirmed"}`,
            attW,
          ) as string[]).map((text) => ({ text, ok: site.confirmed })),
        )
      : [];
    const rowH = Math.max(nameLines.length, 1 + siteLines.length) * LINE_H + PAD_Y * 2;
    if (y + rowH > FOOTER_LIMIT) {
      doc.addPage();
      y = MARGIN;
      head();
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
    }
    if (i % 2 === 1) {
      doc.setFillColor(248, 250, 252);
      doc.rect(MARGIN, y, CONTENT_W, rowH, "F");
    }
    // An unconfirmed client is tinted across its whole row: the flag has to be
    // visible from the shape of the page, not only from the last column.
    if (!c.confirmed) {
      doc.setFillColor(254, 242, 242);
      doc.rect(MARGIN, y, CONTENT_W, rowH, "F");
    }
    const baseline = y + PAD_Y + 3;
    let x = MARGIN;
    doc.setTextColor(15, 23, 42);
    nameLines.forEach((ln, li) => doc.text(ln, x + 2, baseline + li * LINE_H));
    x += COLS[0].w;
    const nums = [c.deployed, c.present, c.absent, c.leave, c.other];
    nums.forEach((n, ni) => {
      doc.text(String(n), x + COLS[ni + 1].w - 2, baseline, { align: "right" });
      x += COLS[ni + 1].w;
    });
    if (c.confirmed) {
      doc.setTextColor(22, 101, 52);
      doc.text(c.confirmed_by ? `Confirmed · ${c.confirmed_by}` : "Confirmed", x + 2, baseline);
    } else if (c.partial) {
      doc.setTextColor(180, 83, 9);
      doc.setFont("helvetica", "bold");
      doc.text(
        `PARTLY CONFIRMED ${c.sites.filter((s) => s.confirmed).length}/${c.sites.length}`,
        x + 2,
        baseline,
      );
      doc.setFont("helvetica", "normal");
      siteLines.forEach((ln, li) => {
        if (ln.ok) doc.setTextColor(22, 101, 52);
        else doc.setTextColor(185, 28, 28);
        doc.text(ln.text, x + 2, baseline + (li + 1) * LINE_H);
      });
    } else {
      doc.setTextColor(185, 28, 28);
      doc.setFont("helvetica", "bold");
      doc.text("NOT CONFIRMED", x + 2, baseline);
      doc.setFont("helvetica", "normal");
    }
    y += rowH;
  });

  // Collective total. Folded from the rows above it rather than fetched: a total
  // that can disagree with the table it sits under is worse than no total.
  const t = summary.totals;
  if (y + 8 > FOOTER_LIMIT) { doc.addPage(); y = MARGIN; }
  doc.setFillColor(241, 245, 249);
  doc.rect(MARGIN, y, CONTENT_W, 7, "F");
  doc.setFont("helvetica", "bold");
  doc.setTextColor(15, 23, 42);
  let x = MARGIN;
  doc.text("All clients", x + 2, y + 4.8);
  x += COLS[0].w;
  [t.deployed, t.present, t.absent, t.leave, t.other].forEach((n, ni) => {
    doc.text(String(n), x + COLS[ni + 1].w - 2, y + 4.8, { align: "right" });
    x += COLS[ni + 1].w;
  });
  const partialCount = summary.unconfirmed.filter((c) => c.partial).length;
  doc.text(
    `${summary.clients.length - summary.unconfirmed.length}/${summary.clients.length} confirmed` +
      (partialCount > 0 ? ` · ${partialCount} partly` : ""),
    x + 2,
    y + 4.8,
  );
  y += 7;

  if (summary.clients.length === 0) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 116, 139);
    doc.text("No guards deployed on that date.", MARGIN, y + 5);
    y += 8;
  }

  // The flag list, spelled out — a reader who skims the table still has to be
  // told, by name, whose attendance nobody confirmed.
  if (summary.unconfirmed.length > 0) {
    // Wholly unconfirmed clients share one comma list; each partly confirmed
    // client gets its own line naming the sites still open.
    const whole = summary.unconfirmed.filter((c) => !c.partial).map((c) => c.client_name).join(", ");
    const lines = [
      ...(whole ? (doc.splitTextToSize(whole, CONTENT_W - 6) as string[]) : []),
      ...summary.unconfirmed
        .filter((c) => c.partial)
        .flatMap((c) => doc.splitTextToSize(describeUnconfirmed(c), CONTENT_W - 6) as string[]),
    ];
    const boxH = lines.length * LINE_H + 10;
    if (y + boxH + 6 > FOOTER_LIMIT) { doc.addPage(); y = MARGIN; }
    y += 5;
    doc.setFillColor(254, 242, 242);
    doc.setDrawColor(220, 38, 38);
    doc.rect(MARGIN, y, CONTENT_W, boxH, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(185, 28, 28);
    doc.text(
      `ATTENDANCE NOT CONFIRMED — ${summary.unconfirmed.length} client${summary.unconfirmed.length === 1 ? "" : "s"} on ${formatDate(summary.date)}`,
      MARGIN + 3,
      y + 5,
    );
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(127, 29, 29);
    lines.forEach((ln, i) => doc.text(ln, MARGIN + 3, y + 9.5 + i * LINE_H));
    y += boxH;
  }

  setY(y);
}
