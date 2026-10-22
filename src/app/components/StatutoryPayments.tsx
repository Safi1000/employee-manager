import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleAlert, Loader2, Plus } from "lucide-react";
import Button from "./Button";
import { supabase, friendlyDbError, statutoryRateOn, STATUTORY_SCHEME_LABEL, type StatutoryRate, type StatutoryScheme } from "../lib/supabase";
import Modal from "./Modal";
import ThemedSelect from "./ThemedSelect";
import { formatDate } from "../lib/date";
import SalesTaxReturns from "./SalesTaxReturns";

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
      supabase.from("statutory_rates").select("scheme, employee_amount, employer_amount, effective_from, reason").eq("company_id", companyId).order("effective_from", { ascending: false }),
    ]);
    const failed = dueRes.find((r) => r.error);
    if (failed?.error) { setErr(failed.error.message); setDues([]); return; }
    setDues(dueRes.flatMap((r) => (r.data ?? []) as Due[]).map((d) => ({
      ...d, accrued: Number(d.accrued), remitted: Number(d.remitted), due: Number(d.due), liability_balance: Number(d.liability_balance),
    })));
    setRemits(((rRes.data ?? []) as Remit[]).map((r) => ({ ...r, amount: Number(r.amount), liability_portion: Number(r.liability_portion), cost_portion: Number(r.cost_portion) })));
    setAsCost(((cRes.data ?? []) as AsCost[]).map((c) => ({ ...c, amount: Number(c.amount) })));
    setRates(((sRes.data ?? []) as StatutoryRate[]).map((x) => ({ ...x, employee_amount: Number(x.employee_amount), employer_amount: Number(x.employer_amount) })));
  }, [companyId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const bankName = useMemo(() => new Map(banks.map((b) => [b.id, b.bank_name])), [banks]);
  if (dues == null) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Reading what is owed…</div>;
  }
  if (err) return <p className="text-sm text-muted-foreground py-8 text-center">{err}</p>;

  const owed = dues.reduce((n, d) => n + Math.max(0, d.due), 0);
  const paid = remits.filter((r) => r.paid_via !== "Expense").reduce((n, r) => n + r.amount, 0);
  const costTotal = asCost.reduce((n, c) => n + c.amount, 0);

  return (
    <div className="flex flex-col gap-4">
      {/* The four figures that say where statutory stands. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <Tile label="Still owed" value={`PKR ${fmt(owed)}`} sub="withheld or accrued by payroll, not yet paid against" tone={owed > 0 ? "text-heed" : "text-up"} />
        <Tile label="Paid as statutory" value={`PKR ${fmt(paid)}`} sub={`${remits.filter((r) => r.paid_via !== "Expense").length} payments recorded here`} />
        <Tile label="Paid but booked as cost" value={`PKR ${fmt(costTotal)}`} sub={asCost.length ? `${asCost.length} payments entered as expenses` : "none"} tone={asCost.length ? "text-down" : "text-up"} />
        {(() => {
          const eobi = statutoryRateOn(rates, "eobi", new Date().toISOString());
          return (
            <Tile label="EOBI per head" value={eobi ? `PKR ${fmt(eobi.employee_amount + eobi.employer_amount)}` : "Not set"}
              sub={eobi ? `${fmt(eobi.employee_amount)} employee · ${fmt(eobi.employer_amount)} employer · from ${monthLabel(eobi.effective_from)}` : "payroll cannot make a payslip with EOBI until it is"}
              tone={eobi ? "" : "text-down"} />
          );
        })()}
      </div>

      {asCost.length > 0 && (
        <section className="rounded-2xl border border-down/40 bg-danger-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-down/30 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-danger-700 dark:text-danger-500 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-danger-700 dark:text-danger-500">Paid, but entered as ordinary expenses</h3>
              <p className="text-xs text-muted-foreground">
                These went to cost instead of settling what payroll withheld — so the month still reads as owed here, and the employee share is counted as cost twice.
                From October&rsquo;s payroll on, pay EOBI and salary tax with &ldquo;Pay&rdquo; on this tab, not as an expense.
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

      <PerHeadRates companyId={companyId} rates={rates} canEdit={canPay} canClassify={canClassify} onChanged={() => void load()} />

      <SalesTaxReturns companyId={companyId} banks={banks} canEdit={canPay} canClassify={canClassify} />

      <IncomeTaxDeducted companyId={companyId} refreshKey={refreshKey} />

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
 * PER-HEAD RATES AND WHO BEARS EOBI (0551, DECIDED 2026-10-22). One dated rate
 * per scheme for the company — EOBI went 370, 400, 407 — changed only from a
 * payroll month on, with a reason. Each client is marked once: its guards'
 * share deducted, the company absorbing all of it, or no EOBI. Payroll applies
 * it from the month on its own.
 */
function PerHeadRates({ companyId, rates, canEdit, canClassify, onChanged }: {
  companyId: string | null; rates: StatutoryRate[]; canEdit: boolean; canClassify: boolean; onChanged: () => void;
}) {
  type Cl = { id: string; name: string; eobi_bearer: "employee" | "company" | null };
  const [clients, setClients] = useState<Cl[]>([]);
  const [show, setShow] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const thisMonth = () => { const d = new Date(); d.setMonth(d.getMonth() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const [f, setF] = useState<{ scheme: "eobi" | "pessi" | "iessi"; emp: string; er: string; from: string; reason: string }>({ scheme: "eobi", emp: "", er: "", from: thisMonth(), reason: "" });

  const loadClients = useCallback(async () => {
    if (!companyId) return;
    const { data, error } = await supabase.from("clients").select("id, name, eobi_bearer").eq("company_id", companyId).order("name");
    if (!error) setClients((data ?? []) as Cl[]);
  }, [companyId]);
  useEffect(() => { void loadClients(); }, [loadClients]);

  const setBearer = async (id: string, v: string) => {
    setBusy(true); setErr(null);
    const { error } = await supabase.from("clients").update({ eobi_bearer: v || null }).eq("id", id);
    setBusy(false);
    if (error) setErr(friendlyDbError(error)); else void loadClients();
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
  const bearers = clients.filter((c) => c.eobi_bearer);

  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground mr-2">Per-head rates</h3>
        {(["eobi", "pessi", "iessi"] as const).map((sc) => {
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
            onClick={() => { setErr(null); setF({ scheme: "eobi", emp: "", er: "", from: thisMonth(), reason: "" }); setOpen(true); }}>Change a rate</button>
        )}
        <button type="button" className="ml-auto text-xs text-brand-700 dark:text-brand-500 hover:underline font-medium" onClick={() => setShow((v) => !v)}>
          EOBI clients · {bearers.length} of {clients.length}
        </button>
      </div>
      {err && !open && <p className="px-4 pb-2 text-sm text-danger-700 dark:text-danger-500">{err}</p>}
      {show && (
        <div className="px-4 py-3 border-t border-border">
          <p className="text-xs text-muted-foreground mb-2">
            Set once per client. &ldquo;Guard&rsquo;s share deducted&rdquo;: payroll withholds the employee share from every guard there and the company pays the employer share.
            &ldquo;Company absorbs&rdquo;: nothing is withheld and the company pays the whole amount. Applies from the next payroll made.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5">
            {clients.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-sm min-w-0">
                <span className={`flex-1 min-w-0 truncate ${c.eobi_bearer ? "text-foreground" : "text-muted-foreground"}`}>{c.name}</span>
                <div className="w-44 flex-shrink-0">
                  <ThemedSelect value={c.eobi_bearer ?? ""} disabled={!canClassify || busy} aria-label={`EOBI for ${c.name}`} onChange={(e) => void setBearer(c.id, e.target.value)}>
                    <option value="">No EOBI</option>
                    <option value="employee">Guard&rsquo;s share deducted</option>
                    <option value="company">Company absorbs</option>
                  </ThemedSelect>
                </div>
              </div>
            ))}
          </div>
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
            <option value="eobi">EOBI</option>
            <option value="pessi">PESSI</option>
            <option value="iessi">IESSI</option>
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
