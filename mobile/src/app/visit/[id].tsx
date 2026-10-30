// A visit to one site (0615). Pick the guards on duty, tick each point yes / no
// / not applicable, the duty register for the site, write what was found and
// what was done about it. A "no" anywhere needs a photo from the camera before
// it saves. The position goes with it and is compared with the site's area on
// the server — recorded, never a refusal.
import { useLocalSearchParams } from "expo-router";
import { CheckCircle2 } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chips, NotesBox, PhotoStrip, ScreenHeader } from "../../components/field";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card } from "../../components/ui";
import { Guard, useField, VisitRow } from "../../lib/field";
import { useLang } from "../../lib/i18n";
import { position } from "../../lib/media";
import { useTheme } from "../../theme/ThemeProvider";

type Point = "present" | "alert" | "uniform" | "id_card" | "weapon" | "ammunition" | "right_post";
type Val = true | false | null;
const POINTS: { key: Point; label: string }[] = [
  { key: "present", label: "Present" }, { key: "alert", label: "Awake and alert" }, { key: "uniform", label: "Uniform" },
  { key: "id_card", label: "ID card" }, { key: "weapon", label: "Weapon and licence" }, { key: "ammunition", label: "Ammunition" },
  { key: "right_post", label: "On the right post" },
];
const allYes = (): Record<Point, Val> => ({ present: true, alert: true, uniform: true, id_card: true, weapon: null, ammunition: null, right_post: true });

