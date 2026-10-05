// ── Attendance Run ───────────────────────────────────────────────────────────
// Attendance runs its course the way payroll does (asked 2026-10-05, 0494):
//
//   HR verifies a half (or the whole month) on the Monthly board
//     → it lands here in REVIEW
//   Ops verifies it            → it moves to OPS VERIFY
//   or Ops sends it back to HR with a remark → it leaves Review, the days
//     unlock, and HR verifies again.
//
// There is no Draft tab: before HR acts there is nothing for Ops to look at.
// Each half moves on its own, or both in one step (attendance_halves_action,
// one transaction). Payroll for a client opens once both halves are Ops-verified.
// Everything here is written through the RPCs; the database checks the stage
// key, the order, and that payroll is still in Draft.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, Loader2, Lock, MessageSquare, RotateCcw, Search, ShieldCheck, Undo2, X,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Tabs from "../../components/Tabs";
import BoardRemarks from "../../components/BoardRemarks";
import AttendanceSheetModal from "../../components/AttendanceSheetModal";
import { supabase } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";

type Half = 1 | 2;

type HalfRow = {
  half: Half;
  hr_verified_at: string | null;
  hr_verified_by_name: string | null;
  ops_verified_at: string | null;
  ops_verified_by_name: string | null;
};

type Scope = {
  key: string;
  name: string;
  clientId: string | null;
  category: string | null;
  halves: Record<Half, HalfRow | null>;
  legacyAt: string | null;
  frozen: boolean;
};

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

const CATEGORY_LABEL: Record<string, string> = {
  office_staff: "Office staff",
  armed: "Armed guards",
  gunman: "Gunmen",
  reliever: "Relievers",
};

const inReview = (h: HalfRow | null) => !!h?.hr_verified_at && !h?.ops_verified_at;
const opsDone = (h: HalfRow | null) => !!h?.ops_verified_at;

