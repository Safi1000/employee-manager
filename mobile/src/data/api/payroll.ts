// Payroll (web PayrollManagement.tsx, PayrollRun.tsx, PayrollAdjustments.tsx,
// LeaveBalances.tsx). The load, the row arithmetic, the payload and every write
// are ported line for line; money only moves through disburse_payslip (0458)
// and settle_payroll_adjustment, never from here.
//
// NOT ported, deliberately: the web loadAll() opens with
//   supabase.from("payslips").delete().lt("period_month", <six months ago>)
// on every page load. That is a destructive side effect of viewing a screen,
// and the phone does not repeat it.
import jsPDF from "jspdf";
import { q, rpc, sb, uid } from "./core";
import { friendlyDbError, resolveAllowedLeaves, resolveEobiAmount } from "../../lib/web/supabase";
import { ensureCustodianLocation, loadCustodianOptions, type CustodianOption } from "../../lib/web/custodian";
import { exportPayrollSheets, type PayrollExportRow } from "../../lib/web/excel";
import { guardDisplayCode } from "../../lib/web/guardCode";
import { isSeparatedState } from "../../lib/web/employmentWindow";
import { savePdf } from "../../lib/saveFile";

export type PaymentMode = "Cash" | "Bank" | "Cheque";
export type PayslipStatus = "Pending" | "Cleared";

export type PayEmployee = {
  id: string; employee_code: string; guard_code: string | null; display_number: number | null; full_name: string; phone: string | null;
  client_id: string | null; branch_id: string | null; contract_id: string | null; category: string | null; shift: string | null;
  status: string | null; lifecycle_state: string | null; base_salary: number | null; allowance: number | null;
  opening_leaves: number | null; opening_leaves_month: string | null; client_name: string | null;
};

export type RowState = {
  employee: PayEmployee;
  period_month: string;
  working_days: number;
  present_days: number;
  absent_days: number;
  leave_days: number;
  base_salary: number;
  per_day_salary: number | null;
  bonus: number;
  deductions: number;
  advance: number;
  income_tax: number;
  eobi: number;
  allowance: number;
  final_salary: number;
  net_salary: number;
  amount_paid: number;
  payment_mode: PaymentMode;
  bank_account_id: string | null;
  cheque_id: string | null;
  status: PayslipStatus;
  disbursed: boolean;
  disbursed_at: string | null;
  notes: string | null;
  payslip_id: string | null;
  override_leaves: boolean;
  allowed_leaves: number;
  effective_present_days: number;
  effective_absent_days: number;
  extra_leave_absent: number;
  double_duty_shifts: number;
  days_over_month: number;
  adjustment_carried: number;
  adjustment_detail: string | null;
};

// ------------------------------------------------------------------ helpers
export const firstOfMonth = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
export const endOfMonthStr = (periodMonth: string) => {
  const [y, m] = periodMonth.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
};
export const formatPeriod = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
};
export const daysInMonth = (periodMonth: string) => {
  const [y, m] = periodMonth.split("-").map(Number);
  return new Date(y, m, 0).getDate();
};
/** The web's period options: this month and the six before it. Default = previous month. */
export function periodOptions() {
  const today = new Date();
  const out: string[] = [];
  for (let i = 0; i <= 6; i++) out.push(firstOfMonth(new Date(today.getFullYear(), today.getMonth() - i, 1)));
  return out;
}
export const previousPeriod = () => { const t = new Date(); return firstOfMonth(new Date(t.getFullYear(), t.getMonth() - 1, 1)); };
export const catLabel = (cat: string) => (cat === "reliever" ? "Relievers" : cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));

/** isSettled: paid >= net, and a zero net is owed nothing (0428). */
export const isSettled = (paid: number, net: number) => net <= 0 || paid >= net;

export function friendlyError(err: any): string {
  const msg = err?.message ?? String(err);
  if (/payslips_paid_not_over_accrued/i.test(msg)) {
    return "This payslip has been paid more than it accrued, so it cannot be saved. That usually means attendance was cut after the money went out. Correct the attendance so the Net covers what was paid, or return the difference by setting Amount Paid back down.";
  }
  if (/payslips_disbursed_cash_names_a_location/i.test(msg)) {
    return "A cash salary needs the office-staff custodian who handed the cash over. Pick one in the payment row before disbursing.";
  }
  if (/period for .* is closed/i.test(msg) || /period .* is closed/i.test(msg)) {
    return msg.includes("Reopen") || msg.includes("reopen") ? msg : `${msg} Reopen the month in Period Close to continue.`;
  }
  return msg;
}

// --------------------------------------------------------------------- load
export type PayrollBase = {
  employees: PayEmployee[];
  sites: { id: string; client_id: string; name: string }[];
  siteByGuard: Map<string, string>;
  clients: any[];
  contracts: any[];
  banks: any[];
  cheques: any[];
  chequeLinkedSums: Map<string, number>;
  cashBalance: number;
  custodians: CustodianOption[];
};

export async function loadPayrollBase(regionId: string | null, companyId: string | null, canViewBanking: boolean): Promise<PayrollBase> {
  const s = sb();
  let empQ = s.from("employees").select(
    "id, company_id, employee_code, guard_code, display_number, full_name, phone, " +
    "client_id, branch_id, contract_id, contract_line_id, category, shift, status, lifecycle_state, " +
    "base_salary, per_day_salary, allowance, bank_name, join_date, last_working_day, termination_date, exit_date, " +
    "eligible_for_rehire, assignment_effective_from, assignment_effective_to, opening_leaves, opening_leaves_month, created_at, " +
    "client:client_id(name)",
  ).order("employee_code");
  if (regionId) empQ = empQ.eq("branch_id", regionId);
  const [emps, sites, deps, clients, contracts, banks, trea, cheques, linkedPs, linkedEx, linkedAdv, linkedIp] = await Promise.all([
    q<any[]>(empQ),
    q<any[]>(s.from("sites").select("id, client_id, name").order("name")),
    q<any[]>(s.from("deployments").select("guard_id, site_id").is("end_date", null)),
    q<any[]>(s.from("clients").select("*").order("name")),
    q<any[]>(s.from("contracts").select("*")),
    q<any[]>(s.from("bank_accounts").select("*").order("bank_name")),
    s.rpc("cash_in_hand" as never, { p_company_id: companyId } as never).maybeSingle(),
    q<any[]>(s.from("cheques").select("*").order("cheque_date", { ascending: false })),
    q<any[]>(s.from("payslips").select("cheque_id, net_salary").not("cheque_id", "is", null)),
    q<any[]>(s.from("expenses").select("cheque_id, amount").not("cheque_id", "is", null)),
    q<any[]>(s.from("advances").select("cheque_id, amount").not("cheque_id", "is", null)),
    q<any[]>(s.from("invoice_payments").select("cheque_id, amount").not("cheque_id", "is", null)),
  ]);
  const linked = new Map<string, number>();
  for (const r of linkedPs) if (r.cheque_id) linked.set(r.cheque_id, (linked.get(r.cheque_id) ?? 0) + Number(r.net_salary));
  for (const r of [...linkedEx, ...linkedAdv, ...linkedIp]) if (r.cheque_id) linked.set(r.cheque_id, (linked.get(r.cheque_id) ?? 0) + Number(r.amount));
  const custodians = companyId ? await loadCustodianOptions(companyId, canViewBanking).catch(() => []) : [];
  return {
    employees: emps.map((e) => ({ ...e, client_name: e.client?.name ?? null })),
    sites,
    siteByGuard: new Map(deps.filter((d) => d.site_id).map((d) => [d.guard_id, d.site_id])),
    clients, contracts, banks, cheques,
    chequeLinkedSums: linked,
    cashBalance: Number((trea.data as any)?.cash_balance ?? 0),
    custodians,
  };
}

type LeaveSummary = { present_days: number; tier: number; quota: number; earned: number; lost: number; opening: number; available: number; taken: number; unpaid: number; closing: number };
type AttPayroll = { worked_shifts: number; present_days: number; double_duty_shifts: number; earned: number; leave_days: number; absent_days: number; rate_effective: number };
export type PeriodAdj = { id: string; amount: number; reason: string; settlement: string; status: string };

