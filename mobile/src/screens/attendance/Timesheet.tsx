import { useLocalSearchParams, useRouter } from "expo-router";
import { Download, Wallet } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { MonthGrid, MonthStepper } from "../../components/MonthGrid";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Button, Card, Chips, Empty, IconBtn, Input, ListCard, Row, SearchBar, Section, StatGrid } from "../../components/ui";
import { THIS_MONTH, TODAY } from "../../data/seed";
import { clientName, useDB } from "../../data/store";
import { bulkClear, bulkMark, BulkStatus, CalendarContext, loadCalendar, markReliever } from "../../data/api/attendance";
import { exportEmployeeTimesheet } from "../../data/api/exports";
import { useAuth } from "../../lib/auth";
import { fmtDay } from "../../lib/format";
import { useTheme } from "../../theme/ThemeProvider";

const LABEL: Record<string, { code: string; label: string; tone: "success" | "danger" | "warning" | "info" | "neutral" }> = {
  present: { code: "P", label: "Present", tone: "success" }, absent: { code: "A", label: "Absent", tone: "danger" },
  leave: { code: "L", label: "Leave", tone: "warning" }, rest_day: { code: "L", label: "Leave", tone: "warning" },
  double_duty: { code: "DD", label: "Double duty", tone: "info" }, relief_cover: { code: "RC", label: "Relief cover", tone: "info" },
};

/**
 * AttendanceManagement: one employee's month, read straight from the database
 * for any month. Correcting a day runs the same gated path as the web's
 * per-employee calendar; with `relieversOnly` it is the Relievers page, where a
 * present mark must name the site worked.
 */
