import { useRouter } from "expo-router";
import { CalendarDays, ChevronLeft, ChevronRight, Download, FileSpreadsheet, FileText, Grid3x3, Users } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Card, Empty, IconBtn, RecordCard, Row, SearchBar, Section, StatGrid, Strength, Tabs, tap } from "../../components/ui";
import type { Shift } from "../../data/seed";
import { TODAY } from "../../data/seed";
import { clientName, siteName, useDB } from "../../data/store";
import { BoardRow, dismissVacancy, downloadMonthlyBoard, loadDayBoard, loadMonthlyBoard } from "../../data/api/attendance";
import { exportBoardClientSheet, exportBoardGuardSheet } from "../../data/api/exports";
import { useAuth } from "../../lib/auth";
import { addDays, fmtDay, fmtShort } from "../../lib/format";
import { inRegion, useRegion } from "../../lib/region";
import { LanguageToggle, tr, useLang } from "../../lib/lang";
import { useTheme } from "../../theme/ThemeProvider";
import { radius } from "../../theme/tokens";
import { EmpAction, EmployeeActionSheets } from "../employees/actions";
import { BulkMarkSheet } from "./BulkMark";

export const SHIFT_LABEL: Record<Shift, string> = { day: "Day", night: "Night", evening: "Evening" };
const shiftLabel = (s: string) => tr(SHIFT_LABEL[s as Shift] ?? s);

