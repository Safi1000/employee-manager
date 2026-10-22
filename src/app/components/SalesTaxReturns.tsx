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
 *  • Each client is classified once, by hand: which authority, or not taxable.
 *    Every return then lists all of that authority's taxable clients.
 *  • Rates are locked and dated (0550): a change is a new rate from a date,
 *    with a reason. A return uses the rate in force on its due date.
 *  • A return runs from the 16th to the 15th and is due on the 15th. Its
 *    window's client receipts into the bank are listed and highlighted; the
 *    taxable amount per client and service month is typed in by hand.
 *  • The lines add up to the challan. Creating the challan books each line on
 *    its client at the service month (Dr 4050, Cr 2400); paying nets it off.
 *  • One payment can settle several challans: a missed month is paid with the
 *    next.
 *
 * Every write is an RPC; the only arithmetic here is the preview of a line's
 * tax before it is saved, and the sum of the lines shown under them.
 */

type Code = "PRA" | "FBR" | "AJK";
const CODES: Code[] = ["FBR", "PRA", "AJK"];
type Authority = { code: Code; name: string };
type Rate = { code: Code; rate: number; effective_from: string; reason: string };
/** The rate in force on a date: the latest that started on or before it. */
const rateOn = (rates: Rate[], code: Code, on: string) =>
  rates.filter((x) => x.code === code && x.effective_from <= on).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? null;
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
  const [rates, setRates] = useState<Rate[]>([]);
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
    const [a, r, l, c, p, rt] = await Promise.all([
      supabase.from("sales_tax_authorities").select("code, name").eq("company_id", companyId),
      supabase.from("sales_tax_returns").select("id, authority, due_on, window_from, window_to, challan_amount, status, payment_id")
        .eq("company_id", companyId).order("due_on", { ascending: false }),
      supabase.from("sales_tax_return_lines").select("id, return_id, client_id, service_month, taxable_amount, rate, tax_amount, note").eq("company_id", companyId),
      supabase.from("clients").select("id, name, sales_tax_authority, branch_id").eq("company_id", companyId).order("name"),
      supabase.from("sales_tax_payments").select("id, amount, paid_on, paid_via, bank_account_id, reference").eq("company_id", companyId),
      supabase.from("sales_tax_rates").select("code, rate, effective_from, reason").eq("company_id", companyId).order("effective_from", { ascending: false }),
    ]);
    // Before 0549 is applied the tables do not exist: show nothing rather than an error.
    if (a.error) { setMissing(true); return; }
    setMissing(false);
    setAuths(((a.data ?? []) as Authority[]).sort((x, y) => CODES.indexOf(x.code) - CODES.indexOf(y.code)));
    setRates(((rt.data ?? []) as Rate[]).map((x) => ({ ...x, rate: Number(x.rate) })));
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

  // ── change a rate (dated) ──
  const [rateOpen, setRateOpen] = useState(false);
  const [rateForm, setRateForm] = useState<{ code: Code; rate: string; from: string; reason: string }>({ code: "FBR", rate: "", from: "", reason: "" });

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
            <div className="lbl">Challans unpaid</div>
            <div className={`font-ledger text-lg font-semibold whitespace-nowrap ${owed > 0 ? "text-heed" : "text-foreground"}`}><span className="cur">PKR</span>{fmt(owed)}</div>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => { setErr(null); setNewRet({ authority: "FBR", due: nextDue() }); setNewOpen(true); }}>
              <Plus className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> New return
            </Button>
          )}
        </div>
      </div>

      {err && !newOpen && !payOpen && !rateOpen && (
        <div className="px-4 py-2 text-sm text-danger-700 dark:text-danger-500 border-b border-border flex items-start gap-2">
          <CircleAlert className="w-4 h-4 mt-0.5 flex-shrink-0" /><span className="flex-1">{err}</span>
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setErr(null)}>Dismiss</button>
        </div>
      )}

      {/* Rates and classification */}
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-x-6 gap-y-2">
        {auths.map((a) => {
          const now = rateOn(rates, a.code, iso(new Date()));
          const next = rates.filter((x) => x.code === a.code && x.effective_from > iso(new Date())).sort((x, y) => x.effective_from.localeCompare(y.effective_from))[0];
          return (
            <div key={a.code} className="text-sm" title={now?.reason}>
              <span className="font-medium text-foreground">{a.code}</span>{" "}
              {now ? <><span className="font-ledger">{now.rate}%</span> <span className="text-[11px] text-muted-foreground">since {fmtDate(now.effective_from)}</span></>
                : <span className="text-[11px] text-heed">no rate</span>}
              {next && <span className="text-[11px] text-muted-foreground"> · {next.rate}% from {fmtDate(next.effective_from)}</span>}
            </div>
          );
        })}
        {canEdit && (
          <button type="button" className="text-xs text-brand-700 dark:text-brand-500 hover:underline font-medium"
            onClick={() => { setErr(null); setRateForm({ code: "FBR", rate: "", from: "", reason: "" }); setRateOpen(true); }}>Change a rate</button>
        )}
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
                    rate={rateOn(rates, r.authority, r.due_on)?.rate ?? null}
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
            {paySel.size === 0 ? "Tick the challans this payment settles — a missed month goes with the next." : `${paySel.size} selected · PKR ${fmt(selTotal)}`}
          </span>
          <Button size="sm" className="ml-auto" disabled={paySel.size === 0 || busy}
            onClick={() => { setErr(null); setPay((x) => ({ ...x, date: iso(new Date()) })); setPayOpen(true); }}>
            Paid — net off
          </Button>
        </div>
      )}

      <Modal isOpen={rateOpen} onClose={() => !busy && setRateOpen(false)} title="Change a sales tax rate" error={rateOpen ? err : null} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setRateOpen(false)}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            if (!(Number(rateForm.rate) > 0)) return setErr("Enter the new rate.");
            if (!rateForm.from) return setErr("Say from which date it applies.");
            const ok = await call(() => supabase.rpc("change_sales_tax_rate", {
              p_company_id: companyId, p_code: rateForm.code, p_rate: Number(rateForm.rate), p_effective_from: rateForm.from, p_reason: rateForm.reason,
            }));
            if (ok) setRateOpen(false);
          }}>{busy ? "Saving…" : "Save the change"}</Button>
        </>}>
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            A rate is never edited. The new one applies to every return due on or after its date; challans already made keep the rate they were made at.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <ThemedSelect value={rateForm.code} onChange={(e) => setRateForm((x) => ({ ...x, code: e.target.value as Code }))} aria-label="Authority">
              {CODES.map((k) => <option key={k} value={k}>{k}</option>)}
            </ThemedSelect>
            <input className={field} inputMode="decimal" placeholder="New rate %" value={rateForm.rate} onChange={(e) => setRateForm((x) => ({ ...x, rate: e.target.value }))} />
          </div>
          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">Applies from</label>
            <input type="date" className={field} value={rateForm.from} onChange={(e) => setRateForm((x) => ({ ...x, from: e.target.value }))} />
          </div>
          <input className={field} placeholder="Why — e.g. Budget FY 2027-28" value={rateForm.reason} onChange={(e) => setRateForm((x) => ({ ...x, reason: e.target.value }))} />
          {rates.filter((x) => x.code === rateForm.code).length > 0 && (
            <ul className="text-xs divide-y divide-border rounded-lg border border-border">
              {rates.filter((x) => x.code === rateForm.code).map((x) => (
                <li key={x.effective_from} className="flex gap-3 px-3 py-1.5"><span className="font-ledger w-10">{x.rate}%</span><span className="text-muted-foreground w-28">from {fmtDate(x.effective_from)}</span><span className="text-muted-foreground truncate">{x.reason}</span></li>
              ))}
            </ul>
          )}
        </div>
      </Modal>

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

      <Modal isOpen={payOpen} onClose={() => !busy && setPayOpen(false)} title={`Challans paid — PKR ${fmt(selTotal)}`} error={payOpen ? err : null} onDismissError={() => setErr(null)}
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
  if (status === "posted") return <span className="inline-flex items-center gap-1 text-xs text-heed"><CircleAlert className="w-3.5 h-3.5" /> Challan made · unpaid</span>;
  return <span className="text-xs text-muted-foreground">Draft</span>;
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

  // A client's service month: the one its latest receipt in the window paid,
  // else the month before the due month.
  const defaultMonth = (clientId: string) => {
    const x = (receipts ?? []).filter((y) => y.client_id === clientId && y.service_month).sort((a, b) => b.payment_date.localeCompare(a.payment_date))[0];
    if (x?.service_month) return x.service_month.slice(0, 7);
    const d = new Date(`${ret.due_on}T00:00:00`); d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

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
              {/* Every taxable client of this authority that has no line yet — set once on the client, listed every month. */}
              {editable && mine.filter((c) => !lines.some((l) => l.client_id === c.id)).map((c) => (
                <ClientEntry key={c.id} client={c} month={defaultMonth(c.id)} rate={rate} busy={busy} field={field}
                  onSave={(month, taxable) => call(() => supabase.rpc("set_sales_tax_return_line", {
                    p_return_id: ret.id, p_client_id: c.id, p_service_month: `${month}-01`, p_taxable_amount: taxable,
                  }))} />
              ))}
              {editable && mine.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-2 text-xs text-muted-foreground">No client is marked {ret.authority} yet — set them once under &ldquo;Taxable clients&rdquo;.</td></tr>
              )}
              {editable && mine.length > 0 && (
                <tr className="bg-muted/30">
                  <td className="px-3 py-1.5 min-w-[12rem]">
                    <ThemedSelect value={draft.client} onChange={(e) => setDraft((d) => ({ ...d, client: e.target.value }))} aria-label="Client">
                      <option value="">Another month for a client…</option>
                      {mine.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </ThemedSelect>
                  </td>
                  <td className="px-3 py-1.5"><input type="month" className={field} value={draft.month} onChange={(e) => setDraft((d) => ({ ...d, month: e.target.value }))} aria-label="Service month" /></td>
                  <td className="px-3 py-1.5"><input className={`${field} text-right font-ledger`} inputMode="decimal" placeholder="taxable" value={draft.taxable}
                    onChange={(e) => setDraft((d) => ({ ...d, taxable: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") void saveLine(); }} /></td>
                  <td className="px-3 py-1.5 text-right font-ledger text-muted-foreground">{preview == null ? (rate == null ? "no rate" : "—") : fmt(preview)}</td>
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
          <span className="text-xs text-muted-foreground">Creating the challan books each client&rsquo;s tax on that client; paying it nets it off.</span>
          <Button size="sm" className="ml-auto" disabled={busy}
            onClick={() => void call(() => supabase.rpc("post_sales_tax_return", { p_return_id: ret.id, p_challan_amount: total }))}>
            Create challan · PKR {fmt(total)}
          </Button>
        </div>
      )}
      {canEdit && ret.status === "posted" && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Challan made for PKR {fmt(ret.challan_amount)}. Tick it below once paid — alone or with another month.</span>
          <button type="button" className="ml-auto text-xs text-muted-foreground hover:text-foreground flex items-center gap-1" disabled={busy}
            onClick={() => void call(() => supabase.rpc("unpost_sales_tax_return", { p_return_id: ret.id }))}>
            <Undo2 className="w-3.5 h-3.5" /> Cancel the challan to correct it
          </button>
        </div>
      )}
    </div>
  );
}

function ClientEntry({ client, month: initialMonth, rate, busy, field, onSave }: {
  client: Client; month: string; rate: number | null; busy: boolean; field: string;
  onSave: (month: string, taxable: number) => Promise<boolean>;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [taxable, setTaxable] = useState("");
  useEffect(() => { setMonth(initialMonth); }, [initialMonth]);
  const ok = Number(taxable) > 0 && !!month;
  const save = async () => { if (ok && await onSave(month, Number(taxable))) setTaxable(""); };
  return (
    <tr>
      <td className="px-3 py-1.5 text-foreground">{client.name}</td>
      <td className="px-3 py-1.5"><input type="month" className={field} value={month} onChange={(e) => setMonth(e.target.value)} aria-label={`Service month for ${client.name}`} /></td>
      <td className="px-3 py-1.5"><input className={`${field} text-right font-ledger`} inputMode="decimal" placeholder="nothing this month" value={taxable}
        onChange={(e) => setTaxable(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} aria-label={`Taxable amount for ${client.name}`} /></td>
      <td className="px-3 py-1.5 text-right font-ledger text-muted-foreground">{rate != null && ok ? fmt(Math.round(Number(taxable) * rate / 100)) : "—"}</td>
      <td className="px-3 py-1.5 text-right"><Button size="sm" variant="secondary" disabled={busy || !ok} onClick={() => void save()}>Save</Button></td>
    </tr>
  );
}
