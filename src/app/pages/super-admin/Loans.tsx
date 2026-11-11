import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Split } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { useAuth, hasAnyPermission } from "../../lib/auth";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { loadBankOptions, type BankOption } from "../../lib/bankOptions";

/**
 * Finance ▸ Loans (0656). Asked by Shayan, 11 Nov 2026: loans to employees are
 * their own thing, not advances. A loan has an amount, a monthly instalment and
 * the month repayment starts; each payslip from then on takes the instalment
 * (Payroll deducts it after any advance, from what the pay can bear).
 *
 * Two ways in:
 *  - New loan — paid out of a bank now.
 *  - Split from an advance — part of an advance ALREADY paid was really a loan
 *    (Zamir, Nov 2026). The advance shrinks, the loan is created on the same
 *    bank, and no money moves.
 *
 * Cash loans are DEFERRED (the custodian float would not match); both functions
 * refuse them.
 */

type Loan = {
  id: string; employee_id: string; principal: number; instalment: number; first_month: string; issued_on: string;
  notes: string | null; converted_from_advance_id: string | null; bank_account_id: string;
  employees: { full_name: string; employee_code: string | null } | null;
};
type Emp = { id: string; full_name: string; employee_code: string | null };
type Adv = { id: string; employee_id: string; amount: number; advance_date: string; bank_account_id: string | null };

const pkr = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;
const monthLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" });
const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const nextMonthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 1).toLocaleDateString("en-CA"); };
const thisMonthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString("en-CA"); };
const today = () => new Date().toLocaleDateString("en-CA");

