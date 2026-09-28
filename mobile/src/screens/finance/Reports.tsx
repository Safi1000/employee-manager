// Financial Reports (web FinancialReports): Revenue basis — P&L, Regional
// Performance, Client Statements, Contracted vs Deployed — and Cash basis (the
// Cash Flow page). Plus the standalone Partnership Report.
import { BookOpen, ChevronDown, ChevronRight, Download, Plus, Settings2, Trash2 } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Pressable, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Banner, Button, Card, Chips, Empty, HStack, IconBtn, Input, Ledger, ListCard, Row, Section, Segmented, Tabs, tap } from "../../components/ui";
import { useDB } from "../../data/store";
import { todayIso } from "../../data/api/core";
import {
  allocatedHoFor, cashStatement, CashData, clearClientShare, deletePartner, deletePartnerEntry, loadCashClientStatements, loadCashflow, loadClientStatements, loadCover,
  loadEntryOptions, loadPartnershipReport, loadPl, loadRegionalPerformance, monthKeys, monthName, partnerClientBreakdown, partnerLedger, plFigures, postingDeadline,
  previousMonthKey, recordPartnerEntry, savePolicy, setClientShare, submitPartnerForm,
} from "../../data/api/finance";
import { exportClientStatements, exportProfitLoss, exportTable } from "../../lib/web/excel";
import { useAuth } from "../../lib/auth";
import { useRegion } from "../../lib/region";
import { useTheme } from "../../theme/ThemeProvider";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cur = (n: number) => `PKR ${Math.round(n).toLocaleString("en-PK")}`;
const money2 = (n: unknown) => Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const acct = (n: unknown) => (Number(n ?? 0) < 0 ? `(${money2(Math.abs(Number(n ?? 0)))})` : money2(n));
const periodOpts = (n = 12) => monthKeys(n).map((p) => ({ value: p, label: monthName(p) }));

export default function Reports() {
  const { can } = useAuth();
  const canCash = can("cashflow.view");
  const [basis, setBasis] = useState<"financial" | "cashflow">("financial");
  const [tab, setTab] = useState<"pl" | "regional" | "clients" | "cover">("pl");
  return (
    <Screen region eyebrow="Finance" title="Financial Reports" subtitle="P&L, client statements and cash flow"
      sticky={<View style={{ gap: 8 }}>
        {canCash && <Segmented value={basis} onChange={setBasis} items={[{ key: "financial", label: "Revenue basis" }, { key: "cashflow", label: "Cash basis" }]} />}
        {basis === "financial" && <Tabs value={tab} onChange={setTab} items={[{ key: "pl", label: "Profit & Loss" }, { key: "regional", label: "Regional performance" }, { key: "clients", label: "Client statements" }, { key: "cover", label: "Contracted vs deployed" }]} />}
      </View>}>
      {basis === "cashflow" ? <CashflowBody /> : tab === "pl" ? <PL /> : tab === "regional" ? <Regional /> : tab === "clients" ? <ClientStatements /> : <Cover />}
    </Screen>
  );
}

