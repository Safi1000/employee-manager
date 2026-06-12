import { useEffect, useMemo, useState } from "react";
import { Search, Download, AlertCircle, X, Loader2 } from "lucide-react";
import jsPDF from "jspdf";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import BusyOverlay from "../../components/BusyOverlay";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import {
  supabase,
  type Employee,
  type Location,
  type Client,
  type BankAccount,
  type Payslip,
  type PaymentMode,
  type PayslipStatus,
  type Cheque,
  type Branch,
} from "../../lib/supabase";

type EmployeeRow = Employee & { location_name: string | null; client_name: string | null };

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
  final_salary: number;
  net_salary: number;
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
  const today = new Date();
  const currentPeriod = firstOfMonth(today);
  // Default the filter to the previous month — payroll is typically processed
  // after a month has ended.
  const previousPeriod = firstOfMonth(new Date(today.getFullYear(), today.getMonth() - 1, 1));

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
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
  const [attendanceAgg, setAttendanceAgg] = useState<Map<string, { present: number; absent: number; leave: number }>>(
    new Map()
  );
  const [advancesByEmployee, setAdvancesByEmployee] = useState<Map<string, number>>(new Map());
  const [priorLeavesByMonth, setPriorLeavesByMonth] = useState<Map<string, Map<string, number>>>(new Map());
  const [cashBalance, setCashBalance] = useState(0);

  const [isBulkDisburseOpen, setIsBulkDisburseOpen] = useState(false);
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const [bulkDisburseDate, setBulkDisburseDate] = useState<string>(todayISO());
  const [rowDisburseTarget, setRowDisburseTarget] = useState<RowState | null>(null);
  const [rowDisburseDate, setRowDisburseDate] = useState<string>(todayISO());
  const [bulkMode, setBulkMode] = useState<PaymentMode>("Cash");
  const [bulkBankId, setBulkBankId] = useState<string>("");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkClearing, setBulkClearing] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [shiftFilter, setShiftFilter] = useState<"all" | "day" | "night">("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [clientFilter, setClientFilter] = useState("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [employeeAddlBranches, setEmployeeAddlBranches] = useState<Map<string, string[]>>(new Map());
  const [statusFilter, setStatusFilter] = useState<"all" | "Cleared" | "Pending">("all");
  const [disbursedFilter, setDisbursedFilter] = useState<"all" | "yes" | "no">("all");
  const [branches, setBranches] = useState<Branch[]>([]);

  const [periodOptions, setPeriodOptions] = useState<string[]>([currentPeriod, previousPeriod]);
  const [selectedPeriod, setSelectedPeriod] = useState(previousPeriod);

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
    const [attRes, payRes, advRes, attHistRes] = await Promise.all([
      supabase.rpc("attendance_period_counts", { p_start: start, p_end: end }),
      supabase.from("payslips").select("*").eq("period_month", period),
      supabase
        .from("advances")
        .select("employee_id, amount")
        .gte("advance_date", start)
        .lte("advance_date", end),
      supabase.rpc("attendance_leave_history", {
        p_window_start: carryWindowStartIso,
        p_until: start,
      }),
    ]);
    const agg = new Map<string, { present: number; absent: number; leave: number }>();
    (attRes.data ?? []).forEach((a: any) => {
      const cur = agg.get(a.employee_id) ?? { present: 0, absent: 0, leave: 0 };
      const cnt = Number(a.cnt) || 0;
      if (a.status === "Present") cur.present += cnt;
      else if (a.status === "Absent") cur.absent += cnt;
      else if (a.status === "Leave") cur.leave += cnt;
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
        .eq("status", "Present");
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
      advMap.set(a.employee_id, (advMap.get(a.employee_id) ?? 0) + Number(a.amount));
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
    setSelectedId(null);
  };

  const loadAll = async () => {
    setLoading(true);
    setError(null);

    const sixAgo = new Date(today.getFullYear(), today.getMonth() - 6, 1);
    const cutoff = firstOfMonth(sixAgo);
    await supabase.from("payslips").delete().lt("period_month", cutoff);

    const [empRes, locRes, cliRes, bankRes, treaRes, chqRes, brRes] = await Promise.all([
      supabase
        .from("employees")
        .select("*, location:location_id(name), client:client_id(name)")
        .order("employee_code"),
      supabase.from("locations").select("*").order("name"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("bank_accounts").select("*").order("bank_name"),
      supabase.from("treasury").select("*").limit(1).maybeSingle(),
      supabase.from("cheques").select("*").order("cheque_date", { ascending: false }),
      supabase.from("branches").select("*").order("is_head_office", { ascending: false }).order("name"),
    ]);

    if (empRes.error) setError(empRes.error.message);
    setEmployees(
      (empRes.data ?? []).map((e: any) => ({
        ...e,
        location_name: e.location?.name ?? null,
        client_name: e.client?.name ?? null,
      }))
    );
    setLocations(locRes.data ?? []);
    setClients(cliRes.data ?? []);
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
  }, []);

  useEffect(() => {
    if (!loading) loadPeriodData(selectedPeriod);
  }, [selectedPeriod]);

  const clientAllowedLeaves = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of clients) {
      m.set(c.id, Number(c.allowed_leaves_per_month ?? 0));
    }
    return m;
  }, [clients]);

  const clientCarryEnabled = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const c of clients) {
      m.set(c.id, !!(c as any).leave_carry_forward);
    }
    return m;
  }, [clients]);

  // Per-client EOBI: amount (PKR) the client wants withheld per employee.
  // 0 (or disabled) means no EOBI for that client.
  const clientEobiAmount = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of clients as Array<{ id: string; eobi_enabled?: boolean; eobi_amount?: number }>) {
      m.set(c.id, c.eobi_enabled ? Number(c.eobi_amount ?? 0) : 0);
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
      const base = clientAllowedLeaves.get(emp.client_id) ?? 0;
      // Months from the carry anchor up to (but excluding) the selected period.
      // No anchor → no backlog (this period simply gets `base`), which avoids the
      // old "compounds out of nowhere" bug (item 8).
      const startStr = clientCarryStart.get(emp.client_id);
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
      let allowed = base;
      for (const k of monthKeys) {
        const used = empLeaves.get(k) ?? 0;
        const unused = Math.max(0, allowed - used);
        allowed = base + unused;
      }
      out.set(emp.id, allowed);
    }
    return out;
  }, [employees, clientCarryEnabled, clientAllowedLeaves, clientCarryStart, priorLeavesByMonth, selectedPeriod]);

  const rows = useMemo<RowState[]>(() => {
    const daysThisPeriod = daysInMonth(selectedPeriod);
    return employees.map((emp) => {
      const existing = payslipsMap.get(emp.id);
      const att = attendanceAgg.get(emp.id) ?? { present: 0, absent: 0, leave: 0 };
      const baseSal = Number(existing?.base_salary ?? emp.base_salary ?? 0);
      const computedAdvance = advancesByEmployee.get(emp.id) ?? 0;
      const baseAllowed = emp.client_id ? clientAllowedLeaves.get(emp.client_id) ?? 0 : 0;
      const carryAllowed = carriedAllowance.get(emp.id);
      const allowed = carryAllowed ?? baseAllowed;
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
        final_salary: 0,
        net_salary: 0,
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
      };
      const edits = rowEdits.get(emp.id) ?? {};
      const merged = { ...defaults, ...edits };
      merged.advance = computedAdvance;
      merged.allowed_leaves = allowed;

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

      const perDay = daysThisPeriod > 0 && merged.base_salary > 0
        ? merged.base_salary / daysThisPeriod
        : 0;
      merged.per_day_salary = perDay > 0 ? Math.round(perDay) : null;
      const earned = Math.round(perDay * merged.effective_present_days);
      merged.final_salary = Math.max(0, Math.round(earned + merged.bonus - merged.deductions));
      // Income tax: 1% of (final_salary - 50000) when > 50000.
      merged.income_tax = merged.final_salary > 50000
        ? Math.round((merged.final_salary - 50000) * 0.01)
        : 0;
      // EOBI: per-client flat amount, applied when employee has a client and
      // that client has eobi_enabled.
      merged.eobi = emp.client_id ? clientEobiAmount.get(emp.client_id) ?? 0 : 0;
      merged.net_salary = Math.max(
        0,
        Math.round(merged.final_salary - merged.income_tax - merged.eobi - merged.advance),
      );
      return merged;
    });
  }, [employees, payslipsMap, attendanceAgg, advancesByEmployee, clientAllowedLeaves, clientEobiAmount, carriedAllowance, selectedPeriod, rowEdits]);

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
        !(e.phone ?? "").toLowerCase().includes(q)
      )
        return false;
      if (shiftFilter !== "all" && e.shift !== shiftFilter) return false;
      if (locationFilter !== "all" && e.location_id !== locationFilter) return false;
      if (clientFilter !== "all" && e.client_id !== clientFilter) return false;
      if (branchFilter !== "all") {
        const inPrimary = e.branch_id === branchFilter;
        const inAdditional = (employeeAddlBranches.get(e.id) ?? []).includes(branchFilter);
        if (!inPrimary && !inAdditional) return false;
      }
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (disbursedFilter !== "all" && (disbursedFilter === "yes" ? !r.disbursed : r.disbursed)) return false;
      return true;
    });
  }, [rows, search, shiftFilter, locationFilter, clientFilter, branchFilter, statusFilter, disbursedFilter, employeeAddlBranches, relieversOnly]);

  const selectedRow = useMemo(
    () => rows.find((r) => r.employee.id === selectedId) ?? null,
    [rows, selectedId]
  );

  const payrollTotals = useMemo(() => {
    let disbursed = 0;
    let notDisbursed = 0;
    let advance = 0;
    for (const r of filtered) {
      advance += r.advance;
      if (r.disbursed) disbursed += r.net_salary;
      else notDisbursed += r.net_salary;
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

  const savePayslip = async (row: RowState): Promise<void> => {
    const payload = {
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
      final_salary: row.final_salary,
      net_salary: row.net_salary,
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
    };
    const { error: upErr } = await supabase
      .from("payslips")
      .upsert(payload, { onConflict: "employee_id,period_month" });
    if (upErr) throw upErr;
  };

  const handleSaveRow = async (row: RowState) => {
    setSavingId(row.employee.id);
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

  const toggleDisbursed = async (row: RowState, dateOverride?: string) => {
    setSavingId(row.employee.id);
    setError(null);
    setRowError(null);
    try {
      if (!row.disbursed) {
        const disburseIso = dateOverride
          ? new Date(`${dateOverride}T12:00:00`).toISOString()
          : new Date().toISOString();
        if (row.net_salary <= 0) {
          setRowError("Net salary must be greater than 0 to disburse.");
          return;
        }
        if (row.payment_mode === "Bank") {
          if (!row.bank_account_id) {
            setRowError("Select a bank account before disbursing.");
            return;
          }
          const bank = banks.find((b) => b.id === row.bank_account_id);
          if (!bank) {
            setRowError("Bank account not found.");
            return;
          }
          if (row.net_salary > Number(bank.balance)) {
            setRowError("Selected bank account balance is insufficient.");
            return;
          }
          const { error: bErr } = await supabase
            .from("bank_accounts")
            .update({
              balance: Number(bank.balance) - row.net_salary,
              updated_at: new Date().toISOString(),
            })
            .eq("id", bank.id);
          if (bErr) throw bErr;
          await supabase.from("bank_transactions").insert({
            bank_account_id: bank.id,
            kind: "payroll",
            amount: row.net_salary,
            cash_delta: 0,
            account_delta: -row.net_salary,
            description: `Payroll ${formatPeriod(row.period_month)} · ${row.employee.employee_code} ${row.employee.full_name}`,
          });
        } else if (row.payment_mode === "Cheque") {
          if (!row.cheque_id) {
            setRowError("Select a cheque before disbursing.");
            return;
          }
          const ownPrev = row.payslip_id ? row.net_salary : 0;
          const remaining = chequeRemaining(row.cheque_id, ownPrev);
          if (row.net_salary > remaining + 0.005) {
            setRowError(`Net salary (PKR ${row.net_salary.toLocaleString()}) exceeds the cheque's remaining capacity (PKR ${remaining.toLocaleString()}).`);
            return;
          }
        } else {
          if (row.net_salary > cashBalance) {
            setRowError("Cash balance is insufficient.");
            return;
          }
          const { data: trea } = await supabase
            .from("treasury")
            .select("id, cash_balance")
            .limit(1)
            .maybeSingle();
          if (trea) {
            await supabase
              .from("treasury")
              .update({
                cash_balance: Number(trea.cash_balance) - row.net_salary,
                updated_at: new Date().toISOString(),
              })
              .eq("id", trea.id);
          }
          await supabase.from("bank_transactions").insert({
            bank_account_id: null,
            kind: "payroll",
            amount: row.net_salary,
            cash_delta: -row.net_salary,
            account_delta: 0,
            description: `Payroll (cash) ${formatPeriod(row.period_month)} · ${row.employee.employee_code} ${row.employee.full_name}`,
          });
        }
        await savePayslip({
          ...row,
          disbursed: true,
          disbursed_at: disburseIso,
          status: "Cleared",
        });
      } else {
        if (row.payment_mode === "Bank" && row.bank_account_id) {
          const bank = banks.find((b) => b.id === row.bank_account_id);
          if (bank) {
            await supabase
              .from("bank_accounts")
              .update({
                balance: Number(bank.balance) + row.net_salary,
                updated_at: new Date().toISOString(),
              })
              .eq("id", bank.id);
          }
          await supabase.from("bank_transactions").insert({
            bank_account_id: row.bank_account_id,
            kind: "payroll",
            amount: row.net_salary,
            cash_delta: 0,
            account_delta: row.net_salary,
            description: `Reverse payroll ${formatPeriod(row.period_month)} · ${row.employee.employee_code} ${row.employee.full_name}`,
          });
        } else if (row.payment_mode === "Cheque") {
          // Cheque-paid: do not touch bank balance. Un-disburse only flips the flag.
        } else {
          const { data: trea } = await supabase
            .from("treasury")
            .select("id, cash_balance")
            .limit(1)
            .maybeSingle();
          if (trea) {
            await supabase
              .from("treasury")
              .update({
                cash_balance: Number(trea.cash_balance) + row.net_salary,
                updated_at: new Date().toISOString(),
              })
              .eq("id", trea.id);
          }
          await supabase.from("bank_transactions").insert({
            bank_account_id: null,
            kind: "payroll",
            amount: row.net_salary,
            cash_delta: row.net_salary,
            account_delta: 0,
            description: `Reverse payroll (cash) ${formatPeriod(row.period_month)} · ${row.employee.employee_code} ${row.employee.full_name}`,
          });
        }
        await savePayslip({ ...row, disbursed: false, disbursed_at: null });
      }
      await loadAll();
    } catch (err: any) {
      setRowError(err.message ?? String(err));
    } finally {
      setSavingId(null);
    }
  };

  const handleBulkDisburse = async () => {
    setError(null);
    const candidates = filtered.filter((r) => !r.disbursed && r.net_salary > 0);
    if (candidates.length === 0) {
      setError("No pending rows in the current filter to disburse.");
      return;
    }
    if (bulkMode === "Bank" && !bulkBankId) {
      setError("Select a bank account for bulk disbursement.");
      return;
    }
    const total = candidates.reduce((s, r) => s + r.net_salary, 0);
    if (bulkMode === "Cash") {
      if (total > cashBalance) {
        setError(`Cash balance (PKR ${cashBalance.toLocaleString()}) is insufficient for PKR ${total.toLocaleString()}.`);
        return;
      }
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
    try {
      for (const row of candidates) {
        const net = row.net_salary;
        if (bulkMode === "Bank") {
          const { data: bankNow } = await supabase
            .from("bank_accounts")
            .select("id, balance, bank_name, account_number")
            .eq("id", bulkBankId)
            .single();
          if (!bankNow) throw new Error("Bank account not found mid-bulk.");
          if (net > Number(bankNow.balance)) {
            throw new Error(`Bank balance exhausted at ${row.employee.employee_code}.`);
          }
          await supabase
            .from("bank_accounts")
            .update({
              balance: Number(bankNow.balance) - net,
              updated_at: new Date().toISOString(),
            })
            .eq("id", bulkBankId);
          await supabase.from("bank_transactions").insert({
            bank_account_id: bulkBankId,
            kind: "payroll",
            amount: net,
            cash_delta: 0,
            account_delta: -net,
            description: `Payroll ${formatPeriod(row.period_month)} · ${row.employee.employee_code} ${row.employee.full_name}`,
          });
        } else {
          const { data: trea } = await supabase
            .from("treasury")
            .select("id, cash_balance")
            .limit(1)
            .maybeSingle();
          if (!trea) throw new Error("Treasury row missing.");
          if (net > Number(trea.cash_balance)) {
            throw new Error(`Cash exhausted at ${row.employee.employee_code}.`);
          }
          await supabase
            .from("treasury")
            .update({
              cash_balance: Number(trea.cash_balance) - net,
              updated_at: new Date().toISOString(),
            })
            .eq("id", trea.id);
          await supabase.from("bank_transactions").insert({
            bank_account_id: null,
            kind: "payroll",
            amount: net,
            cash_delta: -net,
            account_delta: 0,
            description: `Payroll (cash) ${formatPeriod(row.period_month)} · ${row.employee.employee_code} ${row.employee.full_name}`,
          });
        }
        await savePayslip({
          ...row,
          payment_mode: bulkMode,
          bank_account_id: bulkMode === "Bank" ? bulkBankId : null,
          disbursed: true,
          disbursed_at: new Date(`${bulkDisburseDate}T12:00:00`).toISOString(),
          status: "Cleared",
        });
      }
      setIsBulkDisburseOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
      await loadAll();
    } finally {
      setBulkSubmitting(false);
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
    doc.text(`Employee: ${row.employee.full_name} (${row.employee.employee_code})`, 40, y);
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
    y += 4;
    doc.setFontSize(12);
    line("Final Salary (Earned + Bonus − Deductions)", `PKR ${row.final_salary.toLocaleString()}`);
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

  return (
    <>
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

      <div className="flex-1 overflow-y-auto p-8">
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
          <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-success-500">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total Disbursed</p>
            <p className="text-2xl text-success-900">
              PKR {payrollTotals.disbursed.toLocaleString()}
            </p>
            <p className="text-xs text-success-700/70 mt-0.5">
              {filtered.filter((r) => r.disbursed).length} payslip
              {filtered.filter((r) => r.disbursed).length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-warning-500">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total Not Disbursed</p>
            <p className="text-2xl text-warning-900">
              PKR {payrollTotals.notDisbursed.toLocaleString()}
            </p>
            <p className="text-xs text-warning-700/70 mt-0.5">
              {filtered.filter((r) => !r.disbursed).length} payslip
              {filtered.filter((r) => !r.disbursed).length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-danger-500">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total Advance</p>
            <p className="text-2xl text-danger-900">
              PKR {payrollTotals.advance.toLocaleString()}
            </p>
            <p className="text-xs text-danger-700/70 mt-0.5">
              for {formatPeriod(selectedPeriod)}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <div className="bg-white rounded-lg border border-slate-200">
              <div className="p-6 border-b border-slate-200 space-y-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-[220px] relative">
                    <Search
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"
                      strokeWidth={1.5}
                    />
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search by employee ID, name, or phone…"
                      className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                    />
                  </div>
                  <select
                    value={selectedPeriod}
                    onChange={(e) => setSelectedPeriod(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    {periodOptions.map((p) => (
                      <option key={p} value={p}>
                        {formatPeriod(p)}
                        {p === currentPeriod ? " (Current)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <select
                    value={shiftFilter}
                    onChange={(e) => setShiftFilter(e.target.value as "all" | "day" | "night")}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="all">All Shifts</option>
                    <option value="day">Day</option>
                    <option value="night">Night</option>
                  </select>
                  <select
                    value={locationFilter}
                    onChange={(e) => setLocationFilter(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="all">All Locations</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <ClientFilterSelect
                    clients={clients}
                    value={clientFilter}
                    onChange={setClientFilter}
                    allValue="all"
                  />
                  <select
                    value={branchFilter}
                    onChange={(e) => setBranchFilter(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="all">All Branches</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as "all" | "Cleared" | "Pending")}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="all">All Status</option>
                    <option value="Pending">Pending</option>
                    <option value="Cleared">Cleared</option>
                  </select>
                  <select
                    value={disbursedFilter}
                    onChange={(e) => setDisbursedFilter(e.target.value as "all" | "yes" | "no")}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="all">All Disbursed</option>
                    <option value="yes">Disbursed</option>
                    <option value="no">Not Disbursed</option>
                  </select>
                </div>
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
                      <th className="text-left px-4 py-3 text-xs text-slate-500">Disbursed</th>
                      <th className="text-left px-4 py-3 text-xs text-slate-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
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
                            className={`hover:bg-slate-50 transition-colors cursor-pointer ${
                              selectedId === e.id ? "bg-slate-50" : ""
                            }`}
                            onClick={() => { setSelectedId(e.id); setRowError(null); }}
                          >
                            <td className="px-4 py-3">
                              <div className="text-sm text-slate-900">{e.full_name}</div>
                              <div className="text-xs text-slate-500 font-mono">
                                {e.employee_code}
                                {e.phone ? ` · ${e.phone}` : ""}
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
                              <div>
                                <span className="text-success-700">P {row.present_days}</span>
                                {" / "}
                                <span className="text-danger-700">A {row.absent_days}</span>
                                {" / "}
                                <span className="text-warning-700">L {row.leave_days}</span>
                              </div>
                              <div className="text-slate-400">of {row.working_days} wd</div>
                            </td>
                            <td className="px-4 py-3 text-sm text-slate-700">
                              PKR {row.base_salary.toLocaleString()}
                            </td>
                            <td className="px-4 py-3 text-sm text-slate-900">
                              PKR {row.net_salary.toLocaleString()}
                            </td>
                            <td className="px-4 py-3">
                              <button
                                type="button"
                                disabled={savingId === e.id}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  toggleStatus(row);
                                }}
                                className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                                  row.status === "Cleared"
                                    ? "bg-success-50 text-success-700 hover:bg-success-100"
                                    : "bg-warning-50 text-warning-700 hover:bg-warning-100"
                                }`}
                              >
                                {row.status}
                              </button>
                            </td>
                            <td className="px-4 py-3">
                              <button
                                type="button"
                                disabled={savingId === e.id}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  if (!row.disbursed) {
                                    // Open date picker before disbursing
                                    setRowDisburseDate(todayISO());
                                    setRowDisburseTarget(row);
                                  } else {
                                    toggleDisbursed(row);
                                  }
                                }}
                                className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                                  row.disbursed
                                    ? "bg-success-50 text-success-700 hover:bg-success-100"
                                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                                }`}
                              >
                                {row.disbursed ? "Disbursed" : "Not Disbursed"}
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

          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg border border-slate-200 p-6 sticky top-4">
              <h3 className="text-base mb-4 text-slate-900">
                Salary Calculation
                {!isCurrent && (
                  <span className="ml-2 text-xs text-warning-700 bg-warning-50 px-2 py-0.5 rounded">
                    History
                  </span>
                )}
              </h3>

              {selectedRow ? (
                <div className="space-y-2.5 text-sm">
                  <div className="pb-2.5 border-b border-slate-200">
                    <p className="text-xs text-slate-500">Employee</p>
                    <p className="text-slate-900">{selectedRow.employee.full_name}</p>
                    <p className="text-xs text-slate-500 font-mono">{selectedRow.employee.employee_code}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Working</span>
                      <span>{selectedRow.working_days}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Present</span>
                      <span className="text-success-600">{selectedRow.present_days}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Absent</span>
                      <span className="text-danger-600">{selectedRow.absent_days}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Leave</span>
                      <span className="text-warning-600">{selectedRow.leave_days}</span>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-200 grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Base Salary</label>
                      <input
                        type="number"
                        value={selectedRow.base_salary}
                        onChange={(e) =>
                          updateEdit(selectedRow.employee.id, { base_salary: Number(e.target.value) })
                        }
                        className="w-full px-2 py-1 border border-slate-200 rounded text-sm"
                      />
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
                      <span className="text-slate-700">{selectedRow.allowed_leaves}</span>
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
                    <div className="flex justify-between">
                      <span className="text-slate-500">Final Salary</span>
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

                  <div className="pt-3 border-t border-slate-200 space-y-2">
                    <label className="block text-xs text-slate-500">Payment Mode</label>
                    <select
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
                    </select>
                    {selectedRow.payment_mode === "Bank" && (
                      <select
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
                      </select>
                    )}
                    {selectedRow.payment_mode === "Cheque" && (
                      <>
                        <select
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
                        </select>
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
                      variant={selectedRow.disbursed ? "secondary" : "primary"}
                      size="sm"
                      onClick={() => {
                        if (!selectedRow.disbursed) {
                          setRowDisburseDate(todayISO());
                          setRowDisburseTarget(selectedRow);
                        } else {
                          toggleDisbursed(selectedRow);
                        }
                      }}
                    >
                      {selectedRow.disbursed ? "Un-disburse" : "Disburse"}
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
              ) : (
                <p className="text-sm text-slate-500 text-center py-8">
                  Select an employee row to view &amp; edit their payslip for {formatPeriod(selectedPeriod)}.
                </p>
              )}
            </div>
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

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-slate-500 mb-1">Employee</p>
                <p className="text-slate-900">{payslipData.employee.full_name}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Employee ID</p>
                <p className="text-slate-900 font-mono">{payslipData.employee.employee_code}</p>
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
              <div className="grid grid-cols-4 gap-2 text-sm">
                <div className="bg-slate-50 p-2 rounded">
                  <p className="text-xs text-slate-500">Working</p>
                  <p className="text-slate-900">{payslipData.working_days}</p>
                </div>
                <div className="bg-success-50 p-2 rounded">
                  <p className="text-xs text-success-700">Present</p>
                  <p className="text-success-900">{payslipData.present_days}</p>
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
                <div className="flex justify-between pt-2 border-t border-slate-200">
                  <span className="text-slate-700">Final Salary</span>
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
        onClose={() => setIsBulkDisburseOpen(false)}
        title="Mark All as Disbursed"
        size="md"
      >
        {(() => {
          const candidates = filtered.filter((r) => !r.disbursed && r.net_salary > 0);
          const total = candidates.reduce((s, r) => s + r.net_salary, 0);
          return (
            <div className="space-y-4">
              <div className="bg-slate-50 border border-slate-200 rounded-md p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-600">Visible non-disbursed rows</span>
                  <span className="text-slate-900">{candidates.length}</span>
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-slate-600">Total to disburse</span>
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
                  <select
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
                  </select>
                </div>
              )}

              {bulkMode === "Cash" && (
                <p className="text-xs text-slate-500">
                  Current cash balance: PKR {cashBalance.toLocaleString()}.
                </p>
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
        onClose={() => setRowDisburseTarget(null)}
        title="Disbursement Date"
        size="sm"
      >
        {rowDisburseTarget && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Disbursing payroll for{" "}
              <span className="text-slate-900">{rowDisburseTarget.employee.full_name}</span>{" "}
              ({rowDisburseTarget.employee.employee_code}) · PKR {rowDisburseTarget.net_salary.toLocaleString()}
            </p>
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
                  const target = rowDisburseTarget;
                  const date = rowDisburseDate;
                  setRowDisburseTarget(null);
                  await toggleDisbursed(target, date);
                }}
              >
                Confirm & Disburse
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
        )}
      </Modal>
    </>
  );
}
