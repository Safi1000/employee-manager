import type * as XLSXNS from "xlsx";
import { saveBlob, mimeFor } from "./saveFile";

/**
 * ATTENDANCE IMPORT TEMPLATE (0638, 3 Nov 2026).
 *
 * One fixed format, exported by Bastion and read back by Bastion:
 *
 *   row 1  Bastion attendance import — do not change rows 1–4
 *   row 2  Client | <name> | Client ID | <uuid>
 *   row 3  Month  | YYYY-MM
 *   row 4  Codes  | P present · L leave · A absent · R rest day · blank no duty
 *   row 5  Guard code | Name | Site | 1 | 2 | … | <last day>
 *   row 6+ one guard per row
 *
 * The reader matches guards by GUARD CODE only. A name is shown back for the
 * person to check, never used to choose the guard: this client alone has two
 * "Ali Raza"s and spellings like "Sharfat"/"Sharafat". The client id and the
 * month in rows 2–3 must be the ones picked on screen, so a sheet cannot land
 * on the wrong client or month. Formulas are not evaluated — only the cached
 * value is read — and the file is capped in size and rows.
 */

let XLSX: typeof XLSXNS;
async function ensureXlsx() {
  if (!XLSX) XLSX = await import("xlsx");
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 1200;
export const CODES: Record<string, string> = { P: "present", L: "leave", A: "absent", R: "rest_day" };
const STATUS_TO_CODE: Record<string, string> = { present: "P", leave: "L", absent: "A", rest_day: "R" };

export type TemplateGuard = { guard_code: string; full_name: string; site: string; marks: Record<number, string> };

export const daysIn = (month: string) => { const [y, m] = month.split("-").map(Number); return new Date(y, m, 0).getDate(); };

/** The template, prefilled with the guards and whatever Bastion already holds for the month. */
export async function downloadTemplate(opts: { clientId: string; clientName: string; month: string; guards: TemplateGuard[] }) {
  await ensureXlsx();
  const n = daysIn(opts.month);
  const days = Array.from({ length: n }, (_, i) => i + 1);
  const aoa: (string | number)[][] = [
    ["Bastion attendance import — do not change rows 1–4"],
    ["Client", opts.clientName, "Client ID", opts.clientId],
    ["Month", opts.month],
    ["Codes", "P present · L leave · A absent · R rest day · blank = no duty that day"],
    ["Guard code", "Name", "Site", ...days],
    ...opts.guards.map((g) => [g.guard_code, g.full_name, g.site, ...days.map((d) => g.marks[d] ?? "")]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Every cell is written as text, so a name beginning with "=" stays a name.
  ws["!cols"] = [{ wch: 12 }, { wch: 24 }, { wch: 16 }, ...days.map(() => ({ wch: 3.5 }))];
  const help = XLSX.utils.aoa_to_sheet([
    ["How to fill this sheet"],
    [""],
    ["1. Fill one letter per day: P present, L leave, A absent, R rest day. Leave the cell empty if the guard had no duty that day."],
    ["2. Do not change rows 1–4, the Guard code column, or the day numbers in row 5."],
    ["3. A guard who is not listed must be added in Bastion (Employees) first. Then put his guard code (GGS-00…) in a new row."],
    ["4. Only the guards in this sheet are changed. Deleting a guard's row leaves his attendance as it is."],
    ["5. A blank day REMOVES a mark Bastion already has for that day. The preview lists every removal before anything is saved."],
    ["6. Upload it on the Attendance board → Import month. Nothing is saved until you have read the preview and confirmed."],
  ]);
  help["!cols"] = [{ wch: 110 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Attendance");
  XLSX.utils.book_append_sheet(wb, help, "How to fill");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const name = `Attendance import ${opts.clientName} ${opts.month}.xlsx`;
  await saveBlob(new Blob([out], { type: mimeFor(name) }), name);
}

export const codeFor = (status: string) => STATUS_TO_CODE[status] ?? "";

export type ParsedRow = { line: number; guard_code: string; name: string; marks: Record<string, string> };
export type Parsed = { clientId: string; month: string; rows: ParsedRow[]; problems: string[]; sha256: string };

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

/** Reads an uploaded template. Problems are collected, not thrown, so the person sees all of them at once. */
export async function readTemplate(file: File): Promise<Parsed> {
  await ensureXlsx();
  const problems: string[] = [];
  if (file.size > MAX_FILE_BYTES) throw new Error("The file is larger than 2 MB. The template for one client's month is a few kilobytes — is this the right file?");
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error("Upload the .xlsx template (or a .csv saved from it).");
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const wb = XLSX.read(buf, { type: "array", cellFormula: false, cellHTML: false, cellStyles: false, sheetRows: MAX_ROWS, dense: true });
  const ws = wb.Sheets["Attendance"] ?? wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("The file has no sheet in it.");
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", blankrows: true });

  const clientId = clean(aoa[1]?.[3]);
  const month = clean(aoa[2]?.[1]);
  if (clean(aoa[1]?.[0]) !== "Client" || clean(aoa[2]?.[0]) !== "Month" || !/^[0-9a-f-]{36}$/i.test(clientId) || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error("This is not Bastion's import template — rows 2 and 3 should hold the client and the month. Download the template, copy the days into it, and upload that.");
  }
  const header = (aoa[4] ?? []).map(clean);
  if (header[0] !== "Guard code") throw new Error('Row 5 should start with "Guard code". Rows 1–5 of the template must not be changed.');
  const n = daysIn(month);
  const dayCols: { col: number; day: number }[] = [];
  header.forEach((h, col) => { if (col >= 3 && /^\d{1,2}$/.test(h)) dayCols.push({ col, day: Number(h) }); });
  const expected = Array.from({ length: n }, (_, i) => i + 1).join(",");
  if (dayCols.map((d) => d.day).join(",") !== expected) problems.push(`Row 5 should number the days 1 to ${n} in order, starting in column D.`);

  const rows: ParsedRow[] = [];
  for (let i = 5; i < aoa.length; i++) {
    const r = aoa[i] ?? [];
    const code = clean(r[0]).toUpperCase();
    const name = clean(r[1]);
    const cells = dayCols.map(({ col, day }) => ({ day, v: clean(r[col]).toUpperCase() }));
    if (!code && !name && cells.every((c) => !c.v)) continue;
    const line = i + 1;
    if (!code) { problems.push(`Row ${line} (${name || "no name"}) has no guard code. Add the guard in Employees first, then put his code here.`); continue; }
    const marks: Record<string, string> = {};
    for (const c of cells) {
      if (!c.v) { marks[String(c.day)] = ""; continue; }
      if (!CODES[c.v]) { problems.push(`Row ${line} (${code}), day ${c.day}: "${c.v}" — use P, L, A, R or leave it blank.`); continue; }
      marks[String(c.day)] = c.v;
    }
    rows.push({ line, guard_code: code, name, marks });
  }
  if (aoa.length >= MAX_ROWS) problems.push(`The sheet has more than ${MAX_ROWS} rows. One client's month should be far fewer.`);
  if (!rows.length && !problems.length) problems.push("No guards found under row 5.");
  return { clientId, month, rows, problems, sha256 };
}
