import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Undo2 } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import ThemedSelect from "./ThemedSelect";
import { supabase, friendlyDbError, type BankAccount } from "../lib/supabase";

/**
 * SECURITY DEPOSITS (0533, 2026-10-21). A bid security, performance guarantee
 * or rent deposit is the company's own money held by someone else — an asset
 * (1170), never an expense going out or income coming back. Giving one moves
 * the bank down and 1170 up; its return moves the bank up and 1170 down. One
 * given before Bastion's books started moves no bank now and reaches the
 * ledger through the opening trial balance (Opening Balances prefills it).
 *
 * Every write is an RPC that moves the bank, logs it and posts the journal in
 * one transaction. Nothing here touches a balance.
 */

type Deposit = {
  id: string;
  purpose: "bid" | "performance" | "rent" | "other";
  party: string;
  instrument: "pay_order" | "cheque" | "cdr" | "other";
  reference: string | null;
  amount: number;
  given_on: string;
  given_from_bank_id: string | null;
  given_before_books: boolean;
  status: "outstanding" | "returned" | "forfeited";
  returned_on: string | null;
  returned_to_bank_id: string | null;
  notes: string | null;
};

const PURPOSE: Record<Deposit["purpose"], string> = { bid: "Bid security", performance: "Performance", rent: "Rent", other: "Other" };
const INSTRUMENT: Record<Deposit["instrument"], string> = { pay_order: "Pay order", cheque: "Cheque", cdr: "CDR", other: "Other" };

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmt = (n: number) => Math.round(n).toLocaleString();
const fmtDate = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";

type GiveForm = {
  beforeBooks: boolean;
  bankId: string;
  amount: string;
  givenOn: string;
  purpose: Deposit["purpose"];
  party: string;
  instrument: Deposit["instrument"];
  reference: string;
  notes: string;
};

const emptyGive = (): GiveForm => ({
  beforeBooks: false, bankId: "", amount: "", givenOn: todayISO(), purpose: "bid",
  party: "", instrument: "pay_order", reference: "", notes: "",
});

