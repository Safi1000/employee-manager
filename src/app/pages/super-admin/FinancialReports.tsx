import { useState } from "react";
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
import Cashflow from "./CashFlow";
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
 *   Cash flow       the existing cash flow statement
 *
 * The working tools that used to live here — the checks, the accrual-to-cash
 * bridge, the ledgers, scenarios, contracted vs deployed — move to the
 * Accountant page, where the people who use them are.
 */

type View = "pl" | "clients" | "ho" | "cash";

export default function FinancialReports() {
  const companyId = useCompanyId();
  const { regionId } = useRegion();
  const [view, setView] = usePageState<View>("Reports.view", "pl");
  const [period, setPeriod] = usePageState<string>("Reports.period", previousMonthKey());
  const [basis, setBasis] = usePageState<Basis>("Reports.basis", "revenue");
  const [cmp, setCmp] = usePageState<Compare>("Reports.compare", "prev");
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const months = recentMonths(15);
  const pl = usePL(companyId, period, basis, cmp, regionId);
  const t = cmpTitle(period, cmp);

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
                { value: "cash", label: "Cash flow" },
              ]}
            />
            {view !== "cash" && (
              <Tabs<Basis> value={basis} onChange={setBasis} items={[{ value: "revenue", label: "Revenue basis" }, { value: "cash", label: "Cash basis" }]} />
            )}
            {view === "pl" && (
              <Tabs<Compare> value={cmp} onChange={setCmp} items={[{ value: "prev", label: "vs previous month" }, { value: "ly", label: "vs last year" }, { value: "ytd", label: "Year to date" }]} />
            )}
          </div>
          {view === "pl" && kpis && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
              {kpis.map((k) => (
                <div key={k.label} className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1 min-w-0">
                  <span className="lbl truncate">{k.label}</span>
                  <span className={`font-ledger text-2xl font-semibold tracking-tight leading-none whitespace-nowrap ${k.v < 0 ? "text-[#f0a99a]" : ""}`}><span className="cur">PKR</span>{Math.round(k.v).toLocaleString()}</span>
                  <span className={`text-xs truncate ${k.good == null ? "text-muted-foreground" : k.good ? "text-[#9ad1a3]" : "text-[#f0a99a]"}`}>{k.sub}</span>
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
        {view === "cash" && <Cashflow embedded />}
      </PageBody>
      <DetailDrawer target={drill} onClose={() => setDrill(null)} />
    </DrillProvider>
  );
}
