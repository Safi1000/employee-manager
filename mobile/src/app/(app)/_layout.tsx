import { Stack } from "expo-router";
import React from "react";
import { useTheme } from "../../theme/ThemeProvider";

export default function AppLayout() {
  const t = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg }, animation: "slide_from_right" }} />;
}
