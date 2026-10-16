import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { Link } from "react-router";
import Modal from "../../../components/Modal";
import Badge from "../../../components/Badge";
import { supabase } from "../../../lib/supabase";
import { formatDate } from "../../../lib/date";
import {
  Amount, callRpc, money, ProposedNotice, SOURCE_ROUTES, SOURCE_TABLE,
  useCompanyId, type DrillTarget,
} from "./kit";

/**
 * The detail tab: any figure opened to its composition.
 *
 *   figure  → the journal lines that make it up (read from the GL)
 *   line    → its journal entry, both sides
 *   entry   → its source document (the invoice, expense, payslip…)
 *
 * A figure that is an apportionment, not a posting (regional overhead, the
 * head-office share), has no journal lines. It opens to a COMPOSITION instead
 * — the pool and the driver that produce it — and says so, rather than
 * pretending a GL path exists.
 */

type GLLine = {
  id: string; debit: number; credit: number; client_id: string | null; branch_id: string | null;
  account: { account_code: string; account_name: string; account_type: string } | null;
  entry: { id: string; entry_date: string; description: string | null; source_table: string | null; source_id: string | null } | null;
};

const LINE_CAP = 2000;

export default function DetailDrawer({ target, onClose }: { target: DrillTarget | null; onClose: () => void }) {
  const [stack, setStack] = useState<DrillTarget[]>([]);
  useEffect(() => { setStack(target ? [target] : []); }, [target]);
  const cur = stack[stack.length - 1] ?? null;
  const push = (t: DrillTarget) => setStack((s) => [...s, t]);
  const back = () => setStack((s) => s.slice(0, -1));

  const title = !cur ? "" : cur.type === "gl" || cur.type === "composition" || cur.type === "ledger" ? cur.title
    : cur.type === "entry" ? "Journal entry" : `Source document — ${cur.table.replace(/_/g, " ")}`;

  return (
    <Modal isOpen={!!cur} onClose={onClose} title={title} size="lg">
      {stack.length > 1 && (
        <button type="button" onClick={back} className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>
      )}
      {cur?.type === "gl" && <GLView t={cur} onOpen={push} />}
      {cur?.type === "entry" && <EntryView id={cur.id} onOpen={push} />}
      {cur?.type === "source" && <SourceView table={cur.table} id={cur.id} />}
      {cur?.type === "ledger" && <LedgerView t={cur} onOpen={push} />}
      {cur?.type === "composition" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground leading-relaxed">{cur.explanation}</p>
          <table className="w-full text-sm">
            <tbody>
              {cur.rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-2 pr-3">{r.label}</td>
                  <td className="py-2 text-right">
                    <Amount v={r.value} onClick={r.drill ? () => push(r.drill!) : undefined} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function Loading() {
  return <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>;
}

function GLView({ t, onOpen }: { t: Extract<DrillTarget, { type: "gl" }>; onOpen: (t: DrillTarget) => void }) {
  const companyId = useCompanyId();
  const [lines, setLines] = useState<GLLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void (async () => {
      setLines(null); setError(null);
      let q = supabase
        .from("journal_lines")
        .select("id, debit, credit, client_id, branch_id, account:account_id!inner(account_code, account_name, account_type), entry:journal_entry_id!inner(id, entry_date, description, source_table, source_id, company_id)")
        .eq("entry.company_id", companyId)
        .gte("entry.entry_date", t.start)
        .lte("entry.entry_date", t.end)
        .limit(LINE_CAP);
      if (t.accountCodes?.length) q = q.in("account.account_code", t.accountCodes);
      if (t.accountTypes?.length) q = q.in("account.account_type", t.accountTypes);
      if (t.clientId) q = q.eq("client_id", t.clientId);
      if (t.branchId) q = q.eq("branch_id", t.branchId);
      if (t.sourceTables?.length) q = q.in("entry.source_table", t.sourceTables);
      if (t.expenseClientId) {
        // GL expense lines carry no client: find the client's expenses first.
        const { data: ex, error: e1 } = await supabase.from("expenses").select("id").eq("client_id", t.expenseClientId).limit(LINE_CAP);
        if (e1) { if (!cancelled) setError(e1.message); return; }
        const ids = ((ex ?? []) as { id: string }[]).map((r) => r.id);
        if (ids.length === 0) { if (!cancelled) setLines([]); return; }
        q = q.in("entry.source_id", ids);
      }
      const { data, error: e } = await q;
      if (cancelled) return;
      if (e) { setError(e.message); return; }
      const rows = ((data ?? []) as unknown as GLLine[]).sort((a, b) =>
        (a.entry?.entry_date ?? "").localeCompare(b.entry?.entry_date ?? "") || (a.account?.account_code ?? "").localeCompare(b.account?.account_code ?? ""));
      setLines(rows);
    })();
    return () => { cancelled = true; };
  }, [companyId, t]);

  if (error) return <div className="text-sm text-danger-600">{error}</div>;
  if (!lines) return <Loading />;
  // Footer: the sum of the lines shown — the one place arithmetic belongs here.
  const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  return (
    <div className="space-y-3">
      {t.note && <p className="text-xs text-muted-foreground leading-relaxed">{t.note}</p>}
      <p className="text-xs text-muted-foreground">
        {lines.length} journal line{lines.length === 1 ? "" : "s"}, {formatDate(t.start)} – {formatDate(t.end)}. Open a line for its entry and source.
        {lines.length >= LINE_CAP && <strong className="text-warning-700"> Showing the first {LINE_CAP}; narrow the month.</strong>}
      </p>
      <div className="overflow-x-auto border border-border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Date</th>
              <th className="text-left px-3 py-2 font-medium">Account</th>
              <th className="text-left px-3 py-2 font-medium">Entry</th>
              <th className="text-right px-3 py-2 font-medium">Debit</th>
              <th className="text-right px-3 py-2 font-medium">Credit</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground">No journal lines.</td></tr>
            ) : lines.map((l) => (
              <tr key={l.id} className="border-t border-border hover:bg-muted/30 cursor-pointer" onClick={() => l.entry && onOpen({ type: "entry", id: l.entry.id })}>
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(l.entry?.entry_date ?? "")}</td>
                <td className="px-3 py-2 whitespace-nowrap"><span className="font-mono text-xs">{l.account?.account_code}</span> {l.account?.account_name}</td>
                <td className="px-3 py-2 min-w-0"><div className="truncate max-w-[22rem]">{l.entry?.description}</div>
                  <div className="text-[11px] text-muted-foreground">{l.entry?.source_table?.replace(/_/g, " ")}</div></td>
                <td className="px-3 py-2 text-right"><Amount v={Number(l.debit) || null} /></td>
                <td className="px-3 py-2 text-right"><Amount v={Number(l.credit) || null} /></td>
              </tr>
            ))}
          </tbody>
          {lines.length > 0 && (
            <tfoot className="border-t-2 border-border font-semibold">
              <tr>
                <td className="px-3 py-2" colSpan={3}>Total of lines shown · net {money(dr - cr)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(dr)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(cr)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function EntryView({ id, onOpen }: { id: string; onOpen: (t: DrillTarget) => void }) {
  const [entry, setEntry] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error: e } = await supabase
        .from("journal_entries")
        .select("id, entry_date, description, source_table, source_id, is_reversal, manual, posting_period, journal_lines(id, debit, credit, account:account_id(account_code, account_name), branch:branch_id(name), client:client_id(name))")
        .eq("id", id).maybeSingle();
      if (cancelled) return;
      if (e) setError(e.message); else setEntry(data as Record<string, unknown> | null);
    })();
    return () => { cancelled = true; };
  }, [id]);
  if (error) return <div className="text-sm text-danger-600">{error}</div>;
  if (!entry) return <Loading />;
  const lines = (entry.journal_lines ?? []) as { id: string; debit: number; credit: number; account: { account_code: string; account_name: string } | null; branch: { name: string } | null; client: { name: string } | null }[];
  const srcTable = (entry.source_table as string | null) ?? null;
  const srcId = (entry.source_id as string | null) ?? null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{entry.description as string}</span>
        <Badge tone="neutral">{formatDate(entry.entry_date as string)}</Badge>
        {Boolean(entry.is_reversal) && <Badge tone="warning">Reversal</Badge>}
        {Boolean(entry.manual) && <Badge tone="info">Manual</Badge>}
      </div>
      <table className="w-full text-sm border border-border rounded-lg overflow-hidden">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr><th className="text-left px-3 py-2 font-medium">Account</th><th className="text-left px-3 py-2 font-medium">Region · client</th>
            <th className="text-right px-3 py-2 font-medium">Debit</th><th className="text-right px-3 py-2 font-medium">Credit</th></tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-t border-border">
              <td className="px-3 py-2"><span className="font-mono text-xs">{l.account?.account_code}</span> {l.account?.account_name}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{[l.branch?.name, l.client?.name].filter(Boolean).join(" · ") || "—"}</td>
              <td className="px-3 py-2 text-right"><Amount v={Number(l.debit) || null} /></td>
              <td className="px-3 py-2 text-right"><Amount v={Number(l.credit) || null} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {srcTable && srcId ? (
        <button type="button" onClick={() => onOpen({ type: "source", table: SOURCE_TABLE[srcTable] ?? srcTable, id: srcId })}
          className="text-sm text-brand-700 dark:text-brand-500 hover:underline">
          Open the source document ({srcTable.replace(/_/g, " ")}) →
        </button>
      ) : <p className="text-xs text-muted-foreground">No source document: this entry was posted directly.</p>}
    </div>
  );
}

