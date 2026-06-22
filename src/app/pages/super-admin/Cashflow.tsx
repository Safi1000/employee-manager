import { useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { supabase } from "../../lib/supabase";
import type { Advance, Expense, InvoicePayment, Payslip, Cheque } from "../../lib/supabase";
import { TrendingUp, TrendingDown, Wallet, ChevronDown, ChevronRight } from "lucide-react";

// One cash event, already resolved to a cash-basis effective date.
type CashItem = { date: string; amount: number; group: string; detail: string };

type MetricKey = "revenue" | "payroll" | "expenses" | "advances";

type MonthRow = {
  key: string;
  label: string;
  revenue: number;
  expenses: number;
  payroll: number;
  advances: number;
  net: number;
};

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const isoDay = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);
const monthKey = (day: string) => day.slice(0, 7);
const monthLabel = (key: string) => {
  const [y, m] = key.split("-");
  return `${MONTH_LABELS[Number(m) - 1]} ${y.slice(-2)}`;
};
const todayMonthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const currency = (n: number) => `PKR ${Math.round(n).toLocaleString("en-PK")}`;

type PeriodMode = "month" | "range" | "all";

export default function Cashflow() {
  const [invoicePayments, setInvoicePayments] = useState<InvoicePayment[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [cheques, setCheques] = useState<Cheque[]>([]);
  const [clientNames, setClientNames] = useState<Map<string, string>>(new Map());
  const [employeeNames, setEmployeeNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Period filter (item 1).
  const [mode, setMode] = useState<PeriodMode>("all");
  const [selMonth, setSelMonth] = useState<string>(todayMonthKey());
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  // Which card's breakdown is expanded (item 2).
  const [openMetric, setOpenMetric] = useState<MetricKey | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [payRes, psRes, exRes, advRes, chqRes, cliRes, empRes] = await Promise.all([
          supabase.from("invoice_payments").select("amount, payment_date, client_id"),
          supabase.from("payslips").select("*").eq("disbursed", true),
          supabase.from("expenses").select("*"),
          supabase
            .from("advances")
            .select("amount, advance_date, payment_mode, cheque_id, employee_id"),
          supabase.from("cheques").select("id, status, cleared_at"),
          supabase.from("clients").select("id, name"),
          supabase.from("employees").select("id, full_name"),
        ]);

        for (const r of [payRes, psRes, exRes, advRes, chqRes, cliRes, empRes]) {
          if (r.error) throw r.error;
        }
        if (cancelled) return;
        setInvoicePayments((payRes.data ?? []) as InvoicePayment[]);
        setPayslips((psRes.data ?? []) as Payslip[]);
        setExpenses((exRes.data ?? []) as Expense[]);
        setAdvances((advRes.data ?? []) as Advance[]);
        setCheques((chqRes.data ?? []) as Cheque[]);
        setClientNames(new Map((cliRes.data ?? []).map((c: any) => [c.id, c.name])));
        setEmployeeNames(new Map((empRes.data ?? []).map((e: any) => [e.id, e.full_name])));
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? "Failed to load cashflow data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Normalize every cash event to { effective date, amount, group, detail },
  // using the same cash-basis rules as before (cheque items only count once
  // their cheque clears). Unrealized items (uncleared cheques) are dropped.
  const allItems = useMemo(() => {
    const chequeById = new Map<string, Cheque>();
    for (const c of cheques) chequeById.set(c.id, c);
    const chequeClearedDay = (chequeId: string | null): string | null => {
      if (!chequeId) return null;
      const c = chequeById.get(chequeId);
      if (!c || c.status !== "cleared") return null;
      return isoDay(c.cleared_at);
    };
    const clientName = (id: string | null) => (id && clientNames.get(id)) || "Unassigned";
    const employeeName = (id: string | null) => (id && employeeNames.get(id)) || "Unknown employee";

    const revenue: CashItem[] = [];
    for (const p of invoicePayments) {
      const date = isoDay(p.payment_date);
      if (!date) continue;
      revenue.push({
        date,
        amount: Number(p.amount ?? 0),
        group: clientName(p.client_id),
        detail: clientName(p.client_id),
      });
    }

    const payroll: CashItem[] = [];
    for (const p of payslips) {
      const date =
        p.payment_mode === "Cheque"
          ? chequeClearedDay(p.cheque_id)
          : isoDay(p.disbursed_at ?? p.period_month);
      if (!date) continue;
      const name = employeeName(p.employee_id);
      payroll.push({
        date,
        amount: Number(p.net_salary ?? 0),
        group: name,
        detail: `${name} · ${monthLabel(monthKey(isoDay(p.period_month) ?? date))}`,
      });
    }

    const expensesItems: CashItem[] = [];
    for (const e of expenses) {
      let date: string | null = null;
      if (e.payment_mode === "Cash" || e.payment_mode === "Bank") {
        date = isoDay(e.expense_date);
      } else if (e.payment_mode === "Cheque") {
        date = chequeClearedDay(e.cheque_id);
      } else if (e.payment_mode === "Payable" && e.payable_status === "Paid") {
        date = isoDay(e.paid_at);
      }
      if (!date) continue;
      const cat = e.pl_category || "Uncategorized";
      expensesItems.push({
        date,
        amount: Number(e.amount ?? 0),
        group: cat,
        detail: e.description?.trim() || cat,
      });
    }

    const advancesItems: CashItem[] = [];
    for (const a of advances) {
      const date =
        a.payment_mode === "Cheque" ? chequeClearedDay(a.cheque_id) : isoDay(a.advance_date);
      if (!date) continue;
      const name = employeeName(a.employee_id);
      advancesItems.push({ date, amount: Number(a.amount ?? 0), group: name, detail: name });
    }

    return { revenue, payroll, expenses: expensesItems, advances: advancesItems };
  }, [invoicePayments, payslips, expenses, advances, cheques, clientNames, employeeNames]);

  // Apply the period filter to a list.
  const inPeriod = useMemo(() => {
    return (date: string): boolean => {
      if (mode === "all") return true;
      if (mode === "month") return monthKey(date) === selMonth;
      // range (inclusive); missing bounds are treated as open-ended.
      if (fromDate && date < fromDate) return false;
      if (toDate && date > toDate) return false;
      return true;
    };
  }, [mode, selMonth, fromDate, toDate]);

  const filtered = useMemo(
    () => ({
      revenue: allItems.revenue.filter((i) => inPeriod(i.date)),
      payroll: allItems.payroll.filter((i) => inPeriod(i.date)),
      expenses: allItems.expenses.filter((i) => inPeriod(i.date)),
      advances: allItems.advances.filter((i) => inPeriod(i.date)),
    }),
    [allItems, inPeriod],
  );

  const sum = (items: CashItem[]) => items.reduce((s, i) => s + i.amount, 0);
  const totals = useMemo(() => {
    const revenue = sum(filtered.revenue);
    const payroll = sum(filtered.payroll);
    const exp = sum(filtered.expenses);
    const adv = sum(filtered.advances);
    return { revenue, payroll, expenses: exp, advances: adv, net: revenue - payroll - exp - adv };
  }, [filtered]);

  // Monthly aggregation (for the charts + table) over the filtered set.
  const rows: MonthRow[] = useMemo(() => {
    const map = new Map<string, MonthRow>();
    const bump = (date: string, field: keyof Omit<MonthRow, "key" | "label" | "net">, amt: number) => {
      const key = monthKey(date);
      let r = map.get(key);
      if (!r) {
        r = { key, label: monthLabel(key), revenue: 0, expenses: 0, payroll: 0, advances: 0, net: 0 };
        map.set(key, r);
      }
      r[field] += amt;
    };
    filtered.revenue.forEach((i) => bump(i.date, "revenue", i.amount));
    filtered.payroll.forEach((i) => bump(i.date, "payroll", i.amount));
    filtered.expenses.forEach((i) => bump(i.date, "expenses", i.amount));
    filtered.advances.forEach((i) => bump(i.date, "advances", i.amount));
    const arr = Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
    for (const r of arr) r.net = r.revenue - r.payroll - r.expenses - r.advances;
    return arr;
  }, [filtered]);

  // Grouped breakdown for the currently-open card.
  const breakdown = useMemo(() => {
    if (!openMetric) return [];
    const items = filtered[openMetric];
    const groups = new Map<string, { total: number; items: CashItem[] }>();
    for (const it of items) {
      let g = groups.get(it.group);
      if (!g) {
        g = { total: 0, items: [] };
        groups.set(it.group, g);
      }
      g.total += it.amount;
      g.items.push(it);
    }
    return Array.from(groups.entries())
      .map(([name, g]) => ({
        name,
        total: g.total,
        items: g.items.slice().sort((a, b) => b.date.localeCompare(a.date)),
      }))
      .sort((a, b) => b.total - a.total);
  }, [openMetric, filtered]);

  const periodLabel =
    mode === "all"
      ? "All time"
      : mode === "month"
      ? monthLabel(selMonth)
      : `${fromDate || "start"} → ${toDate || "now"}`;

  const toggleMetric = (m: MetricKey) => {
    setOpenGroups(new Set());
    setOpenMetric((prev) => (prev === m ? null : m));
  };
  const toggleGroup = (name: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const METRICS: { key: MetricKey; label: string }[] = [
    { key: "revenue", label: "Revenue" },
    { key: "payroll", label: "Payroll" },
    { key: "expenses", label: "Expenses" },
    { key: "advances", label: "Advances" },
  ];

  return (
    <>
      <Header title="Cash Flow" subtitle="Cash inflow vs outflow — filter by month, range or all time" />

      <div className="flex-1 overflow-y-auto p-8">
        {error && (
          <div className="mb-4 p-3 rounded-md border border-danger-200 bg-danger-50 text-danger-700 text-sm">
            {error}
          </div>
        )}

        {/* Period filter */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-6 flex flex-wrap items-center gap-3">
          <div className="flex gap-1 bg-slate-100 rounded-md p-1">
            {(["month", "range", "all"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 text-sm rounded capitalize transition-colors ${
                  mode === m ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {m === "all" ? "All time" : m === "month" ? "Month" : "Date range"}
              </button>
            ))}
          </div>

          {mode === "month" && (
            <input
              type="month"
              value={selMonth}
              onChange={(e) => setSelMonth(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          )}
          {mode === "range" && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
              />
              <span className="text-slate-400 text-sm">to</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
              />
            </div>
          )}

          <span className="text-xs text-slate-500 ml-auto">
            Showing: <span className="text-slate-700">{periodLabel}</span> · click a card for a full breakdown
          </span>
        </div>

        {/* Summary cards (clickable → breakdown) */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-4">
          <SummaryTile
            label="Revenue"
            value={currency(totals.revenue)}
            icon={<Wallet className="w-5 h-5 text-success-600" />}
            accent="emerald"
            subtitle="Payments received"
            active={openMetric === "revenue"}
            onClick={() => toggleMetric("revenue")}
          />
          <SummaryTile
            label="Total Payroll"
            value={currency(totals.payroll)}
            icon={<TrendingDown className="w-5 h-5 text-slate-700" />}
            accent="slate"
            subtitle="Disbursed net salaries"
            active={openMetric === "payroll"}
            onClick={() => toggleMetric("payroll")}
          />
          <SummaryTile
            label="Total Expenses"
            value={currency(totals.expenses)}
            icon={<TrendingDown className="w-5 h-5 text-danger-600" />}
            accent="rose"
            subtitle="Cash/Bank + paid payables"
            active={openMetric === "expenses"}
            onClick={() => toggleMetric("expenses")}
          />
          <SummaryTile
            label="Total Advances"
            value={currency(totals.advances)}
            icon={<TrendingDown className="w-5 h-5 text-warning-600" />}
            accent="rose"
            subtitle="By advance / clear date"
            active={openMetric === "advances"}
            onClick={() => toggleMetric("advances")}
          />
          <SummaryTile
            label="Net"
            value={currency(totals.net)}
            icon={<TrendingUp className="w-5 h-5 text-slate-700" />}
            accent={totals.net >= 0 ? "emerald" : "rose"}
            subtitle="Revenue − Payroll − Exp − Adv"
          />
        </div>

        {/* Breakdown panel for the selected card */}
        {openMetric && (
          <div className="bg-white rounded-lg border border-slate-200 mb-6">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base text-slate-900">
                {METRICS.find((m) => m.key === openMetric)?.label} breakdown
                <span className="text-slate-400 text-sm"> · {periodLabel}</span>
              </h3>
              <span className="text-sm text-slate-700">{currency(totals[openMetric])}</span>
            </div>
            <div className="divide-y divide-slate-100">
              {breakdown.length === 0 && (
                <div className="px-6 py-6 text-sm text-slate-500 text-center">
                  No {openMetric} in this period.
                </div>
              )}
              {breakdown.map((g) => {
                const expanded = openGroups.has(g.name);
                return (
                  <div key={g.name}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.name)}
                      className="w-full px-6 py-3 flex items-center justify-between hover:bg-slate-50 text-left"
                    >
                      <span className="flex items-center gap-2 text-sm text-slate-800">
                        {expanded ? (
                          <ChevronDown className="w-4 h-4 text-slate-400" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-slate-400" />
                        )}
                        {g.name}
                        <span className="text-xs text-slate-400">
                          ({g.items.length} {g.items.length === 1 ? "item" : "items"})
                        </span>
                      </span>
                      <span className="text-sm text-slate-700">{currency(g.total)}</span>
                    </button>
                    {expanded && (
                      <div className="bg-slate-50/60">
                        {g.items.map((it, idx) => (
                          <div
                            key={idx}
                            className="px-6 py-2 pl-12 flex items-center justify-between text-sm border-t border-slate-100"
                          >
                            <span className="text-slate-600">
                              <span className="text-slate-400 font-mono text-xs mr-3">{it.date}</span>
                              {it.detail}
                            </span>
                            <span className="text-slate-700">{currency(it.amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-6 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="text-base text-slate-900">Monthly Cashflow</h2>
              <p className="text-xs text-slate-500 mt-1">
                Cash-basis: revenue = payments received, payroll = disbursed net salaries,
                expenses = Cash/Bank + paid payables, advances by advance/clear date.
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => window.print()}>
              Download Report (PDF)
            </Button>
          </div>

          <div className="p-6">
            {loading ? (
              <div className="h-[350px] flex items-center justify-center text-slate-500 text-sm">
                Loading cashflow…
              </div>
            ) : rows.length === 0 ? (
              <div className="h-[350px] flex items-center justify-center text-slate-500 text-sm">
                No data for {periodLabel}.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={350}>
                <LineChart data={rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 12 }} />
                  <YAxis tick={{ fill: "#64748b", fontSize: 12 }} />
                  <Tooltip formatter={(v: number) => currency(Number(v))} />
                  <Legend />
                  <Line type="monotone" dataKey="revenue" stroke="var(--color-success-500)" strokeWidth={2} name="Revenue" />
                  <Line type="monotone" dataKey="expenses" stroke="var(--color-danger-500)" strokeWidth={2} name="Expenses" />
                  <Line type="monotone" dataKey="payroll" stroke="#0f172a" strokeWidth={2} name="Payroll" />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <h3 className="text-base mb-6 text-slate-900">Revenue vs Expenses</h3>
            {loading ? (
              <div className="h-[300px] flex items-center justify-center text-slate-500 text-sm">Loading…</div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 12 }} />
                  <YAxis tick={{ fill: "#64748b", fontSize: 12 }} />
                  <Tooltip formatter={(v: number) => currency(Number(v))} />
                  <Legend />
                  <Bar dataKey="revenue" fill="var(--color-success-500)" radius={[4, 4, 0, 0]} name="Revenue" />
                  <Bar dataKey="expenses" fill="var(--color-danger-500)" radius={[4, 4, 0, 0]} name="Expenses" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <h3 className="text-base mb-6 text-slate-900">Payroll Impact</h3>
            {loading ? (
              <div className="h-[300px] flex items-center justify-center text-slate-500 text-sm">Loading…</div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 12 }} />
                  <YAxis tick={{ fill: "#64748b", fontSize: 12 }} />
                  <Tooltip formatter={(v: number) => currency(Number(v))} />
                  <Bar dataKey="payroll" fill="#0f172a" radius={[4, 4, 0, 0]} name="Payroll Cost" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <h3 className="text-base text-slate-900">Monthly Breakdown · {periodLabel}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                  <th className="px-6 py-3 text-left">Month</th>
                  <th className="px-6 py-3 text-right">Revenue</th>
                  <th className="px-6 py-3 text-right">Payroll</th>
                  <th className="px-6 py-3 text-right">Expenses</th>
                  <th className="px-6 py-3 text-right">Advances</th>
                  <th className="px-6 py-3 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-6 py-3 text-slate-900">{r.label}</td>
                    <td className="px-6 py-3 text-right text-success-600">{currency(r.revenue)}</td>
                    <td className="px-6 py-3 text-right text-slate-700">{currency(r.payroll)}</td>
                    <td className="px-6 py-3 text-right text-danger-600">{currency(r.expenses)}</td>
                    <td className="px-6 py-3 text-right text-warning-600">{currency(r.advances)}</td>
                    <td
                      className={`px-6 py-3 text-right ${
                        r.net >= 0 ? "text-success-600" : "text-danger-600"
                      }`}
                    >
                      {currency(r.net)}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && !loading && (
                  <tr>
                    <td colSpan={6} className="px-6 py-6 text-center text-slate-500">
                      No data available.
                    </td>
                  </tr>
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50 text-slate-900">
                    <td className="px-6 py-3">Total</td>
                    <td className="px-6 py-3 text-right">{currency(totals.revenue)}</td>
                    <td className="px-6 py-3 text-right">{currency(totals.payroll)}</td>
                    <td className="px-6 py-3 text-right">{currency(totals.expenses)}</td>
                    <td className="px-6 py-3 text-right">{currency(totals.advances)}</td>
                    <td className="px-6 py-3 text-right">{currency(totals.net)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function SummaryTile({
  label,
  value,
  icon,
  accent,
  subtitle,
  active,
  onClick,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent: "emerald" | "rose" | "slate";
  subtitle?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const accentBg =
    accent === "emerald" ? "bg-success-50" : accent === "rose" ? "bg-danger-50" : "bg-slate-100";
  const valueText =
    accent === "emerald"
      ? "text-success-700"
      : accent === "rose"
      ? "text-danger-700"
      : "text-slate-900";
  const borderL =
    accent === "emerald"
      ? "border-l-success-500"
      : accent === "rose"
      ? "border-l-danger-500"
      : "border-l-slate-400";
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`text-left w-full bg-white rounded-lg border border-slate-200 border-l-4 ${borderL} p-4 transition-shadow ${
        clickable ? "hover:shadow-sm cursor-pointer" : "cursor-default"
      } ${active ? "ring-2 ring-brand-200" : ""}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
          <div className={`text-lg mt-1 ${valueText}`}>{value}</div>
          {subtitle && <div className="text-xs text-slate-400 mt-1">{subtitle}</div>}
          {clickable && (
            <div className="text-[11px] text-brand-600 mt-1">{active ? "Hide breakdown" : "View breakdown"}</div>
          )}
        </div>
        <div className={`p-2 rounded-md ${accentBg}`}>{icon}</div>
      </div>
    </button>
  );
}
