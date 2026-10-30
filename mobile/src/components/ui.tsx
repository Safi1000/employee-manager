import { LucideIcon, Search, X } from "lucide-react-native";
import React from "react";
import { ActivityIndicator, Image, Pressable, StyleProp, TextInput, TextInputProps, View, ViewStyle } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { fonts, radius, Tone } from "../theme/tokens";
import { T } from "./Text";

type BtnVariant = "primary" | "secondary" | "ghost";
export function Button({
  label, onPress, variant = "primary", icon: Icon, disabled, loading, style,
}: { label: string; onPress?: () => void; variant?: BtnVariant; icon?: LucideIcon; disabled?: boolean; loading?: boolean; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const bg = { primary: t.brand[500], secondary: t.card, ghost: "transparent" }[variant];
  const fg = { primary: t.onBrand, secondary: t.fg, ghost: t.fgSoft }[variant];
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        {
          height: 50, paddingHorizontal: 18, borderRadius: radius.lg, backgroundColor: bg,
          flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
          borderWidth: variant === "secondary" ? 1 : 0, borderColor: t.border, opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : Icon ? <Icon size={18} color={fg} strokeWidth={2} /> : null}
      <T v="bodyStrong" color={fg}>{label}</T>
    </Pressable>
  );
}

export function Input({ label, helper, style, mono, ...rest }: TextInputProps & { label: string; helper?: string; mono?: boolean }) {
  const t = useTheme();
  const [focus, setFocus] = React.useState(false);
  return (
    <View style={[{ marginBottom: 16 }, style as ViewStyle]}>
      <T v="smallStrong" soft style={{ marginBottom: 6 }}>{label}</T>
      <TextInput
        placeholderTextColor={t.mutedFg}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        {...rest}
        style={{
          height: 52, paddingHorizontal: 14, borderRadius: radius.lg, backgroundColor: t.input, borderWidth: 1,
          borderColor: focus ? t.brand[500] : t.border, color: t.fg, fontFamily: mono ? fonts.monoBold : fonts.body,
          fontSize: mono ? 20 : 17, letterSpacing: mono ? 4 : 0,
        }}
      />
      {helper ? <T v="small" muted style={{ marginTop: 4 }}>{helper}</T> : null}
    </View>
  );
}

export function SearchBar({ value, onChange, placeholder = "Search" }: { value: string; onChange: (s: string) => void; placeholder?: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: 46, borderRadius: radius.lg, backgroundColor: t.card, borderWidth: 1, borderColor: t.border, paddingHorizontal: 12, gap: 8 }}>
      <Search size={17} color={t.mutedFg} />
      <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={t.mutedFg} autoCorrect={false}
        style={{ flex: 1, color: t.fg, fontFamily: fonts.body, fontSize: 16, height: 46 }} />
      {value ? <Pressable onPress={() => onChange("")} hitSlop={8}><X size={16} color={t.mutedFg} /></Pressable> : null}
    </View>
  );
}

export function Card({ children, style, onPress }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const t = useTheme();
  const box: ViewStyle = { backgroundColor: t.card, borderRadius: radius.xl, borderWidth: 1, borderColor: t.border, padding: 16 };
  if (!onPress) return <View style={[box, style]}>{children}</View>;
  return <Pressable onPress={onPress} style={({ pressed }) => [box, { opacity: pressed ? 0.85 : 1 }, style]}>{children}</Pressable>;
}

export function Badge({ label, tone = "neutral" }: { label: string; tone?: Tone }) {
  const t = useTheme();
  const tn = t.tone(tone);
  return (
    <View style={{ alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: tn.tint, borderWidth: 1, borderColor: tn.line }}>
      <T v="smallStrong" color={tn.text} style={{ fontSize: 12 }}>{label}</T>
    </View>
  );
}

export function Banner({ tone = "warning", title, sub }: { tone?: Tone; title: string; sub?: string }) {
  const t = useTheme();
  const tn = t.tone(tone);
  return (
    <View style={{ backgroundColor: tn.tint, borderColor: tn.line, borderWidth: 1, borderRadius: radius.lg, padding: 12, flexDirection: "row", gap: 10, marginBottom: 14 }}>
      <View style={{ width: 4, alignSelf: "stretch", borderRadius: 2, backgroundColor: tn.solid }} />
      <View style={{ flex: 1 }}>
        <T v="smallStrong" color={tn.text} style={{ fontSize: 14 }}>{title}</T>
        {sub ? <T v="small" soft style={{ marginTop: 2 }}>{sub}</T> : null}
      </View>
    </View>
  );
}

export function Empty({ title, sub, icon: Icon }: { title: string; sub?: string; icon?: LucideIcon }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: "center", paddingVertical: 36, paddingHorizontal: 24, gap: 8 }}>
      {Icon && (
        <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: t.muted, alignItems: "center", justifyContent: "center", marginBottom: 4 }}>
          <Icon size={24} color={t.mutedFg} />
        </View>
      )}
      <T v="bodyStrong" center>{title}</T>
      {sub ? <T v="small" muted center>{sub}</T> : null}
    </View>
  );
}

export function Avatar({ name, uri }: { name: string; uri?: string | null }) {
  const t = useTheme();
  const tn = t.tone("brand");
  const letters = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  if (uri) return <Image source={{ uri }} accessibilityLabel={name} style={{ width: 40, height: 40, borderRadius: 13, borderWidth: 1, borderColor: tn.line }} />;
  return (
    <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: tn.tint, borderWidth: 1, borderColor: tn.line, alignItems: "center", justifyContent: "center" }}>
      <T v="smallStrong" color={tn.text} style={{ fontSize: 14 }}>{letters}</T>
    </View>
  );
}
