import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Plus, Fuel, Receipt, Gauge, Undo2, ListPlus, Trash2 } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import ThemedSelect from "./ThemedSelect";
import { supabase, friendlyDbError, type BankAccount } from "../lib/supabase";

/**
 * FUEL CARDS (0542, DECIDED 2026-10-16). A card has two roles that never merge:
 *
 *  • Company float — loaded from a bank, spent on fuel bills. Its balance is
 *    its own ledger account (1020.NN); a bill is a fuel expense on the bill's
 *    date, and the unspent balance is an asset. The Attock portal figure is
 *    typed in and compared; a difference, or a card never checked, is red
 *    (ledger check fuel_cards_agree_with_attock_portal).
 *  • Allowance card — the card a man's fixed allowance is paid onto from
 *    payroll ("Fuel card" as the payment mode). Nothing is tracked on it.
 *
 * Every write is an RPC. Nothing here touches a balance, and nothing here adds
 * one up: the figures are read from fuel_card_balances.
 */

type CardRow = {
  fuel_card_id: string; role: "float" | "allowance"; label: string; provider: string; card_last4: string | null;
  holder_employee_id: string | null; holder_name: string | null; branch_id: string | null; account_code: string | null;
  is_active: boolean; balance: number; loaded: number; billed: number;
  reading_as_of: string | null; portal_balance: number | null; balance_on_reading: number | null; difference: number | null;
};
type Load = { id: string; fuel_card_id: string; bank_account_id: string; amount: number; loaded_on: string; note: string | null };
type Opt = { id: string; name: string };

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const monthStartISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; };
const fmt = (n: number | null) => (n == null ? "—" : Math.round(Number(n)).toLocaleString());
const fmtDate = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";

type Dialog =
  | { kind: "register" }
  | { kind: "load"; card: CardRow }
  | { kind: "bill"; card: CardRow }
  | { kind: "reading"; card: CardRow }
  | { kind: "reverse"; load: Load; card: CardRow }
  | { kind: "bills"; card: CardRow }
  | { kind: "book"; card: CardRow; gap: number }
  | null;

