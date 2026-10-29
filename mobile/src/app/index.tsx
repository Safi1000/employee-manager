// Home: the sites this supervisor covers.
import { useRouter } from "expo-router";
import { ChevronRight, LogOut, MapPin } from "lucide-react-native";
import React, { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "../components/Text";
import { Banner, Card, Empty } from "../components/ui";
import { useField } from "../lib/field";
import { useTheme } from "../theme/ThemeProvider";

/** "Signed in until 9:40 pm", and a warning in the last half hour. */
function useSessionLine(endsAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  if (!endsAt) return { line: null, warn: false, mins: 0 };
  const mins = Math.max(0, Math.round((endsAt - now) / 60_000));
  const at = new Date(endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return { line: `Signed in until ${at}`, warn: mins <= 30, mins };
}

export default function Home() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { me, endsAt, recheck, signOut } = useField();
  const [refreshing, setRefreshing] = useState(false);
  const s = useSessionLine(endsAt);
  const sites = me?.sites ?? [];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24, gap: 10 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await recheck(); setRefreshing(false); }} />}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
        <View style={{ flex: 1 }}>
          <T v="eyebrow" color={t.brand[600]}>Site supervisor</T>
          <T v="title" style={{ marginTop: 4 }}>{me?.name}</T>
          <T v="mono" muted>{me?.employee_code}{s.line ? ` · ${s.line}` : ""}</T>
        </View>
        <Pressable onPress={() => void signOut()} hitSlop={10} style={{ padding: 6 }} accessibilityLabel="Sign out">
          <LogOut size={20} color={t.mutedFg} />
        </Pressable>
      </View>
      {s.warn ? <Banner tone="warning" title={`Your session ends in ${s.mins} min`} sub="Sign in again after it ends — it lasts 14 hours." /> : null}

      <T v="eyebrow" muted style={{ marginTop: 6 }}>{sites.length === 1 ? "Your site" : `Your sites · ${sites.length}`}</T>
      {sites.length === 0 ? (
        <Empty icon={MapPin} title="No sites yet" sub="Your office hasn't given you any sites. Ask them to add yours." />
      ) : sites.map((site) => (
        <Card key={site.id} onPress={() => router.push({ pathname: "/site/[id]", params: { id: site.id, name: site.name } })}
          style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <T v="bodyStrong">{site.name}</T>
            <T v="small" muted>{[site.client !== site.name ? site.client : null, site.location].filter(Boolean).join(" · ") || " "}</T>
          </View>
          <ChevronRight size={18} color={t.mutedFg} />
        </Card>
      ))}
    </ScrollView>
  );
}
