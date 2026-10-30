// Report an incident at one site (0616). It lands in the same Incidents list the
// office works on the web; the office takes it from there. Kind and seriousness
// are the incidents table's own lists. Guards involved come from this site's
// roster; photos from the camera; the position goes with it.
import { useLocalSearchParams } from "expo-router";
import { Send } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chips, NotesBox, PhotoStrip, ScreenHeader } from "../../components/field";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card } from "../../components/ui";
import { Guard, IncidentRow, useField } from "../../lib/field";
import { useLang } from "../../lib/i18n";
import { position } from "../../lib/media";
import { useTheme } from "../../theme/ThemeProvider";

const CATEGORIES = [
  ["theft", "Theft"], ["altercation", "Fight or argument"], ["guard_injury", "Guard injured"], ["weapon_discharge", "Weapon fired"],
  ["no_show", "Guard didn't come"], ["asset_damage", "Damage"], ["client_complaint", "Client complaint"], ["other", "Other"],
] as const;
const SEVERITIES = [["low", "Low", "neutral"], ["medium", "Medium", "warning"], ["high", "High", "danger"], ["critical", "Critical", "danger"]] as const;
type Category = (typeof CATEGORIES)[number][0];
type Severity = (typeof SEVERITIES)[number][0];

export default function Incident() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { tr } = useLang();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { roster, call } = useField();
  const [guards, setGuards] = useState<Guard[]>([]);
  const [recent, setRecent] = useState<IncidentRow[]>([]);
  const [category, setCategory] = useState<Category | null>(null);
  const [severity, setSeverity] = useState<Severity>("medium");
  const [text, setText] = useState("");
  const [involved, setInvolved] = useState<string[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [g, i] = await Promise.all([roster(id), call<IncidentRow[]>("field_site_incidents", { p_site_id: id })]);
      setGuards(g); setRecent(i ?? []);
    } catch (e) { setErr((e as Error).message); }
  }, [id, roster, call]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void load(); }, [load]);

  const send = async () => {
    if (!category) return;
    setBusy(true); setErr(null); setSent(null);
    try {
      const res = await call<{ code: string | null }>("field_report_incident", {
        p_site_id: id, p_category: category, p_severity: severity, p_description: text, p_guard_ids: involved, p_photos: photos, p_geo: await position(),
      });
      setSent(res.code ?? ""); setCategory(null); setSeverity("medium"); setText(""); setInvolved([]); setPhotos([]);
      await load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const word = (list: readonly (readonly string[])[], v: string) => tr(list.find((x) => x[0] === v)?.[1] ?? v);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, gap: 14 }}>
      <ScreenHeader title={tr("Report incident")} sub={name} />
      {err ? <Banner tone="danger" title={tr(err)} /> : null}
      {sent !== null ? <Banner tone="success" title={tr("Incident sent to the office")} sub={sent || undefined} /> : null}

      <View style={{ gap: 6 }}>
        <T v="smallStrong" soft>{tr("What happened")}</T>
        <Chips value={category} onChange={setCategory} options={CATEGORIES.map(([v, l]) => ({ value: v, label: tr(l) }))} />
      </View>
      <View style={{ gap: 6 }}>
        <T v="smallStrong" soft>{tr("How serious")}</T>
        <Chips value={severity} onChange={setSeverity} options={SEVERITIES.map(([v, l, tone]) => ({ value: v, label: tr(l), tone }))} />
      </View>
      <NotesBox label={tr("Details")} value={text} onChange={setText} placeholder={tr("Who, what, when, what was done")} lines={4} />
      {guards.length ? (
        <View style={{ gap: 6 }}>
          <T v="smallStrong" soft>{tr("Guards involved")}</T>
          <Chips multi value={involved} onChange={(v) => setInvolved((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]))}
            options={guards.map((g) => ({ value: g.employee_id, label: g.full_name }))} />
        </View>
      ) : null}
      <PhotoStrip photos={photos} onChange={setPhotos} />
      <Button label={tr("Send to the office")} icon={Send} onPress={() => void send()} loading={busy} disabled={!category || !text.trim()} />

      {recent.length ? <T v="eyebrow" muted style={{ marginTop: 10 }}>{tr("Last 30 days")}</T> : null}
      {recent.map((i) => (
        <Card key={i.id} style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {i.is_sos ? <Badge label="SOS" tone="danger" /> : <Badge label={word(CATEGORIES, i.category)} tone="neutral" />}
            <Badge label={word(SEVERITIES, i.severity)} tone={i.severity === "high" || i.severity === "critical" ? "danger" : "warning"} />
            <T v="small" muted>{new Date(i.at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</T>
          </View>
          {i.description ? <T v="body" numberOfLines={3}>{i.description}</T> : null}
          <T v="small" muted>{[i.code, i.reporter_name, tr(i.status.replace(/_/g, " "))].filter(Boolean).join(" · ")}</T>
        </Card>
      ))}
    </ScrollView>
  );
}
