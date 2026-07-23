import ThemedSelect from "./ThemedSelect";
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import Button from "./Button";
import { formatDate } from "../lib/date";
import {
  supabase,
  LIFECYCLE_STATE_LABEL,
  LIFECYCLE_TRANSITIONS,
  TRAINING_KIND_LABEL,
  type Employee,
  type EmployeeLifecycleState,
  type VettingStatus,
  type TrainingKind,
  type DisciplinaryWarning,
  type EmployeeTrainingRecord,
  type ClearanceCertificate,
  type ServiceHistoryRow,
} from "../lib/supabase";

// §12 — Lifecycle, vetting, discipline, exit-clearance, training and the unified
// service-history timeline, all for a single employee. Reads the state machine and
// gate RPCs built in migrations 0082-0084; the DB enforces the rules, this is the
// operator surface for them.

const FIELD =
  "w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";

const VETTING_BADGE: Record<VettingStatus, string> = {
  pending: "bg-warning-50 text-warning-700 border-warning-200",
  cleared: "bg-success-50 text-success-700 border-success-200",
  adverse: "bg-danger-50 text-danger-700 border-danger-200",
};

const EXIT_STATES: EmployeeLifecycleState[] = ["left", "terminated"];

export default function EmployeeLifecyclePanel({
  employee,
  onChanged,
}: {
  employee: Employee;
  onChanged: () => void | Promise<void>;
}) {
  const [warnings, setWarnings] = useState<DisciplinaryWarning[]>([]);
  const [training, setTraining] = useState<EmployeeTrainingRecord[]>([]);
  const [clearance, setClearance] = useState<ClearanceCertificate | null>(null);
  const [history, setHistory] = useState<ServiceHistoryRow[]>([]);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Exit transition needs a reason + rehire decision (enforced in the RPC too).
  const [exitTo, setExitTo] = useState<EmployeeLifecycleState | null>(null);
  const [exitReason, setExitReason] = useState("");
  const [exitEligible, setExitEligible] = useState(true);

  const [newWarning, setNewWarning] = useState("");
  const [newTraining, setNewTraining] = useState<{
    kind: TrainingKind;
    completed_on: string;
    expires_on: string;
    provider: string;
  }>({ kind: "orientation", completed_on: "", expires_on: "", provider: "" });

  const load = useCallback(async () => {
    const [w, t, h, b] = await Promise.all([
      supabase.from("disciplinary_warnings").select("*").eq("employee_id", employee.id).order("issued_on", { ascending: false }),
      supabase.from("employee_training_records").select("*").eq("employee_id", employee.id).order("completed_on", { ascending: false }),
      supabase.from("employee_service_history").select("*").eq("employee_id", employee.id).order("event_at", { ascending: false }),
      supabase.rpc("armed_post_blockers", { p_employee_id: employee.id }),
    ]);
    setWarnings((w.data ?? []) as DisciplinaryWarning[]);
    setTraining((t.data ?? []) as EmployeeTrainingRecord[]);
    setHistory((h.data ?? []) as ServiceHistoryRow[]);
    setBlockers(((b.data as string[] | null) ?? []).filter(Boolean));
    const { data: cc } = await supabase
      .from("clearance_certificates")
      .select("*")
      .eq("employee_id", employee.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setClearance((cc as ClearanceCertificate) ?? null);
  }, [employee.id]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true);
    setErr(null);
    const { error } = await p;
    setBusy(false);
    if (error) {
      setErr(error.message);
      return false;
    }
    await load();
    await onChanged();
    return true;
  };

  const transition = (to: EmployeeLifecycleState) => {
    if (EXIT_STATES.includes(to)) {
      setExitTo(to);
      return;
    }
    run(
      supabase.rpc("transition_employee_lifecycle", {
        p_employee_id: employee.id,
        p_to_state: to,
      }),
    );
  };

  const submitExit = async () => {
    if (!exitTo) return;
    if (!exitReason.trim()) {
      setErr("Exit requires a reason.");
      return;
    }
    if (
      await run(
        supabase.rpc("transition_employee_lifecycle", {
          p_employee_id: employee.id,
          p_to_state: exitTo,
          p_reason: exitReason.trim(),
          p_eligible_for_rehire: exitEligible,
        }),
      )
    ) {
      setExitTo(null);
      setExitReason("");
      setExitEligible(true);
    }
  };

  const setVetting = (
    field: "police_verification_status" | "nadra_verisys_status",
    value: VettingStatus,
  ) => {
    const dateField = field === "police_verification_status" ? "police_verification_date" : "nadra_verisys_date";
    return run(
      supabase
        .from("employees")
        .update({ [field]: value, [dateField]: new Date().toISOString().slice(0, 10) })
        .eq("id", employee.id),
    );
  };

  const addWarning = async () => {
    if (!newWarning.trim()) return;
    if (await run(supabase.from("disciplinary_warnings").insert({ employee_id: employee.id, reason: newWarning.trim() }))) {
      setNewWarning("");
    }
  };
  const rescindWarning = (id: string) =>
    run(supabase.from("disciplinary_warnings").update({ rescinded: true, rescinded_reason: "Rescinded" }).eq("id", id));

  const addTraining = async () => {
    if (!newTraining.completed_on) {
      setErr("Training needs a completion date.");
      return;
    }
    if (
      await run(
        supabase.from("employee_training_records").insert({
          employee_id: employee.id,
          kind: newTraining.kind,
          completed_on: newTraining.completed_on,
          expires_on: newTraining.expires_on || null,
          provider: newTraining.provider.trim() || null,
        }),
      )
    ) {
      setNewTraining({ kind: "orientation", completed_on: "", expires_on: "", provider: "" });
    }
  };

  const assessClearance = () =>
    run(supabase.rpc("assess_clearance", { p_employee_id: employee.id }));
  const releaseDues = () =>
    run(supabase.rpc("release_final_dues", { p_employee_id: employee.id }));

  const activeWarnings = warnings.filter((w) => !w.rescinded).length;

  return (
    <div className="pt-4 border-t border-slate-200 space-y-6">
      <h4 className="text-sm text-slate-900">Lifecycle &amp; Compliance</h4>
      {err && <p className="text-xs text-danger-600">{err}</p>}

      {/* Lifecycle state + transitions */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm text-slate-500">State:</span>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs bg-slate-100 text-slate-700 border border-slate-200">
            {LIFECYCLE_STATE_LABEL[employee.lifecycle_state]}
          </span>
          {employee.rehire_count > 0 && (
            <span className="text-xs text-slate-400">rehired ×{employee.rehire_count}</span>
          )}
          {employee.pending_termination_review && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs bg-danger-50 text-danger-700 border border-danger-200">
              Termination review
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {LIFECYCLE_TRANSITIONS[employee.lifecycle_state].map((to) => (
            <Button key={to} type="button" variant="secondary" size="sm" disabled={busy} onClick={() => transition(to)}>
              → {LIFECYCLE_STATE_LABEL[to]}
            </Button>
          ))}
        </div>
        {exitTo && (
          <div className="mt-2 p-2 bg-slate-50 rounded border border-slate-200 space-y-2">
            <p className="text-xs text-slate-600">Exit to {LIFECYCLE_STATE_LABEL[exitTo]} — reason required.</p>
            <input className={FIELD} placeholder="Exit reason" value={exitReason} onChange={(e) => setExitReason(e.target.value)} />
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={exitEligible} onChange={(e) => setExitEligible(e.target.checked)} />
              <span>Eligible for rehire</span>
            </label>
            <div className="flex gap-2">
              <Button type="button" variant="primary" size="sm" disabled={busy} onClick={submitExit}>
                Confirm exit
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => setExitTo(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Vetting */}
      <div>
        <p className="text-sm text-slate-700 mb-2">Vetting</p>
        {(["police_verification_status", "nadra_verisys_status"] as const).map((field) => {
          const label = field === "police_verification_status" ? "Police character certificate" : "NADRA Verisys";
          const val = employee[field];
          return (
            <div key={field} className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm text-slate-600">{label}</span>
              <div className="flex items-center gap-2">
                <span className={`inline-flex px-2 py-0.5 rounded-md text-xs border ${VETTING_BADGE[val]}`}>{val}</span>
                <ThemedSelect
                  className={FIELD + " w-32"}
                  value={val}
                  disabled={busy}
                  onChange={(e) => setVetting(field, e.target.value as VettingStatus)}
                >
                  <option value="pending">pending</option>
                  <option value="cleared">cleared</option>
                  <option value="adverse">adverse</option>
                </ThemedSelect>
              </div>
            </div>
          );
        })}
        <div className={`text-xs mt-1 ${blockers.length ? "text-danger-700" : "text-success-700"}`}>
          {blockers.length ? `Armed post blocked: ${blockers.join(", ")}` : "Eligible for armed / sensitive posts"}
        </div>
      </div>

      {/* Discipline */}
      <div>
        <p className="text-sm text-slate-700 mb-2">
          Disciplinary Warnings <span className="text-xs text-slate-400">({activeWarnings}/3 active)</span>
        </p>
        {warnings.length > 0 && (
          <ul className="space-y-1 mb-2">
            {warnings.map((w) => (
              <li key={w.id} className="flex items-center justify-between text-sm">
                <span className={w.rescinded ? "text-slate-400 line-through" : "text-slate-700"}>
                  #{w.warning_number} · {formatDate(w.issued_on)} · {w.reason}
                </span>
                {!w.rescinded && (
                  <button type="button" onClick={() => rescindWarning(w.id)} className="text-xs text-slate-500 hover:text-slate-700 underline">
                    Rescind
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input className={FIELD} placeholder="New warning reason" value={newWarning} onChange={(e) => setNewWarning(e.target.value)} />
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={addWarning}>
            Issue
          </Button>
        </div>
      </div>

      {/* Training */}
      <div>
        <p className="text-sm text-slate-700 mb-2">Training &amp; Competence</p>
        <div className="flex flex-wrap gap-2 text-xs mb-2">
          <span className={`px-2 py-0.5 rounded-md border ${employee.orientation_done ? "bg-success-50 text-success-700 border-success-200" : "bg-slate-100 text-slate-500 border-slate-200"}`}>
            Orientation {employee.orientation_done ? "✓" : "—"}
          </span>
          <span className={`px-2 py-0.5 rounded-md border ${employee.weapons_certified ? "bg-success-50 text-success-700 border-success-200" : "bg-slate-100 text-slate-500 border-slate-200"}`}>
            Weapons cert {employee.weapons_certified ? (employee.weapons_cert_expiry ? `→ ${formatDate(employee.weapons_cert_expiry)}` : "✓") : "—"}
          </span>
        </div>
        {training.length > 0 && (
          <ul className="space-y-1 mb-2">
            {training.map((t) => (
              <li key={t.id} className="text-sm text-slate-700">
                {TRAINING_KIND_LABEL[t.kind]} · {formatDate(t.completed_on)}
                {t.expires_on ? ` (expires ${formatDate(t.expires_on)})` : ""}
                {t.provider ? ` · ${t.provider}` : ""}
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2">
          <ThemedSelect
            className={FIELD}
            value={newTraining.kind}
            onChange={(e) => setNewTraining({ ...newTraining, kind: e.target.value as TrainingKind })}
          >
            {Object.entries(TRAINING_KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </ThemedSelect>
          <input type="date" className={FIELD} value={newTraining.completed_on} onChange={(e) => setNewTraining({ ...newTraining, completed_on: e.target.value })} title="Completed on" />
          <input type="date" className={FIELD} value={newTraining.expires_on} onChange={(e) => setNewTraining({ ...newTraining, expires_on: e.target.value })} title="Expires on" />
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={addTraining}>
            Add
          </Button>
        </div>
      </div>

      {/* Exit clearance */}
      <div>
        <p className="text-sm text-slate-700 mb-2">Exit Clearance</p>
        {clearance ? (
          <div className="text-sm text-slate-700 space-y-1 mb-2">
            <div>
              Status:{" "}
              <span className={clearance.status === "cleared" ? "text-success-700" : clearance.status === "blocked" ? "text-danger-700" : "text-slate-600"}>
                {clearance.status}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              Kit outstanding: {clearance.outstanding_kit_count ?? "—"} · Advance outstanding:{" "}
              {clearance.outstanding_advance != null ? clearance.outstanding_advance.toLocaleString() : "—"} · Salary undisbursed:{" "}
              {clearance.undisbursed_salary != null ? clearance.undisbursed_salary.toLocaleString() : "—"} · Open incidents:{" "}
              {clearance.open_incident_count ?? "—"}
            </div>
            {clearance.dues_released && (
              <div className="text-xs text-success-700">Final dues released {clearance.dues_released_on ? `on ${formatDate(clearance.dues_released_on)}` : ""}</div>
            )}
          </div>
        ) : (
          <p className="text-xs text-slate-500 mb-2">No clearance assessed yet.</p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={assessClearance}>
            Assess clearance
          </Button>
          <Button
            type="button"
            variant="success"
            size="sm"
            disabled={busy || clearance?.status !== "cleared" || clearance?.dues_released}
            onClick={releaseDues}
          >
            Release final dues
          </Button>
        </div>
      </div>

      {/* Service history timeline */}
      <div>
        <p className="text-sm text-slate-700 mb-2">Service History</p>
        {history.length === 0 ? (
          <p className="text-xs text-slate-500">No events yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {history.map((h, i) => (
              <li key={i} className="text-sm text-slate-700 flex gap-2">
                <span className="text-xs text-slate-400 w-24 flex-shrink-0">{formatDate(h.event_at.slice(0, 10))}</span>
                <span className="text-xs uppercase text-slate-400 w-16 flex-shrink-0">{h.kind}</span>
                <span>
                  {h.title}
                  {h.detail ? <span className="text-slate-500"> — {h.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
