import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import Button from "./Button";
import { supabase, friendlyDbError } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useRegion } from "../lib/region";
import { downloadFinanceReportPdf, label } from "../lib/financeReportPdf";
import { invoiceGaps, loadFollowInvoices, loadFollowUpdates, monthShort, type FollowInvoice, type FollowUpdates } from "../lib/followUpData";
import FollowUpSummary from "./FollowUpSummary";

/**
 * FINANCE REPORT (0632, DECIDED 2 Nov 2026). Nobody fills it in: it reads
 * finance_report() for everything ENTERED since the last finance report was
 * exported — a payment dated last week but entered today is in today's report
 * — and the state now. Exporting records the period (log_report_run), so the
 * next report starts where this one ended. The only arithmetic is each list's
 * total, the sum of the rows shown.
 */

const amt = (n: unknown) => Math.round(Number(n ?? 0)).toLocaleString("en-US");
const short = (iso: string | null | undefined) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const monthOf = (iso: string | null | undefined) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "");
const toLocalInput = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

function Section({ title, total, children }: { title: string; total?: string; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-xl bg-card">
      <div className="px-4 py-2.5 border-b border-border flex items-baseline gap-2">
        <h3 className="font-semibold text-foreground">{title}</h3>
        {total && <span className="ml-auto text-sm font-semibold tabular-nums text-foreground">{total}</span>}
      </div>
      <div className="px-4 py-3 text-sm">{children}</div>
    </div>
  );
}
const Nil = ({ text = "Nil." }: { text?: string }) => <p className="text-muted-foreground italic">{text}</p>;