export type PayrollPeriod = {
  period: string;
  attPayroll: Map<string, AttPayroll>;
  attendanceAgg: Map<string, { present: number; absent: number; leave: number }>;
  payslipsMap: Map<string, any>;
  advancesByEmployee: Map<string, number>;
  priorLeavesByMonth: Map<string, Map<string, number>>;
  leaveOverrides: Map<string, { allowed: number; reason: string | null }>;
  carriedAdj: Map<string, { carried: number; detail: string }>;
  periodAdj: Map<string, PeriodAdj[]>;
  leaveSummary: Map<string, LeaveSummary>;
  relieverPerClient: Map<string, Map<string, number>>;
};

export async function loadPayrollPeriod(period: string, relieversOnly: boolean): Promise<PayrollPeriod> {
  const s = sb();
  const start = period;
  const end = endOfMonthStr(period);
  const [py, pm] = period.split("-").map(Number);
  const cws = new Date(py, pm - 1 - 12, 1);
  const carryWindowStartIso = `${cws.getFullYear()}-${String(cws.getMonth() + 1).padStart(2, "0")}-01`;
  const [attRes, payRes, advRes, attHistRes, apRes, lvRes, carRes, adjRes, lsRes] = await Promise.all([
    rpc<any[]>("attendance_period_counts", { p_start: start, p_end: end }),
    q<any[]>(s.from("payslips").select("*").eq("period_month", period)),
    rpc<any[]>("employee_advance_outstanding", { p_period_start: start }),
    rpc<any[]>("attendance_leave_history", { p_window_start: carryWindowStartIso, p_until: start }),
    rpc<any[]>("attendance_payroll", { p_start: start, p_end: end }),
    q<any[]>(s.from("employee_leave_overrides").select("employee_id, allowed_leaves, reason").eq("period_month", period)),
    rpc<any[]>("carried_adjustments_for", { p_period_month: period }),
    q<any[]>(s.from("payroll_adjustments").select("id, employee_id, amount, reason, settlement, status").eq("original_period_month", period)),
    rpc<any[]>("leave_period_summary", { p_period_start: period }),
  ]);
  const leaveSummary = new Map<string, LeaveSummary>(((lsRes ?? []) as any[]).map((r) => [r.employee_id, {
    present_days: Number(r.present_days), tier: Number(r.tier), quota: Number(r.quota), earned: Number(r.earned),
    lost: Number(r.lost), opening: Number(r.opening), available: Number(r.available), taken: Number(r.taken),
    unpaid: Number(r.unpaid), closing: Number(r.closing),
  }]));
  const carriedAdj = new Map(((carRes ?? []) as any[]).map((r) => [r.employee_id, { carried: Number(r.carried) || 0, detail: r.detail ?? "" }]));
  const periodAdj = new Map<string, PeriodAdj[]>();
  for (const r of adjRes) {
    const list = periodAdj.get(r.employee_id) ?? [];
    list.push({ id: r.id, amount: Number(r.amount), reason: r.reason, settlement: r.settlement, status: r.status });
    periodAdj.set(r.employee_id, list);
  }
  const leaveOverrides = new Map(lvRes.map((r) => [r.employee_id, { allowed: Number(r.allowed_leaves), reason: r.reason as string | null }]));
  const attPayroll = new Map<string, AttPayroll>();
  for (const r of (apRes ?? []) as any[]) {
    attPayroll.set(r.employee_id, {
      worked_shifts: Number(r.worked_shifts) || 0,
      present_days: Number(r.present_days ?? r.worked_shifts) || 0,
      double_duty_shifts: Number(r.double_duty_shifts) || 0,
      earned: Number(r.earned) || 0,
      leave_days: Number(r.leave_days) || 0,
      absent_days: Number(r.absent_days) || 0,
      rate_effective: Number(r.rate_effective) || 0,
    });
  }
  const attendanceAgg = new Map<string, { present: number; absent: number; leave: number }>();
  for (const a of (attRes ?? []) as any[]) {
    const cur = attendanceAgg.get(a.employee_id) ?? { present: 0, absent: 0, leave: 0 };
    const cnt = Number(a.cnt) || 0;
    const st = String(a.status).toLowerCase();
    if (st === "present" || st === "double_duty" || st === "relief_cover") cur.present += cnt;
    else if (st === "absent") cur.absent += cnt;
    else if (st === "leave" || st === "rotation_leave" || st === "rest_day") cur.leave += cnt;
    attendanceAgg.set(a.employee_id, cur);
  }
  const relieverPerClient = new Map<string, Map<string, number>>();
  if (relieversOnly) {
    const relRows = await q<any[]>(s.from("attendance_records").select("employee_id, worked_for_client_id")
      .gte("attendance_date", start).lte("attendance_date", end).in("status", ["Present", "present", "double_duty", "relief_cover"]));
    for (const r of relRows) {
      const key = r.worked_for_client_id ?? "unattributed";
      const inner = relieverPerClient.get(r.employee_id) ?? new Map<string, number>();
      inner.set(key, (inner.get(key) ?? 0) + 1);
      relieverPerClient.set(r.employee_id, inner);
    }
  }
  const payslipsMap = new Map<string, any>(payRes.map((p) => [p.employee_id, p]));
  const advancesByEmployee = new Map<string, number>(((advRes ?? []) as any[]).map((a) => [a.employee_id, Number(a.outstanding) || 0]));
  const priorLeavesByMonth = new Map<string, Map<string, number>>();
  for (const r of (attHistRes ?? []) as any[]) {
    const monthKey = String(r.month_key ?? "").slice(0, 7);
    if (!monthKey) continue;
    if (!priorLeavesByMonth.has(r.employee_id)) priorLeavesByMonth.set(r.employee_id, new Map());
    const m = priorLeavesByMonth.get(r.employee_id)!;
    m.set(monthKey, (m.get(monthKey) ?? 0) + Number(r.cnt));
  }
  return { period, attPayroll, attendanceAgg, payslipsMap, advancesByEmployee, priorLeavesByMonth, leaveOverrides, carriedAdj, periodAdj, leaveSummary, relieverPerClient };
}

