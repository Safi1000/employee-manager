import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, HandCoins, X } from "lucide-react";
import { supabase, friendlyDbError } from "../lib/supabase";
import { formatDate } from "../lib/date";

/**
 * 0640 (4 Nov 2026). Two lists that must not be quiet:
 *  - cash someone recorded into another person's keeping, waiting for that
 *    custodian to say it arrived (a super admin answers for custodians with no
 *    office login);
 *  - pairs of payments that look like the same money entered twice, until each
 *    is marked genuine or reversed.
 * Shows nothing when both are empty.
 */
type Awaiting = { payment_id: string; client_name: string; invoice_number: string | null; amount: number; payment_date: string; entered_on: string; entered_by: string | null; custodian: string; can_confirm: boolean };
type Dup = { payment_id: string; earlier_id: string; client_name: string; amount: number; payment_date: string; earlier_date: string; entered_on: string; earlier_entered_on: string; entered_by: string | null; earlier_entered_by: string | null; invoice_number: string | null; earlier_invoice: string | null };

const pkr = (n: number) => Number(n).toLocaleString("en-PK", { maximumFractionDigits: 0 });

export default function PaymentChecksPanel({ canEdit }: { canEdit: boolean }) {
  const [awaiting, setAwaiting] = useState<Awaiting[]>([]);
  const [dups, setDups] = useState<Dup[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [a, d] = await Promise.all([supabase.rpc("cash_awaiting_confirmation"), supabase.rpc("possible_duplicate_receipts")]);
    // Before 0640 is applied neither function exists: show nothing rather than an error.
    setAwaiting(a.error ? [] : ((a.data ?? []) as Awaiting[]));
    setDups(d.error ? [] : ((d.data ?? []) as Dup[]));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const confirm = async (row: Awaiting, received: boolean) => {
    let note: string | null = null;
    if (!received) {
      note = window.prompt(`Cash of PKR ${pkr(row.amount)} from ${row.client_name} was recorded into ${row.custodian}'s keeping by ${row.entered_by ?? "someone"}.\n\nWhat happened? (The office is alerted.)`);
      if (!note?.trim()) return;
    }
    setBusy(row.payment_id); setErr(null);
    const { error } = await supabase.rpc("confirm_cash_custody", { p_payment_id: row.payment_id, p_received: received, p_note: note });
    setBusy(null);
    if (error) { setErr(friendlyDbError(error)); return; }
    void load();
  };
  const genuine = async (row: Dup) => {
    if (!window.confirm(`Mark the PKR ${pkr(row.amount)} payment from ${row.client_name} (dated ${formatDate(row.payment_date)}) as a genuine second payment?`)) return;
    setBusy(row.payment_id); setErr(null);
    const { error } = await supabase.rpc("mark_receipt_not_duplicate", { p_payment_id: row.payment_id });
    setBusy(null);
    if (error) { setErr(friendlyDbError(error)); return; }
    void load();
  };

  if (!awaiting.length && !dups.length && !err) return null;
  return (
    <div className="space-y-3 mb-4">
      {err && <div className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">{err}</div>}
      {awaiting.length > 0 && (
        <div className="rounded-xl border border-heed/30 bg-heed/10 p-3">
          <p className="text-sm font-semibold text-foreground inline-flex items-center gap-1.5 mb-2"><HandCoins className="w-4 h-4" />Cash waiting for the custodian to confirm ({awaiting.length})</p>
          <ul className="space-y-1.5 text-sm">
            {awaiting.map((r) => (
              <li key={r.payment_id} className="flex flex-wrap items-center gap-2">
                <span className="flex-1 min-w-0">
                  <span className="text-foreground">PKR {pkr(r.amount)} · {r.client_name}</span>
                  <span className="text-xs text-muted-foreground"> · dated {formatDate(r.payment_date)}{r.invoice_number ? ` · ${r.invoice_number}` : ""} · into {r.custodian}'s keeping, entered {formatDate(r.entered_on)} by {r.entered_by ?? "someone"}</span>
                </span>
                {r.can_confirm ? (
                  <span className="flex gap-2">
                    <button type="button" disabled={busy === r.payment_id} onClick={() => void confirm(r, true)} className="inline-flex items-center gap-1 text-xs font-semibold text-up hover:underline disabled:opacity-50"><Check className="w-3.5 h-3.5" />Received</button>
                    <button type="button" disabled={busy === r.payment_id} onClick={() => void confirm(r, false)} className="inline-flex items-center gap-1 text-xs font-semibold text-down hover:underline disabled:opacity-50"><X className="w-3.5 h-3.5" />Not received</button>
                  </span>
                ) : <span className="text-xs text-muted-foreground">waiting for {r.custodian}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {dups.length > 0 && (
        <div className="rounded-xl border border-down/30 bg-down/10 p-3">
          <p className="text-sm font-semibold text-foreground inline-flex items-center gap-1.5 mb-1"><AlertTriangle className="w-4 h-4" />Possible duplicate payments ({dups.length})</p>
          <p className="text-xs text-muted-foreground mb-2">Same client, same amount, dated within 3 days. Mark it genuine if it really was a second payment; otherwise reverse it from the client's ledger.</p>
          <ul className="space-y-1.5 text-sm">
            {dups.map((r) => (
              <li key={r.payment_id} className="flex flex-wrap items-center gap-2">
                <span className="flex-1 min-w-0">
                  <span className="text-foreground">PKR {pkr(r.amount)} · {r.client_name}</span>
                  <span className="text-xs text-muted-foreground"> · {formatDate(r.payment_date)}{r.invoice_number ? ` (${r.invoice_number})` : ""}, entered {formatDate(r.entered_on)} by {r.entered_by ?? "someone"} — and {formatDate(r.earlier_date)}{r.earlier_invoice ? ` (${r.earlier_invoice})` : ""}, entered {formatDate(r.earlier_entered_on)} by {r.earlier_entered_by ?? "someone"}</span>
                </span>
                {canEdit && <button type="button" disabled={busy === r.payment_id} onClick={() => void genuine(r)} className="text-xs font-semibold text-brand-700 dark:text-brand-500 hover:underline disabled:opacity-50">Genuine</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
