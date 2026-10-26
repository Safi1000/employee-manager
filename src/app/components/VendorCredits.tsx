import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Copy, Loader2 } from "lucide-react";
import Button from "./Button";
import ThemedSelect from "./ThemedSelect";
import { supabase, type BankAccount } from "../lib/supabase";
import { ensureCustodianLocation, type CustodianOption } from "../lib/custodian";
import { formatDate } from "../lib/date";

/**
 * BILLS PAID TWICE (0562, 2026-10-26). Inside a vendor's Payables window.
 *
 *   Paid twice? — pick the vendor's paid bills that should never have existed.
 *     They come out of the books and the money paid on them becomes a credit
 *     with the vendor (mark_bills_duplicate). The bank or cash it left is not
 *     touched: that money really went.
 *   A credit is then settled by choice, never automatically:
 *     Refund received — the vendor hands it back, into a person's cash or a bank;
 *     Use against a bill — it pays (part of) one of his open bills.
 *   Either can be reverted. Accounts staff only (accounting.edit).
 */

type Bill = { id: string; description: string | null; amount: number; expense_date: string; payable_status: string | null };
type Credit = { id: string; amount: number; reason: string; bills: { description: string | null; amount: number }[]; created_at: string };
type Settlement = { id: string; credit_id: string; kind: "refund" | "applied"; amount: number; paid_via: string | null; bank_account_id: string | null; custodian_location_id: string | null; expense_id: string | null; settled_on: string };

const money = (n: number) => Math.round(Number(n || 0)).toLocaleString();

