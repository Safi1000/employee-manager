// ── Fire / Resign a guard ───────────────────────────────────────────────────
//
// Lives on Workforce ▸ Assignments & Pay, which is where postings are managed —
// separating someone is the end of a posting, so it belongs beside the actions
// that create and move them rather than on the roster screen.
//
// Rules unchanged from where this used to live on Employee Management:
//   · Firing and Resignation behave IDENTICALLY for the roster (both close the
//     active posting and set last_working_day). They differ only in the recorded
//     reason and the default rehire eligibility.
//   · record_separation is what actually removes the guard from the roster from
//     the day after the last working day; prior attendance stays intact.
//   · assess_clearance is snapshotted afterwards so the exit-clearance panel
//     reflects the outstanding dues as they stood at separation.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { supabase } from "../lib/supabase";

const todayIso = () => new Date().toISOString().slice(0, 10);

/** What the guard still owes / is owed at the moment of separation. */
type ExitGates = {
  outstanding_kit_count: number;
  outstanding_advance: number;
  open_incident_count: number;
  undisbursed_salary: number;
};

export type FireGuardTarget = {
  id: string;
  full_name: string;
  employee_code: string;
};

export default function FireGuardModal({
  guard,
  onClose,
  onDone,
}: {
  guard: FireGuardTarget;
  onClose: () => void;
  /** Called after a successful separation, with the resulting lifecycle state. */
  onDone: (result: {
    id: string;
    lifecycle_state: "left" | "fired";
    eligible_for_rehire: boolean;
  }) => void | Promise<void>;
}) {
  const [gates, setGates] = useState<ExitGates | null>(null);
  const [gatesLoading, setGatesLoading] = useState(true);
  const [reason, setReason] = useState("");
  const [eligible, setEligible] = useState(false); // firing defaults to NOT rehire-eligible
  const [type, setType] = useState<"firing" | "resignation">("firing");
  const [date, setDate] = useState<string>(todayIso());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setGatesLoading(true);
    supabase
      .rpc("employee_clearance_gates", { p_employee_id: guard.id })
      .then(({ data, error: gErr }) => {
        if (!alive) return;
        setGatesLoading(false);
        if (gErr) { setError(gErr.message); return; }
        // A returns-table RPC comes back as an array of one row.
        const row = Array.isArray(data) ? data[0] : data;
        if (row) {
          setGates({
            outstanding_kit_count: Number(row.outstanding_kit_count ?? 0),
            outstanding_advance: Number(row.outstanding_advance ?? 0),
            open_incident_count: Number(row.open_incident_count ?? 0),
            undisbursed_salary: Number(row.undisbursed_salary ?? 0),
          });
        }
      });
    return () => { alive = false; };
  }, [guard.id]);

  const confirm = async () => {
    if (!reason.trim()) { setError("A reason is required."); return; }
    if (!date) { setError("An effective (last working) date is required."); return; }
    setSubmitting(true);
    setError(null);
    // §9: record_separation sets last_working_day + termination_date, records the
    // reason + rehire flag, moves lifecycle_state, and CLOSES the active posting
    // (end_date = last working day). This is what removes the guard from the
    // roster from the day after — the old transition RPC did none of that.
    const reasonVal = type === "resignation" ? "resignation" : "termination_misconduct";
    const { error: sErr } = await supabase.rpc("record_separation", {
      p_guard: guard.id,
      p_reason: reasonVal,
      p_last_working_day: date,
      p_termination_date: date,
      p_rehire_eligible: eligible,
      p_note: reason.trim(),
    });
    if (sErr) { setSubmitting(false); setError(sErr.message); return; }
    // Snapshot the exit clearance so the panel reflects the outstanding dues.
    await supabase.rpc("assess_clearance", { p_employee_id: guard.id });
    setSubmitting(false);
    await onDone({
      id: guard.id,
      lifecycle_state: type === "resignation" ? "left" : "fired",
      eligible_for_rehire: eligible,
    });
  };

  const hasOutstanding =
    !!gates &&
    (gates.undisbursed_salary > 0 ||
      gates.outstanding_advance > 0 ||
      gates.outstanding_kit_count > 0 ||
      gates.open_incident_count > 0);

  return (
    <Modal
      isOpen
      error={error}
      onDismissError={() => setError(null)}
      onClose={onClose}
      title="Fire / Resign guard"
      size="sm"
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Separating{" "}
          <span className="text-slate-900 font-medium">{guard.full_name}</span>{" "}
          ({guard.employee_code}). Removes them from the roster from the day
          after the last working day; prior attendance stays intact.
        </p>

        {/* Separation type — both remove from the roster identically; they
            differ only in recorded reason + default rehire eligibility. */}
        <div>
          <span className="block text-sm text-slate-700 mb-1">Separation type</span>
          <div className="flex gap-2">
            {([["firing", "Firing"], ["resignation", "Resignation"]] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => { setType(val); setEligible(val === "resignation"); }}
                className={`flex-1 px-3 py-2 rounded-md text-sm border transition-colors ${type === val ? "bg-brand-500 text-brand-950 border-brand-500 font-medium" : "border-border text-muted-foreground hover:bg-accent"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Effective date — Today or a picker. */}
        <div>
          <label className="block text-sm text-slate-700 mb-1">Effective (last working) date *</label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDate(todayIso())}
              className={`px-3 py-2 rounded-md text-sm border ${date === todayIso() ? "bg-slate-100 border-slate-300 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              Today
            </button>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="flex-1 px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
        </div>

        {/* Outstanding dues — only shown when there is something outstanding. */}
        {gatesLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking outstanding dues…
          </div>
        ) : hasOutstanding && gates ? (
          <div className="rounded-md border border-warning-200 bg-warning-50 p-3 space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-warning-800">
              Outstanding before exit
            </p>
            <ul className="text-sm text-warning-900 space-y-1">
              {gates.undisbursed_salary > 0 && (
                <li className="flex justify-between gap-4">
                  <span>Salary not yet disbursed</span>
                  <span className="font-medium tabular-nums">{gates.undisbursed_salary.toLocaleString()}</span>
                </li>
              )}
              {gates.outstanding_advance > 0 && (
                <li className="flex justify-between gap-4">
                  <span>Advance outstanding</span>
                  <span className="font-medium tabular-nums">{gates.outstanding_advance.toLocaleString()}</span>
                </li>
              )}
              {gates.outstanding_kit_count > 0 && (
                <li className="flex justify-between gap-4">
                  <span>Equipment / kit not returned</span>
                  <span className="font-medium tabular-nums">{gates.outstanding_kit_count} item{gates.outstanding_kit_count === 1 ? "" : "s"}</span>
                </li>
              )}
              {gates.open_incident_count > 0 && (
                <li className="flex justify-between gap-4">
                  <span>Open incidents</span>
                  <span className="font-medium tabular-nums">{gates.open_incident_count}</span>
                </li>
              )}
            </ul>
            <p className="text-xs text-warning-700 pt-1">
              These are recorded on the exit clearance; final dues can only be released once settled.
            </p>
          </div>
        ) : gates ? (
          <p className="text-sm text-success-700">No outstanding dues, kit, or open incidents.</p>
        ) : null}

        <div>
          <label className="block text-sm text-slate-700 mb-1">
            {type === "resignation" ? "Resignation note *" : "Reason for firing *"}
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            placeholder={type === "resignation" ? "e.g. Resigned for personal reasons…" : "e.g. Repeated no-shows, misconduct…"}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
          <span>Eligible for rehire</span>
        </label>

        <div className="flex items-center gap-3 pt-2">
          <Button
            variant="danger"
            size="md"
            className="flex-1"
            disabled={submitting || gatesLoading}
            onClick={confirm}
          >
            {submitting ? "Saving…" : type === "resignation" ? "Confirm Resignation" : "Confirm Fire"}
          </Button>
          <Button variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
