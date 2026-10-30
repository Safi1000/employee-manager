// Today's Daily Report (0625) — the same one as Operations › Daily Reports on
// the web: a note per active client (the login's region when pinned), "no
// report", urgent. Each note saves when you leave the box. Share PDF builds the
// report on the phone and hands it to WhatsApp, email or anything else.
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Share2 } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenHeader } from "../components/field";
import { T } from "../components/Text";
import { Banner, Button, Card } from "../components/ui";
import { useField } from "../lib/field";
import { useLang } from "../lib/i18n";
import { useTheme } from "../theme/ThemeProvider";
import { fonts, radius } from "../theme/tokens";

type Row = { id: string; name: string; region: string | null; details: string | null; no_report: boolean; urgent: boolean };
type Day = { date: string; region: string | null; clients: Row[] };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default function DailyReportOffice() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { tr, lang } = useLang();
  const { call } = useField();
  const [day, setDay] = useState<Day | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setDay(await call<Day>("field_daily_clients", {})); setErr(null); } catch (e) { setErr((e as Error).message); }
  }, [call]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void load(); }, [load]);

  const save = async (r: Row, patch: Partial<Row>) => {
    const next = { ...r, ...patch };
    setSaving(r.id); setErr(null);
    try {
      await call("field_save_client_report", { p_client_id: r.id, p_details: next.details ?? "", p_no_report: next.no_report, p_urgent: next.urgent });
      setDay((d) => (d ? { ...d, clients: d.clients.map((x) => (x.id === r.id ? next : x)) } : d));
    } catch (e) { setErr((e as Error).message); }
    setSaving(null);
  };

  const share = async () => {
    if (!day) return;
    setBusy(true); setErr(null);
    try {
      const rows = [...day.clients].sort((a, b) => Number(a.no_report) - Number(b.no_report) || Number(b.urgent) - Number(a.urgent) || a.name.localeCompare(b.name));
      const when = new Date(`${day.date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      const html = `<html><head><meta charset="utf-8"><style>
        body{font-family:-apple-system,Roboto,Arial;padding:28px;color:#111}h1{font-size:20px;margin:0}p.sub{color:#555;margin:4px 0 18px}
        table{width:100%;border-collapse:collapse;font-size:12px}td{border-bottom:1px solid #ddd;padding:7px 6px;vertical-align:top}
        td.c{width:32%;font-weight:600}.u{color:#b42318;font-weight:700}.n{color:#888}</style></head><body>
        <h1>Daily Report</h1><p class="sub">${esc(when)}${day.region ? ` · ${esc(day.region)}` : ""}</p><table>
        ${rows.map((r) => `<tr><td class="c">${esc(r.name)}${r.urgent ? ' <span class="u">URGENT</span>' : ""}</td>
          <td>${r.no_report ? '<span class="n">No report</span>' : esc(r.details ?? "—").replace(/\n/g, "<br>")}</td></tr>`).join("")}
        </table></body></html>`;
      const { uri } = await Print.printToFileAsync({ html });
      await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: tr("Share the Daily Report"), UTI: "com.adobe.pdf" });
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, gap: 10 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      <ScreenHeader title={tr("Daily Report")} sub={day ? [new Date(`${day.date}T00:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }), day.region].filter(Boolean).join(" · ") : null} />
      {err ? <Banner tone="danger" title={tr(err)} /> : null}
      <Button label={tr("Share PDF")} icon={Share2} variant="secondary" onPress={() => void share()} loading={busy} disabled={!day} />
      {(day?.clients ?? []).map((r) => (
        <Card key={r.id} style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <T v="bodyStrong" style={{ flex: 1 }}>{r.name}</T>
            {saving === r.id ? <T v="small" muted>{tr("saving…")}</T> : null}
          </View>
          {!r.no_report ? (
            <TextInput value={draft[r.id] ?? r.details ?? ""} onChangeText={(v) => setDraft((d) => ({ ...d, [r.id]: v }))}
              onBlur={() => { const v = draft[r.id]; if (v !== undefined && v !== (r.details ?? "")) void save(r, { details: v }); }}
              multiline placeholder={tr("Details for this client today…")} placeholderTextColor={t.mutedFg} textAlignVertical="top"
              style={{ minHeight: 60, padding: 10, borderRadius: radius.md, backgroundColor: t.input, borderWidth: 1, borderColor: t.border,
                color: t.fg, fontFamily: fonts.body, fontSize: 15, writingDirection: lang === "ur" ? "rtl" : "ltr" }} />
          ) : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Toggle on={r.no_report} label={tr("No report")} onPress={() => void save(r, { no_report: !r.no_report, urgent: false })} />
            {!r.no_report ? <Toggle on={r.urgent} danger label={tr("Urgent")} onPress={() => void save(r, { urgent: !r.urgent })} /> : null}
          </View>
        </Card>
      ))}
    </ScrollView>
  );
}

function Toggle({ on, label, onPress, danger }: { on: boolean; label: string; onPress: () => void; danger?: boolean }) {
  const t = useTheme();
  const tn = t.tone(danger ? "danger" : "brand");
  return (
    <Pressable onPress={onPress} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
      style={{ paddingHorizontal: 12, height: 34, borderRadius: 9, justifyContent: "center", borderWidth: 1,
        borderColor: on ? tn.text : t.border, backgroundColor: on ? tn.tint : "transparent" }}>
      <T v="smallStrong" color={on ? tn.text : t.mutedFg}>{label}</T>
    </Pressable>
  );
}
