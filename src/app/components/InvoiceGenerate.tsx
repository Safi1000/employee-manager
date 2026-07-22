import ThemedSelect from "./ThemedSelect";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, AlertCircle, X, CheckCircle2, FileDown, Plus, Trash2, FileText } from "lucide-react";
import Button from "./Button";
import { useAuth } from "../lib/auth";
import { generateInvoiceDocument } from "../lib/invoiceTemplates";
import {
  supabase,
  CONTRACT_LINE_CATEGORY_LABEL,
  CLIENT_INVOICE_GROUP_LABEL,
  DEFAULT_INVOICE_SETTINGS,
  effectiveCommittedByCategory,
  computeInvoiceTaxes,
  financialYearLabel,
  amountInWords,
  type Client,
  type Contract,
  type ContractLine,
  type ContractAddendum,
  type Invoice,
  type InvoiceLine,
  type InvoiceTax,
  type ClientInvoiceGroup,
  type RemitAccount,
} from "../lib/supabase";

type DraftLine = { category: InvoiceLine["category"]; label: string; quantity: string; unit_rate: string; taxable: boolean };
type DraftTax = { name: string; rate: string; base: InvoiceTax["base"]; direction: InvoiceTax["direction"]; component?: string };

// One draft per active contract that has no invoice yet for the selected period.
type Draft = {
  contractId: string;
  contractCode: string;
  client: Client;
  invoiceNumber: string;
  periodStart: string;
  periodEnd: string;
  lines: DraftLine[];
  taxes: DraftTax[];
  notes: string;
  remitIndex: number; // index into client's remit_accounts
  overrideTotal: string;
  overrideReason: string;
  previousBalance: number;
  // Per-draft ready-to-post toggle. A draft is reviewed, then "Cleared", then
  // batch-posted by "Generate All Cleared" into a real Unpaid invoice.
  status: "Pending" | "Cleared";
};

type StatusFilter = "all" | "pending" | "cleared";

// A rendered row is either an already-generated invoice or a draftable contract.
type Row =
  | { kind: "existing"; key: string; client: Client; contract: Contract; invoice: Invoice }
  | { kind: "draft"; key: string; client: Client; contract: Contract };

const num = (s: string) => Number(s) || 0;
const monthKey = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

// Billing month of an invoice: period_start when present (generation path), else
// invoice_date (manual path). Matches the DB uq_invoice_contract_month index.
const invoiceMonth = (inv: Invoice) => (inv.period_start ?? inv.invoice_date ?? "").slice(0, 7);
const isCleared = (inv: Invoice) => inv.status === "Paid";

// End-of-month date string for a YYYY-MM period.
const monthBounds = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  const start = `${ym}-01`;
  const last = new Date(y, m, 0).getDate();
  const end = `${ym}-${String(last).padStart(2, "0")}`;
  return { start, end };
};

