// ── Payroll adjustments: the record that a payslip was wrong ────────────────
//
// An adjustment sits BESIDE the payslip; it never rewrites it. The payslip is
// what was paid; the adjustment is that it was wrong, by how much, why, and how
// it was put right. Everything here reads payroll_adjustments and calls the
// three RPCs — nothing is computed or written from the browser.
//
// OPEN ADJUSTMENTS MUST BE VISIBLE BEFORE A PERIOD CLOSES. The accrual posts
// to the open period on the day it is raised (never to the payslip's own,
// closed or not), so an unsettled adjustment is money owed to a guard that
// quietly stops existing, so the open list leads and the ledger
// check no_adjustment_quietly_stops_existing watches the same rows nightly.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { loadCustodianOptions, ensureCustodianLocation, type CustodianOption } from "../../lib/custodian";
import { formatDate } from "../../lib/date";
import { type PayrollAdjustment, adjustmentSettlementLabel } from "../../components/PayrollAdjustmentHistory";

const FIELD = "w-full px-3 py-2 border border-border rounded-md text-sm bg-background";
const money = (n: unknown) => Number(n ?? 0).toLocaleString();
const monthLabel = (d: string) => new Date(d + "T00:00:00").toLocaleString("en", { month: "long", year: "numeric" });

type Row = PayrollAdjustment & { full_name: string; guard_code: string | null; settled_period: string | null };

