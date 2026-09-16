// Contracted vs Deployed vs Cost — per client, per month (item 5 of the reliever
// pass). It is the number that says what unbilled cover costs: MIU is billed for
// 12 and may man 13, and that 13th only shows up here.
//
//   contracted — committed headcount from contract_lines (what the client pays for)
//   deployed   — distinct guards who actually stood there this month (from marks,
//                keyed on worked_for_client_id, so relievers count for the client
//                they covered)
//   cost       — payroll_cost_by_client(month): salary apportioned by worked days
//
// A report, not a control. Nothing here refuses anything; deployed exceeding
// contracted is expected and is exactly the cost being surfaced.
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import ExportButton from "../../components/ExportButton";
import { exportTable } from "../../lib/excel";
import { supabase, fetchAllRows, isPersonnelCategory, type ContractLineCategory } from "../../lib/supabase";

const monthKeyFromDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return monthKeyFromDate(d); };

type Row = { client_id: string; client_name: string; contracted: number; deployed: number; cost: number };

export default function ContractedVsDeployed() {
  const [month, setMonth] = useState(prevMonth());
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      const start = `${month}-01`;
      const [y, m] = month.split("-").map(Number);
      const end = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;

      const [cliRes, conRes, lineRes, costRes] = await Promise.all([
        supabase.from("clients").select("id, name"),
        supabase.from("contracts").select("id, client_id, status, contract_type"),
        supabase.from("contract_lines").select("contract_id, category, committed_count"),
        supabase.rpc("payroll_cost_by_client", { p_period_month: start }),
      ]);
      // Deployed marks can exceed a page, so paginate.
      const marks = await fetchAllRows<{ worked_for_client_id: string | null; employee_id: string }>(() =>
        supabase
          .from("attendance_records")
          .select("worked_for_client_id, employee_id")
          .gte("attendance_date", start)
          .lte("attendance_date", end)
          .in("status", ["present", "double_duty", "relief_cover"]) as unknown as {
          range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
        },
      );
      if (!alive) return;

      const firstErr = cliRes.error || conRes.error || lineRes.error || (costRes.error as any);
      if (firstErr) { setError(firstErr.message); setLoading(false); return; }

      const clientName = new Map((cliRes.data ?? []).map((c: any) => [c.id, c.name as string]));
      // Active guard-deployment contracts → their client.
      const contractClient = new Map<string, string>();
      for (const k of (conRes.data ?? []) as any[]) {
        if (k.status === "active" && k.contract_type === "guard_deployment") contractClient.set(k.id, k.client_id);
      }
      const contracted = new Map<string, number>();
      for (const l of (lineRes.data ?? []) as any[]) {
        const cid = contractClient.get(l.contract_id);
        if (!cid || !isPersonnelCategory(l.category as ContractLineCategory)) continue;
        contracted.set(cid, (contracted.get(cid) ?? 0) + (Number(l.committed_count) || 0));
      }
      const deployedSet = new Map<string, Set<string>>();
      for (const r of marks) {
        if (!r.worked_for_client_id) continue;
        const s = deployedSet.get(r.worked_for_client_id) ?? new Set<string>();
        s.add(r.employee_id);
        deployedSet.set(r.worked_for_client_id, s);
      }
      const cost = new Map<string, number>();
      for (const r of (costRes.data ?? []) as any[]) cost.set(r.client_id, Number(r.cost) || 0);

      const ids = new Set<string>([...contracted.keys(), ...deployedSet.keys(), ...cost.keys()]);
      const out: Row[] = [...ids].map((id) => ({
        client_id: id,
        client_name: clientName.get(id) ?? "—",
        contracted: contracted.get(id) ?? 0,
        deployed: deployedSet.get(id)?.size ?? 0,
        cost: cost.get(id) ?? 0,
      }));
      out.sort((a, b) => (b.deployed - b.contracted) - (a.deployed - a.contracted) || a.client_name.localeCompare(b.client_name));
      setRows(out);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [month]);

  const totals = useMemo(() => rows.reduce(
    (t, r) => ({ contracted: t.contracted + r.contracted, deployed: t.deployed + r.deployed, cost: t.cost + r.cost }),
    { contracted: 0, deployed: 0, cost: 0 },
  ), [rows]);

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-lg text-slate-900 mb-1">Contracted vs Deployed vs Cost</h3>
          <p className="text-sm text-slate-500">
            What each client is committed to, who actually stood there, and the payroll it cost. A positive
            gap is cover carried above the contract — visible here, billed nowhere.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-sm">
            <span className="block text-xs text-slate-500 mb-1">Month</span>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-md text-sm" />
          </label>
          <ExportButton
            onExport={() => exportTable({
              fileName: `Contracted vs Deployed ${month}.xlsx`,
              sheetName: "Cover",
              headers: ["Client", "Contracted", "Deployed", "Gap", "Cost"],
              rows: rows.map((r) => [r.client_name, r.contracted, r.deployed, r.deployed - r.contracted, r.cost]),
            })}
          />
        </div>
      </div>

      {error && <div className="p-3 mb-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">{error}</div>}

      {loading ? (
        <div className="flex items-center gap-2 text-slate-500 text-sm py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center text-slate-500 text-sm py-10">No contracted or deployed strength this month.</div>
      ) : (
        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-2">Client</th>
                <th className="text-right px-4 py-2">Contracted</th>
                <th className="text-right px-4 py-2">Deployed</th>
                <th className="text-right px-4 py-2">Gap</th>
                <th className="text-right px-4 py-2">Cost (PKR)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const gap = r.deployed - r.contracted;
                return (
                  <tr key={r.client_id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 text-slate-800">{r.client_name}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600">{r.contracted}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600">{r.deployed}</td>
                    <td className={`px-4 py-2 text-right tabular-nums font-medium ${gap > 0 ? "text-danger-600" : gap < 0 ? "text-slate-400" : "text-slate-500"}`}>
                      {gap > 0 ? `+${gap}` : gap}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700">{r.cost.toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50 font-medium text-slate-800">
                <td className="px-4 py-2">Total</td>
                <td className="px-4 py-2 text-right tabular-nums">{totals.contracted}</td>
                <td className="px-4 py-2 text-right tabular-nums">{totals.deployed}</td>
                <td className="px-4 py-2 text-right tabular-nums">{totals.deployed - totals.contracted > 0 ? `+${totals.deployed - totals.contracted}` : totals.deployed - totals.contracted}</td>
                <td className="px-4 py-2 text-right tabular-nums">{totals.cost.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
