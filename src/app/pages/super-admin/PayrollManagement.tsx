import ThemedSelect from "../../components/ThemedSelect";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Download, AlertCircle, X, Loader2, SlidersHorizontal, ChevronDown } from "lucide-react";
import jsPDF from "jspdf";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import BusyOverlay from "../../components/BusyOverlay";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import {
  supabase,
  resolveAllowedLeaves,
  resolveEobiAmount,
  type Employee,
  type Client,
  type BankAccount,
  type Payslip,
  type PaymentMode,
  type PayslipStatus,
  type Cheque,
  type Branch,
  type Contract,
} from "../../lib/supabase";
import { useRegion, withRegion } from "../../lib/region";
import { useAuth } from "../../lib/auth";
import { loadCustodianOptions, ensureCustodianLocation, type CustodianOption } from "../../lib/custodian";
import { isSeparatedState, lifecycleStatusLabel } from "../../lib/employmentWindow";
import { guardDisplayCode } from "../../lib/guardCode";

type EmployeeRow = Employee & { client_name: string | null };

type RowState = {
  employee: EmployeeRow;
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
  /** Cumulative cash actually paid out for this payslip (persisted). */
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
  /** Extra shifts worked on days already counted in present_days. */
  double_duty_shifts: number;
  /** How far present+absent+leave ran past the month, before trimming. */
  days_over_month: number;
};

const firstOfMonth = (d: Date) => {
  const y = d.getFullYear();
  const m = d.getMonth();
  const mm = String(m + 1).padStart(2, "0");
  return `${y}-${mm}-01`;
};
const endOfMonthStr = (periodMonth: string) => {
  const [y, m] = periodMonth.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  const mm = String(m).padStart(2, "0");
  const dd = String(last).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
};
const formatPeriod = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
};
const daysInMonth = (periodMonth: string) => {
  const [y, m] = periodMonth.split("-").map(Number);
  return new Date(y, m, 0).getDate();
};

type PayrollManagementProps = { relieversOnly?: boolean };

