import { useCallback, useEffect, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";

// §18 Field Control Loop: daily OK reports (silent-site alerting), supervisor
// visits, no-show → reliever events, new-contract mobilisation checklist, post
// orders.

type Tab = "reports" | "visits" | "noshows" | "mobilisation" | "orders";

const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";

export default function FieldOps() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [tab, setTab] = useState<Tab>("reports");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [reportStatus, setReportStatus] = useState<any[]>([]);
  const [visits, setVisits] = useState<any[]>([]);
  const [noshows, setNoshows] = useState<any[]>([]);
  const [mobs, setMobs] = useState<any[]>([]);
  const [mobItems, setMobItems] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [empName, setEmpName] = useState<Map<string, string>>(new Map());
  const [employees, setEmployees] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [contracts, setContracts] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [rs, vs, ns, mb, mi, po, emp, ps, ct] = await Promise.all([
      supabase.from("daily_report_status").select("*").eq("company_id", companyId),
      supabase.from("supervisor_visits").select("*").eq("company_id", companyId).order("scheduled_date", { ascending: false }).limit(100),
      supabase.from("no_show_events").select("*").eq("company_id", companyId).order("event_date", { ascending: false }).limit(100),
      supabase.from("contract_mobilisations").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
      supabase.from("contract_mobilisation_items").select("*").eq("company_id", companyId),
      supabase.from("post_orders").select("*").eq("company_id", companyId).eq("active", true).order("created_at", { ascending: false }),
      supabase.from("employees").select("id, full_name").eq("company_id", companyId),
      supabase.from("posts").select("id, name, client_id, branch_id, contract_id, required_guards").eq("company_id", companyId).eq("active", true).order("name"),
      supabase.from("contracts").select("id, contract_code, client_id").eq("company_id", companyId),
    ]);
    setReportStatus(rs.data ?? []);
    setVisits(vs.data ?? []);
    setNoshows(ns.data ?? []);
    setMobs(mb.data ?? []);
    setMobItems(mi.data ?? []);
    setOrders(po.data ?? []);
    setEmployees((emp.data ?? []) as any[]);
    setEmpName(new Map(((emp.data ?? []) as any[]).map((e) => [e.id, e.full_name])));
    setPosts(ps.data ?? []);
    setContracts(ct.data ?? []);
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

  const silent = reportStatus.filter((r) => r.is_silent);

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header title="Field Operations" subtitle="Daily reports, supervisor visits, no-shows, mobilisation, post orders" />

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {([
          ["reports", `Daily Reports${silent.length ? ` (${silent.length} silent)` : ""}`],
          ["visits", "Supervisor Visits"],
          ["noshows", "No-shows"],
          ["mobilisation", "Mobilisation"],
          ["orders", "Post Orders"],
        ] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {label}
          </button>
        ))}
      </div>

      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      {/* Daily reports / silent sites */}
      {tab === "reports" && (
        <div className="space-y-3">
        <DailyReportForm companyId={companyId} posts={posts} run={run} busy={busy} />
        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
              <tr>
                <th className="text-left px-3 py-2">Post</th>
                <th className="text-left px-3 py-2">Region</th>
                <th className="text-center px-3 py-2">Reported today</th>
                <th className="text-right px-3 py-2">Present / Required</th>
                <th className="text-center px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reportStatus.map((r) => (
                <tr key={r.post_id} className={r.is_silent ? "bg-danger-50" : ""}>
                  <td className="px-3 py-1.5 text-slate-700">{r.post_name}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.region_name ?? "—"}</td>
                  <td className="px-3 py-1.5 text-center">{r.reported_today ? "✓" : "—"}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.strength_present ?? "—"} / {r.strength_required ?? "—"}</td>
                  <td className="px-3 py-1.5 text-center">
                    {r.is_silent
                      ? <span className="px-2 py-0.5 rounded-md text-xs border bg-danger-50 text-danger-700 border-danger-200">SILENT</span>
                      : r.reported_today
                        ? <span className="px-2 py-0.5 rounded-md text-xs border bg-success-50 text-success-700 border-success-200">{r.all_ok ? "All OK" : "Exception"}</span>
                        : <span className="text-slate-400 text-xs">awaiting</span>}
                  </td>
                </tr>
              ))}
              {reportStatus.length === 0 && <tr><td colSpan={5} className="px-3 py-3 text-slate-500">No active posts.</td></tr>}
            </tbody>
          </table>
        </div>
        </div>
      )}

      {/* Visits */}
      {tab === "visits" && (
        <div className="space-y-3">
        <VisitForm companyId={companyId} posts={posts} employees={employees} run={run} busy={busy} />
        <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
          {visits.map((v) => (
            <div key={v.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-slate-700">{v.scheduled_date ?? "—"} · {v.findings ? v.findings.slice(0, 60) : "no findings"}</span>
              <span className="text-xs px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200">{v.status}</span>
            </div>
          ))}
          {visits.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No visits logged.</p>}
        </div>
        </div>
      )}

      {/* No-shows */}
      {tab === "noshows" && (
        <div className="space-y-3">
        <NoShowForm companyId={companyId} posts={posts} employees={employees} run={run} busy={busy} />
        <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
          {noshows.map((n) => (
            <div key={n.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-slate-700">
                {empName.get(n.employee_id) ?? n.employee_id} · {n.event_date}
                {n.reliever_employee_id && <span className="text-slate-500"> · reliever: {empName.get(n.reliever_employee_id) ?? "?"}</span>}
              </span>
              <Button variant="secondary" size="sm" disabled={busy}
                onClick={() => run(supabase.rpc("warn_repeat_no_show", { p_employee_id: n.employee_id }))}>
                Check repeat → warn
              </Button>
            </div>
          ))}
          {noshows.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No no-show events.</p>}
        </div>
        </div>
      )}

      {/* Mobilisation */}
      {tab === "mobilisation" && (
        <div className="space-y-3">
          <MobilisationForm companyId={companyId} posts={posts} contracts={contracts} run={run} busy={busy} />
          {mobs.map((m) => {
            const items = mobItems.filter((i) => i.mobilisation_id === m.id);
            const done = items.filter((i) => i.done).length;
            return (
              <div key={m.id} className="border border-slate-200 rounded-md p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-800">Mobilisation · {done}/{items.length} steps · <span className="capitalize">{m.status}</span></span>
                  {m.status !== "launched" && (
                    <Button variant="primary" size="sm" disabled={busy || done < items.length}
                      onClick={() => run(supabase.rpc("launch_site", { p_mobilisation_id: m.id }))}>
                      Launch site
                    </Button>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-1">
                  {items.map((i) => (
                    <label key={i.id} className="flex items-center gap-2 text-sm text-slate-600">
                      <input type="checkbox" checked={i.done} disabled={busy || m.status === "launched"}
                        onChange={() => run(supabase.from("contract_mobilisation_items").update({ done: !i.done }).eq("id", i.id))} />
                      <span className="capitalize">{String(i.step).replace(/_/g, " ")}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
          {mobs.length === 0 && <p className="text-sm text-slate-500">No mobilisations. Create one from a contract to launch a site from its checklist.</p>}
        </div>
      )}

      {/* Post orders */}
      {tab === "orders" && (
        <div className="space-y-3">
        <PostOrderForm companyId={companyId} posts={posts} run={run} busy={busy} />
        <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
          {orders.map((o) => (
            <div key={o.id} className="px-3 py-2 text-sm">
              <div className="text-slate-800">{o.title ?? "Post order"} <span className="text-xs text-slate-400">v{o.version} · from {o.effective_from}</span></div>
              <div className="text-slate-600 whitespace-pre-wrap mt-1">{o.body}</div>
            </div>
          ))}
          {orders.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No standing post orders.</p>}
        </div>
        </div>
      )}
    </div>
  );
}

type Run = (p: PromiseLike<{ error: { message: string } | null }>) => Promise<boolean>;
const box = "border border-slate-200 rounded-md p-3 grid grid-cols-2 md:grid-cols-6 gap-2 items-end bg-slate-50/50";

function DailyReportForm({ companyId, posts, run, busy }: { companyId: string; posts: any[]; run: Run; busy: boolean }) {
  const [postId, setPostId] = useState("");
  const [required, setRequired] = useState("");
  const [present, setPresent] = useState("");
  const [note, setNote] = useState("");
  const post = posts.find((p) => p.id === postId);
  const allOk = present !== "" && required !== "" && Number(present) >= Number(required);
  const submit = async () => {
    if (!postId) return;
    const ok = await run(supabase.from("daily_ok_reports").insert({
      company_id: companyId, post_id: postId, client_id: post?.client_id ?? null,
      report_date: new Date().toISOString().slice(0, 10),
      strength_required: Number(required) || post?.required_guards || 0,
      strength_present: Number(present) || 0, all_ok: allOk, exception_note: allOk ? null : note,
    }));
    if (ok) { setPresent(""); setNote(""); }
  };
  return (
    <div className={box}>
      <div className="col-span-2">
        <label className="text-xs text-slate-500 block mb-1">Post</label>
        <select className={FIELD + " w-full"} value={postId} onChange={(e) => setPostId(e.target.value)}>
          <option value="">— post —</option>
          {posts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div><label className="text-xs text-slate-500 block mb-1">Required</label>
        <input className={FIELD + " w-full"} value={required} onChange={(e) => setRequired(e.target.value)} placeholder={post?.required_guards ?? "0"} /></div>
      <div><label className="text-xs text-slate-500 block mb-1">Present</label>
        <input className={FIELD + " w-full"} value={present} onChange={(e) => setPresent(e.target.value)} placeholder="0" /></div>
      <input className={FIELD + " col-span-2 md:col-span-1"} placeholder="Exception note" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button variant="primary" size="sm" disabled={busy || !postId} onClick={submit}>Submit report</Button>
    </div>
  );
}

function VisitForm({ companyId, posts, employees, run, busy }: { companyId: string; posts: any[]; employees: any[]; run: Run; busy: boolean }) {
  const [postId, setPostId] = useState("");
  const [supId, setSupId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [status, setStatus] = useState("completed");
  const [findings, setFindings] = useState("");
  const post = posts.find((p) => p.id === postId);
  const submit = async () => {
    if (!postId) return;
    const ok = await run(supabase.from("supervisor_visits").insert({
      company_id: companyId, post_id: postId, client_id: post?.client_id ?? null,
      supervisor_employee_id: supId || null, scheduled_date: date, status,
      completed_at: status === "completed" ? new Date().toISOString() : null, findings,
    }));
    if (ok) setFindings("");
  };
  return (
    <div className={box}>
      <div className="col-span-2"><label className="text-xs text-slate-500 block mb-1">Post</label>
        <select className={FIELD + " w-full"} value={postId} onChange={(e) => setPostId(e.target.value)}>
          <option value="">— post —</option>{posts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></div>
      <div><label className="text-xs text-slate-500 block mb-1">Supervisor</label>
        <select className={FIELD + " w-full"} value={supId} onChange={(e) => setSupId(e.target.value)}>
          <option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
        </select></div>
      <div><label className="text-xs text-slate-500 block mb-1">Date</label>
        <input type="date" className={FIELD + " w-full"} value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <div><label className="text-xs text-slate-500 block mb-1">Status</label>
        <select className={FIELD + " w-full"} value={status} onChange={(e) => setStatus(e.target.value)}>
          {["scheduled", "completed", "missed", "cancelled"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select></div>
      <input className={FIELD + " col-span-2 md:col-span-6"} placeholder="Findings / corrective actions" value={findings} onChange={(e) => setFindings(e.target.value)} />
      <Button variant="primary" size="sm" disabled={busy || !postId} onClick={submit}>Log visit</Button>
    </div>
  );
}

function NoShowForm({ companyId, posts, employees, run, busy }: { companyId: string; posts: any[]; employees: any[]; run: Run; busy: boolean }) {
  const [postId, setPostId] = useState("");
  const [empId, setEmpId] = useState("");
  const [shift, setShift] = useState("day");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const post = posts.find((p) => p.id === postId);
  const submit = async () => {
    if (!postId || !empId) return;
    await run(supabase.from("no_show_events").insert({
      company_id: companyId, post_id: postId, client_id: post?.client_id ?? null,
      employee_id: empId, shift, event_date: date,
    }));
  };
  return (
    <div className={box}>
      <div className="col-span-2"><label className="text-xs text-slate-500 block mb-1">Post</label>
        <select className={FIELD + " w-full"} value={postId} onChange={(e) => setPostId(e.target.value)}>
          <option value="">— post —</option>{posts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></div>
      <div className="col-span-2"><label className="text-xs text-slate-500 block mb-1">Guard (no-show)</label>
        <select className={FIELD + " w-full"} value={empId} onChange={(e) => setEmpId(e.target.value)}>
          <option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
        </select></div>
      <div><label className="text-xs text-slate-500 block mb-1">Shift</label>
        <select className={FIELD + " w-full"} value={shift} onChange={(e) => setShift(e.target.value)}>
          {["day", "evening", "night"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select></div>
      <div><label className="text-xs text-slate-500 block mb-1">Date</label>
        <input type="date" className={FIELD + " w-full"} value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <Button variant="primary" size="sm" disabled={busy || !postId || !empId} onClick={submit}>Record no-show</Button>
    </div>
  );
}

function MobilisationForm({ companyId, posts, contracts, run, busy }: { companyId: string; posts: any[]; contracts: any[]; run: Run; busy: boolean }) {
  const [contractId, setContractId] = useState("");
  const [postId, setPostId] = useState("");
  const submit = async () => {
    if (!contractId || !postId) return;
    const post = posts.find((p) => p.id === postId);
    await run(supabase.from("contract_mobilisations").insert({
      company_id: companyId, contract_id: contractId, post_id: postId, branch_id: post?.branch_id ?? null, status: "pending",
    }));
  };
  return (
    <div className="border border-slate-200 rounded-md p-3 flex items-end gap-2 flex-wrap bg-slate-50/50">
      <div><label className="text-xs text-slate-500 block mb-1">Contract</label>
        <select className={FIELD} value={contractId} onChange={(e) => setContractId(e.target.value)}>
          <option value="">— contract —</option>{contracts.map((c) => <option key={c.id} value={c.id}>{c.contract_code}</option>)}
        </select></div>
      <div><label className="text-xs text-slate-500 block mb-1">Post</label>
        <select className={FIELD} value={postId} onChange={(e) => setPostId(e.target.value)}>
          <option value="">— post —</option>{posts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></div>
      <Button variant="primary" size="sm" disabled={busy || !contractId || !postId} onClick={submit}>Start mobilisation</Button>
      <span className="text-xs text-slate-400">Checklist steps are seeded automatically.</span>
    </div>
  );
}

function PostOrderForm({ companyId, posts, run, busy }: { companyId: string; posts: any[]; run: Run; busy: boolean }) {
  const [postId, setPostId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const submit = async () => {
    if (!postId || !body.trim()) return;
    const post = posts.find((p) => p.id === postId);
    const ok = await run(supabase.from("post_orders").insert({
      company_id: companyId, post_id: postId, branch_id: post?.branch_id ?? null,
      title, body, effective_from: from, active: true,
    }));
    if (ok) { setTitle(""); setBody(""); }
  };
  return (
    <div className="border border-slate-200 rounded-md p-3 space-y-2 bg-slate-50/50">
      <div className="flex items-end gap-2 flex-wrap">
        <div><label className="text-xs text-slate-500 block mb-1">Post</label>
          <select className={FIELD} value={postId} onChange={(e) => setPostId(e.target.value)}>
            <option value="">— post —</option>{posts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        <input className={FIELD + " flex-1"} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div><label className="text-xs text-slate-500 block mb-1">Effective from</label>
          <input type="date" className={FIELD} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
      </div>
      <textarea className={FIELD + " w-full"} rows={3} placeholder="Post order body" value={body} onChange={(e) => setBody(e.target.value)} />
      <Button variant="primary" size="sm" disabled={busy || !postId || !body.trim()} onClick={submit}>Publish post order</Button>
    </div>
  );
}