// ------------------------------------------------------------------ compute
/** The web `rows` memo, with allowedLeavesByEmployee / eobiByEmployee / carriedAllowance folded in. */
export function computeRows(base: PayrollBase, pd: PayrollPeriod, rowEdits: Map<string, Partial<RowState>>): RowState[] {
  const selectedPeriod = pd.period;
  const clientById = new Map(base.clients.map((c) => [c.id, c]));
  const contractById = new Map(base.contracts.map((c) => [c.id, c]));
  const allowedOf = (e: PayEmployee) => resolveAllowedLeaves(e.contract_id ? contractById.get(e.contract_id) : null, e.client_id ? clientById.get(e.client_id) : null);
  const eobiOf = (e: PayEmployee) => resolveEobiAmount(e.contract_id ? contractById.get(e.contract_id) : null, e.client_id ? clientById.get(e.client_id) : null);

  const [py, pm] = selectedPeriod.split("-").map(Number);
  const carried = new Map<string, number>();
  for (const emp of base.employees) {
    if (!emp.client_id) continue;
    const client = clientById.get(emp.client_id);
    if (!client?.leave_carry_forward) continue;
    const b = allowedOf(emp);
    const selKey = `${py}-${String(pm).padStart(2, "0")}`;
    const openingMonth = emp.opening_leaves_month;
    const openingActive = emp.opening_leaves != null && !!openingMonth && openingMonth.slice(0, 7) <= selKey;
    const startStr = openingActive ? openingMonth : client.leave_carry_start ?? null;
    const monthKeys: string[] = [];
    if (startStr) {
      let y = Number(startStr.slice(0, 4));
      let mo = Number(startStr.slice(5, 7));
      while (y < py || (y === py && mo < pm)) {
        monthKeys.push(`${y}-${String(mo).padStart(2, "0")}`);
        mo += 1;
        if (mo > 12) { mo = 1; y += 1; }
      }
    }
    const empLeaves = pd.priorLeavesByMonth.get(emp.id) ?? new Map<string, number>();
    let allowed = openingActive ? b + Number(emp.opening_leaves ?? 0) : b;
    for (const k of monthKeys) {
      const used = empLeaves.get(k) ?? 0;
      allowed = b + Math.max(0, allowed - used);
    }
    carried.set(emp.id, allowed);
  }

  const daysThisPeriod = daysInMonth(selectedPeriod);
  return base.employees.map((emp) => {
    const existing = pd.payslipsMap.get(emp.id);
    const ap = pd.attPayroll.get(emp.id);
    const att = ap ? { present: ap.present_days, absent: ap.absent_days, leave: ap.leave_days } : (pd.attendanceAgg.get(emp.id) ?? { present: 0, absent: 0, leave: 0 });
    const doubleDuty = ap?.double_duty_shifts ?? 0;
    const baseSal = Number(existing?.base_salary ?? emp.base_salary ?? 0);
    const computedAdvance = pd.advancesByEmployee.get(emp.id) ?? 0;
    const baseAllowed = allowedOf(emp);
    const carryAllowed = carried.get(emp.id);
    const overrideAllowed = pd.leaveOverrides.get(emp.id)?.allowed;
    const ls = pd.leaveSummary.get(emp.id);
    const allowed = overrideAllowed ?? (ls ? ls.available : carryAllowed ?? baseAllowed);
    const defaults: RowState = {
      employee: emp, period_month: selectedPeriod, working_days: daysThisPeriod,
      present_days: att.present, absent_days: att.absent, leave_days: att.leave,
      base_salary: baseSal, per_day_salary: null,
      bonus: Number(existing?.bonus ?? 0), deductions: Number(existing?.deductions ?? 0),
      advance: computedAdvance, income_tax: 0, eobi: 0,
      allowance: Number(existing?.allowance ?? emp.allowance ?? 0),
      final_salary: 0, net_salary: 0,
      amount_paid: Number(existing?.amount_paid ?? 0),
      payment_mode: (existing?.payment_mode ?? "Cash") as PaymentMode,
      bank_account_id: existing?.bank_account_id ?? null,
      cheque_id: existing?.cheque_id ?? null,
      status: (existing?.status ?? "Pending") as PayslipStatus,
      disbursed: existing?.disbursed ?? false,
      disbursed_at: existing?.disbursed_at ?? null,
      notes: existing?.notes ?? null,
      payslip_id: existing?.id ?? null,
      override_leaves: existing?.override_leaves ?? false,
      allowed_leaves: allowed,
      effective_present_days: 0, effective_absent_days: 0, extra_leave_absent: 0,
      double_duty_shifts: doubleDuty, days_over_month: 0,
      adjustment_carried: existing?.disbursed ? Number(existing.adjustment_carried ?? 0) : pd.carriedAdj.get(emp.id)?.carried ?? 0,
      adjustment_detail: pd.carriedAdj.get(emp.id)?.detail ?? null,
    };
    const merged: RowState = { ...defaults, ...(rowEdits.get(emp.id) ?? {}) };
    merged.advance = computedAdvance;
    merged.allowed_leaves = allowed;
    merged.double_duty_shifts = doubleDuty;

    const capTotal = merged.present_days + merged.absent_days + merged.leave_days;
    merged.days_over_month = Math.max(0, capTotal - daysThisPeriod);
    if (merged.days_over_month > 0) {
      let excess = merged.days_over_month;
      const trimLeave = Math.min(excess, merged.leave_days);
      merged.leave_days -= trimLeave;
      excess -= trimLeave;
      if (excess > 0) merged.absent_days = Math.max(0, merged.absent_days - excess);
    }
    const rawLeaves = merged.leave_days;
    const rawPresent = merged.present_days;
    const rawAbsent = merged.absent_days;
    let countableLeaves: number;
    let extraLeaveAbsent: number;
    if (merged.override_leaves) { countableLeaves = rawLeaves; extraLeaveAbsent = 0; }
    else { countableLeaves = Math.min(rawLeaves, merged.allowed_leaves); extraLeaveAbsent = Math.max(0, rawLeaves - merged.allowed_leaves); }
    merged.effective_present_days = rawPresent + countableLeaves + merged.double_duty_shifts;
    merged.extra_leave_absent = extraLeaveAbsent;
    merged.effective_absent_days = rawAbsent + extraLeaveAbsent;

    const rateEff = ap && ap.rate_effective > 0 ? ap.rate_effective : merged.base_salary;
    const perDay = daysThisPeriod > 0 && rateEff > 0 ? rateEff / daysThisPeriod : 0;
    merged.per_day_salary = perDay > 0 ? Math.round(perDay) : null;
    const earnedWorked = ap ? ap.earned : perDay * rawPresent;
    const paidLeavePay = perDay * countableLeaves;
    const earned = Math.round(earnedWorked + paidLeavePay);
    const earnedSalary = Math.max(0, Math.round(earned + merged.bonus - merged.deductions));
    merged.income_tax = earnedSalary > 50000 ? Math.round((earnedSalary - 50000) * 0.01) : 0;
    merged.eobi = eobiOf(emp);
    merged.final_salary = earnedSalary + Math.round(merged.allowance);
    const deductible = Math.max(0, merged.final_salary - merged.income_tax - merged.eobi);
    merged.advance = Math.min(computedAdvance, deductible);
    merged.adjustment_carried = defaults.adjustment_carried;
    merged.net_salary = Math.max(0, deductible - merged.advance + merged.adjustment_carried);
    return merged;
  });
}

export type RowFilter = {
  relieversOnly?: boolean; clientScopeId?: string | null; categoryScope?: string | null;
  search?: string; clientFilter?: string; siteFilter?: string; statusFilter?: "all" | PayslipStatus;
  disbursedFilter?: "all" | "yes" | "no"; empTab?: "all" | "active" | "inactive";
  categoryFilter?: "all" | "client" | "office_staff" | "reliever"; shiftFilter?: "all" | "day" | "night";
};

export function empDisplay(base: PayrollBase, emp: PayEmployee) {
  return guardDisplayCode(emp, base.clients.find((c) => c.id === emp.client_id)?.employee_id_prefix ?? null);
}

/** The web `filtered` memo, then `sortedRows` (undisbursed first, stable). */
export function filterRows(base: PayrollBase, rows: RowState[], f: RowFilter): RowState[] {
  const qs = (f.search ?? "").trim().toLowerCase();
  const out = rows.filter((r) => {
    const e = r.employee;
    if (f.categoryScope) { if ((e.category ?? "client") !== f.categoryScope) return false; }
    else {
      if (f.relieversOnly && e.category !== "reliever") return false;
      if (!f.relieversOnly && e.category === "reliever") return false;
    }
    if (qs && !e.full_name.toLowerCase().includes(qs) && !e.employee_code.toLowerCase().includes(qs) &&
      !empDisplay(base, e).toLowerCase().includes(qs) && !(e.phone ?? "").toLowerCase().includes(qs)) return false;
    if (f.shiftFilter && f.shiftFilter !== "all" && e.shift !== f.shiftFilter) return false;
    if (f.clientScopeId && e.client_id !== f.clientScopeId) return false;
    if (f.clientFilter && f.clientFilter !== "all" && e.client_id !== f.clientFilter) return false;
    if (f.siteFilter && f.siteFilter !== "all" && base.siteByGuard.get(e.id) !== f.siteFilter) return false;
    if (f.statusFilter && f.statusFilter !== "all" && r.status !== f.statusFilter) return false;
    if (f.disbursedFilter && f.disbursedFilter !== "all" && (f.disbursedFilter === "yes" ? !r.disbursed : r.disbursed)) return false;
    const separated = isSeparatedState(e.lifecycle_state);
    if (f.empTab === "active" && separated) return false;
    if (f.empTab === "inactive" && !separated) return false;
    const hasAttendance = r.present_days > 0 || r.absent_days > 0 || r.leave_days > 0;
    if (!hasAttendance && !r.payslip_id && r.advance === 0) return false;
    if (f.categoryFilter && f.categoryFilter !== "all" && (e.category ?? "client") !== f.categoryFilter) return false;
    return true;
  });
  return out.sort((a, b) => Number(!!a.disbursed) - Number(!!b.disbursed));
}

