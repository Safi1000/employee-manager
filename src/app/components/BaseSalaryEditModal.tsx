// Change one employee's pay from Assignments & Pay: the base salary, and how he
// is paid (0540).
//
// Salary is effective-dated: set_employee_salary writes a dated salary record and,
// when it is the latest one in force, moves employees.base_salary with it. The
// payroll Review tab makes the SAME call (PayrollManagement.saveBaseSalary), so
// the two screens cannot disagree. Unpaid payslips from the effective month on
// are carried onto the new figure, so a month already in payroll Review shows it.
//
// The effective date starts empty on purpose: when a raise applies from is a
// fact to be entered, not "today".
//
// Pay basis (0540, DECIDED 2026-10-16): monthly = base ÷ days in month × days
// worked; per day = his own daily rate × days worked. The rate is the man's,
// never the client's. set_employee_pay_basis is the one writer. The basis is
// current, not dated (DEFERRED), so it applies to every payslip not yet
// generated.

import { useState } from "react";
import { Loader2 } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { supabase } from "../lib/supabase";

type Basis = "monthly" | "per_day";

export default function BaseSalaryEditModal({
  employee, onClose, onSaved,
}: {
  employee: {
    id: string; full_name: string; base_salary: number | null; allowance: number | null;
    pay_basis?: Basis; daily_rate?: number | null;
  };
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const currentBasis: Basis = employee.pay_basis ?? "monthly";
  const currentRate = employee.daily_rate != null ? Math.round(Number(employee.daily_rate)) : null;
  const [basis, setBasis] = useState<Basis>(currentBasis);
  const [rate, setRate] = useState(currentRate != null ? String(currentRate) : "");
  const [base, setBase] = useState("");
  const [effective, setEffective] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const current = employee.base_salary != null ? Math.round(Number(employee.base_salary)) : null;
  const rateN = Math.round(Number(rate));
  const basisChanged = basis !== currentBasis || (basis === "per_day" && rateN !== currentRate);
  const baseChanged = base !== "";
  const canSave = !saving && (basisChanged || (baseChanged && !!effective));

  const save = async () => {
    setErr(null);
    if (basisChanged) {
      if (basis === "per_day" && (!Number.isFinite(rateN) || rateN <= 0)) { setErr("Enter a daily rate above zero."); return; }
      if (!reason.trim()) { setErr("Say why the pay basis is changing — it changes what he is paid."); return; }
    }
    if (baseChanged) {
      const n = Math.round(Number(base));
      if (!Number.isFinite(n) || n <= 0) { setErr("Enter a base salary above zero."); return; }
      if (!effective) { setErr("Pick the date the new salary takes effect."); return; }
    }
    setSaving(true);

    if (basisChanged) {
      const { error } = await supabase.rpc("set_employee_pay_basis", {
        p_employee_id: employee.id,
        p_pay_basis: basis,
        p_daily_rate: basis === "per_day" ? rateN : null,
        p_reason: reason.trim(),
      });
      if (error) { setSaving(false); setErr(error.message); return; }
    }

    if (baseChanged) {
      const n = Math.round(Number(base));
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
      if (error) { setSaving(false); setErr(basisChanged ? `Pay basis saved, but the base salary was not: ${error.message}` : error.message); return; }
      // Carry it onto unpaid payslips from the effective month on, so payroll
      // Review shows the same figure. Paid payslips keep what they were paid at.
      const { error: psErr } = await supabase
        .from("payslips")
        .update({ base_salary: n })
        .eq("employee_id", employee.id)
        .gte("period_month", `${effective.slice(0, 7)}-01`)
        .eq("disbursed", false);
      if (psErr) { setSaving(false); setErr(`Salary saved, but unpaid payslips could not be updated: ${psErr.message}`); return; }
    }
    setSaving(false);
    await onSaved();
  };

  const seg = (b: Basis, label: string) => (
    <button
      type="button"
      onClick={() => setBasis(b)}
      className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors ${basis === b ? "bg-card text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
      aria-pressed={basis === b}
    >
      {label}
    </button>
  );

  return (
    <Modal
      isOpen
      onClose={() => { if (!saving) onClose(); }}
      title={`Pay — ${employee.full_name}`}
      size="sm"
      error={err}
      onDismissError={() => setErr(null)}
      footer={
        <div className="flex items-center gap-3">
          <Button variant="primary" size="md" className="flex-1" disabled={!canSave} onClick={save}>
            {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : "Save"}
          </Button>
          <Button variant="secondary" size="md" disabled={saving} onClick={onClose}>Cancel</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Paid</label>
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {seg("monthly", "Monthly")}
            {seg("per_day", "Per day")}
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            {basis === "monthly"
              ? "Base ÷ days in the month × days worked."
              : "His own daily rate × days worked, whichever client he covers. Days not worked are unpaid."}
          </p>
        </div>

        {basis === "per_day" && (
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Daily rate (PKR) *</label>
            <input
              type="number"
              min={0}
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder="e.g. 1000"
              className="w-full px-3 py-2 border border-border rounded-md text-sm bg-card"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Applies to every payslip not yet generated.
            </p>
          </div>
        )}

        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-sm text-muted-foreground">
            Current base salary: <span className="text-foreground tabular-nums">{current != null ? `PKR ${current.toLocaleString()}` : "not set"}</span>
            {basis === "per_day" && <span className="block text-[11px]">Not used while he is paid per day.</span>}
          </p>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">New base salary (PKR)</label>
            <input
              type="number"
              min={0}
              autoFocus={basis === "monthly"}
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder={current != null ? String(current) : "e.g. 32000"}
              className="w-full px-3 py-2 border border-border rounded-md text-sm bg-card"
            />
          </div>
          {baseChanged && (
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
          )}
        </div>

        <div>
          <label className="block text-xs text-muted-foreground mb-1">Reason{basisChanged ? " *" : ""}</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={basisChanged ? "e.g. Reliever — paid by the day" : "e.g. Annual increment"}
            className="w-full px-3 py-2 border border-border rounded-md text-sm bg-card"
          />
        </div>
      </div>
    </Modal>
  );
}
