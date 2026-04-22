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
import type { BankTransaction, Expense, Payslip } from "../../lib/supabase";
import { TrendingUp, TrendingDown, Wallet } from "lucide-react";

type Row = {
  key: string;
  label: string;
  income: number;
  expenses: number;
  payroll: number;
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
  const [bankTx, setBankTx] = useState<BankTransaction[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
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

        const [txRes, psRes, exRes] = await Promise.all([
          supabase
            .from("bank_transactions")
            .select("*")
            .gte("created_at", sinceMonthIso)
            .order("created_at", { ascending: true }),
          supabase
            .from("payslips")
            .select("*")
            .eq("disbursed", true)
            .gte("period_month", sinceMonthIso),
          supabase
            .from("expenses")
            .select("*")
            .gte("expense_date", sinceMonthIso),
        ]);

        if (txRes.error) throw txRes.error;
        if (psRes.error) throw psRes.error;
        if (exRes.error) throw exRes.error;

        if (cancelled) return;
        setBankTx((txRes.data ?? []) as BankTransaction[]);
        setPayslips((psRes.data ?? []) as Payslip[]);
        setExpenses((exRes.data ?? []) as Expense[]);
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
    const incomeByMonth = new Map<string, number>();
    for (const tx of bankTx) {
      const key = monthKeyFromIso(tx.created_at ?? null);
      if (!key) continue;
      const delta = Number(tx.account_delta ?? 0) + Number(tx.cash_delta ?? 0);
      incomeByMonth.set(key, (incomeByMonth.get(key) ?? 0) + delta);
    }

    const payrollByMonth = new Map<string, number>();
    for (const p of payslips) {
      const key = monthKeyFromIso(p.disbursed_at ?? p.period_month);
      if (!key) continue;
      payrollByMonth.set(
        key,
        (payrollByMonth.get(key) ?? 0) + Number(p.net_salary ?? 0),
      );
    }

    const expensesByMonth = new Map<string, number>();
    for (const e of expenses) {
      if (e.payment_mode === "Cash" || e.payment_mode === "Bank") {
        const key = monthKeyFromIso(e.expense_date);
        if (!key) continue;
        expensesByMonth.set(
          key,
          (expensesByMonth.get(key) ?? 0) + Number(e.amount ?? 0),
        );
      } else if (e.payment_mode === "Payable" && e.payable_status === "Paid") {
        const key = monthKeyFromIso(e.paid_at);
        if (!key) continue;
        expensesByMonth.set(
          key,
          (expensesByMonth.get(key) ?? 0) + Number(e.amount ?? 0),
        );
      }
    }

    return months.map(({ key, label }) => {
      const income = incomeByMonth.get(key) ?? 0;
      const payroll = payrollByMonth.get(key) ?? 0;
      const exp = expensesByMonth.get(key) ?? 0;
      return {
        key,
        label,
        income,
        expenses: exp,
        payroll,
        net: income - payroll - exp,
      };
    });
  }, [bankTx, payslips, expenses, months]);

  const totals = useMemo(() => {
    const income = rows.reduce((s, r) => s + r.income, 0);
    const payroll = rows.reduce((s, r) => s + r.payroll, 0);
    const exp = rows.reduce((s, r) => s + r.expenses, 0);
    return { income, payroll, expenses: exp, net: income - payroll - exp };
  }, [rows]);

  const windowLabel =
    rows.length > 0 ? `${rows[0].label} – ${rows[rows.length - 1].label}` : "";

  return (
    <>
      <Header title="Cashflow & Reports" />

      <div className="flex-1 overflow-y-auto p-8">
        {error && (
          <div className="mb-4 p-3 rounded-md border border-red-200 bg-red-50 text-red-700 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <SummaryTile
            label="Net Bank/Cash Change"
            value={currency(totals.income)}
            icon={<Wallet className="w-5 h-5 text-emerald-600" />}
            accent="emerald"
            subtitle={windowLabel}
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
            icon={<TrendingDown className="w-5 h-5 text-rose-600" />}
            accent="rose"
            subtitle="Cash/Bank + paid payables"
          />
          <SummaryTile
            label="Net"
            value={currency(totals.net)}
            icon={<TrendingUp className="w-5 h-5 text-slate-700" />}
            accent={totals.net >= 0 ? "emerald" : "rose"}
            subtitle="Income − Payroll − Expenses"
          />
        </div>

        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-6 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="text-base text-slate-900">Monthly Cashflow</h2>
              <p className="text-xs text-slate-500 mt-1">
                Income = net change in bank + cash balances. Payroll = disbursed
                net salaries. Expenses include Cash/Bank expenses and paid
                payables.
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
                    dataKey="income"
                    stroke="#10b981"
                    strokeWidth={2}
                    name="Income (Net Δ)"
                  />
                  <Line
                    type="monotone"
                    dataKey="expenses"
                    stroke="#ef4444"
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
              Income vs Expenses
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
                    dataKey="income"
                    fill="#10b981"
                    radius={[4, 4, 0, 0]}
                    name="Income"
                  />
                  <Bar
                    dataKey="expenses"
                    fill="#ef4444"
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
                  <th className="px-6 py-3 text-right">Income (Net Δ)</th>
                  <th className="px-6 py-3 text-right">Payroll</th>
                  <th className="px-6 py-3 text-right">Expenses</th>
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
                        r.income >= 0 ? "text-emerald-600" : "text-rose-600"
                      }`}
                    >
                      {currency(r.income)}
                    </td>
                    <td className="px-6 py-3 text-right text-slate-700">
                      {currency(r.payroll)}
                    </td>
                    <td className="px-6 py-3 text-right text-rose-600">
                      {currency(r.expenses)}
                    </td>
                    <td
                      className={`px-6 py-3 text-right ${
                        r.net >= 0 ? "text-emerald-600" : "text-rose-600"
                      }`}
                    >
                      {currency(r.net)}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && !loading && (
                  <tr>
                    <td
                      colSpan={5}
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
                      {currency(totals.income)}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {currency(totals.payroll)}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {currency(totals.expenses)}
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
      ? "bg-emerald-50"
      : accent === "rose"
        ? "bg-rose-50"
        : "bg-slate-100";
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-slate-500">{label}</div>
          <div className="text-lg text-slate-900 mt-1">{value}</div>
          {subtitle && (
            <div className="text-xs text-slate-400 mt-1">{subtitle}</div>
          )}
        </div>
        <div className={`p-2 rounded-md ${accentBg}`}>{icon}</div>
      </div>
    </div>
  );
}