/** AttendanceBoard: the day's client-shift rows, read as they stood ON that date. */
export default function Attendance() {
  const t = useTheme();
  useLang();
  const router = useRouter();
  const { db, v, act } = useDB();
  const { can, canAny } = useAuth();
  const { regionId } = useRegion();
  const { toast } = useOverlay();
  const [tab, setTab] = useState<"board" | "vacancies" | "shifts">("board");
  const [date, setDate] = useState(TODAY);
  const [clientF, setClientF] = useState("");
  const [q, setQ] = useState("");
  const [bulk, setBulk] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const canShifts = canAny(["assignments.hr", "employees.edit"]);

  const load = useCallback(async () => {
    setErr(null);
    try { setRows(await loadDayBoard(date)); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [date]);
  // Re-read when the date changes and after any write elsewhere (v bumps on reload).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-change, as the web screen does
  useEffect(() => { setRows(null); void load(); }, [load, v]);

  const visible = useMemo(() => (rows ?? []).filter((r) =>
    inRegion(regionId, r.branch_id) && (!clientF || r.client_id === clientF) &&
    (!q || (r.site_name + r.client_name).toLowerCase().includes(q.toLowerCase()))), [rows, regionId, clientF, q]);
  const byClient = useMemo(() => {
    const m = new Map<string, BoardRow[]>();
    for (const r of visible) m.set(r.client_id, [...(m.get(r.client_id) ?? []), r]);
    return [...m.entries()];
  }, [visible]);
  const exceptionsOf = (r: BoardRow) => [...r.marks.values()].filter((m) => m.status === "absent" || m.status === "leave").length;
  const totals = {
    confirmed: visible.filter((r) => r.confirmation).length,
    onGround: visible.reduce((a, r) => a + r.roster.length - exceptionsOf(r), 0),
    exceptions: visible.reduce((a, r) => a + exceptionsOf(r), 0),
    awaiting: visible.filter((r) => !r.confirmation).length,
  };
  const vacancies = db.vacancies.filter((x) => inRegion(regionId, db.clients.find((c) => c.id === x.client_id)?.branch_id));
  const exportClient = clientF ? db.clients.find((c) => c.id === clientF) : null;

  const runExport = async (fn: () => Promise<unknown>) => {
    setExportOpen(false);
    try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : String(e), "danger"); }
  };

  return (
    <Screen
      region
      eyebrow={tr("Workforce")}
      title={tr("Attendance")}
      actions={
        <>
          <LanguageToggle />
          {can("attendance.bulk_mark") && <IconBtn icon={CalendarDays} label={tr("Bulk Mark by Employee")} onPress={() => setBulk(true)} />}
          <IconBtn icon={Download} label={tr("Export")} onPress={() => setExportOpen(true)} />
        </>
      }
      sticky={
        <Tabs value={tab} onChange={setTab} items={[
          { key: "board", label: tr("Daily board") },
          { key: "vacancies", label: tr("Vacancies"), count: vacancies.length },
          ...(canShifts ? [{ key: "shifts" as const, label: tr("Shift Management") }] : []),
        ]} />
      }
    >
      {tab === "board" && (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <IconBtn icon={ChevronLeft} label={tr("Previous day")} onPress={() => setDate(addDays(date, -1))} />
            <Pressable onPress={() => { tap(); setDate(TODAY); }} style={{ flex: 1, height: 40, borderRadius: radius.lg, backgroundColor: t.card, borderWidth: 1, borderColor: t.border, alignItems: "center", justifyContent: "center" }}>
              <T v="smallStrong" style={{ fontSize: 14 }}>{date === TODAY ? `${tr("Today")} · ${fmtDay(date)}` : fmtDay(date)}</T>
            </Pressable>
            <IconBtn icon={ChevronRight} label={tr("Next day")} onPress={() => date < TODAY && setDate(addDays(date, 1))} />
          </View>
          {err ? <Banner tone="danger" title={tr("Couldn't load the board")} sub={err} /> : !rows ? <ActivityIndicator color={t.brand[500]} style={{ marginVertical: 30 }} /> : (
            <>
              <StatGrid items={[
                { label: tr("Confirmed"), value: `${totals.confirmed}/${visible.length}`, tone: totals.confirmed === visible.length ? "success" : "brand", hint: tr("shifts") },
                { label: tr("On ground"), value: String(totals.onGround), tone: "success" },
                { label: tr("Exceptions"), value: String(totals.exceptions), tone: totals.exceptions ? "danger" : "neutral", hint: tr("absent or on leave") },
                { label: tr("Awaiting"), value: String(totals.awaiting), tone: totals.awaiting ? "warning" : "neutral", hint: tr("not confirmed") },
              ]} />
              <View style={{ marginTop: 12 }}><SearchBar value={q} onChange={setQ} placeholder={tr("Site or client")} /></View>
              <View style={{ marginTop: 8 }}>
                <Select compact clearable label={tr("Client")} value={clientF} onChange={setClientF} placeholder={tr("All Clients")} options={db.clients.filter((c) => c.status === "active").map((c) => ({ value: c.id, label: c.name }))} />
              </View>

              {byClient.map(([cid, list]) => {
                const done = list.filter((r) => r.confirmation).length;
                return (
                  <Section key={cid} title={list[0]!.client_name} count={`${done}/${list.length}`}
                    action={<T v="smallStrong" color={t.tone("brand").text} onPress={() => router.push(`/attendance/monthly/${cid}`)}>{tr("Monthly")}</T>}>
                    {list.map((r) => {
                      const ex = exceptionsOf(r);
                      return (
                        <Pressable key={r.key}
                          onPress={() => { tap(); router.push(`/attendance/site/${r.group_key}?shift=${r.shift_code}&date=${date}&client=${r.client_id}&site=${r.site_id ? 1 : 0}&n=${r.contracted}`); }}
                          style={({ pressed }) => ({
                            backgroundColor: pressed ? t.muted : t.card, borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, padding: 14, marginBottom: 8,
                            borderLeftWidth: 4, borderLeftColor: r.confirmation ? t.tone("success").solid : t.tone("warning").solid,
                          })}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                            <View style={{ flex: 1 }}>
                              <T v="bodyStrong" numberOfLines={1}>{r.site_id ? r.site_name : tr("All sites")}</T>
                              <T v="small" muted>{tr("{shift} shift", { shift: shiftLabel(r.shift_code) })}{r.confirmation ? ` · ${tr("by {names}", { names: r.confirmation.supervisor_name })}` : ""}</T>
                            </View>
                            <Badge label={r.confirmation ? tr("Confirmed") : r.marks.size ? tr("Reported") : tr("Awaiting")} tone={r.confirmation ? "success" : r.marks.size ? "info" : "warning"} dot />
                          </View>
                          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12, gap: 12 }}>
                            <View style={{ flex: 1 }}><Strength contracted={r.contracted} deployed={r.roster.length} exceptions={ex} /></View>
                            <T v="mono" style={{ fontSize: 13 }}>
                              <T v="mono" color={t.tone("success").text} style={{ fontSize: 13 }}>{r.roster.length - ex}</T>
                              <T v="mono" muted style={{ fontSize: 13 }}>/{r.contracted}</T>
                            </T>
                          </View>
                          {ex > 0 || r.roster.length < r.contracted ? (
                            <T v="small" color={t.tone("danger").text} style={{ marginTop: 8 }}>
                              {[ex ? tr(ex > 1 ? "{n} exceptions" : "{n} exception", { n: ex }) : "", r.roster.length < r.contracted ? tr("{n} unfilled", { n: r.contracted - r.roster.length }) : ""].filter(Boolean).join(" · ")}
                            </T>
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </Section>
                );
              })}
              {byClient.length === 0 && <Empty icon={Grid3x3} title={tr("No shifts match")} />}
            </>
          )}
        </>
      )}

      {tab === "vacancies" && (
        <>
          <T v="small" muted style={{ marginBottom: 12 }}>{tr("Open vacancies drive recruitment — the client is still contracted for that strength.")}</T>
          {vacancies.map((x) => (
            <RecordCard key={x.id} title={x.reason} subtitle={`${clientName(db, x.client_id)}${x.site_id ? ` · ${siteName(db, x.site_id)}` : ""}`}
              badge={<Badge label={shiftLabel(x.shift)} tone="info" small />} accent="warning"
              fields={[{ label: tr("Opened"), value: fmtShort(x.opened) }, { label: tr("Open for"), value: tr("{n} days", { n: Math.max(0, Math.round((Date.parse(TODAY) - Date.parse(x.opened)) / 864e5)) }) }]}
              actions={can("attendance.edit") ? [{ label: tr("Dismiss"), onPress: () => { void act(() => dismissVacancy(x.id), tr("Vacancy dismissed")); } }] : undefined} />
          ))}
          {vacancies.length === 0 && <Empty icon={Users} title={tr("No open vacancies.")} sub={tr("Every contracted slot is posted.")} />}
        </>
      )}

      {tab === "shifts" && canShifts && <ShiftManagement />}

      <BulkMarkSheet open={bulk} onClose={() => setBulk(false)} />

      <Sheet open={exportOpen} onClose={() => setExportOpen(false)} title={tr("Export")} subtitle={fmtDay(date)}>
        <Row title={tr("Per-client sheet (PDF)")} subtitle={tr("Every client-shift for the day, for client submission")} right={<FileText size={18} color={t.mutedFg} />}
          onPress={() => runExport(() => exportBoardClientSheet(db.company.id, date, visible))} />
        <Row title={tr("Per-guard sheet (PDF)")} subtitle={tr("One row per rostered guard, for payroll")} right={<FileText size={18} color={t.mutedFg} />}
          onPress={() => runExport(() => exportBoardGuardSheet(db.company.id, date, visible))} />
        <Row last title={tr("Monthly attendance (Excel)")} subtitle={exportClient ? `${exportClient.name} · ${date.slice(0, 7)}` : tr("Pick a client in the filter first")} right={<FileSpreadsheet size={18} color={t.mutedFg} />}
          onPress={() => exportClient ? runExport(async () => downloadMonthlyBoard(await loadMonthlyBoard(exportClient.id, null, date.slice(0, 7)), exportClient.name)) : toast(tr("Pick a client in the filter first"), "info")} />
      </Sheet>
    </Screen>
  );
}

/** Shift management: each change is a dated posting change (change_guard_shift), via the same sheet as the profile. */
function ShiftManagement() {
  useLang();
  const { db } = useDB();
  const { regionId } = useRegion();
  const [target, setTarget] = useState<string | null>(null);
  const clients = db.clients.filter((c) => c.status === "active" && inRegion(regionId, c.branch_id));
  const e = db.employees.find((x) => x.id === target) ?? null;
  const [action, setAction] = useState<EmpAction>(null);
  return (
    <>
      <T v="small" muted style={{ marginBottom: 4 }}>{tr("Move a guard between shifts. The change is dated, so past attendance stays on the old shift.")}</T>
      {clients.map((c) => {
        const staff = db.employees.filter((x) => x.client_id === c.id && x.lifecycle === "active");
        if (!staff.length) return null;
        return (
          <Section key={c.id} title={c.name} count={staff.length}>
            <Card pad={0}>
              {staff.map((x, i) => (
                <Row key={x.id} last={i === staff.length - 1} title={x.name} subtitle={`${x.code} · ${siteName(db, x.site_id)}`}
                  right={<Badge label={shiftLabel(x.shift)} tone="info" small />} onPress={() => { setTarget(x.id); setAction("shift"); }} />
              ))}
            </Card>
          </Section>
        );
      })}
      <EmployeeActionSheets e={e} action={action} onClose={() => { setAction(null); setTarget(null); }} />
    </>
  );
}