export default function PayrollAdjustments() {
  const { profile, company } = useAuth();
  const canAdjust = hasPermission(profile, "payroll.adjust");

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSettled, setShowSettled] = useState(false);

  const [settling, setSettling] = useState<Row | null>(null);
  const [cancelling, setCancelling] = useState<Row | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [pay, setPay] = useState({ mode: "Cash", bank: "", custodian: "", date: new Date().toISOString().slice(0, 10) });
  const [banks, setBanks] = useState<{ id: string; bank_name: string; account_number: string }[]>([]);
  const [custodians, setCustodians] = useState<CustodianOption[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const [a, e, p] = await Promise.all([
      supabase.from("payroll_adjustments").select("*").order("original_period_month", { ascending: false }).order("raised_at", { ascending: false }),
      supabase.from("employees").select("id, full_name, guard_code"),
      supabase.from("payslips").select("id, period_month"),
    ]);
    if (a.error) setErr(a.error.message);
    const emp = new Map((e.data ?? []).map((x: any) => [x.id, x]));
    const ps = new Map((p.data ?? []).map((x: any) => [x.id, x.period_month]));
    setRows(((a.data ?? []) as any[]).map((x) => ({
      ...x,
      full_name: emp.get(x.employee_id)?.full_name ?? "—",
      guard_code: emp.get(x.employee_id)?.guard_code ?? null,
      settled_period: x.settled_payslip_id ? ps.get(x.settled_payslip_id) ?? null : null,
    })));
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!settling || !company?.id) return;
    supabase.from("bank_accounts").select("id, bank_name, account_number").eq("company_id", company.id)
      .then(({ data }) => setBanks((data ?? []) as any[]));
    loadCustodianOptions(company.id, false).then(setCustodians);
  }, [settling, company?.id]);

  const open = useMemo(() => rows.filter((r) => r.status === "open"), [rows]);
  const rest = useMemo(() => rows.filter((r) => r.status !== "open"), [rows]);
  // Guards who keep appearing — the site signal.
  const repeat = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of rows) if (r.status !== "cancelled") c.set(r.employee_id, (c.get(r.employee_id) ?? 0) + 1);
    return c;
  }, [rows]);

  const settle = async () => {
    if (!settling || !company?.id) return;
    setBusy(true); setErr(null);
    let custodianLoc: string | null = null;
    if (pay.mode === "Cash") {
      const c = custodians.find((x) => x.employeeId === pay.custodian);
      if (!c) { setBusy(false); setErr("Pick who is handing the cash over."); return; }
      custodianLoc = await ensureCustodianLocation(company.id, c.employeeId, c.fullName, c.kind);
    }
    const { error } = await supabase.rpc("settle_payroll_adjustment", {
      p_adjustment_id: settling.id,
      p_payment_mode: pay.mode,
      p_bank_account_id: pay.mode === "Bank" ? pay.bank || null : null,
      p_custodian_location_id: custodianLoc,
      p_paid_on: pay.date,
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setSettling(null);
    load();
  };

  const cancel = async () => {
    if (!cancelling) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("cancel_payroll_adjustment", { p_adjustment_id: cancelling.id, p_reason: cancelReason });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setCancelling(null); setCancelReason("");
    load();
  };

  const table = (list: Row[], emptyText: string) => (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-muted/40 border-b border-border">
          <tr>
            {["Guard", "Corrects", "Amount", "Reason", "Settles", "Raised", "Status", ""].map((h) => (
              <th key={h} className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {list.length === 0 && !loading && (
            <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyText}</td></tr>
          )}
          {list.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-2 text-sm">
                {r.full_name}
                {r.guard_code && <span className="text-muted-foreground font-mono text-xs"> {r.guard_code}</span>}
                {(repeat.get(r.employee_id) ?? 0) > 1 && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-warning-50 text-warning-700 border border-warning-200"
                        title="This guard has been corrected more than once — look at the site">
                    ×{repeat.get(r.employee_id)}
                  </span>
                )}
              </td>
              <td className="px-4 py-2 text-sm">{monthLabel(r.original_period_month)}</td>
              <td className={`px-4 py-2 text-sm tabular-nums ${Number(r.amount) < 0 ? "text-danger-700" : "text-success-700"}`}>
                {Number(r.amount) > 0 ? "+" : ""}{money(r.amount)}
              </td>
              <td className="px-4 py-2 text-sm text-muted-foreground">{r.reason}</td>
              <td className="px-4 py-2 text-sm">
                {adjustmentSettlementLabel(r)}
                {r.settled_period && <span className="text-muted-foreground"> · {monthLabel(r.settled_period)}</span>}
              </td>
              <td className="px-4 py-2 text-sm">{formatDate(r.raised_at)}</td>
              <td className="px-4 py-2 text-sm capitalize">
                {r.status}{r.status === "cancelled" && r.cancelled_reason ? ` — ${r.cancelled_reason}` : ""}
              </td>
              <td className="px-4 py-2 text-right whitespace-nowrap">
                {canAdjust && r.status === "open" && r.settlement === "pay_now" && (
                  <Button size="sm" disabled={busy} onClick={() => setSettling(r)}>
                    {Number(r.amount) > 0 ? "Pay" : "Receive"}
                  </Button>
                )}
                {canAdjust && r.status === "open" && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setCancelling(r)}>Cancel</Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <Header title="Adjustments" subtitle="What a payslip got wrong, and what was done about it" />
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-4 space-y-6">
        {err && <div className="p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">{err}</div>}
        {loading && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}

        <div className="bg-card border border-border rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-sm font-medium">Open</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Raised from a payslip on the Payslips tab. A pay-now adjustment settles here; one carried to
              the next payslip settles when that payslip is disbursed. An adjustment still open when its
              period closes is money that quietly stops existing — the nightly check watches for it.
            </p>
          </div>
          {table(open, "Nothing open. Every correction raised has been settled.")}
        </div>

        <div className="bg-card border border-border rounded-md overflow-hidden">
          <button type="button" className="w-full px-4 py-3 border-b border-border text-left flex items-center justify-between"
                  onClick={() => setShowSettled((v) => !v)}>
            <span className="text-sm font-medium">Settled and cancelled</span>
            <span className="text-xs text-muted-foreground">{rest.length} · {showSettled ? "hide" : "show"}</span>
          </button>
          {showSettled && table(rest, "None yet.")}
        </div>
      </div>

      {settling && (
        <Modal isOpen onClose={() => setSettling(null)}
               title={`${Number(settling.amount) > 0 ? "Pay" : "Receive"} PKR ${money(Math.abs(Number(settling.amount)))} — ${settling.full_name}`} size="sm">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Corrects {monthLabel(settling.original_period_month)}: {settling.reason}. The money moves through the
              ledger and the balance in one transaction.
            </p>
            <div>
              <label className="block text-sm mb-1">By</label>
              <ThemedSelect value={pay.mode} onChange={(e) => setPay({ ...pay, mode: e.target.value })}>
                <option value="Cash">Cash</option>
                <option value="Bank">Bank</option>
              </ThemedSelect>
            </div>
            {pay.mode === "Bank" ? (
              <div>
                <label className="block text-sm mb-1">Bank account</label>
                <ThemedSelect value={pay.bank} onChange={(e) => setPay({ ...pay, bank: e.target.value })}>
                  <option value="">Pick…</option>
                  {banks.map((b) => <option key={b.id} value={b.id}>{b.bank_name} — {b.account_number}</option>)}
                </ThemedSelect>
              </div>
            ) : (
              <div>
                <label className="block text-sm mb-1">{Number(settling.amount) > 0 ? "Who hands the cash over" : "Who receives the cash"}</label>
                <ThemedSelect value={pay.custodian} onChange={(e) => setPay({ ...pay, custodian: e.target.value })}>
                  <option value="">Pick…</option>
                  {custodians.map((c) => <option key={c.employeeId} value={c.employeeId}>{c.fullName}</option>)}
                </ThemedSelect>
              </div>
            )}
            <div>
              <label className="block text-sm mb-1">Date</label>
              <input className={FIELD} type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setSettling(null)}>Back</Button>
              <Button onClick={settle} disabled={busy || (pay.mode === "Bank" ? !pay.bank : !pay.custodian)}>
                {busy ? "Settling…" : "Settle"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {cancelling && (
        <Modal isOpen onClose={() => setCancelling(null)} title="Cancel adjustment" size="sm">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              The accrual reverses and the row stays, marked cancelled with this reason. Nothing is deleted.
            </p>
            <input className={FIELD} placeholder="Why" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCancelling(null)}>Back</Button>
              <Button onClick={cancel} disabled={busy || !cancelReason.trim()}>Cancel adjustment</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
