import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronDown, Loader2 } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

/**
 * REGIONAL PERFORMANCE — item 2.
 *
 * TWO DIMENSIONS WERE BEING EXPRESSED AS FIVE TABS: revenue-basis P&L,
 * revenue-basis client profitability, cash-basis P&L, cash-basis client
 * profitability, and a separate Regional Overhead Expenses tab. But basis is a
 * TOGGLE and P&L / region / client is a LEVEL OF DETAIL. This is one view with
 * one basis control and a drill-down.
 *
 * THE COLUMN NAMES ARE THE POINT, not decoration. "Region cost" previously
 * meant either own cost or own-plus-head-office depending on which screen you
 * were reading, and that ambiguity is what produced the head office
 * double-charge. So the columns are named and they add up:
 *
 *     Own cost + HO allocated = Total cost      Revenue − Total cost = Net
 *
 * THE DRIVER IS SHOWN BESIDE EVERY ALLOCATED FIGURE — the percentage and what
 * it is a percentage OF. Nobody should have to ask how an allocation was
 * reached, and after 0349 the answer is the same on both bases: invoiced
 * revenue. Showing it is also how a reader notices that the cash-basis view
 * apportions by invoiced figures, which is deliberate and otherwise invisible.
 *
 * NOTHING HERE COMPUTES A FIGURE THE LEDGER ALREADY HOLDS. Regions come from
 * regional_pl_range, the head-office split from ho_exclusion_preview (0353,
 * which honours ho_excluded and uses the 0349 driver), clients from
 * client_statement_loaded. The only arithmetic is adding named columns that
 * are displayed beside their total — the footer exception in CLAUDE.md.
 */

type RegionRow = {
  branch_id: string;
  region_name: string;
  revenue: number;
  own_cost: number;
  ho_allocated: number;
  invoiced: number;
  excluded: boolean;
};

type ClientRow = {
  client_id: string;
  client_name: string;
  branch_id: string | null;
  revenue: number;
  direct_payroll: number;
  direct_expenses: number;
  regional_overhead: number;
  ho_share: number;
  net: number;
};

const money = (n: number) =>
  `PKR ${Math.round(n).toLocaleString()}`;