export default function Timesheet({ relieversOnly }: { relieversOnly?: boolean }) {
  const t = useTheme();
  const params = useLocalSearchParams<{ employee?: string }>();
  const { db, act } = useDB();
  const { can, profile } = useAuth();
  const router = useRouter();
  const { toast } = useOverlay();
  const pool = db.employees.filter((e) => e.lifecycle === "active" && (relieversOnly ? e.category === "reliever" : e.category !== "reliever"));
  const [emp, setEmp] = useState(params.employee ?? "");
  const [month, setMonth] = useState(THIS_MONTH);
  const [day, setDay] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [ctx, setCtx] = useState<CalendarContext | null>(null);
  const [status, setStatus] = useState<BulkStatus>("present");
  const [override, setOverride] = useState("");
  const [site, setSite] = useState("");
  const [covering, setCovering] = useState("");
  const [busy, setBusy] = useState(false);
  const e = db.employees.find((x) => x.id === emp);

  const reload = useCallback(async () => {
    if (!e) return;
    setCtx(null);
    try { setCtx(await loadCalendar(e, month, db.contracts)); } catch (err) { toast(err instanceof Error ? err.message : String(err), "danger"); }
  }, [e, month, db.contracts, toast]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-change, as the web screen does
  useEffect(() => { void reload(); }, [reload]);

  if (!e) {
    const list = pool.filter((x) => !q || (x.name + x.code).toLowerCase().includes(q.toLowerCase()));
    return (
      <Screen eyebrow="Workforce" title={relieversOnly ? "Relievers" : "Attendance timesheet"} subtitle="Pick an employee to open their month.">
        <SearchBar value={q} onChange={setQ} placeholder="Name or code" />
        <ListCard style={{ marginTop: 12 }}>
          {list.slice(0, 80).map((x, i) => (
            <Row key={x.id} last={i === Math.min(list.length, 80) - 1} title={x.name} meta={`${x.code} · ${clientName(db, x.client_id)}`} onPress={() => setEmp(x.id)} />
          ))}
        </ListCard>
        {list.length === 0 && <Empty title="No one to show" />}
      </Screen>
    );
  }

  const monthDays = ctx ? [...ctx.existing.keys()].sort() : [];
  const count = (s: string[]) => monthDays.filter((d) => s.includes(ctx!.existing.get(d)!)).length;
  const canEdit = can("attendance.edit");

  const save = async (kind: "mark" | "clear") => {
    if (!day || !ctx || !profile) return;
    setBusy(true);
    let notice = "";
    const ok = await act(async () => {
      if (relieversOnly && kind === "mark") {
        if (status === "double_duty") throw new Error("Relievers are marked Present, Absent or Leave.");
        await markReliever(e, ctx, day, status, site || null, covering || null);
        notice = `${fmtDay(day)} → ${LABEL[status]!.label}`;
      } else {
        notice = kind === "mark" ? await bulkMark(e, ctx, [day], status, override, profile) : await bulkClear(e, ctx, [day], override);
      }
    });
    setBusy(false);
    if (ok) { toast(notice); setDay(null); setOverride(""); await reload(); }
  };

  return (
    <Screen
      eyebrow={relieversOnly ? "Relievers" : "Timesheet"}
      title={e.name}
      subtitle={`${e.code} · ${e.department} · ${clientName(db, e.client_id)}`}
      actions={<>
        {relieversOnly && can("payroll.view") && <IconBtn icon={Wallet} label="Reliever payroll" onPress={() => router.push("/relievers/payroll")} />}
        <IconBtn icon={Download} label="Export to Excel" onPress={() => exportEmployeeTimesheet(e, month).catch((err) => toast(err instanceof Error ? err.message : String(err), "danger"))} />
      </>}
    >
      <Select label="Employee" searchable value={emp} onChange={(v) => { setEmp(v); setDay(null); }} options={pool.map((x) => ({ value: x.id, label: x.name, sub: x.code }))} />
      <MonthStepper month={month} onChange={setMonth} />
      {!ctx ? <ActivityIndicator color={t.brand[500]} style={{ marginVertical: 24 }} /> : (
        <>
          <View style={{ marginTop: 12 }}>
            <StatGrid cols={3} items={[
              { label: "Present", value: String(count(["present", "double_duty", "relief_cover"])), tone: "success" },
              { label: "Absent", value: String(count(["absent"])), tone: "danger" },
              { label: "Leave", value: String(count(["leave", "rest_day"])), tone: "warning" },
            ]} />
          </View>
          <Card style={{ marginTop: 12 }} pad={10}>
            <MonthGrid month={month} selected={day} onPress={(d) => { if (d <= TODAY) { setDay(d); setStatus((ctx.existing.get(d) as BulkStatus) ?? "present"); } }}
              render={(d) => {
                const s = ctx.existing.get(d);
                const m = s ? LABEL[s] : null;
                return <T v="mono" style={{ fontSize: 10 }} color={m ? t.tone(m.tone).text : t.mutedFg}>{m?.code ?? ""}</T>;
              }} />
          </Card>
          <T v="small" muted style={{ marginTop: 8 }}>Tap a day to correct it.</T>
          <Section title="Marked days" count={monthDays.length}>
            <ListCard>
              {monthDays.slice().reverse().slice(0, 31).map((d, i, a) => {
                const m = LABEL[ctx.existing.get(d)!];
                return <Row key={d} last={i === a.length - 1} title={fmtDay(d)} right={m ? <Badge label={m.label} tone={m.tone} small /> : null} onPress={() => setDay(d)} />;
              })}
            </ListCard>
          </Section>
        </>
      )}

      <Sheet open={!!day && !!ctx} onClose={() => setDay(null)} title={day ? fmtDay(day) : ""} subtitle={`Attendance — ${e.name}`}
        footer={canEdit ? <>
          {!relieversOnly && <Button label="Clear" variant="secondary" full loading={busy} onPress={() => save("clear")} />}
          <Button label="Save" full loading={busy} onPress={() => save("mark")} />
        </> : <Button label="Close" full onPress={() => setDay(null)} />}>
        {day && ctx && (
          <>
            {ctx.windowBlock(day) ? <T v="small" color={t.tone("danger").text} style={{ marginBottom: 10 }}>{ctx.windowBlock(day)}</T> : null}
            <T v="small" muted style={{ marginBottom: 10 }}>Currently: {ctx.existing.get(day) ? LABEL[ctx.existing.get(day)!]!.label : "unmarked"} · {ctx.resolveShift(e.id, day)} shift</T>
            <Chips value={status} onChange={setStatus} items={(relieversOnly ? ["present", "absent", "leave"] : ["present", "absent", "leave", "double_duty"]).map((k) => ({ key: k as BulkStatus, label: LABEL[k]!.label }))} />
            {relieversOnly && status === "present" && (
              <View style={{ marginTop: 14 }}>
                <Select label="Site worked" required searchable value={site} onChange={setSite} options={db.sites.map((s) => ({ value: s.id, label: s.name, sub: clientName(db, s.client_id) }))} />
                <Select label="Covering for" clearable searchable value={covering} onChange={setCovering} placeholder="Nobody in particular"
                  options={db.employees.filter((x) => x.lifecycle === "active" && x.category !== "reliever" && (!site || x.site_id === site)).map((x) => ({ value: x.id, label: x.name, sub: x.code }))} />
              </View>
            )}
            {!relieversOnly && <View style={{ marginTop: 14 }}><Input label="Override reason" value={override} onChangeText={setOverride} multiline placeholder="Only needed past the backdate limit" /></View>}
            {!canEdit && <T v="small" muted style={{ marginTop: 10 }}>You can view but not change attendance.</T>}
          </>
        )}
      </Sheet>
    </Screen>
  );
}
