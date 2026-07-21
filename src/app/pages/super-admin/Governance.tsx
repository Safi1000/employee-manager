import { useCallback, useEffect, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";

// §2 governance surface: the approval-workflow engine (pending requests +
// decisions, all logged) and department assignment for salaried staff.

type Tab = "approvals" | "departments";
const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";
const DEPARTMENTS = ["operations", "compliance", "hr", "finance", "client_management"] as const;

export default function Governance() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [tab, setTab] = useState<Tab>("approvals");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [requests, setRequests] = useState<any[]>([]);
  const [configs, setConfigs] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [rq, cf, st] = await Promise.all([
      supabase.from("approval_requests").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(100),
      supabase.from("approval_configs").select("*").eq("company_id", companyId).order("action_key"),
      supabase.from("profiles").select("id, full_name, email, department, is_rmd").eq("company_id", companyId).order("full_name"),
    ]);
    setRequests(rq.data ?? []);
    setConfigs(cf.data ?? []);
    setStaff(st.data ?? []);
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

  const pending = requests.filter((r) => r.status === "pending" || r.status === "recommended");

  // §2: apply a department's default permission set to a staff profile.
  const applyDeptDefaults = async (profileId: string, dept: string | null) => {
    if (!dept) { setErr("Assign a department before applying its permission set."); return; }
    setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc("department_default_permissions", { p_dept: dept });
    if (error) { setBusy(false); setErr(error.message); return; }
    const perms = (data as string[]) ?? [];
    const upd = await supabase.from("profiles").update({ permissions: perms }).eq("id", profileId);
    setBusy(false);
    if (upd.error) { setErr(upd.error.message); return; }
    await load();
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header title="Governance" subtitle="Approval workflow engine and department roles" />

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {([["approvals", `Approvals${pending.length ? ` (${pending.length})` : ""}`], ["departments", "Departments"]] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {label}
          </button>
        ))}
      </div>

      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      {tab === "approvals" && (
        <div className="space-y-4">
          <section>
            <h3 className="text-sm text-slate-900 mb-2">Pending requests</h3>
            <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
              {pending.map((r) => (
                <div key={r.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-slate-700">
                    {String(r.action_key).replace(/_/g, " ")}
                    {r.amount != null && <span className="text-slate-500"> · {Number(r.amount).toLocaleString()}</span>}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button variant="primary" size="sm" disabled={busy}
                      onClick={() => run(supabase.rpc("decide_approval", { p_request_id: r.id, p_approve: true, p_reason: null }))}>Approve</Button>
                    <Button variant="secondary" size="sm" disabled={busy}
                      onClick={() => run(supabase.rpc("decide_approval", { p_request_id: r.id, p_approve: false, p_reason: null }))}>Reject</Button>
                  </div>
                </div>
              ))}
              {pending.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No pending requests.</p>}
            </div>
          </section>

          <section>
            <h3 className="text-sm text-slate-900 mb-2">Decision log</h3>
            <div className="border border-slate-200 rounded-md divide-y divide-slate-100 max-h-72 overflow-y-auto">
              {requests.filter((r) => r.status !== "pending").map((r) => (
                <div key={r.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
                  <span className="text-slate-600">{String(r.action_key).replace(/_/g, " ")}{r.amount != null && ` · ${Number(r.amount).toLocaleString()}`}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200">{r.status}</span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-sm text-slate-900 mb-2">Action thresholds</h3>
            <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
              {configs.map((c) => (
                <div key={c.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
                  <span className="text-slate-700">{c.name}</span>
                  <span className="text-xs text-slate-500">approver: {c.approver_permission}{c.threshold_amount != null && ` · > ${Number(c.threshold_amount).toLocaleString()}`}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === "departments" && (
        <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
          {staff.map((s) => (
            <div key={s.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-slate-700">{s.full_name ?? s.email}</span>
              <div className="flex items-center gap-2">
                <select className={FIELD} value={s.department ?? ""}
                  onChange={(e) => run(supabase.from("profiles").update({ department: e.target.value || null }).eq("id", s.id))}>
                  <option value="">— department —</option>
                  {DEPARTMENTS.map((d) => <option key={d} value={d}>{d.replace(/_/g, " ")}</option>)}
                </select>
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  <input type="checkbox" checked={!!s.is_rmd}
                    onChange={() => run(supabase.from("profiles").update({ is_rmd: !s.is_rmd }).eq("id", s.id))} />
                  RMD
                </label>
                <Button variant="secondary" size="sm" disabled={busy || !s.department}
                  onClick={() => applyDeptDefaults(s.id, s.department)}>Apply dept permissions</Button>
              </div>
            </div>
          ))}
          {staff.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No staff accounts.</p>}
        </div>
      )}
    </div>
  );
}