// ────────────────────────────────────────────────────────────────────── P&L
function PL() {
  const t = useTheme();
  const { db } = useDB();
  const { regionId } = useRegion();
  const { toast } = useOverlay();
  const [period, setPeriod] = useState(previousMonthKey());
  const [data, setData] = useState<Awaited<ReturnType<typeof loadPl>> | null>(null);
  const [ho, setHo] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const branchFilter = regionId ?? "all";
  const headOfficeId = db.branches.find((b) => b.kind === "head_office")?.id ?? null;
  useEffect(() => { let c = false; loadPl(period).then((d) => { if (!c) { setData(d); setError(null); } }).catch((e) => { if (!c) setError(err(e)); }); return () => { c = true; }; }, [period]);
  useEffect(() => {
    let c = false;
    if (branchFilter === "all" || branchFilter === headOfficeId || !db.company.id) { const h = setTimeout(() => setHo(0), 0); return () => clearTimeout(h); }
    allocatedHoFor(db.company.id, period, branchFilter).then((v) => { if (!c) setHo(v); }).catch(() => { if (!c) setHo(0); });
    return () => { c = true; };
  }, [branchFilter, headOfficeId, period, db.company.id]);
  const f = useMemo(() => (data ? plFigures(data, branchFilter, headOfficeId, ho) : null), [data, branchFilter, headOfficeId, ho]);
  const line = (label: string, v: number, tone?: "success" | "danger") => <Ledger label={label} value={cur(v)} tone={tone} />;
  return (
    <>
      <HStack>
        <View style={{ flex: 1 }}><Select compact label="Month" value={period} onChange={setPeriod} options={periodOpts()} /></View>
        <IconBtn icon={Download} label="Export P&L" onPress={() => f && exportProfitLoss(f as never, monthName(period), `P&L ${monthName(period)}.xlsx`).catch((e) => toast(err(e), "danger"))} />
      </HStack>
      {error && <Banner tone="danger" title={error} />}
      {!f && !error && <ActivityIndicator style={{ marginTop: 16 }} />}
      {f && (
        <>
          <Section title="Revenue"><Card>{line("Security services", f.securityRevenue, "success")}{line("Guard deployment", f.guardRevenue, "success")}<Ledger label="Total revenue" value={cur(f.totalRevenue)} strong top tone="success" /></Card></Section>
          <Section title="Cost of services"><Card>
            {line("Guard payroll & salaries", f.guardPayroll)}{line("Guard statutory (EOBI / IESSI / PESSI)", f.cosStatutory)}{line("Transportation & fuel", f.cosTransport)}{line("Equipment & supplies", f.cosEquipment)}{line("Other cost of services", f.cosOther)}
            <Ledger label="Total cost of services" value={cur(f.totalCos)} strong top tone="danger" />
          </Card></Section>
          <Card style={{ marginTop: 10 }}><Ledger label={f.grossProfit < 0 ? "Gross loss" : "Gross profit"} value={cur(Math.abs(f.grossProfit))} strong tone={f.grossProfit >= 0 ? "success" : "danger"} /></Card>
          <Section title="Operating expenses"><Card>
            {line("Office salaries (non-billable staff)", f.officePayroll)}{line("Utilities & rent (HQ)", f.opUtilities)}{line("Insurance", f.opInsurance)}{line("Licences (company-level)", f.opLicenses)}{line("Other operating expenses", f.opOther)}
            {f.allocatedHo > 0 && line("Head office (allocated)", f.allocatedHo)}
            <Ledger label="Total operating expenses" value={cur(f.totalOpex)} strong top tone="danger" />
          </Card></Section>
          <Card style={{ marginTop: 10 }}>
            <Ledger label={f.operatingProfit < 0 ? "Operating loss" : "Operating profit"} value={cur(Math.abs(f.operatingProfit))} strong tone={f.operatingProfit >= 0 ? "success" : "danger"} />
            <Ledger label="Earnings before tax" value={cur(f.ebt)} />
            <Ledger label="Taxes" value={cur(f.taxes)} tone="danger" />
            <Ledger label="Net profit" value={cur(f.netProfit)} strong top tone={f.netProfit >= 0 ? "success" : "danger"} />
          </Card>
          <T v="small" color={t.mutedFg} style={{ marginTop: 6 }}>Revenue is recognised at the service month; payroll at final salary for the month.</T>
        </>
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────── Regional Performance
function Regional() {
  const t = useTheme();
  const { db } = useDB();
  const [basis, setBasis] = useState<"revenue" | "cash">("revenue");
  const [period, setPeriod] = useState(monthKeys(1)[0]);
  const [data, setData] = useState<Awaited<ReturnType<typeof loadRegionalPerformance>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => { let c = false; setData(null); loadRegionalPerformance(db.company.id, period, basis).then((d) => { if (!c) { setData(d); setError(null); } }).catch((e) => { if (!c) setError(err(e)); }); return () => { c = true; }; }, [db.company.id, period, basis]); // eslint-disable-line react-hooks/set-state-in-effect
  const totals = useMemo(() => {
    const rs = data?.regions ?? [];
    const revenue = rs.reduce((s, r) => s + r.revenue, 0), own = rs.reduce((s, r) => s + r.own_cost, 0), ho = rs.reduce((s, r) => s + r.ho_allocated, 0);
    return { revenue, own, ho, net: revenue - own - ho };
  }, [data]);
  return (
    <>
      <HStack>
        <View style={{ flex: 1 }}><Select compact label="Month" value={period} onChange={setPeriod} options={periodOpts()} /></View>
        <View style={{ flex: 1 }}><Chips value={basis} onChange={setBasis} items={[{ key: "revenue", label: "Revenue" }, { key: "cash", label: "Cash" }]} /></View>
      </HStack>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 16 }} />}
      {data && (
        <>
          <Card style={{ marginTop: 10 }}>
            <Ledger label="Revenue" value={cur(totals.revenue)} />
            <Ledger label="Own cost" value={cur(totals.own)} />
            <Ledger label="HO allocated" value={cur(totals.ho)} sub={`Pool ${cur(data.pool)} — apportioned by revenue`} />
            <Ledger label="Net" value={cur(totals.net)} strong top tone={totals.net >= 0 ? "success" : "danger"} />
          </Card>
          {data.regions.map((r) => {
            const isOpen = open.has(r.branch_id);
            const kids = data.clients.filter((c) => c.branch_id === r.branch_id);
            const cats = data.categories.get(r.branch_id);
            const net = r.revenue - r.own_cost - r.ho_allocated;
            return (
              <Card key={r.branch_id} pad={0} style={{ marginTop: 10 }}>
                <Pressable onPress={() => { tap(); setOpen((p) => { const n = new Set(p); if (n.has(r.branch_id)) n.delete(r.branch_id); else n.add(r.branch_id); return n; }); }} style={{ padding: 12 }}>
                  <HStack>
                    {isOpen ? <ChevronDown size={16} color={t.mutedFg} /> : <ChevronRight size={16} color={t.mutedFg} />}
                    <T v="bodyStrong" style={{ flex: 1 }}>{r.region_name}{r.excluded ? " · HO-excluded" : ""}</T>
                    <T v="mono" color={net < 0 ? t.tone("danger").text : t.fg}>{cur(net)}</T>
                  </HStack>
                  <T v="small" muted>Rev {cur(r.revenue)} · Own {cur(r.own_cost)} · HO {cur(r.ho_allocated)}</T>
                </Pressable>
                {isOpen && (
                  <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
                    {kids.map((c) => <Ledger key={c.client_id} label={c.client_name} sub={`rev ${cur(Number(c.revenue))} · own ${cur(Number(c.direct_payroll) + Number(c.direct_expenses) + Number(c.regional_overhead))} · HO ${cur(Number(c.ho_share))}`} value={cur(Number(c.net))} tone={Number(c.net) < 0 ? "danger" : undefined} />)}
                    {cats && <T v="eyebrow" muted style={{ marginTop: 8 }}>Expenses by category</T>}
                    {cats && [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([name, v]) => <Ledger key={name} label={name} value={cur(v)} />)}
                  </View>
                )}
              </Card>
            );
          })}
        </>
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────── Client statements
function ClientStatements() {
  const { regionId } = useRegion();
  const { toast } = useOverlay();
  const [period, setPeriod] = useState(previousMonthKey());
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<any | null>(null);
  useEffect(() => { let c = false; loadClientStatements(period).then((r) => { if (!c) { setRows(r); setError(null); } }).catch((e) => { if (!c) setError(err(e)); }); return () => { c = true; }; }, [period]);
  const shown = (rows ?? []).filter((r) => !regionId || r.branch_id === regionId);
  const tot = shown.reduce((a, r) => ({ inv: a.inv + r.total_invoiced, pay: a.pay + r.payroll_expense, exp: a.exp + r.expenses, reg: a.reg + r.regional_overhead, ho: a.ho + r.ho_share, net: a.net + r.total_income }), { inv: 0, pay: 0, exp: 0, reg: 0, ho: 0, net: 0 });
  return (
    <>
      <HStack>
        <View style={{ flex: 1 }}><Select compact label="Month" value={period} onChange={setPeriod} options={periodOpts()} /></View>
        <IconBtn icon={Download} label="Export" onPress={() => exportClientStatements(shown.map((r) => ({ client: `${r.name} (${r.client_code})`, totalReceivable: r.total_invoiced, payrollExpenses: r.payroll_expense, otherExpenses: r.expenses + r.regional_overhead + r.ho_share, netIncome: r.total_income })), monthName(period), `Client Statement ${monthName(period)}.xlsx`).catch((e) => toast(err(e), "danger"))} />
      </HStack>
      {error && <Banner tone="danger" title={error} />}
      {!rows && !error && <ActivityIndicator style={{ marginTop: 16 }} />}
      {rows && (
        <Card style={{ marginTop: 10 }}>
          <Ledger label="Invoiced" value={cur(tot.inv)} /><Ledger label="Payroll" value={cur(tot.pay)} /><Ledger label="Direct expenses" value={cur(tot.exp)} />
          <Ledger label="Regional overhead" value={cur(tot.reg)} /><Ledger label="HO share" value={cur(tot.ho)} /><Ledger label="Total income" value={cur(tot.net)} strong top tone={tot.net >= 0 ? "success" : "danger"} />
        </Card>
      )}
      <ListCard style={{ marginTop: 10 }}>
        {shown.map((r, i) => <Row key={r.id} last={i === shown.length - 1} onPress={() => setSel(r)} title={r.name} meta={`${r.client_code} · invoiced ${cur(r.total_invoiced)}`} right={<T v="mono">{cur(r.total_income)}</T>} />)}
      </ListCard>
      <Sheet full open={!!sel} onClose={() => setSel(null)} title={sel?.name ?? ""} subtitle={`Client statement · ${monthName(period)}`}>
        {sel && (
          <>
            <Card>
              <Ledger label="Total invoiced" value={cur(sel.total_invoiced)} />
              <Ledger label="Payroll expense" value={cur(sel.payroll_expense)} />
              <Ledger label="Direct expenses" value={cur(sel.expenses)} />
              <Ledger label="Regional overhead" value={cur(sel.regional_overhead)} />
              <Ledger label="Head office share" value={cur(sel.ho_share)} />
              <Ledger label="Total income" value={cur(sel.total_income)} strong top tone={sel.total_income >= 0 ? "success" : "danger"} />
            </Card>
            <Section title="Invoices" count={sel.invoices.length}>
              <ListCard>{sel.invoices.map((inv: any, i: number) => (
                <Row key={inv.id} last={i === sel.invoices.length - 1} title={inv.invoice_number} meta={`${inv.invoice_date} · ${inv.status}`} right={<T v="mono">{cur(Number(inv.invoice_amount))}</T>}
                  onPress={inv.drive_view_url ? () => Linking.openURL(inv.drive_view_url) : undefined} />
              ))}</ListCard>
            </Section>
          </>
        )}
      </Sheet>
    </>
  );
}

// ────────────────────────────────────────────────────── Contracted vs Deployed
function Cover() {
  const t = useTheme();
  const { toast } = useOverlay();
  const [month, setMonth] = useState(previousMonthKey());
  const [rows, setRows] = useState<Awaited<ReturnType<typeof loadCover>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let c = false; setRows(null); loadCover(month).then((r) => { if (!c) { setRows(r); setError(null); } }).catch((e) => { if (!c) setError(err(e)); }); return () => { c = true; }; }, [month]); // eslint-disable-line react-hooks/set-state-in-effect
  const totals = (rows ?? []).reduce((a, r) => ({ contracted: a.contracted + r.contracted, deployed: a.deployed + r.deployed, cost: a.cost + r.cost }), { contracted: 0, deployed: 0, cost: 0 });
  return (
    <>
      <T v="small" muted>What each client is committed to, who actually stood there, and the payroll it cost. A positive gap is cover carried above the contract — visible here, billed nowhere.</T>
      <HStack style={{ marginTop: 8 }}>
        <View style={{ flex: 1 }}><Select compact label="Month" value={month} onChange={setMonth} options={periodOpts()} /></View>
        <IconBtn icon={Download} label="Export" onPress={() => rows && exportTable({ fileName: `Contracted vs Deployed ${month}.xlsx`, sheetName: "Cover", headers: ["Client", "Contracted", "Deployed", "Gap", "Cost"], rows: rows.map((r) => [r.client_name, r.contracted, r.deployed, r.deployed - r.contracted, r.cost]) }).catch((e) => toast(err(e), "danger"))} />
      </HStack>
      {error && <Banner tone="danger" title={error} />}
      {!rows && !error && <ActivityIndicator style={{ marginTop: 16 }} />}
      {rows && rows.length === 0 && <Empty title="No contracted or deployed strength this month." />}
      <ListCard style={{ marginTop: 10 }}>
        {(rows ?? []).map((r, i) => {
          const gap = r.deployed - r.contracted;
          return <Row key={r.client_id} last={i === (rows?.length ?? 0) - 1} title={r.client_name} meta={`Contracted ${r.contracted} · Deployed ${r.deployed} · Cost ${cur(r.cost)}`}
            right={<T v="mono" color={gap > 0 ? t.tone("danger").text : t.mutedFg}>{gap > 0 ? `+${gap}` : gap}</T>} />;
        })}
      </ListCard>
      {rows && rows.length > 0 && <Card style={{ marginTop: 10 }}><Ledger label="Contracted" value={String(totals.contracted)} /><Ledger label="Deployed" value={String(totals.deployed)} /><Ledger label="Cost" value={cur(totals.cost)} strong /></Card>}
    </>
  );
}

// ────────────────────────────────────────────────────────────── Cash basis
export function CashflowBody() {
  const t = useTheme();
  const { regionId } = useRegion();
  const { toast } = useOverlay();
  const [tab, setTab] = useState<"cashflow" | "clients">("cashflow");
  const [data, setData] = useState<CashData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState(monthKeys(1)[0]);
  const [branch, setBranch] = useState("all");
  const [stmtPeriod, setStmtPeriod] = useState(monthKeys(1)[0]);
  const [stmts, setStmts] = useState<Awaited<ReturnType<typeof loadCashClientStatements>> | null>(null);
  const [sel, setSel] = useState<any | null>(null);
  useEffect(() => { let c = false; loadCashflow(regionId).then((d) => { if (!c) { setData(d); setError(null); } }).catch((e) => { if (!c) setError(err(e)); }); return () => { c = true; }; }, [regionId]);
  useEffect(() => { if (!data) return; let c = false; loadCashClientStatements(data, stmtPeriod).then((r) => { if (!c) setStmts(r); }).catch((e) => toast(err(e), "danger")); return () => { c = true; }; }, [data, stmtPeriod]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useMemo(() => (data ? cashStatement(data, month, branch) : null), [data, month, branch]);
  const rows = (stmts ?? []).filter((r) => branch === "all" || r.branchId === branch);
  const tot = rows.reduce((a, r) => ({ received: a.received + r.received, payroll: a.payroll + r.payrollPaid, expenses: a.expenses + r.expensesPaid, regional: a.regional + r.regionalOverhead, ho: a.ho + r.hoShare, net: a.net + r.netCash }), { received: 0, payroll: 0, expenses: 0, regional: 0, ho: 0, net: 0 });
  const branchOpts = [{ value: "all", label: "All branches" }, ...(data?.branches ?? []).map((b) => ({ value: b.id, label: b.name }))];
  return (
    <>
      <Chips value={tab} onChange={setTab} items={[{ key: "cashflow", label: "Cash flow" }, { key: "clients", label: "Client statements" }]} />
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 16 }} />}
      {data && tab === "cashflow" && s && (
        <>
          <HStack style={{ marginTop: 8 }}>
            <View style={{ flex: 1 }}><Select compact label="Branch" value={branch} onChange={setBranch} options={branchOpts} /></View>
            <View style={{ flex: 1 }}><Select compact label="Month" value={month} onChange={setMonth} options={periodOpts()} /></View>
          </HStack>
          <Section title="Cash received"><Card><Ledger label="Security services" value={cur(s.securityRevenue)} tone="success" /><Ledger label="Guard deployment" value={cur(s.guardRevenue)} tone="success" /><Ledger label="Total received" value={cur(s.totalRevenue)} strong top tone="success" /></Card></Section>
          <Section title="Cost of services paid"><Card>
            <Ledger label="Guard payroll & salaries" value={cur(s.guardPayroll)} /><Ledger label="Guard statutory (EOBI / IESSI / PESSI)" value={cur(s.cosStatutory)} /><Ledger label="Transportation & fuel" value={cur(s.cosTransport)} />
            <Ledger label="Equipment & supplies" value={cur(s.cosEquipment)} /><Ledger label="Other cost of services" value={cur(s.cosOther)} /><Ledger label="Total" value={cur(s.totalCos)} strong top tone="danger" />
          </Card></Section>
          <Card style={{ marginTop: 10 }}><Ledger label={s.grossProfit < 0 ? "Gross loss" : "Gross profit"} value={cur(Math.abs(s.grossProfit))} strong tone={s.grossProfit >= 0 ? "success" : "danger"} /></Card>
          <Section title="Operating expenses paid"><Card>
            <Ledger label="Office salaries (non-billable staff)" value={cur(s.officePayroll)} /><Ledger label="Utilities & rent (HQ)" value={cur(s.opUtilities)} /><Ledger label="Insurance" value={cur(s.opInsurance)} />
            <Ledger label="Licences (company-level)" value={cur(s.opLicenses)} /><Ledger label="Other operating expenses" value={cur(s.opOther)} /><Ledger label="Total" value={cur(s.totalOpex)} strong top tone="danger" />
          </Card></Section>
          <Card style={{ marginTop: 10 }}>
            <Ledger label={s.operatingProfit < 0 ? "Operating loss" : "Operating profit"} value={cur(Math.abs(s.operatingProfit))} strong tone={s.operatingProfit >= 0 ? "success" : "danger"} />
            <Ledger label="Earnings before tax" value={cur(s.ebt)} /><Ledger label="Taxes paid" value={cur(s.taxes)} tone="danger" />
            <Ledger label="Net profit (cash)" value={cur(s.netProfit)} strong top tone={s.netProfit >= 0 ? "success" : "danger"} />
            <Ledger label="Salary advances paid" value={`(${cur(s.advancesPaid)})`} tone="danger" />
            <Ledger label="Net change in cash" value={cur(s.netCashChange)} strong top tone={s.netCashChange >= 0 ? "success" : "danger"} />
          </Card>
        </>
      )}
      {data && tab === "clients" && (
        <>
          <HStack style={{ marginTop: 8 }}>
            <View style={{ flex: 1 }}><Select compact label="Branch" value={branch} onChange={setBranch} options={branchOpts} /></View>
            <View style={{ flex: 1 }}><Select compact label="Month" value={stmtPeriod} onChange={setStmtPeriod} options={periodOpts()} /></View>
            <IconBtn icon={Download} label="Export" onPress={() => exportClientStatements(rows.map((r) => ({ client: `${r.client.name} (${r.client.client_code})`, totalReceivable: r.received, payrollExpenses: r.payrollPaid, otherExpenses: r.expensesPaid + r.regionalOverhead + r.hoShare, netIncome: r.netCash })), monthName(stmtPeriod), `Client Statement (Cash) ${monthName(stmtPeriod)}.xlsx`).catch((e) => toast(err(e), "danger"))} />
          </HStack>
          {!stmts && <ActivityIndicator />}
          {stmts && (
            <Card style={{ marginTop: 8 }}>
              <Ledger label="Cash received" value={cur(tot.received)} /><Ledger label="Payroll paid" value={cur(tot.payroll)} /><Ledger label="Direct expenses" value={cur(tot.expenses)} />
              <Ledger label="Regional overhead" value={cur(tot.regional)} /><Ledger label="HO share" value={cur(tot.ho)} /><Ledger label="Net cash" value={cur(tot.net)} strong top tone={tot.net >= 0 ? "success" : "danger"} />
            </Card>
          )}
          <ListCard style={{ marginTop: 8 }}>
            {rows.map((r, i) => <Row key={r.client.id} last={i === rows.length - 1} onPress={() => setSel(r)} title={r.client.name} meta={`${r.regionName} · received ${cur(r.received)}`} right={<T v="mono" color={r.netCash < 0 ? t.tone("danger").text : t.fg}>{cur(r.netCash)}</T>} />)}
          </ListCard>
          <Sheet full open={!!sel} onClose={() => setSel(null)} title={sel?.client.name ?? ""} subtitle={`Full client statement (cash basis) · ${monthName(stmtPeriod)}`}>
            {sel && (
              <>
                <Card>
                  <Ledger label="Cash received" value={cur(sel.received)} /><Ledger label="Payroll paid" value={cur(sel.payrollPaid)} /><Ledger label="Direct expenses" value={cur(sel.expensesPaid)} />
                  <Ledger label="Regional overhead" value={cur(sel.regionalOverhead)} /><Ledger label="HO share" value={cur(sel.hoShare)} /><Ledger label="Net cash" value={cur(sel.netCash)} strong top />
                </Card>
                <Section title="Payments received" count={sel.payments.length}>
                  <ListCard>{sel.payments.map((p: any, i: number) => <Row key={p.id} last={i === sel.payments.length - 1} title={p.date} meta={p.mode ?? ""} right={<T v="mono">{cur(p.amount)}</T>} />)}</ListCard>
                </Section>
              </>
            )}
          </Sheet>
        </>
      )}
    </>
  );
}

