import { ChevronLeft, ChevronRight } from "lucide-react-native";
import React from "react";
import { Pressable, View } from "react-native";
import { TODAY } from "../data/seed";
import { daysInMonth, fmtMonth } from "../lib/format";
import { useTheme } from "../theme/ThemeProvider";
import { T } from "./Text";
import { IconBtn, tap } from "./ui";

export const shiftMonth = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y!, m! - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export function MonthStepper({ month, onChange, max = TODAY.slice(0, 7) }: { month: string; onChange: (m: string) => void; max?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <IconBtn icon={ChevronLeft} label="Previous month" onPress={() => onChange(shiftMonth(month, -1))} />
      <T v="h3" center style={{ flex: 1 }}>{fmtMonth(month)}</T>
      <IconBtn icon={ChevronRight} label="Next month" onPress={() => month < max && onChange(shiftMonth(month, 1))} />
    </View>
  );
}

/** Seven-column month calendar (Mon-first). Each cell renders whatever the caller needs. */
export function MonthGrid({ month, render, onPress, selected }: { month: string; render?: (date: string, day: number) => React.ReactNode; onPress?: (date: string) => void; selected?: string | null }) {
  const t = useTheme();
  const [y, m] = month.split("-").map(Number);
  const lead = (new Date(y!, m! - 1, 1).getDay() + 6) % 7;
  const n = daysInMonth(month);
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  while (cells.length % 7) cells.push(null);
  return (
    <View>
      <View style={{ flexDirection: "row", marginBottom: 6 }}>
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <T key={i} v="eyebrow" muted center style={{ flex: 1, fontSize: 11 }}>{d}</T>
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {cells.map((d, i) => {
          const isToday = d === TODAY;
          const sel = d && d === selected;
          return (
            <View key={i} style={{ width: `${100 / 7}%`, padding: 2 }}>
              {d ? (
                <Pressable
                  disabled={!onPress}
                  onPress={() => { tap(); onPress?.(d); }}
                  style={{
                    aspectRatio: 1, borderRadius: 8, alignItems: "center", justifyContent: "center", gap: 2,
                    backgroundColor: sel ? t.tone("brand").tint : t.card, borderWidth: isToday || sel ? 1.5 : 1, borderColor: sel || isToday ? t.brand[500] : t.border,
                    opacity: d > TODAY ? 0.45 : 1,
                  }}
                >
                  <T v="mono" style={{ fontSize: 11, lineHeight: 13 }} muted={!isToday}>{Number(d.slice(8))}</T>
                  {render?.(d, Number(d.slice(8)))}
                </Pressable>
              ) : (
                <View style={{ aspectRatio: 1 }} />
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}