/** Columns worth showing first on a source row; the rest follow. */
const LEAD = ["invoice_number", "description", "full_name", "amount", "invoice_amount", "net_salary", "final_salary",
  "payment_date", "expense_date", "invoice_date", "service_month", "period_month", "payment_mode", "status", "notes"];

function SourceView({ table, id }: { table: string; id: string }) {
  const [row, setRow] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error: e } = await supabase.from(table).select("*").eq("id", id).maybeSingle();
      if (cancelled) return;
      if (e) setError(e.message); else if (!data) setError("This document is not readable with your permissions, or no longer exists."); else setRow(data as Record<string, unknown>);
    })();
    return () => { cancelled = true; };
  }, [table, id]);
  if (error) return <div className="text-sm text-danger-600">{error}</div>;
  if (!row) return <Loading />;
  const keys = Object.keys(row).filter((k) => !/(^id$|_id$|^company_id$|created_at|updated_at|drive_|attachment_path|variable_grid)/.test(k) && row[k] != null && row[k] !== "");
  keys.sort((a, b) => (LEAD.indexOf(a) === -1 ? 99 : LEAD.indexOf(a)) - (LEAD.indexOf(b) === -1 ? 99 : LEAD.indexOf(b)));
  const route = SOURCE_ROUTES[table];
  const view = (row.drive_view_url as string | null) ?? null;
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {keys.map((k) => (
          <div key={k} className="min-w-0">
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">{k.replace(/_/g, " ")}</dt>
            <dd className="break-words">{typeof row[k] === "object" ? JSON.stringify(row[k]) : String(row[k])}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-4 text-sm">
        {view && <a href={view} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-700 dark:text-brand-500 hover:underline">Attachment <ExternalLink className="w-3.5 h-3.5" /></a>}
        {route && <Link to={route.href} className="inline-flex items-center gap-1 text-brand-700 dark:text-brand-500 hover:underline">Open in {route.label} <ExternalLink className="w-3.5 h-3.5" /></Link>}
      </div>
    </div>
  );
}

type LedgerRow = { row_kind: "OPENING" | "LINE" | "CLOSING"; entry_date: string; journal_entry_id: string | null; source_table: string | null;
  description: string | null; account_code: string | null; debit: number | null; credit: number | null; balance: number };

export function LedgerTable({ rows, onOpen }: { rows: LedgerRow[]; onOpen: (t: DrillTarget) => void }) {
  return (
    <div className="overflow-x-auto border border-border rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Date</th>
            <th className="text-left px-3 py-2 font-medium">Particulars</th>
            <th className="text-right px-3 py-2 font-medium">Debit</th>
            <th className="text-right px-3 py-2 font-medium">Credit</th>
            <th className="text-right px-3 py-2 font-medium">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const edge = r.row_kind !== "LINE";
            return (
              <tr key={i} className={`border-t border-border ${edge ? "bg-muted/30 font-semibold" : "hover:bg-muted/30 cursor-pointer"}`}
                onClick={() => !edge && r.journal_entry_id && onOpen({ type: "entry", id: r.journal_entry_id })}>
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(r.entry_date)}</td>
                <td className="px-3 py-2 min-w-0"><div className="truncate max-w-[24rem]">{r.description}</div>
                  {!edge && <div className="text-[11px] text-muted-foreground">{[r.account_code, r.source_table?.replace(/_/g, " ")].filter(Boolean).join(" · ")}</div>}</td>
                <td className="px-3 py-2 text-right"><Amount v={r.debit} /></td>
                <td className="px-3 py-2 text-right"><Amount v={r.credit} /></td>
                <td className="px-3 py-2 text-right"><Amount v={r.balance} strong={edge} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LedgerView({ t, onOpen }: { t: Extract<DrillTarget, { type: "ledger" }>; onOpen: (t: DrillTarget) => void }) {
  const companyId = useCompanyId();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [state, setState] = useState<{ error: string | null; missing: boolean }>({ error: null, missing: false });
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void (async () => {
      setRows(null);
      const r = await callRpc<LedgerRow[]>("ledger_statement", { p_company_id: companyId, p_kind: t.kind, p_subject_id: t.subjectId, p_start: t.start, p_end: t.end });
      if (cancelled) return;
      setState({ error: r.error, missing: r.missing });
      setRows(r.data ?? []);
    })();
    return () => { cancelled = true; };
  }, [companyId, t]);
  if (state.missing) return <ProposedNotice fn="ledger_statement" what="This ledger" />;
  if (state.error) return <div className="text-sm text-danger-600">{state.error}</div>;
  if (!rows) return <Loading />;
  return <LedgerTable rows={rows} onOpen={onOpen} />;
}
