/**
 * Payroll workbook (6 Nov 2026, on the Excel standard in xlsxKit).
 *
 * One WORKSHEET PER CLIENT, because a month's payroll is reviewed and signed
 * client by client. Every figure is the screen's own; this file does no payroll
 * arithmetic. Two things are formulas rather than numbers, so they can never
 * disagree with what they are made of: each row's Balance (Net − Paid) and the
 * totals row (a SUM over the column above).
 *
 * People with no payslip yet (payroll not run for them) keep their payroll
 * columns BLANK, not 0 — a 0 reads as "owed nothing". Base salary and
 * allowance are filled in for everyone, because they live on the employee
 * record and are known before payroll runs.
 */
import type { Company } from "./supabase";
import type { PayrollExportSheet } from "./excel";
import { saveWorkbook, xFormula, xRef, xRow, type XCol, type XSheet } from "./xlsxKit";

const COLUMNS: XCol[] = [
  { header: "#", key: "n", width: 5, kind: "center" },
  { header: "Client code", key: "code", width: 12 },
  { header: "Permanent code", key: "guard", width: 13 },
  { header: "Name", key: "name", width: 28 },
  { header: "Site", key: "site", width: 22 },
  { header: "Present", key: "p", width: 8, kind: "int" },
  { header: "Absent", key: "a", width: 8, kind: "int" },
  { header: "Leave", key: "l", width: 8, kind: "int" },
  { header: "Base salary", key: "base", width: 13, kind: "money", total: true },
  { header: "Allowance", key: "allow", width: 11, kind: "money", total: true },
  { header: "Bonus", key: "bonus", width: 10, kind: "money", total: true },
  { header: "Gross", key: "gross", width: 13, kind: "money", total: true },
  { header: "Advance", key: "adv", width: 11, kind: "money", total: true },
  { header: "EOBI", key: "eobi", width: 9, kind: "money", total: true },
  { header: "Income tax", key: "tax", width: 11, kind: "money", total: true },
  { header: "Other deductions", key: "ded", width: 13, kind: "money", total: true },
  { header: "Net salary", key: "net", width: 13, kind: "money", total: true },
  { header: "Paid", key: "paid", width: 13, kind: "money", total: true },
  { header: "Balance", key: "bal", width: 12, kind: "money", total: true },
  { header: "Mode", key: "mode", width: 9 },
  { header: "Status", key: "status", width: 12 },
];

export async function exportPayrollWorkbook(o: {
  company: Company | null | undefined;
  sheets: PayrollExportSheet[];
  periodLabel: string;
  fileName?: string;
}) {
  const sheets: XSheet[] = o.sheets.map((s) => {
    const processed = s.rows.filter((r) => r.hasPayslip).length;
    const unprocessed = s.rows.length - processed;
    const rows = s.rows.map((r, i) => {
      const base = { n: i + 1, code: r.employeeCode, guard: r.guardCode, name: r.name, site: r.site ?? "", base: r.baseSalary, allow: r.allowance, status: r.status };
      if (!r.hasPayslip) return base;
      const sr = xRow(i);
      return {
        ...base,
        p: r.presentDays, a: r.absentDays, l: r.leaveDays,
        bonus: r.bonus, gross: r.finalSalary, adv: r.advance, eobi: r.eobi, tax: r.incomeTax, ded: r.deductions,
        net: r.netSalary, paid: r.amountPaid,
        bal: xFormula(`${xRef(COLUMNS, "net", sr)}-${xRef(COLUMNS, "paid", sr)}`, Math.round(r.netSalary) - Math.round(r.amountPaid)),
        mode: r.paymentMode,
      };
    });
    return {
      name: s.name,
      title: `Payroll — ${s.name}`,
      subtitle: `${o.periodLabel}  ·  ${s.rows.length} employee${s.rows.length === 1 ? "" : "s"}`,
      // Said ON THE SHEET: the file outlives the screen that explained the blanks.
      note: unprocessed === 0 ? undefined
        : unprocessed === s.rows.length ? "Payroll has not been processed for this client yet — salary columns are blank by design, not zero."
        : `Part-processed: ${unprocessed} of ${s.rows.length} employees have no payslip yet. Their salary columns are blank, not zero.`,
      columns: COLUMNS,
      rows,
      // The label says what the total covers — 1 processed of 109 must not read as everyone's payroll.
      totalLabel: processed === s.rows.length ? `Total — ${s.rows.length} employee${s.rows.length === 1 ? "" : "s"}` : `Total — ${processed} of ${s.rows.length} with a payslip`,
      totalLabelKey: "name",
      freezeColumns: 4,
    };
  });
  await saveWorkbook({
    company: o.company,
    sheets,
    emptyMessage: "No clients selected.",
    fileName: o.fileName ?? (o.sheets.length === 1 ? `Payroll - ${o.sheets[0].name} - ${o.periodLabel}.xlsx` : `Payroll - ${o.sheets.length} clients - ${o.periodLabel}.xlsx`),
  });
}
