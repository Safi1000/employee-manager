import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, FileText, Loader2, Plus, Search } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import ThemedSelect from "./ThemedSelect";
import { supabase, friendlyDbError } from "../lib/supabase";
import { useAuth, hasPermission } from "../lib/auth";
import { useRegion } from "../lib/region";
import { usePageState } from "../lib/pageState";
import { canReadBankBalances, loadBankOptions } from "../lib/bankOptions";
import { loadCustodianOptions, ensureCustodianLocation, type CustodianOption } from "../lib/custodian";
import { exportTable } from "../lib/excel";
import { downloadClientLedgerPdf } from "../lib/clientLedgerPdf";

/**
 * CLIENT RECEIVABLES (0626, DECIDED 2 Nov 2026). Replaces the month-picker
 * receivables table.
 *
 * The list opens on BALANCE TODAY: brought forward (before Bastion), what each
 * client owes now and how old it is, and their last payment. The client ledger
 * reads like a bank statement, by date: an advance invoice sits on the day it
 * was sent, with the month it bills for beside it; each payment is one line with
 * how it was paid, the cheque, where the money went, the cash and the tax the
 * client deducted.
 *
 * Every figure here is read from client_receivables_today() and
 * client_receivable_ledger(). The only arithmetic in this file is the list's
 * footer — the sum of the rows displayed above it (the stated exception in
 * CLAUDE.md) — and the receipt form's "this clears" preview of what the user is
 * typing, which is not a balance.
 */

type Row = {
  client_id: string;
  client_name: string;
  branch_id: string | null;
  brought_forward: number;
  invoiced: number;
  settled: number;
  cash_received: number;
  wht_deducted: number;
  balance: number;
  owed_before_bastion: number;
  age_0_30: number;
  age_31_60: number;
  age_61_90: number;
  age_over_90: number;
  open_invoices: number;
  oldest_open_date: string | null;
  wht_awaiting_certificate: number;
  last_paid_on: string | null;
  last_paid_mode: string | null;
  last_paid_amount: number | null;
};

type Line = {
  line_no: number;
  line_date: string | null;
  line_kind: "opening" | "invoice" | "receipt" | "untracked";
  reference: string;
  for_month: string | null;
  details: string;
  mode: string | null;
  cheque_no: string | null;
  cheque_status: string | null;
  cheque_status_on: string | null;
  deposited_to: string | null;
  invoiced: number;
  received: number;
  wht: number;
  wht_status: string | null;
  wht_certificate: string | null;
  balance: number;
  payment_ids: string[] | null;
  invoice_id: string | null;
};

const n = (v: unknown) => Number(v ?? 0);
const fmt = (v: number) => (Math.abs(v) < 0.5 ? "—" : Math.round(v).toLocaleString());
const fmtBal = (v: number) => (v < -0.5 ? `${Math.round(-v).toLocaleString()} CR` : Math.round(v).toLocaleString());
const fmtDate = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
const fmtMonth = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "";
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());

type Range = "all" | "month" | "3m" | "fy" | "custom";
function rangeDates(r: Range, from: string, to: string): [string | null, string | null] {
  const now = new Date();
  if (r === "month") return [iso(new Date(now.getFullYear(), now.getMonth(), 1)), null];
  if (r === "3m") return [iso(new Date(now.getFullYear(), now.getMonth() - 2, 1)), null];
  if (r === "fy") return [iso(new Date(now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1, 6, 1)), null];
  if (r === "custom") return [from || null, to || null];
  return [null, null];
}

