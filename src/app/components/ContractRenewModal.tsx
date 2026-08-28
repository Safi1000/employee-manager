import { useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { formatDateUS } from "../lib/date";
import { supabase, type Contract } from "../lib/supabase";

/**
 * Renew an expiring / expired contract onto a new term.
 *
 * All the copying happens in the `renew_contract` RPC (migration 0202) so the
 * clone is atomic and the client can't half-create a contract: every term and
 * every contract line comes across, the source contract is retired, and guards
 * pinned to it move onto the renewal. This dialog only collects the two things
 * the database can't know — the new start and end dates.
 */
export default function ContractRenewModal({
  isOpen,
  contract,
  clientName,
  onClose,
  onRenewed,
}: {
  isOpen: boolean;
  contract: Contract | null;
  clientName: string;
  onClose: () => void;
  onRenewed: () => void;
}) {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [isInfinite, setIsInfinite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default the new term to pick up the day after the old one ended, running for
  // a year — the shape almost every renewal takes, still fully editable.
  useEffect(() => {
    if (!isOpen || !contract) return;
    setError(null);
    setBusy(false);
    setIsInfinite(false);
    const base = contract.end_date ? new Date(`${contract.end_date}T00:00:00Z`) : new Date();
    if (contract.end_date) base.setUTCDate(base.getUTCDate() + 1);
    const start = base.toISOString().slice(0, 10);
    const end = new Date(base);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    end.setUTCDate(end.getUTCDate() - 1);
    setStartDate(start);
    setEndDate(end.toISOString().slice(0, 10));
  }, [isOpen, contract]);

  if (!contract) return null;

  const submit = async () => {
    if (!startDate) { setError("Pick the date the renewed contract starts."); return; }
    if (!isInfinite && !endDate) { setError("Pick the date the renewed contract ends, or tick “no end date”."); return; }
    if (!isInfinite && endDate < startDate) { setError("The end date can't be before the start date."); return; }
    setBusy(true);
    setError(null);
    const { error: rpcErr } = await supabase.rpc("renew_contract", {
      p_contract_id: contract.id,
      p_start_date: startDate,
      p_end_date: isInfinite ? null : endDate,
      p_is_infinite: isInfinite,
    });
    setBusy(false);
    if (rpcErr) { setError(rpcErr.message); return; }
    onRenewed();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Renew ${contract.contract_code}`} size="md">
      <div className="space-y-4">
        <div className="bg-slate-50 border border-slate-200 rounded-md p-3 text-sm">
          <p className="text-slate-900">{clientName}</p>
          <p className="text-xs text-slate-500 mt-0.5">
            Current term: {formatDateUS(contract.start_date)}
            {contract.is_infinite
              ? " → no end date"
              : contract.end_date
                ? ` → ${formatDateUS(contract.end_date)}`
                : " → no end date"}
          </p>
        </div>

        <p className="text-xs text-slate-600">
          Every term and contract line is copied onto a new contract with its own code.
          {" "}<strong>{contract.contract_code}</strong> is marked expired, and any guards pinned to it
          move onto the renewal so their attendance keeps working. The signed document and any
          addendums are not carried over — attach the new paperwork to the renewed contract.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-600 mb-1">New start date *</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">New end date {isInfinite ? "" : "*"}</label>
            <input
              type="date"
              value={endDate}
              disabled={isInfinite}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-100 disabled:text-slate-400"
            />
            <label className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={isInfinite}
                onChange={(e) => setIsInfinite(e.target.checked)}
              />
              No end date (open-ended)
            </label>
          </div>
        </div>

        {error && <p className="text-sm text-danger-600">{error}</p>}

        <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
          <Button variant="primary" size="md" className="flex-1" disabled={busy} onClick={submit}>
            {busy
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Renewing…</>
              : <><RotateCcw className="w-4 h-4 mr-2" /> Renew Contract</>}
          </Button>
          <Button variant="secondary" size="md" disabled={busy} onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}
