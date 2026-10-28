import { useCallback, useEffect, useState } from "react";
import Button from "./Button";
import Modal from "./Modal";
import ThemedSelect from "./ThemedSelect";
import { supabase, friendlyDbError } from "../lib/supabase";

/**
 * CLIENT CLEARANCES (0576/0580, Shayan 2026-10-28) — Lahore's own mechanism:
 * "client wise … as soon as we get the money from the client … and that exact
 * client becomes profitable till that date … we'll get our share".
 *
 * A client is CLEARED through a month once its money is in and it is
 * profitable to that date. Before clearing, its costs and the regional
 * partner's share are entered on Expenses, paid from his cash (as Shafqat's
 * statements are). Clearing then declares GGS's share for that client and
 * posts it to the equity partners on its own journal — beside the monthly run,
 * never inside it. Each clearance is one line in the equity partner's ledger.
 */

type Clearance = {
  id: string; client_id: string; period_month: string; amount: number; pra_held: number;
  note: string | null; posted_journal_id: string | null;
};
type Opt = { id: string; name: string };

const acct = (n: number) => Math.round(n).toLocaleString();
const monthName = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" });
const monthEnd = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

export default function ClientClearances({
  companyId, branchId, regionName, canEdit, onChanged,
}: {
  companyId: string;
  branchId: string;
  regionName: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<Clearance[]>([]);
  const [clients, setClients] = useState<Opt[]>([]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ client: "", month: "", amount: "", pra: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, c] = await Promise.all([
      supabase.from("region_declared_profit")
        .select("id, client_id, period_month, amount, pra_held, note, posted_journal_id")
        .eq("company_id", companyId).eq("branch_id", branchId).not("client_id", "is", null)
        .order("period_month", { ascending: false }),
      supabase.from("clients").select("id, name").eq("company_id", companyId).eq("branch_id", branchId).order("name"),
    ]);
    setRows(((d.data ?? []) as Clearance[]).map((r) => ({ ...r, amount: Number(r.amount), pra_held: Number(r.pra_held ?? 0) })));
    setClients((c.data ?? []) as Opt[]);
  }, [companyId, branchId]);
  useEffect(() => { void load(); }, [load]);

  const name = (id: string) => clients.find((c) => c.id === id)?.name ?? "Client";
  const num = (s: string) => Number(s.replace(/[,\s]/g, ""));

  const clear = async () => {
    if (!f.client) return setErr("Choose the client.");
    if (!/^\d{4}-\d{2}$/.test(f.month)) return setErr("Choose the month it is cleared through.");
    const amount = num(f.amount), pra = f.pra.trim() ? num(f.pra) : 0;
    if (!f.amount.trim() || Number.isNaN(amount)) return setErr("Enter GGS's share for this client (commas are fine).");
    if (Number.isNaN(pra) || pra < 0) return setErr("Enter the PRA held, or leave it empty.");
    const month = `${f.month}-01`;
    setBusy(true); setErr(null);
    const dec = await supabase.rpc("declare_region_profit", {
      p_branch_id: branchId, p_month: month, p_amount: amount, p_note: f.note.trim() || null, p_client_id: f.client, p_pra_held: pra,
    });
    if (dec.error) { setBusy(false); return setErr(friendlyDbError(dec.error)); }
    const post = await supabase.rpc("post_declared_region_profit", { p_branch_id: branchId, p_month: month });
    setBusy(false);
    if (post.error) {
      await load();
      return setErr(`Declared, but not posted: ${friendlyDbError(post.error)} — use Post on its row once that is fixed.`);
    }
    setOpen(false);
    await load();
    onChanged();
  };

  const post = async (r: Clearance) => {
    setErr(null);
    const { error } = await supabase.rpc("post_declared_region_profit", { p_branch_id: branchId, p_month: r.period_month });
    if (error) return setErr(friendlyDbError(error));
    await load(); onChanged();
  };
  const unpost = async (r: Clearance) => {
    if (!window.confirm(`Take ${name(r.client_id)}'s clearance through ${monthEnd(r.period_month)} back out of the partners' ledgers?`)) return;
    setErr(null);
    const { error } = await supabase.rpc("unpost_declared_region_profit", { p_declared_id: r.id });
    if (error) return setErr(friendlyDbError(error));
    await load(); onChanged();
  };

  const field = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  const total = rows.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="border-t border-border px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <div>
          <h4 className="text-sm font-semibold text-foreground">{regionName} — clients cleared</h4>
          <p className="text-xs text-muted-foreground">
            Each client is settled on its own, through a month, once its money is in and it is in profit. GGS&rsquo;s share
            posts to the equity partner as its own line.
          </p>
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => { setErr(null); setF({ client: "", month: "", amount: "", pra: "", note: "" }); setOpen(true); }}>
            Clear a client
          </Button>
        )}
      </div>
      {err && !open && <p className="text-xs text-danger-700 dark:text-danger-500 mb-2">{err}</p>}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No client cleared yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left py-1.5 font-medium">Client</th>
                <th className="text-left py-1.5 font-medium">Cleared through</th>
                <th className="text-right py-1.5 font-medium">GGS share</th>
                <th className="text-right py-1.5 font-medium">PRA held</th>
                <th className="text-right py-1.5 font-medium">In the ledgers</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-1.5 pr-3 text-foreground">{name(r.client_id)}{r.note ? <div className="text-[11px] text-muted-foreground">{r.note}</div> : null}</td>
                  <td className="py-1.5 pr-3 text-muted-foreground whitespace-nowrap">{monthEnd(r.period_month)}</td>
                  <td className="py-1.5 text-right font-ledger font-semibold">{acct(r.amount)}</td>
                  <td className="py-1.5 text-right font-ledger text-muted-foreground">{r.pra_held ? acct(r.pra_held) : "—"}</td>
                  <td className="py-1.5 text-right whitespace-nowrap">
                    {r.posted_journal_id
                      ? <span className="text-xs text-up">Posted{canEdit && <button type="button" className="ml-2 text-muted-foreground hover:text-foreground underline" onClick={() => void unpost(r)}>Unpost</button>}</span>
                      : <span className="text-xs text-heed">Not posted{canEdit && <button type="button" className="ml-2 font-semibold text-brand-700 dark:text-brand-500 hover:underline" onClick={() => void post(r)}>Post</button>}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border font-semibold">
                <td className="py-1.5" colSpan={2}>Total</td>
                <td className="py-1.5 text-right font-ledger">{acct(total)}</td>
                <td className="py-1.5 text-right font-ledger text-muted-foreground">{acct(rows.reduce((s, r) => s + r.pra_held, 0))}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <Modal isOpen={open} onClose={() => !busy && setOpen(false)} title={`Clear a ${regionName} client`} error={err} onDismissError={() => setErr(null)}
        footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void clear()} disabled={busy}>{busy ? "Posting…" : "Clear and post"}</Button>
        </>}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Before clearing: the client&rsquo;s payment is in, and its costs and the regional partner&rsquo;s share are on
            Expenses, paid from his cash. Clearing posts GGS&rsquo;s share to the equity partner&rsquo;s ledger, dated the last
            day of the month — no bank or cash moves.
          </p>
          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">Client *</label>
            <ThemedSelect value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })}>
              <option value="">Select client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </ThemedSelect>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Cleared through (month) *</label>
              <input type="month" className={field} value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} />
            </div>
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">GGS share (PKR) *</label>
              <input className={field} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            </div>
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">PRA held (PKR)</label>
              <input className={field} inputMode="decimal" value={f.pra} onChange={(e) => setF({ ...f, pra: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">Note (shows in the ledger)</label>
            <input className={field} placeholder="e.g. GGS 55% of October" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </div>
        </div>
      </Modal>
    </div>
  );
}
