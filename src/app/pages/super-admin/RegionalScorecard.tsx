import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, MapPin, Wallet, Layers, Receipt, Building2 } from "lucide-react";
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

type TabKey = "scorecard" | "opex" | "profit-revenue" | "profit-cash";

/** One region's scorecard — see the public.regional_scorecard view. */
type ScorecardRow = {
  branch_id: string | null;
  region_name: string;
  active_headcount: number;
  incidents_ytd: number;
  no_shows_30d: number;
  receivables_outstanding: number;
  profit_ytd: number;
  profit_prior_year: number;
};

/** One client's fully-loaded statement — see public.client_statement_loaded.
 *  Summed per branch it gives the three distinct cost buckets a region carries. */
type ClientStmtRow = {
  branch_id: string | null;
  revenue: number;
  direct_payroll: number;
  direct_expenses: number;
  regional_overhead: number;
  ho_share: number;
  net: number;
};

/** The three cost types kept apart, per region, for the selected month. */
type RegionFinance = {
  revenue: number;
  clientLinked: number;   // cost of services booked to clients
  regionSpecific: number; // office staff salary + office running costs
  shared: number;         // head office, apportioned
  net: number;
};
const ZERO_FINANCE: RegionFinance = { revenue: 0, clientLinked: 0, regionSpecific: 0, shared: 0, net: 0 };

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
  // This page deliberately does NOT follow the global region switch: its own
  // region tabs are the filter, and they always list every company region. The
  // one exception is a PINNED user (RMD), a hard security boundary — they stay
  // restricted to their own region regardless.
  const { regionId, regions, locked } = useRegion();
  const companyId = company?.id ?? "";

  // Only the operating-expenses view is shown now; the other tabs (scorecard,
  // profit) are hidden, not deleted — their components and render branches stay.
  const [tab] = useState<TabKey>("opex");
  // Region filter for the operating-expenses view, in place of the old metric
  // tabs. "all" stacks every region; a branch key narrows to that one.
  const [regionTab, setRegionTab] = useState<string>("all");
  const [period, setPeriod] = useState<string>(monthKeyOf(new Date()));
  const [pl, setPl] = useState<RegionalPl[]>([]);
  const [opex, setOpex] = useState<OpexRow[]>([]);
  const [scorecard, setScorecard] = useState<ScorecardRow[]>([]);
  const [clientStmt, setClientStmt] = useState<ClientStmtRow[]>([]);
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
      const monthStart = `${period}-01`;
      const [yy, mm] = period.split("-").map(Number);
      const monthEnd = `${period}-${String(new Date(yy, mm, 0).getDate()).padStart(2, "0")}`;
      const [plRes, oxRes, scRes, csRes] = await Promise.all([
        supabase.rpc("regional_pl", { p_month: monthStart }),
        supabase.rpc("operating_expense_detail", { p_month: monthStart }),
        // View keys off current_date, not the picked month, so it is the same
        // every period — refetched with the rest rather than special-cased.
        supabase.from("regional_scorecard").select(
          "branch_id, region_name, active_headcount, incidents_ytd, no_shows_30d, receivables_outstanding, profit_ytd, profit_prior_year",
        ).eq("company_id", companyId).order("region_name"),
        // Reused wholesale from the P&L / partner-basis work: the same statement
        // that separates client-linked cost, regional overhead and HO share.
        supabase.rpc("client_statement_loaded", { p_start: monthStart, p_end: monthEnd, p_basis: "revenue" }),
      ]);
      if (cancelled) return;
      setPl((plRes.data ?? []) as RegionalPl[]);
      setOpex((oxRes.data ?? []) as OpexRow[]);
      setScorecard((scRes.data ?? []) as ScorecardRow[]);
      setClientStmt((csRes.data ?? []) as ClientStmtRow[]);
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
  // Head Office branch(es): their own overhead is apportioned into the
  // client-bearing regions, so we drop it from the direct display and re-add it
  // as each region's "Head Office (allocated)" expense line.
  const hoBranchIds = useMemo(
    () => new Set(regions.filter((r) => r.is_head_office).map((r) => r.id)),
    [regions],
  );

  // Head-Office-cost-by-region: each region's share of company invoicing and the
  // HO cost that share carries. Straight off the same client statement the
  // Financial Reports / Cash Flow pages use, so the numbers match exactly.
  const hoByRegion = useMemo(() => {
    const m = new Map<string, { branchId: string; name: string; invoiced: number; ho: number }>();
    for (const r of clientStmt) {
      if (!r.branch_id || hoBranchIds.has(r.branch_id)) continue;
      const cur = m.get(r.branch_id) ?? {
        branchId: r.branch_id,
        name: regions.find((x) => x.id === r.branch_id)?.name ?? "Region",
        invoiced: 0,
        ho: 0,
      };
      cur.invoiced += Number(r.revenue);
      cur.ho += Number(r.ho_share);
      m.set(r.branch_id, cur);
    }
    const all = Array.from(m.values());
    const companyInvoiced = all.reduce((s, x) => s + x.invoiced, 0);
    const totalHo = all.reduce((s, x) => s + x.ho, 0);
    // Division by zero guarded: no invoicing → every region 0%.
    const rows = all
      .map((x) => ({ ...x, pct: companyInvoiced > 0 ? (x.invoiced / companyInvoiced) * 100 : 0 }))
      .sort((a, b) => b.ho - a.ho);
    return { rows, companyInvoiced, totalHo };
  }, [clientStmt, hoBranchIds, regions]);

  // Operating expenses with the apportioned Head Office share added on. The Head
  // Office region stays exactly as before (its own opex + tab); each client-
  // bearing region additionally gains a synthetic "Head Office (allocated)" line,
  // so its total and the grand total include the apportioned share.
  const opexLoaded = useMemo(() => {
    const own = opex;
    const hoLines: OpexRow[] = hoByRegion.rows
      .filter((r) => r.ho > 0)
      .map((r) => ({
        branch_id: r.branchId,
        region_name: r.name,
        category: "Head Office (allocated)",
        expense_id: null,
        expense_date: `${period}-01`,
        description: "Apportioned by share of company revenue",
        client_name: null,
        vendor_name: null,
        payment_mode: null,
        amount: r.ho,
        is_derived: false,
      }));
    return [...own, ...hoLines];
  }, [opex, hoBranchIds, hoByRegion, period]);

  // All regions' expenses — the global selector is intentionally ignored here.
  // A pinned user is the only one kept to their own region (security boundary).
  const opexRows = useMemo(
    () => (locked && regionId ? opexLoaded.filter((r) => r.branch_id === regionId) : opexLoaded),
    [opexLoaded, regionId, locked],
  );
  // Region tabs list EVERY company region (Head Office included, as before),
  // independent of the global selector. A pinned user sees only theirs.
  const regionTabs = useMemo(() => {
    const list = locked && regionId ? regions.filter((r) => r.id === regionId) : regions;
    return list.map((r) => ({ key: r.id, name: r.name }));
  }, [regions, locked, regionId]);
  // Fall back to "all" when the picked region has no rows this month, so the
  // highlight and the filter never point at a tab that isn't there.
  const activeRegion = regionTabs.some((t) => t.key === regionTab) ? regionTab : "all";
  const opexRegionRows = useMemo(
    () => (activeRegion === "all" ? opexRows : opexRows.filter((r) => (r.branch_id ?? "unassigned") === activeRegion)),
    [opexRows, activeRegion],
  );
  const scRows = useMemo(
    () => (regionId ? scorecard.filter((r) => r.branch_id === regionId) : scorecard),
    [scorecard, regionId],
  );

  // The month's client statements summed per region, into the three cost types.
  // Keyed by branch so each region card can look its own figures up in O(1);
  // a region with no clients simply isn't in the map and reads as all-zero.
  const finByBranch = useMemo(() => {
    const m = new Map<string, RegionFinance>();
    for (const r of clientStmt) {
      const key = r.branch_id ?? "unassigned";
      const a = m.get(key) ?? { ...ZERO_FINANCE };
      a.revenue += Number(r.revenue);
      a.clientLinked += Number(r.direct_payroll) + Number(r.direct_expenses);
      a.regionSpecific += Number(r.regional_overhead);
      a.shared += Number(r.ho_share);
      a.net += Number(r.net);
      m.set(key, a);
    }
    return m;
  }, [clientStmt]);
  const finance = (branchId: string | null) => finByBranch.get(branchId ?? "unassigned") ?? ZERO_FINANCE;

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
    for (const r of opexRegionRows) {
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
  }, [opexRegionRows]);

  return (
    <>
      <Header
        title="Regional Operating Expenses"
        subtitle="Operating expenses, region by region"
        actions={
          <ExportButton
            onExport={() => {
              if (tab === "scorecard") {
                exportTable({
                  fileName: `Regional Scorecard ${monthLabel(period)}.xlsx`,
                  sheetName: "Regional Scorecard",
                  title: `Regional Scorecard — ${monthLabel(period)}`,
                  headers: [
                    "Region", "Headcount", "Incidents (YTD)", "No-shows (30d)", "Receivables",
                    "Revenue (month)", "Client-Linked Costs", "Region-Specific Expenses", "Shared / Allocated", "Net (month)",
                  ],
                  rows: scRows.map((r) => {
                    const f = finance(r.branch_id);
                    return [
                      r.region_name,
                      Number(r.active_headcount),
                      Number(r.incidents_ytd),
                      Number(r.no_shows_30d),
                      Number(r.receivables_outstanding),
                      f.revenue, f.clientLinked, f.regionSpecific, f.shared, f.net,
                    ];
                  }),
                });
                return;
              }
              if (tab === "opex") {
                exportTable({
                  fileName: `Operating Expenses ${monthLabel(period)}.xlsx`,
                  sheetName: "Operating Expenses",
                  title: `Operating Expenses by Region — ${monthLabel(period)}`,
                  headers: ["Region", "Category", "Date", "Description", "Client / Vendor", "Mode", "Amount"],
                  rows: opexRegionRows.map((r) => [
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

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
      <div className="flex flex-wrap items-center gap-3 mb-6 mt-1">
        {/* Region tabs replace the old metric tabs: pick a region to filter the
            operating expenses, or "All Regions" to see them stacked. */}
        <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-muted/60 border border-border">
          {[{ key: "all", name: "All Regions" }, ...regionTabs].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setRegionTab(t.key)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm transition-all ${
                activeRegion === t.key
                  ? "bg-brand-600 text-[#fff] shadow-sm shadow-brand-600/25"
                  : "text-muted-foreground hover:text-foreground hover:bg-card"
              }`}
            >
              {t.key !== "all" && (
                <MapPin className={`w-3.5 h-3.5 ${activeRegion === t.key ? "text-[#fff]" : "text-brand-500"}`} strokeWidth={2} />
              )}
              {t.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <label className="text-sm text-muted-foreground">Month</label>
          <ThemedSelect
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="px-3 py-2 border border-border rounded-lg text-sm bg-card shadow-sm"
          >
            {periodOptions.map((p) => (
              <option key={p} value={p}>{monthLabel(p)}</option>
            ))}
          </ThemedSelect>
        </div>
      </div>

      {tab === "scorecard" && <ScorecardTab rows={scRows} finance={finance} period={period} loading={loading} />}
      {tab === "opex" && (
        <OperatingExpensesTab
          tree={opexTree}
          period={period}
          loading={loading}
          hoByRegion={hoByRegion}
          showHoBreakdown={activeRegion === "all"}
        />
      )}
      {tab === "profit-revenue" && (
        <ProfitTab basis="revenue" rows={plRows} totals={plTotals} period={period} loading={loading} />
      )}
      {tab === "profit-cash" && (
        <ProfitTab basis="cash" rows={plRows} totals={plTotals} period={period} loading={loading} />
      )}
      </div>
    </>
  );
}

/**
 * Regional scorecard — one card per region, in two clearly-separated zones:
 *
 *   Operations   headcount, incidents, no-shows, receivables — a current
 *                snapshot from the regional_scorecard view (not the picked month).
 *   Money        the selected month's revenue and its THREE distinct cost types,
 *                kept apart because they answer different questions:
 *                  · Client-linked      cost of the guards a client pays for
 *                  · Region-specific    this region's own office staff + running
 *                                       costs, tied to no client — the figure the
 *                                       old flat scorecard buried
 *                  · Shared / allocated head office, apportioned down
 *                These reconcile: revenue − the three = net.
 */
function ScorecardTab({
  rows, finance, period, loading,
}: {
  rows: ScorecardRow[];
  finance: (branchId: string | null) => RegionFinance;
  period: string;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="bg-card border border-border rounded-xl p-10 text-center text-muted-foreground mb-8">
        Loading…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-10 text-center text-muted-foreground mb-8">
        No regions.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
      {rows.map((r) => (
        <RegionCard key={r.branch_id ?? "unassigned"} row={r} fin={finance(r.branch_id)} period={period} />
      ))}
    </div>
  );
}

/** A stat in the Operations zone — label above, value below. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">{label}</p>
      <p className={`text-base tabular-nums ${tone === "danger" ? "text-danger-700 dark:text-danger-500" : "text-foreground"}`}>
        {value}
      </p>
    </div>
  );
}

/**
 * One region. The three cost lines are colour-coded — amber for the
 * region-specific expenses this redesign is about, slate for client-linked,
 * indigo for the allocated head-office share — so which bucket a number sits in
 * is never ambiguous, and a share bar under each shows its weight at a glance.
 */
function RegionCard({ row, fin, period }: { row: ScorecardRow; fin: RegionFinance; period: string }) {
  const ytdDelta = Number(row.profit_ytd) - Number(row.profit_prior_year);
  const costTotal = fin.clientLinked + fin.regionSpecific + fin.shared;
  const pct = (n: number) => (costTotal > 0 ? (n / costTotal) * 100 : 0);
  const CostLine = ({ label, value, hint, bar, text }: {
    label: string; value: number; hint: string; bar: string; text: string;
  }) => (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className={`inline-flex items-center gap-1.5 text-sm ${text}`}>
          <span className={`w-2 h-2 rounded-full ${bar}`} />
          {label}
        </span>
        <span className="text-sm tabular-nums text-foreground shrink-0">− {pkr(value)}</span>
      </div>
      <div className="flex items-center gap-2 mt-1 pl-3.5">
        <div className="h-1 flex-1 rounded-full bg-muted overflow-hidden">
          <div className={`h-full ${bar}`} style={{ width: `${pct(value)}%` }} />
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0">{hint}</span>
      </div>
    </div>
  );

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden flex flex-col">
      {/* Header — region + the month's net */}
      <div className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3 bg-slate-50">
        <h4 className="flex items-center gap-2 text-foreground font-semibold" style={{ fontFamily: "var(--font-display)" }}>
          <MapPin className="w-4 h-4 text-brand-600 dark:text-brand-500 shrink-0" strokeWidth={2} />
          {row.region_name}
        </h4>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Net · {monthLabel(period)}</p>
          <p className={`text-base tabular-nums font-medium ${fin.net >= 0 ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"}`}>
            {pkr(fin.net)}
          </p>
        </div>
      </div>

      {/* Operations — current snapshot */}
      <div className="px-5 py-3.5 border-b border-border">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Operations · current</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Headcount" value={money(row.active_headcount)} />
          <Stat label="Incidents YTD" value={money(row.incidents_ytd)} />
          <Stat label="No-shows 30d" value={money(row.no_shows_30d)} />
          <Stat label="Receivables" value={pkr(row.receivables_outstanding)} tone="danger" />
        </div>
      </div>

      {/* Money — the selected month, revenue then the three cost types */}
      <div className="px-5 py-3.5 space-y-2.5 flex-1">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Money · {monthLabel(period)}</p>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-brand-700 dark:text-brand-500">Revenue</span>
          <span className="text-sm tabular-nums text-brand-700 dark:text-brand-500">{pkr(fin.revenue)}</span>
        </div>
        <CostLine
          label="Client-linked" value={fin.clientLinked}
          hint={`${pct(fin.clientLinked).toFixed(0)}%`}
          bar="bg-slate-400" text="text-muted-foreground"
        />
        <CostLine
          label="Region-specific" value={fin.regionSpecific}
          hint={`${pct(fin.regionSpecific).toFixed(0)}%`}
          bar="bg-amber-500" text="text-amber-700 dark:text-amber-500"
        />
        <CostLine
          label="Shared / allocated" value={fin.shared}
          hint={`${pct(fin.shared).toFixed(0)}%`}
          bar="bg-indigo-400" text="text-muted-foreground"
        />
        <div className="flex items-baseline justify-between gap-3 pt-2 border-t border-border">
          <span className="text-sm text-foreground font-medium">Net</span>
          <span className={`text-sm tabular-nums font-medium ${fin.net >= 0 ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"}`}>
            {pkr(fin.net)}
          </span>
        </div>
      </div>

      {/* Footer — the view's YTD profit vs last year, kept but de-emphasised */}
      <div className="px-5 py-2.5 border-t border-border bg-slate-50/60 flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted-foreground">Profit YTD {pkr(row.profit_ytd)}</span>
        <span className={`text-[11px] tabular-nums ${ytdDelta >= 0 ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"}`}>
          {ytdDelta >= 0 ? "▲" : "▼"} {pkr(Math.abs(ytdDelta))} vs last yr
        </span>
      </div>
    </div>
  );
}

/** A compact stat chip for the summary hero — icon + label over a value. */
function MiniStat({ icon, label, value, small }: { icon: ReactNode; label: string; value: string; small?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card/70 px-3 py-2.5 min-w-0">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
        <span className="text-brand-500">{icon}</span>
        <span className="text-[10px] uppercase tracking-wide truncate">{label}</span>
      </div>
      <p className={`${small ? "text-sm mt-0.5" : "text-xl"} tabular-nums text-foreground truncate`} title={value}>{value}</p>
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
  tree, period, loading, hoByRegion, showHoBreakdown,
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
  hoByRegion: {
    rows: { branchId: string; name: string; invoiced: number; ho: number; pct: number }[];
    companyInvoiced: number;
    totalHo: number;
  };
  showHoBreakdown: boolean;
}) {
  const [openCats, setOpenCats] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpenCats((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Categories rolled up across every shown region, for the "where it went"
  // breakdown — the same category in two regions is one bar, ranked by spend.
  const catAgg = useMemo(() => {
    const m = new Map<string, number>();
    for (const reg of tree.regions)
      for (const cat of reg.categoryList) m.set(cat.category, (m.get(cat.category) ?? 0) + cat.total);
    return Array.from(m, ([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
  }, [tree]);

  return (
    <div className="space-y-5 mb-8">
      {/* Summary — the headline number, quick counts, and where the money went */}
      <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="relative p-6 md:p-7 border-b border-border bg-gradient-to-br from-danger-50/70 via-card to-card dark:from-danger-700/10 dark:via-card dark:to-card">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-5">
            <div className="min-w-0 flex items-start gap-4">
              <div className="hidden sm:flex w-12 h-12 rounded-xl bg-danger-100 dark:bg-danger-700/20 items-center justify-center shrink-0">
                <Wallet className="w-6 h-6 text-danger-600 dark:text-danger-500" strokeWidth={1.75} />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                  Total operating expenses · {monthLabel(period)}
                </p>
                <p className="text-3xl md:text-4xl tabular-nums text-danger-700 dark:text-danger-500 font-semibold tracking-tight">
                  PKR <CountUp value={tree.grand} format={money} />
                </p>
                <p className="text-xs text-muted-foreground mt-2 max-w-xl leading-relaxed">
                  The cost of running the business — rent, utilities, office salaries, travel and the rest.
                  Cost of Services (a client's guards) is excluded; that belongs to the client.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 shrink-0">
              <MiniStat icon={<MapPin className="w-4 h-4" strokeWidth={2} />} label="Regions" value={String(tree.regions.length)} />
              <MiniStat icon={<Layers className="w-4 h-4" strokeWidth={2} />} label="Categories" value={String(catAgg.length)} />
              <MiniStat icon={<Receipt className="w-4 h-4" strokeWidth={2} />} label="Largest" value={catAgg[0]?.category ?? "—"} small />
            </div>
          </div>
        </div>
        {catAgg.length > 0 && (
          <div className="p-6 md:p-7">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-4">Where it went</p>
            <div className="space-y-3.5">
              {catAgg.slice(0, 6).map((c, i) => {
                const share = tree.grand > 0 ? (c.total / tree.grand) * 100 : 0;
                return (
                  <div key={c.category} className="group">
                    <div className="flex items-baseline justify-between gap-3 mb-1.5">
                      <span className="text-sm text-foreground truncate flex items-center gap-2">
                        <span className="text-[10px] tabular-nums text-muted-foreground w-4 shrink-0">{i + 1}</span>
                        {c.category}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                        <span className="text-foreground">{pkr(c.total)}</span> · {share.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden ml-6">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-700 transition-all duration-500"
                        style={{ width: `${Math.max(share, 1.5)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
              {catAgg.length > 6 && (
                <p className="text-[11px] text-muted-foreground pt-0.5 ml-6">
                  + {catAgg.length - 6} more categor{catAgg.length - 6 === 1 ? "y" : "ies"}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Head Office cost by region — moved here from the client statements; the
          same allocation is folded into each region's expenses above. */}
      {!loading && showHoBreakdown && hoByRegion.rows.length > 0 && (
        <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Building2 className="w-4 h-4 text-brand-600 dark:text-brand-500" strokeWidth={2} />
              Head Office cost by region
            </h3>
            <span className="text-xs text-muted-foreground">
              Allocation = (Region Invoiced ÷ Company Invoiced) × Head Office Total
            </span>
          </div>
          <div className="p-6 space-y-4">
            {hoByRegion.rows.map((r) => (
              <div key={r.branchId}>
                <div className="flex items-baseline justify-between gap-3 mb-1.5">
                  <span className="text-sm text-foreground flex items-center gap-2 min-w-0">
                    <MapPin className="w-3.5 h-3.5 text-brand-500 shrink-0" strokeWidth={2} />
                    <span className="truncate">{r.name}</span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                    Invoiced {pkr(r.invoiced)} · <span className="text-foreground">{r.pct.toFixed(1)}%</span> · HO{" "}
                    <span className="text-amber-700 dark:text-amber-500">{pkr(r.ho)}</span>
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-600" style={{ width: `${Math.max(r.pct, 1.5)}%` }} />
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 pt-3 border-t border-border text-sm">
              <span className="text-foreground font-medium">Company total</span>
              <span className="tabular-nums text-muted-foreground shrink-0">
                Invoiced {pkr(hoByRegion.companyInvoiced)} · 100% · HO{" "}
                <span className="text-foreground font-medium">{pkr(hoByRegion.totalHo)}</span>
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Each region's Head Office allocation is added to its expenses above and counted in the total.
            </p>
          </div>
        </div>
      )}

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
        <div key={reg.region} className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3 bg-muted/40">
            <h4 className="flex items-center gap-2.5 text-foreground font-semibold" style={{ fontFamily: "var(--font-display)" }}>
              <span className="w-8 h-8 rounded-lg bg-brand-50 dark:bg-brand-700/20 flex items-center justify-center shrink-0">
                <MapPin className="w-4 h-4 text-brand-600 dark:text-brand-500" strokeWidth={2} />
              </span>
              {reg.region}
              <span className="text-xs font-normal text-muted-foreground">
                {reg.categoryList.length} categor{reg.categoryList.length === 1 ? "y" : "ies"}
              </span>
            </h4>
            <div className="flex items-center gap-3 shrink-0">
              {tree.regions.length > 1 && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {tree.grand > 0 ? ((reg.total / tree.grand) * 100).toFixed(0) : 0}% of total
                </span>
              )}
              <span className="tabular-nums text-danger-700 dark:text-danger-500 font-medium">
                {pkr(reg.total)}
              </span>
            </div>
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
