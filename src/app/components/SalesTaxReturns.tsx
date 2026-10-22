import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Loader2, Plus, Trash2, Undo2 } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import ThemedSelect from "./ThemedSelect";
import { supabase, friendlyDbError } from "../lib/supabase";
import { loadCustodianOptions, type CustodianOption } from "../lib/custodian";

/**
 * SALES TAX (0549, DECIDED 2026-10-22). PRA, FBR (ICT) and AJK.
 *
 *  • Each client is classified by hand: which authority, or not taxable.
 *  • A return runs from the 16th to the 15th and is due on the 15th. Its
 *    window's client receipts into the bank are listed and highlighted; the
 *    taxable amount per client and service month is typed in by hand.
 *  • The lines add up to the challan. The actual challan is typed in and must
 *    match before the return posts — each line then lands on its client at the
 *    service month (Dr 4050, Cr 2400).
 *  • One payment can settle several posted returns: a missed month is paid
 *    with the next.
 *
 * Every write is an RPC; the only arithmetic here is the preview of a line's
 * tax before it is saved, and the sum of the lines shown under them.
 */

type Code = "PRA" | "FBR" | "AJK";
const CODES: Code[] = ["FBR", "PRA", "AJK"];
type Authority = { code: Code; name: string; rate: number | null };
type Ret = { id: string; authority: Code; due_on: string; window_from: string; window_to: string; challan_amount: number | null; status: "draft" | "posted" | "paid"; payment_id: string | null };
type Line = { id: string; return_id: string; client_id: string; service_month: string; taxable_amount: number; rate: number; tax_amount: number; note: string | null };
type Client = { id: string; name: string; sales_tax_authority: Code | null; branch_id: string | null };
type Receipt = { id: string; client_id: string | null; amount: number; payment_date: string; bank_account_id: string | null; invoice_id: string | null; service_month: string | null };
type Payment = { id: string; amount: number; paid_on: string; paid_via: string; bank_account_id: string | null; reference: string | null };