export default function VendorCredits({
  companyId, vendorId, bills, paidByVendorPayment, banks, custodians, canEdit, onChanged,
}: {
  companyId: string | null;
  vendorId: string;
  bills: Bill[];
  /** Bills cleared through vendor payments — the only ones that can be "paid twice". */
  paidByVendorPayment: Set<string>;
  banks: BankAccount[];
  custodians: CustodianOption[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [credits, setCredits] = useState<Credit[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [marking, setMarking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [settle, setSettle] = useState<{ creditId: string; mode: "refund" | "apply" } | null>(null);
  const [amount, setAmount] = useState("");
  const [via, setVia] = useState<"Cash" | "Bank">("Cash");
  const [personId, setPersonId] = useState("");
  const [bankId, setBankId] = useState("");
  const [billId, setBillId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: cs } = await supabase.from("vendor_credits").select("id, amount, reason, bills, created_at")
      .eq("vendor_id", vendorId).order("created_at", { ascending: false });
    const list = (cs ?? []) as Credit[];
    setCredits(list);
    if (list.length) {
      const { data: ss } = await supabase.from("vendor_credit_settlements").select("*").in("credit_id", list.map((c) => c.id)).order("created_at");
      setSettlements((ss ?? []) as Settlement[]);
    } else setSettlements([]);
  }, [vendorId]);
  useEffect(() => { void load(); }, [load]);

  const paidBills = bills.filter((b) => b.payable_status === "Paid" && paidByVendorPayment.has(b.id));
  const openBills = bills.filter((b) => b.payable_status !== "Paid");
  const remainingOf = (c: Credit) => Number(c.amount) - settlements.filter((s) => s.credit_id === c.id).reduce((n, s) => n + Number(s.amount), 0);

  const run = async (fn: () => Promise<{ error: { message: string } | null }>) => {
    setBusy(true); setErr(null);
    const { error } = await fn();
    setBusy(false);
    if (error) { setErr(error.message); return false; }
    await load(); onChanged();
    return true;
  };

  const markDuplicate = async () => {
    const total = paidBills.filter((b) => picked.has(b.id)).reduce((n, b) => n + Number(b.amount), 0);
    if (!window.confirm(`Mark ${picked.size} bill${picked.size === 1 ? "" : "s"} (PKR ${money(total)}) as paid twice?\n\nThey come out of the books and PKR ${money(total)} becomes a credit with this vendor. The bank or cash that paid them does not change.`)) return;
    if (await run(async () => supabase.rpc("mark_bills_duplicate", { p_expense_ids: [...picked], p_reason: reason }))) {
      setMarking(false); setPicked(new Set()); setReason("");
    }
  };

  const openSettle = (c: Credit, mode: "refund" | "apply") => {
    setSettle({ creditId: c.id, mode }); setAmount(String(remainingOf(c))); setVia("Cash"); setPersonId(""); setBankId(""); setBillId(""); setErr(null);
  };

  const doSettle = async () => {
    if (!settle) return;
    const amt = Number(amount);
    if (settle.mode === "refund") {
      let loc: string | null = null;
      if (via === "Cash") {
        const staff = custodians.find((c) => c.employeeId === personId);
        if (!staff || !companyId) { setErr("Choose who received the cash."); return; }
        loc = staff.locationId ?? await ensureCustodianLocation(companyId, staff.employeeId, staff.fullName);
      }
      if (await run(async () => supabase.rpc("refund_vendor_credit", {
        p_credit_id: settle.creditId, p_amount: amt, p_paid_via: via,
        p_bank_account_id: via === "Bank" ? bankId || null : null, p_custodian_location_id: loc,
      }))) setSettle(null);
    } else {
      if (await run(async () => supabase.rpc("apply_vendor_credit", { p_credit_id: settle.creditId, p_expense_id: billId, p_amount: amt })))
        setSettle(null);
    }
  };

  const revert = async (s: Settlement) => {
    if (!window.confirm(s.kind === "refund"
      ? `Revert this refund of PKR ${money(s.amount)}? The money comes back off where it was received, and the credit is owed again.`
      : `Revert using PKR ${money(s.amount)} of credit on that bill? The bill is owed again, and the credit returns.`)) return;
    await run(async () => supabase.rpc("revert_vendor_credit_settlement", { p_settlement_id: s.id }));
  };

  const whereLabel = (s: Settlement) => s.kind === "applied"
    ? `Used on ${bills.find((b) => b.id === s.expense_id)?.description ?? "a bill"}`
    : s.paid_via === "Bank"
      ? `Refund · Bank · ${banks.find((b) => b.id === s.bank_account_id)?.bank_name ?? "—"}`
      : `Refund · Cash · ${custodians.find((c) => c.locationId === s.custodian_location_id)?.fullName ?? "custodian"}`;

  if (!canEdit && credits.length === 0) return null;

  return (
    <div className="border-t border-border pt-3 space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium text-foreground">Paid twice / credit with this vendor</div>
        {canEdit && paidBills.length > 0 && !marking && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => { setMarking(true); setErr(null); }}>
            <Copy className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} /> Paid twice?
          </Button>
        )}
      </div>
      {err && <div className="text-sm text-danger-700 bg-danger-50 border border-danger-200 rounded-md px-3 py-2">{err}</div>}

      {marking && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Tick the bills that should never have been paid — for example, a bill already included in a later one.
            They come out of the books; what was paid on them becomes a credit with this vendor.
          </p>
          <ul className="divide-y divide-border max-h-56 overflow-y-auto">
            {paidBills.map((b) => (
              <li key={b.id}>
                <label className="flex items-center gap-2 py-1.5 text-sm cursor-pointer">
                  <input type="checkbox" checked={picked.has(b.id)} onChange={() => {
                    const n = new Set(picked); if (n.has(b.id)) n.delete(b.id); else n.add(b.id); setPicked(n);
                  }} />
                  <span className="flex-1 truncate">{b.description ?? "Bill"} <span className="text-xs text-muted-foreground">· {formatDate(b.expense_date)}</span></span>
                  <span className="font-ledger">PKR {money(b.amount)}</span>
                </label>
              </li>
            ))}
          </ul>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why — e.g. already inside the 4,050 bill for 1–21 Oct"
            className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={busy || picked.size === 0 || !reason.trim()} onClick={markDuplicate}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Mark as paid twice</>}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { setMarking(false); setPicked(new Set()); }}>Cancel</Button>
          </div>
        </div>
      )}

      {credits.map((c) => {
        const left = remainingOf(c);
        const mine = settlements.filter((s) => s.credit_id === c.id);
        return (
          <div key={c.id} className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0">
                <div className="text-sm text-foreground">
                  Credit PKR {money(c.amount)} <span className="text-xs text-muted-foreground">· {formatDate(c.created_at)}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {c.reason} · bills: {(c.bills ?? []).map((b) => `${b.description ?? "bill"} (${money(b.amount)})`).join(", ")}
                </div>
              </div>
              <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${left > 0 ? "bg-warning-50 text-warning-700" : "bg-success-50 text-success-700"}`}>
                {left > 0 ? `PKR ${money(left)} still owed by vendor` : "Settled"}
              </span>
            </div>
            {mine.length > 0 && (
              <ul className="divide-y divide-border text-sm">
                {mine.map((s) => (
                  <li key={s.id} className="py-1.5 flex items-center gap-2">
                    <span className="flex-1 text-muted-foreground">{formatDate(s.settled_on)} · {whereLabel(s)}</span>
                    <span className="font-ledger">PKR {money(s.amount)}</span>
                    {canEdit && (
                      <Button variant="ghost" size="sm" onClick={() => revert(s)}><RotateCcw className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />Revert</Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && left > 0 && settle?.creditId !== c.id && (
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => openSettle(c, "refund")}>Refund received</Button>
                <Button variant="ghost" size="sm" disabled={openBills.length === 0} onClick={() => openSettle(c, "apply")}
                  title={openBills.length === 0 ? "This vendor has no open bill" : undefined}>Use against a bill</Button>
              </div>
            )}
            {settle?.creditId === c.id && (
              <div className="grid gap-2 sm:grid-cols-3 items-end">
                <label className="text-xs text-muted-foreground">Amount
                  <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm" />
                </label>
                {settle.mode === "refund" ? (
                  <>
                    <label className="text-xs text-muted-foreground">Received in
                      <ThemedSelect value={via} onChange={(e) => setVia(e.target.value as "Cash" | "Bank")} className="mt-1 w-full">
                        <option value="Cash">Cash</option><option value="Bank">Bank</option>
                      </ThemedSelect>
                    </label>
                    {via === "Cash" ? (
                      <label className="text-xs text-muted-foreground">Received by
                        <ThemedSelect value={personId} onChange={(e) => setPersonId(e.target.value)} className="mt-1 w-full">
                          <option value="">Choose…</option>
                          {custodians.map((p) => <option key={p.employeeId} value={p.employeeId}>{p.fullName}</option>)}
                        </ThemedSelect>
                      </label>
                    ) : (
                      <label className="text-xs text-muted-foreground">Into
                        <ThemedSelect value={bankId} onChange={(e) => setBankId(e.target.value)} className="mt-1 w-full">
                          <option value="">Choose…</option>
                          {banks.map((b) => <option key={b.id} value={b.id}>{b.bank_name}</option>)}
                        </ThemedSelect>
                      </label>
                    )}
                  </>
                ) : (
                  <label className="text-xs text-muted-foreground sm:col-span-2">Bill
                    <ThemedSelect value={billId} onChange={(e) => setBillId(e.target.value)} className="mt-1 w-full">
                      <option value="">Choose…</option>
                      {openBills.map((b) => <option key={b.id} value={b.id}>{b.description ?? "Bill"} · {formatDate(b.expense_date)} · PKR {money(b.amount)}</option>)}
                    </ThemedSelect>
                  </label>
                )}
                <div className="sm:col-span-3 flex gap-2">
                  <Button variant="primary" size="sm" disabled={busy || !(Number(amount) > 0) || (settle.mode === "apply" && !billId)} onClick={doSettle}>
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : settle.mode === "refund" ? "Record refund" : "Use credit"}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setSettle(null)}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
