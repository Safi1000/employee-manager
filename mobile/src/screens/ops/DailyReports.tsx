import { useRouter } from "expo-router";
import { Check, ChevronLeft, ChevronRight, FileDown, Plus, ShieldAlert, Trash2 } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, HStack, IconBtn, ListCard, Row, Section, Toggle, tap } from "../../components/ui";
import { TODAY } from "../../data/seed";
import { useDB } from "../../data/store";
import {
  addDayTask, deleteDayTask, exportDailyReport, loadReportAttendance, loadReportDay, regionCut, ReportDay, saveClientNote, saveOtherUpdates, updateDayTask,
} from "../../data/api/dailyReports";
import type { AttendanceSummary } from "../../lib/web/attendanceSummary";
import { useAuth } from "../../lib/auth";
import { addDays, fmtDay, fmtShort, fmtTime } from "../../lib/format";
import { inRegion, useRegion } from "../../lib/region";
import { useTheme } from "../../theme/ThemeProvider";
import { fonts, radius } from "../../theme/tokens";

/**
 * Daily Reports (web FieldOps): one note per active client per day, the day's
 * Other Updates and Next Day Tasks, exported as the branded PDF. Only TODAY is
 * writable (web: locked = !isToday || !roster.edit); past days are read-only.
 */
export default function DailyReports() {
  const t = useTheme();
  const router = useRouter();
  const { db, act } = useDB();
  const { can, canAny } = useAuth();
  const { regionId, label: regionLabel } = useRegion();
  const { toast } = useOverlay();
  const [date, setDate] = useState(TODAY);
  const [day, setDay] = useState<ReportDay | null>(null);
  const [att, setAtt] = useState<AttendanceSummary | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [other, setOther] = useState<string | null>(null);
  const [newTask, setNewTask] = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = date !== TODAY || !can("roster.edit");
  const clients = useMemo(() => db.clients.filter((c) => c.status === "active" && inRegion(regionId, c.branch_id)), [db.clients, regionId]);

  const load = useCallback(async () => {
    setDay(null); setAtt(null); setDrafts({}); setOther(null);
    try {
      const [d, a] = await Promise.all([loadReportDay(db.company.id, date), loadReportAttendance(db.company.id, date).catch(() => null)]);
      setDay(d); setAtt(a);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), "danger"); }
  }, [db.company.id, date, toast]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-change, as the web screen does
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    const done = await act(fn, ok);
    setBusy(false);
    if (done) await load();
    return done;
  };

  const written = day ? clients.filter((c) => !day.noReport.has(c.id) && (day.details.get(c.id) ?? "").trim()).length : 0;
  const visibleAtt = att ? regionCut(att, regionId) : null;
  const staffName = (id: string | null) => (id ? day?.staff.find((x) => x.id === id)?.full_name ?? "Former staff" : "Unassigned");

  return (
    <Screen
      region
      eyebrow="Operations"
      title="Daily Reports"
      subtitle={day ? `${written} of ${clients.length} clients written for ${fmtShort(date)}` : undefined}
      actions={<IconBtn icon={FileDown} label="Export PDF" onPress={() => day && run(() => exportDailyReport({
        companyId: db.company.id, date, regionLabel: regionId ? regionLabel : null, clients, day, attendance: visibleAtt,
      }), "Daily report exported")} />}
      sticky={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <IconBtn icon={ChevronLeft} label="Previous day" onPress={() => setDate(addDays(date, -1))} />
          <Pressable onPress={() => { tap(); setDate(TODAY); }} style={{ flex: 1, height: 40, borderRadius: radius.lg, backgroundColor: t.card, borderWidth: 1, borderColor: t.border, alignItems: "center", justifyContent: "center" }}>
            <T v="smallStrong" style={{ fontSize: 14 }}>{date === TODAY ? `Today · ${fmtDay(date)}` : fmtDay(date)}</T>
          </Pressable>
          <IconBtn icon={ChevronRight} label="Next day" onPress={() => date < TODAY && setDate(addDays(date, 1))} />
        </View>
      }
    >
      {date !== TODAY && <Banner tone="info" title="Past day — read only" sub="Reports are written on the day." />}
      {visibleAtt && visibleAtt.unconfirmed.length > 0 && (
        <Banner tone="warning" title={`${visibleAtt.unconfirmed.length} client(s) not confirmed for ${fmtShort(visibleAtt.date)}`} sub="The PDF lists yesterday's attendance; unconfirmed clients are named in it." />
      )}
      {canAny(["incidents.view", "incidents.edit"]) && (
        <Card onPress={() => router.push("/incidents")} style={{ marginBottom: 4 }}>
          <HStack>
            <ShieldAlert size={18} color={t.tone("danger").text} />
            <T v="smallStrong" style={{ flex: 1, fontSize: 14 }}>{db.incidents.filter((i) => i.occurred_at.startsWith(date)).length} incidents logged this day</T>
            {can("incidents.edit") && <T v="smallStrong" color={t.tone("brand").text}>Log incident</T>}
          </HStack>
        </Card>
      )}

      {!day ? <ActivityIndicator color={t.brand[500]} style={{ marginTop: 30 }} /> : (
        <>
          {clients.map((c) => {
            const saved = day.details.get(c.id) ?? "";
            const flag = day.noReport.has(c.id);
            const draft = drafts[c.id];
            const dirty = draft !== undefined && draft !== saved;
            const summary = visibleAtt?.clients.find((x) => x.client_id === c.id);
            return (
              <Section key={c.id} title={c.name} action={flag ? <Badge label="No report" tone="neutral" small /> : saved && !dirty ? <Badge label="Written" tone="success" small /> : dirty ? <Badge label="Unsaved" tone="warning" small /> : undefined}>
                <Card>
                  {summary && (
                    <HStack gap={14} style={{ marginBottom: 10 }}>
                      <T v="small" muted>{summary.deployed} deployed</T>
                      <T v="small" color={summary.absent ? t.tone("danger").text : t.mutedFg}>{summary.absent} absent</T>
                      <T v="small" muted>{summary.leave} leave</T>
                      {!summary.confirmed && <Badge label="Unconfirmed" tone="warning" small />}
                    </HStack>
                  )}
                  <TextInput
                    multiline
                    editable={!locked && !flag}
                    value={flag ? "" : draft ?? saved}
                    onChangeText={(v) => setDrafts((x) => ({ ...x, [c.id]: v }))}
                    placeholder={flag ? "Marked as no report." : locked ? "No note written." : "Details for this client today…"}
                    placeholderTextColor={t.mutedFg}
                    style={{ minHeight: 84, color: t.fg, fontFamily: fonts.body, fontSize: 16, lineHeight: 22, textAlignVertical: "top", backgroundColor: t.input, borderRadius: radius.lg, borderWidth: 1, borderColor: dirty ? t.brand[500] : t.border, padding: 12 }}
                  />
                  {!locked && (
                    <View style={{ marginTop: 10 }}>
                      <Toggle label="No report for this client today" value={flag} onChange={(v) => { void run(() => saveClientNote(db.company.id, c.id, date, v ? "" : draft ?? saved, v)); }} />
                      {dirty && (
                        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
                          <Button size="sm" label="Discard" variant="ghost" onPress={() => setDrafts((x) => { const y = { ...x }; delete y[c.id]; return y; })} />
                          <Button size="sm" label="Save note" icon={Check} loading={busy} onPress={() => { void run(() => saveClientNote(db.company.id, c.id, date, draft!, false), "Note saved"); }} />
                        </View>
                      )}
                    </View>
                  )}
                </Card>
              </Section>
            );
          })}

          <Section title="Other updates" hint="One note for the whole report.">
            <Card>
              <TextInput multiline editable={!locked} value={other ?? day.otherUpdates} onChangeText={setOther} placeholder={locked ? "None." : "Anything that isn't about one client…"} placeholderTextColor={t.mutedFg}
                style={{ minHeight: 70, color: t.fg, fontFamily: fonts.body, fontSize: 16, lineHeight: 22, textAlignVertical: "top", backgroundColor: t.input, borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, padding: 12 }} />
              {!locked && other !== null && other !== day.otherUpdates && (
                <View style={{ marginTop: 10, flexDirection: "row", justifyContent: "flex-end" }}>
                  <Button size="sm" label="Save" icon={Check} loading={busy} onPress={() => { void run(() => saveOtherUpdates(db.company.id, date, other), "Saved"); }} />
                </View>
              )}
            </Card>
          </Section>

          <Section title="Next day tasks" count={day.tasks.length}>
            <ListCard>
              {day.tasks.map((x, i) => locked ? (
                <Row key={x.id} last={i === day.tasks.length - 1} title={x.title} subtitle={staffName(x.assignee_employee_id)} />
              ) : (
                <View key={x.id} style={{ padding: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: t.border }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <T v="bodyStrong" style={{ flex: 1 }}>{x.title}</T>
                    <Pressable hitSlop={8} onPress={() => { void run(() => deleteDayTask(x.id)); }}><Trash2 size={16} color={t.mutedFg} /></Pressable>
                  </View>
                  <Select compact clearable label="Assignee" value={x.assignee_employee_id ?? ""} placeholder="Unassigned"
                    onChange={(v) => { void run(() => updateDayTask(x.id, { assignee_employee_id: v || null })); }}
                    options={day.staff.map((s) => ({ value: s.id, label: s.full_name, sub: s.employee_code }))} />
                </View>
              ))}
              {!locked && (
                <View style={{ padding: 12, gap: 8 }}>
                  <TextInput value={newTask} onChangeText={setNewTask} placeholder="Add a task for tomorrow" placeholderTextColor={t.mutedFg}
                    style={{ color: t.fg, fontFamily: fonts.body, fontSize: 15, backgroundColor: t.input, borderRadius: radius.md, borderWidth: 1, borderColor: t.border, paddingHorizontal: 12, height: 44 }} />
                  <Select compact clearable label="Assignee" value={newAssignee} onChange={setNewAssignee} placeholder="Unassigned" options={day.staff.map((s) => ({ value: s.id, label: s.full_name, sub: s.employee_code }))} />
                  <Button size="sm" label="Add task" icon={Plus} disabled={!newTask.trim()} onPress={async () => {
                    if (await run(() => addDayTask(db.company.id, date, newTask, newAssignee || null, day.tasks))) { setNewTask(""); setNewAssignee(""); }
                  }} />
                </View>
              )}
            </ListCard>
          </Section>
        </>
      )}

      <Section title="Export history" count={db.reportExports.length}>
        <ListCard>
          {db.reportExports.slice(0, 20).map((x, i, a) => (
            <Row key={x.id} last={i === a.length - 1} title={fmtDay(x.date)} subtitle={`${x.clients} clients · by ${x.by}`} meta={`${fmtShort(x.at.slice(0, 10))} ${fmtTime(x.at)}`} />
          ))}
        </ListCard>
      </Section>
    </Screen>
  );
}

