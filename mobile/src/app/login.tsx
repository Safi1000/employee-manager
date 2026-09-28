import { ArrowRight, Moon, ShieldCheck, Sun } from "lucide-react-native";
import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "../components/Text";
import { Button, IconBtn, Input } from "../components/ui";
import { useAuth } from "../lib/auth";
import { isLive } from "../lib/supabase";
import { useThemeCtx } from "../theme/ThemeProvider";
import { radius } from "../theme/tokens";

export default function Login() {
  const { theme: t, setModePref } = useThemeCtx();
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(await signIn(email, password));
    setBusy(false);
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32, paddingHorizontal: 20 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: t.brand[500], alignItems: "center", justifyContent: "center" }}>
              <ShieldCheck size={22} color={t.onBrand} strokeWidth={2.4} />
            </View>
            <View>
              <T v="h3">Bastion Field</T>
              <T v="small" muted>Guard workforce</T>
            </View>
          </View>
          <IconBtn icon={t.dark ? Sun : Moon} label="Toggle theme" onPress={() => setModePref(t.dark ? "light" : "dark")} />
        </View>

        {/* Post-board hero: the shifts a supervisor is about to open, as a strip of slots. */}
        <View style={{ marginTop: 40, marginBottom: 28 }}>
          <View style={{ flexDirection: "row", gap: 4, marginBottom: 18 }}>
            {Array.from({ length: 14 }, (_, i) => (
              <View key={i} style={{ flex: 1, height: 26, borderRadius: 4, backgroundColor: i === 9 ? t.tone("danger").solid : i === 4 || i === 12 ? t.tone("warning").solid : t.tone("success").solid, opacity: 0.25 + (i % 5) * 0.15 }} />
            ))}
          </View>
          <T v="eyebrow" color={t.tone("brand").text}>Field operations</T>
          <T v="display" style={{ fontSize: 38, lineHeight: 42, marginTop: 6 }}>Every post,{"\n"}every shift,{"\n"}accounted for.</T>
          <T v="body" muted style={{ marginTop: 10 }}>Sign in with the same account you use on the web app.</T>
        </View>

        <Input label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="you@company.pk" autoComplete="email" />
        <Input label="Password" value={password} onChangeText={setPassword} secureTextEntry placeholder="••••••••" autoComplete="password" onSubmitEditing={submit} />
        {error ? (
          <View style={{ backgroundColor: t.tone("danger").tint, borderRadius: radius.lg, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: t.tone("danger").line }}>
            <T v="smallStrong" color={t.tone("danger").text}>{error}</T>
          </View>
        ) : null}
        <Button label="Sign in" icon={ArrowRight} size="lg" loading={busy} onPress={submit} />

        {!isLive && (
          <View style={{ marginTop: 20, backgroundColor: t.tone("danger").tint, borderRadius: radius.lg, padding: 12, borderWidth: 1, borderColor: t.tone("danger").line }}>
            <T v="smallStrong" color={t.tone("danger").text}>This build has no server configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in mobile/.env and rebuild.</T>
          </View>
        )}
        <T v="small" muted center style={{ marginTop: 28 }}>Built by TechxServe</T>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
