import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, FileSpreadsheet, FileText, Loader2, Search } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import ThemedSelect from "./ThemedSelect";
import { supabase, friendlyDbError } from "../lib/supabase";
import { useAuth, hasPermission, hasAnyPermission } from "../lib/auth";
import { useRegion } from "../lib/region";
import { usePageState } from "../lib/pageState";
import { downloadFollowUpPdf, type FollowUpPdfRow } from "../lib/followUpPdf";
import { exportTable } from "../lib/excel";
import { SPANS, invoiceGaps, invoiceStatus, loadFollowInvoices, loadFollowUpdates, monthShort, spanRange, type FollowInvoice, type FollowUpdates, type Span } from "../lib/followUpData";
import FollowUpSummary from "./FollowUpSummary";

/**
 * PAYMENT FOLLOW-UP (0628, DECIDED 2 Nov 2026).
 *
 * Who to chase for payment, and what was agreed. Read from client_followup_list(),
 * which returns every amount as NULL to a login holding only
 * receivables.follow_up — so the ops team sees names, how late, the usual pay
 * day, contact notes, promise dates and next steps, and no figure at all. The
 * screen hides the amount columns for them too, but the database is what makes
 * it true.
 *
 * LATE means past the client's usual pay day for their oldest unpaid invoice, or
 * followup_after_days (7) after it when no day is set; anything from before
 * Bastion is always late. Exported as a PDF with figures (finance only) or
 * without, to share whenever it is wanted — it is not part of the daily report.
 */

export type FollowRow = {
  client_id: string;
  client_name: string;
  branch_id: string | null;
  region_name: string | null;
  usual_pay_day: number | null;
  is_late: boolean;
  late_since: string | null;
  days_late: number | null;
  from_before_bastion: boolean;
  balance: number | null;
  overdue: number | null;
  last_contact_on: string | null;
  last_contact_channel: string | null;
  last_contact_note: string | null;
  promised_by: string | null;
  promised_amount: number | null;
  next_follow_up: string | null;
  next_step: string | null;
  next_step_assignee: string | null;
  next_step_assignee_name: string | null;
  next_step_followup_id: string | null;
  next_step_done: boolean;
  /** 0630: date and mode for everyone; the amount only for logins that can see amounts. */
  last_paid_on: string | null;
  last_paid_mode: string | null;
  last_paid_amount: number | null;
};

type History = {
  id: string; contacted_on: string; channel: string; note: string; promised_by: string | null; promised_amount: number | null;
  next_follow_up: string | null; next_step: string | null; next_step_assignee_name: string | null; next_step_done_at: string | null; logged_by_name: string | null;
};

export const CHANNELS: [string, string][] = [["call", "Call"], ["whatsapp", "WhatsApp"], ["letter", "Letter"], ["visit", "Visit"], ["email", "Email"]];
export const channelLabel = (c: string | null) => CHANNELS.find(([k]) => k === c)?.[1] ?? c ?? "";
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());
const fmtDate = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
const fmtShort = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
const fmt = (v: number | null) => (v == null ? "" : Math.round(v).toLocaleString());
const n = (v: unknown) => (v == null ? null : Number(v));
const ordinal = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;

/** Whether this login is shown amounts. Display only: the database decides what it returns. */
/** Balances under this are grouped away on request (write-off candidates, mostly former clients). */
const SMALL = 50000;

export function useCanSeeAmounts() {
  const { profile } = useAuth();
  return hasAnyPermission(profile, ["invoices.view", "invoices.edit", "receivables.view", "accounting.edit"]);
}

/** The opening balances were taken on at 31 Aug 2026; an amount still owed from them is late from that day. */
const OPENING_DATE = "2026-08-31";
function lateText(r: FollowRow) {
  // Shayan, 2 Nov 2026: no "before Bastion" wording anywhere — an unpaid opening
  // balance reads as days late since the opening date, like any other debt.
  if (r.from_before_bastion) {
    const d = Math.floor((new Date(`${today()}T00:00:00`).getTime() - new Date(`${OPENING_DATE}T00:00:00`).getTime()) / 86400000);
    return `${d} days late (since 31 Aug)`;
  }
  if (r.is_late && r.days_late != null) return `${r.days_late} day${r.days_late === 1 ? "" : "s"} late`;
  if (r.late_since) return `Due ${fmtShort(r.late_since)}`;
  return "Not late yet";
}

