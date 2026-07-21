import { useCallback, useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase, type Branch } from "../../lib/supabase";

// §28.1 / §13 — payroll as a pipeline-with-exceptions. Draft → Review →
// Approve (locks) → Disburse → Complete. Disbursement is only reachable after
// approval, and approval is gated on every exception being resolved or
// accepted-with-reason — the DB enforces both, so the safe path is the only
// path. Payslip amounts are generated on the Payroll calculation screen; this
// wraps a run around them.

const STAGES = ["draft", "review", "approved", "disbursed", "completed"] as const;
const STAGE_LABEL: Record<string, string> = {
  draft: "Draft", review: "Review", approved: "Approved", disbursed: "Disbursed", completed: "Complete",
};
const BAND: Record<string, string> = {
  green: "bg-success-500", amber: "bg-warning-500", red: "bg-danger-500",
};
const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";
const money = (n: any) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const monthStart = () => new Date().toISOString().slice(0, 8) + "01";

const EXC_LABELS: [string, string][] = [
  ["has_unmarked", "unmarked days"],
  ["low_attendance", "<50% attendance"],
  ["zero_value", "zero-value pay"],
  ["pay_changed", "pay changed vs last month"],
  ["is_joiner", "joiner pro-rata"],
  ["is_leaver", "leaver settlement"],
  ["has_advance_netting", "advance netting"],
];

