// The verification chain and the remarks thread for ONE half-month attendance
// board (0493): HR verifies, then Ops, then Finance. A later stage can send the
// half back to the one before it, with a reason that lands in the thread.
//
// Every write goes through an RPC — attendance_half_action for the stages,
// attendance_board_remark for the thread — which stamps who did it from the
// signed-in account. Nothing here sends a name or a user id.

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, CheckCircle2, CornerDownRight, Loader2, Lock, MessageSquare, RotateCcw, Send, ShieldCheck, Undo2, X,
} from "lucide-react";
import Button from "./Button";
import { supabase } from "../lib/supabase";

export type HalfVerification = {
  id: string;
  hr_verified_at: string | null;
  hr_verified_by_name: string | null;
  ops_verified_at: string | null;
  ops_verified_by_name: string | null;
  finance_verified_at: string | null;
  finance_verified_by_name: string | null;
};

type Remark = {
  id: string;
  parent_id: string | null;
  kind: "remark" | "reply" | "returned";
  body: string;
  author_name: string | null;
  created_at: string;
};

type Stage = "hr" | "ops" | "finance";

const STAGES: { key: Stage; label: string }[] = [
  { key: "hr", label: "HR" },
  { key: "ops", label: "Ops" },
  { key: "finance", label: "Finance" },
];

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  });

