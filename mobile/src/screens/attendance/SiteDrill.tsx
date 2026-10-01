import { useLocalSearchParams, useRouter } from "expo-router";
import { CheckCircle2 } from "lucide-react-native";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Avatar, Banner, Button, Card, Chips, Empty, Input, Section, Strength } from "../../components/ui";
import { AttStatus, Shift, TODAY } from "../../data/seed";
import { clientName, useDB } from "../../data/store";
import { useAuth } from "../../lib/auth";
import { confirmShift, DrillGuard, loadShiftRoster } from "../../data/live";
import { fmtDay } from "../../lib/format";
import { useTheme } from "../../theme/ThemeProvider";
import { SHIFT_LABEL } from "./Attendance";
import { MARK, StatusPick } from "./marks";

/** ShiftDrillModal as a full screen: presume present, record exceptions, supervisor confirms. */
export default function SiteDrill() {
  return <LiveSiteDrill />;
}

// The web board's absence reasons — attendance_records.absent_reason holds these tokens.
const LIVE_ABSENT_REASONS = [
  { value: "awol", label: "AWOL" },
  { value: "sick", label: "Sick" },
  { value: "absconded", label: "Absconded" },
];

type LiveMark = { status: AttStatus; absent_reason: string | null; extraShift?: Shift | null };
type Loaded = Awaited<ReturnType<typeof loadShiftRoster>>;

/**
 * Live site drill. The roster is the dated posting in force on the chosen day,
 * read fresh from the database (not the app's cached "today" postings), and the
 * save is a port of the web board's confirm: one row per guard, double duty as
 * two rows, then the confirmation. The database has no "reported" state, so
 * there is one action: confirm.
 */
