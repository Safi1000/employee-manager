// English / Urdu (Shayan, 30 Oct 2026: "once the app is finalised an option to
// change language to Urdu should be there").
//
// The English sentence IS the key: tr("Today's attendance") looks it up in UR
// and falls back to the English when there is no translation, so a string that
// was missed shows in English rather than as a blank or a key. Placeholders are
// {name}. The server's messages (refusals, flags) go through tr() too, so the
// common ones read in Urdu; one nobody translated stays English.
//
// Urdu text is set right-to-left by <T>; the screen layout itself stays as it
// is (rows do not mirror), which keeps every screen working in both languages.
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { UR, UR_PATTERNS } from "./ur";

export type Lang = "en" | "ur";
type Vars = Record<string, string | number | null | undefined>;
type Ctx = { lang: Lang; setLang: (l: Lang) => void; tr: (en: string, vars?: Vars) => string };

const LangCtx = createContext<Ctx | null>(null);
const KEY = "ggs.lang";

const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")) : s);

/** Exact sentence first; then the server's sentences that carry a name or a number. */
function urdu(en: string): string {
  if (UR[en]) return UR[en];
  for (const [re, ur] of UR_PATTERNS) if (re.test(en)) return en.replace(re, ur);
  return en;
}

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    AsyncStorage.getItem(KEY).then((v) => { if (v === "ur" || v === "en") setLangState(v); }).catch(() => {});
  }, []);
  const setLang = useCallback((l: Lang) => { setLangState(l); AsyncStorage.setItem(KEY, l).catch(() => {}); }, []);
  const tr = useCallback((en: string, vars?: Vars) => fill(lang === "ur" ? urdu(en) : en, vars), [lang]);
  const value = useMemo(() => ({ lang, setLang, tr }), [lang, setLang, tr]);
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

export function useLang() {
  const c = useContext(LangCtx);
  if (!c) throw new Error("LangProvider missing");
  return c;
}