const firstOf = (ym: string) => `${ym}-01`;
const lastOf = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function RegionalPerformance() {
  const { profile, company } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;

  const [basis, setBasis] = useState<"revenue" | "cash">("revenue");
  const [period, setPeriod] = useState<string>(thisMonth());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [regions, setRegions] = useState<RegionRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [pool, setPool] = useState<number>(0);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const start = firstOf(period);
      const end = lastOf(period);

      const [pl, prev, cs] = await Promise.all([
        supabase.rpc("regional_pl_range", { p_start: start, p_end: end }),
        supabase.rpc("ho_exclusion_preview", {
          p_company_id: companyId, p_period: start, p_excluded: null,
        }),
        supabase.rpc("client_statement_loaded", {
          p_start: start, p_end: end, p_basis: basis, p_company_id: companyId,
        }),
      ]);
      if (pl.error) throw pl.error;
      if (prev.error) throw prev.error;
      if (cs.error) throw cs.error;

      const alloc = new Map<string, { absorbs: number; invoiced: number; excluded: boolean }>();
      for (const r of (prev.data ?? []) as any[]) {
        alloc.set(r.branch_id, {
          absorbs: Number(r.absorbs_now ?? 0),
          invoiced: Number(r.invoiced ?? 0),
          excluded: !!r.excluded_now,
        });
      }

      const rows: RegionRow[] = [];
      let hoPool = 0;
      for (const r of (pl.data ?? []) as any[]) {
        const isHo = !alloc.has(r.branch_id);   // preview omits head office
        const revenue = basis === "cash" ? Number(r.revenue_cash ?? 0) : Number(r.revenue_accrual ?? 0);
        const payroll = basis === "cash" ? Number(r.payroll_cash ?? 0) : Number(r.payroll_accrual ?? 0);
        const expenses = basis === "cash" ? Number(r.expenses_cash ?? 0) : Number(r.expenses_accrual ?? 0);
        if (isHo) {
          // Head office is the GIVER of the pool. Its own cost less its own
          // revenue is what gets spread; it is shown above the table, not as a
          // region row, because it is not absorbing anything.
          hoPool += payroll + expenses - revenue;
          continue;
        }
        const a = alloc.get(r.branch_id)!;
        rows.push({
          branch_id: r.branch_id,
          region_name: r.region_name ?? "Unassigned",
          revenue,
          own_cost: payroll + expenses,
          ho_allocated: a.absorbs,
          invoiced: a.invoiced,
          excluded: a.excluded,
        });
      }

      setRegions(rows);
      setClients((cs.data ?? []) as ClientRow[]);
      // The pool as SPREAD, which is what the region rows sum to. Where that
      // differs from head office's own net cost, the banner below says so
      // rather than quietly showing whichever is larger.
      setPool(rows.reduce((s, r) => s + r.ho_allocated, 0) || hoPool);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [companyId, period, basis]);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    const revenue = regions.reduce((s, r) => s + r.revenue, 0);
    const own = regions.reduce((s, r) => s + r.own_cost, 0);
    const ho = regions.reduce((s, r) => s + r.ho_allocated, 0);
    const drv = regions.reduce((s, r) => s + (r.excluded ? 0 : r.invoiced), 0);
    return { revenue, own, ho, total: own + ho, net: revenue - own - ho, drv };
  }, [regions]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const driverLabel = (r: RegionRow) => {
    if (r.excluded) return "excluded";
    if (totals.drv <= 0) return "no invoiced revenue";
    return `${((r.invoiced / totals.drv) * 100).toFixed(1)}% of invoiced revenue`;
  };

  if (!companyId) {
    return <p className="text-sm text-slate-600 p-6">Select a company to see regional performance.</p>;
  }

  return (
    <div className="space-y-6">
      {/* ONE basis control, at the top. Not one per tab — switching basis must
          never move a control, and it must never mean re-finding your place. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-lg text-slate-900">Regional Performance</h3>
          <p className="text-sm text-slate-500">
            {basis === "cash" ? "Cash basis" : "Revenue basis"} · {period}
            {" · "}
            <span className="text-slate-400">
              cost is apportioned by invoiced revenue on both bases
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
            {(["revenue", "cash"] as const).map((b) => (
              <button
                key={b}
                onClick={() => setBasis(b)}
                className={`px-3 py-2 text-sm ${basis === b ? "bg-brand-600 text-[#fff]" : "text-slate-600 hover:bg-slate-50"}`}
              >
                {b === "revenue" ? "Revenue" : "Cash"}
              </button>
            ))}
          </div>
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          />
        </div>
      </div>

      {error && <p className="text-sm text-danger-600 whitespace-pre-line">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
      ) : (
        <>
          {/* THE POOL, AND ITS SHARES, SO THEY VISIBLY SUM TO IT. */}
          <div className="border border-slate-200 rounded-lg p-5">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Head office pool</p>
            <p className="text-2xl text-slate-900 tabular-nums">{money(pool)}</p>
            <div className="mt-4 space-y-1">
              {regions.map((r) => (
                <div key={r.branch_id} className="flex justify-between text-sm">
                  <span className="text-slate-600">
                    {r.region_name}
                    <span className="ml-2 text-[11px] text-slate-400">{driverLabel(r)}</span>
                  </span>
                  <span className="tabular-nums text-slate-800">{money(r.ho_allocated)}</span>
                </div>
              ))}
              <div className="flex justify-between text-sm pt-2 mt-2 border-t border-slate-200">
                <span className="text-slate-900">Allocated</span>
                <span className="tabular-nums text-slate-900 font-medium">{money(totals.ho)}</span>
              </div>
              {Math.abs(totals.ho - pool) >= 1 && (
                <p className="text-xs text-warning-700 pt-2">
                  {money(Math.abs(pool - totals.ho))} of the pool is not allocated to any region.
                  That happens when no region has invoiced revenue in the month — the shares cannot
                  be computed, so the cost is stranded rather than spread.
                </p>
              )}
            </div>
          </div>

          {/* NAMED COLUMNS THAT ADD UP. */}
          <div className="border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-white">
                  <th className="text-left px-4 py-2 text-[11px] uppercase text-slate-400">Region</th>
                  <th className="text-right px-4 py-2 text-[11px] uppercase text-slate-400">Revenue</th>
                  <th className="text-right px-4 py-2 text-[11px] uppercase text-slate-400">Own cost</th>
                  <th className="text-right px-4 py-2 text-[11px] uppercase text-slate-400">HO allocated</th>
                  <th className="text-right px-4 py-2 text-[11px] uppercase text-slate-400">Total cost</th>
                  <th className="text-right px-4 py-2 text-[11px] uppercase text-slate-400">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {regions.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">No regions.</td></tr>
                )}
                {regions.map((r) => {
                  const total = r.own_cost + r.ho_allocated;
                  const net = r.revenue - total;
                  const kids = clients.filter((c) => c.branch_id === r.branch_id);
                  const isOpen = open.has(r.branch_id);
                  return (
                    <>
                      <tr key={r.branch_id} className="hover:bg-slate-50 cursor-pointer" onClick={() => toggle(r.branch_id)}>
                        <td className="px-4 py-2 text-sm text-slate-900">
                          <span className="inline-flex items-center gap-1">
                            {isOpen ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                            {r.region_name}
                            {r.excluded && (
                              <span className="ml-1 text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                                HO excluded
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right text-sm tabular-nums">{money(r.revenue)}</td>
                        <td className="px-4 py-2 text-right text-sm tabular-nums">{money(r.own_cost)}</td>
                        <td className="px-4 py-2 text-right text-sm tabular-nums">
                          {money(r.ho_allocated)}
                          <span className="block text-[10px] text-slate-400">{driverLabel(r)}</span>
                        </td>
                        <td className="px-4 py-2 text-right text-sm tabular-nums">{money(total)}</td>
                        <td className={`px-4 py-2 text-right text-sm tabular-nums font-medium ${net < 0 ? "text-danger-700" : "text-slate-900"}`}>
                          {money(net)}
                        </td>
                      </tr>
                      {isOpen && kids.length === 0 && (
                        <tr key={`${r.branch_id}-none`} className="bg-slate-50">
                          <td colSpan={6} className="px-10 py-2 text-xs text-slate-500">No clients in this region for the period.</td>
                        </tr>
                      )}
                      {isOpen && kids.map((c) => {
                        const own = c.direct_payroll + c.direct_expenses + c.regional_overhead;
                        const tot = own + c.ho_share;
                        return (
                          <tr key={`${r.branch_id}-${c.client_id}`} className="bg-slate-50">
                            <td className="px-10 py-2 text-sm text-slate-700">{c.client_name}</td>
                            <td className="px-4 py-2 text-right text-sm tabular-nums text-slate-700">{money(c.revenue)}</td>
                            <td className="px-4 py-2 text-right text-sm tabular-nums text-slate-700">{money(own)}</td>
                            <td className="px-4 py-2 text-right text-sm tabular-nums text-slate-700">{money(c.ho_share)}</td>
                            <td className="px-4 py-2 text-right text-sm tabular-nums text-slate-700">{money(tot)}</td>
                            <td className={`px-4 py-2 text-right text-sm tabular-nums ${c.net < 0 ? "text-danger-700" : "text-slate-800"}`}>
                              {money(c.net)}
                            </td>
                          </tr>
                        );
                      })}
                    </>
                  );
                })}
              </tbody>
              {regions.length > 0 && (
                <tfoot>
                  {/* Folded from the rows above, per CLAUDE.md's stated
                      exception: a footer that is fetched separately can
                      contradict its own table. */}
                  <tr className="border-t-2 border-slate-300 bg-slate-50">
                    <td className="px-4 py-2 text-sm text-slate-900">Total</td>
                    <td className="px-4 py-2 text-right text-sm tabular-nums font-medium">{money(totals.revenue)}</td>
                    <td className="px-4 py-2 text-right text-sm tabular-nums font-medium">{money(totals.own)}</td>
                    <td className="px-4 py-2 text-right text-sm tabular-nums font-medium">{money(totals.ho)}</td>
                    <td className="px-4 py-2 text-right text-sm tabular-nums font-medium">{money(totals.total)}</td>
                    <td className={`px-4 py-2 text-right text-sm tabular-nums font-semibold ${totals.net < 0 ? "text-danger-700" : "text-slate-900"}`}>
                      {money(totals.net)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
    </div>
  );
}
