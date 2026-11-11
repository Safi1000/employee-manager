import { useCallback, useEffect, useMemo, useState } from "react";
import { downloadReceiptPdf, receiptWhatsAppText, type ReceiptLine } from "../lib/receiptPdf";
import { brandingFromCompany } from "../lib/pdfBranding";
import { ArrowLeft, Ban, Download, FileText, Loader2, MessageSquare, Plus, Search, ShieldCheck } from "lucide-react";
import Tabs from "./Tabs";
import PaymentFollowUp, { ContactModal, channelLabel } from "./PaymentFollowUp";
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
import { recordPaymentChecked } from "../lib/paymentEntry";
import { askReason } from "./askReason";

/**
 * CLIENT RECEIVABLES (0626, DECIDED 2 Nov 2026). Replaces the month-picker
 * receivables table.
 *
 * The list opens on BALANCE TODAY: the opening balance at 31 Aug 2026, what each
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
 *
 * 0627 (DECIDED 2 Nov 2026) folded the old Receivables page in here: a
 * Follow-up view (clients with money over 30 days old, each contact logged with
 * any promise and the next follow-up date), a Write-offs view (requested by one
 * person, approved by another holding receivables.write_off_approve), and the
 * totals by region.
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
  written_off: number;
  balance: number;
  owed_before_bastion: number;
  age_0_30: number;
  age_31_60: number;
  age_61_90: number;
  age_over_90: number;
  overdue: number;
  open_invoices: number;
  oldest_open_date: string | null;
  wht_awaiting_certificate: number;
  write_off_pending: number;
  last_paid_on: string | null;
  last_paid_mode: string | null;
  last_paid_amount: number | null;
  last_contact_on: string | null;
  last_contact_channel: string | null;
  last_contact_note: string | null;
  promised_amount: number | null;
  promised_by: string | null;
  next_follow_up: string | null;
};

/** 0661: a client holding its latest invoice as security — read from client_security_held(). */
type SecurityHeld = {
  hold_id: string; client_id: string; reason: string; since: string;
  invoice_id: string | null; invoice_number: string | null; invoice_date: string | null; period_start: string | null;
  invoice_amount: number; held_amount: number;
};
const loadSecurityHeld = async (): Promise<Map<string, SecurityHeld>> => {
  const { data } = await supabase.rpc("client_security_held");
  return new Map(((data ?? []) as SecurityHeld[]).map((h) => [h.client_id, { ...h, held_amount: n(h.held_amount), invoice_amount: n(h.invoice_amount) }]));
};

type RegionTotal = { branch_id: string | null; region_name: string; clients: number; balance: number; overdue: number; age_over_90: number };


