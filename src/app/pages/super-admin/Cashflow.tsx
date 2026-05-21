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
import { TrendingUp, TrendingDown, Wallet } from "lucide-react";

type Row = {
  key: string;
  label: string;
  revenue: number;
  expenses: number;
  payroll: number;
  advances: number;
  net: number;
};

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function monthKeyFromDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthKeyFromIso(iso: string | null | undefined) {
  if (!iso) return null;
  return iso.slice(0, 7);
}

function lastNMonthKeys(n: number): { key: string; label: string }[] {
  const now = new Date();
  const arr: { key: string; label: string }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    arr.push({
      key: monthKeyFromDate(d),
      label: `${MONTH_LABELS[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`,
    });
  }
  return arr;
}

const currency = (n: number) =>
  `PKR ${Math.round(n).toLocaleString("en-PK")}`;

export default function Cashflow() {
  const [invoicePayments, setInvoicePayments] = useState<InvoicePayment[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [cheques, setCheques] = useState<Cheque[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const months = useMemo(() => lastNMonthKeys(12), []);
  const windowStart = months[0]?.key ?? monthKeyFromDate(new Date());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const sinceMonthIso = `${windowStart}-01`;

        const [payRes, psRes, exRes, advRes, chqRes] = await Promise.all([
          supabase
            .from("invoice_payments")
            .select("amount, payment_date")
            .gte("payment_date", sinceMonthIso),
          supabase
            .from("payslips")
            .select("*")
            .eq("disbursed", true)
            .gte("period_month", sinceMonthIso),
          supabase
            .from("expenses")
            .select("*")
            .gte("expense_date", sinceMonthIso),
          supabase
            .from("advances")
            .select("amount, advance_date, payment_mode, cheque_id")
            .gte("advance_date", sinceMonthIso),
          supabase.from("cheques").select("id, status, cleared_at"),
        ]);

        if (payRes.error) throw payRes.error;
        if (psRes.error) throw psRes.error;
        if (exRes.error) throw exRes.error;
        if (advRes.error) throw advRes.error;
        if (chqRes.error) throw chqRes.error;

        if (cancelled) return;
        setInvoicePayments((payRes.data ?? []) as InvoicePayment[]);
        setPayslips((psRes.data ?? []) as Payslip[]);
        setExpenses((exRes.data ?? []) as Expense[]);
        setAdvances((advRes.data ?? []) as Advance[]);
        setCheques((chqRes.data ?? []) as Cheque[]);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? "Failed to load cashflow data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [windowStart]);

  const rows: Row[] = useMemo(() => {
    // Cheque-paid items only count once their cheque is cleared (using cleared_at).
    const chequeById = new Map<string, Cheque>();
    for (const c of cheques) chequeById.set(c.id, c);
    const chequeBucket = (chequeId: string | null): string | null => {
      if (!chequeId) return null;
      const c = chequeById.get(chequeId);
      if (!c || c.status !== "cleared") return null;
      return monthKeyFromIso(c.cleared_at);
    };

    // Revenue is cash-basis: only invoice_payments actually received count.
    // Cheque is outgoing-only, so no gating needed here.
    const revenueByMonth = new Map<string, number>();
    for (const p of invoicePayments) {
      const key = monthKeyFromIso(p.payment_date);
      if (!key) continue;
      revenueByMonth.set(
        key,
        (revenueByMonth.get(key) ?? 0) + Number(p.amount ?? 0),
      );
    }

    const payrollByMonth = new Map<string, number>();
    for (const p of payslips) {
      const key =
        p.payment_mode === "Cheque"
          ? chequeBucket(p.cheque_id)
          : monthKeyFromIso(p.disbursed_at ?? p.period_month);
      if (!key) continue;
      payrollByMonth.set(
        key,
        (payrollByMonth.get(key) ?? 0) + Number(p.net_salary ?? 0),
      );
    }

    const expensesByMonth = new Map<string, number>();
    for (const e of expenses) {
      let key: string | null = null;
      if (e.payment_mode === "Cash" || e.payment_mode === "Bank") {
        key = monthKeyFromIso(e.expense_date);
      } else if (e.payment_mode === "Cheque") {
        key = chequeBucket(e.cheque_id);
      } else if (e.payment_mode === "Payable" && e.payable_status === "Paid") {
        key = monthKeyFromIso(e.paid_at);
      }
      if (!key) continue;
      expensesByMonth.set(
        key,
        (expensesByMonth.get(key) ?? 0) + Number(e.amount ?? 0),
      );
    }

    const advancesByMonth = new Map<string, number>();
    for (const a of advances) {
      const key =
        a.payment_mode === "Cheque"
          ? chequeBucket(a.cheque_id)
          : monthKeyFromIso(a.advance_date);
      if (!key) continue;
      advancesByMonth.set(key, (advancesByMonth.get(key) ?? 0) + Number(a.amount ?? 0));
    }

    return months.map(({ key, label }) => {
      const revenue = revenueByMonth.get(key) ?? 0;
      const payroll = payrollByMonth.get(key) ?? 0;
      const exp = expensesByMonth.get(key) ?? 0;
      const adv = advancesByMonth.get(key) ?? 0;
      return {
        key,
        label,
        revenue,
        expenses: exp,
        payroll,
        advances: adv,
        net: revenue - payroll - exp - adv,
      };
    });
  }, [invoicePayments, payslips, expenses, advances, cheques, months]);

  const totals = useMemo(() => {
    const revenue = rows.reduce((s, r) => s + r.revenue, 0);
    const payroll = rows.reduce((s, r) => s + r.payroll, 0);
    const exp = rows.reduce((s, r) => s + r.expenses, 0);
    const adv = rows.reduce((s, r) => s + r.advances, 0);
    return {
      revenue,
      payroll,
      expenses: exp,
      advances: adv,
      net: revenue - payroll - exp - adv,
    };
  }, [rows]);

  const windowLabel =
    rows.length > 0 ? `${rows[0].label} – ${rows[rows.length - 1].label}` : "";

  return (
    <>
      <Header title="Cashflow & Reports" subtitle="Cash inflow vs outflow over the trailing 12 months" />

      <div className="flex-1 overflow-y-auto p-8">
        {error && (
          <div className="mb-4 p-3 rounded-md border border-danger-200 bg-danger-50 text-danger-700 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
          <SummaryTile
            label="Revenue"
            value={currency(totals.revenue)}
            icon={<Wallet className="w-5 h-5 text-success-600" />}
            accent="emerald"
            subtitle={`Payments received · ${windowLabel}`}
          />
          <SummaryTile
            label="Total Payroll"
            value={currency(totals.payroll)}
            icon={<TrendingDown className="w-5 h-5 text-slate-700" />}
            accent="slate"
            subtitle="Disbursed"
          />
          <SummaryTile
            label="Total Expenses"
            value={currency(totals.expenses)}
            icon={<TrendingDown className="w-5 h-5 text-danger-600" />}
            accent="rose"
            subtitle="Cash/Bank + paid payables"
          />
          <SummaryTile
            label="Total Advances"
            value={currency(totals.advances)}
            icon={<TrendingDown className="w-5 h-5 text-warning-600" />}
            accent="rose"
            subtitle="By advance date"
          />
          <SummaryTile
            label="Net"
            value={currency(totals.net)}
            icon={<TrendingUp className="w-5 h-5 text-slate-700" />}
            accent={totals.net >= 0 ? "emerald" : "rose"}
            subtitle="Revenue − Payroll − Expenses − Advances"
          />
        </div>

        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-6 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="text-base text-slate-900">Monthly Cashflow</h2>
              <p className="text-xs text-slate-500 mt-1">
                Revenue = invoice payments actually received, bucketed by payment date.
                Payroll = disbursed net salaries (when paid out). Expenses include
                Cash/Bank expenses and paid payables. Advances are recognized
                immediately by advance date. All cash-basis.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.print()}
            >
              Download Report (PDF)
            </Button>
          </div>

          <div className="p-6">
            {loading ? (
              <div className="h-[350px] flex items-center justify-center text-slate-500 text-sm">
                Loading cashflow…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={350}>
                <LineChart data={rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "#64748b", fontSize: 12 }}
                  />
                  <YAxis tick={{ fill: "#64748b", fontSize: 12 }} />
                  <Tooltip
                    formatter={(v: number) => currency(Number(v))}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="revenue"
                    stroke="var(--color-success-500)"
                    strokeWidth={2}
                    name="Revenue"
                  />
                  <Line
                    type="monotone"
                    dataKey="expenses"
                    stroke="var(--color-danger-500)"
                    strokeWidth={2}
                    name="Expenses"
                  />
                  <Line
                    type="monotone"
                    dataKey="payroll"
                    stroke="#0f172a"
                    strokeWidth={2}
                    name="Payroll"
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <h3 className="text-base mb-6 text-slate-900">
              Revenue vs Expenses
            </h3>
            {loading ? (
              <div className="h-[300px] flex items-center justify-center text-slate-500 text-sm">
                Loading…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "#64748b", fontSize: 12 }}
                  />
                  <YAxis tick={{ fill: "#64748b", fontSize: 12 }} />
                  <Tooltip
                    formatter={(v: number) => currency(Number(v))}
                  />
                  <Legend />
                  <Bar
                    dataKey="revenue"
                    fill="var(--color-success-500)"
                    radius={[4, 4, 0, 0]}
                    name="Revenue"
                  />
                  <Bar
                    dataKey="expenses"
                    fill="var(--color-danger-500)"
                    radius={[4, 4, 0, 0]}
                    name="Expenses"
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <h3 className="text-base mb-6 text-slate-900">Payroll Impact</h3>
            {loading ? (
              <div className="h-[300px] flex items-center justify-center text-slate-500 text-sm">
                Loading…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "#64748b", fontSize: 12 }}
                  />
                  <YAxis tick={{ fill: "#64748b", fontSize: 12 }} />
                  <Tooltip
                    formatter={(v: number) => currency(Number(v))}
                  />
                  <Bar
                    dataKey="payroll"
                    fill="#0f172a"
                    radius={[4, 4, 0, 0]}
                    name="Payroll Cost"
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <h3 className="text-base text-slate-900">Monthly Breakdown</h3>
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
                  <tr
                    key={r.key}
                    className="border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-6 py-3 text-slate-900">{r.label}</td>
                    <td
                      className={`px-6 py-3 text-right ${
                        r.revenue >= 0 ? "text-success-600" : "text-danger-600"
                      }`}
                    >
                      {currency(r.revenue)}
                    </td>
                    <td className="px-6 py-3 text-right text-slate-700">
                      {currency(r.payroll)}
                    </td>
                    <td className="px-6 py-3 text-right text-danger-600">
                      {currency(r.expenses)}
                    </td>
                    <td className="px-6 py-3 text-right text-warning-600">
                      {currency(r.advances)}
                    </td>
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
                    <td
                      colSpan={6}
                      className="px-6 py-6 text-center text-slate-500"
                    >
                      No data available.
                    </td>
                  </tr>
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50 text-slate-900">
                    <td className="px-6 py-3">Total</td>
                    <td className="px-6 py-3 text-right">
                      {currency(totals.revenue)}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {currency(totals.payroll)}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {currency(totals.expenses)}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {currency(totals.advances)}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {currency(totals.net)}
                    </td>
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
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent: "emerald" | "rose" | "slate";
  subtitle?: string;
}) {
  const accentBg =
    accent === "emerald"
      ? "bg-success-50"
      : accent === "rose"
        ? "bg-danger-50"
        : "bg-slate-100";
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
  return (
    <div className={`bg-white rounded-lg border border-slate-200 border-l-4 ${borderL} p-4`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
          <div className={`text-lg mt-1 ${valueText}`}>{value}</div>
          {subtitle && (
            <div className="text-xs text-slate-400 mt-1">{subtitle}</div>
          )}
        </div>
        <div className={`p-2 rounded-md ${accentBg}`}>{icon}</div>
      </div>
    </div>
  );
}
