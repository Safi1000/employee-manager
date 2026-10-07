// The pieces Payroll, Reliever payroll and Payroll Run share: the loaded
// workspace (the web component's state) and the salary drawer.
import { FileDown, HandCoins, Lock, Save } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Checkbox, HStack, Input, Ledger, Section } from "../../components/ui";
import { useDB } from "../../data/store";
import { todayIso } from "../../data/api/core";
import {
  computeRows, downloadPayslipPdf, formatPeriod, friendlyError, loadPayrollBase, loadPayrollPeriod, PayrollBase, PayrollPeriod,
  PaymentMode, raiseAdjustment, RowState, saveLeaveOverride, saveRow, settlePayment, toggleStatus, chequeRemaining, empDisplay,
} from "../../data/api/payroll";
import { useAuth } from "../../lib/auth";
import { amountInWords, pkr } from "../../lib/format";
import { useRegion } from "../../lib/region";
import { useTheme } from "../../theme/ThemeProvider";

export const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Workspace = {
  base: PayrollBase | null;
  pd: PayrollPeriod | null;
  rows: RowState[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  updateEdit: (employeeId: string, patch: Partial<RowState>) => void;
  clearEdit: (employeeId: string) => void;
  companyId: string | null;
  canViewBanking: boolean;
};

/** loadAll + loadPeriodData + the rows memo. `enabled=false` defers the load (Payroll Run opens scopes on demand). */
export function usePayrollWorkspace(period: string, relieversOnly: boolean, enabled = true): Workspace {
  const { db, v } = useDB();
  const { can } = useAuth();
  const { regionId } = useRegion();
  const canViewBanking = can("banks.view");
  const companyId = db.company.id || null;
  const [base, setBase] = useState<PayrollBase | null>(null);
  const [pd, setPd] = useState<PayrollPeriod | null>(null);
  const [edits, setEdits] = useState<Map<string, Partial<RowState>>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const [b, p] = await Promise.all([loadPayrollBase(regionId, companyId, canViewBanking), loadPayrollPeriod(period, relieversOnly)]);
      setBase(b); setPd(p); setEdits(new Map()); setError(null);
    } catch (e) { setError(err(e)); }
    finally { setLoading(false); }
  }, [enabled, regionId, companyId, canViewBanking, period, relieversOnly]);
  useEffect(() => { const h = setTimeout(() => { void reload(); }, 0); return () => clearTimeout(h); }, [reload, v]);

  const rows = useMemo(() => (base && pd && pd.period === period ? computeRows(base, pd, edits) : []), [base, pd, edits, period]);
  const updateEdit = useCallback((id: string, patch: Partial<RowState>) => setEdits((prev) => { const n = new Map(prev); n.set(id, { ...(n.get(id) ?? {}), ...patch }); return n; }), []);
  const clearEdit = useCallback((id: string) => setEdits((prev) => { const n = new Map(prev); n.delete(id); return n; }), []);
  return { base, pd, rows, loading, error, reload, updateEdit, clearEdit, companyId, canViewBanking };
}

export type PanelMode = "full" | "afterNet" | "throughNet";

/**
 * The web's salary drawer. `full` is Reliever payroll (every control); `afterNet`
 * is Payroll Management for a Finance-Verified scope (Net + payment slice);
 * `throughNet` is the Payroll Run embed (through Net Salary, no payment).
 */
export function PayslipSheet({ ws, employeeId, mode, onClose, onChanged }: { ws: Workspace; employeeId: string | null; mode: PanelMode; onClose: () => void; onChanged?: () => void }) {
  const row = ws.rows.find((r) => r.employee.id === employeeId) ?? null;
  return (
    <Sheet full open={!!employeeId} onClose={onClose} title={row?.employee.full_name ?? "Payslip"}
      subtitle={row && ws.base ? `${empDisplay(ws.base, row.employee)} · ${formatPeriod(row.period_month)}` : undefined}>
      {row && ws.base && ws.pd ? <PayslipPanel ws={ws} row={row} mode={mode} onChanged={onChanged} /> : <T v="small" muted>Loading…</T>}
    </Sheet>
  );
}

