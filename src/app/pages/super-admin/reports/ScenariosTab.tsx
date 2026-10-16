import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Loader2, Save, Trash2 } from "lucide-react";
import Button from "../../../components/Button";
import ThemedSelect from "../../../components/ThemedSelect";
import Badge from "../../../components/Badge";
import { Panel, SearchBox, inputCls } from "../_assetsKit";
import { supabase } from "../../../lib/supabase";
import { formatDate } from "../../../lib/date";
import { Amount, callRpc, money, monthEnd, monthLabel, monthStart, signed, useCompanyId } from "./kit";

/**
 * SCENARIOS — computed and discarded, never posted.
 *
 * Every lever is passed to scenario_compare() (proposed in 0516), which sets a
 * transaction-local override on the READ path, reads every figure twice and
 * returns actual, scenario and the delta. It is the mechanism 0514 built for
 * head office (bastion.ho_mode_override), extended; postings clear it before
 * computing, so no scenario can ever reach a posting. Nothing on this screen
 * writes to the ledger: the only write is saving a scenario's LEVERS by name.
 *
 * Until 0516 is applied, the head-office lever still works on its own through
 * ho_switch_impact() (0515), which exists today.
 */

type Mode = { branch_id: string; region_name: string; apportioned: boolean };
type Partner = { id: string; name: string; scope: string; branch_id: string | null; profit_share_percent: number };
type Branch = { id: string; name: string; is_head_office: boolean };
type Receipt = { id: string; payment_date: string; amount: number; client: { name: string } | null };
type Expense = { id: string; expense_date: string; amount: number; description: string | null; payment_mode: string };
type Client = { id: string; name: string };
type Result = { section: string; subject_id: string; subject: string; actual: number | null; scenario: number | null; delta: number };
type Saved = { id: string; name: string; period: string; params: Levers; created_at: string };

type Levers = {
  basis?: "cash" | "revenue";
  ho?: Record<string, "on" | "off">;
  partners?: Record<string, { pct?: number; branch_id?: string }>;
  receipt_dates?: Record<string, string>;
  expense_dates?: Record<string, string>;
  exclude_clients?: string[];
  exclude_regions?: string[];
};

const SECTION_LABEL: Record<string, string> = { company: "Company", ho: "Head office", partner: "Partners", region: "Regions", client: "Clients" };

/** Drop empty levers so a saved scenario says only what it changes. */
const clean = (l: Levers): Levers => {
  const o: Levers = {};
  if (l.basis) o.basis = l.basis;
  if (l.ho && Object.keys(l.ho).length) o.ho = l.ho;
  const p = Object.fromEntries(Object.entries(l.partners ?? {}).filter(([, v]) => v.pct != null || v.branch_id));
  if (Object.keys(p).length) o.partners = p;
  const r = Object.fromEntries(Object.entries(l.receipt_dates ?? {}).filter(([, v]) => !!v));
  if (Object.keys(r).length) o.receipt_dates = r;
  const e = Object.fromEntries(Object.entries(l.expense_dates ?? {}).filter(([, v]) => !!v));
  if (Object.keys(e).length) o.expense_dates = e;
  if (l.exclude_clients?.length) o.exclude_clients = l.exclude_clients;
  if (l.exclude_regions?.length) o.exclude_regions = l.exclude_regions;
  return o;
};

