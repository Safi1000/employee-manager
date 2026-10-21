import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Loader2, Users } from "lucide-react";
import Tabs from "../../../components/Tabs";
import Badge from "../../../components/Badge";
import ExportButton from "../../../components/ExportButton";
import { Panel } from "../_assetsKit";
import { supabase } from "../../../lib/supabase";
import { exportTable } from "../../../lib/excel";
import { useAuth, hasPermission } from "../../../lib/auth";
import { useRegion } from "../../../lib/region";
import { usePageState } from "../../../lib/pageState";
import { Amount, monthEnd, monthLabel, monthStart, useCompanyId, useDrill, type DrillTarget } from "./kit";

/**
 * Client-wise profit for a month, on either basis, read from
 * client_statement_loaded — the one client P&L every partner figure is built
 * from. Head office is visible and switchable here (0515's per-region setting,
 * with its price), and shows as its own line when held.
 *
 * Every figure opens: revenue, payroll and direct expenses to their journal
 * lines; regional overhead and the head-office share — which are
 * apportionments, not postings — to their pool and driver.
 */

type Row = {
  client_id: string | null; client_name: string; client_code: string | null; branch_id: string | null; region_name: string;
  revenue: number; direct_payroll: number; direct_expenses: number; regional_overhead: number; ho_share: number; net: number;
};
type Mode = { branch_id: string; region_name: string; apportioned: boolean; own_setting: boolean };

const COLS = ["revenue", "direct_payroll", "direct_expenses", "regional_overhead", "ho_share", "net"] as const;
const HEAD: Record<(typeof COLS)[number], string> = {
  revenue: "Revenue", direct_payroll: "Payroll", direct_expenses: "Direct expenses",
  regional_overhead: "Regional overhead", ho_share: "Head office", net: "Net",
};

