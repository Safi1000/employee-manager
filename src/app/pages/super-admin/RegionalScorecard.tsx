import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import Header from "../../components/Header";
import ThemedSelect from "../../components/ThemedSelect";
import ExportButton from "../../components/ExportButton";
import { exportTable } from "../../lib/excel";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";

// §22 Regional scorecard + KPI department dashboard — one card per region with
// coverage, incidents, no-shows, receivables, profit and inter-region balance,
// plus the department KPI traffic-light roll-up.
//
// Three financial tabs sit alongside it (0178): the same month's profit read on
// a revenue basis and on a cash basis, and the general-expense breakdown.

const money = (n: any) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const pkr = (n: any) => `PKR ${money(n)}`;

type TabKey = "scorecard" | "profit-revenue" | "profit-cash" | "general";

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

type GeneralExpense = {
  branch_id: string | null;
  region_name: string;
  category: string;
  amount: number;
  is_payroll: boolean;
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
    const from = 0;
    const dur = 900;
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(from + (target - from) * eased);
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
  const companyId = company?.id ?? "";
  const [cards, setCards] = useState<any[]>([]);
  const [kpis, setKpis] = useState<any[]>([]);

  const [tab, setTab] = useState<TabKey>("scorecard");
  const [period, setPeriod] = useState<string>(monthKeyOf(new Date()));
  const [pl, setPl] = useState<RegionalPl[]>([]);
  const [general, setGeneral] = useState<GeneralExpense[]>([]);
  const [loadingFin, setLoadingFin] = useState(false);

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

  const load = useCallback(async () => {
    if (!companyId) return;
    const [sc, kd] = await Promise.all([
      supabase.from("regional_scorecard").select("*").eq("company_id", companyId),
      supabase.from("kpi_department_dashboard").select("*").eq("company_id", companyId).order("period_month", { ascending: false }),
    ]);
    setCards(sc.data ?? []);
    setKpis(kd.data ?? []);
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  // Both financial datasets come from the same month, so they load together —
  // switching between the revenue and cash tabs must not re-query.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    (async () => {
      setLoadingFin(true);
      const [plRes, geRes] = await Promise.all([
        supabase.rpc("regional_pl", { p_month: `${period}-01` }),
        supabase.rpc("regional_general_expenses", { p_month: `${period}-01` }),
      ]);
      if (cancelled) return;
      setPl((plRes.data ?? []) as RegionalPl[]);
      setGeneral((geRes.data ?? []) as GeneralExpense[]);
      setLoadingFin(false);
    })();
    return () => { cancelled = true; };
  }, [companyId, period]);

  const plTotals = useMemo(() => {
    const t = {
      revenue_accrual: 0, payroll_accrual: 0, expenses_accrual: 0, profit_accrual: 0,
      revenue_cash: 0, payroll_cash: 0, expenses_cash: 0, profit_cash: 0,
    };
    for (const r of pl) {
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
  }, [pl]);

  // General expenses pivoted to category × region, so one row reads "Utilities
  // & Rent, and what each region spent on it".
  const generalPivot = useMemo(() => {
    const regions = Array.from(new Set(general.map((g) => g.region_name))).sort();
    const byCategory = new Map<string, { category: string; isPayroll: boolean; per: Map<string, number>; total: number }>();
    for (const g of general) {
      let row = byCategory.get(g.category);
      if (!row) {
        row = { category: g.category, isPayroll: g.is_payroll, per: new Map(), total: 0 };
        byCategory.set(g.category, row);
      }
      const amt = Number(g.amount);
      row.per.set(g.region_name, (row.per.get(g.region_name) ?? 0) + amt);
      row.total += amt;
    }
    const rows = Array.from(byCategory.values()).sort((a, b) => b.total - a.total);
    const perRegionTotal = new Map<string, number>();
    for (const r of rows) {
      for (const [reg, amt] of r.per) perRegionTotal.set(reg, (perRegionTotal.get(reg) ?? 0) + amt);
    }
    const grand = rows.reduce((s, r) => s + r.total, 0);
    return { regions, rows, perRegionTotal, grand };
  }, [general]);

  // Auto-gliding, chevron-controllable marquee of region cards.
  const viewRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const geomRef = useRef({ set: 0, step: 340 });

  useEffect(() => {
    const view = viewRef.current;
    const track = trackRef.current;
    if (!view || !track || cards.length === 0) return;

    const measure = () => {
      geomRef.current.set = track.scrollWidth / 2;
      const card = track.querySelector<HTMLElement>("[data-card]");
      if (card) geomRef.current.step = card.getBoundingClientRect().width + 16;
    };
    measure();
    window.addEventListener("resize", measure);

    let raf = 0;
    const reduce = prefersReduced();
    const loop = () => {
      const g = geomRef.current;
      if (!pausedRef.current && !reduce && g.set > view.clientWidth) {
        view.scrollLeft += 0.4;
        if (view.scrollLeft >= g.set) view.scrollLeft -= g.set;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, [cards]);

  const nudge = (dir: number) => {
    const view = viewRef.current;
    const g = geomRef.current;
    if (!view) return;
    pausedRef.current = true;
    setTimeout(() => { pausedRef.current = false; }, 3200);
    if (dir < 0 && view.scrollLeft < g.step) view.scrollLeft += g.set;
    else if (dir > 0 && view.scrollLeft > g.set - g.step) view.scrollLeft -= g.set;
    view.scrollBy({ left: dir * g.step, behavior: prefersReduced() ? "auto" : "smooth" });
  };

  const loopCards = cards.length ? [...cards, ...cards] : [];

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header
        title="Regional Scorecard"
        subtitle="Per-region operating & financial health (§22)"
        actions={
          tab === "scorecard" ? undefined : (
            <ExportButton
              onExport={() => {
                if (tab === "general") {
                  exportTable({
                    fileName: `Regional General Expenses ${monthLabel(period)}.xlsx`,
                    sheetName: "General Expenses",
                    title: `General Expenses by Region — ${monthLabel(period)}`,
                    headers: ["Category", ...generalPivot.regions, "Total"],
                    rows: generalPivot.rows.map((r) => [
                      r.category,
                      ...generalPivot.regions.map((reg) => Number(r.per.get(reg) ?? 0)),
                      Number(r.total),
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
                  rows: pl.map((r) => [
                    r.region_name,
                    Number(cash ? r.revenue_cash : r.revenue_accrual),
                    Number(cash ? r.payroll_cash : r.payroll_accrual),
                    Number(cash ? r.expenses_cash : r.expenses_accrual),
                    Number(cash ? r.profit_cash : r.profit_accrual),
                  ]),
                });
              }}
            />
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-6 mt-1">
        {([
          ["scorecard", "Scorecard"],
          ["profit-revenue", "Regional Profit · Revenue"],
          ["profit-cash", "Regional Profit · Cash"],
          ["general", "General Expenses"],
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
        {tab !== "scorecard" && (
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
        )}
      </div>

      {tab === "profit-revenue" && (
        <ProfitTab
          basis="revenue"
          rows={pl}
          totals={plTotals}
          period={period}
          loading={loadingFin}
        />
      )}

      {tab === "profit-cash" && (
        <ProfitTab
          basis="cash"
          rows={pl}
          totals={plTotals}
          period={period}
          loading={loadingFin}
        />
      )}

      {tab === "general" && (
        <GeneralExpensesTab pivot={generalPivot} period={period} loading={loadingFin} />
      )}

      {tab === "scorecard" && (
      <>
      <div className="flex items-center justify-between mb-4 mt-1">
        <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-muted-foreground">Regions</h3>
        {cards.length > 1 && (
          <div className="flex gap-2">
            <button type="button" onClick={() => nudge(-1)} aria-label="Previous"
              className="w-9 h-9 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground hover:border-brand-500/50 grid place-items-center transition-colors">
              <ChevronLeft className="w-4 h-4" strokeWidth={2} />
            </button>
            <button type="button" onClick={() => nudge(1)} aria-label="Next"
              className="w-9 h-9 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground hover:border-brand-500/50 grid place-items-center transition-colors">
              <ChevronRight className="w-4 h-4" strokeWidth={2} />
            </button>
          </div>
        )}
      </div>

      {cards.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-10 text-center text-muted-foreground mb-8">No active regions.</div>
      ) : (
        <div
          ref={viewRef}
          className="overflow-hidden mb-8"
          style={{ WebkitMaskImage: "linear-gradient(90deg, transparent, #000 2%, #000 98%, transparent)", maskImage: "linear-gradient(90deg, transparent, #000 2%, #000 98%, transparent)" }}
          onMouseEnter={() => { pausedRef.current = true; }}
          onMouseLeave={() => { pausedRef.current = false; }}
        >
          <div ref={trackRef} className="flex w-max py-1">
            {loopCards.map((c, i) => {
              const profitUp = Number(c.profit_ytd ?? 0) >= Number(c.profit_prior_year ?? 0);
              const accent = profitUp ? "border-l-success-500" : "border-l-danger-500";
              return (
                <div
                  key={i}
                  data-card={i < cards.length ? "" : undefined}
                  aria-hidden={i >= cards.length}
                  className={`w-[320px] flex-shrink-0 mr-4 bg-card border border-border border-l-4 ${accent} rounded-xl p-5 space-y-3 transition-shadow hover:shadow-md`}
                  style={
                    i < cards.length && !prefersReduced()
                      ? { animation: `feed-slide-in 0.5s var(--ease, ease-out) both`, animationDelay: `${i * 70}ms` }
                      : undefined
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 font-semibold text-foreground truncate" style={{ fontFamily: "var(--font-display)" }}>
                      <MapPin className="w-3.5 h-3.5 text-brand-600 dark:text-brand-500 shrink-0" strokeWidth={2} />
                      {c.region_name}
                    </h3>
                    <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground border border-border shrink-0">{String(c.region_kind)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-y-2.5 gap-x-4 text-sm">
                    <Metric label="Active headcount" value={c.active_headcount} />
                    <Metric label="Incidents YTD" value={c.incidents_ytd} tone={Number(c.incidents_ytd) > 0 ? "warn" : undefined} />
                    <Metric label="No-shows 30d" value={c.no_shows_30d} tone={Number(c.no_shows_30d) > 0 ? "warn" : undefined} />
                    <Metric label="Receivables" value={c.receivables_outstanding} money />
                    <Metric label="Profit YTD" value={c.profit_ytd} money tone={Number(c.profit_ytd) < 0 ? "bad" : "good"} />
                    <Metric label="vs prior yr" text={profitUp ? "▲" : "▼"} tone={profitUp ? "good" : "bad"} />
                    <Metric label="Inter-region net" value={c.inter_region_balance} money />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <section>
        <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-muted-foreground mb-2">Department KPI roll-up</h3>
        <div className="overflow-x-auto border border-border rounded-xl bg-card">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="bg-slate-50 text-[11px] text-muted-foreground uppercase tracking-[0.08em] border-b border-border">
              <tr>
                <th className="text-left px-3 py-2.5">Month</th>
                <th className="text-left px-3 py-2.5">Department</th>
                <th className="text-right px-3 py-2.5">Scored</th>
                <th className="text-right px-3 py-2.5">Green</th>
                <th className="text-right px-3 py-2.5">Amber</th>
                <th className="text-right px-3 py-2.5">Red</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {kpis.map((k, i) => (
                <tr key={i} className="hover:bg-accent/50 transition-colors">
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">{String(k.period_month).slice(0, 7)}</td>
                  <td className="px-3 py-2 text-foreground capitalize">{String(k.department).replace(/_/g, " ")}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-foreground">{k.kpis_scored}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-success-700 dark:text-success-500">{k.green}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-warning-700 dark:text-warning-500">{k.amber}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-danger-700 dark:text-danger-500">{k.red}</td>
                </tr>
              ))}
              {kpis.length === 0 && <tr><td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">No KPI scores yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      </>
      )}
    </div>
  );
}

/**
 * Regional profit for one month, on whichever basis was asked for.
 *
 * Both bases come from the same query, so the only thing that changes between
 * the two tabs is which four columns are read and what they are called. That
 * is deliberate: the figures must be two readings of one month, not two
 * separately-derived reports that could drift apart.
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
              // revenue has no margin, and printing "0%" implies it broke even.
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

/**
 * General (overhead) expenses: the running cost of the business rather than the
 * cost of delivering a client's guards. Pivoted category × region so one row
 * reads "rent, and what each region spent on it".
 */
function GeneralExpensesTab({
  pivot, period, loading,
}: {
  pivot: {
    regions: string[];
    rows: { category: string; isPayroll: boolean; per: Map<string, number>; total: number }[];
    perRegionTotal: Map<string, number>;
    grand: number;
  };
  period: string;
  loading: boolean;
}) {
  return (
    <div className="bg-card border border-border rounded-xl mb-8">
      <div className="p-6 border-b border-border">
        <h3 className="text-lg text-foreground mb-1">General Expenses</h3>
        <p className="text-sm text-muted-foreground">
          {monthLabel(period)}. Overheads only — rent, utilities, office salaries, travel, stationery
          and the rest. Anything booked as Cost of Services is excluded, because that is a client's
          guards rather than the cost of running the business.
        </p>
      </div>

      <div className="p-4 border-b border-border">
        <Tile label="Total general expenses" value={pivot.grand} accent="danger" />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-slate-50 text-[11px] text-muted-foreground uppercase tracking-[0.08em] border-b border-border">
            <tr>
              <th className="text-left px-4 py-2.5">Category</th>
              {pivot.regions.map((r) => (
                <th key={r} className="text-right px-4 py-2.5">{r}</th>
              ))}
              <th className="text-right px-4 py-2.5">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && (
              <tr><td colSpan={pivot.regions.length + 2} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && pivot.rows.length === 0 && (
              <tr>
                <td colSpan={pivot.regions.length + 2} className="px-4 py-8 text-center text-muted-foreground">
                  No general expenses recorded for {monthLabel(period)}.
                </td>
              </tr>
            )}
            {!loading && pivot.rows.map((r) => (
              <tr key={r.category} className="hover:bg-accent/50 transition-colors">
                <td className="px-4 py-3 text-foreground">
                  {r.category}
                  {/* Office salaries live in payslips, not expenses — say so, so
                      nobody hunts for the matching expense row. */}
                  {r.isPayroll && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground border border-border">
                      from payroll
                    </span>
                  )}
                </td>
                {pivot.regions.map((reg) => (
                  <td key={reg} className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {r.per.has(reg) ? pkr(r.per.get(reg)) : "—"}
                  </td>
                ))}
                <td className="px-4 py-3 text-right tabular-nums text-foreground font-medium">{pkr(r.total)}</td>
              </tr>
            ))}
          </tbody>
          {!loading && pivot.rows.length > 0 && (
            <tfoot>
              <tr className="border-t border-border bg-slate-50 text-foreground font-medium">
                <td className="px-4 py-3">Total</td>
                {pivot.regions.map((reg) => (
                  <td key={reg} className="px-4 py-3 text-right tabular-nums">
                    {pkr(pivot.perRegionTotal.get(reg) ?? 0)}
                  </td>
                ))}
                <td className="px-4 py-3 text-right tabular-nums">{pkr(pivot.grand)}</td>
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

function Metric({
  label,
  value,
  text,
  tone,
  money: isMoney,
}: {
  label: string;
  value?: number;
  text?: string;
  tone?: "good" | "bad" | "warn";
  money?: boolean;
}) {
  const color =
    tone === "good" ? "text-success-700 dark:text-success-500"
    : tone === "bad" ? "text-danger-700 dark:text-danger-500"
    : tone === "warn" ? "text-warning-700 dark:text-warning-500"
    : "text-foreground";
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums font-medium ${color}`}>
        {text !== undefined ? (
          text
        ) : value === null || value === undefined ? (
          "—"
        ) : (
          <CountUp value={Number(value)} format={isMoney ? money : undefined} />
        )}
      </div>
    </div>
  );
}
