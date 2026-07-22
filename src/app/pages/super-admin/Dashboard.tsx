import { useEffect, useMemo, useState } from "react";
import {
  Users,
  Calendar,
  Receipt,
  DollarSign,
  Building2,
  TrendingUp,
  AlertCircle,
  Loader2,
  Trophy,
  FileSignature,
  Siren,
  ShieldAlert,
  CalendarRange,
  Lock,
  Unlock,
  PieChart as PieIcon,
} from "lucide-react";
import { Link } from "react-router";
import Header from "../../components/Header";
import { formatDate } from "../../lib/date";
import StatCard from "../../components/StatCard";
import ActivityFeed, { type FeedItem } from "../../components/ActivityFeed";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { CHART_TT, CHART_GRID, CHART_LEGEND, CHART_ANIM, CHART_COLORS } from "../../lib/chart";
import { hasPermission, useAuth } from "../../lib/auth";
import { supabase, fetchAllRows } from "../../lib/supabase";
import { useRegion, withRegion } from "../../lib/region";

type BankRow = { id: string; bank_name: string; balance: number };
type TopClientRow = { id: string; name: string; revenue: number };
type AttendancePoint = { date: string; label: string; present: number; absent: number; leave: number };
type AlertRow = { id: string; title: string; due_date: string; category: string; priority: string };
type ExpensePieRow = { name: string; value: number };
type ContractEndingRow = { id: string; code: string; client_name: string; end_date: string; days_left: number };
type IncidentRow = { id: string; code: string; severity: string; category: string; occurred_at: string; status: string };

const PIE_COLORS = CHART_COLORS;

