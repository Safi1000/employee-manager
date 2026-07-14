import { FileText } from "lucide-react";
import { formatDate } from "../lib/date";
import {
  ADDENDUM_CHANGE_TYPE_LABEL,
  ADDENDUM_SOURCE_LABEL,
  CONTRACT_LINE_CATEGORY_LABEL,
  type ContractAddendum,
  type ContractLineCategory,
} from "../lib/supabase";

/**
 * Read-only list of a contract's addendums. Shared by the contract editor (where the
 * category lookup comes from the in-flight line drafts) and the read-only Contract
 * Overview (where it comes from the stored lines) — hence the injected lookup rather
 * than either owning the resolution.
 *
 * An addendum with no contract_line_id introduces a NEW line, so it carries its own
 * category instead of borrowing one from an existing line.
 */
export default function AddendumTable({
  addendums,
  categoryByLineId,
}: {
  addendums: ContractAddendum[];
  categoryByLineId: Map<string, ContractLineCategory>;
}) {
  if (addendums.length === 0) {
    return <p className="px-3 py-3 text-sm text-slate-500">No addendums on this contract.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-500 uppercase border-b border-slate-200">
            <th className="text-left px-3 py-2">Effective</th>
            <th className="text-left px-3 py-2">Change</th>
            <th className="text-left px-3 py-2">Category / Line</th>
            <th className="text-left px-3 py-2">Source</th>
            <th className="text-left px-3 py-2">Reference</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {addendums.map((a) => {
            const cat = a.contract_line_id
              ? categoryByLineId.get(a.contract_line_id) ?? a.category
              : a.category;
            return (
              <tr key={a.id}>
                <td className="px-3 py-1.5 text-slate-700">{formatDate(a.effective_from)}</td>
                <td className="px-3 py-1.5 text-slate-700">
                  {ADDENDUM_CHANGE_TYPE_LABEL[a.change_type]}
                  {a.change_type === "RATE_CHANGE"
                    ? a.new_rate != null && ` → PKR ${Number(a.new_rate).toLocaleString()}`
                    : ` (${a.change_type === "REDUCE_HEADCOUNT" ? "−" : "+"}${a.count_delta})`}
                </td>
                <td className="px-3 py-1.5 text-slate-600">
                  {cat ? CONTRACT_LINE_CATEGORY_LABEL[cat] : "—"}
                  {!a.contract_line_id && <span className="text-[10px] text-slate-400 ml-1">(new line)</span>}
                </td>
                <td className="px-3 py-1.5 text-slate-600">{ADDENDUM_SOURCE_LABEL[a.source]}</td>
                <td className="px-3 py-1.5">
                  {a.drive_view_url ? (
                    <a
                      href={a.drive_view_url}
                      target="_blank"
                      rel="noopener"
                      className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700"
                    >
                      <FileText className="w-3 h-3" />
                      {a.reference_file_name ?? "Document"}
                    </a>
                  ) : (
                    <span className="text-xs text-slate-500">{a.reference ?? "—"}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
