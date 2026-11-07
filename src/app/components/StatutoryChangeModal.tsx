import { useMemo, useState } from "react";
import Modal from "./Modal";
import Button from "./Button";
import { supabase, friendlyDbError } from "../lib/supabase";

/**
 * STATUTORY CHANGE (0647, 7 Nov 2026). "EOBI increased by 70 — how do we
 * include that?" Payroll already takes a statutory change from statutory_rates
 * on its date. This is the other half: the contracts say charges are revised
 * "through mutual consent in line with the updated official rates", so a
 * proposal of +Rs X per guard from the date is opened on each contract chosen,
 * and each client's answer — agreed, less, refused, deferred — is recorded on
 * that contract (Decisions → Answer). Agreeing writes the rate changes.
 */
export type StatutoryContract = { id: string; code: string; client: string; guards: number; type: string; active: boolean };

export default function StatutoryChangeModal({ isOpen, onClose, contracts, onDone }: {
  isOpen: boolean;
  onClose: () => void;
  contracts: StatutoryContract[];
  onDone: (n: number) => void;
}) {
  const live = useMemo(() => contracts.filter((c) => c.active), [contracts]);
  const [basis, setBasis] = useState("");
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(live.filter((c) => c.type === "guard_deployment").map((c) => c.id)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const guards = live.filter((c) => picked.has(c.id)).reduce((t, c) => t + c.guards, 0);
  const amt = Number(amount);

  const submit = async () => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc("propose_statutory_reviews", { p_contract_ids: [...picked], p_amount: amt, p_effective_from: from, p_basis: basis });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    onDone(Number(data ?? 0));
    onClose();
  };

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const field = "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm";

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Statutory change — propose to clients" size="lg" error={err} onDismissError={() => setErr(null)}
      footer={<div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{picked.size} contract{picked.size === 1 ? "" : "s"} · {guards} guards{amt ? ` · about PKR ${Math.round(amt * guards).toLocaleString("en-PK")} a month if every client agrees` : ""}</span>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={busy || !basis.trim() || !amt || !from || picked.size === 0} onClick={() => void submit()}>Open {picked.size} proposal{picked.size === 1 ? "" : "s"}</Button>
        </div>
      </div>}>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">Payroll takes a statutory change from its own rates on the date. This opens the matching proposal to each client, per the clause "revised through mutual consent in line with the updated official rates". Each client's answer is then recorded on that contract under <b>Decisions</b>; agreeing writes the new rates.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <label className="space-y-1 md:col-span-3"><span className="text-xs text-muted-foreground">What changed</span><input className={field} value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="e.g. EOBI employer share +70 from 1 Jan 2027" /></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">Per guard per month (Rs)</span><input className={field} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="70" /></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">From</span><input type="date" className={field} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground uppercase">Contracts</span>
          <span className="flex gap-3 text-xs">
            <button type="button" className="text-brand-700 hover:underline" onClick={() => setPicked(new Set(live.map((c) => c.id)))}>All</button>
            <button type="button" className="text-brand-700 hover:underline" onClick={() => setPicked(new Set())}>None</button>
          </span>
        </div>
        <ul className="max-h-[40vh] overflow-y-auto divide-y divide-border rounded-lg border border-border">
          {live.map((c) => (
            <li key={c.id}>
              <label className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted/50">
                <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                <span className="flex-1 min-w-0 truncate text-foreground">{c.client}</span>
                <span className="text-xs text-muted-foreground font-mono">{c.code}</span>
                <span className="text-xs text-muted-foreground tabular-nums w-16 text-right">{c.guards} guards</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
