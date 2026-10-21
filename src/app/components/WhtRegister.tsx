import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BadgeCheck, CircleSlash } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import ThemedSelect from "./ThemedSelect";
import { supabase, friendlyDbError } from "../lib/supabase";

/**
 * WITHHOLDING TAX REGISTER (0536, 2026-10-21). A client saying "the rest is
 * WHT" is a CLAIM: it becomes a tax credit only when it is seen deposited on
 * the FBR portal (or a certificate arrives). Until then it is listed here, and
 * flagged once it is older than OVERDUE_DAYS. "Not deposited" takes the WHT
 * off the receipt, so the client owes it again; no money moves.
 *
 * Status is changed only through verify_wht / reject_wht — the table refuses a
 * hand-written status.
 */

/** Days after the receipt before an unverified claim is flagged. */
const OVERDUE_DAYS = 45;

type Row = {
  id: string;
  payment_date: string;
  amount: number;
  withholding_amount: number;
  wht_status: "claimed" | "verified" | "not_deposited";
  wht_certificate_no: string | null;
  wht_verified_on: string | null;
  wht_status_note: string | null;
  wht_rejected_amount: number | null;
  client: { name: string } | null;
  invoice: { invoice_number: string } | null;
};

const fmt = (n: number) => Math.round(n).toLocaleString();
const fmtDate = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";
const ageDays = (d: string) => Math.floor((Date.now() - new Date(`${d.slice(0, 10)}T00:00:00`).getTime()) / 86400000);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type Filter = "open" | "overdue" | "verified" | "not_deposited" | "all";

