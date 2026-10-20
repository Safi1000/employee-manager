// English / Urdu for the Attendance screens (asked 2026-10-20: "I need Urdu
// option in Attendance as well where I can freely switch between English and
// Urdu").
//
//   t("Present")                    → "حاضر" in Urdu, "Present" in English
//   t("{n} on roster", { n: 12 })   → placeholders filled in either language
//   useLang()                       → re-renders the caller when the choice flips
//   <LanguageToggle />              → the English | اردو switch
//
// The English text IS the key, so a string with no Urdu entry simply shows in
// English — nothing can go blank because a translation is missing. Names typed
// into the system (guards, clients, sites, supervisors) are data and are never
// translated.
//
// One choice for every Attendance screen and its pop-ups, remembered in
// localStorage per browser. Layout stays left-to-right in both languages, so
// every column and button is in the same place whichever is showing; Urdu runs
// render right-to-left inside it by the browser's own bidi rules.
//
// Exports (PDF / Excel) stay in English: they go to clients and payroll, and
// their columns are matched by other tools.

import { useSyncExternalStore } from "react";
import { URDU } from "./lang.ur";

export type Lang = "en" | "ur";

const KEY = "attendance.lang";
const listeners = new Set<() => void>();

function read(): Lang {
  try {
    return localStorage.getItem(KEY) === "ur" ? "ur" : "en";
  } catch {
    return "en";
  }
}

let current: Lang = read();

export function setLang(next: Lang) {
  current = next;
  try { localStorage.setItem(KEY, next); } catch { /* storage unavailable: the choice lasts this visit */ }
  for (const fn of listeners) fn();
}

export function getLang(): Lang {
  return current;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  // Another tab flipping the language follows here too.
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { current = read(); fn(); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(fn); window.removeEventListener("storage", onStorage); };
}

/** Translate one English string. Safe to call outside components; pair with useLang() so the caller re-renders. */
export function t(en: string, vars?: Record<string, string | number>): string {
  const s = current === "ur" ? URDU[en] ?? en : en;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function useLang(): { lang: Lang; t: typeof t; setLang: typeof setLang } {
  const lang = useSyncExternalStore(subscribe, getLang, () => "en" as Lang);
  return { lang, t, setLang };
}

export function LanguageToggle({ className = "" }: { className?: string }) {
  const { lang } = useLang();
  const base = "px-2.5 py-1.5 text-xs transition-colors";
  return (
    <div className={`inline-flex rounded-md border border-border overflow-hidden shrink-0 ${className}`} role="group" aria-label="Language">
      <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")}
        className={`${base} ${lang === "en" ? "bg-brand-600 text-white" : "bg-card text-foreground hover:bg-accent"}`}>
        English
      </button>
      <button type="button" aria-pressed={lang === "ur"} onClick={() => setLang("ur")} lang="ur"
        className={`${base} border-l border-border ${lang === "ur" ? "bg-brand-600 text-white" : "bg-card text-foreground hover:bg-accent"}`}>
        اردو
      </button>
    </div>
  );
}
