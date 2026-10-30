// The CEO's snapshot (0625): today's operations and this week's minor
// expenses, one screen, read-only. Pull down to refresh.
import React, { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenHeader } from "../components/field";
import { T } from "../components/Text";
import { Banner, Card } from "../components/ui";
import { useField } from "../lib/field";
import { useLang } from "../lib/i18n";
import { useTheme } from "../theme/ThemeProvider";

type Snap = {
  date: string;
  attendance: { shifts_confirmed: number; from_app_waiting_review: number; absent: number; on_leave: number; relievers_sent: number };
  incidents: { open: number; sos_7_days: number; recent: { at: string; category: string; severity: string; is_sos: boolean; site: string | null; client: string | null }[] };
  people: { warnings_waiting: number; termination_review: number };
  field: { visits_today: number; visits_week: number; issues_week: number; tasks_open: number; tasks_overdue: number; not_acknowledged: number; daily_report_clients_today: number };
  expenses: { week_count: number; week_total: number; largest: { date: string; amount: number; description: string | null; category: string | null }[];
    app_requests_waiting: number; app_requests_waiting_total: number };
};
const pkr = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;

export default function Snapshot() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { tr } = useLang();
  const { call } = useField();
  const [s, setS] = useState<Snap | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setS(await call<Snap>("field_snapshot", {})); setErr(null); } catch (e) { setErr((e as Error).message); }
  }, [call]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void load(); }, [load]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, gap: 12 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      <ScreenHeader title={tr("Snapshot")} sub={s ? new Date(`${s.date}T00:00:00`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" }) : null} />
      {err ? <Banner tone="danger" title={tr(err)} /> : null}
      {s ? (
        <>
          <T v="eyebrow" muted>{tr("Today")}</T>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Tile label={tr("Shifts confirmed")} value={s.attendance.shifts_confirmed} />
            <Tile label={tr("Absent")} value={s.attendance.absent} warn={s.attendance.absent > 0} />
            <Tile label={tr("On leave")} value={s.attendance.on_leave} />
            <Tile label={tr("Relievers sent")} value={s.attendance.relievers_sent} />
            <Tile label={tr("Site attendance to review")} value={s.attendance.from_app_waiting_review} warn={s.attendance.from_app_waiting_review > 0} />
            <Tile label={tr("Daily Report clients done")} value={s.field.daily_report_clients_today} />
          </View>

          <T v="eyebrow" muted>{tr("Needs attention")}</T>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Tile label={tr("Open incidents")} value={s.incidents.open} warn={s.incidents.open > 0} />
            <Tile label={tr("SOS in 7 days")} value={s.incidents.sos_7_days} warn={s.incidents.sos_7_days > 0} />
            <Tile label={tr("Warnings waiting")} value={s.people.warnings_waiting} warn={s.people.warnings_waiting > 0} />
            <Tile label={tr("Termination review")} value={s.people.termination_review} warn={s.people.termination_review > 0} />
            <Tile label={tr("Tasks overdue")} value={s.field.tasks_overdue} warn={s.field.tasks_overdue > 0} />
            <Tile label={tr("App activity not acknowledged")} value={s.field.not_acknowledged} warn={s.field.not_acknowledged > 0} />
          </View>
          {s.incidents.recent.length ? (
            <Card style={{ gap: 6 }}>
              {s.incidents.recent.map((i, n) => (
                <T key={n} v="small">{i.is_sos ? "SOS · " : ""}{i.category.replace(/_/g, " ")} ({i.severity}) — {i.site ?? i.client ?? "—"} ·{" "}
                  {new Date(i.at).toLocaleDateString([], { day: "numeric", month: "short" })}</T>
              ))}
            </Card>
          ) : null}

          <T v="eyebrow" muted>{tr("This week")}</T>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Tile label={tr("Site visits")} value={s.field.visits_week} />
            <Tile label={tr("Points found wrong")} value={s.field.issues_week} warn={s.field.issues_week > 0} />
            <Tile label={tr("Expenses recorded")} value={pkr(s.expenses.week_total)} />
            <Tile label={tr("App requests waiting")} value={pkr(s.expenses.app_requests_waiting_total)} warn={s.expenses.app_requests_waiting > 0} />
          </View>
          {s.expenses.largest.length ? (
            <Card style={{ gap: 6 }}>
              <T v="smallStrong" soft>{tr("Largest expenses this week")}</T>
              {s.expenses.largest.map((x, n) => (
                <View key={n} style={{ flexDirection: "row", gap: 8 }}>
                  <T v="small" style={{ flex: 1 }} numberOfLines={1}>{[x.category, x.description].filter(Boolean).join(" — ") || "—"}</T>
                  <T v="smallStrong">{pkr(x.amount)}</T>
                </View>
              ))}
            </Card>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

function Tile({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ width: "48.5%", backgroundColor: t.card, borderRadius: 14, borderWidth: 1, borderColor: warn ? t.tone("warning").line : t.border, padding: 12, gap: 2 }}>
      <T v="figure" color={warn ? t.tone("warning").text : t.fg}>{value}</T>
      <T v="small" muted>{label}</T>
    </View>
  );
}
