import React from "react";
import { Pressable, View } from "react-native";
import { T } from "../../components/Text";
import { tap } from "../../components/ui";
import type { AttStatus } from "../../data/seed";
import { useTheme } from "../../theme/ThemeProvider";
import { radius, Tone } from "../../theme/tokens";

// P/A/L/DD/X — the web app's attendance mark vocabulary and colours.
export const MARK: Record<AttStatus, { code: string; label: string; tone: Tone }> = {
  present: { code: "P", label: "Present", tone: "success" },
  absent: { code: "A", label: "Absent", tone: "danger" },
  leave: { code: "L", label: "Leave", tone: "warning" },
  double_duty: { code: "DD", label: "Double duty", tone: "info" },
  rest_day: { code: "X", label: "Rest day", tone: "neutral" },
  relief_cover: { code: "R", label: "Relief cover", tone: "info" },
};

export const PICKABLE: AttStatus[] = ["present", "absent", "leave", "double_duty"];

/** Four big thumb targets — a supervisor marks exceptions standing at the gate. */
export function StatusPick({ value, onChange, disabled }: { value: AttStatus | null; onChange: (s: AttStatus) => void; disabled?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      {PICKABLE.map((s) => {
        const m = MARK[s];
        const on = value === s;
        const tn = t.tone(m.tone);
        return (
          <Pressable
            key={s}
            disabled={disabled}
            onPress={() => { tap(); onChange(s); }}
            accessibilityLabel={m.label}
            style={{
              flex: 1, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center",
              backgroundColor: on ? tn.strong : "transparent", borderWidth: 1, borderColor: on ? tn.strong : t.border, opacity: disabled ? 0.5 : 1,
            }}
          >
            <T v="monoLg" style={{ fontSize: 14 }} color={on ? (m.tone === "warning" ? t.onBrand : "#fff") : tn.text}>{m.code}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function MarkCell({ s, size = 26, onPress, label }: { s: AttStatus | null; size?: number; onPress?: () => void; label?: string }) {
  const t = useTheme();
  const m = s ? MARK[s] : null;
  const tn = m ? t.tone(m.tone) : null;
  const inner = (
    <View
      style={{
        width: size, height: size, borderRadius: 5, alignItems: "center", justifyContent: "center",
        backgroundColor: tn ? tn.tint : "transparent", borderWidth: 1, borderColor: tn ? tn.line : t.border,
      }}
    >
      <T v="mono" style={{ fontSize: size < 24 ? 9 : 10, lineHeight: 12 }} color={tn ? tn.text : t.mutedFg}>{m ? m.code : label ?? ""}</T>
    </View>
  );
  if (!onPress) return inner;
  return <Pressable onPress={() => { tap(); onPress(); }} hitSlop={2}>{inner}</Pressable>;
}

export function MarkTag({ s }: { s: AttStatus | null }) {
  const t = useTheme();
  if (!s) return null;
  const m = MARK[s];
  return <T v="monoLg" style={{ fontSize: 10, lineHeight: 12 }} color={m.tone === "neutral" ? t.mutedFg : t.tone(m.tone).text}>{m.code}</T>;
}