export function payrollTotals(rows: RowState[]) {
  let disbursed = 0, notDisbursed = 0, advance = 0, disbursedCount = 0, notDisbursedCount = 0;
  for (const r of rows) {
    advance += r.advance;
    const paid = Math.round(r.amount_paid || 0);
    disbursed += paid;
    notDisbursed += Math.max(0, Math.round(r.net_salary) - paid);
    if (paid > 0) disbursedCount++; else notDisbursedCount++;
  }
  return { disbursed, notDisbursed, advance, disbursedCount, notDisbursedCount };
}

/** onRows: the live computed roster in exporter shape. */
export function exportRowOf(base: PayrollBase, r: RowState): PayrollExportRow {
  return {
    employeeCode: empDisplay(base, r.employee),
    guardCode: r.employee.guard_code ?? r.employee.employee_code ?? "",
    name: r.employee.full_name ?? "",
    hasPayslip: true,
    presentDays: Number(r.present_days ?? 0), absentDays: Number(r.absent_days ?? 0), leaveDays: Number(r.leave_days ?? 0),
    baseSalary: Math.round(Number(r.base_salary ?? 0)), allowance: Math.round(Number(r.allowance ?? 0)), bonus: Math.round(Number(r.bonus ?? 0)),
    finalSalary: Math.round(Number(r.final_salary ?? 0)), advance: Math.round(Number(r.advance ?? 0)), eobi: Math.round(Number(r.eobi ?? 0)),
    incomeTax: Math.round(Number(r.income_tax ?? 0)), deductions: Math.round(Number(r.deductions ?? 0)), netSalary: Math.round(Number(r.net_salary ?? 0)),
    amountPaid: Math.round(Number(r.amount_paid ?? 0)), paymentMode: r.payment_mode ?? "",
    status: r.disbursed ? "Disbursed" : (r.status ?? "Pending"),
  } as PayrollExportRow;
}

export function chequeRemaining(base: PayrollBase, chequeId: string, excludeOwnAmount = 0) {
  const c = base.cheques.find((x) => x.id === chequeId);
  if (!c) return 0;
  return Number(c.amount) - (base.chequeLinkedSums.get(chequeId) ?? 0) + excludeOwnAmount;
}

// ------------------------------------------------------------------- writes
function assertPaidNotOverAccrued(row: RowState) {
  const paid = Math.round(row.amount_paid ?? 0);
  const net = Math.round(row.net_salary ?? 0);
  if (paid <= net) return;
  throw new Error(
    `${row.employee.full_name ?? "This employee"} has been paid PKR ${paid.toLocaleString()} against a Net Salary of PKR ${net.toLocaleString()}, so this payslip cannot be saved — ` +
    "a payslip cannot disburse more than it accrued. This usually means attendance was reduced after the payment went out. " +
    `Either restore the attendance so the Net covers what was paid, or return PKR ${(paid - net).toLocaleString()} by lowering Amount Paid.`,
  );
}

export function buildPayslipPayload(row: RowState) {
  assertPaidNotOverAccrued(row);
  return {
    employee_id: row.employee.id, period_month: row.period_month, working_days: row.working_days,
    present_days: row.present_days, absent_days: row.absent_days, leave_days: row.leave_days,
    base_salary: row.base_salary, per_day_salary: row.per_day_salary, bonus: row.bonus, deductions: row.deductions,
    advance: row.advance, income_tax: row.income_tax, eobi: row.eobi, allowance: row.allowance,
    final_salary: row.final_salary, net_salary: row.net_salary, amount_paid: row.amount_paid ?? 0,
    payment_mode: row.payment_mode,
    bank_account_id: row.payment_mode === "Bank" || row.payment_mode === "Cheque" ? row.bank_account_id : null,
    cheque_id: row.payment_mode === "Cheque" ? row.cheque_id : null,
    status: row.status, disbursed: row.disbursed, disbursed_at: row.disbursed_at, notes: row.notes,
    override_leaves: row.override_leaves, adjustment_carried: row.adjustment_carried ?? 0,
    updated_at: new Date().toISOString(),
  };
}

export async function savePayslip(row: RowState) {
  await q(sb().from("payslips").upsert(buildPayslipPayload(row) as never, { onConflict: "employee_id,period_month" }));
}

/** afterNet auto-save: every visible row without a payslip gets one, in one batched upsert. */
export async function autoSaveMissing(rows: RowState[]) {
  const missing = rows.filter((r) => !r.payslip_id);
  if (missing.length === 0) return false;
  await q(sb().from("payslips").upsert(missing.map((r) => buildPayslipPayload(r)) as never, { onConflict: "employee_id,period_month" }));
  return true;
}

async function syncOverpayAdvance(employeeId: string, periodMonth: string, overpay: number) {
  await rpc("sync_overpayment_carry_forward", { p_employee_id: employeeId, p_period_month: periodMonth, p_overpay: overpay });
}

/** handleSaveRow: records edits, re-derives disbursed from what is already paid, carries an overpayment. */
export async function saveRow(row: RowState) {
  const paid = Math.round(row.amount_paid || 0);
  const net = Math.round(row.net_salary);
  const disbursed = isSettled(paid, net);
  await savePayslip({ ...row, disbursed, disbursed_at: disbursed ? row.disbursed_at ?? new Date().toISOString() : null, status: disbursed ? "Cleared" : row.status });
  await syncOverpayAdvance(row.employee.id, row.period_month, paid - net);
}

export async function toggleStatus(row: RowState) {
  await savePayslip({ ...row, status: row.status === "Cleared" ? "Pending" : "Cleared" });
}

export async function markAllCleared(rows: RowState[]) {
  for (const row of rows.filter((r) => r.status === "Pending")) await savePayslip({ ...row, status: "Cleared" });
}

export async function saveLeaveOverride(employeeId: string, period: string, raw: string, reason: string) {
  const trimmed = raw.trim();
  if (trimmed === "") {
    await q(sb().from("employee_leave_overrides").delete().eq("employee_id", employeeId).eq("period_month", period));
    return;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) throw new Error("Allowed leaves must be 0 or more.");
  await q(sb().from("employee_leave_overrides").upsert({
    employee_id: employeeId, period_month: period, allowed_leaves: value, reason: reason.trim() || null, created_by: await uid(),
  } as never, { onConflict: "employee_id,period_month" }));
}

export async function raiseAdjustment(payslipId: string, amount: string, reason: string, settlement: "pay_now" | "carry_forward") {
  const { error } = await sb().rpc("raise_payroll_adjustment" as never, { p_payslip_id: payslipId, p_amount: Number(amount), p_reason: reason.trim(), p_settlement: settlement } as never);
  if (error) throw new Error(friendlyDbError(error));
}

/** Result of a settle: `soft` is the web's rowError that is not a failure (stale / unchanged). */
export type SettleResult = { ok: true } | { ok: false; message: string; reload?: boolean };

let disburseLock = false;

/**
 * settlePayment: pay the DELTA up to `targetPaid`. Figures are upserted first (the
 * Zahid Anwar fix), the CAS baseline is checked, then disburse_payslip claims and
 * moves the balance in one transaction.
 */
