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
// Backdated past a move (12 Nov 2026, Shayan; 0668): a guard hired with no
// salary had one entered after he moved clients, dated back to his first day,
// at the NEW post's rate — so his month at the old post was paid at the wrong
// figure. When the effective date falls before a move to another client, the
// window says so, offers the move date, and will not save until someone ticks
// that the one rate is right for both posts.
//
// Pay basis (0540, DECIDED 2026-10-16): monthly = base ÷ days in month × days
// worked; per day = his own daily rate × days worked. The rate is the man's,
// never the client's. set_employee_pay_basis is the one writer. The basis is
// current, not dated (DEFERRED), so it applies to every payslip not yet
// generated.

import { useEffect, useMemo, useState } from "react";
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
  const [postings, setPostings] = useState<{ client_id: string | null; start: string; end: string | null; name: string }[]>([]);
  const [bothPostsOk, setBothPostsOk] = useState(false);

  useEffect(() => {
    let live = true;
    void supabase.from("deployments")
      .select("client_id, start_date, end_date, clients(name)")
      .eq("guard_id", employee.id)
      .order("start_date")
      .then(({ data }) => {
        if (!live) return;
        setPostings(((data ?? []) as any[]).map((d) => ({
          client_id: d.client_id ?? null, start: d.start_date, end: d.end_date ?? null,
          name: d.clients?.name ?? "another post",
        })));
      });
    return () => { live = false; };
  }, [employee.id]);

  // The post he was at on the effective date, and the first move to a
  // different client after it. Null when the new salary covers one post only.
  const backdated = useMemo(() => {
    if (!effective) return null;
    const at = postings.find((p) => p.start <= effective && (!p.end || p.end >= effective));
    if (!at) return null;
    const moved = postings.find((p) => p.start > effective && p.client_id !== at.client_id);
    return moved ? { from: at.name, to: moved.name, on: moved.start } : null;
  }, [effective, postings]);
  useEffect(() => { setBothPostsOk(false); }, [effective]);
  const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  const current = employee.base_salary != null ? Math.round(Number(employee.base_salary)) : null;
  const rateN = Math.round(Number(rate));
  const basisChanged = basis !== currentBasis || (basis === "per_day" && rateN !== currentRate);
  const baseChanged = base !== "";
  const canSave = !saving && (basisChanged || (baseChanged && !!effective)) && !(baseChanged && backdated && !bothPostsOk);

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
      if (backdated && !bothPostsOk) { setErr(`This date is before his move to ${backdated.to}. Confirm the rate is right for ${backdated.from} too, or start it on ${fmtDay(backdated.on)}.`); return; }
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
              {backdated && (
                <div role="alert" className="mt-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500 space-y-2">
                  <p>
                    <span className="font-semibold">This goes back before a move.</span> He was at <span className="font-medium">{backdated.from}</span> on this date and moved to <span className="font-medium">{backdated.to}</span> on {fmtDay(backdated.on)}.
                    This salary would also pay his days at {backdated.from}.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <button type="button" onClick={() => setEffective(backdated.on)}
                      className="px-2 py-1 rounded-md border border-warning-200 dark:border-warning-500/30 bg-card text-foreground hover:bg-accent">
                      Start it on {fmtDay(backdated.on)} instead
                    </button>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs font-normal">
                      <input type="checkbox" className="rounded border-border" checked={bothPostsOk} onChange={(e) => setBothPostsOk(e.target.checked)} />
                      The same rate is right at both posts
                    </label>
                  </div>
                </div>
              )}
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
