import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleAlert, Loader2, Plus } from "lucide-react";
import Button from "./Button";
import { supabase, STATUTORY_SCHEME_LABEL, type StatutoryScheme } from "../lib/supabase";
import { formatDate } from "../lib/date";

/**
 * STATUTORY (2026-10-22). EOBI, salary tax (FBR), PESSI and IESSI as their own
 * tab beside Payables: what payroll withheld or accrued for each month, what
 * has been paid against it, what is still owed — and every payment that went
 * to cost as an ordinary expense instead of settling the liability, which is
 * why a month that has been paid can still read as owed.
 *
 * Every figure is read from the database: statutory_liability_due (accrued,
 * remitted, due per scheme and month), statutory_remittances (each payment and
 * how it split between liability and cost), statutory_booked_as_cost (the
 * payments booked as expenses). Paying is "Pay a statutory liability"
 * (remit_statutory_liability) — the only way a payment settles what is owed.
 */

const SCHEMES: StatutoryScheme[] = ["eobi", "salary_tax", "pessi", "iessi"];
type Due = { scheme: string; period_month: string; accrued: number; remitted: number; due: number; liability_account: string; liability_balance: number };
type Remit = { id: string; scheme: string; period_month: string; amount: number; liability_portion: number; cost_portion: number; paid_on: string; paid_via: string; reference: string | null; notes: string | null; bank_account_id: string | null };
type AsCost = { expense_id: string; expense_date: string; description: string | null; category: string; scheme: string; amount: number; liability_account: string };

