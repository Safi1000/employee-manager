import { useRouter } from "expo-router";
import { LogOut } from "lucide-react-native";
import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { Screen } from "../components/Screen";
import { T } from "../components/Text";
import { Avatar, Badge, Button, Card, Empty, SearchBar, Section, Segmented, tap } from "../components/ui";
import { useOverlay } from "../components/Sheet";
import { useAuth } from "../lib/auth";
import { hasAny, ROLE_LABEL } from "../lib/permissions";
import { GROUP_ORDER, NAV, NavItem } from "../navigation/registry";
import { useThemeCtx } from "../theme/ThemeProvider";
import { radius } from "../theme/tokens";

export default function Menu() {
  const { theme: t, modePref, setModePref } = useThemeCtx();
  const router = useRouter();
  const { profile, signOut } = useAuth();
  const { confirm } = useOverlay();
  const [q, setQ] = useState("");

  // Same three filters the web sidebar applies: permission keys, role, and employee link.
  const visible = NAV.filter((n) => {
    if (n.href === "/") return false;
    if (n.needsEmployeeLink && !profile?.employee_id) return false;
    if (n.roles) return !!profile && (n.roles.includes(profile.role) || profile.role === "super_super_admin");
    return hasAny(profile, n.perms ?? []);
  });
  const shown = q ? visible.filter((n) => (n.title + " " + n.blurb + " " + n.group).toLowerCase().includes(q.toLowerCase())) : visible;
  const groups = GROUP_ORDER.map((g) => ({ g, items: shown.filter((n) => n.group === g) })).filter((x) => x.items.length);

  return (
    <Screen title="Menu" eyebrow={`${visible.length} pages available`} back={false}>
      <Card style={{ marginBottom: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Avatar name={profile?.name ?? "?"} size={48} />
          <View style={{ flex: 1 }}>
            <T v="h3">{profile?.name}</T>
            <T v="small" muted numberOfLines={1}>{profile?.title || profile?.email}</T>
          </View>
          <Badge label={profile ? ROLE_LABEL[profile.role] : ""} tone="brand" />
        </View>
        <View style={{ marginTop: 14 }}>
          <Segmented
            items={[{ key: "system", label: "System" }, { key: "light", label: "Light" }, { key: "dark", label: "Dark" }]}
            value={modePref}
            onChange={setModePref}
          />
        </View>
      </Card>

      <SearchBar value={q} onChange={setQ} placeholder="Jump to a page" />

      {groups.map(({ g, items }) => (
        <Section key={g} title={g} count={items.length}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            {items.map((n) => <Tile key={n.href} n={n} onPress={() => router.push(n.href as never)} />)}
          </View>
        </Section>
      ))}
      {groups.length === 0 && <Empty title="No page matches" sub={`Nothing called “${q}” that you can open.`} />}

      <View style={{ marginTop: 28 }}>
        <Button
          label="Sign out"
          icon={LogOut}
          variant="secondary"
          onPress={async () => { if (await confirm({ title: "Sign out?", message: "You'll need your password to get back in.", confirmLabel: "Sign out", tone: "danger" })) signOut(); }}
        />
      </View>
    </Screen>
  );

  function Tile({ n, onPress }: { n: NavItem; onPress: () => void }) {
    const Icon = n.icon;
    return (
      <Pressable
        onPress={() => { tap(); onPress(); }}
        style={({ pressed }) => ({
          width: "48.4%", minHeight: 104, padding: 12, borderRadius: radius.lg, backgroundColor: pressed ? t.muted : t.card, borderWidth: 1, borderColor: t.border, justifyContent: "space-between",
        })}
      >
        <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: t.tone("brand").tint, alignItems: "center", justifyContent: "center" }}>
          <Icon size={18} color={t.tone("brand").text} strokeWidth={2} />
        </View>
        <View style={{ marginTop: 10 }}>
          <T v="smallStrong" style={{ fontSize: 14 }} numberOfLines={1}>{n.title}</T>
          <T v="small" muted numberOfLines={1} style={{ fontSize: 12 }}>{n.blurb}</T>
        </View>
      </Pressable>
    );
  }
}
