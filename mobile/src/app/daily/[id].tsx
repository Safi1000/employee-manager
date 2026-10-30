// A site's end-of-day word (0619): all OK, or what was not — urgent if the
// office must act tonight. One per site per day; sending again replaces it. The
// office reads it beside the client on Daily Reports. 0620: sent by office
// staff holding the daily-report key (any of them; the last one sent stands),
// never by the site supervisor.
import { useLocalSearchParams } from "expo-router";
import { Send } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chips, NotesBox, PhotoStrip, ScreenHeader } from "../../components/field";
import { T } from "../../components/Text";
import { Banner, Button, Card } from "../../components/ui";
import { Daily, useField } from "../../lib/field";
import { useLang } from "../../lib/i18n";
import { position } from "../../lib/media";
import { useTheme } from "../../theme/ThemeProvider";

export default function DailyReport() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { tr } = useLang();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { call } = useField();
  const [d, setD] = useState<Daily | null>(null);
  const [ok, setOk] = useState<"yes" | "no" | null>(null);
  const [note, setNote] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setD(await call<Daily>("field_site_daily", { p_site_id: id })); } catch (e) { setErr((e as Error).message); }
  }, [id, call]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void load(); }, [load]);

  const send = async () => {
    setBusy(true); setErr(null);
    try {
      await call("field_submit_daily_report", { p_site_id: id, p_all_ok: ok === "yes", p_note: note, p_urgent: ok === "no" && urgent, p_photos: photos, p_geo: await position() });
      setOk(null); setNote(""); setUrgent(false); setPhotos([]);
      await load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const r = d?.report;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, gap: 14 }}>
      <ScreenHeader title={tr("Daily report")} sub={name} />
      {err ? <Banner tone="danger" title={tr(err)} /> : null}
      {r ? (
        <Card style={{ gap: 4 }}>
          <T v="eyebrow" muted>{tr("Sent today")}</T>
          <T v="bodyStrong" color={t.tone(r.all_ok ? "success" : r.urgent ? "danger" : "warning").text}>
            {r.all_ok ? tr("All OK") : r.urgent ? tr("Not OK · urgent") : tr("Not OK")}
          </T>
          {r.note ? <T v="body">{r.note}</T> : null}
          <T v="small" muted>{tr("By {name} at {time}", { name: r.sent_by_name, time: new Date(r.sent_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) })}</T>
        </Card>
      ) : d ? <Banner tone="info" title={tr("No report sent today yet.")} /> : null}

      {d?.can_send ? (
        <>
          <T v="eyebrow" muted>{r ? tr("Send again (replaces today's)") : tr("Today at this site")}</T>
          <Chips value={ok} onChange={setOk} options={[{ value: "yes", label: tr("All OK"), tone: "success" }, { value: "no", label: tr("Not OK"), tone: "danger" }]} />
          {ok ? <NotesBox label={ok === "yes" ? tr("Anything to add (optional)") : tr("What was not OK")} value={note} onChange={setNote} /> : null}
          {ok === "no" ? (
            <Pressable onPress={() => setUrgent((u) => !u)} accessibilityRole="checkbox" accessibilityState={{ checked: urgent }}
              style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View style={{ width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: urgent ? t.tone("danger").solid : t.border,
                backgroundColor: urgent ? t.tone("danger").solid : "transparent", alignItems: "center", justifyContent: "center" }}>
                {urgent ? <T v="smallStrong" color="#fff">✓</T> : null}
              </View>
              <T v="body" style={{ flex: 1 }}>{tr("Urgent — the office must act today")}</T>
            </Pressable>
          ) : null}
          {ok ? <PhotoStrip photos={photos} onChange={setPhotos} /> : null}
          <Button label={tr("Send report")} icon={Send} onPress={() => void send()} loading={busy} disabled={!ok || (ok === "no" && !note.trim())} />
        </>
      ) : d ? <T v="small" muted>{tr("Your login doesn't have the daily report permission.")}</T> : null}
    </ScrollView>
  );
}