const fmt = (n: number | null | undefined) => (n == null ? "—" : Math.round(Number(n)).toLocaleString());
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";
const monthLabel = (m: string) => new Date(`${m.slice(0, 7)}-01T00:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" });
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** The next 15th on or after today — the return now being filled. */
const nextDue = () => { const d = new Date(); if (d.getDate() > 15) d.setMonth(d.getMonth() + 1); d.setDate(15); return iso(d); };

export default function SalesTaxReturns({
  companyId, banks, canEdit, canClassify,
}: {
  companyId: string | null;
  banks: { id: string; bank_name: string; account_number?: string | null }[];
  /** accounting.edit: rates, returns, posting, paying. */
  canEdit: boolean;
  /** clients.edit: which authority a client files with. */
  canClassify: boolean;
}) {
  const [auths, setAuths] = useState<Authority[] | null>(null);
  const [rets, setRets] = useState<Ret[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [missing, setMissing] = useState(false);
  const [openRet, setOpenRet] = useState<string | null>(null);
  const [showClients, setShowClients] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [a, r, l, c, p] = await Promise.all([
      supabase.from("sales_tax_authorities").select("code, name, rate").eq("company_id", companyId),
      supabase.from("sales_tax_returns").select("id, authority, due_on, window_from, window_to, challan_amount, status, payment_id")
        .eq("company_id", companyId).order("due_on", { ascending: false }),
      supabase.from("sales_tax_return_lines").select("id, return_id, client_id, service_month, taxable_amount, rate, tax_amount, note").eq("company_id", companyId),
      supabase.from("clients").select("id, name, sales_tax_authority, branch_id").eq("company_id", companyId).order("name"),
      supabase.from("sales_tax_payments").select("id, amount, paid_on, paid_via, bank_account_id, reference").eq("company_id", companyId),
    ]);
    // Before 0549 is applied the tables do not exist: show nothing rather than an error.
    if (a.error) { setMissing(true); return; }
    setMissing(false);
    setAuths(((a.data ?? []) as Authority[]).map((x) => ({ ...x, rate: x.rate == null ? null : Number(x.rate) }))
      .sort((x, y) => CODES.indexOf(x.code) - CODES.indexOf(y.code)));
    setRets(((r.data ?? []) as Ret[]).map((x) => ({ ...x, challan_amount: x.challan_amount == null ? null : Number(x.challan_amount) })));
    setLines(((l.data ?? []) as Line[]).map((x) => ({ ...x, taxable_amount: Number(x.taxable_amount), rate: Number(x.rate), tax_amount: Number(x.tax_amount) })));
    setClients((c.data ?? []) as Client[]);
    setPayments(((p.data ?? []) as Payment[]).map((x) => ({ ...x, amount: Number(x.amount) })));
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  const clientName = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
  const bankName = useMemo(() => new Map(banks.map((b) => [b.id, b.bank_name])), [banks]);

  // ── pay dialog ──
  const [paySel, setPaySel] = useState<Set<string>>(new Set());
  const [payOpen, setPayOpen] = useState(false);
  const [pay, setPay] = useState<{ via: "Bank" | "Cash"; bank: string; custodian: string; date: string; ref: string }>({ via: "Bank", bank: "", custodian: "", date: iso(new Date()), ref: "" });
  const [custodians, setCustodians] = useState<CustodianOption[]>([]);
  useEffect(() => {
    if (payOpen && companyId && custodians.length === 0) void loadCustodianOptions(companyId, false).then(setCustodians).catch(() => undefined);
  }, [payOpen, companyId, custodians.length]);

  // ── new return ──
  const [newOpen, setNewOpen] = useState(false);
  const [newRet, setNewRet] = useState<{ authority: Code; due: string }>({ authority: "FBR", due: nextDue() });

  if (missing) return null;
  if (auths == null) {
    return <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Reading sales tax…</div>;
  }

  const call = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setErr(null);
    const { error } = await fn();
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return false; }
    await load();
    return true;
  };

  const posted = rets.filter((r) => r.status === "posted");
  const owed = posted.reduce((n, r) => n + (r.challan_amount ?? 0), 0);
  const taxable = clients.filter((c) => c.sales_tax_authority);
  const selTotal = posted.filter((r) => paySel.has(r.id)).reduce((n, r) => n + (r.challan_amount ?? 0), 0);

  const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";

  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Sales tax — PRA, FBR (ICT), AJK</h3>
          <p className="text-xs text-muted-foreground">
            Client receipts from the 16th to the 15th, due on the 15th. Each client&rsquo;s tax lands on that client at its service month.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <div className="text-right">
            <div className="lbl">Posted, not paid</div>
            <div className={`font-ledger text-lg font-semibold whitespace-nowrap ${owed > 0 ? "text-heed" : "text-foreground"}`}><span className="cur">PKR</span>{fmt(owed)}</div>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => { setErr(null); setNewRet({ authority: "FBR", due: nextDue() }); setNewOpen(true); }}>
              <Plus className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> New return
            </Button>
          )}
        </div>
      </div>

      {err && !newOpen && !payOpen && (
        <div className="px-4 py-2 text-sm text-danger-700 dark:text-danger-500 border-b border-border flex items-start gap-2">
          <CircleAlert className="w-4 h-4 mt-0.5 flex-shrink-0" /><span className="flex-1">{err}</span>
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setErr(null)}>Dismiss</button>
        </div>
      )}

      {/* Rates and classification */}
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-x-6 gap-y-2">
        {auths.map((a) => (
          <RateField key={a.code} a={a} canEdit={canEdit && !busy}
            onSave={(rate) => call(() => supabase.rpc("set_sales_tax_rate", { p_company_id: companyId, p_code: a.code, p_rate: rate }))} />
        ))}
        <button type="button" className="ml-auto text-xs text-brand-700 dark:text-brand-500 hover:underline font-medium flex items-center gap-1"
          onClick={() => setShowClients((v) => !v)}>
          {showClients ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          Taxable clients · {taxable.length} of {clients.length}
        </button>
      </div>
      {showClients && (
        <div className="px-4 py-3 border-b border-border">
          <p className="text-xs text-muted-foreground mb-2">Islamabad clients file with FBR (ICT), Rawalpindi with PRA. A client left &ldquo;Not taxable&rdquo; never appears in a return.</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5">
            {clients.map((c) => (
              <div key={c.id} className="flex items-center gap-2 text-sm min-w-0">
                <span className={`flex-1 min-w-0 truncate ${c.sales_tax_authority ? "text-foreground" : "text-muted-foreground"}`}>{c.name}</span>
                <div className="w-32 flex-shrink-0">
                  <ThemedSelect value={c.sales_tax_authority ?? ""} disabled={!canClassify || busy} aria-label={`Sales tax authority for ${c.name}`}
                    onChange={(e) => call(() => supabase.from("clients").update({ sales_tax_authority: e.target.value || null }).eq("id", c.id))}>
                    <option value="">Not taxable</option>
                    {CODES.map((k) => <option key={k} value={k}>{k}</option>)}
                  </ThemedSelect>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Returns */}
      {rets.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          No returns yet. Recording starts with the next one: start it with &ldquo;New return&rdquo;, add each taxable client, match the challan, post, then pay.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {rets.map((r) => {
            const rl = lines.filter((l) => l.return_id === r.id);
            const total = rl.reduce((n, l) => n + l.tax_amount, 0);
            const p = r.payment_id ? payments.find((x) => x.id === r.payment_id) : undefined;
            const isOpen = openRet === r.id;
            return (
              <div key={r.id}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                  {canEdit && r.status === "posted" && (
                    <input type="checkbox" className="accent-brand-600" aria-label={`Pay ${r.authority} due ${fmtDate(r.due_on)}`}
                      checked={paySel.has(r.id)}
                      onChange={() => setPaySel((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} />
                  )}
                  <button type="button" className="flex-1 min-w-0 text-left" onClick={() => setOpenRet(isOpen ? null : r.id)}>
                    <div className="text-sm font-medium text-foreground flex items-center gap-1.5">
                      {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      {r.authority} · due {fmtDate(r.due_on)}
                    </div>
                    <div className="text-[11px] text-muted-foreground pl-5">
                      receipts {fmtDate(r.window_from)} – {fmtDate(r.window_to)} · {rl.length} client line{rl.length === 1 ? "" : "s"}
                      {p ? ` · paid ${fmtDate(p.paid_on)} ${p.paid_via === "Bank" ? `from ${bankName.get(p.bank_account_id ?? "") ?? "bank"}` : "in cash"}${p.reference ? ` · ${p.reference}` : ""}` : ""}
                    </div>
                  </button>
                  <span className="font-ledger text-sm font-semibold text-foreground">{fmt(r.status === "draft" ? total : r.challan_amount)}</span>
                  <StatusChip status={r.status} />
                </div>
                {isOpen && (
                  <ReturnBody ret={r} lines={rl} clients={clients} clientName={clientName} bankName={bankName}
                    rate={auths.find((a) => a.code === r.authority)?.rate ?? null}
                    companyId={companyId} canEdit={canEdit} busy={busy} call={call} field={field} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {canEdit && posted.length > 0 && (
        <div className="px-4 py-3 border-t border-border flex flex-wrap items-center gap-3 bg-muted/30">
          <span className="text-xs text-muted-foreground">
            {paySel.size === 0 ? "Tick the posted returns this challan pays — a missed month goes with the next." : `${paySel.size} selected · PKR ${fmt(selTotal)}`}
          </span>
          <Button size="sm" className="ml-auto" disabled={paySel.size === 0 || busy}
            onClick={() => { setErr(null); setPay((x) => ({ ...x, date: iso(new Date()) })); setPayOpen(true); }}>
            Pay selected
          </Button>
        </div>
      )}

      <Modal isOpen={newOpen} onClose={() => !busy && setNewOpen(false)} title="New sales tax return" error={newOpen ? err : null} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setNewOpen(false)}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            setBusy(true); setErr(null);
            const { data, error } = await supabase.rpc("open_sales_tax_return", { p_company_id: companyId, p_authority: newRet.authority, p_due_on: newRet.due });
            setBusy(false);
            if (error) { setErr(friendlyDbError(error)); return; }
            setNewOpen(false); await load(); setOpenRet(String(data));
          }}>{busy ? "Starting…" : "Start return"}</Button>
        </>}>
        <div className="flex flex-col gap-3">
          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">Authority</label>
            <ThemedSelect value={newRet.authority} onChange={(e) => setNewRet((x) => ({ ...x, authority: e.target.value as Code }))}>
              {CODES.map((k) => <option key={k} value={k}>{auths.find((a) => a.code === k)?.name ?? k}</option>)}
            </ThemedSelect>
          </div>
          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">Due on (the 15th)</label>
            <input type="date" className={field} value={newRet.due} onChange={(e) => setNewRet((x) => ({ ...x, due: e.target.value }))} />
            <p className="text-[11px] text-muted-foreground mt-1">Covers client receipts from the 16th of the month before through this date.</p>
          </div>
        </div>
      </Modal>

      <Modal isOpen={payOpen} onClose={() => !busy && setPayOpen(false)} title={`Pay sales tax — PKR ${fmt(selTotal)}`} error={payOpen ? err : null} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setPayOpen(false)}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            const custodian = custodians.find((c) => c.employeeId === pay.custodian);
            if (pay.via === "Bank" && !pay.bank) return setErr("Choose the bank account.");
            if (pay.via === "Cash" && !custodian?.locationId) return setErr("Choose who paid it in cash.");
            const ok = await call(() => supabase.rpc("pay_sales_tax_returns", {
              p_company_id: companyId, p_return_ids: [...paySel], p_paid_via: pay.via,
              p_bank_account_id: pay.via === "Bank" ? pay.bank : null,
              p_custodian_location_id: pay.via === "Cash" ? custodian?.locationId ?? null : null,
              p_paid_on: pay.date, p_reference: pay.ref.trim() || null,
            }));
            if (ok) { setPayOpen(false); setPaySel(new Set()); }
          }}>{busy ? "Paying…" : "Pay"}</Button>
        </>}>
        <div className="flex flex-col gap-3">
          <ul className="text-sm divide-y divide-border rounded-lg border border-border">
            {posted.filter((r) => paySel.has(r.id)).map((r) => (
              <li key={r.id} className="flex justify-between px-3 py-1.5"><span>{r.authority} · due {fmtDate(r.due_on)}</span><span className="font-ledger">{fmt(r.challan_amount)}</span></li>
            ))}
          </ul>
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {(["Bank", "Cash"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={pay.via === v} onClick={() => setPay((x) => ({ ...x, via: v }))}
                className={`flex-1 px-3 py-1.5 text-sm rounded-md ${pay.via === v ? "bg-card text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}>{v}</button>
            ))}
          </div>
          {pay.via === "Bank" ? (
            <ThemedSelect value={pay.bank} onChange={(e) => setPay((x) => ({ ...x, bank: e.target.value }))} aria-label="Bank account">
              <option value="">Choose the bank…</option>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.bank_name}{b.account_number ? ` · ${b.account_number}` : ""}</option>)}
            </ThemedSelect>
          ) : (
            <ThemedSelect value={pay.custodian} onChange={(e) => setPay((x) => ({ ...x, custodian: e.target.value }))} aria-label="Paid by">
              <option value="">Who paid it in cash…</option>
              {custodians.filter((c) => c.locationId).map((c) => <option key={c.employeeId} value={c.employeeId}>{c.fullName}</option>)}
            </ThemedSelect>
          )}
          <div className="grid grid-cols-2 gap-3">
            <input type="date" className={field} value={pay.date} onChange={(e) => setPay((x) => ({ ...x, date: e.target.value }))} aria-label="Paid on" />
            <input className={field} placeholder="Challan / PSID no." value={pay.ref} onChange={(e) => setPay((x) => ({ ...x, ref: e.target.value }))} />
          </div>
        </div>
      </Modal>
    </section>
  );
}

