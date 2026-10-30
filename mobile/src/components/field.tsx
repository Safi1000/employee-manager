// Pieces the field screens share: the screen header, choice chips, a notes box,
// and the camera strip (camera only — never the gallery; see lib/media.ts).
import { useRouter } from "expo-router";
import { ArrowLeft, Camera, X } from "lucide-react-native";
import React, { useState } from "react";
import { Image, Pressable, ScrollView, TextInput, View } from "react-native";
import { useLang } from "../lib/i18n";
import { takePhoto } from "../lib/media";
import { useTheme } from "../theme/ThemeProvider";
import { fonts, radius, Tone } from "../theme/tokens";
import { T } from "./Text";

export function ScreenHeader({ title, sub, right }: { title: string; sub?: string | null; right?: React.ReactNode }) {
  const t = useTheme();
  const router = useRouter();
  const { tr } = useLang();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel={tr("Back")}><ArrowLeft size={22} color={t.fg} /></Pressable>
      <View style={{ flex: 1 }}>
        <T v="title" numberOfLines={1}>{title}</T>
        {sub ? <T v="small" muted numberOfLines={1}>{sub}</T> : null}
      </View>
      {right}
    </View>
  );
}

export type ChipOption<V extends string> = { value: V; label: string; tone?: Tone };
/** One choice (or several with multi) from a short list, as tappable chips. */
export function Chips<V extends string>({ options, value, onChange, multi }: {
  options: ChipOption<V>[]; value: V | V[] | null; onChange: (v: V) => void; multi?: boolean;
}) {
  const t = useTheme();
  const on = (v: V) => (multi ? (value as V[] | null ?? []).includes(v) : value === v);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {options.map((o) => {
        const sel = on(o.value);
        const tn = t.tone(o.tone ?? "brand");
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole={multi ? "checkbox" : "radio"} accessibilityState={{ selected: sel }}
            style={{ paddingHorizontal: 12, minHeight: 38, borderRadius: 10, justifyContent: "center",
              backgroundColor: sel ? tn.tint : t.card, borderWidth: 1, borderColor: sel ? tn.text : t.border }}>
            <T v="bodyStrong" color={sel ? tn.text : t.fgSoft}>{o.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function NotesBox({ label, value, onChange, placeholder, lines = 3 }: {
  label: string; value: string; onChange: (s: string) => void; placeholder?: string; lines?: number;
}) {
  const t = useTheme();
  const { lang } = useLang();
  return (
    <View style={{ gap: 6 }}>
      <T v="smallStrong" soft>{label}</T>
      <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={t.mutedFg} multiline
        textAlignVertical="top"
        style={{ minHeight: 24 * lines + 20, padding: 12, borderRadius: radius.lg, backgroundColor: t.input, borderWidth: 1, borderColor: t.border,
          color: t.fg, fontFamily: fonts.body, fontSize: 16, writingDirection: lang === "ur" ? "rtl" : "ltr" }} />
    </View>
  );
}

/** Photos taken now, with the camera. Tap × to drop one. */
export function PhotoStrip({ photos, onChange, max = 6, label }: { photos: string[]; onChange: (p: string[]) => void; max?: number; label?: string }) {
  const t = useTheme();
  const { tr } = useLang();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setBusy(true); setErr(null);
    try { const p = await takePhoto(); if (p) onChange([...photos, p]); }
    catch (e) { setErr(tr((e as Error).message)); }
    setBusy(false);
  };
  return (
    <View style={{ gap: 6 }}>
      <T v="smallStrong" soft>{label ?? tr("Photos")}</T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {photos.map((p, i) => (
          <View key={i}>
            <Image source={{ uri: p }} style={{ width: 76, height: 76, borderRadius: 12, borderWidth: 1, borderColor: t.border }} />
            <Pressable onPress={() => onChange(photos.filter((_, j) => j !== i))} hitSlop={8} accessibilityLabel={tr("Remove photo")}
              style={{ position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: 11, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" }}>
              <X size={14} color="#fff" />
            </Pressable>
          </View>
        ))}
        {photos.length < max ? (
          <Pressable onPress={() => void add()} disabled={busy} accessibilityLabel={tr("Take a photo")}
            style={{ width: 76, height: 76, borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: t.border, backgroundColor: t.card,
              alignItems: "center", justifyContent: "center", gap: 2, opacity: busy ? 0.5 : 1 }}>
            <Camera size={20} color={t.mutedFg} />
            <T v="small" muted>{tr("Camera")}</T>
          </Pressable>
        ) : null}
      </ScrollView>
      {err ? <T v="small" color={t.tone("danger").text}>{err}</T> : null}
    </View>
  );
}

/** English ⇄ اردو. Remembered on the phone. */
export function LangSwitch() {
  const t = useTheme();
  const { lang, setLang } = useLang();
  return (
    <Pressable onPress={() => setLang(lang === "ur" ? "en" : "ur")} hitSlop={8} accessibilityRole="button"
      accessibilityLabel={lang === "ur" ? "English" : "Urdu"}
      style={{ paddingHorizontal: 10, height: 32, borderRadius: 9, borderWidth: 1, borderColor: t.border, backgroundColor: t.card, justifyContent: "center" }}>
      <T v="smallStrong" soft>{lang === "ur" ? "English" : "اردو"}</T>
    </Pressable>
  );
}