const currency = (n: number) => `PKR ${Math.round(n).toLocaleString("en-PK")}`;
const compact = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return `PKR ${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `PKR ${(n / 1_000).toFixed(0)}K`;
  return `PKR ${Math.round(n).toLocaleString("en-PK")}`;
};

const monthRange = (offset: number) => {
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  const end = new Date(d.getFullYear(), d.getMonth() + offset + 1, 0);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
};

const monthLabel = (offset: number) => {
  const d = new Date();
  const x = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  return x.toLocaleDateString(undefined, { month: "short", year: "numeric" });
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysAgoIso = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const daysAheadIso = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const deltaLabel = (curr: number, prev: number): { value: string; positive: boolean } => {
  if (prev === 0 && curr === 0) return { value: "no change", positive: true };
  if (prev === 0) return { value: "new this month", positive: true };
  const pct = ((curr - prev) / Math.abs(prev)) * 100;
  const sign = pct >= 0 ? "+" : "";
  return { value: `${sign}${pct.toFixed(0)}% vs ${monthLabel(-1)}`, positive: pct >= 0 };
};

const PRIORITY_COLOR: Record<string, string> = {
  critical: "text-danger-700 bg-danger-50",
  high: "text-warning-700 bg-warning-50",
  medium: "text-brand-700 bg-brand-50",
  low: "text-slate-600 bg-slate-100",
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: "bg-danger-600 text-[#fff] border-danger-700",
  high: "bg-danger-50 text-danger-700 border-danger-200",
  medium: "bg-warning-50 text-warning-700 border-warning-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
};

export default function SuperAdminDashboard() {
  const { profile, company } = useAuth();
  const { regionId } = useRegion();
  const hiddenWidgets = useMemo(
    () => new Set<string>((company?.dashboard_hidden_widgets ?? []) as string[]),
    [company?.dashboard_hidden_widgets],
  );
  const show = (key: string) => !hiddenWidgets.has(key);

  const can = {
    compliance: hasPermission(profile, "compliance.view"),
    employees: hasPermission(profile, "employees.view"),
    attendance: hasPermission(profile, "attendance.view"),
    expenses: hasPermission(profile, "expenses.view"),
    payroll: hasPermission(profile, "payroll.view"),
    accounting: hasPermission(profile, "accounting.view"),
    reports: hasPermission(profile, "reports.view"),
    contracts: hasPermission(profile, "contracts.view"),
    roster: hasPermission(profile, "roster.view"),
    incidents: hasPermission(profile, "incidents.view"),
    coa: hasPermission(profile, "coa.view") || hasPermission(profile, "reports.view"),
    periodClose: hasPermission(profile, "period_close.manage") || hasPermission(profile, "reports.view"),
  };

  const nothingToShow =
    !can.compliance && !can.employees && !can.attendance && !can.expenses &&
    !can.payroll && !can.accounting && !can.reports && !can.contracts &&
    !can.roster && !can.incidents;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [employeeCount, setEmployeeCount] = useState(0);
  const [attendanceTodayPct, setAttendanceTodayPct] = useState(0);
  const [attendanceYesterdayPct, setAttendanceYesterdayPct] = useState(0);

  const [expensesMtd, setExpensesMtd] = useState(0);
  const [expensesPrev, setExpensesPrev] = useState(0);

  const [payrollMtd, setPayrollMtd] = useState(0);
  const [payrollPrev, setPayrollPrev] = useState(0);

  const [banks, setBanks] = useState<BankRow[]>([]);
  const [topClients, setTopClients] = useState<TopClientRow[]>([]);
  const [attendanceTrend, setAttendanceTrend] = useState<AttendancePoint[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);

  // Sprint 1-5 additions
  const [activeContracts, setActiveContracts] = useState(0);
  const [openIncidents, setOpenIncidents] = useState(0);
  const [licencesExpiring, setLicencesExpiring] = useState(0);
  const [rosterGaps, setRosterGaps] = useState(0);
  const [rosterFilled, setRosterFilled] = useState(0);
  const [rosterTotal, setRosterTotal] = useState(0);
  const [expensesPie, setExpensesPie] = useState<ExpensePieRow[]>([]);
  const [contractsEnding, setContractsEnding] = useState<ContractEndingRow[]>([]);
  const [recentIncidents, setRecentIncidents] = useState<IncidentRow[]>([]);
  const [periodClosedThisMonth, setPeriodClosedThisMonth] = useState<boolean | null>(null);
  const [lastClosedMonth, setLastClosedMonth] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { start: mStart, end: mEnd } = monthRange(0);
        const { start: pStart, end: pEnd } = monthRange(-1);
        const today = todayIso();
        const yesterday = daysAgoIso(1);
        const sevenDaysAgo = daysAgoIso(6);
        const in30 = daysAheadIso(30);
        const in60 = daysAheadIso(60);
        const next7 = daysAheadIso(7);
        const periodMonthKey = `${mStart.slice(0, 7)}-01`;

        const [
          empRes,
          attTodayRes,
          attYestRes,
          attTrendRes,
          expMtdRes,
          expPrevRes,
          psMtdRes,
          psPrevRes,
          banksRes,
          payMtdRes,
          datesRes,
          contractEndsRes,
          // Sprint 1-5 additions
          activeContractsRes,
          openIncidentsRes,
          expCatRes,
          contractsEndingRes,
          recentIncRes,
          rosterRes,
          rosterEmpsRes,
          empExpRes,
          periodRes,
          periodLastRes,
        ] = await Promise.all([
          // Region-aware widgets filter on branch_id via the global selector.
          withRegion(supabase.from("employees").select("id", { count: "exact", head: true }).eq("status", "Active"), regionId),
          withRegion(supabase.from("attendance_records").select("status").eq("attendance_date", today), regionId),
          withRegion(supabase.from("attendance_records").select("status").eq("attendance_date", yesterday), regionId),
          withRegion(supabase.from("attendance_records").select("attendance_date, status").gte("attendance_date", sevenDaysAgo).lte("attendance_date", today), regionId),
          withRegion(supabase.from("expenses").select("amount, expense_date, category_id").gte("expense_date", mStart).lte("expense_date", mEnd), regionId),
          withRegion(supabase.from("expenses").select("amount, expense_date").gte("expense_date", pStart).lte("expense_date", pEnd), regionId),
          withRegion(supabase.from("payslips").select("net_salary, disbursed").eq("period_month", periodMonthKey).eq("disbursed", true), regionId),
          withRegion(supabase.from("payslips").select("net_salary, disbursed").eq("period_month", `${pStart.slice(0, 7)}-01`).eq("disbursed", true), regionId),
          // Bank pool is shared across regions (spec §8) — stays company-wide.
          supabase.from("bank_accounts").select("id, bank_name, balance").order("bank_name"),
          fetchAllRows<{ client_id: string | null; invoice_id: string | null; amount: number; payment_date: string }>(() =>
            withRegion(
              supabase
                .from("invoice_payments")
                .select("client_id, invoice_id, amount, payment_date")
                .gte("payment_date", mStart)
                .lte("payment_date", mEnd),
              regionId,
            ) as unknown as {
                range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
              },
          ),
          supabase.from("important_dates").select("id, title, due_date, category, priority").gte("due_date", today).lte("due_date", in30).order("due_date"),
          withRegion(supabase.from("clients").select("id, name, contract_end").not("contract_end", "is", null).gte("contract_end", today).lte("contract_end", in60).order("contract_end"), regionId),
          // active contracts count — contracts carry no branch_id (region is via
          // client); left company-wide rather than restructure this count query.
          supabase.from("contracts").select("id", { count: "exact", head: true }).eq("status", "active"),
          // open incidents count (open + under_investigation)
          withRegion(supabase.from("incidents").select("id", { count: "exact", head: true }).in("status", ["open", "under_investigation"]), regionId),
          // expense categories for pie chart
          supabase.from("expense_categories").select("id, name"),
          // contracts ending in next 60 days — no branch_id on contracts; left
          // company-wide (region for contracts is derivable only via client).
          supabase
            .from("contracts")
            .select("id, contract_code, client_id, end_date")
            .eq("status", "active")
            .not("end_date", "is", null)
            .gte("end_date", today)
            .lte("end_date", in60)
            .order("end_date")
            .limit(10),
          // recent incidents (last 30 days)
          withRegion(
            supabase
              .from("incidents")
              .select("id, incident_code, severity, category, occurred_at, status")
              .gte("occurred_at", daysAgoIso(30) + "T00:00:00Z")
              .order("occurred_at", { ascending: false })
              .limit(8),
            regionId,
          ),
          // roster gaps: scheduled assignments for next 7 days
          withRegion(
            supabase
              .from("roster_assignments")
              .select("employee_id, assignment_date")
              .gte("assignment_date", today)
              .lte("assignment_date", next7),
            regionId,
          ),
          // employees who should be on roster (active client/reliever)
          withRegion(
            supabase
              .from("employees")
              .select("id")
              .eq("status", "Active")
              .in("category", ["client", "reliever"]),
            regionId,
          ),
          // employee licence expiries
          withRegion(
            supabase
              .from("employees")
              .select("weapon_licence_expiry, guard_service_licence_expiry, medical_fitness_expiry, probation_end_date, status"),
            regionId,
          ),
          // current month period closed?
          supabase
            .from("accounting_periods")
            .select("period_month")
            .eq("period_month", periodMonthKey)
            .maybeSingle(),
          // most recent closed month
          supabase
            .from("accounting_periods")
            .select("period_month")
            .order("period_month", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);

        if (cancelled) return;

        if (empRes.error) throw empRes.error;
        setEmployeeCount(empRes.count ?? 0);

        const attPct = (rows: { status: string }[] | null): number => {
          if (!rows || rows.length === 0) return 0;
          const present = rows.filter((r) => r.status === "Present").length;
          return Math.round((present / rows.length) * 100);
        };
        if (attTodayRes.error) throw attTodayRes.error;
        if (attYestRes.error) throw attYestRes.error;
        setAttendanceTodayPct(attPct(attTodayRes.data as { status: string }[]));
        setAttendanceYesterdayPct(attPct(attYestRes.data as { status: string }[]));

        if (attTrendRes.error) throw attTrendRes.error;
        const byDay = new Map<string, { present: number; absent: number; leave: number }>();
        const dayList: string[] = [];
        for (let i = 6; i >= 0; i -= 1) {
          const d = daysAgoIso(i);
          dayList.push(d);
          byDay.set(d, { present: 0, absent: 0, leave: 0 });
        }
        for (const r of (attTrendRes.data ?? []) as { attendance_date: string; status: string }[]) {
          const slot = byDay.get(r.attendance_date);
          if (!slot) continue;
          if (r.status === "Present") slot.present += 1;
          else if (r.status === "Absent") slot.absent += 1;
          else if (r.status === "Leave") slot.leave += 1;
        }
        setAttendanceTrend(
          dayList.map((d) => {
            const slot = byDay.get(d)!;
            const label = new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
            return { date: d, label, ...slot };
          }),
        );

        if (expMtdRes.error) throw expMtdRes.error;
        if (expPrevRes.error) throw expPrevRes.error;
        const sum = (rows: { amount: number }[] | null) =>
          (rows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
        setExpensesMtd(sum(expMtdRes.data as { amount: number }[]));
        setExpensesPrev(sum(expPrevRes.data as { amount: number }[]));

        // Expense pie — group MTD expenses by category name
        const catMap = new Map<string, string>();
        for (const c of (expCatRes.data ?? []) as { id: string; name: string }[]) catMap.set(c.id, c.name);
        const pieMap = new Map<string, number>();
        for (const e of ((expMtdRes.data ?? []) as { amount: number; category_id: string | null }[])) {
          const name = e.category_id ? catMap.get(e.category_id) ?? "Other" : "Uncategorised";
          pieMap.set(name, (pieMap.get(name) ?? 0) + Number(e.amount ?? 0));
        }
        const pieData: ExpensePieRow[] = Array.from(pieMap.entries())
          .map(([name, value]) => ({ name, value }))
          .filter((r) => r.value > 0)
          .sort((a, b) => b.value - a.value);
        setExpensesPie(pieData);

        if (psMtdRes.error) throw psMtdRes.error;
        if (psPrevRes.error) throw psPrevRes.error;
        const sumPay = (rows: { net_salary: number }[] | null) =>
          (rows ?? []).reduce((s, r) => s + Number(r.net_salary ?? 0), 0);
        setPayrollMtd(sumPay(psMtdRes.data as { net_salary: number }[]));
        setPayrollPrev(sumPay(psPrevRes.data as { net_salary: number }[]));

        if (banksRes.error) throw banksRes.error;
        setBanks(
          ((banksRes.data ?? []) as BankRow[]).map((b) => ({
            id: b.id,
            bank_name: b.bank_name,
            balance: Number(b.balance ?? 0),
          })),
        );

        // Top clients by payments
        const payByClient = new Map<string, number>();
        const invoiceOnly: string[] = [];
        for (const r of payMtdRes) {
          if (r.client_id) payByClient.set(r.client_id, (payByClient.get(r.client_id) ?? 0) + Number(r.amount));
          else if (r.invoice_id) invoiceOnly.push(r.invoice_id);
        }
        if (invoiceOnly.length > 0) {
          const { data: invs } = await supabase.from("invoices").select("id, client_id").in("id", invoiceOnly);
          const map = new Map<string, string>();
          for (const i of (invs ?? []) as { id: string; client_id: string }[]) map.set(i.id, i.client_id);
          for (const r of payMtdRes) {
            if (!r.client_id && r.invoice_id) {
              const cid = map.get(r.invoice_id);
              if (cid) payByClient.set(cid, (payByClient.get(cid) ?? 0) + Number(r.amount));
            }
          }
        }
        const clientIds = Array.from(payByClient.keys());
        if (clientIds.length > 0) {
          const { data: clientRows } = await supabase.from("clients").select("id, name").in("id", clientIds);
          const nameMap = new Map<string, string>();
          for (const c of (clientRows ?? []) as { id: string; name: string }[]) nameMap.set(c.id, c.name);
          const list: TopClientRow[] = clientIds.map((id) => ({
            id,
            name: nameMap.get(id) ?? "Unknown client",
            revenue: payByClient.get(id) ?? 0,
          }));
          list.sort((a, b) => b.revenue - a.revenue);
          setTopClients(list.slice(0, 10));
        } else {
          setTopClients([]);
        }

        // Compliance + contract-end alerts
        if (datesRes.error) throw datesRes.error;
        if (contractEndsRes.error) throw contractEndsRes.error;
        const todayDate = new Date(today);
        const contractAlerts: AlertRow[] = ((contractEndsRes.data ?? []) as {
          id: string; name: string; contract_end: string;
        }[]).flatMap((c) => {
          const endDate = new Date(c.contract_end);
          const daysLeft = Math.round((endDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));
          if (daysLeft > 60) return [];
          const priority = daysLeft <= 7 ? "critical" : daysLeft <= 30 ? "high" : "medium";
          return [{
            id: `contract-${c.id}`,
            title: `Contract ending: ${c.name} (${daysLeft}d)`,
            due_date: c.contract_end,
            category: "Client",
            priority,
          }];
        });
        const merged = [...((datesRes.data ?? []) as AlertRow[]), ...contractAlerts].sort((a, b) => a.due_date.localeCompare(b.due_date));
        setAlerts(merged);

        // Sprint 1-5 stat tallies
        setActiveContracts(activeContractsRes.count ?? 0);
        setOpenIncidents(openIncidentsRes.count ?? 0);

        // Licences expiring in next 30 days (count employees with any expiring item)
        const empExpRows = ((empExpRes.data ?? []) as {
          weapon_licence_expiry: string | null;
          guard_service_licence_expiry: string | null;
          medical_fitness_expiry: string | null;
          probation_end_date: string | null;
          status: string;
        }[]).filter((e) => e.status !== "Inactive");
        let licCount = 0;
        for (const e of empExpRows) {
          const dates = [
            e.weapon_licence_expiry,
            e.guard_service_licence_expiry,
            e.medical_fitness_expiry,
            e.probation_end_date,
          ].filter(Boolean) as string[];
          if (dates.some((d) => d >= today && d <= in30)) licCount += 1;
        }
        setLicencesExpiring(licCount);

        // Roster gaps: employees x 7 days minus filled assignments
        const rosterEmps = ((rosterEmpsRes.data ?? []) as { id: string }[]).length;
        const filledSlots = ((rosterRes.data ?? []) as { employee_id: string; assignment_date: string }[]).length;
        const totalSlots = rosterEmps * 7;
        setRosterGaps(Math.max(0, totalSlots - filledSlots));
        setRosterFilled(filledSlots);
        setRosterTotal(totalSlots);

        // Contracts ending list
        const contractsEndingRaw = (contractsEndingRes.data ?? []) as { id: string; contract_code: string; client_id: string | null; end_date: string }[];
        const ceClientIds = Array.from(new Set(contractsEndingRaw.map((c) => c.client_id).filter(Boolean) as string[]));
        const ceClientMap = new Map<string, string>();
        if (ceClientIds.length > 0) {
          const { data: ceClients } = await supabase.from("clients").select("id, name").in("id", ceClientIds);
          for (const c of (ceClients ?? []) as { id: string; name: string }[]) ceClientMap.set(c.id, c.name);
        }
        setContractsEnding(contractsEndingRaw.map((c) => ({
          id: c.id,
          code: c.contract_code,
          client_name: c.client_id ? ceClientMap.get(c.client_id) ?? "—" : "—",
          end_date: c.end_date,
          days_left: Math.round((new Date(c.end_date).getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24)),
        })));

        // Recent incidents
        type IncidentRaw = { id: string; incident_code: string; severity: string; category: string; occurred_at: string; status: string };
        setRecentIncidents(((recentIncRes.data ?? []) as IncidentRaw[]).map((i) => ({
          id: i.id,
          code: i.incident_code,
          severity: i.severity,
          category: i.category,
          occurred_at: i.occurred_at,
          status: i.status,
        })));

        // Period close status
        setPeriodClosedThisMonth(periodRes.data != null);
        setLastClosedMonth((periodLastRes.data as { period_month: string } | null)?.period_month ?? null);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Re-fetch region-aware widgets when the global region selector changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId]);

  const totalBankBalance = useMemo(() => banks.reduce((s, b) => s + b.balance, 0), [banks]);
  const maxBank = useMemo(() => Math.max(1, ...banks.map((b) => b.balance)), [banks]);
  const maxClient = useMemo(() => Math.max(1, ...topClients.map((c) => c.revenue)), [topClients]);

  const branchScopeNote = profile?.branch_id ? "Scoped to your branch." : null;

  // Live activity feed — assembled from real recent data (payments in,
  // incidents logged, compliance items due) and animated like the landing page.
  const feedItems = useMemo<FeedItem[]>(() => {
    const out: FeedItem[] = [];
    topClients.forEach((c) =>
      out.push({ id: `pay-${c.id}`, tone: "in", text: `Payment received · ${c.name}`, amount: `+${compact(c.revenue)}` }),
    );
    recentIncidents.forEach((i) =>
      out.push({ id: `inc-${i.id}`, tone: "out", text: `Incident ${i.code} · ${i.category} · ${i.status.replace(/_/g, " ")}` }),
    );
    alerts.forEach((a) =>
      out.push({ id: `al-${a.id}`, tone: "evt", text: `${a.title} · due ${a.due_date}` }),
    );
    return out;
  }, [topClients, recentIncidents, alerts]);

  return (
    <>
      <Header
        title="Dashboard"
        subtitle={`Financial overview — ${new Date().toLocaleDateString(undefined, {
          weekday: "long", day: "numeric", month: "long", year: "numeric",
        })}`}
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {error && (
          <div className="mb-4 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded text-sm">{error}</div>
        )}

        {branchScopeNote && (
          <div className="mb-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-brand-50 text-brand-700 text-xs">
            <Building2 className="w-3.5 h-3.5" strokeWidth={1.5} />
            {branchScopeNote}
          </div>
        )}

        {nothingToShow && (
          <div className="bg-white border border-slate-200 rounded-lg p-12 text-center">
            <h3 className="text-base text-slate-900 mb-2">Nothing to show yet</h3>
            <p className="text-sm text-slate-500">
              You don&apos;t have any feature permissions yet. Ask a Super Admin to grant you access.
            </p>
          </div>
        )}

        {loading ? (
          <div className="bg-white border border-slate-200 rounded-lg p-10 text-center text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading dashboard…
          </div>
        ) : (
          <>
            {/* Primary stat cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-6">
              {can.employees && show("stat_employees") && (
                <StatCard title="Total Employees" value={employeeCount} icon={Users} tone="brand" />
              )}
              {can.attendance && show("stat_attendance_today") && (
                <StatCard
                  title="Attendance Today"
                  value={`${attendanceTodayPct}%`}
                  icon={Calendar}
                  tone="info"
                  trend={attendanceTodayPct === 0 && attendanceYesterdayPct === 0 ? undefined : {
                    value: `${attendanceTodayPct - attendanceYesterdayPct >= 0 ? "+" : ""}${attendanceTodayPct - attendanceYesterdayPct}% from yesterday`,
                    positive: attendanceTodayPct - attendanceYesterdayPct >= 0,
                  }}
                />
              )}
              {can.expenses && show("stat_expenses_mtd") && (
                <StatCard title={`Expenses · ${monthLabel(0)}`} value={compact(expensesMtd)} icon={Receipt} tone="danger" trend={deltaLabel(expensesMtd, expensesPrev)} />
              )}
              {can.payroll && show("stat_payroll_mtd") && (
                <StatCard title={`Payroll · ${monthLabel(0)}`} value={compact(payrollMtd)} icon={DollarSign} tone="warning" trend={deltaLabel(payrollMtd, payrollPrev)} />
              )}
            </div>

            {/* Sprint 1-5 stat cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-6 md:mb-8">
              {can.contracts && show("stat_active_contracts") && (
                <StatCard title="Active Contracts" value={activeContracts} icon={FileSignature} tone="brand" />
              )}
              {can.incidents && show("stat_open_incidents") && (
                <StatCard title="Open Incidents" value={openIncidents} icon={Siren} tone={openIncidents > 0 ? "danger" : "info"} />
              )}
              {can.compliance && show("stat_licences_expiring") && (
                <StatCard title="Licences expiring <30d" value={licencesExpiring} icon={ShieldAlert} tone={licencesExpiring > 0 ? "warning" : "info"} />
              )}
              {can.roster && show("stat_roster_gaps") && (
                <StatCard title="Roster gaps · next 7d" value={rosterGaps} icon={CalendarRange} tone={rosterGaps > 0 ? "warning" : "info"} />
              )}
            </div>

            {/* Bank overview + Top clients */}
            <div className={`grid grid-cols-1 ${can.accounting && show("bank_overview") && can.reports && show("top_clients") ? "lg:grid-cols-2" : ""} gap-6 mb-6 md:mb-8`}>
              {can.accounting && show("bank_overview") && (
                <div className="bg-white rounded-lg border border-slate-200 p-6">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-base text-slate-900">Bank Account Overview</h3>
                    <Building2 className="w-5 h-5 text-brand-600" strokeWidth={1.5} />
                  </div>
                  {banks.length === 0 ? (
                    <p className="text-sm text-slate-500">No bank accounts yet.</p>
                  ) : (
                    <div className="space-y-4">
                      {banks.map((b) => {
                        const color = PIE_COLORS[banks.indexOf(b) % PIE_COLORS.length];
                        return (
                          <div key={b.id} className="border-l-4 pl-4 py-2" style={{ borderColor: color }}>
                            <div className="flex justify-between items-center mb-1">
                              <p className="text-sm text-slate-700">{b.bank_name}</p>
                              <p className="text-base" style={{ color }}>{currency(b.balance)}</p>
                            </div>
                            <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${(b.balance / maxBank) * 100}%`, backgroundColor: color }} />
                            </div>
                          </div>
                        );
                      })}
                      <div className="pt-4 border-t border-slate-200 flex justify-between items-center">
                        <span className="text-sm text-slate-600">Total Bank Balance</span>
                        <span className="text-lg text-slate-900">{currency(totalBankBalance)}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {can.reports && show("top_clients") && (
                <div className="bg-white rounded-lg border border-slate-200 p-6">
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <h3 className="text-base text-slate-900 flex items-center gap-2">
                        <Trophy className="w-4 h-4 text-warning-500" strokeWidth={1.5} />
                        Top 10 Clients · {monthLabel(0)}
                      </h3>
                      <p className="text-xs text-slate-500 mt-0.5">By payments received this month.</p>
                    </div>
                    <TrendingUp className="w-5 h-5 text-success-600" strokeWidth={1.5} />
                  </div>
                  {topClients.length === 0 ? (
                    <p className="text-sm text-slate-500">No client payments received this month yet.</p>
                  ) : (
                    <div className="space-y-2.5">
                      {topClients.map((c, idx) => (
                        <div key={c.id} className="flex items-center gap-3">
                          <span className="w-6 text-xs text-slate-400 text-right tabular-nums">{idx + 1}.</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline justify-between gap-2 mb-1">
                              <span className="text-sm text-slate-800 truncate">{c.name}</span>
                              <span className="text-xs text-slate-600 tabular-nums">{currency(c.revenue)}</span>
                            </div>
                            <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                              <div className="h-full rounded-full bg-gradient-to-r from-success-400 to-success-600" style={{ width: `${Math.max(2, (c.revenue / maxClient) * 100)}%` }} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Live activity feed (landing-page style) */}
            {feedItems.length > 0 && (
              <div className="mb-6 md:mb-8">
                <h3 className="text-base font-bold text-foreground mb-3">Live activity</h3>
                <ActivityFeed items={feedItems} />
              </div>
            )}

            {/* Expenses pie chart */}
            {can.expenses && show("expenses_pie") && (
              <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6 md:mb-8">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h3 className="text-base text-slate-900 flex items-center gap-2">
                      <PieIcon className="w-4 h-4 text-brand-600" strokeWidth={1.5} />
                      Expenses by Category · {monthLabel(0)}
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">Where the money went this month.</p>
                  </div>
                </div>
                {expensesPie.length === 0 ? (
                  <p className="text-sm text-slate-500">No expenses recorded this month.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Pie {...CHART_ANIM} cornerRadius={5} stroke="var(--card)" strokeWidth={2} data={expensesPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} innerRadius={45} paddingAngle={2}>
                          {expensesPie.map((_, i) => (
                            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip {...CHART_TT} formatter={(value: number) => currency(value)} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="space-y-2">
                      {expensesPie.slice(0, 10).map((row, i) => {
                        const total = expensesPie.reduce((s, r) => s + r.value, 0);
                        const pct = total > 0 ? Math.round((row.value / total) * 100) : 0;
                        return (
                          <div key={row.name} className="flex items-center gap-3 text-sm">
                            <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                            <span className="flex-1 truncate text-slate-700">{row.name}</span>
                            <span className="text-xs text-slate-500 w-10 text-right tabular-nums">{pct}%</span>
                            <span className="text-sm text-slate-900 w-24 text-right tabular-nums">{currency(row.value)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Attendance trend + Compliance alerts */}
            <div className={`grid grid-cols-1 ${can.attendance && show("attendance_trend") && show("compliance_alerts") ? "lg:grid-cols-2" : ""} gap-6 mb-6 md:mb-8`}>
              {can.attendance && show("attendance_trend") && (
                <div className="bg-white rounded-lg border border-slate-200 p-6">
                  <h3 className="text-base mb-6 text-slate-900">Attendance Trend · Last 7 Days</h3>
                  {attendanceTrend.every((p) => p.present + p.absent + p.leave === 0) ? (
                    <p className="text-sm text-slate-500">No attendance recorded in the last 7 days.</p>
                  ) : (
                    <ResponsiveContainer width="100%" height={250}>
                      <LineChart data={attendanceTrend}>
                        <CartesianGrid {...CHART_GRID} />
                        <XAxis dataKey="label" tick={{ fill: "var(--color-slate-500)", fontSize: 12 }} axisLine={{ stroke: "var(--border)" }} tickLine={{ stroke: "var(--border)" }} />
                        <YAxis tick={{ fill: "var(--color-slate-500)", fontSize: 12 }} axisLine={{ stroke: "var(--border)" }} tickLine={{ stroke: "var(--border)" }} />
                        <Tooltip {...CHART_TT} />
                        <Legend {...CHART_LEGEND} />
                        <Line {...CHART_ANIM} type="monotone" dataKey="present" stroke="var(--color-success-500)" strokeWidth={2} dot={{ fill: "var(--color-success-500)" }} name="Present" />
                        <Line {...CHART_ANIM} type="monotone" dataKey="absent" stroke="var(--color-danger-500)" strokeWidth={2} dot={{ fill: "var(--color-danger-500)" }} name="Absent" />
                        <Line {...CHART_ANIM} type="monotone" dataKey="leave" stroke="var(--color-warning-500)" strokeWidth={2} dot={{ fill: "var(--color-warning-500)" }} name="Leave" />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>
              )}

              {show("compliance_alerts") && (
                <div className="bg-white rounded-lg border border-slate-200">
                  <div className="p-6 border-b border-slate-200">
                    <h3 className="text-base text-slate-900">Upcoming Compliance · Next 30 Days</h3>
                  </div>
                  {alerts.length === 0 ? (
                    <div className="p-6 text-sm text-slate-500">Nothing due in the next 60 days.</div>
                  ) : (
                    <div className="divide-y divide-slate-200">
                      {alerts.map((a) => {
                        const daysLeft = Math.max(0, Math.ceil((new Date(a.due_date).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)));
                        const priorityClass = PRIORITY_COLOR[a.priority] ?? PRIORITY_COLOR.low;
                        return (
                          <div key={a.id} className="p-4 flex items-start gap-3 hover:bg-slate-50 transition-colors">
                            <AlertCircle className="w-4 h-4 text-warning-600 flex-shrink-0 mt-0.5" strokeWidth={1.5} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <p className="text-sm text-slate-900 truncate">{a.title}</p>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide ${priorityClass}`}>{a.priority}</span>
                              </div>
                              <p className="text-xs text-slate-500">{a.category} · due {formatDate(a.due_date)}</p>
                            </div>
                            <span className="text-xs text-slate-400 tabular-nums">{daysLeft === 0 ? "today" : `${daysLeft}d`}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Contracts ending + Recent incidents */}
            <div className={`grid grid-cols-1 ${can.contracts && show("contracts_ending") && can.incidents && show("incidents_recent") ? "lg:grid-cols-2" : ""} gap-6 mb-6 md:mb-8`}>
              {can.contracts && show("contracts_ending") && (
                <div className="bg-white rounded-lg border border-slate-200">
                  <div className="p-6 border-b border-slate-200 flex items-center justify-between">
                    <h3 className="text-base text-slate-900 flex items-center gap-2">
                      <FileSignature className="w-4 h-4 text-brand-600" strokeWidth={1.5} />
                      Contracts ending soon
                    </h3>
                    <Link to="/super-admin/contracts" className="text-xs text-brand-600 hover:text-brand-700">All contracts →</Link>
                  </div>
                  {contractsEnding.length === 0 ? (
                    <div className="p-6 text-sm text-slate-500">No active contracts ending in the next 60 days.</div>
                  ) : (
                    <div className="divide-y divide-slate-200">
                      {contractsEnding.map((c) => {
                        const tone = c.days_left <= 7 ? "text-danger-700" : c.days_left <= 30 ? "text-warning-700" : "text-slate-700";
                        return (
                          <div key={c.id} className="p-4 flex items-center gap-3 hover:bg-slate-50 transition-colors">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-mono text-slate-500">{c.code}</span>
                                <span className="text-sm text-slate-900 truncate">{c.client_name}</span>
                              </div>
                              <p className="text-xs text-slate-500">Ends {formatDate(c.end_date)}</p>
                            </div>
                            <span className={`text-sm tabular-nums ${tone}`}>{c.days_left}d</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {can.incidents && show("incidents_recent") && (
                <div className="bg-white rounded-lg border border-slate-200">
                  <div className="p-6 border-b border-slate-200 flex items-center justify-between">
                    <h3 className="text-base text-slate-900 flex items-center gap-2">
                      <Siren className="w-4 h-4 text-danger-600" strokeWidth={1.5} />
                      Recent incidents · last 30 days
                    </h3>
                    <Link to="/super-admin/incidents" className="text-xs text-brand-600 hover:text-brand-700">All incidents →</Link>
                  </div>
                  {recentIncidents.length === 0 ? (
                    <div className="p-6 text-sm text-slate-500">No incidents in the last 30 days.</div>
                  ) : (
                    <div className="divide-y divide-slate-200">
                      {recentIncidents.map((i) => (
                        <div key={i.id} className="p-4 flex items-center gap-3 hover:bg-slate-50 transition-colors">
                          <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] uppercase border ${SEVERITY_COLOR[i.severity] ?? SEVERITY_COLOR.low}`}>
                            {i.severity}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono text-slate-500">{i.code}</span>
                              <span className="text-sm text-slate-700 capitalize">{i.category.replace(/_/g, " ")}</span>
                            </div>
                            <p className="text-xs text-slate-500">{new Date(i.occurred_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>
                          </div>
                          <span className="text-xs text-slate-400 capitalize">{i.status.replace(/_/g, " ")}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Deployment roster overview (item 13) */}
            {can.roster && show("roster_overview") && (
              <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6 md:mb-8">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base text-slate-900 flex items-center gap-2">
                    <CalendarRange className="w-4 h-4 text-brand-600" strokeWidth={1.5} />
                    Deployment roster · next 7 days
                  </h3>
                  <Link to="/super-admin/roster" className="text-xs text-brand-600 hover:text-brand-700">Open roster →</Link>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="rounded-lg border border-slate-200 p-4">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Slots filled</div>
                    <div className="text-2xl text-success-700">{rosterFilled}</div>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-4">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Total slots</div>
                    <div className="text-2xl text-slate-900">{rosterTotal}</div>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-4">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Gaps</div>
                    <div className={`text-2xl ${rosterGaps > 0 ? "text-danger-600" : "text-slate-900"}`}>{rosterGaps}</div>
                  </div>
                </div>
                <div className="mt-4 h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full bg-success-500"
                    style={{ width: `${rosterTotal > 0 ? Math.round((rosterFilled / rosterTotal) * 100) : 0}%` }}
                  />
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  {rosterTotal > 0 ? Math.round((rosterFilled / rosterTotal) * 100) : 0}% of guard-days covered across the next week.
                </p>
              </div>
            )}

            {/* Period close status */}
            {can.periodClose && show("period_close_status") && (
              <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6 md:mb-8">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {periodClosedThisMonth ? (
                      <Lock className="w-5 h-5 text-success-600" />
                    ) : (
                      <Unlock className="w-5 h-5 text-warning-600" />
                    )}
                    <div>
                      <h3 className="text-base text-slate-900">Period Close Status</h3>
                      <p className="text-xs text-slate-500">
                        {periodClosedThisMonth
                          ? `${monthLabel(0)} is closed — writes to this month are blocked.`
                          : `${monthLabel(0)} is open. ${lastClosedMonth ? `Last closed: ${lastClosedMonth.slice(0, 7)}.` : "No months closed yet."}`}
                      </p>
                    </div>
                  </div>
                  <Link to="/super-admin/period-close" className="text-xs text-brand-600 hover:text-brand-700">Manage →</Link>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