export default function PaymentFollowUp({ onOpenClient }: { onOpenClient?: (clientId: string) => void } = {}) {
  const { profile, company } = useAuth();
  const canAct = hasAnyPermission(profile, ["receivables.follow_up", "invoices.edit"]);
  const canSeeAmounts = useCanSeeAmounts();
  const canSetPolicy = hasPermission(profile, "accounting.edit");
  const { regionId } = useRegion();

  const [rows, setRows] = useState<FollowRow[]>([]);
  const [people, setPeople] = useState<{ id: string; full_name: string }[]>([]);
  /** 0631: the usual day each client paid on the pre-Bastion sheets — a suggestion (finance only). */
  const [usualDay, setUsualDay] = useState<Map<string, { day: number; n: number }>>(new Map());
  const [lateAfter, setLateAfter] = useState(7);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = usePageState<"late" | "all" | "mine">("PaymentFollowUp.show", "late");
  const [hideSmall, setHideSmall] = usePageState("PaymentFollowUp.hideSmall", false);
  const [search, setSearch] = usePageState("PaymentFollowUp.search", "");
  const [logFor, setLogFor] = useState<FollowRow | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  /** 0634: the updates summary for the chosen period, and last month's invoice per client. */
  const [span, setSpan] = usePageState<Span>("PaymentFollowUp.span", "7d");
  const [updates, setUpdates] = useState<FollowUpdates | null>(null);
  const [invoices, setInvoices] = useState<Map<string, FollowInvoice[]>>(new Map());
  useEffect(() => { const r = spanRange(span); void loadFollowUpdates(r.from, r.to).then(setUpdates); }, [span]);

  const load = useCallback(async () => {
    setLoading(true);
    void loadFollowInvoices().then(setInvoices);
    const [l, p, fs, pt] = await Promise.all([
      supabase.rpc("client_followup_list"),
      supabase.rpc("followup_assignees"),
      company?.id ? supabase.from("finance_settings").select("followup_after_days").eq("company_id", company.id).maybeSingle() : Promise.resolve({ data: null } as any),
      // Finance keys only (the view is invoker over a finance-read table); empty for ops.
      supabase.from("client_sheet_pay_timing").select("client_id, usual_day, dated_receipts"),
    ]);
    setUsualDay(new Map(((pt.data ?? []) as any[]).map((x) => [x.client_id, { day: Number(x.usual_day), n: Number(x.dated_receipts) }])));
    if (l.error) setErr(friendlyDbError(l.error));
    else {
      setErr(null);
      setRows(((l.data ?? []) as any[]).map((r) => ({ ...r, balance: n(r.balance), overdue: n(r.overdue), promised_amount: n(r.promised_amount), last_paid_amount: n(r.last_paid_amount) })));
    }
    setPeople((p.data ?? []) as { id: string; full_name: string }[]);
    if ((fs.data as any)?.followup_after_days != null) setLateAfter(Number((fs.data as any).followup_after_days));
    setLoading(false);
  }, [company?.id]);
  useEffect(() => { void load(); }, [load]);

  const openHistory = async (clientId: string) => {
    if (open === clientId) { setOpen(null); return; }
    setOpen(clientId);
    setHistory([]);
    const { data, error } = await supabase.rpc("client_followup_history", { p_client_id: clientId });
    if (error) setErr(friendlyDbError(error));
    else setHistory(((data ?? []) as any[]).map((h) => ({ ...h, promised_amount: n(h.promised_amount) })));
  };

  const t = today();
  const me = profile?.id;
  const invMonth = monthShort([...invoices.values()][0]?.[0]?.for_month) || "Last month's";
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => !regionId || r.branch_id === regionId)
      .filter((r) => (show === "late" ? r.is_late : show === "mine" ? (!!r.next_step && !r.next_step_done && r.next_step_assignee === me) : true))
      .filter((r) => !q || r.client_name.toLowerCase().includes(q))
      // 3 Nov 2026: small former-client balances (4,620 · 5,000 · 12,500) sat among HMC and Nova.
      .filter((r) => !hideSmall || r.balance == null || Math.abs(r.balance) >= SMALL)
      .sort((a, b) => {
        // Steps due today or earlier first, then the latest-paying.
        const ad = a.next_follow_up && a.next_follow_up <= t && !a.next_step_done ? 0 : 1;
        const bd = b.next_follow_up && b.next_follow_up <= t && !b.next_step_done ? 0 : 1;
        const al = a.from_before_bastion ? 100000 : a.days_late ?? -1;
        const bl = b.from_before_bastion ? 100000 : b.days_late ?? -1;
        return ad - bd || bl - al || a.client_name.localeCompare(b.client_name);
      });
  }, [rows, regionId, show, search, me, t, hideSmall]);
  const smallCount = rows.filter((r) => (!regionId || r.branch_id === regionId) && r.balance != null && Math.abs(r.balance) < SMALL && (show !== "late" || r.is_late)).length;
  // Clients whose usual pay day is not set but the invoice sheets suggest one.
  const suggestable = rows.filter((r) => !r.usual_pay_day && usualDay.has(r.client_id));
  const acceptSuggestions = async () => {
    setErr(null);
    for (const r of suggestable) {
      const { error } = await supabase.rpc("set_client_pay_day", { p_client_id: r.client_id, p_day: usualDay.get(r.client_id)!.day });
      if (error) { setErr(friendlyDbError(error)); break; }
    }
    void load();
  };

  const setPayDay = async (r: FollowRow, v: string) => {
    const { error } = await supabase.rpc("set_client_pay_day", { p_client_id: r.client_id, p_day: v ? Number(v) : null });
    if (error) return setErr(friendlyDbError(error));
    void load();
  };
  const doneStep = async (r: FollowRow) => {
    if (!r.next_step_followup_id) return;
    const { error } = await supabase.rpc("complete_followup_step", { p_followup_id: r.next_step_followup_id });
    if (error) return setErr(friendlyDbError(error));
    void load();
  };
  const saveLateAfter = async (v: number) => {
    if (!company?.id) return;
    setLateAfter(v);
    const { error } = await supabase.from("finance_settings").update({ followup_after_days: v, updated_at: new Date().toISOString() }).eq("company_id", company.id);
    if (error) setErr(friendlyDbError(error)); else void load();
  };

  const exportPdf = (withFigures: boolean) => {
    const rowsOut: FollowUpPdfRow[] = visible.map((r) => ({
      client: r.client_name,
      region: r.region_name,
      late: lateText(r),
      isLate: r.is_late,
      payDay: r.usual_pay_day ? ordinal(r.usual_pay_day) : "",
      lastPaidOn: r.last_paid_on,
      lastPaid: r.last_paid_on ? `${fmtShort(r.last_paid_on)}${r.last_paid_mode ? ` · ${r.last_paid_mode}` : ""}${withFigures && r.last_paid_amount != null ? ` · ${fmt(r.last_paid_amount)}` : ""}` : "Never",
      lastContactOn: r.last_contact_on,
      lastContact: r.last_contact_on ? `${channelLabel(r.last_contact_channel)}: ${r.last_contact_note ?? ""}` : null,
      promise: r.promised_by ? `by ${fmtShort(r.promised_by)}${withFigures && r.promised_amount != null ? ` (${fmt(r.promised_amount)})` : ""}` : null,
      nextStep: r.next_step && !r.next_step_done ? r.next_step : null,
      nextWho: r.next_step && !r.next_step_done ? r.next_step_assignee_name : null,
      nextBy: r.next_step && !r.next_step_done ? r.next_follow_up : null,
      owes: withFigures ? r.balance : null,
      overdue: withFigures ? r.overdue : null,
      invoice: invoiceStatus(invoices.get(r.client_id)).text,
    }));
    void downloadFollowUpPdf({
      company, rows: rowsOut, withFigures,
      region: regionId ? (rows.find((r) => r.branch_id === regionId)?.region_name ?? null) : null,
      scopeNote: show === "late" ? "Late clients" : show === "mine" ? "My next steps" : "Everyone who owes",
      todayIso: t,
      preparedBy: profile?.full_name ?? "",
      updates: updates ? { data: updates, label: SPANS.find(([k]) => k === span)?.[1] ?? "", regionId } : null,
      invoiceMonth: invMonth,
      gaps: invoiceGaps(invoices, regionId),
    });
  };

  // 0634: the same table as an Excel sheet, with or without figures.
  const exportExcel = (withFigures: boolean) => {
    const headers = ["Client", "Region", "Status", "Pays on", "Last paid", "Last paid mode", ...(withFigures ? ["Last paid amount", "Owes", "Late amount"] : []),
      `${invMonth} invoice`, "Last contact", "What they said", "Promise", ...(withFigures ? ["Promised amount"] : []), "Next step", "Who", "By"];
    void exportTable({
      fileName: `Payment follow-up ${t}${withFigures ? " (with figures)" : ""}.xlsx`,
      sheetName: "Follow-up",
      title: `Payment follow-up — ${show === "late" ? "late clients" : show === "mine" ? "my next steps" : "everyone who owes"} — ${fmtDate(t)}`,
      headers,
      rows: visible.map((r) => [
        r.client_name, r.region_name ?? "", lateText(r), r.usual_pay_day ? ordinal(r.usual_pay_day) : "",
        r.last_paid_on ? fmtDate(r.last_paid_on) : "Never", r.last_paid_mode ?? "",
        ...(withFigures ? [r.last_paid_amount, r.balance, r.overdue] : []),
        invoiceStatus(invoices.get(r.client_id)).text,
        r.last_contact_on ? `${fmtDate(r.last_contact_on)} · ${channelLabel(r.last_contact_channel)}` : "", r.last_contact_note ?? "",
        r.promised_by ? fmtDate(r.promised_by) : "", ...(withFigures ? [r.promised_amount] : []),
        r.next_step && !r.next_step_done ? r.next_step : "", r.next_step && !r.next_step_done ? r.next_step_assignee_name ?? "" : "",
        r.next_step && !r.next_step_done && r.next_follow_up ? fmtDate(r.next_follow_up) : "",
      ]),
      columnWidths: headers.map((h) => (["What they said", "Next step"].includes(h) ? 40 : h === "Client" ? 28 : 16)),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {([["late", "Late"], ["all", "Everyone who owes"], ["mine", "My next steps"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setShow(k)}
            className={`px-3 py-1.5 rounded-lg text-sm border ${show === k ? "bg-foreground text-background border-foreground" : "bg-card border-border hover:bg-muted"}`}>
            {label}{k === "late" ? ` (${rows.filter((r) => (!regionId || r.branch_id === regionId) && r.is_late).length})` : ""}
          </button>
        ))}
        <div className="relative min-w-[180px] max-w-xs flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-border bg-card text-sm" placeholder="Search clients" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex-1" />
        <div className="inline-flex items-center rounded-lg border border-border overflow-hidden text-sm">
          <span className="px-2.5 text-xs text-muted-foreground"><FileText className="w-3.5 h-3.5 inline" /> PDF</span>
          <button className="px-3 py-1.5 border-l border-border hover:bg-accent" onClick={() => exportPdf(false)}>Without figures</button>
          {canSeeAmounts && <button className="px-3 py-1.5 border-l border-border hover:bg-accent" onClick={() => exportPdf(true)}>With figures</button>}
        </div>
        <div className="inline-flex items-center rounded-lg border border-border overflow-hidden text-sm">
          <span className="px-2.5 text-xs text-muted-foreground"><FileSpreadsheet className="w-3.5 h-3.5 inline" /> Excel</span>
          <button className="px-3 py-1.5 border-l border-border hover:bg-accent" onClick={() => exportExcel(false)}>Without figures</button>
          {canSeeAmounts && <button className="px-3 py-1.5 border-l border-border hover:bg-accent" onClick={() => exportExcel(true)}>With figures</button>}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Updates</h3>
          {SPANS.map(([k, label]) => (
            <button key={k} onClick={() => setSpan(k)}
              className={`px-2.5 py-1 rounded-lg text-xs border ${span === k ? "bg-foreground text-background border-foreground" : "bg-card border-border hover:bg-muted"}`}>{label}</button>
          ))}
          <span className="text-[11px] text-muted-foreground">Payments, contacts and deliveries entered in the period; promises missed, steps due and invoices open as of now.</span>
        </div>
        <FollowUpSummary updates={updates} invoices={invoices} regionId={regionId} canSeeAmounts={canSeeAmounts} />
      </div>

      <p className="text-xs text-muted-foreground">
        A client is late once their usual pay day has passed for their oldest unpaid invoice — or {lateAfter} days after the invoice when no pay day is set.
        An opening balance still unpaid (as at 31 Aug 2026) is late from that date. Set each client's usual pay day in the "Pays on" column.
        {canAct && suggestable.length > 0 && (
          <> <button type="button" className="text-brand-700 dark:text-brand-500 hover:underline font-medium" onClick={() => void acceptSuggestions()}>
            Use the invoice sheets' usual day for {suggestable.length} client{suggestable.length === 1 ? "" : "s"}
          </button></>
        )}
        {canSeeAmounts && (smallCount > 0 || hideSmall) && (
          <> · <button type="button" className="hover:underline" onClick={() => setHideSmall(!hideSmall)}>
            {hideSmall ? "Show balances under 50,000" : `Hide ${smallCount} balance${smallCount === 1 ? "" : "s"} under 50,000`}
          </button></>
        )}
      </p>
      {err && <div className="rounded-lg border border-danger-200 bg-danger-50 dark:bg-danger-500/10 p-3 text-sm text-danger-700 dark:text-danger-500">{err}</div>}

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left">
            <tr className="text-xs text-muted-foreground">
              <th className="px-3 py-2 w-6"></th>
              <th className="px-3 py-2">Client</th>
              <th className="px-3 py-2">Late</th>
              <th className="px-3 py-2">Pays on</th>
              <th className="px-3 py-2">Last paid</th>
              <th className="px-3 py-2">{invMonth} invoice</th>
              {canSeeAmounts && <th className="px-3 py-2 text-right">Owes</th>}
              {canSeeAmounts && <th className="px-3 py-2 text-right">Late amount</th>}
              <th className="px-3 py-2">Last contact</th>
              <th className="px-3 py-2">Promise</th>
              <th className="px-3 py-2">Next step</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={12} className="px-3 py-10 text-center text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={12} className="px-3 py-10 text-center text-muted-foreground">{show === "late" ? "No client is late." : show === "mine" ? "No open steps for you." : "No client owes anything."}</td></tr>
            ) : visible.flatMap((r) => {
              const stepDue = !!r.next_step && !r.next_step_done && !!r.next_follow_up && r.next_follow_up <= t;
              const promiseMissed = !!r.promised_by && r.promised_by < t && r.is_late;
              const main = (
                <tr key={r.client_id} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <button onClick={() => void openHistory(r.client_id)} className="text-muted-foreground hover:text-foreground" title="Follow-up history">
                      {open === r.client_id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    {onOpenClient ? <button className="font-medium text-foreground hover:underline text-left" onClick={() => onOpenClient(r.client_id)}>{r.client_name}</button>
                      : <div className="font-medium text-foreground">{r.client_name}</div>}
                    {!regionId && r.region_name && <div className="text-[11px] text-muted-foreground">{r.region_name}</div>}
                  </td>
                  <td className={`px-3 py-2 whitespace-nowrap text-xs ${r.is_late ? "text-danger-700 dark:text-danger-500 font-semibold" : "text-muted-foreground"}`}>{lateText(r)}</td>
                  <td className="px-3 py-2">
                    {canAct ? (
                      <ThemedSelect value={r.usual_pay_day ?? ""} onChange={(e) => void setPayDay(r, e.target.value)} className="text-xs">
                        <option value="">Not set</option>
                        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{ordinal(d)}</option>)}
                      </ThemedSelect>
                    ) : <span className="text-xs">{r.usual_pay_day ? ordinal(r.usual_pay_day) : "—"}</span>}
                    {(() => {
                      const u = usualDay.get(r.client_id);
                      if (!u || u.day === r.usual_pay_day) return null;
                      const label = `Usually ~${ordinal(u.day)} (${u.n} payments on the invoice sheets)`;
                      return canAct
                        ? <button className="block text-[11px] text-brand-600 hover:underline mt-0.5" title="From the dated receipts on the monthly invoice sheets" onClick={() => void setPayDay(r, String(u.day))}>{label}</button>
                        : <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>;
                    })()}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {r.last_paid_on ? <>{fmtShort(r.last_paid_on)}<div className="text-muted-foreground">{r.last_paid_mode}{canSeeAmounts && r.last_paid_amount != null ? ` · ${fmt(r.last_paid_amount)}` : ""}</div></> : <span className="text-muted-foreground">Never</span>}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {(() => {
                      const st = invoiceStatus(invoices.get(r.client_id));
                      return st.text ? <span className={st.tone === "warn" ? "text-warning-700 dark:text-warning-500 font-medium" : "text-success-700 dark:text-success-500"}>{st.text}</span> : <span className="text-muted-foreground">—</span>;
                    })()}
                  </td>
                  {canSeeAmounts && <td className="px-3 py-2 text-right font-ledger">{fmt(r.balance)}</td>}
                  {canSeeAmounts && <td className="px-3 py-2 text-right font-ledger">{fmt(r.overdue)}</td>}
                  <td className="px-3 py-2 text-xs max-w-[260px]">
                    {r.last_contact_on ? <><span className="text-muted-foreground">{fmtShort(r.last_contact_on)} · {channelLabel(r.last_contact_channel)}</span><div className="line-clamp-2">{r.last_contact_note}</div></>
                      : <span className="text-muted-foreground">Not contacted</span>}
                  </td>
                  <td className={`px-3 py-2 text-xs whitespace-nowrap ${promiseMissed ? "text-danger-700 dark:text-danger-500 font-semibold" : ""}`}>
                    {r.promised_by ? <>by {fmtShort(r.promised_by)}{canSeeAmounts && r.promised_amount != null ? <> · {fmt(r.promised_amount)}</> : null}{promiseMissed ? <div>missed</div> : null}</> : ""}
                  </td>
                  <td className="px-3 py-2 text-xs max-w-[220px]">
                    {r.next_step && !r.next_step_done ? (
                      <>
                        <div className={stepDue ? "font-semibold text-warning-700 dark:text-warning-500" : ""}>{r.next_step}</div>
                        <div className="text-muted-foreground">{r.next_step_assignee_name ?? "Anyone"}{r.next_follow_up ? ` · ${stepDue ? "due " : ""}${fmtShort(r.next_follow_up)}` : ""}</div>
                        {canAct && <button className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline" onClick={() => void doneStep(r)}><Check className="w-3 h-3" /> Done</button>}
                      </>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{canAct && <Button variant="secondary" size="sm" onClick={() => setLogFor(r)}>Log contact</Button>}</td>
                </tr>
              );
              if (open !== r.client_id) return [main];
              return [main, (
                <tr key={`${r.client_id}-h`} className="bg-muted/30">
                  <td></td>
                  <td colSpan={11} className="px-3 py-2">
                    {history.length === 0 ? <div className="text-xs text-muted-foreground">No contact logged yet.</div> : (
                      <ul className="space-y-1 text-xs">
                        {history.map((h) => (
                          <li key={h.id}>
                            <span className="text-muted-foreground">{fmtDate(h.contacted_on)} · {channelLabel(h.channel)}{h.logged_by_name ? ` · ${h.logged_by_name}` : ""}</span> — {h.note}
                            {h.promised_by && <span className="ml-2 font-semibold">Promised by {fmtShort(h.promised_by)}{h.promised_amount != null ? ` · ${fmt(h.promised_amount)}` : ""}</span>}
                            {h.next_step && <span className="ml-2 text-muted-foreground">Next: {h.next_step}{h.next_step_assignee_name ? ` (${h.next_step_assignee_name})` : ""}{h.next_follow_up ? ` by ${fmtShort(h.next_follow_up)}` : ""}{h.next_step_done_at ? " ✓" : ""}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              )];
            })}
          </tbody>
        </table>
      </div>

      {canSetPolicy && (
        <div className="rounded-xl border border-border bg-card p-3 text-sm flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">With no pay day set, a client is late</span>
          <ThemedSelect value={lateAfter} onChange={(e) => void saveLateAfter(Number(e.target.value))}>
            {[3, 5, 7, 10, 14, 21, 30].map((d) => <option key={d} value={d}>{d} days</option>)}
          </ThemedSelect>
          <span className="text-muted-foreground">after the invoice date.</span>
        </div>
      )}

      {logFor && <ContactModal clientId={logFor.client_id} clientName={logFor.client_name} people={people}
        onClose={() => setLogFor(null)} onSaved={() => { setLogFor(null); void load(); if (open === logFor.client_id) void openHistory(logFor.client_id); }} />}
    </div>
  );
}

/**
 * Log a contact. Shared with the client ledger. The promise AMOUNT field is
 * offered only to logins that can see amounts; log_client_followup refuses an
 * amount from anyone else regardless.
 */
export function ContactModal({ clientId, clientName, people: given, onClose, onSaved }: {
  clientId: string; clientName: string; people?: { id: string; full_name: string }[]; onClose: () => void; onSaved: () => void;
}) {
  const canSeeAmounts = useCanSeeAmounts();
  const [people, setPeople] = useState(given ?? []);
  const [channel, setChannel] = useState("call");
  const [on, setOn] = useState(today());
  const [note, setNote] = useState("");
  const [promised, setPromised] = useState("");
  const [promisedBy, setPromisedBy] = useState("");
  const [step, setStep] = useState("");
  const [assignee, setAssignee] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (given) return;
    void supabase.rpc("followup_assignees").then(({ data }) => setPeople((data ?? []) as { id: string; full_name: string }[]));
  }, [given]);

  const save = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("log_client_followup", {
      p_client_id: clientId, p_channel: channel, p_note: note, p_contacted_on: on || null,
      p_promised_amount: canSeeAmounts && promised ? Number(promised) : null, p_promised_by: promisedBy || null,
      p_next_follow_up: next || null, p_next_step: step.trim() || null, p_next_step_assignee: assignee || null,
    });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    onSaved();
  };
  return (
    <Modal isOpen onClose={onClose} title={`Log contact — ${clientName}`} error={err} onDismissError={() => setErr(null)}
      footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save"}</Button></div>}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-2">
          {CHANNELS.map(([k, label]) => (
            <button key={k} onClick={() => setChannel(k)}
              className={`px-3 py-1.5 rounded-lg border ${channel === k ? "bg-foreground text-background border-foreground" : "bg-card border-border"}`}>{label}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="lbl">Date</span>
            <input type="date" max={today()} className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={on} onChange={(e) => setOn(e.target.value)} /></label>
          <label className="block"><span className="lbl">They promised to pay by (optional)</span>
            <input type="date" className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={promisedBy} onChange={(e) => setPromisedBy(e.target.value)} /></label>
        </div>
        <label className="block"><span className="lbl">What did they say?</span>
          <textarea rows={3} className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Spoke to accounts; cheque being signed this week" /></label>
        {canSeeAmounts && (
          <label className="block"><span className="lbl">Promised amount (optional)</span>
            <input type="number" inputMode="decimal" className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={promised} onChange={(e) => setPromised(e.target.value)} /></label>
        )}
        <div className="rounded-lg border border-border p-3 space-y-3">
          <div className="lbl">Next step (optional)</div>
          <input className="w-full px-3 py-2 rounded-lg border border-border bg-card" value={step} onChange={(e) => setStep(e.target.value)} placeholder="e.g. Visit to collect the cheque" />
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="lbl">Who</span>
              <ThemedSelect className="mt-1" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Anyone</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              </ThemedSelect></label>
            <label className="block"><span className="lbl">By when</span>
              <input type="date" min={on} className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={next} onChange={(e) => setNext(e.target.value)} /></label>
          </div>
        </div>
      </div>
    </Modal>
  );
}
