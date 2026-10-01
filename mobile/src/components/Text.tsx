import React from "react";
import { Text, TextProps, TextStyle } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { fonts } from "../theme/tokens";

type Variant = "display" | "title" | "h3" | "body" | "bodyStrong" | "small" | "smallStrong" | "eyebrow" | "mono" | "monoLg" | "figure";

const base: Record<Variant, TextStyle> = {
  display: { fontFamily: fonts.displayHeavy, fontSize: 28, lineHeight: 32, letterSpacing: -0.6 },
  title: { fontFamily: fonts.display, fontSize: 20, lineHeight: 24, letterSpacing: -0.3 },
  h3: { fontFamily: fonts.display, fontSize: 16, lineHeight: 20, letterSpacing: -0.2 },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21 },
  bodyStrong: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 21 },
  small: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  smallStrong: { fontFamily: fonts.semibold, fontSize: 13, lineHeight: 18 },
  // Floor of 11px for micro-labels (handoff gap #20 — the web's 10–11px labels go illegible on phones).
  eyebrow: { fontFamily: fonts.bold, fontSize: 11, lineHeight: 14, letterSpacing: 1.3, textTransform: "uppercase" },
  mono: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 18 },
  monoLg: { fontFamily: fonts.monoBold, fontSize: 16, lineHeight: 20 },
  figure: { fontFamily: fonts.displayHeavy, fontSize: 24, lineHeight: 28, letterSpacing: -0.5 },
};

export type TProps = TextProps & { v?: Variant; color?: string; muted?: boolean; soft?: boolean; center?: boolean; right?: boolean };

export function T({ v = "body", color, muted, soft, center, right, style, ...rest }: TProps) {
  const t = useTheme();
  const c = color ?? (muted ? t.mutedFg : soft ? t.fgSoft : t.fg);
  return (
    <Text
      {...rest}
      style={[base[v], { color: c }, center && { textAlign: "center" }, right && { textAlign: "right" }, style]}
    />
  );
}