export async function settlePayment(base: PayrollBase, companyId: string | null, row: RowState, targetPaid: number, custodianEmpId: string, dateOverride?: string): Promise<SettleResult> {
  if (disburseLock) return { ok: false, message: "A payment is already in progress." };
  disburseLock = true;
  try {
    const already = Math.round(row.amount_paid || 0);
    const target = Math.max(0, Math.round(targetPaid));
    const net = Math.round(row.net_salary);
    const pay = target - already;
    if (pay === 0) return { ok: false, message: "Amount Paid is unchanged — nothing to settle." };
    if (target > net) {
      return { ok: false, message: `Amount Paid cannot exceed Net Salary. This payslip accrued PKR ${net.toLocaleString()} — paying PKR ${target.toLocaleString()} would disburse money that was never earned. If more days were worked, correct the attendance first so the Net rises with it.` };
    }
    const disburseIso = dateOverride ? new Date(`${dateOverride}T12:00:00`).toISOString() : new Date().toISOString();
    let custodianLocId: string | null = null;
    if (row.payment_mode === "Bank") {
      if (!row.bank_account_id) return { ok: false, message: "Select a bank account before disbursing." };
      const bank = base.banks.find((b) => b.id === row.bank_account_id);
      if (!bank) return { ok: false, message: "Bank account not found." };
      if (pay > 0 && pay > Number(bank.balance)) return { ok: false, message: "Selected bank account balance is insufficient for this payment." };
    } else if (row.payment_mode === "Cheque") {
      if (pay > 0) {
        if (!row.cheque_id) return { ok: false, message: "Select a cheque before disbursing." };
        const ownPrev = row.payslip_id ? Number(row.net_salary) : 0;
        const remaining = chequeRemaining(base, row.cheque_id, ownPrev);
        if (pay > remaining + 0.005) return { ok: false, message: `Payment (PKR ${pay.toLocaleString()}) exceeds the cheque's remaining capacity (PKR ${remaining.toLocaleString()}).` };
      }
    } else {
      if (pay > 0 && pay > base.cashBalance) return { ok: false, message: "Cash balance is insufficient for this payment." };
      if (!custodianEmpId) return { ok: false, message: "Select who is paying this cash (custodian)." };
      const staff = base.custodians.find((c) => c.employeeId === custodianEmpId);
      if (!companyId || !staff) return { ok: false, message: "Custodian not found — reload and try again." };
      custodianLocId = await ensureCustodianLocation(companyId, staff.employeeId, staff.fullName);
    }
    const up = await q<{ id: string; amount_paid: number }>(sb().from("payslips")
      .upsert(buildPayslipPayload({ ...row, amount_paid: already }) as never, { onConflict: "employee_id,period_month" })
      .select("id, amount_paid").single());
    if (Math.round(Number(up.amount_paid)) !== already) return { ok: false, message: "This payslip changed on another device — reloading.", reload: true };
    const label = `${formatPeriod(row.period_month)} · ${row.employee.employee_code} ${row.employee.full_name}`;
    const payDesc = row.payment_mode === "Cash"
      ? `${pay < 0 ? "Reverse payroll (cash)" : "Payroll (cash)"} ${label}`
      : `${pay < 0 ? "Reverse payroll" : "Payroll"} ${label}`;
    const { error: rpcErr } = await sb().rpc("disburse_payslip" as never, {
      p_payslip_id: up.id, p_expected_paid: already, p_target_paid: target, p_payment_mode: row.payment_mode,
      p_bank_account_id: row.payment_mode === "Bank" || row.payment_mode === "Cheque" ? row.bank_account_id : null,
      p_cheque_id: row.payment_mode === "Cheque" ? row.cheque_id : null,
      p_custodian_location_id: row.payment_mode === "Cash" ? custodianLocId : null,
      p_disbursed_at: disburseIso, p_description: payDesc,
    } as never);
    if (rpcErr) {
      if (/PAYSLIP_STALE/.test(rpcErr.message)) return { ok: false, message: "This payslip changed on another device — reloading.", reload: true };
      throw new Error(rpcErr.message);
    }
    await syncOverpayAdvance(row.employee.id, row.period_month, target - net);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: friendlyError(e), reload: true };
  } finally {
    disburseLock = false;
  }
}

/** handleBulkDisburse: each candidate paid its remaining Balance, figures written first, stale rows skipped. */
export async function bulkDisburse(base: PayrollBase, companyId: string | null, candidatesIn: RowState[], opts: { mode: PaymentMode; bankId: string; custodianEmpId: string; date: string; canViewBanking: boolean }): Promise<{ done: number; total: number }> {
  if (disburseLock) throw new Error("A payment is already in progress.");
  const remainingOf = (r: RowState) => Math.round(r.net_salary) - Math.round(r.amount_paid || 0);
  const candidates = candidatesIn.filter((r) => remainingOf(r) > 0);
  if (candidates.length === 0) throw new Error("No unpaid balances in the current selection to disburse.");
  if (opts.mode === "Bank" && !opts.bankId) throw new Error("Select a bank account for bulk disbursement.");
  const total = candidates.reduce((sum, r) => sum + remainingOf(r), 0);
  let locId: string | null = null;
  if (opts.mode === "Cash") {
    if (total > base.cashBalance) throw new Error(`Cash balance (PKR ${base.cashBalance.toLocaleString()}) is insufficient for PKR ${total.toLocaleString()}.`);
    if (!opts.custodianEmpId) throw new Error("Select who is paying this cash (custodian) for the bulk disbursement.");
    const staff = base.custodians.find((c) => c.employeeId === opts.custodianEmpId);
    if (!companyId || !staff) throw new Error("Custodian not found — reload and try again.");
    locId = await ensureCustodianLocation(companyId, staff.employeeId, staff.fullName);
  } else {
    const bank = base.banks.find((b) => b.id === opts.bankId);
    if (!bank) throw new Error("Selected bank account not found.");
    if (total > Number(bank.balance)) {
      throw new Error(opts.canViewBanking
        ? `Bank balance (PKR ${Number(bank.balance).toLocaleString()}) is insufficient for PKR ${total.toLocaleString()}.`
        : `Selected bank account balance is insufficient for this payment (PKR ${total.toLocaleString()}).`);
    }
  }
  disburseLock = true;
  const iso = new Date(`${opts.date}T12:00:00`).toISOString();
  let done = 0;
  try {
    for (const row of candidates) {
      const net = Math.round(row.net_salary);
      const already = Math.round(row.amount_paid || 0);
      const up = await q<{ id: string; amount_paid: number }>(sb().from("payslips")
        .upsert(buildPayslipPayload({ ...row, payment_mode: opts.mode, bank_account_id: opts.mode === "Bank" ? opts.bankId : null, amount_paid: already }) as never, { onConflict: "employee_id,period_month" })
        .select("id, amount_paid").single());
      if (Math.round(Number(up.amount_paid)) !== already) {
        throw new Error(`${row.employee.full_name ?? row.employee.employee_code} was paid on another device while this batch was running — reload and disburse the rest.`);
      }
      const label = `${formatPeriod(row.period_month)} · ${row.employee.employee_code} ${row.employee.full_name}`;
      const { error: rpcErr } = await sb().rpc("disburse_payslip" as never, {
        p_payslip_id: up.id, p_expected_paid: already, p_target_paid: net, p_payment_mode: opts.mode,
        p_bank_account_id: opts.mode === "Bank" ? opts.bankId : null, p_cheque_id: null,
        p_custodian_location_id: opts.mode === "Cash" ? locId : null, p_disbursed_at: iso,
        p_description: opts.mode === "Cash" ? `Payroll (cash) ${label}` : `Payroll ${label}`,
      } as never);
      if (rpcErr) {
        if (/PAYSLIP_STALE/.test(rpcErr.message)) continue;
        throw new Error(`${row.employee.employee_code} ${row.employee.full_name}: ${rpcErr.message}`);
      }
      done++;
    }
    return { done, total: candidates.length };
  } catch (e) {
    const suffix = done > 0 ? ` — ${done} of ${candidates.length} disbursed before this failed.` : "";
    throw new Error(friendlyError(e) + suffix);
  } finally {
    disburseLock = false;
  }
}

