import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Building2, CheckCircle2, Loader2, Scale, ShieldAlert, Users } from "lucide-react";
import StatCard from "../../../components/StatCard";
import Badge from "../../../components/Badge";
import { Panel } from "../_assetsKit";
import { supabase } from "../../../lib/supabase";
import { formatDate } from "../../../lib/date";
import {
  Amount, callRpc, money, monthEnd, monthLabel, monthStart, ProposedNotice,
  useCompanyId, useDrill, type DrillTarget,
} from "./kit";

/**
 * THE ACCOUNTANT'S OVERVIEW — what the September 2026 audit had to find by
 * hand, surfaced without being asked.
 *
 * Anything with money on it is a CHECK first (a function wired into
 * ledger_checks, so it turns red overnight on its own) and a tile second. The
 * five findings below are proposed as checks in 0516; until 0516 applies each
 * says so instead of showing an empty list that would read as "none".
 * Head office unallocated and contracted-vs-deployed cover are TILES, not
 * checks: both are decided states (0514/0515; absorbed cover by design), and a
 * check that is red by policy teaches people that red is normal.
 */

type CheckRow = { check_name: string; expected: number; actual: number; difference: number; passed: boolean };

/** The function behind each control, for its drill-down rows. */
const CHECK_ROWS: Record<string, { fn: string; args: "co" | "co_month" | "none"; label: string }> = {
  payroll_accrual_matches_attendance: { fn: "payroll_attendance_drift", args: "co", label: "Payslips whose days disagree with attendance" },
  revenue_recognised_in_service_month: { fn: "revenue_outside_service_month", args: "co", label: "Invoices whose revenue month cannot be checked" },
  no_stale_prepaid_balance: { fn: "stale_prepaid_expenses", args: "co", label: "Prepaid expenses not fully released" },
  no_negative_custodian_balance: { fn: "negative_custodian_balances", args: "co", label: "Custodians holding less than nothing" },
  cash_per_location_gl_equals_operational: { fn: "custodian_held_operational", args: "co", label: "Custody locations: GL vs operational" },
  bank_per_account_gl_equals_operational: { fn: "bank_held_operational", args: "co", label: "Bank accounts: GL vs operational" },
  cash_pl_agrees_with_partnership: { fn: "cash_basis_partnership_mismatch", args: "co", label: "Months where the cash P&L and the partnership base differ" },
  migration_ledger_matches_repo: { fn: "migration_ledger_drift", args: "none", label: "Migrations recorded vs in the repository" },
  every_control_is_invoked: { fn: "uninvoked_controls", args: "none", label: "Controls nothing calls" },
  no_definer_function_crosses_a_branch: { fn: "branch_guard_gaps", args: "none", label: "Functions that cross a branch unguarded" },
  every_source_row_posted: { fn: "unposted_source_rows", args: "co", label: "Source rows with no journal entry" },
  alert_delivery_is_healthy: { fn: "alert_delivery_gaps", args: "co", label: "Alert delivery problems" },
  monthly_ledger_run_is_current: { fn: "monthly_ledger_run_gaps", args: "co", label: "Monthly ledger jobs behind" },
  every_billed_client_carries_cost: { fn: "client_income_cost_gaps", args: "co_month", label: "Clients billed with no cost, or cost with no billing" },
  no_payroll_booked_as_expense: { fn: "payroll_booked_as_expense", args: "co", label: "Guard pay booked as an expense" },
  cash_and_bank_land_where_recorded: { fn: "cash_bank_crossposted", args: "co", label: "Cash recorded as bank, or bank as cash" },
  no_advance_booked_as_expense: { fn: "advances_booked_as_expense", args: "co", label: "Advances sitting inside expense" },
  invoices_fall_inside_their_contract: { fn: "invoice_outside_contract", args: "co", label: "Invoices outside their contract's dates" },
};

/** The audit's findings, in the order an accountant would act on them. */
const FINDINGS = [
  "every_billed_client_carries_cost",
  "no_payroll_booked_as_expense",
  "cash_and_bank_land_where_recorded",
  "no_advance_booked_as_expense",
  "invoices_fall_inside_their_contract",
] as const;

