// Trips (0623): start — odometer reading and photo, which client, what for —
// and end — odometer reading and photo. Kilometres only: the office prices the
// trip on the fuel sheet on the web. One trip runs at a time.
import { Car, Flag, Play } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { Alert, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chips, NotesBox, ScreenHeader } from "../components/field";
import { T } from "../components/Text";
import { Badge, Banner, Button, Card, Input } from "../components/ui";
import { useField } from "../lib/field";
import { useLang } from "../lib/i18n";
import { position, takePhoto } from "../lib/media";
import { useTheme } from "../theme/ThemeProvider";

type TripState = {
  card: { label: string; last4: string | null } | null;
  open: { id: string; start_at: string; start_odometer: number; purpose: string; client: string | null } | null;
  recent: { id: string; start_at: string; km: number; purpose: string; client: string | null; added: boolean }[];
  clients: { id: string; name: string }[];
};

export default function Trip() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { tr } = useLang();
  const { call } = useField();
  const [s, setS] = useState<TripState | null>(null);
  const [reading, setReading] = useState("");
  const [client, setClient] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setS(await call<TripState>("field_trip_state", {})); setErr(null); } catch (e) { setErr((e as Error).message); }
  }, [call]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void load(); }, [load]);

  const snap = async () => {
    setErr(null);
    try { const p = await takePhoto(800); if (p) setPhoto(p); } catch (e) { setErr((e as Error).message); }
  };
  const reset = () => { setReading(""); setPhoto(null); setPurpose(""); setClient(null); };

  const start = async () => {
    setBusy(true); setErr(null); setDone(null);
    try {
      await call("field_trip_start", { p_odometer: Number(reading), p_client_id: client, p_purpose: purpose, p_photo: photo, p_geo: await position() });
      reset(); await load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const end = async () => {
    if (!s?.open) return;
    setBusy(true); setErr(null);
    try {
      const r = await call<{ km: number }>("field_trip_end", { p_trip_id: s.open.id, p_odometer: Number(reading), p_photo: photo, p_geo: await position() });
      setDone(tr("Trip ended · {km} km", { km: r.km })); reset(); await load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const cancel = () => {
    if (!s?.open) return;
    Alert.alert(tr("Cancel this trip?"), tr("Only if you started it by mistake."), [
      { text: tr("Keep it"), style: "cancel" },
      { text: tr("Cancel trip"), style: "destructive", onPress: async () => { try { await call("field_trip_cancel", { p_trip_id: s.open!.id }); await load(); } catch (e) { setErr((e as Error).message); } } },
    ]);
  };

  const open = s?.open;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, gap: 14 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
      <ScreenHeader title={tr("Trips")} sub={s?.card ? `${s.card.label}${s.card.last4 ? ` ••${s.card.last4}` : ""}` : tr("No fuel card linked to your login")} />
      {err ? <Banner tone="danger" title={tr(err)} /> : null}
      {done ? <Banner tone="success" title={done} sub={tr("The office adds it to the fuel sheet.")} /> : null}

      {open ? (
        <Card style={{ gap: 4 }}>
          <T v="eyebrow" color={t.brand[600]}>{tr("Trip running")}</T>
          <T v="bodyStrong">{[open.client, open.purpose].filter(Boolean).join(" — ")}</T>
          <T v="small" muted>{tr("Started {time} at {km} km", { time: new Date(open.start_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), km: open.start_odometer })}</T>
        </Card>
      ) : null}

      <T v="eyebrow" muted>{open ? tr("End the trip") : tr("Start a trip")}</T>
      <Input label={tr("Odometer reading (km)")} value={reading} onChangeText={(v) => setReading(v.replace(/[^\d.]/g, ""))} keyboardType="decimal-pad" style={{ marginBottom: 0 }} />
      <Button label={photo ? tr("Odometer photo taken — retake") : tr("Photo of the odometer")} variant="secondary" icon={Car} onPress={() => void snap()} />
      {!open ? (
        <>
          <View style={{ gap: 6 }}>
            <T v="smallStrong" soft>{tr("Client (optional)")}</T>
            <Chips value={client} onChange={(v) => setClient(client === v ? null : v)} options={(s?.clients ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          </View>
          <NotesBox label={tr("What for")} value={purpose} onChange={setPurpose} lines={1} />
          <Button label={tr("Start trip")} icon={Play} onPress={() => void start()} loading={busy} disabled={!reading || !photo || !purpose.trim()} />
        </>
      ) : (
        <>
          <Button label={tr("End trip")} icon={Flag} onPress={() => void end()} loading={busy} disabled={!reading || !photo} />
          <Button label={tr("Cancel trip")} variant="ghost" onPress={cancel} />
        </>
      )}

      {s?.recent.length ? <T v="eyebrow" muted style={{ marginTop: 8 }}>{tr("Last trips")}</T> : null}
      {(s?.recent ?? []).map((r) => (
        <Card key={r.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <T v="bodyStrong">{r.km} km · {[r.client, r.purpose].filter(Boolean).join(" — ")}</T>
            <T v="small" muted>{new Date(r.start_at).toLocaleDateString([], { day: "numeric", month: "short" })}</T>
          </View>
          <Badge label={tr(r.added ? "On fuel sheet" : "Waiting")} tone={r.added ? "success" : "warning"} />
        </Card>
      ))}
    </ScrollView>
  );
}
