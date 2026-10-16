import { useEffect, useMemo, useState } from "react";
import { BookOpen, Loader2 } from "lucide-react";
import Tabs from "../../../components/Tabs";
import ThemedSelect from "../../../components/ThemedSelect";
import { Panel, SearchBox, inputCls } from "../_assetsKit";
import { supabase } from "../../../lib/supabase";
import { formatDate } from "../../../lib/date";
import { usePageState } from "../../../lib/pageState";
import { LedgerTable } from "./DetailDrawer";
import { Amount, callRpc, monthEnd, ProposedNotice, useCompanyId, useDrill } from "./kit";

/**
 * The ledgers: general, client, supplier, partner, guard. Each shows opening,
 * movement and closing, and every line opens to its entry and source.
 *
 * The arithmetic — opening, running balance, closing — is the database's
 * (ledger_statement, proposed in 0516). The partner ledger is partner_ledger(),
 * the decided definition (0445/0476): it includes custody, which the partner's
 * capital account alone does not, so a second definition built from GL lines
 * would disagree with the one partners are paid on.
 */

type Kind = "account" | "client" | "supplier" | "partner" | "guard";
type Opt = { id: string; label: string };
type PartnerRow = { entry_date: string; particulars: string; cash_paid: number; remuneration: number; balance: number; source: string; entry_id: string | null };