export default function HalfMonthReview({
  clientId, category, month, half, halfLabel, halfEnded, verification, legacyVerifiedAt,
  payrollPhase, outstanding, canHr, canOps, canFinance, onChanged,
}: {
  clientId: string | null;
  category: string | null;
  /** YYYY-MM */
  month: string;
  half: 1 | 2;
  /** e.g. "1–15 Oct" */
  halfLabel: string;
  halfEnded: boolean;
  verification: HalfVerification | null;
  /** A pre-0493 whole-month OPS verification, which counts as fully verified. */
  legacyVerifiedAt: string | null;
  payrollPhase: string | null;
  /** Unconfirmed days in this half (blocks HR verify). */
  outstanding: { empName: string; date: string }[];
  canHr: boolean;
  canOps: boolean;
  canFinance: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [returning, setReturning] = useState<null | "return_to_hr" | "return_to_ops">(null);
  const [returnNote, setReturnNote] = useState("");

  const [remarks, setRemarks] = useState<Remark[]>([]);
  const [remarksOpen, setRemarksOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [remarkErr, setRemarkErr] = useState<string | null>(null);

  const scopeFilter = <T extends { eq: (c: string, v: string) => T }>(q: T) =>
    clientId ? q.eq("client_id", clientId) : q.eq("category", category as string);

  const loadRemarks = async () => {
    const { data } = await scopeFilter(
      supabase
        .from("attendance_board_remarks")
        .select("id, parent_id, kind, body, author_name, created_at")
        .eq("period_month", `${month}-01`)
        .eq("half", half) as any,
    ).order("created_at", { ascending: true });
    setRemarks((data ?? []) as Remark[]);
  };

  useEffect(() => {
    setMsg(null);
    setReturning(null);
    setReplyTo(null);
    void loadRemarks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, category, month, half, verification?.hr_verified_at, verification?.ops_verified_at]);

  const threads = useMemo(() => {
    const top = remarks.filter((r) => !r.parent_id);
    const replies = new Map<string, Remark[]>();
    for (const r of remarks) {
      if (!r.parent_id) continue;
      replies.set(r.parent_id, [...(replies.get(r.parent_id) ?? []), r]);
    }
    return top.map((r) => ({ remark: r, replies: replies.get(r.id) ?? [] }));
  }, [remarks]);

  const frozen = payrollPhase !== null;
  const done: Record<Stage, { at: string | null; by: string | null }> = legacyVerifiedAt
    ? {
        hr: { at: legacyVerifiedAt, by: null },
        ops: { at: legacyVerifiedAt, by: null },
        finance: { at: legacyVerifiedAt, by: null },
      }
    : {
        hr: { at: verification?.hr_verified_at ?? null, by: verification?.hr_verified_by_name ?? null },
        ops: { at: verification?.ops_verified_at ?? null, by: verification?.ops_verified_by_name ?? null },
        finance: { at: verification?.finance_verified_at ?? null, by: verification?.finance_verified_by_name ?? null },
      };
  const current: Stage | "done" = !done.hr.at ? "hr" : !done.ops.at ? "ops" : !done.finance.at ? "finance" : "done";

  const act = async (action: string, note?: string) => {
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.rpc("attendance_half_action", {
      p_client_id: clientId,
      p_category: clientId ? null : category,
      p_period_month: `${month}-01`,
      p_half: half,
      p_action: action,
      p_note: note ?? null,
    });
    setBusy(false);
    if (error) { setMsg({ kind: "err", text: error.message }); return; }
    const text: Record<string, string> = {
      hr_verify: "HR verified. This half's attendance is now locked and with Ops.",
      ops_verify: "Ops verified. This half is now with Finance.",
      finance_verify: "Finance verified. This half is complete.",
      undo_hr: "HR verification withdrawn. The half is unlocked.",
      undo_ops: "Ops verification withdrawn.",
      undo_finance: "Finance verification withdrawn.",
      return_to_hr: "Sent back to HR. The half is unlocked for corrections.",
      return_to_ops: "Sent back to Ops.",
    };
    setMsg({ kind: "ok", text: text[action] ?? "Done." });
    setReturning(null);
    setReturnNote("");
    onChanged();
  };

  const hrVerify = () => {
    if (!halfEnded) {
      setMsg({ kind: "err", text: `This half (${halfLabel}) hasn't ended yet. It can be verified from the day after.` });
      return;
    }
    if (outstanding.length > 0) {
      const preview = outstanding.slice(0, 6).map((o) => `${o.empName} (${o.date})`).join(", ");
      setMsg({
        kind: "err",
        text: `${outstanding.length} unconfirmed day(s) in this half: ${preview}${outstanding.length > 6 ? "…" : ""}. Confirm or override them first.`,
      });
      return;
    }
    void act("hr_verify");
  };

  const post = async (body: string, parentId: string | null) => {
    if (!body.trim()) return;
    setPosting(true);
    setRemarkErr(null);
    const { error } = await supabase.rpc("attendance_board_remark", {
      p_client_id: clientId,
      p_category: clientId ? null : category,
      p_period_month: `${month}-01`,
      p_half: half,
      p_body: body.trim(),
      p_parent_id: parentId,
    });
    setPosting(false);
    if (error) { setRemarkErr(error.message); return; }
    if (parentId) { setReplyDraft(""); setReplyTo(null); } else setDraft("");
    await loadRemarks();
  };

  // What the signed-in user can do right now, at the current stage.
  const actions: { key: string; label: string; icon: typeof ShieldCheck; variant: "primary" | "secondary"; onClick: () => void }[] = [];
  if (!legacyVerifiedAt && !frozen) {
    if (current === "hr" && canHr)
      actions.push({ key: "hr", label: "HR Verify", icon: ShieldCheck, variant: "primary", onClick: hrVerify });
    if (current === "ops" && canOps) {
      actions.push({ key: "ops", label: "Ops Verify", icon: ShieldCheck, variant: "primary", onClick: () => act("ops_verify") });
      actions.push({ key: "ret_hr", label: "Send back to HR", icon: RotateCcw, variant: "secondary", onClick: () => setReturning("return_to_hr") });
    }
    if (current === "ops" && canHr && !canOps)
      actions.push({ key: "undo_hr", label: "Withdraw HR verification", icon: Undo2, variant: "secondary", onClick: () => act("undo_hr") });
    if (current === "finance" && canFinance) {
      actions.push({ key: "fin", label: "Finance Verify", icon: ShieldCheck, variant: "primary", onClick: () => act("finance_verify") });
      actions.push({ key: "ret_ops", label: "Send back to Ops", icon: RotateCcw, variant: "secondary", onClick: () => setReturning("return_to_ops") });
    }
    if (current === "finance" && canOps && !canFinance)
      actions.push({ key: "undo_ops", label: "Withdraw Ops verification", icon: Undo2, variant: "secondary", onClick: () => act("undo_ops") });
    if (current === "done" && canFinance)
      actions.push({ key: "undo_fin", label: "Withdraw Finance verification", icon: Undo2, variant: "secondary", onClick: () => act("undo_finance") });
  }

  const waitingOn = current === "done" ? null : STAGES.find((s) => s.key === current)!.label;

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* The chain, left to right. */}
        <ol className="flex items-center gap-1.5 text-xs">
          {STAGES.map((s, i) => {
            const d = done[s.key];
            const isCurrent = current === s.key;
            return (
              <li key={s.key} className="flex items-center gap-1.5">
                {i > 0 && <span className={`w-4 h-px ${d.at ? "bg-success-400" : "bg-border"}`} />}
                <span
                  title={d.at ? `${s.label} verified${d.by ? ` by ${d.by}` : ""} · ${when(d.at)}` : isCurrent ? `Waiting on ${s.label}` : `${s.label} — not yet`}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                    d.at
                      ? "border-success-300 bg-success-50 text-success-800 dark:bg-success-900/20 dark:text-success-400"
                      : isCurrent
                        ? "border-warning-300 bg-warning-50 text-warning-800 dark:bg-warning-900/20 dark:text-warning-400"
                        : "border-border text-muted-foreground"
                  }`}
                >
                  {d.at ? <CheckCircle2 className="w-3 h-3" /> : <span className={`w-1.5 h-1.5 rounded-full ${isCurrent ? "bg-warning-500" : "bg-muted-foreground/40"}`} />}
                  {s.label}
                  {d.at && d.by && <span className="hidden md:inline text-success-700/80 dark:text-success-500/80">· {d.by}</span>}
                </span>
              </li>
            );
          })}
        </ol>

        <span className="text-[11px] text-muted-foreground">
          {legacyVerifiedAt
            ? `Verified under the old monthly process on ${when(legacyVerifiedAt)}.`
            : waitingOn
              ? `${halfLabel} · waiting on ${waitingOn}`
              : `${halfLabel} · fully verified`}
          {done.hr.at && !legacyVerifiedAt && <Lock className="inline w-3 h-3 ml-1 -mt-0.5" />}
        </span>

        <div className="flex flex-wrap items-center gap-1.5 ml-auto">
          {actions.map((a) => (
            <Button key={a.key} size="sm" variant={a.variant} onClick={a.onClick} disabled={busy}>
              {busy && a.variant === "primary" ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <a.icon className="w-4 h-4 mr-1.5" />}
              {a.label}
            </Button>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setRemarksOpen((o) => !o)}>
            <MessageSquare className="w-4 h-4 mr-1.5" />
            Remarks{remarks.length > 0 ? ` (${remarks.length})` : ""}
          </Button>
        </div>
      </div>

      {frozen && !legacyVerifiedAt && (
        <p className="text-[11px] text-warning-700 dark:text-warning-500 flex items-center gap-1">
          <Lock className="w-3 h-3" /> Payroll for this month has moved past Draft, so verification is frozen. Move payroll back to Draft to change it.
        </p>
      )}

      {returning && (
        <div className="rounded-md border border-warning-300 bg-warning-50 dark:bg-warning-900/20 p-2.5 space-y-2">
          <p className="text-xs text-warning-900 dark:text-warning-300">
            {returning === "return_to_hr"
              ? "Send this half back to HR. HR's verification is cleared and the attendance unlocks for corrections."
              : "Send this half back to Ops. Ops' verification is cleared."}{" "}
            Say what needs fixing — it is posted to the remarks.
          </p>
          <textarea
            autoFocus
            rows={2}
            value={returnNote}
            onChange={(e) => setReturnNote(e.target.value)}
            placeholder="e.g. Ali Raza shows absent on 4 Oct but was on leave"
            className="w-full px-2.5 py-1.5 border border-border rounded-md text-sm bg-card"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setReturning(null); setReturnNote(""); }} disabled={busy}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={() => act(returning, returnNote)} disabled={busy || !returnNote.trim()}>
              {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-1.5" />}
              Send back
            </Button>
          </div>
        </div>
      )}

      {msg && (
        <div className={`flex items-start gap-2 px-3 py-2 rounded-md text-xs ${msg.kind === "ok" ? "bg-success-50 text-success-700 border border-success-200 dark:bg-success-900/20 dark:text-success-400" : "bg-danger-50 text-danger-700 border border-danger-200"}`}>
          {msg.kind === "ok" ? <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
          <span className="flex-1">{msg.text}</span>
          <button onClick={() => setMsg(null)}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {remarksOpen && (
        <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-3 max-h-[40dvh] overflow-auto">
          {threads.length === 0 && (
            <p className="text-xs text-muted-foreground">No remarks on {halfLabel} yet.</p>
          )}
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
                <button
                  type="button"
                  onClick={() => { setReplyTo(remark.id); setReplyDraft(""); }}
                  className="pl-4 text-[11px] text-brand-600 hover:text-brand-700"
                >
                  Reply
                </button>
              )}
            </div>
          ))}

          <div className="flex gap-1.5 pt-1 border-t border-border">
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
          {remarkErr && <p className="text-xs text-danger-600">{remarkErr}</p>}
        </div>
      )}
    </div>
  );
}

function RemarkBubble({ r }: { r: Remark }) {
  return (
    <div className={`rounded-md border px-2.5 py-1.5 ${r.kind === "returned" ? "border-warning-300 bg-warning-50 dark:bg-warning-900/20" : "border-border bg-card"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          {r.author_name ?? "Unknown"}
          {r.kind === "returned" && <span className="ml-1.5 text-[10px] font-normal text-warning-800 dark:text-warning-400">sent back</span>}
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0">{when(r.created_at)}</span>
      </div>
      <p className="text-sm text-foreground whitespace-pre-wrap break-words mt-0.5">{r.body}</p>
    </div>
  );
}
