import { useLocalSearchParams } from "expo-router";
import { BadgeCheck, Download, Undo2 } from "lucide-react-native";
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
  clearAttendanceDay, clearAttendanceMonth, downloadMonthlyBoard, loadMonthlyBoard, MonthlyBoard as Board, opsUnverify, opsVerify, overrideCell,
} from "../../data/api/attendance";
import { useAuth } from "../../lib/auth";
import { fmtMonth } from "../../lib/format";
import { useTheme } from "../../theme/ThemeProvider";
import { radius } from "../../theme/tokens";

const TONE: Record<string, "success" | "danger" | "warning" | "info" | "neutral"> = { P: "success", A: "danger", L: "warning", DD: "info", X: "neutral" };
type Target = { empId: string; empName: string; date: string; current: string; shift: string; presentOnly: boolean; otherShifts: string[] };

/**
 * The Monthly Board, built by the web's own sheet pipeline (lib/web/attendanceSheet):
 * only supervisor-confirmed marks show, unconfirmed days flag red and block OPS
 * Verify. The phone renders one card per guard instead of the 93-column grid.
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
  const client = db.clients.find((c) => c.id === clientId);
  const canOps = can("attendance.ops_verify");

  const load = useCallback(async () => {
    if (!clientId) return;
    setBoard(null); setErr(null);
    try { setBoard(await loadMonthlyBoard(clientId, siteF === "all" ? null : siteF, month)); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [clientId, siteF, month]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-change, as the web screen does
  useEffect(() => { void load(); }, [load]);

  if (!client) return <Screen title="Monthly board"><Empty title="Client not found" /></Screen>;
  const sites = db.sites.filter((s) => s.client_id === client.id);
  const locked = !!board?.verifiedAt;
  const guards = board?.rows.filter((r) => !r.isReliever) ?? [];
  const totals = guards.reduce((a, r) => ({ p: a.p + r.presents, a: a.a + r.absents, l: a.l + r.leaves, dd: a.dd + r.doubleDuties }), { p: 0, a: 0, l: 0, dd: 0 });

  const runOp = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    const done = await act(fn, ok);
    setBusy(false);
    if (done) { setTarget(null); setReason(""); await load(); }
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
          {canOps && (locked ? (
            <Button label="Un-verify" icon={Undo2} variant="secondary" full loading={busy} onPress={async () => {
              if (await confirm({ title: "Un-verify this month?", message: "Attendance edits will be unlocked again. The override audit log is kept.", confirmLabel: "Un-verify", tone: "danger" })) {
                await runOp(() => opsUnverify(client.id, month, board), "OPS verification removed");
              }
            }} />
          ) : (
            <Button label="OPS verify" icon={BadgeCheck} full loading={busy} onPress={async () => {
              if (await confirm({ title: `Verify ${fmtMonth(month)}?`, message: "Locks this client's attendance for the month. Payroll uses it as the source of truth.", confirmLabel: "Verify" })) {
                await runOp(() => opsVerify(client.id, month, board), "Month OPS-Verified. Attendance for this client is now locked for the month.");
              }
            }} />
          ))}
        </>
      ) : undefined}
    >
      <MonthStepper month={month} onChange={setMonth} />
      {sites.length > 1 && (
        <View style={{ marginTop: 12 }}>
          <Chips value={siteF} onChange={setSiteF} items={[{ key: "all", label: "All sites" }, ...sites.map((s) => ({ key: s.id, label: s.name }))]} />
        </View>
      )}
      {err ? <Banner tone="danger" title="Couldn't load the board" sub={err} /> : !board ? <ActivityIndicator color={t.brand[500]} style={{ marginTop: 30 }} /> : (
        <>
          <View style={{ marginTop: 12 }}>
            {locked
              ? <Banner tone="success" title="OPS verified" sub="Locked for payroll. Un-verify to correct a mark." />
              : board.outstanding.length
                ? <Banner tone="warning" title={`${board.outstanding.length} day(s) not confirmed`} sub="Red days are unconfirmed and block OPS Verify. Confirm them on the daily board." />
                : <Banner tone="info" title="Not yet verified" sub={board.monthEnded ? "Every day is accounted for. Ready to verify." : "Verify becomes available once the month has ended."} />}
          </View>
          <StatGrid cols={2} items={[
            { label: "Present", value: String(totals.p), tone: "success" },
            { label: "Absent", value: String(totals.a), tone: "danger" },
            { label: "Leave", value: String(totals.l), tone: "warning" },
            { label: "Double duty", value: String(totals.dd), tone: "info" },
          ]} />
          {board.monthEnded && !locked && canOps && <T v="small" muted style={{ marginTop: 10 }}>Tap a day to override it. Every override needs a reason and is kept in the audit log.</T>}

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
                    const editable = canOps && !!row.empId && !relDay && board.monthEnded && !locked && (st !== "" || !flagged) && st !== "X";
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
                  <Badge small label={`L ${row.leaves}`} tone="warning" />
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
            clientId: client.id, empId: target.empId, date: target.date, shift: target.shift, current: target.current, status, presentOnly: target.presentOnly, reason, locked, profile,
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
              <Button size="sm" variant="ghost" label="Clear this day" disabled={!reason.trim()} onPress={() => runOp(() => clearAttendanceDay(target.empId, target.date, reason, locked), "Day cleared")} />
              <Button size="sm" variant="ghost" label="Clear whole month" disabled={!reason.trim()} onPress={async () => {
                if (await confirm({ title: `Clear all of ${target.empName}'s marks?`, message: "Every day of the month goes back to unmarked. This cannot be undone.", confirmLabel: "Clear month", tone: "danger" })) {
                  await runOp(() => clearAttendanceMonth(target.empId, month, reason, locked), "Month cleared");
                }
              }} />
            </View>
            <View style={{ height: 4, borderRadius: radius.sm }} />
          </>
        )}
      </Sheet>
    </Screen>
  );
}
