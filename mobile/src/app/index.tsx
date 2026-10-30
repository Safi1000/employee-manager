// Home: the sites this login sees. A supervisor's own few, as a list; office
// staff's every site (0612), grouped by client with a search, since that is
// 68 sites under 50 clients and nobody scrolls that.
import { useRouter } from "expo-router";
import { ChevronRight, LogOut, MapPin } from "lucide-react-native";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "../components/Text";
import { Banner, Card, Empty, SearchBar } from "../components/ui";
import { Site, useField } from "../lib/field";
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

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export default function Home() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { me, endsAt, recheck, signOut } = useField();
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState("");
  const s = useSessionLine(endsAt);
  const sites = useMemo(() => me?.sites ?? [], [me]);
  const office = me?.kind === "office";
  const grouped = office || sites.length > 8;

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const rows = term ? sites.filter((x) => `${x.client ?? ""} ${x.name} ${x.location ?? ""} ${x.region ?? ""}`.toLowerCase().includes(term)) : sites;
    const map = new Map<string, Site[]>();
    rows.forEach((x) => { const k = x.client ?? x.name; map.set(k, [...(map.get(k) ?? []), x]); });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sites, q]);
  const guards = sites.reduce((n, x) => n + (x.guards ?? 0), 0);

  const open = (site: Site) => router.push({ pathname: "/site/[id]", params: { id: site.id, name: site.name } });

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24, gap: 10 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await recheck(); setRefreshing(false); }} />}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
        <View style={{ flex: 1 }}>
          <T v="eyebrow" color={t.brand[600]}>{office ? (me?.title || "Office") : "Site supervisor"}</T>
          <T v="title" style={{ marginTop: 4 }}>{me?.name}</T>
          <T v="mono" muted>{[me?.employee_code, s.line].filter(Boolean).join(" · ")}</T>
        </View>
        <Pressable onPress={() => void signOut()} hitSlop={10} style={{ padding: 6 }} accessibilityLabel="Sign out">
          <LogOut size={20} color={t.mutedFg} />
        </Pressable>
      </View>
      {s.warn ? <Banner tone="warning" title={`Your session ends in ${s.mins} min`} sub={`Sign in again after it ends — it lasts ${me?.session_hours ?? 8} hours.`} /> : null}

      <T v="eyebrow" muted style={{ marginTop: 6 }}>
        {sites.length === 1 ? "Your site" : `${office ? "Sites" : "Your sites"} · ${sites.length} · ${plural(guards, "guard")}`}
      </T>
      {grouped && sites.length > 0 ? <SearchBar value={q} onChange={setQ} placeholder="Client, site or region" /> : null}

      {sites.length === 0 ? (
        <Empty icon={MapPin} title="No sites yet"
          sub={office ? "Your login doesn't reach any site yet. Ask a super admin." : "Your office hasn't given you any sites. Ask them to add yours."} />
      ) : !grouped ? sites.map((site) => (
        <SiteCard key={site.id} site={site} onPress={() => open(site)} showClient />
      )) : groups.length === 0 ? (
        <Empty icon={MapPin} title="No match" />
      ) : groups.map(([client, list]) => (
        <View key={client} style={{ gap: 6, marginTop: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
            <T v="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>{client}</T>
            <T v="small" muted>{[list[0].region, plural(list.reduce((n, x) => n + (x.guards ?? 0), 0), "guard")].filter(Boolean).join(" · ")}</T>
          </View>
          {list.map((site) => <SiteCard key={site.id} site={site} onPress={() => open(site)} />)}
        </View>
      ))}
    </ScrollView>
  );
}

function SiteCard({ site, onPress, showClient }: { site: Site; onPress: () => void; showClient?: boolean }) {
  const t = useTheme();
  const sub = [showClient && site.client !== site.name ? site.client : null, site.location, plural(site.guards ?? 0, "guard")].filter(Boolean).join(" · ");
  return (
    <Card onPress={onPress} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View style={{ flex: 1 }}>
        <T v="bodyStrong">{site.name}</T>
        <T v="small" muted>{sub}</T>
      </View>
      <ChevronRight size={18} color={t.mutedFg} />
    </Card>
  );
}