type Line = {
  line_no: number;
  line_date: string | null;
  line_kind: "opening" | "invoice" | "receipt" | "untracked" | "write_off";
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
  written_off: number;
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
  // Every client is listed by default — a client who owes nothing, or is in credit,
  // still needs its ledger to show how it was cleared (Shayan, 4 Nov 2026: a client
  // netted to zero vanished and its ledger with it). Hiding them is the opt-in.
  const [hideSettled, setHideSettled] = usePageState("ClientReceivables.hideSettled", false);
  const [selected, setSelected] = useState<Row | null>(null);
  const [view, setView] = usePageState<"balances" | "followup" | "writeoffs">("ClientReceivables.view", "balances");
  const [regions, setRegions] = useState<RegionTotal[]>([]);
  const [held, setHeld] = useState<Map<string, SecurityHeld>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data, error }, reg, sec] = await Promise.all([
      supabase.rpc("client_receivables_today"),
      supabase.rpc("client_receivables_by_region"),
      loadSecurityHeld(),
    ]);
    setHeld(sec);
    setRegions(((reg.data ?? []) as RegionTotal[]).map((r) => ({ ...r, balance: n(r.balance), overdue: n(r.overdue), age_over_90: n(r.age_over_90) })));
    if (error) setErr(friendlyDbError(error));
    else {
      setErr(null);
      setRows(((data ?? []) as Row[]).map((r) => ({
        ...r,
        brought_forward: n(r.brought_forward), invoiced: n(r.invoiced), settled: n(r.settled), cash_received: n(r.cash_received),
        wht_deducted: n(r.wht_deducted), balance: n(r.balance), owed_before_bastion: n(r.owed_before_bastion),
        age_0_30: n(r.age_0_30), age_31_60: n(r.age_31_60), age_61_90: n(r.age_61_90), age_over_90: n(r.age_over_90),
        wht_awaiting_certificate: n(r.wht_awaiting_certificate),
        written_off: n(r.written_off), overdue: n(r.overdue), write_off_pending: n(r.write_off_pending),
        last_paid_amount: r.last_paid_amount == null ? null : n(r.last_paid_amount),
        promised_amount: r.promised_amount == null ? null : n(r.promised_amount),
      })));
    }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => !regionId || r.branch_id === regionId)
      .filter((r) => !hideSettled || Math.abs(r.balance) > 0.5)
      .filter((r) => !q || r.client_name.toLowerCase().includes(q))
      .sort((a, b) => b.balance - a.balance);
  }, [rows, regionId, search, hideSettled]);

  // Footer: the sum of the rows shown above it, and nothing else (CLAUDE.md).
  const foot = useMemo(() => visible.reduce(
    (t, r) => ({
      balance: t.balance + r.balance,
      bf: t.bf + r.owed_before_bastion,
      a0: t.a0 + r.age_0_30, a31: t.a31 + r.age_31_60, a61: t.a61 + r.age_61_90, a90: t.a90 + r.age_over_90,
      wht: t.wht + r.wht_awaiting_certificate,
      held: t.held + (held.get(r.client_id)?.held_amount ?? 0),
    }),
    { balance: 0, bf: 0, a0: 0, a31: 0, a61: 0, a90: 0, wht: 0, held: 0 },
  ), [visible, held]);

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

  const viewTabs = (
    <Tabs<"balances" | "followup" | "writeoffs"> value={view} onChange={setView} items={[
      { value: "balances", label: "Balances" },
      { value: "followup", label: "Follow-up", count: rows.filter((r) => (!regionId || r.branch_id === regionId) && r.next_follow_up && r.next_follow_up <= today()).length || undefined },
      { value: "writeoffs", label: "Write-offs", count: rows.filter((r) => (!regionId || r.branch_id === regionId) && r.write_off_pending > 0.5).length || undefined },
    ]} />
  );

  if (view === "followup") {
    return (
      <div className="space-y-4">
        {viewTabs}
        {/* 0628: the same list the ops team sees on Payment Follow-up, with amounts for finance. */}
        <PaymentFollowUp onOpenClient={(id) => setSelected(rows.find((r) => r.client_id === id) ?? null)} />
      </div>
    );
  }
  if (view === "writeoffs") {
    return (
      <div className="space-y-4">
        {viewTabs}
        <WriteOffsView companyId={companyId} regionId={regionId} onChanged={() => void load()} />
      </div>
    );
  }

  const exportList = () => exportTable({
    fileName: `Receivables ${today()}.xlsx`,
    title: `Client receivables — balance on ${fmtDate(today())}`,
    headers: ["Client", "Owes now", "Held as security", "Opening balance 31 Aug (still owed)", "0–30 days", "31–60 days", "61–90 days", "Over 90 days", "Tax awaiting certificate", "Last payment", "Mode", "Amount"],
    rows: visible.map((r) => [r.client_name, Math.round(r.balance), Math.round(held.get(r.client_id)?.held_amount ?? 0), Math.round(r.owed_before_bastion), Math.round(r.age_0_30), Math.round(r.age_31_60),
      Math.round(r.age_61_90), Math.round(r.age_over_90), Math.round(r.wht_awaiting_certificate), fmtDate(r.last_paid_on), r.last_paid_mode ?? "", r.last_paid_amount ?? ""]),
  });

  return (
    <div className="space-y-4">
      {viewTabs}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {[
          ["Owed today", foot.balance, "text-foreground"],
          ["Opening (31 Aug)", foot.bf, "text-muted-foreground"],
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

      {!regionId && regions.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {regions.map((g) => (
            <div key={g.branch_id ?? "none"} className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
              <span className="font-medium text-foreground">{g.region_name}</span>
              <span className="ml-2 font-ledger">{fmtBal(g.balance)}</span>
              <span className="ml-2 text-xs text-muted-foreground">{g.clients} clients · overdue {fmt(g.overdue)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-card text-sm" placeholder="Search clients"
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={hideSettled} onChange={(e) => setHideSettled(e.target.checked)} /> Hide clients who owe nothing
        </label>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => void exportList()}><Download className="w-4 h-4 mr-1" /> Excel</Button>
      </div>

      {err && <div className="rounded-lg border border-danger-200 bg-danger-50 dark:bg-danger-500/10 p-3 text-sm text-danger-700 dark:text-danger-500">{err}</div>}

      <p className="text-xs text-muted-foreground">
        Balances are as of today. Payments clear the oldest amount first: the opening balance, then invoices by date.
        "Opening (31 Aug)" is what is still owed from each client's opening balance at 31 Aug 2026. "Held as security" is the
        latest invoice of a client that keeps one back in place of a guarantee — it is owed, but not late, so it is in no age column.
        Click a client for their ledger.
      </p>

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left">
            <tr className="text-xs text-muted-foreground">
              <th className="px-3 py-2">Client</th>
              <th className="px-3 py-2 text-right">Owes now</th>
              <th className="px-3 py-2 text-right">Held as security</th>
              <th className="px-3 py-2 text-right">Opening (31 Aug)</th>
              <th className="px-3 py-2 text-right">0–30 days</th>
              <th className="px-3 py-2 text-right">31–60</th>
              <th className="px-3 py-2 text-right">61–90</th>
              <th className="px-3 py-2 text-right">Over 90</th>
              <th className="px-3 py-2">Last payment</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-3 py-10 text-center text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">No client owes anything{search ? " that matches" : ""}.</td></tr>
            ) : visible.map((r) => (
              <tr key={r.client_id} className="border-t border-border hover:bg-muted/40 cursor-pointer" onClick={() => setSelected(r)}>
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">{r.client_name}</div>
                  {r.wht_awaiting_certificate > 0.5 && (
                    <div className="text-[11px] text-warning-700 dark:text-warning-500">Tax {fmt(r.wht_awaiting_certificate)} awaiting certificate</div>
                  )}
                  {held.has(r.client_id) && (
                    <div className="text-[11px] text-info-700 dark:text-info-500">Holds latest invoice as security</div>
                  )}
                </td>
                <td className={`px-3 py-2 text-right font-ledger font-semibold ${r.balance < -0.5 ? "text-success-700 dark:text-success-500" : "text-foreground"}`}>{fmtBal(r.balance)}</td>
                <td className="px-3 py-2 text-right font-ledger text-info-700 dark:text-info-500"
                  title={held.get(r.client_id)?.invoice_number ? `${held.get(r.client_id)!.invoice_number} — ${held.get(r.client_id)!.reason}` : undefined}>
                  {held.has(r.client_id) ? fmt(held.get(r.client_id)!.held_amount) : ""}
                </td>
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
                <td className="px-3 py-2 text-right font-ledger">{foot.held > 0.5 ? fmt(foot.held) : ""}</td>
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

      <FormerClients />
    </div>
  );
}

// ───────────────────────────── One client's ledger ─────────────────────────────

function ClientLedger({ row, companyId, companyName, canEdit, onBack }: {
  row: Row; companyId: string | null; companyName: string; canEdit: boolean; onBack: () => void;
}) {
  const { company, profile } = useAuth();
  const toReceipt = (l: Line): ReceiptLine => ({ date: l.line_date!, reference: l.reference, mode: l.mode, chequeNo: l.cheque_no, depositedTo: l.deposited_to, received: l.received, wht: l.wht });
  const [range, setRange] = usePageState<Range>("ClientReceivables.range", "all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<{ id: string; cheque_number: string; amount: number; cheque_date: string; bank: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  // 0661: does this client hold its latest invoice as security?
  const [security, setSecurity] = useState<SecurityHeld | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const loadSecurity = useCallback(async () => {
    setSecurity((await loadSecurityHeld()).get(row.client_id) ?? null);
  }, [row.client_id]);
  useEffect(() => { void loadSecurity(); }, [loadSecurity]);
  const endSecurity = async () => {
    if (!security) return;
    const note = await askReason({
      title: "End security hold",
      subject: { title: row.client_name, meta: `Holding its latest invoice since ${fmtDate(security.since)}` },
      message: "Its latest invoice ages and counts as overdue again, like any other. Nothing in the ledger changes.",
      label: "Why has it ended?",
      placeholder: "e.g. Contract ended — security invoice paid",
      confirmLabel: "End hold",
    });
    if (!note) return;
    const { error } = await supabase.rpc("end_client_security_hold", { p_hold_id: security.hold_id, p_note: note });
    if (error) { setErr(friendlyDbError(error)); return; }
    await loadSecurity();
  };
  const [taxLine, setTaxLine] = useState<Line | null>(null);
  // 0659: move a receipt part to the invoice it really paid.
  const [moveLine, setMoveLine] = useState<Line | null>(null);
  const [contactOpen, setContactOpen] = useState(false);
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [contacts, setContacts] = useState<{ id: string; contacted_on: string; channel: string; note: string; promised_amount: number | null; promised_by: string | null; next_follow_up: string | null }[]>([]);
  const [pendingWo, setPendingWo] = useState<{ id: string; amount: number; reason: string; requested_at: string }[]>([]);

  const [pFrom, pTo] = rangeDates(range, from, to);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data, error }, chq, fu, wo] = await Promise.all([
      supabase.rpc("client_receivable_ledger", { p_client_id: row.client_id, p_from: pFrom, p_to: pTo }),
      supabase.from("cheques").select("id, cheque_number, amount, cheque_date, status, bank:bank_accounts(bank_name)")
        .eq("client_id", row.client_id).eq("direction", "incoming").not("status", "in", "(cleared,bounced)").order("cheque_date"),
      supabase.from("client_followups").select("id, contacted_on, channel, note, promised_amount, promised_by, next_follow_up")
        .eq("client_id", row.client_id).order("contacted_on", { ascending: false }).order("created_at", { ascending: false }).limit(20),
      supabase.from("client_write_offs").select("id, amount, reason, requested_at").eq("client_id", row.client_id).eq("status", "pending"),
    ]);
    setContacts(((fu.data ?? []) as any[]).map((c) => ({ ...c, promised_amount: c.promised_amount == null ? null : n(c.promised_amount) })));
    setPendingWo(((wo.data ?? []) as any[]).map((w) => ({ ...w, amount: n(w.amount) })));
    if (error) setErr(friendlyDbError(error));
    else {
      setErr(null);
      // The database still labels the opening line "Balance before Bastion"; Shayan
      // wants no such wording (2 Nov 2026), so it reads as an opening balance here
      // and in the PDF/Excel built from these lines. To be changed at the source
      // with the dated opening items.
      setLines(((data ?? []) as Line[]).map((l) => ({ ...l, details: l.details === "Balance before Bastion" ? "Opening balance at 31 Aug 2026" : l.details, invoiced: n(l.invoiced), received: n(l.received), wht: n(l.wht), written_off: n(l.written_off), balance: n(l.balance) })));
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
    // A write-off is shown in the Received column, its details saying what it is.
    invoiced: l.invoiced, received: l.received + l.written_off, wht: l.wht, balance: l.balance,
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
        <Button variant="secondary" size="sm" onClick={() => void downloadClientLedgerPdf({ companyName, branding: brandingFromCompany(company), clientName: row.client_name, scope: scopeLabel, lines: exportRows, closing })}>
          <FileText className="w-4 h-4 mr-1" /> PDF
        </Button>
        {canEdit && !security && <Button variant="secondary" size="sm" onClick={() => setSecurityOpen(true)}><ShieldCheck className="w-4 h-4 mr-1" /> Holds invoice as security</Button>}
        {canEdit && <Button variant="secondary" size="sm" onClick={() => setContactOpen(true)}><MessageSquare className="w-4 h-4 mr-1" /> Log contact</Button>}
        {canEdit && row.balance > 0.5 && <Button variant="secondary" size="sm" onClick={() => setWriteOffOpen(true)}><Ban className="w-4 h-4 mr-1" /> Write off</Button>}
        {canEdit && <Button size="sm" onClick={() => setReceiptOpen(true)}><Plus className="w-4 h-4 mr-1" /> Record payment</Button>}
      </div>

      {security && (
        <div className="flex flex-wrap items-start gap-3 rounded-lg border border-info-200 bg-info-50 dark:bg-info-500/10 p-3 text-sm text-info-700 dark:text-info-500">
          <ShieldCheck className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold">Holds its latest invoice as security · since {fmtDate(security.since)}</div>
            <div className="text-xs mt-0.5">
              {security.invoice_number
                ? <>Held now: {security.invoice_number} — {fmt(security.held_amount)} unpaid of {fmt(security.invoice_amount)}. </>
                : <>No invoice yet. </>}
              It is owed but not late, so it is left out of ageing and overdue. Each new invoice takes its place. {security.reason}
            </div>
          </div>
          {canEdit && <Button variant="secondary" size="sm" onClick={() => void endSecurity()}>End hold</Button>}
        </div>
      )}
      {securityOpen && (
        <SecurityHoldModal clientId={row.client_id} clientName={row.client_name}
          onClose={() => setSecurityOpen(false)} onSaved={() => { setSecurityOpen(false); void loadSecurity(); }} />
      )}

      {pendingWo.length > 0 && (
        <div className="rounded-lg border border-warning-200 bg-warning-50 dark:bg-warning-500/10 p-3 text-sm text-warning-700 dark:text-warning-500">
          Waiting for approval: {pendingWo.map((w) => `write off ${fmt(w.amount)} (${w.reason})`).join(" · ")}. Approve it under Write-offs; it is not in the balance until then.
        </div>
      )}

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
                <td className="px-3 py-2 text-right font-ledger">
                  {l.line_kind === "write_off" ? <>{fmt(l.written_off)}<div className="text-[11px] font-sans text-danger-700 dark:text-danger-500">written off</div></> : fmt(l.received)}
                  {/* 3 Nov 2026: an official receipt for the client, from this line. */}
                  {l.line_kind === "receipt" && l.line_date && (
                    <div className="flex justify-end gap-2 font-sans text-[11px]">
                      <button className="text-brand-600 hover:underline" onClick={() => void downloadReceiptPdf({ company, client: row.client_name, line: toReceipt(l), receivedBy: profile?.full_name ?? "" })}>Receipt</button>
                      <a className="text-brand-600 hover:underline" target="_blank" rel="noreferrer"
                        href={`https://wa.me/?text=${encodeURIComponent(receiptWhatsAppText(row.client_name, toReceipt(l), company?.name ?? companyName))}`}>WhatsApp</a>
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="font-ledger">{fmt(l.wht)}</div>
                  <WhtBadge status={l.wht_status} cert={l.wht_certificate} />
                  {/* 0659: any receipt, even one spread over several invoices. */}
                  {canEdit && l.line_kind === "receipt" && (l.payment_ids?.length ?? 0) >= 1 && l.wht_status !== "certificate received" && (
                    <button className="text-[11px] text-brand-600 hover:underline" onClick={() => setTaxLine(l)}>
                      {l.wht ? "Change tax" : "Add tax deducted"}
                    </button>
                  )}
                  {canEdit && l.line_kind === "receipt" && (l.payment_ids?.length ?? 0) >= 1 && (
                    <button className="block ml-auto text-[11px] text-brand-600 hover:underline" onClick={() => setMoveLine(l)}>
                      Move to invoice
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

      <SheetHistory clientId={row.client_id} />

      <div className="rounded-xl border border-border bg-card">
        <div className="px-4 py-2 border-b border-border text-sm font-semibold">Follow-up history</div>
        {contacts.length === 0 ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">No contact logged yet.</div>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {contacts.map((c) => (
              <li key={c.id} className="px-4 py-2">
                <span className="text-muted-foreground">{fmtDate(c.contacted_on)} · {channelLabel(c.channel)}</span> — {c.note}
                {c.promised_amount != null && <span className="ml-2 text-xs font-semibold">Promised {fmt(c.promised_amount)} by {fmtDate(c.promised_by)}</span>}
                {c.next_follow_up && <span className="ml-2 text-xs text-muted-foreground">Next: {fmtDate(c.next_follow_up)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {contactOpen && <ContactModal clientId={row.client_id} clientName={row.client_name} onClose={() => setContactOpen(false)} onSaved={() => { setContactOpen(false); void load(); }} />}
      {writeOffOpen && <WriteOffModal row={row} onClose={() => setWriteOffOpen(false)} onSaved={() => { setWriteOffOpen(false); void load(); }} />}
      {receiptOpen && (
        <ReceiptModal row={row} companyId={companyId} owed={row.balance}
          onClose={() => setReceiptOpen(false)} onSaved={() => { setReceiptOpen(false); void load(); }} />
      )}
      {moveLine && (
        <MoveModal line={moveLine} clientId={row.client_id} onClose={() => setMoveLine(null)} onSaved={() => { setMoveLine(null); void load(); }} />
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
        const { error, cancelled } = await recordPaymentChecked({
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
        }, row.client_id);
        if (cancelled) return;
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
    // 0659: a receipt spread over several invoices takes its tax as a whole, oldest invoice first.
    const ids = line.payment_ids ?? [];
    const { error } = ids.length > 1
      ? await supabase.rpc("set_receipt_withholding", { p_payment_ids: ids, p_withholding: v })
      : await supabase.rpc("record_payment_withholding", { p_payment_id: ids[0], p_withholding: v });
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

// 0659: re-point one part of a receipt to the invoice it really paid. No money moves.
function MoveModal({ line, clientId, onClose, onSaved }: { line: Line; clientId: string; onClose: () => void; onSaved: () => void }) {
  type Part = { id: string; amount: number; withholding_amount: number; invoices: { invoice_number: string | null } | null };
  type Inv = { id: string; invoice_number: string | null; invoice_date: string; invoice_amount: number; amount_received: number };
  const [parts, setParts] = useState<Part[]>([]);
  const [invs, setInvs] = useState<Inv[]>([]);
  const [partId, setPartId] = useState("");
  const [invId, setInvId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([
      supabase.from("invoice_payments").select("id, amount, withholding_amount, invoices(invoice_number)").in("id", line.payment_ids ?? []),
      supabase.from("invoices").select("id, invoice_number, invoice_date, invoice_amount, amount_received").eq("client_id", clientId).order("invoice_date", { ascending: false }).limit(24),
    ]).then(([p, i]) => {
      const ps = ((p.data ?? []) as any[]).map((x) => ({ ...x, amount: n(x.amount), withholding_amount: n(x.withholding_amount) })) as Part[];
      setParts(ps);
      if (ps.length === 1) setPartId(ps[0].id);
      setInvs(((i.data ?? []) as any[]).map((x) => ({ ...x, invoice_amount: n(x.invoice_amount), amount_received: n(x.amount_received) })));
    });
  }, [line.payment_ids, clientId]);
  const part = parts.find((x) => x.id === partId);
  const settle = part ? part.amount + part.withholding_amount : 0;
  const save = async () => {
    if (!partId) return setErr("Choose which part of the receipt to move.");
    if (!invId) return setErr("Choose the invoice it paid.");
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("move_receipt_part", { p_payment_id: partId, p_invoice_id: invId });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    onSaved();
  };
  return (
    <Modal isOpen onClose={onClose} size="sm" title="Move to the invoice it paid" error={err} onDismissError={() => setErr(null)}
      footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Move"}</Button></div>}>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Payment of {fmt(line.received)} on {fmtDate(line.line_date)}. Use this when a payment was applied to the wrong invoice — for example an
          older invoice whose leftover was really the tax they deducted. No money moves; only which invoice it settles.
        </p>
        <label className="block">
          <span className="lbl">Part of the receipt</span>
          <select className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={partId} onChange={(e) => setPartId(e.target.value)}>
            {parts.length !== 1 && <option value="">Choose…</option>}
            {parts.map((x) => <option key={x.id} value={x.id}>{fmt(x.amount)}{x.withholding_amount ? ` + ${fmt(x.withholding_amount)} tax` : ""} — now on {x.invoices?.invoice_number ?? "no invoice"}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="lbl">Invoice it paid</span>
          <select className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={invId} onChange={(e) => setInvId(e.target.value)}>
            <option value="">Choose…</option>
            {invs.map((x) => {
              const room = Math.round(x.invoice_amount - x.amount_received);
              return <option key={x.id} value={x.id} disabled={!!part && room < Math.round(settle)}>{x.invoice_number ?? "—"} · {fmtDate(x.invoice_date)} · {room > 0 ? `${room.toLocaleString()} open` : "fully settled"}</option>;
            })}
          </select>
        </label>
      </div>
    </Modal>
  );
}

// ───────────────────────────── Write-offs (0627) ─────────────────────────────

function WriteOffModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("request_client_write_off", { p_client_id: row.client_id, p_amount: Number(amount || 0), p_reason: reason });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    onSaved();
  };
  return (
    <Modal isOpen onClose={onClose} size="sm" title={`Write off — ${row.client_name}`} error={err} onDismissError={() => setErr(null)}
      footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" onClick={() => void save()} disabled={busy}>{busy ? "Sending…" : "Ask for approval"}</Button></div>}>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          For money this client will never pay. They owe {fmtBal(row.balance)}. Someone else with the "Approve bad-debt write-offs" permission must approve it;
          until then nothing changes. Once approved it is booked as a bad-debt expense and comes off their balance.
        </p>
        <label className="block"><span className="lbl">Amount to write off</span>
          <input type="number" inputMode="decimal" className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button type="button" className="text-[11px] text-brand-600 hover:underline" onClick={() => setAmount(String(Math.round(row.balance * 100) / 100))}>Everything they owe ({fmt(row.balance)})</button>
        </label>
        <label className="block"><span className="lbl">Why will it never be paid?</span>
          <textarea rows={3} className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Company closed; owner untraceable since March" /></label>
      </div>
    </Modal>
  );
}

type WriteOff = {
  id: string; client_id: string; amount: number; reason: string; status: "pending" | "approved" | "rejected";
  requested_by: string; requested_at: string; decided_at: string | null; decision_note: string | null;
  client: { name: string; branch_id: string | null } | null;
};

function WriteOffsView({ companyId, regionId, onChanged }: { companyId: string | null; regionId: string | null; onChanged: () => void }) {
  const { profile } = useAuth();
  const canApprove = hasPermission(profile, "receivables.write_off_approve");
  const canSetPolicy = hasPermission(profile, "accounting.edit");
  const [list, setList] = useState<WriteOff[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [bearer, setBearer] = useState<string>("region");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<WriteOff | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const [w, fs] = await Promise.all([
      supabase.from("client_write_offs").select("id, client_id, amount, reason, status, requested_by, requested_at, decided_at, decision_note, client:clients(name, branch_id)")
        .order("requested_at", { ascending: false }),
      companyId ? supabase.from("finance_settings").select("bad_debt_bearer").eq("company_id", companyId).maybeSingle() : Promise.resolve({ data: null } as any),
    ]);
    if (w.error) setErr(friendlyDbError(w.error));
    const rows = ((w.data ?? []) as any[]).map((x) => ({ ...x, amount: n(x.amount) })) as WriteOff[];
    setList(rows);
    setBearer((fs.data as any)?.bad_debt_bearer ?? "region");
    const ids = Array.from(new Set(rows.map((r) => r.requested_by)));
    if (ids.length) {
      const { data } = await supabase.from("profiles").select("id, full_name").in("id", ids);
      setNames(new Map(((data ?? []) as any[]).map((p) => [p.id, p.full_name ?? ""])));
    }
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  const decide = async (w: WriteOff, approve: boolean, why: string | null) => {
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("decide_client_write_off", { p_write_off_id: w.id, p_approve: approve, p_note: why });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    setRejecting(null); setNote("");
    await load(); onChanged();
  };
  const saveBearer = async (v: string) => {
    if (!companyId) return;
    setBearer(v);
    const { error } = await supabase.from("finance_settings").update({ bad_debt_bearer: v, updated_at: new Date().toISOString() }).eq("company_id", companyId);
    if (error) setErr(friendlyDbError(error));
  };

  const scoped = list.filter((w) => !regionId || w.client?.branch_id === regionId);
  const pending = scoped.filter((w) => w.status === "pending");
  const done = scoped.filter((w) => w.status !== "pending");
  const me = profile?.id;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        A write-off is asked for from the client's ledger ("Write off") and approved here by a different person. Approved write-offs are booked as bad-debt expense and come off the client's balance.
      </p>
      {err && <div className="rounded-lg border border-danger-200 bg-danger-50 dark:bg-danger-500/10 p-3 text-sm text-danger-700 dark:text-danger-500">{err}</div>}

      <div className="rounded-xl border border-border bg-card">
        <div className="px-4 py-2 border-b border-border text-sm font-semibold">Waiting for approval ({pending.length})</div>
        {pending.length === 0 ? <div className="px-4 py-4 text-sm text-muted-foreground">Nothing waiting.</div> : (
          <ul className="divide-y divide-border">
            {pending.map((w) => (
              <li key={w.id} className="px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
                <div className="flex-1 min-w-[240px]">
                  <div className="font-medium">{w.client?.name ?? "—"} · <span className="font-ledger">{fmt(w.amount)}</span></div>
                  <div className="text-xs text-muted-foreground">{w.reason} — asked by {names.get(w.requested_by) || "someone"} on {fmtDate(w.requested_at)}</div>
                </div>
                {canApprove && w.requested_by !== me && (
                  <>
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void decide(w, true, null)}>Approve write-off</Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRejecting(w)}>Reject</Button>
                  </>
                )}
                {w.requested_by === me && <span className="text-xs text-muted-foreground">Your request — someone else approves it</span>}
                {!canApprove && w.requested_by !== me && <span className="text-xs text-muted-foreground">Needs "Approve bad-debt write-offs"</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="px-4 py-2 border-b border-border text-sm font-semibold">Decided</div>
        {done.length === 0 ? <div className="px-4 py-4 text-sm text-muted-foreground">No write-offs yet.</div> : (
          <ul className="divide-y divide-border text-sm">
            {done.map((w) => (
              <li key={w.id} className="px-4 py-2">
                <span className={w.status === "approved" ? "text-danger-700 dark:text-danger-500 font-semibold" : "text-muted-foreground"}>{w.status === "approved" ? "Written off" : "Rejected"}</span>
                {" "}{w.client?.name ?? "—"} · <span className="font-ledger">{fmt(w.amount)}</span>
                <span className="text-xs text-muted-foreground"> — {w.reason}{w.decision_note ? ` · ${w.decision_note}` : ""} · {fmtDate(w.decided_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-4 text-sm flex flex-wrap items-center gap-3">
        <span className="text-muted-foreground">A written-off debt is charged to</span>
        <ThemedSelect value={bearer} disabled={!canSetPolicy} onChange={(e) => void saveBearer(e.target.value)}>
          <option value="region">The client's region</option>
          <option value="head_office">Head office</option>
        </ThemedSelect>
        {!canSetPolicy && <span className="text-xs text-muted-foreground">Changing this needs "Edit banks, transfers, reconciliation".</span>}
      </div>

      {rejecting && (
        <Modal isOpen size="sm" onClose={() => setRejecting(null)} title={`Reject write-off — ${rejecting.client?.name ?? ""}`}
          footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button><Button disabled={busy || !note.trim()} onClick={() => void decide(rejecting, false, note)}>Reject</Button></div>}>
          <label className="block text-sm"><span className="lbl">Why?</span>
            <textarea rows={3} className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </Modal>
      )}
    </div>
  );
}

// ───────────────────────────── Invoice-sheet history (0631) ─────────────────────────────

type SheetRow = {
  id: number; source_name: string; sheet_month: string; p_balance: number | null; invoice: number | null;
  deduction: number | null; received: number | null; balance: number | null; received_date: string | null;
  received_date_text: string | null; note: string | null;
};
const fmtCell = (v: number | null) => (v == null ? "" : Math.round(v).toLocaleString());

/**
 * The client's month-by-month history from the monthly invoice sheets before
 * Bastion (0631) — FOR REFERENCE. Shown exactly as the sheets typed it (blank
 * stays blank) and never added to anything: the before-Bastion position is the
 * brought-forward line at the top of the ledger.
 */
function SheetHistory({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<SheetRow[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void supabase.from("client_sheet_history")
      .select("id, source_name, sheet_month, p_balance, invoice, deduction, received, balance, received_date, received_date_text, note")
      .eq("client_id", clientId).order("sheet_month").order("source_row")
      .then(({ data }) => setRows(((data ?? []) as any[]).map((r) => ({ ...r, p_balance: n(r.p_balance), invoice: n(r.invoice), deduction: n(r.deduction), received: n(r.received), balance: r.balance == null ? null : n(r.balance) }))));
  }, [clientId]);
  if (!rows || rows.length === 0) return null;
  const multi = new Set(rows.map((r) => r.source_name)).size > 1;
  const first = rows[0].sheet_month, last = rows[rows.length - 1].sheet_month;
  return (
    <div className="rounded-xl border border-border bg-card">
      <button className="w-full flex items-center justify-between px-4 py-2 border-b border-border text-sm" onClick={() => setOpen(!open)}>
        <span className="font-semibold">Monthly invoice sheets</span>
        <span className="text-xs text-muted-foreground">{fmtMonth(first)} – {fmtMonth(last)} · {rows.length} rows · {open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="overflow-x-auto">
          <p className="px-4 pt-2 text-xs text-muted-foreground">
            For reference: copied as the sheets were kept (WHT taken at invoice; blank cells left blank). It is not added to the balance above — the balance brought into Bastion is the "Brought forward" line.
          </p>
          <table className="w-full text-sm">
            <thead className="text-left">
              <tr className="text-xs text-muted-foreground">
                <th className="px-3 py-2">Month</th>
                {multi && <th className="px-3 py-2">Row on sheet</th>}
                <th className="px-3 py-2 text-right">Previous balance</th>
                <th className="px-3 py-2 text-right">Invoiced</th>
                <th className="px-3 py-2 text-right">Deducted</th>
                <th className="px-3 py-2 text-right">Received</th>
                <th className="px-3 py-2">Received on</th>
                <th className="px-3 py-2 text-right">Balance</th>
                <th className="px-3 py-2">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-1.5 whitespace-nowrap">{fmtMonth(r.sheet_month)}</td>
                  {multi && <td className="px-3 py-1.5 text-xs">{r.source_name}</td>}
                  <td className="px-3 py-1.5 text-right font-ledger">{fmtCell(r.p_balance)}</td>
                  <td className="px-3 py-1.5 text-right font-ledger">{fmtCell(r.invoice)}</td>
                  <td className="px-3 py-1.5 text-right font-ledger">{fmtCell(r.deduction)}</td>
                  <td className="px-3 py-1.5 text-right font-ledger">{fmtCell(r.received)}</td>
                  <td className="px-3 py-1.5 text-xs whitespace-nowrap">{r.received_date ? fmtDate(r.received_date) : r.received_date_text ?? ""}</td>
                  <td className="px-3 py-1.5 text-right font-ledger">{fmtCell(r.balance)}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Clients on the pre-Bastion sheets who are not Bastion clients (0631), for reference. */
export function FormerClients() {
  const [rows, setRows] = useState<{ sheet_client: string; sheet_month: string; invoice: number | null; received: number | null; balance: number | null; note: string | null }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void supabase.from("client_sheet_history").select("sheet_client, sheet_month, invoice, received, balance, note")
      .is("client_id", null).order("sheet_client").order("sheet_month")
      .then(({ data }) => setRows((data ?? []) as any[]));
  }, []);
  // One line per former client: the months they appear in and their LAST sheet row, as typed.
  const byClient = new Map<string, typeof rows>();
  for (const r of rows) byClient.set(r.sheet_client, [...(byClient.get(r.sheet_client) ?? []), r]);
  if (byClient.size === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-card">
      <button className="w-full flex items-center justify-between px-4 py-2 text-sm" onClick={() => setOpen(!open)}>
        <span className="font-semibold">Inactive clients</span>
        <span className="text-xs text-muted-foreground">{byClient.size} clients from the monthly invoice sheets with no current contract · {open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <table className="w-full text-sm border-t border-border">
          <thead className="text-left"><tr className="text-xs text-muted-foreground">
            <th className="px-3 py-2">Client (as on the sheets)</th><th className="px-3 py-2">On the sheets</th>
            <th className="px-3 py-2 text-right">Last balance on the sheets</th><th className="px-3 py-2">Last note</th>
          </tr></thead>
          <tbody>
            {[...byClient.entries()].map(([name, list]) => {
              const lastRow = list[list.length - 1];
              return (
                <tr key={name} className="border-t border-border">
                  <td className="px-3 py-1.5">{name}</td>
                  <td className="px-3 py-1.5 text-xs whitespace-nowrap">{fmtMonth(list[0].sheet_month)} – {fmtMonth(lastRow.sheet_month)}</td>
                  <td className="px-3 py-1.5 text-right font-ledger">{lastRow.balance == null ? "" : Math.round(Number(lastRow.balance)).toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{[...list].reverse().find((x) => x.note)?.note ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// 0661: start a security hold — the client keeps its latest invoice back in place of a guarantee.
function SecurityHoldModal({ clientId, clientName, onClose, onSaved }: {
  clientId: string; clientName: string; onClose: () => void; onSaved: () => void;
}) {
  const [reason, setReason] = useState("");
  const [since, setSince] = useState(today());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("set_client_security_hold", { p_client_id: clientId, p_reason: reason.trim(), p_since: since });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    onSaved();
  };
  return (
    <Modal isOpen onClose={onClose} title="Holds latest invoice as security" size="sm" error={err} onDismissError={() => setErr(null)}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !reason.trim() || !since}>{busy ? "Saving…" : "Save"}</Button>
        </div>
      }>
      <div className="space-y-4 text-sm">
        <p className="text-foreground">
          <span className="font-semibold">{clientName}</span> keeps its latest invoice unpaid as security. Each month the
          previous one is released and the new one is held.
        </p>
        <p className="text-muted-foreground text-xs">
          The latest invoice is shown as "held as security" and left out of ageing, overdue and receivable days. It is still
          owed: the balance and the ledger do not change. Anything older that is unpaid still shows as overdue.
        </p>
        <div>
          <label className="block text-xs font-medium text-foreground mb-1.5">Why<span className="text-danger-600 ml-0.5">*</span></label>
          <textarea className="w-full min-h-16 px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground"
            placeholder="e.g. In place of a PKR 5m bank guarantee; released at contract end"
            value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-medium text-foreground mb-1.5">Since<span className="text-danger-600 ml-0.5">*</span></label>
          <input type="date" className="px-3 py-2 rounded-lg border border-border bg-background text-sm" value={since} onChange={(e) => setSince(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}