/** Turn a row from a check's function into the right drill-down. */
function rowDrill(fn: string, r: Record<string, unknown>, period: string): DrillTarget | null {
  const id = (k: string) => (r[k] as string | undefined) ?? null;
  if (id("expense_id")) return { type: "source", table: "expenses", id: id("expense_id")! };
  if (id("invoice_id")) return { type: "source", table: "invoices", id: id("invoice_id")! };
  if (id("payslip_id")) return { type: "source", table: "payslips", id: id("payslip_id")! };
  if (fn === "cash_bank_crossposted" && id("source_id")) return { type: "source", table: id("source_table")!, id: id("source_id")! };
  if (fn === "client_income_cost_gaps" && id("client_id"))
    return { type: "gl", title: `${String(r.client_name)} — ${monthLabel(period)}`, start: monthStart(period), end: monthEnd(period), clientId: id("client_id")!,
      note: "Every journal line carrying this client in the month. Income with no payroll or expense line beside it is the gap." };
  return null;
}

function RowsTable({ fn, rows, period }: { fn: string; rows: Record<string, unknown>[]; period: string }) {
  const drill = useDrill();
  const cols = useMemo(() => {
    const first = rows[0] ?? {};
    return Object.keys(first).filter((k) => !/(_id$|^id$)/.test(k)).slice(0, 7);
  }, [rows]);
  if (rows.length === 0) return <div className="text-xs text-muted-foreground px-1 py-2">No rows.</div>;
  return (
    <div className="overflow-x-auto border border-border rounded-lg">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>{cols.map((c) => <th key={c} className="text-left px-2.5 py-1.5 font-medium whitespace-nowrap">{c.replace(/_/g, " ")}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((r, i) => {
            const t = rowDrill(fn, r, period);
            return (
              <tr key={i} className={`border-t border-border ${t ? "hover:bg-muted/30 cursor-pointer" : ""}`} onClick={() => t && drill(t)}>
                {cols.map((c) => {
                  const v = r[c];
                  const isNum = typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && !/date|month|code|name|number/.test(c));
                  return (
                    <td key={c} className={`px-2.5 py-1.5 ${isNum ? "text-right" : ""} max-w-[18rem] truncate`}>
                      {isNum ? <Amount v={v as number} /> : /date|month/.test(c) && typeof v === "string" ? formatDate(v) : String(v ?? "—")}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > 50 && <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground border-t border-border">Showing 50 of {rows.length}.</div>}
    </div>
  );
}

function CheckRows({ name, period }: { name: string; period: string }) {
  const companyId = useCompanyId();
  const meta = CHECK_ROWS[name];
  const [state, setState] = useState<{ rows: Record<string, unknown>[] | null; missing: boolean; error: string | null }>({ rows: null, missing: false, error: null });
  useEffect(() => {
    if (!companyId || !meta) return;
    let cancelled = false;
    void (async () => {
      const args = meta.args === "none" ? {} : meta.args === "co_month" ? { p_company_id: companyId, p_month: monthStart(period) } : { p_company_id: companyId };
      const r = await callRpc<Record<string, unknown>[]>(meta.fn, args);
      if (!cancelled) setState({ rows: r.data ?? [], missing: r.missing, error: r.missing ? null : r.error });
    })();
    return () => { cancelled = true; };
  }, [companyId, meta, period]);
  if (!meta) return <div className="text-xs text-muted-foreground">This control reports a figure, not rows: expected and actual are shown above.</div>;
  if (state.missing) return <ProposedNotice fn={meta.fn} what="This list" />;
  if (state.error) return <div className="text-xs text-danger-600">{state.error}</div>;
  if (!state.rows) return <div className="text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin inline-block mr-1" />Loading…</div>;
  return <RowsTable fn={meta.fn} rows={state.rows} period={period} />;
}

function FindingCard({ name, check, period }: { name: string; check: CheckRow | undefined; period: string }) {
  const [open, setOpen] = useState(false);
  const meta = CHECK_ROWS[name];
  const status = check == null ? <Badge tone="neutral">Proposed (0516)</Badge>
    : check.passed ? <Badge tone="success">Clear</Badge> : <Badge tone="danger">{money(check.actual)} found</Badge>;
  return (
    <div className="border border-border rounded-lg">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-3 px-3.5 py-3 text-left hover:bg-muted/30">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{meta.label}</div>
          <div className="text-[11px] text-muted-foreground font-mono">{name}</div>
        </div>
        {status}
      </button>
      {open && <div className="px-3.5 pb-3.5"><CheckRows name={name} period={period} /></div>}
    </div>
  );
}

export function BridgePanel({ period }: { period: string }) {
  const companyId = useCompanyId();
  const [state, setState] = useState<{ rows: { sort: number; item: string; amount: number; detail: string }[] | null; missing: boolean; error: string | null }>({ rows: null, missing: false, error: null });
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void (async () => {
      setState({ rows: null, missing: false, error: null });
      const r = await callRpc<{ sort: number; item: string; amount: number; detail: string }[]>("cash_accrual_bridge",
        { p_company_id: companyId, p_start: monthStart(period), p_end: monthEnd(period) });
      if (!cancelled) setState({ rows: r.data, missing: r.missing, error: r.missing ? null : r.error });
    })();
    return () => { cancelled = true; };
  }, [companyId, period]);
  return (
    <Panel icon={Scale} title={`Accrual to cash — ${monthLabel(period)}`}
      description="The accrual result, each reconciling item by name, and the cash result. Read from the same figures every statement reads; nothing left for the reader to derive.">
      {state.missing ? <ProposedNotice fn="cash_accrual_bridge" what="The bridge" />
        : state.error ? <div className="text-sm text-danger-600">{state.error}</div>
        : !state.rows ? <div className="text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />Loading…</div>
        : (
          <table className="w-full text-sm">
            <tbody>
              {state.rows.map((r) => {
                const edge = r.sort === 10 || r.sort === 90;
                const unexplained = r.sort === 80;
                if (unexplained && Math.abs(Number(r.amount)) < 0.005) return null;
                return (
                  <tr key={r.sort} className={`border-t border-border ${edge ? "font-semibold" : ""} ${unexplained ? "bg-danger-50" : ""}`}>
                    <td className="py-2 pr-3 align-top">
                      <div className={edge ? "text-foreground" : "pl-4"}>{r.item}</div>
                      {!edge && <div className="pl-4 text-[11px] text-muted-foreground leading-snug">{r.detail}</div>}
                    </td>
                    <td className="py-2 text-right align-top"><Amount v={r.amount} strong={edge} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
    </Panel>
  );
}

export default function OverviewTab({ period, onOpenTab }: { period: string; onOpenTab: (t: "clients" | "statements") => void }) {
  const companyId = useCompanyId();
  const [checks, setChecks] = useState<CheckRow[] | null>(null);
  const [hoLine, setHoLine] = useState<number | null>(null);
  const [cover, setCover] = useState<{ value: number | null; missing: boolean }>({ value: null, missing: false });
  const [error, setError] = useState<string | null>(null);
  const [openCheck, setOpenCheck] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void (async () => {
      setChecks(null);
      const [lc, cs, cv] = await Promise.all([
        supabase.rpc("ledger_checks", { p_company_id: companyId }),
        supabase.rpc("client_statement_loaded", { p_start: monthStart(period), p_end: monthEnd(period), p_basis: "revenue", p_company_id: companyId }),
        callRpc<{ unbilled_cover: number }[]>("client_cover", { p_company_id: companyId, p_month: monthStart(period) }),
      ]);
      if (cancelled) return;
      if (lc.error) { setError(lc.error.message); return; }
      setChecks((lc.data ?? []) as CheckRow[]);
      const ho = ((cs.data ?? []) as { client_id: string | null; ho_share: number }[]).find((r) => r.client_id == null);
      setHoLine(ho ? Number(ho.ho_share) : 0);
      setCover({ value: cv.data ? cv.data.reduce((s, r) => s + Number(r.unbilled_cover || 0), 0) : null, missing: cv.missing });
    })();
    return () => { cancelled = true; };
  }, [companyId, period]);

  const byName = useMemo(() => new Map((checks ?? []).map((c) => [c.check_name, c])), [checks]);
  const red = (checks ?? []).filter((c) => !c.passed && c.check_name !== "checks_evaluated");
  const findingsRed = FINDINGS.filter((f) => byName.get(f) && !byName.get(f)!.passed).length;

  return (
    <div className="space-y-5">
      {error && <div className="text-sm text-danger-600">{error}</div>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        {/* Each tile opens what it counts (2026-10-22: "every figure clickable"). */}
        <StatCard title="Red controls" value={checks ? red.length : "…"} icon={ShieldAlert} tone={red.length ? "danger" : "success"}
          onClick={() => document.getElementById("overview-red-controls")?.scrollIntoView({ behavior: "smooth", block: "start" })} />
        <StatCard title="Audit findings open" value={checks ? (byName.has(FINDINGS[0]) ? findingsRed : "—") : "…"} icon={AlertTriangle} tone="warning"
          onClick={() => document.getElementById("overview-findings")?.scrollIntoView({ behavior: "smooth", block: "start" })} />
        <StatCard title={`Head office unallocated · ${monthLabel(period)}`} value={hoLine == null ? "…" : money(hoLine)} icon={Building2} tone="neutral"
          onClick={() => onOpenTab("clients")} />
        <StatCard title="Unbilled cover (heads)" value={cover.missing ? "—" : cover.value == null ? "…" : money(cover.value)} icon={Users} tone="info"
          onClick={() => onOpenTab("statements")} />
      </div>

      <div id="overview-findings" className="scroll-mt-4">
      <Panel icon={AlertTriangle} tone="warning" title="What the September audit found by hand"
        description="Each is a check: it turns red on its own overnight and stays red until the cause is fixed. Open one for its rows; open a row for its source.">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {FINDINGS.map((f) => <FindingCard key={f} name={f} check={byName.get(f)} period={period} />)}
        </div>
      </Panel>
      </div>

      <div id="overview-red-controls" className="scroll-mt-4">
      <Panel icon={ShieldAlert} tone="danger" title="Every red control"
        description="Straight from ledger_checks. Expected, actual and the difference; open one for the rows behind it."
        flush>
        {!checks ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Running the checks…</div>
        ) : red.length === 0 ? (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-success-700"><CheckCircle2 className="w-4 h-4" /> Every control is green.</div>
        ) : (
          <div className="divide-y divide-border">
            {red.map((c) => (
              <div key={c.check_name}>
                <button type="button" onClick={() => setOpenCheck(openCheck === c.check_name ? null : c.check_name)}
                  className="w-full grid grid-cols-[1fr_auto] md:grid-cols-[1fr_9rem_9rem_9rem] gap-3 items-center px-4 md:px-5 py-2.5 text-left hover:bg-muted/30">
                  <div className="min-w-0">
                    <div className="text-sm text-foreground truncate">{CHECK_ROWS[c.check_name]?.label ?? c.check_name.replace(/_/g, " ")}</div>
                    <div className="text-[11px] text-muted-foreground font-mono truncate">{c.check_name}</div>
                  </div>
                  <div className="hidden md:block text-right text-xs text-muted-foreground">expected <Amount v={c.expected} /></div>
                  <div className="hidden md:block text-right text-xs text-muted-foreground">actual <Amount v={c.actual} /></div>
                  <div className="text-right text-sm"><Amount v={c.difference} strong /></div>
                </button>
                {openCheck === c.check_name && <div className="px-4 md:px-5 pb-4"><CheckRows name={c.check_name} period={period} /></div>}
              </div>
            ))}
          </div>
        )}
      </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <BridgePanel period={period} />
        <Panel icon={Building2} title="Head office and cover"
          description="Both are decided states, so they are figures to watch rather than controls to clear.">
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span>Head office cost left at head office in {monthLabel(period)}</span>
              <Amount v={hoLine} strong />
            </div>
            <p className="text-xs text-muted-foreground">
              Each region is set Yes or No on the Client profit tab; a No region's share passes to the Yes regions, so this is zero unless every region is No. It is never dropped: every statement carries it as the
              Head office — unallocated line.
            </p>
            <div className="flex flex-wrap gap-3 pt-1">
              <button type="button" className="text-brand-700 dark:text-brand-500 hover:underline text-sm" onClick={() => onOpenTab("clients")}>Charge head office to a region →</button>
              <button type="button" className="text-brand-700 dark:text-brand-500 hover:underline text-sm" onClick={() => onOpenTab("statements")}>Contracted vs deployed →</button>
            </div>
            {cover.missing && <ProposedNotice fn="client_cover" what="The unbilled-cover tile" />}
          </div>
        </Panel>
      </div>
    </div>
  );
}
