import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import ThemedSelect from "./ThemedSelect";
import { formatDate } from "../lib/date";
import { supabase, type Partner } from "../lib/supabase";

/** One client's contribution to a regional partner's share for the period. */
type BreakdownRow = {
  client_id: string;
  client_name: string;
  client_code: string;
  basis: string;
  client_net: number;
  share_percent: number;
  is_override: boolean;
  amount: number;
};

/** One line of the partner's running account. */
type LedgerRow = {
  entry_date: string;
  particulars: string;
  cash_paid: number;
  remuneration: number;
  balance: number;
  source: string;
  entry_id: string | null;
};

const money = (n: number) =>
  Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Accounting style: negatives in parentheses, as the paper ledger writes them. */
const acct = (n: number) => (n < 0 ? `(${money(Math.abs(n))})` : money(n));

const firstOfMonth = (p: string) => `${p}-01`;
const lastOfMonth = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return new Date(y, m, 0).toISOString().slice(0, 10);
};

export default function PartnerDetailModal({
  isOpen,
  partner,
  period,
  periodOptions,
  regionName,
  onClose,
  onChanged,
}: {
  isOpen: boolean;
  partner: Partner | null;
  /** YYYY-MM the report is showing. */
  period: string;
  periodOptions: string[];
  regionName: string | null;
  onClose: () => void;
  /** Something was written that the report behind should pick up. */
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"breakdown" | "ledger">("breakdown");
  const [breakdown, setBreakdown] = useState<BreakdownRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-client share editing
  const [editClientId, setEditClientId] = useState<string | null>(null);
  const [editPct, setEditPct] = useState("");
  const [saving, setSaving] = useState(false);

  // Ledger period + new cash entry
  const [ledgerFrom, setLedgerFrom] = useState(period);
  const [isAddEntryOpen, setIsAddEntryOpen] = useState(false);
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [entryMethod, setEntryMethod] = useState<"CASH" | "BANK_TRANSFER" | "FUEL_CARD" | "CHEQUE">("CASH");
  const [entryAmount, setEntryAmount] = useState("");
  const [entryNote, setEntryNote] = useState("");
  const [entryType, setEntryType] = useState<"DRAWING" | "CONTRIBUTION">("DRAWING");

  const isRegional = partner?.scope === "BRANCH";

  const loadBreakdown = useCallback(async () => {
    if (!partner || !isRegional) { setBreakdown([]); return; }
    const { data, error: e } = await supabase.rpc("partner_client_breakdown", {
      p_partner_id: partner.id,
      p_start: firstOfMonth(period),
      p_end: lastOfMonth(period),
    });
    if (e) { setError(e.message); return; }
    setBreakdown((data ?? []) as BreakdownRow[]);
  }, [partner, isRegional, period]);

  const loadLedger = useCallback(async () => {
    if (!partner) { setLedger([]); return; }
    const { data, error: e } = await supabase.rpc("partner_ledger", {
      p_partner_id: partner.id,
      p_start: firstOfMonth(ledgerFrom),
      p_end: lastOfMonth(period),
    });
    if (e) { setError(e.message); return; }
    setLedger((data ?? []) as LedgerRow[]);
  }, [partner, ledgerFrom, period]);

  useEffect(() => {
    if (!isOpen || !partner) return;
    setError(null);
    setTab(isRegional ? "breakdown" : "ledger");
    // Default the ledger to a year back, or the partner's own start.
    const [y, m] = period.split("-").map(Number);
    const back = new Date(y - 1, m - 1, 1);
    setLedgerFrom(`${back.getFullYear()}-${String(back.getMonth() + 1).padStart(2, "0")}`);
  }, [isOpen, partner, isRegional, period]);

  useEffect(() => {
    if (!isOpen || !partner) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([loadBreakdown(), loadLedger()]);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [isOpen, partner, loadBreakdown, loadLedger]);

  const totals = useMemo(() => {
    let net = 0, amount = 0;
    for (const r of breakdown) { net += Number(r.client_net); amount += Number(r.amount); }
    return { net, amount };
  }, [breakdown]);

  const saveClientShare = async (row: BreakdownRow) => {
    if (!partner) return;
    const pct = Number(editPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) { setError("Share must be between 0 and 100."); return; }
    setSaving(true);
    setError(null);
    const { error: e } = await supabase
      .from("partner_client_shares")
      .upsert(
        { partner_id: partner.id, client_id: row.client_id, share_percent: pct },
        { onConflict: "partner_id,client_id" },
      );
    setSaving(false);
    if (e) { setError(e.message); return; }
    setEditClientId(null);
    await loadBreakdown();
    onChanged();
  };

  /** Drop the override so this client falls back to the partner's headline %. */
  const clearClientShare = async (row: BreakdownRow) => {
    if (!partner) return;
    setSaving(true);
    const { error: e } = await supabase
      .from("partner_client_shares")
      .delete()
      .eq("partner_id", partner.id)
      .eq("client_id", row.client_id);
    setSaving(false);
    if (e) { setError(e.message); return; }
    await loadBreakdown();
    onChanged();
  };

  const addEntry = async () => {
    if (!partner) return;
    const amt = Number(entryAmount);
    if (!Number.isFinite(amt) || amt <= 0) { setError("Enter an amount above zero."); return; }
    setSaving(true);
    setError(null);
    const { error: e } = await supabase.from("partner_account_entries").insert({
      partner_id: partner.id,
      date: entryDate,
      type: entryType,
      description: entryNote.trim(),
      amount: amt,
      payment_method: entryMethod,
    });
    setSaving(false);
    if (e) { setError(e.message); return; }
    setIsAddEntryOpen(false);
    setEntryAmount("");
    setEntryNote("");
    await loadLedger();
    onChanged();
  };

  const deleteEntry = async (row: LedgerRow) => {
    if (!row.entry_id) return;
    if (!window.confirm("Delete this ledger entry?")) return;
    const { error: e } = await supabase.from("partner_account_entries").delete().eq("id", row.entry_id);
    if (e) { setError(e.message); return; }
    await loadLedger();
    onChanged();
  };

  if (!partner) return null;

  const basisLabel =
    partner.basis === "cash" ? "Net Cash (cash basis)"
      : partner.basis === "revenue" ? "Total Income (revenue basis)"
        : "Adjusted profit";

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={partner.name} size="lg">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`px-2 py-0.5 rounded ${isRegional ? "bg-amber-50 text-amber-700" : "bg-brand-50 text-brand-700"}`}>
            {isRegional ? `Regional · ${regionName ?? "no region"}` : "Equity"}
          </span>
          <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700">
            {Number(partner.profit_share_percent)}% share
          </span>
          {isRegional && (
            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700">of {basisLabel}</span>
          )}
        </div>

        <div className="flex gap-2">
          {(isRegional ? (["breakdown", "ledger"] as const) : (["ledger"] as const)).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-md text-sm transition-colors ${
                tab === t ? "bg-brand-600 text-[#fff]" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {t === "breakdown" ? "Client breakdown" : "Ledger"}
            </button>
          ))}
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        {loading && (
          <div className="py-10 text-center text-slate-500 text-sm">
            <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
          </div>
        )}

        {/* ── CLIENT BREAKDOWN ───────────────────────────────────────────── */}
        {!loading && tab === "breakdown" && (
          <div>
            <p className="text-xs text-slate-500 mb-2">
              What each client in {regionName ?? "this region"} contributes for {period}, on this
              partner's own basis. Set a share on a single client to override their headline
              {" "}{Number(partner.profit_share_percent)}% — that override feeds the real allocation,
              not just this view.
            </p>
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr className="text-xs text-slate-500 uppercase">
                    <th className="text-left px-3 py-2">Client</th>
                    <th className="text-right px-3 py-2">{partner.basis === "cash" ? "Net Cash" : "Total Income"}</th>
                    <th className="text-right px-3 py-2">Share</th>
                    <th className="text-right px-3 py-2">Amount</th>
                    <th className="text-right px-3 py-2">Edit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {breakdown.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                      No clients in this region for {period}.
                    </td></tr>
                  )}
                  {breakdown.map((r) => {
                    const editing = editClientId === r.client_id;
                    return (
                      <tr key={r.client_id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 text-slate-900">
                          {r.client_name}
                          <span className="text-xs text-slate-500 font-mono ml-2">{r.client_code}</span>
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${Number(r.client_net) < 0 ? "text-danger-600" : "text-slate-700"}`}>
                          {acct(Number(r.client_net))}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {editing ? (
                            <input
                              type="number"
                              step="0.001"
                              min="0"
                              max="100"
                              value={editPct}
                              onChange={(e) => setEditPct(e.target.value)}
                              className="w-20 px-2 py-1 border border-slate-200 rounded text-sm text-right"
                            />
                          ) : (
                            <span className={r.is_override ? "text-brand-700 font-medium" : "text-slate-600"}>
                              {Number(r.share_percent)}%
                              {r.is_override && <span className="block text-[10px] text-slate-500">override</span>}
                            </span>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${Number(r.amount) < 0 ? "text-danger-600" : "text-slate-900"}`}>
                          {acct(Number(r.amount))}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {editing ? (
                            <div className="flex gap-1 justify-end">
                              <Button variant="primary" size="sm" disabled={saving} onClick={() => saveClientShare(r)}>Save</Button>
                              <Button variant="ghost" size="sm" onClick={() => setEditClientId(null)}>Cancel</Button>
                            </div>
                          ) : (
                            <div className="flex gap-1 justify-end">
                              <button
                                onClick={() => { setEditClientId(r.client_id); setEditPct(String(r.share_percent)); }}
                                className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
                                title="Set a share just for this client"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              {r.is_override && (
                                <button
                                  onClick={() => clearClientShare(r)}
                                  className="p-1.5 rounded text-slate-500 hover:bg-slate-100"
                                  title={`Reset to the headline ${Number(partner.profit_share_percent)}%`}
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 border-t border-slate-200 font-medium">
                    <td className="px-3 py-2 text-slate-700">Total</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${totals.net < 0 ? "text-danger-700" : "text-slate-900"}`}>
                      {acct(totals.net)}
                    </td>
                    <td />
                    <td className={`px-3 py-2 text-right tabular-nums ${totals.amount < 0 ? "text-danger-700" : "text-slate-900"}`}>
                      {acct(totals.amount)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* ── LEDGER ─────────────────────────────────────────────────────── */}
        {!loading && tab === "ledger" && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500">From</label>
                <ThemedSelect
                  value={ledgerFrom}
                  onChange={(e) => setLedgerFrom(e.target.value)}
                  className="px-2 py-1.5 border border-slate-200 rounded-md text-sm"
                >
                  {periodOptions.map((p) => <option key={p} value={p}>{p}</option>)}
                </ThemedSelect>
                <span className="text-xs text-slate-500">through {period}</span>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setIsAddEntryOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Record payment
              </Button>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-sm">
                <thead className="bg-slate-800 text-[#fff]">
                  <tr className="text-xs uppercase">
                    <th className="text-left px-3 py-2">Date</th>
                    <th className="text-left px-3 py-2">Particulars</th>
                    <th className="text-right px-3 py-2">Cash Paid</th>
                    <th className="text-right px-3 py-2">Remuneration</th>
                    <th className="text-right px-3 py-2">Balance</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  <tr className="bg-slate-50">
                    <td className="px-3 py-2 text-slate-600">
                      {partner.opening_balance_date ? formatDate(partner.opening_balance_date) : "—"}
                    </td>
                    <td className="px-3 py-2 text-slate-700">OPENING BALANCE</td>
                    <td /><td />
                    <td className="px-3 py-2 text-right tabular-nums text-slate-900">
                      {acct(Number(partner.opening_balance ?? 0))}
                    </td>
                    <td />
                  </tr>
                  {ledger.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                      Nothing recorded in this range yet.
                    </td></tr>
                  )}
                  {ledger.map((r, i) => (
                    <tr key={`${r.entry_id ?? "alloc"}-${i}`} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{formatDate(r.entry_date)}</td>
                      <td className="px-3 py-2 text-slate-700">{r.particulars}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {Number(r.cash_paid) === 0 ? "" : acct(Number(r.cash_paid))}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${Number(r.remuneration) < 0 ? "text-danger-600" : "text-slate-700"}`}>
                        {Number(r.remuneration) === 0 ? "" : acct(Number(r.remuneration))}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums font-medium ${Number(r.balance) < 0 ? "text-danger-700" : "text-slate-900"}`}>
                        {acct(Number(r.balance))}
                      </td>
                      <td className="px-2 py-2 text-right">
                        {r.entry_id && (
                          <button
                            onClick={() => deleteEntry(r)}
                            className="p-1 rounded text-slate-400 hover:text-danger-600 hover:bg-danger-50"
                            title="Delete entry"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Balance = previous − Cash Paid + Remuneration. A negative balance (in brackets) is what
              the company owes the partner. Remuneration is their monthly allocation, taken on their
              own basis and including any per-client overrides.
            </p>
          </div>
        )}

        <div className="flex justify-end pt-4 border-t border-slate-200">
          <Button variant="secondary" size="md" onClick={onClose}>Close</Button>
        </div>
      </div>

      {/* Record a payment to (or contribution from) the partner. */}
      <Modal isOpen={isAddEntryOpen} onClose={() => setIsAddEntryOpen(false)} title="Record payment" size="sm">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-600 mb-1">Date</label>
              <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Amount</label>
              <input type="number" min="0" step="0.01" value={entryAmount} onChange={(e) => setEntryAmount(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-right" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-600 mb-1">Direction</label>
              <ThemedSelect value={entryType} onChange={(e) => setEntryType(e.target.value as "DRAWING" | "CONTRIBUTION")}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm">
                <option value="DRAWING">Paid to partner</option>
                <option value="CONTRIBUTION">Received from partner</option>
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Method</label>
              <ThemedSelect value={entryMethod} onChange={(e) => setEntryMethod(e.target.value as typeof entryMethod)}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm">
                <option value="CASH">Cash paid</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="FUEL_CARD">Fuel card</option>
                <option value="CHEQUE">Cheque</option>
              </ThemedSelect>
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Note (optional)</label>
            <input type="text" value={entryNote} onChange={(e) => setEntryNote(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm" />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" disabled={saving} onClick={addEntry}>
              {saving ? "Saving…" : "Record"}
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsAddEntryOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>
    </Modal>
  );
}
