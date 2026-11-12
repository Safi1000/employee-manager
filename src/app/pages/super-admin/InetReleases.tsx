import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, Send, XCircle } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { askReason } from "../../components/askReason";
import { useAuth, hasPermission } from "../../lib/auth";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { downloadInetFile } from "../../lib/inetFile";
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
};
type Item = {
  id: string; batch_id: string; kind: "payslip" | "vendor"; amount: number; payee_name: string;
  account_no: string | null; bank_name: string | null; bank_code: string | null; status: "initiated" | "released" | "rejected";
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
      const { data: its } = await supabase.from("inet_items").select("id, batch_id, kind, amount, payee_name, account_no, bank_name, bank_code, status")
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

  const card = (b: Batch) => {
    const its = itemsOf.get(b.id) ?? [];
    const live = its.filter((i) => i.status !== "rejected");
    const total = live.reduce((s, i) => s + i.amount, 0);
    const isOpen = open.has(b.id);
    const mine = b.initiated_by && b.initiated_by === profile?.id;
    return (
      <div key={b.id} className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <button type="button" className="flex items-center gap-2 text-left min-w-0 flex-1"
            onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(b.id)) n.delete(b.id); else n.add(b.id); return n; })}>
            {isOpen ? <ChevronDown className="w-4 h-4 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 flex-shrink-0" />}
            <div className="min-w-0">
              <div className="font-semibold text-foreground truncate">{b.label}</div>
              <div className="text-xs text-muted-foreground">
                {bankName(b.bank_account_id)} · {kindLabel(b.file_kind)} · {live.length} payment{live.length === 1 ? "" : "s"} · initiated by {who(b.initiated_by)} {when(b.initiated_at)}
                {b.status === "released" && <> · released by {who(b.released_by)} {when(b.released_at)}{b.rounding_difference ? ` · rounding ${b.rounding_difference}` : ""}</>}
                {b.status === "rejected" && <> · rejected {when(b.rejected_at)}{b.note ? ` — ${b.note}` : ""}</>}
              </div>
            </div>
          </button>
          <div className="font-ledger font-semibold text-foreground">PKR {pkr(b.status === "released" && b.inet_total != null ? b.inet_total : total)}</div>
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
          {b.status !== "initiated" && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${b.status === "released" ? "bg-success-100 text-success-700 dark:bg-success-500/15 dark:text-success-500" : "bg-muted text-muted-foreground"}`}>
              {b.status === "released" ? "Released" : "Rejected"}
            </span>
          )}
        </div>
        {isOpen && (
          <div className="border-t border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground bg-muted/40">
                <tr><th className="px-4 py-2">Payee</th><th className="px-4 py-2">Bank</th><th className="px-4 py-2">Account / IBAN</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Status</th></tr>
              </thead>
              <tbody>
                {its.map((i) => (
                  <tr key={i.id} className="border-t border-border">
                    <td className="px-4 py-1.5">{i.payee_name}</td>
                    <td className="px-4 py-1.5 text-muted-foreground">{i.bank_name ?? ""}{i.bank_code ? ` (${i.bank_code})` : ""}</td>
                    <td className="px-4 py-1.5 font-ledger text-xs">{i.account_no ?? ""}</td>
                    <td className="px-4 py-1.5 text-right font-ledger">{pkr(i.amount)}</td>
                    <td className="px-4 py-1.5 text-xs">{i.status === "initiated" ? "In transit" : i.status === "released" ? "Paid" : "Rejected"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {!embedded && <Header title="iNet releases" subtitle="Online bank payments: initiated, then released by someone else — nothing is paid until released" />}
      <div className={embedded ? "space-y-4" : "flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-4"}>
        {embedded && <p className="text-sm text-muted-foreground">Online bank payments: initiated, then released by someone else. Nothing is paid and no bank moves until a batch is released.</p>}
        {err && <div className="rounded-lg border border-danger-200 bg-danger-50 dark:bg-danger-500/10 p-3 text-sm text-danger-700 dark:text-danger-500">{err}</div>}
        {msg && <div className="rounded-lg border border-success-200 bg-success-50 dark:bg-success-500/10 p-3 text-sm text-success-700 dark:text-success-500">{msg}</div>}
        <h2 className="text-sm font-semibold text-foreground">Waiting for release ({pending.length})</h2>
        {loading ? <p className="text-sm text-muted-foreground">Loading…</p>
          : pending.length === 0 ? <p className="text-sm text-muted-foreground">Nothing in transit. Initiate payments from Payroll or Banks ▸ Payables.</p>
          : pending.map(card)}
        {done.length > 0 && (
          <>
            <h2 className="text-sm font-semibold text-foreground pt-4">Last 45 days</h2>
            {done.map(card)}
          </>
        )}
      </div>
      {releasing && (
        <ReleaseModal batch={releasing} bankName={bankName(releasing.bank_account_id)} items={(itemsOf.get(releasing.id) ?? []).filter((i) => i.status === "initiated")}
          onClose={() => setReleasing(null)}
          onDone={(m) => { setReleasing(null); setMsg(m); void load(); }} />
      )}
    </>
  );
}

function ReleaseModal({ batch, bankName, items, onClose, onDone }: {
  batch: Batch; bankName: string; items: Item[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [total, setTotal] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = items.filter((i) => !rejected.has(i.id));
  const sum = live.reduce((s, i) => s + i.amount, 0);
  const sent = Number(total.replace(/,/g, "")) || 0;
  const diff = Math.round((sent - sum) * 100) / 100;
  const allRejected = live.length === 0;

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
          <Button onClick={() => void submit()} disabled={busy || (!allRejected && (!sent || Math.abs(diff) > 100))}>
            {busy ? "Releasing…" : allRejected ? "Reject all" : "Release"}
          </Button>
        </ModalFooter>
      }>
      <div className="space-y-4">
        <Hint tone="info">
          Releasing pays the payments below from {bankName}, dated today, and moves the bank. Tick any row iNet rejected:
          it goes back to unpaid. A difference up to Rs 100 between iNet's total and the rows is written to Rounding Differences.
        </Hint>
        <div className="max-h-72 overflow-y-auto rounded-lg border border-border divide-y divide-border text-sm">
          {items.map((i) => (
            <label key={i.id} className={`flex items-center gap-3 px-3 py-1.5 cursor-pointer ${rejected.has(i.id) ? "opacity-60 line-through" : ""}`}>
              <input type="checkbox" checked={rejected.has(i.id)}
                onChange={() => setRejected((s) => { const n = new Set(s); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; })} />
              <span className="flex-1 truncate">{i.payee_name}<span className="text-xs text-muted-foreground"> · {i.bank_name}</span></span>
              <span className="font-ledger">{pkr(i.amount)}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Tick = rejected by iNet.</p>
        {!allRejected && (
          <FormField label="Total iNet sent" required hint="From iNet's confirmation for this group.">
            <input className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm font-ledger" inputMode="decimal"
              placeholder={pkr(sum)} value={total} onChange={(e) => setTotal(e.target.value)} />
          </FormField>
        )}
        <FormField label="Note">
          <input className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm" value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
