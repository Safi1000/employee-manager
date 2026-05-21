import { useEffect, useMemo, useState } from "react";
import { Users, Calendar, Receipt, DollarSign, Building2, TrendingUp, AlertCircle, Loader2, Trophy } from "lucide-react";
import Header from "../../components/Header";
import StatCard from "../../components/StatCard";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { hasPermission, useAuth } from "../../lib/auth";
import { supabase, fetchAllRows } from "../../lib/supabase";

type BankRow = { id: string; bank_name: string; balance: number };
type TopClientRow = { id: string; name: string; revenue: number };
type AttendancePoint = { date: string; label: string; present: number; absent: number; leave: number };
type AlertRow = { id: string; title: string; due_date: string; category: string; priority: string };

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

export default function SuperAdminDashboard() {
  const { profile, company } = useAuth();
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
  };

  const nothingToShow =
    !can.compliance && !can.employees && !can.attendance && !can.expenses &&
    !can.payroll && !can.accounting && !can.reports;

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
        const in30 = (() => {
          const d = new Date();
          d.setDate(d.getDate() + 30);
          return d.toISOString().slice(0, 10);
        })();
        const in60 = (() => {
          const d = new Date();
          d.setDate(d.getDate() + 60);
          return d.toISOString().slice(0, 10);
        })();

        // Fan out — all under RLS, so a branched user gets only their slice.
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
        ] = await Promise.all([
          supabase.from("employees").select("id", { count: "exact", head: true }).eq("status", "Active"),
          supabase.from("attendance_records").select("status").eq("attendance_date", today),
          supabase.from("attendance_records").select("status").eq("attendance_date", yesterday),
          supabase
            .from("attendance_records")
            .select("attendance_date, status")
            .gte("attendance_date", sevenDaysAgo)
            .lte("attendance_date", today),
          supabase.from("expenses").select("amount, expense_date").gte("expense_date", mStart).lte("expense_date", mEnd),
          supabase.from("expenses").select("amount, expense_date").gte("expense_date", pStart).lte("expense_date", pEnd),
          supabase.from("payslips").select("net_salary, disbursed").eq("period_month", `${mStart.slice(0, 7)}-01`).eq("disbursed", true),
          supabase.from("payslips").select("net_salary, disbursed").eq("period_month", `${pStart.slice(0, 7)}-01`).eq("disbursed", true),
          supabase.from("bank_accounts").select("id, bank_name, balance").order("bank_name"),
          fetchAllRows<{ client_id: string | null; invoice_id: string | null; amount: number; payment_date: string }>(() =>
            supabase
              .from("invoice_payments")
              .select("client_id, invoice_id, amount, payment_date")
              .gte("payment_date", mStart)
              .lte("payment_date", mEnd) as unknown as {
                range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
              },
          ),
          supabase
            .from("important_dates")
            .select("id, title, due_date, category, priority")
            .gte("due_date", today)
            .lte("due_date", in30)
            .order("due_date"),
          supabase
            .from("clients")
            .select("id, name, contract_end")
            .not("contract_end", "is", null)
            .gte("contract_end", today)
            .lte("contract_end", in60)
            .order("contract_end"),
        ]);

        if (cancelled) return;

        // Employee count.
        if (empRes.error) throw empRes.error;
        setEmployeeCount(empRes.count ?? 0);

        // Attendance % today and yesterday.
        const attPct = (rows: { status: string }[] | null): number => {
          if (!rows || rows.length === 0) return 0;
          const present = rows.filter((r) => r.status === "Present").length;
          return Math.round((present / rows.length) * 100);
        };
        if (attTodayRes.error) throw attTodayRes.error;
        if (attYestRes.error) throw attYestRes.error;
        setAttendanceTodayPct(attPct(attTodayRes.data as { status: string }[]));
        setAttendanceYesterdayPct(attPct(attYestRes.data as { status: string }[]));

        // 7-day trend.
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

        // Expenses MTD + previous month.
        if (expMtdRes.error) throw expMtdRes.error;
        if (expPrevRes.error) throw expPrevRes.error;
        const sum = (rows: { amount: number }[] | null) =>
          (rows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
        setExpensesMtd(sum(expMtdRes.data as { amount: number }[]));
        setExpensesPrev(sum(expPrevRes.data as { amount: number }[]));

        // Payroll MTD + previous month.
        if (psMtdRes.error) throw psMtdRes.error;
        if (psPrevRes.error) throw psPrevRes.error;
        const sumPay = (rows: { net_salary: number }[] | null) =>
          (rows ?? []).reduce((s, r) => s + Number(r.net_salary ?? 0), 0);
        setPayrollMtd(sumPay(psMtdRes.data as { net_salary: number }[]));
        setPayrollPrev(sumPay(psPrevRes.data as { net_salary: number }[]));

        // Bank accounts.
        if (banksRes.error) throw banksRes.error;
        setBanks(
          ((banksRes.data ?? []) as BankRow[]).map((b) => ({
            id: b.id,
            bank_name: b.bank_name,
            balance: Number(b.balance ?? 0),
          })),
        );

        // Top 10 clients by current-month invoice payments.
        const payByClient = new Map<string, number>();
        // Need client_ids for invoice payments that only carry invoice_id.
        const invoiceOnly: string[] = [];
        for (const r of payMtdRes) {
          if (r.client_id) {
            payByClient.set(r.client_id, (payByClient.get(r.client_id) ?? 0) + Number(r.amount));
          } else if (r.invoice_id) {
            invoiceOnly.push(r.invoice_id);
          }
        }
        if (invoiceOnly.length > 0) {
          const { data: invs } = await supabase
            .from("invoices")
            .select("id, client_id")
            .in("id", invoiceOnly);
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
          const { data: clientRows } = await supabase
            .from("clients")
            .select("id, name")
            .in("id", clientIds);
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

        // Compliance alerts + synthesized contract-end alerts (60/30/7 day windows).
        if (datesRes.error) throw datesRes.error;
        if (contractEndsRes.error) throw contractEndsRes.error;
        const todayDate = new Date(today);
        const contractAlerts: AlertRow[] = ((contractEndsRes.data ?? []) as {
          id: string;
          name: string;
          contract_end: string;
        }[]).flatMap((c) => {
          const endDate = new Date(c.contract_end);
          const daysLeft = Math.round(
            (endDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24),
          );
          // Only fire at the 60/30/7-day windows (and anything shorter than 7).
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
        const merged = [
          ...((datesRes.data ?? []) as AlertRow[]),
          ...contractAlerts,
        ].sort((a, b) => a.due_date.localeCompare(b.due_date));
        setAlerts(merged);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalBankBalance = useMemo(() => banks.reduce((s, b) => s + b.balance, 0), [banks]);
  const maxBank = useMemo(() => Math.max(1, ...banks.map((b) => b.balance)), [banks]);
  const maxClient = useMemo(() => Math.max(1, ...topClients.map((c) => c.revenue)), [topClients]);

  const branchScopeNote = profile?.branch_id ? "Scoped to your branch." : null;

  return (
    <>
      <Header
        title="Dashboard"
        subtitle={`Financial overview — ${new Date().toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        })}`}
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {error && (
          <div className="mb-4 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded text-sm">{error}</div>
        )}

        {branchScopeNote && (
          <div className="mb-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-50 text-brand-700 text-xs">
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
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-6 md:mb-8">
              {can.employees && show("stat_employees") && (
                <StatCard title="Total Employees" value={employeeCount} icon={Users} tone="brand" />
              )}
              {can.attendance && show("stat_attendance_today") && (
                <StatCard
                  title="Attendance Today"
                  value={`${attendanceTodayPct}%`}
                  icon={Calendar}
                  tone="info"
                  trend={
                    attendanceTodayPct === 0 && attendanceYesterdayPct === 0
                      ? undefined
                      : {
                          value: `${attendanceTodayPct - attendanceYesterdayPct >= 0 ? "+" : ""}${
                            attendanceTodayPct - attendanceYesterdayPct
                          }% from yesterday`,
                          positive: attendanceTodayPct - attendanceYesterdayPct >= 0,
                        }
                  }
                />
              )}
              {can.expenses && show("stat_expenses_mtd") && (
                <StatCard
                  title={`Expenses · ${monthLabel(0)}`}
                  value={compact(expensesMtd)}
                  icon={Receipt}
                  tone="danger"
                  trend={deltaLabel(expensesMtd, expensesPrev)}
                />
              )}
              {can.payroll && show("stat_payroll_mtd") && (
                <StatCard
                  title={`Payroll · ${monthLabel(0)}`}
                  value={compact(payrollMtd)}
                  icon={DollarSign}
                  tone="warning"
                  trend={deltaLabel(payrollMtd, payrollPrev)}
                />
              )}
            </div>

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
                        const colors = ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ec4899", "#14b8a6"];
                        const color = colors[banks.indexOf(b) % colors.length];
                        return (
                          <div key={b.id} className="border-l-4 pl-4 py-2" style={{ borderColor: color }}>
                            <div className="flex justify-between items-center mb-1">
                              <p className="text-sm text-slate-700">{b.bank_name}</p>
                              <p className="text-base" style={{ color }}>{currency(b.balance)}</p>
                            </div>
                            <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full"
                                style={{ width: `${(b.balance / maxBank) * 100}%`, backgroundColor: color }}
                              />
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
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-success-400 to-success-600"
                                style={{ width: `${Math.max(2, (c.revenue / maxClient) * 100)}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className={`grid grid-cols-1 ${can.attendance && show("attendance_trend") && show("compliance_alerts") ? "lg:grid-cols-2" : ""} gap-6 mb-6 md:mb-8`}>
              {can.attendance && show("attendance_trend") && (
                <div className="bg-white rounded-lg border border-slate-200 p-6">
                  <h3 className="text-base mb-6 text-slate-900">Attendance Trend · Last 7 Days</h3>
                  {attendanceTrend.every((p) => p.present + p.absent + p.leave === 0) ? (
                    <p className="text-sm text-slate-500">No attendance recorded in the last 7 days.</p>
                  ) : (
                    <ResponsiveContainer width="100%" height={250}>
                      <LineChart data={attendanceTrend}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 12 }} />
                        <YAxis tick={{ fill: "#64748b", fontSize: 12 }} />
                        <Tooltip />
                        <Legend />
                        <Line type="monotone" dataKey="present" stroke="var(--color-success-500)" strokeWidth={2} dot={{ fill: "var(--color-success-500)" }} name="Present" />
                        <Line type="monotone" dataKey="absent" stroke="var(--color-danger-500)" strokeWidth={2} dot={{ fill: "var(--color-danger-500)" }} name="Absent" />
                        <Line type="monotone" dataKey="leave" stroke="var(--color-warning-500)" strokeWidth={2} dot={{ fill: "var(--color-warning-500)" }} name="Leave" />
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
                      const daysLeft = Math.max(
                        0,
                        Math.ceil((new Date(a.due_date).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)),
                      );
                      const priorityClass = PRIORITY_COLOR[a.priority] ?? PRIORITY_COLOR.low;
                      return (
                        <div key={a.id} className="p-4 flex items-start gap-3 hover:bg-slate-50 transition-colors">
                          <AlertCircle className="w-4 h-4 text-warning-600 flex-shrink-0 mt-0.5" strokeWidth={1.5} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <p className="text-sm text-slate-900 truncate">{a.title}</p>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide ${priorityClass}`}>
                                {a.priority}
                              </span>
                            </div>
                            <p className="text-xs text-slate-500">{a.category} · due {a.due_date}</p>
                          </div>
                          <span className="text-xs text-slate-400 tabular-nums">
                            {daysLeft === 0 ? "today" : `${daysLeft}d`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
