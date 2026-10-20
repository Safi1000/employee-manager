import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import ExportButton from "../../../components/ExportButton";
import { supabase } from "../../../lib/supabase";
import { exportTable } from "../../../lib/excel";
import { money, monthEnd, monthLabel, monthStart, useCompanyId, useDrill } from "../reports/kit";

/**
 * THE INCOME & WITHDRAWAL STATE, from the ledger: one column per bank account
 * and cash holder, one row per kind of movement, for the month — brought
 * forward, every way money came in and went out, and closing.
 *
 * Each column is ledger_statement('account', <that location's GL account>):
 * OPENING and CLOSING are its own rows, and every movement row here is the sum
 * of its LINE rows grouped by the source that posted them. Nothing is worked
 * out that the ledger does not already hold, so the closing row is the
 * ledger's closing, not a total of the rows above it — and if those ever
 * disagree, the "Check" row says so.
 */

type Loc = { id: string; name: string; location_type: string; coa_account_id: string | null; bank_account_id: string | null };
type Row = { row_kind: string; source_table: string | null; debit: number | null; credit: number | null; balance: number | null };

/** Which grid row a posting source belongs to, by direction. */
const GROUPS: { key: string; label: string; sources: string[] | null; dir: "in" | "out" | "net" }[] = [
  { key: "clients", label: "Received from clients", sources: ["invoice_payments"], dir: "net" },
  { key: "transfer", label: "Moved between our accounts", sources: ["bank_transfers", "cash_deposits", "custody_transfers", "cash_withdrawals", "custodian_transfers"], dir: "net" },
  { key: "salaries", label: "Guard salaries paid", sources: ["payslips_disbursement", "payroll_adjustment_settlement"], dir: "net" },
  { key: "expenses", label: "Expenses and payables paid", sources: ["expenses", "expense_settlements", "payable_payments", "cheques"], dir: "net" },
  { key: "advances", label: "Advances to guards", sources: ["advances"], dir: "net" },
  { key: "partners", label: "Partners", sources: ["partner_account_entries"], dir: "net" },
  { key: "other", label: "Everything else", sources: null, dir: "net" },
];
const KNOWN = new Set(GROUPS.flatMap((g) => g.sources ?? []));

