import { Tabs } from "expo-router";
import { CalendarCheck, LayoutGrid, LucideIcon, NotebookPen, Sun, Users } from "lucide-react-native";
import React from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "../../../components/Text";
import { tap } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { useTheme } from "../../../theme/ThemeProvider";
type BottomTabBarProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>["tabBar"]>>[0];

const ICONS: Record<string, LucideIcon> = { index: Sun, attendance: CalendarCheck, employees: Users, "daily-reports": NotebookPen, menu: LayoutGrid };

// Field-ops first: the four things a supervisor does on a phone get a thumb-reach tab;
// every other page of the web app lives one tap away in Menu.
export default function TabLayout() {
  const { canAny } = useAuth();
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(p) => <TabBar {...p} />}>
      <Tabs.Screen name="index" options={{ title: "Today" }} />
      <Tabs.Screen name="attendance" options={{ title: "Attendance", href: canAny(["attendance.view", "attendance.edit"]) ? undefined : null }} />
      <Tabs.Screen name="employees" options={{ title: "People", href: canAny(["employees.view", "employees.edit"]) ? undefined : null }} />
      <Tabs.Screen name="daily-reports" options={{ title: "Reports", href: canAny(["roster.view", "roster.edit", "incidents.view", "attendance.view"]) ? undefined : null }} />
      <Tabs.Screen name="menu" options={{ title: "Menu" }} />
    </Tabs>
  );
}

function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        position: "absolute", left: 12, right: 12, bottom: Math.max(insets.bottom, 10), flexDirection: "row",
        backgroundColor: t.dark ? "#16190f" : t.fg, borderRadius: 22, padding: 6, gap: 4,
        shadowColor: "#000", shadowOpacity: 0.28, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10,
        borderWidth: t.dark ? 1 : 0, borderColor: t.border,
      }}
    >
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key]!;
        // expo-router sets href:null → tabBarItemStyle display none
        if ((options as { href?: unknown }).href === null || (options.tabBarItemStyle as { display?: string } | undefined)?.display === "none") return null;
        const focused = state.index === index;
        const Icon = ICONS[route.name] ?? LayoutGrid;
        const onPress = () => {
          tap();
          const e = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!focused && !e.defaultPrevented) navigation.navigate(route.name, route.params);
        };
        const inactive = t.dark ? t.mutedFg : "#a59d86";
        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            style={{ flex: 1, height: 54, borderRadius: 17, alignItems: "center", justifyContent: "center", gap: 3, backgroundColor: focused ? t.brand[500] : "transparent" }}
          >
            <Icon size={20} color={focused ? t.onBrand : inactive} strokeWidth={focused ? 2.4 : 2} />
            <T v="smallStrong" style={{ fontSize: 11, lineHeight: 13 }} color={focused ? t.onBrand : inactive}>{String(options.title ?? route.name)}</T>
          </Pressable>
        );
      })}
    </View>
  );
}