export function Cashflow() {
  return <Screen region eyebrow="Finance" title="Cash Flow" subtitle="Cash inflow vs outflow"><CashflowBody /></Screen>;
}

// ─────────────────────────────────────────────────────── Partnership Report
export function PartnershipReport() {
  const t = useTheme();
  const { db } = useDB();
  const { can } = useAuth();
  const { toast, confirm } = useOverlay();
  const companyId = db.company.id;
  const canEdit = can("accounting.edit");
  const [period, setPeriod] = useState(previousMonthKey());
  const [data, setData] = useState<Awaited<ReturnType<typeof loadPartnershipReport>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<any | "new" | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const load = useCallback(async () => { try { setData(await loadPartnershipReport(companyId)); setError(null); } catch (e) { setError(err(e)); } }, [companyId]);
  useEffect(() => { const h = setTimeout(() => { void load(); }, 0); return () => clearTimeout(h); }, [load]);
  const partners = data?.partners ?? [];
  const branches = data?.branches ?? [];
  const equityShareTotal = partners.filter((p) => p.scope !== "BRANCH").reduce((s, p) => s + Number(p.profit_share_percent), 0);
  const basis = (data?.settings?.partner_remuneration_basis ?? null) as "cash" | "revenue" | null;
  const regionOf = (p: any) => branches.find((b) => b.id === p.branch_id)?.name ?? "no region";

  return (
    <Screen eyebrow="Finance" title="Partnership Report" subtitle="Regional and equity partner allocation, and each partner's running account"
      actions={<IconBtn icon={Download} label="Export" onPress={() => exportTable({
        fileName: `Partnership Report ${monthName(period)}.xlsx`, sheetName: "Partnership", title: `Partnership Report — ${monthName(period)}`, headers: ["Partner", "Kind", "Profit Share %"],
        rows: partners.map((p) => [p.name, p.scope === "BRANCH" ? `Regional · ${regionOf(p)}` : "Equity", Number(p.profit_share_percent)]),
      }).catch((e) => toast(err(e), "danger"))} />}>
      <Select compact label="Month" value={period} onChange={setPeriod} options={periodOpts()} />
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 16 }} />}
      {data && <PolicyPanel companyId={companyId} period={period} canEdit={canEdit} settings={data.settings} onSaved={load} />}
      {data && (
        <>
          <Button icon={Plus} label="Add partner" style={{ marginVertical: 10 }} onPress={() => setForm("new")} />
          {partners.length === 0 && <Empty title="No partners yet" sub="Add the first one above." />}
          {partners.map((p) => (
            <Card key={p.id} style={{ marginBottom: 8 }}>
              <HStack>
                <View style={{ flex: 1 }}>
                  <T v="bodyStrong">{p.name}{p.opening_balance_locked ? " 🔒" : ""}</T>
                  <T v="small" muted>{p.scope === "BRANCH" ? `Regional · ${regionOf(p)}` : "Equity"}</T>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <T v="mono" color={t.tone("brand").text}>{Number(p.profit_share_percent)}%</T>
                  {p.scope === "BRANCH" && basis && <T v="small" muted>of {basis === "cash" ? "Net Cash" : "Total Income"}</T>}
                </View>
              </HStack>
              <HStack style={{ marginTop: 8 }}>
                <Button size="sm" variant="secondary" icon={BookOpen} label="Ledger" onPress={() => setDetail(p)} />
                <Button size="sm" variant="ghost" icon={Settings2} label="Edit" onPress={() => setForm(p)} />
                <Button size="sm" variant="ghost" icon={Trash2} label="Delete" onPress={async () => {
                  if (!(await confirm({ title: `Delete ${p.name}?`, message: "Their ledger entries and any per-client share overrides go with them.", confirmLabel: "Delete", tone: "danger" }))) return;
                  try { await deletePartner(p.id); toast("Partner deleted", "warning"); await load(); } catch (e) { toast(err(e), "danger"); }
                }} />
              </HStack>
            </Card>
          ))}
          <Card style={{ marginTop: 6 }}>
            <Ledger label="Equity share allocated" value={`${equityShareTotal}%`} tone={equityShareTotal > 100 ? "danger" : undefined} />
            <Ledger label="Partners" value={String(partners.length)} />
            <T v="small" muted style={{ marginTop: 6 }}>Equity shares divide the company-wide residual; a regional partner&apos;s share divides their own region. The two are separate pools, so they are not summed together.</T>
          </Card>
        </>
      )}
      {form && <PartnerFormSheet partner={form === "new" ? null : form} branches={branches} equityShareTotal={equityShareTotal} period={period} onClose={() => setForm(null)} onSaved={async () => { setForm(null); toast("Partner saved"); await load(); }} />}
      {detail && <PartnerDetailSheet partner={detail} companyId={companyId} regionName={detail.scope === "BRANCH" ? regionOf(detail) : null} onClose={() => setDetail(null)} />}
    </Screen>
  );
}

