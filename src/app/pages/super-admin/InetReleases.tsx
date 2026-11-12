import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, Send, Upload, XCircle } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { askReason } from "../../components/askReason";
import { useAuth, hasPermission } from "../../lib/auth";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { downloadInetFile, inetFileName, inetFileRows } from "../../lib/inetFile";
import { matchApproval, readApprovalSheet, type ApprovalMatch } from "../../lib/inetApproval";
import { FormField, Hint, ModalFooter } from "./_assetsKit";

/**
 * Bank & Ledgers ▸ iNet releases (0662). Asked by Shayan, 11 Nov 2026; moved
 * from its own Finance page into Bank & Ledgers as a tab, 12 Nov 2026 (Shayan),
 * beside the bank balances a release moves. `embedded` drops the page header.
 *
 * Online bank payments go out in two steps by two people. Whoever initiates
 * (Payroll, Banks ▸ Payables) puts the payments in transit and downloads the
 * upload file here; someone else releases each batch with the total iNet
 * actually sent, ticking any rows iNet rejected. Only then is anything paid and
 * does the bank move — on the release date. A difference of Rs 100 or less is
 * rounding (6950); more is refused until the rejected rows are ticked.
 */

type Batch = {
  id: string; bank_account_id: string; label: string; reference: string | null;
  file_kind: "FT" | "IBFT" | "single" | "manual"; transaction_date: string; status: "initiated" | "released" | "rejected";
  initiated_by: string | null; initiated_at: string; released_by: string | null; released_at: string | null;
  inet_total: number | null; rounding_difference: number | null; rejected_at: string | null; note: string | null;
  /** 0667: the file joins the items paid to one receiver account into one row. */
  combined?: boolean;
};
type Item = {
  id: string; batch_id: string; kind: "payslip" | "vendor"; amount: number; payee_name: string;
  account_no: string | null; bank_name: string | null; bank_code: string | null; status: "initiated" | "released" | "rejected";
  /** 0663: wallet / iban / account; and the guard, when the salary was paid to someone else (payee_name is then the receiver). */
  account_kind?: string | null; on_behalf_of?: string | null;
};

