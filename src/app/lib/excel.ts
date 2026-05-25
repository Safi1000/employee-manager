import * as XLSX from "xlsx";

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

function downloadWorkbook(wb: XLSX.WorkBook, fileName: string) {
  XLSX.writeFile(wb, fileName);
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

// ---------- Attendance Format ----------
export type AttendanceEmployeeRow = {
  serial: number;
  name: string;
  designation: string;
  empCode: string;
  shift: "day" | "night";
  // statusByDay[day-1] = "P" | "A" | "L" | ""
  statusByDay: string[];
  presents: number;
  absents: number;
  leaves: number;
  payDays: number;
};

export function exportAttendance(opts: {
  monthLabel: string; // e.g. "MARCH 2026"
  daysInMonth: number;
  clientLabel?: string;
  rows: AttendanceEmployeeRow[];
  fileName?: string;
}) {
  const { monthLabel, daysInMonth, clientLabel, rows } = opts;
  const headers1: any[] = ["Ser.", "Name", "Desg.", "Emp #"];
  for (let d = 1; d <= daysInMonth; d += 1) {
    headers1.push(d, ""); // each day spans D + N
  }
  headers1.push("Presents", "Absents", "Leaves", "Pay Days");

  const headers2: any[] = ["", "", "", ""];
  for (let d = 1; d <= daysInMonth; d += 1) {
    headers2.push("D", "N");
  }
  headers2.push("", "", "", "");

  const data: any[][] = [];
  data.push([DEFAULT_COMPANY]);
  data.push([
    `ATTENDANCE SHEET - ${monthLabel.toUpperCase()}${
      clientLabel ? ` (${clientLabel} - DAY & NIGHT SHIFTS)` : " (DAY & NIGHT SHIFTS)"
    }`,
  ]);
  data.push(headers1);
  data.push(headers2);

  // Day totals
  const totalPresentsByDay: { d: number; n: number }[] = Array.from(
    { length: daysInMonth },
    () => ({ d: 0, n: 0 }),
  );
  const totalLeavesByDay: { d: number; n: number }[] = Array.from(
    { length: daysInMonth },
    () => ({ d: 0, n: 0 }),
  );
  const totalAbsentsByDay: { d: number; n: number }[] = Array.from(
    { length: daysInMonth },
    () => ({ d: 0, n: 0 }),
  );

  for (const row of rows) {
    const r: any[] = [
      String(row.serial).padStart(2, "0"),
      row.name,
      row.designation,
      row.empCode,
    ];
    for (let i = 0; i < daysInMonth; i += 1) {
      const status = row.statusByDay[i] ?? "";
      if (row.shift === "day") {
        r.push(status, "");
        if (status === "P") totalPresentsByDay[i].d += 1;
        if (status === "L") totalLeavesByDay[i].d += 1;
        if (status === "A") totalAbsentsByDay[i].d += 1;
      } else {
        r.push("", status);
        if (status === "P") totalPresentsByDay[i].n += 1;
        if (status === "L") totalLeavesByDay[i].n += 1;
        if (status === "A") totalAbsentsByDay[i].n += 1;
      }
    }
    r.push(row.presents, row.absents, row.leaves, row.payDays);
    data.push(r);
  }

  // Totals rows
  const totalRow = (
    label: string,
    src: { d: number; n: number }[],
    final: { p: number; a: number; l: number; pd: number } | null,
  ) => {
    const r: any[] = [label, "", "", ""];
    for (const v of src) r.push(v.d, v.n);
    if (final) r.push(final.p, final.a, final.l, final.pd);
    else r.push("", "", "", "");
    return r;
  };

  const sumP = rows.reduce((s, r) => s + r.presents, 0);
  const sumA = rows.reduce((s, r) => s + r.absents, 0);
  const sumL = rows.reduce((s, r) => s + r.leaves, 0);
  const sumPD = rows.reduce((s, r) => s + r.payDays, 0);

  data.push(totalRow("Total Presents", totalPresentsByDay, { p: sumP, a: sumA, l: sumL, pd: sumPD }));
  data.push(totalRow("Total Leaves", totalLeavesByDay, null));
  data.push(totalRow("Total Absents", totalAbsentsByDay, null));

  const grandByDay: { d: number; n: number }[] = totalPresentsByDay.map((p, i) => ({
    d: p.d + totalLeavesByDay[i].d + totalAbsentsByDay[i].d,
    n: p.n + totalLeavesByDay[i].n + totalAbsentsByDay[i].n,
  }));
  data.push(totalRow("Grand Total", grandByDay, null));

  data.push([]);
  data.push(["D", "=", "day shift"]);
  data.push(["N", "=", "night shift"]);
  data.push(["pay days", "=", "total present + allowed leaves - excessive leaves"]);

  const ws = XLSX.utils.aoa_to_sheet(data);
  // Title merges
  const totalCols = 4 + daysInMonth * 2 + 4;
  mergeCell(ws, 0, 0, 0, totalCols - 1);
  mergeCell(ws, 1, 0, 1, totalCols - 1);
  // Day-number header merges (each pair: D+N share the day number cell visually)
  for (let i = 0; i < daysInMonth; i += 1) {
    mergeCell(ws, 2, 4 + i * 2, 2, 4 + i * 2 + 1);
  }
  const widths = [6, 28, 8, 14];
  for (let i = 0; i < daysInMonth; i += 1) widths.push(4, 4);
  widths.push(10, 10, 10, 10);
  setColWidths(ws, widths);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(monthLabel.toUpperCase()));
  downloadWorkbook(wb, opts.fileName ?? `Attendance ${monthLabel}.xlsx`);
}
