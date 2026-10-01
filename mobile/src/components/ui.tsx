import * as Haptics from "expo-haptics";
import { Check, ChevronRight, LucideIcon, Search, X } from "lucide-react-native";
import React from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from "react-native";
import { amountInWords, initials } from "../lib/format";
import { useTheme } from "../theme/ThemeProvider";
import { fonts, radius, Tone } from "../theme/tokens";
import { T } from "./Text";

export const tap = () => {
  if (Platform.OS !== "web") Haptics.selectionAsync().catch(() => {});
};

// ---------------------------------------------------------------- status → tone
// Canonical map, from the web app's lib/tone.ts toneOfStatus().
export function toneOf(status: string | null | undefined): Tone {
  const s = String(status ?? "").toLowerCase().replace(/\s+/g, "_");
  if (["cleared", "paid", "disbursed", "received", "active", "completed", "done", "present", "confirmed", "resolved", "approved", "filed", "posted", "closed_ok", "green", "verified"].includes(s)) return "success";
  if (["overdue", "failed", "rejected", "absent", "expired", "critical", "fired", "bounced", "denied", "blocking", "red", "terminated", "adverse", "lost"].includes(s)) return "danger";
  if (["pending", "due", "leave", "on_leave", "partial", "in_progress", "warning", "high", "awaiting", "under_investigation", "unpaid", "amber", "open", "negotiating", "trial", "past_due"].includes(s)) return "warning";
  if (["draft", "todo", "info", "scheduled", "medium", "reported", "double_duty", "review", "proposal_sent"].includes(s)) return "info";
  return "neutral";
}

// ---------------------------------------------------------------- Card
export function Card({ children, style, pad = 16, onPress, accent }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; pad?: number; onPress?: () => void; accent?: Tone }) {
  const t = useTheme();
  const body = (
    <View
      style={[
        { backgroundColor: t.card, borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.border, padding: pad, overflow: "hidden" },
        accent && { borderLeftWidth: 4, borderLeftColor: t.tone(accent).solid },
        style,
      ]}
    >
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={() => { tap(); onPress(); }} style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.995 : 1 }] }]}>
      {body}
    </Pressable>
  );
}

// ---------------------------------------------------------------- Section
export function Section({ title, count, action, children, style, hint }: { title: string; count?: number | string; action?: React.ReactNode; hint?: string; children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View style={[{ marginTop: 22 }, style]}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10, gap: 8 }}>
        <View style={{ width: 6, height: 6, borderRadius: 1, backgroundColor: t.brand[500] }} />
        <T v="eyebrow" soft style={{ flexShrink: 1 }}>{title}</T>
        {count !== undefined && <T v="mono" muted style={{ fontSize: 12 }}>{count}</T>}
        <View style={{ flex: 1, height: StyleSheet.hairlineWidth * 2, backgroundColor: t.border, marginLeft: 4 }} />
        {action}
      </View>
      {hint ? <T v="small" muted style={{ marginTop: -4, marginBottom: 10 }}>{hint}</T> : null}
      {children}
    </View>
  );
}

// ---------------------------------------------------------------- Badge
export function Badge({ label, tone, dot, solid, small }: { label: string; tone?: Tone; dot?: boolean; solid?: boolean; small?: boolean }) {
  const t = useTheme();
  const tn = t.tone(tone ?? toneOf(label));
  return (
    <View
      style={{
        flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start",
        paddingHorizontal: small ? 6 : 8, paddingVertical: small ? 1 : 3, borderRadius: 6,
        backgroundColor: solid ? tn.strong : tn.tint, borderWidth: solid ? 0 : 1, borderColor: tn.line,
      }}
    >
      {dot && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: solid ? "#fff" : tn.solid }} />}
      <T v="smallStrong" style={{ fontSize: small ? 11 : 12, lineHeight: 16 }} color={solid ? (tone === "brand" || tone === "warning" ? t.onBrand : "#fff") : tn.text}>
        {label}
      </T>
    </View>
  );
}