function PolicyPanel({ companyId, period, canEdit, settings, onSaved }: { companyId: string; period: string; canEdit: boolean; settings: any; onSaved: () => void }) {
  const t = useTheme();
  const { toast, confirm } = useOverlay();
  const [basis, setBasis] = useState<"cash" | "revenue">((settings?.partner_remuneration_basis ?? "cash") as "cash" | "revenue");
  const [day, setDay] = useState(settings?.partnership_posting_day != null ? String(settings.partnership_posting_day) : "");
  const [deadline, setDeadline] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { postingDeadline(companyId, period).then(setDeadline).catch(() => setDeadline(null)); }, [companyId, period, settings]);
  const dayNum = day.trim() === "" ? null : Number(day);
  const basisChanged = basis !== (settings?.partner_remuneration_basis ?? "cash");
  const dirty = basisChanged || (dayNum ?? null) !== (settings?.partnership_posting_day ?? null);
  return (
    <Section title="Partnership policy" hint="Company-wide, not per partner. One decides what every partner is paid on; the other decides when the month has to be paid by.">
      <Card>
        <Select label="Remuneration basis" value={basis} onChange={(v) => canEdit && setBasis(v as "cash" | "revenue")} options={[{ value: "cash", label: "Net Cash (cash basis)" }, { value: "revenue", label: "Total Income (revenue basis)" }]} />
        <Input label="Posting day (1–28, blank = no deadline)" keyboardType="numeric" editable={canEdit} value={day} onChangeText={setDay} />
        {deadline && <T v="small" color={deadline.posted ? t.tone("success").text : deadline.days_late > 0 ? t.tone("danger").text : t.mutedFg}>{deadline.posted ? `Posted. It was due ${deadline.due_date}.` : deadline.days_late > 0 ? `${deadline.days_late} day(s) late — due ${deadline.due_date}.` : `Due ${deadline.due_date}.`}</T>}
        {canEdit && <Button style={{ marginTop: 8 }} label={busy ? "Saving…" : "Save policy"} disabled={busy || !dirty} onPress={async () => {
          if (dayNum !== null && (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 28)) { toast("Posting day must be a whole number from 1 to 28, or blank for no deadline.", "danger"); return; }
          if (basisChanged && !(await confirm({ title: `Change the remuneration basis to ${basis === "cash" ? "Net Cash (cash basis)" : "Total Income (revenue basis)"}?`, message: "This changes what EVERY partner is paid, in every month the report is re-run for. Shares already posted keep their amounts; anything not yet posted is allocated on the new basis.", confirmLabel: "Change basis" }))) return;
          setBusy(true);
          try { await savePolicy(companyId, basis, dayNum); toast("Policy saved."); onSaved(); } catch (e) { toast(err(e), "danger"); } finally { setBusy(false); }
        }} />}
      </Card>
    </Section>
  );
}

