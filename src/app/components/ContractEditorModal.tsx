import { useEffect, useState } from "react";
import { Plus, Loader2, AlertCircle, X } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import {
  supabase,
  CONTRACT_TYPE_LABEL,
  CONTRACT_SHIFT_LABEL,
  CONTRACT_STATUS_LABEL,
  type Contract,
  type ContractShiftPattern,
  type ContractStatus,
  type ContractType,
} from "../lib/supabase";

type ContractFormState = {
  contract_type: ContractType;
  start_date: string;
  end_date: string;
  number_of_guards: string;
  shift_pattern: ContractShiftPattern;
  rate_per_guard_per_month: string;
  allowed_leaves_per_month: string;
  eobi_deduction: boolean;
  eobi_amount: string;
  annual_escalation_pct: string;
  renewal_terms: string;
  status: ContractStatus;
};

const blank = (): ContractFormState => ({
  contract_type: "static",
  start_date: new Date().toISOString().slice(0, 10),
  end_date: "",
  number_of_guards: "0",
  shift_pattern: "day",
  rate_per_guard_per_month: "0",
  allowed_leaves_per_month: "",
  eobi_deduction: false,
  eobi_amount: "",
  annual_escalation_pct: "",
  renewal_terms: "",
  status: "active",
});

const fromContract = (c: Contract): ContractFormState => ({
  contract_type: c.contract_type,
  start_date: c.start_date,
  end_date: c.end_date ?? "",
  number_of_guards: String(c.number_of_guards),
  shift_pattern: c.shift_pattern,
  rate_per_guard_per_month: String(c.rate_per_guard_per_month),
  allowed_leaves_per_month: c.allowed_leaves_per_month != null ? String(c.allowed_leaves_per_month) : "",
  eobi_deduction: c.eobi_deduction,
  eobi_amount: c.eobi_amount != null ? String(c.eobi_amount) : "",
  annual_escalation_pct: c.annual_escalation_pct != null ? String(c.annual_escalation_pct) : "",
  renewal_terms: c.renewal_terms ?? "",
  status: c.status,
});

/**
 * Shared add/edit contract modal. Used from the Clients page (item 1 — contracts
 * editable there) and re-usable elsewhere. The client is fixed by the caller, so
 * there's no client picker here. Document upload stays on the Contracts page.
 */
export default function ContractEditorModal({
  isOpen,
  clientId,
  clientName,
  contract,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  clientId: string;
  clientName?: string;
  contract: Contract | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ContractFormState>(blank());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setForm(contract ? fromContract(contract) : blank());
    setError(null);
  }, [isOpen, contract]);

  const buildPayload = () => ({
    client_id: clientId,
    contract_type: form.contract_type,
    start_date: form.start_date,
    end_date: form.end_date || null,
    number_of_guards: Math.max(0, Math.floor(Number(form.number_of_guards) || 0)),
    shift_pattern: form.shift_pattern,
    rate_per_guard_per_month: Math.max(0, Number(form.rate_per_guard_per_month) || 0),
    allowed_leaves_per_month:
      form.allowed_leaves_per_month === "" ? null : Math.max(0, Math.floor(Number(form.allowed_leaves_per_month) || 0)),
    eobi_deduction: form.eobi_deduction,
    eobi_amount: form.eobi_deduction && form.eobi_amount !== "" ? Number(form.eobi_amount) : null,
    annual_escalation_pct: form.annual_escalation_pct === "" ? null : Number(form.annual_escalation_pct),
    renewal_terms: form.renewal_terms.trim() || null,
    status: form.status,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (contract) {
        const { error: upErr } = await supabase.from("contracts").update(buildPayload()).eq("id", contract.id);
        if (upErr) throw upErr;
      } else {
        const { error: insErr } = await supabase.from("contracts").insert(buildPayload());
        if (insErr) throw insErr;
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={contract ? `Edit ${contract.contract_code}` : `Add Contract${clientName ? ` — ${clientName}` : ""}`}
      size="lg"
    >
      <form className="space-y-3" onSubmit={handleSubmit}>
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button type="button" onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Contract Type *</label>
            <select
              required
              value={form.contract_type}
              onChange={(e) => setForm({ ...form, contract_type: e.target.value as ContractType })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              {(["static", "mobile_patrol", "event", "reliever_pool"] as const).map((t) => (
                <option key={t} value={t}>{CONTRACT_TYPE_LABEL[t]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Status</label>
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as ContractStatus })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              {(["active", "expired", "terminated", "draft"] as const).map((s) => (
                <option key={s} value={s}>{CONTRACT_STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Start Date *</label>
            <input
              required
              type="date"
              value={form.start_date}
              onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">End Date</label>
            <input
              type="date"
              value={form.end_date}
              onChange={(e) => setForm({ ...form, end_date: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Number of Guards *</label>
            <input
              required
              type="number"
              min="0"
              value={form.number_of_guards}
              onChange={(e) => setForm({ ...form, number_of_guards: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Shift Pattern *</label>
            <select
              required
              value={form.shift_pattern}
              onChange={(e) => setForm({ ...form, shift_pattern: e.target.value as ContractShiftPattern })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            >
              {(["day", "night", "both", "custom"] as const).map((s) => (
                <option key={s} value={s}>{CONTRACT_SHIFT_LABEL[s]}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Rate per Guard / month (PKR) *</label>
            <input
              required
              type="number"
              min="0"
              step="0.01"
              value={form.rate_per_guard_per_month}
              onChange={(e) => setForm({ ...form, rate_per_guard_per_month: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Allowed Leaves / month</label>
            <input
              type="number"
              min="0"
              value={form.allowed_leaves_per_month}
              onChange={(e) => setForm({ ...form, allowed_leaves_per_month: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              placeholder="Inherits client default if blank"
            />
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm text-slate-700 mb-1">
              <input
                type="checkbox"
                checked={form.eobi_deduction}
                onChange={(e) => setForm({ ...form, eobi_deduction: e.target.checked })}
              />
              EOBI deduction
            </label>
            {form.eobi_deduction && (
              <input
                type="number"
                min="0"
                value={form.eobi_amount}
                onChange={(e) => setForm({ ...form, eobi_amount: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="Per-employee EOBI"
              />
            )}
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Annual Escalation %</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.annual_escalation_pct}
              onChange={(e) => setForm({ ...form, annual_escalation_pct: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              placeholder="e.g. 10"
            />
          </div>

          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Renewal Terms</label>
            <textarea
              value={form.renewal_terms}
              onChange={(e) => setForm({ ...form, renewal_terms: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              placeholder="Free text for special clauses"
            />
          </div>
        </div>

        <div className="sticky bottom-0 -mx-6 -mb-6 px-6 py-3 bg-white border-t border-slate-200 flex items-center gap-2">
          <Button variant="primary" size="md" disabled={submitting} className="flex-1">
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
            {submitting ? "Saving…" : contract ? "Save Changes" : "Add Contract"}
          </Button>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