const fmt = (n: number | null | undefined) => (n == null ? "—" : Math.round(Number(n)).toLocaleString());
const monthLabel = (m: string) => new Date(`${m.slice(0, 7)}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

export default function StatutoryPayments({
  companyId, banks, canPay, onPay, refreshKey,
}: {
  companyId: string | null;
  banks: { id: string; bank_name: string }[];
  canPay: boolean;
  /** Opens "Pay a statutory liability", optionally for one scheme. */
  onPay: (scheme?: StatutoryScheme) => void;
  /** Bumped by the parent after a payment, so the tab re-reads. */
  refreshKey?: unknown;
}) {
  const [dues, setDues] = useState<Due[] | null>(null);
  const [remits, setRemits] = useState<Remit[]>([]);
  const [asCost, setAsCost] = useState<AsCost[]>([]);
  const [employerEobi, setEmployerEobi] = useState<number | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    setErr(null);
    // Months from the ledger's first through this one.
    const { data: start } = await supabase.rpc("ledger_start_date", { p_company_id: companyId });
    const first = new Date(`${String(start ?? new Date().toISOString()).slice(0, 7)}-01T00:00:00`);
    const now = new Date();
    const months: string[] = [];
    for (let d = new Date(first); d <= now; d.setMonth(d.getMonth() + 1)) {
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`);
    }
    const dueCalls = months.flatMap((m) => SCHEMES.map((sc) =>
      supabase.rpc("statutory_liability_due", { p_company_id: companyId, p_scheme: sc, p_period: m })));
    const [dueRes, rRes, cRes, sRes] = await Promise.all([
      Promise.all(dueCalls),
      supabase.from("statutory_remittances").select("id, scheme, period_month, amount, liability_portion, cost_portion, paid_on, paid_via, reference, notes, bank_account_id")
        .eq("company_id", companyId).order("paid_on", { ascending: false }),
      supabase.rpc("statutory_booked_as_cost", { p_company_id: companyId }),
      supabase.from("payroll_statutory_settings").select("eobi_employer_amount").eq("company_id", companyId).maybeSingle(),
    ]);
    const failed = dueRes.find((r) => r.error);
    if (failed?.error) { setErr(failed.error.message); setDues([]); return; }
    setDues(dueRes.flatMap((r) => (r.data ?? []) as Due[]).map((d) => ({
      ...d, accrued: Number(d.accrued), remitted: Number(d.remitted), due: Number(d.due), liability_balance: Number(d.liability_balance),
    })));
    setRemits(((rRes.data ?? []) as Remit[]).map((r) => ({ ...r, amount: Number(r.amount), liability_portion: Number(r.liability_portion), cost_portion: Number(r.cost_portion) })));
    setAsCost(((cRes.data ?? []) as AsCost[]).map((c) => ({ ...c, amount: Number(c.amount) })));
    setEmployerEobi(sRes.data ? (sRes.data as { eobi_employer_amount: number | null }).eobi_employer_amount : null);
  }, [companyId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const bankName = useMemo(() => new Map(banks.map((b) => [b.id, b.bank_name])), [banks]);
  if (dues == null) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Reading what is owed…</div>;
  }
  if (err) return <p className="text-sm text-muted-foreground py-8 text-center">{err}</p>;

  const owed = dues.reduce((n, d) => n + Math.max(0, d.due), 0);
  const paid = remits.reduce((n, r) => n + r.amount, 0);
  const costTotal = asCost.reduce((n, c) => n + c.amount, 0);

  return (
    <div className="flex flex-col gap-4">
      {/* The four figures that say where statutory stands. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <Tile label="Still owed" value={`PKR ${fmt(owed)}`} sub="withheld or accrued by payroll, not yet paid against" tone={owed > 0 ? "text-heed" : "text-up"} />
        <Tile label="Paid as statutory" value={`PKR ${fmt(paid)}`} sub={`${remits.length} payment${remits.length === 1 ? "" : "s"} recorded here`} />
        <Tile label="Paid but booked as cost" value={`PKR ${fmt(costTotal)}`} sub={asCost.length ? `${asCost.length} payments entered as expenses` : "none"} tone={asCost.length ? "text-down" : "text-up"} />
        <Tile label="Employer EOBI per guard" value={employerEobi == null ? "Not set" : `PKR ${fmt(employerEobi)}`}
          sub={employerEobi == null ? "payroll cannot generate a payslip with EOBI until it is" : "accrued at payroll"} tone={employerEobi == null ? "text-down" : ""} />
      </div>

      {asCost.length > 0 && (
        <section className="rounded-2xl border border-down/40 bg-danger-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-down/30 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-danger-700 dark:text-danger-500 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-danger-700 dark:text-danger-500">Paid, but entered as ordinary expenses</h3>
              <p className="text-xs text-muted-foreground">
                These went to cost instead of settling what payroll withheld — so the month still reads as owed here, and the employee share is counted as cost twice.
                Each is converted into a statutory payment (same date, same bank) once its split is confirmed.
              </p>
            </div>
          </div>
          <div className="divide-y divide-border bg-card">
            {asCost.map((c) => (
              <div key={c.expense_id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                <span className="text-muted-foreground whitespace-nowrap">{formatDate(c.expense_date)}</span>
                <span className="flex-1 min-w-0 truncate text-foreground">{c.description ?? c.category}</span>
                <span className="text-xs text-muted-foreground">{STATUTORY_SCHEME_LABEL[c.scheme as StatutoryScheme] ?? c.scheme} · should settle {c.liability_account}</span>
                <span className="font-ledger font-semibold">{fmt(c.amount)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {SCHEMES.map((sc) => {
        const rows = dues.filter((d) => d.scheme === sc).sort((a, b) => b.period_month.localeCompare(a.period_month));
        const scRemits = remits.filter((r) => r.scheme === sc);
        const anything = rows.some((r) => r.accrued || r.remitted || r.due) || scRemits.length;
        const balance = rows[0]?.liability_balance ?? 0;
        return (
          <section key={sc} className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">{STATUTORY_SCHEME_LABEL[sc]}</h3>
                <p className="text-xs text-muted-foreground">{rows[0]?.liability_account ?? ""} · balance <span className="font-ledger text-foreground">{fmt(balance)}</span></p>
              </div>
              {canPay && (
                <Button size="sm" variant="secondary" className="ml-auto" onClick={() => onPay(sc)}>
                  <Plus className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Pay {STATUTORY_SCHEME_LABEL[sc]}
                </Button>
              )}
            </div>
            {!anything ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">Nothing withheld or accrued by payroll for {STATUTORY_SCHEME_LABEL[sc]} yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Month</th>
                      <th className="text-right px-4 py-2 font-medium">Accrued by payroll</th>
                      <th className="text-right px-4 py-2 font-medium">Paid against it</th>
                      <th className="text-right px-4 py-2 font-medium">Still owed</th>
                      <th className="text-left px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.filter((r) => r.accrued || r.remitted || r.due).map((r) => {
                      const st = r.due <= 0.5 ? (r.accrued ? "paid" : "none") : r.remitted > 0 ? "part" : "open";
                      const monthPays = scRemits.filter((x) => x.period_month.slice(0, 7) === r.period_month.slice(0, 7));
                      return (
                        <tr key={r.period_month} className={st === "open" ? "bg-warning-50/50" : undefined}>
                          <td className="px-4 py-2 align-top">
                            <div className="text-foreground">{monthLabel(r.period_month)}</div>
                            {monthPays.map((p) => (
                              <div key={p.id} className="text-[11px] text-muted-foreground">
                                Paid {formatDate(p.paid_on)} · {p.paid_via === "Bank" ? bankName.get(p.bank_account_id ?? "") ?? "bank" : "cash"}
                                {p.reference ? ` · ${p.reference}` : ""} · {fmt(p.amount)}
                                {p.cost_portion > 0 ? ` (${fmt(p.liability_portion)} against what was withheld, ${fmt(p.cost_portion)} employer cost)` : ""}
                              </div>
                            ))}
                          </td>
                          <td className="px-4 py-2 text-right font-ledger align-top">{fmt(r.accrued)}</td>
                          <td className="px-4 py-2 text-right font-ledger align-top">{fmt(r.remitted)}</td>
                          <td className={`px-4 py-2 text-right font-ledger align-top ${r.due > 0.5 ? "text-heed font-semibold" : "text-muted-foreground"}`}>{fmt(r.due)}</td>
                          <td className="px-4 py-2 align-top">
                            {st === "paid" && <span className="inline-flex items-center gap-1 text-xs text-success-700 dark:text-success-500"><CheckCircle2 className="w-3.5 h-3.5" /> Paid</span>}
                            {st === "part" && <span className="inline-flex items-center gap-1 text-xs text-heed"><CircleAlert className="w-3.5 h-3.5" /> Part paid</span>}
                            {st === "open" && <span className="inline-flex items-center gap-1 text-xs text-heed"><CircleAlert className="w-3.5 h-3.5" /> Owed</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Tile({ label, value, sub, tone = "" }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1 min-w-0">
      <span className="lbl">{label}</span>
      <span className={`font-ledger text-2xl font-semibold tracking-tight leading-none whitespace-nowrap ${tone}`}>{value}</span>
      <span className="text-xs text-muted-foreground">{sub}</span>
    </div>
  );
}
