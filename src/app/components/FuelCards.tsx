import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Plus, Fuel, Receipt, Gauge, Undo2, ListPlus, Trash2, Pencil, HelpCircle } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import ThemedSelect from "./ThemedSelect";
import { supabase, friendlyDbError, type BankAccount } from "../lib/supabase";
import FuelCardStatement from "./FuelCardStatement";

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
/** 0572: a top-up comes from a bank or from a custodian's cash — exactly one. */
type Load = { id: string; fuel_card_id: string; bank_account_id: string | null; custodian_location_id: string | null; amount: number; loaded_on: string; note: string | null };
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
  | { kind: "edit"; card: CardRow }
  | { kind: "delete"; card: CardRow }
  | { kind: "partnerLoad"; card: CardRow; partnerId: string }
  | { kind: "min"; card: CardRow }
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
  // 2026-10-28: the monthly FUEL SHEET is written here, not in Excel — a line
  // per trip with its route and km; the amount is km × petrol price ÷ km per
  // litre, the sheet's own formula (its "Avg" column is price ÷ 30). A line
  // with no km takes a typed amount (a plain bill).
  type BillLine = { date: string; amount: string; client: string; note: string; km: string; price: string; err?: string; done?: boolean };
  const [lines, setLines] = useState<BillLine[]>([]);
  const [missing, setMissing] = useState(false);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [branches, setBranches] = useState<Opt[]>([]);
  const [employees, setEmployees] = useState<Opt[]>([]);
  // 0554: who holds each card (an office-staff employee, or a partner for an allowance card).
  const [partners, setPartners] = useState<Opt[]>([]);
  const [holders, setHolders] = useState<Map<string, { employee: string | null; partner: string | null; notes: string | null; min: number | null; avg: number | null }>>(new Map());
  // 0582: bumped after anything that moves a card, so its open statement re-reads.
  const [stmtKey, setStmtKey] = useState(0);
  // 0572: cash custodians a card can be topped up from.
  const [custodians, setCustodians] = useState<Opt[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [clients, setClients] = useState<(Opt & { branch_id: string | null })[]>([]);
  const [categories, setCategories] = useState<Opt[]>([]);

  // one form, reset per dialog
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const load = useCallback(async () => {
    if (!companyId) return;
    const [c, l] = await Promise.all([
      supabase.rpc("fuel_card_balances", { p_company_id: companyId }),
      supabase.from("fuel_card_loads").select("id, fuel_card_id, bank_account_id, custodian_location_id, amount, loaded_on, note")
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
    const { data: hx } = await supabase.from("fuel_cards").select("id, holder_employee_id, holder_partner_id, notes, min_balance, km_per_litre").eq("company_id", companyId);
    setHolders(new Map(((hx ?? []) as { id: string; holder_employee_id: string | null; holder_partner_id: string | null; notes: string | null; min_balance: number | null; km_per_litre: number | null }[])
      .map((x) => [x.id, { employee: x.holder_employee_id, partner: x.holder_partner_id, notes: x.notes,
        min: x.min_balance == null ? null : Number(x.min_balance), avg: x.km_per_litre == null ? null : Number(x.km_per_litre) }])));
    setStmtKey((k) => k + 1);
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
      // Only office staff hold fuel cards (0554).
      supabase.from("employees").select("id, full_name, lifecycle_state").eq("company_id", companyId).eq("category", "office_staff").order("full_name"),
      supabase.from("clients").select("id, name, branch_id").eq("company_id", companyId).order("name"),
      supabase.from("expense_categories").select("id, name").eq("company_id", companyId).order("name"),
      supabase.from("partners").select("id, name").eq("company_id", companyId).eq("is_active", true).order("name"),
      supabase.from("cash_locations").select("id, name, custodian_employee_id, custodian_partner_id, is_active").eq("company_id", companyId).order("name"),
    ]).then(([b, e, cl, cat, pt, loc]) => {
      setCustodians(((loc.data ?? []) as { id: string; name: string; custodian_employee_id: string | null; custodian_partner_id: string | null; is_active: boolean | null }[])
        .filter((x) => x.is_active !== false && (x.custodian_employee_id || x.custodian_partner_id)).map((x) => ({ id: x.id, name: x.name })));
      setPartners((pt.data ?? []) as Opt[]);
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
  const custodianName = useMemo(() => new Map(custodians.map((x) => [x.id, x.name])), [custodians]);
  const sourceOf = (l: Load) => (l.custodian_location_id ? `${custodianName.get(l.custodian_location_id) ?? "custodian"}'s cash` : bankName.get(l.bank_account_id ?? "") ?? "bank");
  const floats = cards.filter((c) => c.role === "float");
  const allowances = cards.filter((c) => c.role === "allowance");
  const floatTotal = floats.reduce((s, c) => s + c.balance, 0);
  const fuelCategory = categories.find((c) => /fuel/i.test(c.name))?.id ?? "";
  /** A sheet line's amount: from km and price when both are given, else as typed. */
  const kmpl = Number(f.kmpl) > 0 ? Number(f.kmpl) : 30;
  const lineAmount = (l: BillLine) => {
    const km = Number(l.km), pr = Number(l.price);
    return km > 0 && pr > 0 ? Math.round((km * pr / kmpl) * 100) / 100 : Number(l.amount) || 0;
  };

  if (missing) return null;

  const open = (d: Dialog, init: Record<string, string> = {}) => { setErr(null); setF(init); setDialog(d); };
  const close = () => { if (!busy) setDialog(null); };
  const openEdit = (c: CardRow) => {
    const h = holders.get(c.fuel_card_id);
    open({ kind: "edit", card: c }, {
      label: c.label, last4: c.card_last4 ?? "", branch: c.branch_id ?? "", notes: h?.notes ?? "",
      holder: h?.partner ? `p:${h.partner}` : h?.employee ? `e:${h.employee}` : "",
    });
  };
  const setDialogPartnerLoad = (c: CardRow, partnerId: string) => open({ kind: "partnerLoad", card: c, partnerId }, { date: todayISO() });
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
    // f.holder is "e:<employee id>" or "p:<partner id>" (0554).
    const holderEmp = f.holder?.startsWith("e:") ? f.holder.slice(2) : null;
    const holderPartner = f.holder?.startsWith("p:") ? f.holder.slice(2) : null;
    if (dialog.kind === "register") {
      const role = f.role === "allowance" ? "allowance" : "float";
      if (!f.label?.trim()) return setErr("Name the card.");
      if (role === "allowance" && !f.holder) return setErr("Choose who holds the card.");
      if (f.last4 && !/^\d{4}$/.test(f.last4)) return setErr("Last four digits only — four numbers.");
      return run(() => supabase.rpc("register_fuel_card", {
        p_role: role, p_label: f.label.trim(), p_branch_id: f.branch || null,
        p_holder_employee_id: holderEmp, p_card_last4: f.last4 || null,
        p_provider: f.provider?.trim() || "Attock", p_notes: f.notes?.trim() || null,
        p_holder_partner_id: role === "allowance" ? holderPartner : null,
      }), false);
    }
    if (dialog.kind === "edit") {
      if (!f.label?.trim()) return setErr("Name the card.");
      if (f.last4 && !/^\d{4}$/.test(f.last4)) return setErr("Last four digits only — four numbers.");
      if (dialog.card.role === "allowance" && !f.holder) return setErr("Choose who holds the card.");
      return run(() => supabase.rpc("update_fuel_card", {
        p_fuel_card_id: dialog.card.fuel_card_id, p_label: f.label.trim(), p_card_last4: f.last4 || null,
        p_holder_employee_id: holderEmp, p_holder_partner_id: dialog.card.role === "allowance" ? holderPartner : null,
        p_branch_id: f.branch || null, p_notes: f.notes?.trim() || null,
      }), false);
    }
    if (dialog.kind === "delete") {
      return run(() => supabase.rpc("delete_fuel_card", { p_fuel_card_id: dialog.card.fuel_card_id }), false);
    }
    if (dialog.kind === "partnerLoad") {
      // A partner's card: the load is a drawing on that partner (DECIDED 2026-10-23).
      if (!(amount > 0)) return setErr("Enter the amount loaded.");
      if (!f.bank) return setErr("Choose the bank it was loaded from.");
      return run(() => supabase.rpc("record_partner_entry", {
        p_partner_id: dialog.partnerId, p_date: f.date || todayISO(), p_type: "DRAWING",
        p_description: `Fuel card load — ${dialog.card.label}${dialog.card.card_last4 ? ` ••${dialog.card.card_last4}` : ""}${f.note?.trim() ? ` · ${f.note.trim()}` : ""}`,
        p_amount: amount, p_method: "BANK_TRANSFER", p_bank_account_id: f.bank, p_cash_location_id: null,
      }), true);
    }
    if (dialog.kind === "min") {
      const v = f.min?.trim() ? Number(f.min) : null;
      if (v != null && !(v >= 0)) return setErr("Enter the minimum as a number, or leave it empty for none.");
      const a = f.avg?.trim() ? Number(f.avg) : null;
      if (a != null && !(a > 0)) return setErr("Enter the average (km per litre) as a number above zero, or leave it empty.");
      // 0582: the vehicle's average, which a trip by km uses.
      return run(async () => {
        const r1 = await supabase.rpc("set_fuel_card_min_balance", { p_fuel_card_id: dialog.card.fuel_card_id, p_min_balance: v });
        if (r1.error) return r1;
        return supabase.rpc("set_fuel_card_average", { p_fuel_card_id: dialog.card.fuel_card_id, p_km_per_litre: a });
      }, false);
    }
    if (dialog.kind === "load") {
      if (!(amount > 0)) return setErr("Enter the amount topped up.");
      if ((f.source ?? "cash") === "cash") {
        // 0572: cash → card. The custodian's cash goes down, the card goes up; no expense.
        if (!f.custodian) return setErr("Choose whose cash paid for the top-up.");
        return run(() => supabase.rpc("load_fuel_card_from_cash", {
          p_fuel_card_id: dialog.card.fuel_card_id, p_custodian_location_id: f.custodian, p_amount: amount,
          p_loaded_on: f.date || todayISO(), p_note: f.note?.trim() || null,
        }), true);
      }
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
      const todo = lines.map((l, i) => ({ l, i })).filter(({ l }) => !l.done && (l.amount || l.note || l.km));
      if (todo.length === 0) return setErr("Type at least one trip.");
      setBusy(true); setErr(null);
      const next = [...lines];
      // One at a time, oldest first, so the card's balance check sees each bill in turn.
      for (const { l, i } of [...todo].sort((a, b) => a.l.date.localeCompare(b.l.date))) {
        const amt = lineAmount(l);
        if (!(amt > 0)) { next[i] = { ...l, err: "Enter the km and petrol price, or the amount." }; continue; }
        if (!l.note.trim()) { next[i] = { ...l, err: "Enter the route." }; continue; }
        // 0582: a trip — by km ÷ average × price, or the amount spent.
        const byKm = Number(l.km) > 0 && Number(l.price) > 0;
        const { error } = await supabase.rpc("record_fuel_trip", {
          p_fuel_card_id: dialog.card.fuel_card_id, p_trip_date: l.date || todayISO(), p_route: l.note.trim(),
          p_client_id: l.client || null,
          p_amount: byKm ? null : amt, p_km: byKm ? Number(l.km) : null,
          p_km_per_litre: byKm ? kmpl : null, p_petrol_price: byKm ? Number(l.price) : null, p_purpose: null,
        });
        next[i] = error ? { ...l, err: friendlyDbError(error) } : { ...l, err: undefined, done: true };
      }
      setLines(next);
      setBusy(false);
      await load();
      if (billsOnly) onMoved();
      if (next.every((l) => l.done || (!l.amount && !l.note && !l.km))) setDialog(null);
      else setErr("Some trips were not recorded — each says why. The rest are in.");
      return;
    }
    if (dialog.kind === "book") {
      // 0582: both ways — fuel with no trip is booked; trips over Attock are scaled to it.
      return run(() => supabase.rpc("fuel_card_match_attock", { p_fuel_card_id: dialog.card.fuel_card_id }), false);
    }
    if (dialog.kind === "reverse") {
      if ((f.reason ?? "").trim().length < 5) return setErr("Say why this load is being reversed.");
      return run(() => supabase.rpc("reverse_fuel_card_load", { p_load_id: dialog.load.id, p_reason: f.reason.trim() }), true);
    }
  };

  const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  // Office staff hold cards; a partner can hold an allowance card (0554).
  const holderPicker = (role: "float" | "allowance") => (
    <div>
      <label className="block text-[11px] text-muted-foreground mb-1">{role === "allowance" ? "Held by *" : "Carried by (office staff)"}</label>
      <ThemedSelect value={f.holder ?? ""} onChange={(e) => set("holder", e.target.value)}>
        <option value="">{role === "allowance" ? "Select person" : "Nobody in particular"}</option>
        {employees.map((e) => <option key={e.id} value={`e:${e.id}`}>{e.name} — office staff</option>)}
        {role === "allowance" && partners.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name} — partner</option>)}
      </ThemedSelect>
    </div>
  );
  const label = "block text-[11px] text-muted-foreground mb-1";

  const status = (c: CardRow) => {
    if (c.balance < -0.005) return { ok: false, text: "Bastion holds this card below zero" };
    if (!c.reading_as_of) return { ok: false, text: "Never tallied with Attock" };
    if (Math.abs(c.difference ?? 0) > 0.5)
      return { ok: false, text: `Attock ${fmt(c.portal_balance)} on ${fmtDate(c.reading_as_of)} · Bastion ${fmt(c.balance_on_reading)}` };
    return { ok: true, text: `Tallied with Attock on ${fmtDate(c.reading_as_of)}` };
  };

  const title =
    dialog?.kind === "register" ? "Register a fuel card"
    : dialog?.kind === "load" ? `Top up — ${dialog.card.label}`
    : dialog?.kind === "min" ? `Settings — ${dialog.card.label}`
    : dialog?.kind === "bill" ? `Fuel bill — ${dialog.card.label}`
    : dialog?.kind === "reading" ? `Tally with Attock — ${dialog.card.label}`
    : dialog?.kind === "edit" ? `Edit card — ${dialog.card.label}`
    : dialog?.kind === "delete" ? `Delete card — ${dialog.card.label}`
    : dialog?.kind === "partnerLoad" ? `Load (partner drawing) — ${dialog.card.label}`
    : dialog?.kind === "reverse" ? `Reverse load — ${dialog.card.label}`
    : dialog?.kind === "bills" ? `Add trips — ${dialog.card.label}`
    : dialog?.kind === "book" ? `Match Attock — ${dialog.card.label}` : "";

  return (
    <div className="mt-6 rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{billsOnly ? "Fuel bills" : "Fuel cards"}</div>
          <div className="text-xs text-muted-foreground">
            {billsOnly
              ? "Record each fuel bill against the card it was paid with — with its client, or as a general bill when it was not for one site."
              : <>Company float cards hold company money; allowance cards are personal. Only office staff and partners hold cards.</>}
          </div>
          {!billsOnly && (
            <button type="button" onClick={() => setShowHelp((v) => !v)} className="mt-1 inline-flex items-center gap-1 text-xs text-brand-700 dark:text-brand-500 hover:underline">
              <HelpCircle className="w-3.5 h-3.5" /> {showHelp ? "Hide" : "How fuel cards work"}
            </button>
          )}
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

      {showHelp && !billsOnly && (
        <div className="px-4 py-3 border-b border-border bg-muted/30 text-sm text-foreground grid gap-2 md:grid-cols-2">
          <div>
            <div className="font-semibold mb-1">Company float card</div>
            <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
              <li><span className="text-foreground">Balance</span> — company money sitting on the card. It is an asset, not an expense, until fuel is bought.</li>
              <li><span className="text-foreground">Top up</span> — money moved from someone&rsquo;s cash or a bank onto the card. The cash or bank goes down, the card goes up; no expense yet.</li>
              <li><span className="text-foreground">Bill / Enter bills</span> — fuel bought with the card, from the bills staff hand in. Each is a fuel expense on its date (for a client, or general) and comes off the card.</li>
              <li><span className="text-foreground">Tally with Attock</span> — type the balance the Attock portal shows. Bastion compares it with its own balance for that day: green when they agree, red when not.</li>
              <li><span className="text-foreground">No bill yet</span> — Attock shows more spent than the bills entered: fuel used without a bill. Chase the bills; whatever is still missing at month end, <span className="text-foreground">Book unbilled</span> records as one general fuel expense so the card agrees again.</li>
            </ul>
          </div>
          <div>
            <div className="font-semibold mb-1">Allowance card</div>
            <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
              <li>A person&rsquo;s own card — no balance is kept for it here.</li>
              <li><span className="text-foreground">Office staff</span> (e.g. CFO): payroll pays the fixed fuel allowance onto the card.</li>
              <li><span className="text-foreground">Partners</span> (CEO, MD): each load is a drawing on that partner — <span className="text-foreground">Load (drawing)</span> takes it from a bank and charges the partner&rsquo;s account.</li>
            </ul>
            <div className="font-semibold mt-3 mb-1">Cards</div>
            <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
              <li><span className="text-foreground">Edit</span> any card&rsquo;s name, number or holder. <span className="text-foreground">Delete</span> only a card nothing has been recorded on; a used card is deactivated instead.</li>
              <li>Only the last four digits are kept — never the PIN.</li>
            </ul>
          </div>
        </div>
      )}

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
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenCard(openCard === c.fuel_card_id ? null : c.fuel_card_id)}>
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
                        {(() => {
                          // 0572: office petrol is on the card only, so it must not run dry.
                          const min = holders.get(c.fuel_card_id)?.min ?? null;
                          if (min == null) return !billsOnly ? <div className="text-[11px] text-muted-foreground whitespace-nowrap">no minimum set</div> : null;
                          return c.balance < min - 0.005
                            ? <div className="text-[11px] font-semibold text-danger-700 dark:text-danger-500 whitespace-nowrap">Below minimum {fmt(min)} — top up {fmt(min - c.balance)}</div>
                            : <div className="text-[11px] text-muted-foreground whitespace-nowrap">minimum {fmt(min)}</div>;
                        })()}
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
                              <span className="text-danger-700 dark:text-danger-500 font-semibold">Trips exceed Attock by {fmt(-gap)} to {fmtDate(c.reading_as_of)}</span>
                            )}
                            {gap != null && Math.abs(gap) > 0.5 && canEdit && !billsOnly && c.is_active && (
                              <button type="button" className="text-brand-700 dark:text-brand-500 hover:underline font-medium"
                                onClick={() => open({ kind: "book", card: c, gap })}>Match Attock</button>
                            )}
                          </div>
                        );
                      })()}
                      {canEdit && c.is_active && (
                        <div className="flex flex-wrap gap-2">
                          {!billsOnly && (
                            <Button size="sm" variant="secondary" onClick={() => open({ kind: "load", card: c }, { date: todayISO(), source: "cash" })}>
                              <Fuel className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Top up
                            </Button>
                          )}
                          <Button size="sm" variant="secondary" onClick={() => {
                            setLines(Array.from({ length: 5 }, () => ({ date: todayISO(), amount: "", client: "", note: "", km: "", price: "" })));
                            open({ kind: "bills", card: c }, { kmpl: String(holders.get(c.fuel_card_id)?.avg ?? 30) });
                            setOpenCard(c.fuel_card_id);
                          }}>
                            <ListPlus className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Add trips
                          </Button>
                          {!billsOnly && (
                            <Button size="sm" variant="secondary" onClick={() => open({ kind: "reading", card: c }, { date: todayISO() })}>
                              <Gauge className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Tally with Attock
                            </Button>
                          )}
                          {!billsOnly && (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => open({ kind: "min", card: c }, {
                                min: holders.get(c.fuel_card_id)?.min != null ? String(holders.get(c.fuel_card_id)?.min) : "",
                                avg: holders.get(c.fuel_card_id)?.avg != null ? String(holders.get(c.fuel_card_id)?.avg) : "",
                              })}>Settings</Button>
                              <Button size="sm" variant="ghost" onClick={() => openEdit(c)}><Pencil className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} /> Edit</Button>
                              <Button size="sm" variant="ghost" onClick={() => open({ kind: "delete", card: c })}><Trash2 className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} /> Delete</Button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    {openCard === c.fuel_card_id && (
                      <div className="px-4 pb-3 flex flex-col gap-3">
                        {/* 0582: the month's trips and top-ups with the running balance. */}
                        <FuelCardStatement card={c} canEdit={canEdit} refreshKey={stmtKey}
                          onChanged={() => { void load(); if (billsOnly) onMoved(); }} />
                        {billsOnly ? null : cardLoads.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No top-ups yet.</p>
                        ) : (
                          <ul className="text-xs divide-y divide-border rounded-lg border border-border">
                            {cardLoads.map((l) => (
                              <li key={l.id} className="flex items-center gap-3 px-3 py-1.5">
                                <span className="text-muted-foreground whitespace-nowrap">{fmtDate(l.loaded_on)}</span>
                                <span className="text-muted-foreground truncate flex-1">from {sourceOf(l)}{l.note ? ` · ${l.note}` : ""}</span>
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
                        <p className="text-[11px] text-muted-foreground">Each trip is a fuel expense paid by &ldquo;Card&rdquo; — it shows in Expenses and in the client&rsquo;s costs.</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!billsOnly && allowances.length > 0 && (
            <div className="border-t border-border">
              <div className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Allowance cards — personal, no balance kept</div>
              <div className="divide-y divide-border">
                {allowances.map((c) => {
                  const h = holders.get(c.fuel_card_id);
                  return (
                  <div key={c.fuel_card_id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm ${c.is_active ? "" : "opacity-60"}`}>
                    <span className="text-foreground font-medium">{c.label}</span>
                    <span className="text-muted-foreground truncate flex-1 min-w-0">
                      {c.holder_name ?? "—"}{h?.partner ? " · partner" : " · office staff"} · {c.provider}{c.card_last4 ? ` ••${c.card_last4}` : ""}
                    </span>
                    {canEdit && h?.partner && c.is_active && (
                      <Button size="sm" variant="secondary" onClick={() => setDialogPartnerLoad(c, h.partner!)}>
                        <Fuel className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} /> Load (drawing)
                      </Button>
                    )}
                    {canEdit && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(c)}><Pencil className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} /> Edit</Button>
                        <Button size="sm" variant="ghost" onClick={() => open({ kind: "delete", card: c })}><Trash2 className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} /> Delete</Button>
                      </>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      <Modal isOpen={!!dialog} onClose={close} title={title} error={err} onDismissError={() => setErr(null)} size={dialog?.kind === "bills" ? "lg" : "md"}
        footer={<>
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : dialog?.kind === "reverse" ? "Reverse load" : dialog?.kind === "bills" ? "Record trips" : dialog?.kind === "book" ? "Match it" : dialog?.kind === "delete" ? "Delete card" : dialog?.kind === "partnerLoad" ? "Record drawing" : "Save"}</Button>
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
                ? "A person's own card. Office staff: payroll pays the fixed allowance onto it. Partner: each load is a drawing on him. No balance is kept."
                : "The company's money on a card. Loads add to it, fuel bills spend it, and the Attock portal balance is checked against it."}
            </p>
            <div>
              <label className={label}>Name *</label>
              <input className={field} value={f.label ?? ""} onChange={(e) => set("label", e.target.value)}
                placeholder={f.role === "allowance" ? "e.g. Shayan — fuel" : "e.g. Office bike — ISB"} />
            </div>
            {holderPicker(f.role === "allowance" ? "allowance" : "float")}
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

        {dialog?.kind === "edit" && (
          <div className="flex flex-col gap-3">
            <div>
              <label className={label}>Name *</label>
              <input className={field} value={f.label ?? ""} onChange={(e) => set("label", e.target.value)} />
            </div>
            {holderPicker(dialog.card.role)}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Last 4 digits</label>
                <input className={field} inputMode="numeric" maxLength={4} value={f.last4 ?? ""} onChange={(e) => set("last4", e.target.value)} />
              </div>
              <div>
                <label className={label}>Region</label>
                <ThemedSelect value={f.branch ?? ""} onChange={(e) => set("branch", e.target.value)}>
                  <option value="">Keep as is</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </ThemedSelect>
              </div>
            </div>
            <div>
              <label className={label}>Note</label>
              <input className={field} value={f.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
            </div>
          </div>
        )}

        {dialog?.kind === "delete" && (
          <p className="text-sm text-foreground">
            Delete <span className="font-semibold">{dialog.card.label}</span>{dialog.card.card_last4 ? ` (••${dialog.card.card_last4})` : ""}? Only a card nothing has been recorded on can be deleted —
            if it has been loaded, billed, tallied or paid onto, deactivate it instead.
          </p>
        )}

        {dialog?.kind === "partnerLoad" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Money put on {dialog.card.holder_name ?? "the partner"}&rsquo;s card is a drawing on him: the bank goes down and his partner account is charged. No balance is kept on the card.
            </p>
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

        {dialog?.kind === "load" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">The cash or bank goes down and the card goes up — a top-up is not an expense. The fuel becomes an expense as it is billed on the card.</p>
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
              <label className={label}>Paid from *</label>
              <ThemedSelect value={f.source ?? "cash"} onChange={(e) => set("source", e.target.value)}>
                <option value="cash">Cash — someone's custody</option>
                <option value="bank">Bank</option>
              </ThemedSelect>
            </div>
            {(f.source ?? "cash") === "cash" ? (
              <div>
                <label className={label}>Whose cash *</label>
                <ThemedSelect value={f.custodian ?? ""} onChange={(e) => set("custodian", e.target.value)}>
                  <option value="">Select person</option>
                  {custodians.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </ThemedSelect>
              </div>
            ) : (
              <div>
                <label className={label}>From bank *</label>
                <ThemedSelect value={f.bank ?? ""} onChange={(e) => set("bank", e.target.value)}>
                  <option value="">Select bank</option>
                  {activeBanks.map((b) => <option key={b.id} value={b.id}>{b.bank_name} · {b.account_number}</option>)}
                </ThemedSelect>
              </div>
            )}
            <div>
              <label className={label}>Note</label>
              <input className={field} value={f.note ?? ""} onChange={(e) => set("note", e.target.value)} />
            </div>
          </div>
        )}

        {dialog?.kind === "min" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Office petrol is paid on the card only, so the card must not run dry. Below this figure the card is flagged for a top-up. Leave it empty for no minimum.
            </p>
            <div>
              <label className={label}>Minimum balance (PKR)</label>
              <input className={field} inputMode="decimal" value={f.min ?? ""} onChange={(e) => set("min", e.target.value)} />
            </div>
            <div>
              <label className={label}>Vehicle average (km per litre)</label>
              <input className={field} inputMode="decimal" value={f.avg ?? ""} onChange={(e) => set("avg", e.target.value)} />
              <p className="text-[11px] text-muted-foreground mt-1">A trip entered by km is km ÷ this average × the petrol price that day.</p>
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
              Open the Attock portal and type the balance it shows for this card, with the date. Bastion compares it with its own balance on that date
              (PKR {fmt(dialog.card.balance)} today): when they agree the card shows green; when Attock shows less, the difference is fuel used without a bill yet.
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
              The month&rsquo;s fuel sheet, a line per trip: date, route, km and the petrol price that day — the amount is worked out as on the sheet.
              Give a line a client only when it is for one client; a run to several sites stays General. A plain bill with no km: type its amount.
              The card holds PKR {fmt(dialog.card.balance)}.
            </p>
            <div className="flex items-center gap-2 text-sm">
              <label className="text-muted-foreground">km per litre</label>
              <input className={`${field} w-20`} inputMode="decimal" value={f.kmpl ?? "30"} onChange={(e) => set("kmpl", e.target.value)} />
              <span className="text-xs text-muted-foreground">(the card&rsquo;s average — change it in Settings)</span>
            </div>
            <div className="hidden md:grid grid-cols-[8rem_minmax(0,1fr)_4.5rem_5.5rem_6rem_12rem_2rem] gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              <span>Date</span><span>Route</span><span>Km</span><span>Petrol price</span><span className="text-right">Amount</span><span>Client</span><span />
            </div>
            <div className="flex flex-col gap-2">
              {lines.map((l, i) => {
                const upd = (patch: Partial<BillLine>) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, ...patch, err: undefined } : x)));
                const computed = Number(l.km) > 0 && Number(l.price) > 0;
                return (
                  <div key={i} className={l.done ? "opacity-50" : ""}>
                    <div className="grid grid-cols-2 md:grid-cols-[8rem_minmax(0,1fr)_4.5rem_5.5rem_6rem_12rem_2rem] gap-2 items-center">
                      <input type="date" className={field} value={l.date} disabled={l.done} onChange={(e) => upd({ date: e.target.value })} />
                      <input className={`${field} col-span-2 md:col-span-1`} placeholder="GGS – Emaar – PCI & back" value={l.note} disabled={l.done} onChange={(e) => upd({ note: e.target.value })} />
                      <input className={field} inputMode="decimal" placeholder="km" value={l.km} disabled={l.done} onChange={(e) => upd({ km: e.target.value })} />
                      <input className={field} inputMode="decimal" placeholder="Rs/litre" value={l.price} disabled={l.done} onChange={(e) => upd({ price: e.target.value })} />
                      {computed
                        ? <span className="font-ledger text-sm text-right text-foreground pr-1">{lineAmount(l).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        : <input className={`${field} text-right`} inputMode="decimal" placeholder="Amount" value={l.amount} disabled={l.done} onChange={(e) => upd({ amount: e.target.value })} />}
                      <ThemedSelect value={l.client} disabled={l.done} onChange={(e) => upd({ client: e.target.value })}>
                        <option value="">General</option>
                        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </ThemedSelect>
                      <button type="button" className="p-2 text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={l.done}
                        onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} title="Remove this line">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    {l.err && <span className="text-[11px] text-danger-700 dark:text-danger-500">{l.err}</span>}
                    {l.done && <span className="text-[11px] text-success-700 dark:text-success-500">Recorded</span>}
                  </div>
                );
              })}
            </div>
            <button type="button" className="self-start text-sm text-brand-700 dark:text-brand-500 hover:underline"
              onClick={() => setLines((ls) => {
                // The next trip is usually the next day at the same price.
                const last = ls[ls.length - 1];
                return [...ls, { date: last?.date ?? todayISO(), amount: "", client: "", note: "", km: "", price: last?.price ?? "" }];
              })}>
              + Another line
            </button>
            {(() => {
              const open = lines.filter((l) => !l.done);
              const total = open.reduce((n, l) => n + lineAmount(l), 0);
              const km = open.reduce((n, l) => n + (Number(l.km) || 0), 0);
              return (
                <p className="text-xs text-muted-foreground">
                  {km ? `${km.toLocaleString()} km · ` : ""}Total <span className="font-ledger text-foreground">{total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  {" "}— each line is a fuel expense on its date and comes off the card{total > dialog.card.balance + 0.005 ? <span className="text-danger-700 dark:text-danger-500 font-semibold"> · more than the card holds — top it up first</span> : null}.
                </p>
              );
            })()}
          </div>
        )}

        {dialog?.kind === "book" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              Attock shows PKR {fmt(dialog.card.portal_balance)} on {fmtDate(dialog.card.reading_as_of)}; the trips entered leave Bastion at PKR {fmt(dialog.card.balance_on_reading)}.
            </p>
            <p className="text-sm text-muted-foreground">
              {dialog.gap > 0
                ? <>Attock shows <span className="font-semibold text-foreground">PKR {fmt(dialog.gap)}</span> more spent than the trips. Matching books it as one general expense, &ldquo;Fuel — no bill&rdquo;, dated {fmtDate(dialog.card.reading_as_of)}. Enter any trips still missing first.</>
                : <>The trips come to <span className="font-semibold text-foreground">PKR {fmt(-dialog.gap)}</span> more than Attock charged — the sheet&rsquo;s estimate over the actual fill-ups. Matching scales the trips since the previous tally down, each in proportion, to what Attock charged; every client keeps its share.</>}
              {" "}The card then agrees with Attock.
            </p>
          </div>
        )}

        {dialog?.kind === "reverse" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              PKR {fmt(dialog.load.amount)} loaded {fmtDate(dialog.load.loaded_on)} from {sourceOf(dialog.load)} goes back there.
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
