import { CONTRACT_STATUS_LABEL, type ContractStatus } from "../lib/supabase";

const STYLE: Record<ContractStatus, string> = {
  active: "bg-success-50 text-success-700 border-success-200",
  expired: "bg-slate-100 text-slate-600 border-slate-200",
  terminated: "bg-danger-50 text-danger-700 border-danger-200",
  draft: "bg-warning-50 text-warning-700 border-warning-200",
};

export default function ContractStatusBadge({ status }: { status: ContractStatus }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-md text-xs border ${STYLE[status]}`}>
      {CONTRACT_STATUS_LABEL[status]}
    </span>
  );
}
