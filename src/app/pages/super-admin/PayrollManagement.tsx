import { useEffect, useMemo, useState } from "react";
import { Search, Download, AlertCircle, X, Loader2 } from "lucide-react";
import jsPDF from "jspdf";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import {
  supabase,
  type Employee,
  type Location,
  type Client,
  type BankAccount,
  type Payslip,
  type PaymentMode,
  type PayslipStatus,
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
  final_salary: number;
  net_salary: number;
  payment_mode: PaymentMode;
  bank_account_id: string | null;
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

export default function PayrollManagement() {
  const today = new Date();
  const currentPeriod = firstOfMonth(today);

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [payslipsMap, setPayslipsMap] = useState<Map<string, Payslip>>(new Map());
  const [attendanceAgg, setAttendanceAgg] = useState<Map<string, { present: number; absent: number; leave: number }>>(
    new Map()
  );
  const [advancesByEmployee, setAdvancesByEmployee] = useState<Map<string, number>>(new Map());
  const [cashBalance, setCashBalance] = useState(0);

  const [isBulkDisburseOpen, setIsBulkDisburseOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState<PaymentMode>("Cash");
  const [bulkBankId, setBulkBankId] = useState<string>("");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [shiftFilter, setShiftFilter] = useState<"all" | "day" | "night">("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [clientFilter, setClientFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "Cleared" | "Pending">("all");
  const [disbursedFilter, setDisbursedFilter] = useState<"all" | "yes" | "no">("all");

  const [periodOptions, setPeriodOptions] = useState<string[]>([currentPeriod]);
  const [selectedPeriod, setSelectedPeriod] = useState(currentPeriod);

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
    const [attRes, payRes, advRes] = await Promise.all([
      supabase
        .from("attendance_records")
        .select("employee_id, status, attendance_date")
        .gte("attendance_date", start)
        .lte("attendance_date", end),
      supabase.from("payslips").select("*").eq("period_month", period),
      supabase
        .from("advances")
        .select("employee_id, amount")
        .gte("advance_date", start)
        .lte("advance_date", end),
    ]);
    const agg = new Map<string, { present: number; absent: number; leave: number }>();
    (attRes.data ?? []).forEach((a: any) => {
      const cur = agg.get(a.employee_id) ?? { present: 0, absent: 0, leave: 0 };
      if (a.status === "Present") cur.present += 1;
      if (a.status === "Absent") cur.absent += 1;
      if (a.status === "Leave") cur.leave += 1;
      agg.set(a.employee_id, cur);
    });
    setAttendanceAgg(agg);
    const pMap = new Map<string, Payslip>();
    (payRes.data ?? []).forEach((p: any) => pMap.set(p.employee_id, p));
    setPayslipsMap(pMap);
    const advMap = new Map<string, number>();
    (advRes.data ?? []).forEach((a: any) => {
      advMap.set(a.employee_id, (advMap.get(a.employee_id) ?? 0) + Number(a.amount));
    });
    setAdvancesByEmployee(advMap);
    setRowEdits(new Map());
    setSelectedId(null);
  };

  const loadAll = async () => {
    setLoading(true);
    setError(null);

    const sixAgo = new Date(today.getFullYear(), today.getMonth() - 6, 1);
    const cutoff = firstOfMonth(sixAgo);
    await supabase.from("payslips").delete().lt("period_month", cutoff);

    const [empRes, locRes, cliRes, bankRes, treaRes] = await Promise.all([
      supabase
        .from("employees")
        .select("*, location:location_id(name), client:client_id(name)")
        .order("employee_code"),
      supabase.from("locations").select("*").order("name"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("bank_accounts").select("*").order("bank_name"),
      supabase.from("treasury").select("*").limit(1).maybeSingle(),
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

  const rows = useMemo<RowState[]>(() => {
    const daysThisPeriod = daysInMonth(selectedPeriod);
    return employees.map((emp) => {
      const existing = payslipsMap.get(emp.id);
      const att = attendanceAgg.get(emp.id) ?? { present: 0, absent: 0, leave: 0 };
      const baseSal = Number(existing?.base_salary ?? emp.base_salary ?? 0);
      const computedAdvance = advancesByEmployee.get(emp.id) ?? 0;
      const allowed = emp.client_id ? clientAllowedLeaves.get(emp.client_id) ?? 0 : 0;
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
        final_salary: 0,
        net_salary: 0,
        payment_mode: (existing?.payment_mode ?? "Cash") as PaymentMode,
        bank_account_id: existing?.bank_account_id ?? null,
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
      merged.per_day_salary = perDay > 0 ? perDay : null;
      const earned = perDay * merged.effective_present_days;
      merged.final_salary = Math.max(0, earned + merged.bonus - merged.deductions);
      merged.net_salary = Math.max(0, merged.final_salary - merged.advance);
      return merged;
    });
  }, [employees, payslipsMap, attendanceAgg, advancesByEmployee, clientAllowedLeaves, selectedPeriod, rowEdits]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const e = r.employee;
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
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (disbursedFilter !== "all" && (disbursedFilter === "yes" ? !r.disbursed : r.disbursed)) return false;
      return true;
    });
  }, [rows, search, shiftFilter, locationFilter, clientFilter, statusFilter, disbursedFilter]);

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
      final_salary: row.final_salary,
      net_salary: row.net_salary,
      payment_mode: row.payment_mode,
      bank_account_id: row.payment_mode === "Bank" ? row.bank_account_id : null,
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

  const toggleDisbursed = async (row: RowState) => {
    setSavingId(row.employee.id);
    setError(null);
    try {
      if (!row.disbursed) {
        if (row.net_salary <= 0) {
          setError("Net salary must be greater than 0 to disburse.");
          return;
        }
        if (row.payment_mode === "Bank") {
          if (!row.bank_account_id) {
            setError("Select a bank account before disbursing.");
            return;
          }
          const bank = banks.find((b) => b.id === row.bank_account_id);
          if (!bank) {
            setError("Bank account not found.");
            return;
          }
          if (row.net_salary > Number(bank.balance)) {
            setError("Selected bank account balance is insufficient.");
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
        } else {
          if (row.net_salary > cashBalance) {
            setError("Cash balance is insufficient.");
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
          disbursed_at: new Date().toISOString(),
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
      setError(err.message ?? String(err));
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
          disbursed_at: new Date().toISOString(),
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
    line("Advance", `PKR ${row.advance.toLocaleString()}`);
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
      <Header
        title="Payroll Management"
        actions={
          <div className="flex items-center gap-3">
            <div className="text-xs text-slate-500 flex flex-col items-end mr-2">
              <span>Cash: PKR {cashBalance.toLocaleString()}</span>
              <span>Days in {formatPeriod(selectedPeriod)}: {daysInMonth(selectedPeriod)}</span>
            </div>
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
          <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 text-red-700 border border-red-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-emerald-50 p-4 rounded-lg border border-emerald-200">
            <p className="text-xs text-emerald-700 mb-1">Total Disbursed</p>
            <p className="text-2xl text-emerald-900">
              PKR {payrollTotals.disbursed.toLocaleString()}
            </p>
            <p className="text-xs text-emerald-700/70 mt-0.5">
              {filtered.filter((r) => r.disbursed).length} payslip
              {filtered.filter((r) => r.disbursed).length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
            <p className="text-xs text-amber-700 mb-1">Total Not Disbursed</p>
            <p className="text-2xl text-amber-900">
              PKR {payrollTotals.notDisbursed.toLocaleString()}
            </p>
            <p className="text-xs text-amber-700/70 mt-0.5">
              {filtered.filter((r) => !r.disbursed).length} payslip
              {filtered.filter((r) => !r.disbursed).length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="bg-rose-50 p-4 rounded-lg border border-rose-200">
            <p className="text-xs text-rose-700 mb-1">Total Advance</p>
            <p className="text-2xl text-rose-900">
              PKR {payrollTotals.advance.toLocaleString()}
            </p>
            <p className="text-xs text-rose-700/70 mt-0.5">
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
                  <select
                    value={clientFilter}
                    onChange={(e) => setClientFilter(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="all">All Clients</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
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
                        <td colSpan={7} className="px-6 py-10 text-center text-slate-500">
                          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                          Loading…
                        </td>
                      </tr>
                    )}
                    {!loading && filtered.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">
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
                            onClick={() => setSelectedId(e.id)}
                          >
                            <td className="px-4 py-3">
                              <div className="text-sm text-slate-900">{e.full_name}</div>
                              <div className="text-xs text-slate-500 font-mono">
                                {e.employee_code}
                                {e.phone ? ` · ${e.phone}` : ""}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-600">
                              <div>
                                <span className="text-green-700">P {row.present_days}</span>
                                {" / "}
                                <span className="text-red-700">A {row.absent_days}</span>
                                {" / "}
                                <span className="text-amber-700">L {row.leave_days}</span>
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
                                    ? "bg-green-50 text-green-700 hover:bg-green-100"
                                    : "bg-amber-50 text-amber-700 hover:bg-amber-100"
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
                                  toggleDisbursed(row);
                                }}
                                className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                                  row.disbursed
                                    ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
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
                  <span className="ml-2 text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                    History
                  </span>
                )}
              </h3>

              {selectedRow ? (
                <div className="space-y-3 text-sm">
                  <div className="pb-3 border-b border-slate-200">
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
                      <span className="text-green-600">{selectedRow.present_days}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Absent</span>
                      <span className="text-red-600">{selectedRow.absent_days}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Leave</span>
                      <span className="text-amber-600">{selectedRow.leave_days}</span>
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
                      <p className="text-xs text-slate-400 mt-1">
                        Sum of advances recorded for {formatPeriod(selectedPeriod)}. Edit in Expenses → Advances.
                      </p>
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
                        <span className="text-red-600">+{selectedRow.extra_leave_absent}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Effective Paid Days</span>
                      <span className="text-slate-900">
                        {selectedRow.effective_present_days} / {selectedRow.working_days}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Per Day × Paid Days</span>
                      <span className="text-slate-700">
                        PKR {Number(selectedRow.per_day_salary ?? 0).toLocaleString()} ×{" "}
                        {selectedRow.effective_present_days} = PKR{" "}
                        {Math.round(
                          (selectedRow.per_day_salary ?? 0) *
                            selectedRow.effective_present_days
                        ).toLocaleString()}
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
                      <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
                        Override on — all {selectedRow.leave_days} leaves counted as paid days.
                        Remember to click Save.
                      </p>
                    )}
                  </div>

                  <div className="pt-3 border-t border-slate-200 space-y-2">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Final Salary</span>
                      <span className="text-slate-900">PKR {selectedRow.final_salary.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
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
                        })
                      }
                      className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                    >
                      <option value="Cash">Cash</option>
                      <option value="Bank">Bank</option>
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
                  </div>

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
                      onClick={() => toggleDisbursed(selectedRow)}
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
                <div className="bg-green-50 p-2 rounded">
                  <p className="text-xs text-green-700">Present</p>
                  <p className="text-green-900">{payslipData.present_days}</p>
                </div>
                <div className="bg-red-50 p-2 rounded">
                  <p className="text-xs text-red-700">Absent</p>
                  <p className="text-red-900">{payslipData.absent_days}</p>
                </div>
                <div className="bg-amber-50 p-2 rounded">
                  <p className="text-xs text-amber-700">Leave</p>
                  <p className="text-amber-900">{payslipData.leave_days}</p>
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
                    <span className="text-emerald-700">Yes (all leaves paid)</span>
                  </div>
                )}
                {payslipData.extra_leave_absent > 0 && !payslipData.override_leaves && (
                  <div className="flex justify-between">
                    <span className="text-slate-600">Absent (extra leaves)</span>
                    <span className="text-red-600">{payslipData.extra_leave_absent}</span>
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
                  <span className="text-green-600">+ PKR {payslipData.bonus.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Deductions</span>
                  <span className="text-red-600">− PKR {payslipData.deductions.toLocaleString()}</span>
                </div>
                <div className="flex justify-between pt-2 border-t border-slate-200">
                  <span className="text-slate-700">Final Salary</span>
                  <span className="text-slate-900">PKR {payslipData.final_salary.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Advance</span>
                  <span className="text-red-600">− PKR {payslipData.advance.toLocaleString()}</span>
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

              <div className="flex items-center gap-3 pt-2">
                <Button
                  variant="primary"
                  size="md"
                  className="flex-1"
                  onClick={handleBulkDisburse}
                  disabled={bulkSubmitting || candidates.length === 0}
                >
                  {bulkSubmitting ? "Disbursing…" : `Disburse ${candidates.length} Payslip${candidates.length === 1 ? "" : "s"}`}
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
    </>
  );
}