export default function ClientProfitTab({ period, basis: basisProp }: { period: string; basis?: "revenue" | "cash" }) {
  const companyId = useCompanyId();
  const { profile } = useAuth();
  const { regionId } = useRegion();
  const drill = useDrill();
  const [ownBasis, setBasis] = usePageState<"revenue" | "cash">("Reports.clientBasis", "revenue");
  // The page band's basis switch drives this tab when it is given one.
  const basis = basisProp ?? ownBasis;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [modes, setModes] = useState<Mode[]>([]);
  const [hoBranchId, setHoBranchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Last month on the same basis (for the change), and contracted heads (for
  // per-guard figures). Both are reads; nothing here re-derives the statement.
  const [prevNet, setPrevNet] = useState<Map<string, number> | null>(null);
  const [heads, setHeads] = useState<Map<string, number>>(new Map());
  const [quick, setQuick] = usePageState<"all" | "loss" | "thin" | "healthy">("Reports.clientQuick", "all");
  const [sortBy, setSortBy] = usePageState<"net" | "margin" | "revenue" | "change">("Reports.clientSort", "net");
  const [view, setView] = usePageState<"table" | "cards">("Reports.clientView", "table");
  const start = monthStart(period), end = monthEnd(period);
  const prevKey = (() => { const [y, m] = period.split("-").map(Number); const d = new Date(y, m - 2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void (async () => {
      setPrevNet(null);
      const [pv, cv] = await Promise.all([
        supabase.rpc("client_statement_loaded", { p_start: monthStart(prevKey), p_end: monthEnd(prevKey), p_basis: basis, p_company_id: companyId }),
        supabase.rpc("client_cover", { p_company_id: companyId, p_month: start }),
      ]);
      if (cancelled) return;
      setPrevNet(new Map(((pv.data ?? []) as Row[]).filter((r) => r.client_id).map((r) => [r.client_id!, Number(r.net)])));
      setHeads(new Map(((cv.data ?? []) as { client_id: string; contracted: number }[]).map((r) => [r.client_id, Number(r.contracted)])));
    })();
    return () => { cancelled = true; };
  }, [companyId, start, prevKey, basis]);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void (async () => {
      setRows(null); setError(null);
      const [cs, md, ho] = await Promise.all([
        supabase.rpc("client_statement_loaded", { p_start: start, p_end: end, p_basis: basis, p_company_id: companyId }),
        supabase.rpc("ho_region_modes", { p_company_id: companyId, p_month: start }),
        supabase.from("branches").select("id").eq("company_id", companyId).eq("is_head_office", true).maybeSingle(),
      ]);
      if (cancelled) return;
      if (cs.error) { setError(cs.error.message); return; }
      setRows(((cs.data ?? []) as Row[]).filter((r) =>
        r.client_id == null || [r.revenue, r.direct_payroll, r.direct_expenses, r.regional_overhead, r.ho_share, r.net].some((v) => Math.abs(Number(v)) > 0.005)));
      setModes((md.data ?? []) as Mode[]);
      setHoBranchId((ho.data as { id: string } | null)?.id ?? null);
    })();
    return () => { cancelled = true; };
  }, [companyId, start, end, basis, reload]);

  // Region scope from the global selector; the head-office line belongs to Head Office.
  const shown = useMemo(() => (rows ?? []).filter((r) => !regionId || r.branch_id === regionId), [rows, regionId]);
  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of shown) {
      const k = r.region_name || "Unassigned";
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()].sort((a, b) => (a[0] === "Head Office" ? 1 : b[0] === "Head Office" ? -1 : a[0].localeCompare(b[0])));
  }, [shown]);

  /** Sum of the rows displayed — the footer/subtotal exception, nothing else. */
  const sum = (rs: Row[], k: (typeof COLS)[number]) => rs.reduce((s, r) => s + Number(r[k] || 0), 0);

  const openCell = async (r: Row, k: (typeof COLS)[number]) => {
    if (!companyId) return;
    const who = r.client_id ? r.client_name : "Head office";
    const t = (title: string, x: Omit<Extract<DrillTarget, { type: "gl" }>, "type" | "title" | "start" | "end">): DrillTarget =>
      ({ type: "gl", title: `${title} — ${who}, ${monthLabel(period)}`, start, end, ...x });
    if (r.client_id == null) {
      // The head-office line: what head office cost on this basis, less what was apportioned.
      const hoBranch = r.branch_id ?? hoBranchId ?? undefined;
      drill({ type: "composition", title: `Head office, unallocated — ${monthLabel(period)}`,
        explanation: "Head-office cost on this basis less what was apportioned to clients in regions switched on (0515). Held regions' shares stay here, with the named exclusions (income tax, bonus provision, a partner's share). Not a posting: it is the remainder of an apportionment.",
        rows: [{ label: "Held at head office", value: Number(r.ho_share), drill: hoBranch ? t("Head-office expense lines", { branchId: hoBranch, accountTypes: ["expense"] }) : undefined }] });
      return;
    }
    if (k === "revenue") {
      drill(basis === "revenue"
        ? t("Revenue", { clientId: r.client_id, accountTypes: ["revenue"], note: "Revenue lines carrying this client, posted at the service month (A4)." })
        : t("Receipts", { clientId: r.client_id, accountCodes: ["1100"], sourceTables: ["invoice_payments"], note: "Receivable lines for this client's receipts in the month: the credits are cash received." }));
    } else if (k === "direct_payroll") {
      drill(t("Payroll", basis === "revenue"
        ? { clientId: r.client_id, sourceTables: ["payslips", "payroll_adjustments"], accountCodes: ["5000", "6000"], note: "Payslip accrual lines carrying this client. The statement splits a guard who worked for two clients by days worked; the GL carries his home client, so the two can differ for such guards." }
        : { clientId: r.client_id, sourceTables: ["payslips_disbursement"], accountCodes: ["2100"], note: "Salaries-payable debits for this client's disbursements in the month. The statement splits by days worked; the GL carries the guard's home client." }));
    } else if (k === "direct_expenses") {
      drill(t("Direct expenses", { expenseClientId: r.client_id, accountTypes: ["expense"], sourceTables: ["expenses", "expenses_prepaid_release"],
        note: basis === "revenue" ? "Expense lines the GL recognised in the month for expenses booked to this client (prepaids through their release)." : "Expense lines for this client's expenses. On the cash basis the statement counts them on the day paid; the GL lines show when they were recognised." }));
    } else if (k === "regional_overhead") {
      drill({ type: "composition", title: `Regional overhead — ${r.client_name}, ${monthLabel(period)}`,
        explanation: `${r.region_name}'s own cost that no client carries (staff without a client, expenses without a client), spread over the region's clients by invoiced revenue. An apportionment, not a posting: it has no journal lines of its own. Open the region's expense lines to see the pool.`,
        rows: [{ label: "This client's share", value: Number(r.regional_overhead),
          drill: r.branch_id ? t("Region's expense lines", { branchId: r.branch_id, accountTypes: ["expense"] }) : undefined }] });
    } else if (k === "ho_share") {
      const basisPool = basis === "cash" ? "cash" : "accrual";
      const [pool, drv] = await Promise.all([
        supabase.rpc("ho_pool", { p_company_id: companyId, p_start: start, p_end: end, p_basis: basisPool }),
        supabase.rpc("ho_driver", { p_company_id: companyId, p_start: start, p_end: end }),
      ]);
      const d = (drv.data ?? []) as { client_id: string; weight: number }[];
      const mine = d.filter((x) => x.client_id === r.client_id).reduce((s, x) => s + Number(x.weight), 0);
      const all = d.reduce((s, x) => s + Number(x.weight), 0);
      const mode = modes.find((m) => m.branch_id === r.branch_id);
      drill({ type: "composition", title: `Head-office share — ${r.client_name}, ${monthLabel(period)}`,
        explanation: `ho_apportionment (0514/0515/0525): the pool times this client's revenue over the revenue of the regions charged head office — paid only when the client's region is charged. A region not charged passes its share to the regions that are. ${r.region_name} is ${mode?.apportioned ? "charged" : "not charged"} this month. The figures below are read from ho_pool and ho_driver; the share itself is the database's.`,
        rows: [
          { label: `Head-office pool (${basisPool})`, value: Number(pool.data ?? 0), drill: hoBranchId ? t("Head-office pool lines", { accountTypes: ["expense"], branchId: hoBranchId, note: "Every expense line on the head-office region. The pool excludes income tax, the bonus provision, the allocation's own accounts and a partner's share (ho_pool's named list)." }) : undefined },
          { label: "This client's revenue (driver)", value: mine, drill: t("Revenue", { clientId: r.client_id, accountTypes: ["revenue"] }) },
          { label: "Every region's revenue (denominator)", value: all },
          { label: "Share carried", value: Number(r.ho_share) },
        ] });
    } else {
      drill({ type: "ledger", kind: "client", subjectId: r.client_id, title: `Client ledger — ${r.client_name}`, start: `${period.slice(0, 4)}-01-01`, end });
    }
  };

  const doExport = () => exportTable({
    fileName: `Client profit ${monthLabel(period)} (${basis === "revenue" ? "accrual" : "cash"}).xlsx`,
    sheetName: "Client profit",
    title: `Client profit — ${monthLabel(period)}, ${basis === "revenue" ? "accrual" : "cash"} basis`,
    headers: ["Region", "Client", ...COLS.map((c) => HEAD[c])],
    rows: shown.map((r) => [r.region_name, r.client_id ? r.client_name : "Head office — unallocated", ...COLS.map((c) => Number(r[c]))]),
  });

  // ---- presentation (ratios of the statement's own figures) ----
  const margin = (r: Row) => (Number(r.revenue) > 0 ? Number(r.net) / Number(r.revenue) : null);
  const band = (r: Row): "loss" | "thin" | "healthy" => { const m = margin(r); return Number(r.net) < 0 ? "loss" : m != null && m < 0.1 ? "thin" : "healthy"; };
  const change = (r: Row) => (r.client_id && prevNet?.has(r.client_id) ? Number(r.net) - prevNet.get(r.client_id)! : null);
  const clients = shown.filter((r) => r.client_id);
  const counts = { all: clients.length, loss: clients.filter((r) => band(r) === "loss").length, thin: clients.filter((r) => band(r) === "thin").length, healthy: clients.filter((r) => band(r) === "healthy").length };
  const keep = (r: Row) => !r.client_id ? quick === "all" : quick === "all" || band(r) === quick;
  const order = (a: Row, b: Row) => {
    if (!a.client_id) return 1; if (!b.client_id) return -1;
    if (sortBy === "margin") return (margin(b) ?? -9) - (margin(a) ?? -9);
    if (sortBy === "revenue") return Number(b.revenue) - Number(a.revenue);
    if (sortBy === "change") return (change(b) ?? -1e15) - (change(a) ?? -1e15);
    return Number(b.net) - Number(a.net);
  };
  const totRev = sum(clients, "revenue"), totNet = sum(clients, "net");
  const totHeads = clients.reduce((n, r) => n + (heads.get(r.client_id!) ?? 0), 0);
  // Best and weakest only among clients with payroll recorded: a client whose
  // guards are not on Bastion's payroll (Lahore, today) reads ~100% and would
  // always "win".
  const ranked = [...clients].filter((r) => Number(r.revenue) > 0 && Number(r.direct_payroll) > 0).sort((a, b) => (margin(b) ?? 0) - (margin(a) ?? 0));
  const noPayroll = clients.filter((r) => Number(r.revenue) > 0 && Number(r.direct_payroll) <= 0).length;
  const best = ranked[0], worst = ranked[ranked.length - 1];
  const pctTxt = (m: number | null) => (m == null ? "—" : `${(m * 100).toFixed(1)}%`);
  const SEG = [
    { k: "direct_payroll" as const, label: "Payroll", cls: "bg-calm" },
    { k: "direct_expenses" as const, label: "Direct", cls: "bg-heed" },
    { k: "regional_overhead" as const, label: "Regional", cls: "bg-rest" },
    { k: "ho_share" as const, label: "Head office", cls: "bg-brand-500" },
  ];
  /** Where each 100 rupees of this client's revenue went. */
  const Split = ({ r, wide }: { r: Row; wide?: boolean }) => {
    const rev = Number(r.revenue);
    if (rev <= 0) return null;
    const parts = SEG.map((x) => ({ ...x, v: Math.max(0, Number(r[x.k])) }));
    const profit = Math.max(0, Number(r.net));
    const whole = Math.max(rev, parts.reduce((n, x) => n + x.v, 0) + profit);
    return (
      <span className={`flex h-1.5 rounded-full overflow-hidden bg-muted ${wide ? "w-full" : "w-40"}`} title={parts.map((x) => `${x.label} ${Math.round((x.v / rev) * 100)}`).join(" · ") + ` · Profit ${Math.round((Number(r.net) / rev) * 100)}`}>
        {parts.map((x) => <span key={x.k} className={x.cls} style={{ width: `${(x.v / whole) * 100}%` }} />)}
        {profit > 0 && <span className="bg-success-500" style={{ width: `${(profit / whole) * 100}%` }} />}
      </span>
    );
  };
  const Change = ({ r }: { r: Row }) => {
    const c = change(r);
    if (c == null || Math.abs(c) < 1) return <span className="text-[11px] text-muted-foreground">{c == null ? "new" : "flat"}</span>;
    const up = c > 0;
    return (
      <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${up ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"}`} title={`Net ${up ? "up" : "down"} on ${monthLabel(prevKey)}`}>
        {up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}{Math.abs(Math.round(c)).toLocaleString()}
      </span>
    );
  };
  const tone = (r: Row) => (band(r) === "loss" ? "text-danger-700 dark:text-danger-500" : band(r) === "thin" ? "text-warning-700 dark:text-warning-500" : "text-success-700 dark:text-success-500");

  return (
    <div className="space-y-5">
      {rows && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            { k: "Clients", v: String(counts.all), sub: `${counts.loss} losing money · ${counts.thin} under 10%`, cls: "" },
            { k: "Net, clients shown", v: Math.round(totNet).toLocaleString(), sub: `${pctTxt(totRev ? totNet / totRev : null)} of ${Math.round(totRev).toLocaleString()} revenue`, cls: totNet < 0 ? "text-danger-700 dark:text-danger-500" : "" },
            { k: "Best margin", v: best ? pctTxt(margin(best)) : "—", sub: best ? `${best.client_name}${noPayroll ? ` · ${noPayroll} with no payroll left out` : ""}` : "—", cls: "text-success-700 dark:text-success-500" },
            { k: "Weakest margin", v: worst ? pctTxt(margin(worst)) : "—", sub: worst?.client_name ?? "—", cls: worst && Number(worst.net) < 0 ? "text-danger-700 dark:text-danger-500" : "text-warning-700 dark:text-warning-500" },
            { k: "Net per contracted guard", v: totHeads ? Math.round(totNet / totHeads).toLocaleString() : "—", sub: totHeads ? `${totHeads} guards under contract` : "no contracted heads", cls: "" },
          ].map((t) => (
            <div key={t.k} className="bg-card border border-border rounded-2xl px-4 py-3 flex flex-col gap-1 min-w-0">
              <span className="lbl truncate">{t.k}</span>
              <span className={`font-ledger text-xl font-semibold tracking-tight leading-none whitespace-nowrap ${t.cls}`}>{t.v}</span>
              <span className="text-xs text-muted-foreground truncate">{t.sub}</span>
            </div>
          ))}
        </div>
      )}

      <Panel icon={Users} title={`Client profit — ${monthLabel(period)}`}
        description={basis === "revenue"
          ? "Accrual: revenue at the service month, payroll accrued, expense as the GL recognised it. Every figure opens its lines."
          : "Cash: received, paid and disbursed in the month. Every figure opens its lines."}
        actions={<>
          {!basisProp && (
            <Tabs<"revenue" | "cash"> size="sm" value={basis} onChange={setBasis}
              items={[{ value: "revenue", label: "Accrual" }, { value: "cash", label: "Cash" }]} />
          )}
          <Tabs<"table" | "cards"> size="sm" value={view} onChange={setView} items={[{ value: "table", label: "Table" }, { value: "cards", label: "Cards" }]} />
          <ExportButton onExport={doExport} />
        </>}
        flush>
        <div className="px-4 md:px-5 py-3 border-b border-border flex flex-wrap items-center gap-3">
          <Tabs<"all" | "loss" | "thin" | "healthy"> size="sm" value={quick} onChange={setQuick}
            items={[
              { value: "all", label: "All", count: counts.all },
              { value: "loss", label: "Losing money", count: counts.loss },
              { value: "thin", label: "Under 10%", count: counts.thin },
              { value: "healthy", label: "Healthy", count: counts.healthy },
            ]} />
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} aria-label="Sort" className="px-3 py-1.5 border border-border rounded-xl bg-card text-sm">
            <option value="net">Most profit first</option>
            <option value="margin">Best margin first</option>
            <option value="revenue">Biggest revenue first</option>
            <option value="change">Biggest gain on {monthLabel(prevKey)}</option>
          </select>
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {SEG.map((x) => <span key={x.k} className="inline-flex items-center gap-1"><span className={`w-2 h-2 rounded-sm ${x.cls}`} />{x.label}</span>)}
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-success-500" />Profit</span>
          </span>
        </div>
        <div className="px-4 md:px-5 py-2 border-b border-border flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-muted-foreground">Head office this month:</span>
          {modes.map((m) => (
            <Badge key={m.branch_id} tone={m.apportioned ? "brand" : "neutral"}>{m.region_name} {m.apportioned ? "apportioned" : "held"}</Badge>
          ))}
        </div>
        {error ? <div className="px-5 py-6 text-sm text-danger-600">{error}</div>
          : !rows ? <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          : view === "cards" ? (
            <div className="p-4 md:p-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {[...shown].filter((r) => r.client_id && keep(r)).sort(order).map((r) => {
                const h = heads.get(r.client_id!) ?? 0;
                return (
                  <article key={r.client_id!} className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <button type="button" className="text-left min-w-0 hover:underline"
                        onClick={() => drill({ type: "ledger", kind: "client", subjectId: r.client_id!, title: `Client ledger — ${r.client_name}`, start: `${period.slice(0, 4)}-01-01`, end })}>
                        <p className="font-semibold text-foreground truncate">{r.client_name}</p>
                        <p className="text-[11px] text-muted-foreground">{r.region_name}{h ? ` · ${h} guards` : ""}</p>
                      </button>
                      <span className={`font-ledger text-sm font-semibold ${tone(r)}`}>{pctTxt(margin(r))}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <button type="button" onClick={() => void openCell(r, "net")} className={`font-ledger text-2xl font-semibold tracking-tight hover:underline ${Number(r.net) < 0 ? "text-danger-700 dark:text-danger-500" : "text-foreground"}`}>{Math.round(Number(r.net)).toLocaleString()}</button>
                      <Change r={r} />
                    </div>
                    <Split r={r} wide />
                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                      <button type="button" onClick={() => void openCell(r, "revenue")} className="text-left hover:underline"><span className="block text-muted-foreground">Revenue</span><span className="font-ledger text-foreground">{Math.round(Number(r.revenue)).toLocaleString()}</span></button>
                      <button type="button" onClick={() => void openCell(r, "direct_payroll")} className="text-left hover:underline"><span className="block text-muted-foreground">Payroll</span><span className="font-ledger text-foreground">{Math.round(Number(r.direct_payroll)).toLocaleString()}</span></button>
                      <span><span className="block text-muted-foreground">Net / guard</span><span className="font-ledger text-foreground">{h ? Math.round(Number(r.net) / h).toLocaleString() : "—"}</span></span>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground border-b border-border">
                  <tr>
                    <th className="text-left px-4 md:px-5 py-2.5">Client</th>
                    {COLS.map((c) => <th key={c} className="text-right px-3 py-2.5 whitespace-nowrap">{HEAD[c]}</th>)}
                    <th className="text-right px-3 py-2.5 whitespace-nowrap">Margin</th>
                    <th className="text-right px-3 py-2.5 whitespace-nowrap">vs {monthLabel(prevKey).split(" ")[0]}</th>
                  </tr>
                </thead>
                {groups.map(([region, all]) => {
                  const rs = all.filter(keep).sort(order);
                  if (rs.length === 0) return null;
                  return (
                    <tbody key={region} className="border-b border-border">
                      <tr className="bg-muted/30">
                        <td colSpan={COLS.length + 3} className="px-4 md:px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{region}</td>
                      </tr>
                      {rs.map((r) => (
                        <tr key={r.client_id ?? "ho"} className="border-t border-border/60 hover:bg-muted/20">
                          <td className="px-4 md:px-5 py-2.5 min-w-0">
                            {r.client_id ? (
                              <button type="button" className="text-left hover:underline flex flex-col gap-1"
                                onClick={() => drill({ type: "ledger", kind: "client", subjectId: r.client_id!, title: `Client ledger — ${r.client_name}`, start: `${period.slice(0, 4)}-01-01`, end })}>
                                <span className="text-foreground">{r.client_name}</span>
                                <Split r={r} />
                              </button>
                            ) : (
                              <div><div className="text-foreground">Head office — unallocated</div>
                                <div className="text-[11px] text-muted-foreground">No region is charged head office</div></div>
                            )}
                          </td>
                          {COLS.map((c) => (
                            <td key={c} className="px-3 py-2.5 text-right">
                              {r.client_id == null && c !== "ho_share" && c !== "net"
                                ? <span className="text-muted-foreground">—</span>
                                : <Amount v={r[c]} strong={c === "net"} onClick={() => void openCell(r, c)} />}
                            </td>
                          ))}
                          <td className="px-3 py-2.5 text-right">
                            {r.client_id && margin(r) != null ? (
                              <span className="inline-flex flex-col items-end gap-1">
                                <span className={`font-ledger text-xs font-semibold ${tone(r)}`}>{pctTxt(margin(r))}</span>
                                <span className="w-14 h-1 rounded-full bg-muted overflow-hidden"><span className={`block h-full rounded-full ${band(r) === "loss" ? "bg-danger-500" : band(r) === "thin" ? "bg-warning-500" : "bg-success-500"}`} style={{ width: `${Math.min(100, Math.max(4, (margin(r)! / 0.4) * 100))}%` }} /></span>
                              </span>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-3 py-2.5 text-right">{r.client_id ? <Change r={r} /> : null}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-border text-xs">
                        <td className="px-4 md:px-5 py-1.5 text-muted-foreground">{region} subtotal</td>
                        {COLS.map((c) => <td key={c} className="px-3 py-1.5 text-right"><Amount v={sum(rs, c)} strong /></td>)}
                        <td className="px-3 py-1.5 text-right font-ledger text-muted-foreground">{pctTxt(sum(rs, "revenue") ? sum(rs, "net") / sum(rs, "revenue") : null)}</td>
                        <td />
                      </tr>
                    </tbody>
                  );
                })}
                <tfoot>
                  <tr className="border-t-2 border-border font-semibold">
                    <td className="px-4 md:px-5 py-2.5">Total of rows shown</td>
                    {COLS.map((c) => <td key={c} className="px-3 py-2.5 text-right"><Amount v={sum(shown.filter(keep), c)} strong /></td>)}
                    <td className="px-3 py-2.5 text-right font-ledger">{pctTxt(sum(shown.filter(keep), "revenue") ? sum(shown.filter(keep), "net") / sum(shown.filter(keep), "revenue") : null)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
      </Panel>
    </div>
  );
}
