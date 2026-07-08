import { useEffect, useMemo, useState } from "react";
import { Loader2, AlertCircle, X, RefreshCw, CheckCircle2, FileDown, Plus, Trash2 } from "lucide-react";
import Button from "./Button";
import { useAuth } from "../lib/auth";
import { generateInvoicePdf } from "../lib/invoicePdf";
import {
  supabase,
  CONTRACT_LINE_CATEGORY_LABEL,
  CLIENT_INVOICE_GROUP_LABEL,
  effectiveCommittedByCategory,
  computeInvoiceTaxes,
  clientPreviousBalance,
  financialYearLabel,
  amountInWords,
  type Client,
  type Contract,
  type ContractLine,
  type ContractAddendum,
  type Invoice,
  type InvoiceLine,
  type InvoiceTax,
  type InvoiceTemplateItem,
  type ClientInvoiceGroup,
  type RemitAccount,
} from "../lib/supabase";

type DraftLine = { category: InvoiceLine["category"]; label: string; quantity: string; unit_rate: string; taxable: boolean };
type DraftTax = { name: string; rate: string; base: InvoiceTax["base"]; direction: InvoiceTax["direction"]; component?: string };

type Draft = {
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
  status: "Pending" | "Cleared";
};

const num = (s: string) => Number(s) || 0;
const monthKey = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

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

  const [period, setPeriod] = useState(monthKey());
  const [group, setGroup] = useState<ClientInvoiceGroup>("FIXED");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<string | null>(null);

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

  const suggestNumber = (client: Client): string => {
    const fy = financialYearLabel(`${period}-01`).replace("FY ", "");
    const ym = period.replace("-", "");
    let base = `INV-${fy}-${client.client_code}-${ym}`;
    // Keep unique against existing invoices for this client.
    const existing = new Set(invoices.filter((i) => i.client_id === client.id).map((i) => i.invoice_number));
    if (!existing.has(base)) return base;
    let n = 2;
    while (existing.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  };

  const buildDrafts = () => {
    setResult(null);
    setError(null);
    const { start, end } = monthBounds(period);
    const next: Draft[] = [];
    for (const client of groupClients) {
      const clientContracts = contracts.filter((c) => c.client_id === client.id && c.status === "active");
      if (clientContracts.length === 0) continue;
      const draftLines: DraftLine[] = [];
      for (const con of clientContracts) {
        const conLines = lines.filter((l) => l.contract_id === con.id);
        const conAdds = addendums.filter((a) => a.contract_id === con.id);
        // Effective committed per category as of the period end (folds addendums).
        const eff = effectiveCommittedByCategory(conLines, conAdds, end);
        for (const l of conLines) {
          const qty = eff.get(l.category) != null && conLines.filter((x) => x.category === l.category).length === 1
            ? eff.get(l.category)! // single line of this category → use effective (with addendums)
            : l.committed_count;     // multiple lines share a category → use each line's base
          if (qty <= 0 && l.unit_rate <= 0) continue;
          draftLines.push({
            category: l.category,
            label: l.label ?? CONTRACT_LINE_CATEGORY_LABEL[l.category],
            quantity: String(qty),
            unit_rate: String(l.unit_rate),
            taxable: l.taxable,
          });
        }
      }
      if (draftLines.length === 0) continue;
      const taxes: DraftTax[] = (client.tax_profile ?? []).map((t) => ({
        name: t.name,
        rate: String(t.rate),
        base: t.base,
        direction: t.direction,
        component: t.component,
      }));
      const remitIndex = Math.max(0, (client.remit_accounts ?? []).findIndex((r) => r.is_default));
      next.push({
        client,
        invoiceNumber: suggestNumber(client),
        periodStart: start,
        periodEnd: end,
        lines: draftLines,
        taxes,
        notes: "",
        remitIndex,
        overrideTotal: "",
        overrideReason: "",
        previousBalance: clientPreviousBalance(invoices, client.id, today()),
        status: "Pending",
      });
    }
    setDrafts(next);
    if (next.length === 0) setError("No clients in this group have active contracts with billable lines.");
  };

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

  const patchDraft = (idx: number, patch: Partial<Draft>) =>
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));

  const generateCleared = async () => {
    const cleared = drafts.filter((d) => d.status === "Cleared");
    if (cleared.length === 0) {
      setError("Clear at least one draft first.");
      return;
    }
    // Guard: override total requires a reason.
    for (const d of cleared) {
      const f = figures(d);
      if (f.overridden && !d.overrideReason.trim()) {
        setError(`${d.client.name}: an override total needs a reason.`);
        return;
      }
    }
    setGenerating(true);
    setError(null);
    const tpl = ((company?.invoice_template ?? []) as InvoiceTemplateItem[]) || [];
    let posted = 0;
    try {
      for (const d of cleared) {
        const f = figures(d);
        const remit: RemitAccount | null = (d.client.remit_accounts ?? [])[d.remitIndex] ?? null;
        const invoiceAmount = f.subtotal + f.addedTotal; // current-period gross
        const insertRow = {
          client_id: d.client.id,
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
          // Uniqueness or other failure — surface which client and stop.
          throw new Error(`${d.client.name} (${d.invoiceNumber}): ${insErr.message}`);
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
        // Company-format PDF (one download per invoice).
        generateInvoicePdf(
          invoice,
          d.client,
          company ?? null,
          tpl,
          {
            lines: lineRows.map((l) => ({ ...l }) as InvoiceLine),
            taxes: taxRows.map((t) => ({ ...t }) as InvoiceTax),
          },
        );
        posted++;
      }
      // Uncleared drafts roll over (stay on screen); clear the posted ones.
      setDrafts((prev) => prev.filter((d) => d.status !== "Cleared"));
      setResult(`Posted ${posted} invoice${posted === 1 ? "" : "s"} as Unpaid and generated PDFs.`);
      await loadData();
      onPosted();
    } catch (err: any) {
      setError(err.message ?? String(err));
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

      {/* Controls */}
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
          <select
            value={group}
            onChange={(e) => setGroup(e.target.value as ClientInvoiceGroup)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm"
          >
            {(["FIXED", "VARIABLE", "SLA"] as const).map((g) => (
              <option key={g} value={g}>{CLIENT_INVOICE_GROUP_LABEL[g]}</option>
            ))}
          </select>
        </div>
        <Button variant="secondary" size="md" onClick={buildDrafts} disabled={loading}>
          <RefreshCw className="w-4 h-4 mr-2" /> Build drafts
        </Button>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-slate-500">
            {drafts.length} draft{drafts.length === 1 ? "" : "s"} · {drafts.filter((d) => d.status === "Cleared").length} cleared
          </span>
          <Button variant="primary" size="md" onClick={generateCleared} disabled={generating || drafts.length === 0}>
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

      {!loading && drafts.length === 0 && (
        <div className="text-center py-10 text-slate-500 text-sm">
          Pick a period and group, then <span className="font-medium">Build drafts</span> to pre-fill invoices from each client's contract lines.
        </div>
      )}

      {drafts.map((d, idx) => {
        const f = figures(d);
        const remitAccounts = d.client.remit_accounts ?? [];
        return (
          <div
            key={d.client.id}
            className={`bg-white border rounded-lg p-4 space-y-3 ${d.status === "Cleared" ? "border-success-300" : "border-slate-200"}`}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-slate-900">{d.client.name}</div>
                <div className="text-xs text-slate-500 font-mono">{d.client.client_code}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded-full border ${d.status === "Cleared" ? "bg-success-50 text-success-700 border-success-200" : "bg-warning-50 text-warning-700 border-warning-200"}`}>
                  {d.status}
                </span>
                <Button
                  variant={d.status === "Cleared" ? "secondary" : "primary"}
                  size="sm"
                  onClick={() => patchDraft(idx, { status: d.status === "Cleared" ? "Pending" : "Cleared" })}
                >
                  {d.status === "Cleared" ? "Reopen" : "Clear"}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Invoice #</label>
                <input
                  value={d.invoiceNumber}
                  onChange={(e) => patchDraft(idx, { invoiceNumber: e.target.value })}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Period start</label>
                <input type="date" value={d.periodStart} onChange={(e) => patchDraft(idx, { periodStart: e.target.value })} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Period end</label>
                <input type="date" value={d.periodEnd} onChange={(e) => patchDraft(idx, { periodEnd: e.target.value })} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm" />
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
                          onChange={(e) => patchDraft(idx, { lines: d.lines.map((x, j) => (j === li ? { ...x, label: e.target.value } : x)) })}
                          className="w-full px-2 py-1 border border-slate-200 rounded text-sm"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input type="number" min="0" value={l.quantity}
                          onChange={(e) => patchDraft(idx, { lines: d.lines.map((x, j) => (j === li ? { ...x, quantity: e.target.value } : x)) })}
                          className="w-full px-2 py-1 border border-slate-200 rounded text-sm text-right" />
                      </td>
                      <td className="px-2 py-1">
                        <input type="number" min="0" step="0.01" value={l.unit_rate}
                          onChange={(e) => patchDraft(idx, { lines: d.lines.map((x, j) => (j === li ? { ...x, unit_rate: e.target.value } : x)) })}
                          className="w-full px-2 py-1 border border-slate-200 rounded text-sm text-right" />
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-700">
                        {(num(l.quantity) * num(l.unit_rate)).toLocaleString()}
                      </td>
                      <td className="px-1 py-1 text-center">
                        <button onClick={() => patchDraft(idx, { lines: d.lines.filter((_, j) => j !== li) })} className="text-danger-600 hover:bg-danger-50 rounded p-1">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                onClick={() => patchDraft(idx, { lines: [...d.lines, { category: null, label: "", quantity: "0", unit_rate: "0", taxable: true }] })}
                className="text-xs text-brand-600 hover:text-brand-700 px-2 py-1.5 inline-flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Add line
              </button>
            </div>

            {/* Totals + taxes + remit */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-xs text-slate-500">Remit account</label>
                <select
                  value={d.remitIndex}
                  onChange={(e) => patchDraft(idx, { remitIndex: Number(e.target.value) })}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
                >
                  {remitAccounts.length === 0 && <option value={-1}>No remit accounts configured</option>}
                  {remitAccounts.map((r, ri) => (
                    <option key={ri} value={ri}>
                      {r.account_title} — {r.account_number} ({r.bank_name}){r.is_default ? " ★" : ""}
                    </option>
                  ))}
                </select>
                <label className="block text-xs text-slate-500 mt-2">Notes</label>
                <textarea value={d.notes} onChange={(e) => patchDraft(idx, { notes: e.target.value })} rows={2} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm" />
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
                    onChange={(e) => patchDraft(idx, { overrideTotal: e.target.value })}
                    placeholder={String(f.lineTotal)}
                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm text-right"
                  />
                  {f.overridden && (
                    <input
                      value={d.overrideReason}
                      onChange={(e) => patchDraft(idx, { overrideReason: e.target.value })}
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
