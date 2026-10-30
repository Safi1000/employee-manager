// Sign in, and every state short of "ready": the authenticator code, this
// phone waiting for the office's approval, this phone cut off, or the server
// unreachable. Two ways in (0612): a supervisor's code + PIN, or an office
// login's own email + password (then its authenticator code).
import { Clock, KeyRound, ShieldOff } from "lucide-react-native";
import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "../components/Text";
import { Banner, Button, Empty, Input } from "../components/ui";
import { useField } from "../lib/field";
import { useTheme } from "../theme/ThemeProvider";

export default function Login() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { phase, error, notice, signIn, signInOffice, verifyCode, signOut, recheck } = useField();
  const [mode, setMode] = useState<"supervisor" | "office">("supervisor");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    const e = mode === "supervisor" ? await signIn(code, pin) : await signInOffice(email, password);
    setBusy(false);
    if (e) setErr(e); else { setPin(""); setPassword(""); }
  };
  const submitCode = async () => {
    setBusy(true); setErr(null);
    const e = await verifyCode(otp);
    setBusy(false);
    if (e) setErr(e); else setOtp("");
  };
  const again = async () => { setBusy(true); await recheck(); setBusy(false); };

  let body: React.ReactNode;
  if (phase === "mfa") {
    body = (
      <>
        <Empty icon={KeyRound} title="Enter your authenticator code" sub="Open your authenticator app and type the 6-digit code for Bastion." />
        {err ? <Banner tone="danger" title={err} /> : null}
        <Input label="Code" value={otp} onChangeText={(v) => setOtp(v.replace(/\D/g, "").slice(0, 6))} keyboardType="number-pad"
          maxLength={6} mono placeholder="123456" autoFocus onSubmitEditing={() => void submitCode()} />
        <Button label="Continue" onPress={() => void submitCode()} loading={busy} disabled={otp.length !== 6} />
        <Button label="Sign out" variant="ghost" onPress={() => void signOut()} style={{ marginTop: 8 }} />
      </>
    );
  } else if (phase === "pending") {
    body = (
      <>
        <Empty icon={Clock} title="Waiting for the office" sub="Your office has to approve this phone before you can use it. Ask them to approve it in Bastion, then tap Check again." />
        <Button label="Check again" onPress={() => void again()} loading={busy} />
        <Button label="Sign out" variant="ghost" onPress={() => void signOut()} style={{ marginTop: 8 }} />
      </>
    );
  } else if (phase === "revoked") {
    body = (
      <>
        <Empty icon={ShieldOff} title="This phone has been cut off" sub="Your office has stopped this phone from using your login. If that's a mistake, call them." />
        <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
      </>
    );
  } else if (phase === "error") {
    body = (
      <>
        <Banner tone="danger" title="Couldn't reach Bastion" sub={error ?? undefined} />
        <Button label="Try again" onPress={() => void again()} loading={busy} />
        <Button label="Sign out" variant="ghost" onPress={() => void signOut()} style={{ marginTop: 8 }} />
      </>
    );
  } else {
    body = (
      <>
        <View style={{ flexDirection: "row", gap: 4, padding: 4, borderRadius: 14, backgroundColor: t.card, borderWidth: 1, borderColor: t.border, marginBottom: 16 }}>
          {(["supervisor", "office"] as const).map((m) => (
            <Pressable key={m} onPress={() => { setMode(m); setErr(null); }} accessibilityRole="tab" accessibilityState={{ selected: mode === m }}
              style={{ flex: 1, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: mode === m ? t.brand[500] : "transparent" }}>
              <T v="bodyStrong" color={mode === m ? t.onBrand : t.fgSoft}>{m === "supervisor" ? "Supervisor" : "Office staff"}</T>
            </Pressable>
          ))}
        </View>
        {notice ? <Banner tone="info" title={notice} /> : null}
        {err ? <Banner tone="danger" title={err} /> : null}
        {mode === "supervisor" ? (
          <>
            <Input label="Employee code" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false}
              placeholder="GGS-00123" returnKeyType="next" />
            <Input label="PIN" value={pin} onChangeText={(v) => setPin(v.replace(/\D/g, "").slice(0, 6))} keyboardType="number-pad"
              secureTextEntry maxLength={6} mono placeholder="••••••" helper="The 6-digit PIN your office gave you." onSubmitEditing={() => void submit()} />
            <Button label="Sign in" onPress={() => void submit()} loading={busy} disabled={!code.trim() || pin.length !== 6} />
          </>
        ) : (
          <>
            <Input label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
              placeholder="name@company.com" returnKeyType="next" />
            <Input label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none"
              helper="Your Bastion sign-in. You'll need your authenticator code next." onSubmitEditing={() => void submit()} />
            <Button label="Sign in" onPress={() => void submit()} loading={busy} disabled={!email.trim() || !password} />
          </>
        )}
      </>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled">
        <View style={{ marginBottom: 28 }}>
          <T v="eyebrow" color={t.brand[600]}>GGS · Bastion</T>
          <T v="display" style={{ marginTop: 6 }}>Field</T>
          <T v="body" muted style={{ marginTop: 6 }}>Sites and the guards posted at them.</T>
        </View>
        {body}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
