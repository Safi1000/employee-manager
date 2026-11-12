import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import { askReason } from "./askReason";
import { supabase, friendlyDbError } from "../lib/supabase";
import { useAuth, hasPermission } from "../lib/auth";
import { PK_BANKS, isPkWallet, validateWalletAccount } from "../lib/validation";
import { formatDate } from "../lib/date";
import { FormField, Hint, ModalFooter } from "../pages/super-admin/_assetsKit";

/**
 * 0663: a guard's salary paid to someone else — standing until ended. Asked by
 * Shayan, 12 Nov 2026: a guard with no online banking, or who asks for it, has
 * his pay sent to another guard or person (anyone). DECIDED: never grouped —
 * each payslip stays its own transfer to the receiver's account, and the
 * release screen marks every such row before anyone releases it.
 */
type Payee = { id: string; payee_name: string; bank_name: string; account_no: string | null; iban: string | null; reason: string; set_at: string };

export default function SalaryPaidTo({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const { profile } = useAuth();
  const canEdit = hasPermission(profile, "payroll.edit");
  const [row, setRow] = useState<Payee | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("salary_payees")
      .select("id, payee_name, bank_name, account_no, iban, reason, set_at")
      .eq("employee_id", employeeId).is("ended_at", null).maybeSingle();
    // Not applied yet, or no access: show nothing rather than an error.
    setRow(error ? null : (data as Payee | null));
    setLoaded(!error);
  }, [employeeId]);
  useEffect(() => { void load(); }, [load]);

  if (!loaded || (!row && !canEdit)) return null;

  const end = async () => {
    if (!row) return;
    const note = await askReason({
      title: "Stop paying someone else",
      subject: { title: employeeName, meta: `Paid to ${row.payee_name}` },
      message: `From the next payment, ${employeeName}'s salary goes to his own account again.`,
      label: "Why?",
      placeholder: "e.g. Opened his own Easypaisa account",
      confirmLabel: "Stop",
      minLength: 3,
    });
    if (!note) return;
    const { error } = await supabase.rpc("end_salary_payee", { p_salary_payee_id: row.id, p_note: note });
    if (error) { setErr(friendlyDbError(error)); return; }
    void load();
  };

  return (
    <div className={`rounded-xl border p-4 ${row ? "border-warning-200 bg-warning-50 dark:bg-warning-500/10" : "border-border"}`}>
      <div className="flex flex-wrap items-start gap-3">
        <ArrowRightLeft className={`w-4 h-4 mt-0.5 ${row ? "text-warning-700 dark:text-warning-500" : "text-muted-foreground"}`} />
        <div className="flex-1 min-w-0 text-sm">
          <p className="font-medium text-foreground">Salary paid to</p>
          {row ? (
            <>
              <p className="text-foreground mt-0.5">
                <span className="font-semibold">{row.payee_name}</span> · {row.bank_name} ·{" "}
                <span className="font-ledger">{row.iban ?? row.account_no}</span>
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">Since {formatDate(row.set_at)} — {row.reason}</p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground mt-0.5">His own account. Bank payments go to the details above.</p>
          )}
          {err && <p className="text-xs text-danger-700 dark:text-danger-500 mt-1">{err}</p>}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setErr(null); setEditing(true); }}>{row ? "Change" : "Pay to someone else"}</Button>
            {row && <Button size="sm" variant="secondary" onClick={() => void end()}>Stop</Button>}
          </div>
        )}
      </div>
      {editing && (
        <PaidToModal employeeId={employeeId} employeeName={employeeName} current={row}
          onClose={() => setEditing(false)} onDone={() => { setEditing(false); void load(); }} />
      )}
    </div>
  );
}

function PaidToModal({ employeeId, employeeName, current, onClose, onDone }: {
  employeeId: string; employeeName: string; current: Payee | null; onClose: () => void; onDone: () => void;
}) {
  const [name, setName] = useState(current?.payee_name ?? "");
  const [bank, setBank] = useState(current?.bank_name ?? "");
  const [account, setAccount] = useState(current?.account_no ?? "");
  const [iban, setIban] = useState(current?.iban ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wallet = isPkWallet(bank);
  const walletErr = wallet ? validateWalletAccount(account, bank) : null;
  const ready = name.trim() && bank && (account.trim() || (!wallet && iban.trim())) && reason.trim().length >= 5 && !walletErr;

  const submit = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("set_salary_payee", {
      p_employee_id: employeeId,
      p_payee_name: name.trim(),
      p_bank_name: bank,
      p_account_no: account.trim() || null,
      p_iban: wallet ? null : iban.trim() || null,
      p_reason: reason.trim(),
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    onDone();
  };

  const input = "w-full px-3 py-2 rounded-lg border border-border bg-background text-sm";
  return (
    <Modal isOpen onClose={onClose} title={`Pay ${employeeName}'s salary to someone else`} size="sm" error={err} onDismissError={() => setErr(null)}
      footer={
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !ready}>{busy ? "Saving…" : "Save"}</Button>
        </ModalFooter>
      }>
      <div className="space-y-4">
        <Hint tone="info">
          Each of his payments still goes as its own transfer, never combined with anyone else's. The bank file says
          "Salary of {employeeName}", and the release screen marks it as paid to someone else.
        </Hint>
        <FormField label="Paid to (name on the account)" required>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kashif Raza" />
        </FormField>
        <FormField label="Bank or wallet" required>
          <select className={input} value={bank} onChange={(e) => setBank(e.target.value)}>
            <option value="">Choose…</option>
            {PK_BANKS.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        </FormField>
        <FormField label={wallet ? "Mobile number" : "Account number"} required={wallet} hint={wallet ? "11 digits, 03XXXXXXXXX" : "Or give the IBAN below"}>
          <input className={`${input} font-ledger`} value={account} onChange={(e) => setAccount(e.target.value)} placeholder={wallet ? "03XXXXXXXXX" : ""} />
          {walletErr && <p className="text-xs text-danger-700 dark:text-danger-500 mt-1">{walletErr}</p>}
        </FormField>
        {!wallet && (
          <FormField label="IBAN" hint="Needed for a transfer to another bank">
            <input className={`${input} font-ledger uppercase`} value={iban} onChange={(e) => setIban(e.target.value)} placeholder="PK.." />
          </FormField>
        )}
        <FormField label="Why?" required hint="Kept with the record.">
          <input className={input} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. No online banking — asked for it to go to his cousin" />
        </FormField>
      </div>
    </Modal>
  );
}
