// English / Urdu for the Attendance screens, as web lib/lang.tsx.
//
//   tr("Present")                    → "حاضر" in Urdu, "Present" in English
//   tr("{n} on roster", { n: 12 })   → placeholders filled in either language
//   useLang()                        → re-renders the caller when the choice flips
//   <LanguageToggle />               → one tap switches English ↔ اردو
//
// The dictionary is the web's own (lib/web/lang.ur.ts, copied by
// scripts/sync-web-lib.mjs), so both apps say the same thing. The English text
// is the key: a string with no entry shows in English, never blank. Names typed
// into the system are data and are not translated. Called `tr` here because
// every screen already calls its theme `t`.
//
// Remembered on the device (AsyncStorage). Exports stay in English, as on web.

import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useSyncExternalStore } from "react";
import { Pressable } from "react-native";
import { T } from "../components/Text";
import { tap } from "../components/ui";
import { useTheme } from "../theme/ThemeProvider";
import { radius } from "../theme/tokens";
import { URDU } from "./web/lang.ur";

export type Lang = "en" | "ur";

const KEY = "ggs.attendance.lang";
const listeners = new Set<() => void>();
let current: Lang = "en";

AsyncStorage.getItem(KEY)
  .then((v) => { if (v === "ur" && current !== "ur") { current = "ur"; for (const fn of listeners) fn(); } })
  .catch(() => {});

export function setLang(next: Lang) {
  current = next;
  AsyncStorage.setItem(KEY, next).catch(() => {});
  for (const fn of listeners) fn();
}

const getLang = (): Lang => current;
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** Translate one English string. Pair with useLang() so the caller re-renders. */
export function tr(en: string, vars?: Record<string, string | number>): string {
  const s = current === "ur" ? URDU[en] ?? en : en;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m: string, k: string) => (k in vars ? String(vars[k]) : m));
}

export function useLang(): { lang: Lang; tr: typeof tr; setLang: typeof setLang } {
  const lang = useSyncExternalStore(subscribe, getLang, getLang);
  return { lang, tr, setLang };
}

/** Header action: shows the language you would switch TO. */
export function LanguageToggle() {
  const t = useTheme();
  const { lang } = useLang();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={lang === "ur" ? "Switch to English" : "اردو میں دیکھیں"}
      onPress={() => { tap(); setLang(lang === "ur" ? "en" : "ur"); }}
      style={({ pressed }) => ({
        height: 40, minWidth: 52, paddingHorizontal: 12, borderRadius: radius.pill,
        alignItems: "center", justifyContent: "center",
        backgroundColor: pressed ? t.muted : t.card, borderWidth: 1, borderColor: t.border,
      })}
    >
      <T v="smallStrong">{lang === "ur" ? "English" : "اردو"}</T>
    </Pressable>
  );
}
