import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { supabase } from "../../lib/supabase";
import Header from "../../components/Header";
import Tabs from "../../components/Tabs";
import ThemedSelect from "../../components/ThemedSelect";
import { PageBody } from "./_assetsKit";
import { usePageState } from "../../lib/pageState";
import { useRegion } from "../../lib/region";
import { DrillProvider, monthLabel, previousMonthKey, recentMonths, useCompanyId, type DrillTarget } from "./reports/kit";
import DetailDrawer from "./reports/DetailDrawer";
import PLTab, { cmpTitle } from "./reports/PLTab";
import ClientProfitTab from "./reports/ClientProfitTab";
import HeadOfficeTab from "./reports/HeadOfficeTab";
import { usePL, type Basis, type Compare } from "./reports/usePL";

/**
 * FINANCIAL REPORTS (rebuilt 2026-10-20) — what the business made, on either
 * basis, against a comparison:
 *
 *   Profit & loss   revenue basis (the GL) or cash basis (the client statement),
 *                   against the previous month, the same month last year, or
 *                   year to date against last year's
 *   Client profit   per client, same rules as before (regional overhead, head
 *                   office), following the band's basis
 *   Head office     the month's pool and each region's Yes/No, with the price
 *
 * 2026-10-28 (Shayan): the Cash flow tab is gone — "cash basis/revenue basis
 * already exists". The standalone Cash Flow page is untouched.
 *
 * The working tools that used to live here — the checks, the accrual-to-cash
 * bridge, the ledgers, scenarios, contracted vs deployed — move to the
 * Accountant page, where the people who use them are.
 */

type View = "pl" | "clients" | "ho";

export default function FinancialReports() {
  const companyId = useCompanyId();
  const { regionId } = useRegion();
  const [savedView, setView] = usePageState<View>("Reports.view", "pl");
  // A browser that last left this page on the removed Cash flow tab opens on P&L.
  const view: View = savedView === "clients" || savedView === "ho" ? savedView : "pl";
  const [period, setPeriod] = usePageState<string>("Reports.period", previousMonthKey());
  const [basis, setBasis] = usePageState<Basis>("Reports.basis", "revenue");
  const [cmp, setCmp] = usePageState<Compare>("Reports.compare", "prev");
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const months = recentMonths(15);
  const pl = usePL(companyId, period, basis, cmp, regionId);
  const t = cmpTitle(period, cmp);

  // 3 Nov 2026: a month whose payroll isn't in yet reads as a record month
  // (October showed 10.8M net, "+1318%", with guard payroll at 6,907). Count
  // the month's payslips against the month before and say so when it's short.
  const [payroll, setPayroll] = useState<{ cur: number; prev: number } | null>(null);
  useEffect(() => {
    if (!companyId) return;
    const [y, m] = period.split("-").map(Number);
    const prevKey = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}`;
    const count = (k: string) => supabase.from("payslips").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("period_month", `${k}-01`);
    void Promise.all([count(period), count(prevKey)]).then(([a, b]) => {
      if (a.error || b.error) { setPayroll(null); return; }
      setPayroll({ cur: a.count ?? 0, prev: b.count ?? 0 });
    });
  }, [companyId, period]);
  const payrollShort = basis === "revenue" && payroll != null && payroll.prev > 0 && payroll.cur < payroll.prev * 0.5;

  const delta = (a: number, b: number) => (b ? `${a >= b ? "+" : "−"}${Math.abs(((a - b) / Math.abs(b)) * 100).toFixed(1)}% on ${t.cmp}` : `${t.cmp}: nothing`);
  const kpis = pl.cur && pl.cmp ? [
    { label: basis === "cash" ? "Received" : "Revenue", v: pl.cur.revenue, sub: delta(pl.cur.revenue, pl.cmp.revenue), good: pl.cur.revenue >= pl.cmp.revenue },
    { label: "Gross profit", v: pl.cur.gross, sub: `${pl.cur.revenue ? ((pl.cur.gross / pl.cur.revenue) * 100).toFixed(1) : "0"}% of ${basis === "cash" ? "receipts" : "revenue"}`, good: null },
    { label: basis === "cash" ? "After overheads" : "Operating profit", v: pl.cur.operating, sub: `${pl.cur.revenue ? ((pl.cur.operating / pl.cur.revenue) * 100).toFixed(1) : "0"}% margin`, good: null },
    { label: basis === "cash" ? "Cash profit" : "Net profit", v: pl.cur.net, sub: delta(pl.cur.net, pl.cmp.net), good: pl.cur.net >= pl.cmp.net },
  ] : null;

  return (
    <DrillProvider open={setDrill}>
      <Header
        title="Financial Reports"
        subtitle={basis === "cash" ? "Cash basis — money received, payroll disbursed and expenses paid in the period" : "Revenue basis — income in the month the service was given, payroll as accrued, expenses as recognised"}
        actions={
          <ThemedSelect value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Month" className="w-44 min-h-10 rounded-xl">
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </ThemedSelect>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
            <Tabs<View>
              value={view}
              onChange={setView}
              items={[
                { value: "pl", label: "Profit & loss" },
                { value: "clients", label: "Client profit" },
                { value: "ho", label: "Head office" },
              ]}
            />
            <Tabs<Basis> value={basis} onChange={setBasis} items={[{ value: "revenue", label: "Revenue basis" }, { value: "cash", label: "Cash basis" }]} />
            {view === "pl" && (
              <Tabs<Compare> value={cmp} onChange={setCmp} items={[{ value: "prev", label: "vs previous month" }, { value: "ly", label: "vs last year" }, { value: "ytd", label: "Year to date" }]} />
            )}
          </div>
          {view !== "ho" && payrollShort && payroll && (
            <div className="flex items-start gap-2 rounded-xl border border-warning-200 bg-warning-50 dark:bg-warning-500/10 px-3 py-2 text-sm text-warning-700 dark:text-warning-500">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                {monthLabel(period)} isn't complete: its payroll isn't in yet ({payroll.cur} payslip{payroll.cur === 1 ? "" : "s"}, against {payroll.prev} the month before).
                Profit below leaves out most guard salaries until the payroll run is posted — don't read it as the month's result.
              </span>
            </div>
          )}
          {view === "pl" && kpis && (
            <div className={`grid grid-cols-2 lg:grid-cols-4 gap-2.5 ${payrollShort ? "opacity-60" : ""}`}>
              {kpis.map((k) => (
                <div key={k.label} className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1 min-w-0">
                  <span className="lbl truncate">{k.label}</span>
                  <span className={`font-ledger text-2xl font-semibold tracking-tight leading-none whitespace-nowrap ${k.v < 0 ? "text-down" : ""}`}><span className="cur">PKR</span>{Math.round(k.v).toLocaleString()}</span>
                  <span className={`text-xs truncate ${k.good == null ? "text-muted-foreground" : k.good ? "text-up" : "text-down"}`}>{k.sub}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Header>
      <PageBody>
        {view === "pl" && <PLTab period={period} basis={basis} cmp={cmp} pl={pl} loading={pl.loading} error={pl.error} />}
        {view === "clients" && <ClientProfitTab period={period} basis={basis} />}
        {view === "ho" && <HeadOfficeTab period={period} basis={basis} />}
      </PageBody>
      <DetailDrawer target={drill} onClose={() => setDrill(null)} />
    </DrillProvider>
  );
}
