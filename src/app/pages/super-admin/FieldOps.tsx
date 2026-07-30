import ThemedSelect from "../../components/ThemedSelect";
import { useCallback, useEffect, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { generateDailyOperationsReportPdf } from "../../lib/dailyReportPdf";

// Operations ▸ Daily Reports (repurposed Field Operations). Date-wise per-post
// OK reporting with silent-site alerting + branded PDF export and a durable
// record. The old supervisor-visit / no-show / mobilisation / post-order tabs
// were dropped in the consolidation (supervisor handles those; not logged here).

const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";

export default function FieldOps() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [reportStatus, setReportStatus] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [exports, setExports] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [rs, ps, dx] = await Promise.all([
      supabase.from("daily_report_status").select("*").eq("company_id", companyId),
      supabase.from("posts").select("id, name, client_id, branch_id, contract_id, required_guards").eq("company_id", companyId).eq("active", true).order("name"),
      supabase.from("daily_report_exports").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(8),
    ]);
    setReportStatus(rs.data ?? []);
    setPosts(ps.data ?? []);
    setExports(dx.data ?? []);
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

  // Generate the branded PDF and write a durable export record (counts snapshot).
  const exportDailyReport = async () => {
    const today = new Date().toISOString().slice(0, 10);
    generateDailyOperationsReportPdf(company, today, reportStatus);
    setBusy(true); setErr(null);
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.from("daily_report_exports").insert({
      report_date: today,
      total_posts: reportStatus.length,
      reported: reportStatus.filter((r) => r.reported_today).length,
      silent: reportStatus.filter((r) => r.is_silent).length,
      exceptions: reportStatus.filter((r) => r.reported_today && r.all_ok === false).length,
      generated_by: userData.user?.id ?? null,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await load();
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header
        title="Daily Reports"
        subtitle="Date-wise per-post OK reporting, silent-site alerting and PDF export"
      />

      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">
            Date-wise per-post reporting. {silent.length > 0 && <span className="text-danger-600">{silent.length} silent.</span>}
          </p>
          <Button variant="secondary" size="sm" disabled={busy || reportStatus.length === 0} onClick={exportDailyReport}>
            Download PDF
          </Button>
        </div>
        <DailyReportForm companyId={companyId} posts={posts} run={run} busy={busy} />
        {exports.length > 0 && (
          <div className="text-xs text-slate-500">
            <span className="text-slate-400">Recent exports:</span>{" "}
            {exports.map((e, i) => (
              <span key={e.id}>
                {i > 0 && " · "}
                <span title={`${e.reported}/${e.total_posts} reported, ${e.silent} silent, ${e.exceptions} exceptions`}>
                  {e.report_date}
                </span>
              </span>
            ))}
          </div>
        )}
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
        <ThemedSelect className={FIELD + " w-full"} value={postId} onChange={(e) => setPostId(e.target.value)}>
          <option value="">— post —</option>
          {posts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </ThemedSelect>
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