export default function FuelCards({
  companyId, banks, canEdit, onMoved, mode = "treasury",
}: {
  companyId: string | null;
  banks: BankAccount[];
  canEdit: boolean;
  /** A bank balance moved (or, in "bills" mode, a bill was recorded): the page reloads. */
  onMoved: () => void;
  /** "bills": the Expenses tab's view — float cards and their bill forms only.
   *  Whoever records operations' bills there never sees a bank, a load or the
   *  Attock balance; loading, the portal reading and the month-end booking stay
   *  with the accountant in Banks & Ledgers. */
  mode?: "treasury" | "bills";
}) {
  const billsOnly = mode === "bills";
  const [cards, setCards] = useState<CardRow[]>([]);
  const [loads, setLoads] = useState<Load[]>([]);
  // This month's bills per card: with a client, general (no client), and how many.
  const [monthBills, setMonthBills] = useState<Map<string, { client: number; general: number; n: number }>>(new Map());
  // "Enter bills": several of operations' bills typed in one go.
  type BillLine = { date: string; amount: string; client: string; note: string; err?: string; done?: boolean };
  const [lines, setLines] = useState<BillLine[]>([]);
  const [missing, setMissing] = useState(false);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [branches, setBranches] = useState<Opt[]>([]);
  const [employees, setEmployees] = useState<Opt[]>([]);
  const [clients, setClients] = useState<(Opt & { branch_id: string | null })[]>([]);
  const [categories, setCategories] = useState<Opt[]>([]);

  // one form, reset per dialog
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const load = useCallback(async () => {
    if (!companyId) return;
    const [c, l] = await Promise.all([
      supabase.rpc("fuel_card_balances", { p_company_id: companyId }),
      supabase.from("fuel_card_loads").select("id, fuel_card_id, bank_account_id, amount, loaded_on, note")
        .eq("company_id", companyId).order("loaded_on", { ascending: false }).limit(200),
    ]);
    // Before 0542 is applied the function does not exist: show nothing rather than an error.
    if (c.error) { setMissing(true); setCards([]); return; }
    setMissing(false);
    setCards(((c.data ?? []) as CardRow[]).map((r) => ({
      ...r, balance: Number(r.balance), loaded: Number(r.loaded), billed: Number(r.billed),
      portal_balance: r.portal_balance == null ? null : Number(r.portal_balance),
      balance_on_reading: r.balance_on_reading == null ? null : Number(r.balance_on_reading),
      difference: r.difference == null ? null : Number(r.difference),
    })));
    setLoads(((l.data ?? []) as Load[]).map((x) => ({ ...x, amount: Number(x.amount) })));
    const ms = monthStartISO();
    const { data: bx } = await supabase.from("expenses").select("fuel_card_id, client_id, amount")
      .eq("company_id", companyId).eq("payment_mode", "Card").gte("expense_date", ms);
    const mb = new Map<string, { client: number; general: number; n: number }>();
    for (const x of (bx ?? []) as { fuel_card_id: string; client_id: string | null; amount: number }[]) {
      const m = mb.get(x.fuel_card_id) ?? { client: 0, general: 0, n: 0 };
      if (x.client_id) m.client += Number(x.amount); else m.general += Number(x.amount);
      m.n += 1; mb.set(x.fuel_card_id, m);
    }
    setMonthBills(mb);
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  // Pickers, once: regions, staff (card holders), clients and categories (bills).
  useEffect(() => {
    if (!companyId) return;
    void Promise.all([
      supabase.from("branches").select("id, name").eq("company_id", companyId).order("name"),
      supabase.from("employees").select("id, full_name, lifecycle_state").eq("company_id", companyId).order("full_name"),
      supabase.from("clients").select("id, name, branch_id").eq("company_id", companyId).order("name"),
      supabase.from("expense_categories").select("id, name").eq("company_id", companyId).order("name"),
    ]).then(([b, e, cl, cat]) => {
      setBranches((b.data ?? []) as Opt[]);
      setEmployees(((e.data ?? []) as { id: string; full_name: string; lifecycle_state: string | null }[])
        .filter((x) => !["fired", "terminated", "resigned", "left", "absconded"].includes(String(x.lifecycle_state ?? "")))
        .map((x) => ({ id: x.id, name: x.full_name })));
      setClients((cl.data ?? []) as (Opt & { branch_id: string | null })[]);
      setCategories((cat.data ?? []) as Opt[]);
    });
  }, [companyId]);

  const activeBanks = useMemo(() => banks.filter((b) => b.active !== false && b.owner_type === "company"), [banks]);
  const bankName = useMemo(() => new Map(banks.map((b) => [b.id, `${b.bank_name} · ${b.account_number}`])), [banks]);
  const floats = cards.filter((c) => c.role === "float");
  const allowances = cards.filter((c) => c.role === "allowance");
  const floatTotal = floats.reduce((s, c) => s + c.balance, 0);
  const fuelCategory = categories.find((c) => /fuel/i.test(c.name))?.id ?? "";

  if (missing) return null;

  const open = (d: Dialog, init: Record<string, string> = {}) => { setErr(null); setF(init); setDialog(d); };
  const close = () => { if (!busy) setDialog(null); };
  const run = async (call: () => PromiseLike<{ error: { message: string } | null }>, moved: boolean) => {
    setBusy(true); setErr(null);
    const { error } = await call();
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setDialog(null);
    await load();
    if (moved) onMoved();
  };

  const submit = async () => {
    if (!dialog) return;
    const amount = Number(f.amount);
    if (dialog.kind === "register") {
      const role = f.role === "allowance" ? "allowance" : "float";
      if (!f.label?.trim()) return setErr("Name the card.");
      if (role === "allowance" && !f.holder) return setErr("Choose who holds the card.");
      if (f.last4 && !/^\d{4}$/.test(f.last4)) return setErr("Last four digits only — four numbers.");
      return run(() => supabase.rpc("register_fuel_card", {
        p_role: role, p_label: f.label.trim(), p_branch_id: f.branch || null,
        p_holder_employee_id: f.holder || null, p_card_last4: f.last4 || null,
        p_provider: f.provider?.trim() || "Attock", p_notes: f.notes?.trim() || null,
      }), false);
    }
    if (dialog.kind === "load") {
      if (!(amount > 0)) return setErr("Enter the amount loaded.");
      if (!f.bank) return setErr("Choose the bank it was loaded from.");
      return run(() => supabase.rpc("load_fuel_card", {
        p_fuel_card_id: dialog.card.fuel_card_id, p_bank_account_id: f.bank, p_amount: amount,
        p_loaded_on: f.date || todayISO(), p_note: f.note?.trim() || null,
      }), true);
    }
    if (dialog.kind === "bill") {
      if (!(amount > 0)) return setErr("Enter the bill amount.");
      if (!f.category) return setErr("Choose the expense category.");
      return run(() => supabase.rpc("record_fuel_card_bill", {
        p_fuel_card_id: dialog.card.fuel_card_id, p_amount: amount, p_bill_date: f.date || todayISO(),
        p_category_id: f.category, p_client_id: f.client || null, p_branch_id: f.branch || null,
        p_description: f.description?.trim() || null,
      }), billsOnly);
    }
    if (dialog.kind === "reading") {
      if (f.portal === undefined || f.portal === "" || !Number.isFinite(Number(f.portal))) return setErr("Enter the balance the Attock portal shows.");
      return run(() => supabase.rpc("record_fuel_card_reading", {
        p_fuel_card_id: dialog.card.fuel_card_id, p_as_of: f.date || todayISO(),
        p_portal_balance: Number(f.portal), p_note: f.note?.trim() || null,
      }), false);
    }
    if (dialog.kind === "bills") {
      const todo = lines.map((l, i) => ({ l, i })).filter(({ l }) => !l.done && (l.amount || l.note));
      if (todo.length === 0) return setErr("Type at least one bill.");
      if (!fuelCategory) return setErr("The expense category \"Transportation & Fuel\" is missing.");
      setBusy(true); setErr(null);
      const next = [...lines];
      // One at a time, oldest first, so the card's balance check sees each bill in turn.
      for (const { l, i } of [...todo].sort((a, b) => a.l.date.localeCompare(b.l.date))) {
        const amt = Number(l.amount);
        if (!(amt > 0)) { next[i] = { ...l, err: "Enter the amount." }; continue; }
        const cl = clients.find((x) => x.id === l.client);
        const { error } = await supabase.rpc("record_fuel_card_bill", {
          p_fuel_card_id: dialog.card.fuel_card_id, p_amount: amt, p_bill_date: l.date || todayISO(),
          p_category_id: fuelCategory, p_client_id: l.client || null,
          p_branch_id: cl?.branch_id ?? dialog.card.branch_id ?? null,
          p_description: l.note.trim() || null,
        });
        next[i] = error ? { ...l, err: friendlyDbError(error) } : { ...l, err: undefined, done: true };
      }
      setLines(next);
      setBusy(false);
      await load();
      if (billsOnly) onMoved();
      if (next.every((l) => l.done || (!l.amount && !l.note))) setDialog(null);
      else setErr("Some bills were not recorded — each says why. The rest are in.");
      return;
    }
    if (dialog.kind === "book") {
      return run(() => supabase.rpc("book_unbilled_fuel", { p_fuel_card_id: dialog.card.fuel_card_id }), false);
    }
    if (dialog.kind === "reverse") {
      if ((f.reason ?? "").trim().length < 5) return setErr("Say why this load is being reversed.");
      return run(() => supabase.rpc("reverse_fuel_card_load", { p_load_id: dialog.load.id, p_reason: f.reason.trim() }), true);
    }
  };

  const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  const label = "block text-[11px] text-muted-foreground mb-1";

  const status = (c: CardRow) => {
    if (c.balance < -0.005) return { ok: false, text: "Bastion holds this card below zero" };
    if (!c.reading_as_of) return { ok: false, text: "Attock balance never entered" };
    if (Math.abs(c.difference ?? 0) > 0.5)
      return { ok: false, text: `Attock ${fmt(c.portal_balance)} on ${fmtDate(c.reading_as_of)} · Bastion ${fmt(c.balance_on_reading)}` };
    return { ok: true, text: `Agrees with Attock on ${fmtDate(c.reading_as_of)}` };
  };

  const title =
    dialog?.kind === "register" ? "Register a fuel card"
    : dialog?.kind === "load" ? `Load — ${dialog.card.label}`
    : dialog?.kind === "bill" ? `Fuel bill — ${dialog.card.label}`
    : dialog?.kind === "reading" ? `Attock balance — ${dialog.card.label}`
    : dialog?.kind === "reverse" ? `Reverse load — ${dialog.card.label}`
    : dialog?.kind === "bills" ? `Enter bills — ${dialog.card.label}`
    : dialog?.kind === "book" ? `Book unbilled fuel — ${dialog.card.label}` : "";

  return (
    <div className="mt-6 rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{billsOnly ? "Fuel bills" : "Fuel cards"}</div>
          <div className="text-xs text-muted-foreground">
            {billsOnly
              ? "Record each fuel bill against the card it was paid with — with its client, or as a general bill when it was not for one site."
              : <>Company float on cards is an asset until it is spent; an allowance card is where a man&rsquo;s fixed allowance is paid.</>}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-right">
            <div className="lbl">Held on cards</div>
            <div className="font-ledger text-lg font-semibold text-foreground whitespace-nowrap">
              <span className="cur">PKR</span>{fmt(floatTotal)}
            </div>
          </div>
          {canEdit && !billsOnly && (
            <Button size="sm" onClick={() => open({ kind: "register" }, { role: "float", provider: "Attock" })}>
              <Plus className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Register card
            </Button>
          )}
        </div>
      </div>

      {cards.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {billsOnly ? "No fuel cards yet — accounts registers them in Banks & Ledgers." : <>No fuel cards registered. Register a company float card to load it and record its bills here, or an employee&rsquo;s card so payroll can pay his fixed allowance onto it.</>}
        </p>
      ) : (
        <>
          {billsOnly && floats.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground">No company float card yet — accounts registers them in Banks & Ledgers.</p>
          )}
          {floats.length > 0 && (
            <div className="divide-y divide-border">
              {floats.map((c) => {
                const st = status(c);
                const cardLoads = loads.filter((l) => l.fuel_card_id === c.fuel_card_id);
                return (
                  <div key={c.fuel_card_id} className={c.is_active ? "" : "opacity-60"}>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                      <button type="button" className="min-w-0 flex-1 text-left" disabled={billsOnly} onClick={() => setOpenCard(openCard === c.fuel_card_id ? null : c.fuel_card_id)}>
                        <div className="text-sm font-medium text-foreground truncate">
                          {c.label}
                          <span className="text-muted-foreground font-normal"> · {c.provider}{c.card_last4 ? ` ••${c.card_last4}` : ""}{c.account_code ? ` · ${c.account_code}` : ""}</span>
                        </div>
                        {!billsOnly && <div className={`text-xs flex items-center gap-1 ${st.ok ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500"}`}>
                          {st.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <CircleAlert className="w-3.5 h-3.5" />}
                          {st.text}
                        </div>}
                      </button>
                      <div className="text-right">
                        <div className="font-ledger text-sm font-semibold text-foreground whitespace-nowrap">{fmt(c.balance)}</div>
                        <div className="text-[11px] text-muted-foreground whitespace-nowrap">loaded {fmt(c.loaded)} · spent {fmt(c.billed)}</div>
                      </div>
                      {(() => {
                        // This month, and the fuel Attock shows spent beyond the bills (0547).
                        const ms = monthStartISO();
                        const loadedMonth = cardLoads.filter((l) => l.loaded_on >= ms).reduce((n, l) => n + l.amount, 0);
                        const mb = monthBills.get(c.fuel_card_id) ?? { client: 0, general: 0, n: 0 };
                        const gap = c.reading_as_of && c.balance_on_reading != null && c.portal_balance != null
                          ? Math.round((c.balance_on_reading - c.portal_balance) * 100) / 100 : null;
                        return (
                          <div className="basis-full flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                            {!billsOnly && <span>This month: loaded <span className="font-ledger text-foreground">{fmt(loadedMonth)}</span></span>}
                            <span>{billsOnly ? "Bills this month" : "bills"} <span className="font-ledger text-foreground">{fmt(mb.client + mb.general)}</span> ({mb.n}{mb.general ? `, ${fmt(mb.general)} general` : ""})</span>
                            {gap != null && gap > 0.5 && (
                              <span className="text-heed font-semibold">No bill yet: <span className="font-ledger">{fmt(gap)}</span> to {fmtDate(c.reading_as_of)}</span>
                            )}
                            {gap != null && gap < -0.5 && (
                              <span className="text-danger-700 dark:text-danger-500 font-semibold">Bills exceed Attock by {fmt(-gap)} — check for a bill entered twice</span>
                            )}
                            {gap != null && gap > 0.5 && canEdit && !billsOnly && c.is_active && (
                              <button type="button" className="text-brand-700 dark:text-brand-500 hover:underline font-medium"
                                onClick={() => open({ kind: "book", card: c, gap })}>Book unbilled (month end)</button>
                            )}
                          </div>
                        );
                      })()}
                      {canEdit && c.is_active && (
                        <div className="flex flex-wrap gap-2">
                          {!billsOnly && (
                            <Button size="sm" variant="secondary" onClick={() => open({ kind: "load", card: c }, { date: todayISO() })}>
                              <Fuel className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Load
                            </Button>
                          )}
                          <Button size="sm" variant="secondary" onClick={() => open({ kind: "bill", card: c }, { date: todayISO(), category: fuelCategory, branch: c.branch_id ?? "" })}>
                            <Receipt className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Bill
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => {
                            setLines(Array.from({ length: 5 }, () => ({ date: todayISO(), amount: "", client: "", note: "" })));
                            open({ kind: "bills", card: c });
                          }}>
                            <ListPlus className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Enter bills
                          </Button>
                          {!billsOnly && (
                            <Button size="sm" variant="secondary" onClick={() => open({ kind: "reading", card: c }, { date: todayISO() })}>
                              <Gauge className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Attock balance
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                    {!billsOnly && openCard === c.fuel_card_id && (
                      <div className="px-4 pb-3">
                        {cardLoads.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No loads yet.</p>
                        ) : (
                          <ul className="text-xs divide-y divide-border rounded-lg border border-border">
                            {cardLoads.map((l) => (
                              <li key={l.id} className="flex items-center gap-3 px-3 py-1.5">
                                <span className="text-muted-foreground whitespace-nowrap">{fmtDate(l.loaded_on)}</span>
                                <span className="text-muted-foreground truncate flex-1">from {bankName.get(l.bank_account_id) ?? "bank"}{l.note ? ` · ${l.note}` : ""}</span>
                                <span className="font-ledger text-foreground">{fmt(l.amount)}</span>
                                {canEdit && (
                                  <button type="button" className="text-muted-foreground hover:text-foreground" title="Reverse this load"
                                    onClick={() => open({ kind: "reverse", load: l, card: c })}>
                                    <Undo2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                        <p className="text-[11px] text-muted-foreground mt-1.5">Bills appear in Expenses, paid by &ldquo;Card&rdquo;.</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!billsOnly && allowances.length > 0 && (
            <div className="border-t border-border">
              <div className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Allowance cards — paid from payroll, not tracked</div>
              <div className="divide-y divide-border">
                {allowances.map((c) => (
                  <div key={c.fuel_card_id} className={`flex items-center gap-3 px-4 py-2 text-sm ${c.is_active ? "" : "opacity-60"}`}>
                    <span className="text-foreground">{c.holder_name ?? "—"}</span>
                    <span className="text-muted-foreground truncate">{c.label} · {c.provider}{c.card_last4 ? ` ••${c.card_last4}` : ""}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <Modal isOpen={!!dialog} onClose={close} title={title} error={err} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : dialog?.kind === "reverse" ? "Reverse load" : dialog?.kind === "bills" ? "Record bills" : dialog?.kind === "book" ? "Book it" : "Save"}</Button>
        </>}>
        {dialog?.kind === "register" && (
          <div className="flex flex-col gap-3">
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {(["float", "allowance"] as const).map((r) => (
                <button key={r} type="button" onClick={() => set("role", r)} aria-pressed={f.role === r}
                  className={`flex-1 px-3 py-1.5 text-sm rounded-md ${f.role === r ? "bg-card text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                  {r === "float" ? "Company float" : "Allowance card"}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {f.role === "allowance"
                ? "A man's own card. Payroll pays his fixed allowance onto it from a bank; nothing is tracked on it after that."
                : "The company's money on a card. Loads add to it, fuel bills spend it, and the Attock portal balance is checked against it."}
            </p>
            <div>
              <label className={label}>Name *</label>
              <input className={field} value={f.label ?? ""} onChange={(e) => set("label", e.target.value)}
                placeholder={f.role === "allowance" ? "e.g. Shayan — fuel" : "e.g. Office bike — ISB"} />
            </div>
            {f.role === "allowance" && (
              <div>
                <label className={label}>Held by *</label>
                <ThemedSelect value={f.holder ?? ""} onChange={(e) => set("holder", e.target.value)}>
                  <option value="">Select employee</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </ThemedSelect>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Provider</label>
                <input className={field} value={f.provider ?? ""} onChange={(e) => set("provider", e.target.value)} />
              </div>
              <div>
                <label className={label}>Last 4 digits</label>
                <input className={field} inputMode="numeric" maxLength={4} value={f.last4 ?? ""} onChange={(e) => set("last4", e.target.value)} />
              </div>
            </div>
            {f.role !== "allowance" && (
              <div>
                <label className={label}>Region</label>
                <ThemedSelect value={f.branch ?? ""} onChange={(e) => set("branch", e.target.value)}>
                  <option value="">Head office / none</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </ThemedSelect>
              </div>
            )}
          </div>
        )}

        {dialog?.kind === "load" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">The bank goes down and the card goes up — no expense is recorded until fuel is bought.</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Amount *</label>
                <input className={field} inputMode="decimal" value={f.amount ?? ""} onChange={(e) => set("amount", e.target.value)} />
              </div>
              <div>
                <label className={label}>Date loaded *</label>
                <input type="date" className={field} value={f.date ?? ""} onChange={(e) => set("date", e.target.value)} />
              </div>
            </div>
            <div>
              <label className={label}>From bank *</label>
              <ThemedSelect value={f.bank ?? ""} onChange={(e) => set("bank", e.target.value)}>
                <option value="">Select bank</option>
                {activeBanks.map((b) => <option key={b.id} value={b.id}>{b.bank_name} · {b.account_number}</option>)}
              </ThemedSelect>
            </div>
            <div>
              <label className={label}>Note</label>
              <input className={field} value={f.note ?? ""} onChange={(e) => set("note", e.target.value)} />
            </div>
          </div>
        )}

        {dialog?.kind === "bill" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Fuel bought on the card. It is an expense on the bill&rsquo;s date and comes off the card&rsquo;s balance (PKR {fmt(dialog.card.balance)}).
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Amount *</label>
                <input className={field} inputMode="decimal" value={f.amount ?? ""} onChange={(e) => set("amount", e.target.value)} />
              </div>
              <div>
                <label className={label}>Bill date *</label>
                <input type="date" className={field} value={f.date ?? ""} onChange={(e) => set("date", e.target.value)} />
              </div>
            </div>
            <div>
              <label className={label}>Category *</label>
              <ThemedSelect value={f.category ?? ""} onChange={(e) => set("category", e.target.value)}>
                <option value="">Select category</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </ThemedSelect>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Client (if for one)</label>
                <ThemedSelect value={f.client ?? ""} onChange={(e) => {
                  const cl = clients.find((x) => x.id === e.target.value);
                  setF((p) => ({ ...p, client: e.target.value, branch: cl?.branch_id ?? p.branch ?? "" }));
                }}>
                  <option value="">General — no client (region cost)</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </ThemedSelect>
              </div>
              <div>
                <label className={label}>Region</label>
                <ThemedSelect value={f.branch ?? ""} onChange={(e) => set("branch", e.target.value)}>
                  <option value="">Card&rsquo;s region</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </ThemedSelect>
              </div>
            </div>
            <div>
              <label className={label}>Description</label>
              <input className={field} value={f.description ?? ""} onChange={(e) => set("description", e.target.value)} placeholder="e.g. Office bike, visits to Emaar" />
            </div>
          </div>
        )}

        {dialog?.kind === "reading" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Type what the Attock portal shows. Bastion compares it with its own balance on that date; a difference turns the card red until it is explained.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Portal balance *</label>
                <input className={field} inputMode="decimal" value={f.portal ?? ""} onChange={(e) => set("portal", e.target.value)} />
              </div>
              <div>
                <label className={label}>As of *</label>
                <input type="date" className={field} value={f.date ?? ""} onChange={(e) => set("date", e.target.value)} />
              </div>
            </div>
            <div>
              <label className={label}>Note</label>
              <input className={field} value={f.note ?? ""} onChange={(e) => set("note", e.target.value)} />
            </div>
          </div>
        )}

        {dialog?.kind === "bills" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Operations&rsquo; bills, one per line. Give each a client, or leave it General for fuel that was not for one site (the office bike, a general run).
              The card holds PKR {fmt(dialog.card.balance)}.
            </p>
            <div className="flex flex-col gap-2">
              {lines.map((l, i) => {
                const upd = (patch: Partial<BillLine>) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, ...patch, err: undefined } : x)));
                return (
                  <div key={i} className={`grid grid-cols-[7.5rem_6rem_1fr_auto] gap-2 items-start ${l.done ? "opacity-50" : ""}`}>
                    <input type="date" className={field} value={l.date} disabled={l.done} onChange={(e) => upd({ date: e.target.value })} />
                    <input className={field} inputMode="decimal" placeholder="Amount" value={l.amount} disabled={l.done} onChange={(e) => upd({ amount: e.target.value })} />
                    <div className="flex flex-col gap-1 min-w-0">
                      <ThemedSelect value={l.client} disabled={l.done} onChange={(e) => upd({ client: e.target.value })}>
                        <option value="">General — no client</option>
                        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </ThemedSelect>
                      <input className={field} placeholder="Site / purpose, e.g. visit to site X" value={l.note} disabled={l.done} onChange={(e) => upd({ note: e.target.value })} />
                      {l.err && <span className="text-[11px] text-danger-700 dark:text-danger-500">{l.err}</span>}
                      {l.done && <span className="text-[11px] text-success-700 dark:text-success-500">Recorded</span>}
                    </div>
                    <button type="button" className="p-2 text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={l.done}
                      onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} title="Remove this line">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
            <button type="button" className="self-start text-sm text-brand-700 dark:text-brand-500 hover:underline"
              onClick={() => setLines((ls) => [...ls, { date: ls[ls.length - 1]?.date ?? todayISO(), amount: "", client: "", note: "" }])}>
              + Another bill
            </button>
            <p className="text-xs text-muted-foreground">
              Total {fmt(lines.filter((l) => !l.done).reduce((n, l) => n + (Number(l.amount) || 0), 0))} — each is a fuel expense on its date and comes off the card.
            </p>
          </div>
        )}

        {dialog?.kind === "book" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              Attock shows PKR {fmt(dialog.card.portal_balance)} on {fmtDate(dialog.card.reading_as_of)}; the bills entered leave Bastion at PKR {fmt(dialog.card.balance_on_reading)}.
              The <span className="font-semibold">PKR {fmt(dialog.gap)}</span> between them is fuel spent with no bill.
            </p>
            <p className="text-sm text-muted-foreground">
              Booking it writes one general expense, &ldquo;Fuel — no bill&rdquo;, on this card dated {fmtDate(dialog.card.reading_as_of)}: a cost to the card&rsquo;s region with no client.
              The card then agrees with Attock. Do this at month end, once operations has handed in every bill it can.
            </p>
          </div>
        )}

        {dialog?.kind === "reverse" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              PKR {fmt(dialog.load.amount)} loaded {fmtDate(dialog.load.loaded_on)} from {bankName.get(dialog.load.bank_account_id) ?? "the bank"} goes back to that bank.
              Refused if the card no longer holds it.
            </p>
            <div>
              <label className={label}>Why *</label>
              <input className={field} value={f.reason ?? ""} onChange={(e) => set("reason", e.target.value)} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
