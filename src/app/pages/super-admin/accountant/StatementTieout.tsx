import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { supabase } from "../../../lib/supabase";
import { monthLabel, monthStart, useCompanyId } from "../reports/kit";

/**
 * TIE-OUT (0539, 2026-10-21). Proof, for one month, that the client-wise
 * statement and the partnership account for every receipt and every rupee that
 * went out. Each line is the same total reached two independent ways
 * (statement_tieout); a difference is a defect, not an opinion. Below it,
 * every item of money that has nowhere to land, with what to fix
 * (unplaced_money). Cash basis — what the partnership runs on.
 */

type Check = {
  sort: number; section: string; check_name: string;
  source_amount: number; statement_amount: number; difference: number; ok: boolean; note: string;
};
type Unplaced = { kind: string; item: string; amount: number; on_date: string; why: string; fix: string };

const fmt = (n: number) => Math.round(Number(n)).toLocaleString();
const fmtDiff = (n: number) => {
  const v = Number(n);
  return Math.abs(v) < 0.5 ? "—" : `${v > 0 ? "+" : "−"}${Math.abs(Math.round(v)).toLocaleString()}`;
};

export default function StatementTieout({ period }: { period: string }) {
  const companyId = useCompanyId();
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [unplaced, setUnplaced] = useState<Unplaced[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setChecks(null); setError(null);
    void Promise.all([
      supabase.rpc("statement_tieout", { p_company_id: companyId, p_month: monthStart(period) }),
      supabase.rpc("unplaced_money", { p_company_id: companyId, p_month: monthStart(period) }),
    ]).then(([c, u]) => {
      if (cancelled) return;
      if (c.error) { setError(c.error.message); setChecks([]); return; }
      setChecks(((c.data ?? []) as Check[]).sort((a, b) => a.sort - b.sort));
      setUnplaced((u.data ?? []) as Unplaced[]);
    });
    return () => { cancelled = true; };
  }, [companyId, period]);

  if (checks == null) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Tying out {monthLabel(period)}…</div>;
  }
  if (error) {
    return <p className="text-sm text-muted-foreground py-8 text-center">{/function .* does not exist/i.test(error) ? "The tie-out appears once its database update is applied." : error}</p>;
  }

  const red = checks.filter((c) => !c.ok).length;
  const sections = [...new Set(checks.map((c) => c.section))];

  return (
    <div className="flex flex-col gap-4">
      <div className={`rounded-2xl border px-4 py-3 flex items-center gap-3 ${red ? "border-down/50 bg-danger-50" : "border-up/40 bg-success-50"}`}>
        {red ? <CircleAlert className="w-5 h-5 text-danger-700 dark:text-danger-500" /> : <CheckCircle2 className="w-5 h-5 text-success-700 dark:text-success-500" />}
        <div className="text-sm">
          <div className={`font-semibold ${red ? "text-danger-700 dark:text-danger-500" : "text-success-700 dark:text-success-500"}`}>
            {red ? `${red} of ${checks.length} checks do not tie out for ${monthLabel(period)}` : `Everything ties out for ${monthLabel(period)}`}
          </div>
          <div className="text-xs text-muted-foreground">
            Each line is one total reached two independent ways. Cash basis — what the partnership runs on.
          </div>
        </div>
      </div>

      {sections.map((sec) => (
        <section key={sec} className="rounded-2xl border border-border bg-card overflow-hidden">
          <h3 className="px-4 py-2.5 border-b border-border text-sm font-semibold text-foreground">{sec}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Check</th>
                  <th className="text-right px-4 py-2 font-medium">Source</th>
                  <th className="text-right px-4 py-2 font-medium">Statement</th>
                  <th className="text-right px-4 py-2 font-medium">Difference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {checks.filter((c) => c.section === sec).map((c) => (
                  <tr key={c.sort} className={c.ok ? "" : "bg-danger-50/60"}>
                    <td className="px-4 py-2 align-top">
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        {c.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-success-700 dark:text-success-500 shrink-0" /> : <CircleAlert className="w-3.5 h-3.5 text-danger-700 dark:text-danger-500 shrink-0" />}
                        {c.check_name}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5 max-w-xl">{c.note}</div>
                    </td>
                    <td className="px-4 py-2 text-right font-ledger align-top">{fmt(c.source_amount)}</td>
                    <td className="px-4 py-2 text-right font-ledger align-top">{fmt(c.statement_amount)}</td>
                    <td className={`px-4 py-2 text-right font-ledger align-top ${c.ok ? "text-muted-foreground" : "text-danger-700 dark:text-danger-500 font-semibold"}`}>{fmtDiff(c.difference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <section className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">Money with nowhere to land</h3>
          <p className="text-xs text-muted-foreground">
            Each item counts for the company but sits in no partner&rsquo;s region. Fix the record named and it moves into a statement.
          </p>
        </div>
        {unplaced.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground text-center">Nothing — every rupee in {monthLabel(period)} has a region.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">What</th>
                  <th className="text-left px-4 py-2 font-medium">Date</th>
                  <th className="text-right px-4 py-2 font-medium">Amount</th>
                  <th className="text-left px-4 py-2 font-medium">Why</th>
                  <th className="text-left px-4 py-2 font-medium">Fix</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {unplaced.map((u, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2"><span className="text-muted-foreground text-xs mr-1.5">{u.kind}</span><span className="text-foreground">{u.item}</span></td>
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{u.on_date}</td>
                    <td className="px-4 py-2 text-right font-ledger">{fmt(u.amount)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{u.why}</td>
                    <td className="px-4 py-2 text-foreground font-medium">{u.fix}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
