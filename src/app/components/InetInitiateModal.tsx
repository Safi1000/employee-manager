import { useState } from "react";
import Modal from "./Modal";
import Button from "./Button";
import { supabase, friendlyDbError } from "../lib/supabase";
import { FormField, Hint, ModalFooter } from "../pages/super-admin/_assetsKit";

/**
 * 0662: put payslips in transit on iNet. Nothing is paid and no bank moves
 * until someone else releases the batch on Banks ▸ iNet releases. Askari
 * payees and other-bank payees become two batches (two upload files)
 * automatically; any payee whose bank details cannot go in the file is listed
 * by the database and nothing is initiated.
 */
export type InetInitiateItem = { payslipId: string; name: string; amount: number };

export default function InetInitiateModal({ bankId, bankName, items, defaultLabel, defaultReference, onClose, onDone }: {
  bankId: string;
  bankName: string;
  items: InetInitiateItem[];
  defaultLabel: string;
  defaultReference: string;
  onClose: () => void;
  onDone: (summary: string) => void;
}) {
  const [label, setLabel] = useState(defaultLabel);
  const [reference, setReference] = useState(defaultReference);
  const [date, setDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const total = items.reduce((s, i) => s + Math.round(i.amount), 0);

  const submit = async () => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc("initiate_inet_payslips", {
      p_bank_account_id: bankId,
      p_label: label.trim(),
      p_reference: reference.trim(),
      p_transaction_date: date,
      p_items: items.map((i) => ({ payslip_id: i.payslipId, amount: Math.round(i.amount) })),
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    const r = data as { items: number; batches: Record<string, string> };
    const kinds = Object.keys(r.batches ?? {}).map((k) => (k === "FT" ? "Askari" : k === "IBFT" ? "other banks" : "keyed by hand"));
    onDone(`${r.items} payslip${r.items === 1 ? "" : "s"} in transit on ${bankName} (${kinds.join(" + ")}). Download the file${kinds.length > 1 ? "s" : ""} on Banks ▸ iNet releases.`);
  };

  return (
    <Modal isOpen onClose={onClose} title={`Initiate on ${bankName} iNet`} size="sm" error={err} onDismissError={() => setErr(null)}
      footer={
        <ModalFooter summary={<>{items.length} payslip{items.length === 1 ? "" : "s"} · PKR {total.toLocaleString()}</>}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !label.trim() || !date}>{busy ? "Initiating…" : "Initiate"}</Button>
        </ModalFooter>
      }>
      <div className="space-y-4">
        <Hint tone="info">
          Nothing is paid yet. The payslips show <span className="font-semibold">In transit</span> and the bank does not move
          until someone else releases the batch with the total iNet sent. Askari accounts and other banks become separate files.
        </Hint>
        <div className="max-h-40 overflow-y-auto rounded-lg border border-border divide-y divide-border text-sm">
          {items.map((i) => (
            <div key={i.payslipId} className="flex justify-between px-3 py-1.5">
              <span className="truncate pr-2">{i.name}</span>
              <span className="font-ledger">{Math.round(i.amount).toLocaleString()}</span>
            </div>
          ))}
        </div>
        <FormField label="iNet group name" required hint="As you will name it on iNet, e.g. HMC Oct salaries 1.">
          <input className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm" value={label} onChange={(e) => setLabel(e.target.value)} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Reference" hint="Column I of the file, e.g. HMC.">
            <input className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm uppercase" value={reference} onChange={(e) => setReference(e.target.value)} />
          </FormField>
          <FormField label="Transaction date" required>
            <input type="date" className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm" value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}
