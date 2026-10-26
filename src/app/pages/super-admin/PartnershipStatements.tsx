import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, FileDown, Loader2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import { supabase, type Partner } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { usePageState } from "../../lib/pageState";
import { brandingFromCompany } from "../../lib/pdfBranding";
import { generatePartnerLedgerPdf } from "../../lib/partnershipPdf";

/**
 * PARTNERSHIP — STATEMENTS (rebuilt 2026-10-26).
 *
 * One partner's account over a range, as partner_ledger gives it — every
 * movement: profit share posted by a run, cash drawn, fuel, client cash held,
 * custody, bank. The old tab read only the hand-entered partner_account_entries
 * and so disagreed with the Months view; this reads the same ledger the run
 * and the Months statement cards read.
 *
 * Recording a drawing or a contribution is the same partner_account_entries
 * insert the old tab made, nothing new.
 */

type Line = { entry_date: string; particulars: string; cash_paid: number; remuneration: number; balance: number; source: string };
const acct = (n: number) => { const v = Math.round(Number(n || 0)); return v < 0 ? `(${Math.abs(v).toLocaleString()})` : v.toLocaleString(); };
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayBefore = (s: string) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() - 1); return ymd(d); };
const fmt = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

const RANGES = [
  { key: "month", label: "This month" },
  { key: "last", label: "Last month" },
  { key: "quarter", label: "Last 3 months" },
  { key: "all", label: "Since the start" },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];
const rangeOf = (k: RangeKey): { from: string | null; to: string | null } => {
  const now = new Date(); const first = new Date(now.getFullYear(), now.getMonth(), 1);
  if (k === "month") return { from: ymd(first), to: null };
  if (k === "last") return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) };
  if (k === "quarter") return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 2, 1)), to: null };
  return { from: null, to: null };
};

const METHODS = [
  { v: "CASH", l: "Cash" }, { v: "BANK_TRANSFER", l: "Bank transfer" }, { v: "FUEL_CARD", l: "Fuel card" }, { v: "CHEQUE", l: "Cheque" },
] as const;