export default function Visit() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { tr } = useLang();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { roster, call } = useField();
  const [guards, setGuards] = useState<Guard[]>([]);
  const [shift, setShift] = useState<string | null>(null);
  const [checks, setChecks] = useState<Map<string, Record<Point, Val>>>(new Map());
  const [notes, setNotes] = useState<Map<string, string>>(new Map());
  const [register, setRegister] = useState<Val>(true);
  const [findings, setFindings] = useState("");
  const [actions, setActions] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [recent, setRecent] = useState<VisitRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ issues: number; inside: boolean | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const [g, v] = await Promise.all([roster(id), call<VisitRow[]>("field_site_visits", { p_site_id: id })]);
      setGuards(g); setRecent(v ?? []);
      setShift((s) => s ?? ([...new Set(g.map((x) => x.shift ?? "day"))][0] ?? null));
    } catch (e) { setErr((e as Error).message); }
  }, [id, roster, call]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void load(); }, [load]);

  const shifts = useMemo(() => [...new Set(guards.map((g) => g.shift ?? "day"))], [guards]);
  const onShift = guards.filter((g) => (g.shift ?? "day") === shift);
  const issues = useMemo(() => [...checks.values()].reduce((n, c) => n + Object.values(c).filter((v) => v === false).length, 0) + (register === false ? 1 : 0), [checks, register]);

  const toggleGuard = (g: Guard) => setChecks((prev) => {
    const next = new Map(prev);
    if (next.has(g.employee_id)) next.delete(g.employee_id); else next.set(g.employee_id, allYes());
    return next;
  });
  const setPoint = (gid: string, p: Point, v: Val) => setChecks((prev) => new Map(prev).set(gid, { ...(prev.get(gid) ?? allYes()), [p]: v }));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await call<{ issues: number; inside: boolean | null }>("field_record_visit", {
        p_site_id: id,
        p_guards: [...checks.entries()].map(([employee_id, c]) => ({ employee_id, checks: c, note: notes.get(employee_id) ?? null })),
        p_site_checks: { duty_register: register }, p_findings: findings, p_actions: actions, p_photos: photos, p_geo: await position(),
      });
      setDone(res); setChecks(new Map()); setNotes(new Map()); setFindings(""); setActions(""); setPhotos([]); setRegister(true);
      await load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, gap: 12 }}>
      <ScreenHeader title={tr("Site visit")} sub={name} />
      {err ? <Banner tone="danger" title={tr(err)} /> : null}
      {done ? <Banner tone={done.issues ? "warning" : "success"} title={done.issues ? tr("Visit saved · {n} points wrong", { n: done.issues }) : tr("Visit saved · all fine")}
        sub={done.inside === false ? tr("Your phone was outside this site's area.") : undefined} /> : null}

      {shifts.length > 1 ? <Chips value={shift} onChange={setShift} options={shifts.map((s) => ({ value: s, label: tr(s) }))} /> : null}
      <T v="eyebrow" muted>{tr("Tap each guard you checked")}</T>
      {onShift.map((g) => {
        const c = checks.get(g.employee_id);
        return (
          <Card key={g.employee_id} style={{ gap: 8 }}>
            <Pressable onPress={() => toggleGuard(g)} style={{ flexDirection: "row", alignItems: "center", gap: 10 }} accessibilityState={{ checked: !!c }}>
              <View style={{ width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: c ? t.brand[500] : t.border, backgroundColor: c ? t.brand[500] : "transparent", alignItems: "center", justifyContent: "center" }}>
                {c ? <T v="smallStrong" color={t.onBrand}>✓</T> : null}
              </View>
              <View style={{ flex: 1 }}>
                <T v="bodyStrong">{g.full_name}</T>
                <T v="mono" muted>{g.employee_code ?? "—"}</T>
              </View>
              {c && Object.values(c).some((v) => v === false) ? <Badge label={tr("Issue")} tone="danger" /> : null}
            </Pressable>
            {c ? (
              <View style={{ gap: 6 }}>
                {POINTS.map((p) => (
                  <View key={p.key} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <T v="small" style={{ flex: 1 }}>{tr(p.label)}</T>
                    <Tri v={c[p.key]} onChange={(v) => setPoint(g.employee_id, p.key, v)} />
                  </View>
                ))}
                <NotesBox label={tr("Note on this guard")} value={notes.get(g.employee_id) ?? ""} lines={1}
                  onChange={(s) => setNotes((prev) => new Map(prev).set(g.employee_id, s))} />
              </View>
            ) : null}
          </Card>
        );
      })}

      <Card style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <T v="bodyStrong" style={{ flex: 1 }}>{tr("Duty register kept up")}</T>
        <Tri v={register} onChange={setRegister} />
      </Card>
      <NotesBox label={tr("What you found")} value={findings} onChange={setFindings} />
      <NotesBox label={tr("What was done about it")} value={actions} onChange={setActions} lines={2} />
      <PhotoStrip photos={photos} onChange={setPhotos} label={issues ? tr("Photos — needed for what was wrong") : tr("Photos")} />
      <Button label={tr("Save visit")} icon={CheckCircle2} onPress={() => void save()} loading={busy}
        disabled={checks.size === 0 || (issues > 0 && photos.length === 0)} />
      {issues > 0 && photos.length === 0 ? <T v="small" muted center>{tr("Take a photo of what was wrong before you save.")}</T> : null}

      {recent.length ? <T v="eyebrow" muted style={{ marginTop: 10 }}>{tr("Last 30 days")}</T> : null}
      {recent.map((v) => (
        <Card key={v.id} style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <T v="bodyStrong">{new Date(v.at).toLocaleDateString([], { day: "numeric", month: "short" })} · {v.visitor_name}</T>
            <Badge label={v.issues ? tr("{n} wrong", { n: v.issues }) : tr("All fine")} tone={v.issues ? "danger" : "success"} />
            {v.inside === false ? <Badge label={tr("Outside area")} tone="warning" /> : null}
          </View>
          <T v="small" muted>{tr("{n} guards checked", { n: v.guards_checked })}{v.findings ? ` · ${v.findings}` : ""}</T>
        </Card>
      ))}
    </ScrollView>
  );
}

/** Yes / no / not applicable. */
function Tri({ v, onChange }: { v: Val; onChange: (v: Val) => void }) {
  const t = useTheme();
  const { tr } = useLang();
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {([true, false, null] as Val[]).map((o) => {
        const on = v === o;
        const tn = t.tone(o === true ? "success" : o === false ? "danger" : "neutral");
        return (
          <Pressable key={String(o)} onPress={() => onChange(o)} accessibilityState={{ selected: on }}
            style={{ minWidth: 44, height: 34, paddingHorizontal: 8, borderRadius: 9, alignItems: "center", justifyContent: "center",
              backgroundColor: on ? tn.tint : "transparent", borderWidth: 1, borderColor: on ? tn.text : t.border }}>
            <T v="smallStrong" color={on ? tn.text : t.mutedFg}>{o === true ? "✓" : o === false ? "✗" : tr("n/a")}</T>
          </Pressable>
        );
      })}
    </View>
  );
}