export default function LedgersTab({ period }: { period: string }) {
  const companyId = useCompanyId();
  const drill = useDrill();
  const [kind, setKind] = usePageState<Kind>("Reports.ledgerKind", "account");
  const [subject, setSubject] = useState<string>("");
  const [opts, setOpts] = useState<Opt[]>([]);
  const [guardQ, setGuardQ] = useState("");
  const [from, setFrom] = useState(`${period.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(monthEnd(period));
  const [rows, setRows] = useState<unknown[] | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null; missing: boolean }>({ loading: false, error: null, missing: false });

  useEffect(() => { setTo(monthEnd(period)); }, [period]);

  // Subjects for the chosen kind.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void (async () => {
      setSubject(""); setRows(null);
      let list: Opt[] = [];
      if (kind === "account") {
        const { data } = await supabase.from("chart_of_accounts").select("id, account_code, account_name").eq("company_id", companyId).eq("active", true).order("account_code");
        list = ((data ?? []) as { id: string; account_code: string; account_name: string }[]).map((a) => ({ id: a.id, label: `${a.account_code} — ${a.account_name}` }));
      } else if (kind === "client") {
        const { data } = await supabase.from("clients").select("id, name, client_code").eq("company_id", companyId).order("name");
        list = ((data ?? []) as { id: string; name: string; client_code: string | null }[]).map((c) => ({ id: c.id, label: c.client_code ? `${c.name} (${c.client_code})` : c.name }));
      } else if (kind === "supplier") {
        const { data } = await supabase.from("vendors").select("id, name").eq("company_id", companyId).order("name");
        list = ((data ?? []) as { id: string; name: string }[]).map((v) => ({ id: v.id, label: v.name }));
      } else if (kind === "partner") {
        const { data } = await supabase.from("partners").select("id, name, scope").eq("company_id", companyId).order("name");
        list = ((data ?? []) as { id: string; name: string; scope: string }[]).map((p) => ({ id: p.id, label: `${p.name} — ${p.scope === "BRANCH" ? "regional" : "equity"}` }));
      }
      if (!cancelled) setOpts(list);
    })();
    return () => { cancelled = true; };
  }, [companyId, kind]);

  // Guards are too many for a dropdown: search them.
  useEffect(() => {
    if (!companyId || kind !== "guard") return;
    const term = guardQ.trim();
    if (term.length < 2) { setOpts([]); return; }
    let cancelled = false;
    const h = setTimeout(() => {
      void (async () => {
        const like = `%${term.replace(/[%,()*]/g, " ")}%`;
        const { data } = await supabase.from("employees").select("id, full_name, guard_code, employee_code")
          .eq("company_id", companyId).or(`full_name.ilike.${like},guard_code.ilike.${like},employee_code.ilike.${like}`).limit(20);
        if (!cancelled) setOpts(((data ?? []) as { id: string; full_name: string; guard_code: string | null; employee_code: string | null }[])
          .map((e) => ({ id: e.id, label: `${e.full_name} (${e.guard_code ?? e.employee_code ?? "—"})` })));
      })();
    }, 250);
    return () => { cancelled = true; clearTimeout(h); };
  }, [companyId, kind, guardQ]);

  useEffect(() => {
    if (!companyId || !subject) { setRows(null); return; }
    let cancelled = false;
    void (async () => {
      setState({ loading: true, error: null, missing: false }); setRows(null);
      if (kind === "partner") {
        const { data, error } = await supabase.rpc("partner_ledger", { p_partner_id: subject, p_start: from, p_end: to });
        if (cancelled) return;
        setState({ loading: false, error: error?.message ?? null, missing: false });
        setRows((data ?? []) as PartnerRow[]);
        return;
      }
      const r = await callRpc<unknown[]>("ledger_statement", { p_company_id: companyId, p_kind: kind, p_subject_id: subject, p_start: from, p_end: to });
      if (cancelled) return;
      setState({ loading: false, error: r.missing ? null : r.error, missing: r.missing });
      setRows(r.data ?? []);
    })();
    return () => { cancelled = true; };
  }, [companyId, kind, subject, from, to]);

  const label = useMemo(() => opts.find((o) => o.id === subject)?.label ?? "", [opts, subject]);

  return (
    <Panel icon={BookOpen} title="Ledgers"
      description="Opening, every movement, closing — and every line opens to its journal entry and source document."
      flush>
      <div className="flex flex-col gap-3 px-4 md:px-5 py-3 border-b border-border">
        <Tabs<Kind> size="sm" value={kind} onChange={(k) => { setKind(k); setGuardQ(""); }}
          items={[{ value: "account", label: "General ledger" }, { value: "client", label: "Client" }, { value: "supplier", label: "Supplier" },
            { value: "partner", label: "Partner" }, { value: "guard", label: "Guard" }]} />
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          {kind === "guard" ? (
            <div className="w-full lg:w-96 space-y-1.5">
              <SearchBox value={guardQ} onChange={setGuardQ} placeholder="Search a guard by name or code…" />
              {opts.length > 0 && (
                <ThemedSelect className="w-full" value={subject} onChange={(e) => setSubject(e.target.value)}>
                  <option value="">Choose a guard…</option>
                  {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </ThemedSelect>
              )}
            </div>
          ) : (
            <div className="w-full lg:w-96">
              <ThemedSelect className="w-full" value={subject} onChange={(e) => setSubject(e.target.value)}>
                <option value="">{kind === "account" ? "Choose an account…" : kind === "client" ? "Choose a client…" : kind === "supplier" ? "Choose a supplier…" : "Choose a partner…"}</option>
                {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </ThemedSelect>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-muted-foreground">From
            <input type="date" className={inputCls + " w-auto"} value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">To
            <input type="date" className={inputCls + " w-auto"} value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        </div>
      </div>
      <div className="p-3 md:p-4 space-y-2">
        {!subject ? <div className="py-8 text-center text-sm text-muted-foreground">Choose what to open.</div>
          : state.missing ? <ProposedNotice fn="ledger_statement" what="This ledger" />
          : state.error ? <div className="text-sm text-danger-600">{state.error}</div>
          : state.loading || !rows ? <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          : kind === "partner" ? <PartnerLedger rows={rows as PartnerRow[]} title={label} onOpen={drill} />
          : (
            <>
              <div className="text-xs text-muted-foreground">{label} · {formatDate(from)} – {formatDate(to)}. Balance is debit less credit.</div>
              <LedgerTable rows={rows as never} onOpen={drill} />
            </>
          )}
      </div>
    </Panel>
  );
}

function PartnerLedger({ rows, title, onOpen }: { rows: PartnerRow[]; title: string; onOpen: ReturnType<typeof useDrill> }) {
  if (rows.length === 0) return <div className="py-6 text-center text-sm text-muted-foreground">No entries in this range.</div>;
  return (
    <>
      <div className="text-xs text-muted-foreground">{title} · partner_ledger: positive balance = the company owes the partner (DECIDED).</div>
      <div className="overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr><th className="text-left px-3 py-2 font-medium">Date</th><th className="text-left px-3 py-2 font-medium">Particulars</th>
              <th className="text-right px-3 py-2 font-medium">Cash paid</th><th className="text-right px-3 py-2 font-medium">Remuneration</th>
              <th className="text-right px-3 py-2 font-medium">Balance</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={`border-t border-border ${r.entry_id ? "hover:bg-muted/30 cursor-pointer" : ""}`}
                onClick={() => r.entry_id && onOpen({ type: "source", table: "partner_account_entries", id: r.entry_id })}>
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(r.entry_date)}</td>
                <td className="px-3 py-2 min-w-0"><div className="truncate max-w-[24rem]">{r.particulars}</div>
                  <div className="text-[11px] text-muted-foreground">{r.source}</div></td>
                <td className="px-3 py-2 text-right"><Amount v={r.cash_paid || null} /></td>
                <td className="px-3 py-2 text-right"><Amount v={r.remuneration || null} /></td>
                <td className="px-3 py-2 text-right"><Amount v={r.balance} strong /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
