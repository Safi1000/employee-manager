import { useEffect, useMemo, useState } from "react";
import { Banknote, Download, FileText, Loader2, MessageCircle } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import { supabase, friendlyDbError } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useRegion } from "../lib/region";
import { guardDisplayCode } from "../lib/guardCode";
import { brandingFromCompany } from "../lib/pdfBranding";
import { generatePayslipPdf } from "../lib/payslipPdf";
import { saveText } from "../lib/saveFile";

/**
 * PAYING OUT (3 Nov 2026 audit). Two things the payroll had no way to do:
 *   - a bank transfer file: every bank payee still to be paid this month, with
 *     IBAN and amount, so transfers are uploaded once instead of keyed one by
 *     one into the bank portal;
 *   - each guard's payslip — the PDF existed but only office staff with a login
 *     could reach their own; now it can be downloaded or sent on WhatsApp.
 * Reads payslips and the guard's bank details; writes nothing.
 */
type Slip = {
  id: string; employee_id: string; present_days: number; absent_days: number; leave_days: number; base_salary: number; bonus: number;
  advance: number; deductions: number; net_salary: number; amount_paid: number | null; disbursed: boolean; disbursed_at: string | null; payment_mode: string | null;
  employees: { full_name: string; employee_code: string | null; guard_code: string | null; phone: string | null; iban: string | null; bank_account: string | null; bank_name: string | null; account_title: string | null; cash_payment_flag: boolean | null; branch_id: string | null; display_number: number | null; clients: { employee_id_prefix: string | null } | null } | null;
};
/** The client code (EDI-001) people use; the permanent GGS code only when there is no client prefix. */
const codeOf = (s: Slip) => (s.employees ? guardDisplayCode(s.employees, s.employees.clients?.employee_id_prefix ?? null) : "");
const monthLabel = (p: string) => new Date(`${p.slice(0, 7)}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
const csv = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** Pakistani mobile → international form for wa.me (03xx… → 923xx…). */
const waNumber = (phone: string | null) => { const d = (phone ?? "").replace(/\D/g, ""); return d.startsWith("03") ? `92${d.slice(1)}` : d.startsWith("92") ? d : ""; };

export default function PayoutTools({ period }: { period: string }) {
  const { company } = useAuth();
  // The region chosen in the top bar, like every other payroll figure on the page.
  const { regionId } = useRegion();
  const [open, setOpen] = useState(false);
  const [slips, setSlips] = useState<Slip[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const month = `${period.slice(0, 7)}-01`;

  useEffect(() => {
    if (!open) return;
    setSlips(null);
    void supabase.from("payslips")
      .select("id, employee_id, present_days, absent_days, leave_days, base_salary, bonus, advance, deductions, net_salary, amount_paid, disbursed, disbursed_at, payment_mode, employees(full_name, employee_code, guard_code, phone, iban, bank_account, bank_name, account_title, cash_payment_flag, branch_id, display_number, clients(employee_id_prefix))")
      .eq("period_month", month).order("created_at")
      .then(({ data, error }) => {
        if (error) setErr(friendlyDbError(error));
        const all = (data ?? []) as unknown as Slip[];
        setSlips(regionId ? all.filter((s) => s.employees?.branch_id === regionId) : all);
      });
  }, [open, month, regionId]);

  const due = (s: Slip) => Math.max(0, Number(s.net_salary) - Number(s.amount_paid ?? 0));
  const bankPayees = useMemo(() => (slips ?? []).filter((s) => due(s) > 0.5 && !s.disbursed && !s.employees?.cash_payment_flag
    && (s.employees?.iban || s.employees?.bank_account) && !/cash/i.test(s.payment_mode ?? "")), [slips]);
  // Guards paid in cash by choice are not "missing" bank details.
  const noBank = (slips ?? []).filter((s) => due(s) > 0.5 && !s.disbursed && !s.employees?.cash_payment_flag && !/cash/i.test(s.payment_mode ?? "")
    && !s.employees?.iban && !s.employees?.bank_account).length;

  const bankFile = () => {
    const rows = [["Beneficiary name", "IBAN / account", "Bank", "Amount (PKR)", "Reference"]];
    for (const s of bankPayees) {
      const e = s.employees!;
      rows.push([e.account_title || e.full_name, e.iban || e.bank_account || "", e.bank_name ?? "", String(Math.round(due(s))),
        `Salary ${monthLabel(month)} ${codeOf(s)}`.trim()]);
    }
    void saveText(rows.map((r) => r.map(csv).join(",")).join("\n"), `Salary transfers ${monthLabel(month)}.csv`);
  };

  const payslip = (s: Slip) => generatePayslipPdf({
    branding: brandingFromCompany(company),
    company,
    monthLabel: monthLabel(month),
    employee: { full_name: s.employees?.full_name ?? "", code: codeOf(s), bank: s.employees?.bank_name ?? null },
    slip: {
      present_days: s.present_days, absent_days: s.absent_days, leave_days: s.leave_days, base_salary: Number(s.base_salary), bonus: Number(s.bonus ?? 0),
      advance: Number(s.advance ?? 0), deductions: Number(s.deductions ?? 0), net_salary: Number(s.net_salary), amount_paid: Number(s.amount_paid ?? 0),
      disbursed: s.disbursed, disbursed_at: s.disbursed_at, period_month: month,
    },
  });
  const waText = (s: Slip) => `${company?.name ?? ""} — salary ${monthLabel(month)} for ${s.employees?.full_name ?? ""}: ${s.present_days} days present, base PKR ${Math.round(Number(s.base_salary)).toLocaleString()}${Number(s.advance) ? `, advance −${Math.round(Number(s.advance)).toLocaleString()}` : ""}${Number(s.deductions) ? `, deductions −${Math.round(Number(s.deductions)).toLocaleString()}` : ""}. Net PKR ${Math.round(Number(s.net_salary)).toLocaleString()}${s.disbursed ? " — paid" : ""}.`;

  const shown = (slips ?? []).filter((s) => !q.trim() || `${s.employees?.full_name} ${s.employees?.guard_code ?? ""} ${codeOf(s)}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <Button variant="secondary" size="md" onClick={() => setOpen(true)}>
        <Banknote className="w-4 h-4 mr-2" strokeWidth={1.5} />Pay out
      </Button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title={`Pay out — ${monthLabel(month)}`} size="lg" error={err} onDismissError={() => setErr(null)}>
        {!slips ? <div className="py-10 text-center text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div> : (
          <div className="space-y-4 text-sm">
            <div className="rounded-xl border border-border p-3 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[200px]">
                <p className="font-medium text-foreground">Bank transfer file</p>
                <p className="text-xs text-muted-foreground">
                  {bankPayees.length} payee{bankPayees.length === 1 ? "" : "s"} still to pay by bank, PKR {Math.round(bankPayees.reduce((t, s) => t + due(s), 0)).toLocaleString()}.
                  {noBank ? ` ${noBank} unpaid have no bank details on file.` : ""} Check the column layout against your bank's upload format before uploading.
                </p>
              </div>
              <Button size="sm" onClick={bankFile} disabled={!bankPayees.length}><Download className="w-4 h-4 mr-1" />Download CSV</Button>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-2">
                <p className="font-medium text-foreground">Payslips ({slips.length})</p>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a guard" className="ml-auto px-3 py-1.5 rounded-lg border border-border bg-card text-sm" />
              </div>
              {slips.length === 0 ? <p className="text-muted-foreground italic">No payslips for this month yet — they appear once the run reaches Finance Verify.</p> : (
                <ul className="divide-y divide-border max-h-[50vh] overflow-y-auto">
                  {shown.map((s) => (
                    <li key={s.id} className="py-1.5 flex items-center gap-2">
                      <span className="flex-1 min-w-0 truncate text-foreground">{s.employees?.full_name}<span className="text-xs text-muted-foreground"> · {codeOf(s)}</span></span>
                      <span className="font-ledger text-xs">{Math.round(Number(s.net_salary)).toLocaleString()}{s.disbursed ? " ✓" : ""}</span>
                      <button type="button" onClick={() => payslip(s)} className="p-1 rounded hover:bg-muted" title="Payslip PDF"><FileText className="w-4 h-4" /></button>
                      {waNumber(s.employees?.phone ?? null)
                        ? <a href={`https://wa.me/${waNumber(s.employees?.phone ?? null)}?text=${encodeURIComponent(waText(s))}`} target="_blank" rel="noreferrer" className="p-1 rounded hover:bg-muted" title="Send on WhatsApp"><MessageCircle className="w-4 h-4" /></a>
                        : <span className="p-1 text-muted-foreground/40" title="No mobile number on file"><MessageCircle className="w-4 h-4" /></span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
