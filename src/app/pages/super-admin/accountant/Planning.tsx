import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, Loader2, Plus, RotateCcw, Trash2, X } from "lucide-react";
import Button from "../../../components/Button";
import Modal from "../../../components/Modal";
import ThemedSelect from "../../../components/ThemedSelect";
import { supabase } from "../../../lib/supabase";
import { useAuth, hasPermission } from "../../../lib/auth";
import { formatDate } from "../../../lib/date";
import { monthEnd, monthLabel, monthStart, useCompanyId } from "../reports/kit";
import { GROUPS, KNOWN } from "./AccountsGrid";

/**
 * PLANNING (0528, 2026-10-21) — what the accountant expects to come in and go
 * out, against what the ledger says did.
 *
 *   The plan        cash_plan rows: expected receipts and payments with dates.
 *                   Marked done with what actually happened, or dropped.
 *   Plan vs actual  per kind of movement, the month's plan beside the ledger's
 *                   actual movements on every bank and cash account — the same
 *                   grouping as the Accounts grid, so the two pages agree.
 *   The next 30     today's cash (the ledger's closing on those accounts) run
 *   days            forward by each expected item, with the low point named.
 *
 * Nothing here posts. A plan is intent; the ledger is what happened.
 */

type Kind = "client_receipt" | "salaries" | "expense" | "vendor" | "advance" | "partner" | "tax" | "loan" | "other";
type Item = {
  id: string; direction: "in" | "out"; kind: Kind; client_id: string | null; vendor_id: string | null;
  description: string; expected_date: string; amount: number; status: "expected" | "done" | "dropped";
  actual_date: string | null; actual_amount: number | null; notes: string | null;
};
const KIND_LABEL: Record<Kind, string> = {
  client_receipt: "Receipt from a client", salaries: "Guard salaries", expense: "Expense", vendor: "Vendor bill",
  advance: "Advance to guards", partner: "Partner", tax: "Tax / statutory", loan: "Loan", other: "Other",
};
/** Which Accounts-grid row a plan kind is compared with. */
const KIND_GROUP: Record<Kind, string> = {
  client_receipt: "clients", salaries: "salaries", expense: "expenses", vendor: "expenses",
  advance: "advances", partner: "partners", tax: "other", loan: "other", other: "other",
};
const signed = (i: Pick<Item, "direction" | "amount">) => (i.direction === "in" ? 1 : -1) * Number(i.amount);
const today = () => new Date().toISOString().slice(0, 10);
const money = (n: number) => Math.round(n).toLocaleString();
const FIELD = "w-full px-3 py-2 border border-border rounded-xl bg-card text-sm text-foreground";

type LRow = { row_kind: string; source_table: string | null; debit: number | null; credit: number | null; balance: number | null };

