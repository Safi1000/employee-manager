import { useCallback, useEffect, useState } from "react";
import Header from "../../components/Header";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";

// §22 Regional scorecard + KPI department dashboard — one card per region with
// coverage, incidents, no-shows, receivables, profit and inter-region balance,
// plus the department KPI traffic-light roll-up.

const money = (n: any) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function RegionalScorecard() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [cards, setCards] = useState<any[]>([]);
  const [kpis, setKpis] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [sc, kd] = await Promise.all([
      supabase.from("regional_scorecard").select("*").eq("company_id", companyId),
      supabase.from("kpi_department_dashboard").select("*").eq("company_id", companyId).order("period_month", { ascending: false }),
    ]);
    setCards(sc.data ?? []);
    setKpis(kd.data ?? []);
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header title="Regional Scorecard" subtitle="Per-region operating & financial health (§22)" />

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
        {cards.map((c) => {
          const profitUp = Number(c.profit_ytd ?? 0) >= Number(c.profit_prior_year ?? 0);
          return (
            <div key={c.branch_id} className="border border-slate-200 rounded-md p-4 bg-white space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-slate-900 font-medium">{c.region_name}</h3>
                <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{String(c.region_kind)}</span>
              </div>
              <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
                <Metric label="Active headcount" value={c.active_headcount} />
                <Metric label="Incidents YTD" value={c.incidents_ytd} tone={Number(c.incidents_ytd) > 0 ? "warn" : undefined} />
                <Metric label="No-shows 30d" value={c.no_shows_30d} tone={Number(c.no_shows_30d) > 0 ? "warn" : undefined} />
                <Metric label="Receivables" value={money(c.receivables_outstanding)} />
                <Metric label="Profit YTD" value={money(c.profit_ytd)} tone={Number(c.profit_ytd) < 0 ? "bad" : "good"} />
                <Metric label="vs prior yr" value={profitUp ? "▲" : "▼"} tone={profitUp ? "good" : "bad"} />
                <Metric label="Inter-region net" value={money(c.inter_region_balance)} />
              </div>
            </div>
          );
        })}
        {cards.length === 0 && <p className="text-sm text-slate-500">No active regions.</p>}
      </div>

      <section>
        <h3 className="text-sm text-slate-900 mb-2">Department KPI roll-up</h3>
        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
              <tr>
                <th className="text-left px-3 py-2">Month</th>
                <th className="text-left px-3 py-2">Department</th>
                <th className="text-right px-3 py-2">Scored</th>
                <th className="text-right px-3 py-2">Green</th>
                <th className="text-right px-3 py-2">Amber</th>
                <th className="text-right px-3 py-2">Red</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {kpis.map((k, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5 text-slate-500">{String(k.period_month).slice(0, 7)}</td>
                  <td className="px-3 py-1.5 text-slate-700 capitalize">{String(k.department).replace(/_/g, " ")}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{k.kpis_scored}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-success-700">{k.green}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-warning-700">{k.amber}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-danger-700">{k.red}</td>
                </tr>
              ))}
              {kpis.length === 0 && <tr><td colSpan={6} className="px-3 py-3 text-slate-500">No KPI scores yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: any; tone?: "good" | "bad" | "warn" }) {
  const color = tone === "good" ? "text-success-700" : tone === "bad" ? "text-danger-700" : tone === "warn" ? "text-warning-700" : "text-slate-900";
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`tabular-nums ${color}`}>{value ?? "—"}</div>
    </div>
  );
}
