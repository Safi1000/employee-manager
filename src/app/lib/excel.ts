import * as XLSX from "xlsx";
import { saveBlob, mimeFor } from "./saveFile";

const DEFAULT_COMPANY = "Guards & Guides Security Services (Pvt.) Limited";

function setColWidths(ws: XLSX.WorkSheet, widths: number[]) {
  ws["!cols"] = widths.map((w) => ({ wch: w }));
}

function mergeCell(
  ws: XLSX.WorkSheet,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
) {
  const merges = (ws["!merges"] = ws["!merges"] ?? []);
  merges.push({ s: { r: startRow, c: startCol }, e: { r: endRow, c: endCol } });
}

// XLSX.writeFile() triggers a browser download, which a native WebView has no
// concept of — the export button would appear to work and produce nothing. Go
// through the bytes instead so the same call yields a download on the web and a
// share sheet on a phone. Fire-and-forget: every caller is a click handler that
// has never awaited this, and the failure mode (no file) is self-evident.
function downloadWorkbook(wb: XLSX.WorkBook, fileName: string) {
  const bytes = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  void saveBlob(new Blob([bytes], { type: mimeFor(fileName) }), fileName);
}

function safeSheetName(name: string) {
  // Excel rules: max 31 chars, no : \ / ? * [ ]
  return name.replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "Sheet1";
}

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("T")[0].split("-").map(Number);
  if (!y || !m || !d) return String(iso);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

// ---------- Generic table exporter ----------
export function exportTable(opts: {
  fileName: string;
  sheetName?: string;
  title?: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
  columnWidths?: number[];
}) {
  const data: any[][] = [];
  if (opts.title) {
    data.push([opts.title]);
    data.push([]);
  }
  data.push(opts.headers);
  for (const row of opts.rows) {
    data.push(row.map((c) => (c == null ? "" : c)));
  }
  const ws = XLSX.utils.aoa_to_sheet(data);
  if (opts.title) {
    mergeCell(ws, 0, 0, 0, opts.headers.length - 1);
  }
  setColWidths(
    ws,
    opts.columnWidths ?? opts.headers.map((h) => Math.max(12, Math.min(40, h.length + 4))),
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(opts.sheetName ?? "Sheet1"));
  downloadWorkbook(wb, opts.fileName);
}

// ---------- Advances Format ----------
export type AdvanceExportRow = {
  date: string;
  employee: string;
  client: string;
  amount: number;
  mode: string;
  remarks: string;
};

