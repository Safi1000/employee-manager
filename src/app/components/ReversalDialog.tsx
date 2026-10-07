// The one popup every reversal goes through — from the Reversals page and from
// the Reverse buttons on the screens where a mistake is noticed (payroll,
// employee profile, invoice payments).
//
// It never decides anything itself. The preview is the database's own reverse_*
// function run with p_preview, so what it lists is exactly what the reversal
// will do, and the blockers are the same ones the reversal would raise.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { supabase, friendlyDbError } from "../lib/supabase";
import { ChoiceCards, FormField, Hint, ModalFooter, SubjectCard } from "../pages/super-admin/_assetsKit";

export type ReversalPreview = {
  kind: string;
  source_id: string;
  title: string;
  blockers: string[];
  effects: string[];
  done: boolean;
  reversal_id: string | null;
};

export const REVERSAL_KINDS: Record<string, { label: string; group: "Payroll & staff" | "Money" | "Operations" }> = {
  payslip_disbursement: { label: "Salary disbursement", group: "Payroll & staff" },
  separation: { label: "Firing / separation", group: "Payroll & staff" },
  separation_legacy: { label: "Firing / separation (recorded before Oct 2026)", group: "Payroll & staff" },
  rehire: { label: "Rehire", group: "Payroll & staff" },
  lifecycle_change: { label: "Status change", group: "Payroll & staff" },
  payroll_adjustment: { label: "Payroll adjustment", group: "Payroll & staff" },
  advance: { label: "Advance", group: "Payroll & staff" },
  attendance_verification: { label: "Attendance verification", group: "Payroll & staff" },
  invoice_payment: { label: "Client payment", group: "Money" },
  invoice: { label: "Invoice", group: "Money" },
  write_off: { label: "Receivable write-off", group: "Money" },
  expense: { label: "Expense", group: "Money" },
  payable_settlement: { label: "Payable settled", group: "Money" },
  vendor_payment: { label: "Vendor payment", group: "Money" },
  bank_transfer: { label: "Bank transfer", group: "Money" },
  bank_to_custodian: { label: "Cash withdrawal to custodian", group: "Money" },
  custody_transfer: { label: "Custody transfer", group: "Money" },
  cash_deposit: { label: "Cash deposit", group: "Money" },
  cheque_clearance: { label: "Cheque clearance", group: "Money" },
  partner_entry: { label: "Partner drawing / contribution", group: "Money" },
  manual_journal: { label: "Manual journal", group: "Money" },
  expense_request_decision: { label: "Expense request decision", group: "Money" },
  inventory_purchase: { label: "Inventory purchase", group: "Operations" },
  kit_event: { label: "Kit issue / return / handover", group: "Operations" },
  clearance_ops: { label: "Clearance (operations)", group: "Operations" },
  dues_release: { label: "Final dues release", group: "Operations" },
  fixed_asset: { label: "Asset capitalised", group: "Operations" },
  asset_disposal: { label: "Asset disposal", group: "Operations" },
  depreciation_entry: { label: "Depreciation (one month)", group: "Operations" },
};

export const kindLabel = (k: string) => REVERSAL_KINDS[k]?.label ?? k.replace(/_/g, " ");

export default function ReversalDialog({
  kind, id, onClose, onDone,
}: {
  kind: string;
  id: string;
  onClose: () => void;
  /** Called once the reversal has been made, with the database's result. */
  onDone?: (r: ReversalPreview) => void;
}) {
  const [preview, setPreview] = useState<ReversalPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"error" | "recover">("error");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ReversalPreview | null>(null);
  const hasMode = kind === "payslip_disbursement";

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const { data, error } = await supabase.rpc("reverse_action", {
      p_kind: kind, p_id: id, p_reason: null, p_preview: true, p_mode: mode,
    });
    setLoading(false);
    if (error) { setErr(friendlyDbError(error)); setPreview(null); return; }
    setPreview(data as ReversalPreview);
  }, [kind, id, mode]);

  useEffect(() => { void loadPreview(); }, [loadPreview]);

  const confirm = async () => {
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase.rpc("reverse_action", {
      p_kind: kind, p_id: id, p_reason: reason.trim(), p_preview: false, p_mode: mode,
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); void loadPreview(); return; }
    const r = data as ReversalPreview;
    setDone(r);
    onDone?.(r);
  };

  const blocked = (preview?.blockers.length ?? 0) > 0;
  const canConfirm = !!preview && !blocked && reason.trim().length >= 5 && !busy;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={done ? "Reversed" : `Reverse ${kindLabel(kind).toLowerCase()}`}
      size="md"
      error={err}
      onDismissError={() => setErr(null)}
      footer={
        done ? (
          <ModalFooter><Button onClick={onClose}>Close</Button></ModalFooter>
        ) : (
          <ModalFooter summary={blocked ? <span className="text-danger-700 dark:text-danger-500">Blocked — see below</span> : undefined}>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="danger" onClick={confirm} disabled={!canConfirm}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
              {busy ? "Reversing…" : "Reverse"}
            </Button>
          </ModalFooter>
        )
      }
    >
      {loading && !preview ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Checking what this reversal would do…
        </div>
      ) : !preview ? null : (
        <div className="space-y-5">
          <SubjectCard title={preview.title} meta={kindLabel(kind)} />

          {done ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-success-200 bg-success-50 px-3 py-2.5 text-sm text-success-700 dark:text-success-500">
                <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>Reversed. It is recorded on the Reversals page with your reason.</span>
              </div>
              <EffectList items={done.effects} />
            </div>
          ) : (
            <>
              {blocked && (
                <div className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5">
                  <div className="flex items-center gap-2 text-sm font-medium text-danger-700 dark:text-danger-500">
                    <AlertTriangle className="w-4 h-4" /> This can't be reversed yet
                  </div>
                  <ul className="mt-1.5 space-y-1 text-sm text-danger-700 dark:text-danger-500 list-disc pl-5">
                    {preview.blockers.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              )}

              {hasMode && (
                <FormField label="What kind of mistake was it?">
                  <ChoiceCards<"error" | "recover">
                    columns={2}
                    value={mode}
                    onChange={setMode}
                    options={[
                      { value: "error", label: "It never really happened", sub: "Wrong bank, entered twice — undo the books only" },
                      { value: "recover", label: "It happened; he must pay it back", sub: "The money stays out and becomes an advance against him", tone: "warning" },
                    ]}
                  />
                </FormField>
              )}

              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">What will happen</div>
                {loading ? <div className="text-sm text-muted-foreground">Updating…</div> : <EffectList items={preview.effects} />}
              </div>

              {!blocked && (
                <FormField label="Reason" required hint="Kept with the reversal for good. Say what was wrong.">
                  <textarea
                    className="w-full min-h-20 px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
                    placeholder="e.g. Paid from the wrong bank account"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </FormField>
              )}

              <Hint>
                The ledger is never edited: the opposite entry is posted, in the original month if it is
                open, otherwise today. A reversal cannot itself be reversed — if this one is wrong, record
                the action again.
              </Hint>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function EffectList({ items }: { items: string[] }) {
  if (items.length === 0) return <div className="text-sm text-muted-foreground">Nothing to change.</div>;
  return (
    <ul className="space-y-1.5">
      {items.map((e, i) => (
        <li key={i} className="flex items-start gap-2 text-sm text-foreground">
          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-brand-500 flex-shrink-0" />
          <span>{e}</span>
        </li>
      ))}
    </ul>
  );
}