export function PayslipPanel({ ws, row, mode, onChanged }: { ws: Workspace; row: RowState; mode: PanelMode; onChanged?: () => void }) {
  const t = useTheme();
  const { can } = useAuth();
  const { toast } = useOverlay();
  const base = ws.base!;
  const pd = ws.pd!;
  const id = row.employee.id;
  const afterNet = mode === "afterNet";
  const throughNet = mode === "throughNet";
  const locked = afterNet && row.disbursed;
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [payNowDraft, setPayNowDraft] = useState("");
  const [custodian, setCustodian] = useState("");
  const ov = pd.leaveOverrides.get(id);
  const [leaveDraft, setLeaveDraft] = useState(ov ? String(ov.allowed) : "");
  const [leaveReason, setLeaveReason] = useState(ov?.reason ?? "");
  const [dateOpen, setDateOpen] = useState(false);
  const [payDate, setPayDate] = useState(todayIso());
  const [adjOpen, setAdjOpen] = useState(false);
  // amount is the CHANGE only, unsigned; kind supplies the sign (fine deducts).
  const [adj, setAdj] = useState({ amount: "", kind: null as "increment" | "fine" | null, reason: "", settlement: "carry_forward" as "pay_now" | "carry_forward" });
  const [adjErr, setAdjErr] = useState<string | null>(null);
  const ls = pd.leaveSummary.get(id);
  const periodAdj = pd.periodAdj.get(id) ?? [];

  // The web clears the typed payment and custodian when the employee, month or
  // amount paid changes, so a figure typed for one guard never lingers on another.
  useEffect(() => { const h = setTimeout(() => { setPayNowDraft(""); setCustodian(""); }, 0); return () => clearTimeout(h); }, [id, row.period_month, row.amount_paid]);

  const done = async () => { await ws.reload(); onChanged?.(); };
  const edit = (patch: Partial<RowState>) => ws.updateEdit(id, patch);
  const num = (s: string) => Number(s.replace(/[^\d.-]/g, "")) || 0;

  const paidSoFar = Math.round(row.amount_paid || 0);
  const balance = Math.round(row.net_salary) - paidSoFar;
  const payNow = Math.round(Number(payNowDraft) || 0);
  const fullyPaid = paidSoFar >= Math.round(row.net_salary);

  const bankLabel = (b: any) => (ws.canViewBanking ? `${b.bank_name} · ${b.account_number} (PKR ${Number(b.balance).toLocaleString()})` : `${b.bank_name} · ${b.account_number}`);
  const custLabel = (c: { fullName: string; held: number }) => (ws.canViewBanking ? `${c.fullName} — holds PKR ${Math.round(c.held).toLocaleString()}` : c.fullName);

  const save = async () => {
    setBusy(true);
    try { await saveRow(row); ws.clearEdit(id); await done(); toast("Payslip saved"); }
    catch (e) { toast(err(e), "danger"); }
    finally { setBusy(false); }
  };
  const openDisburse = () => {
    if (payNow <= 0) { setRowError("Enter a Payment Amount greater than 0."); return; }
    if (payNow > balance + 0.5) { setRowError(`Payment Amount cannot exceed the Balance of PKR ${balance.toLocaleString()}.`); return; }
    if (row.payment_mode === "Cash" && !custodian) { setRowError("Select who is paying this cash (custodian)."); return; }
    setRowError(null); setPayDate(todayIso()); setDateOpen(true);
  };
  const disburse = async () => {
    setDateOpen(false);
    setBusy(true);
    const r = await settlePayment(base, ws.companyId, row, paidSoFar + payNow, custodian, payDate);
    setBusy(false);
    if (!r.ok) { setRowError(r.message); if (r.reload) await done(); return; }
    await done();
    toast(`PKR ${payNow.toLocaleString()} disbursed`);
  };

  return (
    <View>
      {row.days_over_month > 0 && (
        <Banner tone="warning" title={`Attendance totalled ${row.days_over_month} day${row.days_over_month === 1 ? "" : "s"} more than the ${row.working_days} in ${formatPeriod(row.period_month)}`}
          sub="Some date carries two statuses. Trimmed from leave/absent so pay matches the month; fix it on the attendance board." />
      )}

      {!afterNet && (
        <Section title="Attendance">
          <Card>
            <Ledger label="Working days" value={String(row.working_days)} />
            <Ledger label="Present" value={String(row.present_days)} />
            {row.double_duty_shifts > 0 && <Ledger label="Double duty (extra shifts)" value={String(row.double_duty_shifts)} />}
            <Ledger label="Absent" value={String(row.absent_days)} />
            <Ledger label="Leave" value={String(row.leave_days)} />
          </Card>
        </Section>
      )}

      {!afterNet && (
        <Section title="Salary">
          <Card>
            <Ledger label="Base salary" value={pkr(row.base_salary)} sub="Set on Assignments & Pay — salary is effective-dated" />
            <Ledger label="Per day (display)" value={row.per_day_salary != null ? pkr(row.per_day_salary) : "—"} />
            <View style={{ height: 10 }} />
            <HStack>
              <Input style={{ flex: 1 }} label="Bonus" keyboardType="numeric" editable={!locked} value={String(row.bonus)} onChangeText={(s) => edit({ bonus: num(s) })} />
              <Input style={{ flex: 1 }} label="Deductions" keyboardType="numeric" editable={!locked} value={String(row.deductions)} onChangeText={(s) => edit({ deductions: num(s) })} />
            </HStack>
            <Ledger label="Advance (from Expenses · Advances)" value={pkr(row.advance)} />
          </Card>
        </Section>
      )}

      {!afterNet && (
        <Section title="Leave">
          <Card>
            <Ledger label="Allowed leaves" value={`${row.allowed_leaves}${ov ? " · overridden" : ""}`} />
            {ls && (
              <View style={{ marginVertical: 6, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: t.border }}>
                <Ledger label="Opening balance" value={String(ls.opening)} />
                <Ledger label={`Earned · ${ls.present_days} days present → tier ${ls.tier} of quota ${ls.quota}`} value={`+${ls.earned}`} />
                {ls.lost > 0 && <Ledger label="Lost at the 15-day cap" value={`−${ls.lost}`} tone="danger" />}
                <Ledger label="Taken this period (leave marks)" value={`−${ls.taken}`} />
                {ls.unpaid > 0 && <Ledger label="Unpaid leave — beyond the balance" value={String(ls.unpaid)} />}
                <Ledger label="Closing balance" value={String(ls.closing)} strong />
              </View>
            )}
            <T v="smallStrong" soft style={{ marginTop: 8 }}>Override allowed leaves · {formatPeriod(row.period_month)} only</T>
            <HStack>
              <Input style={{ flex: 1 }} keyboardType="numeric" value={leaveDraft} placeholder={String(ov?.allowed ?? row.allowed_leaves)} onChangeText={setLeaveDraft} />
              <Input style={{ flex: 2 }} value={leaveReason} placeholder="Reason (optional)" onChangeText={setLeaveReason} />
            </HStack>
            <HStack>
              <Button size="sm" variant="secondary" label="Apply" loading={busy} onPress={async () => {
                setBusy(true);
                try { await saveLeaveOverride(id, row.period_month, leaveDraft, leaveReason); await done(); toast("Leave allowance saved"); } catch (e) { toast(friendlyError(e), "danger"); }
                finally { setBusy(false); }
              }} />
              {ov && <Button size="sm" variant="ghost" label="Remove override" disabled={busy} onPress={async () => {
                setLeaveDraft(""); setLeaveReason(""); setBusy(true);
                try { await saveLeaveOverride(id, row.period_month, "", ""); await done(); toast("Override removed"); } catch (e) { toast(friendlyError(e), "danger"); }
                finally { setBusy(false); }
              }} />}
            </HStack>
            <T v="small" muted>{ov?.reason ? `Reason: ${ov.reason}` : "Applies to this employee for this month only. Blank = follow the contract."}</T>
            <View style={{ height: 10 }} />
            <Ledger label="Leaves taken" value={String(row.leave_days)} />
            {!row.override_leaves && row.extra_leave_absent > 0 && <Ledger label="Absent due to extra leaves" value={`+${row.extra_leave_absent}`} tone="danger" />}
            <Ledger label="Effective paid days" value={`${row.effective_present_days} / ${row.working_days}`} strong />
            <Checkbox value={row.override_leaves} onChange={(v) => edit({ override_leaves: v })} label="Allow full payment despite extra leaves" sub={row.override_leaves ? "Override on — all leaves paid. Tap Save." : undefined} />
          </Card>
        </Section>
      )}

      <Section title="Net">
        <Card>
          {!afterNet && (
            <>
              <Input label="Allowance (+ PKR)" keyboardType="numeric" value={String(row.allowance)} onChangeText={(s) => edit({ allowance: Math.max(0, num(s)) })} />
              <Ledger label="Final salary (incl. allowance)" value={pkr(row.final_salary)} />
              {row.income_tax > 0 && <Ledger label="Income tax (1% over 50K)" value={`− ${pkr(row.income_tax)}`} tone="danger" />}
              {row.eobi > 0 && <Ledger label="EOBI" value={`− ${pkr(row.eobi)}`} tone="danger" />}
              <Ledger label="Advance" value={`− ${pkr(row.advance)}`} tone="danger" />
            </>
          )}
          {row.adjustment_carried !== 0 && (
            <Ledger label="Adjustment carried" sub={row.adjustment_detail ?? "from an earlier period"}
              value={`${row.adjustment_carried > 0 ? "+" : "−"} ${pkr(Math.abs(row.adjustment_carried))}`} tone={row.adjustment_carried > 0 ? "success" : "danger"} />
          )}
          <Ledger label="Net salary" value={pkr(row.net_salary)} strong top />
          <T v="small" muted style={{ textAlign: "right" }}>{amountInWords(row.net_salary)}</T>
        </Card>
      </Section>

      {!throughNet && (
        <Section title="Payment">
          <Card>
            <Ledger label="Amount paid (so far)" value={pkr(paidSoFar)} />
            <Ledger label="Balance (Net − Paid)" value={pkr(balance)} tone={balance > 0 ? "warning" : balance < 0 ? "danger" : "success"} />
            {row.amount_paid > 0 && balance !== 0 && (
              <T v="small" color={t.tone(balance > 0 ? "warning" : "danger").text} style={{ marginVertical: 6 }}>
                {balance > 0
                  ? `PKR ${balance.toLocaleString()} still owed — PKR ${paidSoFar.toLocaleString()} paid but Net is now higher. Pay the balance below.`
                  : `PKR ${Math.abs(balance).toLocaleString()} overpaid — PKR ${paidSoFar.toLocaleString()} paid but Net dropped. Save to carry it to next month as an advance.`}
              </T>
            )}
            {balance > 0 && (
              <>
                <Input label="Payment amount (pay now)" amount keyboardType="numeric" value={payNowDraft} placeholder={`0 — up to ${balance.toLocaleString()}`}
                  onChangeText={(s) => setPayNowDraft(s.replace(/[^\d.]/g, ""))}
                  error={payNow > Math.max(0, balance) + 0.5 ? `Payment Amount cannot exceed the Balance of PKR ${balance.toLocaleString()}.` : undefined} />
                <T v="smallStrong" color={t.tone("brand").text} onPress={() => setPayNowDraft(String(balance))}>Pay full balance</T>
              </>
            )}
          </Card>
        </Section>
      )}

      {!throughNet && (
        <Section title="Note & adjustments">
          <Card>
            <Input multiline label="Note" value={row.notes ?? ""} placeholder="Disputed, awaiting site confirmation…" onChangeText={(s) => edit({ notes: s || null })} />
            {periodAdj.map((a) => (
              <Ledger key={a.id} label={`${a.reason} · ${a.settlement === "pay_now" ? "pay now" : "next payslip"} · ${a.status}`} value={`${a.amount > 0 ? "+" : ""}${a.amount.toLocaleString()}`} tone={a.amount < 0 ? "danger" : "success"} />
            ))}
            {can("payroll.adjust") && row.payslip_id && (
              <Button size="sm" variant="secondary" label="Raise adjustment" style={{ marginTop: 8 }} onPress={() => { setAdj({ amount: "", kind: null, reason: "", settlement: "carry_forward" }); setAdjErr(null); setAdjOpen(true); }} />
            )}
          </Card>
        </Section>
      )}

      {!throughNet && (
        <Section title="Paid by">
          <Card>
            {locked && <Banner tone="success" title="Disbursed — this payslip is paid and locked." sub="Salary and payment details can no longer be changed." />}
            <Select label="Payment mode" value={row.payment_mode} onChange={(m) => !locked && edit({ payment_mode: m as PaymentMode, cheque_id: null })}
              options={["Cash", "Bank", "Cheque"].map((m) => ({ value: m, label: m }))} />
            {row.payment_mode === "Cash" && (
              <Select label="Paid by (custodian)" required searchable value={custodian} onChange={(x) => !locked && setCustodian(x)} placeholder="Select who is paying this cash…"
                options={base.custodians.map((c) => ({ value: c.employeeId, label: custLabel(c) }))} />
            )}
            {row.payment_mode === "Bank" && (
              <Select label="Bank account" value={row.bank_account_id ?? ""} onChange={(x) => !locked && edit({ bank_account_id: x || null })} placeholder="Select bank account"
                options={base.banks.map((b) => ({ value: b.id, label: bankLabel(b) }))} />
            )}
            {row.payment_mode === "Cheque" && (
              <>
                <Select label="Cheque" value={row.cheque_id ?? ""} placeholder="Select a pending cheque" onChange={(x) => {
                  if (locked) return;
                  const chq = base.cheques.find((c) => c.id === x);
                  edit({ cheque_id: x || null, bank_account_id: chq?.bank_account_id ?? null });
                }} options={base.cheques.filter((c) => c.status === "pending" || c.id === row.cheque_id).map((c) => {
                  const bank = base.banks.find((b) => b.id === c.bank_account_id);
                  const remaining = chequeRemaining(base, c.id, row.cheque_id === c.id ? row.net_salary : 0);
                  return { value: c.id, label: `#${c.cheque_number} · ${bank?.bank_name ?? "Bank"} · PKR ${Number(c.amount).toLocaleString()}`, sub: `remaining PKR ${remaining.toLocaleString()} · ${c.status}` };
                })} />
                <T v="small" muted>Cashflow recognises this salary only after the cheque is marked Cleared in Bank Accounts → Cheques.</T>
              </>
            )}
          </Card>
        </Section>
      )}

      {rowError && <Banner tone="danger" title={rowError} />}

      <View style={{ gap: 8, marginTop: 12 }}>
        {!throughNet && can("payroll.edit") && (
          <HStack>
            {!afterNet && (
              <Button style={{ flex: 1 }} variant={row.status === "Cleared" ? "secondary" : "primary"} label={row.status === "Cleared" ? "Mark Pending" : "Mark Cleared"} disabled={busy}
                onPress={async () => { setBusy(true); try { await toggleStatus(row); await done(); } catch (e) { toast(err(e), "danger"); } finally { setBusy(false); } }} />
            )}
            <Button style={{ flex: 1 }} icon={fullyPaid ? Lock : HandCoins} loading={busy} disabled={fullyPaid}
              label={fullyPaid ? "Disbursed" : row.amount_paid > 0 ? "Pay balance" : "Disburse"} onPress={openDisburse} />
          </HStack>
        )}
        <HStack>
          {can("payroll.edit") && <Button style={{ flex: 1 }} variant="secondary" icon={Save} label={busy ? "Saving…" : "Save"} disabled={busy || locked} onPress={save} />}
          {!throughNet && <Button style={{ flex: 1 }} icon={FileDown} label="Payslip PDF" onPress={async () => {
            // openPayslipModal saves the row first, then the slip is drawn from it.
            try { if (can("payroll.edit")) { await saveRow(row).catch(() => undefined); } await downloadPayslipPdf(base, pd, row); } catch (e) { toast(err(e), "danger"); }
          }} />}
        </HStack>
        {row.status && <Badge label={row.disbursed ? "Disbursed" : row.status} tone={row.disbursed ? "success" : row.status === "Cleared" ? "info" : "warning"} small />}
      </View>

      <Sheet open={dateOpen} onClose={() => setDateOpen(false)} title={`Disburse PKR ${payNow.toLocaleString()}`} subtitle={row.employee.full_name}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setDateOpen(false)} /><Button label="Disburse" full onPress={disburse} /></>}>
        <Input label="Disbursement date" value={payDate} onChangeText={setPayDate} placeholder="YYYY-MM-DD" />
        <Ledger label="Mode" value={row.payment_mode} />
        <Ledger label="Amount" value={pkr(payNow)} strong />
      </Sheet>

      <Sheet open={adjOpen} onClose={() => setAdjOpen(false)} title={`Raise adjustment — ${row.employee.full_name}`} error={adjErr}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setAdjOpen(false)} /><Button label="Raise" full disabled={!adj.kind || !Number(adj.amount) || !adj.reason.trim()} onPress={async () => {
          setAdjErr(null);
          try { await raiseAdjustment(row.payslip_id!, String((adj.kind === "fine" ? -1 : 1) * Math.abs(Number(adj.amount))), adj.reason, adj.settlement); setAdjOpen(false); await done(); toast("Adjustment raised"); }
          catch (e) { setAdjErr(err(e)); }
        }} /></>}>
        <HStack gap={16}>
          <Checkbox value={adj.kind === "increment"} onChange={(v) => setAdj({ ...adj, kind: v ? "increment" : null })} label="Increment" />
          <Checkbox value={adj.kind === "fine"} onChange={(v) => setAdj({ ...adj, kind: v ? "fine" : null })} label="Fine" />
        </HStack>
        <Input label={`${adj.kind === "fine" ? "Fine" : adj.kind === "increment" ? "Increment" : ""} amount — only the amount ${adj.kind === "fine" ? "deducted" : "added"}, not the new total`.trim()} keyboardType="numeric" value={adj.amount} onChangeText={(s) => setAdj({ ...adj, amount: s.replace(/-/g, "") })} />
        <Input label="Reason" required multiline value={adj.reason} onChangeText={(s) => setAdj({ ...adj, reason: s })} />
        <Select label="Settlement" value={adj.settlement} onChange={(s) => setAdj({ ...adj, settlement: s as "pay_now" | "carry_forward" })}
          options={[{ value: "carry_forward", label: "Next payslip" }, { value: "pay_now", label: "Pay now (settled from Adjustments)" }]} />
      </Sheet>
    </View>
  );
}

