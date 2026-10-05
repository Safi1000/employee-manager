// App-wide "remember where I was" (asked 2026-10-05: "I need persistent state
// all across my application").
//
// Two pieces:
//
//   usePageState(name, initial) — useState that survives leaving the page and
//     coming back: tabs, search boxes, filters, month/date pickers, which rows
//     or groups are open. Keyed by the route's path plus the name, so the same
//     component on two routes (main vs reliever payroll) keeps two memories.
//
//   <ScrollMemory> — mounted once in the layout; remembers how far each page
//     was scrolled and puts it back when you return, once the page has content.
//
// Kept in sessionStorage: it lasts while the browser tab is open, and a fresh
// visit starts from each page's defaults (e.g. the previous month). It is a
// convenience — never a source of truth — so every read and write tolerates
// storage being unavailable, and a stored value that no longer applies (a
// client since deleted) simply finds nothing.
//
// Deliberately NOT used for unsaved form contents or open dialogs: restoring a
// half-filled form after navigating away is how a stale value gets saved.

import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type Dispatch, type ReactNode, type SetStateAction,
} from "react";
import { useLocation } from "react-router";

const PREFIX = "pageState:";

// Sets and Maps (open-row sets, per-group maps) round-trip through JSON.
function replacer(_k: string, v: unknown) {
  if (v instanceof Set) return { __t: "Set", v: [...v] };
  if (v instanceof Map) return { __t: "Map", v: [...v.entries()] };
  return v;
}
function reviver(_k: string, v: any) {
  if (v && typeof v === "object" && v.__t === "Set" && Array.isArray(v.v)) return new Set(v.v);
  if (v && typeof v === "object" && v.__t === "Map" && Array.isArray(v.v)) return new Map(v.v);
  return v;
}

function read<T>(key: string): { hit: true; value: T } | { hit: false } {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw == null) return { hit: false };
    return { hit: true, value: JSON.parse(raw, reviver) as T };
  } catch {
    return { hit: false };
  }
}
function write(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value, replacer)); } catch { /* quota / privacy mode */ }
}

/**
 * A scope for components rendered more than once on the same page (the payroll
 * embedded per client in the Payroll Run), so each instance remembers its own.
 */
const ScopeCtx = createContext<string>("");
export function PageStateScope({ name, children }: { name: string; children: ReactNode }) {
  const parent = useContext(ScopeCtx);
  return <ScopeCtx.Provider value={parent ? `${parent}/${name}` : name}>{children}</ScopeCtx.Provider>;
}

/** useState that is remembered for this page for the rest of the browser session. */
export function usePageState<T>(name: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const { pathname } = useLocation();
  const scope = useContext(ScopeCtx);
  const key = `${PREFIX}${pathname}${scope ? `#${scope}` : ""}:${name}`;
  const [value, setValue] = useState<T>(() => {
    const r = read<T>(key);
    if (r.hit) return r.value;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  // Write on every change. A ref keeps the first write from re-saving the default.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; if (!read(key).hit) return; }
    write(key, value);
  }, [key, value]);
  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => setValue(next), []);
  return [value, set];
}

/** Read/write one remembered value outside a component (TabHub's last tab). */
export const pageMemory = {
  get<T>(key: string): T | null { const r = read<T>(PREFIX + key); return r.hit ? r.value : null; },
  set(key: string, value: unknown) { write(PREFIX + key, value); },
};

// ── Scroll ───────────────────────────────────────────────────────────────────
const SCROLLABLE = ".overflow-y-auto, .overflow-auto";

/**
 * Remembers each page's scroll position and restores it on return. Pages
 * scroll inside their own `overflow-y-auto` container, not the window, so this
 * watches scroll events under the layout and records which container moved
 * (by its position among the scrollable containers) and how far.
 *
 * Restoring waits for content: a page loads its data after it mounts, so the
 * position is re-applied a few times over the first seconds, and abandoned the
 * moment the user scrolls or clicks themselves.
 */
export function ScrollMemory({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { pathname, search } = useLocation();
  const routeKey = `${PREFIX}scroll:${pathname}${search}`;
  const restoring = useRef(false);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let pending: number | null = null;
    const onScroll = (e: Event) => {
      if (restoring.current) return;
      const el = e.target as HTMLElement;
      if (!(el instanceof HTMLElement) || !el.matches(SCROLLABLE)) return;
      const all = Array.from(root.querySelectorAll<HTMLElement>(SCROLLABLE));
      const index = all.indexOf(el);
      if (index < 0) return;
      if (pending) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => write(routeKey, { index, top: el.scrollTop }));
    };
    root.addEventListener("scroll", onScroll, true);
    return () => root.removeEventListener("scroll", onScroll, true);
  }, [routeKey]);

  useLayoutEffect(() => {
    const root = ref.current;
    const saved = read<{ index: number; top: number }>(routeKey);
    if (!root || !saved.hit || !saved.value.top) return;
    const { index, top } = saved.value;
    let stopped = false;
    restoring.current = true;
    const stop = () => { stopped = true; restoring.current = false; };
    const apply = () => {
      if (stopped) return;
      const el = Array.from(root.querySelectorAll<HTMLElement>(SCROLLABLE))[index];
      if (el && el.scrollHeight - el.clientHeight >= top - 2) el.scrollTop = top;
    };
    const timers = [0, 120, 350, 800, 1500, 2500].map((ms) => window.setTimeout(apply, ms));
    const done = window.setTimeout(stop, 2600);
    const userActs = () => stop();
    root.addEventListener("wheel", userActs, { passive: true, once: true });
    root.addEventListener("touchstart", userActs, { passive: true, once: true });
    root.addEventListener("mousedown", userActs, { once: true });
    root.addEventListener("keydown", userActs, { once: true });
    return () => {
      stop();
      timers.forEach(clearTimeout);
      clearTimeout(done);
      root.removeEventListener("wheel", userActs);
      root.removeEventListener("touchstart", userActs);
      root.removeEventListener("mousedown", userActs);
      root.removeEventListener("keydown", userActs);
    };
  }, [routeKey]);

  return <div ref={ref} className="contents">{children}</div>;
}
