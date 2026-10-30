// Tasks the office set on this site (0619): mark each done, or couldn't — with
// a note, which alerts the office. Photos optional. Closed tasks stay listed for
// a week.
import { useLocalSearchParams } from "expo-router";
import { CheckCircle2, ClipboardList, XCircle } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NotesBox, PhotoStrip, ScreenHeader } from "../../components/field";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Empty } from "../../components/ui";
import { TaskRow, useField } from "../../lib/field";
import { useLang } from "../../lib/i18n";
import { position } from "../../lib/media";
import { useTheme } from "../../theme/ThemeProvider";

export default function Tasks() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { tr } = useLang();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { call } = useField();
  const [rows, setRows] = useState<TaskRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setRows((await call<TaskRow[]>("field_site_tasks", { p_site_id: id })) ?? []); } catch (e) { setErr((e as Error).message); }
  }, [id, call]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void load(); }, [load]);

  const close = async (taskId: string, done: boolean) => {
    setBusy(true); setErr(null);
    try {
      await call("field_task_update", { p_task_id: taskId, p_done: done, p_note: note, p_photos: photos, p_geo: await position() });
      setOpenId(null); setNote(""); setPhotos([]);
      await load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, gap: 10 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      <ScreenHeader title={tr("Tasks")} sub={name} />
      {err ? <Banner tone="danger" title={tr(err)} /> : null}
      {rows && rows.length === 0 ? <Empty icon={ClipboardList} title={tr("No tasks for this site")} sub={tr("The office sets tasks in Bastion.")} /> : null}
      {(rows ?? []).map((k) => (
        <Card key={k.id} style={{ gap: 6 }} onPress={k.status === "open" ? () => { setOpenId(openId === k.id ? null : k.id); setNote(""); setPhotos([]); } : undefined}>
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <T v="bodyStrong" style={{ flex: 1 }}>{k.title}</T>
            <Badge label={tr(k.status === "open" ? "Open" : k.status === "done" ? "Done" : "Couldn't")}
              tone={k.status === "open" ? "warning" : k.status === "done" ? "success" : "danger"} />
          </View>
          {k.details ? <T v="body" soft>{k.details}</T> : null}
          <T v="small" muted>{[k.due_date ? tr("Due {date}", { date: new Date(`${k.due_date}T00:00:00`).toLocaleDateString([], { day: "numeric", month: "short" }) }) : null,
            k.created_by_name ? tr("From {name}", { name: k.created_by_name }) : null,
            k.done_by_name ? `${k.done_by_name}${k.done_note ? ` — ${k.done_note}` : ""}` : null].filter(Boolean).join(" · ")}</T>
          {openId === k.id ? (
            <View style={{ gap: 10, marginTop: 6 }}>
              <NotesBox label={tr("Note (needed if it couldn't be done)")} value={note} onChange={setNote} lines={2} />
              <PhotoStrip photos={photos} onChange={setPhotos} max={3} />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button label={tr("Done")} icon={CheckCircle2} onPress={() => void close(k.id, true)} loading={busy} style={{ flex: 1 }} />
                <Button label={tr("Couldn't")} icon={XCircle} variant="secondary" onPress={() => void close(k.id, false)} disabled={busy || !note.trim()} style={{ flex: 1 }} />
              </View>
            </View>
          ) : null}
        </Card>
      ))}
    </ScrollView>
  );
}
