import { useLocalSearchParams } from "expo-router";
import { BadgeCheck, CornerDownRight, Download, MessageSquare, RotateCcw, Undo2 } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { MonthStepper } from "../../components/MonthGrid";
import { Screen } from "../../components/Screen";
import { Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Chips, Empty, Input, Section, StatGrid } from "../../components/ui";
import { THIS_MONTH } from "../../data/seed";
import { useDB } from "../../data/store";
import {
  BoardRemark, clearAttendanceDay, clearAttendanceMonth, downloadMonthlyBoard, halfAction, HalfAction, halfRange, loadBoardRemarks,
  loadMonthlyBoard, MonthlyBoard as Board, overrideCell, postBoardRemark,
} from "../../data/api/attendance";
import { useAuth } from "../../lib/auth";
import { fmtMonth } from "../../lib/format";
import { useTheme } from "../../theme/ThemeProvider";
import { radius } from "../../theme/tokens";

const TONE: Record<string, "success" | "danger" | "warning" | "info" | "neutral"> = { P: "success", A: "danger", L: "warning", DD: "info", X: "neutral" };
type Target = { empId: string; empName: string; date: string; current: string; shift: string; presentOnly: boolean; otherShifts: string[] };

/**
 * The Monthly Board, built by the web's own sheet pipeline (lib/web/attendanceSheet):
 * only supervisor-confirmed marks show, unconfirmed days flag red and block HR
 * Verify. The phone renders one card per guard instead of the 93-column grid.
 *
 * Since 0493 it is two boards, one per half-month, each verified HR -> Ops ->
 * Finance, with one remarks thread per half. Same rules as the web board
 * (components/HalfMonthReview); the database enforces all of them.
 */