const pkr = (n: number) => Math.round(n).toLocaleString();
const when = (s: string | null) => (s ? new Date(s).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const kindLabel = (k: Batch["file_kind"]) => (k === "FT" ? "Same-bank file" : k === "IBFT" ? "Other banks file" : k === "single" ? "Single instruction (keyed by hand)" : "Keyed by hand");

export default function InetReleases({ embedded = false }: { embedded?: boolean } = {}) {
  const { profile } = useAuth();
  const canRelease = hasPermission(profile, "bank.inet_release");
  const canInitiate = hasPermission(profile, "bank.inet_initiate");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [banks, setBanks] = useState<Map<string, string>>(new Map());
  const [formats, setFormats] = useState<Map<string, string | null>>(new Map());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [releasing, setReleasing] = useState<Batch | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const since = new Date(Date.now() - 45 * 86400000).toISOString();
    const [bRes, bk] = await Promise.all([
      supabase.from("inet_batches").select("*").or(`status.eq.initiated,initiated_at.gte.${since}`).order("initiated_at", { ascending: false }),
      supabase.rpc("inet_banks"),
    ]);
    if (bRes.error) { setErr(friendlyDbError(bRes.error)); setLoading(false); return; }
    const bs = ((bRes.data ?? []) as Batch[]).map((b) => ({ ...b, inet_total: b.inet_total == null ? null : Number(b.inet_total), rounding_difference: b.rounding_difference == null ? null : Number(b.rounding_difference) }));
    setBatches(bs);
    setBanks(new Map(((bk.data ?? []) as { id: string; bank_name: string }[]).map((b) => [b.id, b.bank_name])));
    setFormats(new Map(((bk.data ?? []) as { id: string; inet_format: string | null }[]).map((b) => [b.id, b.inet_format])));
    if (bs.length) {
      const { data: its } = await supabase.from("inet_items").select("id, batch_id, kind, amount, payee_name, account_no, bank_name, bank_code, status, account_kind, on_behalf_of")
        .in("batch_id", bs.map((b) => b.id)).order("payee_name");
      setItems(((its ?? []) as Item[]).map((i) => ({ ...i, amount: Number(i.amount) })));
      const ids = [...new Set(bs.flatMap((b) => [b.initiated_by, b.released_by]).filter(Boolean) as string[])];
      if (ids.length) {
        const { data: ps } = await supabase.from("profiles").select("id, full_name").in("id", ids);
        setNames(new Map(((ps ?? []) as { id: string; full_name: string }[]).map((p) => [p.id, p.full_name])));
      }
    } else setItems([]);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const itemsOf = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of items) { const l = m.get(i.batch_id) ?? []; l.push(i); m.set(i.batch_id, l); }
    return m;
  }, [items]);
  const pending = batches.filter((b) => b.status === "initiated");
  const done = batches.filter((b) => b.status !== "initiated");
  const bankName = (id: string) => banks.get(id) ?? "Bank";
  const who = (id: string | null) => (id ? names.get(id) ?? "someone" : "Bastion");

  const download = async (b: Batch) => {
    setErr(null);
    try {
      const fmt = formats.get(b.bank_account_id);
      if (fmt !== "askari" && fmt !== "soneri") throw new Error(`${bankName(b.bank_account_id)} has no upload file format set up — key this batch in by hand.`);
      await downloadInetFile(bankName(b.bank_account_id), fmt, b, (itemsOf.get(b.id) ?? []).filter((i) => i.status !== "rejected"));
    } catch (e: any) { setErr(e.message ?? String(e)); }
  };
  const rejectAll = async (b: Batch) => {
    const note = await askReason({
      title: "Reject batch",
      subject: { title: b.label, meta: `${bankName(b.bank_account_id)} · ${(itemsOf.get(b.id) ?? []).length} payments` },
      message: "Every payment in it goes back to unpaid. Nothing was paid, so nothing is reversed.",
      label: "Why?",
      placeholder: "e.g. Rejected by the CEO — amounts to be corrected",
      confirmLabel: "Reject batch",
      tone: "danger",
    });
    if (!note) return;
    const { error } = await supabase.rpc("reject_inet_batch", { p_batch_id: b.id, p_note: note });
    if (error) { setErr(friendlyDbError(error)); return; }
    setMsg(`"${b.label}" rejected — its payments are unpaid again.`);
    void load();
  };

  const statusChip = (b: Batch) => (
    <span className={`text-xs font-medium px-2 py-0.5 rounded whitespace-nowrap ${
      b.status === "initiated" ? "bg-info-100 text-info-700 dark:bg-info-500/15 dark:text-info-500"
        : b.status === "released" ? "bg-success-100 text-success-700 dark:bg-success-500/15 dark:text-success-500"
        : "bg-muted text-muted-foreground"}`}>
      {b.status === "initiated" ? "In transit" : b.status === "released" ? "Released" : "Rejected"}
    </span>
  );
  const payee = (i: Item) => (
    <>
      <div className="text-foreground">{i.payee_name}</div>
      {i.on_behalf_of && (
        <div className="text-xs text-warning-700 dark:text-warning-500 inline-flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> Salary of {i.on_behalf_of} — paid to someone else
        </div>
      )}
    </>
  );

  const card = (b: Batch) => {
    const its = itemsOf.get(b.id) ?? [];
    const live = its.filter((i) => i.status !== "rejected");
    const total = live.reduce((s, i) => s + i.amount, 0);
    const paidTo = live.filter((i) => i.on_behalf_of).length;
    const isOpen = open.has(b.id);
    const mine = b.initiated_by && b.initiated_by === profile?.id;
    return (
      <div key={b.id} className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3 p-4">
          <button type="button" className="flex items-start gap-2 text-left min-w-0 flex-1 basis-64"
            onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(b.id)) n.delete(b.id); else n.add(b.id); return n; })}>
            {isOpen ? <ChevronDown className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />}
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-foreground">{b.label}</span>
                {statusChip(b)}
                {b.combined && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded bg-muted text-muted-foreground whitespace-nowrap">receiver rows joined</span>
                )}
                {paidTo > 0 && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded bg-warning-100 text-warning-700 dark:bg-warning-500/15 dark:text-warning-500 whitespace-nowrap">
                    {paidTo} paid to someone else
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {bankName(b.bank_account_id)} · {kindLabel(b.file_kind)}{b.reference ? ` · ref ${b.reference}` : ""} · {live.length} payment{live.length === 1 ? "" : "s"}
              </div>
              <div className="text-xs text-muted-foreground">
                Initiated by {who(b.initiated_by)}, {when(b.initiated_at)}
                {b.status === "released" && <> · released by {who(b.released_by)}, {when(b.released_at)}{b.rounding_difference ? ` · rounding ${b.rounding_difference}` : ""}</>}
                {b.status === "rejected" && <> · rejected {when(b.rejected_at)}{b.note ? ` — ${b.note}` : ""}</>}
              </div>
            </div>
          </button>
          <div className="flex flex-wrap items-center gap-3 ml-auto">
            <div className="text-right">
              <div className="lbl">{b.status === "released" ? "Sent" : "Total"}</div>
              <div className="font-ledger text-lg font-semibold text-foreground whitespace-nowrap"><span className="cur">PKR</span>{pkr(b.status === "released" && b.inet_total != null ? b.inet_total : total)}</div>
            </div>
            {b.status === "initiated" && (
              <div className="flex flex-wrap gap-2">
                {(b.file_kind === "FT" || b.file_kind === "IBFT") && (
                  <Button size="sm" variant="secondary" onClick={() => void download(b)}><Download className="w-4 h-4 mr-1" /> iNet file</Button>
                )}
                {(canRelease || canInitiate) && (
                  <Button size="sm" variant="secondary" onClick={() => void rejectAll(b)}><XCircle className="w-4 h-4 mr-1" /> Reject</Button>
                )}
                {canRelease && (
                  <Button size="sm" disabled={!!mine} title={mine ? "You initiated this batch — someone else must release it." : undefined}
                    onClick={() => { setErr(null); setReleasing(b); }}>
                    <Send className="w-4 h-4 mr-1" /> Release
                  </Button>
                )}
              </div>
            )}
          </div>
          {b.status === "initiated" && mine && canRelease && (
            <p className="basis-full text-xs text-muted-foreground">You initiated this batch, so someone else must release it.</p>
          )}
        </div>
        {isOpen && (
          <div className="border-t border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground bg-muted/40">
                <tr>
                  <th className="px-4 py-2 font-medium">Payee</th>
                  <th className="px-4 py-2 font-medium">Bank / wallet</th>
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {its.map((i) => (
                  <tr key={i.id} className={`border-t border-border align-top ${i.status === "rejected" ? "opacity-60" : ""}`}>
                    <td className="px-4 py-2">{payee(i)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{i.bank_name ?? ""}{i.bank_code ? ` (${i.bank_code})` : ""}</td>
                    <td className="px-4 py-2 font-ledger text-xs whitespace-nowrap">{i.account_no ?? ""}{i.account_kind === "wallet" ? <span className="text-muted-foreground font-sans"> · wallet</span> : null}</td>
                    <td className="px-4 py-2 text-right font-ledger whitespace-nowrap">{pkr(i.amount)}</td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap">{i.status === "initiated" ? "In transit" : i.status === "released" ? "Paid" : "Rejected"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-muted/40">
                  <td className="px-4 py-2 text-xs text-muted-foreground" colSpan={3}>{live.length} payment{live.length === 1 ? "" : "s"}{its.length > live.length ? ` · ${its.length - live.length} rejected` : ""}</td>
                  <td className="px-4 py-2 text-right font-ledger font-semibold">{pkr(total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    );
  };

  // In transit, per bank — what is waiting to leave each bank.
  const transitByBank = useMemo(() => {
    const m = new Map<string, { n: number; amount: number }>();
    for (const b of pending) {
      const amt = (itemsOf.get(b.id) ?? []).filter((i) => i.status === "initiated").reduce((s, i) => s + i.amount, 0);
      const cur = m.get(b.bank_account_id) ?? { n: 0, amount: 0 };
      m.set(b.bank_account_id, { n: cur.n + 1, amount: cur.amount + amt });
    }
    return m;
  }, [pending, itemsOf]);

  return (
    <>
      {!embedded && <Header title="iNet releases" subtitle="Online bank payments: initiated, then released by someone else — nothing is paid until released" />}
      <div className={embedded ? "space-y-4" : "flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-4"}>
        <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="lbl">In transit</span>
          {transitByBank.size === 0
            ? <span className="text-sm text-muted-foreground">Nothing waiting for release</span>
            : [...transitByBank.entries()].map(([id, t]) => (
              <span key={id} className="flex items-baseline gap-2 text-sm">
                <span className="text-muted-foreground">{bankName(id)}</span>
                <span className="font-ledger font-semibold text-foreground">{pkr(t.amount)}</span>
                <span className="text-xs text-muted-foreground">({t.n} batch{t.n === 1 ? "" : "es"})</span>
              </span>
            ))}
          <span className="ml-auto text-xs text-muted-foreground">Not in any bank balance until released</span>
        </div>
        {err && <div className="rounded-lg border border-danger-200 bg-danger-50 dark:bg-danger-500/10 p-3 text-sm text-danger-700 dark:text-danger-500">{err}</div>}
        {msg && <div className="rounded-lg border border-success-200 bg-success-50 dark:bg-success-500/10 p-3 text-sm text-success-700 dark:text-success-500">{msg}</div>}
        {loading ? <p className="text-sm text-muted-foreground px-1">Loading…</p>
          : pending.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border px-4 py-10 text-center">
              <p className="text-sm font-medium text-foreground">Nothing waiting for release</p>
              <p className="text-xs text-muted-foreground mt-1">Initiate salaries from Payroll (Disburse on an Askari or Soneri bank), or a vendor payment from Accounts payable. Each batch then appears here with its upload file.</p>
            </div>
          ) : (
            <>
              <h2 className="text-sm font-semibold text-foreground px-1">Waiting for release ({pending.length})</h2>
              {pending.map(card)}
            </>
          )}
        {done.length > 0 && (
          <>
            <h2 className="text-sm font-semibold text-foreground pt-4 px-1">Last 45 days</h2>
            {done.map(card)}
          </>
        )}
      </div>
      {releasing && (
        <ReleaseModal batch={releasing} bankName={bankName(releasing.bank_account_id)} format={formats.get(releasing.bank_account_id) ?? null} items={(itemsOf.get(releasing.id) ?? []).filter((i) => i.status === "initiated")}
          onClose={() => setReleasing(null)}
          onDone={(m) => { setReleasing(null); setMsg(m); void load(); }} />
      )}
    </>
  );
}

function ReleaseModal({ batch, bankName, format, items, onClose, onDone }: {
  batch: Batch; bankName: string; format: string | null; items: Item[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  // 0667: in a combined batch, the items paid to one receiver account are one
  // row at the bank — they are matched, ticked and released together.
  const groupOf = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!batch.combined) return m;
    const byAcct = new Map<string, string[]>();
    for (const i of items) {
      if (!i.on_behalf_of || !i.account_no) continue;
      const k = i.account_no.toUpperCase().replace(/[^0-9A-Z]/g, "");
      byAcct.set(k, [...(byAcct.get(k) ?? []), i.id]);
    }
    for (const ids of byAcct.values()) if (ids.length > 1) for (const id of ids) m.set(id, ids);
    return m;
  }, [batch.combined, items]);
  const toggle = (id: string) => setRejected((s) => {
    const n = new Set(s); const ids = groupOf.get(id) ?? [id]; const on = !n.has(id);
    for (const x of ids) { if (on) n.add(x); else n.delete(x); }
    return n;
  });
  // Askari's approval export (12 Nov 2026): rejected payments are NOT in it, so a
  // payment missing from the file is proposed as rejected; the total is the
  // file's matched rows. The person releasing can still change any tick.
  const [match, setMatch] = useState<ApprovalMatch | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const expectedFile = inetFileName(bankName, batch);
  const readFile = async (f: File) => {
    setErr(null);
    try {
      const XLSX = await import("xlsx");
      const rows = readApprovalSheet(XLSX, await f.arrayBuffer());
      // A combined group is one row at the bank: match it as one, then expand.
      const seen = new Set<string>();
      const units = items.flatMap((i) => {
        const ids = groupOf.get(i.id);
        if (!ids) return [{ id: i.id, account_no: i.account_no, amount: i.amount, payee_name: i.payee_name }];
        if (seen.has(ids[0])) return [];
        seen.add(ids[0]);
        const members = items.filter((x) => ids.includes(x.id));
        return [{ id: ids[0], account_no: i.account_no, amount: members.reduce((t, x) => t + x.amount, 0), payee_name: `${i.payee_name} (${ids.length} guards)` }];
      });
      const m = matchApproval(units, rows);
      setMatch(m); setFileName(f.name);
      setRejected(new Set(m.missing.flatMap((x) => groupOf.get(x.id) ?? [x.id])));
      setCount(String(m.matched.size));
      setTotal(m.matchedTotal ? String(m.matchedTotal) : "");
    } catch (e: any) { setMatch(null); setFileName(null); setErr(e.message ?? String(e)); }
  };
  const wrongFile = !!match && match.fileNames.length > 0 && !match.fileNames.some((n) => n.toLowerCase().includes(expectedFile.toLowerCase()));
  const [total, setTotal] = useState("");
  // The number of transactions the bank shows (Soneri shows it on screen, no export).
  const [count, setCount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = items.filter((i) => !rejected.has(i.id));
  const sum = live.reduce((s, i) => s + i.amount, 0);
  const sent = Number(total.replace(/,/g, "")) || 0;
  const diff = Math.round((sent - sum) * 100) / 100;
  const allRejected = live.length === 0;
  const expectedRows = inetFileRows(batch, live.map((i) => ({ ...i, amount: i.amount }))).length;
  const countN = count.trim() ? Number(count.replace(/\D/g, "")) : null;
  const countOff = countN != null && countN !== expectedRows;
  const countRequired = format === "soneri";

  const submit = async () => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc("release_inet_batch", {
      p_batch_id: batch.id,
      p_inet_total: allRejected ? null : sent,
      p_rejected_item_ids: [...rejected],
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    const r = data as { released: number; rejected: number; rounding?: number };
    onDone(allRejected
      ? `"${batch.label}": every payment rejected — all unpaid again.`
      : `"${batch.label}" released: ${r.released} paid from ${bankName}${r.rejected ? `, ${r.rejected} back to unpaid` : ""}${r.rounding ? `, rounding ${r.rounding} to Rounding Differences` : ""}.`);
  };

  return (
    <Modal isOpen onClose={onClose} title={`Release — ${batch.label}`} size="md" error={err} onDismissError={() => setErr(null)}
      footer={
        <ModalFooter summary={allRejected ? "All rejected" : <>Items PKR {pkr(sum)}{sent ? <> · difference <span className={Math.abs(diff) > 100 ? "text-danger-700 dark:text-danger-500 font-semibold" : ""}>{diff}</span></> : null}</>}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || (!allRejected && (!sent || Math.abs(diff) > 100 || countOff || (countRequired && countN == null)))}>
            {busy ? "Releasing…" : allRejected ? "Reject all" : "Release"}
          </Button>
        </ModalFooter>
      }>
      <div className="space-y-4">
        <Hint tone="info">
          Releasing pays the payments below from {bankName}, dated today, and moves the bank. Ticked rows were rejected and go
          back to unpaid. A difference up to Rs 100 between what iNet sent and the rows goes to Rounding Differences.
        </Hint>
        {format === "askari" && (batch.file_kind === "FT" || batch.file_kind === "IBFT" || batch.file_kind === "single") && (
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-sm cursor-pointer hover:bg-muted">
                <Upload className="w-4 h-4" /> {fileName ? "Choose another file" : "Upload iNet approval export"}
                <input type="file" accept=".xlsx,.xls" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ""; }} />
              </label>
              <span className="text-xs text-muted-foreground min-w-0 truncate">{fileName ?? "Ins_Approval_….xlsx from iNet, after the CEO approves — Bastion ticks what is missing and fills the total."}</span>
            </div>
            {match && (
              <div className="space-y-1.5 text-xs">
                <p className="inline-flex items-center gap-1 text-success-700 dark:text-success-500">
                  <CheckCircle2 className="w-3.5 h-3.5" /> {match.matched.size} of {items.length} found in the file · PKR {pkr(match.matchedTotal)}
                </p>
                {match.missing.length > 0 && (
                  <p className="text-danger-700 dark:text-danger-500">
                    Not in the file, so ticked as rejected: {match.missing.map((x) => x.payee_name).join(", ")}
                  </p>
                )}
                {match.notApproved.length > 0 && (
                  <p className="text-warning-700 dark:text-warning-500">
                    {match.notApproved.length} row{match.notApproved.length === 1 ? " is" : "s are"} not approved yet in this file (status {match.notApproved[0].status}). Export again after the CEO approves.
                  </p>
                )}
                {match.extra.length > 0 && (
                  <p className="text-warning-700 dark:text-warning-500">
                    {match.extra.length} row{match.extra.length === 1 ? "" : "s"} in the file {match.extra.length === 1 ? "is" : "are"} not in this batch: {match.extra.slice(0, 5).map((r) => `${r.name || r.account} ${pkr(r.amount)}`).join(", ")}{match.extra.length > 5 ? "…" : ""}
                  </p>
                )}
                {wrongFile && (
                  <p className="text-danger-700 dark:text-danger-500">
                    This export is for "{match.fileNames.join(", ")}", not this batch's file "{expectedFile}". Check you chose the right group.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
        <div className="max-h-72 overflow-y-auto rounded-lg border border-border divide-y divide-border text-sm">
          {items.map((i) => (
            <label key={i.id} className={`flex items-center gap-3 px-3 py-1.5 cursor-pointer ${rejected.has(i.id) ? "opacity-60 line-through" : ""}`}>
              <input type="checkbox" checked={rejected.has(i.id)} onChange={() => toggle(i.id)} />
              <span className="flex-1 min-w-0">
                <span className="block truncate">{i.payee_name}<span className="text-xs text-muted-foreground"> · {i.bank_name}</span></span>
                {i.on_behalf_of && <span className="block text-xs text-warning-700 dark:text-warning-500">Salary of {i.on_behalf_of} — paid to someone else</span>}
              </span>
              <span className="font-ledger">{pkr(i.amount)}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Tick = rejected by iNet.{groupOf.size ? " Guards paid to one receiver in one transfer are ticked together." : ""}</p>
        {!allRejected && (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Total the bank sent" required hint={format === "soneri" ? "From Trans@ct's screen for this batch." : "From iNet's confirmation for this group."}>
              <input className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm font-ledger" inputMode="decimal"
                placeholder={pkr(sum)} value={total} onChange={(e) => setTotal(e.target.value)} />
            </FormField>
            <FormField label="Transactions the bank shows" required={countRequired}
              hint={`Bastion expects ${expectedRows} for the rows not ticked.`}>
              <input className={`w-full px-3 py-2 rounded-lg border bg-background text-sm font-ledger ${countOff ? "border-danger-500" : "border-border"}`} inputMode="numeric"
                placeholder={String(expectedRows)} value={count} onChange={(e) => setCount(e.target.value)} />
            </FormField>
          </div>
        )}
        {countOff && (
          <Hint tone="warning">
            The bank shows {countN} transaction{countN === 1 ? "" : "s"} but {expectedRows} {expectedRows === 1 ? "row is" : "rows are"} left in this batch. Tick the payments the bank did not send, or check the count.
          </Hint>
        )}
        <FormField label="Note">
          <input className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm" value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