function StatusChip({ status }: { status: Ret["status"] }) {
  if (status === "paid") return <span className="inline-flex items-center gap-1 text-xs text-success-700 dark:text-success-500"><CheckCircle2 className="w-3.5 h-3.5" /> Paid</span>;
  if (status === "posted") return <span className="inline-flex items-center gap-1 text-xs text-heed"><CircleAlert className="w-3.5 h-3.5" /> Posted · to pay</span>;
  return <span className="text-xs text-muted-foreground">Draft</span>;
}

function RateField({ a, canEdit, onSave }: { a: Authority; canEdit: boolean; onSave: (rate: number) => Promise<boolean> }) {
  const [v, setV] = useState(a.rate == null ? "" : String(a.rate));
  useEffect(() => { setV(a.rate == null ? "" : String(a.rate)); }, [a.rate]);
  const dirty = v !== (a.rate == null ? "" : String(a.rate));
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-foreground font-medium">{a.code}</span>
      {canEdit ? (
        <>
          <input className="w-16 rounded-md border border-border bg-background px-2 py-1 text-sm font-ledger text-right" inputMode="decimal"
            value={v} placeholder="rate" onChange={(e) => setV(e.target.value)} aria-label={`${a.code} rate`} />
          <span className="text-muted-foreground">%</span>
          {dirty && Number(v) > 0 && <button type="button" className="text-xs text-brand-700 dark:text-brand-500 font-medium hover:underline" onClick={() => void onSave(Number(v))}>Save</button>}
        </>
      ) : (
        <span className="font-ledger text-muted-foreground">{a.rate == null ? "rate not set" : `${a.rate}%`}</span>
      )}
      {a.rate == null && !dirty && <span className="text-[11px] text-heed">not set</span>}
    </div>
  );
}

