// One expense or advance request (0622): amount, category (expenses), what it
// was for, the day, a receipt photo. It goes to the app's own panel and waits
// for the office's approval on the web.
import { useLocalSearchParams, useRouter } from "expo-router";
import { Send } from "lucide-react-native";
import React, { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Chips, NotesBox, PhotoStrip, ScreenHeader } from "../../components/field";
import { T } from "../../components/Text";
import { Banner, Button, Input } from "../../components/ui";
import { useField } from "../../lib/field";
import { useLang } from "../../lib/i18n";
import { position } from "../../lib/media";
import { useTheme } from "../../theme/ThemeProvider";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

export default function NewRequest() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { tr } = useLang();
  const { call } = useField();
  const params = useLocalSearchParams<{ kind?: string }>();
  const [kind, setKind] = useState<"expense" | "advance">(params.kind === "advance" ? "advance" : "expense");
  const [cats, setCats] = useState<{ id: string; name: string }[]>([]);
  const [cat, setCat] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [what, setWhat] = useState("");
  const [day, setDay] = useState<string>(daysAgo(0));
  const [photos, setPhotos] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void call<{ id: string; name: string }[]>("field_expense_categories", {}).then((c) => setCats(c ?? [])).catch((e: Error) => setErr(e.message)); }, [call]);

  const send = async () => {
    setBusy(true); setErr(null);
    try {
      await call("field_request_money", { p_kind: kind, p_amount: Number(amount), p_category_id: kind === "expense" ? cat : null,
        p_description: what, p_expense_date: day, p_site_id: null, p_photos: photos, p_geo: await position() });
      router.back();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const ok = Number(amount) > 0 && what.trim() && (kind === "advance" || cat);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, gap: 14 }}>
      <ScreenHeader title={tr(kind === "advance" ? "Request an advance" : "Record an expense")} sub={tr("Waits for the office's approval")} />
      {err ? <Banner tone="danger" title={tr(err)} /> : null}
      <Chips value={kind} onChange={setKind} options={[{ value: "expense", label: tr("Expense") }, { value: "advance", label: tr("Advance") }]} />
      <Input label={tr("Amount (PKR)")} value={amount} onChangeText={(v) => setAmount(v.replace(/[^\d.]/g, ""))} keyboardType="decimal-pad" placeholder="0" style={{ marginBottom: 0 }} />
      {kind === "expense" ? (
        <View style={{ gap: 6 }}>
          <T v="smallStrong" soft>{tr("Category")}</T>
          <Chips value={cat} onChange={setCat} options={cats.map((c) => ({ value: c.id, label: c.name }))} />
        </View>
      ) : null}
      <NotesBox label={tr("What for")} value={what} onChange={setWhat} lines={2} />
      <View style={{ gap: 6 }}>
        <T v="smallStrong" soft>{tr("When")}</T>
        <Chips value={day} onChange={setDay} options={[{ value: daysAgo(0), label: tr("Today") }, { value: daysAgo(1), label: tr("Yesterday") }, { value: daysAgo(2), label: tr("2 days ago") }]} />
      </View>
      {kind === "expense" ? <PhotoStrip photos={photos} onChange={setPhotos} max={3} label={tr("Receipt")} /> : null}
      <Button label={tr("Send")} icon={Send} onPress={() => void send()} loading={busy} disabled={!ok} />
    </ScrollView>
  );
}
