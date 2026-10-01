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
import { ActivityIndicator, Pressable, View } from "react-native";
import { T } from "../components/Text";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { OverlayProvider } from "../components/Sheet";
import { DataProvider, useDB } from "../data/store";
import { AuthProvider, useAuth } from "../lib/auth";
import { RegionProvider } from "../lib/region";
import { ThemeProvider, useTheme, useThemeCtx } from "../theme/ThemeProvider";

export default function RootLayout() {
  const [loaded] = useFonts({
    BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold, HankenGrotesk_400Regular, HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold, HankenGrotesk_700Bold, JetBrainsMono_500Medium, JetBrainsMono_700Bold,
  });
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <DataProvider>
            <RegionProvider>
              <OverlayProvider>{loaded ? <Root /> : <Splash />}</OverlayProvider>
            </RegionProvider>
          </DataProvider>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Splash({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, alignItems: "center", justifyContent: "center", gap: 12 }}>
      <ActivityIndicator color={t.brand[500]} />
      {label ? <T v="small" muted>{label}</T> : null}
    </View>
  );
}

/** Live mode: the first load failed, so there is nothing true to show. Say so and offer a retry. */
function LoadFailed({ message, retry, signOut }: { message: string; retry: () => void; signOut: () => void }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}>
      <T v="h3">{"Couldn't load your data"}</T>
      <T v="small" muted style={{ textAlign: "center" }}>{message}</T>
      <Pressable onPress={retry} style={{ paddingVertical: 10, paddingHorizontal: 18, borderRadius: 10, backgroundColor: t.brand[500] }}>
        <T v="smallStrong" color={t.onBrand}>Try again</T>
      </Pressable>
      <Pressable onPress={signOut}><T v="small" muted>Sign out</T></Pressable>
    </View>
  );
}

function Root() {
  const t = useTheme();
  const { profile, loading, signOut } = useAuth();
  const data = useDB();
  // The company brand colour (companies.theme) applies for everyone, as on the web.
  const { setBrandKey } = useThemeCtx();
  const companyTheme = data.db.company.theme;
  React.useEffect(() => { if (companyTheme) setBrandKey(companyTheme); }, [companyTheme]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading) return <Splash />;
  // First live load: hold the shell until real data is in, so no screen renders
  // "0 guards" for a company that has hundreds.
  if (profile && data.loading && data.v === 0) return <Splash label="Loading your company…" />;
  if (profile && data.error && data.v === 0) return <LoadFailed message={data.error} retry={() => void data.reload()} signOut={() => void signOut()} />;
  return (
    <>
      <StatusBar style={t.dark ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
        <Stack.Protected guard={!profile}>
          <Stack.Screen name="login" />
        </Stack.Protected>
        <Stack.Protected guard={!!profile}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
      </Stack>
    </>
  );
}
