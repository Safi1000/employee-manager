// Today's attendance at one site, shift by shift (0613). Everyone is presumed
// present; the supervisor taps the exceptions (absent, leave, double duty with
// its second shift), says whether each reliever the office sent arrived, and
// confirms the shift in his own name. The office has the last word: a shift it
// has already confirmed is shown, not editable. Office staff see it read-only.
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft, CheckCircle2, UserCheck, Users } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Empty } from "../../components/ui";
import { ConfirmResult, Mark, Sheet, Shift, useField } from "../../lib/field";
import { useTheme } from "../../theme/ThemeProvider";

const SHIFT_LABEL: Record<Shift, string> = { day: "Day", evening: "Evening", night: "Night" };
const MARKS: { value: Mark; label: string }[] = [
  { value: "present", label: "P" }, { value: "absent", label: "A" }, { value: "leave", label: "L" }, { value: "double_duty", label: "DD" },
];
const MARK_WORD: Record<Mark, string> = { present: "Present", absent: "Absent", leave: "Leave", double_duty: "Double duty" };
const asMark = (s: string | null): Mark | null =>
  s === "present" || s === "absent" || s === "double_duty" ? s : s === "leave" || s === "rotation_leave" || s === "rest_day" ? "leave" : null;

export default function Attendance() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { sheet, confirmShift, me } = useField();
  const [shift, setShift] = useState<Shift | null>(null);
  const [data, setData] = useState<Sheet | null>(null);
  const [marks, setMarks] = useState<Map<string, { status: Mark; other?: Shift }>>(new Map());
  const [arrived, setArrived] = useState<Map<string, boolean>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<ConfirmResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (s: Shift | null) => {
    try {
      // The first call learns which shifts the site has; open the largest.
      let got = await sheet(id, s ?? "day");
      if (!s && got.shifts.length && !got.shifts.some((x) => x.shift === "day")) {
        const biggest = [...got.shifts].sort((a, b) => b.guards - a.guards)[0].shift;
        got = await sheet(id, biggest);
      }
      setErr(null); setData(got); setShift(got.shift);
      // Start from what is already recorded today; unmarked = present.
      setMarks(new Map(got.guards.flatMap((g) => {
        const m = asMark(g.status);
        return m && m !== "present" ? [[g.employee_id, { status: m, other: g.other_shift ?? undefined }]] : [];
      })));
      setArrived(new Map(got.relievers.map((r) => [r.record_id, r.arrived ?? true])));
    } catch (e) { setErr((e as Error).message); }
  }, [id, sheet]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void load(null); }, [load]);

  const otherShifts = useMemo(() => (["day", "evening", "night"] as Shift[]).filter((s) => s !== shift), [shift]);
  const tally = useMemo(() => {
    const n = { present: 0, absent: 0, leave: 0, double_duty: 0 } as Record<Mark, number>;
    (data?.guards ?? []).forEach((g) => { n[marks.get(g.employee_id)?.status ?? "present"] += 1; });
    return n;
  }, [data, marks]);

  const setMark = (employeeId: string, status: Mark) => {
    setDone(null);
    setMarks((prev) => {
      const next = new Map(prev);
      if (status === "present") next.delete(employeeId);
      else next.set(employeeId, { status, other: status === "double_duty" ? (prev.get(employeeId)?.other ?? otherShifts[0]) : undefined });
      return next;
    });
  };

  const confirm = async () => {
    if (!data || !shift) return;
    setBusy(true); setErr(null);
    try {
      const res = await confirmShift(id, shift,
        [...marks.entries()].map(([employee_id, m]) => ({ employee_id, status: m.status, ...(m.status === "double_duty" ? { other_shift: m.other } : {}) })),
        data.relievers.map((r) => ({ record_id: r.record_id, arrived: arrived.get(r.record_id) ?? true })));
      setDone(res);
      await load(shift);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const editable = !!data?.can_confirm;
  const conf = data?.confirmation;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="Back"><ArrowLeft size={22} color={t.fg} /></Pressable>
          <View style={{ flex: 1 }}>
            <T v="title" numberOfLines={1}>{name ?? data?.site.name ?? "Attendance"}</T>
            <T v="small" muted>Today{data ? ` · ${new Date(`${data.date}T00:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}` : ""}</T>
          </View>
        </View>
        {data && data.shifts.length > 1 ? (
          <View style={{ flexDirection: "row", gap: 6 }}>
            {data.shifts.map((s) => (
              <Pressable key={s.shift} onPress={() => { setDone(null); void load(s.shift); }} accessibilityRole="tab" accessibilityState={{ selected: s.shift === shift }}
                style={{ flex: 1, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center",
                  backgroundColor: s.shift === shift ? t.brand[500] : t.card, borderWidth: 1, borderColor: s.shift === shift ? t.brand[500] : t.border }}>
                <T v="bodyStrong" color={s.shift === shift ? t.onBrand : t.fgSoft}>{SHIFT_LABEL[s.shift]} · {s.guards}</T>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24, gap: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(shift); setRefreshing(false); }} />}>
        {err ? <Banner tone="danger" title={err} /> : null}
        {done ? (
          <Banner tone="success" title={`${SHIFT_LABEL[shift ?? "day"]} shift confirmed`}
            sub={[`${done.present} present`, done.absent ? `${done.absent} absent` : null, done.leave ? `${done.leave} on leave` : null,
              done.double_duty ? `${done.double_duty} double duty` : null,
              done.relievers_arrived + done.relievers_missing ? `${done.relievers_arrived} reliever${done.relievers_arrived === 1 ? "" : "s"} arrived${done.relievers_missing ? `, ${done.relievers_missing} didn't` : ""}` : null]
              .filter(Boolean).join(" · ")} />
        ) : conf ? (
          <Banner tone={conf.by_office ? "info" : "success"} title={conf.by_office ? `Confirmed by the office · ${conf.supervisor_name}` : `Confirmed by ${conf.supervisor_name}`}
            sub={`${new Date(conf.confirmed_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${conf.by_office ? " · ask the office to change anything" : editable ? " · you can change it and confirm again today" : ""}`} />
        ) : null}
        {data && !editable && data.why_not && !conf?.by_office ? <Banner tone="info" title={data.why_not} /> : null}

        {data === null ? null : data.guards.length === 0 && data.relievers.length === 0 ? (
          <Empty icon={Users} title="Nobody is posted on this shift" />
        ) : (
          <>
            {data.guards.map((g) => {
              const m = marks.get(g.employee_id);
              const status = m?.status ?? "present";
              return (
                <Card key={g.employee_id} style={{ gap: 8 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <View style={{ flex: 1 }}>
                      <T v="bodyStrong">{g.full_name}</T>
                      <T v="mono" muted>{g.employee_code ?? "—"}</T>
                    </View>
                    {editable ? (
                      <View style={{ flexDirection: "row", gap: 4 }}>
                        {MARKS.map((opt) => {
                          const on = status === opt.value;
                          const tone = t.tone(opt.value === "present" ? "success" : opt.value === "absent" ? "danger" : opt.value === "leave" ? "warning" : "brand");
                          return (
                            <Pressable key={opt.value} onPress={() => setMark(g.employee_id, opt.value)} accessibilityLabel={`${MARK_WORD[opt.value]}: ${g.full_name}`}
                              accessibilityState={{ selected: on }}
                              style={{ minWidth: 38, height: 38, paddingHorizontal: 8, borderRadius: 10, alignItems: "center", justifyContent: "center",
                                backgroundColor: on ? tone.tint : "transparent", borderWidth: 1, borderColor: on ? tone.text : t.border }}>
                              <T v="bodyStrong" color={on ? tone.text : t.mutedFg}>{opt.label}</T>
                            </Pressable>
                          );
                        })}
                      </View>
                    ) : (
                      <Badge label={MARK_WORD[asMark(g.status) ?? "present"] + (g.status ? "" : " (not marked)")}
                        tone={!g.status ? "neutral" : asMark(g.status) === "absent" ? "danger" : asMark(g.status) === "leave" ? "warning" : "success"} />
                    )}
                  </View>
                  {editable && status === "double_duty" ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <T v="small" muted>Second shift:</T>
                      {otherShifts.map((s) => (
                        <Pressable key={s} onPress={() => setMarks((prev) => new Map(prev).set(g.employee_id, { status: "double_duty", other: s }))}
                          style={{ paddingHorizontal: 12, height: 32, borderRadius: 8, justifyContent: "center",
                            backgroundColor: m?.other === s ? t.brand[500] : t.card, borderWidth: 1, borderColor: m?.other === s ? t.brand[500] : t.border }}>
                          <T v="small" color={m?.other === s ? t.onBrand : t.fgSoft}>{SHIFT_LABEL[s]}</T>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                  {(g.flags ?? []).length ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {(g.flags ?? []).map((f) => <Badge key={f} label={f} tone="danger" />)}
                    </View>
                  ) : null}
                </Card>
              );
            })}

            {data.relievers.length ? <T v="eyebrow" muted style={{ marginTop: 10 }}>Relievers sent by the office</T> : null}
            {data.relievers.map((r) => {
              const yes = arrived.get(r.record_id) ?? true;
              return (
                <Card key={r.record_id} style={{ gap: 8 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <UserCheck size={18} color={t.mutedFg} />
                    <View style={{ flex: 1 }}>
                      <T v="bodyStrong">{r.full_name}</T>
                      <T v="small" muted>{[r.employee_code, r.covering_for ? `covering ${r.covering_for}` : null].filter(Boolean).join(" · ")}</T>
                    </View>
                  </View>
                  {editable ? (
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      {[true, false].map((v) => (
                        <Pressable key={String(v)} onPress={() => { setDone(null); setArrived((prev) => new Map(prev).set(r.record_id, v)); }}
                          style={{ flex: 1, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center",
                            backgroundColor: yes === v ? t.tone(v ? "success" : "danger").tint : "transparent",
                            borderWidth: 1, borderColor: yes === v ? t.tone(v ? "success" : "danger").text : t.border }}>
                          <T v="bodyStrong" color={yes === v ? t.tone(v ? "success" : "danger").text : t.mutedFg}>{v ? "Arrived" : "Didn't arrive"}</T>
                        </Pressable>
                      ))}
                    </View>
                  ) : (
                    <Badge label={r.arrived == null ? "Not confirmed yet" : r.arrived ? "Arrived" : "Didn't arrive"}
                      tone={r.arrived == null ? "neutral" : r.arrived ? "success" : "danger"} />
                  )}
                </Card>
              );
            })}

            {editable ? (
              <View style={{ marginTop: 10, gap: 6 }}>
                <T v="small" muted style={{ textAlign: "center" }}>
                  {[`${tally.present} present`, tally.absent ? `${tally.absent} absent` : null, tally.leave ? `${tally.leave} leave` : null,
                    tally.double_duty ? `${tally.double_duty} double duty` : null].filter(Boolean).join(" · ")}
                </T>
                <Button label={conf ? "Confirm again" : `Confirm ${SHIFT_LABEL[shift ?? "day"].toLowerCase()} shift`} icon={CheckCircle2}
                  onPress={() => void confirm()} loading={busy} />
                <T v="small" muted style={{ textAlign: "center" }}>{`Confirmed as ${me?.name}. Only today's attendance can be confirmed here.`}</T>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