export default function SecurityDeposits({
  companyId, banks, canEdit, onMoved,
}: {
  companyId: string | null;
  banks: BankAccount[];
  canEdit: boolean;
  /** A bank balance moved: the page reloads its bank cards. */
  onMoved: () => void;
}) {
  const [rows, setRows] = useState<Deposit[]>([]);
  const [missing, setMissing] = useState(false);
  const [showReturned, setShowReturned] = useState(false);

  const [giveOpen, setGiveOpen] = useState(false);
  const [give, setGive] = useState<GiveForm>(emptyGive);
  const [returning, setReturning] = useState<Deposit | null>(null);
  const [retBank, setRetBank] = useState("");
  const [retOn, setRetOn] = useState(todayISO());
  const [retNotes, setRetNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    const { data, error } = await supabase.from("security_deposits").select("*")
      .eq("company_id", companyId).order("given_on", { ascending: false });
    // Before 0533 is applied the table does not exist: show nothing rather than an error.
    if (error) { setMissing(true); setRows([]); return; }
    setMissing(false);
    setRows(((data ?? []) as Deposit[]).map((d) => ({ ...d, amount: Number(d.amount) })));
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  const bankName = useMemo(() => new Map(banks.map((b) => [b.id, `${b.bank_name} · ${b.account_number}`])), [banks]);
  const activeBanks = useMemo(() => banks.filter((b) => b.active !== false && b.owner_type === "company"), [banks]);
  const outstanding = rows.filter((r) => r.status === "outstanding");
  const outstandingTotal = outstanding.reduce((s, r) => s + r.amount, 0);
  const shown = showReturned ? rows : outstanding;

  if (missing) return null;

  const submitGive = async () => {
    const amount = Number(give.amount);
    if (!(amount > 0)) return setErr("Enter the deposit amount.");
    if (!give.party.trim()) return setErr("Enter who holds the deposit — the tender authority, client or landlord.");
    if (!give.givenOn) return setErr("Enter the date it was given.");
    if (!give.beforeBooks && !give.bankId) return setErr("Choose the bank it was paid from.");
    setBusy(true); setErr(null);
    const common = {
      p_amount: amount, p_given_on: give.givenOn, p_purpose: give.purpose, p_party: give.party.trim(),
      p_instrument: give.instrument, p_reference: give.reference.trim() || null, p_notes: give.notes.trim() || null,
    };
    const { error } = give.beforeBooks
      ? await supabase.rpc("record_opening_security_deposit", { p_company_id: companyId, ...common })
      : await supabase.rpc("record_security_deposit", { p_bank_account_id: give.bankId, ...common });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    setGiveOpen(false); setGive(emptyGive());
    await load();
    if (!give.beforeBooks) onMoved();
  };

  const submitReturn = async () => {
    if (!returning) return;
    if (!retBank) return setErr("Choose the bank it came back into.");
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("return_security_deposit", {
      p_deposit_id: returning.id, p_bank_account_id: retBank, p_returned_on: retOn, p_notes: retNotes.trim() || null,
    });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    setReturning(null); setRetNotes("");
    await load();
    onMoved();
  };

  const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  const label = "block text-[11px] text-muted-foreground mb-1";

  return (
    <div className="mt-6 rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">Security deposits</div>
          <div className="text-xs text-muted-foreground">
            Bid securities and other refundable deposits — company money held elsewhere, not an expense.
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-right">
            <div className="lbl">Out with others</div>
            <div className="font-ledger text-lg font-semibold text-foreground whitespace-nowrap">
              <span className="cur">PKR</span>{fmt(outstandingTotal)}
            </div>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => { setErr(null); setGive(emptyGive()); setGiveOpen(true); }}>
              <Plus className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Give a deposit
            </Button>
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {rows.length === 0
            ? "No security deposits recorded. When you give a bid security or other refundable deposit, record it here so the bank and the books agree."
            : "Nothing outstanding — every deposit has come back."}
        </p>
      ) : (
        <div className="divide-y divide-border">
          {shown.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground truncate">
                  {d.party} <span className="text-muted-foreground font-normal">· {PURPOSE[d.purpose]}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {INSTRUMENT[d.instrument]}{d.reference ? ` ${d.reference}` : ""} · given {fmtDate(d.given_on)}
                  {d.given_before_books ? " (before Bastion)" : d.given_from_bank_id ? ` from ${bankName.get(d.given_from_bank_id) ?? "bank"}` : ""}
                  {d.status === "returned" && ` · back ${fmtDate(d.returned_on)} to ${bankName.get(d.returned_to_bank_id ?? "") ?? "bank"}`}
                </div>
              </div>
              <div className="font-ledger text-sm font-semibold text-foreground whitespace-nowrap">{fmt(d.amount)}</div>
              {d.status === "outstanding" ? (
                canEdit && (
                  <Button size="sm" variant="secondary" onClick={() => {
                    setErr(null); setReturning(d); setRetBank(d.given_from_bank_id ?? ""); setRetOn(todayISO()); setRetNotes("");
                  }}>
                    <Undo2 className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Returned
                  </Button>
                )
              ) : (
                <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full border bg-muted text-muted-foreground border-border">
                  {d.status === "returned" ? "Returned" : "Forfeited"}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {rows.some((r) => r.status !== "outstanding") && (
        <button type="button" className="w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground border-t border-border text-left"
          onClick={() => setShowReturned((v) => !v)}>
          {showReturned ? "Hide returned deposits" : `Show returned deposits (${rows.length - outstanding.length})`}
        </button>
      )}

      <Modal isOpen={giveOpen} onClose={() => setGiveOpen(false)} title="Give a security deposit" error={err} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setGiveOpen(false)}>Cancel</Button>
          <Button onClick={submitGive} disabled={busy}>{busy ? "Saving…" : "Record deposit"}</Button>
        </>}>
        <div className="flex flex-col gap-3">
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input type="checkbox" className="mt-1" checked={give.beforeBooks}
              onChange={(e) => setGive({ ...give, beforeBooks: e.target.checked, bankId: "" })} />
            <span>
              Given before Bastion&rsquo;s books started
              <span className="block text-xs text-muted-foreground">
                The money left the bank before its opening balance was taken, so no bank moves now. It goes into the opening trial balance instead.
              </span>
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Type *</label>
              <ThemedSelect value={give.purpose} onChange={(e) => setGive({ ...give, purpose: e.target.value as Deposit["purpose"] })}>
                {Object.entries(PURPOSE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </ThemedSelect>
            </div>
            <div>
              <label className={label}>Paid as *</label>
              <ThemedSelect value={give.instrument} onChange={(e) => setGive({ ...give, instrument: e.target.value as Deposit["instrument"] })}>
                {Object.entries(INSTRUMENT).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </ThemedSelect>
            </div>
          </div>
          <div>
            <label className={label}>Held by * (tender authority, client, landlord)</label>
            <input className={field} value={give.party} onChange={(e) => setGive({ ...give, party: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Amount *</label>
              <input className={field} inputMode="decimal" value={give.amount} onChange={(e) => setGive({ ...give, amount: e.target.value })} />
            </div>
            <div>
              <label className={label}>Date given *</label>
              <input type="date" className={field} value={give.givenOn} onChange={(e) => setGive({ ...give, givenOn: e.target.value })} />
            </div>
          </div>
          {!give.beforeBooks && (
            <div>
              <label className={label}>Paid from bank *</label>
              <ThemedSelect value={give.bankId} onChange={(e) => setGive({ ...give, bankId: e.target.value })}>
                <option value="">Select bank</option>
                {activeBanks.map((b) => <option key={b.id} value={b.id}>{b.bank_name} · {b.account_number}</option>)}
              </ThemedSelect>
            </div>
          )}
          <div>
            <label className={label}>Reference (pay order / cheque no., tender no.)</label>
            <input className={field} value={give.reference} onChange={(e) => setGive({ ...give, reference: e.target.value })} />
          </div>
          <div>
            <label className={label}>Notes</label>
            <input className={field} value={give.notes} onChange={(e) => setGive({ ...give, notes: e.target.value })} />
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!returning} onClose={() => setReturning(null)} title="Deposit returned" error={err} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setReturning(null)}>Cancel</Button>
          <Button onClick={submitReturn} disabled={busy}>{busy ? "Saving…" : `Record PKR ${returning ? fmt(returning.amount) : ""} back`}</Button>
        </>}>
        {returning && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              {PURPOSE[returning.purpose]} from <span className="font-medium">{returning.party}</span>, PKR {fmt(returning.amount)}, given {fmtDate(returning.given_on)}.
              The bank goes up and the deposit is cleared — no income is recorded.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Deposited into *</label>
                <ThemedSelect value={retBank} onChange={(e) => setRetBank(e.target.value)}>
                  <option value="">Select bank</option>
                  {activeBanks.map((b) => <option key={b.id} value={b.id}>{b.bank_name} · {b.account_number}</option>)}
                </ThemedSelect>
              </div>
              <div>
                <label className={label}>Date deposited *</label>
                <input type="date" className={field} value={retOn} onChange={(e) => setRetOn(e.target.value)} />
              </div>
            </div>
            <div>
              <label className={label}>Notes</label>
              <input className={field} value={retNotes} onChange={(e) => setRetNotes(e.target.value)} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
