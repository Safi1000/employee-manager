/**
 * THE EXCEL STANDARD (6 Nov 2026). Every workbook Bastion produces is built
 * here, so they all look like one company's documents:
 *
 *   row 1  the company's legal name (from the company, never hard-coded)
 *   row 2  what the sheet is
 *   row 3  the period / client / scope
 *   row 4  a note, when the sheet needs one to be read correctly
 *   row 5  the column headings — brand colour, bold, frozen, filterable
 *   rows   the data — Rs with thousands separators, dates as real dates
 *   last   a totals row whose figures are LIVE FORMULAS over the column above,
 *          so the total cannot disagree with the rows it sums
 *
 * Printing: A4 landscape, one page wide, headings repeated on every page, and
 * the "Exported by" stamp with page numbers in the footer.
 *
 * ExcelJS (~1 MB) is loaded the first time a workbook is built, not with the
 * page. The free SheetJS build this replaces cannot write any styling at all.
 */
import type ExcelJSNS from "exceljs";
import type { Company } from "./supabase";
import { brandingFromCompany } from "./pdfBranding";
import { saveBlob, mimeFor } from "./saveFile";
import { exportStamp, exporterName } from "./exportStamp";

let ExcelJS: typeof ExcelJSNS | null = null;
async function load(): Promise<typeof ExcelJSNS> {
  if (!ExcelJS) {
    const m = (await import("exceljs")) as unknown as { default?: typeof ExcelJSNS } & typeof ExcelJSNS;
    ExcelJS = m.default ?? m;
  }
  return ExcelJS;
}

export type XKind = "text" | "int" | "money" | "date" | "center";
export type XCol = {
  header: string;
  key: string;
  width?: number;
  kind?: XKind;
  /** Sum this column in the totals row (a live SUM formula). */
  total?: boolean;
};
export type XValue = string | number | Date | null | undefined | { formula: string; result?: number };
export type XSheet = {
  /** Tab name; made Excel-safe and unique automatically. */
  name: string;
  title: string;
  subtitle?: string;
  /** Shown in amber under the subtitle — for anything the reader must know to read the sheet. */
  note?: string;
  columns: XCol[];
  rows: Record<string, XValue>[];
  /** Text for the totals row, placed in `totalLabelKey` (default: the first text column). Omit to have no totals row. */
  totalLabel?: string;
  totalLabelKey?: string;
  /** Columns to keep frozen on the left when scrolling sideways (e.g. code + name). */
  freezeColumns?: number;
};

const HEAD_ROW = 5;
const MONEY = '#,##0;[Red]-#,##0';
const INT = '#,##0';
const DATE = 'dd mmm yyyy';
const INK = "FF0F172A", SOFT = "FF64748B", RULE = "FFE2E8F0", BAND = "FFF8FAFC", TOTAL_FILL = "FFF1F5F9", NOTE = "FFB45309";

const argb = (hex: string) => "FF" + hex.replace("#", "").toUpperCase().padStart(6, "0");
const colLetter = (n: number) => { let s = ""; for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

function sheetNamer() {
  const used = new Set<string>();
  return (name: string) => {
    const base = (name.replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "Sheet").trim();
    let n = base, i = 2;
    while (used.has(n.toLowerCase())) n = `${base.slice(0, 27)} (${i++})`;
    used.add(n.toLowerCase());
    return n;
  };
}

/** ISO date string → a real Excel date (local midnight), anything else untouched. */
export function xDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return y && m && d ? new Date(Date.UTC(y, m - 1, d)) : null;
}

