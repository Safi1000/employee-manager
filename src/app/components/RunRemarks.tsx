import { useCallback, useEffect, useState } from "react";
import { MessageSquareWarning, Check } from "lucide-react";
import Button from "./Button";
import { supabase, friendlyDbError } from "../lib/supabase";

/**
 * Remarks handed between stages (0658). Shayan, 11 Nov 2026: HR leaves remarks
 * for Ops on the monthly board; Ops leaves remarks for Accounts before
 * approving. The reader must acknowledge each one before the next approval —
 * the database refuses Ops verify / Finance Verify while one is open, so this
 * panel is the way through, not a courtesy.
 *
 *   stage "hr_to_ops"       — written by HR, acknowledged by Ops.
 *   stage "ops_to_accounts" — written by Ops, acknowledged by Accounts.
 */

type Remark = {
  id: string; body: string; author_name: string | null; created_at: string;
  acknowledged_at: string | null; acknowledged_by_name: string | null;
  employees: { full_name: string } | null;
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

export default function RunRemarks({
  stage, clientId, category, branchId = null, month, canAdd, canAck, onOpenCount, compact = false,
}: {
  stage: "hr_to_ops" | "ops_to_accounts";
  clientId: string | null;
  category: string | null;
  branchId?: string | null;
  /** "YYYY-MM" */
  month: string;
  canAdd: boolean;
  canAck: boolean;
  /** Reports how many remarks are still unacknowledged, so the parent can hold its approve button. */
  onOpenCount?: (n: number) => void;
  compact?: boolean;
}) {
  const [rows, setRows] = useState<Remark[]>([]);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    let q = supabase.from("run_remarks")
      .select("id, body, author_name, created_at, acknowledged_at, acknowledged_by_name, employees(full_name)")
      .eq("stage", stage).eq("period_month", `${month}-01`).order("created_at");
    q = clientId ? q.eq("client_id", clientId) : q.eq("category", category ?? "");
    if (!clientId && branchId) q = q.eq("branch_id", branchId);
    const { data, error } = await q;
    if (error) { setErr(friendlyDbError(error)); return; }
    const list = (data ?? []) as unknown as Remark[];
    setRows(list);
    onOpenCount?.(list.filter((r) => !r.acknowledged_at).length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, clientId, category, branchId, month]);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (!draft.trim()) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("add_run_remark", {
      p_stage: stage, p_client_id: clientId, p_category: clientId ? null : category,
      p_branch_id: clientId ? null : branchId, p_period_month: `${month}-01`, p_body: draft.trim(),
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setDraft(""); setAdding(false);
    await load();
  };

  const ack = async (id: string) => {
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("acknowledge_run_remark", { p_remark_id: id });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    await load();
  };

  const from = stage === "hr_to_ops" ? "HR" : "Ops";
  const to = stage === "hr_to_ops" ? "Ops" : "Accounts";
  const open = rows.filter((r) => !r.acknowledged_at);
  if (rows.length === 0 && !canAdd) return null;

  return (
    <div className={compact ? "text-xs" : "text-sm"}>
      {rows.length > 0 && (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.id}
              className={`rounded-md border px-3 py-2 ${r.acknowledged_at
                ? "border-border bg-muted/40"
                : "border-warning-200 bg-warning-50 dark:border-warning-500/30 dark:bg-warning-500/10"}`}>
              <div className="flex items-start gap-2">
                {!r.acknowledged_at && <MessageSquareWarning className="w-4 h-4 mt-0.5 text-warning-700 dark:text-warning-500 shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="text-foreground whitespace-pre-wrap">{r.employees?.full_name ? <b>{r.employees.full_name}: </b> : null}{r.body}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {from} remark for {to} · {r.author_name ?? "—"} · {when(r.created_at)}
                    {r.acknowledged_at && <> · acknowledged by {r.acknowledged_by_name ?? "—"} {when(r.acknowledged_at)}</>}
                  </div>
                </div>
                {!r.acknowledged_at && canAck && (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => ack(r.id)}>
                    <Check className="w-3.5 h-3.5 mr-1" /> Acknowledge
                  </Button>
                )}
              </div>
            </div>
          ))}
          {open.length > 0 && !canAck && (
            <p className="text-[11px] text-muted-foreground">Waiting for {to} to acknowledge {open.length === 1 ? "it" : "them"}.</p>
          )}
        </div>
      )}
      {canAdd && (
        adding ? (
          <div className="mt-2 flex flex-col gap-2">
            <textarea className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" rows={2}
              placeholder={`Remark for ${to} — e.g. "3 guards' leave on 12 Oct is not on the sheet yet"`}
              value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={busy || !draft.trim()} onClick={add}>Send to {to}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setDraft(""); }}>Cancel</Button>
            </div>
          </div>
        ) : (
          <button type="button" className="mt-1.5 text-[11px] text-brand-600 hover:underline" onClick={() => setAdding(true)}>
            + Add a remark for {to}
          </button>
        )
      )}
      {err && <p className="mt-1 text-[11px] text-danger-700 dark:text-danger-500">{err}</p>}
    </div>
  );
}