export default function MonthlyBoard() {
  const t = useTheme();
  const { clientId } = useLocalSearchParams<{ clientId: string }>();
  const { db, act } = useDB();
  const { can, profile } = useAuth();
  const { toast, confirm } = useOverlay();
  const [month, setMonth] = useState(THIS_MONTH);
  const [siteF, setSiteF] = useState<string>("all");
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [status, setStatus] = useState<"present" | "absent" | "leave">("present");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [half, setHalf] = useState<"1" | "2">("1");
  const [returning, setReturning] = useState<null | "return_to_hr">(null);
  const [returnNote, setReturnNote] = useState("");
  const [remarks, setRemarks] = useState<BoardRemark[]>([]);
  const [remarksOpen, setRemarksOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<BoardRemark | null>(null);
  const client = db.clients.find((c) => c.id === clientId);
  const canHr = can("attendance.hr_verify");
  const canOps = can("attendance.ops_verify");
  // Who may correct a day by override: the same people as before, plus HR, who
  // now owns the first sign-off.
  const canOverride = canOps || canHr;
  const h = Number(half) as 1 | 2;

  const load = useCallback(async () => {
    if (!clientId) return;
    setBoard(null); setErr(null);
    try {
      const [b, r] = await Promise.all([
        loadMonthlyBoard(clientId, siteF === "all" ? null : siteF, month, h),
        loadBoardRemarks(clientId, month, h),
      ]);
      setBoard(b); setRemarks(r);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [clientId, siteF, month, h]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-change, as the web screen does
  useEffect(() => { void load(); }, [load]);

  if (!client) return <Screen title="Monthly board"><Empty title="Client not found" /></Screen>;
  const sites = db.sites.filter((s) => s.client_id === client.id);
  const locked = !!board?.locked;
  const guards = board?.rows.filter((r) => !r.isReliever) ?? [];
  // The grid shows the whole month; the half switch only picks which half's
  // verification and remarks are shown. A day is locked if its half is.
  const totals = guards.reduce((a, r) => ({ p: a.p + r.presents, a: a.a + r.absents, l: a.l + r.leaves, dd: a.dd + r.doubleDuties }), { p: 0, a: 0, l: 0, dd: 0 });
  const dayLocked = (i: number) => !!board && board.lockedHalves[i < board.halfCut ? 1 : 2];
  const dateLocked = (iso: string) => dayLocked(Number(iso.slice(8, 10)) - 1);
  const anyUnlocked = !!board && (!board.lockedHalves[1] || !board.lockedHalves[2]);

  // The chain. A legacy monthly verification counts as all three stages done.
  const legacy = board?.verifiedAt ?? null;
  const v = board?.halfVer ?? null;
  const stages = [
    { key: "hr", label: "HR", at: legacy ?? v?.hr_verified_at ?? null, by: legacy ? null : v?.hr_verified_by_name ?? null },
    { key: "ops", label: "Ops", at: legacy ?? v?.ops_verified_at ?? null, by: legacy ? null : v?.ops_verified_by_name ?? null },
  ] as const;
  const current = stages.find((st) => !st.at)?.key ?? "done";
  const frozen = !!board?.runPhase;
  const ranges = { "1": halfRange(month, 1), "2": halfRange(month, 2) };

  // What this user can do now. Primary action first.
  const actions: { key: string; label: string; icon: typeof BadgeCheck; variant: "primary" | "secondary"; run: () => void }[] = [];
  const doAction = (a: HalfAction, ok: string, note?: string) => board && client && runOp(() => halfAction(client.id, month, board, a, note), ok);
  if (board && !legacy && !frozen) {
    if (current === "hr" && canHr) actions.push({ key: "hr", label: "HR verify", icon: BadgeCheck, variant: "primary", run: async () => {
      if (await confirm({ title: `HR verify ${board.halfLabel}?`, message: "Locks this half's attendance and passes it to Ops.", confirmLabel: "Verify" })) doAction("hr_verify", "HR verified — locked and with Ops");
    } });
    if (current === "ops" && canOps) {
      actions.push({ key: "ops", label: "Ops verify", icon: BadgeCheck, variant: "primary", run: () => doAction("ops_verify", "Ops verified — this half is complete") });
      actions.push({ key: "ret_hr", label: "Send back to HR", icon: RotateCcw, variant: "secondary", run: () => { setReturnNote(""); setReturning("return_to_hr"); } });
    }
    if (current === "ops" && canHr && !canOps) actions.push({ key: "undo_hr", label: "Withdraw HR", icon: Undo2, variant: "secondary", run: () => doAction("undo_hr", "HR verification withdrawn") });
    // 0494: the chain is HR -> Ops; Finance acts only in the payroll run.
    if (current === "done" && canOps) actions.push({ key: "undo_ops", label: "Back to Review", icon: Undo2, variant: "secondary", run: () => doAction("undo_ops", "Moved back to Review") });
  }
  const threads = remarks.filter((r) => !r.parent_id).map((r) => ({ remark: r, replies: remarks.filter((x) => x.parent_id === r.id) }));
  const fmtWhen = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

  const runOp = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    const done = await act(fn, ok);
    setBusy(false);
    if (done) { setTarget(null); setReason(""); setReturning(null); setReturnNote(""); setDraft(""); setReplyTo(null); await load(); }
    return done;
  };

  return (
    <Screen
      eyebrow="Monthly board"
      title={client.name}
      subtitle={board ? `${guards.length} guards · ${fmtMonth(month)}` : fmtMonth(month)}
      footer={board ? (
        <>
          <Button label="Download" icon={Download} variant="secondary" full disabled={!board.rows.length}
            onPress={() => downloadMonthlyBoard(board, client.name).catch((e) => toast(e instanceof Error ? e.message : String(e), "danger"))} />
          {actions.slice(0, 2).map((a) => (
            <Button key={a.key} label={a.label} icon={a.icon} variant={a.variant} full loading={busy && a.variant === "primary"} disabled={busy} onPress={a.run} />
          ))}
        </>
      ) : undefined}
    >
      <MonthStepper month={month} onChange={setMonth} />
      <View style={{ marginTop: 12 }}>
        <Chips value={half} onChange={setHalf} items={[
          { key: "1", label: `Verifying 1st half · ${ranges["1"].first + 1}–${ranges["1"].last + 1}` },
          { key: "2", label: `Verifying 2nd half · ${ranges["2"].first + 1}–${ranges["2"].last + 1}` },
        ]} />
      </View>
      {sites.length > 1 && (
        <View style={{ marginTop: 12 }}>
          <Chips value={siteF} onChange={setSiteF} items={[{ key: "all", label: "All sites" }, ...sites.map((s) => ({ key: s.id, label: s.name }))]} />
        </View>
      )}
      {err ? <Banner tone="danger" title="Couldn't load the board" sub={err} /> : !board ? <ActivityIndicator color={t.brand[500]} style={{ marginTop: 30 }} /> : (
        <>
          <Card style={{ marginTop: 12 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              {stages.map((st) => (
                <Badge key={st.key} small
                  label={`${st.at ? "✓ " : ""}${st.label}${st.by ? ` · ${st.by}` : ""}`}
                  tone={st.at ? "success" : current === st.key ? "warning" : "neutral"} />
              ))}
            </View>
            <T v="small" muted style={{ marginTop: 8 }}>
              {legacy
                ? `Verified under the old monthly process · ${fmtWhen(legacy)}`
                : current === "done"
                  ? `${board.halfLabel} · fully verified`
                  : `${board.halfLabel} · waiting on ${stages.find((st) => st.key === current)!.label}${locked ? " · locked" : ""}`}
            </T>
            {frozen && !legacy && <T v="small" style={{ marginTop: 6 }} color={t.tone("warning").text}>Payroll has moved past Draft, so verification is frozen. Move payroll back to Draft to change it.</T>}
            {actions.length > 2 && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                {actions.slice(2).map((a) => <Button key={a.key} size="sm" variant="secondary" icon={a.icon} label={a.label} disabled={busy} onPress={a.run} />)}
              </View>
            )}
            <View style={{ marginTop: 10 }}>
              <Button size="sm" variant="ghost" icon={MessageSquare} label={`Remarks${remarks.length ? ` (${remarks.length})` : ""}`} onPress={() => setRemarksOpen(true)} />
            </View>
          </Card>
          {!locked && board.outstanding.length > 0 && (
            <View style={{ marginTop: 10 }}>
              <Banner tone="warning" title={`${board.outstanding.length} day(s) not confirmed in this half`} sub="Red days are unconfirmed and block HR Verify. Confirm them on the daily board." />
            </View>
          )}
          <StatGrid cols={2} items={[
            { label: "Present", value: String(totals.p), tone: "success" },
            { label: "Absent", value: String(totals.a), tone: "danger" },
            { label: "Leave", value: String(totals.l), tone: "warning" },
            { label: "Double duty", value: String(totals.dd), tone: "info" },
          ]} />
          {board.monthEnded && anyUnlocked && canOverride && <T v="small" muted style={{ marginTop: 10 }}>Tap a day to override it. Every override needs a reason and is kept in the audit log.</T>}

          <Section title="Guards" count={board.rows.length}>
            {board.rows.map((row) => (
              <Card key={`${row.empId}-${row.serial}`} style={{ marginBottom: 10 }}>
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
                  <T v="mono" muted style={{ width: 22 }}>{String(row.serial).padStart(2, "0")}</T>
                  <View style={{ flex: 1 }}>
                    <T v="smallStrong" style={{ fontSize: 15 }}>{row.name}{row.isReliever ? "  · Reliever" : ""}</T>
                    <T v="mono" muted style={{ fontSize: 11 }}>{row.empCode}{row.separationNote ? ` · ${row.separationNote}` : ""}</T>
                  </View>
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                  {Array.from({ length: board.daysInMonth }, (_, i) => {
                    const st = row.statusByDay[i] ?? "";
                    const date = `${month}-${String(i + 1).padStart(2, "0")}`;
                    const flagged = row.empId ? board.flagged.has(`${row.empId}|${i}`) : false;
                    const relDay = !!row.relieverByDay?.[i];
                    const ownShift = String(row.shiftByDay?.[i] ?? row.shift ?? "day").toLowerCase();
                    const editable = canOverride && !!row.empId && !relDay && board.monthEnded && !dayLocked(i) && (st !== "" || !flagged) && st !== "X";
                    const tn = st ? t.tone(TONE[st] ?? "neutral") : null;
                    return (
                      <Pressable key={i} disabled={!editable} onPress={() => {
                        setStatus(st === "A" ? "absent" : st === "L" ? "leave" : "present");
                        setTarget({ empId: row.empId!, empName: row.name, date, current: st === "DD" ? "P" : st, shift: ownShift, presentOnly: false, otherShifts: board.shifts.filter((s) => s !== ownShift) });
                      }}>
                        <View style={{
                          width: 25, height: 25, borderRadius: 5, alignItems: "center", justifyContent: "center", borderWidth: 1,
                          backgroundColor: flagged ? t.tone("danger").tint : relDay ? t.tone("brand").tint : tn ? tn.tint : "transparent",
                          borderColor: flagged ? t.tone("danger").line : tn ? tn.line : t.border,
                        }}>
                          <T v="mono" style={{ fontSize: 9, lineHeight: 12 }} color={tn ? tn.text : t.mutedFg}>{st || String(i + 1)}</T>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
                <View style={{ flexDirection: "row", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  <Badge small label={`P ${row.presents}`} tone="success" />
                  <Badge small label={`A ${row.absents}`} tone="danger" />
                  {row.allowedLeaves != null && <Badge small label={`Allowed L ${row.allowedLeaves}`} tone="neutral" />}
                  <Badge small label={`L taken ${row.leaves}`} tone="warning" />
                  <Badge small label={`DD ${row.doubleDuties}`} tone="info" />
                  <Badge small label={`Pay days ${row.payDays}`} tone="neutral" />
                </View>
              </Card>
            ))}
            {board.rows.length === 0 && <Empty title="No guards on this board" />}
          </Section>
        </>
      )}

      <Sheet open={!!target} onClose={() => setTarget(null)} title={`Override — ${target?.empName ?? ""}`} subtitle={target ? `${target.date} · currently ${target.current || "unmarked"}` : undefined}
        footer={<>
          <Button label="Cancel" variant="secondary" full onPress={() => setTarget(null)} />
          <Button label={target?.presentOnly ? "Add as double duty" : "Save override"} full loading={busy} disabled={!reason.trim()} onPress={() => target && profile && runOp(() => overrideCell({
            clientId: client.id, empId: target.empId, date: target.date, shift: target.shift, current: target.current, status, presentOnly: target.presentOnly, reason, locked: dateLocked(target.date), profile,
          }), "Override saved")} />
        </>}>
        {target && (
          <>
            {!target.presentOnly && <Chips value={status} onChange={setStatus} items={[{ key: "present", label: "Present" }, { key: "absent", label: "Absent" }, { key: "leave", label: "Leave" }]} />}
            {target.current === "P" && target.otherShifts.length > 0 && (
              <View style={{ marginTop: 12 }}>
                <T v="small" muted style={{ marginBottom: 6 }}>Or add a second shift worked that day (double duty):</T>
                <Chips value={target.presentOnly ? target.shift : ""} onChange={(s) => setTarget({ ...target, presentOnly: true, shift: s })} items={target.otherShifts.map((s) => ({ key: s, label: s[0]!.toUpperCase() + s.slice(1) }))} />
              </View>
            )}
            <View style={{ marginTop: 14 }}><Input label="Reason" required value={reason} onChangeText={setReason} multiline /></View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
              <Button size="sm" variant="ghost" label="Clear this day" disabled={!reason.trim()} onPress={() => runOp(() => clearAttendanceDay(target.empId, target.date, reason, dateLocked(target.date)), "Day cleared")} />
              <Button size="sm" variant="ghost" label="Clear whole month" disabled={!reason.trim()} onPress={async () => {
                if (await confirm({ title: `Clear all of ${target.empName}'s marks?`, message: "Every day of the month goes back to unmarked. This cannot be undone.", confirmLabel: "Clear month", tone: "danger" })) {
                  await runOp(() => clearAttendanceMonth(target.empId, month, reason, !!board?.lockedHalves[1] || !!board?.lockedHalves[2]), "Month cleared");
                }
              }} />
            </View>
            <View style={{ height: 4, borderRadius: radius.sm }} />
          </>
        )}
      </Sheet>

      <Sheet open={!!returning} onClose={() => setReturning(null)}
        title={returning === "return_to_hr" ? "Send back to HR" : "Send back to Ops"}
        subtitle={returning === "return_to_hr" ? "HR's verification is cleared and the half unlocks for corrections." : "Ops' verification is cleared."}
        footer={<>
          <Button label="Cancel" variant="secondary" full onPress={() => setReturning(null)} />
          <Button label="Send back" icon={RotateCcw} full loading={busy} disabled={!returnNote.trim()} onPress={() => returning && doAction(returning, returning === "return_to_hr" ? "Sent back to HR" : "Sent back to Ops", returnNote)} />
        </>}>
        <Input label="What needs fixing?" required value={returnNote} onChangeText={setReturnNote} multiline helper="Posted to this half's remarks." />
      </Sheet>

      <Sheet open={remarksOpen} onClose={() => { setRemarksOpen(false); setReplyTo(null); }} title={`Remarks · ${board?.halfLabel ?? ""}`}
        footer={<>
          <View style={{ flex: 1 }}>
            {replyTo && <T v="small" muted style={{ marginBottom: 4 }}>Replying to {replyTo.author_name ?? "Unknown"} · <T v="small" color={t.brand[600]} onPress={() => setReplyTo(null)}>cancel</T></T>}
            <Input value={draft} onChangeText={setDraft} placeholder={replyTo ? "Write a reply…" : "Add a remark…"} multiline />
            <Button label={replyTo ? "Reply" : "Post remark"} full loading={busy} disabled={!draft.trim()} onPress={() => client && runOp(() => postBoardRemark(client.id, month, h, draft, replyTo?.id ?? null), replyTo ? "Reply posted" : "Remark posted")} />
          </View>
        </>}>
        {threads.length === 0 && <T v="small" muted>No remarks on this half yet.</T>}
        {threads.map(({ remark, replies }) => (
          <View key={remark.id} style={{ marginBottom: 14 }}>
            <RemarkCard r={remark} when={fmtWhen(remark.created_at)} />
            {replies.map((rep) => (
              <View key={rep.id} style={{ flexDirection: "row", gap: 6, marginTop: 6, paddingLeft: 12 }}>
                <CornerDownRight size={14} color={t.mutedFg} style={{ marginTop: 10 }} />
                <View style={{ flex: 1 }}><RemarkCard r={rep} when={fmtWhen(rep.created_at)} /></View>
              </View>
            ))}
            <T v="small" color={t.brand[600]} style={{ marginTop: 6, paddingLeft: 12 }} onPress={() => setReplyTo(remark)}>Reply</T>
          </View>
        ))}
      </Sheet>
    </Screen>
  );
}

function RemarkCard({ r, when }: { r: BoardRemark; when: string }) {
  const t = useTheme();
  const tn = r.kind === "returned" ? t.tone("warning") : null;
  return (
    <View style={{ borderWidth: 1, borderRadius: radius.sm, padding: 10, borderColor: tn ? tn.line : t.border, backgroundColor: tn ? tn.tint : "transparent" }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <T v="smallStrong">{r.author_name ?? "Unknown"}{r.kind === "returned" ? "  · sent back" : ""}</T>
        <T v="small" muted>{when}</T>
      </View>
      <T v="small" style={{ marginTop: 4 }}>{r.body}</T>
    </View>
  );
}