/** One roster row: name, code, attendance, net and state. */
export function RosterLine({ base, row, onPress, left, extra }: { base: PayrollBase; row: RowState; onPress: () => void; left?: React.ReactNode; extra?: React.ReactNode }) {
  const t = useTheme();
  const paid = Math.round(row.amount_paid || 0);
  return (
    <Card pad={12} onPress={onPress} style={{ marginBottom: 8 }} accent={row.disbursed ? "success" : paid > 0 ? "warning" : undefined}>
      <HStack>
        {left}
        <View style={{ flex: 1, minWidth: 0 }}>
          <T v="bodyStrong" numberOfLines={1}>{row.employee.full_name}</T>
          <T v="small" muted numberOfLines={1}>{empDisplay(base, row.employee)} · P{row.present_days} A{row.absent_days} L{row.leave_days}{row.double_duty_shifts ? ` DD${row.double_duty_shifts}` : ""}</T>
          {extra}
        </View>
        <View style={{ alignItems: "flex-end", gap: 3 }}>
          <T v="mono" style={{ fontSize: 14 }}>{pkr(row.net_salary)}</T>
          <Badge small label={row.disbursed ? "Disbursed" : paid > 0 ? `Paid ${pkr(paid, { compact: true })}` : row.status} tone={row.disbursed ? "success" : row.status === "Cleared" ? "info" : "warning"} />
        </View>
      </HStack>
      {row.days_over_month > 0 && <T v="small" color={t.tone("warning").text}>+{row.days_over_month} day(s) over the month</T>}
    </Card>
  );
}

