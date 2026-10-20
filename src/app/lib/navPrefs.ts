import { useSyncExternalStore } from "react";

/**
 * Pinned and recently opened pages (2026-10-20, with the section rail and the
 * command palette). Per browser, per user: a convenience, not a record — so it
 * lives in localStorage and an empty list is always a valid answer.
 *
 * Both lists hold paths only. The rail and the palette resolve a path back to
 * its label and icon from the nav the user is actually allowed, so a page
 * someone loses access to simply drops out of their pins.
 */

const PIN_KEY = "nav.pinned.v1";
const RECENT_KEY = "nav.recent.v1";
const EVENT = "navprefs:change";
const MAX_PINS = 8;
const MAX_RECENT = 8;

function read(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function write(key: string, list: string[]) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* private mode: lists stay in memory only */ }
  cache.delete(key);
  window.dispatchEvent(new Event(EVENT));
}

// useSyncExternalStore needs a stable snapshot between changes.
const cache = new Map<string, string[]>();
const snapshot = (key: string) => {
  let v = cache.get(key);
  if (!v) { v = read(key); cache.set(key, v); }
  return v;
};
const subscribe = (cb: () => void) => {
  const onStorage = (e: StorageEvent) => { if (e.key === PIN_KEY || e.key === RECENT_KEY) { cache.clear(); cb(); } };
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener("storage", onStorage); };
};

export function usePinned(): string[] {
  return useSyncExternalStore(subscribe, () => snapshot(PIN_KEY));
}
export function useRecent(): string[] {
  return useSyncExternalStore(subscribe, () => snapshot(RECENT_KEY));
}

export function togglePin(path: string) {
  const cur = snapshot(PIN_KEY);
  write(PIN_KEY, cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path].slice(-MAX_PINS));
}

export function pushRecent(path: string) {
  const cur = snapshot(RECENT_KEY);
  if (cur[0] === path) return;
  write(RECENT_KEY, [path, ...cur.filter((p) => p !== path)].slice(0, MAX_RECENT));
}