function PartnerFormSheet({ partner, branches, equityShareTotal, period, onClose, onSaved }: { partner: any | null; branches: any[]; equityShareTotal: number; period: string; onClose: () => void; onSaved: () => void }) {
  const { toast } = useOverlay();
  const [f, setF] = useState({
    name: partner?.name ?? "", scope: (partner?.scope ?? "COMPANY") as "COMPANY" | "BRANCH", branchId: partner?.branch_id ?? "",
    share: partner ? String(partner.profit_share_percent) : "", opening: partner ? String(partner.opening_balance ?? 0) : "",
    startMonth: partner?.start_month ? String(partner.start_month).slice(0, 7) : new Date().toISOString().slice(0, 7),
  });
  const [breakdown, setBreakdown] = useState<any[]>([]);
  const [edit, setEdit] = useState<{ clientId: string; pct: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState<string | null>(null);
  const isRegional = partner?.scope === "BRANCH";
  const loadBd = useCallback(async () => { if (isRegional) setBreakdown(await partnerClientBreakdown(partner.id, period)); }, [isRegional, partner, period]);
  useEffect(() => { const h = setTimeout(() => { loadBd().catch((x) => setE(err(x))); }, 0); return () => clearTimeout(h); }, [loadBd]);
  return (
    <Sheet full open onClose={onClose} title={partner ? `Edit ${partner.name}` : "Add partner"} error={e}
      footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button full label={busy ? "Saving…" : "Save"} disabled={busy} onPress={async () => {
        setBusy(true); setE(null);
        try { await submitPartnerForm(partner, f, equityShareTotal); onSaved(); } catch (x) { setE(err(x)); } finally { setBusy(false); }
      }} /></>}>
      <Input label={`Partner name${partner ? " (locked)" : ""}`} required editable={!partner} value={f.name} onChangeText={(s) => setF({ ...f, name: s })} />
      <Select label="Kind" value={f.scope} onChange={(v) => !partner && setF({ ...f, scope: v as "COMPANY" | "BRANCH" })} options={[{ value: "COMPANY", label: "Equity partner" }, { value: "BRANCH", label: "Regional partner" }]} />
      {f.scope === "BRANCH" && <Select label="Region" value={f.branchId} onChange={(v) => setF({ ...f, branchId: v })} options={branches.filter((b) => !b.is_head_office).map((b) => ({ value: b.id, label: b.name }))} />}
      <Input label="Profit share %" required keyboardType="numeric" value={f.share} onChangeText={(s) => setF({ ...f, share: s })} />
      {(!partner || !partner.opening_balance_locked) && <Input label="Opening balance" keyboardType="numeric" value={f.opening} onChangeText={(s) => setF({ ...f, opening: s })} />}
      {!partner && <Input label="Starts sharing profit from (YYYY-MM)" value={f.startMonth} onChangeText={(s) => setF({ ...f, startMonth: s })} />}
      {isRegional && (
        <Section title={`Client shares · ${monthName(period)}`} hint="Override one client's share for this month; the rest follow the partner's share.">
          {breakdown.map((r) => (
            <Card key={r.client_id} style={{ marginBottom: 6 }}>
              <HStack>
                <View style={{ flex: 1 }}>
                  <T v="bodyStrong">{r.client_name}</T>
                  <T v="small" muted>{r.client_code} · net {acct(r.client_net)} · {r.share_percent}%{r.is_override ? " (override)" : ""}</T>
                </View>
                <T v="mono">{acct(r.amount)}</T>
              </HStack>
              {edit && edit.clientId === r.client_id ? (
                <HStack style={{ marginTop: 6 }}>
                  <Input style={{ flex: 1 }} keyboardType="numeric" value={edit.pct} onChangeText={(s) => setEdit({ clientId: r.client_id, pct: s })} />
                  <Button size="sm" label="Save" onPress={async () => {
                    const pct = Number(edit?.pct);
                    if (!Number.isFinite(pct) || pct < 0 || pct > 100) { setE("Share must be between 0 and 100."); return; }
                    try { await setClientShare(partner.id, r.client_id, pct, period); setEdit(null); await loadBd(); toast("Share saved"); } catch (x) { setE(err(x)); }
                  }} />
                </HStack>
              ) : (
                <HStack style={{ marginTop: 6 }}>
                  <Button size="sm" variant="ghost" label="Set share" onPress={() => setEdit({ clientId: r.client_id, pct: String(r.share_percent) })} />
                  {r.is_override && <Button size="sm" variant="ghost" label="Clear override" onPress={async () => { try { await clearClientShare(partner.id, r.client_id, period); await loadBd(); } catch (x) { setE(err(x)); } }} />}
                </HStack>
              )}
            </Card>
          ))}
          {breakdown.length === 0 && <T v="small" muted>No clients contribute to this region this month.</T>}
        </Section>
      )}
    </Sheet>
  );
}

