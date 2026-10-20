import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import ThemedSelect from "./ThemedSelect";
import { supabase, type StatutoryScheme, STATUTORY_SCHEME_LABEL } from "../lib/supabase";
import { ensureCustodianLocation, type CustodianOption } from "../lib/custodian";

/**
 * 0520. "Pay a statutory liability" — the one sanctioned way to record paying
 * EOBI, salary tax (FBR), PESSI or IESSI. The database does the work
 * (remit_statutory_liability): the liability portion against 2300 / 2450 / 2350
 * up to what payroll accrued for the period, any remainder to 5100 as employer
 * cost, and the money out through apply_money_delta. This screen only asks and
 * shows; it computes nothing it then posts.
 *
 * The split preview is the one piece of arithmetic here: "how much of what you
 * typed is covered by what is due" — min(amount, due) — so the person sees what
 * will happen before it does. The database recomputes it under a lock.
 */

type Due = {
  scheme: string;
  period_month: string;
  accrued: number;
  remitted: number;
  due: number;
  liability_account: string;
  liability_balance: number;
  remainder_goes_to: string;
};

export type StatutoryRemitDefaults = {
  scheme?: StatutoryScheme;
  amount?: string;
  paidOn?: string;
  branchId?: string;
};

const prevMonth = (iso: string) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00`);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const fmt = (n: number) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function StatutoryRemitModal({
  isOpen, onClose, companyId, banks, custodians, branches, defaults, onDone,
}: {
  isOpen: boolean;
  onClose: () => void;
  companyId: string | null;
  banks: { id: string; bank_name: string; account_number?: string }[];
  custodians: CustodianOption[];
  branches: { id: string; name: string }[];
  defaults?: StatutoryRemitDefaults;
  onDone?: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [scheme, setScheme] = useState<StatutoryScheme>("eobi");
  const [period, setPeriod] = useState(prevMonth(today));
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [paidVia, setPaidVia] = useState<"Bank" | "Cash">("Bank");
  const [bankId, setBankId] = useState("");
  const [custodianId, setCustodianId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [due, setDue] = useState<Due | null>(null);
  const [dueError, setDueError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the caller's defaults each time it opens. The period defaults to
  // the month BEFORE the payment: a challan pays last month's contributions.
  useEffect(() => {
    if (!isOpen) return;
    const on = defaults?.paidOn || today;
    setScheme(defaults?.scheme ?? "eobi");
    setAmount(defaults?.amount ?? "");
    setPaidOn(on);
    setPeriod(prevMonth(on));
    setBranchId(defaults?.branchId ?? "");
    setPaidVia("Bank"); setBankId(""); setCustodianId(""); setReference(""); setNotes("");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !companyId || !period) return;
    let cancelled = false;
    setDue(null); setDueError(null);
    void (async () => {
      const { data, error: e } = await supabase.rpc("statutory_liability_due", {
        p_company_id: companyId, p_scheme: scheme, p_period: `${period}-01`,
      });
      if (cancelled) return;
      if (e) { setDueError(e.message); return; }
      const row = ((data ?? []) as Due[])[0] ?? null;
      setDue(row ? { ...row, accrued: Number(row.accrued), remitted: Number(row.remitted), due: Number(row.due), liability_balance: Number(row.liability_balance) } : null);
    })();
    return () => { cancelled = true; };
  }, [isOpen, companyId, scheme, period]);

  const amt = Number(amount) || 0;
  const againstLiability = due ? Math.min(amt, due.due) : 0;
  const remainder = Math.max(amt - againstLiability, 0);
  const refused = scheme === "salary_tax" && remainder > 0.005;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!companyId) { setError("No company selected."); return; }
    if (amt <= 0) { setError("Enter the amount paid."); return; }
    if (paidVia === "Bank" && !bankId) { setError("Choose the bank account it was paid from."); return; }
    if (paidVia === "Cash" && !custodianId) { setError("Choose who paid it in cash."); return; }
    setSaving(true);
    try {
      let locationId: string | null = null;
      if (paidVia === "Cash") {
        const c = custodians.find((x) => x.employeeId === custodianId);
        locationId = c?.locationId ?? (c ? await ensureCustodianLocation(companyId, c.employeeId, c.fullName, c.kind) : null);
      }
      const { error: rpcErr } = await supabase.rpc("remit_statutory_liability", {
        p_company_id: companyId,
        p_scheme: scheme,
        p_period: `${period}-01`,
        p_amount: amt,
        p_paid_via: paidVia,
        p_bank_account_id: paidVia === "Bank" ? bankId : null,
        p_custodian_location_id: paidVia === "Cash" ? locationId : null,
        p_paid_on: paidOn,
        p_reference: reference || null,
        p_notes: notes || null,
        p_branch_id: branchId || null,
      });
      if (rpcErr) { setError(rpcErr.message); return; }
      onDone?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full px-3 py-2 border border-border rounded-md text-sm";

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Pay a statutory liability" size="md">
      <form className="space-y-4" onSubmit={submit}>
        <p className="text-xs text-muted-foreground">
          EOBI, salary tax, PESSI and IESSI are paid against what payroll already owes, not booked as a new cost.
          What was withheld from pay for the month clears its payable; only the part payroll did not accrue
          (the employer&apos;s share) becomes cost.
        </p>
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={2} />
            <div className="flex-1">{error}</div>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-foreground mb-1">Scheme *</label>
            <ThemedSelect value={scheme} onChange={(e) => setScheme(e.target.value as StatutoryScheme)} className={inputCls}>
              {(Object.keys(STATUTORY_SCHEME_LABEL) as StatutoryScheme[]).map((s) => (
                <option key={s} value={s}>{STATUTORY_SCHEME_LABEL[s]}</option>
              ))}
            </ThemedSelect>
          </div>
          <div>
            <label className="block text-sm text-foreground mb-1">For the month of *</label>
            <input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} className={inputCls} />
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted/50 p-3 text-sm">
          {dueError ? <div className="text-danger-700">{dueError}</div>
            : !due ? <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Reading what payroll accrued…</div>
            : (
              <div className="space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">Accrued by payroll for the month</span><span className="tabular-nums">{fmt(due.accrued)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Already remitted for the month</span><span className="tabular-nums">{fmt(due.remitted)}</span></div>
                <div className="flex justify-between font-medium"><span>Still due</span><span className="tabular-nums">{fmt(due.due)}</span></div>
                <div className="text-[11px] text-muted-foreground">{due.liability_account}: balance {fmt(due.liability_balance)} across all months.</div>
              </div>
            )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-foreground mb-1">Amount paid *</label>
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm text-foreground mb-1">Paid on *</label>
            <input type="date" max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className={inputCls} />
          </div>
        </div>

        {amt > 0 && due && (
          <div className={`rounded-md border p-3 text-sm ${refused ? "border-danger-200 bg-danger-50 text-danger-700" : "border-border"}`}>
            {refused ? (
              <>Only {fmt(due.due)} of salary tax is due for this month. A challan larger than the tax withheld contains
                something that is not salary tax — record that part as what it is. This will be refused.</>
            ) : (
              <div className="space-y-1">
                <div className="flex justify-between"><span>Against {due.liability_account}</span><span className="tabular-nums">{fmt(againstLiability)}</span></div>
                <div className="flex justify-between"><span>To {due.remainder_goes_to}</span><span className="tabular-nums">{fmt(remainder)}</span></div>
              </div>
            )}
          </div>
        )}

        <div>
          <label className="block text-sm text-foreground mb-1">Paid from *</label>
          <div className="grid grid-cols-2 gap-2">
            {(["Bank", "Cash"] as const).map((m) => (
              <label key={m} className={`flex items-center justify-center gap-2 px-3 py-2 border rounded-md cursor-pointer text-sm ${paidVia === m ? "border-foreground bg-muted/50" : "border-border hover:border-border"}`}>
                <input type="radio" name="statutory_paid_via" className="sr-only" checked={paidVia === m} onChange={() => setPaidVia(m)} />
                {m}
              </label>
            ))}
          </div>
        </div>
        {paidVia === "Bank" ? (
          <ThemedSelect value={bankId} onChange={(e) => setBankId(e.target.value)} className={inputCls}>
            <option value="">Choose the bank account…</option>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.bank_name}{b.account_number ? ` — ${b.account_number}` : ""}</option>)}
          </ThemedSelect>
        ) : (
          <ThemedSelect value={custodianId} onChange={(e) => setCustodianId(e.target.value)} className={inputCls}>
            <option value="">Who paid it in cash?</option>
            {custodians.map((c) => <option key={c.employeeId} value={c.employeeId}>{c.fullName}</option>)}
          </ThemedSelect>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-foreground mb-1">Challan / CPR number</label>
            <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm text-foreground mb-1">Region</label>
            <ThemedSelect value={branchId} onChange={(e) => setBranchId(e.target.value)} className={inputCls}>
              <option value="">Head Office (default)</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </ThemedSelect>
          </div>
        </div>
        <div>
          <label className="block text-sm text-foreground mb-1">Notes</label>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" variant="primary" size="md" className="flex-1" disabled={saving || refused}>
            {saving ? "Recording…" : "Record payment"}
          </Button>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}