export default function PayrollManagement({ relieversOnly = false }: PayrollManagementProps = {}) {
  const { regionId } = useRegion();
  const today = new Date();
  const currentPeriod = firstOfMonth(today);
  // Default the filter to the previous month — payroll is typically processed
  // after a month has ended.
  const previousPeriod = firstOfMonth(new Date(today.getFullYear(), today.getMonth() - 1, 1));

  // Item 1: remember the selected period + payslip across navigation so the user
  // resumes where they left off. Scoped so reliever and main payroll don't clash.
  const selStoreKey = `payroll.selection.${relieversOnly ? "reliever" : "main"}.v1`;
  const readSel = (): { period?: string; id?: string | null } => {
    try {
      return JSON.parse(localStorage.getItem(selStoreKey) || "null") ?? {};
    } catch {
      return {};
    }
  };

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  // Client-prefixed display code for user-facing ID displays (permanent GGS code
  // is kept in immutable accounting/journal descriptions + payslip filenames).
  const empDisplay = (emp: { client_id?: string | null; display_number?: number | null; guard_code?: string | null; employee_code?: string | null }) =>
    guardDisplayCode(emp, clients.find((c) => c.id === emp.client_id)?.employee_id_prefix ?? null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [cheques, setCheques] = useState<Cheque[]>([]);
  const [chequeLinkedSums, setChequeLinkedSums] = useState<Map<string, number>>(new Map());
  const [rowError, setRowError] = useState<string | null>(null);
  const chequeRemaining = (chequeId: string, excludeOwnAmount: number = 0): number => {
    const c = cheques.find((x) => x.id === chequeId);
    if (!c) return 0;
    const used = chequeLinkedSums.get(chequeId) ?? 0;
    return Number(c.amount) - used + excludeOwnAmount;
  };
  const [payslipsMap, setPayslipsMap] = useState<Map<string, Payslip>>(new Map());
  // Per-reliever per-client present-day counts for the active period.
  // Only loaded in relieversOnly mode (cheap, small dataset).
  const [relieverPerClient, setRelieverPerClient] = useState<Map<string, Map<string | "unattributed", number>>>(new Map());
  const [attPayroll, setAttPayroll] = useState<Map<string, { worked_shifts: number; present_days: number; double_duty_shifts: number; earned: number; leave_days: number; absent_days: number; rate_effective: number }>>(new Map());
  /**
   * employee_id -> leave allowance that replaces contract/client/carry-forward,
   * for the SELECTED PERIOD ONLY. Reloaded whenever the period changes, so it
   * can never leak into another month's payroll.
   */
  const [leaveOverrides, setLeaveOverrides] = useState<Map<string, { allowed: number; reason: string | null }>>(new Map());
  const [leaveDraft, setLeaveDraft] = useState<string>("");
  const [leaveReason, setLeaveReason] = useState<string>("");
  const [leaveSaving, setLeaveSaving] = useState(false);
  const [attendanceAgg, setAttendanceAgg] = useState<Map<string, { present: number; absent: number; leave: number }>>(
    new Map()
  );
  const [advancesByEmployee, setAdvancesByEmployee] = useState<Map<string, number>>(new Map());
  const [priorLeavesByMonth, setPriorLeavesByMonth] = useState<Map<string, Map<string, number>>>(new Map());
  const [cashBalance, setCashBalance] = useState(0);
  const { profile } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? null;
  // Office-staff custodians (who physically holds/pays cash) — same list Cash
  // Custody & Expenses use. Required when a salary is paid in Cash so the payment
  // decrements that person's tracked cash and shows in the Cash Custody ledger.
  const [custodians, setCustodians] = useState<CustodianOption[]>([]);
  const [cashCustodianId, setCashCustodianId] = useState<string>("");     // drawer (per-row) payment
  const [bulkCashCustodianId, setBulkCashCustodianId] = useState<string>(""); // bulk disburse

  const [isBulkDisburseOpen, setIsBulkDisburseOpen] = useState(false);
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const [bulkDisburseDate, setBulkDisburseDate] = useState<string>(todayISO());
  const [rowDisburseTarget, setRowDisburseTarget] = useState<RowState | null>(null);
  const [rowDisburseDate, setRowDisburseDate] = useState<string>(todayISO());
  // The amount being paid RIGHT NOW (not cumulative). Disburse adds it to the
  // stored Amount Paid and moves exactly this much. Defaults to the outstanding
  // Balance so paying in full stays one click; capped at Balance on submit.
  const [paymentAmountDraft, setPaymentAmountDraft] = useState<string>("");
  const [bulkMode, setBulkMode] = useState<PaymentMode>("Cash");
  const [bulkBankId, setBulkBankId] = useState<string>("");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkClearing, setBulkClearing] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [shiftFilter, setShiftFilter] = useState<"all" | "day" | "night">("all");
  const [clientFilter, setClientFilter] = useState("all");
  /** Site within the selected client. Only offered once a client is chosen. */
  const [siteFilter, setSiteFilter] = useState("all");
  const [sites, setSites] = useState<{ id: string; client_id: string; name: string }[]>([]);
  /** guard_id -> site_id of their open posting. The employee row does not carry it. */
  const [siteByGuard, setSiteByGuard] = useState<Map<string, string>>(new Map());
  const [employeeAddlBranches, setEmployeeAddlBranches] = useState<Map<string, string[]>>(new Map());
  const [statusFilter, setStatusFilter] = useState<"all" | "Cleared" | "Pending">("all");
  const [disbursedFilter, setDisbursedFilter] = useState<"all" | "yes" | "no">("all");
  // Active / Inactive employee tab split (Inactive = anything not currently Active).
  const [empTab, setEmpTab] = useState<"all" | "active" | "inactive">("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [warningDismissed, setWarningDismissed] = useState(false);
  // The sticky salary drawer must fit the visible scroll area exactly (the
  // chrome above it varies: SSA "viewing" banner, region bar, dismissable
  // warning). Measure it instead of guessing a vh offset.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drawerMaxH, setDrawerMaxH] = useState<number | undefined>(undefined);
  // Employee category filter (same set as the Employees tab) — e.g. Office Staff only.
  const [categoryFilter, setCategoryFilter] = useState<"all" | "client" | "office_staff" | "reliever">("all");
  const [branches, setBranches] = useState<Branch[]>([]);

  const [periodOptions, setPeriodOptions] = useState<string[]>([currentPeriod, previousPeriod]);
  const [selectedPeriod, setSelectedPeriod] = useState(() => readSel().period ?? previousPeriod);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rowEdits, setRowEdits] = useState<Map<string, Partial<RowState>>>(new Map());
  const [savingId, setSavingId] = useState<string | null>(null);

  const [isPayslipModalOpen, setIsPayslipModalOpen] = useState(false);
  const [payslipData, setPayslipData] = useState<RowState | null>(null);

  useEffect(() => {
    const opts: string[] = [];
    for (let i = 0; i <= 6; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      opts.push(firstOfMonth(d));
    }
    setPeriodOptions(opts);
  }, []);

  const loadPeriodData = async (period: string) => {
    const start = period;
    const end = endOfMonthStr(period);
    const [yStr, mStr] = period.split("-");
    const py = Number(yStr);
    const pm = Number(mStr);
    const carryWindowStart = new Date(py, pm - 1 - 12, 1);
    const carryWindowStartIso = `${carryWindowStart.getFullYear()}-${String(
      carryWindowStart.getMonth() + 1
    ).padStart(2, "0")}-01`;
    // Server-side aggregation RPCs — raw SELECT was hitting PostgREST's
    // ~1000-row response cap once a company crossed ~30 employees with full
    // month coverage, silently dropping attendance for most people.
    const [attRes, payRes, advRes, attHistRes, apRes, lvRes] = await Promise.all([
      supabase.rpc("attendance_period_counts", { p_start: start, p_end: end }),
      supabase.from("payslips").select("*").eq("period_month", period),
      // Outstanding advance balance (Σ advances − Σ recovered on prior payslips),
      // so a partly-recovered advance carries forward instead of vanishing.
      supabase.rpc("employee_advance_outstanding", { p_period_start: start }),
      supabase.rpc("attendance_leave_history", {
        p_window_start: carryWindowStartIso,
        p_until: start,
      }),
      // Phase 9 §10: earnings from verified attendance × salary-history rate per date.
      supabase.rpc("attendance_payroll", { p_start: start, p_end: end }),
      // One-month, one-employee leave allowance overrides for THIS period only.
      supabase
        .from("employee_leave_overrides")
        .select("employee_id, allowed_leaves, reason")
        .eq("period_month", period),
    ]);
    setLeaveOverrides(
      new Map(
        ((lvRes.data ?? []) as { employee_id: string; allowed_leaves: number; reason: string | null }[])
          .map((r) => [r.employee_id, { allowed: Number(r.allowed_leaves), reason: r.reason }]),
      ),
    );
    const apMap = new Map<string, { worked_shifts: number; present_days: number; double_duty_shifts: number; earned: number; leave_days: number; absent_days: number; rate_effective: number }>();
    for (const r of ((apRes.data ?? []) as any[])) {
      apMap.set(r.employee_id, {
        worked_shifts: Number(r.worked_shifts) || 0,
        // present_days = distinct dates worked; double duty is the EXTRA shifts
        // on top. Older payslips predate the split, so fall back to treating
        // every worked shift as its own day.
        present_days: Number(r.present_days ?? r.worked_shifts) || 0,
        double_duty_shifts: Number(r.double_duty_shifts) || 0,
        earned: Number(r.earned) || 0,
        leave_days: Number(r.leave_days) || 0,
        absent_days: Number(r.absent_days) || 0,
        rate_effective: Number(r.rate_effective) || 0,
      });
    }
    setAttPayroll(apMap);
    const agg = new Map<string, { present: number; absent: number; leave: number }>();
    (attRes.data ?? []).forEach((a: any) => {
      const cur = agg.get(a.employee_id) ?? { present: 0, absent: 0, leave: 0 };
      const cnt = Number(a.cnt) || 0;
      // Phase 6: normalize legacy (Present/Absent/Leave) + new spec status set.
      // blocked NEVER counts as absence or shortfall (§8.3).
      const s = String(a.status).toLowerCase();
      if (s === "present" || s === "double_duty" || s === "relief_cover") cur.present += cnt;
      else if (s === "absent") cur.absent += cnt;
      else if (s === "leave" || s === "rotation_leave" || s === "rest_day") cur.leave += cnt;
      // "blocked" (and anything else) is ignored.
      agg.set(a.employee_id, cur);
    });
    setAttendanceAgg(agg);

    // In relievers mode, additionally pull per-day client attribution so the
    // table can show "Worked for: Client A 5d, Client B 3d" and so the same
    // numbers can be fed into the P&L (per-client � per_day_salary).
    if (relieversOnly) {
      const { data: relRows } = await supabase
        .from("attendance_records")
        .select("employee_id, worked_for_client_id")
        .gte("attendance_date", start)
        .lte("attendance_date", end)
        .in("status", ["Present", "present", "double_duty", "relief_cover"]);
      const per = new Map<string, Map<string | "unattributed", number>>();
      for (const r of ((relRows ?? []) as { employee_id: string; worked_for_client_id: string | null }[])) {
        const key: string | "unattributed" = r.worked_for_client_id ?? "unattributed";
        const inner = per.get(r.employee_id) ?? new Map<string | "unattributed", number>();
        inner.set(key, (inner.get(key) ?? 0) + 1);
        per.set(r.employee_id, inner);
      }
      setRelieverPerClient(per);
    } else {
      setRelieverPerClient(new Map());
    }

    const pMap = new Map<string, Payslip>();
    (payRes.data ?? []).forEach((p: any) => pMap.set(p.employee_id, p));
    setPayslipsMap(pMap);
    const advMap = new Map<string, number>();
    (advRes.data ?? []).forEach((a: any) => {
      advMap.set(a.employee_id, Number(a.outstanding) || 0);
    });
    setAdvancesByEmployee(advMap);
    // attendance_leave_history returns one row per (employee, month) with cnt.
    const histMap = new Map<string, Map<string, number>>();
    (attHistRes.data ?? []).forEach((r: any) => {
      const monthKey: string = String(r.month_key ?? "").slice(0, 7);
      if (!monthKey) return;
      if (!histMap.has(r.employee_id)) histMap.set(r.employee_id, new Map());
      const empMap = histMap.get(r.employee_id)!;
      empMap.set(monthKey, (empMap.get(monthKey) ?? 0) + Number(r.cnt));
    });
    setPriorLeavesByMonth(histMap);
    setRowEdits(new Map());
    // Selection is intentionally preserved here (item 1) so switching away and
    // back keeps the chosen payslip. It's cleared explicitly when the user picks
    // a different period.
  };

  const loadAll = async () => {
    setLoading(true);
    setError(null);

    const sixAgo = new Date(today.getFullYear(), today.getMonth() - 6, 1);
    const cutoff = firstOfMonth(sixAgo);
    await supabase.from("payslips").delete().lt("period_month", cutoff);

    const [empRes, siteRes, depRes, cliRes, conRes, bankRes, treaRes, chqRes, brRes] = await Promise.all([
      // Region scopes the payroll roster (each row = an employee). Bank/treasury/
      // cheque reads below stay company-wide — the cash pool isn't region-split.
      withRegion(
        // Every employee enters the payroll roster. The old Ops-verify /
        // Finance-approve gate is gone: it silently withheld pay from people who
        // had genuinely worked, and nothing downstream depended on it.
        supabase
          .from("employees")
          .select("*, client:client_id(name)")
          .order("employee_code"),
        regionId,
      ),
      supabase.from("sites").select("id, client_id, name").order("name"),
      // Where each guard currently stands, for the Site filter.
      supabase.from("deployments").select("guard_id, site_id").is("end_date", null),
      supabase.from("clients").select("*").order("name"),
      supabase.from("contracts").select("*"),
      supabase.from("bank_accounts").select("*").order("bank_name"),
      supabase.from("treasury").select("*").limit(1).maybeSingle(),
      supabase.from("cheques").select("*").order("cheque_date", { ascending: false }),
      supabase.from("branches").select("*").order("is_head_office", { ascending: false }).order("name"),
    ]);

    if (empRes.error) setError(empRes.error.message);
    setEmployees(
      (empRes.data ?? []).map((e: any) => ({
        ...e,
        client_name: e.client?.name ?? null,
      }))
    );
    setSites((siteRes.data ?? []) as { id: string; client_id: string; name: string }[]);
    setSiteByGuard(
      new Map(
        ((depRes.data ?? []) as { guard_id: string; site_id: string | null }[])
          .filter((d) => d.site_id)
          .map((d) => [d.guard_id, d.site_id as string]),
      ),
    );
    setClients(cliRes.data ?? []);
    setContracts((conRes.data ?? []) as Contract[]);
    setBanks((bankRes.data ?? []) as BankAccount[]);
    setCheques((chqRes.data ?? []) as Cheque[]);
    setBranches((brRes.data ?? []) as Branch[]);

    const { data: ebRows } = await supabase.from("employee_branches").select("employee_id, branch_id");
    const addl = new Map<string, string[]>();
    for (const r of (ebRows ?? []) as { employee_id: string; branch_id: string }[]) {
      const arr = addl.get(r.employee_id) ?? [];
      arr.push(r.branch_id);
      addl.set(r.employee_id, arr);
    }
    setEmployeeAddlBranches(addl);

    const [linkedPs, linkedEx, linkedAdv, linkedIp] = await Promise.all([
      supabase.from("payslips").select("cheque_id, net_salary").not("cheque_id", "is", null),
      supabase.from("expenses").select("cheque_id, amount").not("cheque_id", "is", null),
      supabase.from("advances").select("cheque_id, amount").not("cheque_id", "is", null),
      supabase.from("invoice_payments").select("cheque_id, amount").not("cheque_id", "is", null),
    ]);
    const linked = new Map<string, number>();
    for (const r of (linkedPs.data ?? []) as { cheque_id: string; net_salary: number }[]) {
      if (r.cheque_id) linked.set(r.cheque_id, (linked.get(r.cheque_id) ?? 0) + Number(r.net_salary));
    }
    for (const r of (linkedEx.data ?? []) as { cheque_id: string; amount: number }[]) {
      if (r.cheque_id) linked.set(r.cheque_id, (linked.get(r.cheque_id) ?? 0) + Number(r.amount));
    }
    for (const r of (linkedAdv.data ?? []) as { cheque_id: string; amount: number }[]) {
      if (r.cheque_id) linked.set(r.cheque_id, (linked.get(r.cheque_id) ?? 0) + Number(r.amount));
    }
    for (const r of (linkedIp.data ?? []) as { cheque_id: string; amount: number }[]) {
      if (r.cheque_id) linked.set(r.cheque_id, (linked.get(r.cheque_id) ?? 0) + Number(r.amount));
    }
    setChequeLinkedSums(linked);
    setCashBalance(Number(treaRes.data?.cash_balance ?? 0));

    await loadPeriodData(selectedPeriod);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
    // Reload the roster when the global region selector changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId]);

  useEffect(() => {
    if (!loading) loadPeriodData(selectedPeriod);
  }, [selectedPeriod]);

  // Load the custodian list once we know the company (for cash payment attribution).
  useEffect(() => {
    if (!companyId) return;
    loadCustodianOptions(companyId).then(setCustodians).catch(() => { /* attribution optional */ });
  }, [companyId]);

  // Item 1: persist the period + selected payslip so navigation resumes here.
  useEffect(() => {
    try {
      localStorage.setItem(selStoreKey, JSON.stringify({ period: selectedPeriod, id: selectedId }));
    } catch {
      /* ignore quota / privacy errors */
    }
  }, [selStoreKey, selectedPeriod, selectedId]);

  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const contractById = useMemo(() => new Map(contracts.map((c) => [c.id, c])), [contracts]);

  // Leave allowance and EOBI are resolved per EMPLOYEE, from the contract they're
  // assigned to, falling back to their client for records that predate the move of
  // these settings onto contracts.
  const allowedLeavesByEmployee = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of employees) {
      m.set(
        e.id,
        resolveAllowedLeaves(
          e.contract_id ? contractById.get(e.contract_id) : null,
          e.client_id ? clientById.get(e.client_id) : null,
        ),
      );
    }
    return m;
  }, [employees, contractById, clientById]);

  // EOBI: flat PKR amount withheld per employee per month. 0 = no EOBI.
  const eobiByEmployee = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of employees) {
      m.set(
        e.id,
        resolveEobiAmount(
          e.contract_id ? contractById.get(e.contract_id) : null,
          e.client_id ? clientById.get(e.client_id) : null,
        ),
      );
    }
    return m;
  }, [employees, contractById, clientById]);

  // Carry-forward has no contract-level equivalent, so it stays anchored to the client.
  const clientCarryEnabled = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const c of clients) {
      m.set(c.id, !!(c as any).leave_carry_forward);
    }
    return m;
  }, [clients]);

  // Item 9: carry accrual is anchored to each client's leave_carry_start month
  // (chosen when the feature is enabled), not a blanket 12-month lookback.
  const clientCarryStart = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const c of clients as Array<{ id: string; leave_carry_start?: string | null }>) {
      m.set(c.id, c.leave_carry_start ?? null);
    }
    return m;
  }, [clients]);

  const carriedAllowance = useMemo(() => {
    const out = new Map<string, number>();
    if (!selectedPeriod) return out;
    const [pyStr, pmStr] = selectedPeriod.split("-");
    const py = Number(pyStr);
    const pm = Number(pmStr);
    for (const emp of employees) {
      if (!emp.client_id) continue;
      if (!clientCarryEnabled.get(emp.client_id)) continue;
      const base = allowedLeavesByEmployee.get(emp.id) ?? 0;
      // Opening leaves OVERRIDE the accumulated balance from their effective
      // month forward: once active, the accrual restarts at `base + opening` and
      // anchors at opening_leaves_month instead of the client's carry start, so
      // any accrual recorded before it is discarded. Earlier periods keep the
      // client's original carry-start accrual (no opening).
      const selKey = `${py}-${String(pm).padStart(2, "0")}`;
      const openingMonth = emp.opening_leaves_month;
      const openingActive =
        emp.opening_leaves != null &&
        !!openingMonth &&
        openingMonth.slice(0, 7) <= selKey;
      const startStr = openingActive ? openingMonth : clientCarryStart.get(emp.client_id);
      // Months from the anchor up to (but excluding) the selected period.
      // No anchor → no backlog (this period simply gets the seed), which avoids
      // the old "compounds out of nowhere" bug (item 8).
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
      const empLeaves = priorLeavesByMonth.get(emp.id) ?? new Map<string, number>();
      let allowed = openingActive ? base + Number(emp.opening_leaves ?? 0) : base;
      for (const k of monthKeys) {
        const used = empLeaves.get(k) ?? 0;
        const unused = Math.max(0, allowed - used);
        allowed = base + unused;
      }
      out.set(emp.id, allowed);
    }
    return out;
  }, [employees, clientCarryEnabled, allowedLeavesByEmployee, clientCarryStart, priorLeavesByMonth, selectedPeriod]);

  const rows = useMemo<RowState[]>(() => {
    const daysThisPeriod = daysInMonth(selectedPeriod);
    return employees.map((emp) => {
      const existing = payslipsMap.get(emp.id);
      // Phase 9 §10: prefer the attendance-payroll RPC (worked shifts incl. double
      // duty / relief cover, blocked excluded, partial months natural); fall back
      // to the legacy aggregate only when the RPC has no row for this guard.
      const ap = attPayroll.get(emp.id);
      // present = DAYS stood, double duty = the extra shifts on top. They used
      // to be one number (worked_shifts), which made "26 present" in a 31-day
      // month impossible to reconcile when 2 of them were second shifts.
      const att = ap
        ? { present: ap.present_days, absent: ap.absent_days, leave: ap.leave_days }
        : (attendanceAgg.get(emp.id) ?? { present: 0, absent: 0, leave: 0 });
      const doubleDuty = ap?.double_duty_shifts ?? 0;
      const baseSal = Number(existing?.base_salary ?? emp.base_salary ?? 0);
      const computedAdvance = advancesByEmployee.get(emp.id) ?? 0;
      const baseAllowed = allowedLeavesByEmployee.get(emp.id) ?? 0;
      const carryAllowed = carriedAllowance.get(emp.id);
      // A manual override for THIS employee in THIS month beats everything —
      // that is the whole point of it. Contract, client default and any
      // carry-forward balance are all policy that applies to a group; this is
      // the one place a single person's month can differ.
      const overrideAllowed = leaveOverrides.get(emp.id)?.allowed;
      const allowed = overrideAllowed ?? carryAllowed ?? baseAllowed;
      const defaults: RowState = {
        employee: emp,
        period_month: selectedPeriod,
        working_days: daysThisPeriod,
        present_days: att.present,
        absent_days: att.absent,
        leave_days: att.leave,
        base_salary: baseSal,
        per_day_salary: null,
        bonus: Number(existing?.bonus ?? 0),
        deductions: Number(existing?.deductions ?? 0),
        advance: computedAdvance,
        income_tax: 0,
        eobi: 0,
        allowance: Number(existing?.allowance ?? emp.allowance ?? 0),
        final_salary: 0,
        net_salary: 0,
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
        effective_present_days: 0,
        effective_absent_days: 0,
        extra_leave_absent: 0,
        double_duty_shifts: doubleDuty,
        days_over_month: 0,
      };
      const edits = rowEdits.get(emp.id) ?? {};
      const merged = { ...defaults, ...edits };
      merged.advance = computedAdvance;
      merged.allowed_leaves = allowed;

      merged.double_duty_shifts = doubleDuty;

      // A month cannot hold more days than it has. present + absent + leave is
      // a partition of the month's calendar days, so July can never total more
      // than 31 — anything above that means a date carries two conflicting
      // statuses (2 employee-months in this data do). Trim the surplus off
      // LEAVE first and then absent, never off days actually worked, and keep
      // the excess so the drawer can say so rather than silently altering pay.
      // Double duty is excluded on purpose: those are extra SHIFTS on days
      // already counted once, so they cost the month nothing.
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
      if (merged.override_leaves) {
        countableLeaves = rawLeaves;
        extraLeaveAbsent = 0;
      } else {
        countableLeaves = Math.min(rawLeaves, merged.allowed_leaves);
        extraLeaveAbsent = Math.max(0, rawLeaves - merged.allowed_leaves);
      }
      merged.effective_present_days = rawPresent + countableLeaves;
      merged.extra_leave_absent = extraLeaveAbsent;
      merged.effective_absent_days = rawAbsent + extraLeaveAbsent;

      // §10.1/§10.3: rate effective per attendance date drives earnings; per-day
      // rate = rate ÷ days_in_month is computed at RUNTIME, never stored.
      const rateEff = ap && ap.rate_effective > 0 ? ap.rate_effective : merged.base_salary;
      const perDay = daysThisPeriod > 0 && rateEff > 0 ? rateEff / daysThisPeriod : 0;
      merged.per_day_salary = perDay > 0 ? Math.round(perDay) : null;
      // Worked earnings come from verified attendance × per-date rate (double duty /
      // relief cover already produce extra shifts in ap.earned). Paid leaves (up to
      // the allowance) are paid at the effective per-day rate.
      const earnedWorked = ap ? ap.earned : perDay * rawPresent;
      const paidLeavePay = perDay * countableLeaves;
      const earned = Math.round(earnedWorked + paidLeavePay);
      // Salary earned from attendance, before allowance. Income tax is figured on
      // THIS so the allowance itself stays untaxed.
      const earnedSalary = Math.max(0, Math.round(earned + merged.bonus - merged.deductions));
      // Income tax: 1% of (earned salary - 50000) when > 50000.
      merged.income_tax = earnedSalary > 50000
        ? Math.round((earnedSalary - 50000) * 0.01)
        : 0;
      // EOBI: flat amount from the employee's contract, falling back to their client.
      merged.eobi = eobiByEmployee.get(emp.id) ?? 0;
      // Allowance is part of Final Salary now — the reports (which read
      // final_salary) count it, and the advance recovers from it too. It is no
      // longer "always paid".
      merged.final_salary = earnedSalary + Math.round(merged.allowance);
      // Recover as much of the OUTSTANDING advance (computedAdvance) as this
      // month's pay can bear; the rest carries to next month. Stored advance =
      // what was ACTUALLY recovered, so next month's outstanding stays correct.
      // If the advance swallows the whole pay, net is zero.
      const deductible = Math.max(0, merged.final_salary - merged.income_tax - merged.eobi);
      merged.advance = Math.min(computedAdvance, deductible);
      merged.net_salary = Math.max(0, deductible - merged.advance);
      return merged;
    });
  }, [employees, payslipsMap, attendanceAgg, attPayroll, advancesByEmployee, allowedLeavesByEmployee, eobiByEmployee, carriedAllowance, leaveOverrides, selectedPeriod, rowEdits]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const e = r.employee;
      // Reliever panel only shows reliever-category staff; the main payroll
      // panel hides them so they aren't double-managed.
      if (relieversOnly && e.category !== "reliever") return false;
      if (!relieversOnly && e.category === "reliever") return false;
      if (
        q &&
        !e.full_name.toLowerCase().includes(q) &&
        !e.employee_code.toLowerCase().includes(q) &&
        !empDisplay(e).toLowerCase().includes(q) &&
        !(e.phone ?? "").toLowerCase().includes(q)
      )
        return false;
      if (shiftFilter !== "all" && e.shift !== shiftFilter) return false;
      if (clientFilter !== "all" && e.client_id !== clientFilter) return false;
      // Site comes from the guard's open posting, not the employee row.
      if (siteFilter !== "all" && siteByGuard.get(e.id) !== siteFilter) return false;
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (disbursedFilter !== "all" && (disbursedFilter === "yes" ? !r.disbursed : r.disbursed)) return false;
      // The Fired tab keys off lifecycle_state — the authoritative separation
      // field the Employees page uses. "Fired" covers every separated state:
      // fired, terminated, resigned/left, absconded.
      const separated = isSeparatedState(e.lifecycle_state);
      if (empTab === "active" && separated) return false;
      if (empTab === "inactive" && !separated) return false;
      // Nobody with zero attendance in the period being paid belongs on the
      // payroll — there is nothing to compute. Applies to EVERY tab, the Fired
      // tab included: a guard who left months ago has nothing to settle in this
      // period and is just noise. A fired guard who worked half a month does
      // have attendance, so they still appear and still get paid — which is the
      // reason this is keyed on attendance rather than on separation.
      //
      // Two exceptions, both because real money already moved in THIS period
      // and payrollTotals sums this filtered list — dropping either would
      // quietly understate the totals:
      //   • a payslip already exists for this period (generated / disbursed)
      //   • an advance was taken in this period (the advances query is scoped
      //     to the period, so an old advance doesn't resurrect them forever)
      const hasAttendance = r.present_days > 0 || r.absent_days > 0 || r.leave_days > 0;
      if (!hasAttendance && !r.payslip_id && r.advance === 0) return false;
      if (categoryFilter !== "all" && (e.category ?? "client") !== categoryFilter) return false;
      return true;
    });
  }, [rows, search, shiftFilter, clientFilter, siteFilter, siteByGuard, statusFilter, disbursedFilter, empTab, categoryFilter, employeeAddlBranches, relieversOnly, branches]);

  /**
   * Sites belonging to the selected client, pooled across every one of their
   * contracts — a guard stands at a site, not at a contract, so splitting the
   * list by contract would only ask the user a question they cannot answer.
   */
  const sitesForClient = useMemo(
    () => (clientFilter === "all" ? [] : sites.filter((s) => s.client_id === clientFilter)),
    [sites, clientFilter],
  );

  // A site from the previous client must not survive a client change, or the
  // list silently empties with a filter the user can no longer see.
  useEffect(() => { setSiteFilter("all"); }, [clientFilter]);

  const selectedRow = useMemo(
    () => rows.find((r) => r.employee.id === selectedId) ?? null,
    [rows, selectedId]
  );

  // Payment Amount starts BLANK — the bank is only ever deducted by the exact
  // amount the user types, never auto-filled to the full balance. Cleared when
  // the employee/month changes or a payment lands, so a figure typed for one
  // guard can't linger on another.
  useEffect(() => {
    setPaymentAmountDraft("");
    setCashCustodianId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedPeriod, selectedRow?.amount_paid]);

  // Load the stored override into the editor whenever the employee or the month
  // changes — otherwise a figure typed for one guard would sit in the box while
  // a different guard's row was on screen.
  useEffect(() => {
    const existing = selectedId ? leaveOverrides.get(selectedId) : undefined;
    setLeaveDraft(existing ? String(existing.allowed) : "");
    setLeaveReason(existing?.reason ?? "");
  }, [selectedId, selectedPeriod, leaveOverrides]);

  const payrollTotals = useMemo(() => {
    let disbursed = 0;
    let notDisbursed = 0;
    let advance = 0;
    for (const r of filtered) {
      advance += r.advance;
      // Disbursed = cash actually paid out (Amount Paid); Not Disbursed = what's
      // still owed (Balance). Both hold for partial payments, not just the flag.
      const paid = Math.round(r.amount_paid || 0);
      disbursed += paid;
      notDisbursed += Math.max(0, Math.round(r.net_salary) - paid);
    }
    return { disbursed, notDisbursed, advance };
  }, [filtered]);

  const updateEdit = (employeeId: string, patch: Partial<RowState>) => {
    setRowEdits((prev) => {
      const next = new Map(prev);
      const current = next.get(employeeId) ?? {};
      next.set(employeeId, { ...current, ...patch });
      return next;
    });
  };

  const buildPayslipPayload = (row: RowState) => ({
    employee_id: row.employee.id,
    period_month: row.period_month,
    working_days: row.working_days,
    present_days: row.present_days,
    absent_days: row.absent_days,
    leave_days: row.leave_days,
    base_salary: row.base_salary,
    per_day_salary: row.per_day_salary,
    bonus: row.bonus,
    deductions: row.deductions,
    advance: row.advance,
    income_tax: row.income_tax,
    eobi: row.eobi,
    allowance: row.allowance,
    final_salary: row.final_salary,
    net_salary: row.net_salary,
    amount_paid: row.amount_paid ?? 0,
    payment_mode: row.payment_mode,
    bank_account_id:
      row.payment_mode === "Bank"
        ? row.bank_account_id
        : row.payment_mode === "Cheque"
          ? row.bank_account_id
          : null,
    cheque_id: row.payment_mode === "Cheque" ? row.cheque_id : null,
    status: row.status,
    disbursed: row.disbursed,
    disbursed_at: row.disbursed_at,
    notes: row.notes,
    override_leaves: row.override_leaves,
    updated_at: new Date().toISOString(),
  });

  /**
   * Write (or clear) one employee's leave allowance for the selected month.
   * Keyed on (employee, period_month), so it applies to this payslip and no
   * other — next month falls straight back to the contract/client rule with
   * nothing to undo.
   */
  const saveLeaveOverride = async (employeeId: string, raw: string, reason: string) => {
    setLeaveSaving(true);
    setError(null);
    try {
      const trimmed = raw.trim();
      if (trimmed === "") {
        // Empty means "no exception this month" — remove the row rather than
        // storing a 0, which would mean something quite different.
        const { error: delErr } = await supabase
          .from("employee_leave_overrides")
          .delete()
          .eq("employee_id", employeeId)
          .eq("period_month", selectedPeriod);
        if (delErr) throw delErr;
      } else {
        const value = Number(trimmed);
        if (!Number.isFinite(value) || value < 0) throw new Error("Allowed leaves must be 0 or more.");
        const { data: userData } = await supabase.auth.getUser();
        const { error: upErr } = await supabase.from("employee_leave_overrides").upsert(
          {
            employee_id: employeeId,
            period_month: selectedPeriod,
            allowed_leaves: value,
            reason: reason.trim() || null,
            created_by: userData.user?.id ?? null,
          },
          { onConflict: "employee_id,period_month" },
        );
        if (upErr) throw upErr;
      }
      await loadPeriodData(selectedPeriod);
    } catch (e: any) {
      setError(friendlyError(e));
    } finally {
      setLeaveSaving(false);
    }
  };

  const savePayslip = async (row: RowState): Promise<void> => {
    const { error: upErr } = await supabase
      .from("payslips")
      .upsert(buildPayslipPayload(row), { onConflict: "employee_id,period_month" });
    if (upErr) throw upErr;
  };

  const firstOfNextMonth = (periodMonth: string) => {
    const [y, m] = periodMonth.split("-").map(Number);
    return firstOfMonth(new Date(y, m, 1)); // m is 1-based, so index m = next month
  };
  const overpayNote = (periodMonth: string) =>
    `Payroll overpayment carry-forward · ${formatPeriod(periodMonth)}`;

  /**
   * Keep a single "advance" row that carries this period's overpayment (paid −
   * net, when positive) into next month, where employee_advance_outstanding
   * picks it up and deducts it. Idempotent: one marker row per (employee,
   * period), reconciled to the current overpaid amount — so it nets with any
   * manual advance the employee has rather than double-counting, and re-saving
   * never stacks duplicates. Deleting/zeroing it reverses its journal entry.
   */
  const syncOverpayAdvance = async (
    employeeId: string,
    periodMonth: string,
    overpay: number,
  ): Promise<void> => {
    const note = overpayNote(periodMonth);
    const target = Math.max(0, Math.round(overpay));
    const { data: existingRows } = await supabase
      .from("advances")
      .select("id, amount")
      .eq("employee_id", employeeId)
      .eq("notes", note);
    const existing = (existingRows ?? [])[0] as { id: string; amount: number } | undefined;
    if (target <= 0) {
      if (existing) await supabase.from("advances").delete().eq("id", existing.id);
      return;
    }
    if (existing) {
      if (Math.round(Number(existing.amount)) !== target) {
        await supabase
          .from("advances")
          .update({ amount: target, advance_date: firstOfNextMonth(periodMonth) })
          .eq("id", existing.id);
      }
    } else {
      await supabase.from("advances").insert({
        employee_id: employeeId,
        amount: target,
        advance_date: firstOfNextMonth(periodMonth),
        payment_mode: "Cash",
        notes: note,
      });
    }
  };

  // Item 4: a friendlier message when a write is blocked by the period-close
  // guard (raised as a Postgres P0001 exception from enforce_period_lock).
  const friendlyError = (err: any): string => {
    const msg = err?.message ?? String(err);
    if (/period for .* is closed/i.test(msg) || /period .* is closed/i.test(msg)) {
      return msg.includes("Reopen") || msg.includes("reopen")
        ? msg
        : `${msg} Reopen the month in Period Close to continue.`;
    }
    return msg;
  };

  // True if the given payslip period (YYYY-MM-01) is a closed accounting period.
  const isPeriodClosed = async (periodMonth: string): Promise<boolean> => {
    const { data } = await supabase
      .from("accounting_periods")
      .select("id")
      .eq("period_month", periodMonth)
      .maybeSingle();
    return !!data;
  };

  // Item 3: synchronous re-entry guard so rapid clicks / double-submits can't
  // disburse the same salary more than once (root cause of the triple-pay bug).
  const disburseLockRef = useRef(false);

  const handleSaveRow = async (row: RowState) => {
    setSavingId(row.employee.id);
    setError(null);
    try {
      // Save records edits; it does NOT move money (that's Disburse's job). But
      // it re-derives the disbursed flag from what's ALREADY been paid against
      // the current Net: Balance 0 (or overpaid) ⇒ Disbursed, otherwise leave it
      // Pending. This is how a payslip that Net dropped to match its paid amount
      // flips to Disbursed, and how one that Net rose past its paid amount stops
      // pretending to be fully paid.
      const paid = Math.round(row.amount_paid || 0);
      const net = Math.round(row.net_salary);
      const disbursed = paid > 0 && paid >= net;
      await savePayslip({
        ...row,
        disbursed,
        disbursed_at: disbursed ? row.disbursed_at ?? new Date().toISOString() : null,
        status: disbursed ? "Cleared" : row.status,
      });
      // Overpaid (paid > net, e.g. attendance later cut Net) carries to next month.
      await syncOverpayAdvance(row.employee.id, row.period_month, paid - net);
      setRowEdits((prev) => {
        const next = new Map(prev);
        next.delete(row.employee.id);
        return next;
      });
      await loadPeriodData(selectedPeriod);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSavingId(null);
    }
  };

  const toggleStatus = async (row: RowState) => {
    const next: PayslipStatus = row.status === "Cleared" ? "Pending" : "Cleared";
    setSavingId(row.employee.id);
    try {
      await savePayslip({ ...row, status: next });
      await loadPeriodData(selectedPeriod);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSavingId(null);
    }
  };

  const markAllCleared = async () => {
    // Cleared = status is "Cleared"; this just flips Pending rows in the
    // current filter. No money moves — purely a status change.
    const pending = filtered.filter((r) => r.status === "Pending");
    if (pending.length === 0) {
      setError("No pending rows in the current filter to clear.");
      return;
    }
    if (
      !window.confirm(
        `Mark ${pending.length} payslip${pending.length === 1 ? "" : "s"} as Cleared?`,
      )
    ) {
      return;
    }
    setError(null);
    setBulkClearing(true);
    try {
      for (const row of pending) {
        await savePayslip({ ...row, status: "Cleared" });
      }
      await loadPeriodData(selectedPeriod);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setBulkClearing(false);
    }
  };

  /**
   * Settle a payslip to a target cumulative Amount Paid, moving only the DELTA
   * (target − already paid) through cash/bank. Paying more moves money out;
   * setting a lower target (down to 0 = un-disburse) returns it. Disbursed is
   * derived: fully paid (paid ≥ net) ⇒ Disbursed, else Pending. Any overpayment
   * (paid > net) is carried to next month as an advance.
   */
  const settlePayment = async (row: RowState, targetPaid: number, dateOverride?: string) => {
    // Item 3: synchronous re-entry guard — blocks rapid double/triple clicks
    // from firing this twice before the first finishes.
    if (disburseLockRef.current) return;
    disburseLockRef.current = true;
    setSavingId(row.employee.id);
    setError(null);
    setRowError(null);
    try {
      const already = Math.round(row.amount_paid || 0);
      const target = Math.max(0, Math.round(targetPaid));
      const net = Math.round(row.net_salary);
      const pay = target - already; // > 0 pays out; < 0 returns to the company
      if (pay === 0) {
        setRowError("Amount Paid is unchanged — nothing to settle.");
        return;
      }
      const disburseIso = dateOverride
        ? new Date(`${dateOverride}T12:00:00`).toISOString()
        : new Date().toISOString();

      // ---- Phase 1: validate funds for the money actually moving now ----
      let bank: (typeof banks)[number] | undefined;
      // Cash payments are attributed to the office-staff custodian who hands out
      // the cash (same model as Expenses / Cash Custody). Resolved here so a
      // failure aborts before any money moves.
      let custodianLocId: string | null = null;
      if (row.payment_mode === "Bank") {
        if (!row.bank_account_id) {
          setRowError("Select a bank account before disbursing.");
          return;
        }
        bank = banks.find((b) => b.id === row.bank_account_id);
        if (!bank) {
          setRowError("Bank account not found.");
          return;
        }
        if (pay > 0 && pay > Number(bank.balance)) {
          setRowError("Selected bank account balance is insufficient for this payment.");
          return;
        }
      } else if (row.payment_mode === "Cheque") {
        if (pay > 0) {
          if (!row.cheque_id) {
            setRowError("Select a cheque before disbursing.");
            return;
          }
          const ownPrev = row.payslip_id ? Number(row.net_salary) : 0;
          const remaining = chequeRemaining(row.cheque_id, ownPrev);
          if (pay > remaining + 0.005) {
            setRowError(`Payment (PKR ${pay.toLocaleString()}) exceeds the cheque's remaining capacity (PKR ${remaining.toLocaleString()}).`);
            return;
          }
        }
      } else {
        if (pay > 0 && pay > cashBalance) {
          setRowError("Cash balance is insufficient for this payment.");
          return;
        }
        // Require a custodian for cash and resolve (create-on-first-use) their
        // cash_location so the payment can be attributed to them.
        if (!cashCustodianId) {
          setRowError("Select who is paying this cash (custodian).");
          return;
        }
        const staff = custodians.find((c) => c.employeeId === cashCustodianId);
        if (!companyId || !staff) {
          setRowError("Custodian not found — reload and try again.");
          return;
        }
        custodianLocId = await ensureCustodianLocation(companyId, staff.employeeId, staff.fullName);
      }

      // ---- Phase 2: claim optimistically on the paid amount ----
      // Update only if amount_paid still equals our baseline, so concurrent
      // clicks / tabs can never apply the same delta twice (the triple-pay guard,
      // now delta-aware for partial payments).
      let payslipId = row.payslip_id;
      if (!payslipId) {
        const { data: up, error: upErr } = await supabase
          .from("payslips")
          .upsert(buildPayslipPayload({ ...row, amount_paid: already }), {
            onConflict: "employee_id,period_month",
          })
          .select("id, amount_paid")
          .single();
        if (upErr) throw upErr;
        payslipId = (up as { id: string }).id;
        if (Math.round(Number((up as { amount_paid: number }).amount_paid)) !== already) {
          setRowError("This payslip changed in another tab — reloading.");
          await loadAll();
          return;
        }
      }
      const newDisbursed = target > 0 && target >= net;
      // Only payment-tracking columns are written here — never the figure columns
      // (net_salary, final_salary, advance, …) that enforce_payroll_run_lock
      // guards. That lets a payment be recorded against an approved/locked run
      // (which is legitimate) AND means no payslip write happens AFTER the money
      // moves, so a lock rejection can never strand cash outside a payslip.
      const { data: claimRows, error: claimErr } = await supabase
        .from("payslips")
        .update({
          amount_paid: target,
          disbursed: newDisbursed,
          disbursed_at: newDisbursed ? disburseIso : null,
          status: newDisbursed ? "Cleared" : row.status,
          payment_mode: row.payment_mode,
          bank_account_id:
            row.payment_mode === "Bank" || row.payment_mode === "Cheque"
              ? row.bank_account_id
              : null,
          cheque_id: row.payment_mode === "Cheque" ? row.cheque_id : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", payslipId)
        .eq("amount_paid", already)
        .select("id");
      if (claimErr) throw claimErr;
      if (!claimRows || claimRows.length === 0) {
        setRowError("This payslip changed in another tab — reloading.");
        await loadAll();
        return;
      }

      // ---- Phase 3: move `pay`; roll the claim back if anything fails ----
      try {
        if (row.payment_mode === "Bank" && bank) {
          const { error: bErr } = await supabase
            .from("bank_accounts")
            .update({ balance: Number(bank.balance) - pay, updated_at: new Date().toISOString() })
            .eq("id", bank.id);
          if (bErr) throw bErr;
          await supabase.from("bank_transactions").insert({
            bank_account_id: bank.id,
            kind: "payroll",
            amount: Math.abs(pay),
            cash_delta: 0,
            account_delta: -pay,
            description: `${pay < 0 ? "Reverse payroll" : "Payroll"} ${formatPeriod(row.period_month)} · ${row.employee.employee_code} ${row.employee.full_name}`,
          });
        } else if (row.payment_mode === "Cheque") {
          // Cheque-paid: cheque clearance handles the bank side; nothing here.
        } else {
          const { data: trea } = await supabase
            .from("treasury")
            .select("id, cash_balance")
            .limit(1)
            .maybeSingle();
          if (trea) {
            await supabase
              .from("treasury")
              .update({ cash_balance: Number(trea.cash_balance) - pay, updated_at: new Date().toISOString() })
              .eq("id", trea.id);
          }
          await supabase.from("bank_transactions").insert({
            bank_account_id: null,
            kind: "payroll",
            amount: Math.abs(pay),
            cash_delta: -pay,
            account_delta: 0,
            // reference_id = custodian cash_location → Cash Custody attributes this
            // as "Cash paid" against that custodian, decreasing their held cash.
            reference_id: custodianLocId,
            description: `${pay < 0 ? "Reverse payroll (cash)" : "Payroll (cash)"} ${formatPeriod(row.period_month)} · ${row.employee.employee_code} ${row.employee.full_name}`,
          });
        }
        // The claim above already persisted amount_paid / disbursed / routing.
        // We deliberately do NOT re-save the full payslip here — that would
        // rewrite the locked figure columns and be rejected AFTER the cash has
        // already moved. Drawer figure edits are saved separately via Save.
      } catch (moneyErr) {
        // Release the claim so the row can be retried after the issue is fixed.
        await supabase
          .from("payslips")
          .update({
            amount_paid: already,
            disbursed: row.disbursed,
            disbursed_at: row.disbursed_at,
            status: row.status,
          })
          .eq("id", payslipId);
        throw moneyErr;
      }

      // Overpaid portion (target − net, when positive) carries to next month.
      await syncOverpayAdvance(row.employee.id, row.period_month, target - net);
      await loadAll();
    } catch (err: any) {
      setRowError(friendlyError(err));
      await loadAll();
    } finally {
      setSavingId(null);
      disburseLockRef.current = false;
    }
  };

  const handleBulkDisburse = async () => {
    if (disburseLockRef.current) return;
    setError(null);
    // Pay each row its remaining Balance (Net − already paid) and top it up to
    // fully paid. Rows already settled (or overpaid) have no balance and are
    // skipped, so a partially-paid row only gets its shortfall, never double pay.
    const remainingOf = (r: RowState) => Math.round(r.net_salary) - Math.round(r.amount_paid || 0);
    const candidates = filtered.filter((r) => remainingOf(r) > 0);
    if (candidates.length === 0) {
      setError("No unpaid balances in the current filter to disburse.");
      return;
    }
    if (bulkMode === "Bank" && !bulkBankId) {
      setError("Select a bank account for bulk disbursement.");
      return;
    }
    const total = candidates.reduce((s, r) => s + remainingOf(r), 0);
    let bulkCustodianLocId: string | null = null;
    if (bulkMode === "Cash") {
      if (total > cashBalance) {
        setError(`Cash balance (PKR ${cashBalance.toLocaleString()}) is insufficient for PKR ${total.toLocaleString()}.`);
        return;
      }
      // Attribute all these cash payments to one custodian (who hands out the cash).
      if (!bulkCashCustodianId) {
        setError("Select who is paying this cash (custodian) for the bulk disbursement.");
        return;
      }
      const staff = custodians.find((c) => c.employeeId === bulkCashCustodianId);
      if (!companyId || !staff) {
        setError("Custodian not found — reload and try again.");
        return;
      }
      bulkCustodianLocId = await ensureCustodianLocation(companyId, staff.employeeId, staff.fullName);
    } else {
      const bank = banks.find((b) => b.id === bulkBankId);
      if (!bank) {
        setError("Selected bank account not found.");
        return;
      }
      if (total > Number(bank.balance)) {
        setError(
          `Bank balance (PKR ${Number(bank.balance).toLocaleString()}) is insufficient for PKR ${total.toLocaleString()}.`
        );
        return;
      }
    }
    setBulkSubmitting(true);
    disburseLockRef.current = true;
    const bulkDisburseIso = new Date(`${bulkDisburseDate}T12:00:00`).toISOString();
    try {
      for (const row of candidates) {
        const net = Math.round(row.net_salary);
        const already = Math.round(row.amount_paid || 0);
        const remaining = net - already; // money moving now for this row
        // Item 3: atomically claim this payslip before moving money; skip if its
        // paid amount changed (e.g. concurrently in another tab).
        let payslipId = row.payslip_id;
        if (!payslipId) {
          const { data: up, error: upErr } = await supabase
            .from("payslips")
            .upsert(
              buildPayslipPayload({
                ...row,
                payment_mode: bulkMode,
                bank_account_id: bulkMode === "Bank" ? bulkBankId : null,
                amount_paid: already,
                disbursed: false,
                disbursed_at: null,
              }),
              { onConflict: "employee_id,period_month" },
            )
            .select("id")
            .single();
          if (upErr) throw upErr;
          payslipId = (up as { id: string }).id;
        }
        const { data: claimRows, error: claimErr } = await supabase
          .from("payslips")
          .update({
            amount_paid: net,
            disbursed: true,
            disbursed_at: bulkDisburseIso,
            status: "Cleared",
            payment_mode: bulkMode,
            bank_account_id: bulkMode === "Bank" ? bulkBankId : null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", payslipId)
          .eq("amount_paid", already)
          .select("id");
        if (claimErr) throw claimErr;
        if (!claimRows || claimRows.length === 0) continue;
        if (bulkMode === "Bank") {
          const { data: bankNow } = await supabase
            .from("bank_accounts")
            .select("id, balance, bank_name, account_number")
            .eq("id", bulkBankId)
            .single();
          if (!bankNow) throw new Error("Bank account not found mid-bulk.");
          if (remaining > Number(bankNow.balance)) {
            throw new Error(`Bank balance exhausted at ${row.employee.employee_code}.`);
          }
          await supabase
            .from("bank_accounts")
            .update({
              balance: Number(bankNow.balance) - remaining,
              updated_at: new Date().toISOString(),
            })
            .eq("id", bulkBankId);
          await supabase.from("bank_transactions").insert({
            bank_account_id: bulkBankId,
            kind: "payroll",
            amount: remaining,
            cash_delta: 0,
            account_delta: -remaining,
            description: `Payroll ${formatPeriod(row.period_month)} · ${row.employee.employee_code} ${row.employee.full_name}`,
          });
        } else {
          const { data: trea } = await supabase
            .from("treasury")
            .select("id, cash_balance")
            .limit(1)
            .maybeSingle();
          if (!trea) throw new Error("Treasury row missing.");
          if (remaining > Number(trea.cash_balance)) {
            throw new Error(`Cash exhausted at ${row.employee.employee_code}.`);
          }
          await supabase
            .from("treasury")
            .update({
              cash_balance: Number(trea.cash_balance) - remaining,
              updated_at: new Date().toISOString(),
            })
            .eq("id", trea.id);
          await supabase.from("bank_transactions").insert({
            bank_account_id: null,
            kind: "payroll",
            amount: remaining,
            cash_delta: -remaining,
            account_delta: 0,
            reference_id: bulkCustodianLocId,
            description: `Payroll (cash) ${formatPeriod(row.period_month)} · ${row.employee.employee_code} ${row.employee.full_name}`,
          });
        }
        // The claim above already persisted amount_paid / disbursed / routing.
        // Re-saving the full payslip here would rewrite the locked figure columns
        // and be rejected AFTER cash moved (stranding it) — so we don't.
      }
      setIsBulkDisburseOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(friendlyError(err));
      await loadAll();
    } finally {
      setBulkSubmitting(false);
      disburseLockRef.current = false;
    }
  };

  const openPayslipModal = async (row: RowState) => {
    setError(null);
    try {
      await savePayslip(row);
      setRowEdits((prev) => {
        const next = new Map(prev);
        next.delete(row.employee.id);
        return next;
      });
      await loadPeriodData(selectedPeriod);
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
    setPayslipData(row);
    setIsPayslipModalOpen(true);
  };

  const downloadPdf = (row: RowState) => {
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    let y = 60;
    doc.setFontSize(18);
    doc.text("Payslip", 40, y);
    y += 24;
    doc.setFontSize(11);
    doc.setTextColor(90);
    doc.text(`Period: ${formatPeriod(row.period_month)}`, 40, y);
    y += 16;
    doc.text(`Employee: ${row.employee.full_name} (${empDisplay(row.employee)})`, 40, y);
    y += 16;
    if (row.employee.phone) {
      doc.text(`Phone: ${row.employee.phone}`, 40, y);
      y += 16;
    }
    y += 10;
    doc.setTextColor(0);
    doc.setFontSize(13);
    doc.text("Summary", 40, y);
    y += 18;
    doc.setFontSize(11);
    const line = (label: string, value: string) => {
      doc.text(label, 40, y);
      doc.text(value, 520, y, { align: "right" });
      y += 16;
    };
    line("Working Days", String(row.working_days));
    line("Present Days", String(row.present_days));
    if (row.double_duty_shifts > 0) line("Double Duty (extra shifts)", String(row.double_duty_shifts));
    line("Absent Days", String(row.absent_days));
    line("Leave Days", String(row.leave_days));
    line("Allowed Leaves", String(row.allowed_leaves));
    if (row.override_leaves) line("Leave Override", "Yes (all leaves paid)");
    if (row.extra_leave_absent > 0)
      line("Absent due to extra leaves", String(row.extra_leave_absent));
    line("Effective Paid Days", `${row.effective_present_days} / ${row.working_days}`);
    y += 6;
    line("Base Salary", `PKR ${row.base_salary.toLocaleString()}`);
    if (row.per_day_salary != null)
      line("Per Day Salary", `PKR ${Number(row.per_day_salary).toLocaleString()}`);
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
    y += 6;
    doc.setFontSize(14);
    line("Net Salary", `PKR ${row.net_salary.toLocaleString()}`);
    y += 10;
    doc.setFontSize(11);
    line("Payment Mode", row.payment_mode);
    if (row.payment_mode === "Bank" && row.bank_account_id) {
      const bank = banks.find((b) => b.id === row.bank_account_id);
      if (bank) line("Bank Account", `${bank.bank_name} · ${bank.account_number}`);
    }
    line("Status", row.status);
    line("Disbursed", row.disbursed ? "Yes" : "No");
    doc.save(`payslip_${row.employee.employee_code}_${row.period_month}.pdf`);
  };

  const isCurrent = selectedPeriod === currentPeriod;

  useEffect(() => {
    const compute = () => {
      const el = scrollRef.current;
      if (!el || window.innerWidth < 1024) {
        setDrawerMaxH(undefined);
        return;
      }
      const top = el.getBoundingClientRect().top;
      setDrawerMaxH(Math.max(240, window.innerHeight - top - 32));
    };
    compute();
    const t = setTimeout(compute, 120);
    window.addEventListener("resize", compute);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", compute);
    };
  }, [selectedId, warningDismissed]);

  const activeFilterCount =
    (shiftFilter !== "all" ? 1 : 0) +
    (statusFilter !== "all" ? 1 : 0) +
    (disbursedFilter !== "all" ? 1 : 0) +
    (siteFilter !== "all" ? 1 : 0) +
    (clientFilter !== "all" ? 1 : 0) +
    (categoryFilter !== "all" ? 1 : 0);

  // §28.1: unmarked attendance-days silently earn zero. Surface them loudly and
  // steer disbursement through the run pipeline (approve-then-disburse, gated on
  // exceptions) rather than the one-click bulk buttons.
  const totalUnmarkedDays = filtered.reduce(
    (s, r) => s + Math.max(0, r.working_days - r.present_days - r.absent_days - r.leave_days),
    0,
  );

  return (
    <>
      {totalUnmarkedDays > 0 && !warningDismissed && (
        <div className="bg-danger-50 border-b border-danger-200 px-4 md:px-8 py-2 text-sm text-danger-700 dark:text-danger-500 flex items-center justify-between gap-3">
          <span>
            <strong>{totalUnmarkedDays.toLocaleString()}</strong> unmarked attendance-day
            {totalUnmarkedDays === 1 ? "" : "s"} in this period — these silently earn zero. Do not bulk-disburse blind.
          </span>
          <div className="flex items-center gap-3 flex-shrink-0">
            <a href="/super-admin/payroll?tab=runs" className="underline whitespace-nowrap">Use the run pipeline →</a>
            <button
              type="button"
              onClick={() => setWarningDismissed(true)}
              title="Dismiss"
              className="p-1 rounded-md hover:bg-danger-500/15 transition-colors"
            >
              <X className="w-4 h-4" strokeWidth={2} />
            </button>
          </div>
        </div>
      )}
      <BusyOverlay
        show={bulkSubmitting || bulkClearing}
        message={bulkSubmitting ? "Disbursing payslips…" : "Clearing payslips…"}
        detail="This may take a moment for large batches. Please don't close this tab."
      />
      <Header
        title={relieversOnly ? "Reliever Payroll" : "Payroll Management"}
        subtitle={
          relieversOnly
            ? "Per-client day attribution and disbursement"
            : "Period payslips, disbursement and cheque tracking"
        }
        actions={
          <div className="flex items-center gap-3">
            <div className="text-xs text-slate-500 flex flex-col items-end mr-2">
              <span>Cash: PKR {cashBalance.toLocaleString()}</span>
              <span>Days in {formatPeriod(selectedPeriod)}: {daysInMonth(selectedPeriod)}</span>
            </div>
            <Button
              variant="secondary"
              size="md"
              onClick={markAllCleared}
              disabled={bulkClearing}
            >
              {bulkClearing && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {bulkClearing ? "Clearing…" : "Mark All as Cleared"}
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                setBulkMode("Cash");
                setBulkBankId("");
                setIsBulkDisburseOpen(true);
              }}
            >
              Mark All as Disbursed
            </Button>
          </div>
        }
      />

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="px-8 pt-8 pb-0">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-card p-5 rounded-xl border border-border border-l-4 border-l-success-500">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Total Disbursed</p>
            <p className="text-2xl font-semibold tabular-nums text-success-700 dark:text-success-500" style={{ fontFamily: "var(--font-display)" }}>
              PKR {payrollTotals.disbursed.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {filtered.filter((r) => r.disbursed).length} payslip
              {filtered.filter((r) => r.disbursed).length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="bg-card p-5 rounded-xl border border-border border-l-4 border-l-warning-500">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Total Not Disbursed</p>
            <p className="text-2xl font-semibold tabular-nums text-warning-700 dark:text-warning-500" style={{ fontFamily: "var(--font-display)" }}>
              PKR {payrollTotals.notDisbursed.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {filtered.filter((r) => !r.disbursed).length} payslip
              {filtered.filter((r) => !r.disbursed).length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="bg-card p-5 rounded-xl border border-border border-l-4 border-l-danger-500">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Total Advance</p>
            <p className="text-2xl font-semibold tabular-nums text-danger-700 dark:text-danger-500" style={{ fontFamily: "var(--font-display)" }}>
              PKR {payrollTotals.advance.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              for {formatPeriod(selectedPeriod)}
            </p>
          </div>
        </div>
        </div>

        <div className="px-8 pb-8">
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          <div className="flex-1 min-w-0 w-full">
            <div className="bg-card rounded-xl border border-border">
              <div className="p-4 border-b border-border">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="w-[220px] min-w-[180px] relative">
                    <Search
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"
                      strokeWidth={1.5}
                    />
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search employee…"
                      className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setFiltersOpen((v) => !v)}
                    className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-md border border-border text-foreground hover:bg-accent transition-colors"
                  >
                    <SlidersHorizontal className="w-4 h-4" strokeWidth={1.5} />
                    Filters
                    {activeFilterCount > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full bg-brand-500 text-[#241a06]">{activeFilterCount}</span>
                    )}
                    <ChevronDown className={`w-4 h-4 transition-transform ${filtersOpen ? "rotate-180" : ""}`} strokeWidth={1.5} />
                  </button>
                  <div className="flex gap-2 ml-auto">
                    {([
                      { v: "all", label: "All" },
                      { v: "active", label: "Active" },
                      { v: "inactive", label: "Fired" },
                    ] as const).map((t) => (
                      <button
                        key={t.v}
                        type="button"
                        onClick={() => setEmpTab(t.v)}
                        className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                          empTab === t.v
                            ? "border-brand-500 bg-brand-500/15 text-brand-700 dark:text-brand-500 font-medium"
                            : "border-border text-muted-foreground hover:bg-accent"
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
                {filtersOpen && (
                  <div className="mt-3 pt-3 border-t border-border flex flex-wrap gap-2">
                  <ThemedSelect
                    value={selectedPeriod}
                    onChange={(e) => { setSelectedId(null); setSelectedPeriod(e.target.value); }}
                    className="px-3 py-2 border border-border rounded-md text-sm"
                  >
                    {periodOptions.map((p) => (
                      <option key={p} value={p}>
                        {formatPeriod(p)}
                        {p === currentPeriod ? " (Current)" : ""}
                      </option>
                    ))}
                  </ThemedSelect>
                  <ThemedSelect
                    value={shiftFilter}
                    onChange={(e) => setShiftFilter(e.target.value as "all" | "day" | "night")}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="all">All Shifts</option>
                    <option value="day">Day</option>
                    <option value="night">Night</option>
                  </ThemedSelect>
                  <ThemedSelect
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as "all" | "Cleared" | "Pending")}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="all">All Status</option>
                    <option value="Pending">Pending</option>
                    <option value="Cleared">Cleared</option>
                  </ThemedSelect>
                  <ThemedSelect
                    value={disbursedFilter}
                    onChange={(e) => setDisbursedFilter(e.target.value as "all" | "yes" | "no")}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="all">All Disbursed</option>
                    <option value="yes">Disbursed</option>
                    <option value="no">Not Disbursed</option>
                  </ThemedSelect>
                  <ClientFilterSelect
                    clients={clients}
                    value={clientFilter}
                    onChange={setClientFilter}
                    allValue="all"
                  />
                  {/* Site only means something once a client is chosen — every
                      client's sites in one list would be hundreds of entries with
                      repeated names. Sites are pooled across ALL of the client's
                      contracts: a guard stands at a site, not at a contract. */}
                  {clientFilter !== "all" && (
                    <ThemedSelect
                      value={siteFilter}
                      onChange={(e) => setSiteFilter(e.target.value)}
                      className="px-3 py-2 border border-border rounded-md text-sm"
                      title="Filter by site"
                    >
                      <option value="all">All Sites</option>
                      {sitesForClient.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </ThemedSelect>
                  )}
                  {!relieversOnly && (
                    <ThemedSelect
                      value={categoryFilter}
                      onChange={(e) => setCategoryFilter(e.target.value as typeof categoryFilter)}
                      className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                      title="Filter by employee category"
                    >
                      <option value="all">All Categories</option>
                      <option value="client">Client</option>
                      <option value="office_staff">Office Staff</option>
                      <option value="reliever">Reliever</option>
                    </ThemedSelect>
                  )}
                  </div>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left px-4 py-3 text-xs text-slate-500">Employee</th>
                      <th className="text-left px-4 py-3 text-xs text-slate-500">
                        {relieversOnly ? "Worked for" : "Client"}
                      </th>
                      <th className="text-left px-4 py-3 text-xs text-slate-500">Attendance</th>
                      <th className="text-left px-4 py-3 text-xs text-slate-500">Base</th>
                      <th className="text-left px-4 py-3 text-xs text-slate-500">Net Salary</th>
                      <th className="text-left px-4 py-3 text-xs text-slate-500">Status</th>
                      <th className="text-left px-4 py-3 text-xs text-slate-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && (
                      <tr>
                        <td colSpan={8} className="px-6 py-10 text-center text-slate-500">
                          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                          Loading…
                        </td>
                      </tr>
                    )}
                    {!loading && filtered.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-6 py-10 text-center text-slate-500 text-sm">
                          No employees match the current filters.
                        </td>
                      </tr>
                    )}
                    {!loading &&
                      filtered.map((row) => {
                        const e = row.employee;
                        return (
                          <tr
                            key={e.id}
                            className={`transition-colors cursor-pointer border-b border-border ${
                              selectedId === e.id ? "bg-brand-500/10" : "hover:bg-accent/50"
                            }`}
                            onClick={() => { setSelectedId(e.id); setRowError(null); }}
                          >
                            <td className="px-4 py-3">
                              <div className="text-sm text-slate-900 flex items-center gap-2">
                                {e.full_name}
                                {/* Says Fired / Terminated / Resigned / Absconded
                                    for a leaver, not the legacy "Inactive" — same
                                    label and tint as the Employees table. */}
                                <span
                                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${
                                    isSeparatedState(e.lifecycle_state)
                                      ? "bg-danger-50 text-danger-700"
                                      : e.status === "Active"
                                        ? "bg-success-50 text-success-700"
                                        : e.status === "On Leave"
                                          ? "bg-warning-50 text-warning-700"
                                          : "bg-slate-100 text-slate-600"
                                  }`}
                                >
                                  {lifecycleStatusLabel(e)}
                                </span>
                              </div>
                              <div className="text-xs text-slate-500 font-mono">
                                {empDisplay(e)}
                                <span className="block text-[11px] text-slate-400">{e.guard_code ?? e.employee_code}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-sm text-slate-700">
                              {relieversOnly ? (() => {
                                const breakdown = relieverPerClient.get(e.id);
                                if (!breakdown || breakdown.size === 0) {
                                  return <span className="text-slate-400">—</span>;
                                }
                                const items = Array.from(breakdown.entries()).sort((a, b) => b[1] - a[1]);
                                return (
                                  <div className="space-y-0.5 text-xs">
                                    {items.map(([cid, days]) => {
                                      const name =
                                        cid === "unattributed"
                                          ? "(Unattributed)"
                                          : clients.find((c) => c.id === cid)?.name ?? "(Unknown)";
                                      return (
                                        <div key={cid} className="flex justify-between gap-3">
                                          <span className="text-slate-700 truncate max-w-[10rem]" title={name}>{name}</span>
                                          <span className="text-slate-500 tabular-nums">{days}d</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })() : (
                                e.client_name ?? <span className="text-slate-400">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-600">
                              {(() => {
                                const unmarked = Math.max(
                                  row.working_days - row.present_days - row.absent_days - row.leave_days,
                                  0,
                                );
                                return (
                                  <>
                                    <div>
                                      <span className="text-success-700">P {row.present_days}</span>
                                      {" / "}
                                      <span className="text-danger-700">A {row.absent_days}</span>
                                      {" / "}
                                      <span className="text-warning-700">L {row.leave_days}</span>
                                      {unmarked > 0 && (
                                        <>
                                          {" / "}
                                          <span className="text-danger-700 font-medium">{unmarked} unmarked</span>
                                        </>
                                      )}
                                    </div>
                                    <div className="text-slate-400">of {row.working_days} wd</div>
                                  </>
                                );
                              })()}
                            </td>
                            <td className="px-4 py-3 text-sm text-slate-700">
                              PKR {row.base_salary.toLocaleString()}
                            </td>
                            <td className="px-4 py-3 text-sm text-slate-900">
                              PKR {row.net_salary.toLocaleString()}
                              {(() => {
                                const bal = Math.round(row.net_salary) - Math.round(row.amount_paid || 0);
                                if (Math.round(row.amount_paid || 0) === 0 || bal === 0) return null;
                                return (
                                  <div className={`text-[11px] font-medium ${bal > 0 ? "text-warning-700" : "text-danger-700"}`}>
                                    {bal > 0 ? `PKR ${bal.toLocaleString()} owed` : `PKR ${Math.abs(bal).toLocaleString()} overpaid`}
                                  </div>
                                );
                              })()}
                            </td>
                            <td className="px-4 py-3">
                              {/* §28.1: Status + Disbursed merged into a single chip. The
                                  status toggle stays interactive; a disbursed dot rides on it. */}
                              <button
                                type="button"
                                disabled={savingId === e.id}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  toggleStatus(row);
                                }}
                                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs ${
                                  row.status === "Cleared"
                                    ? "bg-success-50 text-success-700 hover:bg-success-100"
                                    : "bg-warning-50 text-warning-700 hover:bg-warning-100"
                                }`}
                                title={row.disbursed ? "Disbursed" : "Not disbursed"}
                              >
                                <span
                                  className={`w-1.5 h-1.5 rounded-full ${
                                    row.disbursed ? "bg-success-600" : "bg-slate-300"
                                  }`}
                                />
                                {row.status}{row.disbursed ? " · Disbursed" : ""}
                              </button>
                            </td>
                            <td className="px-4 py-3">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(ev: React.MouseEvent) => {
                                  ev.stopPropagation();
                                  openPayslipModal(row);
                                }}
                              >
                                Payslip
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {selectedRow && (
          <div
            className="w-full lg:w-[400px] flex-shrink-0 lg:sticky lg:top-4 lg:overflow-y-auto"
            style={{ maxHeight: drawerMaxH }}
          >
            <div className="bg-card rounded-xl border border-border p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-foreground flex items-center gap-2">
                  Salary Calculation
                  {!isCurrent && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-warning-700 dark:text-warning-500 bg-warning-50 border border-warning-200 px-1.5 py-0.5 rounded-md">
                      History
                    </span>
                  )}
                </h3>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  title="Close"
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <X className="w-4 h-4" strokeWidth={1.75} />
                </button>
              </div>

              {selectedRow ? (
                <div className="space-y-2 text-sm">
                  <div className="pb-2 border-b border-border">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Employee</p>
                    <p className="text-foreground font-medium">{selectedRow.employee.full_name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{empDisplay(selectedRow.employee)} · {selectedRow.employee.guard_code ?? selectedRow.employee.employee_code}</p>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 text-center">
                    <div className="rounded-md border border-border py-1.5">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Working</div>
                      <div className="text-base font-semibold tabular-nums text-foreground">{selectedRow.working_days}</div>
                    </div>
                    <div className="rounded-md border border-border py-1.5">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Present</div>
                      <div className="text-base font-semibold tabular-nums text-success-600 dark:text-success-500">{selectedRow.present_days}</div>
                    </div>
                    {/* Extra shifts on days already counted under Present, so
                        Present + Absent + Leave still adds up to the month. */}
                    <div className="rounded-md border border-border py-1.5" title="Extra shifts worked on days already counted as present">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Double duty</div>
                      <div className="text-base font-semibold tabular-nums text-brand-600 dark:text-brand-500">{selectedRow.double_duty_shifts}</div>
                    </div>
                    <div className="rounded-md border border-border py-1.5">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Absent</div>
                      <div className="text-base font-semibold tabular-nums text-danger-600 dark:text-danger-500">{selectedRow.absent_days}</div>
                    </div>
                    <div className="rounded-md border border-border py-1.5">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Leave</div>
                      <div className="text-base font-semibold tabular-nums text-warning-600 dark:text-warning-500">{selectedRow.leave_days}</div>
                    </div>
                  </div>
                  {selectedRow.days_over_month > 0 && (
                    <p className="text-[11px] text-warning-800 dark:text-warning-500 bg-warning-50 border border-warning-200 rounded px-2 py-1">
                      Attendance for this month totalled {selectedRow.days_over_month} day
                      {selectedRow.days_over_month === 1 ? "" : "s"} more than the {selectedRow.working_days} in{" "}
                      {formatPeriod(selectedPeriod)} — some date carries two statuses. Trimmed from leave/absent
                      so pay matches the month; fix it on the attendance board.
                    </p>
                  )}

                  <div className="pt-3 border-t border-slate-200 grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Base Salary</label>
                      <input
                        type="number"
                        value={selectedRow.base_salary}
                        disabled
                        readOnly
                        className="w-full px-2 py-1 border border-slate-200 rounded text-sm bg-slate-50 text-slate-500 cursor-not-allowed"
                      />
                      <p className="text-[11px] text-slate-500 mt-1">
                        Set on Assignments &amp; Pay — salary is effective-dated, so changing it here
                        would price this payslip off a figure no salary record contains.
                      </p>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Per Day (display)</label>
                      <input
                        type="number"
                        value={selectedRow.per_day_salary ?? ""}
                        disabled
                        className="w-full px-2 py-1 border border-slate-200 rounded text-sm bg-slate-50 text-slate-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Bonus</label>
                      <input
                        type="number"
                        value={selectedRow.bonus}
                        onChange={(e) =>
                          updateEdit(selectedRow.employee.id, { bonus: Number(e.target.value) })
                        }
                        className="w-full px-2 py-1 border border-slate-200 rounded text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Deductions</label>
                      <input
                        type="number"
                        value={selectedRow.deductions}
                        onChange={(e) =>
                          updateEdit(selectedRow.employee.id, { deductions: Number(e.target.value) })
                        }
                        className="w-full px-2 py-1 border border-slate-200 rounded text-sm"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs text-slate-500 mb-1">
                        Advance <span className="text-slate-400">(from Expenses · Advances)</span>
                      </label>
                      <input
                        type="number"
                        value={selectedRow.advance}
                        disabled
                        className="w-full px-2 py-1 border border-slate-200 rounded text-sm bg-slate-50 text-slate-500"
                      />
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-200 space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Allowed Leaves</span>
                      <span className="text-slate-700">
                        {selectedRow.allowed_leaves}
                        {leaveOverrides.has(selectedRow.employee.id) && (
                          <span className="ml-1 text-[10px] uppercase tracking-wide text-warning-700 dark:text-warning-500">
                            overridden
                          </span>
                        )}
                      </span>
                    </div>
                    {/* One employee, one month. Deliberately not a contract or
                        client setting — those apply to everyone on them, and to
                        every month after. */}
                    <div className="rounded border border-slate-200 bg-slate-50/60 px-2 py-2 space-y-1.5">
                      <label className="block text-[11px] text-slate-500">
                        Override allowed leaves · {formatPeriod(selectedPeriod)} only
                      </label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          step="0.5"
                          value={leaveDraft}
                          placeholder={String(
                            leaveOverrides.get(selectedRow.employee.id)?.allowed ??
                              selectedRow.allowed_leaves,
                          )}
                          onChange={(e) => setLeaveDraft(e.target.value)}
                          className="w-20 px-2 py-1 border border-slate-200 rounded text-sm"
                        />
                        <input
                          value={leaveReason}
                          placeholder="Reason (optional)"
                          onChange={(e) => setLeaveReason(e.target.value)}
                          className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-sm"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={leaveSaving}
                          onClick={() => saveLeaveOverride(selectedRow.employee.id, leaveDraft, leaveReason)}
                        >
                          {leaveSaving && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
                          Apply
                        </Button>
                        {leaveOverrides.has(selectedRow.employee.id) && (
                          <button
                            type="button"
                            disabled={leaveSaving}
                            onClick={() => { setLeaveDraft(""); setLeaveReason(""); saveLeaveOverride(selectedRow.employee.id, "", ""); }}
                            className="text-[11px] text-danger-600 hover:underline"
                          >
                            Remove override
                          </button>
                        )}
                      </div>
                      <p className="text-[10px] text-slate-500">
                        {leaveOverrides.get(selectedRow.employee.id)?.reason
                          ? `Reason: ${leaveOverrides.get(selectedRow.employee.id)?.reason}`
                          : "Applies to this employee for this month only. Blank = follow the contract."}
                      </p>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Leaves Taken</span>
                      <span className="text-slate-700">{selectedRow.leave_days}</span>
                    </div>
                    {!selectedRow.override_leaves && selectedRow.extra_leave_absent > 0 && (
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-500">Absent due to extra leaves</span>
                        <span className="text-danger-600">+{selectedRow.extra_leave_absent}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Effective Paid Days</span>
                      <span className="text-slate-900">
                        {selectedRow.effective_present_days} / {selectedRow.working_days}
                      </span>
                    </div>
                    <label className="flex items-center gap-2 text-xs pt-1">
                      <input
                        type="checkbox"
                        checked={selectedRow.override_leaves}
                        onChange={(e) =>
                          updateEdit(selectedRow.employee.id, {
                            override_leaves: e.target.checked,
                          })
                        }
                        className="rounded border-slate-300"
                      />
                      <span className="text-slate-700">
                        Allow full payment despite extra leaves
                      </span>
                    </label>
                    {selectedRow.override_leaves && (
                      <p className="text-xs text-success-700 bg-success-50 border border-success-200 rounded px-2 py-1">
                        Override on — all leaves paid. Click Save.
                      </p>
                    )}
                  </div>

                  <div className="pt-3 border-t border-slate-200 space-y-2">
                    {/* Allowance sits ABOVE Final Salary and is part of it — the
                        reports read final_salary, so this makes it count. */}
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500">Allowance</span>
                      <div className="flex items-center gap-1">
                        <span className="text-success-700">+ PKR</span>
                        <input
                          type="number"
                          min={0}
                          value={selectedRow.allowance}
                          onChange={(e) =>
                            updateEdit(selectedRow.employee.id, {
                              allowance: Math.max(0, Number(e.target.value) || 0),
                            })
                          }
                          className="w-24 px-2 py-1 border border-slate-200 rounded text-sm text-right"
                        />
                      </div>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Final Salary (incl. allowance)</span>
                      <span className="text-slate-900">PKR {selectedRow.final_salary.toLocaleString()}</span>
                    </div>
                    {selectedRow.income_tax > 0 && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">Income Tax (1% over 50K)</span>
                        <span className="text-danger-700">− PKR {Math.round(selectedRow.income_tax).toLocaleString()}</span>
                      </div>
                    )}
                    {selectedRow.eobi > 0 && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">EOBI</span>
                        <span className="text-danger-700">− PKR {Math.round(selectedRow.eobi).toLocaleString()}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-slate-500">Advance</span>
                      <span className="text-danger-700">− PKR {Math.round(selectedRow.advance).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between pt-1 border-t border-slate-100">
                      <span className="text-base text-slate-900">Net Salary</span>
                      <span className="text-lg text-slate-900">PKR {selectedRow.net_salary.toLocaleString()}</span>
                    </div>
                  </div>

                  {/* Amount Paid (locked, cumulative) + Balance + the Payment
                      Amount being made now. Disburse adds Payment Amount to
                      Amount Paid and moves exactly that much. */}
                  {(() => {
                    const paidSoFar = Math.round(selectedRow.amount_paid || 0);
                    const balance = Math.round(selectedRow.net_salary) - paidSoFar;
                    const payNow = Math.round(Number(paymentAmountDraft) || 0);
                    const exceeds = payNow > Math.max(0, balance) + 0.5;
                    return (
                      <div className="pt-3 border-t border-slate-200 space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-slate-500 text-sm">Amount Paid <span className="text-slate-400">(so far)</span></span>
                          <span className="text-sm font-medium text-slate-900 tabular-nums">PKR {paidSoFar.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-slate-500 text-sm">Balance <span className="text-slate-400">(Net − Paid)</span></span>
                          <span className={`text-sm font-medium tabular-nums ${balance > 0 ? "text-warning-700" : balance < 0 ? "text-danger-700" : "text-success-700"}`}>
                            PKR {balance.toLocaleString()}
                          </span>
                        </div>
                        {selectedRow.amount_paid > 0 && balance !== 0 && (
                          <p className={`text-[11px] rounded px-2 py-1 border ${balance > 0 ? "text-warning-800 dark:text-warning-500 bg-warning-50 border-warning-200" : "text-danger-700 bg-danger-50 border-danger-200"}`}>
                            {balance > 0
                              ? `PKR ${balance.toLocaleString()} still owed — PKR ${paidSoFar.toLocaleString()} paid but Net is now higher. Pay the balance below.`
                              : `PKR ${Math.abs(balance).toLocaleString()} overpaid — PKR ${paidSoFar.toLocaleString()} paid but Net dropped. Save to carry it to next month as an advance.`}
                          </p>
                        )}
                        {/* Payment Amount — the money to move now. Sits directly
                            above Payment Mode. Capped at Balance. */}
                        {balance > 0 && (
                          <div className="pt-1">
                            <label className="flex justify-between items-center mb-1">
                              <span className="text-slate-500 text-sm">Payment Amount <span className="text-slate-400">(pay now)</span></span>
                              <span className="text-[11px] text-brand-600 cursor-pointer hover:underline" onClick={() => setPaymentAmountDraft(String(balance))}>Pay full balance</span>
                            </label>
                            <div className="flex items-center gap-1">
                              <span className="text-slate-400 text-sm">PKR</span>
                              <input
                                type="number"
                                min={0}
                                max={balance}
                                value={paymentAmountDraft}
                                placeholder={`0 — up to ${balance.toLocaleString()}`}
                                onChange={(e) => setPaymentAmountDraft(e.target.value)}
                                className={`w-full px-2 py-1 border rounded text-sm text-right ${exceeds ? "border-danger-400 bg-danger-50" : "border-slate-200"}`}
                              />
                            </div>
                            {exceeds && (
                              <p className="text-[11px] text-danger-700 mt-1">
                                Payment Amount cannot exceed the Balance of PKR {balance.toLocaleString()}.
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  <div className="pt-3 border-t border-slate-200 space-y-2">
                    <label className="block text-xs text-slate-500">Payment Mode</label>
                    <ThemedSelect
                      value={selectedRow.payment_mode}
                      onChange={(e) =>
                        updateEdit(selectedRow.employee.id, {
                          payment_mode: e.target.value as PaymentMode,
                          cheque_id: null,
                        })
                      }
                      className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                    >
                      <option value="Cash">Cash</option>
                      <option value="Bank">Bank</option>
                      <option value="Cheque">Cheque</option>
                    </ThemedSelect>
                    {selectedRow.payment_mode === "Cash" && (
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Paid By (custodian) *</label>
                        <ThemedSelect
                          value={cashCustodianId}
                          onChange={(e) => setCashCustodianId(e.target.value)}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                        >
                          <option value="">Select who is paying this cash…</option>
                          {custodians.map((c) => (
                            <option key={c.employeeId} value={c.employeeId}>
                              {c.fullName} — holds PKR {Math.round(c.held).toLocaleString()}
                            </option>
                          ))}
                        </ThemedSelect>
                        <p className="text-[11px] text-slate-500 mt-1">
                          The office-staff member physically handing out this cash. Their tracked cash decreases and it logs in Cash Custody.
                        </p>
                      </div>
                    )}
                    {selectedRow.payment_mode === "Bank" && (
                      <ThemedSelect
                        value={selectedRow.bank_account_id ?? ""}
                        onChange={(e) =>
                          updateEdit(selectedRow.employee.id, {
                            bank_account_id: e.target.value || null,
                          })
                        }
                        className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                      >
                        <option value="">Select bank account</option>
                        {banks.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.bank_name} · {b.account_number} (PKR {Number(b.balance).toLocaleString()})
                          </option>
                        ))}
                      </ThemedSelect>
                    )}
                    {selectedRow.payment_mode === "Cheque" && (
                      <>
                        <ThemedSelect
                          value={selectedRow.cheque_id ?? ""}
                          onChange={(e) => {
                            const id = e.target.value || null;
                            const chq = id ? cheques.find((c) => c.id === id) : null;
                            updateEdit(selectedRow.employee.id, {
                              cheque_id: id,
                              bank_account_id: chq?.bank_account_id ?? null,
                            });
                          }}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                        >
                          <option value="">Select a pending cheque</option>
                          {cheques
                            .filter((c) => c.status === "pending" || c.id === selectedRow.cheque_id)
                            .map((c) => {
                              const bank = banks.find((b) => b.id === c.bank_account_id);
                              const ownPrev = selectedRow.cheque_id === c.id ? selectedRow.net_salary : 0;
                              const remaining = chequeRemaining(c.id, ownPrev);
                              return (
                                <option key={c.id} value={c.id}>
                                  #{c.cheque_number} · {bank?.bank_name ?? "Bank"} · PKR {Number(c.amount).toLocaleString()} (remaining PKR {remaining.toLocaleString()}) · {c.status}
                                </option>
                              );
                            })}
                        </ThemedSelect>
                        <p className="text-[11px] text-slate-500">
                          Cashflow recognises this salary only after the cheque is marked Cleared in Bank Accounts → Cheques.
                        </p>
                      </>
                    )}
                  </div>

                  {rowError && (
                    <div className="flex items-start gap-2 p-2 bg-danger-50 text-danger-700 border border-danger-200 rounded text-xs">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" strokeWidth={2} />
                      <div className="flex-1">{rowError}</div>
                      <button type="button" onClick={() => setRowError(null)}>
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 pt-3 border-t border-slate-200">
                    <Button
                      variant={selectedRow.status === "Cleared" ? "secondary" : "primary"}
                      size="sm"
                      onClick={() => toggleStatus(selectedRow)}
                    >
                      {selectedRow.status === "Cleared" ? "Mark Pending" : "Mark Cleared"}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      // Salaries can't be un-disbursed, so a fully-paid row's
                      // button is a disabled "Disbursed" marker — never a reversal.
                      disabled={
                        savingId === selectedRow.employee.id ||
                        Math.round(selectedRow.amount_paid || 0) >= Math.round(selectedRow.net_salary)
                      }
                      onClick={() => {
                        // Validate the Payment Amount against the Balance, then open
                        // the date modal to pay it.
                        const paidSoFar = Math.round(selectedRow.amount_paid || 0);
                        const balance = Math.round(selectedRow.net_salary) - paidSoFar;
                        const payNow = Math.round(Number(paymentAmountDraft) || 0);
                        if (payNow <= 0) {
                          setRowError("Enter a Payment Amount greater than 0.");
                          return;
                        }
                        if (payNow > balance + 0.5) {
                          setRowError(`Payment Amount cannot exceed the Balance of PKR ${balance.toLocaleString()}.`);
                          return;
                        }
                        setRowError(null);
                        setRowDisburseDate(todayISO());
                        setRowDisburseTarget(selectedRow);
                      }}
                    >
                      {Math.round(selectedRow.amount_paid || 0) >= Math.round(selectedRow.net_salary)
                        ? "Disbursed"
                        : selectedRow.amount_paid > 0
                          ? "Pay balance"
                          : "Disburse"}
                    </Button>
                  </div>

                  <div className="flex gap-2 pt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleSaveRow(selectedRow)}
                      disabled={savingId === selectedRow.employee.id}
                    >
                      {savingId === selectedRow.employee.id ? "Saving…" : "Save"}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      className="flex-1"
                      onClick={() => openPayslipModal(selectedRow)}
                    >
                      Payslip
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          )}
        </div>
        </div>
      </div>

      <Modal
        isOpen={isPayslipModalOpen}
        onClose={() => setIsPayslipModalOpen(false)}
        title="Payslip Preview"
        size="lg"
      >
        {payslipData && (
          <div className="space-y-4 bg-white">
            <div className="text-center pb-4 border-b border-slate-200">
              <h3 className="text-lg text-slate-900">Payslip</h3>
              <p className="text-sm text-slate-500">{formatPeriod(payslipData.period_month)}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-slate-500 mb-1">Employee</p>
                <p className="text-slate-900">{payslipData.employee.full_name}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Employee ID</p>
                <p className="text-slate-900 font-mono">{empDisplay(payslipData.employee)}</p>
              </div>
              {payslipData.employee.phone && (
                <div>
                  <p className="text-slate-500 mb-1">Phone</p>
                  <p className="text-slate-900">{payslipData.employee.phone}</p>
                </div>
              )}
              <div>
                <p className="text-slate-500 mb-1">Payment Mode</p>
                <p className="text-slate-900">{payslipData.payment_mode}</p>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200">
              <h4 className="text-sm text-slate-900 mb-3">Attendance</h4>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
                <div className="bg-slate-50 p-2 rounded">
                  <p className="text-xs text-slate-500">Working</p>
                  <p className="text-slate-900">{payslipData.working_days}</p>
                </div>
                <div className="bg-success-50 p-2 rounded">
                  <p className="text-xs text-success-700">Present</p>
                  <p className="text-success-900">{payslipData.present_days}</p>
                </div>
                <div className="bg-brand-50 p-2 rounded">
                  <p className="text-xs text-brand-700">Double duty</p>
                  <p className="text-brand-900">{payslipData.double_duty_shifts}</p>
                </div>
                <div className="bg-danger-50 p-2 rounded">
                  <p className="text-xs text-danger-700">Absent</p>
                  <p className="text-danger-900">{payslipData.absent_days}</p>
                </div>
                <div className="bg-warning-50 p-2 rounded">
                  <p className="text-xs text-warning-700">Leave</p>
                  <p className="text-warning-900">{payslipData.leave_days}</p>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200">
              <h4 className="text-sm text-slate-900 mb-3">Earnings &amp; Deductions</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-600">Allowed Leaves</span>
                  <span className="text-slate-900">{payslipData.allowed_leaves}</span>
                </div>
                {payslipData.override_leaves && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Leave Override</span>
                    <span className="text-success-700">Yes (all leaves paid)</span>
                  </div>
                )}
                {payslipData.extra_leave_absent > 0 && !payslipData.override_leaves && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Absent (extra leaves)</span>
                    <span className="text-danger-600">{payslipData.extra_leave_absent}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-600">Effective Paid Days</span>
                  <span className="text-slate-900">
                    {payslipData.effective_present_days} / {payslipData.working_days}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Base Salary</span>
                  <span className="text-slate-900">PKR {payslipData.base_salary.toLocaleString()}</span>
                </div>
                {payslipData.per_day_salary != null && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Per Day Salary</span>
                    <span className="text-slate-900">
                      PKR {Number(payslipData.per_day_salary).toLocaleString()}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-600">Earned (Per Day × Paid Days)</span>
                  <span className="text-slate-900">
                    PKR{" "}
                    {Math.round(
                      (payslipData.per_day_salary ?? 0) *
                        payslipData.effective_present_days
                    ).toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Bonus</span>
                  <span className="text-success-600">+ PKR {payslipData.bonus.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Deductions</span>
                  <span className="text-danger-600">− PKR {payslipData.deductions.toLocaleString()}</span>
                </div>
                {payslipData.allowance > 0 && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Allowance</span>
                    <span className="text-success-600">+ PKR {Math.round(payslipData.allowance).toLocaleString()}</span>
                  </div>
                )}
                <div className="flex justify-between pt-2 border-t border-slate-200">
                  <span className="text-slate-700">Final Salary (incl. allowance)</span>
                  <span className="text-slate-900">PKR {payslipData.final_salary.toLocaleString()}</span>
                </div>
                {payslipData.income_tax > 0 && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Income Tax (1% over PKR 50,000)</span>
                    <span className="text-danger-600">− PKR {Math.round(payslipData.income_tax).toLocaleString()}</span>
                  </div>
                )}
                {payslipData.eobi > 0 && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">EOBI</span>
                    <span className="text-danger-600">− PKR {Math.round(payslipData.eobi).toLocaleString()}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-600">Advance</span>
                  <span className="text-danger-600">− PKR {payslipData.advance.toLocaleString()}</span>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t-2 border-slate-300">
              <div className="flex justify-between items-center">
                <span className="text-base text-slate-900">Net Salary</span>
                <span className="text-xl text-slate-900">
                  PKR {payslipData.net_salary.toLocaleString()}
                </span>
              </div>
              <div className="mt-2 flex justify-between text-xs text-slate-500">
                <span>Status: {payslipData.status}</span>
                <span>Disbursed: {payslipData.disbursed ? "Yes" : "No"}</span>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
              <Button variant="primary" size="md" className="flex-1" onClick={() => downloadPdf(payslipData)}>
                <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Download PDF
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsPayslipModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={isBulkDisburseOpen}
        error={error}
        onDismissError={() => setError(null)}
        onClose={() => setIsBulkDisburseOpen(false)}
        title="Mark All as Disbursed"
        size="md"
      >
        {(() => {
          // Pay each row its outstanding Balance (Net − Amount Paid), matching
          // what handleBulkDisburse actually moves — never the full Net Salary.
          const remainingOf = (r: RowState) => Math.round(r.net_salary) - Math.round(r.amount_paid || 0);
          const candidates = filtered.filter((r) => remainingOf(r) > 0);
          const total = candidates.reduce((s, r) => s + remainingOf(r), 0);
          return (
            <div className="space-y-4">
              <div className="bg-slate-50 border border-slate-200 rounded-md p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-600">Rows with an unpaid balance</span>
                  <span className="text-slate-900">{candidates.length}</span>
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-slate-600">Total balance to disburse</span>
                  <span className="text-slate-900">PKR {total.toLocaleString()}</span>
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-slate-600">Period</span>
                  <span className="text-slate-900">{formatPeriod(selectedPeriod)}</span>
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  Only employees currently visible under the active filters will be
                  disbursed.
                </p>
              </div>

              <div>
                <label className="block text-sm text-slate-700 mb-2">Payment Mode</label>
                <div className="flex gap-3">
                  {(["Cash", "Bank"] as const).map((m) => (
                    <label
                      key={m}
                      className={`flex-1 flex items-center gap-2 px-4 py-2 border rounded-md cursor-pointer text-sm ${
                        bulkMode === m
                          ? "border-slate-900 bg-slate-50"
                          : "border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      <input
                        type="radio"
                        name="bulk-mode"
                        checked={bulkMode === m}
                        onChange={() => setBulkMode(m)}
                      />
                      <span>{m}</span>
                    </label>
                  ))}
                </div>
              </div>

              {bulkMode === "Bank" && (
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Bank Account</label>
                  <ThemedSelect
                    value={bulkBankId}
                    onChange={(e) => setBulkBankId(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="">Select bank account</option>
                    {banks.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.bank_name} · {b.account_number} (PKR {Number(b.balance).toLocaleString()})
                      </option>
                    ))}
                  </ThemedSelect>
                </div>
              )}

              {bulkMode === "Cash" && (
                <div>
                  <label className="block text-sm text-slate-700 mb-1">Paid By (custodian) *</label>
                  <ThemedSelect
                    value={bulkCashCustodianId}
                    onChange={(e) => setBulkCashCustodianId(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="">Select who is paying this cash…</option>
                    {custodians.map((c) => (
                      <option key={c.employeeId} value={c.employeeId}>
                        {c.fullName} — holds PKR {Math.round(c.held).toLocaleString()}
                      </option>
                    ))}
                  </ThemedSelect>
                  <p className="text-xs text-slate-500 mt-1">
                    Current cash balance: PKR {cashBalance.toLocaleString()}. This custodian's tracked cash decreases and each payment logs in Cash Custody.
                  </p>
                </div>
              )}

              <div>
                <label className="block text-sm text-slate-700 mb-1">Disbursement Date</label>
                <input
                  type="date"
                  value={bulkDisburseDate}
                  onChange={(e) => setBulkDisburseDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Cashflow will bucket this disbursement under the selected date's month.
                </p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <Button
                  variant="primary"
                  size="md"
                  className="flex-1"
                  onClick={handleBulkDisburse}
                  disabled={bulkSubmitting || candidates.length === 0}
                >
                  {bulkSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  {bulkSubmitting ? `Disbursing ${candidates.length} payslip${candidates.length === 1 ? "" : "s"}…` : `Disburse ${candidates.length} Payslip${candidates.length === 1 ? "" : "s"}`}
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => setIsBulkDisburseOpen(false)}
                  disabled={bulkSubmitting}
                >
                  Cancel
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>

      <Modal
        isOpen={rowDisburseTarget !== null}
        error={error}
        onDismissError={() => setError(null)}
        onClose={() => setRowDisburseTarget(null)}
        title="Disbursement Date"
        size="sm"
      >
        {rowDisburseTarget && (() => {
          const already = Math.round(rowDisburseTarget.amount_paid || 0);
          // paymentAmountDraft is the amount paid NOW; it accumulates onto
          // Amount Paid, so the new cumulative target is already + payNow.
          const payNow = Math.max(0, Math.round(Number(paymentAmountDraft) || 0));
          const target = already + payNow;
          const balAfter = Math.round(rowDisburseTarget.net_salary) - target;
          return (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Paying{" "}
              <span className="text-slate-900 font-medium">{rowDisburseTarget.employee.full_name}</span>{" "}
              ({empDisplay(rowDisburseTarget.employee)})
            </p>
            <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-sm space-y-1">
              <div className="flex justify-between"><span className="text-slate-500">Net Salary</span><span className="text-slate-900">PKR {Math.round(rowDisburseTarget.net_salary).toLocaleString()}</span></div>
              {already > 0 && (
                <div className="flex justify-between"><span className="text-slate-500">Already paid</span><span className="text-slate-900">PKR {already.toLocaleString()}</span></div>
              )}
              <div className="flex justify-between font-medium"><span className="text-slate-700">Paying now</span><span className={payNow < 0 ? "text-warning-700" : "text-slate-900"}>PKR {payNow.toLocaleString()}</span></div>
              <div className="flex justify-between border-t border-slate-200 pt-1">
                <span className="text-slate-500">Balance after</span>
                <span className={balAfter > 0 ? "text-warning-700" : balAfter < 0 ? "text-danger-700" : "text-success-700"}>
                  PKR {balAfter.toLocaleString()}{balAfter < 0 ? " (overpaid → next month)" : balAfter > 0 ? " (still owed)" : ""}
                </span>
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Disbursement Date *</label>
              <input
                type="date"
                value={rowDisburseDate}
                onChange={(e) => setRowDisburseDate(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                required
              />
              <p className="text-xs text-slate-500 mt-1">
                Cashflow will bucket this under the selected date's month.
              </p>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <Button
                variant="primary"
                size="md"
                className="flex-1"
                disabled={!rowDisburseDate}
                onClick={async () => {
                  const tgt = rowDisburseTarget;
                  const date = rowDisburseDate;
                  const paidTo = already + Math.max(0, Math.round(Number(paymentAmountDraft) || 0));
                  setRowDisburseTarget(null);
                  await settlePayment(tgt, paidTo, date);
                }}
              >
                Confirm &amp; Disburse
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => setRowDisburseTarget(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
          );
        })()}
      </Modal>
    </>
  );
}
