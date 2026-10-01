import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import { accents, brandPalettes, dark, light, mix, Palette, Tone } from "./tokens";

type ToneSet = { solid: string; strong: string; text: string; tint: string; tintStrong: string; line: string };

export type Theme = Palette & {
  mode: "light" | "dark";
  brand: { 500: string; 600: string; 700: string };
  tone: (t: Tone) => ToneSet;
};

type Ctx = {
  theme: Theme;
  modePref: "system" | "light" | "dark";
  setModePref: (m: "system" | "light" | "dark") => void;
  brandKey: string;
  setBrandKey: (k: string) => void;
};

const ThemeCtx = createContext<Ctx | null>(null);
const MODE_KEY = "ggs.mode";
const BRAND_KEY = "ggs.brand";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [modePref, setModePrefState] = useState<"system" | "light" | "dark">("system");
  const [brandKey, setBrandKeyState] = useState("amber");

  useEffect(() => {
    AsyncStorage.multiGet([MODE_KEY, BRAND_KEY])
      .then(([[, m], [, b]]) => {
        if (m === "light" || m === "dark" || m === "system") setModePrefState(m);
        if (b && brandPalettes[b]) setBrandKeyState(b);
      })
      .catch(() => {});
  }, []);

  const setModePref = (m: "system" | "light" | "dark") => {
    setModePrefState(m);
    AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
  };
  const setBrandKey = (k: string) => {
    setBrandKeyState(k);
    AsyncStorage.setItem(BRAND_KEY, k).catch(() => {});
  };

  const theme = useMemo<Theme>(() => {
    const mode = modePref === "system" ? (system === "dark" ? "dark" : "light") : modePref;
    const p = mode === "dark" ? dark : light;
    const brand = brandPalettes[brandKey] ?? accents.brand;
    const tone = (t: Tone): ToneSet => {
      if (t === "neutral") {
        return { solid: p.mutedFg, strong: p.fgSoft, text: p.fgSoft, tint: p.muted, tintStrong: p.border, line: p.borderStrong };
      }
      const r = t === "brand" ? brand : accents[t];
      return {
        solid: r[500],
        strong: r[600],
        // Text on a tint: -700 in light, -500 in dark (web rule).
        text: p.dark ? r[500] : r[700],
        tint: mix(r[500], p.card, 14),
        tintStrong: mix(r[500], p.card, 26),
        line: mix(r[500], p.card, 42),
      };
    };
    return { ...p, mode, brand, tone };
  }, [modePref, system, brandKey]);

  return (
    <ThemeCtx.Provider value={{ theme, modePref, setModePref, brandKey, setBrandKey }}>{children}</ThemeCtx.Provider>
  );
}

export function useThemeCtx() {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error("ThemeProvider missing");
  return c;
}

export const useTheme = () => useThemeCtx().theme;