export default function Planning({ period }: { period: string }) {
  const companyId = useCompanyId();
  const { profile } = useAuth();
  const canView = hasPermission(profile, "planning.view") || hasPermission(profile, "planning.edit");
  const canEdit = hasPermission(profile, "planning.edit");
  const start = monthStart(period), end = monthEnd(period);

  const [items, setItems] = useState<Item[] | null>(null);
  const [carried, setCarried] = useState<Item[]>([]);
  const [upcoming, setUpcoming] = useState<Item[]>([]);
  const [actualBy, setActualBy] = useState<Map<string, number> | null>(null);
  const [cashNow, setCashNow] = useState<number | null>(null);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [doneFor, setDoneFor] = useState<Item | null>(null);

  const load = useCallback(async () => {
    if (!companyId || !canView) return;
    setError(null);
    const horizon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const [mi, ci, up, cl, vd, locs] = await Promise.all([
      supabase.from("cash_plan").select("*").eq("company_id", companyId).gte("expected_date", start).lte("expected_date", end).order("expected_date"),
      // Still expected from an earlier month — the plan said it would have happened.
      supabase.from("cash_plan").select("*").eq("company_id", companyId).eq("status", "expected").lt("expected_date", start).order("expected_date"),
      supabase.from("cash_plan").select("*").eq("company_id", companyId).eq("status", "expected").gte("expected_date", today()).lte("expected_date", horizon).order("expected_date"),
      supabase.from("clients").select("id, name").eq("company_id", companyId).order("name"),
      supabase.from("vendors").select("id, name").order("name"),
      supabase.from("cash_locations").select("coa_account_id").eq("company_id", companyId).eq("is_active", true),
    ]);
    const e0 = mi.error ?? ci.error ?? up.error;
    if (e0) { setError(e0.message); setItems([]); return; }
    setItems((mi.data ?? []) as Item[]);
    setCarried((ci.data ?? []) as Item[]);
    setUpcoming((up.data ?? []) as Item[]);
    setClients((cl.data ?? []) as { id: string; name: string }[]);
    setVendors((vd.data ?? []) as { id: string; name: string }[]);

    // Actual movements in the month, from the ledger, by the Accounts-grid
    // grouping; and today's cash = the accounts' closing as of today.
    const accts = ((locs.data ?? []) as { coa_account_id: string | null }[]).map((l) => l.coa_account_id).filter(Boolean) as string[];
    const [month, now] = await Promise.all([
      Promise.all(accts.map((a) => supabase.rpc("ledger_statement", { p_company_id: companyId, p_kind: "account", p_subject_id: a, p_start: start, p_end: end }))),
      Promise.all(accts.map((a) => supabase.rpc("ledger_statement", { p_company_id: companyId, p_kind: "account", p_subject_id: a, p_start: today(), p_end: today() }))),
    ]);
    const by = new Map<string, number>();
    for (const r of month) for (const l of ((r.data ?? []) as LRow[])) {
      if (l.row_kind !== "LINE") continue;
      const g = GROUPS.find((x) => (x.sources ? x.sources.includes(l.source_table ?? "") : !KNOWN.has(l.source_table ?? "")));
      if (g) by.set(g.key, (by.get(g.key) ?? 0) + Number(l.debit ?? 0) - Number(l.credit ?? 0));
    }
    setActualBy(month.some((r) => r.error) ? null : by);
    setCashNow(now.some((r) => r.error) ? null : now.reduce((n, r) => {
      const rows = (r.data ?? []) as LRow[];
      return n + Number(rows.find((x) => x.row_kind === "CLOSING")?.balance ?? rows.find((x) => x.row_kind === "OPENING")?.balance ?? 0);
    }, 0));
  }, [companyId, canView, start, end]);
  useEffect(() => { void load(); }, [load]);

  const run = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setError(null);
    const { error: e } = await p;
    setBusy(false);
    if (e) { setError(e.message); return false; }
    await load();
    return true;
  };

  const live = (items ?? []).filter((i) => i.status !== "dropped");
  const planIn = live.filter((i) => i.direction === "in").reduce((n, i) => n + Number(i.amount), 0);
  const planOut = live.filter((i) => i.direction === "out").reduce((n, i) => n + Number(i.amount), 0);
  const doneCount = live.filter((i) => i.status === "done").length;

  // Plan vs actual by Accounts-grid row.
  const compare = useMemo(() => {
    const plan = new Map<string, number>();
    for (const i of live) plan.set(KIND_GROUP[i.kind], (plan.get(KIND_GROUP[i.kind]) ?? 0) + signed(i));
    return GROUPS.filter((g) => g.key !== "transfer").map((g) => ({ key: g.key, label: g.label, plan: plan.get(g.key) ?? 0, actual: actualBy?.get(g.key) ?? 0 }))
      .filter((r) => Math.abs(r.plan) >= 1 || Math.abs(r.actual) >= 1);
  }, [live, actualBy]);

  // The next 30 days: cash now, moved by each expected item in date order.
  const runway = useMemo(() => {
    if (cashNow == null) return null;
    let bal = cashNow, low = cashNow, lowDate = today();
    const steps = upcoming.map((i) => { bal += signed(i); if (bal < low) { low = bal; lowDate = i.expected_date; } return { i, bal }; });
    return { steps, low, lowDate, end: bal };
  }, [cashNow, upcoming]);

  if (!canView) {
    return (
      <div className="bg-card border border-border rounded-2xl px-6 py-10 text-center">
        <p className="font-display text-lg font-bold text-foreground">Planning needs its own access</p>
        <p className="text-sm text-muted-foreground mt-1">Ask an administrator to grant <span className="font-ledger">planning.view</span> (to see the plan) or <span className="font-ledger">planning.edit</span> (to add to it) in Access & Governance.</p>
      </div>
    );
  }
  if (!items) return <div className="bg-card border border-border rounded-2xl flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Reading the plan and the ledger…</div>;

  const nameOf = (i: Item) => (i.client_id ? clients.find((c) => c.id === i.client_id)?.name : i.vendor_id ? vendors.find((v) => v.id === i.vendor_id)?.name : null);
  const tile = "bg-card border border-border rounded-2xl px-4 py-3 flex flex-col gap-1 min-w-0";

  return (
    <div className="space-y-4">
      {error && <div className="rounded-xl border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700 dark:text-danger-500">{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className={tile}><span className="lbl">Expected in · {monthLabel(period)}</span><span className="font-ledger text-xl font-semibold text-success-700 dark:text-success-500">{money(planIn)}</span><span className="text-xs text-muted-foreground">{live.filter((i) => i.direction === "in").length} items</span></div>
        <div className={tile}><span className="lbl">Expected out</span><span className="font-ledger text-xl font-semibold text-danger-700 dark:text-danger-500">{money(planOut)}</span><span className="text-xs text-muted-foreground">{live.filter((i) => i.direction === "out").length} items</span></div>
        <div className={tile}><span className="lbl">Net plan</span><span className={`font-ledger text-xl font-semibold ${planIn - planOut < 0 ? "text-danger-700 dark:text-danger-500" : "text-foreground"}`}>{planIn - planOut < 0 ? "−" : ""}{money(Math.abs(planIn - planOut))}</span><span className="text-xs text-muted-foreground">{doneCount} of {live.length} done</span></div>
        <div className={tile}>
          <span className="lbl">Lowest cash, next 30 days</span>
          <span className={`font-ledger text-xl font-semibold ${runway && runway.low < 0 ? "text-danger-700 dark:text-danger-500" : "text-foreground"}`}>{runway ? `${runway.low < 0 ? "−" : ""}${money(Math.abs(runway.low))}` : "—"}</span>
          <span className="text-xs text-muted-foreground truncate">{runway ? (runway.steps.length ? `on ${formatDate(runway.lowDate)} · from ${money(cashNow!)} today` : "nothing expected in 30 days") : "needs ledger access"}</span>
        </div>
      </div>

      {carried.length > 0 && (
        <div className="rounded-2xl border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:text-warning-500">
          {carried.length} item{carried.length === 1 ? " is" : "s are"} still expected from an earlier month: {carried.slice(0, 4).map((i) => `${i.description} (${formatDate(i.expected_date)})`).join(", ")}{carried.length > 4 ? "…" : ""}. Mark them done or dropped so the plan stays honest.
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[3fr_2fr] gap-4">
        <section className="bg-card border border-border rounded-2xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-base font-bold tracking-tight text-foreground">The plan · {monthLabel(period)}</h3>
              <p className="text-xs text-muted-foreground">What you expect to receive and pay, and when.</p>
            </div>
            {canEdit && <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}><Plus className="w-3.5 h-3.5 mr-1" /> Add to the plan</Button>}
          </div>
          {items.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">Nothing planned for {monthLabel(period)} yet.{canEdit ? " Add the receipts you expect from clients and the payments due — salaries, bills, advances — with their dates." : ""}</p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((i) => (
                <li key={i.id} className={`px-5 py-3 flex items-center gap-3 ${i.status === "dropped" ? "opacity-50" : ""}`}>
                  <span className={`h-8 w-8 rounded-xl flex items-center justify-center flex-shrink-0 ${i.direction === "in" ? "bg-success-50 text-success-700 dark:text-success-500" : "bg-danger-50 text-danger-700 dark:text-danger-500"}`}>
                    {i.direction === "in" ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium text-foreground truncate ${i.status === "dropped" ? "line-through" : ""}`}>{i.description}</p>
                    <p className="text-xs text-muted-foreground truncate">{formatDate(i.expected_date)} · {KIND_LABEL[i.kind]}{nameOf(i) ? ` · ${nameOf(i)}` : ""}</p>
                  </div>
                  <div className="text-right">
                    <p className={`font-ledger text-sm font-semibold ${i.direction === "in" ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"}`}>{i.direction === "in" ? "+" : "−"}{money(Number(i.amount))}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {i.status === "done" ? `done${i.actual_amount != null ? ` · ${money(Number(i.actual_amount))}` : ""}${i.actual_date ? ` on ${formatDate(i.actual_date)}` : ""}` : i.status === "dropped" ? "dropped" : i.expected_date < today() ? <span className="text-danger-700 dark:text-danger-500">overdue</span> : "expected"}
                    </p>
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-1">
                      {i.status === "expected" && <button type="button" disabled={busy} onClick={() => setDoneFor(i)} title="Mark done" className="p-1.5 rounded-lg hover:bg-success-50 text-success-700 dark:text-success-500"><Check className="w-4 h-4" /></button>}
                      {i.status === "expected" && <button type="button" disabled={busy} onClick={() => void run(supabase.from("cash_plan").update({ status: "dropped" }).eq("id", i.id))} title="Drop — it will not happen" className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"><X className="w-4 h-4" /></button>}
                      {i.status !== "expected" && <button type="button" disabled={busy} onClick={() => void run(supabase.from("cash_plan").update({ status: "expected", actual_date: null, actual_amount: null }).eq("id", i.id))} title="Back to expected" className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"><RotateCcw className="w-4 h-4" /></button>}
                      <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Delete "${i.description}" from the plan?`)) void run(supabase.from("cash_plan").delete().eq("id", i.id)); }} title="Delete" className="p-1.5 rounded-lg hover:bg-danger-50 text-muted-foreground hover:text-danger-700"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="space-y-4">
          <section className="bg-card border border-border rounded-2xl p-5">
            <h3 className="font-display text-base font-bold tracking-tight text-foreground">Plan against actual</h3>
            <p className="text-xs text-muted-foreground mb-3">Actual is every bank and cash account's movements this month, from the ledger — the Accounts grid's rows.</p>
            {compare.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing planned and nothing moved yet this month.</p>
            ) : (
              <div className="space-y-3">
                {compare.map((r) => {
                  const max = Math.max(1, Math.abs(r.plan), Math.abs(r.actual));
                  const diff = r.actual - r.plan;
                  return (
                    <div key={r.key} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="text-foreground">{r.label}</span>
                        <span className={`font-ledger text-xs ${Math.abs(diff) < 1 ? "text-muted-foreground" : diff > 0 ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"}`}>{Math.abs(diff) < 1 ? "on plan" : `${diff > 0 ? "+" : "−"}${money(Math.abs(diff))} vs plan`}</span>
                      </div>
                      <div className="grid grid-cols-[52px_1fr_88px] items-center gap-2 text-[11px]">
                        <span className="text-muted-foreground">Plan</span>
                        <span className="h-2 rounded-full bg-muted overflow-hidden"><span className="block h-full rounded-full bg-calm" style={{ width: `${(Math.abs(r.plan) / max) * 100}%` }} /></span>
                        <span className="font-ledger text-right text-foreground">{r.plan < 0 ? "−" : ""}{money(Math.abs(r.plan))}</span>
                        <span className="text-muted-foreground">Actual</span>
                        <span className="h-2 rounded-full bg-muted overflow-hidden"><span className={`block h-full rounded-full ${r.actual >= 0 ? "bg-success-500" : "bg-brand-500"}`} style={{ width: `${(Math.abs(r.actual) / max) * 100}%` }} /></span>
                        <span className="font-ledger text-right text-foreground">{actualBy ? `${r.actual < 0 ? "−" : ""}${money(Math.abs(r.actual))}` : "—"}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="bg-card border border-border rounded-2xl p-5">
            <h3 className="font-display text-base font-bold tracking-tight text-foreground">The next 30 days</h3>
            <p className="text-xs text-muted-foreground mb-3">Today's cash on every bank and cash account, moved by each expected item in date order.</p>
            {!runway ? <p className="text-sm text-muted-foreground">Needs access to the ledger.</p>
              : runway.steps.length === 0 ? <p className="text-sm text-muted-foreground">Nothing expected in the next 30 days.</p>
              : (
                <ul className="space-y-1.5">
                  <li className="flex justify-between text-xs text-muted-foreground"><span>Today</span><span className="font-ledger">{money(cashNow!)}</span></li>
                  {runway.steps.map(({ i, bal }) => (
                    <li key={i.id} className="grid grid-cols-[72px_1fr_80px_88px] gap-2 text-xs items-baseline">
                      <span className="text-muted-foreground">{formatDate(i.expected_date)}</span>
                      <span className="truncate text-foreground">{i.description}</span>
                      <span className={`font-ledger text-right ${i.direction === "in" ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"}`}>{i.direction === "in" ? "+" : "−"}{money(Number(i.amount))}</span>
                      <span className={`font-ledger text-right font-semibold ${bal < 0 ? "text-danger-700 dark:text-danger-500" : "text-foreground"}`}>{bal < 0 ? "−" : ""}{money(Math.abs(bal))}</span>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </div>
      </div>

      {addOpen && <AddItem clients={clients} vendors={vendors} busy={busy} onClose={() => setAddOpen(false)}
        onSave={async (row) => { const ok = await run(supabase.from("cash_plan").insert({ ...row, company_id: companyId })); if (ok) setAddOpen(false); }} />}
      {doneFor && <MarkDone item={doneFor} busy={busy} onClose={() => setDoneFor(null)}
        onSave={async (amount, date) => { const ok = await run(supabase.from("cash_plan").update({ status: "done", actual_amount: amount, actual_date: date }).eq("id", doneFor.id)); if (ok) setDoneFor(null); }} />}
    </div>
  );
}

function AddItem({ clients, vendors, busy, onClose, onSave }: {
  clients: { id: string; name: string }[]; vendors: { id: string; name: string }[]; busy: boolean;
  onClose: () => void; onSave: (row: Omit<Item, "id" | "status" | "actual_date" | "actual_amount">) => void;
}) {
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [kind, setKind] = useState<Kind>("client_receipt");
  const [clientId, setClientId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const kinds = (Object.keys(KIND_LABEL) as Kind[]).filter((k) => (direction === "in" ? ["client_receipt", "partner", "loan", "other"].includes(k) : k !== "client_receipt"));
  const amt = Number(amount);
  const ok = description.trim().length > 0 && amt > 0 && !!date;
  return (
    <Modal isOpen onClose={onClose} title="Add to the plan" size="md">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ok) onSave({ direction, kind, client_id: kind === "client_receipt" ? clientId || null : null, vendor_id: kind === "vendor" ? vendorId || null : null, description: description.trim(), expected_date: date, amount: amt, notes: notes.trim() || null }); }}>
        <div className="flex gap-2">
          {(["in", "out"] as const).map((d) => (
            <button key={d} type="button" onClick={() => { setDirection(d); setKind(d === "in" ? "client_receipt" : "expense"); }}
              className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold ${direction === d ? "border-brand-500 text-foreground" : "border-border text-muted-foreground"}`}>
              {d === "in" ? "Money in" : "Money out"}
            </button>
          ))}
        </div>
        <div>
          <label className="lbl block mb-1">Kind</label>
          <ThemedSelect className={FIELD} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </ThemedSelect>
        </div>
        {kind === "client_receipt" && (
          <div>
            <label className="lbl block mb-1">Client</label>
            <ThemedSelect className={FIELD} value={clientId} onChange={(e) => { setClientId(e.target.value); if (!description) setDescription(`Receipt — ${clients.find((c) => c.id === e.target.value)?.name ?? ""}`); }}>
              <option value="">— client —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </ThemedSelect>
          </div>
        )}
        {kind === "vendor" && (
          <div>
            <label className="lbl block mb-1">Vendor</label>
            <ThemedSelect className={FIELD} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">— vendor —</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </ThemedSelect>
          </div>
        )}
        <div>
          <label className="lbl block mb-1">Description</label>
          <input className={FIELD} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. September invoice — HMC Taxila" required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="lbl block mb-1">Expected on</label><input type="date" className={FIELD} value={date} onChange={(e) => setDate(e.target.value)} required /></div>
          <div><label className="lbl block mb-1">Amount (PKR)</label><input inputMode="decimal" className={FIELD} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" required /></div>
        </div>
        <div><label className="lbl block mb-1">Notes</label><input className={FIELD} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" /></div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!ok || busy}>Add</Button>
        </div>
      </form>
    </Modal>
  );
}

function MarkDone({ item, busy, onClose, onSave }: { item: Item; busy: boolean; onClose: () => void; onSave: (amount: number, date: string) => void }) {
  const [amount, setAmount] = useState(String(item.amount));
  const [date, setDate] = useState(today());
  const amt = Number(amount);
  return (
    <Modal isOpen onClose={onClose} title={`Done — ${item.description}`} size="sm">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (amt >= 0 && date) onSave(amt, date); }}>
        <p className="text-sm text-muted-foreground">Planned {item.direction === "in" ? "to receive" : "to pay"} PKR {money(Number(item.amount))} on {formatDate(item.expected_date)}. What actually happened?</p>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="lbl block mb-1">Actual amount</label><input inputMode="decimal" className={FIELD} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /></div>
          <div><label className="lbl block mb-1">On</label><input type="date" className={FIELD} value={date} onChange={(e) => setDate(e.target.value)} /></div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>Mark done</Button>
        </div>
      </form>
    </Modal>
  );
}
