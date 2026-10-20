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
};

export const remarkWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

/** Load the remarks for a board. Exposed so callers can show a count. */
export async function loadBoardRemarks(clientId: string | null, category: string | null, month: string, half: 1 | 2, branchId: string | null = null) {
  let q = supabase
    .from("attendance_board_remarks")
    .select("id, parent_id, kind, body, author_name, created_at")
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
  clientId, category, branchId = null, month, half, halfLabel, reloadKey = 0, onCount,
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

  return (
    <div className="space-y-3">
      {loading && <p className="text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 inline animate-spin mr-1" /> Loading remarks…</p>}
      {!loading && threads.length === 0 && <p className="text-xs text-muted-foreground">No remarks on {halfLabel} yet.</p>}
      {threads.map(({ remark, replies }) => (
        <div key={remark.id} className="space-y-1.5">
          <RemarkBubble r={remark} />
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

function RemarkBubble({ r }: { r: BoardRemark }) {
  return (
    <div className={`rounded-md border px-2.5 py-1.5 ${r.kind === "returned" ? "border-warning-300 bg-warning-50 dark:bg-warning-900/20" : "border-border bg-card"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          {r.author_name ?? "Unknown"}
          {r.kind === "returned" && <span className="ml-1.5 text-[10px] font-normal text-warning-800 dark:text-warning-400">sent back</span>}
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0">{remarkWhen(r.created_at)}</span>
      </div>
      <p className="text-sm text-foreground whitespace-pre-wrap break-words mt-0.5">{r.body}</p>
    </div>
  );
}