function PartnerDetailSheet({ partner, companyId, regionName, onClose }: { partner: any; companyId: string; regionName: string | null; onClose: () => void }) {
  const t = useTheme();
  const { toast, confirm } = useOverlay();
  const [ledger, setLedger] = useState<any[] | null>(null);
  const [e, setE] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [opts, setOpts] = useState<Awaited<ReturnType<typeof loadEntryOptions>> | null>(null);
  const [f, setF] = useState({ date: todayIso(), type: "DRAWING" as "DRAWING" | "CONTRIBUTION", note: "", amount: "", method: "CASH", paidByEmp: "", bankId: "" });
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setLedger(await partnerLedger(partner.id)); } catch (x) { setE(err(x)); } }, [partner.id]);
  useEffect(() => { const h = setTimeout(() => { void load(); }, 0); return () => clearTimeout(h); }, [load]);
  useEffect(() => { if (adding && !opts) loadEntryOptions(companyId).then(setOpts).catch(() => undefined); }, [adding, opts, companyId]);
  const usesBank = f.method === "BANK_TRANSFER" || f.method === "CHEQUE";
  return (
    <Sheet full open onClose={onClose} title={partner.name} subtitle={`${partner.scope === "BRANCH" ? `Regional · ${regionName ?? "no region"}` : "Equity"} · ${Number(partner.profit_share_percent)}% share`} error={e}
      footer={<Button full icon={Plus} label="Record drawing / contribution" onPress={() => setAdding(true)} />}>
      {!ledger && <ActivityIndicator />}
      {ledger?.map((r, i) => (
        <Card key={`${r.entry_id ?? i}`} style={{ marginBottom: 6 }}>
          <HStack>
            <View style={{ flex: 1 }}>
              <T v="bodyStrong">{r.particulars}</T>
              <T v="small" muted>{r.entry_date} · {r.source}</T>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              {Number(r.cash_paid) !== 0 && <T v="mono" color={t.tone("danger").text}>paid {acct(r.cash_paid)}</T>}
              {Number(r.remuneration) !== 0 && <T v="mono" color={t.tone("success").text}>earned {acct(r.remuneration)}</T>}
              <T v="small" muted>bal {acct(r.balance)}</T>
            </View>
          </HStack>
          {r.entry_id && <Button size="sm" variant="ghost" icon={Trash2} label="Delete" style={{ alignSelf: "flex-start" }} onPress={async () => {
            if (!(await confirm({ title: "Delete this ledger entry?", confirmLabel: "Delete", tone: "danger" }))) return;
            try { await deletePartnerEntry(r.entry_id); await load(); toast("Entry deleted", "warning"); } catch (x) { setE(err(x)); }
          }} />}
        </Card>
      ))}
      {ledger && ledger.length === 0 && <T v="small" muted>No ledger entries yet.</T>}
      <Sheet open={adding} onClose={() => setAdding(false)} title="Record entry" footer={<Button full label={busy ? "Saving…" : "Save"} disabled={busy} onPress={async () => {
        setBusy(true); setE(null);
        try { await recordPartnerEntry(companyId, partner.id, f, opts?.custodians ?? []); setAdding(false); setF({ ...f, amount: "", note: "", paidByEmp: "", bankId: "" }); await load(); toast("Entry recorded"); }
        catch (x) { toast(err(x), "danger"); } finally { setBusy(false); }
      }} />}>
        <Chips value={f.type} onChange={(k) => setF({ ...f, type: k })} items={[{ key: "DRAWING", label: "Drawing" }, { key: "CONTRIBUTION", label: "Contribution" }]} />
        <Input label="Date" value={f.date} onChangeText={(s) => setF({ ...f, date: s })} />
        <Input label="Amount" required amount keyboardType="numeric" value={f.amount} onChangeText={(s) => setF({ ...f, amount: s.replace(/[^\d.]/g, "") })} />
        <Select label="Method" value={f.method} onChange={(v) => setF({ ...f, method: v })} options={["CASH", "BANK_TRANSFER", "FUEL_CARD", "CHEQUE"].map((m) => ({ value: m, label: m.replace("_", " ") }))} />
        {f.method === "CASH" && <Select label="Paid by (custodian)" required searchable value={f.paidByEmp} onChange={(v) => setF({ ...f, paidByEmp: v })} options={(opts?.custodians ?? []).map((c) => ({ value: c.employeeId, label: c.fullName }))} />}
        {usesBank && <Select label="Bank account" required value={f.bankId} onChange={(v) => setF({ ...f, bankId: v })} options={(opts?.banks ?? []).map((b) => ({ value: b.id, label: b.bank_name }))} />}
        <Input label="Note" value={f.note} onChangeText={(s) => setF({ ...f, note: s })} />
      </Sheet>
    </Sheet>
  );
}


