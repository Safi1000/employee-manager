import ThemedSelect from "../../components/ThemedSelect";
import { useCallback, useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";

// Contract renewal pipeline — re-homed here (Compliance ▸ Licenses & Renewals)
// when the Client Relationships panel was dissolved. Same renewal_pipeline table.

const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";
const RENEWAL_STAGES = ["not_started", "contacted", "negotiating", "renewed", "lost"];

export default function ContractRenewals() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clients, setClients] = useState<any[]>([]);
  const [renewals, setRenewals] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [cl, rn] = await Promise.all([
      supabase.from("clients").select("id,name").eq("company_id", companyId).order("name"),
      supabase.from("renewal_pipeline").select("*").eq("company_id", companyId).order("expected_close_date"),
    ]);
    setClients(cl.data ?? []);
    setRenewals(rn.data ?? []);
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  const run = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setErr(null);
    const { error } = await p;
    setBusy(false);
    if (error) { setErr(error.message); return false; }
    await load();
    return true;
  };

  const clientName = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);

  const [rnClient, setRnClient] = useState("");
  const [rnDate, setRnDate] = useState("");

  const addRenewal = async () => {
    if (!rnClient) return;
    await run(supabase.from("renewal_pipeline").insert({
      company_id: companyId, client_id: rnClient, stage: "not_started",
      expected_close_date: rnDate || null,
    }));
  };

  return (
    <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
      <Header title="Contract Renewals" subtitle="Contract renewal pipeline (from the dissolved Client Relationships panel)" />
      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      <div className="space-y-4">
        <section className="border border-slate-200 rounded-md p-3 flex items-end gap-2 flex-wrap">
          <div>
            <label className="text-xs text-slate-500 block mb-1">Client</label>
            <ThemedSelect className={FIELD} value={rnClient} onChange={(e) => setRnClient(e.target.value)}>
              <option value="">— client —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </ThemedSelect>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">Expected close</label>
            <input type="date" className={FIELD} value={rnDate} onChange={(e) => setRnDate(e.target.value)} />
          </div>
          <Button variant="primary" size="sm" disabled={busy || !rnClient} onClick={addRenewal}>Add to pipeline</Button>
        </section>
        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
              <tr>
                <th className="text-left px-3 py-2">Client</th>
                <th className="text-left px-3 py-2">Expected close</th>
                <th className="text-left px-3 py-2">Stage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {renewals.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-1.5 text-slate-700">{clientName.get(r.client_id)}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.expected_close_date ?? "—"}</td>
                  <td className="px-3 py-1.5">
                    <ThemedSelect className={FIELD + " py-1"} value={r.stage}
                      onChange={(e) => run(supabase.from("renewal_pipeline").update({ stage: e.target.value }).eq("id", r.id))}>
                      {RENEWAL_STAGES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
                    </ThemedSelect>
                  </td>
                </tr>
              ))}
              {renewals.length === 0 && <tr><td colSpan={3} className="px-3 py-3 text-slate-500">Nothing in the pipeline.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
