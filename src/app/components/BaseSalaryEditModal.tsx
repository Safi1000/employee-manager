// Change one employee's base salary from Assignments & Pay.
//
// Salary is effective-dated: set_employee_salary writes a dated salary record and,
// when it is the latest one in force, moves employees.base_salary with it. The
// payroll Review tab makes the SAME call (PayrollManagement.saveBaseSalary), so
// the two screens cannot disagree. Unpaid payslips from the effective month on
// are carried onto the new figure, so a month already in payroll Review shows it.
//
// The effective date starts empty on purpose: when a raise applies from is a
// fact to be entered, not "today".

import { useState } from "react";
import { Loader2 } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { supabase } from "../lib/supabase";

export default function BaseSalaryEditModal({
  employee, onClose, onSaved,
}: {
  employee: { id: string; full_name: string; base_salary: number | null; allowance: number | null };
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [base, setBase] = useState("");
  const [effective, setEffective] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const current = employee.base_salary != null ? Math.round(Number(employee.base_salary)) : null;

  const save = async () => {
    const n = Math.round(Number(base));
    if (!base || !Number.isFinite(n) || n <= 0) { setErr("Enter a base salary above zero."); return; }
    if (!effective) { setErr("Pick the date the new salary takes effect."); return; }
    setSaving(true);
    setErr(null);
    const [y, m] = effective.split("-").map(Number);
    const dim = new Date(y, m, 0).getDate();
    const { error } = await supabase.rpc("set_employee_salary", {
      p_employee_id: employee.id,
      p_effective_date: effective,
      p_base_salary: n,
      p_allowance: Number(employee.allowance ?? 0),
      p_per_day_salary: n / dim,
      p_reason: reason.trim() || "Base salary changed on Assignments & Pay",
    });
    if (error) { setSaving(false); setErr(error.message); return; }
    // Carry it onto unpaid payslips from the effective month on, so payroll
    // Review shows the same figure. Paid payslips keep what they were paid at.
    const { error: psErr } = await supabase
      .from("payslips")
      .update({ base_salary: n })
      .eq("employee_id", employee.id)
      .gte("period_month", `${effective.slice(0, 7)}-01`)
      .eq("disbursed", false);
    setSaving(false);
    if (psErr) { setErr(`Salary saved, but unpaid payslips could not be updated: ${psErr.message}`); return; }
    await onSaved();
  };

  return (
    <Modal
      isOpen
      onClose={() => { if (!saving) onClose(); }}
      title={`Base salary — ${employee.full_name}`}
      size="sm"
      error={err}
      onDismissError={() => setErr(null)}
      footer={
        <div className="flex items-center gap-3">
          <Button variant="primary" size="md" className="flex-1" disabled={saving || !base || !effective} onClick={save}>
            {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : "Save"}
          </Button>
          <Button variant="secondary" size="md" disabled={saving} onClick={onClose}>Cancel</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Current base salary: <span className="text-foreground tabular-nums">{current != null ? `PKR ${current.toLocaleString()}` : "not set"}</span>
        </p>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">New base salary (PKR) *</label>
          <input
            type="number"
            min={0}
            autoFocus
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder={current != null ? String(current) : "e.g. 32000"}
            className="w-full px-3 py-2 border border-border rounded-md text-sm bg-card"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Effective from *</label>
          <input
            type="date"
            value={effective}
            onChange={(e) => setEffective(e.target.value)}
            className="w-full px-3 py-2 border border-border rounded-md text-sm bg-card"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Days from this date are paid at the new salary. Unpaid payslips from this month on, including one in payroll Review, take the new figure.
          </p>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Reason</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Annual increment"
            className="w-full px-3 py-2 border border-border rounded-md text-sm bg-card"
          />
        </div>
      </div>
    </Modal>
  );
}