export function exportAdvances(rows: AdvanceExportRow[], fileName = "Advances.xlsx") {
  const headers = ["Date", "Employee Name", "Client", "Amount", "Mode", "Remarks"];
  const data: any[][] = [];
  data.push(["Advances Format"]);
  data.push([]);
  data.push(headers);
  for (const r of rows) {
    data.push([fmtDate(r.date), r.employee, r.client, r.amount, r.mode, r.remarks]);
  }
  data.push([]);
  data.push([
    "Total",
    "",
    "",
    rows.reduce((s, r) => s + Number(r.amount || 0), 0),
    "",
    "",
  ]);
  const ws = XLSX.utils.aoa_to_sheet(data);
  mergeCell(ws, 0, 0, 0, headers.length - 1);
  setColWidths(ws, [14, 28, 24, 14, 10, 32]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Advances");
  downloadWorkbook(wb, fileName);
}

// ---------- Expenses Format ----------
export type ExpenseExportRow = {
  date: string;
  particulars: string;
  category: string;
  client: string;
  amount: number;
  mode: string;
};

export function exportExpenses(rows: ExpenseExportRow[], fileName = "Expenses.xlsx") {
  const headers = ["Date", "Particulars", "Category", "Client", "Amount", "Mode"];
  const data: any[][] = [];
  data.push(["Expenses Format"]);
  data.push([]);
  data.push(headers);
  for (const r of rows) {
    data.push([fmtDate(r.date), r.particulars, r.category, r.client, r.amount, r.mode]);
  }
  data.push([]);
  data.push([
    "Total",
    "",
    "",
    "",
    rows.reduce((s, r) => s + Number(r.amount || 0), 0),
    "",
  ]);
  const ws = XLSX.utils.aoa_to_sheet(data);
  mergeCell(ws, 0, 0, 0, headers.length - 1);
  setColWidths(ws, [14, 36, 22, 24, 14, 10]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Expenses");
  downloadWorkbook(wb, fileName);
}

// ---------- Client Statement Format ----------
export type ClientStatementExportRow = {
  client: string;
  totalReceivable: number;
  payrollExpenses: number;
  otherExpenses: number;
  netIncome: number;
};

export function exportClientStatements(
  rows: ClientStatementExportRow[],
  periodLabel: string,
  fileName = "Client Statement.xlsx",
) {
  const headers = [
    "Client's Name",
    "Total Receivable",
    "Payroll Expenses",
    "Other Expenses",
    "Net Income",
  ];
  const data: any[][] = [];
  data.push([`Client Statement — ${periodLabel}`]);
  data.push([]);
  data.push(headers);
  for (const r of rows) {
    data.push([r.client, r.totalReceivable, r.payrollExpenses, r.otherExpenses, r.netIncome]);
  }
  data.push([]);
  const totals = rows.reduce(
    (acc, r) => ({
      r: acc.r + Number(r.totalReceivable || 0),
      p: acc.p + Number(r.payrollExpenses || 0),
      o: acc.o + Number(r.otherExpenses || 0),
      n: acc.n + Number(r.netIncome || 0),
    }),
    { r: 0, p: 0, o: 0, n: 0 },
  );
  data.push(["Total", totals.r, totals.p, totals.o, totals.n]);
  const ws = XLSX.utils.aoa_to_sheet(data);
  mergeCell(ws, 0, 0, 0, headers.length - 1);
  setColWidths(ws, [32, 18, 18, 18, 18]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Client Statement");
  downloadWorkbook(wb, fileName);
}

// ---------- Profit & Loss Format ----------
export type PLFigures = {
  // Revenue
  securityRevenue: number;
  guardRevenue: number;
  totalRevenue: number;
  // Cost of Services
  guardPayroll: number;
  cosStatutory: number; // EOBI + IESSI + PESSI
  cosTransport: number;
  cosEquipment: number;
  cosOther: number;
  totalCos: number;
  grossProfit: number;
  // Operating Expenses
  officePayroll: number;
  opUtilities: number;
  opInsurance: number;
  opLicenses: number;
  opOther: number;
  totalOpex: number;
  operatingProfit: number;
  // Below the line
  ebt: number;
  taxes: number;
  netProfit: number;
};

export function exportProfitLoss(
  fig: PLFigures,
  periodLabel: string,
  fileName = "P&L.xlsx",
) {
  const data: any[][] = [];
  data.push([DEFAULT_COMPANY]);
  data.push([`Profit and Loss Statement — ${periodLabel}`]);
  data.push([]);
  data.push(["PROFIT AND LOSS STATEMENT", "", "", "", ""]);
  data.push([]);
  data.push(["Revenue", "", "", "", ""]);
  data.push(["  Security Services Revenue", "", "", fig.securityRevenue, ""]);
  data.push(["  Guard Deployment Revenue", "", "", fig.guardRevenue, ""]);
  data.push(["  Total Revenue", "", "", "", fig.totalRevenue]);
  data.push([]);
  data.push(["Cost of Services", "", "", "", ""]);
  data.push(["  Guard Payroll & Salaries", "", "", fig.guardPayroll, ""]);
  data.push(["  Guard Statutory (EOBI/IESSI/PESSI)", "", "", fig.cosStatutory, ""]);
  data.push(["  Transportation & Fuel", "", "", fig.cosTransport, ""]);
  data.push(["  Equipment & Supplies", "", "", fig.cosEquipment, ""]);
  data.push(["  Other Cost of Services", "", "", fig.cosOther, ""]);
  data.push(["  Total Cost of Services", "", "", "", fig.totalCos]);
  data.push([]);
  data.push(["Gross Profit", "", "", "", fig.grossProfit]);
  data.push([]);
  data.push(["Operating Expenses", "", "", "", ""]);
  data.push(["  Office Salaries", "", "", fig.officePayroll, ""]);
  data.push(["  Utilities & Rent", "", "", fig.opUtilities, ""]);
  data.push(["  Insurance", "", "", fig.opInsurance, ""]);
  data.push(["  Licences (company-level)", "", "", fig.opLicenses, ""]);
  data.push(["  Other Operating Expenses", "", "", fig.opOther, ""]);
  data.push(["  Total Operating Expenses", "", "", "", fig.totalOpex]);
  data.push([]);
  data.push(["Operating Profit", "", "", "", fig.operatingProfit]);
  data.push([]);
  data.push(["Earnings Before Tax (EBT)", "", "", "", fig.ebt]);
  data.push(["Income Tax", "", "", "", fig.taxes]);
  data.push(["Net Profit", "", "", "", fig.netProfit]);
  const ws = XLSX.utils.aoa_to_sheet(data);
  mergeCell(ws, 0, 0, 0, 4);
  mergeCell(ws, 1, 0, 1, 4);
  mergeCell(ws, 3, 0, 3, 4);
  setColWidths(ws, [36, 4, 4, 18, 18]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "P&L");
  downloadWorkbook(wb, fileName);
}

// ---------- Receivable Ledger Format ----------
export type LedgerEntry =
  | {
      kind: "invoice";
      date: string;
      description: string;
      invoiceAmount: number;
    }
  | {
      kind: "payment";
      date: string;
      description: string;
      amount: number;
    };

export type LedgerClient = {
  name: string;
  entries: LedgerEntry[];
};

export function exportReceivableLedger(
  clients: LedgerClient[],
  fileName = "Receivable Ledger.xlsx",
) {
  const wb = XLSX.utils.book_new();
  const headers = [
    "Sr #",
    "Date",
    "Name",
    "Description",
    "Debit",
    "Invoice",
    "Tax",
    "After Tax Net Amount",
    "Running Balance",
  ];

  if (clients.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet([
      [DEFAULT_COMPANY],
      [],
      headers,
      ["", "", "", "No data", "", "", "", "", ""],
    ]);
    mergeCell(ws, 0, 0, 0, headers.length - 1);
    setColWidths(ws, [6, 14, 32, 40, 14, 14, 10, 18, 18]);
    XLSX.utils.book_append_sheet(wb, ws, "Ledger");
    downloadWorkbook(wb, fileName);
    return;
  }

  for (const client of clients) {
    const data: any[][] = [];
    data.push([DEFAULT_COMPANY]);
    data.push([client.name]);
    data.push([]);
    data.push(headers);
    let running = 0;
    let totalDebit = 0;
    let totalInvoice = 0;
    let sr = 0;
    const sorted = [...client.entries].sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const e of sorted) {
      sr += 1;
      if (e.kind === "invoice") {
        running += Number(e.invoiceAmount || 0);
        totalInvoice += Number(e.invoiceAmount || 0);
        data.push([
          sr,
          fmtDate(e.date),
          client.name,
          e.description,
          0,
          Number(e.invoiceAmount || 0),
          0,
          Number(e.invoiceAmount || 0),
          running,
        ]);
      } else {
        running -= Number(e.amount || 0);
        totalDebit += Number(e.amount || 0);
        data.push([
          sr,
          fmtDate(e.date),
          client.name,
          e.description,
          Number(e.amount || 0),
          0,
          0,
          0,
          running,
        ]);
      }
    }
    data.push([]);
    data.push([
      "",
      "",
      "",
      "Grand Total",
      totalDebit,
      totalInvoice,
      0,
      totalInvoice,
      running,
    ]);
    const ws = XLSX.utils.aoa_to_sheet(data);
    mergeCell(ws, 0, 0, 0, headers.length - 1);
    mergeCell(ws, 1, 0, 1, headers.length - 1);
    setColWidths(ws, [6, 14, 32, 40, 14, 14, 10, 18, 18]);
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(`${client.name} Ledger`));
  }
  downloadWorkbook(wb, fileName);
}

// ---------- Bank Statement Format ----------
export type BankStatementRow = {
  date: string;
  kind: string;
  description: string | null;
  bankName: string;
  credit: number;
  debit: number;
  cashIn: number;
  cashOut: number;
};

export function exportBankStatement(
  rows: BankStatementRow[],
  opts: { fromDate?: string; toDate?: string; bankLabel: string },
  fileName = "Bank Statement.xlsx",
) {
  const periodLabel =
    opts.fromDate && opts.toDate
      ? `${opts.fromDate} to ${opts.toDate}`
      : opts.fromDate
      ? `From ${opts.fromDate}`
      : opts.toDate
      ? `To ${opts.toDate}`
      : "All time";

  const headers = ["Date", "Type", "Bank", "Description", "Credit (In)", "Debit (Out)", "Cash In", "Cash Out"];
  const data: any[][] = [];
  data.push([DEFAULT_COMPANY]);
  data.push([`Bank Statement — ${opts.bankLabel} — ${periodLabel}`]);
  data.push([]);
  data.push(headers);

  let totalCredit = 0;
  let totalDebit = 0;
  let totalCashIn = 0;
  let totalCashOut = 0;

  for (const r of rows) {
    totalCredit += Number(r.credit || 0);
    totalDebit += Number(r.debit || 0);
    totalCashIn += Number(r.cashIn || 0);
    totalCashOut += Number(r.cashOut || 0);
    data.push([
      fmtDate(r.date),
      r.kind,
      r.bankName,
      r.description ?? "",
      r.credit || "",
      r.debit || "",
      r.cashIn || "",
      r.cashOut || "",
    ]);
  }

  data.push([]);
  data.push(["Total", "", "", "", totalCredit, totalDebit, totalCashIn, totalCashOut]);

  const ws = XLSX.utils.aoa_to_sheet(data);
  mergeCell(ws, 0, 0, 0, headers.length - 1);
  mergeCell(ws, 1, 0, 1, headers.length - 1);
  setColWidths(ws, [14, 18, 22, 40, 14, 14, 12, 12]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(`Bank Statement`));
  downloadWorkbook(wb, fileName);
}

// ---------- Attendance Format ----------
export type AttendanceEmployeeRow = {
  serial: number;
  /** Stable employee id — used by the on-screen Monthly Board to key OPS-Verify
   * flags/overrides per employee+date. Not emitted to the Excel export. */
  empId?: string;
  name: string;
  designation: string;
  empCode: string;
  // Fallback shift code for days with no explicit shiftByDay entry.
  shift: string;
  // Effective shift CODE per day (override-aware), e.g. "day" | "night" | "evening"
  // or any code a contract defines. shiftByDay[day-1] = the code worked that day.
  // Falls back to `shift` for every day when omitted.
  shiftByDay?: string[];
  // statusByDay[day-1] = "P" | "A" | "L" | "DD" (double duty — two shifts worked
  // that day) | "X" (separated — see separationNote) | ""
  statusByDay: string[];
  presents: number;
  absents: number;
  leaves: number;
  /** Days the guard worked TWO shifts. Counted inside `presents` as well — a
   *  double-duty day is still one day present; this is the extra duty on top. */
  doubleDuties: number;
  payDays: number;
  // Set for a guard who left/was fired: shown after their name and used for the
  // legend, e.g. "Fired 10/03/2026". Days from that date on carry "X".
  separationNote?: string | null;
};

// Compact one-letter column badge for a shift code (day → D, night → N,
// evening → E). Data-driven from the code, mirroring AttendanceBoard's shiftAbbr.
export const shiftAbbr = (code: string): string => (code ? code[0].toUpperCase() : "?");
const titleCase = (code: string): string =>
  code.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

// Column order is a DISPLAY preference only — the SET of shifts is always derived
// from the data. Known shifts sort in this natural order; anything else follows,
// alphabetically, so a contract with novel shift codes still exports every one.
const SHIFT_DISPLAY_ORDER = ["day", "night", "evening"];
export const orderShifts = (codes: Iterable<string>): string[] => {
  const uniq = Array.from(new Set(Array.from(codes, (c) => String(c || "day").toLowerCase())));
  return uniq.sort((a, b) => {
    const ia = SHIFT_DISPLAY_ORDER.indexOf(a);
    const ib = SHIFT_DISPLAY_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a < b ? -1 : a > b ? 1 : 0;
  });
};

// The shift-column set for a sheet, derived from the rows' actual shift codes
// exactly as exportAttendance does — so the on-screen viewer shows the same
// columns as the download. An explicit override wins.
export function deriveAttendanceShifts(rows: AttendanceEmployeeRow[], override?: string[]): string[] {
  if (override) return override;
  const codes = new Set<string>();
  for (const row of rows) {
    for (const c of row.shiftByDay ?? []) codes.add(String(c || row.shift || "day").toLowerCase());
    codes.add(String(row.shift || "day").toLowerCase());
  }
  return codes.size ? orderShifts(codes) : ["day"];
}

export function exportAttendance(opts: {
  monthLabel: string; // e.g. "MARCH 2026" or a range label
  daysInMonth: number;
  clientLabel?: string;
  rows: AttendanceEmployeeRow[];
  fileName?: string;
  // Optional explicit column labels (one per day). When omitted the columns are
  // numbered 1..daysInMonth (single-month sheet). A date-range export passes the
  // day-of-month of each date so the sheet can span a month boundary.
  dayLabels?: (string | number)[];
  // Optional explicit shift-column set. When omitted it is derived from the rows'
  // actual shift codes, so the sheet shows exactly the shifts present (Day/Night,
  // or Day/Night/Evening for a 3-shift contract like HMC) — never a fixed set.
  shifts?: string[];
}) {
  const { monthLabel, clientLabel, rows } = opts;
  const dayLabels = opts.dayLabels ?? Array.from({ length: opts.daysInMonth }, (_, i) => i + 1);
  const daysInMonth = dayLabels.length;

  // The shift columns, data-driven: every code appearing in any row's per-day or
  // fallback shift. Defaults to ["day"] so an all-day sheet still has one column.
  const shiftCodes = new Set<string>();
  for (const row of rows) {
    for (const c of row.shiftByDay ?? []) shiftCodes.add(String(c || row.shift || "day").toLowerCase());
    shiftCodes.add(String(row.shift || "day").toLowerCase());
  }
  const shifts = opts.shifts ?? (shiftCodes.size ? orderShifts(shiftCodes) : ["day"]);
  const S = shifts.length;
  const shiftIndex = new Map(shifts.map((c, i) => [c, i]));

  const headers1: any[] = ["Ser.", "Name", "Desg.", "Emp #"];
  for (let d = 0; d < daysInMonth; d += 1) {
    headers1.push(dayLabels[d], ...Array(S - 1).fill("")); // each day spans its shifts
  }
  headers1.push("Presents", "Absents", "Leaves", "Double Duty", "Pay Days");

  const headers2: any[] = ["", "", "", ""];
  for (let d = 0; d < daysInMonth; d += 1) {
    for (const c of shifts) headers2.push(shiftAbbr(c));
  }
  headers2.push("", "", "", "", "");

  const data: any[][] = [];
  data.push([DEFAULT_COMPANY]);
  const shiftTitle = shifts.map((c) => c.toUpperCase()).join(" & ");
  data.push([
    `ATTENDANCE SHEET - ${monthLabel.toUpperCase()}${
      clientLabel ? ` (${clientLabel} - ${shiftTitle} SHIFTS)` : ` (${shiftTitle} SHIFTS)`
    }`,
  ]);
  data.push(headers1);
  data.push(headers2);

  // Day totals: [dayIndex][shiftIndex].
  const zeros = () => Array.from({ length: daysInMonth }, () => Array(S).fill(0) as number[]);
  const totalPresentsByDay = zeros();
  const totalLeavesByDay = zeros();
  const totalAbsentsByDay = zeros();

  for (const row of rows) {
    const r: any[] = [
      String(row.serial).padStart(2, "0"),
      // A separated guard is called out on their own row, so the sheet explains
      // its own blanks instead of reading as missing attendance.
      row.separationNote ? `${row.name} (${row.separationNote})` : row.name,
      row.designation,
      row.empCode,
    ];
    for (let i = 0; i < daysInMonth; i += 1) {
      const status = row.statusByDay[i] ?? "";
      // Per-day shift decides which shift column the mark lands in, so a day a
      // guard swapped shifts shows under the shift actually worked.
      const dayShift = String(row.shiftByDay?.[i] ?? row.shift ?? "day").toLowerCase();
      const si = shiftIndex.get(dayShift) ?? 0;
      for (let c = 0; c < S; c += 1) r.push(c === si ? status : "");
      if (status === "P" || status === "DD") totalPresentsByDay[i][si] += 1;
      if (status === "L") totalLeavesByDay[i][si] += 1;
      if (status === "A") totalAbsentsByDay[i][si] += 1;
    }
    r.push(row.presents, row.absents, row.leaves, row.doubleDuties, row.payDays);
    data.push(r);
  }

  // Totals rows
  const totalRow = (
    label: string,
    src: number[][],
    final: { p: number; a: number; l: number; dd: number; pd: number } | null,
  ) => {
    const r: any[] = [label, "", "", ""];
    for (const perShift of src) for (const v of perShift) r.push(v);
    if (final) r.push(final.p, final.a, final.l, final.dd, final.pd);
    else r.push("", "", "", "", "");
    return r;
  };

  const sumP = rows.reduce((s, r) => s + r.presents, 0);
  const sumA = rows.reduce((s, r) => s + r.absents, 0);
  const sumL = rows.reduce((s, r) => s + r.leaves, 0);
  const sumDD = rows.reduce((s, r) => s + r.doubleDuties, 0);
  const sumPD = rows.reduce((s, r) => s + r.payDays, 0);

  data.push(totalRow("Total Presents", totalPresentsByDay, { p: sumP, a: sumA, l: sumL, dd: sumDD, pd: sumPD }));
  data.push(totalRow("Total Leaves", totalLeavesByDay, null));
  data.push(totalRow("Total Absents", totalAbsentsByDay, null));

  const grandByDay: number[][] = totalPresentsByDay.map((perShift, i) =>
    perShift.map((p, s) => p + totalLeavesByDay[i][s] + totalAbsentsByDay[i][s]),
  );
  data.push(totalRow("Grand Total", grandByDay, null));

  data.push([]);
  for (const c of shifts) data.push([shiftAbbr(c), "=", `${c} shift`]);
  data.push(["P / A / L", "=", "present / absent / leave"]);
  data.push(["DD", "=", "double duty — two shifts worked that day"]);
  data.push([
    "X",
    "=",
    "not markable on this date — fired / terminated / resigned, before joining, or outside the contract dates",
  ]);
  data.push(["pay days", "=", "total present + allowed leaves - excessive leaves"]);

  // Roll-call of everyone whose employment ended, with the date — so the sheet
  // answers "why did this guard stop appearing?" without a second lookup.
  const separated = rows.filter((r) => r.separationNote);
  if (separated.length > 0) {
    data.push([]);
    data.push(["Separations in / before this period"]);
    for (const r of separated) data.push([r.empCode, r.name, r.separationNote]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);
  // Title merges
  const totalCols = 4 + daysInMonth * S + 4;
  mergeCell(ws, 0, 0, 0, totalCols - 1);
  mergeCell(ws, 1, 0, 1, totalCols - 1);
  // Day-number header merges (the day's shift columns share the day number cell)
  if (S > 1) {
    for (let i = 0; i < daysInMonth; i += 1) {
      mergeCell(ws, 2, 4 + i * S, 2, 4 + i * S + S - 1);
    }
  }
  const widths = [6, 28, 8, 14];
  for (let i = 0; i < daysInMonth; i += 1) for (let c = 0; c < S; c += 1) widths.push(4);
  widths.push(10, 10, 10, 10);
  setColWidths(ws, widths);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(monthLabel.toUpperCase()));
  downloadWorkbook(wb, opts.fileName ?? `Attendance ${monthLabel}.xlsx`);
}