// ---------------------------------------------------------------- payslip PDF
export function downloadPayslipPdf(base: PayrollBase, pd: PayrollPeriod, row: RowState) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  let y = 60;
  doc.setFontSize(18);
  doc.text("Payslip", 40, y);
  y += 24;
  doc.setFontSize(11);
  doc.setTextColor(90);
  doc.text(`Period: ${formatPeriod(row.period_month)}`, 40, y); y += 16;
  doc.text(`Employee: ${row.employee.full_name} (${empDisplay(base, row.employee)})`, 40, y); y += 16;
  if (row.employee.phone) { doc.text(`Phone: ${row.employee.phone}`, 40, y); y += 16; }
  y += 10;
  doc.setTextColor(0);
  doc.setFontSize(13);
  doc.text("Summary", 40, y);
  y += 18;
  doc.setFontSize(11);
  const line = (label: string, value: string) => { doc.text(label, 40, y); doc.text(value, 520, y, { align: "right" }); y += 16; };
  line("Working Days", String(row.working_days));
  line("Present Days", String(row.present_days));
  if (row.double_duty_shifts > 0) line("Double Duty (extra shifts)", String(row.double_duty_shifts));
  line("Absent Days", String(row.absent_days));
  line("Leave Days", String(row.leave_days));
  line("Allowed Leaves", String(row.allowed_leaves));
  const l = pd.leaveSummary.get(row.employee.id);
  if (l) {
    line("Leave earned", `${l.earned} (${l.present_days} days present → tier ${l.tier} of ${l.quota})${l.lost > 0 ? ` · ${l.lost} lost at the 15-day cap` : ""}`);
    line("Leave balance", `${l.opening} opening → ${l.closing} closing`);
  }
  if (row.override_leaves) line("Leave Override", "Yes (all leaves paid)");
  if (row.extra_leave_absent > 0) line("Absent due to extra leaves", String(row.extra_leave_absent));
  line("Effective Paid Days", `${row.effective_present_days} / ${row.working_days}`);
  y += 6;
  line("Base Salary", `PKR ${row.base_salary.toLocaleString()}`);
  if (row.per_day_salary != null) line("Per Day Salary", `PKR ${Number(row.per_day_salary).toLocaleString()}`);
  line("Earned (Per Day × Paid Days)", `PKR ${Math.round((row.per_day_salary ?? 0) * row.effective_present_days).toLocaleString()}`);
  line("Bonus", `PKR ${row.bonus.toLocaleString()}`);
  line("Deductions", `PKR ${row.deductions.toLocaleString()}`);
  if (row.allowance > 0) line("Allowance", `+ PKR ${Math.round(row.allowance).toLocaleString()}`);
  y += 4;
  doc.setFontSize(12);
  line("Final Salary (Earned + Bonus − Deductions + Allowance)", `PKR ${row.final_salary.toLocaleString()}`);
  doc.setFontSize(11);
  if (row.income_tax > 0) line("Income Tax (1% over PKR 50,000)", `− PKR ${Math.round(row.income_tax).toLocaleString()}`);
  if (row.eobi > 0) line("EOBI", `− PKR ${Math.round(row.eobi).toLocaleString()}`);
  line("Advance", `− PKR ${row.advance.toLocaleString()}`);
  if (row.adjustment_carried && row.adjustment_carried !== 0) {
    line(`Adjustment (${row.adjustment_detail ?? "earlier period"})`, `${row.adjustment_carried > 0 ? "+" : "−"} PKR ${Math.abs(Math.round(row.adjustment_carried)).toLocaleString()}`);
  }
  y += 6;
  doc.setFontSize(14);
  line("Net Salary", `PKR ${row.net_salary.toLocaleString()}`);
  y += 10;
  doc.setFontSize(11);
  line("Payment Mode", row.payment_mode);
  if (row.payment_mode === "Bank" && row.bank_account_id) {
    const bank = base.banks.find((b) => b.id === row.bank_account_id);
    if (bank) line("Bank Account", `${bank.bank_name} · ${bank.account_number}`);
  }
  line("Status", row.status);
  line("Disbursed", row.disbursed ? "Yes" : "No");
  return savePdf(doc, `payslip_${row.employee.employee_code}_${row.period_month}.pdf`);
}

// ------------------------------------------------- Payroll page shell (FV only)
export type Scope = { key: string; name: string; clientId: string | null; category: string | null; verifiable?: boolean };
export type ShellTotals = { disbursed: number; notDisbursed: number; advance: number; disbursedCount: number; notDisbursedCount: number };
export const ZERO_SHELL: ShellTotals = { disbursed: 0, notDisbursed: 0, advance: 0, disbursedCount: 0, notDisbursedCount: 0 };

function payslipExportRow(r: any, meta?: { code: string; guardCode: string; name: string }): PayrollExportRow {
  return {
    employeeCode: meta?.code ?? "", guardCode: meta?.guardCode ?? "", name: meta?.name ?? "", hasPayslip: true,
    presentDays: Number(r.present_days ?? 0), absentDays: Number(r.absent_days ?? 0), leaveDays: Number(r.leave_days ?? 0),
    baseSalary: Math.round(Number(r.base_salary ?? 0)), allowance: Math.round(Number(r.allowance ?? 0)), bonus: Math.round(Number(r.bonus ?? 0)),
    finalSalary: Math.round(Number(r.final_salary ?? 0)), advance: Math.round(Number(r.advance ?? 0)), eobi: Math.round(Number(r.eobi ?? 0)),
    incomeTax: Math.round(Number(r.income_tax ?? 0)), deductions: Math.round(Number(r.deductions ?? 0)), netSalary: Math.round(Number(r.net_salary ?? 0)),
    amountPaid: Math.round(Number(r.amount_paid ?? 0)), paymentMode: r.payment_mode ?? "",
    status: r.disbursed ? "Disbursed" : (r.status ?? "Pending"),
  } as PayrollExportRow;
}