export default function PartnershipStatements() {
  const { profile, company } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
  const canEdit = hasPermission(profile, "accounting.edit");

  const [partners, setPartners] = useState<Partner[]>([]);
  const [pid, setPid] = usePageState<string>("PartnershipStatements.partner", "");
  const [range, setRange] = usePageState<RangeKey>("PartnershipStatements.range", "quarter");
  const [lines, setLines] = useState<Line[]>([]);
  const [opening, setOpening] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [entry, setEntry] = useState<null | "DRAWING" | "CONTRIBUTION">(null);
  const [form, setForm] = useState({ date: ymd(new Date()), amount: "", method: "CASH", description: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    void supabase.from("partners").select("*").eq("company_id", companyId).order("name").then(({ data }) => {
      const list = (data ?? []) as Partner[];
      setPartners(list);
      if (!pid && list.length) setPid(list[0].id);
    });
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const { from, to } = rangeOf(range);
  const load = useCallback(async () => {
    if (!pid) return;
    setLoading(true); setErr(null);
    const [cur, before] = await Promise.all([
      supabase.rpc("partner_ledger", { p_partner_id: pid, p_start: from, p_end: to }),
      from ? supabase.rpc("partner_ledger", { p_partner_id: pid, p_start: null, p_end: dayBefore(from) }) : Promise.resolve({ data: [], error: null }),
    ]);
    setLoading(false);
    if (cur.error) { setErr(cur.error.message); return; }
    const prior = (before.data ?? []) as Line[];
    const p = partners.find((x) => x.id === pid);
    setOpening(prior.length ? Number(prior[prior.length - 1].balance) : from ? Number(p?.opening_balance ?? 0) : 0);
    setLines((cur.data ?? []) as Line[]);
  }, [pid, from, to, partners]);
  useEffect(() => { void load(); }, [load]);

  const partner = partners.find((p) => p.id === pid) ?? null;
  const profit = lines.reduce((n, l) => n + Number(l.remuneration || 0), 0);
  const paid = lines.reduce((n, l) => n + Number(l.cash_paid || 0), 0);
  const closing = lines.length ? Number(lines[lines.length - 1].balance) : opening;
  const rangeLabel = useMemo(() => {
    if (!from && !to) return "since the start";
    return `${from ? fmt(from) : "start"} – ${to ? fmt(to) : "today"}`;
  }, [from, to]);

  const pdf = () => partner && generatePartnerLedgerPdf({
    branding: brandingFromCompany(company), partnerName: partner.name, rangeLabel, opening, closing,
    rows: lines.map((l) => ({ entry_date: l.entry_date, particulars: l.particulars, cash_paid: Number(l.cash_paid), remuneration: Number(l.remuneration), balance: Number(l.balance) })),
  });

  const save = async () => {
    if (!companyId || !pid || !entry) return;
    const amt = Number(form.amount);
    if (!(amt > 0)) { setErr("Enter an amount greater than zero."); return; }
    setSaving(true); setErr(null);
    const { error } = await supabase.from("partner_account_entries").insert({
      company_id: companyId, partner_id: pid, date: form.date, type: entry,
      description: form.description || (entry === "DRAWING" ? "Drawing" : "Contribution"),
      amount: amt, payment_method: form.method, created_by: profile?.id,
    });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setEntry(null); setForm({ date: ymd(new Date()), amount: "", method: "CASH", description: "" });
    await load();
  };

  return (
    <>
      <Header
        title="Statements"
        subtitle="Each partner's account — everything the ledger holds for them, line by line"
        actions={
          <div className="flex items-center gap-2">
            {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            {partner && <Button variant="ghost" onClick={pdf}><FileDown className="w-4 h-4" /> PDF</Button>}
          </div>
        }
      >
        <div className="flex flex-wrap gap-1.5">
          {partners.map((p) => (
            <button key={p.id} type="button" onClick={() => setPid(p.id)}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${p.id === pid ? "border-brand-500 bg-brand-500/15 text-foreground font-semibold" : "border-border bg-card text-muted-foreground hover:border-brand-500/60"}`}>
              {p.name}
            </button>
          ))}
        </div>
      </Header>

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-5">
        {err && <div className="bg-danger-50 border border-danger-200 rounded-lg px-4 py-3 text-sm text-danger-700">{err}</div>}

        {partner && (
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 pt-4 pb-3 flex flex-wrap items-center gap-3">
              <div>
                <h2 className="font-display text-2xl font-bold tracking-tight text-foreground">{partner.name}</h2>
                <p className="text-xs text-muted-foreground">
                  {partner.scope === "BRANCH" ? "Regional partner" : "Equity partner"} · {Number(partner.profit_share_percent)}% · {rangeLabel}
                </p>
              </div>
              <div className="ml-auto flex flex-wrap gap-1.5">
                {RANGES.map((r) => (
                  <button key={r.key} type="button" onClick={() => setRange(r.key)}
                    className={`rounded-lg px-2.5 py-1 text-xs ${range === r.key ? "bg-foreground text-background font-semibold" : "text-muted-foreground hover:bg-muted"}`}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 border-t border-border divide-x divide-border">
              {[
                { k: "Opening", v: opening },
                { k: "Profit share", v: profit },
                { k: "Paid / drawn", v: -paid },
                { k: "Closing", v: closing, strong: true },
              ].map((x) => (
                <div key={x.k} className="px-5 py-3">
                  <span className="lbl">{x.k}</span>
                  <div className={`font-ledger mt-0.5 ${x.strong ? "text-2xl font-bold" : "text-lg font-semibold"} ${x.v < 0 ? "text-down" : "text-foreground"}`}>{acct(x.v)}</div>
                </div>
              ))}
            </div>
            {canEdit && (
              <div className="px-5 py-3 border-t border-border flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => setEntry("DRAWING")}><ArrowUpRight className="w-4 h-4" /> Record drawing</Button>
                <Button variant="ghost" size="sm" onClick={() => setEntry("CONTRIBUTION")}><ArrowDownLeft className="w-4 h-4" /> Record contribution</Button>
              </div>
            )}
          </section>
        )}

        {partner && (
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-5 py-2 font-medium">Date</th>
                    <th className="text-left px-4 py-2 font-medium">Particulars</th>
                    <th className="text-right px-4 py-2 font-medium">Paid / drawn</th>
                    <th className="text-right px-4 py-2 font-medium">Profit share</th>
                    <th className="text-right px-5 py-2 font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr className="bg-muted/20">
                    <td className="px-5 py-2 text-muted-foreground">{from ? fmt(from) : "—"}</td>
                    <td className="px-4 py-2 text-muted-foreground">Opening balance</td>
                    <td /><td />
                    <td className={`px-5 py-2 text-right font-ledger ${opening < 0 ? "text-down" : ""}`}>{acct(opening)}</td>
                  </tr>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td className="px-5 py-2 text-muted-foreground whitespace-nowrap">{fmt(l.entry_date)}</td>
                      <td className="px-4 py-2 text-foreground">{l.particulars}</td>
                      <td className="px-4 py-2 text-right font-ledger">{Number(l.cash_paid) ? acct(l.cash_paid) : ""}</td>
                      <td className="px-4 py-2 text-right font-ledger text-up">{Number(l.remuneration) ? acct(l.remuneration) : ""}</td>
                      <td className={`px-5 py-2 text-right font-ledger ${Number(l.balance) < 0 ? "text-down" : ""}`}>{acct(l.balance)}</td>
                    </tr>
                  ))}
                  {!loading && lines.length === 0 && (
                    <tr><td colSpan={5} className="px-5 py-6 text-center text-muted-foreground">Nothing moved on this account in this range.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      <Modal isOpen={entry !== null} onClose={() => setEntry(null)} title={entry === "DRAWING" ? `Drawing — ${partner?.name ?? ""}` : `Contribution — ${partner?.name ?? ""}`} size="md">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-muted-foreground">Date
              <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm" />
            </label>
            <label className="text-xs text-muted-foreground">Amount (PKR)
              <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm" />
            </label>
          </div>
          <label className="block text-xs text-muted-foreground">Paid by
            <ThemedSelect value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className="mt-1 w-full">
              {METHODS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
            </ThemedSelect>
          </label>
          <label className="block text-xs text-muted-foreground">Description
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm" />
          </label>
          <div className="flex gap-2 pt-1">
            <Button variant="primary" disabled={saving} onClick={save}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}</Button>
            <Button variant="secondary" onClick={() => setEntry(null)}>Cancel</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
