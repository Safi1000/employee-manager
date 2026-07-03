import { useEffect, useState } from "react";
import { Plus, Loader2, AlertCircle, X, ChevronDown, ChevronRight as ChevronRightIcon } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import {
  supabase,
  CONTRACT_TYPE_LABEL,
  CONTRACT_STATUS_LABEL,
  GUARD_RATE_LABELS,
  type Contract,
  type ContractStatus,
  type ContractType,
  type GuardRates,
} from "../lib/supabase";

type ContractFormState = {
  contract_type: ContractType;
  start_date: string;
  end_date: string;
  day_guards: string;
  night_guards: string;
  evening_guards: string;
  guard_rates: GuardRates;
  rate_per_guard_per_month: string;
  allowed_leaves_per_month: string;
  eobi_deduction: boolean;
  eobi_amount: string;
  annual_escalation_pct: string;
  renewal_terms: string;
  status: ContractStatus;
};

const blank = (): ContractFormState => ({
  contract_type: "services",
  start_date: new Date().toISOString().slice(0, 10),
  end_date: "",
  day_guards: "0",
  night_guards: "0",
  evening_guards: "0",
  guard_rates: {},
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
  day_guards: String(c.day_guards ?? 0),
  night_guards: String(c.night_guards ?? 0),
  evening_guards: String(c.evening_guards ?? 0),
  guard_rates: (c.guard_rates as GuardRates) ?? {},
  rate_per_guard_per_month: String(c.rate_per_guard_per_month),
  allowed_leaves_per_month: c.allowed_leaves_per_month != null ? String(c.allowed_leaves_per_month) : "",
  eobi_deduction: c.eobi_deduction,
  eobi_amount: c.eobi_amount != null ? String(c.eobi_amount) : "",
  annual_escalation_pct: c.annual_escalation_pct != null ? String(c.annual_escalation_pct) : "",
  renewal_terms: c.renewal_terms ?? "",
  status: c.status,
});

const upsertAlerts = async (
  contractCode: string,
  clientName: string,
  startDate: string,
  endDate: string | null,
  contractId: string,
) => {
  await supabase
    .from("important_dates")
    .delete()
    .ilike("notes", `%[contract:${contractId}]%`);

  if (endDate) return;

  const reviewDate = new Date(startDate + "T00:00:00");
  reviewDate.setFullYear(reviewDate.getFullYear() + 1);
  const due = reviewDate.toISOString().slice(0, 10);
  const title = `Contract Review — ${clientName} (${contractCode})`;
  const tag = `[contract:${contractId}]`;

  await supabase.from("important_dates").insert(
    [30, 15, 7, 1].map((days) => ({
      title,
      due_date: due,
      category: "Client" as const,
      priority: days <= 7 ? ("high" as const) : ("medium" as const),
      advance_notice_days: days,
      notes: `${days}-day notice: review or renew this indefinite contract. ${tag}`,
    })),
  );
};

/**
 * Shared add/edit contract modal. Used from the Clients page.
 * The client is fixed by the caller; document upload stays on the Contracts page.
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
  const [ratesOpen, setRatesOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setForm(contract ? fromContract(contract) : blank());
    setError(null);
    setRatesOpen(false);
  }, [isOpen, contract]);

  const totalGuards =
    Math.max(0, Number(form.day_guards) || 0) +
    Math.max(0, Number(form.night_guards) || 0) +
    Math.max(0, Number(form.evening_guards) || 0);

  const buildPayload = () => {
    const day = Math.max(0, Math.floor(Number(form.day_guards) || 0));
    const night = Math.max(0, Math.floor(Number(form.night_guards) || 0));
    const evening = Math.max(0, Math.floor(Number(form.evening_guards) || 0));
    return {
      client_id: clientId,
      contract_type: form.contract_type,
      start_date: form.start_date,
      end_date: form.end_date || null,
      day_guards: day,
      night_guards: night,
      evening_guards: evening,
      number_of_guards: day + night + evening,
      guard_rates: form.guard_rates,
      rate_per_guard_per_month: Math.max(0, Number(form.rate_per_guard_per_month) || 0),
      allowed_leaves_per_month:
        form.allowed_leaves_per_month === "" ? null : Math.max(0, Math.floor(Number(form.allowed_leaves_per_month) || 0)),
      eobi_deduction: form.eobi_deduction,
      eobi_amount: form.eobi_deduction && form.eobi_amount !== "" ? Number(form.eobi_amount) : null,
      annual_escalation_pct: form.annual_escalation_pct === "" ? null : Number(form.annual_escalation_pct),
      renewal_terms: form.renewal_terms.trim() || null,
      status: form.status,
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (contract) {
        const { error: upErr } = await supabase.from("contracts").update(buildPayload()).eq("id", contract.id);
        if (upErr) throw upErr;
        await upsertAlerts(contract.contract_code, clientName ?? "", form.start_date, form.end_date || null, contract.id);
      } else {
        const { data, error: insErr } = await supabase.from("contracts").insert(buildPayload()).select().single();
        if (insErr) throw insErr;
        const inserted = data as Contract;
        await upsertAlerts(inserted.contract_code, clientName ?? "", form.start_date, form.end_date || null, inserted.id);
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
              {(["services", "guard_deployment"] as const).map((t) => (
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
            {!form.end_date && (
              <p className="text-[10px] text-warning-600 mt-1">No end date — 1-year review alerts will be created.</p>
            )}
          </div>

          {/* Per-shift guard counts */}
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-2">Guards per Shift</label>
            <div className="grid grid-cols-3 gap-2">
              {(["day", "night", "evening"] as const).map((shift) => {
                const key = `${shift}_guards` as "day_guards" | "night_guards" | "evening_guards";
                return (
                  <div key={shift} className="border border-slate-200 rounded-md p-2">
                    <label className="block text-xs text-slate-600 mb-1 capitalize">{shift}</label>
                    <input
                      type="number"
                      min="0"
                      value={form[key]}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                      className="w-full px-2 py-1 border border-slate-200 rounded text-sm"
                    />
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-500 mt-1">Total guards: <strong>{totalGuards}</strong></p>
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

          {/* Guard rates expandable */}
          <div className="col-span-2">
            <div className="border border-slate-200 rounded-md">
              <button
                type="button"
                onClick={() => setRatesOpen((o) => !o)}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-slate-900 hover:bg-slate-50"
              >
                {ratesOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
                <span className="flex-1 text-left">Rates per Guard Type (PKR / month)</span>
              </button>
              {ratesOpen && (
                <div className="p-4 border-t border-slate-200 grid grid-cols-2 gap-3">
                  {(Object.keys(GUARD_RATE_LABELS) as Array<keyof GuardRates>).map((key) => (
                    <div key={key}>
                      <label className="block text-xs text-slate-600 mb-1">{GUARD_RATE_LABELS[key]}</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={form.guard_rates[key] ?? ""}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            guard_rates: {
                              ...form.guard_rates,
                              [key]: e.target.value === "" ? undefined : Number(e.target.value),
                            },
                          })
                        }
                        className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                        placeholder="—"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
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
