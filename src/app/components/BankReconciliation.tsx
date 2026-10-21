import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Scale } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import ThemedSelect from "./ThemedSelect";
import { supabase, friendlyDbError, type BankAccount } from "../lib/supabase";

/**
 * BANK RECONCILIATION (0534, 2026-10-21). "On <statement date> the bank said X
 * and Bastion said Y", stamped with the system time it was confirmed. Every
 * movement ENTERED after that stamp is listed apart under the bank — backdated
 * ones included, because the question is "what changed since I last checked",
 * and entry time is the only thing that answers it. A leftover difference can
 * be parked in 1190 Bank Suspense and cleared once its cause is recorded.
 */

type Recon = {
  id: string;
  bank_account_id: string;
  statement_date: string;
  statement_balance: number;
  book_balance: number;
  difference: number;
  posted_to_suspense: boolean;
  notes: string | null;
  reconciled_at: string;
  cleared_at: string | null;
  clear_note: string | null;
};

type Movement = { id: string; bank_account_id: string; kind: string; account_delta: number; description: string | null; created_at: string };

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))}`;
const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const fmtStamp = (d: string) => new Date(d).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
/** A statement figure as typed: "2,368,041.00", "PKR 2368041" and " 2368041 " all read the same. */
const parseAmount = (v: string): number | null => {
  const t = v.replace(/pkr/i, "").replace(/[,\s]/g, "");
  if (t === "" || !/^-?\d*\.?\d+$/.test(t)) return null;
  return Number(t);
};
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function BankReconciliation({
  companyId, banks, canEdit, onMoved,
}: {
  companyId: string | null;
  banks: BankAccount[];
  canEdit: boolean;
  /** A balance or a tally changed: the page reloads its bank cards. */
  onMoved: () => void;
}) {
  const [recons, setRecons] = useState<Recon[]>([]);
  const [since, setSince] = useState<Map<string, Movement[]>>(new Map());
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const [form, setForm] = useState<{ bankId: string; date: string; balance: string; post: boolean; notes: string } | null>(null);
  const [clearing, setClearing] = useState<Recon | null>(null);
  const [clearNote, setClearNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const companyBanks = useMemo(() => banks.filter((b) => b.owner_type === "company" && b.active !== false), [banks]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const { data, error } = await supabase.from("bank_reconciliations").select("*")
      .eq("company_id", companyId).order("reconciled_at", { ascending: false });
    // Before 0534 is applied the table does not exist: show nothing.
    if (error) { setMissing(true); return; }
    setMissing(false);
    const rows = ((data ?? []) as Recon[]).map((r) => ({
      ...r, statement_balance: Number(r.statement_balance), book_balance: Number(r.book_balance), difference: Number(r.difference),
    }));
    setRecons(rows);

    // Entered since each bank's last reconciliation. One read per reconciled bank;
    // a bank never reconciled has no "since".
    const last = new Map<string, Recon>();
    for (const r of rows) if (!last.has(r.bank_account_id)) last.set(r.bank_account_id, r);
    const m = new Map<string, Movement[]>();
    await Promise.all([...last.values()].map(async (r) => {
      const { data: mv } = await supabase.from("bank_transactions")
        .select("id, bank_account_id, kind, account_delta, description, created_at")
        .eq("bank_account_id", r.bank_account_id).gt("created_at", r.reconciled_at)
        .neq("account_delta", 0).order("created_at", { ascending: true });
      m.set(r.bank_account_id, ((mv ?? []) as Movement[]).map((x) => ({ ...x, account_delta: Number(x.account_delta) })));
    }));
    setSince(m);
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  if (missing || companyBanks.length === 0) return null;

  const lastFor = (bankId: string) => recons.find((r) => r.bank_account_id === bankId);
  const parked = recons.filter((r) => r.posted_to_suspense && !r.cleared_at);
  const bankName = (id: string) => companyBanks.find((b) => b.id === id)?.bank_name ?? banks.find((b) => b.id === id)?.bank_name ?? "Bank";

  const formBank = form ? companyBanks.find((b) => b.id === form.bankId) : undefined;
  const formAmount = form ? parseAmount(form.balance) : null;
  const formDiff = formBank && formAmount != null ? formAmount - Number(formBank.balance) : null;

  const submit = async () => {
    if (!form) return;
    if (!form.bankId) return setErr("Choose the bank.");
    if (formAmount == null) return setErr("Enter the balance the statement shows, as a number (commas are fine).");
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("reconcile_bank", {
      p_bank_account_id: form.bankId, p_statement_date: form.date, p_statement_balance: formAmount,
      p_post_difference: form.post, p_notes: form.notes.trim() || null,
    });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    setForm(null);
    await load();
    // Always: the bank cards show "Tallied to …", which changes even when no money moved.
    onMoved();
  };

  const submitClear = async () => {
    if (!clearing) return;
    if (!clearNote.trim()) return setErr("Say what the difference turned out to be.");
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("clear_bank_suspense", { p_reconciliation_id: clearing.id, p_note: clearNote.trim() });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    setClearing(null); setClearNote("");
    await load();
    onMoved();
  };

  const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  const label = "block text-[11px] text-muted-foreground mb-1";

  return (
    <div className="mt-6 rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">Reconciliation</div>
          <div className="text-xs text-muted-foreground">
            When each bank last agreed with its statement, and everything entered since — backdated entries included.
          </div>
        </div>
        {canEdit && (
          <Button size="sm" className="ml-auto" onClick={() => {
            setErr(null); setForm({ bankId: companyBanks[0]?.id ?? "", date: todayISO(), balance: "", post: true, notes: "" });
          }}>
            <Scale className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Reconcile a bank
          </Button>
        )}
      </div>

      {parked.length > 0 && (
        <div className="px-4 py-3 border-b border-border bg-warning-50">
          <div className="text-xs font-semibold text-warning-700 dark:text-warning-500 mb-1">In suspense — not yet explained</div>
          {parked.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm py-1">
              <span className="text-foreground">{bankName(r.bank_account_id)} · {fmtDate(r.statement_date)}</span>
              <span className="font-ledger font-semibold text-foreground">{signed(r.difference)}</span>
              {canEdit && (
                <Button size="sm" variant="secondary" className="ml-auto" onClick={() => { setErr(null); setClearNote(""); setClearing(r); }}>
                  Found it — clear
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="divide-y divide-border">
        {companyBanks.map((b) => {
          const last = lastFor(b.id);
          const mv = since.get(b.id) ?? [];
          const net = mv.reduce((s, x) => s + x.account_delta, 0);
          const isOpen = open.has(b.id);
          return (
            <div key={b.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">{b.bank_name} <span className="text-muted-foreground font-normal">· {b.account_number}</span></div>
                  <div className="text-xs text-muted-foreground">
                    {last ? (
                      <>
                        {Math.abs(last.difference) < 0.005 || last.posted_to_suspense
                          ? <CheckCircle2 className="inline w-3.5 h-3.5 mr-1 text-success-700 dark:text-success-500" strokeWidth={2} />
                          : null}
                        Tallied to {fmtDate(last.statement_date)} at {fmt(last.statement_balance)}
                        {Math.abs(last.difference) >= 0.005 && ` · difference ${signed(last.difference)}${last.posted_to_suspense ? " to suspense" : " left open"}`}
                        {` · confirmed ${fmtStamp(last.reconciled_at)}`}
                      </>
                    ) : "Never reconciled"}
                  </div>
                </div>
                {last && (
                  <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(b.id)) n.delete(b.id); else n.add(b.id); return n; })}>
                    {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    {mv.length === 0 ? "Nothing entered since" : `${mv.length} entered since · net ${signed(net)}`}
                  </button>
                )}
              </div>
              {isOpen && mv.length > 0 && (
                <div className="mt-2 rounded-lg border border-border overflow-hidden">
                  {mv.map((x) => (
                    <div key={x.id} className="flex items-center gap-3 px-3 py-1.5 text-xs border-b border-border last:border-b-0">
                      <span className="text-muted-foreground whitespace-nowrap w-28 shrink-0">{fmtStamp(x.created_at)}</span>
                      <span className="text-foreground min-w-0 flex-1 truncate" title={x.description ?? ""}>{x.description ?? x.kind}</span>
                      <span className={`font-ledger whitespace-nowrap ${x.account_delta < 0 ? "text-down" : "text-up"}`}>{signed(x.account_delta)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Modal isOpen={!!form} onClose={() => setForm(null)} title="Reconcile a bank" error={err} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : "Confirm reconciliation"}</Button>
        </>}>
        {form && (
          <div className="flex flex-col gap-3">
            <div>
              <label className={label}>Bank *</label>
              <ThemedSelect value={form.bankId} onChange={(e) => setForm({ ...form, bankId: e.target.value })}>
                {companyBanks.map((b) => <option key={b.id} value={b.id}>{b.bank_name} · {b.account_number}</option>)}
              </ThemedSelect>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Statement date *</label>
                <input type="date" className={field} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </div>
              <div>
                <label className={label}>Statement balance *</label>
                <input className={field} inputMode="decimal" value={form.balance} onChange={(e) => setForm({ ...form, balance: e.target.value })} />
              </div>
            </div>
            {formBank && (
              <div className="rounded-lg border border-border px-3 py-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Bastion now</span><span className="font-ledger">{fmt(Number(formBank.balance))}</span></div>
                {formDiff != null && (
                  <div className="flex justify-between mt-1">
                    <span className="text-muted-foreground">Difference (statement − Bastion)</span>
                    <span className={`font-ledger font-semibold ${Math.abs(formDiff) < 0.005 ? "text-up" : "text-heed"}`}>
                      {Math.abs(formDiff) < 0.005 ? "Tallied" : signed(formDiff)}
                    </span>
                  </div>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Compare against the statement balance as it stands now. Anything entered in Bastion after you confirm
              is listed under the bank until the next reconciliation.
            </p>
            {formDiff != null && Math.abs(formDiff) >= 0.005 && (
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input type="checkbox" className="mt-1" checked={form.post} onChange={(e) => setForm({ ...form, post: e.target.checked })} />
                <span>
                  Park the difference in Bank Suspense
                  <span className="block text-xs text-muted-foreground">
                    Bastion&rsquo;s bank is set to the statement figure and {signed(formDiff)} waits in suspense until you find it.
                    Unticked, the difference is only noted.
                  </span>
                </span>
              </label>
            )}
            <div>
              <label className={label}>Notes</label>
              <input className={field} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={!!clearing} onClose={() => setClearing(null)} title="Clear suspense" error={err} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setClearing(null)}>Cancel</Button>
          <Button onClick={submitClear} disabled={busy}>{busy ? "Saving…" : "Clear it"}</Button>
        </>}>
        {clearing && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              {bankName(clearing.bank_account_id)}, {fmtDate(clearing.statement_date)}: {signed(clearing.difference)} in suspense.
            </p>
            <p className="text-xs text-muted-foreground">
              Record the real entry first (the missing payment, the duplicate removed). Clearing then takes the parked
              amount back out of the bank, so it is not counted twice.
            </p>
            <div>
              <label className={label}>What was it? *</label>
              <input className={field} value={clearNote} onChange={(e) => setClearNote(e.target.value)} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
