// Sign in, and every state short of "ready": this phone waiting for the
// office's approval, this phone cut off, or the server unreachable.
import { Clock, ShieldOff } from "lucide-react-native";
import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "../components/Text";
import { Banner, Button, Empty, Input } from "../components/ui";
import { useField } from "../lib/field";
import { useTheme } from "../theme/ThemeProvider";

export default function Login() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { phase, error, notice, signIn, signOut, recheck } = useField();
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    const e = await signIn(code, pin);
    setBusy(false);
    if (e) setErr(e); else setPin("");
  };
  const again = async () => { setBusy(true); await recheck(); setBusy(false); };

  let body: React.ReactNode;
  if (phase === "pending") {
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
        {notice ? <Banner tone="info" title={notice} /> : null}
        {err ? <Banner tone="danger" title={err} /> : null}
        <Input label="Employee code" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false}
          placeholder="GGS-00123" returnKeyType="next" />
        <Input label="PIN" value={pin} onChangeText={(v) => setPin(v.replace(/\D/g, "").slice(0, 6))} keyboardType="number-pad"
          secureTextEntry maxLength={6} mono placeholder="••••••" helper="The 6-digit PIN your office gave you." onSubmitEditing={() => void submit()} />
        <Button label="Sign in" onPress={() => void submit()} loading={busy} disabled={!code.trim() || pin.length !== 6} />
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
          <T v="body" muted style={{ marginTop: 6 }}>Your sites and the guards posted at them.</T>
        </View>
        {body}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
