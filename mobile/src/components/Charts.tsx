import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { Tone } from "../theme/tokens";
import { T } from "./Text";
import { tap } from "./ui";

/** Single-series column chart. Tap a column for its value (touch stands in for hover). No legend — the section title names the series. */
export function Columns({ data, height = 120, format = (n: number) => String(n), tone = "brand" }: { data: { label: string; value: number }[]; height?: number; format?: (n: number) => string; tone?: Tone }) {
  const t = useTheme();
  const [sel, setSel] = useState<number | null>(data.length - 1);
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <View>
      <View style={{ height: 22, justifyContent: "flex-end" }}>
        {sel !== null && data[sel] ? (
          <T v="small" muted>
            {data[sel]!.label} · <T v="mono" style={{ fontSize: 13 }}>{format(data[sel]!.value)}</T>
          </T>
        ) : null}
      </View>
      <View style={{ height, flexDirection: "row", alignItems: "flex-end", gap: 6, marginTop: 6, borderBottomWidth: 1, borderBottomColor: t.border }}>
        {data.map((d, i) => (
          <Pressable key={d.label + i} onPress={() => { tap(); setSel(i); }} style={{ flex: 1, height: "100%", justifyContent: "flex-end" }}>
            <View
              style={{
                height: Math.max(3, (d.value / max) * (height - 4)), borderTopLeftRadius: 4, borderTopRightRadius: 4,
                backgroundColor: sel === i ? t.tone(tone).strong : t.tone(tone).line,
              }}
            />
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
        {data.map((d, i) => (
          <T key={d.label + i} v="small" muted center numberOfLines={1} style={{ flex: 1, fontSize: 11 }}>{d.label}</T>
        ))}
      </View>
    </View>
  );
}

/** Ranked horizontal bars with direct labels — used for "by category" breakdowns. One hue: magnitude, not identity. */
export function Bars({ data, format = (n: number) => String(n), max: maxIn }: { data: { label: string; value: number; sub?: string }[]; format?: (n: number) => string; max?: number }) {
  const t = useTheme();
  const max = maxIn ?? Math.max(1, ...data.map((d) => d.value));
  return (
    <View style={{ gap: 12 }}>
      {data.map((d) => (
        <View key={d.label}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 5, gap: 8 }}>
            <T v="small" soft numberOfLines={1} style={{ flex: 1, fontSize: 14 }}>{d.label}</T>
            <T v="mono" style={{ fontSize: 13 }}>{format(d.value)}</T>
          </View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: t.muted, overflow: "hidden" }}>
            <View style={{ width: `${Math.max(2, (d.value / max) * 100)}%`, height: 8, borderRadius: 4, backgroundColor: t.brand[500] }} />
          </View>
          {d.sub ? <T v="small" muted style={{ fontSize: 12, marginTop: 3 }}>{d.sub}</T> : null}
        </View>
      ))}
    </View>
  );
}

/** Part-to-whole bar in status colours, always paired with labelled counts (status is never colour-alone). */
export function StatusBar({ parts }: { parts: { label: string; value: number; tone: Tone }[] }) {
  const t = useTheme();
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <View>
      <View style={{ flexDirection: "row", height: 12, borderRadius: 6, overflow: "hidden", gap: 2 }}>
        {parts.filter((p) => p.value > 0).map((p) => (
          <View key={p.label} style={{ flex: p.value / total, backgroundColor: t.tone(p.tone).solid }} />
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, marginTop: 10 }}>
        {parts.map((p) => (
          <View key={p.label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: t.tone(p.tone).solid }} />
            <T v="small" soft>{p.label}</T>
            <T v="mono" style={{ fontSize: 13 }}>{p.value}</T>
          </View>
        ))}
      </View>
    </View>
  );
}

export function Progress({ value, max, tone = "brand" }: { value: number; max: number; tone?: Tone }) {
  const t = useTheme();
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: t.muted, overflow: "hidden" }}>
      <View style={{ width: `${Math.min(100, (value / Math.max(1, max)) * 100)}%`, height: 6, backgroundColor: t.tone(tone).solid }} />
    </View>
  );
}
