import { useEffect, useMemo, useState } from "react";
import { Building2, Loader2, Users } from "lucide-react";
import Tabs from "../../../components/Tabs";
import Badge from "../../../components/Badge";
import ExportButton from "../../../components/ExportButton";
import HeadOfficeApportionmentPanel from "../../../components/HeadOfficeApportionmentPanel";
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

export default function ClientProfitTab({ period }: { period: string }) {
  const companyId = useCompanyId();
  const { profile } = useAuth();
  const canEdit = hasPermission(profile, "accounting.edit");
  const { regionId } = useRegion();
  const drill = useDrill();
  const [basis, setBasis] = usePageState<"revenue" | "cash">("Reports.clientBasis", "revenue");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [modes, setModes] = useState<Mode[]>([]);
  const [hoBranchId, setHoBranchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const start = monthStart(period), end = monthEnd(period);

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
        explanation: `ho_apportionment (0514/0515): the pool times this client's revenue over every region's revenue — paid only when the client's region is switched on. ${r.region_name} is ${mode?.apportioned ? "apportioned" : "held"} this month. The figures below are read from ho_pool and ho_driver; the share itself is the database's.`,
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

  return (
    <div className="space-y-5">
      <Panel icon={Users} title={`Client profit — ${monthLabel(period)}`}
        description={basis === "revenue"
          ? "Accrual: revenue at the service month, payroll accrued, expense as the GL recognised it."
          : "Cash: received, paid and disbursed in the month."}
        actions={<>
          <Tabs<"revenue" | "cash"> size="sm" value={basis} onChange={setBasis}
            items={[{ value: "revenue", label: "Accrual" }, { value: "cash", label: "Cash" }]} />
          <ExportButton onExport={doExport} />
        </>}
        flush>
        <div className="px-4 md:px-5 py-2.5 border-b border-border flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-muted-foreground">Head office this month:</span>
          {modes.map((m) => (
            <Badge key={m.branch_id} tone={m.apportioned ? "brand" : "neutral"}>{m.region_name} {m.apportioned ? "apportioned" : "held"}</Badge>
          ))}
        </div>
        {error ? <div className="px-5 py-6 text-sm text-danger-600">{error}</div>
          : !rows ? <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b border-border">
                  <tr>
                    <th className="text-left px-4 md:px-5 py-2.5 font-medium">Client</th>
                    {COLS.map((c) => <th key={c} className="text-right px-3 py-2.5 font-medium whitespace-nowrap">{HEAD[c]}</th>)}
                  </tr>
                </thead>
                {groups.map(([region, rs]) => (
                  <tbody key={region} className="border-b border-border">
                    <tr className="bg-muted/30">
                      <td colSpan={COLS.length + 1} className="px-4 md:px-5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{region}</td>
                    </tr>
                    {rs.map((r) => (
                      <tr key={r.client_id ?? "ho"} className="border-t border-border/60 hover:bg-muted/20">
                        <td className="px-4 md:px-5 py-2 min-w-0">
                          {r.client_id ? (
                            <button type="button" className="text-left hover:underline"
                              onClick={() => drill({ type: "ledger", kind: "client", subjectId: r.client_id!, title: `Client ledger — ${r.client_name}`, start: `${period.slice(0, 4)}-01-01`, end })}>
                              <div className="text-foreground">{r.client_name}</div>
                              <div className="text-[11px] text-muted-foreground font-mono">{r.client_code}</div>
                            </button>
                          ) : (
                            <div><div className="text-foreground">Head office — unallocated</div>
                              <div className="text-[11px] text-muted-foreground">Held, not apportioned</div></div>
                          )}
                        </td>
                        {COLS.map((c) => (
                          <td key={c} className="px-3 py-2 text-right">
                            {r.client_id == null && c !== "ho_share" && c !== "net"
                              ? <span className="text-muted-foreground">—</span>
                              : <Amount v={r[c]} strong={c === "net"} onClick={() => void openCell(r, c)} />}
                          </td>
                        ))}
                      </tr>
                    ))}
                    <tr className="border-t border-border text-xs">
                      <td className="px-4 md:px-5 py-1.5 text-muted-foreground">{region} subtotal</td>
                      {COLS.map((c) => <td key={c} className="px-3 py-1.5 text-right"><Amount v={sum(rs, c)} strong /></td>)}
                    </tr>
                  </tbody>
                ))}
                <tfoot>
                  <tr className="border-t-2 border-border font-semibold">
                    <td className="px-4 md:px-5 py-2.5">Total of rows shown</td>
                    {COLS.map((c) => <td key={c} className="px-3 py-2.5 text-right"><Amount v={sum(shown, c)} strong /></td>)}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
      </Panel>

      {companyId && (
        <Panel icon={Building2} title="Head-office treatment"
          description="Switch head office per region (0515). The price — every partner as set and after the change — is shown before anything saves.">
          <HeadOfficeApportionmentPanel companyId={companyId} period={period} canEdit={canEdit} onSaved={() => setReload((n) => n + 1)} />
        </Panel>
      )}
    </div>
  );
}