export default function AttendanceRun() {
  const { profile, company } = useAuth();
  const canOps = hasPermission(profile, "attendance.ops_verify");
  const canHr = hasPermission(profile, "attendance.hr_verify");

  const [month, setMonth] = useState(thisMonth());
  const [tab, setTab] = useState<"review" | "verified">("review");
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Send-back form: which scope, which halves, and the remark.
  const [sendBack, setSendBack] = useState<{ key: string; halves: Half[] } | null>(null);
  const [sendNote, setSendNote] = useState("");
  const [remarksFor, setRemarksFor] = useState<{ key: string; half: Half } | null>(null);
  const [boardFor, setBoardFor] = useState<Scope | null>(null);

  const period = `${month}-01`;
  const halfLabels = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const dim = new Date(y, m, 0).getDate();
    const cut = Math.floor(dim / 2);
    const mon = new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short" });
    return { 1: `1–${cut} ${mon}`, 2: `${cut + 1}–${dim} ${mon}` } as Record<Half, string>;
  }, [month]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [hv, legacy, phases] = await Promise.all([
      supabase
        .from("attendance_half_verifications")
        .select("client_id, category, half, hr_verified_at, hr_verified_by_name, ops_verified_at, ops_verified_by_name, client:client_id(name)")
        .eq("period_month", period),
      supabase
        .from("attendance_month_verifications")
        .select("client_id, category, verified_at, client:client_id(name)")
        .eq("period_month", period),
      supabase.from("payroll_run_phases").select("client_id, category, phase").eq("period_month", period),
    ]);
    const err = hv.error ?? legacy.error ?? phases.error;
    if (err) { setError(err.message); setLoading(false); return; }

    const frozenKeys = new Set(((phases.data ?? []) as any[]).filter((p) => p.phase).map((p) => p.client_id ?? `cat:${p.category}`));
    const byKey = new Map<string, Scope>();
    const scopeFor = (r: any): Scope => {
      const key = r.client_id ?? `cat:${r.category}`;
      let sc = byKey.get(key);
      if (!sc) {
        sc = {
          key,
          name: r.client?.name ?? CATEGORY_LABEL[r.category] ?? String(r.category ?? "—"),
          clientId: r.client_id ?? null,
          category: r.client_id ? null : r.category,
          halves: { 1: null, 2: null },
          legacyAt: null,
          frozen: frozenKeys.has(key),
        };
        byKey.set(key, sc);
      }
      return sc;
    };
    for (const r of (hv.data ?? []) as any[]) scopeFor(r).halves[r.half as Half] = r as HalfRow;
    for (const r of (legacy.data ?? []) as any[]) scopeFor(r).legacyAt = r.verified_at;
    setScopes([...byKey.values()].sort((a, b) => a.name.localeCompare(b.name)));
    setLoading(false);
  }, [period]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSendBack(null); setRemarksFor(null); setNotice(null); }, [month, tab]);

  const matches = (s: Scope) => !search.trim() || s.name.toLowerCase().includes(search.trim().toLowerCase());
  const reviewScopes = scopes.filter((s) => !s.legacyAt && (inReview(s.halves[1]) || inReview(s.halves[2])) && matches(s));
  const verifiedScopes = scopes.filter((s) => (s.legacyAt || opsDone(s.halves[1]) || opsDone(s.halves[2])) && matches(s));
  const visible = tab === "review" ? reviewScopes : verifiedScopes;

  const act = async (s: Scope, halves: Half[], action: "ops_verify" | "return_to_hr" | "undo_ops", note?: string) => {
    setBusyKey(s.key);
    setNotice(null);
    const { error: e } = await supabase.rpc("attendance_halves_action", {
      p_client_id: s.clientId,
      p_category: s.clientId ? null : s.category,
      p_period_month: period,
      p_halves: halves,
      p_action: action,
      p_note: note ?? null,
    });
    setBusyKey(null);
    if (e) { setNotice({ kind: "err", text: `${s.name}: ${e.message}` }); return; }
    const what = halves.length === 2 ? "both halves" : `the ${halves[0] === 1 ? "1st" : "2nd"} half`;
    setNotice({
      kind: "ok",
      text: action === "ops_verify"
        ? `${s.name}: ${what} Ops-verified.`
        : action === "return_to_hr"
          ? `${s.name}: ${what} sent back to HR with your remark.`
          : `${s.name}: ${what} moved back to Review.`,
    });
    setSendBack(null);
    setSendNote("");
    await load();
  };

  const shiftMonth = (delta: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  return (
    <>
      <Header
        title="Attendance Run"
        subtitle="HR-verified halves wait in Review for Ops, who verify them or send them back to HR"
        actions={
          <div className="flex items-center gap-1">
            <button onClick={() => shiftMonth(-1)} className="p-1.5 rounded hover:bg-accent" title="Previous month"><ChevronLeft className="w-4 h-4" /></button>
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="px-3 py-2 border border-border bg-card rounded-md text-sm text-foreground" />
            <button onClick={() => shiftMonth(1)} className="p-1.5 rounded hover:bg-accent" title="Next month"><ChevronRight className="w-4 h-4" /></button>
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" /><div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <Tabs
            value={tab}
            onChange={(v) => setTab(v as typeof tab)}
            items={[
              { value: "review", label: "Review", count: scopes.filter((s) => !s.legacyAt && (inReview(s.halves[1]) || inReview(s.halves[2]))).length },
              { value: "verified", label: "Ops Verify", count: scopes.filter((s) => s.legacyAt || opsDone(s.halves[1]) || opsDone(s.halves[2])).length },
            ]}
          />
          <div className="relative sm:ml-auto sm:w-72">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients…"
              className="w-full pl-10 pr-3 py-2 border border-border bg-card rounded-md text-sm text-foreground" />
          </div>
        </div>

        {notice && (
          <div className={`flex items-start gap-2 px-3 py-2 rounded-md text-sm ${notice.kind === "ok" ? "bg-success-50 text-success-700 border border-success-200 dark:bg-success-900/20 dark:text-success-400" : "bg-danger-50 text-danger-700 border border-danger-200"}`}>
            {notice.kind === "ok" ? <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
            <span className="flex-1">{notice.text}</span>
            <button onClick={() => setNotice(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        {!canOps && (
          <p className="text-xs text-muted-foreground">You can see the run, but verifying or sending back needs the "OPS-verify" attendance permission.</p>
        )}

        {loading ? (
          <div className="bg-card border border-border rounded-lg px-4 py-10 text-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-card border border-border rounded-lg px-4 py-10 text-center text-sm text-muted-foreground">
            {tab === "review"
              ? "Nothing waiting for Ops. A half appears here once HR verifies it on the Monthly board."
              : "Nothing Ops-verified for this month yet."}
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map((s) => {
              const reviewHalves = ([1, 2] as Half[]).filter((h) => inReview(s.halves[h]));
              const verifiedHalves = ([1, 2] as Half[]).filter((h) => opsDone(s.halves[h]));
              const busy = busyKey === s.key;
              const canAct = canOps && !s.frozen && !s.legacyAt;
              return (
                <div key={s.key} className="bg-card border border-border rounded-lg">
                  <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border">
                    <p className="text-sm font-medium text-foreground flex-1 min-w-0 truncate">{s.name}</p>
                    {s.frozen && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-warning-700 dark:text-warning-500" title="Payroll for this month has moved past Draft">
                        <Lock className="w-3 h-3" /> Payroll in progress — frozen
                      </span>
                    )}
                    {tab === "review" && canAct && reviewHalves.length === 2 && (
                      <>
                        <Button size="sm" variant="primary" disabled={busy} onClick={() => act(s, [1, 2], "ops_verify")}>
                          {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-1.5" />} Verify whole month
                        </Button>
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setSendNote(""); setSendBack({ key: s.key, halves: [1, 2] }); }}>
                          <RotateCcw className="w-4 h-4 mr-1.5" /> Send whole month back
                        </Button>
                      </>
                    )}
                    {tab === "verified" && canAct && verifiedHalves.length === 2 && (
                      <Button size="sm" variant="secondary" disabled={busy}
                        onClick={() => { if (window.confirm(`Move both halves of ${s.name} back to Review?`)) void act(s, [1, 2], "undo_ops"); }}>
                        <Undo2 className="w-4 h-4 mr-1.5" /> Move month back to Review
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setBoardFor(s)}>
                      <ExternalLink className="w-4 h-4 mr-1.5" /> Open board
                    </Button>
                  </div>

                  <div className="divide-y divide-border">
                    {([1, 2] as Half[]).map((h) => {
                      const r = s.halves[h];
                      const state = s.legacyAt
                        ? { tone: "text-success-700 dark:text-success-500", text: `Verified under the old monthly process · ${when(s.legacyAt)}` }
                        : r?.ops_verified_at
                          ? { tone: "text-success-700 dark:text-success-500", text: `Ops verified${r.ops_verified_by_name ? ` by ${r.ops_verified_by_name}` : ""} · ${when(r.ops_verified_at)}` }
                          : r?.hr_verified_at
                            ? { tone: "text-brand-700 dark:text-brand-300", text: "In Review — waiting on Ops" }
                            : { tone: "text-muted-foreground", text: "Waiting on HR" };
                      return (
                        <div key={h} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          <span className="text-sm text-foreground w-36 shrink-0">
                            {h === 1 ? "1st" : "2nd"} half <span className="text-muted-foreground tabular-nums">{halfLabels[h]}</span>
                          </span>
                          <span className="flex-1 min-w-0 text-xs">
                            <span className={state.tone}>
                              {(r?.ops_verified_at || s.legacyAt) && <CheckCircle2 className="w-3.5 h-3.5 inline -mt-0.5 mr-1" />}
                              {state.text}
                            </span>
                            {r?.hr_verified_at && (
                              <span className="block text-muted-foreground">
                                HR verified{r.hr_verified_by_name ? ` by ${r.hr_verified_by_name}` : ""} · {when(r.hr_verified_at)}
                              </span>
                            )}
                          </span>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {tab === "review" && canAct && inReview(r) && (
                              <>
                                <Button size="sm" variant={reviewHalves.length === 2 ? "secondary" : "primary"} disabled={busy} onClick={() => act(s, [h], "ops_verify")}>
                                  <ShieldCheck className="w-4 h-4 mr-1.5" /> Verify
                                </Button>
                                <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setSendNote(""); setSendBack({ key: s.key, halves: [h] }); }}>
                                  <RotateCcw className="w-4 h-4 mr-1.5" /> Send back
                                </Button>
                              </>
                            )}
                            {tab === "verified" && canAct && opsDone(r) && (
                              <Button size="sm" variant="secondary" disabled={busy}
                                onClick={() => { if (window.confirm(`Move the ${h === 1 ? "1st" : "2nd"} half of ${s.name} back to Review?`)) void act(s, [h], "undo_ops"); }}>
                                <Undo2 className="w-4 h-4 mr-1.5" /> Back to Review
                              </Button>
                            )}
                            <Button size="sm" variant="ghost"
                              onClick={() => setRemarksFor((cur) => (cur?.key === s.key && cur.half === h ? null : { key: s.key, half: h }))}>
                              <MessageSquare className="w-4 h-4" />
                            </Button>
                          </div>

                          {sendBack?.key === s.key && sendBack.halves.includes(h) && sendBack.halves[0] === h && (
                            <div className="basis-full rounded-md border border-warning-300 bg-warning-50 dark:bg-warning-900/20 p-2.5 space-y-2">
                              <p className="text-xs text-warning-900 dark:text-warning-300">
                                Send {sendBack.halves.length === 2 ? "the whole month" : `the ${h === 1 ? "1st" : "2nd"} half`} back to HR. Its days unlock for corrections, and
                                your remark is posted to the board so HR sees what to fix.
                              </p>
                              <textarea
                                autoFocus
                                rows={2}
                                value={sendNote}
                                onChange={(e) => setSendNote(e.target.value)}
                                placeholder="e.g. Ali Raza is absent on 4 Oct but was on approved leave"
                                className="w-full px-2.5 py-1.5 border border-border rounded-md text-sm bg-card"
                              />
                              <div className="flex justify-end gap-2">
                                <Button size="sm" variant="secondary" onClick={() => setSendBack(null)} disabled={busy}>Cancel</Button>
                                <Button size="sm" variant="primary" disabled={busy || !sendNote.trim()} onClick={() => act(s, sendBack.halves, "return_to_hr", sendNote)}>
                                  {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-1.5" />} Send back to HR
                                </Button>
                              </div>
                            </div>
                          )}

                          {remarksFor?.key === s.key && remarksFor.half === h && (
                            <div className="basis-full rounded-md border border-border bg-secondary/30 p-3 max-h-[40dvh] overflow-auto">
                              <BoardRemarks clientId={s.clientId} category={s.category} month={month} half={h} halfLabel={halfLabels[h]} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {boardFor && (
        <AttendanceSheetModal
          clientId={boardFor.clientId ?? `cat:${boardFor.category}`}
          clientName={boardFor.name}
          initialMonth={month}
          companyId={company?.id ?? null}
          canHrVerify={canHr}
          currentUserId={profile?.id ?? null}
          currentUserRole={profile?.role ?? null}
          onClose={() => { setBoardFor(null); void load(); }}
        />
      )}
    </>
  );
}
