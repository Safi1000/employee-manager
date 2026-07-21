import { useEffect, useMemo, useState } from "react";
import {
  Lock,
  Unlock,
  Loader2,
  AlertCircle,
  X,
  ShieldAlert,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { formatDate } from "../../lib/date";
import {
  supabase,
  type AccountingPeriod,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

type MonthRow = {
  period_month: string;          // YYYY-MM-01
  label: string;                 // "May 2026"
  invoices: number;
  payments: number;
  expenses: number;
  payslips: number;
  advances: number;
  cheques: number;
  total: number;
  closed_at: string | null;
  closed_by_name: string | null;
  note: string | null;
};

const monthsBack = (n: number): string[] => {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i += 1) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    out.push(iso);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
};

const monthLabel = (iso: string): string => {
  const [y, m] = iso.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

const lastOfMonth = (iso: string): string => {
  const [y, m] = iso.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${iso.slice(0, 7)}-${String(last).padStart(2, "0")}`;
};

export default function PeriodClose() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "super_admin" || profile?.role === "super_super_admin";

  const [periods, setPeriods] = useState<Map<string, AccountingPeriod>>(new Map());
  const [profilesById, setProfilesById] = useState<Map<string, string>>(new Map());
  const [counts, setCounts] = useState<Map<string, MonthRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pending action
  const [actionRow, setActionRow] = useState<MonthRow | null>(null);
  const [actionKind, setActionKind] = useState<"close" | "reopen" | null>(null);
  const [actionNote, setActionNote] = useState("");
  const [actionSubmitting, setActionSubmitting] = useState(false);

  const monthList = useMemo(() => monthsBack(18), []);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const startMonth = monthList[monthList.length - 1];
    const endMonth = lastOfMonth(monthList[0]);

    const [periodsRes, profilesRes, invRes, payRes, expRes, psRes, advRes, chqRes] =
      await Promise.all([
        supabase.from("accounting_periods").select("*"),
        supabase.from("profiles").select("id, full_name, email"),
        supabase
          .from("invoices")
          .select("invoice_date")
          .gte("invoice_date", startMonth)
          .lte("invoice_date", endMonth),
        supabase
          .from("invoice_payments")
          .select("payment_date")
          .gte("payment_date", startMonth)
          .lte("payment_date", endMonth),
        supabase
          .from("expenses")
          .select("expense_date")
          .gte("expense_date", startMonth)
          .lte("expense_date", endMonth),
        supabase
          .from("payslips")
          .select("period_month")
          .gte("period_month", startMonth)
          .lte("period_month", endMonth),
        supabase
          .from("advances")
          .select("advance_date")
          .gte("advance_date", startMonth)
          .lte("advance_date", endMonth),
        supabase
          .from("cheques")
          .select("cheque_date")
          .gte("cheque_date", startMonth)
          .lte("cheque_date", endMonth),
      ]);

    if (periodsRes.error) setError(periodsRes.error.message);

    const periodMap = new Map<string, AccountingPeriod>();
    for (const p of ((periodsRes.data ?? []) as AccountingPeriod[])) {
      periodMap.set(p.period_month.slice(0, 7) + "-01", p);
    }
    setPeriods(periodMap);

    const profMap = new Map<string, string>();
    for (const p of ((profilesRes.data ?? []) as { id: string; full_name: string | null; email: string | null }[])) {
      profMap.set(p.id, p.full_name ?? p.email ?? p.id);
    }
    setProfilesById(profMap);

    const tally = (rows: { d: string }[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const key = `${r.d.slice(0, 7)}-01`;
        m.set(key, (m.get(key) ?? 0) + 1);
      }
      return m;
    };
    const tInv = tally(((invRes.data ?? []) as { invoice_date: string }[]).map((r) => ({ d: r.invoice_date })));
    const tPay = tally(((payRes.data ?? []) as { payment_date: string }[]).map((r) => ({ d: r.payment_date })));
    const tExp = tally(((expRes.data ?? []) as { expense_date: string }[]).map((r) => ({ d: r.expense_date })));
    const tPs  = tally(((psRes.data  ?? []) as { period_month: string }[]).map((r) => ({ d: r.period_month })));
    const tAdv = tally(((advRes.data ?? []) as { advance_date: string }[]).map((r) => ({ d: r.advance_date })));
    const tChq = tally(((chqRes.data ?? []) as { cheque_date: string }[]).map((r) => ({ d: r.cheque_date })));

    const rows = new Map<string, MonthRow>();
    for (const iso of monthList) {
      const period = periodMap.get(iso) ?? null;
      const invoices = tInv.get(iso) ?? 0;
      const payments = tPay.get(iso) ?? 0;
      const expenses = tExp.get(iso) ?? 0;
      const payslips = tPs.get(iso) ?? 0;
      const advances = tAdv.get(iso) ?? 0;
      const cheques = tChq.get(iso) ?? 0;
      rows.set(iso, {
        period_month: iso,
        label: monthLabel(iso),
        invoices,
        payments,
        expenses,
        payslips,
        advances,
        cheques,
        total: invoices + payments + expenses + payslips + advances + cheques,
        closed_at: period?.closed_at ?? null,
        closed_by_name: period?.closed_by ? profMap.get(period.closed_by) ?? null : null,
        note: period?.note ?? null,
      });
    }
    setCounts(rows);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const askClose = (row: MonthRow) => {
    setActionRow(row);
    setActionKind("close");
    setActionNote("");
  };

  const askReopen = (row: MonthRow) => {
    setActionRow(row);
    setActionKind("reopen");
    setActionNote("");
  };

  const confirmAction = async () => {
    if (!actionRow || !actionKind) return;
    setActionSubmitting(true);
    setError(null);
    if (actionKind === "close") {
      const { error: insErr } = await supabase
        .from("accounting_periods")
        .insert({
          period_month: actionRow.period_month,
          closed_by: profile?.id ?? null,
          note: actionNote.trim() || null,
        });
      if (insErr) {
        setActionSubmitting(false);
        setError(insErr.message);
        return;
      }
    } else {
      const period = periods.get(actionRow.period_month);
      if (period) {
        const { error: delErr } = await supabase
          .from("accounting_periods")
          .delete()
          .eq("id", period.id);
        if (delErr) {
          setActionSubmitting(false);
          setError(delErr.message);
          return;
        }
      }
    }
    setActionSubmitting(false);
    setActionRow(null);
    setActionKind(null);
    setActionNote("");
    await loadAll();
  };

  const rows = useMemo(() => monthList.map((iso) => counts.get(iso)).filter((x): x is MonthRow => !!x), [monthList, counts]);

  const closedCount = useMemo(() => rows.filter((r) => r.closed_at).length, [rows]);

  return (
    <>
      <Header
        title="Period Close"
        subtitle="Lock a month so no edits can land in it. Re-opens require explicit confirmation."
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="bg-warning-50 border border-warning-200 rounded-md p-3 text-sm text-warning-900 flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <strong>How this works:</strong> Closing a month blocks <em>any</em> new
            or edited invoice, payment, expense, payslip, advance, or cheque dated
            in that month — for everyone. To correct a mistake in a closed period,
            either post a new transaction in an open month (reversing entry), or
            re-open the month, fix it, and close it again. Re-openings are logged.
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Tile label="Months shown" value={rows.length} />
          <Tile label="Closed" value={closedCount} colour="text-success-700" />
          <Tile label="Open" value={rows.length - closedCount} colour="text-warning-700" />
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Month</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Invoices</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Payments</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Expenses</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Payslips</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Advances</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Cheques</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Status</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && rows.map((row) => {
                  const closed = !!row.closed_at;
                  return (
                    <tr key={row.period_month} className={closed ? "bg-success-50/30" : "hover:bg-slate-50"}>
                      <td className="px-4 py-3 text-sm">
                        <div className="text-slate-900">{row.label}</div>
                        <div className="text-xs text-slate-500 font-mono">{row.period_month}</div>
                      </td>
                      <CountCell n={row.invoices} />
                      <CountCell n={row.payments} />
                      <CountCell n={row.expenses} />
                      <CountCell n={row.payslips} />
                      <CountCell n={row.advances} />
                      <CountCell n={row.cheques} />
                      <td className="px-4 py-3 text-sm">
                        {closed ? (
                          <div>
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-success-50 text-success-700 border border-success-200">
                              <Lock className="w-3 h-3" />
                              Closed
                            </span>
                            <div className="text-[10px] text-slate-500 mt-1">
                              {row.closed_by_name && <>by {row.closed_by_name} · </>}
                              {row.closed_at && formatDate(row.closed_at)}
                            </div>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-warning-50 text-warning-700 border border-warning-200">
                            <Unlock className="w-3 h-3" />
                            Open
                          </span>
                        )}
                        {row.note && (
                          <div className="text-[10px] text-slate-500 mt-1 italic">"{row.note}"</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!isAdmin ? (
                          <span className="text-xs text-slate-400">Admin only</span>
                        ) : closed ? (
                          <button
                            onClick={() => askReopen(row)}
                            className="text-xs px-2 py-1 rounded border border-danger-200 text-danger-700 hover:bg-danger-50"
                          >
                            Re-open
                          </button>
                        ) : (
                          <button
                            onClick={() => askClose(row)}
                            className="text-xs px-2 py-1 rounded bg-brand-600 text-[#fff] hover:bg-brand-700"
                          >
                            Close Month
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Confirmation modal */}
      <Modal
        isOpen={actionRow !== null && actionKind !== null}
        onClose={() => { setActionRow(null); setActionKind(null); }}
        title={actionKind === "close" ? `Close ${actionRow?.label}?` : `Re-open ${actionRow?.label}?`}
        size="md"
      >
        {actionRow && actionKind && (
          <div className="space-y-3">
            {actionKind === "close" ? (
              <>
                <div className="text-sm text-slate-700">
                  Closing this month will block any new or edited transaction
                  dated within <strong>{actionRow.label}</strong>. Existing
                  transactions stay; only future writes are rejected.
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-md p-3 text-xs text-slate-600 space-y-0.5">
                  <div><strong>{actionRow.total}</strong> transactions in this month</div>
                  <div className="text-[10px] text-slate-500">
                    {actionRow.invoices} invoices · {actionRow.payments} payments ·{" "}
                    {actionRow.expenses} expenses · {actionRow.payslips} payslips ·{" "}
                    {actionRow.advances} advances · {actionRow.cheques} cheques
                  </div>
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-700">
                Re-opening allows edits to land in <strong>{actionRow.label}</strong> again.
                This action is logged. Best practice is to close the month again
                immediately after the correction.
              </div>
            )}
            <div>
              <label className="block text-sm text-slate-700 mb-1">
                Note {actionKind === "reopen" && <span className="text-danger-600">(recommended)</span>}
              </label>
              <textarea
                value={actionNote}
                onChange={(e) => setActionNote(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                placeholder={actionKind === "close" ? "Optional: e.g., reviewed by external auditor" : "Why are you re-opening this month?"}
              />
            </div>
            <div className="flex items-center gap-2 pt-3 border-t border-slate-200">
              <Button
                variant={actionKind === "close" ? "primary" : "danger"}
                size="md"
                disabled={actionSubmitting}
                onClick={confirmAction}
                className="flex-1"
              >
                {actionSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : actionKind === "close" ? <Lock className="w-4 h-4 mr-1" /> : <Unlock className="w-4 h-4 mr-1" />}
                {actionKind === "close" ? "Close Month" : "Re-open Month"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => { setActionRow(null); setActionKind(null); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function Tile({ label, value, colour = "text-slate-900" }: { label: string; value: number; colour?: string }) {
  return (
    <div className="bg-white p-3 rounded-lg border border-slate-200">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-2xl ${colour}`}>{value}</div>
    </div>
  );
}

function CountCell({ n }: { n: number }) {
  return (
    <td className={`px-4 py-3 text-right text-sm ${n === 0 ? "text-slate-300" : "text-slate-900"}`}>
      {n === 0 ? "—" : n}
    </td>
  );
}