function ReturnBody({
  ret, lines, clients, clientName, bankName, rate, companyId, canEdit, busy, call, field,
}: {
  ret: Ret; lines: Line[]; clients: Client[]; clientName: Map<string, string>; bankName: Map<string, string>;
  rate: number | null; companyId: string | null; canEdit: boolean; busy: boolean;
  call: (fn: () => PromiseLike<{ error: { message: string } | null }>) => Promise<boolean>; field: string;
}) {
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [draft, setDraft] = useState<{ client: string; month: string; taxable: string; note: string }>({ client: "", month: "", taxable: "", note: "" });
  const [challan, setChallan] = useState("");
  const editable = canEdit && ret.status === "draft";
  const mine = clients.filter((c) => c.sales_tax_authority === ret.authority);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await supabase.from("invoice_payments")
        .select("id, client_id, amount, payment_date, bank_account_id, invoice_id, invoices(client_id, service_month)")
        .eq("company_id", companyId ?? "").gte("payment_date", ret.window_from).lte("payment_date", ret.window_to)
        .not("bank_account_id", "is", null).order("payment_date");
      if (!alive) return;
      setReceipts(((data ?? []) as unknown as (Omit<Receipt, "service_month"> & { invoices: { client_id: string | null; service_month: string | null } | null })[]).map((x) => ({
        id: x.id, client_id: x.client_id ?? x.invoices?.client_id ?? null, amount: Number(x.amount), payment_date: x.payment_date,
        bank_account_id: x.bank_account_id, invoice_id: x.invoice_id, service_month: x.invoices?.service_month ?? null,
      })));
    })();
    return () => { alive = false; };
  }, [companyId, ret.window_from, ret.window_to]);

  const total = lines.reduce((n, l) => n + l.tax_amount, 0);
  const preview = rate != null && Number(draft.taxable) > 0 ? Math.round(Number(draft.taxable) * rate / 100) : null;
  const authOf = new Map(clients.map((c) => [c.id, c.sales_tax_authority]));
  const lined = new Set(lines.map((l) => `${l.client_id}|${l.service_month.slice(0, 7)}`));

  const saveLine = async () => {
    if (!draft.client || !draft.month || !(Number(draft.taxable) > 0)) return;
    const ok = await call(() => supabase.rpc("set_sales_tax_return_line", {
      p_return_id: ret.id, p_client_id: draft.client, p_service_month: `${draft.month}-01`,
      p_taxable_amount: Number(draft.taxable), p_note: draft.note.trim() || null,
    }));
    if (ok) setDraft({ client: "", month: "", taxable: "", note: "" });
  };

  return (
    <div className="px-4 pb-4 flex flex-col gap-3 bg-muted/20">
      {/* Client receipts into the bank in this window — the taxable base, highlighted. */}
      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground pt-2 pb-1">Client receipts into the bank, {fmtDate(ret.window_from)} – {fmtDate(ret.window_to)}</div>
        {receipts == null ? (
          <p className="text-xs text-muted-foreground">Reading receipts…</p>
        ) : receipts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No client receipts into a bank in this window.</p>
        ) : (
          <ul className="text-xs divide-y divide-border rounded-lg border border-border bg-card">
            {receipts.map((x) => {
              const a = x.client_id ? authOf.get(x.client_id) : null;
              const here = a === ret.authority;
              const done = x.client_id && x.service_month ? lined.has(`${x.client_id}|${x.service_month.slice(0, 7)}`) : false;
              return (
                <li key={x.id} className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 ${here && !done ? "bg-warning-50" : ""}`}>
                  <span className="text-muted-foreground whitespace-nowrap">{fmtDate(x.payment_date)}</span>
                  <span className={`flex-1 min-w-0 truncate ${here ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                    {x.client_id ? clientName.get(x.client_id) ?? "Client" : "No client"}
                    {x.service_month ? ` · for ${monthLabel(x.service_month)}` : ""}
                  </span>
                  <span className="text-muted-foreground">{bankName.get(x.bank_account_id ?? "") ?? "bank"}</span>
                  <span className="font-ledger text-foreground">{fmt(x.amount)}</span>
                  <span className={`w-28 text-right ${here ? (done ? "text-success-700 dark:text-success-500" : "text-heed font-semibold") : "text-muted-foreground"}`}>
                    {here ? (done ? "in this return" : "taxable — add") : a ? `files with ${a}` : "not taxable"}
                  </span>
                  {here && !done && editable && x.client_id && (
                    <button type="button" className="text-brand-700 dark:text-brand-500 font-medium hover:underline"
                      onClick={() => setDraft({ client: x.client_id!, month: (x.service_month ?? x.payment_date).slice(0, 7), taxable: "", note: "" })}>Add</button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* The lines. */}
      <div>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground pb-1">Taxable clients in this return{rate != null ? ` · ${rate}%` : ""}</div>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">Client</th>
                <th className="text-left px-3 py-1.5 font-medium">Service month</th>
                <th className="text-right px-3 py-1.5 font-medium">Taxable</th>
                <th className="text-right px-3 py-1.5 font-medium">Tax</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-1.5">{clientName.get(l.client_id) ?? "—"}{l.note ? <span className="text-[11px] text-muted-foreground"> · {l.note}</span> : null}</td>
                  <td className="px-3 py-1.5">{monthLabel(l.service_month)}</td>
                  <td className="px-3 py-1.5 text-right font-ledger">{fmt(l.taxable_amount)}</td>
                  <td className="px-3 py-1.5 text-right font-ledger">{fmt(l.tax_amount)}</td>
                  <td className="px-3 py-1.5 text-right">
                    {editable && (
                      <button type="button" className="text-muted-foreground hover:text-foreground" title="Remove this line" disabled={busy}
                        onClick={() => void call(() => supabase.rpc("set_sales_tax_return_line", { p_return_id: ret.id, p_client_id: l.client_id, p_service_month: l.service_month, p_taxable_amount: 0 }))}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {editable && (
                <tr className="bg-muted/30">
                  <td className="px-3 py-1.5 min-w-[12rem]">
                    <ThemedSelect value={draft.client} onChange={(e) => setDraft((d) => ({ ...d, client: e.target.value }))} aria-label="Client">
                      <option value="">{mine.length ? "Client…" : `No client files with ${ret.authority} yet`}</option>
                      {mine.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </ThemedSelect>
                  </td>
                  <td className="px-3 py-1.5"><input type="month" className={field} value={draft.month} onChange={(e) => setDraft((d) => ({ ...d, month: e.target.value }))} aria-label="Service month" /></td>
                  <td className="px-3 py-1.5"><input className={`${field} text-right font-ledger`} inputMode="decimal" placeholder="taxable" value={draft.taxable}
                    onChange={(e) => setDraft((d) => ({ ...d, taxable: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") void saveLine(); }} /></td>
                  <td className="px-3 py-1.5 text-right font-ledger text-muted-foreground">{preview == null ? (rate == null ? "set rate" : "—") : fmt(preview)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Button size="sm" variant="secondary" disabled={busy || !draft.client || !draft.month || !(Number(draft.taxable) > 0)} onClick={() => void saveLine()}>Add</Button>
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-semibold">
                <td className="px-3 py-1.5" colSpan={3}>Challan from the lines</td>
                <td className="px-3 py-1.5 text-right font-ledger">{fmt(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {canEdit && ret.status === "draft" && lines.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-muted-foreground">Actual challan</label>
          <input className="w-36 rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-ledger text-right" inputMode="decimal"
            value={challan} onChange={(e) => setChallan(e.target.value)} placeholder={fmt(total)} />
          {challan !== "" && Math.round(Number(challan)) !== total && (
            <span className="text-xs text-danger-700 dark:text-danger-500 font-semibold">differs by {fmt(Math.abs(Math.round(Number(challan)) - total))} — correct a line or the challan</span>
          )}
          <Button size="sm" className="ml-auto" disabled={busy || challan === "" || Math.round(Number(challan)) !== total}
            onClick={() => void call(() => supabase.rpc("post_sales_tax_return", { p_return_id: ret.id, p_challan_amount: Number(challan) }))}>
            Matches — post
          </Button>
        </div>
      )}
      {canEdit && ret.status === "posted" && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Posted at PKR {fmt(ret.challan_amount)}. Tick it below to pay, alone or with another month.</span>
          <button type="button" className="ml-auto text-xs text-muted-foreground hover:text-foreground flex items-center gap-1" disabled={busy}
            onClick={() => void call(() => supabase.rpc("unpost_sales_tax_return", { p_return_id: ret.id }))}>
            <Undo2 className="w-3.5 h-3.5" /> Unpost to correct
          </button>
        </div>
      )}
    </div>
  );
}
