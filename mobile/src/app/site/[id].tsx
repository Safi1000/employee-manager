// One site's guards: name, code, shift, phone, expiry flags. Nothing else —
// field_site_roster returns no CNIC number and no pay, by design (0607).
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft, Phone, Users } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Linking, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "../../components/Text";
import { Avatar, Badge, Banner, Card, Empty, SearchBar } from "../../components/ui";
import { Guard, useField } from "../../lib/field";
import { useTheme } from "../../theme/ThemeProvider";

export default function SiteRoster() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { roster } = useField();
  const [rows, setRows] = useState<Guard[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { const got = await roster(id); setErr(null); setRows(got); }
    catch (e) { setErr((e as Error).message); setRows((r) => r ?? []); }
  }, [id, roster]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set only after the request returns
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows ?? []).filter((g) => !s || `${g.full_name} ${g.employee_code ?? ""}`.toLowerCase().includes(s));
  }, [rows, q]);
  const flagged = (rows ?? []).filter((g) => (g.flags ?? []).length > 0).length;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="Back"><ArrowLeft size={22} color={t.fg} /></Pressable>
          <View style={{ flex: 1 }}>
            <T v="title" numberOfLines={1}>{name ?? "Site"}</T>
            {rows ? <T v="small" muted>{rows.length} guard{rows.length === 1 ? "" : "s"}{flagged ? ` · ${flagged} with a document to renew` : ""}</T> : null}
          </View>
        </View>
        <SearchBar value={q} onChange={setQ} placeholder="Name or code" />
        {err ? <Banner tone="danger" title={err} /> : null}
      </View>
      <FlatList
        data={shown}
        keyExtractor={(g) => g.employee_id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24, gap: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={rows === null ? null : <Empty icon={Users} title={q ? "No match" : "No guards posted here"} />}
        renderItem={({ item: g }) => (
          <Card style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Avatar name={g.full_name} />
              <View style={{ flex: 1 }}>
                <T v="bodyStrong">{g.full_name}</T>
                <T v="mono" muted>{g.employee_code ?? "—"}{g.shift ? ` · ${g.shift}` : ""}</T>
              </View>
              {g.phone ? (
                <Pressable onPress={() => void Linking.openURL(`tel:${g.phone}`)} hitSlop={8} accessibilityLabel={`Call ${g.full_name}`}
                  style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: t.tone("success").tint, alignItems: "center", justifyContent: "center" }}>
                  <Phone size={18} color={t.tone("success").text} />
                </Pressable>
              ) : null}
            </View>
            {(g.flags ?? []).length ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {(g.flags ?? []).map((f) => <Badge key={f} label={f} tone="danger" />)}
              </View>
            ) : null}
          </Card>
        )}
      />
    </View>
  );
}
