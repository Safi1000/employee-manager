// ── Disciplinary Warnings ───────────────────────────────────────────────────
//
// Lives on Workforce ▸ Assignments & Pay, beside Fire / Resign. Warnings are the
// steps that lead to a separation, so they belong next to the action they build
// towards rather than buried in a compliance panel on the employee record.
//
// 0617 (DECIDED 30 Oct 2026):
//   * SOFT warnings — as many as needed, a history only: no fine, no count.
//   * FORMAL warnings — 3 in a rolling 12 months; the 3rd flags the guard for
//     termination review (HR separates him through Fire, as always).
//   * A fine is 1–6 days' salary and is set by HR only — whoever holds
//     warnings.approve. It then waits on Payroll ("Fines from warnings") until
//     HR adds it to the payslip.
//   * A formal warning raised on the field app arrives PENDING and is approved
//     or refused here or on Workforce › Warnings.
//
// Rules unchanged from before: a warning carries a reason, warning_number is
// assigned by the DB (now: at approval, inside the 12-month window), and
// rescinding is a soft flag (the row stays, struck through) rather than a
// delete — the history of a rescinded warning is what makes the next one
// defensible.
import { useEmployeeCodeIndex } from "../lib/employeeCodes";
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { formatDate } from "../lib/date";
import { hasPermission, useAuth } from "../lib/auth";
import { supabase, type DisciplinaryWarning } from "../lib/supabase";

const FIELD =
  "w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent";

export type WarningTarget = {
  id: string;
  full_name: string;
  employee_code: string;
};

const inWindow = (w: DisciplinaryWarning) => {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  return w.kind === "formal" && w.status === "approved" && !w.rescinded && new Date(`${w.issued_on}T00:00:00`) > cutoff;
};

export default function DisciplinaryWarningsModal({
  guard,
  onClose,
}: {
  guard: WarningTarget;
  onClose: () => void;
}) {
  const codeIndex = useEmployeeCodeIndex();
  const { profile } = useAuth();
  const canApprove = hasPermission(profile, "warnings.approve");
  const [warnings, setWarnings] = useState<DisciplinaryWarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newWarning, setNewWarning] = useState("");
  const [kind, setKind] = useState<"soft" | "formal">("soft");
  const [fineDays, setFineDays] = useState("");

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
    const days = kind === "formal" && fineDays ? Number(fineDays) : null;
    if (await run(
      supabase.from("disciplinary_warnings").insert({ employee_id: guard.id, reason: newWarning.trim(), kind, status: "approved", fine_days: days }),
    )) {
      setNewWarning("");
      setFineDays("");
    }
  };

  const rescindWarning = (id: string) =>
    run(supabase.from("disciplinary_warnings").update({ rescinded: true }).eq("id", id));

  const activeWarnings = warnings.filter(inWindow).length;

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
        <p className="text-sm text-muted-foreground">
          {codeIndex.byId.get(guard.id) ?? guard.employee_code} ·{" "}
          <span className={activeWarnings >= 3 ? "text-danger-700 font-medium" : "text-foreground"}>
            {activeWarnings}/3 formal in the last 12 months
          </span>
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : warnings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No warnings issued.</p>
        ) : (
          <ul className="space-y-2 max-h-72 overflow-y-auto">
            {warnings.map((w) => (
              <li key={w.id} className="flex items-start justify-between gap-2 text-sm">
                <span className={w.rescinded || w.status === "refused" ? "text-muted-foreground/70 line-through" : "text-foreground"}>
                  <span className="font-medium">
                    {w.kind === "soft" ? "Soft" : w.warning_number ? `Formal #${w.warning_number}` : "Formal"}
                  </span>
                  {w.status === "pending" && <span className="ml-1 text-warning-700">· awaiting approval</span>}
                  {w.status === "refused" && <span className="ml-1">· refused</span>}
                  {" "}· {formatDate(w.issued_on)} · {w.reason}
                  {w.fine_days ? <span className="ml-1 text-muted-foreground">· fine {w.fine_days} day{w.fine_days === 1 ? "" : "s"}{w.fine_applied_at ? " (on payslip)" : " (waiting on Payroll)"}</span> : null}
                  {w.source === "app" && w.raised_by_name ? <span className="ml-1 text-muted-foreground">· from {w.raised_by_name} on the field app</span> : null}
                </span>
                {!w.rescinded && w.status === "approved" && (
                  <button
                    type="button"
                    onClick={() => rescindWarning(w.id)}
                    className="text-xs text-muted-foreground hover:text-foreground underline shrink-0"
                  >
                    Rescind
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {warnings.some((w) => w.status === "pending") && (
          <p className="text-xs text-muted-foreground">Approve or refuse pending warnings on Workforce › Warnings.</p>
        )}

        <div className="space-y-2 pt-1">
          <div className="flex gap-2 text-sm">
            {(["soft", "formal"] as const).map((k) => (
              <button key={k} type="button" onClick={() => setKind(k)} disabled={k === "formal" && !canApprove}
                className={`px-3 py-1.5 rounded-md border ${kind === k ? "border-brand-500 bg-brand-500/10 text-foreground" : "border-border text-muted-foreground"} disabled:opacity-50`}
                title={k === "formal" && !canApprove ? "Issuing a formal warning needs the \"Approve warnings\" permission" : undefined}>
                {k === "soft" ? "Soft" : "Formal"}
              </button>
            ))}
            {kind === "formal" && (
              <select className={`${FIELD} w-auto`} value={fineDays} onChange={(e) => setFineDays(e.target.value)} aria-label="Fine">
                <option value="">No fine</option>
                {[1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>Fine: {d} day{d === 1 ? "" : "s"}' salary</option>)}
              </select>
            )}
          </div>
          <div className="flex gap-2">
            <input
              className={FIELD}
              placeholder={kind === "soft" ? "Soft warning — reason (history only, no fine)" : "Formal warning — reason"}
              value={newWarning}
              onChange={(e) => setNewWarning(e.target.value)}
            />
            <Button type="button" variant="secondary" size="sm" disabled={busy || (kind === "formal" && !canApprove)} onClick={addWarning}>
              Issue
            </Button>
          </div>
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