export default function AccountsGrid({ period }: { period: string }) {
  const companyId = useCompanyId();
  const drill = useDrill();
  const [locs, setLocs] = useState<Loc[] | null>(null);
  const [data, setData] = useState<Map<string, Row[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const start = monthStart(period), end = monthEnd(period);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setLocs(null); setError(null);
    void (async () => {
      const { data: ls, error: e } = await supabase.from("cash_locations")
        .select("id, name, location_type, coa_account_id, bank_account_id").eq("company_id", companyId).eq("is_active", true);
      if (cancelled) return;
      if (e) { setError(e.message); return; }
      const list = ((ls ?? []) as Loc[]).filter((l) => l.coa_account_id)
        .sort((a, b) => (a.location_type === b.location_type ? a.name.localeCompare(b.name) : a.location_type === "BANK" ? -1 : 1));
      const res = await Promise.all(list.map((l) => supabase.rpc("ledger_statement", { p_company_id: companyId, p_kind: "account", p_subject_id: l.coa_account_id, p_start: start, p_end: end })));
      if (cancelled) return;
      const m = new Map<string, Row[]>();
      res.forEach((r, i) => m.set(list[i].id, (r.data ?? []) as Row[]));
      const failed = res.find((r) => r.error);
      if (failed?.error) setError(failed.error.message);
      setData(m);
      setLocs(list);
    })();
    return () => { cancelled = true; };
  }, [companyId, start, end]);

  const grid = useMemo(() => {
    if (!locs) return null;
    const col = (l: Loc) => {
      const rows = data.get(l.id) ?? [];
      const opening = Number(rows.find((r) => r.row_kind === "OPENING")?.balance ?? 0);
      const closing = Number(rows.find((r) => r.row_kind === "CLOSING")?.balance ?? opening);
      const lines = rows.filter((r) => r.row_kind === "LINE");
      const by: Record<string, number> = {};
      for (const g of GROUPS) {
        by[g.key] = lines.filter((r) => (g.sources ? g.sources.includes(r.source_table ?? "") : !KNOWN.has(r.source_table ?? "")))
          .reduce((n, r) => n + Number(r.debit ?? 0) - Number(r.credit ?? 0), 0);
      }
      const moved = Object.values(by).reduce((a, b) => a + b, 0);
      return { opening, closing, by, check: opening + moved - closing };
    };
    return locs.map((l) => ({ loc: l, ...col(l) }));
  }, [locs, data]);

  if (error && !grid) return <div className="bg-card border border-border rounded-2xl px-5 py-6 text-sm text-danger-700 dark:text-danger-500">{error}</div>;
  if (!grid) return <div className="bg-card border border-border rounded-2xl flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Reading every bank and cash ledger…</div>;

  const total = (f: (c: NonNullable<typeof grid>[number]) => number) => grid.reduce((n, c) => n + f(c), 0);
  const openLedger = (c: NonNullable<typeof grid>[number]) => drill({ type: "ledger", kind: "account", subjectId: c.loc.coa_account_id!, title: `${c.loc.name} — ${monthLabel(period)}`, start, end });
  const short = (n: string) => n.replace(/\s+—\s+\d+$/, "").replace(/ Bank$/, "");
  const cell = "font-ledger text-right whitespace-nowrap px-3 py-2";
  const cols = `minmax(210px,1.6fr) repeat(${grid.length + 1}, minmax(108px,1fr))`;

  const rowsDef: { label: string; get: (c: NonNullable<typeof grid>[number]) => number; strong?: boolean; dark?: boolean; signed?: boolean }[] = [
    { label: "Brought forward", get: (c) => c.opening, strong: true },
    ...GROUPS.map((g) => ({ label: g.label, get: (c: NonNullable<typeof grid>[number]) => c.by[g.key], signed: true })),
    { label: "Closing balance", get: (c) => c.closing, strong: true, dark: true },
  ];

  const doExport = () => exportTable({
    fileName: `Income and withdrawal state ${monthLabel(period)}.xlsx`, sheetName: "Accounts",
    title: `Income & withdrawal state — ${monthLabel(period)} (from the ledger)`,
    headers: ["", ...grid.map((c) => c.loc.name), "Total"],
    rows: rowsDef.map((r) => [r.label, ...grid.map((c) => Math.round(r.get(c))), Math.round(total(r.get))]),
  });

  const fmt = (v: number, signed?: boolean) => (Math.abs(v) < 0.5 ? "—" : signed ? `${v > 0 ? "+" : "−"}${money(Math.abs(Math.round(v)))}` : money(Math.round(v)));
  const imbalance = grid.filter((c) => Math.abs(c.check) >= 1);

  return (
    <section className="bg-card border border-border rounded-[18px] overflow-hidden">
      <div className="px-5 md:px-6 pt-4 pb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="lbl">Income & withdrawal state · from the ledger</p>
          <h2 className="font-display text-xl md:text-[22px] font-bold tracking-tight mt-1">Every account, {monthLabel(period)}</h2>
          <p className="text-[13px] text-muted-foreground mt-1">Banks first, then each cash holder. In is positive, out is negative. Tap a column heading for that account's ledger.</p>
        </div>
        <ExportButton onExport={doExport} />
      </div>
      <div className="overflow-x-auto">
        <div style={{ minWidth: 210 + (grid.length + 1) * 112 }}>
          <div className="grid border-y border-border bg-muted/60 text-xs font-semibold text-muted-foreground" style={{ gridTemplateColumns: cols }}>
            <span className="px-6 py-2.5" />
            {grid.map((c) => (
              <button key={c.loc.id} type="button" onClick={() => openLedger(c)} className="px-3 py-2.5 text-right hover:text-foreground hover:underline flex flex-col items-end">
                <span className="text-foreground truncate max-w-full">{short(c.loc.name)}</span>
                <span className="font-normal">{c.loc.location_type === "BANK" ? "bank" : "cash holder"}</span>
              </button>
            ))}
            <span className="px-3 py-2.5 text-right flex flex-col items-end"><span className="text-foreground">Total</span><span className="font-normal">all accounts</span></span>
          </div>
          {rowsDef.map((r) => (
            <div key={r.label} className={`grid items-center text-sm ${r.dark ? "mx-3 my-1.5 rounded-xl bg-[#191a10] text-[#f3eee2] font-semibold" : r.strong ? "border-t border-foreground/60 font-semibold" : "border-t border-border/70 hover:bg-muted/40"}`} style={{ gridTemplateColumns: cols }}>
              <span className={`py-2 ${r.dark ? "px-3" : "px-6"}`}>{r.label}</span>
              {grid.map((c) => {
                const v = r.get(c);
                return (
                  <button key={c.loc.id} type="button" onClick={() => openLedger(c)}
                    className={`${cell} rounded-md hover:underline ${r.signed && v < 0 ? (r.dark ? "text-[#f0a99a]" : "text-danger-700 dark:text-danger-500") : ""} ${Math.abs(v) < 0.5 ? "opacity-50" : ""}`}>
                    {fmt(v, r.signed)}
                  </button>
                );
              })}
              <span className={`${cell} font-semibold`}>{fmt(total(r.get), r.signed)}</span>
            </div>
          ))}
          <div className="grid items-center text-xs text-muted-foreground border-t border-border" style={{ gridTemplateColumns: cols }}>
            <span className="px-6 py-2">Check: brought forward + movements − closing</span>
            {grid.map((c) => <span key={c.loc.id} className={`${cell} ${Math.abs(c.check) >= 1 ? "text-danger-700 dark:text-danger-500 font-semibold" : ""}`}>{Math.abs(c.check) < 1 ? "✓" : fmt(c.check, true)}</span>)}
            <span className={cell}>{imbalance.length ? `${imbalance.length} off` : "✓"}</span>
          </div>
        </div>
      </div>
      <div className="h-2" />
    </section>
  );
}
