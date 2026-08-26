// ── Disciplinary Warnings ───────────────────────────────────────────────────
//
// Lives on Workforce ▸ Assignments & Pay, beside Fire / Resign. Warnings are the
// steps that lead to a separation — three active warnings is the threshold the
// office works to — so they belong next to the action they build towards rather
// than buried in a compliance panel on the employee record.
//
// Rules unchanged from the panel this came out of: a warning carries a reason,
// warning_number is assigned by the DB, and rescinding is a soft flag (the row
// stays, struck through) rather than a delete — the history of a rescinded
// warning is exactly what makes the next one defensible.
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { formatDate } from "../lib/date";
import { supabase, type DisciplinaryWarning } from "../lib/supabase";

const FIELD =
  "w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";

export type WarningTarget = {
  id: string;
  full_name: string;
  employee_code: string;
};

export default function DisciplinaryWarningsModal({
  guard,
  onClose,
}: {
  guard: WarningTarget;
  onClose: () => void;
}) {
  const [warnings, setWarnings] = useState<DisciplinaryWarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newWarning, setNewWarning] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("disciplinary_warnings")
      .select("*")
      .eq("employee_id", guard.id)
      .order("issued_on", { ascending: false });
    if (error) setErr(error.message);
    else setWarnings((data ?? []) as DisciplinaryWarning[]);
    setLoading(false);
  }, [guard.id]);

  useEffect(() => { load(); }, [load]);

  const run = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true);
    setErr(null);
    const { error } = await p;
    setBusy(false);
    if (error) { setErr(error.message); return false; }
    await load();
    return true;
  };

  const addWarning = async () => {
    if (!newWarning.trim()) return;
    if (await run(
      supabase.from("disciplinary_warnings").insert({ employee_id: guard.id, reason: newWarning.trim() }),
    )) {
      setNewWarning("");
    }
  };

  const rescindWarning = (id: string) =>
    run(supabase.from("disciplinary_warnings").update({ rescinded: true }).eq("id", id));

  const activeWarnings = warnings.filter((w) => !w.rescinded).length;

  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title={`Disciplinary Warnings — ${guard.full_name}`}
      size="sm"
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {guard.employee_code} ·{" "}
          <span className={activeWarnings >= 3 ? "text-danger-700 font-medium" : "text-slate-700"}>
            {activeWarnings}/3 active
          </span>
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : warnings.length === 0 ? (
          <p className="text-sm text-slate-500">No warnings issued.</p>
        ) : (
          <ul className="space-y-1.5 max-h-64 overflow-y-auto">
            {warnings.map((w) => (
              <li key={w.id} className="flex items-start justify-between gap-2 text-sm">
                <span className={w.rescinded ? "text-slate-400 line-through" : "text-slate-700"}>
                  #{w.warning_number} · {formatDate(w.issued_on)} · {w.reason}
                </span>
                {!w.rescinded && (
                  <button
                    type="button"
                    onClick={() => rescindWarning(w.id)}
                    className="text-xs text-slate-500 hover:text-slate-700 underline shrink-0"
                  >
                    Rescind
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-2 pt-1">
          <input
            className={FIELD}
            placeholder="New warning reason"
            value={newWarning}
            onChange={(e) => setNewWarning(e.target.value)}
          />
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={addWarning}>
            Issue
          </Button>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button variant="secondary" size="md" className="flex-1" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