function LiveSiteDrill() {
  const t = useTheme();
  const router = useRouter();
  // id is the board row's group key: a site id, or the client id for a client with no sites.
  const { id, shift = "day", date = TODAY, client, site: isSiteParam, n } = useLocalSearchParams<{ id: string; shift?: Shift; date?: string; client?: string; site?: string; n?: string }>();
  const { db, reload } = useDB();
  const { can, profile } = useAuth();
  const { toast } = useOverlay();
  const realSite = db.sites.find((s) => s.id === id);
  const isSite = isSiteParam !== "0" && !!realSite;
  const site = realSite
    ? { id: realSite.id, name: realSite.name, client_id: realSite.client_id }
    : client ? { id: id!, name: "All sites", client_id: client } : undefined;
  const [data, setData] = useState<Loaded | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<string, LiveMark>>({});
  const [supervisor, setSupervisor] = useState(profile?.name ?? "");
  const [override, setOverride] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    loadShiftRoster(id, shift, date, isSite)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setMarks(Object.fromEntries(Object.entries(d.marks).map(([gid, m]) => [gid, { status: m.status === "rest_day" ? "leave" : m.status, absent_reason: m.absent_reason }])));
        if (d.confirmation?.supervisor_name) setSupervisor(d.confirmation.supervisor_name);
      })
      .catch((e) => { if (!cancelled) setLoadErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [id, shift, date, isSite]);

  if (!site) return <Screen title="Site"><Empty title="Site not found" /></Screen>;
  const header = { eyebrow: `${clientName(db, site.client_id)} · ${SHIFT_LABEL[shift]} shift`, title: site.name, subtitle: fmtDay(date) };
  if (loadErr) return <Screen {...header}><Banner tone="danger" title="Couldn't load this shift" sub={loadErr} /></Screen>;
  if (!data) return <Screen {...header}><ActivityIndicator color={t.brand[500]} style={{ marginTop: 40 }} /></Screen>;

  const guards: DrillGuard[] = data.roster;
  const contracted = n != null ? Number(n) || 0 : realSite?.shifts.find((s) => s.shift === shift)?.contracted ?? 0;
  const blocked = data.gate?.mode === "blocked";
  const needsOverride = data.gate?.mode === "override_required";
  const editable = can("attendance.edit") && !blocked;
  const statusOf = (gid: string): AttStatus => marks[gid]?.status ?? "present";
  const exceptions = guards.filter((g) => ["absent", "leave"].includes(statusOf(g.guard_id))).length;
  const otherShifts = data.siteShifts.filter((s) => s !== shift);

  const setStatus = (gid: string, s: AttStatus) =>
    setMarks((m) => ({
      ...m,
      [gid]: {
        status: s,
        absent_reason: s === "absent" ? m[gid]?.absent_reason ?? null : null,
        extraShift: s === "double_duty" ? m[gid]?.extraShift ?? otherShifts[0] ?? null : null,
      },
    }));

  const save = async () => {
    if (!supervisor.trim()) return toast("Supervisor name is required to confirm", "danger");
    if (needsOverride && !override.trim()) return toast("Give a reason for marking a past date", "danger");
    if (guards.some((g) => statusOf(g.guard_id) === "absent" && !marks[g.guard_id]?.absent_reason)) return toast("Pick a reason for every absence", "danger");
    if (guards.some((g) => statusOf(g.guard_id) === "double_duty" && !marks[g.guard_id]?.extraShift)) return toast("Double duty needs a second shift", "danger");
    if (!profile) return;
    setSaving(true);
    try {
      await confirmShift({
        companyId: db.companyId, groupKey: site.id, isSite, clientId: site.client_id, shift, date, roster: guards, marks,
        supervisor, override, userId: profile.id, role: profile.role,
      });
      await reload();
      toast(`${site.name} confirmed`);
      router.back();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "danger");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      {...header}
      footer={editable && guards.length > 0 ? <Button label={data.confirmation ? "Re-confirm shift" : "Confirm shift"} icon={CheckCircle2} full loading={saving} onPress={save} /> : undefined}
    >
      {blocked && <Banner tone="danger" title="Marking closed for this date" sub={data.gate?.reason ?? "Someone with backdate permission has to make this change."} />}
      {data.confirmation && <Banner tone="success" title={`Confirmed by ${data.confirmation.supervisor_name}`} sub="Confirming again replaces the marks for this shift." />}

      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View>
            <T v="eyebrow" muted>Strength</T>
            <T v="figure" style={{ marginTop: 4 }}>{guards.length - exceptions}<T v="h3" muted> / {contracted}</T></T>
          </View>
          <View style={{ alignItems: "flex-end", gap: 6 }}>
            <T v="small" muted>{exceptions} exception{exceptions === 1 ? "" : "s"}</T>
            {guards.length < contracted && <T v="smallStrong" color={t.tone("danger").text}>{contracted - guards.length} slot unfilled</T>}
          </View>
        </View>
        <View style={{ marginTop: 12 }}>
          <Strength contracted={contracted} deployed={guards.length} exceptions={exceptions} />
        </View>
      </Card>

      <Section title="Roster" count={guards.length} hint="Everyone is presumed present. Tap only the exceptions.">
        {guards.map((g) => {
          const s = statusOf(g.guard_id);
          return (
            <Card key={g.guard_id} style={{ marginBottom: 8 }} accent={MARK[s].tone}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <Avatar name={g.name} size={34} />
                <View style={{ flex: 1 }}>
                  <T v="smallStrong" style={{ fontSize: 15 }}>{g.name}</T>
                  <T v="mono" muted style={{ fontSize: 11 }}>{g.code}{g.department ? ` · ${g.department}` : ""}</T>
                </View>
              </View>
              <StatusPick value={s} disabled={!editable} onChange={(v) => setStatus(g.guard_id, v)} />
              {s === "absent" && (
                <View style={{ marginTop: 12 }}>
                  <Select
                    label="Absent reason"
                    required
                    value={marks[g.guard_id]?.absent_reason ?? ""}
                    onChange={(v) => setMarks((m) => ({ ...m, [g.guard_id]: { ...m[g.guard_id]!, absent_reason: v } }))}
                    options={LIVE_ABSENT_REASONS}
                  />
                </View>
              )}
              {s === "double_duty" && (
                <View style={{ marginTop: 12, gap: 6 }}>
                  <T v="small" muted>Second shift worked</T>
                  {otherShifts.length ? (
                    <Chips
                      items={otherShifts.map((x) => ({ key: x, label: SHIFT_LABEL[x] }))}
                      value={marks[g.guard_id]?.extraShift ?? otherShifts[0]!}
                      onChange={(x) => setMarks((m) => ({ ...m, [g.guard_id]: { ...m[g.guard_id]!, extraShift: x } }))}
                    />
                  ) : (
                    <T v="small" color={t.tone("danger").text}>{"This site runs no other shift, so double duty can't be recorded here."}</T>
                  )}
                </View>
              )}
            </Card>
          );
        })}
        {guards.length === 0 && <Empty title="Nobody posted on this shift" sub="Post guards from Assignments & Pay on the web app." />}
      </Section>

      {editable && guards.length > 0 && (
        <Section title="Sign-off">
          <Input label="Supervisor" required value={supervisor} onChangeText={setSupervisor} />
          {needsOverride && <Input label="Reason for marking a past date" required value={override} onChangeText={setOverride} multiline />}
        </Section>
      )}
    </Screen>
  );
}
