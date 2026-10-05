// The HR side of attendance verification, on the Monthly board (0493/0494).
//
// HR verifies a half, or the whole month at once; that locks the days and puts
// the half in the Attendance Run's Review tab, where Ops verifies it or sends it
// back with a remark. This bar shows where each half stands and offers HR its
// actions. Ops acts on the Attendance Run page, not here.
//
// Whole-month actions go through attendance_halves_action, one transaction, so
// they land on both halves or neither.

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Loader2, Lock, MessageSquare, ShieldCheck, Undo2, X } from "lucide-react";
import Button from "./Button";
import BoardRemarks from "./BoardRemarks";
import { supabase } from "../lib/supabase";

export type HalfVerification = {
  id: string;
  half: 1 | 2;
  hr_verified_at: string | null;
  hr_verified_by_name: string | null;
  ops_verified_at: string | null;
  ops_verified_by_name: string | null;
};

export type HalfInfo = {
  label: string;           // "1–15 Oct"
  ended: boolean;
  ver: HalfVerification | null;
  outstanding: { empName: string; date: string }[];
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

/** Where one half stands, as one phrase and a tone. */
export function halfState(info: HalfInfo, legacyAt: string | null) {
  if (legacyAt) return { tone: "success" as const, text: `Verified (old monthly process, ${when(legacyAt)})` };
  const v = info.ver;
  if (v?.ops_verified_at) return { tone: "success" as const, text: `Ops verified${v.ops_verified_by_name ? ` by ${v.ops_verified_by_name}` : ""} · ${when(v.ops_verified_at)}` };
  if (v?.hr_verified_at) return { tone: "info" as const, text: `In Review — HR verified${v.hr_verified_by_name ? ` by ${v.hr_verified_by_name}` : ""} · ${when(v.hr_verified_at)}` };
  if (info.ended) return { tone: "warning" as const, text: "Waiting on HR" };
  return { tone: "muted" as const, text: "In progress — not ended yet" };
}

const TONE = {
  success: "border-success-300 bg-success-50 text-success-800 dark:bg-success-900/20 dark:text-success-400",
  info: "border-brand-300 bg-brand-50 text-brand-800 dark:bg-brand-900/20 dark:text-brand-300",
  warning: "border-warning-300 bg-warning-50 text-warning-800 dark:bg-warning-900/20 dark:text-warning-400",
  muted: "border-border text-muted-foreground",
};

export default function BoardVerificationBar({
  clientId, category, branchId = null, month, view, halves, legacyVerifiedAt, payrollPhase, canHr, onChanged,
}: {
  clientId: string | null;
  category: string | null;
  /** Staff groups are verified per region (0498). Ignored for clients. */
  branchId?: string | null;
  month: string;
  /** What the grid is showing; HR's actions apply to it. */
  view: "month" | 1 | 2;
  halves: Record<1 | 2, HalfInfo>;
  legacyVerifiedAt: string | null;
  payrollPhase: string | null;
  canHr: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [remarksOpen, setRemarksOpen] = useState(false);
  const [remarksHalf, setRemarksHalf] = useState<1 | 2>(view === 2 ? 2 : 1);
  const [remarkCounts, setRemarkCounts] = useState<Record<1 | 2, number | null>>({ 1: null, 2: null });

  const frozen = payrollPhase !== null;
  const targets: (1 | 2)[] = view === "month" ? [1, 2] : [view];
  const scopeName = view === "month" ? "the whole month" : view === 1 ? "the 1st half" : "the 2nd half";

  // Halves HR can verify now: not legacy, not yet HR-verified.
  const toVerify = legacyVerifiedAt ? [] : targets.filter((h) => !halves[h].ver?.hr_verified_at);
  const notEnded = toVerify.filter((h) => !halves[h].ended);
  // Halves HR can withdraw: HR-verified, Ops not yet.
  const toWithdraw = legacyVerifiedAt ? [] : targets.filter((h) => halves[h].ver?.hr_verified_at && !halves[h].ver?.ops_verified_at);

  const run = async (hs: (1 | 2)[], action: "hr_verify" | "undo_hr", ok: string) => {
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.rpc("attendance_halves_action", {
      p_client_id: clientId,
      p_category: clientId ? null : category,
      p_period_month: `${month}-01`,
      p_halves: hs,
      p_action: action,
      p_note: null,
      p_branch_id: clientId ? null : branchId,
    });
    setBusy(false);
    if (error) { setMsg({ kind: "err", text: error.message }); return; }
    setMsg({ kind: "ok", text: ok });
    onChanged();
  };

  const hrVerify = () => {
    if (notEnded.length > 0) {
      const h = notEnded[0];
      setMsg({ kind: "err", text: `The ${h === 1 ? "1st" : "2nd"} half (${halves[h].label}) hasn't ended yet. It can be verified from the day after it ends${view === "month" ? " — or verify the 1st half on its own now" : ""}.` });
      return;
    }
    const outstanding = toVerify.flatMap((h) => halves[h].outstanding);
    if (outstanding.length > 0) {
      const preview = outstanding.slice(0, 6).map((o) => `${o.empName} (${o.date})`).join(", ");
      setMsg({ kind: "err", text: `${outstanding.length} unconfirmed day(s) in ${scopeName}: ${preview}${outstanding.length > 6 ? "…" : ""}. Confirm or override them first.` });
      return;
    }
    const label = toVerify.length === 2 ? "Both halves" : toVerify[0] === 1 ? "The 1st half" : "The 2nd half";
    void run(toVerify, "hr_verify", `${label} HR-verified and locked. ${toVerify.length === 2 ? "They are" : "It is"} now in Review on the Attendance Run for Ops.`);
  };

  const verifyLabel = toVerify.length === 2 ? "HR verify whole month" : toVerify[0] === 1 ? "HR verify 1st half" : "HR verify 2nd half";
  const withdrawLabel = toWithdraw.length === 2 ? "Withdraw HR (both halves)" : "Withdraw HR verification";

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {([1, 2] as const).map((h) => {
          const st = halfState(halves[h], legacyVerifiedAt);
          const dim = view !== "month" && view !== h;
          return (
            <span key={h} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${TONE[st.tone]} ${dim ? "opacity-50" : ""}`}>
              {st.tone === "success" ? <CheckCircle2 className="w-3 h-3" /> : st.tone === "info" ? <Lock className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
              <span className="font-medium">{h === 1 ? "1st" : "2nd"} half {halves[h].label}</span>
              <span className="hidden md:inline">· {st.text}</span>
            </span>
          );
        })}
        <div className="flex flex-wrap items-center gap-1.5 ml-auto">
          {canHr && !frozen && toVerify.length > 0 && (
            <Button size="sm" variant="primary" onClick={hrVerify} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-1.5" />}
              {verifyLabel}
            </Button>
          )}
          {canHr && !frozen && toWithdraw.length > 0 && (
            <Button size="sm" variant="secondary" disabled={busy}
              onClick={() => { if (window.confirm(`Withdraw HR verification for ${toWithdraw.length === 2 ? "both halves" : `the ${toWithdraw[0] === 1 ? "1st" : "2nd"} half`}? The days unlock and leave Ops' Review.`)) void run(toWithdraw, "undo_hr", "HR verification withdrawn. The days are unlocked."); }}>
              <Undo2 className="w-4 h-4 mr-1.5" /> {withdrawLabel}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => { setRemarksHalf(view === 2 ? 2 : 1); setRemarksOpen((o) => !o); }}>
            <MessageSquare className="w-4 h-4 mr-1.5" /> Remarks
          </Button>
        </div>
      </div>

      {frozen && !legacyVerifiedAt && (
        <p className="text-[11px] text-warning-700 dark:text-warning-500 flex items-center gap-1">
          <Lock className="w-3 h-3" /> Payroll for this month has moved past Draft, so verification is frozen.
        </p>
      )}

      {msg && (
        <div className={`flex items-start gap-2 px-3 py-2 rounded-md text-xs ${msg.kind === "ok" ? "bg-success-50 text-success-700 border border-success-200 dark:bg-success-900/20 dark:text-success-400" : "bg-danger-50 text-danger-700 border border-danger-200"}`}>
          {msg.kind === "ok" ? <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
          <span className="flex-1">{msg.text}</span>
          <button onClick={() => setMsg(null)}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {remarksOpen && (
        <div className="rounded-md border border-border bg-secondary/30 p-3 max-h-[40dvh] overflow-auto">
          <div className="flex items-center gap-1 mb-3">
            {([1, 2] as const).map((h) => (
              <button key={h} type="button" onClick={() => setRemarksHalf(h)}
                className={`px-2.5 py-1 rounded text-xs ${remarksHalf === h ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {h === 1 ? "1st" : "2nd"} half{remarkCounts[h] ? ` (${remarkCounts[h]})` : ""}
              </button>
            ))}
          </div>
          <BoardRemarks
            clientId={clientId}
            category={category}
            branchId={branchId}
            month={month}
            half={remarksHalf}
            halfLabel={halves[remarksHalf].label}
            onCount={(n) => setRemarkCounts((c) => ({ ...c, [remarksHalf]: n }))}
          />
        </div>
      )}
    </div>
  );
}