function addSheet(wb: ExcelJSNS.Workbook, s: XSheet, legalName: string, brand: string, nameOf: (n: string) => string) {
  const ws = wb.addWorksheet(nameOf(s.name), {
    views: [{ state: "frozen", ySplit: HEAD_ROW, xSplit: s.freezeColumns ?? 0, showGridLines: false }],
    pageSetup: {
      paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.3 },
      printTitlesRow: `${HEAD_ROW}:${HEAD_ROW}`,
    },
    headerFooter: { oddFooter: `&L&7${exportStamp().replace(/&/g, "&&")}&R&7Page &P of &N` },
  });
  const n = s.columns.length;
  ws.columns = s.columns.map((c) => ({ key: c.key, width: c.width ?? Math.max(10, Math.min(40, c.header.length + 4)) }));

  const banner = (row: number, text: string, font: Partial<ExcelJSNS.Font>, height?: number) => {
    ws.mergeCells(row, 1, row, n);
    const cell = ws.getCell(row, 1);
    cell.value = text;
    cell.font = { name: "Calibri", ...font };
    cell.alignment = { vertical: "middle" };
    if (height) ws.getRow(row).height = height;
  };
  banner(1, legalName, { size: 14, bold: true, color: { argb: brand } }, 22);
  banner(2, s.title, { size: 12, bold: true, color: { argb: INK } }, 18);
  banner(3, s.subtitle ?? "", { size: 10, color: { argb: SOFT } });
  banner(4, s.note ?? "", { size: 10, italic: true, color: { argb: NOTE } });

  const head = ws.getRow(HEAD_ROW);
  s.columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: brand } };
    cell.alignment = { vertical: "middle", wrapText: true, horizontal: c.kind === "money" || c.kind === "int" ? "right" : c.kind === "center" ? "center" : "left" };
    cell.border = { bottom: { style: "thin", color: { argb: brand } } };
  });
  head.height = 30;

  const first = HEAD_ROW + 1;
  s.rows.forEach((r, ri) => {
    const row = ws.getRow(first + ri);
    s.columns.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      const v = r[c.key];
      cell.value = v === undefined || v === "" ? null : (v as ExcelJSNS.CellValue);
      cell.font = { name: "Calibri", size: 10, color: { argb: INK } };
      cell.border = { bottom: { style: "hair", color: { argb: RULE } } };
      if (ri % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
      if (c.kind === "money") { cell.numFmt = MONEY; cell.alignment = { horizontal: "right" }; }
      else if (c.kind === "int") { cell.numFmt = INT; cell.alignment = { horizontal: "right" }; }
      else if (c.kind === "date") { cell.numFmt = DATE; cell.alignment = { horizontal: "left" }; }
      else if (c.kind === "center") cell.alignment = { horizontal: "center" };
    });
  });
  const last = first + s.rows.length - 1;

  if (s.rows.length) ws.autoFilter = { from: { row: HEAD_ROW, column: 1 }, to: { row: HEAD_ROW, column: n } };

  if (s.totalLabel !== undefined && s.rows.length) {
    const row = ws.getRow(last + 1);
    const labelKey = s.totalLabelKey ?? s.columns.find((c) => !c.kind || c.kind === "text")?.key;
    s.columns.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: INK } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_FILL } };
      cell.border = { top: { style: "thin", color: { argb: INK } }, bottom: { style: "double", color: { argb: INK } } };
      if (c.key === labelKey) cell.value = s.totalLabel!;
      if (c.total) {
        const L = colLetter(ci + 1);
        // The cached result is what a viewer that does not recalculate shows; Excel recomputes it on open.
        const result = s.rows.reduce((t, r) => {
          const v = r[c.key];
          return t + (typeof v === "number" ? v : v && typeof v === "object" && "result" in v ? Number((v as { result?: number }).result ?? 0) : 0);
        }, 0);
        cell.value = { formula: `SUM(${L}${first}:${L}${last})`, result };
        cell.numFmt = c.kind === "int" ? INT : MONEY;
        cell.alignment = { horizontal: "right" };
      }
    });
    row.height = 18;
  }
}

/** Build and download one workbook in the Bastion standard. */
export async function saveWorkbook(o: { company: Company | null | undefined; fileName: string; sheets: XSheet[]; emptyMessage?: string }) {
  const X = await load();
  const b = brandingFromCompany(o.company);
  const brand = argb(b.brandColor);
  const wb = new X.Workbook();
  wb.creator = exporterName();
  wb.company = b.legalName;
  wb.created = new Date();
  const nameOf = sheetNamer();
  const sheets = o.sheets.length ? o.sheets : [{
    // A workbook with no sheets is a corrupt file, not an empty one.
    name: "Export", title: o.fileName.replace(/\.xlsx$/i, ""), note: o.emptyMessage ?? "Nothing to export.",
    columns: [{ header: "", key: "x", width: 60 }], rows: [],
  }];
  for (const s of sheets) addSheet(wb, s, b.legalName, brand, nameOf);
  const bytes = await wb.xlsx.writeBuffer();
  await saveBlob(new Blob([bytes], { type: mimeFor(o.fileName) }), o.fileName);
}

/** A per-row formula with its value cached (e.g. Balance = Net − Paid), so it reads right before Excel recalculates. */
export function xFormula(formula: string, result: number): XValue {
  return { formula, result };
}

/** Column letter for a column key in a spec, for building per-row formulas. Row is 1-based sheet row. */
export function xRef(columns: XCol[], key: string, sheetRow: number): string {
  return `${colLetter(columns.findIndex((c) => c.key === key) + 1)}${sheetRow}`;
}
/** Sheet row number of data row `i` (0-based). */
export const xRow = (i: number) => HEAD_ROW + 1 + i;
