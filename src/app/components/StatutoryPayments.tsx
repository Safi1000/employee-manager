import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleAlert, Loader2, Plus } from "lucide-react";
import Button from "./Button";
import { supabase, friendlyDbError, statutoryRateOn, STATUTORY_SCHEME_LABEL, type StatutoryRate, type StatutoryScheme } from "../lib/supabase";
import Modal from "./Modal";
import ThemedSelect from "./ThemedSelect";
import { formatDate } from "../lib/date";
import SalesTaxReturns from "./SalesTaxReturns";
import Tabs from "./Tabs";
import { usePageState } from "../lib/pageState";

/**
 * STATUTORY (2026-10-22). EOBI, salary tax (FBR), PESSI and IESSI as their own
 * tab beside Payables: what payroll withheld or accrued for each month, what
 * has been paid against it, what is still owed — and every payment that went
 * to cost as an ordinary expense instead of settling the liability, which is
 * why a month that has been paid can still read as owed.
 *
 * REDESIGN (2026-10-22): one section at a time — Overview (what is owed, by
 * when, and the last payments), Sales tax, EOBI, Salary tax, PESSI / IESSI.
 * Each scheme's section holds its rate, its people and its months together.
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
  companyId, banks, canPay, canClassify = false, onPay, refreshKey,
}: {
  companyId: string | null;
  banks: { id: string; bank_name: string; account_number?: string | null }[];
  canPay: boolean;
  /** clients.edit: classify which clients pay sales tax, and to whom. */
  canClassify?: boolean;
  /** Opens "Pay a statutory liability", optionally for one scheme. */
  onPay: (scheme?: StatutoryScheme) => void;
  /** Bumped by the parent after a payment, so the tab re-reads. */
  refreshKey?: unknown;
}) {
  const [dues, setDues] = useState<Due[] | null>(null);
  const [remits, setRemits] = useState<Remit[]>([]);
  const [asCost, setAsCost] = useState<AsCost[]>([]);
  const [rates, setRates] = useState<StatutoryRate[]>([]);
  const [salesTax, setSalesTax] = useState<{ unpaid: number; unpaidN: number; drafts: number }>({ unpaid: 0, unpaidN: 0, drafts: 0 });
  const [err, setErr] = useState<string | null>(null);
  type Section = "overview" | "sales" | "eobi" | "salary" | "social";
  const [section, setSection] = usePageState<Section>("Statutory.section", "overview");

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
    const [dueRes, rRes, cRes, sRes, stRes] = await Promise.all([
      Promise.all(dueCalls),
      supabase.from("statutory_remittances").select("id, scheme, period_month, amount, liability_portion, cost_portion, paid_on, paid_via, reference, notes, bank_account_id")
        .eq("company_id", companyId).order("paid_on", { ascending: false }),
      supabase.rpc("statutory_booked_as_cost", { p_company_id: companyId }),
      supabase.from("statutory_rates").select("scheme, employee_amount, employer_amount, effective_from, reason").eq("company_id", companyId).order("effective_from", { ascending: false }),
      supabase.from("sales_tax_returns").select("status, challan_amount").eq("company_id", companyId).neq("status", "paid"),
    ]);
    const failed = dueRes.find((r) => r.error);
    if (failed?.error) { setErr(failed.error.message); setDues([]); return; }
    setDues(dueRes.flatMap((r) => (r.data ?? []) as Due[]).map((d) => ({
      ...d, accrued: Number(d.accrued), remitted: Number(d.remitted), due: Number(d.due), liability_balance: Number(d.liability_balance),
    })));
    setRemits(((rRes.data ?? []) as Remit[]).map((r) => ({ ...r, amount: Number(r.amount), liability_portion: Number(r.liability_portion), cost_portion: Number(r.cost_portion) })));
    setAsCost(((cRes.data ?? []) as AsCost[]).map((c) => ({ ...c, amount: Number(c.amount) })));
    setRates(((sRes.data ?? []) as StatutoryRate[]).map((x) => ({ ...x, employee_amount: Number(x.employee_amount), employer_amount: Number(x.employer_amount) })));
    const st = (stRes.data ?? []) as { status: string; challan_amount: number | null }[];
    setSalesTax({
      unpaid: st.filter((x) => x.status === "posted").reduce((n, x) => n + Number(x.challan_amount ?? 0), 0),
      unpaidN: st.filter((x) => x.status === "posted").length,
      drafts: st.filter((x) => x.status === "draft").length,
    });
  }, [companyId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const bankName = useMemo(() => new Map(banks.map((b) => [b.id, b.bank_name])), [banks]);
  if (dues == null) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Reading what is owed…</div>;
  }
  if (err) return <p className="text-sm text-muted-foreground py-8 text-center">{err}</p>;

  const owedOf = (sc: StatutoryScheme) => dues.filter((d) => d.scheme === sc).reduce((n, d) => n + Math.max(0, d.due), 0);
  // The earliest month still owed for a scheme, and — for EOBI — the 10th of
  // the month after it, when its challan is due (DECIDED 2026-10-22).
  const oldestOwed = (sc: StatutoryScheme) => dues.filter((d) => d.scheme === sc && d.due > 0.5).map((d) => d.period_month).sort()[0] ?? null;
  const tenthAfter = (m: string) => { const d = new Date(`${m.slice(0, 7)}-01T00:00:00`); d.setMonth(d.getMonth() + 1); d.setDate(10); return d; };
  const costTotal = asCost.reduce((n, c) => n + c.amount, 0);
  const schemeTable = (sc: StatutoryScheme) => (
    <SchemeTable key={sc} sc={sc} dues={dues} remits={remits} bankName={bankName} canPay={canPay} onPay={onPay} />
  );

  type Card = { key: Section; title: string; amount: number; line: string; tone: string };
  const eobiOldest = oldestOwed("eobi");
  const cards: Card[] = [
    {
      key: "sales", title: "Sales tax", amount: salesTax.unpaid,
      line: salesTax.unpaidN ? `${salesTax.unpaidN} challan${salesTax.unpaidN === 1 ? "" : "s"} made, unpaid · due the 15th`
        : salesTax.drafts ? `${salesTax.drafts} return${salesTax.drafts === 1 ? "" : "s"} being filled · due the 15th` : "nothing open · next return due the 15th",
      tone: salesTax.unpaid > 0 ? "text-heed" : "",
    },
    {
      key: "eobi", title: "EOBI", amount: owedOf("eobi"),
      line: eobiOldest ? `withheld from ${monthLabel(eobiOldest)} on · challan by ${tenthAfter(eobiOldest).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : "nothing withheld and unpaid",
      tone: owedOf("eobi") > 0 ? "text-heed" : "",
    },
    {
      key: "salary", title: "Salary tax (FBR)", amount: owedOf("salary_tax"),
      line: oldestOwed("salary_tax") ? `withheld from ${monthLabel(oldestOwed("salary_tax")!)} on` : "nothing withheld and unpaid",
      tone: owedOf("salary_tax") > 0 ? "text-heed" : "",
    },
    {
      key: "social", title: "PESSI / IESSI", amount: owedOf("pessi") + owedOf("iessi"),
      line: statutoryRateOn(rates, "pessi", new Date().toISOString()) || statutoryRateOn(rates, "iessi", new Date().toISOString()) ? "per head, from their challans" : "rates not set yet",
      tone: owedOf("pessi") + owedOf("iessi") > 0 ? "text-heed" : "",
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Tabs<Section> value={section} onChange={setSection} items={[
        { value: "overview", label: "Overview" },
        { value: "sales", label: "Sales tax", count: salesTax.unpaidN || undefined },
        { value: "eobi", label: "EOBI" },
        { value: "salary", label: "Salary tax" },
        { value: "social", label: "PESSI / IESSI" },
      ]} />

      {section === "overview" && (
        <>
          {/* What is owed, per obligation, and by when. Each opens its section. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            {cards.map((c) => (
              <button key={c.key} type="button" onClick={() => setSection(c.key)}
                className="text-left rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1 min-w-0 hover:border-brand-500/50 transition-colors">
                <span className="lbl">{c.title} · owed</span>
                <span className={`font-ledger text-2xl font-semibold tracking-tight leading-none whitespace-nowrap ${c.tone}`}>PKR {fmt(c.amount)}</span>
                <span className="text-xs text-muted-foreground">{c.line}</span>
              </button>
            ))}
          </div>

          {asCost.length > 0 && (
            <section className="rounded-2xl border border-down/40 bg-danger-50 overflow-hidden">
              <div className="px-4 py-3 border-b border-down/30 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 text-danger-700 dark:text-danger-500 flex-shrink-0" />
                <div>
                  <h3 className="text-sm font-semibold text-danger-700 dark:text-danger-500">Paid, but entered as ordinary expenses · PKR {fmt(costTotal)}</h3>
                  <p className="text-xs text-muted-foreground">
                    These went to cost instead of settling what payroll withheld — so the month still reads as owed, and the employee share is counted as cost twice.
                    Pay EOBI and salary tax from their section here, not as an expense.
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

          {/* The last payments, whichever scheme. */}
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center">
              <h3 className="text-sm font-semibold text-foreground">Recent payments</h3>
              <span className="ml-auto text-xs text-muted-foreground">EOBI, salary tax, PESSI, IESSI</span>
            </div>
            {remits.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {remits.slice(0, 8).map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 px-4 py-2">
                    <span className="text-muted-foreground whitespace-nowrap w-24">{formatDate(p.paid_on)}</span>
                    <span className="flex-1 min-w-0 truncate text-foreground">
                      {STATUTORY_SCHEME_LABEL[p.scheme as StatutoryScheme] ?? p.scheme} · {monthLabel(p.period_month)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {p.paid_via === "Expense" ? "settled by an earlier expense" : p.paid_via === "Bank" ? bankName.get(p.bank_account_id ?? "") ?? "bank" : "cash"}
                    </span>
                    <span className="font-ledger font-semibold">{fmt(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {section === "sales" && (
        <SalesTaxReturns companyId={companyId} banks={banks} canEdit={canPay} canClassify={canClassify} />
      )}

      {section === "eobi" && (
        <>
          <PerHeadRates companyId={companyId} rates={rates} canEdit={canPay} canClassify={canClassify} onChanged={() => void load()} schemes={["eobi"]} chooser />
          {schemeTable("eobi")}
        </>
      )}

      {section === "salary" && (
        <>
          {schemeTable("salary_tax")}
          <IncomeTaxDeducted companyId={companyId} refreshKey={refreshKey} />
        </>
      )}

      {section === "social" && (
        <>
          <PerHeadRates companyId={companyId} rates={rates} canEdit={canPay} canClassify={canClassify} onChanged={() => void load()} schemes={["pessi", "iessi"]} chooser={false} />
          {schemeTable("pessi")}
          {schemeTable("iessi")}
        </>
      )}
    </div>
  );
}

/** One scheme's months: what payroll withheld or accrued, what was paid against it, what is still owed. */
function SchemeTable({ sc, dues, remits, bankName, canPay, onPay }: {
  sc: StatutoryScheme; dues: Due[]; remits: Remit[]; bankName: Map<string, string>; canPay: boolean; onPay: (scheme?: StatutoryScheme) => void;
}) {
  const rows = dues.filter((d) => d.scheme === sc).sort((a, b) => b.period_month.localeCompare(a.period_month));
  const scRemits = remits.filter((r) => r.scheme === sc);
  const anything = rows.some((r) => r.accrued || r.remitted || r.due) || scRemits.length;
  const balance = rows[0]?.liability_balance ?? 0;
  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{STATUTORY_SCHEME_LABEL[sc]} by month</h3>
          <p className="text-xs text-muted-foreground">{rows[0]?.liability_account ?? ""} · balance <span className="font-ledger text-foreground">{fmt(balance)}</span></p>
        </div>
        {canPay && (
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => onPay(sc)}>
            <Plus className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Pay {STATUTORY_SCHEME_LABEL[sc]}
          </Button>
        )}
      </div>
      {!anything ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">Nothing withheld or accrued for {STATUTORY_SCHEME_LABEL[sc]} yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Month</th>
                <th className="text-right px-4 py-2 font-medium">Withheld / accrued</th>
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
                          {p.paid_via === "Expense"
                            // 0548: paid before this screen existed, by an expense that stays as it is.
                            ? <>Settled {formatDate(p.paid_on)} by an expense already booked{p.notes ? ` — ${p.notes.replace(/ — 0548$/, "")}` : ""} · {fmt(p.amount)}</>
                            : <>Paid {formatDate(p.paid_on)} · {p.paid_via === "Bank" ? bankName.get(p.bank_account_id ?? "") ?? "bank" : "cash"}
                              {p.reference ? ` · ${p.reference}` : ""} · {fmt(p.amount)}</>}
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

/**
 * INCOME TAX DEDUCTED (2026-10-22). Per person, per payslip: what payroll
 * withheld as salary tax, from October 2026's payslips on — "from next
 * payslip". The month's total is what "Pay Salary tax (FBR)" settles.
 */
const INCOME_TAX_FROM = "2026-10-01";

function IncomeTaxDeducted({ companyId, refreshKey }: { companyId: string | null; refreshKey?: unknown }) {
  type Row = { id: string; employee_id: string; period_month: string; final_salary: number | null; income_tax: number; status: string | null; name: string };
  const [rows, setRows] = useState<Row[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;
    let alive = true;
    void (async () => {
      const { data, error } = await supabase.from("payslips")
        .select("id, employee_id, period_month, final_salary, income_tax, status")
        .eq("company_id", companyId).gte("period_month", INCOME_TAX_FROM).gt("income_tax", 0)
        .order("period_month", { ascending: false });
      if (!alive) return;
      if (error) { setDenied(true); setRows([]); return; }
      const ps = (data ?? []) as Omit<Row, "name">[];
      const ids = [...new Set(ps.map((p) => p.employee_id))];
      const names = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 200) {
        const { data: em } = await supabase.from("employees").select("id, full_name").in("id", ids.slice(i, i + 200));
        for (const e of (em ?? []) as { id: string; full_name: string }[]) names.set(e.id, e.full_name);
      }
      if (!alive) return;
      setRows(ps.map((p) => ({ ...p, income_tax: Number(p.income_tax), final_salary: p.final_salary == null ? null : Number(p.final_salary), name: names.get(p.employee_id) ?? "—" }))
        .sort((a, b) => b.period_month.localeCompare(a.period_month) || a.name.localeCompare(b.name)));
    })();
    return () => { alive = false; };
  }, [companyId, refreshKey]);

  const months = useMemo(() => [...new Set((rows ?? []).map((r) => r.period_month))], [rows]);

  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Income tax deducted</h3>
        <p className="text-xs text-muted-foreground">Salary tax withheld on each payslip, person by person, from October 2026&rsquo;s payslips on.</p>
      </div>
      {rows == null ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">Reading payslips…</p>
      ) : denied ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">Payslips need payroll access to read.</p>
      ) : months.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">No income tax deducted yet — the list starts with October&rsquo;s payslips.</p>
      ) : (
        <div className="divide-y divide-border">
          {months.map((m) => {
            const mr = rows.filter((r) => r.period_month === m);
            const isOpen = open === m || months.length === 1;
            return (
              <div key={m}>
                <button type="button" className="w-full flex items-center gap-3 px-4 py-2.5 text-left" onClick={() => setOpen(open === m ? null : m)}>
                  <span className="text-sm font-medium text-foreground flex-1">{monthLabel(m)} · {mr.length} {mr.length === 1 ? "person" : "people"}</span>
                  <span className="font-ledger text-sm font-semibold">{fmt(mr.reduce((n, r) => n + r.income_tax, 0))}</span>
                </button>
                {isOpen && (
                  <div className="overflow-x-auto px-4 pb-3">
                    <table className="w-full text-sm">
                      <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="text-left py-1 font-medium">Employee</th>
                          <th className="text-right py-1 font-medium">Salary</th>
                          <th className="text-right py-1 font-medium">Tax deducted</th>
                          <th className="text-left py-1 pl-4 font-medium">Payslip</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {mr.map((r) => (
                          <tr key={r.id}>
                            <td className="py-1">{r.name}</td>
                            <td className="py-1 text-right font-ledger text-muted-foreground">{fmt(r.final_salary)}</td>
                            <td className="py-1 text-right font-ledger">{fmt(r.income_tax)}</td>
                            <td className="py-1 pl-4 text-xs text-muted-foreground">{r.status ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * PER-HEAD RATES AND WHO IS DEDUCTED (0551, 0552 — DECIDED 2026-10-22). One
 * dated rate per scheme for the company — EOBI went 370, 400, 407 — changed
 * only from a payroll month on, with a reason. EOBI is withheld from the
 * employees chosen here, one by one ("not every employee's EOBI is paid
 * because sometimes a client refuses"); it sits in EOBI Payable until a
 * challan pays it. The soft flags only inform — nothing is enforced.
 */
function PerHeadRates({ companyId, rates, canEdit, canClassify, onChanged, schemes, chooser }: {
  companyId: string | null; rates: StatutoryRate[]; canEdit: boolean; canClassify: boolean; onChanged: () => void;
  /** Which schemes' rates this section shows. */
  schemes: ("eobi" | "pessi" | "iessi")[];
  /** EOBI's section: who it is deducted from, open. */
  chooser: boolean;
}) {
  type Emp = {
    id: string; full_name: string; client_id: string | null; category: string | null; lifecycle_state: string | null;
    date_of_birth: string | null; cnic_number: string | null; cnic_expiry: string | null; eobi_registration_number: string | null; eobi_deduct: boolean;
  };
  const [emps, setEmps] = useState<Emp[]>([]);
  const [clientName, setClientName] = useState<Map<string, string>>(new Map());
  const [onlyChosen, setOnlyChosen] = useState(true);
  const [q, setQ] = useState("");
  const show = chooser;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const thisMonth = () => { const d = new Date(); d.setMonth(d.getMonth() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const [f, setF] = useState<{ scheme: "eobi" | "pessi" | "iessi"; emp: string; er: string; from: string; reason: string }>({ scheme: schemes[0], emp: "", er: "", from: thisMonth(), reason: "" });

  const loadEmps = useCallback(async () => {
    if (!companyId || !chooser) return;
    const [e, c] = await Promise.all([
      supabase.from("employees")
        .select("id, full_name, client_id, category, lifecycle_state, date_of_birth, cnic_number, cnic_expiry, eobi_registration_number, eobi_deduct")
        .eq("company_id", companyId).order("full_name"),
      supabase.from("clients").select("id, name").eq("company_id", companyId),
    ]);
    if (!e.error) setEmps((e.data ?? []) as Emp[]);
    setClientName(new Map(((c.data ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name])));
  }, [companyId, chooser]);
  useEffect(() => { void loadEmps(); }, [loadEmps]);

  const setDeduct = async (ids: string[], v: boolean) => {
    if (ids.length === 0) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.from("employees").update({ eobi_deduct: v }).in("id", ids);
    setBusy(false);
    if (error) setErr(friendlyDbError(error)); else void loadEmps();
  };
  const save = async () => {
    if (!(Number(f.emp) >= 0) || !(Number(f.er) >= 0) || f.emp === "" || f.er === "") return setErr("Enter the employee and employer amounts per head.");
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("change_statutory_rate", {
      p_company_id: companyId, p_scheme: f.scheme, p_employee_amount: Number(f.emp), p_employer_amount: Number(f.er),
      p_effective_from: `${f.from}-01`, p_reason: f.reason,
    });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    setOpen(false); onChanged();
  };

  const nowIso = new Date().toISOString();
  const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  const LEFT = ["left", "terminated", "fired", "absconded", "archived"];
  const today = new Date().toISOString().slice(0, 10);
  const age = (dob: string | null) => {
    if (!dob) return null;
    const b = new Date(`${dob}T00:00:00`), n = new Date();
    return n.getFullYear() - b.getFullYear() - (n < new Date(n.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
  };
  // Soft flags — informing only, never enforced.
  const flags = (e: Emp) => {
    const out: string[] = [];
    const a = age(e.date_of_birth);
    if (a == null) out.push("age unknown"); else if (a >= 65) out.push(`age ${a}`);
    if (!e.cnic_number?.trim()) out.push("no CNIC"); else if (e.cnic_expiry && e.cnic_expiry < today) out.push("CNIC expired");
    if (!e.eobi_registration_number?.trim()) out.push("no EOBI no.");
    if (LEFT.includes(String(e.lifecycle_state ?? ""))) out.push(String(e.lifecycle_state));
    return out;
  };
  const chosen = emps.filter((e) => e.eobi_deduct);
  const shown = emps.filter((e) => (onlyChosen ? e.eobi_deduct : !LEFT.includes(String(e.lifecycle_state ?? "")) || e.eobi_deduct)
    && (!q.trim() || e.full_name.toLowerCase().includes(q.trim().toLowerCase())));
  const groups = [...shown.reduce((m, e) => {
    const k = e.client_id ? clientName.get(e.client_id) ?? "Client" : "Head office / office staff";
    m.set(k, [...(m.get(k) ?? []), e]); return m;
  }, new Map<string, Emp[]>())].sort((a, b) => b[1].length - a[1].length);
  const flagged = chosen.filter((e) => flags(e).some((f) => !f.startsWith("age unknown") && f !== "no EOBI no.")).length;

  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground mr-2">Per head</h3>
        {schemes.map((sc) => {
          const r = statutoryRateOn(rates, sc, nowIso);
          return (
            <div key={sc} className="text-sm" title={r?.reason}>
              <span className="font-medium text-foreground">{STATUTORY_SCHEME_LABEL[sc]}</span>{" "}
              {r ? <><span className="font-ledger">{fmt(r.employee_amount)} + {fmt(r.employer_amount)}</span> <span className="text-[11px] text-muted-foreground">since {monthLabel(r.effective_from)}</span></>
                : <span className="text-[11px] text-muted-foreground">not set</span>}
            </div>
          );
        })}
        {canEdit && (
          <button type="button" className="text-xs text-brand-700 dark:text-brand-500 hover:underline font-medium"
            onClick={() => { setErr(null); setF({ scheme: schemes[0], emp: "", er: "", from: thisMonth(), reason: "" }); setOpen(true); }}>Change a rate</button>
        )}
        {chooser && (
          <span className="ml-auto text-xs text-muted-foreground">
            Deducted from <span className="font-semibold text-foreground">{chosen.length}</span> employees{flagged ? ` · ${flagged} flagged` : ""}
          </span>
        )}
      </div>
      {err && !open && <p className="px-4 pb-2 text-sm text-danger-700 dark:text-danger-500">{err}</p>}
      {show && (
        <div className="px-4 py-3 border-t border-border flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Payroll withholds the EOBI employee share from everyone ticked, from the next payroll made, and holds it as a liability.
            Whose EOBI is actually paid is chosen on the challan; the employer share is a cost only for them, on their client (office staff on head office).
            Flags are for information only.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <input className="w-56 rounded-lg border border-border bg-background px-3 py-1.5 text-sm" placeholder="Search a name" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="flex gap-1 rounded-lg bg-muted p-1 text-xs">
              {([true, false] as const).map((v) => (
                <button key={String(v)} type="button" aria-pressed={onlyChosen === v} onClick={() => setOnlyChosen(v)}
                  className={`px-3 py-1 rounded-md ${onlyChosen === v ? "bg-card text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                  {v ? `Ticked (${chosen.length})` : "Everyone working"}
                </button>
              ))}
            </div>
          </div>
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody here.</p>
          ) : groups.map(([g, list]) => {
            const ticked = list.filter((e) => e.eobi_deduct).length;
            return (
              <div key={g} className="rounded-lg border border-border">
                <div className="flex items-center gap-3 px-3 py-1.5 bg-muted/40 text-sm">
                  <span className="font-medium text-foreground flex-1">{g}</span>
                  <span className="text-xs text-muted-foreground">{ticked} of {list.length} ticked</span>
                  {canClassify && (
                    <>
                      <button type="button" disabled={busy} className="text-xs text-brand-700 dark:text-brand-500 hover:underline" onClick={() => void setDeduct(list.filter((e) => !e.eobi_deduct).map((e) => e.id), true)}>Tick all</button>
                      <button type="button" disabled={busy} className="text-xs text-muted-foreground hover:text-foreground" onClick={() => void setDeduct(list.filter((e) => e.eobi_deduct).map((e) => e.id), false)}>Untick all</button>
                    </>
                  )}
                </div>
                <ul className="divide-y divide-border text-sm">
                  {list.map((e) => {
                    const fl = e.eobi_deduct ? flags(e) : [];
                    return (
                      <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1">
                        <input type="checkbox" className="accent-brand-600" checked={e.eobi_deduct} disabled={!canClassify || busy}
                          aria-label={`Deduct EOBI from ${e.full_name}`} onChange={() => void setDeduct([e.id], !e.eobi_deduct)} />
                        <span className={`flex-1 min-w-0 truncate ${e.eobi_deduct ? "text-foreground" : "text-muted-foreground"}`}>{e.full_name}</span>
                        {fl.map((f) => (
                          <span key={f} className={`text-[11px] rounded px-1.5 py-0.5 ${/^age \d/.test(f) || f === "CNIC expired" || LEFT.includes(f) ? "bg-warning-50 text-heed" : "bg-muted text-muted-foreground"}`}>{f}</span>
                        ))}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      <Modal isOpen={open} onClose={() => !busy && setOpen(false)} title="Change a per-head rate" error={open ? err : null} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save the change"}</Button>
        </>}>
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">A rate is never edited. The new one applies to payroll from its month; payslips already made keep the rate they were made at.</p>
          <ThemedSelect value={f.scheme} onChange={(e) => setF((x) => ({ ...x, scheme: e.target.value as typeof f.scheme }))} aria-label="Scheme">
            {schemes.map((sc) => <option key={sc} value={sc}>{STATUTORY_SCHEME_LABEL[sc]}</option>)}
          </ThemedSelect>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Employee share per head</label>
              <input className={field} inputMode="decimal" value={f.emp} onChange={(e) => setF((x) => ({ ...x, emp: e.target.value }))} />
            </div>
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Employer share per head</label>
              <input className={field} inputMode="decimal" value={f.er} onChange={(e) => setF((x) => ({ ...x, er: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">Applies from payroll month</label>
            <input type="month" className={field} value={f.from} onChange={(e) => setF((x) => ({ ...x, from: e.target.value }))} />
          </div>
          <input className={field} placeholder="Why — e.g. Minimum wage FY 2027-28" value={f.reason} onChange={(e) => setF((x) => ({ ...x, reason: e.target.value }))} />
          {rates.filter((x) => x.scheme === f.scheme).length > 0 && (
            <ul className="text-xs divide-y divide-border rounded-lg border border-border">
              {rates.filter((x) => x.scheme === f.scheme).map((x) => (
                <li key={x.effective_from} className="flex gap-3 px-3 py-1.5">
                  <span className="font-ledger w-24">{fmt(x.employee_amount)} + {fmt(x.employer_amount)}</span>
                  <span className="text-muted-foreground w-28">from {monthLabel(x.effective_from)}</span>
                  <span className="text-muted-foreground truncate">{x.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
    </section>
  );
}
