import { useEffect, useState } from "react";
import { Link } from "react-router";
import Header from "../../components/Header";
import Tabs from "../../components/Tabs";
import ThemedSelect from "../../components/ThemedSelect";
import { PageBody } from "./_assetsKit";
import { supabase } from "../../lib/supabase";
import { usePageState } from "../../lib/pageState";
import { DrillProvider, monthLabel, monthStart, previousMonthKey, recentMonths, useCompanyId, type DrillTarget } from "./reports/kit";
import DetailDrawer from "./reports/DetailDrawer";
import EntitySearch from "./reports/EntitySearch";
import OverviewTab from "./reports/OverviewTab";
import LedgersTab from "./reports/LedgersTab";
import ScenariosTab from "./reports/ScenariosTab";
import ContractedVsDeployed from "./ContractedVsDeployed";
import AccountsGrid from "./accountant/AccountsGrid";
import Planning from "./accountant/Planning";
import StatementTieout from "./accountant/StatementTieout";

/**
 * ACCOUNTANT (2026-10-20) — the working surface for the people given
 * `accountant.view` in Access & Governance. Financial Reports says what the
 * business made; this is where the accountant proves it:
 *
 *   Accounts     the income & withdrawal state, every bank and cash holder,
 *                from the ledger
 *   Planning     expected receipts and payments against the ledger (0528)
 *   Checks       every red control and the audit findings, with the rows
 *                behind them, and the accrual-to-cash bridge
 *   Tie-out      the month's statements against their sources, every rupee
 *                placed, and what has nowhere to land (0539)
 *   Ledgers      general, client, supplier, partner and guard ledgers
 *   Scenarios    levers against actuals, computed and never posted
 *   Cover        contracted against deployed heads per client
 *
 * One search reaches any entity and one drawer opens any figure, as before.
 */

type Section = "accounts" | "planning" | "checks" | "tieout" | "ledgers" | "scenarios" | "cover";

export default function Accountant() {
  const companyId = useCompanyId();
  const [section, setSection] = usePageState<Section>("Accountant.section", "accounts");
  const [period, setPeriod] = usePageState<string>("Accountant.period", previousMonthKey());
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [red, setRed] = useState<number | null>(null);
  const [closed, setClosed] = useState<boolean | null>(null);
  const months = recentMonths(15);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void Promise.all([
      supabase.rpc("ledger_checks", { p_company_id: companyId }),
      supabase.from("accounting_periods").select("period_month").eq("period_month", monthStart(period)).maybeSingle(),
    ]).then(([lc, ap]) => {
      if (cancelled) return;
      const rows = (lc.data ?? []) as { check_name: string; passed: boolean }[];
      setRed(lc.error ? null : rows.filter((r) => !r.passed && r.check_name !== "checks_evaluated").length);
      setClosed(ap.data != null);
    });
    return () => { cancelled = true; };
  }, [companyId, period]);

  return (
    <DrillProvider open={setDrill}>
      <Header
        title="Accountant"
        subtitle="Every account from the ledger, the checks that prove it, and the tools to work it"
        actions={
          <ThemedSelect value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Month" className="w-44 min-h-10 rounded-xl">
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </ThemedSelect>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
            <button type="button" onClick={() => setSection("checks")} className="text-left rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1 hover:border-brand-500/70">
              <span className="lbl">Controls red</span>
              <span className={`font-ledger text-2xl font-semibold leading-none ${red ? "text-down" : "text-up"}`}>{red == null ? "…" : red}</span>
              <span className="text-xs text-muted-foreground">{red == null ? "running the nightly controls…" : red ? "open Checks for the rows behind each" : "every control is green"}</span>
            </button>
            <Link to="/app/period-close" className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1 hover:border-brand-500/70">
              <span className="lbl">{monthLabel(period)}</span>
              <span className={`font-display text-2xl font-bold leading-none ${closed ? "text-up" : "text-heed"}`}>{closed == null ? "…" : closed ? "Closed" : "Open"}</span>
              <span className="text-xs text-muted-foreground">{closed ? "locked — reopen from Period Close" : "close it from Period Close once the checks are clear"}</span>
            </Link>
            <div className="rounded-[14px] border border-border bg-card px-3 py-2 flex flex-col justify-center gap-1 min-w-0">
              <span className="lbl px-1">Find anything</span>
              <EntitySearch period={period} />
            </div>
          </div>
          <Tabs<Section>
            value={section}
            onChange={setSection}
            items={[
              { value: "accounts", label: "Accounts" },
              { value: "planning", label: "Planning" },
              { value: "checks", label: "Checks", count: red ?? undefined },
              { value: "tieout", label: "Tie-out" },
              { value: "ledgers", label: "Ledgers" },
              { value: "scenarios", label: "Scenarios" },
              { value: "cover", label: "Contracted vs deployed" },
            ]}
          />
        </div>
      </Header>
      <PageBody>
        {section === "accounts" && <AccountsGrid period={period} />}
        {section === "planning" && <Planning period={period} />}
        {section === "checks" && (
          <OverviewTab period={period} onOpenTab={() => setSection("cover")} />
        )}
        {section === "tieout" && <StatementTieout period={period} />}
        {section === "ledgers" && <LedgersTab period={period} />}
        {section === "scenarios" && <ScenariosTab period={period} />}
        {section === "cover" && <ContractedVsDeployed />}
      </PageBody>
      <DetailDrawer target={drill} onClose={() => setDrill(null)} />
    </DrillProvider>
  );
}
