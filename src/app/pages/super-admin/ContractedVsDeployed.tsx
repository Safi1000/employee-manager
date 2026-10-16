// Contracted vs Deployed vs Cost — per client, per month (item 5 of the reliever
// pass). It is the number that says what unbilled cover costs: MIU is billed for
// 12 and may man 13, and that 13th only shows up here.
//
// READ, NOT COMPUTED (0516). Every figure comes from client_cover(), which holds
// the definitions this screen used to compute in the browser:
//   contracted     committed heads on personnel lines of active guard-deployment contracts
//   deployed       distinct guards marked present / double duty / relief cover FOR the client
//   unbilled cover deployed above contracted — cover the company absorbs
//   payroll cost   the accrual client statement's direct payroll (salary split by days worked)
//
// A report, not a control. Nothing here refuses anything; deployed exceeding
// contracted is expected and is exactly the cost being surfaced.
import { useEffect, useState } from "react";
import { Loader2, Users } from "lucide-react";
import ExportButton from "../../components/ExportButton";
import Badge from "../../components/Badge";
import { exportTable } from "../../lib/excel";
import { supabase } from "../../lib/supabase";
import { usePageState } from "../../lib/pageState";
import { Panel, inputCls } from "./_assetsKit";
import { useCompanyId } from "./reports/kit";

const monthKeyFromDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return monthKeyFromDate(d); };

type Row = { client_id: string; client_name: string; contracted: number; deployed: number; unbilled_cover: number; payroll_cost: number };

export default function ContractedVsDeployed() {
  const companyId = useCompanyId();
  const [month, setMonth] = usePageState("ContractedVsDeployed.month", prevMonth());
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: e } = await supabase.rpc("client_cover", { p_company_id: companyId, p_month: `${month}-01` });
      if (!alive) return;
      if (e) { setError(e.message); setLoading(false); return; }
      setRows(((data ?? []) as Row[]).map((r) => ({ ...r, contracted: Number(r.contracted), deployed: Number(r.deployed),
        unbilled_cover: Number(r.unbilled_cover), payroll_cost: Number(r.payroll_cost) })));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [month, companyId]);

  // Footer: the sum of the rows shown — the one place arithmetic belongs here.
  const totals = rows.reduce(
    (t, r) => ({ contracted: t.contracted + r.contracted, deployed: t.deployed + r.deployed, unbilled: t.unbilled + r.unbilled_cover, cost: t.cost + r.payroll_cost }),
    { contracted: 0, deployed: 0, unbilled: 0, cost: 0 },
  );

  return (
    <Panel
      icon={Users}
      title="Contracted vs deployed vs cost"
      description="What each client is committed to, who actually stood there, and the payroll it cost. Unbilled cover is strength carried above the contract — visible here, billed nowhere."
      actions={<>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className={inputCls + " w-auto"} />
        <ExportButton
          onExport={() => exportTable({
            fileName: `Contracted vs Deployed ${month}.xlsx`,
            sheetName: "Cover",
            headers: ["Client", "Contracted", "Deployed", "Unbilled cover", "Payroll cost"],
            rows: rows.map((r) => [r.client_name, r.contracted, r.deployed, r.unbilled_cover, r.payroll_cost]),
          })}
        />
      </>}
      flush
    >
      {/* A figure that changes basis has to say so where it is read, not only in a report. */}
      <div className="px-4 md:px-5 py-2.5 border-b border-border text-[11px] text-muted-foreground leading-relaxed">
        <strong className="text-foreground">Basis, since 16 Oct 2026:</strong> every column is read from the database
        (<code>client_cover()</code>, migration 0516) instead of being computed in this screen. Payroll cost is the accrual
        client statement's payroll — final salary split across clients by days worked. Measured against the previous
        computation for August and September 2026: identical totals and no client differing.
      </div>
      {error && <div className="px-5 py-3 text-sm text-danger-600">{error}</div>}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">No contracted or deployed strength this month.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b border-border">
              <tr>
                <th className="text-left px-4 md:px-5 py-2.5 font-medium">Client</th>
                <th className="text-right px-3 py-2.5 font-medium">Contracted</th>
                <th className="text-right px-3 py-2.5 font-medium">Deployed</th>
                <th className="text-right px-3 py-2.5 font-medium">Unbilled cover</th>
                <th className="text-right px-4 md:px-5 py-2.5 font-medium">Payroll cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.client_id} className="border-t border-border/60 hover:bg-muted/20">
                  <td className="px-4 md:px-5 py-2">
                    <span className="text-foreground">{r.client_name}</span>
                    {r.deployed < r.contracted && <Badge tone="warning" className="ml-2">short-staffed</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.contracted}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.deployed}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-medium ${r.unbilled_cover > 0 ? "text-danger-700 dark:text-danger-500" : "text-muted-foreground"}`}>
                    {r.unbilled_cover > 0 ? `+${r.unbilled_cover}` : "—"}
                  </td>
                  <td className="px-4 md:px-5 py-2 text-right tabular-nums">{r.payroll_cost.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border font-semibold">
                <td className="px-4 md:px-5 py-2.5">Total of rows shown</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{totals.contracted}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{totals.deployed}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{totals.unbilled > 0 ? `+${totals.unbilled}` : "—"}</td>
                <td className="px-4 md:px-5 py-2.5 text-right tabular-nums">{totals.cost.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Panel>
  );
}