/** How a receipt was paid, in one line: mode, cheque and its status. */
function howPaid(l: Line) {
  if (l.line_kind === "invoice") return l.for_month ? `For ${fmtMonth(l.for_month)}` : "";
  if (l.line_kind === "untracked") return "Not recorded";
  if (l.line_kind !== "receipt") return "";
  const parts: string[] = [];
  if (l.mode === "Cheque") {
    parts.push(`Cheque${l.cheque_no ? ` #${l.cheque_no}` : ""}`);
    if (l.cheque_status) parts.push(`${l.cheque_status}${l.cheque_status_on ? ` ${fmtDate(l.cheque_status_on)}` : ""}`);
  } else if (l.mode === "Bank") parts.push("Bank transfer");
  else if (l.mode) parts.push(l.mode);
  return parts.join(" · ");
}

function WhtBadge({ status, cert }: { status: string | null; cert: string | null }) {
  if (!status) return null;
  const tone =
    status === "certificate received"
      ? "text-success-700 dark:text-success-500"
      : status === "not deposited"
        ? "text-danger-700 dark:text-danger-500"
        : "text-warning-700 dark:text-warning-500";
  return (
    <div className={`text-[11px] font-semibold ${tone}`}>
      {status === "certificate received" ? `Certificate ${cert ?? ""}`.trim() : status === "not deposited" ? "Not deposited" : "Awaiting certificate"}
    </div>
  );
}

export default function ClientReceivables() {
  const { profile, company } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
  const canEdit = hasPermission(profile, "invoices.edit");
  const { regionId } = useRegion();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = usePageState("ClientReceivables.search", "");
  const [showSettled, setShowSettled] = usePageState("ClientReceivables.showSettled", false);
  const [selected, setSelected] = useState<Row | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("client_receivables_today");
    if (error) setErr(friendlyDbError(error));
    else {
      setErr(null);
      setRows(((data ?? []) as Row[]).map((r) => ({
        ...r,
        brought_forward: n(r.brought_forward), invoiced: n(r.invoiced), settled: n(r.settled), cash_received: n(r.cash_received),
        wht_deducted: n(r.wht_deducted), balance: n(r.balance), owed_before_bastion: n(r.owed_before_bastion),
        age_0_30: n(r.age_0_30), age_31_60: n(r.age_31_60), age_61_90: n(r.age_61_90), age_over_90: n(r.age_over_90),
        wht_awaiting_certificate: n(r.wht_awaiting_certificate),
        last_paid_amount: r.last_paid_amount == null ? null : n(r.last_paid_amount),
      })));
    }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => !regionId || r.branch_id === regionId)
      .filter((r) => showSettled || Math.abs(r.balance) > 0.5)
      .filter((r) => !q || r.client_name.toLowerCase().includes(q))
      .sort((a, b) => b.balance - a.balance);
  }, [rows, regionId, search, showSettled]);

  // Footer: the sum of the rows shown above it, and nothing else (CLAUDE.md).
  const foot = useMemo(() => visible.reduce(
    (t, r) => ({
      balance: t.balance + r.balance,
      bf: t.bf + r.owed_before_bastion,
      a0: t.a0 + r.age_0_30, a31: t.a31 + r.age_31_60, a61: t.a61 + r.age_61_90, a90: t.a90 + r.age_over_90,
      wht: t.wht + r.wht_awaiting_certificate,
    }),
    { balance: 0, bf: 0, a0: 0, a31: 0, a61: 0, a90: 0, wht: 0 },
  ), [visible]);

  if (selected) {
    return (
      <ClientLedger
        row={selected}
        companyId={companyId}
        companyName={company?.name ?? ""}
        canEdit={canEdit}
        onBack={() => { setSelected(null); void load(); }}
      />
    );
  }

  const exportList = () => exportTable({
    fileName: `Receivables ${today()}.xlsx`,
    title: `Client receivables — balance on ${fmtDate(today())}`,
    headers: ["Client", "Owes now", "Before Bastion (still owed)", "0–30 days", "31–60 days", "61–90 days", "Over 90 days", "Tax awaiting certificate", "Last payment", "Mode", "Amount"],
    rows: visible.map((r) => [r.client_name, Math.round(r.balance), Math.round(r.owed_before_bastion), Math.round(r.age_0_30), Math.round(r.age_31_60),
      Math.round(r.age_61_90), Math.round(r.age_over_90), Math.round(r.wht_awaiting_certificate), fmtDate(r.last_paid_on), r.last_paid_mode ?? "", r.last_paid_amount ?? ""]),
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {[
          ["Owed today", foot.balance, "text-foreground"],
          ["Before Bastion", foot.bf, "text-muted-foreground"],
          ["0–30 days", foot.a0, "text-foreground"],
          ["31–60 days", foot.a31, "text-warning-700 dark:text-warning-500"],
          ["61–90 days", foot.a61, "text-warning-700 dark:text-warning-500"],
          ["Over 90 days", foot.a90, "text-danger-700 dark:text-danger-500"],
        ].map(([label, v, tone]) => (
          <div key={label as string} className="rounded-xl border border-border bg-card p-3">
            <div className="lbl">{label as string}</div>
            <div className={`font-ledger text-lg font-semibold ${tone as string}`}>{fmtBal(v as number)}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-card text-sm" placeholder="Search clients"
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={showSettled} onChange={(e) => setShowSettled(e.target.checked)} /> Show clients who owe nothing
        </label>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => void exportList()}><Download className="w-4 h-4 mr-1" /> Excel</Button>
      </div>

      {err && <div className="rounded-lg border border-danger-200 bg-danger-50 dark:bg-danger-500/10 p-3 text-sm text-danger-700 dark:text-danger-500">{err}</div>}

      <p className="text-xs text-muted-foreground">
        Balances are as of today. Payments clear the oldest amount first: the balance from before Bastion, then invoices by date.
        "Before Bastion" is what is still owed from the balance brought in when Bastion started. Click a client for their ledger.
      </p>

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left">
            <tr className="text-xs text-muted-foreground">
              <th className="px-3 py-2">Client</th>
              <th className="px-3 py-2 text-right">Owes now</th>
              <th className="px-3 py-2 text-right">Before Bastion</th>
              <th className="px-3 py-2 text-right">0–30 days</th>
              <th className="px-3 py-2 text-right">31–60</th>
              <th className="px-3 py-2 text-right">61–90</th>
              <th className="px-3 py-2 text-right">Over 90</th>
              <th className="px-3 py-2">Last payment</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">No client owes anything{search ? " that matches" : ""}.</td></tr>
            ) : visible.map((r) => (
              <tr key={r.client_id} className="border-t border-border hover:bg-muted/40 cursor-pointer" onClick={() => setSelected(r)}>
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{r.client_name}</div>
                  {r.wht_awaiting_certificate > 0.5 && (
                    <div className="text-[11px] text-warning-700 dark:text-warning-500">Tax {fmt(r.wht_awaiting_certificate)} awaiting certificate</div>
                  )}
                </td>
                <td className={`px-3 py-2 text-right font-ledger font-semibold ${r.balance < -0.5 ? "text-success-700 dark:text-success-500" : "text-foreground"}`}>{fmtBal(r.balance)}</td>
                <td className="px-3 py-2 text-right font-ledger text-muted-foreground">{fmt(r.owed_before_bastion)}</td>
                <td className="px-3 py-2 text-right font-ledger">{fmt(r.age_0_30)}</td>
                <td className="px-3 py-2 text-right font-ledger">{fmt(r.age_31_60)}</td>
                <td className="px-3 py-2 text-right font-ledger">{fmt(r.age_61_90)}</td>
                <td className={`px-3 py-2 text-right font-ledger ${r.age_over_90 > 0.5 ? "text-danger-700 dark:text-danger-500 font-semibold" : ""}`}>{fmt(r.age_over_90)}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                  {r.last_paid_on ? <>{fmtDate(r.last_paid_on)} · {r.last_paid_mode} · <span className="font-ledger">{fmt(r.last_paid_amount ?? 0)}</span></> : "No payment yet"}
                </td>
              </tr>
            ))}
          </tbody>
          {visible.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-border font-semibold">
                <td className="px-3 py-2">Total ({visible.length})</td>
                <td className="px-3 py-2 text-right font-ledger">{fmtBal(foot.balance)}</td>
                <td className="px-3 py-2 text-right font-ledger">{fmt(foot.bf)}</td>
                <td className="px-3 py-2 text-right font-ledger">{fmt(foot.a0)}</td>
                <td className="px-3 py-2 text-right font-ledger">{fmt(foot.a31)}</td>
                <td className="px-3 py-2 text-right font-ledger">{fmt(foot.a61)}</td>
                <td className="px-3 py-2 text-right font-ledger">{fmt(foot.a90)}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{foot.wht > 0.5 ? `Tax awaiting certificates: ${fmt(foot.wht)}` : ""}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ───────────────────────────── One client's ledger ─────────────────────────────

function ClientLedger({ row, companyId, companyName, canEdit, onBack }: {
  row: Row; companyId: string | null; companyName: string; canEdit: boolean; onBack: () => void;
}) {
  const [range, setRange] = usePageState<Range>("ClientReceivables.range", "all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<{ id: string; cheque_number: string; amount: number; cheque_date: string; bank: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [taxLine, setTaxLine] = useState<Line | null>(null);

  const [pFrom, pTo] = rangeDates(range, from, to);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data, error }, chq] = await Promise.all([
      supabase.rpc("client_receivable_ledger", { p_client_id: row.client_id, p_from: pFrom, p_to: pTo }),
      supabase.from("cheques").select("id, cheque_number, amount, cheque_date, status, bank:bank_accounts(bank_name)")
        .eq("client_id", row.client_id).eq("direction", "incoming").not("status", "in", "(cleared,bounced)").order("cheque_date"),
    ]);
    if (error) setErr(friendlyDbError(error));
    else {
      setErr(null);
      setLines(((data ?? []) as Line[]).map((l) => ({ ...l, invoiced: n(l.invoiced), received: n(l.received), wht: n(l.wht), balance: n(l.balance) })));
    }
    setPending(((chq.data ?? []) as any[]).map((c) => ({ id: c.id, cheque_number: c.cheque_number, amount: n(c.amount), cheque_date: c.cheque_date, bank: c.bank?.bank_name ?? null })));
    setLoading(false);
  }, [row.client_id, pFrom, pTo]);
  useEffect(() => { void load(); }, [load]);

  const closing = lines.length ? lines[lines.length - 1].balance : 0;
  const scopeLabel = range === "all" ? "All dates, from the balance brought forward"
    : `${pFrom ? fmtDate(pFrom) : "Start"} to ${pTo ? fmtDate(pTo) : "today"}`;

  const exportRows = lines.map((l) => ({
    date: l.line_kind === "opening" ? (l.line_date ? fmtDate(l.line_date) : "") : fmtDate(l.line_date),
    details: l.line_kind === "opening" ? `${l.reference} — ${l.details}` : l.details,
    reference: l.line_kind === "opening" ? "" : l.reference,
    how: [howPaid(l), l.deposited_to, l.wht ? (l.wht_status ?? "") : ""].filter(Boolean).join(" · "),
    invoiced: l.invoiced, received: l.received, wht: l.wht, balance: l.balance,
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="w-4 h-4 mr-1" /> All clients</Button>
        <div>
          <h2 className="text-lg font-semibold text-foreground">{row.client_name}</h2>
          <p className="text-xs text-muted-foreground">Statement of account · {scopeLabel}</p>
        </div>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => void exportTable({
          fileName: `${row.client_name} statement.xlsx`,
          title: `${row.client_name} — statement of account (${scopeLabel})`,
          headers: ["Date", "Details", "Invoice", "How paid / where it went", "Invoiced", "Received", "Tax deducted", "Balance"],
          rows: exportRows.map((r) => [r.date, r.details, r.reference, r.how, r.invoiced || "", r.received || "", r.wht || "", Math.round(r.balance)]),
        })}><Download className="w-4 h-4 mr-1" /> Excel</Button>
        <Button variant="secondary" size="sm" onClick={() => void downloadClientLedgerPdf({ companyName, clientName: row.client_name, scope: scopeLabel, lines: exportRows, closing })}>
          <FileText className="w-4 h-4 mr-1" /> PDF
        </Button>
        {canEdit && <Button size="sm" onClick={() => setReceiptOpen(true)}><Plus className="w-4 h-4 mr-1" /> Record payment</Button>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {([["all", "Everything"], ["month", "This month"], ["3m", "Last 3 months"], ["fy", "This financial year"], ["custom", "Dates…"]] as [Range, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setRange(k)}
            className={`px-3 py-1.5 rounded-lg text-sm border ${range === k ? "bg-foreground text-background border-foreground" : "bg-card border-border text-foreground hover:bg-muted"}`}>
            {label}
          </button>
        ))}
        {range === "custom" && (
          <>
            <input type="date" className="px-2 py-1.5 rounded-lg border border-border bg-card text-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="text-muted-foreground text-sm">to</span>
            <input type="date" className="px-2 py-1.5 rounded-lg border border-border bg-card text-sm" value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
      </div>

      {pending.length > 0 && (
        <div className="rounded-lg border border-info-200 bg-info-50 dark:bg-info-500/10 p-3 text-sm text-info-700 dark:text-info-500">
          Cheques received, not yet cleared (not in the balance until they clear):{" "}
          {pending.map((c) => `#${c.cheque_number} ${fmt(c.amount)} dated ${fmtDate(c.cheque_date)}${c.bank ? ` → ${c.bank}` : ""}`).join(" · ")}
        </div>
      )}
      {err && <div className="rounded-lg border border-danger-200 bg-danger-50 dark:bg-danger-500/10 p-3 text-sm text-danger-700 dark:text-danger-500">{err}</div>}

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left">
            <tr className="text-xs text-muted-foreground">
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Details</th>
              <th className="px-3 py-2">Invoice</th>
              <th className="px-3 py-2">How paid</th>
              <th className="px-3 py-2">Went to</th>
              <th className="px-3 py-2 text-right">Invoiced</th>
              <th className="px-3 py-2 text-right">Received</th>
              <th className="px-3 py-2 text-right">Tax deducted</th>
              <th className="px-3 py-2 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-3 py-10 text-center text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</td></tr>
            ) : lines.map((l) => (
              <tr key={l.line_no} className={`border-t border-border align-top ${l.line_kind === "opening" ? "bg-muted/40" : ""}`}>
                <td className="px-3 py-2 whitespace-nowrap">{fmtDate(l.line_date)}</td>
                <td className="px-3 py-2">
                  <div className={l.line_kind === "opening" ? "font-semibold" : "text-foreground"}>
                    {l.line_kind === "opening" ? l.reference : l.details}
                  </div>
                  {l.line_kind === "opening" && <div className="text-xs text-muted-foreground">{l.details}</div>}
                </td>
                <td className="px-3 py-2 text-xs font-ledger">{l.line_kind === "opening" ? "" : l.reference}</td>
                <td className="px-3 py-2 text-xs whitespace-nowrap">{howPaid(l)}</td>
                <td className="px-3 py-2 text-xs">{l.deposited_to ?? ""}</td>
                <td className="px-3 py-2 text-right font-ledger">{fmt(l.invoiced)}</td>
                <td className="px-3 py-2 text-right font-ledger">{fmt(l.received)}</td>
                <td className="px-3 py-2 text-right">
                  <div className="font-ledger">{fmt(l.wht)}</div>
                  <WhtBadge status={l.wht_status} cert={l.wht_certificate} />
                  {canEdit && l.line_kind === "receipt" && (l.payment_ids?.length ?? 0) === 1 && l.wht_status !== "certificate received" && (
                    <button className="text-[11px] text-brand-600 hover:underline" onClick={() => setTaxLine(l)}>
                      {l.wht ? "Change tax" : "Add tax deducted"}
                    </button>
                  )}
                </td>
                <td className={`px-3 py-2 text-right font-ledger font-semibold ${l.balance < -0.5 ? "text-success-700 dark:text-success-500" : ""}`}>{fmtBal(l.balance)}</td>
              </tr>
            ))}
          </tbody>
          {!loading && lines.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-border font-semibold">
                <td className="px-3 py-2" colSpan={8}>{closing < -0.5 ? "In credit" : "Balance due"}</td>
                <td className="px-3 py-2 text-right font-ledger">{fmtBal(closing)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {receiptOpen && (
        <ReceiptModal row={row} companyId={companyId} owed={row.balance}
          onClose={() => setReceiptOpen(false)} onSaved={() => { setReceiptOpen(false); void load(); }} />
      )}
      {taxLine && (
        <TaxModal line={taxLine} onClose={() => setTaxLine(null)} onSaved={() => { setTaxLine(null); void load(); }} />
      )}
    </div>
  );
}

// ───────────────────────────── Record a payment ─────────────────────────────

/**
 * One form for every way a client pays. "Amount received" is what arrived
 * (cash, transfer or cheque); "Tax deducted" is what the client kept back for
 * the FBR. The two together clear the receivable (A1) — the form says so in a
 * sentence, so nobody has to know which figure goes where.
 */
function ReceiptModal({ row, companyId, owed, onClose, onSaved }: {
  row: Row; companyId: string | null; owed: number; onClose: () => void; onSaved: () => void;
}) {
  const { profile } = useAuth();
  const [mode, setMode] = useState<"Bank" | "Cash" | "Cheque">("Bank");
  const [amount, setAmount] = useState("");
  const [wht, setWht] = useState("");
  const [date, setDate] = useState(today());
  const [bankId, setBankId] = useState("");
  const [custodianId, setCustodianId] = useState("");
  const [chequeNo, setChequeNo] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [notes, setNotes] = useState("");
  const [banks, setBanks] = useState<{ id: string; bank_name: string; account_number: string; active?: boolean; owner_type?: string | null }[]>([]);
  const [custodians, setCustodians] = useState<CustodianOption[]>([]);
  const [openInvoices, setOpenInvoices] = useState<{ id: string; invoice_number: string; invoice_date: string; outstanding: number }[]>([]);
  const [rate, setRate] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;
    void (async () => {
      const full = canReadBankBalances(profile);
      const [b, c, inv, cl] = await Promise.all([
        loadBankOptions<any>(companyId, full),
        loadCustodianOptions(companyId, full),
        supabase.from("invoices").select("id, invoice_number, invoice_date, outstanding").eq("client_id", row.client_id).gt("outstanding", 0.005).order("invoice_date"),
        supabase.from("clients").select("withholding_tax_rate").eq("id", row.client_id).maybeSingle(),
      ]);
      setBanks((b ?? []).filter((x: any) => x.active !== false && (x.owner_type ?? "company") === "company"));
      setCustodians(c);
      setOpenInvoices(((inv.data ?? []) as any[]).map((i) => ({ ...i, outstanding: n(i.outstanding) })));
      setRate(n(cl.data?.withholding_tax_rate));
    })();
  }, [companyId, profile, row.client_id]);

  const cash = Number(amount || 0);
  const tax = mode === "Cheque" ? 0 : Number(wht || 0);
  const clears = cash + tax;

  const save = async () => {
    setErr(null);
    if (!(cash > 0)) return setErr("Enter the amount received.");
    if (tax < 0) return setErr("Tax deducted cannot be negative.");
    if (!date) return setErr("Enter the date.");
    if ((mode === "Bank" || mode === "Cheque") && !bankId) return setErr(mode === "Bank" ? "Choose the bank account it went into." : "Choose the bank account the cheque goes into.");
    if (mode === "Cash" && !custodianId) return setErr("Choose who received the cash.");
    if (mode === "Cheque" && !chequeNo.trim()) return setErr("Enter the cheque number.");
    setBusy(true);
    try {
      if (mode === "Cheque") {
        const { error } = await supabase.rpc("record_cheque", {
          p_bank_account_id: bankId, p_cheque_number: chequeNo.trim(), p_amount: cash, p_cheque_date: date,
          p_cheque_type: "payment", p_direction: "incoming", p_recipient: row.client_name,
          p_notes: notes.trim() || null, p_invoice_id: invoiceId || null, p_client_id: row.client_id,
        });
        if (error) throw error;
      } else {
        let loc: string | null = null;
        if (mode === "Cash") {
          const who = custodians.find((c) => c.employeeId === custodianId);
          if (!who || !companyId) throw new Error("Choose who received the cash.");
          loc = await ensureCustodianLocation(companyId, who.employeeId, who.fullName, who.kind);
        }
        const { error } = await supabase.rpc("record_invoice_payment", {
          p_invoice_id: invoiceId || null,
          p_client_id: invoiceId ? null : row.client_id,
          p_amount: cash,
          p_payment_date: date,
          p_payment_mode: mode,
          p_bank_account_id: mode === "Bank" ? bankId : null,
          p_notes: notes.trim() || null,
          // Always explicit: null would apply the client's rate unseen.
          p_withholding: tax,
          p_custodian_location_id: loc,
        });
        if (error) throw error;
      }
      onSaved();
    } catch (e: any) {
      setErr(friendlyDbError(e));
    } finally {
      setBusy(false);
    }
  };

  // The client's agreed rate is on the GROSS (cash + tax), so from the cash
  // received: tax = cash × r / (100 − r).
  const rateTax = rate > 0 && rate < 100 && cash > 0 ? Math.round((cash * rate) / (100 - rate)) : 0;

  return (
    <Modal isOpen onClose={onClose} title={`Record payment — ${row.client_name}`} error={err} onDismissError={() => setErr(null)}
      footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save payment"}</Button></div>}>
      <div className="space-y-4">
        <div>
          <div className="lbl mb-1">How did they pay?</div>
          <div className="flex gap-2">
            {(["Bank", "Cheque", "Cash"] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex-1 px-3 py-2 rounded-lg border text-sm ${mode === m ? "bg-foreground text-background border-foreground" : "bg-card border-border"}`}>
                {m === "Bank" ? "Bank transfer" : m}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="lbl">Amount received (PKR)</span>
            <input type="number" inputMode="decimal" className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <span className="text-[11px] text-muted-foreground">{mode === "Cash" ? "The cash handed over." : mode === "Cheque" ? "The amount on the cheque." : "What reached the bank."}</span>
          </label>
          <label className="block">
            <span className="lbl">Tax the client deducted (PKR)</span>
            <input type="number" inputMode="decimal" className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card disabled:opacity-50"
              value={mode === "Cheque" ? "" : wht} disabled={mode === "Cheque"} onChange={(e) => setWht(e.target.value)} placeholder="0" />
            {mode === "Cheque" ? (
              <span className="text-[11px] text-muted-foreground">Add it on the payment's line once the cheque clears.</span>
            ) : rateTax > 0 ? (
              <button type="button" className="text-[11px] text-brand-600 hover:underline" onClick={() => setWht(String(rateTax))}>
                Their rate is {rate}% of the full amount → {rateTax.toLocaleString()}
              </button>
            ) : (
              <span className="text-[11px] text-muted-foreground">Leave 0 if they deducted nothing.</span>
            )}
          </label>
        </div>

        {cash > 0 && (
          <div className="rounded-lg bg-muted/60 p-3 text-sm">
            {mode === "Cheque" ? (
              <>When the cheque clears, it clears <b>{clears.toLocaleString()}</b> of the <b>{Math.round(owed).toLocaleString()}</b> they owe.</>
            ) : (
              <>{cash.toLocaleString()} received{tax > 0 ? <> + {tax.toLocaleString()} tax deducted</> : null} clears <b>{clears.toLocaleString()}</b> of the{" "}
                <b>{Math.round(owed).toLocaleString()}</b> they owe. {owed - clears > 0.5 ? <>{Math.round(owed - clears).toLocaleString()} left.</> : owed - clears < -0.5 ? <>They will be {Math.round(clears - owed).toLocaleString()} in credit.</> : <>Fully paid.</>}</>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="lbl">{mode === "Cheque" ? "Cheque date" : "Date received"}</span>
            <input type="date" className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={date} max={mode === "Cheque" ? undefined : today()} onChange={(e) => setDate(e.target.value)} />
          </label>
          {mode === "Cheque" && (
            <label className="block">
              <span className="lbl">Cheque number</span>
              <input className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} />
            </label>
          )}
          {mode !== "Cash" ? (
            <label className="block">
              <span className="lbl">{mode === "Cheque" ? "Deposited into" : "Went into"}</span>
              <ThemedSelect className="mt-1" value={bankId} onChange={(e) => setBankId(e.target.value)}>
                <option value="">Choose bank account</option>
                {banks.map((b) => <option key={b.id} value={b.id}>{`${b.bank_name}${b.account_number ? ` · ${b.account_number}` : ""}`}</option>)}
              </ThemedSelect>
            </label>
          ) : (
            <label className="block">
              <span className="lbl">Received by</span>
              <ThemedSelect className="mt-1" value={custodianId} onChange={(e) => setCustodianId(e.target.value)}>
                <option value="">Who holds the cash?</option>
                {custodians.map((c) => <option key={c.employeeId} value={c.employeeId}>{c.fullName}</option>)}
              </ThemedSelect>
            </label>
          )}
        </div>

        <label className="block">
          <span className="lbl">Apply to</span>
          <ThemedSelect className="mt-1" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
            <option value="">Oldest first (recommended)</option>
            {openInvoices.map((i) => <option key={i.id} value={i.id}>{`${i.invoice_number} · ${fmtDate(i.invoice_date)} · ${Math.round(i.outstanding).toLocaleString()} open`}</option>)}
          </ThemedSelect>
        </label>

        <label className="block">
          <span className="lbl">Note (optional)</span>
          <input className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. transfer reference" />
        </label>
      </div>
    </Modal>
  );
}

// ───────────────────────────── Tax deducted after the fact ─────────────────────────────

function TaxModal({ line, onClose, onSaved }: { line: Line; onClose: () => void; onSaved: () => void }) {
  const [wht, setWht] = useState(line.wht ? String(line.wht) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const v = Number(wht || 0);
    if (v < 0) return setErr("Tax deducted cannot be negative.");
    setBusy(true);
    const { error } = await supabase.rpc("record_payment_withholding", { p_payment_id: line.payment_ids![0], p_withholding: v });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    onSaved();
  };
  return (
    <Modal isOpen onClose={onClose} size="sm" title="Tax the client deducted" error={err} onDismissError={() => setErr(null)}
      footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save"}</Button></div>}>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Payment of {fmt(line.received)} on {fmtDate(line.line_date)} ({line.reference}). The tax clears the same amount of what they owe; no money moves.
          It then waits for a certificate under Withholding tax.
        </p>
        <label className="block">
          <span className="lbl">Tax deducted (PKR)</span>
          <input type="number" inputMode="decimal" className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={wht} onChange={(e) => setWht(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
