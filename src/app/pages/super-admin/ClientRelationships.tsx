import ThemedSelect from "../../components/ThemedSelect";
import { useCallback, useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import Tabs from "../../components/Tabs";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { generateClientServiceReportPdf } from "../../lib/clientReportPdf";
import { usePageState } from "../../lib/pageState";

// §22 Client relationship layer — service reviews, complaints and the renewal
// pipeline, plus a printable client service report.

type Tab = "reviews" | "complaints" | "renewals";

const FIELD =
  "px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent";

const RENEWAL_STAGES = ["not_started", "contacted", "negotiating", "renewed", "lost"];
const COMPLAINT_STATUS = ["open", "in_progress", "resolved", "closed"];

export default function ClientRelationships() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [tab, setTab] = usePageState<Tab>("ClientRelationships.tab", "reviews");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [clients, setClients] = useState<any[]>([]);
  const [reviews, setReviews] = useState<any[]>([]);
  const [complaints, setComplaints] = useState<any[]>([]);
  const [renewals, setRenewals] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [cl, rv, cp, rn] = await Promise.all([
      supabase.from("clients").select("id,name").eq("company_id", companyId).order("name"),
      supabase.from("client_service_reviews").select("*").eq("company_id", companyId).order("review_date", { ascending: false }),
      supabase.from("client_complaints").select("*").eq("company_id", companyId).order("raised_on", { ascending: false }),
      supabase.from("renewal_pipeline").select("*").eq("company_id", companyId).order("expected_close_date"),
    ]);
    setClients(cl.data ?? []);
    setReviews(rv.data ?? []);
    setComplaints(cp.data ?? []);
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

  // review form
  const [rvClient, setRvClient] = useState("");
  const [rvDate, setRvDate] = useState(new Date().toISOString().slice(0, 10));
  const [rvRating, setRvRating] = useState("4");
  const [rvSummary, setRvSummary] = useState("");
  const [rvActions, setRvActions] = useState("");

  const addReview = async () => {
    if (!rvClient) return;
    const ok = await run(supabase.from("client_service_reviews").insert({
      company_id: companyId, client_id: rvClient, review_date: rvDate,
      rating: Number(rvRating), summary: rvSummary, action_items: rvActions,
    }));
    if (ok) { setRvSummary(""); setRvActions(""); }
  };

  // complaint form
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

  // renewal form
  const [rnClient, setRnClient] = useState("");
  const [rnDate, setRnDate] = useState("");

  const addRenewal = async () => {
    if (!rnClient) return;
    await run(supabase.from("renewal_pipeline").insert({
      company_id: companyId, client_id: rnClient, stage: "not_started",
      expected_close_date: rnDate || null,
    }));
  };

  const printReport = (clientId: string) => {
    const name = clientName.get(clientId) ?? "Client";
    generateClientServiceReportPdf({
      companyName: company?.name ?? "",
      clientName: name,
      reviews: reviews.filter((r) => r.client_id === clientId),
      complaints: complaints.filter((c) => c.client_id === clientId),
    });
  };

  return (
    <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
      <Header title="Client Relationships" subtitle="Service reviews, complaints, renewal pipeline (§22)" />

      <Tabs<Tab> className="mb-4" value={tab} onChange={setTab} items={([["reviews", "Service Reviews"], ["complaints", "Complaints"], ["renewals", "Renewals"]] as [Tab, string][]).map(([t, label]) => ({ value: t, label }))} />
      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      {tab === "reviews" && (
        <div className="space-y-4">
          <section className="border border-border rounded-md p-3 grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground block mb-1">Client</label>
              <ThemedSelect className={FIELD + " w-full"} value={rvClient} onChange={(e) => setRvClient(e.target.value)}>
                <option value="">— client —</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </ThemedSelect>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Date</label>
              <input type="date" className={FIELD + " w-full"} value={rvDate} onChange={(e) => setRvDate(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Rating</label>
              <ThemedSelect className={FIELD + " w-full"} value={rvRating} onChange={(e) => setRvRating(e.target.value)}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </ThemedSelect>
            </div>
            <input className={FIELD + " col-span-2"} placeholder="Summary" value={rvSummary} onChange={(e) => setRvSummary(e.target.value)} />
            <input className={FIELD + " col-span-2 md:col-span-4"} placeholder="Action items" value={rvActions} onChange={(e) => setRvActions(e.target.value)} />
            <Button variant="primary" size="sm" disabled={busy || !rvClient} onClick={addReview}>Log review</Button>
          </section>
          <div className="border border-border rounded-md divide-y divide-border">
            {reviews.map((r) => (
              <div key={r.id} className="px-3 py-2 text-sm flex items-center justify-between">
                <div>
                  <span className="text-foreground">{clientName.get(r.client_id)}</span>
                  <span className="text-muted-foreground/70 ml-2">{r.review_date} · ★{r.rating}</span>
                  {r.summary && <div className="text-xs text-muted-foreground">{r.summary}</div>}
                </div>
                <Button variant="secondary" size="sm" onClick={() => printReport(r.client_id)}>Print report</Button>
              </div>
            ))}
            {reviews.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">No reviews.</p>}
          </div>
        </div>
      )}

      {tab === "complaints" && (
        <div className="space-y-4">
          <section className="border border-border rounded-md p-3 grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground block mb-1">Client</label>
              <ThemedSelect className={FIELD + " w-full"} value={cpClient} onChange={(e) => setCpClient(e.target.value)}>
                <option value="">— client —</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </ThemedSelect>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Channel</label>
              <ThemedSelect className={FIELD + " w-full"} value={cpChannel} onChange={(e) => setCpChannel(e.target.value)}>
                {["phone", "email", "in_person", "letter"].map((c) => <option key={c} value={c}>{c}</option>)}
              </ThemedSelect>
            </div>
            <input className={FIELD + " col-span-2 md:col-span-2"} placeholder="Description" value={cpDesc} onChange={(e) => setCpDesc(e.target.value)} />
            <Button variant="primary" size="sm" disabled={busy || !cpClient || !cpDesc.trim()} onClick={addComplaint}>Log complaint</Button>
          </section>
          <div className="overflow-x-auto border border-border rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Client</th>
                  <th className="text-left px-3 py-2">Raised</th>
                  <th className="text-left px-3 py-2">Description</th>
                  <th className="text-left px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {complaints.map((c) => (
                  <tr key={c.id}>
                    <td className="px-3 py-1.5 text-foreground">{clientName.get(c.client_id)}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{c.raised_on}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{c.description}</td>
                    <td className="px-3 py-1.5">
                      <ThemedSelect className={FIELD + " py-1"} value={c.status}
                        onChange={(e) => run(supabase.from("client_complaints").update({ status: e.target.value, resolved_on: (e.target.value === "resolved" || e.target.value === "closed") ? new Date().toISOString().slice(0, 10) : null }).eq("id", c.id))}>
                        {COMPLAINT_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
                      </ThemedSelect>
                    </td>
                  </tr>
                ))}
                {complaints.length === 0 && <tr><td colSpan={4} className="px-3 py-3 text-muted-foreground">No complaints.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "renewals" && (
        <div className="space-y-4">
          <section className="border border-border rounded-md p-3 flex items-end gap-2 flex-wrap">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Client</label>
              <ThemedSelect className={FIELD} value={rnClient} onChange={(e) => setRnClient(e.target.value)}>
                <option value="">— client —</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </ThemedSelect>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Expected close</label>
              <input type="date" className={FIELD} value={rnDate} onChange={(e) => setRnDate(e.target.value)} />
            </div>
            <Button variant="primary" size="sm" disabled={busy || !rnClient} onClick={addRenewal}>Add to pipeline</Button>
          </section>
          <div className="overflow-x-auto border border-border rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Client</th>
                  <th className="text-left px-3 py-2">Expected close</th>
                  <th className="text-left px-3 py-2">Stage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {renewals.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-1.5 text-foreground">{clientName.get(r.client_id)}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{r.expected_close_date ?? "—"}</td>
                    <td className="px-3 py-1.5">
                      <ThemedSelect className={FIELD + " py-1"} value={r.stage}
                        onChange={(e) => run(supabase.from("renewal_pipeline").update({ stage: e.target.value }).eq("id", r.id))}>
                        {RENEWAL_STAGES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
                      </ThemedSelect>
                    </td>
                  </tr>
                ))}
                {renewals.length === 0 && <tr><td colSpan={3} className="px-3 py-3 text-muted-foreground">Nothing in the pipeline.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
