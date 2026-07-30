import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

// Billing reconciliation — moved here from the old Sites & Strength panel.
// Contracted vs deployed vs attendance-on-ground vs shortfall, per client.
// A client contracted for more than is on ground surfaces recruitment exposure.

type BillingRow = {
  client_id: string;
  client_name: string;
  contracted: number;
  deployed: number;
  attendance_on_ground: number;
  shortfall: number;
};

export default function BillingReconciliation() {
  const [rows, setRows] = useState<BillingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("v_client_billing_reconciliation")
        .select("*")
        .order("shortfall", { ascending: false });
      if (error) setError(error.message);
      else setRows((data ?? []) as BillingRow[]);
      setLoading(false);
    })();
  }, []);

  const visible = rows.filter((b) => b.contracted > 0 || b.deployed > 0);

  return (
    <div>
      {error && <p className="text-sm text-danger-600 mb-3">{error}</p>}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase tracking-wide">Client</th>
                <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase tracking-wide">Contracted</th>
                <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase tracking-wide">Deployed</th>
                <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase tracking-wide">On ground (att.)</th>
                <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase tracking-wide">Shortfall</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500 text-sm">Loading…</td></tr>
              )}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500 text-sm">No billing lines to reconcile yet.</td></tr>
              )}
              {visible.map((b) => (
                <tr key={b.client_id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3 text-sm font-medium text-slate-800">{b.client_name}</td>
                  <td className="px-4 py-3 text-sm text-right text-slate-500">{b.contracted}</td>
                  <td className="px-4 py-3 text-sm text-right text-slate-500">{b.deployed}</td>
                  <td className="px-4 py-3 text-sm text-right text-slate-500">{b.attendance_on_ground}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`inline-block px-2 py-0.5 rounded-md text-xs border font-medium ${b.shortfall > 0 ? "bg-warning-50 text-warning-800 border-warning-200" : "bg-success-50 text-success-700 border-success-200"}`}>
                      {b.shortfall > 0 ? `−${b.shortfall}` : "0"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-slate-500 mt-1">Shortfall = contracted − deployed. A client contracted for more than is on ground surfaces recruitment exposure.</p>
    </div>
  );
}
