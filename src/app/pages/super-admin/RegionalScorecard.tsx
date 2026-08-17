import { useEffect, useMemo, useState } from "react";
import { ChevronRight, MapPin } from "lucide-react";
import Header from "../../components/Header";
import ThemedSelect from "../../components/ThemedSelect";
import ExportButton from "../../components/ExportButton";
import { exportTable } from "../../lib/excel";
import { formatDate } from "../../lib/date";
import { useAuth } from "../../lib/auth";
import { useRegion } from "../../lib/region";
import { supabase } from "../../lib/supabase";

// Regional financials. Three views of one month:
//
//   Operating Expenses   what it costs to RUN the business, region by region and
//                        head office included, itemised down to the individual
//                        expense. Cost of services is excluded — that is the
//                        cost of a client's guards, not of the business.
//   Regional Profit      the same month on a revenue basis and on a cash basis.
//
// The §22 scorecard cards (headcount, incidents, no-shows, receivables, YTD
// profit vs prior year) and the department KPI roll-up used to live here. Both
// were removed; regional_scorecard and kpi_department_dashboard are no longer
// read anywhere in the app.

const money = (n: any) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const pkr = (n: any) => `PKR ${money(n)}`;

type TabKey = "opex" | "profit-revenue" | "profit-cash";

/** One region's month, both bases at once — see public.regional_pl. */
type RegionalPl = {
  branch_id: string | null;
  region_name: string;
  revenue_accrual: number;
  payroll_accrual: number;
  expenses_accrual: number;
  profit_accrual: number;
  revenue_cash: number;
  payroll_cash: number;
  expenses_cash: number;
  profit_cash: number;
};

/** One operating-expense line — see public.operating_expense_detail. */
type OpexRow = {
  branch_id: string | null;
  region_name: string;
  category: string;
  expense_id: string | null;
  expense_date: string;
  description: string | null;
  client_name: string | null;
  vendor_name: string | null;
  payment_mode: string | null;
  amount: number;
  is_derived: boolean;
};

const monthKeyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};
const prefersReduced = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Smoothly counts a number up on mount / when it changes. */
function CountUp({ value, format }: { value: number; format?: (n: number) => string }) {
  const [n, setN] = useState(prefersReduced() ? value : 0);
  useEffect(() => {
    const target = Number(value) || 0;
    if (prefersReduced()) {
      setN(target);
      return;
    }
    let raf = 0;
    let start: number | null = null;
    const dur = 900;
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      setN(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setN(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format ? format(n) : Math.round(n).toLocaleString()}</>;
}

export default function RegionalScorecard() {
  const { company } = useAuth();
  // Honours the global region switch: an RMD login is PINNED to its own region,
  // and without this the one page showing regional profit was showing them every
  // other region's. Consolidated (null) keeps the full comparison.
  const { regionId } = useRegion();
  const companyId = company?.id ?? "";

  const [tab, setTab] = useState<TabKey>("opex");
  const [period, setPeriod] = useState<string>(monthKeyOf(new Date()));
  const [pl, setPl] = useState<RegionalPl[]>([]);
  const [opex, setOpex] = useState<OpexRow[]>([]);
  const [loading, setLoading] = useState(false);

  const periodOptions = useMemo(() => {
    const opts: string[] = [];
    const d = new Date();
    d.setDate(1);
    for (let i = 0; i < 18; i += 1) {
      opts.push(monthKeyOf(d));
      d.setMonth(d.getMonth() - 1);
    }
    return opts;
  }, []);

  // Both datasets are the same month, so they load together — switching tabs
  // must not re-query.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [plRes, oxRes] = await Promise.all([
        supabase.rpc("regional_pl", { p_month: `${period}-01` }),
        supabase.rpc("operating_expense_detail", { p_month: `${period}-01` }),
      ]);
      if (cancelled) return;
      setPl((plRes.data ?? []) as RegionalPl[]);
      setOpex((oxRes.data ?? []) as OpexRow[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [companyId, period]);

  // Both RPCs return branch_id and a month is a handful of regions, so the
  // switch is applied here rather than pushed into SQL. Totals derive from the
  // FILTERED rows, so the total line always agrees with the rows above it.
  const plRows = useMemo(
    () => (regionId ? pl.filter((r) => r.branch_id === regionId) : pl),
    [pl, regionId],
  );
  const opexRows = useMemo(
    () => (regionId ? opex.filter((r) => r.branch_id === regionId) : opex),
    [opex, regionId],
  );

  const plTotals = useMemo(() => {
    const t = {
      revenue_accrual: 0, payroll_accrual: 0, expenses_accrual: 0, profit_accrual: 0,
      revenue_cash: 0, payroll_cash: 0, expenses_cash: 0, profit_cash: 0,
    };
    for (const r of plRows) {
      t.revenue_accrual += Number(r.revenue_accrual);
      t.payroll_accrual += Number(r.payroll_accrual);
      t.expenses_accrual += Number(r.expenses_accrual);
      t.profit_accrual += Number(r.profit_accrual);
      t.revenue_cash += Number(r.revenue_cash);
      t.payroll_cash += Number(r.payroll_cash);
      t.expenses_cash += Number(r.expenses_cash);
      t.profit_cash += Number(r.profit_cash);
    }
    return t;
  }, [plRows]);

  // region → category → the individual expenses inside it, with subtotals at
  // every level so each one can be read without adding anything up by hand.
  const opexTree = useMemo(() => {
    const byRegion = new Map<string, {
      region: string;
      total: number;
      categories: Map<string, { category: string; total: number; items: OpexRow[] }>;
    }>();
    for (const r of opexRows) {
      let reg = byRegion.get(r.region_name);
      if (!reg) {
        reg = { region: r.region_name, total: 0, categories: new Map() };
        byRegion.set(r.region_name, reg);
      }
      let cat = reg.categories.get(r.category);
      if (!cat) {
        cat = { category: r.category, total: 0, items: [] };
        reg.categories.set(r.category, cat);
      }
      const amt = Number(r.amount);
      cat.items.push(r);
      cat.total += amt;
      reg.total += amt;
    }
    const regions = Array.from(byRegion.values())
      .map((r) => ({
        ...r,
        categoryList: Array.from(r.categories.values()).sort((a, b) => b.total - a.total),
      }))
      .sort((a, b) => b.total - a.total);
    return { regions, grand: regions.reduce((s, r) => s + r.total, 0) };
  }, [opexRows]);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
      <Header
        title="Regional Financials"
        subtitle="Operating expenses and profit, region by region"
        actions={
          <ExportButton
            onExport={() => {
              if (tab === "opex") {
                exportTable({
                  fileName: `Operating Expenses ${monthLabel(period)}.xlsx`,
                  sheetName: "Operating Expenses",
                  title: `Operating Expenses by Region — ${monthLabel(period)}`,
                  headers: ["Region", "Category", "Date", "Description", "Client / Vendor", "Mode", "Amount"],
                  rows: opexRows.map((r) => [
                    r.region_name,
                    r.category,
                    r.expense_date,
                    r.description ?? "",
                    r.client_name ?? r.vendor_name ?? "Office",
                    r.payment_mode ?? (r.is_derived ? "Payroll" : ""),
                    Number(r.amount),
                  ]),
                });
                return;
              }
              const cash = tab === "profit-cash";
              exportTable({
                fileName: `Regional Profit (${cash ? "Cash" : "Revenue"}) ${monthLabel(period)}.xlsx`,
                sheetName: "Regional Profit",
                title: `Regional Profit — ${cash ? "cash basis" : "revenue basis"} — ${monthLabel(period)}`,
                headers: ["Region", cash ? "Cash Received" : "Revenue", cash ? "Payroll Paid" : "Payroll", cash ? "Expenses Paid" : "Expenses", cash ? "Net Cash" : "Profit"],
                rows: plRows.map((r) => [
                  r.region_name,
                  Number(cash ? r.revenue_cash : r.revenue_accrual),
                  Number(cash ? r.payroll_cash : r.payroll_accrual),
                  Number(cash ? r.expenses_cash : r.expenses_accrual),
                  Number(cash ? r.profit_cash : r.profit_accrual),
                ]),
              });
            }}
          />
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-6 mt-1">
        {([
          ["opex", "Operating Expenses"],
          ["profit-revenue", "Regional Profit · Revenue"],
          ["profit-cash", "Regional Profit · Cash"],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`px-4 py-2 rounded-md text-sm transition-colors ${
              tab === k
                ? "bg-brand-600 text-[#fff]"
                : "bg-card text-muted-foreground border border-border hover:bg-accent"
            }`}
          >
            {label}
          </button>
        ))}
        <div className="flex items-center gap-2 ml-auto">
          <label className="text-sm text-muted-foreground">Month:</label>
          <ThemedSelect
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="px-3 py-2 border border-border rounded-md text-sm bg-card"
          >
            {periodOptions.map((p) => (
              <option key={p} value={p}>{monthLabel(p)}</option>
            ))}
          </ThemedSelect>
        </div>
      </div>

      {tab === "opex" && <OperatingExpensesTab tree={opexTree} period={period} loading={loading} />}
      {tab === "profit-revenue" && (
        <ProfitTab basis="revenue" rows={plRows} totals={plTotals} period={period} loading={loading} />
      )}
      {tab === "profit-cash" && (
        <ProfitTab basis="cash" rows={plRows} totals={plTotals} period={period} loading={loading} />
      )}
    </div>
  );
}

/**
 * Operating expenses, region → category → the individual expenses inside it.
 *
 * Regions start expanded and categories collapsed: the question is almost
 * always "what did this region spend on what", with the individual lines there
 * to answer "on what exactly" once a category looks wrong.
 */
function OperatingExpensesTab({
  tree, period, loading,
}: {
  tree: {
    regions: {
      region: string;
      total: number;
      categoryList: { category: string; total: number; items: OpexRow[] }[];
    }[];
    grand: number;
  };
  period: string;
  loading: boolean;
}) {
  const [openCats, setOpenCats] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpenCats((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <div className="space-y-6 mb-8">
      <div className="bg-card border border-border rounded-xl">
        <div className="p-6 border-b border-border">
          <h3 className="text-lg text-foreground mb-1">Operating Expenses — {monthLabel(period)}</h3>
          <p className="text-sm text-muted-foreground">
            The cost of running the business: rent, utilities, office salaries, travel, stationery and
            the rest, per region and at head office. Cost of Services is excluded — that is the cost of
            a client's guards, and it belongs to the client, not the overhead.
          </p>
        </div>
        <div className="p-4">
          <div className="bg-card p-3 rounded-lg border border-border border-l-4 border-l-danger-500 inline-block min-w-[240px]">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
              Total operating expenses
            </p>
            <p className="text-lg tabular-nums text-danger-700 dark:text-danger-500">
              PKR <CountUp value={tree.grand} format={money} />
            </p>
          </div>
        </div>
      </div>

      {loading && (
        <div className="bg-card border border-border rounded-xl p-10 text-center text-muted-foreground">
          Loading…
        </div>
      )}

      {!loading && tree.regions.length === 0 && (
        <div className="bg-card border border-border rounded-xl p-10 text-center text-muted-foreground">
          No operating expenses recorded for {monthLabel(period)}.
        </div>
      )}

      {!loading && tree.regions.map((reg) => (
        <div key={reg.region} className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3 bg-slate-50">
            <h4 className="flex items-center gap-2 text-foreground font-semibold" style={{ fontFamily: "var(--font-display)" }}>
              <MapPin className="w-4 h-4 text-brand-600 dark:text-brand-500 shrink-0" strokeWidth={2} />
              {reg.region}
              <span className="text-xs font-normal text-muted-foreground">
                {reg.categoryList.length} categor{reg.categoryList.length === 1 ? "y" : "ies"}
              </span>
            </h4>
            <span className="tabular-nums text-danger-700 dark:text-danger-500 font-medium">
              {pkr(reg.total)}
            </span>
          </div>

          <div className="divide-y divide-border">
            {reg.categoryList.map((cat) => {
              const key = `${reg.region}|${cat.category}`;
              const open = openCats.has(key);
              const share = reg.total !== 0 ? (cat.total / reg.total) * 100 : 0;
              return (
                <div key={key}>
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    aria-expanded={open}
                    className="w-full px-5 py-2.5 flex items-center gap-3 hover:bg-accent/50 transition-colors text-left"
                  >
                    <ChevronRight
                      className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                      strokeWidth={1.75}
                    />
                    <span className="text-sm text-foreground flex-1 truncate">
                      {cat.category}
                      {/* Office salaries come from payslips, not expenses — say
                          so, so nobody hunts for a matching expense row. */}
                      {cat.items.some((i) => i.is_derived) && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground border border-border">
                          from payroll
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0 hidden sm:inline">
                      {share.toFixed(1)}%
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                      {cat.items.length} item{cat.items.length === 1 ? "" : "s"}
                    </span>
                    <span className="text-sm tabular-nums text-foreground shrink-0 w-32 text-right">
                      {pkr(cat.total)}
                    </span>
                  </button>

                  {open && (
                    <div className="bg-slate-50/60 overflow-x-auto">
                      <table className="w-full text-sm min-w-[620px]">
                        <thead>
                          <tr className="text-[11px] text-muted-foreground uppercase tracking-[0.08em] border-y border-border">
                            <th className="text-left px-5 py-2 pl-12">Date</th>
                            <th className="text-left px-3 py-2">Description</th>
                            <th className="text-left px-3 py-2">Client / Vendor</th>
                            <th className="text-left px-3 py-2">Mode</th>
                            <th className="text-right px-5 py-2">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {cat.items.map((it, i) => (
                            <tr key={it.expense_id ?? `derived-${i}`} className="hover:bg-accent/40 transition-colors">
                              <td className="px-5 py-2 pl-12 text-muted-foreground tabular-nums whitespace-nowrap">
                                {formatDate(it.expense_date)}
                              </td>
                              <td className="px-3 py-2 text-foreground">
                                {it.description || <span className="text-muted-foreground">—</span>}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {it.client_name ?? it.vendor_name ?? "Office"}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {it.payment_mode ?? (it.is_derived ? "Payroll" : "—")}
                              </td>
                              <td className="px-5 py-2 text-right tabular-nums text-foreground">
                                {pkr(it.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="border-t border-border text-foreground font-medium">
                            <td className="px-5 py-2 pl-12" colSpan={4}>{cat.category} total</td>
                            <td className="px-5 py-2 text-right tabular-nums">{pkr(cat.total)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Regional profit for one month, on whichever basis was asked for.
 *
 * Both bases come from the same query, so the only thing that changes between
 * the two tabs is which four columns are read and what they are called — two
 * readings of one month, not two separately-derived reports that could drift.
 */
function ProfitTab({
  basis, rows, totals, period, loading,
}: {
  basis: "revenue" | "cash";
  rows: RegionalPl[];
  totals: {
    revenue_accrual: number; payroll_accrual: number; expenses_accrual: number; profit_accrual: number;
    revenue_cash: number; payroll_cash: number; expenses_cash: number; profit_cash: number;
  };
  period: string;
  loading: boolean;
}) {
  const cash = basis === "cash";
  const pick = (r: RegionalPl) => ({
    revenue: Number(cash ? r.revenue_cash : r.revenue_accrual),
    payroll: Number(cash ? r.payroll_cash : r.payroll_accrual),
    expenses: Number(cash ? r.expenses_cash : r.expenses_accrual),
    profit: Number(cash ? r.profit_cash : r.profit_accrual),
  });
  const t = {
    revenue: cash ? totals.revenue_cash : totals.revenue_accrual,
    payroll: cash ? totals.payroll_cash : totals.payroll_accrual,
    expenses: cash ? totals.expenses_cash : totals.expenses_accrual,
    profit: cash ? totals.profit_cash : totals.profit_accrual,
  };
  const L = cash
    ? { revenue: "Cash Received", payroll: "Payroll Paid", expenses: "Expenses Paid", profit: "Net Cash" }
    : { revenue: "Revenue", payroll: "Payroll", expenses: "Expenses", profit: "Profit" };

  return (
    <div className="bg-card border border-border rounded-xl mb-8">
      <div className="p-6 border-b border-border">
        <h3 className="text-lg text-foreground mb-1">
          Regional Profit — {cash ? "cash basis" : "revenue basis"}
        </h3>
        <p className="text-sm text-muted-foreground">
          {monthLabel(period)}.{" "}
          {cash
            ? "Money that actually moved: payments received, salaries disbursed, expenses paid. A cheque counts on the day it clears."
            : "Money earned and incurred: invoices raised, salaries accrued to the period, expenses by their date — regardless of whether either side has been settled."}
        </p>
      </div>

      <div className="p-4 grid grid-cols-1 md:grid-cols-4 gap-3 border-b border-border">
        <Tile label={L.revenue} value={t.revenue} accent="brand" />
        <Tile label={L.payroll} value={t.payroll} accent="danger" />
        <Tile label={L.expenses} value={t.expenses} accent="danger" />
        <Tile label={L.profit} value={t.profit} accent={t.profit >= 0 ? "success" : "danger"} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-slate-50 text-[11px] text-muted-foreground uppercase tracking-[0.08em] border-b border-border">
            <tr>
              <th className="text-left px-4 py-2.5">Region</th>
              <th className="text-right px-4 py-2.5">{L.revenue}</th>
              <th className="text-right px-4 py-2.5">{L.payroll}</th>
              <th className="text-right px-4 py-2.5">{L.expenses}</th>
              <th className="text-right px-4 py-2.5">{L.profit}</th>
              <th className="text-right px-4 py-2.5">Margin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No regions.</td></tr>
            )}
            {!loading && rows.map((r) => {
              const v = pick(r);
              // Undefined rather than 0% when nothing came in — a region with no
              // revenue has no margin, and "0%" would imply it broke even.
              const margin = v.revenue > 0 ? (v.profit / v.revenue) * 100 : null;
              return (
                <tr key={r.branch_id ?? "unassigned"} className="hover:bg-accent/50 transition-colors">
                  <td className="px-4 py-3 text-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-brand-600 dark:text-brand-500 shrink-0" strokeWidth={2} />
                      {r.region_name}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-brand-700 dark:text-brand-500">{pkr(v.revenue)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-danger-700 dark:text-danger-500">{pkr(v.payroll)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-danger-700 dark:text-danger-500">{pkr(v.expenses)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums font-medium ${v.profit >= 0 ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"}`}>
                    {pkr(v.profit)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {margin === null ? "—" : `${margin.toFixed(1)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {!loading && rows.length > 0 && (
            <tfoot>
              <tr className="border-t border-border bg-slate-50 text-foreground font-medium">
                <td className="px-4 py-3">Total</td>
                <td className="px-4 py-3 text-right tabular-nums">{pkr(t.revenue)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{pkr(t.payroll)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{pkr(t.expenses)}</td>
                <td className={`px-4 py-3 text-right tabular-nums ${t.profit >= 0 ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"}`}>
                  {pkr(t.profit)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {t.revenue > 0 ? `${((t.profit / t.revenue) * 100).toFixed(1)}%` : "—"}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function Tile({
  label, value, accent,
}: {
  label: string;
  value: number;
  accent: "brand" | "danger" | "success";
}) {
  const border =
    accent === "success" ? "border-l-success-500" : accent === "danger" ? "border-l-danger-500" : "border-l-brand-500";
  const text =
    accent === "success" ? "text-success-700 dark:text-success-500"
    : accent === "danger" ? "text-danger-700 dark:text-danger-500"
    : "text-foreground";
  return (
    <div className={`bg-card p-3 rounded-lg border border-border border-l-4 ${border}`}>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{label}</p>
      <p className={`text-lg tabular-nums ${text}`}>
        PKR <CountUp value={Number(value)} format={money} />
      </p>
    </div>
  );
}
