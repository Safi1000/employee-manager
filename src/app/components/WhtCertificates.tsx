import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, Download, Loader2, Paperclip } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import Tabs from "./Tabs";
import WhtRegister from "./WhtRegister";
import { supabase, friendlyDbError } from "../lib/supabase";
import { useAuth, hasPermission } from "../lib/auth";
import { useRegion } from "../lib/region";
import { usePageState } from "../lib/pageState";
import { exportTable } from "../lib/excel";

/**
 * WITHHOLDING TAX (0626, DECIDED 2 Nov 2026).
 *
 * The tax is entered on the payment, as "tax the client deducted". It clears the
 * receivable at once (A1) and waits here until the client's certificate arrives.
 * A certificate is recorded ONCE: tick the payments it covers, enter its number,
 * date and amount, attach the scan. record_wht_certificate() refuses it unless
 * the amount equals the tax on the ticked payments.
 *
 * "Monthly totals" is the figure for filing. "Register" is the per-receipt view
 * (0536) with "Not deposited" for tax a client claimed and never paid in.
 */

const ATTACH_BUCKET = "cheque-attachments";

type Pending = {
  id: string;
  payment_date: string;
  amount: number;
  withholding_amount: number;
  client_id: string;
  client_name: string;
  branch_id: string | null;
  invoice_number: string | null;
};

type Cert = {
  id: string;
  certificate_no: string;
  certificate_date: string;
  amount: number;
  attachment_path: string | null;
  notes: string | null;
  client: { name: string; branch_id: string | null } | null;
  payments: { id: string }[];
};

type Month = { month: string; client_id: string; client_name: string; deducted: number; certified: number; awaiting: number };

const n = (v: unknown) => Number(v ?? 0);
const fmt = (v: number) => Math.round(v).toLocaleString();
const fmtDate = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
const fmtMonth = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
const ageDays = (d: string) => Math.floor((Date.now() - new Date(`${d.slice(0, 10)}T00:00:00`).getTime()) / 86400000);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type View = "awaiting" | "certificates" | "monthly" | "register";