// ---------------------------------------------------------------- Button
type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
export function Button({
  label, onPress, variant = "primary", icon: Icon, size = "md", disabled, loading, full, style,
}: { label: string; onPress?: () => void; variant?: BtnVariant; icon?: LucideIcon; size?: "sm" | "md" | "lg"; disabled?: boolean; loading?: boolean; full?: boolean; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const bg = { primary: t.brand[500], secondary: t.card, ghost: "transparent", danger: t.tone("danger").strong, success: t.tone("success").strong }[variant];
  const fg = { primary: t.onBrand, secondary: t.fg, ghost: t.fgSoft, danger: "#fff", success: "#fff" }[variant];
  const h = size === "sm" ? 36 : size === "lg" ? 52 : 44;
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={() => { tap(); onPress?.(); }}
      style={({ pressed }) => [
        {
          height: h, paddingHorizontal: size === "sm" ? 12 : 16, borderRadius: radius.lg, backgroundColor: bg,
          flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
          borderWidth: variant === "secondary" ? 1 : 0, borderColor: t.border, opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
        full && { alignSelf: "stretch", flexGrow: 1 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : Icon ? <Icon size={size === "sm" ? 16 : 18} color={fg} strokeWidth={2} /> : null}
      <T v="smallStrong" color={fg} style={{ fontSize: size === "lg" ? 16 : 14 }}>{label}</T>
    </Pressable>
  );
}

export function IconBtn({ icon: Icon, onPress, tone, label, size = 40, filled }: { icon: LucideIcon; onPress?: () => void; tone?: Tone; label?: string; size?: number; filled?: boolean }) {
  const t = useTheme();
  const c = tone ? t.tone(tone).text : t.fg;
  return (
    <Pressable
      accessibilityLabel={label}
      hitSlop={6}
      onPress={() => { tap(); onPress?.(); }}
      style={({ pressed }) => ({
        width: size, height: size, borderRadius: radius.lg, alignItems: "center", justifyContent: "center",
        backgroundColor: filled ? t.brand[500] : pressed ? t.muted : t.card, borderWidth: filled ? 0 : 1, borderColor: t.border,
      })}
    >
      <Icon size={18} color={filled ? t.onBrand : c} strokeWidth={2} />
    </Pressable>
  );
}

// ---------------------------------------------------------------- Stats
export type Stat = { label: string; value: string; tone?: Tone; hint?: string; onPress?: () => void; active?: boolean; icon?: LucideIcon };

/** The web's left-accent StatCard, as a 2-up phone grid. Odd counts let the last tile span. */
export function StatGrid({ items, cols = 2 }: { items: Stat[]; cols?: number }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      {items.map((s, i) => {
        const tone = t.tone(s.tone ?? "neutral");
        const span = items.length % cols === 1 && i === items.length - 1;
        const W = span ? "100%" : cols === 3 ? "31.5%" : "48.4%";
        const Wrap = s.onPress ? Pressable : View;
        return (
          <Wrap
            key={s.label}
            onPress={s.onPress ? () => { tap(); s.onPress!(); } : undefined}
            style={{
              width: W, backgroundColor: s.active ? tone.tint : t.card, borderRadius: radius.lg, borderWidth: 1,
              borderColor: s.active ? tone.line : t.border, borderLeftWidth: 4, borderLeftColor: tone.solid,
              paddingVertical: 12, paddingHorizontal: 12, minHeight: 78,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {s.icon && <s.icon size={13} color={t.mutedFg} strokeWidth={2} />}
              <T v="eyebrow" muted numberOfLines={1} style={{ letterSpacing: 0.8, flexShrink: 1 }}>{s.label}</T>
            </View>
            <T v="figure" numberOfLines={1} adjustsFontSizeToFit style={{ marginTop: 6, fontSize: cols === 3 ? 20 : 22 }} color={s.tone && s.tone !== "neutral" ? tone.text : t.fg}>
              {s.value}
            </T>
            {s.hint ? <T v="small" muted numberOfLines={1} style={{ fontSize: 12, marginTop: 2 }}>{s.hint}</T> : null}
          </Wrap>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- Tabs (one scrollable strip — handoff gap #8)
export type TabItem<K extends string> = { key: K; label: string; count?: number };
export function Tabs<K extends string>({ items, value, onChange, style }: { items: TabItem<K>[]; value: K; onChange: (k: K) => void; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[{ flexGrow: 0 }, style]} contentContainerStyle={{ gap: 6, paddingRight: 16 }}>
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable
            key={it.key}
            onPress={() => { tap(); onChange(it.key); }}
            style={{
              flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, height: 36, borderRadius: radius.pill,
              backgroundColor: on ? t.fg : t.card, borderWidth: 1, borderColor: on ? t.fg : t.border,
            }}
          >
            <T v="smallStrong" color={on ? t.bg : t.fgSoft}>{it.label}</T>
            {it.count !== undefined && (
              <View style={{ minWidth: 20, paddingHorizontal: 5, height: 18, borderRadius: 9, backgroundColor: on ? t.brand[500] : t.muted, alignItems: "center", justifyContent: "center" }}>
                <T v="mono" style={{ fontSize: 11, lineHeight: 14 }} color={on ? t.onBrand : t.fgSoft}>{it.count}</T>
              </View>
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Two-to-four option segmented track (Payroll Run stages, Revenue/Cash basis). */
export function Segmented<K extends string>({ items, value, onChange }: { items: TabItem<K>[]; value: K; onChange: (k: K) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", backgroundColor: t.muted, borderRadius: radius.lg, padding: 3 }}>
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable
            key={it.key}
            onPress={() => { tap(); onChange(it.key); }}
            style={{ flex: 1, height: 34, borderRadius: radius.md, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 5, backgroundColor: on ? t.card : "transparent", borderWidth: on ? 1 : 0, borderColor: t.border }}
          >
            <T v="smallStrong" numberOfLines={1} color={on ? t.tone("brand").text : t.mutedFg}>{it.label}</T>
            {it.count !== undefined && <T v="mono" style={{ fontSize: 11 }} muted>{it.count}</T>}
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- Chips (filters)
export function Chips<K extends string>({ items, value, onChange, multi }: { items: TabItem<K>[]; value: K | K[]; onChange: (k: K) => void; multi?: boolean }) {
  const t = useTheme();
  const sel = (k: K) => (Array.isArray(value) ? value.includes(k) : value === k);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingRight: 16 }} style={{ flexGrow: 0 }}>
      {items.map((it) => {
        const on = sel(it.key);
        return (
          <Pressable
            key={it.key}
            onPress={() => { tap(); onChange(it.key); }}
            style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 11, height: 32, borderRadius: radius.md, borderWidth: 1, borderColor: on ? t.tone("brand").line : t.border, backgroundColor: on ? t.tone("brand").tint : "transparent" }}
          >
            {multi && on && <Check size={13} color={t.tone("brand").text} />}
            <T v="smallStrong" color={on ? t.tone("brand").text : t.fgSoft}>{it.label}</T>
            {it.count !== undefined && <T v="mono" style={{ fontSize: 11 }} muted>{it.count}</T>}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ---------------------------------------------------------------- Field columns (label/value grid)
export type FieldItem = { label: string; value: React.ReactNode; full?: boolean; mono?: boolean; tone?: Tone };
export function Fields({ items, cols = 2 }: { items: FieldItem[]; cols?: number }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 12 }}>
      {items.map((f, i) => (
        <View key={f.label + i} style={{ width: f.full ? "100%" : cols === 3 ? "33.33%" : "50%", paddingRight: 10 }}>
          <T v="eyebrow" muted style={{ fontSize: 11, letterSpacing: 0.7, marginBottom: 3 }}>{f.label}</T>
          {typeof f.value === "string" || typeof f.value === "number" ? (
            <T v={f.mono ? "mono" : "smallStrong"} color={f.tone ? t.tone(f.tone).text : undefined} style={{ fontSize: f.mono ? 13 : 14 }}>
              {f.value === "" || f.value === null ? "—" : f.value}
            </T>
          ) : (
            f.value
          )}
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- RecordCard (MobileCardList, as a native card)
export function RecordCard({
  title, subtitle, badge, accent, fields, tags, actions, onPress, leading, right, children,
}: {
  title: string; subtitle?: string; badge?: React.ReactNode; accent?: Tone; fields?: FieldItem[]; tags?: React.ReactNode;
  actions?: { label: string; onPress: () => void; tone?: Tone; icon?: LucideIcon }[]; onPress?: () => void; leading?: React.ReactNode; right?: React.ReactNode; children?: React.ReactNode;
}) {
  const t = useTheme();
  return (
    <Card pad={0} onPress={onPress} accent={accent} style={{ marginBottom: 10 }}>
      <View style={{ padding: 14, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
          {leading}
          <View style={{ flex: 1, minWidth: 0 }}>
            <T v="bodyStrong" numberOfLines={2}>{title}</T>
            {subtitle ? <T v="mono" muted numberOfLines={1} style={{ fontSize: 12, marginTop: 1 }}>{subtitle}</T> : null}
          </View>
          {badge}
          {right}
          {onPress && !right ? <ChevronRight size={18} color={t.mutedFg} style={{ marginTop: 2 }} /> : null}
        </View>
        {fields && fields.length > 0 && <Fields items={fields} />}
        {tags}
        {children}
      </View>
      {actions && actions.length > 0 && (
        <View style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: t.border }}>
          {actions.map((a, i) => (
            <Pressable
              key={a.label}
              onPress={() => { tap(); a.onPress(); }}
              style={({ pressed }) => ({ flex: 1, height: 44, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", borderLeftWidth: i ? 1 : 0, borderLeftColor: t.border, backgroundColor: pressed ? t.muted : "transparent" })}
            >
              {a.icon && <a.icon size={15} color={a.tone ? t.tone(a.tone).text : t.fgSoft} />}
              <T v="smallStrong" color={a.tone ? t.tone(a.tone).text : t.fgSoft}>{a.label}</T>
            </Pressable>
          ))}
        </View>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Row (dense list line)
export function Row({ title, subtitle, left, right, onPress, last, meta }: { title: React.ReactNode; subtitle?: React.ReactNode; left?: React.ReactNode; right?: React.ReactNode; onPress?: () => void; last?: boolean; meta?: string }) {
  const t = useTheme();
  const inner = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: last ? 0 : 1, borderBottomColor: t.border }}>
      {left}
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof title === "string" ? <T v="smallStrong" style={{ fontSize: 14 }} numberOfLines={2}>{title}</T> : title}
        {subtitle ? (typeof subtitle === "string" ? <T v="small" muted numberOfLines={2} style={{ marginTop: 1 }}>{subtitle}</T> : subtitle) : null}
        {meta ? <T v="mono" muted style={{ fontSize: 11, marginTop: 2 }}>{meta}</T> : null}
      </View>
      {right}
      {onPress && <ChevronRight size={16} color={t.mutedFg} />}
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable onPress={() => { tap(); onPress(); }} style={({ pressed }) => ({ backgroundColor: pressed ? t.muted : "transparent" })}>
      {inner}
    </Pressable>
  );
}

/** A card holding Rows. */
export function ListCard({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <Card pad={0} style={style}>{children}</Card>;
}

// ---------------------------------------------------------------- Ledger line (label ........ value)
export function Ledger({ label, value, strong, tone, indent, sub, top }: { label: string; value: string; strong?: boolean; tone?: Tone; indent?: boolean; sub?: string; top?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", paddingVertical: strong ? 10 : 7, gap: 8, borderTopWidth: top ? 1 : 0, borderTopColor: t.borderStrong, paddingLeft: indent ? 12 : 0 }}>
      <View style={{ flexShrink: 1 }}>
        <T v={strong ? "bodyStrong" : "small"} soft={!strong} style={!strong ? { fontSize: 14 } : undefined}>{label}</T>
        {sub ? <T v="small" muted style={{ fontSize: 12 }}>{sub}</T> : null}
      </View>
      <View style={{ flex: 1, borderBottomWidth: 1, borderBottomColor: t.border, borderStyle: "dotted", marginBottom: 4, minWidth: 12 }} />
      <T v={strong ? "monoLg" : "mono"} color={tone ? t.tone(tone).text : t.fg} style={!strong ? { fontSize: 14 } : undefined}>{value}</T>
    </View>
  );
}

// ---------------------------------------------------------------- Inputs
export function Label({ children, required }: { children: string; required?: boolean }) {
  const t = useTheme();
  return (
    <T v="smallStrong" soft style={{ marginBottom: 6 }}>
      {children}
      {required ? <T v="smallStrong" color={t.tone("danger").text}> *</T> : null}
    </T>
  );
}

export function Input({ label, helper, error, required, style, amount, ...rest }: TextInputProps & { label?: string; helper?: string; error?: string; required?: boolean; amount?: boolean }) {
  const t = useTheme();
  const [focus, setFocus] = React.useState(false);
  return (
    <View style={[{ marginBottom: 14 }, style as ViewStyle]}>
      {label ? <Label required={required}>{label}</Label> : null}
      <TextInput
        placeholderTextColor={t.mutedFg}
        keyboardType={amount ? "numeric" : rest.keyboardType}
        onFocus={(e) => { setFocus(true); rest.onFocus?.(e); }}
        onBlur={(e) => { setFocus(false); rest.onBlur?.(e); }}
        {...rest}
        style={{
          minHeight: rest.multiline ? 96 : 48, paddingHorizontal: 14, paddingTop: rest.multiline ? 12 : 0, borderRadius: radius.lg,
          backgroundColor: t.input, borderWidth: 1, borderColor: error ? t.tone("danger").solid : focus ? t.brand[500] : t.border,
          color: t.fg, fontFamily: amount ? fonts.mono : fonts.body, fontSize: 16, textAlignVertical: rest.multiline ? "top" : "center",
        }}
      />
      {amount && rest.value ? <T v="small" muted style={{ fontStyle: "italic", marginTop: 4, fontSize: 12 }}>{amountInWords(String(rest.value))}</T> : null}
      {error ? <T v="small" color={t.tone("danger").text} style={{ marginTop: 4 }}>{error}</T> : helper ? <T v="small" muted style={{ marginTop: 4 }}>{helper}</T> : null}
    </View>
  );
}

export function SearchBar({ value, onChange, placeholder = "Search" }: { value: string; onChange: (s: string) => void; placeholder?: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: 44, borderRadius: radius.lg, backgroundColor: t.card, borderWidth: 1, borderColor: t.border, paddingHorizontal: 12, gap: 8 }}>
      <Search size={17} color={t.mutedFg} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={t.mutedFg}
        autoCorrect={false}
        style={{ flex: 1, color: t.fg, fontFamily: fonts.body, fontSize: 16, height: 44 }}
      />
      {value ? (
        <Pressable onPress={() => onChange("")} hitSlop={8}>
          <X size={16} color={t.mutedFg} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function Toggle({ value, onChange, label, sub }: { value: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  const t = useTheme();
  return (
    <Pressable onPress={() => { tap(); onChange(!value); }} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 }}>
      <View style={{ flex: 1 }}>
        <T v="smallStrong" style={{ fontSize: 14 }}>{label}</T>
        {sub ? <T v="small" muted>{sub}</T> : null}
      </View>
      <View style={{ width: 46, height: 28, borderRadius: 14, padding: 3, backgroundColor: value ? t.brand[500] : t.borderStrong, alignItems: value ? "flex-end" : "flex-start" }}>
        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: value ? t.onBrand : t.card }} />
      </View>
    </Pressable>
  );
}

export function Checkbox({ value, onChange, label, sub }: { value: boolean; onChange: (v: boolean) => void; label?: string; sub?: string }) {
  const t = useTheme();
  return (
    <Pressable onPress={() => { tap(); onChange(!value); }} hitSlop={6} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: label ? 8 : 0 }}>
      <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: value ? t.brand[500] : t.borderStrong, backgroundColor: value ? t.brand[500] : "transparent", alignItems: "center", justifyContent: "center" }}>
        {value && <Check size={14} color={t.onBrand} strokeWidth={3} />}
      </View>
      {label ? (
        <View style={{ flex: 1 }}>
          <T v="small" style={{ fontSize: 14 }}>{label}</T>
          {sub ? <T v="mono" muted style={{ fontSize: 11 }}>{sub}</T> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------- misc
export function Avatar({ name, size = 36, tone }: { name: string; size?: number; tone?: Tone }) {
  const t = useTheme();
  const tn = t.tone(tone ?? "brand");
  return (
    <View style={{ width: size, height: size, borderRadius: size / 3, backgroundColor: tn.tint, borderWidth: 1, borderColor: tn.line, alignItems: "center", justifyContent: "center" }}>
      <T v="smallStrong" color={tn.text} style={{ fontSize: size * 0.36 }}>{initials(name)}</T>
    </View>
  );
}

export function Empty({ title, sub, icon: Icon }: { title: string; sub?: string; icon?: LucideIcon }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: "center", paddingVertical: 32, paddingHorizontal: 24, gap: 8 }}>
      {Icon && (
        <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: t.muted, alignItems: "center", justifyContent: "center", marginBottom: 4 }}>
          <Icon size={22} color={t.mutedFg} />
        </View>
      )}
      <T v="bodyStrong" center>{title}</T>
      {sub ? <T v="small" muted center>{sub}</T> : null}
    </View>
  );
}

export function Banner({ tone = "warning", title, sub, action }: { tone?: Tone; title: string; sub?: string; action?: React.ReactNode }) {
  const t = useTheme();
  const tn = t.tone(tone);
  return (
    <View style={{ backgroundColor: tn.tint, borderColor: tn.line, borderWidth: 1, borderRadius: radius.lg, padding: 12, flexDirection: "row", gap: 10, alignItems: "center", marginBottom: 12 }}>
      <View style={{ width: 4, alignSelf: "stretch", borderRadius: 2, backgroundColor: tn.solid }} />
      <View style={{ flex: 1 }}>
        <T v="smallStrong" color={tn.text} style={{ fontSize: 14 }}>{title}</T>
        {sub ? <T v="small" soft style={{ marginTop: 2 }}>{sub}</T> : null}
      </View>
      {action}
    </View>
  );
}

/** Contracted-vs-deployed meter: filled cells per headcount slot. The app's quiet signature. */
export function Strength({ contracted, deployed, exceptions = 0 }: { contracted: number; deployed: number; exceptions?: number }) {
  const t = useTheme();
  const n = Math.max(contracted, deployed);
  return (
    <View style={{ flexDirection: "row", gap: 3, flexWrap: "wrap" }}>
      {Array.from({ length: n }, (_, i) => {
        const filled = i < deployed - exceptions;
        const exc = i >= deployed - exceptions && i < deployed;
        const over = i >= contracted;
        return (
          <View
            key={i}
            style={{
              width: 14, height: 14, borderRadius: 3,
              backgroundColor: over ? t.tone("info").solid : filled ? t.tone("success").solid : exc ? t.tone("warning").solid : "transparent",
              borderWidth: filled || exc || over ? 0 : 1.5, borderColor: t.tone("danger").solid, borderStyle: "dashed",
            }}
          />
        );
      })}
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[{ height: 1, backgroundColor: t.border, marginVertical: 12 }, style]} />;
}

export function Gap({ h = 12 }: { h?: number }) {
  return <View style={{ height: h }} />;
}

export function HStack({ children, gap = 8, style, wrap }: { children: React.ReactNode; gap?: number; style?: StyleProp<ViewStyle>; wrap?: boolean }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap, flexWrap: wrap ? "wrap" : "nowrap" }, style]}>{children}</View>;
}
