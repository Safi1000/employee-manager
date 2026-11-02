import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Truck } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import { supabase, friendlyDbError } from "../lib/supabase";
import { useRegion } from "../lib/region";

/**
 * INVOICE DELIVERY (0632, DECIDED 2 Nov 2026).
 *
 * Whether an invoice reached the client is its own fact — a tick with how and
 * when — and no longer one of the options of a hand-set "status" that also
 * tried to say whether it was paid. Payment is read from what was received
 * (PaymentBadge), so it cannot disagree with the ledger.
 */

export type Delivery = { delivered_on: string; method: string };
export const DELIVERY_METHODS: [string, string][] = [["email", "Email"], ["whatsapp", "WhatsApp"], ["hand", "By hand"], ["courier", "Courier"], ["portal", "Client portal"]];
const methodLabel = (m: string) => DELIVERY_METHODS.find(([k]) => k === m)?.[1] ?? m;
const fmtShort = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Every delivery the caller can see, by invoice. */
export async function loadDeliveries(): Promise<Map<string, Delivery>> {
  const { data } = await supabase.from("invoice_deliveries").select("invoice_id, delivered_on, method");
  return new Map(((data ?? []) as any[]).map((d) => [d.invoice_id, { delivered_on: d.delivered_on, method: d.method }]));
}

/** Paid / Part-paid / Unpaid, from the invoice's own figures — never typed. */
export function PaymentBadge({ amount, received }: { amount: number; received: number }) {
  const out = amount - received;
  const [label, tone] = out <= 0.5
    ? ["Paid", "bg-success-50 text-success-700 border-success-200 dark:bg-success-500/10 dark:text-success-500"]
    : received > 0.5
      ? ["Part-paid", "bg-brand-50 text-brand-700 border-brand-200 dark:bg-brand-500/10 dark:text-brand-500"]
      : ["Unpaid", "bg-warning-50 text-warning-700 border-warning-200 dark:bg-warning-500/10 dark:text-warning-500"];
  return <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border ${tone}`}>{label}</span>;
}

/** "Auto" for generator-made invoices, "Manual" for hand-made ones. */
export function OriginBadge({ generated }: { generated: boolean | null | undefined }) {
  return generated
    ? <span className="ml-1.5 align-middle text-[10px] font-semibold px-1.5 py-0.5 rounded bg-info-50 text-info-700 dark:bg-info-500/10 dark:text-info-500" title="Made by Invoices → Generate">Auto</span>
    : <span className="ml-1.5 align-middle text-[10px] font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground" title="Made by hand">Manual</span>;
}

/** The delivered tick: shows how and when, or a button to record it. */
export function DeliveryCell({ invoiceId, delivery, canEdit, onChanged }: {
  invoiceId: string; delivery: Delivery | undefined; canEdit: boolean; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (delivery) {
    return (
      <>
        <button type="button" disabled={!canEdit} onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 text-xs text-success-700 dark:text-success-500 disabled:cursor-default"
          title={canEdit ? "Change or remove" : undefined}>
          <Check className="w-3.5 h-3.5" /> Delivered · {methodLabel(delivery.method)} · {fmtShort(delivery.delivered_on)}
        </button>
        {open && <DeliveryModal invoiceId={invoiceId} delivery={delivery} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onChanged(); }} />}
      </>
    );
  }
  return canEdit ? (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-xs text-warning-700 dark:text-warning-500 hover:underline">
        <Truck className="w-3.5 h-3.5" /> Not delivered — mark
      </button>
      {open && <DeliveryModal invoiceId={invoiceId} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onChanged(); }} />}
    </>
  ) : <span className="text-xs text-warning-700 dark:text-warning-500">Not delivered</span>;
}

function DeliveryModal({ invoiceId, delivery, onClose, onSaved }: { invoiceId: string; delivery?: Delivery; onClose: () => void; onSaved: () => void }) {
  const [method, setMethod] = useState(delivery?.method ?? "email");
  const [on, setOn] = useState(delivery?.delivered_on ?? today());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("mark_invoice_delivered", { p_invoice_id: invoiceId, p_method: method, p_delivered_on: on, p_note: note.trim() || null });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    onSaved();
  };
  const remove = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("unmark_invoice_delivered", { p_invoice_id: invoiceId });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    onSaved();
  };
  return (
    <Modal isOpen onClose={onClose} size="sm" title="Invoice delivered" error={err} onDismissError={() => setErr(null)}
      footer={<div className="flex justify-between gap-2 w-full">
        {delivery ? <Button variant="ghost" onClick={() => void remove()} disabled={busy}>Not delivered after all</Button> : <span />}
        <div className="flex gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save"}</Button></div>
      </div>}>
      <div className="space-y-3 text-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap gap-2">
          {DELIVERY_METHODS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setMethod(k)}
              className={`px-3 py-1.5 rounded-lg border ${method === k ? "bg-foreground text-background border-foreground" : "bg-card border-border"}`}>{label}</button>
          ))}
        </div>
        <label className="block"><span className="lbl">Delivered on</span>
          <input type="date" max={today()} className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={on} onChange={(e) => setOn(e.target.value)} /></label>
        <label className="block"><span className="lbl">Note (optional)</span>
          <input className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. sent to accounts@client" /></label>
      </div>
    </Modal>
  );
}

/**
 * Clients with a contract running in the month and no invoice billing it
 * (invoices_missing, 0632). Defaults to last month — the month just billed.
 */
export function MissingInvoices({ onGenerate }: { onGenerate?: () => void }) {
  const { regionId } = useRegion();
  const d = new Date();
  const lastMonth = `${d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear()}-${String(d.getMonth() === 0 ? 12 : d.getMonth()).padStart(2, "0")}`;
  const [month, setMonth] = useState(lastMonth);
  const [rows, setRows] = useState<{ client_id: string; client_name: string; branch_id: string | null; guards: number }[]>([]);
  const load = useCallback(async () => {
    const { data } = await supabase.rpc("invoices_missing", { p_month: `${month}-01` });
    setRows((data ?? []) as any[]);
  }, [month]);
  useEffect(() => { void load(); }, [load]);
  const shown = rows.filter((r) => !regionId || r.branch_id === regionId);
  if (shown.length === 0) return null;
  const label = new Date(`${month}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  return (
    <div className="mb-4 rounded-xl border border-warning-200 bg-warning-50 dark:bg-warning-500/10 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-warning-700 dark:text-warning-500" />
        <span className="font-semibold text-warning-700 dark:text-warning-500">{shown.length} client{shown.length === 1 ? "" : "s"} with a running contract and no invoice for</span>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="px-2 py-0.5 rounded border border-border bg-card text-xs" />
        <div className="flex-1" />
        {onGenerate && <Button size="sm" variant="secondary" onClick={onGenerate}>Generate invoices</Button>}
      </div>
      <div className="mt-1 text-warning-700 dark:text-warning-500">
        {shown.map((r) => r.client_name).join(" · ")}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">Missing for {label}: an active contract that month and no invoice billing it.</div>
    </div>
  );
}
