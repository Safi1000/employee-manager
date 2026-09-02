import { useEffect, useMemo, useState } from "react";
import { Loader2, AlertCircle, X, Lock, LockOpen, Info } from "lucide-react";
import Header from "../../components/Header";
import ThemedSelect from "../../components/ThemedSelect";
import ExportButton from "../../components/ExportButton";
import { exportTable } from "../../lib/excel";
import {
  supabase,
  ACCOUNT_TYPE_LABEL,
  ACCOUNT_TYPE_ORDER,
  type AccountType,
  type TrialBalanceAccountRow,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { useRegion } from "../../lib/region";

// TRIAL BALANCE
//
// Reads `public.trial_balance` and nothing else. That view is the single
// source for account balances: 0299 collapsed the duplicate sum that
// `ledger_checks_base` used to compute inline, and 0319 added `posting_period`
// to its grain so this screen can filter by period rather than pulling
// `journal_lines` and summing them in the browser — which is what this screen
// did before, and is the defect the ledger work exists to remove.
//
// The view's grain is account x branch x period, and this screen offers "all
// regions" and "all periods" — so something has to add the branch rows and the
// period rows together. 0320 put that somewhere in the database:
// `trial_balance_for(company, period, branch)` answers all four combinations
// from one body, reading trial_balance and summing its columns. The screen
// therefore adds nothing up.
//
// The ONE figure computed here is the footer total, and it is computed here on
// purpose. A trial balance footer means "the sum of the column above it". A
// total fetched separately would disagree with its own table the moment the
// rows differ — hide-zero, or a row RLS withheld — which is the header-figure
// defect (report 9.16). A footer that cannot contradict its table has to be
// folded from the table.

const fmtPKR = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;

const monthLabel = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

type Folded = {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: AccountType;
  debit: number;
  credit: number;
};

export default function TrialBalance() {
  const { profile, company } = useAuth();
  const { regionId, region } = useRegion();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;

  const [rows, setRows] = useState<TrialBalanceAccountRow[]>([]);
  const [periods, setPeriods] = useState<string[]>([]);
  // "" means every period — the cumulative balance, which is what the check
  // suite compares. A specific period narrows to that month's movement.
  const [period, setPeriod] = useState<string>("");
  const [closedPeriods, setClosedPeriods] = useState<Set<string>>(new Set());
  const [hideZero, setHideZero] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!companyId) {
        setRows([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);

      const [tbRes, apRes] = await Promise.all([
        // 0320. Already one row per account at the requested grain — nulls mean
        // "every period" and "every region", which is exactly what the two
        // "All" options mean.
        supabase.rpc("trial_balance_for", {
          p_company_id: companyId,
          p_period: period || null,
          p_branch_id: regionId,
        }),
        supabase
          .from("accounting_periods")
          .select("period_month, closed_at")
          .eq("company_id", companyId),
      ]);

      if (cancelled) return;
      if (tbRes.error) {
        setError(tbRes.error.message);
        setLoading(false);
        return;
      }

      setRows((tbRes.data ?? []) as TrialBalanceAccountRow[]);
      setClosedPeriods(
        new Set(
          ((apRes.data ?? []) as { period_month: string }[]).map((p) => p.period_month),
        ),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, regionId, period]);

  // The period list is a reading of what has actually been posted, not a
  // generated calendar — a month with no entries is not a period of this
  // ledger. It is loaded unfiltered so selecting a period never removes the
  // option that produced it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!companyId) return;
      const { data } = await supabase
        .from("trial_balance")
        .select("posting_period")
        .eq("company_id", companyId);
      if (cancelled) return;
      const set = new Set(
        ((data ?? []) as { posting_period: string }[]).map((r) => r.posting_period),
      );
      setPeriods([...set].sort().reverse());
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Filtering, not folding: the rows arrive one per account already.
  const folded = useMemo<Folded[]>(
    () =>
      rows
        .map((r) => ({
          account_id: r.account_id,
          account_code: r.account_code,
          account_name: r.account_name,
          account_type: r.account_type,
          debit: Number(r.total_debit),
          credit: Number(r.total_credit),
        }))
        .filter((r) => !hideZero || r.debit !== 0 || r.credit !== 0),
    [rows, hideZero],
  );

  const totals = useMemo(() => {
    let d = 0;
    let c = 0;
    for (const r of folded) {
      d += r.debit;
      c += r.credit;
    }
    return { d, c };
  }, [folded]);

  const balanced = Math.abs(totals.d - totals.c) < 0.005;
  const isClosed = period ? closedPeriods.has(period) : false;

  const byType = useMemo(() => {
    const m = new Map<AccountType, Folded[]>();
    for (const t of ACCOUNT_TYPE_ORDER) m.set(t, []);
    for (const r of folded) m.get(r.account_type)?.push(r);
    return m;
  }, [folded]);

  return (
    <>
      <Header
        title="Trial Balance"
        subtitle="Every account with its debit and credit balance, read from the ledger"
        actions={
          <ExportButton
            onExport={() =>
              exportTable({
                fileName: `Trial Balance ${period || "all periods"}.xlsx`,
                sheetName: "Trial Balance",
                title: `Trial Balance — ${period ? monthLabel(period) : "all periods"}${
                  region ? ` — ${region.name}` : ""
                }`,
                headers: ["Code", "Account", "Type", "Debit (PKR)", "Credit (PKR)"],
                rows: [
                  ...folded.map((r) => [
                    r.account_code,
                    r.account_name,
                    ACCOUNT_TYPE_LABEL[r.account_type],
                    r.debit,
                    r.credit,
                  ]),
                  ["", "TOTAL", "", totals.d, totals.c],
                ],
              })
            }
          />
        }
      />

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-4 md:p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-slate-600">Period</label>
              <ThemedSelect
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm min-w-[200px]"
              >
                <option value="">All periods (cumulative)</option>
                {periods.map((p) => (
                  <option key={p} value={p}>
                    {monthLabel(p)}
                  </option>
                ))}
              </ThemedSelect>

              {period && (
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs ${
                    isClosed
                      ? "bg-slate-100 text-slate-700"
                      : "bg-success-50 text-success-700"
                  }`}
                >
                  {isClosed ? (
                    <>
                      <Lock className="w-3 h-3" /> Closed
                    </>
                  ) : (
                    <>
                      <LockOpen className="w-3 h-3" /> Open
                    </>
                  )}
                </span>
              )}
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={hideZero}
                onChange={(e) => setHideZero(e.target.checked)}
              />
              Hide zero balances
            </label>
          </div>

          {loading ? (
            <div className="py-16 text-center text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
            </div>
          ) : folded.length === 0 ? (
            <EmptyLedger period={period} regionName={region?.name ?? null} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Code</th>
                    <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Account</th>
                    <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Debit</th>
                    <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Credit</th>
                  </tr>
                </thead>
                {ACCOUNT_TYPE_ORDER.map((type) => {
                  const group = byType.get(type) ?? [];
                  if (group.length === 0) return null;
                  return (
                    <tbody key={type} className="divide-y divide-slate-100">
                      <tr className="bg-slate-50/60">
                        <td colSpan={4} className="px-4 py-2 text-xs uppercase tracking-wide text-slate-500">
                          {ACCOUNT_TYPE_LABEL[type]}
                        </td>
                      </tr>
                      {group.map((r) => (
                        <tr key={r.account_id} className="hover:bg-slate-50">
                          <td className="px-4 py-2 text-xs font-mono text-slate-900">{r.account_code}</td>
                          <td className="px-4 py-2 text-sm text-slate-900">{r.account_name}</td>
                          <td className="px-4 py-2 text-right text-sm">
                            {r.debit !== 0 ? fmtPKR(r.debit) : ""}
                          </td>
                          <td className="px-4 py-2 text-right text-sm">
                            {r.credit !== 0 ? fmtPKR(r.credit) : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  );
                })}
                <tfoot>
                  <tr className="border-t-2 border-slate-300 bg-slate-50">
                    <td colSpan={2} className="px-4 py-3 text-sm text-slate-900 font-medium text-right">
                      TOTAL
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-slate-900 font-medium">
                      {fmtPKR(totals.d)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-slate-900 font-medium">
                      {fmtPKR(totals.c)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={4} className="px-4 py-2 text-xs text-right">
                      Difference:{" "}
                      <span className={balanced ? "text-success-700 font-medium" : "text-danger-700 font-medium"}>
                        {fmtPKR(totals.d - totals.c)}
                      </span>
                      {balanced && <span className="text-success-700 ml-2">✓ Balanced</span>}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * An empty trial balance is a real reading, not a broken screen. Saying which
 * is which matters right now: the live company has no journal lines until its
 * financials are entered, and a blank table invites the wrong conclusion.
 */
function EmptyLedger({ period, regionName }: { period: string; regionName: string | null }) {
  return (
    <div className="py-16 px-6 text-center">
      <Info className="w-6 h-6 mx-auto text-slate-400 mb-3" />
      <p className="text-sm text-slate-700">
        No journal entries {period ? `for ${monthLabel(period)}` : "yet"}
        {regionName ? ` in ${regionName}` : ""}.
      </p>
      <p className="text-xs text-slate-500 mt-2 max-w-md mx-auto">
        This is the ledger reporting that nothing has been posted — not a
        loading failure. Balances appear here as soon as invoices, payroll,
        expenses or opening balances are entered.
      </p>
    </div>
  );
}