/** Bulk disburse sheet (web isBulkDisburseOpen modal). */
export function BulkDisburseSheet({ ws, open, count, total, onClose, onSubmit }: {
  ws: Workspace; open: boolean; count: number; total: number; onClose: () => void;
  onSubmit: (o: { mode: PaymentMode; bankId: string; custodianEmpId: string; date: string }) => Promise<void>;
}) {
  const [mode, setMode] = useState<PaymentMode>("Cash");
  const [bankId, setBankId] = useState("");
  const [cust, setCust] = useState("");
  const [date, setDate] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const base = ws.base;
  return (
    <Sheet open={open} onClose={onClose} title="Bulk disburse" subtitle={`${count} payslip${count === 1 ? "" : "s"} · ${pkr(total)}`}
      footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button label="Disburse" full loading={busy} onPress={async () => {
        setBusy(true);
        try { await onSubmit({ mode, bankId, custodianEmpId: cust, date }); } finally { setBusy(false); }
      }} /></>}>
      <Ledger label="Total (remaining balances)" value={pkr(total)} strong />
      <View style={{ height: 12 }} />
      <Select label="Payment mode" value={mode} onChange={(m) => setMode(m as PaymentMode)} options={[{ value: "Cash", label: "Cash" }, { value: "Bank", label: "Bank" }]} />
      {mode === "Cash" && base && <Select label="Paid by (custodian)" required searchable value={cust} onChange={setCust}
        options={base.custodians.map((c) => ({ value: c.employeeId, label: ws.canViewBanking ? `${c.fullName} — holds PKR ${Math.round(c.held).toLocaleString()}` : c.fullName }))} />}
      {mode === "Bank" && base && <Select label="Bank account" required value={bankId} onChange={setBankId}
        options={base.banks.map((b) => ({ value: b.id, label: ws.canViewBanking ? `${b.bank_name} · ${b.account_number} (PKR ${Number(b.balance).toLocaleString()})` : `${b.bank_name} · ${b.account_number}` }))} />}
      <Input label="Disbursement date" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" />
    </Sheet>
  );
}
