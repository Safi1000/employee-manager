// A guard's adjustment history. Ten a month across 450 payslips means a guard
// who appears here repeatedly is a signal about a site, not about him — which
// is why the list lives on his record and not only on the payroll screen.
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { formatDate } from "../lib/date";

export type PayrollAdjustment = {
  id: string; payslip_id: string; employee_id: string; original_period_month: string;
  amount: number; reason: string; settlement: "pay_now" | "carry_forward";
  status: "open" | "settled" | "cancelled"; raised_at: string; settled_at: string | null;
  cancelled_reason: string | null;
};

export const adjustmentSettlementLabel = (a: PayrollAdjustment) =>
  a.settlement === "pay_now" ? "Pay now" : "Next payslip";

export default function PayrollAdjustmentHistory({ employeeId }: { employeeId: string }) {
  const [rows, setRows] = useState<PayrollAdjustment[]>([]);
  useEffect(() => {
    supabase.from("payroll_adjustments").select("*").eq("employee_id", employeeId)
      .order("original_period_month", { ascending: false })
      .then(({ data }) => setRows((data ?? []) as PayrollAdjustment[]));
  }, [employeeId]);

  if (rows.length === 0) return <p className="text-sm text-slate-500">No payslip corrections.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((a) => (
        <li key={a.id} className="py-2 text-sm flex items-start justify-between gap-3">
          <div>
            <div>
              <span className="font-medium">{new Date(a.original_period_month + "T00:00:00").toLocaleString("en", { month: "short", year: "numeric" })}</span>
              <span className="text-slate-500"> · {a.reason}</span>
            </div>
            <div className="text-xs text-slate-500">
              {adjustmentSettlementLabel(a)} · raised {formatDate(a.raised_at)}
              {a.status === "settled" && a.settled_at ? ` · settled ${formatDate(a.settled_at)}` : ""}
              {a.status === "cancelled" ? ` · cancelled — ${a.cancelled_reason ?? ""}` : ""}
            </div>
          </div>
          <span className={`tabular-nums ${Number(a.amount) < 0 ? "text-danger-700" : "text-success-700"}`}>
            {Number(a.amount) > 0 ? "+" : ""}{Number(a.amount).toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
