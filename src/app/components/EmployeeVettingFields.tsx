// ── Vetting: Police Character Certificate + NADRA Verisys ───────────────────
//
// Lives in the employee form's Documents section. These are two documents the
// office chases and files, so they sit with the other documents rather than in a
// separate compliance panel — the person ticking "Police Verification uploaded"
// is the same person setting its status in the same breath.
//
// The armed-post blocker line is kept alongside them: it is entirely derived
// from these two statuses (armed_post_blockers, migration 0083), so it explains
// the consequence of the value right where the value is set.
import { useCallback, useEffect, useState } from "react";
import ThemedSelect from "./ThemedSelect";
import { supabase, type VettingStatus } from "../lib/supabase";

const FIELD =
  "w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";

const VETTING_BADGE: Record<VettingStatus, string> = {
  pending: "bg-warning-50 text-warning-700 border-warning-200",
  cleared: "bg-success-50 text-success-700 border-success-200",
  adverse: "bg-danger-50 text-danger-700 border-danger-200",
};

const VETTING_FIELDS = [
  ["police_verification_status", "police_verification_date", "Police character certificate"],
  ["nadra_verisys_status", "nadra_verisys_date", "NADRA Verisys"],
] as const;

export default function EmployeeVettingFields({
  employeeId,
  police,
  nadra,
  onChanged,
}: {
  employeeId: string;
  police: VettingStatus;
  nadra: VettingStatus;
  /** Called after a status is written, so the parent can refresh its copy. */
  onChanged: () => void | Promise<void>;
}) {
  const [blockers, setBlockers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadBlockers = useCallback(async () => {
    const { data } = await supabase.rpc("armed_post_blockers", { p_employee_id: employeeId });
    setBlockers(((data as string[] | null) ?? []).filter(Boolean));
  }, [employeeId]);

  useEffect(() => { loadBlockers(); }, [loadBlockers]);

  // Setting a status stamps its date, the same pairing the compliance panel used.
  const setVetting = async (
    statusField: string,
    dateField: string,
    value: VettingStatus,
  ) => {
    setBusy(true);
    setErr(null);
    const { error } = await supabase
      .from("employees")
      .update({ [statusField]: value, [dateField]: new Date().toISOString().slice(0, 10) })
      .eq("id", employeeId);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await loadBlockers();
    await onChanged();
  };

  const valueOf = (statusField: string) =>
    statusField === "police_verification_status" ? police : nadra;

  return (
    <div className="pt-3 border-t border-slate-100">
      <p className="text-sm text-slate-700 mb-2">Vetting</p>
      {err && <p className="text-xs text-danger-600 mb-2">{err}</p>}
      {VETTING_FIELDS.map(([statusField, dateField, label]) => {
        const val = valueOf(statusField);
        return (
          <div key={statusField} className="flex items-center justify-between gap-2 mb-2">
            <span className="text-sm text-slate-600">{label}</span>
            <div className="flex items-center gap-2">
              <span className={`inline-flex px-2 py-0.5 rounded-md text-xs border ${VETTING_BADGE[val]}`}>{val}</span>
              <ThemedSelect
                className={FIELD + " w-32"}
                value={val}
                disabled={busy}
                onChange={(e) => setVetting(statusField, dateField, e.target.value as VettingStatus)}
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
  );
}
