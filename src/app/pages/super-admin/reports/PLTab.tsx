import { Fragment, useCallback, useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase";
import { useAuth, hasPermission } from "../../../lib/auth";
import { Loader2 } from "lucide-react";
import ExportButton from "../../../components/ExportButton";
import { exportTable } from "../../../lib/excel";
import { useRegion } from "../../../lib/region";
import { monthEnd, monthLabel, monthStart, money, useCompanyId, useDrill, type DrillTarget } from "./kit";
import { loadPL, ranges, type Basis, type Compare, type PL, type PLSection } from "./usePL";

/**
 * Profit & loss on either basis, with a comparison column, change and share of
 * revenue; beside it, where every 100 rupees of revenue went and the lines that
 * moved most. Every revenue-basis line opens to its journal lines; every
 * cash-basis line opens to what the client statement counts in it.
 */

const SEC_COLOR: Record<PLSection["key"], string> = { rev: "#2f5d8a", cos: "#7a4f0e", opex: "#e9a73c", tax: "#a3392a" };
const pct = (n: number) => (isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—");
const sgn = (n: number) => (Math.abs(n) < 0.5 ? "—" : `${n > 0 ? "+" : "−"}${Math.abs(Math.round(n)).toLocaleString()}`);

export const cmpTitle = (period: string, cmp: Compare) => {
  const r = ranges(period, cmp);
  return {
    cur: r.ytd ? `Jan–${monthLabel(period).split(" ")[0].slice(0, 3)} ${period.slice(0, 4)}` : monthLabel(period),
    cmp: r.ytd ? `Jan–${monthLabel(r.cmpLabel).split(" ")[0].slice(0, 3)} ${r.cmpLabel.slice(0, 4)}` : monthLabel(r.cmpLabel),
  };
};

export default function PLTab({ period, basis, cmp, pl, loading, error }: {
  period: string; basis: Basis; cmp: Compare; pl: { cur: PL | null; cmp: PL | null }; loading: boolean; error: string | null;
}) {
  const drill = useDrill();
  const { regionId, regions } = useRegion();
  const companyId = useCompanyId();
  const { profile } = useAuth();
  const r = ranges(period, cmp);
  const titles = cmpTitle(period, cmp);

  // BUDGET (0528). Revenue basis only — a budget is per ledger account. The
  // second column becomes the budget and the change becomes the variance.
  // planning.edit can type a figure into a line for a single month, saved for
  // the region in view (or the whole company).
  const canBudget = hasPermission(profile, "planning.view") || hasPermission(profile, "planning.edit");
  const canEditBudget = hasPermission(profile, "planning.edit") && !r.ytd;
  const [vsBudget, setVsBudget] = useState(false);
  const [budget, setBudget] = useState<Map<string, { amount: number; ids: string[] }>>(new Map());
  const [acctId, setAcctId] = useState<Map<string, string>>(new Map());
  const [budgetErr, setBudgetErr] = useState<string | null>(null);
  const showBudget = vsBudget && basis === "revenue" && canBudget;
  const loadBudget = useCallback(async () => {
    if (!companyId || !showBudget) return;
    const [bl, ca] = await Promise.all([
      supabase.from("budget_lines").select("id, amount, branch_id, account:account_id(account_code)")
        .eq("company_id", companyId).gte("period_month", monthStart(r.cur[0])).lte("period_month", monthStart(r.cur[1])),
      supabase.from("chart_of_accounts").select("id, account_code").eq("company_id", companyId),
    ]);
    if (bl.error) { setBudgetErr(bl.error.message); return; }
    const m = new Map<string, { amount: number; ids: string[] }>();
    for (const row of (bl.data ?? []) as unknown as { id: string; amount: number; branch_id: string | null; account: { account_code: string } | null }[]) {
      // A region's view reads that region's lines; the company view reads all.
      if (regionId && row.branch_id !== regionId) continue;
      const code = row.account?.account_code;
      if (!code) continue;
      const cur = m.get(code) ?? { amount: 0, ids: [] };
      cur.amount += Number(row.amount); cur.ids.push(row.id); m.set(code, cur);
    }
    setBudget(m);
    setAcctId(new Map(((ca.data ?? []) as { id: string; account_code: string }[]).map((a) => [a.account_code, a.id])));
    setBudgetErr(null);
  }, [companyId, showBudget, r.cur[0], r.cur[1], regionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadBudget(); }, [loadBudget]);

  // BY REGION (2026-10-21): every region's statement side by side, each read
  // with the same loader as the statement itself, filtered to that region,
  // and the company's total beside them.
  const [byRegion, setByRegion] = useState(false);
  const [regionPL, setRegionPL] = useState<{ id: string; name: string; pl: PL }[] | null>(null);
  const [companyPL, setCompanyPL] = useState<PL | null>(null);
  useEffect(() => {
    if (!byRegion || !companyId) return;
    let cancelled = false;
    setRegionPL(null);
    const list = [...regions].sort((a, b) => Number(a.is_head_office) - Number(b.is_head_office) || a.name.localeCompare(b.name));
    void Promise.all([
      ...list.map((g) => loadPL(companyId, basis, r.cur[0], r.cur[1], g.id).then((pl) => ({ id: g.id, name: g.name, pl }))),
    ]).then(async (rs) => {
      const total = await loadPL(companyId, basis, r.cur[0], r.cur[1], null);
      if (!cancelled) { setRegionPL(rs); setCompanyPL(total); }
    }).catch(() => { if (!cancelled) setRegionPL([]); });
    return () => { cancelled = true; };
  }, [byRegion, companyId, basis, r.cur[0], r.cur[1], regions]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveBudget = async (code: string, raw: string) => {
    if (!companyId) return;
    const v = raw.trim() === "" ? null : Number(raw.replace(/[^0-9.-]/g, ""));
    const id = acctId.get(code);
    if (!id || (v != null && !isFinite(v))) return;
    const month = monthStart(period);
    let q = supabase.from("budget_lines").select("id").eq("company_id", companyId).eq("period_month", month).eq("account_id", id);
    q = regionId ? q.eq("branch_id", regionId) : q.is("branch_id", null);
    const { data: found } = await q.maybeSingle();
    const res = v == null
      ? (found ? await supabase.from("budget_lines").delete().eq("id", (found as { id: string }).id) : { error: null })
      : found
        ? await supabase.from("budget_lines").update({ amount: v }).eq("id", (found as { id: string }).id)
        : await supabase.from("budget_lines").insert({ company_id: companyId, period_month: month, account_id: id, branch_id: regionId ?? null, amount: v });
    if (res.error) { setBudgetErr(res.error.message); return; }
    await loadBudget();
  };
  if (error) return <div className="bg-card border border-border rounded-2xl px-5 py-6 text-sm text-danger-700 dark:text-danger-500">{error}</div>;
  if (loading || !pl.cur || !pl.cmp) return <div className="bg-card border border-border rounded-2xl flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Reading the {basis === "cash" ? "client statement" : "general ledger"}…</div>;
  const cur = pl.cur, prv = pl.cmp;
  const start = monthStart(r.cur[0]), end = monthEnd(r.cur[1]);

  const lineOf = (sec: PLSection["key"], key: string) => {
    if (showBudget) {
      const code = cur.sections.find((s) => s.key === sec)?.lines.find((l) => l.key === key)?.code;
      return code ? budget.get(code)?.amount ?? 0 : 0;
    }
    return prv.sections.find((s) => s.key === sec)?.lines.find((l) => l.key === key)?.value ?? 0;
  };
  const secTotalB = (sec: PLSection["key"]) => (showBudget ? (cur.sections.find((s) => s.key === sec)?.lines ?? []).reduce((n, l) => n + lineOf(sec, l.key), 0) : null);
  const bRev = secTotalB("rev"), bCos = secTotalB("cos"), bOpex = secTotalB("opex"), bTax = secTotalB("tax");
  const cmpTot = showBudget
    ? { gross: bRev! - bCos!, operating: bRev! - bCos! - bOpex!, net: bRev! - bCos! - bOpex! - bTax! }
    : { gross: prv.gross, operating: prv.operating, net: prv.net };
  const cmpHead = showBudget ? `Budget${r.ytd ? "" : ` · ${monthLabel(period).split(" ")[0]}`}` : titles.cmp;
  const open = (sec: PLSection, l: { key: string; label: string; value: number; code?: string }): DrillTarget =>
    basis === "revenue" && l.code
      ? { type: "gl", title: `${l.code} ${l.label} — ${titles.cur}`, start, end, accountCodes: [l.code], branchId: regionId ?? undefined, note: "Every journal line on this account in the period — the figure is their net." }
      : { type: "composition", title: `${l.label} — ${titles.cur}, cash basis`, explanation: "Cash basis, from the client statement: money received, payroll disbursed and expenses paid in the period, with regional overhead and head office as currently set. Open Client profit to see it client by client.", rows: [{ label: l.label, value: l.value }, { label: `Same line, ${titles.cmp}`, value: lineOf(sec.key, l.key) }] };

  const totalRow = (label: string, a: number, b: number, big: boolean, cost = false) => {
    const d = a - b;
    const good = (d > 0) !== cost;
    return (
      <tr key={label} className={big ? "" : "border-t border-border"}>
        <td colSpan={5} className={big ? "px-3 py-1.5" : "p-0"}>
          <div className={`grid grid-cols-[minmax(220px,2.2fr)_repeat(4,minmax(110px,1fr))] gap-3 items-center font-semibold text-sm ${big ? "rounded-xl bg-ink text-ink-foreground px-4 py-3" : "px-6 py-2.5"}`}>
            <span>{label}</span>
            <span className="font-ledger text-right">{money(a)}</span>
            <span className={`font-ledger text-right ${big ? "opacity-70" : "text-muted-foreground"}`}>{money(b)}</span>
            <span className={`font-ledger text-right ${Math.abs(d) < 0.5 ? "opacity-60" : good ? (big ? "text-up" : "text-success-700 dark:text-success-500") : big ? "text-down" : "text-danger-700 dark:text-danger-500"}`}>{sgn(d)}</span>
            <span className={`font-ledger text-right ${big ? "opacity-70" : "text-muted-foreground"}`}>{pct(a / (cur.revenue || 1))}</span>
          </div>
        </td>
      </tr>
    );
  };

  // Every line with its comparison, for the movers list.
  const movers = cur.sections.flatMap((s) => s.lines.map((l) => ({ s, l, d: l.value - lineOf(s.key, l.key), b: lineOf(s.key, l.key) })))
    .filter((x) => Math.abs(x.d) >= 1).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 6);
  const split = [
    { label: basis === "cash" ? "Direct costs" : "Cost of services", v: cur.cos, c: "#7a4f0e" },
    { label: basis === "cash" ? "Overheads" : "Operating expenses", v: cur.opex, c: "#e9a73c" },
    ...(cur.tax ? [{ label: "Income tax", v: cur.tax, c: "#a3392a" }] : []),
    { label: cur.net >= 0 ? "Profit" : "Loss", v: Math.abs(cur.net), c: cur.net >= 0 ? "#3d4a2b" : "#a3392a" },
  ];

  const doExport = () => exportTable({
    fileName: `Profit and loss ${titles.cur} (${basis}).xlsx`, sheetName: "P&L",
    title: `Profit and loss — ${titles.cur}, ${basis === "cash" ? "cash" : "revenue"} basis, against ${titles.cmp}`,
    headers: ["Section", "Line", titles.cur, titles.cmp, "Change"],
    rows: [
      ...cur.sections.flatMap((s) => s.lines.map((l) => [s.title, `${l.code ? `${l.code} ` : ""}${l.label}`, l.value, lineOf(s.key, l.key), l.value - lineOf(s.key, l.key)])),
      ["", "Gross profit", cur.gross, prv.gross, cur.gross - prv.gross],
      ["", "Operating profit", cur.operating, prv.operating, cur.operating - prv.operating],
      ["", "Net profit", cur.net, prv.net, cur.net - prv.net],
    ],
  });

  return (
    <div className="flex flex-wrap gap-4 md:gap-5 items-start">
      <section className="flex-[2_1_640px] min-w-0 bg-card border border-border rounded-[18px] overflow-hidden">
        <div className="px-5 md:px-6 pt-4 pb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="lbl">Statement · {basis === "cash" ? "cash basis" : "revenue basis, from the general ledger"}</p>
            <h2 className="font-display text-xl md:text-[22px] font-bold tracking-tight mt-1">Line by line</h2>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-xl border border-border p-0.5 text-xs font-semibold">
              <button type="button" onClick={() => { setVsBudget(false); setByRegion(false); }} className={`px-2.5 py-1 rounded-lg ${!vsBudget && !byRegion ? "bg-muted text-foreground" : "text-muted-foreground"}`}>vs {titles.cmp}</button>
              {basis === "revenue" && canBudget && <button type="button" onClick={() => { setVsBudget(true); setByRegion(false); }} className={`px-2.5 py-1 rounded-lg ${vsBudget && !byRegion ? "bg-muted text-foreground" : "text-muted-foreground"}`}>vs budget</button>}
              {regions.length > 1 && <button type="button" onClick={() => setByRegion(true)} className={`px-2.5 py-1 rounded-lg ${byRegion ? "bg-muted text-foreground" : "text-muted-foreground"}`}>By region</button>}
            </div>
            <ExportButton onExport={doExport} />
          </div>
        </div>
        {showBudget && (
          <p className="px-5 md:px-6 pb-2 text-xs text-muted-foreground">
            {budgetErr ? <span className="text-danger-700 dark:text-danger-500">{budgetErr}</span>
              : canEditBudget ? `Type a budget into any line — saved for ${monthLabel(period)}${regionId ? ", this region" : ", the whole company"}. Leave it empty to clear it.`
              : r.ytd ? "Year to date sums each month's budget; switch to a single month to edit." : "Budget figures are set by people with planning access."}
          </p>
        )}
        {byRegion ? (
          !regionPL || !companyPL ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Reading every region…</div>
          ) : (() => {
            const cols = [...regionPL.map((x) => ({ key: x.id, name: x.name, pl: x.pl })), { key: "total", name: "Company", pl: companyPL }];
            const grid = { gridTemplateColumns: `minmax(220px,2fr) repeat(${cols.length}, minmax(110px,1fr))` };
            const valOf = (pl: PL, sec: PLSection["key"], key: string) => pl.sections.find((x) => x.key === sec)?.lines.find((l) => l.key === key)?.value ?? 0;
            const tot = (label: string, f: (pl: PL) => number, ink = false) => (
              <div key={label} className={`grid gap-3 items-center font-semibold text-sm ${ink ? "mx-3 my-1 rounded-xl bg-ink text-ink-foreground px-3 py-2.5" : "px-6 py-2 border-t border-border"}`} style={grid}>
                <span>{label}</span>
                {cols.map((c) => <span key={c.key} className={`font-ledger text-right ${f(c.pl) < 0 ? (ink ? "text-down" : "text-danger-700 dark:text-danger-500") : ""}`}>{money(f(c.pl))}</span>)}
              </div>
            );
            return (
              <div className="overflow-x-auto pb-2">
                <div style={{ minWidth: 220 + cols.length * 122 }}>
                  <div className="grid gap-3 px-6 py-2.5 bg-muted/60 border-y border-border text-xs font-semibold text-muted-foreground" style={grid}>
                    <span>Line · {titles.cur}</span>
                    {cols.map((c) => <span key={c.key} className={`text-right truncate ${c.key === "total" ? "text-foreground" : ""}`}>{c.name}</span>)}
                  </div>
                  {companyPL.sections.filter((x) => x.lines.length > 0).map((sec) => (
                    <Fragment key={sec.key}>
                      <div className="px-6 pt-3 pb-1"><span className="inline-flex items-center gap-2"><span className="w-2 h-2 rounded-sm" style={{ background: SEC_COLOR[sec.key] }} /><span className="lbl text-foreground">{sec.title}</span></span></div>
                      {sec.lines.map((l) => (
                        <div key={l.key} className="grid gap-3 items-center px-6 pl-9 py-1 text-sm hover:bg-muted/40" style={grid}>
                          <span className="truncate">{l.code && <span className="font-ledger text-xs text-muted-foreground mr-2">{l.code}</span>}{l.label}</span>
                          {cols.map((c) => <span key={c.key} className={`font-ledger text-right ${c.key === "total" ? "font-semibold" : "text-muted-foreground"}`}>{money(valOf(c.pl, sec.key, l.key))}</span>)}
                        </div>
                      ))}
                    </Fragment>
                  ))}
                  {tot("Revenue", (pl) => pl.revenue)}
                  {tot("Gross profit", (pl) => pl.gross)}
                  {tot(basis === "cash" ? "Cash profit before tax" : "Operating profit", (pl) => pl.operating)}
                  {tot(basis === "cash" ? "Cash profit" : "Net profit", (pl) => pl.net, true)}
                  <div className="grid gap-3 items-center px-6 py-2 text-xs text-muted-foreground" style={grid}>
                    <span>Net margin</span>
                    {cols.map((c) => <span key={c.key} className="font-ledger text-right">{pct(c.pl.net / (c.pl.revenue || 1))}</span>)}
                  </div>
                  <p className="px-6 pt-1 text-[11px] text-muted-foreground">Each region is its own ledger lines (and head office its own). The company column is the whole ledger; regional columns may not add to it exactly where a line carries no region.</p>
                </div>
              </div>
            );
          })()
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr><td colSpan={5} className="p-0">
                <div className="grid grid-cols-[minmax(220px,2.2fr)_repeat(4,minmax(110px,1fr))] gap-3 px-6 py-2.5 bg-muted/60 border-y border-border text-xs font-semibold text-muted-foreground">
                  <span>Line</span><span className="text-right">{titles.cur}</span><span className="text-right">{cmpHead}</span><span className="text-right">{showBudget ? "vs budget" : "Change"}</span><span className="text-right">% of revenue</span>
                </div>
              </td></tr>
            </thead>
            <tbody>
              {cur.sections.filter((s) => s.lines.length > 0 || s.key === "rev").map((s) => {
                const a = s.lines.reduce((n, l) => n + l.value, 0);
                const b = showBudget ? secTotalB(s.key) ?? 0 : prv.sections.find((x) => x.key === s.key)?.lines.reduce((n, l) => n + l.value, 0) ?? 0;
                return (
                  <Fragment key={s.key}>
                    <tr><td colSpan={5} className="px-6 pt-4 pb-1.5"><span className="inline-flex items-center gap-2"><span className="w-2 h-2 rounded-sm" style={{ background: SEC_COLOR[s.key] }} /><span className="lbl text-foreground">{s.title}</span></span></td></tr>
                    {s.lines.length === 0 && <tr><td colSpan={5} className="px-9 py-1.5 text-xs text-muted-foreground">Nothing posted.</td></tr>}
                    {s.lines.map((l) => {
                      const bb = lineOf(s.key, l.key), d = l.value - bb, good = (d > 0) !== s.cost;
                      const share = l.value / (cur.revenue || 1);
                      return (
                        <tr key={l.key}><td colSpan={5} className="p-0">
                          <div className="grid grid-cols-[minmax(220px,2.2fr)_repeat(4,minmax(110px,1fr))] gap-3 items-center px-6 pl-9 py-1 hover:bg-muted/40">
                            <span className="min-w-0 truncate">{l.code && <span className="font-ledger text-xs text-muted-foreground mr-2">{l.code}</span>}{l.label}</span>
                            <button type="button" onClick={() => drill(open(s, l))} className="font-ledger text-right rounded-md px-1 py-1 hover:bg-brand-100 hover:underline">{money(l.value)}</button>
                            {showBudget && canEditBudget && l.code ? (
                              <input
                                key={`${l.code}-${bb}`}
                                defaultValue={bb ? String(Math.round(bb)) : ""}
                                placeholder="—"
                                inputMode="decimal"
                                aria-label={`Budget for ${l.label}`}
                                onBlur={(e) => { if (e.target.value !== (bb ? String(Math.round(bb)) : "")) void saveBudget(l.code!, e.target.value); }}
                                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                className="font-ledger text-right bg-transparent border border-transparent hover:border-border focus:border-brand-500 rounded-md px-1 py-0.5 w-full text-muted-foreground focus:text-foreground outline-none"
                              />
                            ) : (
                              <span className="font-ledger text-right text-muted-foreground">{money(bb)}</span>
                            )}
                            <span className={`font-ledger text-right ${Math.abs(d) < 0.5 ? "text-muted-foreground" : good ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"}`}>{sgn(d)}</span>
                            <span className="flex items-center justify-end gap-2"><span className="w-12 h-1.5 rounded-full bg-muted overflow-hidden"><span className="block h-full" style={{ width: `${Math.min(100, Math.abs(share) * 100)}%`, background: SEC_COLOR[s.key] }} /></span><span className="font-ledger text-xs text-muted-foreground w-12 text-right">{pct(share)}</span></span>
                          </div>
                        </td></tr>
                      );
                    })}
                    {totalRow(`Total ${s.title.toLowerCase()}`, a, b, false, s.cost)}
                    {s.key === "cos" && totalRow("Gross profit", cur.gross, cmpTot.gross, true)}
                    {s.key === "opex" && totalRow(basis === "cash" ? "Cash profit before tax" : "Operating profit", cur.operating, cmpTot.operating, true)}
                  </Fragment>
                );
              })}
              {totalRow(basis === "cash" ? "Cash profit" : "Net profit", cur.net, cmpTot.net, true)}
            </tbody>
          </table>
        </div>
        )}
        <div className="h-3" />
      </section>

      <div className="flex-[1_1_320px] min-w-0 flex flex-col gap-4 md:gap-5">
        <section className="bg-card border border-border rounded-[18px] p-5 flex flex-col gap-3">
          <p className="lbl">Where every 100 rupees went</p>
          <div className="flex h-7 rounded-lg overflow-hidden bg-muted">
            {split.map((x) => <span key={x.label} title={x.label} className="h-full" style={{ width: `${Math.max(0, (x.v / Math.max(1, cur.revenue)) * 100)}%`, background: x.c }} />)}
          </div>
          {split.map((x) => (
            <div key={x.label} className="grid grid-cols-[12px_minmax(0,1fr)_64px] gap-2.5 items-center text-[13px]">
              <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: x.c }} /><span>{x.label}</span>
              <span className="font-ledger text-right font-semibold">{((x.v / Math.max(1, cur.revenue)) * 100).toFixed(1)}</span>
            </div>
          ))}
        </section>
        <section className="bg-card border border-border rounded-[18px] p-5 flex flex-col gap-1">
          <p className="lbl mb-2">{showBudget ? "Furthest from budget" : `Biggest moves against ${titles.cmp}`}</p>
          {movers.length === 0 && <p className="text-sm text-muted-foreground">No line moved.</p>}
          {movers.map(({ s, l, d, b }) => (
            <button key={`${s.key}-${l.key}`} type="button" onClick={() => drill(open(s, l))} className="group grid grid-cols-[minmax(0,1fr)_110px] gap-2 items-center min-h-11 border-t border-border/70 text-left text-sm">
              <span className="min-w-0"><span className="block truncate group-hover:underline">{l.label}</span><span className="text-xs text-muted-foreground">{b ? `${((d / Math.abs(b)) * 100).toFixed(1)}% ${d > 0 ? (showBudget ? "over" : "up") : (showBudget ? "under" : "down")}` : showBudget ? "no budget set" : "new this period"}</span></span>
              <span className={`font-ledger text-right font-semibold ${(d > 0) !== s.cost ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"}`}>{sgn(d)}</span>
            </button>
          ))}
        </section>
      </div>
    </div>
  );
}