export default function ScenariosTab({ period }: { period: string }) {
  const companyId = useCompanyId();
  const [levers, setLevers] = useState<Levers>({});
  const [modes, setModes] = useState<Mode[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [clientQ, setClientQ] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [comparedMonth, setComparedMonth] = useState<string | null>(null);
  const [state, setState] = useState<{ error: string | null; missing: boolean }>({ error: null, missing: false });
  const start = monthStart(period), end = monthEnd(period);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void (async () => {
      const [md, pt, br, rc, ex, cl, sv] = await Promise.all([
        supabase.rpc("ho_region_modes", { p_company_id: companyId, p_month: start }),
        supabase.from("partners").select("id, name, scope, branch_id, profit_share_percent").eq("company_id", companyId).eq("is_active", true).order("name"),
        supabase.from("branches").select("id, name, is_head_office").eq("company_id", companyId).eq("active", true).order("name"),
        supabase.from("invoice_payments").select("id, payment_date, amount, client:client_id(name)").eq("company_id", companyId).gte("payment_date", start).lte("payment_date", end).order("amount", { ascending: false }).limit(60),
        supabase.from("expenses").select("id, expense_date, amount, description, payment_mode").eq("company_id", companyId).in("payment_mode", ["Cash", "Bank"]).gte("expense_date", start).lte("expense_date", end).order("amount", { ascending: false }).limit(60),
        supabase.from("clients").select("id, name").eq("company_id", companyId).order("name"),
        supabase.from("report_scenarios").select("id, name, period, params, created_at").eq("company_id", companyId).order("created_at", { ascending: false }),
      ]);
      if (cancelled) return;
      setModes((md.data ?? []) as Mode[]);
      setPartners((pt.data ?? []) as Partner[]);
      setBranches((br.data ?? []) as Branch[]);
      setReceipts((rc.data ?? []) as unknown as Receipt[]);
      setExpenses((ex.data ?? []) as Expense[]);
      setClients((cl.data ?? []) as Client[]);
      setSaved(sv.error ? [] : ((sv.data ?? []) as Saved[]));
    })();
    return () => { cancelled = true; };
  }, [companyId, start, end]);

  const regions = branches.filter((b) => !b.is_head_office);
  const chosen = useMemo(() => clean(levers), [levers]);
  const changed = Object.keys(chosen).length > 0;

  const compare = async (l: Levers = chosen, onMonth: string = start) => {
    if (!companyId) return;
    setBusy(true); setResults(null); setComparedMonth(onMonth);
    const r = await callRpc<Result[]>("scenario_compare", { p_company_id: companyId, p_period: onMonth, p_scenario: l });
    if (r.missing) {
      // Until 0516: the head-office lever alone, through ho_switch_impact (0515).
      const ho = Object.entries(l.ho ?? {});
      const other = Object.keys(l).filter((k) => k !== "ho");
      if (ho.length === 1 && other.length === 0) {
        const [branchId, mode] = ho[0];
        const f = await callRpc<{ partner_id: string; partner_name: string; current_amount: number; proposed_amount: number; difference: number }[]>(
          "ho_switch_impact", { p_company_id: companyId, p_period: onMonth, p_branch_id: branchId, p_apportion: mode === "on" });
        setResults((f.data ?? []).map((x) => ({ section: "partner", subject_id: x.partner_id, subject: x.partner_name, actual: x.current_amount, scenario: x.proposed_amount, delta: x.difference })));
        setState({ error: f.error, missing: true });
      } else {
        setState({ error: null, missing: true });
      }
      setBusy(false);
      return;
    }
    setState({ error: r.error, missing: false });
    setResults(r.data ?? []);
    setBusy(false);
  };

  const save = async () => {
    if (!companyId || !name.trim()) return;
    const r = await callRpc<string>("save_report_scenario", { p_company_id: companyId, p_name: name.trim(), p_period: start, p_params: chosen });
    if (r.missing) { setState({ error: null, missing: true }); return; }
    if (r.error) { setState({ error: r.error, missing: false }); return; }
    setName("");
    const { data } = await supabase.from("report_scenarios").select("id, name, period, params, created_at").eq("company_id", companyId).order("created_at", { ascending: false });
    setSaved((data ?? []) as Saved[]);
  };
  const remove = async (id: string) => {
    const r = await callRpc<null>("delete_report_scenario", { p_id: id });
    if (r.error) { setState({ error: r.error, missing: r.missing }); return; }
    setSaved((s) => s.filter((x) => x.id !== id));
  };

  const set = <K extends keyof Levers>(k: K, v: Levers[K]) => setLevers((l) => ({ ...l, [k]: v }));
  const shownResults = (results ?? []).filter((r) => showAll || Math.abs(r.delta) > 0.005);
  const sections = ["company", "ho", "partner", "region", "client"].filter((s) => shownResults.some((r) => r.section === s));
  const filteredClients = clients.filter((c) => !clientQ.trim() || c.name.toLowerCase().includes(clientQ.trim().toLowerCase())).slice(0, 40);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] gap-5 items-start">
      <Panel icon={FlaskConical} title={`Levers — ${monthLabel(period)}`}
        description="Computed and discarded. Nothing here posts; a scenario can only be saved for comparison.">
        <div className="space-y-5 text-sm">
          <section>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Basis</div>
            <ThemedSelect className="w-full" value={levers.basis ?? ""} onChange={(e) => set("basis", (e.target.value || undefined) as Levers["basis"])}>
              <option value="">As set for the company</option>
              <option value="cash">Cash</option>
              <option value="revenue">Accrual (revenue)</option>
            </ThemedSelect>
          </section>

          <section>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Head office, per region</div>
            <div className="space-y-1.5">
              {modes.map((m) => (
                <div key={m.branch_id} className="flex items-center justify-between gap-2">
                  <span>{m.region_name} <span className="text-[11px] text-muted-foreground">({m.apportioned ? "apportioned" : "held"})</span></span>
                  <ThemedSelect className="w-40" value={levers.ho?.[m.branch_id] ?? ""}
                    onChange={(e) => { const v = e.target.value as "on" | "off" | ""; const ho = { ...(levers.ho ?? {}) }; if (v) ho[m.branch_id] = v; else delete ho[m.branch_id]; set("ho", ho); }}>
                    <option value="">As set</option><option value="on">Apportioned</option><option value="off">Held</option>
                  </ThemedSelect>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Partners</div>
            <p className="text-[11px] text-muted-foreground mb-1.5">Changes the partner's default rate; a per-client rate (HMC Taxila at 37.5%, DECIDED) still applies.</p>
            <div className="space-y-2">
              {partners.map((p) => (
                <div key={p.id} className="grid grid-cols-[1fr_5.5rem] gap-2 items-center">
                  <span className="truncate">{p.name} <span className="text-[11px] text-muted-foreground">{p.profit_share_percent}%</span></span>
                  <input type="number" min={0} max={100} step="0.5" placeholder="%" className={inputCls}
                    value={levers.partners?.[p.id]?.pct ?? ""}
                    onChange={(e) => { const pts = { ...(levers.partners ?? {}) }; const cur = { ...(pts[p.id] ?? {}) };
                      cur.pct = e.target.value === "" ? undefined : Number(e.target.value); pts[p.id] = cur; set("partners", pts); }} />
                  {p.scope === "BRANCH" && (
                    <ThemedSelect className="col-span-2" value={levers.partners?.[p.id]?.branch_id ?? ""}
                      onChange={(e) => { const pts = { ...(levers.partners ?? {}) }; const cur = { ...(pts[p.id] ?? {}) };
                        cur.branch_id = e.target.value || undefined; pts[p.id] = cur; set("partners", pts); }}>
                      <option value="">Region as set ({branches.find((b) => b.id === p.branch_id)?.name ?? "—"})</option>
                      {regions.map((b) => <option key={b.id} value={b.id}>Apply to {b.name}</option>)}
                    </ThemedSelect>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Move a receipt</div>
            <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
              {receipts.map((r) => (
                <div key={r.id} className="grid grid-cols-[1fr_9.5rem] gap-2 items-center">
                  <span className="truncate text-xs">{r.client?.name ?? "—"} · {money(r.amount)} · {formatDate(r.payment_date)}</span>
                  <input type="date" className={inputCls} value={levers.receipt_dates?.[r.id] ?? ""}
                    onChange={(e) => set("receipt_dates", { ...(levers.receipt_dates ?? {}), [r.id]: e.target.value })} />
                </div>
              ))}
              {receipts.length === 0 && <div className="text-xs text-muted-foreground">No receipts this month.</div>}
            </div>
          </section>

          <section>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Move a payment</div>
            <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
              {expenses.map((x) => (
                <div key={x.id} className="grid grid-cols-[1fr_9.5rem] gap-2 items-center">
                  <span className="truncate text-xs">{x.description ?? "Expense"} · {money(x.amount)} · {formatDate(x.expense_date)}</span>
                  <input type="date" className={inputCls} value={levers.expense_dates?.[x.id] ?? ""}
                    onChange={(e) => set("expense_dates", { ...(levers.expense_dates ?? {}), [x.id]: e.target.value })} />
                </div>
              ))}
              {expenses.length === 0 && <div className="text-xs text-muted-foreground">No cash or bank expenses this month.</div>}
            </div>
          </section>

          <section>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Exclude</div>
            <div className="flex flex-wrap gap-2 mb-2">
              {regions.map((b) => {
                const on = levers.exclude_regions?.includes(b.id) ?? false;
                return (
                  <label key={b.id} className="inline-flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={on} onChange={() => set("exclude_regions", on ? (levers.exclude_regions ?? []).filter((x) => x !== b.id) : [...(levers.exclude_regions ?? []), b.id])} />
                    {b.name}
                  </label>
                );
              })}
            </div>
            <SearchBox value={clientQ} onChange={setClientQ} placeholder="Find a client to exclude…" />
            <div className="max-h-40 overflow-y-auto mt-1.5 space-y-1">
              {filteredClients.map((c) => {
                const on = levers.exclude_clients?.includes(c.id) ?? false;
                return (
                  <label key={c.id} className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={on} onChange={() => set("exclude_clients", on ? (levers.exclude_clients ?? []).filter((x) => x !== c.id) : [...(levers.exclude_clients ?? []), c.id])} />
                    <span className="truncate">{c.name}</span>
                  </label>
                );
              })}
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="primary" size="sm" disabled={!changed || busy} onClick={() => void compare(chosen, start)}>
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} Compare with actuals
            </Button>
            <Button variant="secondary" size="sm" disabled={!changed} onClick={() => { setLevers({}); setResults(null); }}>Reset</Button>
          </div>
          <div className="flex items-center gap-2">
            <input className={inputCls} placeholder="Name this scenario to keep it" value={name} onChange={(e) => setName(e.target.value)} />
            <Button variant="secondary" size="sm" disabled={!changed || !name.trim()} onClick={() => void save()}><Save className="w-3.5 h-3.5" /> Save</Button>
          </div>
        </div>
      </Panel>

      <div className="space-y-5">
        <Panel title={`Scenario against actuals${comparedMonth ? ` — ${monthLabel(comparedMonth)}` : ""}`} description="Every figure the levers move: actual, scenario and the delta. Discarded when you leave."
          actions={results && <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show unchanged</label>}
          flush>
          <div className="p-4 md:p-5 space-y-3">
            {state.missing && (
              <div className="text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg px-3 py-2.5">
                scenario_compare() is proposed in migration 0516 and not yet applied. Until it is, one lever works on its own:
                switching head office for a single region, through ho_switch_impact (0515). Every other lever needs 0516.
              </div>
            )}
            {state.error && <div className="text-sm text-danger-600">{state.error}</div>}
            {busy ? <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Computing both…</div>
              : !results ? <div className="py-8 text-center text-sm text-muted-foreground">Set a lever and compare.</div>
              : shownResults.length === 0 ? <div className="py-8 text-center text-sm text-muted-foreground">These levers move nothing this month.</div>
              : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr><th className="text-left py-1.5 font-medium">Figure</th><th className="text-right py-1.5 font-medium">Actual</th>
                      <th className="text-right py-1.5 font-medium">Scenario</th><th className="text-right py-1.5 font-medium">Delta</th></tr>
                  </thead>
                  {sections.map((s) => (
                    <tbody key={s}>
                      <tr><td colSpan={4} className="pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{SECTION_LABEL[s] ?? s}</td></tr>
                      {shownResults.filter((r) => r.section === s).map((r) => (
                        <tr key={`${r.section}${r.subject_id}`} className="border-t border-border/60">
                          <td className="py-1.5 pr-2">{r.subject}</td>
                          <td className="py-1.5 text-right"><Amount v={r.actual} /></td>
                          <td className="py-1.5 text-right"><Amount v={r.scenario} /></td>
                          <td className={`py-1.5 text-right tabular-nums font-semibold ${r.delta > 0 ? "text-success-700 dark:text-success-500" : r.delta < 0 ? "text-danger-700 dark:text-danger-500" : "text-muted-foreground"}`}>{signed(r.delta)}</td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              )}
          </div>
        </Panel>

        <Panel title="Saved scenarios" description="Levers and month only — never a result and never a posting. Open one to recompute it against today's actuals.">
          {saved.length === 0 ? <div className="text-sm text-muted-foreground">None saved{state.missing ? " (saving needs 0516)" : ""}.</div> : (
            <div className="divide-y divide-border">
              {saved.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{s.name}</div>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      <Badge tone="neutral">{monthLabel(s.period)}</Badge>
                      {Object.keys(s.params ?? {}).map((k) => <Badge key={k} tone="info">{k.replace(/_/g, " ")}</Badge>)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="secondary" size="sm" onClick={() => { setLevers(s.params ?? {}); void compare(s.params ?? {}, s.period); }}>Compare</Button>
                    <button type="button" title="Delete" onClick={() => void remove(s.id)} className="p-1.5 text-muted-foreground hover:text-danger-600"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