export default function WhtRegister({ companyId, canEdit, onChanged }: { companyId: string | null; canEdit: boolean; onChanged?: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [missing, setMissing] = useState(false);
  const [filter, setFilter] = useState<Filter>("open");
  const [month, setMonth] = useState("all");
  const [verifying, setVerifying] = useState<Row | null>(null);
  const [rejecting, setRejecting] = useState<Row | null>(null);
  const [cert, setCert] = useState("");
  const [onDate, setOnDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    const { data, error } = await supabase.from("invoice_payments")
      .select("id, payment_date, amount, withholding_amount, wht_status, wht_certificate_no, wht_verified_on, wht_status_note, wht_rejected_amount, client:client_id(name), invoice:invoice_id(invoice_number)")
      .eq("company_id", companyId).not("wht_status", "is", null)
      .order("payment_date", { ascending: false });
    // Before 0536 the columns do not exist: say nothing rather than error.
    if (error) { setMissing(true); return; }
    setMissing(false);
    setRows(((data ?? []) as unknown as Row[]).map((r) => ({
      ...r, amount: Number(r.amount), withholding_amount: Number(r.withholding_amount ?? 0),
      wht_rejected_amount: r.wht_rejected_amount == null ? null : Number(r.wht_rejected_amount),
    })));
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  const months = useMemo(() => [...new Set(rows.map((r) => r.payment_date.slice(0, 7)))].sort().reverse(), [rows]);
  const inMonth = (r: Row) => month === "all" || r.payment_date.slice(0, 7) === month;
  const claimed = rows.filter((r) => r.wht_status === "claimed" && inMonth(r));
  const overdue = claimed.filter((r) => ageDays(r.payment_date) > OVERDUE_DAYS);
  const verified = rows.filter((r) => r.wht_status === "verified" && inMonth(r));
  const rejected = rows.filter((r) => r.wht_status === "not_deposited" && inMonth(r));
  const sum = (xs: Row[], f: (r: Row) => number) => xs.reduce((s, r) => s + f(r), 0);

  const shown = filter === "open" ? claimed : filter === "overdue" ? overdue : filter === "verified" ? verified
    : filter === "not_deposited" ? rejected : rows.filter(inMonth);

  if (missing) {
    return <p className="text-sm text-muted-foreground py-8 text-center">The withholding tax register appears once its database update is applied.</p>;
  }

  const submitVerify = async () => {
    if (!verifying) return;
    if (!cert.trim()) return setErr("Enter the certificate or CPR number.");
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("verify_wht", { p_payment_id: verifying.id, p_certificate_no: cert.trim(), p_verified_on: onDate, p_note: note.trim() || null });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    setVerifying(null); await load(); onChanged?.();
  };
  const submitReject = async () => {
    if (!rejecting) return;
    if (!note.trim()) return setErr("Say how you found it was not deposited.");
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("reject_wht", { p_payment_id: rejecting.id, p_note: note.trim() });
    setBusy(false);
    if (error) return setErr(friendlyDbError(error));
    setRejecting(null); await load(); onChanged?.();
  };

  const tile = (key: Filter, label: string, value: number, sub: string, tone: string) => (
    <button type="button" onClick={() => setFilter(key)}
      className={`text-left rounded-[14px] border bg-card px-4 py-3 flex flex-col gap-1 min-w-0 transition-colors ${filter === key ? "border-brand-500" : "border-border hover:border-brand-500/60"}`}>
      <span className="lbl">{label}</span>
      <span className={`font-ledger text-2xl font-semibold tracking-tight leading-none whitespace-nowrap ${tone}`}><span className="cur">PKR</span>{fmt(value)}</span>
      <span className="text-xs text-muted-foreground truncate">{sub}</span>
    </button>
  );

  const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  const label = "block text-[11px] text-muted-foreground mb-1";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        {tile("open", "Claimed, not verified", sum(claimed, (r) => r.withholding_amount), `${claimed.length} receipt${claimed.length === 1 ? "" : "s"} — check the portal`, "text-heed")}
        {tile("overdue", `Over ${OVERDUE_DAYS} days`, sum(overdue, (r) => r.withholding_amount), overdue.length ? `${overdue.length} still not seen deposited` : "none overdue", overdue.length ? "text-down" : "text-foreground")}
        {tile("verified", "Verified tax credit", sum(verified, (r) => r.withholding_amount), `${verified.length} with certificate`, "text-up")}
        {tile("not_deposited", "Not deposited", sum(rejected, (r) => r.wht_rejected_amount ?? 0), "owed again by the client", "text-foreground")}
      </div>

      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">Withholding tax register</div>
            <div className="text-xs text-muted-foreground">
              WHT a client says it deducted is a claim until you see it deposited. Verify it with the certificate or CPR number; if it never arrives, mark it not deposited and the client owes it again.
            </div>
          </div>
          <div className="ml-auto w-40">
            <ThemedSelect value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="all">All months</option>
              {months.map((m) => <option key={m} value={m}>{new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" })}</option>)}
            </ThemedSelect>
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground text-center">
            {filter === "open" ? "No WHT waiting to be verified." : filter === "overdue" ? `Nothing claimed more than ${OVERDUE_DAYS} days ago is still unverified.` : "Nothing here."}
          </p>
        ) : (
          <div className="overflow-auto max-h-[32rem]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Receipt</th>
                  <th className="px-4 py-2 font-medium">Client</th>
                  <th className="px-4 py-2 font-medium">Invoice</th>
                  <th className="px-4 py-2 font-medium text-right">Cash</th>
                  <th className="px-4 py-2 font-medium text-right">WHT</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.map((r) => {
                  const age = ageDays(r.payment_date);
                  const late = r.wht_status === "claimed" && age > OVERDUE_DAYS;
                  return (
                    <tr key={r.id}>
                      <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">{fmtDate(r.payment_date)}</td>
                      <td className="px-4 py-2 text-foreground">{r.client?.name ?? "—"}</td>
                      <td className="px-4 py-2 text-muted-foreground font-ledger">{r.invoice?.invoice_number ?? "on account"}</td>
                      <td className="px-4 py-2 text-right font-ledger">{fmt(r.amount)}</td>
                      <td className="px-4 py-2 text-right font-ledger font-semibold">
                        {r.wht_status === "not_deposited" ? <span className="line-through text-muted-foreground">{fmt(r.wht_rejected_amount ?? 0)}</span> : fmt(r.withholding_amount)}
                      </td>
                      <td className="px-4 py-2">
                        {r.wht_status === "verified" ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-success-700 dark:text-success-500" title={r.wht_status_note ?? ""}>
                            <BadgeCheck className="w-3.5 h-3.5" strokeWidth={2} /> {r.wht_certificate_no} · {fmtDate(r.wht_verified_on)}
                          </span>
                        ) : r.wht_status === "not_deposited" ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground" title={r.wht_status_note ?? ""}>
                            <CircleSlash className="w-3.5 h-3.5" strokeWidth={2} /> Not deposited — owed again
                          </span>
                        ) : (
                          <span className={`inline-flex items-center gap-1 text-xs font-semibold ${late ? "text-danger-700 dark:text-danger-500" : "text-warning-700 dark:text-warning-500"}`} title={r.wht_status_note ?? ""}>
                            {late && <AlertTriangle className="w-3.5 h-3.5" strokeWidth={2} />} Claimed · {age} day{age === 1 ? "" : "s"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {canEdit && r.wht_status === "claimed" && (
                          <span className="inline-flex gap-1.5">
                            <Button size="sm" variant="secondary" onClick={() => { setErr(null); setCert(""); setOnDate(todayISO()); setNote(""); setVerifying(r); }}>Verify</Button>
                            <Button size="sm" variant="ghost" onClick={() => { setErr(null); setNote(""); setRejecting(r); }}>Not deposited</Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal isOpen={!!verifying} onClose={() => setVerifying(null)} title="Verify withholding tax" error={err} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setVerifying(null)}>Cancel</Button>
          <Button onClick={submitVerify} disabled={busy}>{busy ? "Saving…" : "Mark verified"}</Button>
        </>}>
        {verifying && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              {verifying.client?.name}: PKR {fmt(verifying.withholding_amount)} withheld on the receipt of {fmtDate(verifying.payment_date)}.
              Confirm you have seen it deposited on the FBR portal or on a certificate.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Certificate / CPR no. *</label>
                <input className={field} value={cert} onChange={(e) => setCert(e.target.value)} />
              </div>
              <div>
                <label className={label}>Verified on *</label>
                <input type="date" className={field} value={onDate} onChange={(e) => setOnDate(e.target.value)} />
              </div>
            </div>
            <div>
              <label className={label}>Notes</label>
              <input className={field} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={!!rejecting} onClose={() => setRejecting(null)} title="WHT not deposited" error={err} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
          <Button variant="danger" onClick={submitReject} disabled={busy}>{busy ? "Saving…" : "Mark not deposited"}</Button>
        </>}>
        {rejecting && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              {rejecting.client?.name} claimed PKR {fmt(rejecting.withholding_amount)} as WHT on {fmtDate(rejecting.payment_date)}.
              Marking it not deposited takes it off the receipt: {rejecting.invoice ? `invoice ${rejecting.invoice.invoice_number}` : "the client's balance"} is owed that amount again. No money moves.
            </p>
            <div>
              <label className={label}>How did you find out? *</label>
              <input className={field} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. not on the FBR portal as of 20 Nov" />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