export default function InvoiceGenerate({ onPosted }: { onPosted: () => void }) {
  const { company } = useAuth();
  const [clients, setClients] = useState<Client[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [lines, setLines] = useState<ContractLine[]>([]);
  const [addendums, setAddendums] = useState<ContractAddendum[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const [period, setPeriod] = useState(monthKey());
  const [group, setGroup] = useState<ClientInvoiceGroup>("FIXED");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Editable drafts, keyed by contract id. Rebuilt whenever the filters or the
  // underlying data change (so any contract that just got an invoice drops out).
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const loadData = async () => {
    setLoading(true);
    const [cliRes, conRes, lineRes, addRes, invRes] = await Promise.all([
      supabase.from("clients").select("*").order("name"),
      supabase.from("contracts").select("*"),
      supabase.from("contract_lines").select("*"),
      supabase.from("contract_addendums").select("*"),
      supabase.from("invoices").select("*"),
    ]);
    setClients((cliRes.data ?? []) as Client[]);
    setContracts((conRes.data ?? []) as Contract[]);
    setLines((lineRes.data ?? []) as ContractLine[]);
    setAddendums((addRes.data ?? []) as ContractAddendum[]);
    setInvoices((invRes.data ?? []) as Invoice[]);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, []);

  const groupClients = useMemo(
    () => clients.filter((c) => (c.invoice_group ?? "FIXED") === group),
    [clients, group],
  );

  const suggestNumber = useCallback(
    (client: Client, contract: Contract, taken: Set<string>): string => {
      const fy = financialYearLabel(`${period}-01`).replace("FY ", "");
      const ym = period.replace("-", "");
      const base = `INV-${fy}-${client.client_code}-${contract.contract_code}-${ym}`;
      if (!taken.has(base)) return base;
      let n = 2;
      while (taken.has(`${base}-${n}`)) n++;
      return `${base}-${n}`;
    },
    [period],
  );

  // Previous Balance is scoped PER CONTRACT, never per client: only THIS
  // contract's own most-recent prior invoice carries forward, and only while it
  // is still unpaid. Gated by the company's per-template toggle.
  const contractPreviousBalance = useCallback(
    (contractId: string): number => {
      const settings = { ...DEFAULT_INVOICE_SETTINGS, ...(company?.invoice_settings ?? {}) };
      const enabled =
        group === "VARIABLE"
          ? settings.variable_show_previous_balance
          : group === "FIXED"
            ? settings.fixed_show_previous_balance
            : false;
      if (!enabled) return 0;
      const priors = invoices
        .filter((i) => i.contract_id === contractId && invoiceMonth(i) < period)
        .sort((a, b) => (invoiceMonth(a) < invoiceMonth(b) ? 1 : -1));
      const last = priors[0];
      if (!last) return 0;
      const unpaid = last.status === "Unpaid" || last.status === "Pending" || last.status === "Partly-Paid";
      if (!unpaid) return 0;
      const outstanding = Number(last.total_due ?? last.invoice_amount ?? 0) - Number(last.amount_received ?? 0);
      return Math.max(0, outstanding);
    },
    [invoices, period, group, company],
  );

  const buildDraft = useCallback(
    (client: Client, con: Contract, taken: Set<string>): Draft | null => {
      const { start, end } = monthBounds(period);
      const conLines = lines.filter((l) => l.contract_id === con.id);
      const conAdds = addendums.filter((a) => a.contract_id === con.id);
      const eff = effectiveCommittedByCategory(conLines, conAdds, end);
      const draftLines: DraftLine[] = [];
      for (const l of conLines) {
        const single = conLines.filter((x) => x.category === l.category).length === 1;
        const qty = single && eff.get(l.category) != null ? eff.get(l.category)! : l.committed_count;
        if (qty <= 0 && l.unit_rate <= 0) continue;
        draftLines.push({
          category: l.category,
          label: l.label ?? CONTRACT_LINE_CATEGORY_LABEL[l.category],
          quantity: String(qty),
          unit_rate: String(l.unit_rate),
          taxable: l.taxable,
        });
      }
      if (draftLines.length === 0) return null;
      const taxes: DraftTax[] = (client.tax_profile ?? []).map((t) => ({
        name: t.name,
        rate: String(t.rate),
        base: t.base,
        direction: t.direction,
        component: t.component,
      }));
      const remitIndex = Math.max(0, (client.remit_accounts ?? []).findIndex((r) => r.is_default));
      const number = suggestNumber(client, con, taken);
      taken.add(number);
      return {
        contractId: con.id,
        contractCode: con.contract_code,
        client,
        invoiceNumber: number,
        periodStart: start,
        periodEnd: end,
        lines: draftLines,
        taxes,
        notes: "",
        remitIndex,
        overrideTotal: "",
        overrideReason: "",
        previousBalance: contractPreviousBalance(con.id),
        status: "Pending",
      };
    },
    [period, lines, addendums, invoices, suggestNumber, contractPreviousBalance],
  );

  // Rebuild drafts on any filter/data change. A contract that already has an
  // invoice for the period is skipped here (no draft) — that's the per-contract
  // dedupe for the generation path.
  useEffect(() => {
    if (loading) return;
    const taken = new Set(invoices.map((i) => i.invoice_number.trim().toLowerCase()));
    const next: Record<string, Draft> = {};
    for (const client of groupClients) {
      const clientContracts = contracts.filter((c) => c.client_id === client.id && c.status === "active");
      for (const con of clientContracts) {
        const already = invoices.some((i) => i.contract_id === con.id && invoiceMonth(i) === period);
        if (already) continue;
        const d = buildDraft(client, con, taken);
        if (d) {
          // suggestNumber uses lowercase-insensitive set; register the built one.
          taken.add(d.invoiceNumber.trim().toLowerCase());
          next[con.id] = d;
        }
      }
    }
    setDrafts(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, period, group, clients, contracts, lines, addendums, invoices]);

  // The full filterable row set: existing invoices + draftable contracts, then
  // narrowed by the Status filter.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const client of groupClients) {
      const clientContracts = contracts.filter((c) => c.client_id === client.id && c.status === "active");
      for (const con of clientContracts) {
        const existing = invoices.find((i) => i.contract_id === con.id && invoiceMonth(i) === period);
        if (existing) {
          out.push({ kind: "existing", key: con.id, client, contract: con, invoice: existing });
        } else if (drafts[con.id]) {
          out.push({ kind: "draft", key: con.id, client, contract: con });
        }
      }
    }
    return out.filter((r) => {
      if (statusFilter === "all") return true;
      // A posted invoice is "cleared" when fully paid; a draft is "cleared" once
      // the user has marked it ready to post. Both honour the same filter.
      const cleared = r.kind === "existing" ? isCleared(r.invoice) : drafts[r.key]?.status === "Cleared";
      return statusFilter === "cleared" ? cleared : !cleared;
    });
  }, [groupClients, contracts, invoices, drafts, period, statusFilter]);

  const draftRows = rows.filter((r) => r.kind === "draft");
  const existingRows = rows.filter((r) => r.kind === "existing");
  const clearedCount = Object.values(drafts).filter((d) => d.status === "Cleared").length;

  // Derived figures for a draft.
  const figures = (d: Draft) => {
    const subtotal = d.lines.reduce((s, l) => s + num(l.quantity) * num(l.unit_rate), 0);
    const { computed, addedTotal, withheldTotal } = computeInvoiceTaxes(
      subtotal,
      d.taxes.map((t) => ({ name: t.name, rate: num(t.rate), base: t.base, direction: t.direction, component: t.component ?? null })),
    );
    const lineTotal = subtotal + addedTotal - withheldTotal + d.previousBalance;
    const overridden = d.overrideTotal.trim() !== "" && num(d.overrideTotal) !== lineTotal;
    const totalDue = overridden ? num(d.overrideTotal) : lineTotal;
    return { subtotal, computed, addedTotal, withheldTotal, lineTotal, totalDue, overridden };
  };

  const patchDraft = (contractId: string, patch: Partial<Draft>) =>
    setDrafts((prev) => (prev[contractId] ? { ...prev, [contractId]: { ...prev[contractId], ...patch } } : prev));

  const toggleCleared = (contractId: string) =>
    setDrafts((prev) => {
      const d = prev[contractId];
      if (!d) return prev;
      return { ...prev, [contractId]: { ...d, status: d.status === "Cleared" ? "Pending" : "Cleared" } };
    });

  // Post a single cleared draft: insert the invoice (with contract_id), its
  // lines and taxes, then generate the PDF. Throws on any failure so the batch
  // can stop and report which client. Shared by "Generate All Cleared".
  const postDraft = async (d: Draft) => {
    const f = figures(d);
    const remit: RemitAccount | null = (d.client.remit_accounts ?? [])[d.remitIndex] ?? null;
    const invoiceAmount = f.subtotal + f.addedTotal; // current-period gross
    const insertRow = {
      client_id: d.client.id,
      contract_id: d.contractId,
      invoice_number: d.invoiceNumber.trim(),
      invoice_date: today(),
      invoice_amount: invoiceAmount,
      withholding_tax: f.withheldTotal,
      amount_received: 0,
      status: "Unpaid" as const,
      notes: d.notes.trim() || null,
      period_start: d.periodStart,
      period_end: d.periodEnd,
      subtotal: f.subtotal,
      tax_added_total: f.addedTotal,
      tax_withheld_total: f.withheldTotal,
      previous_balance: d.previousBalance,
      total_due: f.totalDue,
      amount_in_words: amountInWords(f.totalDue),
      remit_account: remit,
      override_reason: f.overridden ? d.overrideReason.trim() : null,
      financial_year: financialYearLabel(`${period}-01`),
      invoice_group: group,
      generated: true,
    };
    const { data: ins, error: insErr } = await supabase.from("invoices").insert(insertRow).select().single();
    if (insErr) {
      // The DB unique index surfaces a duplicate here as a friendly message.
      const dup = /uq_invoice_contract_month|duplicate key/i.test(insErr.message);
      throw new Error(
        dup
          ? `${d.client.name} (${d.contractCode}): an invoice for this contract already exists for ${period}.`
          : `${d.client.name} (${d.invoiceNumber}): ${insErr.message}`,
      );
    }
    const invoice = ins as Invoice;
    const lineRows = d.lines.map((l, i) => ({
      invoice_id: invoice.id,
      category: l.category,
      label: l.label,
      quantity: Math.floor(num(l.quantity)),
      unit_rate: num(l.unit_rate),
      amount: num(l.quantity) * num(l.unit_rate),
      taxable: l.taxable,
      sort_order: i,
    }));
    if (lineRows.length) {
      const { error: lErr } = await supabase.from("invoice_lines").insert(lineRows);
      if (lErr) throw lErr;
    }
    const taxRows = f.computed.map((t, i) => ({
      invoice_id: invoice.id,
      name: t.name,
      rate: t.rate,
      base: t.base,
      direction: t.direction,
      component: t.component ?? null,
      amount: t.amount,
      sort_order: i,
    }));
    if (taxRows.length) {
      const { error: tErr } = await supabase.from("invoice_taxes").insert(taxRows);
      if (tErr) throw tErr;
    }
    // Template is auto-selected by the client's invoice_group inside
    // generateInvoiceDocument. Pass the contract + its lines so SLA can read the
    // cost build-up and the Fixed/Variable tables render per-contract.
    generateInvoiceDocument({
      invoice,
      client: d.client,
      company: company ?? null,
      contract: contracts.find((c) => c.id === d.contractId) ?? null,
      contractLines: lines.filter((l) => l.contract_id === d.contractId),
      invoiceLines: lineRows.map((l) => ({ ...l }) as InvoiceLine),
      taxes: taxRows.map((t) => ({ ...t }) as InvoiceTax),
    });
  };

  // Batch-post every currently Cleared draft into an Unpaid invoice + PDF.
  const generateAllCleared = async () => {
    const cleared = Object.values(drafts).filter((d) => d.status === "Cleared");
    if (cleared.length === 0) {
      setError("Clear at least one draft first.");
      return;
    }
    setError(null);
    setResult(null);

    // Up-front guards so nothing is written if any draft is invalid.
    const existingNumbers = new Set(invoices.map((i) => i.invoice_number.trim().toLowerCase()));
    const seenInBatch = new Set<string>();
    for (const d of cleared) {
      const f = figures(d);
      if (f.overridden && !d.overrideReason.trim()) {
        setError(`${d.client.name}: an override total needs a reason.`);
        return;
      }
      const key = d.invoiceNumber.trim().toLowerCase();
      if (existingNumbers.has(key)) {
        setError(`${d.client.name} (${d.invoiceNumber}): that invoice number already exists.`);
        return;
      }
      if (seenInBatch.has(key)) {
        setError(`Invoice number ${d.invoiceNumber} is used by more than one draft in this batch.`);
        return;
      }
      seenInBatch.add(key);
      // Mirrors the DB rule (uq_invoice_contract_month): one per contract/period.
      if (invoices.some((i) => i.contract_id === d.contractId && invoiceMonth(i) === period)) {
        setError(`${d.client.name} (${d.contractCode}): this contract already has an invoice for ${period}.`);
        return;
      }
    }

    setGenerating(true);
    let posted = 0;
    try {
      for (const d of cleared) {
        await postDraft(d);
        posted++;
      }
      setResult(`Posted ${posted} invoice${posted === 1 ? "" : "s"} as Unpaid and generated PDFs.`);
      await loadData();
      onPosted();
    } catch (err: any) {
      setError(
        `${err.message ?? String(err)}${posted > 0 ? ` (${posted} already posted before this)` : ""}`,
      );
      await loadData();
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
        </div>
      )}
      {result && (
        <div className="flex items-start gap-2 p-3 bg-success-50 text-success-700 border border-success-200 rounded-md text-sm">
          <CheckCircle2 className="w-4 h-4 mt-0.5" />
          <div className="flex-1">{result}</div>
          <button onClick={() => setResult(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Filters — selecting Period / Client Group / Status updates the view
          immediately; there is no separate build step. */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Period</label>
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Client group</label>
          <ThemedSelect
            value={group}
            onChange={(e) => setGroup(e.target.value as ClientInvoiceGroup)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            {(["FIXED", "VARIABLE", "SLA"] as const).map((g) => (
              <option key={g} value={g}>{CLIENT_INVOICE_GROUP_LABEL[g]}</option>
            ))}
          </ThemedSelect>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Status</label>
          <ThemedSelect
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="cleared">Cleared</option>
          </ThemedSelect>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-slate-500">
            {existingRows.length} invoiced · {draftRows.length} to generate · {clearedCount} cleared
          </span>
          <Button
            variant="primary"
            size="md"
            onClick={generateAllCleared}
            disabled={generating || clearedCount === 0}
          >
            {generating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileDown className="w-4 h-4 mr-2" />}
            Generate All Cleared
          </Button>
        </div>
      </div>

      {loading && (
        <div className="text-center py-10 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="text-center py-10 text-slate-500 text-sm">
          No active contracts match this period, group and status.
        </div>
      )}

      {/* Already-generated invoices for the period (read-only summary). */}
      {existingRows.map((r) => {
        if (r.kind !== "existing") return null;
        const inv = r.invoice;
        const cleared = isCleared(inv);
        return (
          <div key={`inv-${r.key}`} className="bg-white border border-slate-200 rounded-lg p-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 truncate">{r.client.name}</div>
              <div className="text-xs text-slate-500 font-mono">
                {r.contract.contract_code} · {inv.invoice_number}
              </div>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <div className="text-right">
                <div className="text-sm font-semibold text-slate-900 tabular-nums">
                  PKR {Number(inv.total_due ?? inv.invoice_amount).toLocaleString()}
                </div>
                <div className="text-[11px] text-slate-500">{inv.invoice_number}</div>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-md border ${cleared ? "bg-success-50 text-success-700 border-success-200" : "bg-warning-50 text-warning-700 border-warning-200"}`}>
                {cleared ? "Cleared" : "Pending"}
              </span>
              <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                <FileText className="w-3.5 h-3.5" /> generated
              </span>
            </div>
          </div>
        );
      })}

      {/* Draftable contracts (no invoice yet this period). */}
      {draftRows.map((r) => {
        const d = drafts[r.key];
        if (!d) return null;
        const f = figures(d);
        const remitAccounts = d.client.remit_accounts ?? [];
        return (
          <div key={`draft-${r.key}`} className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-slate-900">{d.client.name}</div>
                <div className="text-xs text-slate-500 font-mono">
                  {d.client.client_code} · contract {d.contractCode}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded-md border ${d.status === "Cleared" ? "bg-success-50 text-success-700 border-success-200" : "bg-warning-50 text-warning-700 border-warning-200"}`}>
                  {d.status}
                </span>
                <Button
                  variant={d.status === "Cleared" ? "secondary" : "primary"}
                  size="sm"
                  disabled={generating}
                  onClick={() => toggleCleared(d.contractId)}
                >
                  {d.status === "Cleared" ? "Reopen" : "Clear"}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Invoice #</label>
                <input
                  value={d.invoiceNumber}
                  onChange={(e) => patchDraft(d.contractId, { invoiceNumber: e.target.value })}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Period start</label>
                <input type="date" value={d.periodStart} onChange={(e) => patchDraft(d.contractId, { periodStart: e.target.value })} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Period end</label>
                <input type="date" value={d.periodEnd} onChange={(e) => patchDraft(d.contractId, { periodEnd: e.target.value })} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm" />
              </div>
            </div>

            {/* Line items */}
            <div className="border border-slate-200 rounded overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-500 uppercase border-b border-slate-200">
                    <th className="text-left px-2 py-1.5">Description</th>
                    <th className="text-right px-2 py-1.5 w-24">Qty</th>
                    <th className="text-right px-2 py-1.5 w-32">Rate</th>
                    <th className="text-right px-2 py-1.5 w-32">Amount</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {d.lines.map((l, li) => (
                    <tr key={li}>
                      <td className="px-2 py-1">
                        <input
                          value={l.label}
                          onChange={(e) => patchDraft(d.contractId, { lines: d.lines.map((x, j) => (j === li ? { ...x, label: e.target.value } : x)) })}
                          className="w-full px-2 py-1 border border-slate-200 rounded text-sm"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input type="number" min="0" value={l.quantity}
                          onChange={(e) => patchDraft(d.contractId, { lines: d.lines.map((x, j) => (j === li ? { ...x, quantity: e.target.value } : x)) })}
                          className="w-full px-2 py-1 border border-slate-200 rounded text-sm text-right" />
                      </td>
                      <td className="px-2 py-1">
                        <input type="number" min="0" step="0.01" value={l.unit_rate}
                          onChange={(e) => patchDraft(d.contractId, { lines: d.lines.map((x, j) => (j === li ? { ...x, unit_rate: e.target.value } : x)) })}
                          className="w-full px-2 py-1 border border-slate-200 rounded text-sm text-right" />
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-700">
                        {(num(l.quantity) * num(l.unit_rate)).toLocaleString()}
                      </td>
                      <td className="px-1 py-1 text-center">
                        <button onClick={() => patchDraft(d.contractId, { lines: d.lines.filter((_, j) => j !== li) })} className="text-danger-600 hover:bg-danger-50 rounded p-1">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                onClick={() => patchDraft(d.contractId, { lines: [...d.lines, { category: null, label: "", quantity: "0", unit_rate: "0", taxable: true }] })}
                className="text-xs text-brand-600 hover:text-brand-700 px-2 py-1.5 inline-flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Add line
              </button>
            </div>

            {/* Totals + taxes + remit */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-xs text-slate-500">Remit account</label>
                <ThemedSelect
                  value={d.remitIndex}
                  onChange={(e) => patchDraft(d.contractId, { remitIndex: Number(e.target.value) })}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                >
                  {remitAccounts.length === 0 && <option value={-1}>No remit accounts configured</option>}
                  {remitAccounts.map((r, ri) => (
                    <option key={ri} value={ri}>
                      {r.account_title} — {r.account_number} ({r.bank_name}){r.is_default ? " ★" : ""}
                    </option>
                  ))}
                </ThemedSelect>
                <label className="block text-xs text-slate-500 mt-2">Notes</label>
                <textarea value={d.notes} onChange={(e) => patchDraft(d.contractId, { notes: e.target.value })} rows={2} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm" />
              </div>
              <div className="text-sm space-y-1">
                <Row label="Subtotal" value={f.subtotal} />
                {f.computed.map((t, ti) => (
                  <Row key={ti} label={`${t.name} (${t.rate}%)`} value={t.direction === "WITHHELD" ? -t.amount : t.amount} muted />
                ))}
                {d.previousBalance !== 0 && <Row label="Previous balance" value={d.previousBalance} muted />}
                <div className="flex items-center justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900">
                  <span>Total Due{f.withheldTotal > 0 ? " (net of withholding)" : ""}</span>
                  <span className="tabular-nums">PKR {f.totalDue.toLocaleString()}</span>
                </div>
                <div className="text-[11px] italic text-slate-500">{amountInWords(f.totalDue)}</div>
                <div className="pt-1">
                  <label className="block text-xs text-slate-500 mb-1">Override total (optional)</label>
                  <input
                    type="number"
                    value={d.overrideTotal}
                    onChange={(e) => patchDraft(d.contractId, { overrideTotal: e.target.value })}
                    placeholder={String(f.lineTotal)}
                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm text-right"
                  />
                  {f.overridden && (
                    <input
                      value={d.overrideReason}
                      onChange={(e) => patchDraft(d.contractId, { overrideReason: e.target.value })}
                      placeholder="Reason for override (required)"
                      className={`w-full px-2 py-1.5 mt-1 border rounded text-sm ${d.overrideReason.trim() ? "border-slate-200" : "border-danger-300"}`}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${muted ? "text-slate-500" : "text-slate-700"}`}>
      <span>{label}</span>
      <span className="tabular-nums">PKR {value.toLocaleString()}</span>
    </div>
  );
}