export default function WhtCertificates({ companyId, onChanged }: { companyId: string | null; onChanged?: () => void }) {
  const { profile } = useAuth();
  const canEdit = hasPermission(profile, "invoices.edit");
  const { regionId } = useRegion();
  const [view, setView] = usePageState<View>("WhtCertificates.view", "awaiting");
  const [pending, setPending] = useState<Pending[]>([]);
  const [certs, setCerts] = useState<Cert[]>([]);
  const [months, setMonths] = useState<Month[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [recording, setRecording] = useState<{ clientId: string; clientName: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [p, c, m] = await Promise.all([
      supabase.from("invoice_payments")
        .select("id, payment_date, amount, withholding_amount, client_id, invoice:invoices(invoice_number, client_id), client:clients(id, name, branch_id)")
        .eq("wht_status", "claimed").gt("withholding_amount", 0).order("payment_date"),
      supabase.from("wht_certificates")
        .select("id, certificate_no, certificate_date, amount, attachment_path, notes, client:clients(name, branch_id), payments:invoice_payments(id)")
        .order("certificate_date", { ascending: false }),
      supabase.from("wht_deducted_by_month").select("month, client_id, client_name, deducted, certified, awaiting").order("month", { ascending: false }),
    ]);
    const firstErr = p.error ?? c.error ?? m.error;
    setErr(firstErr ? friendlyDbError(firstErr) : null);
    // A receipt on account carries client_id; one against an invoice may carry
    // only the invoice, so the client is taken from either.
    const rows = ((p.data ?? []) as any[]).map((r) => {
      const cid = r.client?.id ?? r.client_id ?? r.invoice?.client_id ?? "";
      return { id: r.id, payment_date: r.payment_date, amount: n(r.amount), withholding_amount: n(r.withholding_amount),
        client_id: cid, client_name: r.client?.name ?? "", branch_id: r.client?.branch_id ?? null, invoice_number: r.invoice?.invoice_number ?? null } as Pending;
    });
    // Fill names for receipts that reached their client only through the invoice.
    const missing = rows.filter((r) => !r.client_name).map((r) => r.client_id);
    if (missing.length) {
      const { data } = await supabase.from("clients").select("id, name, branch_id").in("id", Array.from(new Set(missing)));
      const byId = new Map(((data ?? []) as any[]).map((x) => [x.id, x]));
      for (const r of rows) if (!r.client_name) { const x = byId.get(r.client_id); r.client_name = x?.name ?? "—"; r.branch_id = x?.branch_id ?? null; }
    }
    setPending(rows);
    setCerts(((c.data ?? []) as any[]).map((x) => ({ ...x, amount: n(x.amount) })));
    setMonths(((m.data ?? []) as any[]).map((x) => ({ ...x, deducted: n(x.deducted), certified: n(x.certified), awaiting: n(x.awaiting) })));
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const scopedPending = useMemo(() => pending.filter((p) => !regionId || p.branch_id === regionId), [pending, regionId]);
  const byClient = useMemo(() => {
    const m = new Map<string, { clientId: string; clientName: string; rows: Pending[] }>();
    for (const p of scopedPending) {
      const g = m.get(p.client_id) ?? { clientId: p.client_id, clientName: p.client_name, rows: [] };
      g.rows.push(p);
      m.set(p.client_id, g);
    }
    return Array.from(m.values()).sort((a, b) => a.clientName.localeCompare(b.clientName));
  }, [scopedPending]);
  const scopedCerts = useMemo(() => certs.filter((c) => !regionId || c.client?.branch_id === regionId), [certs, regionId]);

  const monthGroups = useMemo(() => {
    const m = new Map<string, Month[]>();
    for (const r of months) m.set(r.month, [...(m.get(r.month) ?? []), r]);
    return Array.from(m.entries());
  }, [months]);

  const toggle = (id: string) => setTicked((s) => { const t = new Set(s); if (t.has(id)) t.delete(id); else t.add(id); return t; });
  const openScan = async (path: string) => {
    const { data, error } = await supabase.storage.from(ATTACH_BUCKET).createSignedUrl(path, 300);
    if (error || !data) return setErr(error ? friendlyDbError(error) : "Could not open the scan.");
    window.open(data.signedUrl, "_blank", "noopener");
  };

  return (
    <div className="space-y-4">
      <Tabs<View> value={view} onChange={setView} items={[
        { value: "awaiting", label: "Awaiting certificate", count: scopedPending.length },
        { value: "certificates", label: "Certificates received" },
        { value: "monthly", label: "Monthly totals" },
        { value: "register", label: "All receipts" },
      ]} />
      {err && <div className="rounded-lg border border-danger-200 bg-danger-50 dark:bg-danger-500/10 p-3 text-sm text-danger-700 dark:text-danger-500">{err}</div>}

      {view === "register" && <WhtRegister companyId={companyId} canEdit={canEdit} onChanged={() => { void load(); onChanged?.(); }} />}

      {view === "awaiting" && (
        <>
          <p className="text-xs text-muted-foreground">
            Tax clients deducted from their payments, waiting for the certificate. When one arrives, tick the payments it covers and record it once.
          </p>
          {loading ? <div className="py-10 text-center text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>
            : byClient.length === 0 ? <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">No tax is waiting for a certificate.</div>
            : byClient.map((g) => {
              const sel = g.rows.filter((r) => ticked.has(r.id));
              const total = g.rows.reduce((s, r) => s + r.withholding_amount, 0);
              return (
                <div key={g.clientId} className="rounded-xl border border-border bg-card">
                  <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border">
                    <div className="font-semibold text-foreground">{g.clientName}</div>
                    <div className="text-xs text-muted-foreground">{g.rows.length} payment{g.rows.length === 1 ? "" : "s"} · tax {fmt(total)}</div>
                    <div className="flex-1" />
                    {canEdit && (
                      <Button size="sm" disabled={sel.length === 0} onClick={() => setRecording({ clientId: g.clientId, clientName: g.clientName })}>
                        <BadgeCheck className="w-4 h-4 mr-1" /> Record certificate{sel.length ? ` (${sel.length})` : ""}
                      </Button>
                    )}
                  </div>
                  <table className="w-full text-sm">
                    <thead><tr className="text-xs text-muted-foreground text-left">
                      <th className="px-4 py-2 w-8"></th><th className="px-2 py-2">Payment date</th><th className="px-2 py-2">Invoice</th>
                      <th className="px-2 py-2 text-right">Received</th><th className="px-2 py-2 text-right">Tax deducted</th><th className="px-4 py-2 text-right">Waiting</th>
                    </tr></thead>
                    <tbody>
                      {g.rows.map((r) => {
                        const age = ageDays(r.payment_date);
                        return (
                          <tr key={r.id} className="border-t border-border">
                            <td className="px-4 py-2">{canEdit && <input type="checkbox" checked={ticked.has(r.id)} onChange={() => toggle(r.id)} />}</td>
                            <td className="px-2 py-2">{fmtDate(r.payment_date)}</td>
                            <td className="px-2 py-2 font-ledger text-xs">{r.invoice_number ?? "On account"}</td>
                            <td className="px-2 py-2 text-right font-ledger">{fmt(r.amount)}</td>
                            <td className="px-2 py-2 text-right font-ledger font-semibold">{fmt(r.withholding_amount)}</td>
                            <td className={`px-4 py-2 text-right text-xs ${age > 45 ? "text-danger-700 dark:text-danger-500 font-semibold" : "text-muted-foreground"}`}>{age} days</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
        </>
      )}

      {view === "certificates" && (
        <div className="rounded-xl border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60"><tr className="text-xs text-muted-foreground text-left">
              <th className="px-3 py-2">Client</th><th className="px-3 py-2">Certificate / CPR</th><th className="px-3 py-2">Date</th>
              <th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-right">Payments</th><th className="px-3 py-2">Scan</th>
            </tr></thead>
            <tbody>
              {scopedCerts.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No certificates recorded yet.</td></tr>
              ) : scopedCerts.map((c) => (
                <tr key={c.id} className="border-t border-border">
                  <td className="px-3 py-2">{c.client?.name ?? "—"}</td>
                  <td className="px-3 py-2 font-ledger">{c.certificate_no}</td>
                  <td className="px-3 py-2">{fmtDate(c.certificate_date)}</td>
                  <td className="px-3 py-2 text-right font-ledger">{fmt(c.amount)}</td>
                  <td className="px-3 py-2 text-right">{c.payments?.length ?? 0}</td>
                  <td className="px-3 py-2">{c.attachment_path
                    ? <button className="text-brand-600 hover:underline inline-flex items-center gap-1 text-xs" onClick={() => void openScan(c.attachment_path!)}><Paperclip className="w-3 h-3" /> Open</button>
                    : <span className="text-xs text-muted-foreground">None</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === "monthly" && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={() => void exportTable({
              fileName: `Tax deducted by clients ${todayISO()}.xlsx`,
              title: "Withholding tax deducted by clients, by payment month",
              headers: ["Month", "Client", "Tax deducted", "Backed by certificate", "Awaiting certificate"],
              rows: months.map((r) => [fmtMonth(r.month), r.client_name, Math.round(r.deducted), Math.round(r.certified), Math.round(r.awaiting)]),
            })}><Download className="w-4 h-4 mr-1" /> Excel</Button>
          </div>
          {monthGroups.length === 0 ? <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">No tax has been deducted yet.</div>
            : monthGroups.map(([month, rs]) => {
              // Each month's total is the sum of the client rows shown under it.
              const t = rs.reduce((a, r) => ({ d: a.d + r.deducted, c: a.c + r.certified, w: a.w + r.awaiting }), { d: 0, c: 0, w: 0 });
              return (
                <div key={month} className="rounded-xl border border-border bg-card">
                  <div className="flex items-center px-4 py-2 border-b border-border">
                    <div className="font-semibold">{fmtMonth(month)}</div>
                    <div className="flex-1" />
                    <div className="text-sm font-ledger">{fmt(t.d)} deducted · {fmt(t.c)} certified{t.w > 0.5 ? <span className="text-warning-700 dark:text-warning-500"> · {fmt(t.w)} awaiting</span> : null}</div>
                  </div>
                  <table className="w-full text-sm"><tbody>
                    {rs.map((r) => (
                      <tr key={r.client_id} className="border-t border-border first:border-t-0">
                        <td className="px-4 py-1.5">{r.client_name}</td>
                        <td className="px-4 py-1.5 text-right font-ledger">{fmt(r.deducted)}</td>
                        <td className="px-4 py-1.5 text-right text-xs text-muted-foreground w-48">{r.awaiting > 0.5 ? `${fmt(r.awaiting)} awaiting` : "certified"}</td>
                      </tr>
                    ))}
                  </tbody></table>
                </div>
              );
            })}
        </div>
      )}

      {recording && (
        <CertificateModal
          companyId={companyId}
          clientId={recording.clientId}
          clientName={recording.clientName}
          rows={pending.filter((p) => p.client_id === recording.clientId && ticked.has(p.id))}
          onClose={() => setRecording(null)}
          onSaved={() => { setRecording(null); setTicked(new Set()); void load(); onChanged?.(); }}
        />
      )}
    </div>
  );
}

function CertificateModal({ companyId, clientId, clientName, rows, onClose, onSaved }: {
  companyId: string | null; clientId: string; clientName: string; rows: Pending[]; onClose: () => void; onSaved: () => void;
}) {
  const ticked = rows.reduce((s, r) => s + r.withholding_amount, 0);
  const [no, setNo] = useState("");
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState(String(Math.round(ticked * 100) / 100));
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setErr(null);
    if (!no.trim()) return setErr("Enter the certificate or CPR number.");
    if (!date) return setErr("Enter the certificate date.");
    setBusy(true);
    try {
      let path: string | null = null;
      if (file) {
        if (!companyId) throw new Error("No company is selected — reload the page and try again.");
        path = `${companyId}/wht/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
        const { error: upErr } = await supabase.storage.from(ATTACH_BUCKET).upload(path, file);
        if (upErr) throw upErr;
      }
      const { error } = await supabase.rpc("record_wht_certificate", {
        p_client_id: clientId, p_certificate_no: no.trim(), p_certificate_date: date, p_amount: Number(amount || 0),
        p_payment_ids: rows.map((r) => r.id), p_attachment_path: path, p_notes: notes.trim() || null,
      });
      if (error) {
        if (path) await supabase.storage.from(ATTACH_BUCKET).remove([path]);
        throw error;
      }
      onSaved();
    } catch (e) {
      setErr(friendlyDbError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Record certificate — ${clientName}`} error={err} onDismissError={() => setErr(null)}
      footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save certificate"}</Button></div>}>
      <div className="space-y-4 text-sm">
        <div className="rounded-lg bg-muted/60 p-3">
          Covers {rows.length} payment{rows.length === 1 ? "" : "s"} with tax of <b>{ticked.toLocaleString()}</b>:{" "}
          {rows.map((r) => `${fmtDate(r.payment_date)} (${fmt(r.withholding_amount)})`).join(", ")}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="lbl">Certificate / CPR number</span>
            <input className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={no} onChange={(e) => setNo(e.target.value)} /></label>
          <label className="block"><span className="lbl">Certificate date</span>
            <input type="date" max={todayISO()} className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="block"><span className="lbl">Amount on the certificate</span>
            <input type="number" inputMode="decimal" className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={amount} onChange={(e) => setAmount(e.target.value)} />
            {Math.abs(Number(amount || 0) - ticked) > 0.5 && (
              <span className="text-[11px] text-danger-700 dark:text-danger-500">Doesn't match the ticked payments ({ticked.toLocaleString()}). Tick the payments it covers.</span>
            )}
          </label>
          <label className="block"><span className="lbl">Scan (optional)</span>
            <input type="file" accept="image/*,application/pdf" className="mt-1 w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        </div>
        <label className="block"><span className="lbl">Note (optional)</span>
          <input className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-card" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
    </Modal>
  );
}