export default function Loans() {
  const { profile } = useAuth();
  const canEdit = hasAnyPermission(profile, ["payroll.edit"]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [repaid, setRepaid] = useState<Map<string, number>>(new Map());
  const [emps, setEmps] = useState<Emp[]>([]);
  const [banks, setBanks] = useState<BankOption[]>([]);
  const [advs, setAdvs] = useState<Adv[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<null | "new" | "split">(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ employeeId: "", amount: "", instalment: "", firstMonth: nextMonthStart(), issuedOn: today(), bankId: "", advanceId: "", notes: "" });

  const load = useCallback(async () => {
    setLoading(true);
    const [l, p, e] = await Promise.all([
      supabase.from("employee_loans").select("id, employee_id, principal, instalment, first_month, issued_on, notes, converted_from_advance_id, bank_account_id, employees(full_name, employee_code)").order("issued_on", { ascending: false }),
      supabase.from("payslips").select("employee_id, loan_recovery").gt("loan_recovery", 0),
      supabase.from("employees").select("id, full_name, employee_code").order("full_name"),
    ]);
    if (l.error) setErr(friendlyDbError(l.error));
    setLoans(((l.data ?? []) as any[]).map((x) => ({ ...x, principal: Number(x.principal), instalment: Number(x.instalment) })));
    const m = new Map<string, number>();
    ((p.data ?? []) as { employee_id: string; loan_recovery: number }[]).forEach((r) => m.set(r.employee_id, (m.get(r.employee_id) ?? 0) + Number(r.loan_recovery)));
    setRepaid(m);
    setEmps((e.data ?? []) as Emp[]);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!mode) return;
    void loadBankOptions(profile?.company_id ?? null, true).then(setBanks).catch(() => setBanks([]));
  }, [mode, profile?.company_id]);

  useEffect(() => {
    if (mode !== "split" || !form.employeeId) { setAdvs([]); return; }
    void supabase.from("advances").select("id, employee_id, amount, advance_date, bank_account_id")
      .eq("employee_id", form.employeeId).eq("payment_mode", "Bank").order("advance_date", { ascending: false }).limit(20)
      .then(({ data }) => setAdvs(((data ?? []) as any[]).map((a) => ({ ...a, amount: Number(a.amount) }))));
  }, [mode, form.employeeId]);

  // One row per employee: what was lent, what came back, what is left.
  const byEmployee = useMemo(() => {
    const g = new Map<string, { name: string; code: string | null; principal: number; instalment: number; loans: Loan[] }>();
    for (const l of loans) {
      const cur = g.get(l.employee_id) ?? { name: l.employees?.full_name ?? "—", code: l.employees?.employee_code ?? null, principal: 0, instalment: 0, loans: [] };
      cur.principal += l.principal;
      if (l.first_month <= thisMonthStart()) cur.instalment += l.instalment;
      cur.loans.push(l);
      g.set(l.employee_id, cur);
    }
    return [...g.entries()].map(([id, v]) => {
      const back = repaid.get(id) ?? 0;
      return { id, ...v, repaid: back, left: Math.max(0, v.principal - back) };
    }).sort((a, b) => b.left - a.left);
  }, [loans, repaid]);

  const totalLeft = byEmployee.reduce((n, r) => n + r.left, 0);

  const open = (m: "new" | "split") => {
    setErr(null);
    setForm({ employeeId: "", amount: "", instalment: "", firstMonth: m === "split" ? thisMonthStart() : nextMonthStart(), issuedOn: today(), bankId: "", advanceId: "", notes: "" });
    setMode(m);
  };

  const submit = async () => {
    const amount = Number(form.amount.replace(/,/g, ""));
    const instalment = Number(form.instalment.replace(/,/g, ""));
    if (!form.employeeId) return setErr("Choose the employee.");
    if (!(amount > 0)) return setErr("Enter the loan amount.");
    if (!(instalment > 0) || instalment > amount) return setErr("The monthly instalment must be above zero and no more than the loan.");
    setBusy(true); setErr(null);
    const { error } = mode === "split"
      ? await supabase.rpc("split_advance_into_loan", {
          p_advance_id: form.advanceId || null, p_loan_amount: amount, p_instalment: instalment,
          p_first_month: form.firstMonth, p_notes: form.notes || null,
        })
      : await supabase.rpc("issue_employee_loan", {
          p_employee_id: form.employeeId, p_principal: amount, p_instalment: instalment, p_first_month: form.firstMonth,
          p_issued_on: form.issuedOn, p_payment_mode: "Bank", p_bank_account_id: form.bankId || null, p_notes: form.notes || null,
        });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    setMode(null);
    await load();
  };

  const amountN = Number(form.amount.replace(/,/g, "")) || 0;
  const instN = Number(form.instalment.replace(/,/g, "")) || 0;
  const months = amountN > 0 && instN > 0 ? Math.ceil(amountN / instN) : 0;
  const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  const label = "block text-[11px] text-muted-foreground mb-1";
  const chosenAdv = advs.find((a) => a.id === form.advanceId);

  return (
    <>
      <Header title="Loans" subtitle="Loans to employees, repaid by monthly instalment from their payslips" />
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-sm text-foreground">Still to be repaid: <b className="font-ledger">{pkr(totalLeft)}</b></div>
          <div className="flex-1" />
          {canEdit && <>
            <Button variant="secondary" onClick={() => open("split")}><Split className="w-4 h-4 mr-1" />Split from an advance</Button>
            <Button onClick={() => open("new")}><Plus className="w-4 h-4 mr-1" />New loan</Button>
          </>}
        </div>

        {err && !mode && <div className="rounded-lg border border-danger-200 bg-danger-50 dark:bg-danger-500/10 p-3 text-sm text-danger-700 dark:text-danger-500">{err}</div>}

        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          {loading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : byEmployee.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No loans on record.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Employee</th>
                  <th className="px-3 py-2 text-left">Loans</th>
                  <th className="px-3 py-2 text-right">Lent</th>
                  <th className="px-3 py-2 text-right">Repaid</th>
                  <th className="px-3 py-2 text-right">Left</th>
                  <th className="px-3 py-2 text-right">Instalment</th>
                </tr>
              </thead>
              <tbody>
                {byEmployee.map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">{r.name}</div>
                      <div className="text-xs text-muted-foreground font-mono">{r.code ?? ""}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.loans.map((l) => (
                        <div key={l.id}>
                          {pkr(l.principal)} on {shortDate(l.issued_on)} · {pkr(l.instalment)}/month from {monthLabel(l.first_month)}
                          {l.converted_from_advance_id ? " · split from an advance" : ""}
                          {l.notes ? ` · ${l.notes}` : ""}
                        </div>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-right font-ledger">{pkr(r.principal)}</td>
                    <td className="px-3 py-2 text-right font-ledger">{pkr(r.repaid)}</td>
                    <td className="px-3 py-2 text-right font-ledger font-semibold">{pkr(r.left)}</td>
                    <td className="px-3 py-2 text-right font-ledger">{r.left > 0 ? pkr(Math.min(r.instalment || r.loans[r.loans.length - 1].instalment, r.left)) : "Repaid"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal isOpen={!!mode} onClose={() => setMode(null)} size="md" error={err} onDismissError={() => setErr(null)}
        title={mode === "split" ? "Split a loan out of an advance" : "New loan"}
        footer={<>
          <Button variant="secondary" onClick={() => setMode(null)}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : mode === "split" ? "Split it" : "Pay the loan"}</Button>
        </>}>
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {mode === "split"
              ? "Use this when part of an advance already paid was really a loan. The advance is reduced by the loan amount and the loan is recorded against the same bank. No money moves."
              : "The loan is paid from the bank now. From the first month chosen, each payslip takes the instalment until it is repaid."}
          </p>
          <div>
            <label className={label}>Employee *</label>
            <select className={field} value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value, advanceId: "" })}>
              <option value="">Choose…</option>
              {emps.map((e) => <option key={e.id} value={e.id}>{e.full_name}{e.employee_code ? ` (${e.employee_code})` : ""}</option>)}
            </select>
          </div>
          {mode === "split" && (
            <div>
              <label className={label}>Advance it came from *</label>
              <select className={field} value={form.advanceId} onChange={(e) => setForm({ ...form, advanceId: e.target.value })} disabled={!form.employeeId}>
                <option value="">{form.employeeId ? (advs.length ? "Choose…" : "No bank advances for this employee") : "Choose the employee first"}</option>
                {advs.map((a) => <option key={a.id} value={a.id}>{pkr(a.amount)} on {shortDate(a.advance_date)}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>{mode === "split" ? "Loan part of it *" : "Loan amount *"}</label>
              <input className={field} inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="60,000" />
            </div>
            <div>
              <label className={label}>Monthly instalment *</label>
              <input className={field} inputMode="decimal" value={form.instalment} onChange={(e) => setForm({ ...form, instalment: e.target.value })} placeholder="15,000" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>First instalment from the payslip of *</label>
              <input type="month" className={field} value={form.firstMonth.slice(0, 7)} onChange={(e) => setForm({ ...form, firstMonth: `${e.target.value}-01` })} />
            </div>
            {mode === "new" ? (
              <div>
                <label className={label}>Paid on</label>
                <input type="date" className={field} value={form.issuedOn} max={today()} onChange={(e) => setForm({ ...form, issuedOn: e.target.value })} />
              </div>
            ) : <div />}
          </div>
          {mode === "new" && (
            <div>
              <label className={label}>Paid from (bank) *</label>
              <select className={field} value={form.bankId} onChange={(e) => setForm({ ...form, bankId: e.target.value })}>
                <option value="">Choose…</option>
                {banks.filter((b) => b.active && (b.owner_type ?? "company") === "company").map((b) => <option key={b.id} value={b.id}>{b.bank_name} {b.account_number}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">Cash loans are not available yet.</p>
            </div>
          )}
          <div>
            <label className={label}>Note</label>
            <input className={field} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. family emergency" />
          </div>
          {months > 0 && (
            <div className="rounded-lg bg-muted/60 p-3 text-sm">
              {pkr(amountN)} repaid at {pkr(instN)} a month: {months} payslip{months === 1 ? "" : "s"}, starting {monthLabel(form.firstMonth)}.
              {mode === "split" && chosenAdv && amountN < chosenAdv.amount && <> The advance becomes {pkr(chosenAdv.amount - amountN)}.</>}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
