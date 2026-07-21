import { useCallback, useEffect, useState } from "react";
import { FileText } from "lucide-react";
import Modal from "./Modal";
import Field from "./Field";
import Button from "./Button";
import AddendumTable from "./AddendumTable";
import ContractStatusBadge from "./ContractStatusBadge";
import { formatDate } from "../lib/date";
import { supabase } from "../lib/supabase";
import {
  CONTRACT_TYPE_LABEL,
  CONTRACT_LINE_CATEGORY_LABEL,
  contractLinesValue,
  activeCountByLine,
  effectiveCommittedByCategory,
  type Branch,
  type Client,
  type Contract,
  type ContractAddendum,
  type ContractLine,
  type ContractLineCategory,
  type Employee,
} from "../lib/supabase";

type EmployeeAssignment = Pick<
  Employee,
  "status" | "contract_id" | "contract_line_id" | "assignment_effective_from" | "assignment_effective_to"
>;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Read-only Contract Overview. Strictly a viewer — it renders what's stored and offers
 * no way to mutate it; editing stays on ContractEditorModal.
 */
export default function ContractViewModal({
  isOpen,
  contract,
  client,
  branch,
  lines,
  addendums,
  employees,
  onClose,
}: {
  isOpen: boolean;
  contract: Contract | null;
  client: Client | null;
  branch: Branch | null;
  lines: ContractLine[];
  addendums: ContractAddendum[];
  employees: EmployeeAssignment[];
  onClose: () => void;
}) {
  if (!contract) return null;

  const categoryByLineId = new Map<string, ContractLineCategory>(
    lines.map((l) => [l.id, l.category] as const),
  );
  // Active headcount is per LINE here (the row is a line), unlike the list page which
  // rolls it up per category.
  const activeByLine = activeCountByLine(employees, today());
  // Addendums shift the committed count per CATEGORY, so the base line count can be
  // stale — show the effective figure alongside it.
  const effectiveByCategory = effectiveCommittedByCategory(lines, addendums, today());

  const valuePerMonth = contractLinesValue(lines);
  const totalCommitted = lines.reduce((n, l) => n + (Number(l.committed_count) || 0), 0);
  const totalActive = lines.reduce((n, l) => n + (activeByLine.get(l.id) ?? 0), 0);

  // Total contract value = monthly value × months in the term. Meaningless for an
  // open-ended contract, which has no term to multiply by.
  const months = (() => {
    if (contract.is_infinite || !contract.end_date) return null;
    const s = new Date(contract.start_date + "T00:00:00");
    const e = new Date(contract.end_date + "T00:00:00");
    const m = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
    return m > 0 ? m : null;
  })();

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Contract ${contract.contract_code}`} size="lg">
      <div className="space-y-4">
        {/* Header — client + status */}
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200">
          <div>
            <div className="text-slate-900">{client?.name ?? "(deleted client)"}</div>
            <div className="text-xs text-slate-500 font-mono">{client?.client_code ?? "—"}</div>
          </div>
          <ContractStatusBadge status={contract.status} />
        </div>

        {/* Contract basics */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Field label="Type">{CONTRACT_TYPE_LABEL[contract.contract_type]}</Field>
          <Field label="Start date">{formatDate(contract.start_date)}</Field>
          <Field label="End date">
            {contract.is_infinite ? (
              <span>
                No end date
                {contract.notice_period_days != null && (
                  <span className="text-slate-600">
                    {" "}
                    — Notice period: {contract.notice_period_days} days
                  </span>
                )}
              </span>
            ) : contract.end_date ? (
              formatDate(contract.end_date)
            ) : (
              "—"
            )}
          </Field>
          <Field label="Value / month">PKR {valuePerMonth.toLocaleString()}</Field>
          <Field label="Total contract value">
            {months != null ? (
              <>
                PKR {(valuePerMonth * months).toLocaleString()}
                <span className="text-xs text-slate-500"> ({months} months)</span>
              </>
            ) : (
              <span className="text-slate-500">— (open-ended)</span>
            )}
          </Field>
          <Field label="Guards (active / committed)">
            {totalActive} / {totalCommitted}
          </Field>
        </div>

        {/* Contract Lines — same columns as the editor, read-only */}
        <div className="border border-slate-200 rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
            <span className="text-sm font-medium text-slate-700">Contract Lines</span>
          </div>
          {lines.length === 0 ? (
            <p className="px-3 py-3 text-sm text-slate-500">No lines on this contract.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-500 uppercase border-b border-slate-200">
                    <th className="text-left px-3 py-2">Category</th>
                    <th className="text-left px-3 py-2">Notes</th>
                    <th className="text-right px-3 py-2">Committed</th>
                    <th className="text-right px-3 py-2">Active</th>
                    <th className="text-right px-3 py-2">Rate / month</th>
                    <th className="text-right px-3 py-2">Line value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lines.map((l) => {
                    const committed = Number(l.committed_count) || 0;
                    const active = activeByLine.get(l.id) ?? 0;
                    const effective = effectiveByCategory.get(l.category);
                    return (
                      <tr key={l.id}>
                        <td className="px-3 py-2 text-slate-900">
                          {CONTRACT_LINE_CATEGORY_LABEL[l.category]}
                        </td>
                        <td className="px-3 py-2 text-slate-600">{l.location || "—"}</td>
                        <td className="px-3 py-2 text-right text-slate-900 tabular-nums">
                          {committed}
                          {effective != null && effective !== committed && (
                            <div className="text-[10px] text-slate-500">
                              {effective} after addendums
                            </div>
                          )}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            active > committed ? "text-danger-700 font-medium" : "text-slate-900"
                          }`}
                        >
                          {active}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-600 tabular-nums">
                          {Number(l.unit_rate).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-600 tabular-nums">
                          {(committed * Number(l.unit_rate)).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50 font-medium text-slate-800">
                    <td className="px-3 py-2" colSpan={2}>Total</td>
                    <td className="px-3 py-2 text-right tabular-nums">{totalCommitted}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{totalActive}</td>
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      PKR {valuePerMonth.toLocaleString()}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* Addendums — same table the editor shows */}
        <div className="border border-slate-200 rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
            <span className="text-sm font-medium text-slate-700">Addendums</span>
            <span className="text-[11px] text-slate-500 ml-2">
              Dated changes to committed count / rate.
            </span>
          </div>
          <AddendumTable addendums={addendums} categoryByLineId={categoryByLineId} />
        </div>

        {/* Document */}
        <div className="border border-slate-200 rounded-md p-3">
          <div className="text-sm font-medium text-slate-700 mb-1">Contract document</div>
          {contract.drive_view_url ? (
            <a
              href={contract.drive_view_url}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1 text-sm text-brand-600 hover:text-brand-700"
            >
              <FileText className="w-4 h-4" />
              {contract.contract_file_name ?? "View document"}
            </a>
          ) : (
            <p className="text-sm text-slate-500">
              No document uploaded. Add one from the contract row or the Edit modal.
            </p>
          )}
        </div>

        {/* Amendment history + amend (§23 contract lock) */}
        <AmendmentSection contractId={contract.id} />

        {/* Client context */}
        <div className="border border-slate-200 rounded-md p-3">
          <div className="text-sm font-medium text-slate-700 mb-2">Client</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Field label="Branch">{branch?.name ?? "—"}</Field>
            <Field label="Industry">{client?.industry ?? "—"}</Field>
            <Field label="Email">{client?.email ?? "—"}</Field>
            <Field label="Phone">{client?.phone ?? "—"}</Field>
          </div>
        </div>
      </div>
    </Modal>
  );
}

