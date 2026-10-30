// Find an employee (0624) by name or code — the ones this login may see (its
// region's, when pinned). Opens his file.
import { useRouter } from "expo-router";
import { ChevronRight, Search } from "lucide-react-native";
import React, { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenHeader } from "../../components/field";
import { T } from "../../components/Text";
import { Banner, Card, Empty, SearchBar } from "../../components/ui";
import { useField } from "../../lib/field";
import { useLang } from "../../lib/i18n";
import { useTheme } from "../../theme/ThemeProvider";

type Hit = { id: string; full_name: string; employee_code: string | null; designation: string | null; site: string | null };

export default function Employees() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { tr } = useLang();
  const { call } = useField();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) return;
    const id = setTimeout(() => {
      void call<Hit[]>("field_employee_search", { p_q: q }).then((h) => { setHits(h ?? []); setErr(null); }).catch((e: Error) => setErr(e.message));
    }, 300);
    return () => clearTimeout(id);
  }, [q, call]);
  const shown = q.trim().length < 2 ? [] : hits;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, gap: 10 }}>
      <ScreenHeader title={tr("Employees")} sub={tr("See a file, fill what is missing, scan documents")} />
      <SearchBar value={q} onChange={setQ} placeholder={tr("Name or code")} />
      {err ? <Banner tone="danger" title={tr(err)} /> : null}
      {q.trim().length < 2 ? <Empty icon={Search} title={tr("Type at least two letters")} /> : shown.length === 0 ? <Empty icon={Search} title={tr("No match")} /> : null}
      {shown.map((h) => (
        <Card key={h.id} onPress={() => router.push({ pathname: "/employees/[id]", params: { id: h.id, name: h.full_name } })}
          style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <T v="bodyStrong">{h.full_name}</T>
            <T v="small" muted>{[h.employee_code, h.designation, h.site].filter(Boolean).join(" · ")}</T>
          </View>
          <ChevronRight size={18} color={t.mutedFg} />
        </Card>
      ))}
    </ScrollView>
  );
}
