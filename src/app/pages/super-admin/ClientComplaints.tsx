import ThemedSelect from "../../components/ThemedSelect";
import { useCallback, useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";

// Client complaints — re-homed here (Operations ▸ Incidents) when the Client
// Relationships panel was dissolved. Same client_complaints table and flow.

const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";
const COMPLAINT_STATUS = ["open", "in_progress", "resolved", "closed"];

export default function ClientComplaints() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clients, setClients] = useState<any[]>([]);
  const [complaints, setComplaints] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [cl, cp] = await Promise.all([
      supabase.from("clients").select("id,name").eq("company_id", companyId).order("name"),
      supabase.from("client_complaints").select("*").eq("company_id", companyId).order("raised_on", { ascending: false }),
    ]);
    setClients(cl.data ?? []);
    setComplaints(cp.data ?? []);
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

  const [cpClient, setCpClient] = useState("");
  const [cpChannel, setCpChannel] = useState("phone");
  const [cpDesc, setCpDesc] = useState("");

  const addComplaint = async () => {
    if (!cpClient || !cpDesc.trim()) return;
    const ok = await run(supabase.from("client_complaints").insert({
      company_id: companyId, client_id: cpClient, raised_on: new Date().toISOString().slice(0, 10),
      channel: cpChannel, description: cpDesc, status: "open",
    }));
    if (ok) setCpDesc("");
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header title="Client Complaints" subtitle="Complaints raised by clients (from the dissolved Client Relationships panel)" />
      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      <div className="space-y-4">
        <section className="border border-slate-200 rounded-md p-3 grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
          <div className="col-span-2">
            <label className="text-xs text-slate-500 block mb-1">Client</label>
            <ThemedSelect className={FIELD + " w-full"} value={cpClient} onChange={(e) => setCpClient(e.target.value)}>
              <option value="">— client —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </ThemedSelect>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">Channel</label>
            <ThemedSelect className={FIELD + " w-full"} value={cpChannel} onChange={(e) => setCpChannel(e.target.value)}>
              {["phone", "email", "in_person", "letter"].map((c) => <option key={c} value={c}>{c}</option>)}
            </ThemedSelect>
          </div>
          <input className={FIELD + " col-span-2 md:col-span-2"} placeholder="Description" value={cpDesc} onChange={(e) => setCpDesc(e.target.value)} />
          <Button variant="primary" size="sm" disabled={busy || !cpClient || !cpDesc.trim()} onClick={addComplaint}>Log complaint</Button>
        </section>
        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
              <tr>
                <th className="text-left px-3 py-2">Client</th>
                <th className="text-left px-3 py-2">Raised</th>
                <th className="text-left px-3 py-2">Description</th>
                <th className="text-left px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {complaints.map((c) => (
                <tr key={c.id}>
                  <td className="px-3 py-1.5 text-slate-700">{clientName.get(c.client_id)}</td>
                  <td className="px-3 py-1.5 text-slate-500">{c.raised_on}</td>
                  <td className="px-3 py-1.5 text-slate-600">{c.description}</td>
                  <td className="px-3 py-1.5">
                    <ThemedSelect className={FIELD + " py-1"} value={c.status}
                      onChange={(e) => run(supabase.from("client_complaints").update({ status: e.target.value, resolved_on: (e.target.value === "resolved" || e.target.value === "closed") ? new Date().toISOString().slice(0, 10) : null }).eq("id", c.id))}>
                      {COMPLAINT_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </ThemedSelect>
                  </td>
                </tr>
              ))}
              {complaints.length === 0 && <tr><td colSpan={4} className="px-3 py-3 text-slate-500">No complaints.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