export default function FinanceReport({ readOnly = false }: { readOnly?: boolean }) {
  const { company, profile } = useAuth();
  const { regions, regionId } = useRegion();
  const [from, setFrom] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<FollowUpdates | null>(null);
  const [followInv, setFollowInv] = useState<Map<string, FollowInvoice[]>>(new Map());

  const load = useCallback(async (start?: string) => {
    setLoading(true); setErr(null);
    let f = start;
    if (!f) {
      const { data: s } = await supabase.rpc("report_period_start", { p_kind: "finance" });
      f = (s as string | null) ?? new Date(Date.now() - 86400000).toISOString();
    }
    setFrom(f);
    const { data: r, error } = await supabase.rpc("finance_report", { p_from: f, p_to: new Date().toISOString() });
    setLoading(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setData(r);
    // 0634: the follow-up picture for the same period, read the way Payment Follow-up reads it.
    const [fu, fi] = await Promise.all([loadFollowUpdates(f, (r as any).to), loadFollowInvoices()]);
    setFollowUp(fu); setFollowInv(fi);
  }, []);
  useEffect(() => { void load(); }, [load]);

  // The region filter narrows what the database already scoped to the caller.
  const d = useMemo(() => {
    if (!data || !regionId) return data;
    const keep = (xs: any[] | undefined) => (xs ?? []).filter((x) => x.branch_id === regionId);
    return { ...data, invoices_raised: keep(data.invoices_raised), invoices_delivered: keep(data.invoices_delivered), undelivered: keep(data.undelivered),
      missing: keep(data.missing), receipts: keep(data.receipts), expenses: keep(data.expenses), late_clients: keep(data.late_clients), followups: keep(data.followups) };
  }, [data, regionId]);
  const regionName = regionId ? regions.find((r) => r.id === regionId)?.name ?? null : null;
  const sum = (xs: any[] | undefined, k = "amount") => (xs ?? []).reduce((s, x) => s + Number(x[k] ?? 0), 0);

  const exportPdf = async () => {
    if (!d) return;
    setBusy(true);
    try {
      await downloadFinanceReportPdf({ company, data: d, region: regionName, preparedBy: profile?.full_name ?? "",
        followUp: followUp ? { updates: { data: followUp, label: "In this period", regionId }, gaps: invoiceGaps(followInv, regionId), invoiceMonth: monthShort([...followInv.values()][0]?.[0]?.for_month) || "Last month's" } : null });
      // Only a company-wide export moves the start: report_runs is per company,
      // so one region's export would drop the others' entries from their next report.
      if (!regionId && !readOnly) {
        const { error } = await supabase.rpc("log_report_run", { p_kind: "finance", p_from: d.from, p_to: d.to });
        if (error) setErr(friendlyDbError(error)); else void load();
      }
    } finally { setBusy(false); }
  };

  const ps = d?.payroll_status, rc = d?.receivables ?? {}, wt = d?.waiting ?? {};
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Everything entered since</span>
        {from && <input type="datetime-local" value={toLocalInput(from)} max={toLocalInput(new Date().toISOString())}
          onChange={(e) => e.target.value && void load(new Date(e.target.value).toISOString())}
          className="px-2 py-1 rounded-lg border border-border bg-card" />}
        <span className="text-muted-foreground">to now{!readOnly && " — the start is where the last exported report ended"}</span>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => void load(from ?? undefined)} disabled={loading}><RefreshCw className="w-4 h-4" /></Button>
        <Button size="sm" onClick={() => void exportPdf()} disabled={!d || busy}><Download className="w-4 h-4 mr-1" />{busy ? "Preparing…" : "Export PDF"}</Button>
      </div>
      {regionId && !readOnly && <p className="text-xs text-muted-foreground">Showing one region. Exporting a single region does not move the start of the next report; export under "All regions" for that.</p>}
      {err && <div className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">{err}</div>}
      {loading && !d && <div className="text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>}
      {d && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              ["Received", amt(sum(d.receipts)), `${d.receipts.length} payment${d.receipts.length === 1 ? "" : "s"}`],
              ["Invoiced", amt(sum(d.invoices_raised)), `${d.invoices_raised.length} raised`],
              ["Expenses", amt(sum(d.expenses)), `${d.expenses.length} entered`],
              ["Clients owe", amt(rc.owed), `${amt(rc.overdue)} over 30 days`],
            ].map(([l, v, s]) => (
              <div key={l} className="border border-border rounded-xl bg-card px-4 py-3">
                <div className="text-xs text-muted-foreground">{l}</div>
                <div className="text-xl font-semibold tabular-nums text-foreground">{v}</div>
                <div className="text-[11px] text-muted-foreground">{s}</div>
              </div>
            ))}
          </div>

          <Section title="Waiting on someone">
            {(() => {
              const items = [
                d.undelivered.length && `${d.undelivered.length} invoice${d.undelivered.length === 1 ? "" : "s"} not marked delivered`,
                d.missing.length && `${d.missing.length} client${d.missing.length === 1 ? "" : "s"} with no invoice for ${monthOf(d.billing_month)}: ${d.missing.map((m: any) => m.client).join(", ")}`,
                wt.cheques_uncleared && `${wt.cheques_uncleared} cheque${wt.cheques_uncleared === 1 ? "" : "s"} received, not cleared`,
                wt.write_offs_pending && `${wt.write_offs_pending} write-off${wt.write_offs_pending === 1 ? "" : "s"} waiting for approval`,
                wt.certificates_awaiting && `${wt.certificates_awaiting} payment${wt.certificates_awaiting === 1 ? "" : "s"} with tax waiting for a certificate`,
                wt.field_requests_pending && `${wt.field_requests_pending} field-app money request${wt.field_requests_pending === 1 ? "" : "s"} waiting`,
                ps?.month && Number(ps.remaining) > 0.5 && `${monthOf(ps.month)} salaries still to pay: ${amt(ps.remaining)} to ${ps.unpaid_people}`,
              ].filter(Boolean) as string[];
              return items.length ? <ol className="list-decimal ml-5 space-y-0.5">{items.map((t) => <li key={t}>{t}</li>)}</ol> : <Nil />;
            })()}
          </Section>

          <Section title="Payments received" total={amt(sum(d.receipts))}>
            {d.receipts.length ? (
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 pr-2">Date</th><th className="pr-2">Client</th><th className="pr-2">Mode</th><th className="pr-2">Went to</th><th className="text-right pr-2">Received</th><th className="text-right">Tax</th></tr></thead>
                <tbody>{d.receipts.map((r: any, i: number) => (
                  <tr key={i} className="border-t border-border"><td className="py-1 pr-2 whitespace-nowrap">{short(r.payment_date)}</td><td className="pr-2">{r.client}</td><td className="pr-2">{label(r.mode)}</td><td className="pr-2">{r.to}</td><td className="text-right pr-2 tabular-nums">{amt(r.amount)}</td><td className="text-right tabular-nums">{Number(r.wht) ? amt(r.wht) : ""}</td></tr>
                ))}</tbody>
              </table></div>
            ) : <Nil />}
          </Section>

          <div className="grid lg:grid-cols-2 gap-4">
            <Section title="Invoices raised" total={amt(sum(d.invoices_raised))}>
              {d.invoices_raised.length ? <ul className="space-y-0.5">{d.invoices_raised.map((r: any, i: number) => (
                <li key={i} className="flex gap-2"><span className="flex-1">{r.client} <span className="text-muted-foreground">· {monthOf(r.for_month)} · {r.auto ? "Auto" : "Manual"}{r.delivered ? " · delivered" : ""}</span></span><span className="tabular-nums">{amt(r.amount)}</span></li>
              ))}</ul> : <Nil />}
            </Section>
            <Section title="Not yet delivered" total={d.undelivered.length ? amt(sum(d.undelivered)) : undefined}>
              {d.undelivered.length ? <ul className="space-y-0.5">{d.undelivered.map((r: any, i: number) => (
                <li key={i} className="flex gap-2"><span className="flex-1">{r.client} <span className="text-muted-foreground">· {r.number} · {monthOf(r.for_month)}</span></span><span className="tabular-nums">{amt(r.amount)}</span></li>
              ))}</ul> : <Nil text="Every recent invoice is marked delivered." />}
            </Section>
          </div>

          <Section title="Expenses entered" total={amt(sum(d.expenses))}>
            {d.expenses.length ? <ul className="space-y-0.5">{d.expenses.map((e: any, i: number) => (
              <li key={i} className="flex gap-2"><span className="w-14 shrink-0 text-muted-foreground">{short(e.date)}</span><span className="flex-1">{e.category}{e.description ? <span className="text-muted-foreground"> · {e.description}</span> : null}</span><span className="tabular-nums">{amt(e.amount)}</span></li>
            ))}</ul> : <Nil />}
          </Section>

          <div className="grid lg:grid-cols-2 gap-4">
            <Section title="Salaries">
              {d.salaries_paid.length ? <ul className="space-y-0.5 mb-2">{d.salaries_paid.map((s: any) => (
                <li key={s.month} className="flex gap-2"><span className="flex-1">Disbursed for {monthOf(s.month)} · {s.people} people</span><span className="tabular-nums">{amt(s.paid)}</span></li>
              ))}</ul> : <p className="text-muted-foreground italic mb-2">No salaries disbursed in this period.</p>}
              {ps?.month && <p>{monthOf(ps.month)} payroll: {ps.people} people, net {amt(ps.net)} · paid {amt(ps.paid)} · <span className={Number(ps.remaining) > 0.5 ? "text-down font-semibold" : ""}>still to pay {amt(ps.remaining)}</span></p>}
            </Section>
            <Section title="Receivables">
              <p>Clients owe {amt(rc.owed)} ({rc.clients_owing ?? 0} clients) · {amt(rc.overdue)} over 30 days · {amt(rc.over_90)} over 90.</p>
              {Number(rc.wht_awaiting) > 0.5 && <p className="text-muted-foreground">Tax {amt(rc.wht_awaiting)} waiting for certificates.</p>}
              {d.late_clients.length > 0 && <ul className="mt-2 space-y-0.5">{d.late_clients.map((r: any, i: number) => (
                <li key={i} className="flex gap-2"><span className="flex-1">{r.client} <span className="text-muted-foreground">{r.last_paid_on ? `· paid ${short(r.last_paid_on)}` : ""}{r.promised_by ? ` · promised by ${short(r.promised_by)}` : ""}</span></span><span className="tabular-nums">{amt(r.overdue)}</span></li>
              ))}</ul>}
            </Section>
          </div>

          {/* 0634: the same follow-up summary as the Payment Follow-up screen, for this report's period. */}
          <div className="space-y-2">
            <h3 className="font-semibold text-foreground">Follow-up</h3>
            <FollowUpSummary updates={followUp} invoices={followInv} regionId={regionId} canSeeAmounts />
          </div>
        </>
      )}
    </div>
  );
}