const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";

// Locked fields whose change is a formal, reason-logged amendment (§23).
const AMENDABLE_FIELDS: [string, string][] = [
  ["rate_per_guard_per_month", "Rate / guard / month"],
  ["number_of_guards", "Number of guards"],
  ["end_date", "End date"],
  ["renewal_terms", "Renewal terms"],
  ["notice_period_days", "Notice period (days)"],
];

function AmendmentSection({ contractId }: { contractId: string }) {
  const [history, setHistory] = useState<any[]>([]);
  const [field, setField] = useState(AMENDABLE_FIELDS[0][0]);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("contract_amendment_history")
      .select("*")
      .eq("contract_id", contractId)
      .order("event_date", { ascending: false });
    setHistory(data ?? []);
  }, [contractId]);
  useEffect(() => { load(); }, [load]);

  const amend = async () => {
    if (!value.trim() || !reason.trim()) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("amend_contract", {
      p_contract_id: contractId, p_field: field, p_new_value: value, p_reason: reason,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setValue(""); setReason("");
    await load();
  };

  return (
    <div className="border border-slate-200 rounded-md overflow-hidden">
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
        <span className="text-sm font-medium text-slate-700">Amendment history</span>
        <span className="text-[11px] text-slate-500 ml-2">Locked-field changes are logged with a reason.</span>
      </div>
      <div className="divide-y divide-slate-100 max-h-40 overflow-y-auto">
        {history.map((h, i) => (
          <div key={i} className="px-3 py-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-700">{h.kind}</span>
              <span className="text-xs text-slate-400">{h.event_date}</span>
            </div>
            {h.detail && <div className="text-xs text-slate-500">{h.detail}</div>}
          </div>
        ))}
        {history.length === 0 && <p className="px-3 py-2 text-sm text-slate-500">No amendments yet.</p>}
      </div>
      <div className="p-3 border-t border-slate-200 space-y-2 bg-slate-50/50">
        <div className="grid grid-cols-2 gap-2">
          <select className={FIELD} value={field} onChange={(e) => setField(e.target.value)}>
            {AMENDABLE_FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input className={FIELD} placeholder="New value" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <input className={FIELD + " w-full"} placeholder="Reason for amendment" value={reason} onChange={(e) => setReason(e.target.value)} />
        {err && <p className="text-xs text-danger-600">{err}</p>}
        <Button variant="primary" size="sm" disabled={busy || !value.trim() || !reason.trim()} onClick={amend}>
          Record amendment
        </Button>
      </div>
    </div>
  );
}