/** The /payroll page shell: only scopes Finance-Verified for the month, with their payslip totals and sheets. */
export async function loadFvShell(period: string) {
  const s = sb();
  const phs = await q<any[]>(s.from("payroll_run_phases").select("client_id, category").eq("period_month", period).not("finance_verified_at", "is", null));
  const clientIds = phs.filter((r) => r.client_id).map((r) => r.client_id);
  const nameById = new Map<string, string>();
  const prefixById = new Map<string, string | null>();
  if (clientIds.length) {
    for (const c of await q<any[]>(s.from("clients").select("id, name, employee_id_prefix").in("id", clientIds))) {
      nameById.set(c.id, c.name);
      prefixById.set(c.id, c.employee_id_prefix ?? null);
    }
  }
  const scopes: Scope[] = phs.map((r) => ({
    key: r.client_id ?? `cat:${r.category}`,
    name: r.client_id ? nameById.get(r.client_id) ?? "Client" : catLabel(r.category),
    clientId: r.client_id ?? null, category: r.category ?? null,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const psRows = await q<any[]>(s.from("payslips").select("net_salary, amount_paid, advance, disbursed, employee_id, present_days, absent_days, leave_days, base_salary, allowance, bonus, final_salary, eobi, income_tax, deductions, payment_mode, status").eq("period_month", period));
  const empIds = Array.from(new Set(psRows.map((r) => r.employee_id)));
  const empScope = new Map<string, string>();
  const empMeta = new Map<string, { code: string; guardCode: string; name: string }>();
  if (empIds.length) {
    for (const e of await q<any[]>(s.from("employees").select("id, client_id, category, employee_code, guard_code, display_number, full_name").in("id", empIds))) {
      empScope.set(e.id, e.client_id ?? `cat:${e.category}`);
      empMeta.set(e.id, { code: guardDisplayCode(e, nameById.has(e.client_id) ? prefixById.get(e.client_id) ?? null : null), guardCode: e.guard_code ?? e.employee_code ?? "", name: e.full_name ?? "" });
    }
  }
  const rowsByScope = new Map<string, PayrollExportRow[]>();
  const totals = new Map<string, ShellTotals>();
  for (const r of psRows) {
    const key = empScope.get(r.employee_id);
    if (!key) continue;
    const arr = rowsByScope.get(key) ?? [];
    arr.push(payslipExportRow(r, empMeta.get(r.employee_id)));
    rowsByScope.set(key, arr);
    const cur = totals.get(key) ?? { ...ZERO_SHELL };
    const paid = Math.round(r.amount_paid || 0);
    cur.disbursed += paid;
    cur.notDisbursed += Math.max(0, Math.round(r.net_salary || 0) - paid);
    cur.advance += Math.round(r.advance || 0);
    if (r.disbursed) cur.disbursedCount += 1; else cur.notDisbursedCount += 1;
    totals.set(key, cur);
  }
  for (const arr of rowsByScope.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
  const index = new Map<string, string>();
  for (const [k, arr] of rowsByScope) index.set(k, arr.map((r) => `${r.name} ${r.employeeCode} ${r.guardCode}`).join(" | ").toLowerCase());
  return { scopes, totals, rowsByScope, index };
}

export async function exportSheets(sheets: { name: string; rows: PayrollExportRow[] }[], periodLabel: string) {
  const nonEmpty = sheets.filter((sh) => sh.rows.length > 0);
  if (nonEmpty.length === 0) throw new Error("Nothing to export — no rows in the chosen scopes.");
  await exportPayrollSheets(nonEmpty as never, periodLabel);
}

// ----------------------------------------------------------------- Payroll Run
export type Phase = "review" | "finance_verify";

export async function loadRun(period: string, regionId: string | null) {
  const s = sb();
  let clsQ = s.from("clients").select("id, name, employee_id_prefix").order("name");
  if (regionId) clsQ = clsQ.or(`branch_id.eq.${regionId},branch_id.is.null`);
  let postedQ = s.from("employees").select("client_id, lifecycle_state, category").not("client_id", "is", null).range(0, 9999);
  if (regionId) postedQ = postedQ.eq("branch_id", regionId);
  let rosterQ = s.from("employees").select("id, full_name, employee_code, guard_code, display_number, client_id, category, lifecycle_state, base_salary, allowance")
    .not("lifecycle_state", "in", "(terminated,fired,left,absconded)").neq("category", "reliever").range(0, 9999);
  if (regionId) rosterQ = rosterQ.eq("branch_id", regionId);
  const [cls, cons, catEmps, postedEmps, vers, phs, ps, rosterEmps, halfVers] = await Promise.all([
    q<any[]>(clsQ),
    q<any[]>(s.from("contracts").select("client_id, contract_type, status, start_date, end_date, is_infinite")),
    q<any[]>(s.from("employees").select("category").is("client_id", null).neq("category", "client").neq("lifecycle_state", "archived")),
    q<any[]>(postedQ),
    q<any[]>(s.from("attendance_month_verifications").select("client_id, category, verified_at").eq("period_month", period)),
    q<any[]>(s.from("payroll_run_phases").select("client_id, category, phase, finance_verified_at").eq("period_month", period)),
    q<any[]>(s.from("payslips").select("net_salary, amount_paid, advance, disbursed, employee_id, present_days, absent_days, leave_days, base_salary, allowance, bonus, final_salary, eobi, income_tax, deductions, payment_mode, status").eq("period_month", period)),
    q<any[]>(rosterQ),
    // 0493: attendance is verified per half-month, HR -> Ops -> Finance.
    q<any[]>(s.from("attendance_half_verifications").select("client_id, category, half, finance_verified_at").eq("period_month", period)),
  ]);
  // A scope's month is cleared for payroll when BOTH halves are Finance-verified,
  // or it carries a pre-0493 monthly verification — attendance_month_cleared().
  const clearedAt = new Map<string, string>();
  for (const v of vers) if (v.verified_at) clearedAt.set(v.client_id ?? `cat:${v.category}`, v.verified_at);
  const halvesByKey = new Map<string, string[]>();
  for (const h of halfVers) {
    if (!h.finance_verified_at) continue;
    const k = h.client_id ?? `cat:${h.category}`;
    halvesByKey.set(k, [...(halvesByKey.get(k) ?? []), h.finance_verified_at]);
  }
  for (const [k, ats] of halvesByKey) if (ats.length === 2 && !clearedAt.has(k)) clearedAt.set(k, ats.sort()[1]!);
  const empIds = Array.from(new Set(ps.map((r) => r.employee_id)));
  const empScope = new Map<string, string>();
  if (empIds.length) for (const e of await q<any[]>(s.from("employees").select("id, client_id, category").in("id", empIds))) empScope.set(e.id, e.client_id ?? `cat:${e.category}`);

  const servicesOnly = new Map<string, boolean>();
  for (const k of cons) servicesOnly.set(k.client_id, (servicesOnly.get(k.client_id) ?? true) && k.contract_type === "services");
  const hasWork = new Set<string>([
    ...(phs.map((p) => p.client_id as string | null).filter(Boolean) as string[]),
    ...[...empScope.values()].filter((k) => !k.startsWith("cat:")),
  ]);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const liveContract = new Set<string>();
  for (const k of cons) {
    if (k.status !== "active") continue;
    if (k.start_date && k.start_date > today) continue;
    if (!k.is_infinite && k.end_date && k.end_date < today) continue;
    liveContract.add(k.client_id);
  }
  const livePosted = postedEmps.filter((e) => !isSeparatedState(e.lifecycle_state));
  const staffed = new Set<string>(livePosted.filter((e) => e.category !== "reliever").map((e) => e.client_id));
  const reliefPoolOnly = new Set<string>(livePosted.filter((e) => !staffed.has(e.client_id)).map((e) => e.client_id));
  const clientScopes: Scope[] = cls
    .filter((c) => hasWork.has(c.id) || (!servicesOnly.get(c.id) && !reliefPoolOnly.has(c.id) && (liveContract.has(c.id) || staffed.has(c.id))))
    .map((c) => ({ key: c.id, name: c.name, clientId: c.id, category: null, verifiable: true }));
  const cats = Array.from(new Set(catEmps.map((e) => e.category).filter(Boolean))).sort() as string[];
  const catScopes: Scope[] = cats.map((cat) => ({ key: `cat:${cat}`, name: catLabel(cat), clientId: null, category: cat, verifiable: cat !== "reliever" }));
  const keyOf = (v: any) => v.client_id ?? `cat:${v.category}`;

  const totals = new Map<string, ShellTotals>();
  for (const r of ps) {
    const key = empScope.get(r.employee_id);
    if (!key) continue;
    const cur = totals.get(key) ?? { ...ZERO_SHELL };
    const paid = Math.round(r.amount_paid || 0);
    cur.disbursed += paid;
    cur.notDisbursed += Math.max(0, Math.round(r.net_salary || 0) - paid);
    cur.advance += Math.round(r.advance || 0);
    if (r.disbursed) cur.disbursedCount += 1; else cur.notDisbursedCount += 1;
    totals.set(key, cur);
  }
  const psByEmp = new Map(ps.map((r) => [r.employee_id, r]));
  const prefixByClient = new Map<string, string | null>(cls.map((c) => [c.id, c.employee_id_prefix ?? null]));
  const rowsByScope = new Map<string, PayrollExportRow[]>();
  const indexOut = new Map<string, string[]>();
  for (const e of rosterEmps) {
    const key = e.client_id ?? `cat:${e.category}`;
    const r = psByEmp.get(e.id);
    const code = guardDisplayCode(e, e.client_id ? prefixByClient.get(e.client_id) ?? null : null);
    const arr = rowsByScope.get(key) ?? [];
    arr.push({
      employeeCode: code, guardCode: e.guard_code ?? e.employee_code ?? "", name: e.full_name ?? "", hasPayslip: !!r,
      presentDays: Number(r?.present_days ?? 0), absentDays: Number(r?.absent_days ?? 0), leaveDays: Number(r?.leave_days ?? 0),
      baseSalary: Math.round(Number(r?.base_salary ?? e.base_salary ?? 0)), allowance: Math.round(Number(r?.allowance ?? e.allowance ?? 0)),
      bonus: Math.round(Number(r?.bonus ?? 0)), finalSalary: Math.round(Number(r?.final_salary ?? 0)), advance: Math.round(Number(r?.advance ?? 0)),
      eobi: Math.round(Number(r?.eobi ?? 0)), incomeTax: Math.round(Number(r?.income_tax ?? 0)), deductions: Math.round(Number(r?.deductions ?? 0)),
      netSalary: Math.round(Number(r?.net_salary ?? 0)), amountPaid: Math.round(Number(r?.amount_paid ?? 0)), paymentMode: r?.payment_mode ?? "",
      status: !r ? "No payslip yet" : r.disbursed ? "Disbursed" : (r.status ?? "Pending"),
    } as PayrollExportRow);
    rowsByScope.set(key, arr);
    const idx = indexOut.get(key) ?? [];
    idx.push(`${e.full_name ?? ""} ${e.employee_code ?? ""} ${e.guard_code ?? ""} ${code}`.toLowerCase());
    indexOut.set(key, idx);
  }
  for (const arr of rowsByScope.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
  return {
    scopes: [...clientScopes, ...catScopes],
    verified: new Set(clearedAt.keys()),
    verifiedAt: clearedAt,
    phaseByKey: new Map<string, Phase>(phs.map((p) => [keyOf(p), p.phase])),
    financeVerified: new Set(phs.filter((p) => p.finance_verified_at).map(keyOf)),
    financeVerifiedAt: new Map<string, string>(phs.filter((p) => p.finance_verified_at).map((p) => [keyOf(p), p.finance_verified_at])),
    totals, rowsByScope,
    searchIndex: new Map([...indexOut].map(([k, v]) => [k, v.join(" | ")])),
  };
}
export type RunData = Awaited<ReturnType<typeof loadRun>>;

function scoped<T>(qb: T, sc: Scope): T {
  const b = qb as any;
  return (sc.clientId ? b.eq("client_id", sc.clientId) : b.eq("category", sc.category)) as T;
}

export async function moveToReview(sc: Scope, period: string, profileId: string | null) {
  if (sc.verifiable) {
    const cleared = await q<boolean>(sb().rpc("attendance_month_cleared", {
      p_client_id: sc.clientId, p_category: sc.clientId ? null : sc.category, p_period_month: period,
    } as never));
    if (!cleared) throw new Error(`${sc.name}'s attendance for ${formatPeriod(period)} isn't verified yet — both halves need HR, Ops and Finance verification on the Monthly Board.`);
  }
  await q(sb().from("payroll_run_phases").insert({ client_id: sc.clientId, category: sc.category, period_month: period, phase: "review", moved_by: profileId } as never));
}
export async function backToDraft(sc: Scope, period: string) {
  await q(scoped(sb().from("payroll_run_phases").delete().eq("period_month", period), sc));
}
export async function setPhase(sc: Scope, period: string, phase: Phase, profileId: string | null) {
  await q(scoped(sb().from("payroll_run_phases").update({ phase, moved_by: profileId, moved_at: new Date().toISOString() } as never).eq("period_month", period), sc));
}
export async function financeVerify(scopes: Scope[], period: string, profileId: string | null) {
  for (const sc of scopes) {
    await q(scoped(sb().from("payroll_run_phases").update({ finance_verified_at: new Date().toISOString(), finance_verified_by: profileId } as never).eq("period_month", period), sc));
  }
}

// ---------------------------------------------------------------- Adjustments
export type AdjustmentRow = {
  id: string; employee_id: string; original_period_month: string; amount: number; reason: string; settlement: string; status: string;
  raised_at: string; cancelled_reason: string | null; settled_payslip_id: string | null;
  full_name: string; guard_code: string | null; settled_period: string | null;
};
export async function loadAdjustments(): Promise<AdjustmentRow[]> {
  const s = sb();
  const [a, e, p] = await Promise.all([
    q<any[]>(s.from("payroll_adjustments").select("*").order("original_period_month", { ascending: false }).order("raised_at", { ascending: false })),
    q<any[]>(s.from("employees").select("id, full_name, guard_code")),
    q<any[]>(s.from("payslips").select("id, period_month")),
  ]);
  const emp = new Map(e.map((x) => [x.id, x]));
  const ps = new Map(p.map((x) => [x.id, x.period_month]));
  return a.map((x) => ({
    ...x,
    full_name: emp.get(x.employee_id)?.full_name ?? "—",
    guard_code: emp.get(x.employee_id)?.guard_code ?? null,
    settled_period: x.settled_payslip_id ? ps.get(x.settled_payslip_id) ?? null : null,
  }));
}
export async function loadAdjustmentPayOptions(companyId: string) {
  const [banks, custodians] = await Promise.all([
    q<any[]>(sb().from("bank_accounts").select("id, bank_name, account_number").eq("company_id", companyId)),
    loadCustodianOptions(companyId, false),
  ]);
  return { banks, custodians };
}
export async function settleAdjustment(companyId: string, adj: AdjustmentRow, pay: { mode: string; bank: string; custodian: string; date: string }, custodians: CustodianOption[]) {
  let custodianLoc: string | null = null;
  if (pay.mode === "Cash") {
    const c = custodians.find((x) => x.employeeId === pay.custodian);
    if (!c) throw new Error("Pick who is handing the cash over.");
    custodianLoc = await ensureCustodianLocation(companyId, c.employeeId, c.fullName, c.kind);
  }
  const { error } = await sb().rpc("settle_payroll_adjustment" as never, {
    p_adjustment_id: adj.id, p_payment_mode: pay.mode, p_bank_account_id: pay.mode === "Bank" ? pay.bank || null : null,
    p_custodian_location_id: custodianLoc, p_paid_on: pay.date,
  } as never);
  if (error) throw new Error(friendlyDbError(error));
}
export async function cancelAdjustment(id: string, reason: string) {
  const { error } = await sb().rpc("cancel_payroll_adjustment" as never, { p_adjustment_id: id, p_reason: reason } as never);
  if (error) throw new Error(friendlyDbError(error));
}

// ---------------------------------------------------------------------- Leave
export type LeaveGuard = {
  id: string; full_name: string; guard_code: string | null;
  leave_quota_override: number | null; leave_quota_override_reason: string | null; leave_quota_override_at: string | null; leave_quota_override_by: string | null;
};
export type LedgerRow = { period_start: string; present_days: number; tier: number; quota: number; earned: number; lost: number; opening: number; taken: number; unpaid: number; closing: number };
export type LostRow = { employee_id: string; full_name: string; opening: number; would_earn: number; banked: number; lost: number };

export async function loadLeaveGuards() {
  const guards = await q<LeaveGuard[]>(sb().from("employees")
    .select("id, full_name, guard_code, leave_quota_override, leave_quota_override_reason, leave_quota_override_at, leave_quota_override_by")
    .in("lifecycle_state", ["active", "on_leave"]).order("full_name"));
  const ids = Array.from(new Set(guards.map((g) => g.leave_quota_override_by).filter(Boolean))) as string[];
  const setterNames = new Map<string, string>();
  if (ids.length) for (const p of await q<any[]>(sb().from("profiles").select("id, full_name").in("id", ids))) setterNames.set(p.id, p.full_name);
  return { guards, setterNames };
}
export async function loadLeaveLedger(employeeId: string) {
  const { data, error } = await sb().rpc("leave_ledger" as never, { p_employee_id: employeeId } as never);
  if (error) throw new Error(friendlyDbError(error));
  return (data ?? []) as LedgerRow[];
}
export async function loadLostAtCap(companyId: string, ym: string) {
  return ((await rpc<any[]>("leave_lost_at_cap", { p_company_id: companyId, p_period_start: `${ym}-01` })) ?? []) as LostRow[];
}
export async function setQuotaOverride(employeeId: string, quota: string | null, reason: string | null) {
  const { error } = await sb().rpc("set_leave_quota_override" as never, { p_employee_id: employeeId, p_quota: quota == null ? null : Number(quota), p_reason: reason } as never);
  if (error) throw new Error(friendlyDbError(error));
}
