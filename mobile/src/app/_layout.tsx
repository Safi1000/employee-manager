import { BricolageGrotesque_700Bold } from "@expo-google-fonts/bricolage-grotesque/700Bold";
import { BricolageGrotesque_800ExtraBold } from "@expo-google-fonts/bricolage-grotesque/800ExtraBold";
import { HankenGrotesk_400Regular } from "@expo-google-fonts/hanken-grotesk/400Regular";
import { HankenGrotesk_500Medium } from "@expo-google-fonts/hanken-grotesk/500Medium";
import { HankenGrotesk_600SemiBold } from "@expo-google-fonts/hanken-grotesk/600SemiBold";
import { HankenGrotesk_700Bold } from "@expo-google-fonts/hanken-grotesk/700Bold";
import { JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono/500Medium";
import { JetBrainsMono_700Bold } from "@expo-google-fonts/jetbrains-mono/700Bold";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FieldProvider, useField } from "../lib/field";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";

export default function RootLayout() {
  const [loaded] = useFonts({
    BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold, HankenGrotesk_400Regular, HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold, HankenGrotesk_700Bold, JetBrainsMono_500Medium, JetBrainsMono_700Bold,
  });
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <FieldProvider>{loaded ? <Root /> : <Splash />}</FieldProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Splash() {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator color={t.brand[500]} />
    </View>
  );
}

function Root() {
  const t = useTheme();
  const { phase } = useField();
  if (phase === "loading") return <Splash />;
  return (
    <>
      <StatusBar style={t.dark ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
        <Stack.Protected guard={phase !== "ready"}>
          <Stack.Screen name="login" />
        </Stack.Protected>
        <Stack.Protected guard={phase === "ready"}>
          <Stack.Screen name="index" />
          <Stack.Screen name="site/[id]" />
        </Stack.Protected>
      </Stack>
    </>
  );
}