export default function PayrollRuns() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [totals, setTotals] = useState<any[]>([]);
  const [exceptions, setExceptions] = useState<any[]>([]);
  const [cockpit, setCockpit] = useState<any>(null);
  const [danger, setDanger] = useState<any>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  const [period, setPeriod] = useState(monthStart());
  const [stream, setStream] = useState<"guard_field" | "salaried">("guard_field");
  const [regionId, setRegionId] = useState<string>("");

  const load = useCallback(async () => {
    if (!companyId) return;
    const [br, rn, tt, cc, dl] = await Promise.all([
      supabase.from("branches").select("*").eq("company_id", companyId).order("is_head_office", { ascending: false }).order("name"),
      supabase.from("payroll_runs").select("*").eq("company_id", companyId).neq("status", "cancelled").order("created_at", { ascending: false }),
      supabase.from("payroll_run_totals").select("*").eq("company_id", companyId),
      supabase.from("cash_cockpit").select("available_after_reserves").eq("company_id", companyId).maybeSingle(),
      supabase.from("danger_level").select("band").eq("company_id", companyId).maybeSingle(),
    ]);
    setBranches((br.data ?? []) as Branch[]);
    setRuns(rn.data ?? []);
    setTotals(tt.data ?? []);
    setCockpit(cc.data);
    setDanger(dl.data);
  }, [companyId]);

  const loadExceptions = useCallback(async (runId: string) => {
    const { data } = await supabase.from("payroll_run_exceptions").select("*").eq("payroll_run_id", runId);
    setExceptions(data ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (selectedRun) loadExceptions(selectedRun); else setExceptions([]); }, [selectedRun, loadExceptions, runs]);

  const run = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setErr(null);
    const { error } = await p;
    setBusy(false);
    if (error) { setErr(error.message); return false; }
    await load();
    return true;
  };

  const createRun = async () => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.from("payroll_runs")
      .insert({ period_month: period, stream, branch_id: regionId || null })
      .select("id").single();
    if (error) { setBusy(false); setErr(error.message); return; }
    // Attach any existing payslips for this period/stream/region.
    const { error: aErr } = await supabase.rpc("payroll_run_attach", { p_run_id: data.id });
    setBusy(false);
    if (aErr) setErr(aErr.message);
    setSelectedRun(data.id);
    await load();
  };

  const ackException = async (payslipId: string) => {
    const reason = window.prompt("Reason to accept this exception:") ?? "";
    if (!reason.trim()) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("acknowledge_payroll_exception", { p_payslip_id: payslipId, p_reason: reason });
    setBusy(false);
    if (error) setErr(error.message);
    if (selectedRun) await loadExceptions(selectedRun);
  };

  const branchName = useMemo(() => new Map(branches.map((b) => [b.id, b.name])), [branches]);
  const totalsByRun = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const t of totals) {
      const arr = m.get(t.payroll_run_id) ?? [];
      arr.push(t); m.set(t.payroll_run_id, arr);
    }
    return m;
  }, [totals]);

  const unackedCount = exceptions.filter((e) => !e.acknowledged).length;

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header
        title="Payroll Runs"
        subtitle="Draft → Review → Approve → Disburse → Complete"
        actions={
          <div className="flex items-center gap-2 text-sm">
            {danger?.band && <span className={`inline-block w-2.5 h-2.5 rounded-full ${BAND[danger.band] ?? "bg-slate-300"}`} title={`Cash band: ${danger.band}`} />}
            <span className="text-slate-500">Available after reserves</span>
            <span className="tabular-nums text-slate-900">PKR {money(cockpit?.available_after_reserves)}</span>
          </div>
        }
      />

      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      {/* Create run */}
      <section className="border border-slate-200 rounded-md p-3 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <input type="date" className={FIELD} value={period} onChange={(e) => setPeriod(e.target.value)} />
          <select className={FIELD} value={stream} onChange={(e) => setStream(e.target.value as any)}>
            <option value="guard_field">Guards &amp; Field</option>
            <option value="salaried">Salaried Staff</option>
          </select>
          <select className={FIELD} value={regionId} onChange={(e) => setRegionId(e.target.value)}>
            <option value="">All regions</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <Button variant="primary" size="sm" disabled={busy} onClick={createRun}>Create run &amp; attach payslips</Button>
        </div>
        <p className="text-xs text-slate-400 mt-1">Generate payslips on the Payroll screen first; a run attaches the matching payslips for its period, stream and region.</p>
      </section>

      {/* Runs */}
      <div className="space-y-3">
        {runs.map((r) => {
          const selected = selectedRun === r.id;
          const rt = totalsByRun.get(r.id) ?? [];
          const gross = rt.reduce((s, t) => s + Number(t.gross ?? 0), 0);
          const ded = rt.reduce((s, t) => s + Number(t.total_deductions ?? 0), 0);
          const net = rt.reduce((s, t) => s + Number(t.net ?? 0), 0);
          const count = rt.reduce((s, t) => s + Number(t.payslip_count ?? 0), 0);
          return (
            <div key={r.id} className={`border rounded-md ${selected ? "border-brand-300" : "border-slate-200"}`}>
              <button className="w-full flex items-center justify-between px-3 py-2 text-left"
                onClick={() => setSelectedRun(selected ? null : r.id)}>
                <span className="text-sm text-slate-800">
                  {String(r.period_month).slice(0, 7)} · {r.stream === "salaried" ? "Salaried" : "Guards & Field"}
                  {r.branch_id ? ` · ${branchName.get(r.branch_id) ?? ""}` : " · All regions"}
                  <span className="text-slate-400"> · {count} payslips</span>
                </span>
                <StageBar status={r.status} />
              </button>

              {selected && (
                <div className="border-t border-slate-100 p-3 space-y-4">
                  {/* Stage actions */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {r.status === "draft" && (
                      <>
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => run(supabase.rpc("payroll_run_attach", { p_run_id: r.id }))}>Re-attach payslips</Button>
                        <Button variant="primary" size="sm" disabled={busy} onClick={() => run(supabase.rpc("transition_payroll_run", { p_run_id: r.id, p_to: "review" }))}>Submit for review</Button>
                      </>
                    )}
                    {r.status === "review" && (
                      <>
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => run(supabase.rpc("transition_payroll_run", { p_run_id: r.id, p_to: "draft" }))}>Back to draft</Button>
                        <Button variant="primary" size="sm" disabled={busy || unackedCount > 0}
                          onClick={() => run(supabase.rpc("transition_payroll_run", { p_run_id: r.id, p_to: "approved" }))}>
                          {unackedCount > 0 ? `Approve (resolve ${unackedCount} exception${unackedCount === 1 ? "" : "s"})` : "Approve & lock"}
                        </Button>
                      </>
                    )}
                    {r.status === "approved" && (
                      <>
                        <Button variant="secondary" size="sm" disabled={busy} onClick={() => run(supabase.rpc("transition_payroll_run", { p_run_id: r.id, p_to: "review" }))}>Reopen</Button>
                        <Button variant="primary" size="sm" disabled={busy} onClick={() => run(supabase.rpc("disburse_payroll_run", { p_run_id: r.id }))}>Disburse approved batch</Button>
                      </>
                    )}
                    {r.status === "disbursed" && (
                      <Button variant="primary" size="sm" disabled={busy} onClick={() => run(supabase.rpc("transition_payroll_run", { p_run_id: r.id, p_to: "completed" }))}>Complete &amp; archive</Button>
                    )}
                  </div>

                  {/* Exceptions panel — gates Approve */}
                  {(r.status === "draft" || r.status === "review") && (
                    <section>
                      <h4 className="text-sm text-slate-900 mb-2">
                        Exceptions {exceptions.length > 0 && <span className="text-xs text-slate-500">({unackedCount} unresolved)</span>}
                      </h4>
                      {exceptions.length === 0 ? (
                        <p className="text-sm text-success-700">No exceptions — clear to approve.</p>
                      ) : (
                        <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
                          {exceptions.map((e) => (
                            <div key={e.payslip_id} className={`flex items-center justify-between px-3 py-2 text-sm ${e.acknowledged ? "" : "bg-warning-50"}`}>
                              <div>
                                <span className="text-slate-800">{e.full_name}</span>
                                <span className="text-slate-500"> · net {money(e.net_salary)}{e.unmarked_days > 0 ? ` · ${e.unmarked_days} unmarked` : ""}</span>
                                <div className="flex gap-1 flex-wrap mt-0.5">
                                  {EXC_LABELS.filter(([k]) => e[k]).map(([k, label]) => (
                                    <span key={k} className="text-xs px-1.5 py-0.5 rounded bg-danger-50 text-danger-700 border border-danger-200">{label}</span>
                                  ))}
                                </div>
                              </div>
                              {e.acknowledged
                                ? <span className="text-xs text-success-700" title={e.ack_reason}>accepted ✓</span>
                                : <Button variant="secondary" size="sm" disabled={busy} onClick={() => ackException(e.payslip_id)}>Accept with reason</Button>}
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  )}

                  {/* Batch totals footer, split by region */}
                  <section>
                    <h4 className="text-sm text-slate-900 mb-2">Batch totals</h4>
                    <div className="overflow-x-auto border border-slate-200 rounded-md">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                          <tr>
                            <th className="text-left px-3 py-2">Region</th>
                            <th className="text-right px-3 py-2">Payslips</th>
                            <th className="text-right px-3 py-2">Gross</th>
                            <th className="text-right px-3 py-2">Deductions</th>
                            <th className="text-right px-3 py-2">Net</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {rt.map((t, i) => (
                            <tr key={i}>
                              <td className="px-3 py-1.5 text-slate-700">{t.region_name ?? "—"}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{t.payslip_count}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{money(t.gross)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{money(t.total_deductions)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums">{money(t.net)}</td>
                            </tr>
                          ))}
                          <tr className="bg-slate-50 font-medium">
                            <td className="px-3 py-1.5 text-slate-700">Total ({count})</td>
                            <td className="px-3 py-1.5" />
                            <td className="px-3 py-1.5 text-right tabular-nums">{money(gross)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{money(ded)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{money(net)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </section>
                </div>
              )}
            </div>
          );
        })}
        {runs.length === 0 && <p className="text-sm text-slate-500">No payroll runs yet.</p>}
      </div>
    </div>
  );
}

function StageBar({ status }: { status: string }) {
  const idx = STAGES.indexOf(status as any);
  return (
    <span className="flex items-center gap-1">
      {STAGES.map((s, i) => (
        <span key={s} className="flex items-center gap-1">
          <span className={`text-xs px-2 py-0.5 rounded-md border ${
            i < idx ? "bg-success-50 text-success-700 border-success-200"
              : i === idx ? "bg-brand-50 text-brand-700 border-brand-300"
              : "bg-slate-50 text-slate-400 border-slate-200"}`}>
            {STAGE_LABEL[s]}
          </span>
          {i < STAGES.length - 1 && <span className="text-slate-300">→</span>}
        </span>
      ))}
    </span>
  );
}
