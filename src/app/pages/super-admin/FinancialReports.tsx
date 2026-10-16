import { useState } from "react";
import Header from "../../components/Header";
import Tabs from "../../components/Tabs";
import ThemedSelect from "../../components/ThemedSelect";
import { PageBody } from "./_assetsKit";
import { usePageState } from "../../lib/pageState";
import { DrillProvider, monthLabel, previousMonthKey, recentMonths, type DrillTarget } from "./reports/kit";
import DetailDrawer from "./reports/DetailDrawer";
import EntitySearch from "./reports/EntitySearch";
import OverviewTab from "./reports/OverviewTab";
import ClientProfitTab from "./reports/ClientProfitTab";
import StatementsTab from "./reports/StatementsTab";
import LedgersTab from "./reports/LedgersTab";
import ScenariosTab from "./reports/ScenariosTab";

/**
 * FINANCIAL REPORTS — the accountant's working surface.
 *
 *   Overview      what the audit found by hand, as checks; every red control;
 *                 head office unallocated; cover; the accrual-to-cash bridge
 *   Client profit per client, either basis, head office visible and switchable
 *   Statements    P&L from the GL, the bridge, regional, cash flow, cover
 *   Ledgers       general, client, supplier, partner, guard
 *   Scenarios     levers against actuals, computed and discarded
 *
 * One search bar reaches every entity; one detail drawer opens any figure to
 * its composition, its journal lines and its source. The ledger answers and
 * the screen reads: nothing here recomputes what a database function holds.
 *
 * Replaces the previous page, which assembled its P&L in the browser from raw
 * invoices, payslips and expenses and used its own tab and table styles. The
 * Partnership Report it also hosted is a separate page (PartnershipReport.tsx).
 */

type Tab = "overview" | "clients" | "statements" | "ledgers" | "scenarios";

export default function FinancialReports() {
  const [tab, setTab] = usePageState<Tab>("Reports.tab", "overview");
  const [period, setPeriod] = usePageState<string>("Reports.period", previousMonthKey());
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const months = recentMonths(15);

  return (
    <DrillProvider open={setDrill}>
      <Header
        title="Financial Reports"
        subtitle="Read from the ledger: every figure opens to its journal lines and source"
        actions={
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Month</span>
            <ThemedSelect value={period} onChange={(e) => setPeriod(e.target.value)} className="w-44">
              {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </ThemedSelect>
          </div>
        }
      />
      <PageBody>
        <EntitySearch period={period} />
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: "overview", label: "Overview" },
            { value: "clients", label: "Client profit" },
            { value: "statements", label: "Statements" },
            { value: "ledgers", label: "Ledgers" },
            { value: "scenarios", label: "Scenarios" },
          ]}
        />
        {tab === "overview" && <OverviewTab period={period} onOpenTab={(t) => setTab(t)} />}
        {tab === "clients" && <ClientProfitTab period={period} />}
        {tab === "statements" && <StatementsTab period={period} />}
        {tab === "ledgers" && <LedgersTab period={period} />}
        {tab === "scenarios" && <ScenariosTab period={period} />}
      </PageBody>
      <DetailDrawer target={drill} onClose={() => setDrill(null)} />
    </DrillProvider>
  );
}
