import { useCallback, useEffect, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";

// §19 Compliance Process Engine: every licence/renewal/NOC as a staged case
// with a government-visit log, dual-jurisdiction register, and the statutory
// filing tracker (EOBI / social security / withholding).

type Tab = "cases" | "filings";
const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";
const STAGES = ["not_started", "submitted", "verification", "follow_up", "issued"] as const;
const JURISDICTIONS = ["ict", "punjab", "federal", "sindh", "kpk", "balochistan", "ajk", "other"] as const;
const CASE_TYPES = ["licence", "renewal", "noc", "registration", "other"] as const;
const FILING_TYPES = ["eobi", "social_security", "withholding_tax", "income_tax", "other"] as const;

export default function ComplianceCases() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [tab, setTab] = useState<Tab>("cases");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [cases, setCases] = useState<any[]>([]);
  const [register, setRegister] = useState<any[]>([]);
  const [filings, setFilings] = useState<any[]>([]);

  const [nc, setNc] = useState({ title: "", case_type: "licence", jurisdiction: "ict", authority: "", target_date: "" });
  const [nf, setNf] = useState({ filing_type: "eobi", period_month: "", due_date: "", amount: "" });
  const [openCase, setOpenCase] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [cs, rg, fl] = await Promise.all([
      supabase.from("compliance_cases").select("*").eq("company_id", companyId).order("target_date", { ascending: true }),
      supabase.from("compliance_jurisdiction_register").select("*").eq("company_id", companyId),
      supabase.from("statutory_filings").select("*").eq("company_id", companyId).order("due_date", { ascending: false }),
    ]);
    setCases(cs.data ?? []);
    setRegister(rg.data ?? []);
    setFilings(fl.data ?? []);
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

  const nextStage = (s: string) => {
    const i = STAGES.indexOf(s as any);
    return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header title="Compliance Cases" subtitle="Licence/renewal/NOC case tracker and statutory filings" />

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {([["cases", "Cases"], ["filings", "Statutory Filings"]] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {label}
          </button>
        ))}
      </div>

      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      {tab === "cases" && (
        <div className="space-y-4">
          {register.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {register.map((r) => (
                <div key={r.jurisdiction} className="border border-slate-200 rounded-md px-3 py-2 text-sm">
                  <span className="uppercase text-slate-700">{r.jurisdiction}</span>
                  <span className="text-slate-500"> · {r.open_cases} open</span>
                  {Number(r.overdue_cases) > 0 && <span className="text-danger-600"> · {r.overdue_cases} overdue</span>}
                </div>
              ))}
            </div>
          )}

          <section className="border border-slate-200 rounded-md p-3">
            <h3 className="text-sm text-slate-900 mb-2">New case</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <input className={FIELD} placeholder="Title" value={nc.title} onChange={(e) => setNc({ ...nc, title: e.target.value })} />
              <select className={FIELD} value={nc.case_type} onChange={(e) => setNc({ ...nc, case_type: e.target.value })}>
                {CASE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <select className={FIELD} value={nc.jurisdiction} onChange={(e) => setNc({ ...nc, jurisdiction: e.target.value })}>
                {JURISDICTIONS.map((j) => <option key={j} value={j}>{j.toUpperCase()}</option>)}
              </select>
              <input className={FIELD} placeholder="Authority" value={nc.authority} onChange={(e) => setNc({ ...nc, authority: e.target.value })} />
              <input type="date" className={FIELD} value={nc.target_date} onChange={(e) => setNc({ ...nc, target_date: e.target.value })} />
              <Button variant="primary" size="sm" disabled={busy || !nc.title}
                onClick={async () => {
                  if (await run(supabase.from("compliance_cases").insert({
                    title: nc.title, case_type: nc.case_type, jurisdiction: nc.jurisdiction,
                    authority: nc.authority || null, target_date: nc.target_date || null,
                  }))) setNc({ title: "", case_type: "licence", jurisdiction: "ict", authority: "", target_date: "" });
                }}>
                Add case
              </Button>
            </div>
          </section>

          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Case</th>
                  <th className="text-left px-3 py-2">Jurisdiction</th>
                  <th className="text-left px-3 py-2">Authority</th>
                  <th className="text-left px-3 py-2">Target</th>
                  <th className="text-left px-3 py-2">Stage</th>
                  <th className="text-right px-3 py-2">Advance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cases.map((c) => {
                  const overdue = c.target_date && c.target_date < new Date().toISOString().slice(0, 10) && c.stage !== "issued";
                  return (
                    <tr key={c.id} className={overdue ? "bg-danger-50" : ""}>
                      <td className="px-3 py-1.5 text-slate-700">{c.title}</td>
                      <td className="px-3 py-1.5 uppercase text-slate-500">{c.jurisdiction}</td>
                      <td className="px-3 py-1.5 text-slate-500">{c.authority ?? "—"}</td>
                      <td className="px-3 py-1.5 text-slate-500">{c.target_date ?? "—"}</td>
                      <td className="px-3 py-1.5"><span className="capitalize">{String(c.stage).replace(/_/g, " ")}</span></td>
                      <td className="px-3 py-1.5 text-right space-x-1">
                        <Button variant="secondary" size="sm" onClick={() => setOpenCase(openCase === c.id ? null : c.id)}>
                          {openCase === c.id ? "Hide visits" : "Visits"}
                        </Button>
                        {nextStage(c.stage) && (
                          <Button variant="secondary" size="sm" disabled={busy}
                            onClick={() => run(supabase.from("compliance_cases").update({ stage: nextStage(c.stage) }).eq("id", c.id))}>
                            → {String(nextStage(c.stage)).replace(/_/g, " ")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {cases.length === 0 && <tr><td colSpan={6} className="px-3 py-3 text-slate-500">No cases.</td></tr>}
              </tbody>
            </table>
          </div>

          {openCase && <CaseVisits companyId={companyId} caseId={openCase} />}
        </div>
      )}

      {tab === "filings" && (
        <div className="space-y-4">
          <section className="border border-slate-200 rounded-md p-3">
            <h3 className="text-sm text-slate-900 mb-2">New filing</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <select className={FIELD} value={nf.filing_type} onChange={(e) => setNf({ ...nf, filing_type: e.target.value })}>
                {FILING_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
              </select>
              <input type="date" className={FIELD} title="Period month" value={nf.period_month} onChange={(e) => setNf({ ...nf, period_month: e.target.value })} />
              <input type="date" className={FIELD} title="Due date" value={nf.due_date} onChange={(e) => setNf({ ...nf, due_date: e.target.value })} />
              <input className={FIELD} placeholder="Amount" value={nf.amount} onChange={(e) => setNf({ ...nf, amount: e.target.value })} />
            </div>
            <div className="mt-2">
              <Button variant="primary" size="sm" disabled={busy || !nf.period_month || !nf.due_date}
                onClick={async () => {
                  if (await run(supabase.from("statutory_filings").insert({
                    filing_type: nf.filing_type, period_month: nf.period_month, due_date: nf.due_date,
                    amount: nf.amount ? Number(nf.amount) : null,
                  }))) setNf({ filing_type: "eobi", period_month: "", due_date: "", amount: "" });
                }}>
                Add filing
              </Button>
            </div>
          </section>

          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Type</th>
                  <th className="text-left px-3 py-2">Period</th>
                  <th className="text-left px-3 py-2">Due</th>
                  <th className="text-right px-3 py-2">Amount</th>
                  <th className="text-center px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filings.map((f) => {
                  const status = f.paid_date ? "paid" : f.filed_date ? "filed" : f.due_date < new Date().toISOString().slice(0, 10) ? "overdue" : "pending";
                  return (
                    <tr key={f.id} className={status === "overdue" ? "bg-danger-50" : ""}>
                      <td className="px-3 py-1.5 text-slate-700 capitalize">{String(f.filing_type).replace(/_/g, " ")}</td>
                      <td className="px-3 py-1.5 text-slate-500">{String(f.period_month).slice(0, 7)}</td>
                      <td className="px-3 py-1.5 text-slate-500">{f.due_date}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{f.amount ? Number(f.amount).toLocaleString() : "—"}</td>
                      <td className="px-3 py-1.5 text-center"><span className="capitalize text-xs">{status}</span></td>
                      <td className="px-3 py-1.5 text-right space-x-1">
                        {!f.filed_date && <Button variant="secondary" size="sm" disabled={busy}
                          onClick={() => run(supabase.from("statutory_filings").update({ filed_date: new Date().toISOString().slice(0, 10) }).eq("id", f.id))}>File</Button>}
                        {f.filed_date && !f.paid_date && <Button variant="primary" size="sm" disabled={busy}
                          onClick={() => run(supabase.from("statutory_filings").update({ paid_date: new Date().toISOString().slice(0, 10) }).eq("id", f.id))}>Pay</Button>}
                      </td>
                    </tr>
                  );
                })}
                {filings.length === 0 && <tr><td colSpan={6} className="px-3 py-3 text-slate-500">No filings.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// §19 government-visit log for a single case.
function CaseVisits({ companyId, caseId }: { companyId: string; caseId: string }) {
  const [visits, setVisits] = useState<any[]>([]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [outcome, setOutcome] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [nextDate, setNextDate] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!caseId) return;
    const { data } = await supabase.from("compliance_case_visits").select("*").eq("case_id", caseId).order("visit_date", { ascending: false });
    setVisits(data ?? []);
  }, [caseId]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!outcome.trim()) return;
    setBusy(true);
    const { error } = await supabase.from("compliance_case_visits").insert({
      company_id: companyId, case_id: caseId, visit_date: date, outcome,
      next_action: nextAction || null, next_action_date: nextDate || null,
    });
    setBusy(false);
    if (!error) { setOutcome(""); setNextAction(""); setNextDate(""); await load(); }
  };

  return (
    <div className="border border-slate-200 rounded-md p-3 space-y-3 bg-slate-50/50">
      <h4 className="text-sm text-slate-900">Government visits</h4>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
        <div><label className="text-xs text-slate-500 block mb-1">Date</label>
          <input type="date" className={FIELD + " w-full"} value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <input className={FIELD + " col-span-2"} placeholder="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
        <input className={FIELD} placeholder="Next action" value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
        <div className="flex gap-2 items-end">
          <input type="date" className={FIELD + " w-full"} title="Next action date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
          <Button variant="primary" size="sm" disabled={busy || !outcome.trim()} onClick={add}>Log</Button>
        </div>
      </div>
      <div className="divide-y divide-slate-100 border border-slate-200 rounded-md bg-white">
        {visits.map((v) => (
          <div key={v.id} className="px-3 py-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-700">{v.visit_date} · {v.outcome}</span>
              {v.next_action_date && <span className="text-xs text-slate-400">next: {v.next_action_date}</span>}
            </div>
            {v.next_action && <div className="text-xs text-slate-500">→ {v.next_action}</div>}
          </div>
        ))}
        {visits.length === 0 && <p className="px-3 py-2 text-sm text-slate-500">No visits logged for this case.</p>}
      </div>
    </div>
  );
}
