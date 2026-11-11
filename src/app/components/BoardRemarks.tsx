// The remarks thread for one half-month attendance board (0493): remarks, one
// level of replies, and the "sent back" notes Ops leaves when returning a half
// to HR. Authors are stamped by attendance_board_remark from the signed-in
// account. Used by the Monthly board and the Attendance Run.

import { useEffect, useMemo, useState } from "react";
import { CornerDownRight, Loader2, Send, X } from "lucide-react";
import Button from "./Button";
import { supabase } from "../lib/supabase";

export type BoardRemark = {
  id: string;
  parent_id: string | null;
  kind: "remark" | "reply" | "returned";
  body: string;
  author_name: string | null;
  created_at: string;
  /** 0658: Ops must acknowledge a top-level remark before verifying the half. */
  acknowledged_at?: string | null;
  acknowledged_by_name?: string | null;
};

export const remarkWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

/** Load the remarks for a board. Exposed so callers can show a count. */
export async function loadBoardRemarks(clientId: string | null, category: string | null, month: string, half: 1 | 2, branchId: string | null = null) {
  let q = supabase
    .from("attendance_board_remarks")
    .select("id, parent_id, kind, body, author_name, created_at, acknowledged_at, acknowledged_by_name")
    .eq("period_month", `${month}-01`)
    .eq("half", half);
  // A staff group's board is per region (0498).
  q = clientId ? q.eq("client_id", clientId)
    : branchId ? q.eq("category", category as string).eq("branch_id", branchId)
    : q.eq("category", category as string).is("branch_id", null);
  const { data, error } = await q.order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as BoardRemark[];
}

export default function BoardRemarks({
  clientId, category, branchId = null, month, half, halfLabel, reloadKey = 0, onCount, canAck = false, onOpenCount,
}: {
  clientId: string | null;
  category: string | null;
  branchId?: string | null;
  /** YYYY-MM */
  month: string;
  half: 1 | 2;
  halfLabel: string;
  /** Bump to re-read (e.g. after a send-back wrote a remark). */
  reloadKey?: number;
  onCount?: (n: number) => void;
  /** 0658: Ops may acknowledge remarks; Ops verify of this half waits for every top-level remark to be acknowledged. */
  canAck?: boolean;
  onOpenCount?: (n: number) => void;
}) {
  const [remarks, setRemarks] = useState<BoardRemark[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await loadBoardRemarks(clientId, category, month, half, clientId ? null : branchId);
      setRemarks(r);
      onCount?.(r.length);
      onOpenCount?.(r.filter((x) => !x.parent_id && x.kind === "remark" && !x.acknowledged_at).length);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    setReplyTo(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, category, branchId, month, half, reloadKey]);

  const threads = useMemo(() => {
    const replies = new Map<string, BoardRemark[]>();
    for (const r of remarks) if (r.parent_id) replies.set(r.parent_id, [...(replies.get(r.parent_id) ?? []), r]);
    return remarks.filter((r) => !r.parent_id).map((r) => ({ remark: r, replies: replies.get(r.id) ?? [] }));
  }, [remarks]);

  const post = async (body: string, parentId: string | null) => {
    if (!body.trim()) return;
    setPosting(true);
    setErr(null);
    const { error } = await supabase.rpc("attendance_board_remark", {
      p_client_id: clientId,
      p_category: clientId ? null : category,
      p_period_month: `${month}-01`,
      p_half: half,
      p_body: body.trim(),
      p_parent_id: parentId,
      p_branch_id: clientId ? null : branchId,
    });
    setPosting(false);
    if (error) { setErr(error.message); return; }
    if (parentId) { setReplyDraft(""); setReplyTo(null); } else setDraft("");
    await load();
  };

  const acknowledge = async (id: string) => {
    setPosting(true); setErr(null);
    const { error } = await supabase.rpc("acknowledge_board_remark", { p_remark_id: id });
    setPosting(false);
    if (error) { setErr(error.message); return; }
    await load();
  };

  return (
    <div className="space-y-3">
      {loading && <p className="text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 inline animate-spin mr-1" /> Loading remarks…</p>}
      {!loading && threads.length === 0 && <p className="text-xs text-muted-foreground">No remarks on {halfLabel} yet.</p>}
      {threads.map(({ remark, replies }) => (
        <div key={remark.id} className="space-y-1.5">
          <RemarkBubble r={remark} canAck={canAck} busy={posting} onAck={() => acknowledge(remark.id)} />
          {replies.map((rep) => (
            <div key={rep.id} className="flex gap-1.5 pl-4">
              <CornerDownRight className="w-3.5 h-3.5 mt-1.5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0"><RemarkBubble r={rep} /></div>
            </div>
          ))}
          {replyTo === remark.id ? (
            <div className="flex gap-1.5 pl-4">
              <input
                autoFocus
                value={replyDraft}
                onChange={(e) => setReplyDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void post(replyDraft, remark.id); }}
                placeholder="Write a reply…"
                className="flex-1 min-w-0 px-2.5 py-1 border border-border rounded-md text-sm bg-card"
              />
              <Button size="sm" variant="primary" onClick={() => post(replyDraft, remark.id)} disabled={posting || !replyDraft.trim()}>
                <Send className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" variant="secondary" onClick={() => { setReplyTo(null); setReplyDraft(""); }}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ) : (
            <button type="button" onClick={() => { setReplyTo(remark.id); setReplyDraft(""); }} className="pl-4 text-[11px] text-brand-600 hover:text-brand-700">
              Reply
            </button>
          )}
        </div>
      ))}
      <div className="flex gap-1.5 pt-2 border-t border-border">
        <textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Add a remark on ${halfLabel}…`}
          className="flex-1 min-w-0 px-2.5 py-1.5 border border-border rounded-md text-sm bg-card"
        />
        <Button size="sm" variant="primary" className="self-end" onClick={() => post(draft, null)} disabled={posting || !draft.trim()}>
          {posting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </div>
      {err && <p className="text-xs text-danger-600">{err}</p>}
    </div>
  );
}

function RemarkBubble({ r, canAck = false, busy = false, onAck }: { r: BoardRemark; canAck?: boolean; busy?: boolean; onAck?: () => void }) {
  // 0658: a top-level remark not yet acknowledged by Ops is highlighted; Ops verify waits for it.
  const open = !r.parent_id && r.kind === "remark" && !r.acknowledged_at;
  return (
    <div className={`rounded-md border px-2.5 py-1.5 ${r.kind === "returned" || open ? "border-warning-200 bg-warning-50 dark:bg-warning-500/10" : "border-border bg-card"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          {r.author_name ?? "Unknown"}
          {r.kind === "returned" && <span className="ml-1.5 text-[10px] font-normal text-warning-700 dark:text-warning-500">sent back</span>}
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0">{remarkWhen(r.created_at)}</span>
      </div>
      <p className="text-sm text-foreground whitespace-pre-wrap break-words mt-0.5">{r.body}</p>
      {!r.parent_id && r.kind === "remark" && (
        r.acknowledged_at ? (
          <p className="text-[10px] text-muted-foreground mt-0.5">Acknowledged by {r.acknowledged_by_name ?? "Ops"} · {remarkWhen(r.acknowledged_at)}</p>
        ) : canAck ? (
          <Button size="sm" variant="secondary" className="mt-1" disabled={busy} onClick={onAck}>Acknowledge</Button>
        ) : (
          <p className="text-[10px] text-warning-700 dark:text-warning-500 mt-0.5">Not yet acknowledged by Ops</p>
        )
      )}
    </div>
  );
}
