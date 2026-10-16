import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileText, Loader2 } from "lucide-react";
import Tabs from "../../../components/Tabs";
import ExportButton from "../../../components/ExportButton";
import { Panel } from "../_assetsKit";
import { supabase } from "../../../lib/supabase";
import { exportTable } from "../../../lib/excel";
import { useAuth, hasPermission } from "../../../lib/auth";
import { useRegion } from "../../../lib/region";
import { usePageState } from "../../../lib/pageState";
import RegionalPerformance from "../RegionalPerformance";
import ContractedVsDeployed from "../ContractedVsDeployed";
import Cashflow from "../CashFlow";
import { BridgePanel } from "./OverviewTab";
import { Amount, monthEnd, monthLabel, monthStart, useCompanyId, useDrill } from "./kit";

/**
 * The statements. The Profit & Loss is READ from the GL (trial_balance_for,
 * 0320) account by account — it replaces a P&L the old page assembled in the
 * browser from raw invoices, payslips and expenses, which is the defect this
 * system exists to remove. Every line opens to its journal lines.
 *
 * Regional performance, cash flow and contracted-vs-deployed are the existing
 * reports, kept whole: their content was right and nothing in them is lost.
 */

type TB = { account_id: string; account_code: string; account_name: string; account_type: string; net_debit: number };

/** P&L sections by account code range: the chart's own grouping. */
const SECTIONS: { key: string; title: string; match: (a: TB) => boolean; sign: 1 | -1 }[] = [
  { key: "rev", title: "Revenue", match: (a) => a.account_type === "revenue", sign: -1 },
  { key: "cos", title: "Cost of services", match: (a) => a.account_type === "expense" && a.account_code.startsWith("5"), sign: 1 },
  { key: "opex", title: "Operating expenses", match: (a) => a.account_type === "expense" && a.account_code.startsWith("6"), sign: 1 },
  { key: "tax", title: "Income tax", match: (a) => a.account_type === "expense" && a.account_code.startsWith("7"), sign: 1 },
];

function ProfitAndLoss({ period }: { period: string }) {
  const companyId = useCompanyId();
  const { regionId } = useRegion();
  const drill = useDrill();
  const [tb, setTb] = useState<TB[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = monthStart(period), end = monthEnd(period);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void (async () => {
      setTb(null);
      const { data, error: e } = await supabase.rpc("trial_balance_for", { p_company_id: companyId, p_period: start, p_branch_id: regionId ?? null });
      if (cancelled) return;
      if (e) { setError(e.message); return; }
      setTb(((data ?? []) as TB[]).filter((a) => a.account_type === "revenue" || a.account_type === "expense"));
    })();
    return () => { cancelled = true; };
  }, [companyId, start, regionId]);

  const sections = useMemo(() => SECTIONS.map((s) => {
    const lines = (tb ?? []).filter(s.match).filter((a) => Math.abs(Number(a.net_debit)) > 0.005)
      .map((a) => ({ ...a, value: s.sign * Number(a.net_debit) }));
    // Section total: the sum of the lines displayed in it.
    return { ...s, lines, total: lines.reduce((x, l) => x + l.value, 0) };
  }), [tb]);
  const tot = (k: string) => sections.find((s) => s.key === k)?.total ?? 0;
  const gross = tot("rev") - tot("cos");
  const operating = gross - tot("opex");
  const net = operating - tot("tax");

  const doExport = () => exportTable({
    fileName: `Profit and loss ${monthLabel(period)}.xlsx`, sheetName: "P&L",
    title: `Profit and loss — ${monthLabel(period)} (from the general ledger)`,
    headers: ["Section", "Account", "Amount"],
    rows: [
      ...sections.flatMap((s) => [...s.lines.map((l) => [s.title, `${l.account_code} ${l.account_name}`, l.value]), [s.title, "Total", s.total]]),
      ["", "Gross profit", gross], ["", "Operating profit", operating], ["", "Net profit", net],
    ],
  });

  const lineRow = (l: TB & { value: number }) => (
    <tr key={l.account_id} className="border-t border-border/60 hover:bg-muted/20">
      <td className="pl-8 pr-3 py-1.5"><span className="font-mono text-xs text-muted-foreground mr-2">{l.account_code}</span>{l.account_name}</td>
      <td className="px-4 md:px-5 py-1.5 text-right">
        <Amount v={l.value} onClick={() => drill({ type: "gl", title: `${l.account_code} ${l.account_name} — ${monthLabel(period)}`, start, end,
          accountCodes: [l.account_code], branchId: regionId ?? undefined,
          note: "Every journal line on this account in the month — the figure is their net." })} />
      </td>
    </tr>
  );
  const totalRow = (label: string, v: number, big?: boolean) => (
    <tr className={`border-t ${big ? "border-t-2" : ""} border-border font-semibold`}>
      <td className="px-4 md:px-5 py-2">{label}</td>
      <td className="px-4 md:px-5 py-2 text-right"><Amount v={v} strong /></td>
    </tr>
  );

  return (
    <Panel icon={FileText} title={`Profit and loss — ${monthLabel(period)}`}
      description="From the general ledger, account by account. Open any line for the journal lines behind it."
      actions={<ExportButton onExport={doExport} />} flush>
      {error ? <div className="px-5 py-6 text-sm text-danger-600">{error}</div>
        : !tb ? <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        : (
          <table className="w-full text-sm">
            <tbody>
              {sections.map((s, i) => (
                <FragmentRows key={s.key}>
                  <tr className="bg-muted/30"><td colSpan={2} className="px-4 md:px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{s.title}</td></tr>
                  {s.lines.length === 0 ? <tr><td colSpan={2} className="pl-8 py-1.5 text-xs text-muted-foreground">Nothing posted.</td></tr> : s.lines.map(lineRow)}
                  {totalRow(`Total ${s.title.toLowerCase()}`, s.total)}
                  {i === 1 && totalRow("Gross profit", gross, true)}
                  {i === 2 && totalRow("Operating profit", operating, true)}
                </FragmentRows>
              ))}
              {totalRow("Net profit", net, true)}
            </tbody>
          </table>
        )}
    </Panel>
  );
}

function FragmentRows({ children }: { children: ReactNode }) { return <>{children}</>; }

export default function StatementsTab({ period }: { period: string }) {
  const { profile } = useAuth();
  const canCash = hasPermission(profile, "cashflow.view");
  const [tab, setTab] = usePageState<"pl" | "bridge" | "regional" | "cash" | "cover">("Reports.statementsTab", "pl");
  const items: { value: "pl" | "bridge" | "regional" | "cash" | "cover"; label: string }[] = [
    { value: "pl", label: "Profit & loss" },
    { value: "bridge", label: "Accrual to cash" },
    { value: "regional", label: "Regional performance" },
    ...(canCash ? [{ value: "cash" as const, label: "Cash flow" }] : []),
    { value: "cover", label: "Contracted vs deployed" },
  ];
  return (
    <div className="space-y-4">
      <Tabs value={tab} onChange={setTab} items={items} size="sm" />
      {tab === "pl" && <ProfitAndLoss period={period} />}
      {tab === "bridge" && <BridgePanel period={period} />}
      {tab === "regional" && <RegionalPerformance />}
      {tab === "cash" && canCash && <Cashflow embedded />}
      {tab === "cover" && <ContractedVsDeployed />}
    </div>
  );
}
