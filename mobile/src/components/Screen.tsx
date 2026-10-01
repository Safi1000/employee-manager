import { useRouter } from "expo-router";
import { ArrowLeft, Lock } from "lucide-react-native";
import React, { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleProp, View, ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../lib/auth";
import { hasAny } from "../lib/permissions";
import { useRegion } from "../lib/region";
import { useTheme } from "../theme/ThemeProvider";
import { radius } from "../theme/tokens";
import { Select } from "./Sheet";
import { T } from "./Text";
import { Button, Empty, tap } from "./ui";

type Props = {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Rendered under the title, pinned while the body scrolls (tabs, filters). */
  sticky?: React.ReactNode;
  back?: boolean;
  region?: boolean;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  footer?: React.ReactNode;
};

export function Screen({ title, eyebrow, subtitle, actions, children, sticky, back, region, scroll = true, contentStyle, footer }: Props) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const showBack = back ?? router.canGoBack();

  // Pull-to-refresh instead of realtime (brief: "skip it for v1").
  const onRefresh = () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 700);
  };

  const header = (
    <View style={{ backgroundColor: t.bg, paddingHorizontal: 16, paddingTop: 10, paddingBottom: sticky ? 10 : 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 40 }}>
        {showBack && (
          <Pressable
            onPress={() => { tap(); router.back(); }}
            hitSlop={8}
            style={{ width: 40, height: 40, borderRadius: radius.lg, backgroundColor: t.card, borderWidth: 1, borderColor: t.border, alignItems: "center", justifyContent: "center" }}
          >
            <ArrowLeft size={19} color={t.fg} />
          </Pressable>
        )}
        {region ? <RegionChip /> : null}
        <View style={{ flex: 1 }} />
        <View style={{ flexDirection: "row", gap: 8 }}>{actions}</View>
      </View>
      <View style={{ marginTop: 12 }}>
        {eyebrow ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <View style={{ width: 14, height: 3, borderRadius: 2, backgroundColor: t.brand[500] }} />
            <T v="eyebrow" color={t.tone("brand").text}>{eyebrow}</T>
          </View>
        ) : null}
        <T v="display" numberOfLines={2}>{title}</T>
        {subtitle ? <T v="small" muted style={{ marginTop: 3 }}>{subtitle}</T> : null}
      </View>
      {sticky ? <View style={{ marginTop: 14, gap: 10 }}>{sticky}</View> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      {header}
      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 110 + insets.bottom }, contentStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.brand[500]} colors={[t.brand[500]]} />}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1, paddingHorizontal: 16 }, contentStyle]}>{children}</View>
      )}
      {footer ? (
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 + insets.bottom, backgroundColor: t.card, borderTopWidth: 1, borderTopColor: t.border, flexDirection: "row", gap: 10 }}>
          {footer}
        </View>
      ) : null}
    </View>
  );
}

function RegionChip() {
  const t = useTheme();
  const { regionId, setRegionId, locked, regions, label } = useRegion();
  if (locked) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: t.card, borderWidth: 1, borderColor: t.border }}>
        <Lock size={13} color={t.mutedFg} />
        <T v="smallStrong">{label}</T>
      </View>
    );
  }
  return (
    <View style={{ minWidth: 160 }}>
      <Select
        compact
        label=""
        value={regionId ?? "all"}
        onChange={(v) => setRegionId(v === "all" ? null : v)}
        options={[{ value: "all", label: "All regions" }, ...regions.map((r) => ({ value: r.id, label: r.name, sub: r.kind === "head_office" ? "Head office" : "Regional" }))]}
        placeholder="All regions"
      />
    </View>
  );
}

/** Route-level gate, mirroring RequirePermission / RequireAuth on web. */
export function Gate({ perms = [], roles, children, title }: { perms?: string[]; roles?: string[]; children: React.ReactNode; title: string }) {
  const { profile } = useAuth();
  const router = useRouter();
  const ok = roles ? !!profile && (roles.includes(profile.role) || profile.role === "super_super_admin") : hasAny(profile, perms);
  if (ok) return <>{children}</>;
  return (
    <Screen title={title} eyebrow="No access">
      <Empty icon={Lock} title="You don't have access to this page" sub={roles ? "This page is for administrators only." : `Needs any of: ${perms.join(", ")}`} />
      <Button label="Back to Today" variant="secondary" onPress={() => router.replace("/")} />
    </Screen>
  );
}
