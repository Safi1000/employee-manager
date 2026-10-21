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
import { useLocation, useNavigate } from "react-router";

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
    // Recorded once scrolling settles, not per event: finding the container's
    // index walks the whole page, which on a 400-row list made every scroll
    // event expensive and the scroll itself stutter (2026-10-21).
    let pending: number | null = null;
    let last: HTMLElement | null = null;
    const onScroll = (e: Event) => {
      if (restoring.current) return;
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      last = el;
      if (pending) window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        pending = null;
        const t = last;
        if (!t || !t.matches(SCROLLABLE)) return;
        const index = Array.from(root.querySelectorAll<HTMLElement>(SCROLLABLE)).indexOf(t);
        if (index >= 0) write(routeKey, { index, top: t.scrollTop });
      }, 150);
    };
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => { if (pending) window.clearTimeout(pending); root.removeEventListener("scroll", onScroll, true); };
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

// ── Saved views (2026-10-22) ─────────────────────────────────────────────────
// A VIEW is everything usePageState remembers for one page — tabs, filters,
// searches, sorts, open groups — taken as one snapshot. Because every page
// already keeps that state here, one mechanism gives all of them saved views
// and shareable links without touching the pages. Scroll positions are not
// part of a view.

export type PageSnapshot = Record<string, string>;   // key suffix after the page prefix → raw JSON

function pagePrefix(pathname: string) { return `${PREFIX}${pathname}`; }

/** The page's remembered state, as raw stored strings keyed by what follows the path. */
export function snapshotPage(pathname: string): PageSnapshot {
  const out: PageSnapshot = {};
  try {
    const pre = pagePrefix(pathname);
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (!k || !k.startsWith(pre)) continue;
      const rest = k.slice(pre.length);
      // Only this page's own keys (":name" or "#scope:name"), never a deeper route's.
      if (!rest.startsWith(":") && !rest.startsWith("#")) continue;
      const v = sessionStorage.getItem(k);
      if (v != null) out[rest] = v;
    }
  } catch { /* storage unavailable: an empty view */ }
  return out;
}

/** Replace the page's remembered state with a snapshot; anything not in it returns to its default. */
export function applySnapshot(pathname: string, snap: PageSnapshot) {
  try {
    const pre = pagePrefix(pathname);
    const drop: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(pre) && (k[pre.length] === ":" || k[pre.length] === "#")) drop.push(k);
    }
    drop.forEach((k) => sessionStorage.removeItem(k));
    for (const [rest, v] of Object.entries(snap)) {
      if ((rest.startsWith(":") || rest.startsWith("#")) && typeof v === "string") sessionStorage.setItem(pre + rest, v);
    }
  } catch { /* storage unavailable: the page opens on its defaults */ }
}

/** A view as a URL-safe string, and back. Null when it cannot be read. */
export function encodeView(snap: PageSnapshot): string {
  const json = JSON.stringify(snap);
  return btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeView(s: string): PageSnapshot | null {
  try {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const obj = JSON.parse(new TextDecoder().decode(Uint8Array.from(b, (ch) => ch.charCodeAt(0))));
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const out: PageSnapshot = {};
    for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out[k] = v;
    return out;
  } catch { return null; }
}

/**
 * Opens a page on a view carried in its link (`?view=…`): the snapshot is
 * written BEFORE the page mounts, so it reads it as its own remembered state,
 * then the parameter is taken off the address. Mounted once in the layout.
 */
export function ViewLink({ children }: { children: ReactNode }) {
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(search);
  const raw = params.get("view");
  const [nonce, setNonce] = useState(0);
  const applied = useRef<string | null>(null);
  if (raw && applied.current !== raw) {
    const snap = decodeView(raw);
    if (snap) applySnapshot(pathname, snap);
    applied.current = raw;
  }
  useEffect(() => {
    if (!raw) return;
    params.delete("view");
    const rest = params.toString();
    setNonce((n) => n + 1);   // remount the page so it re-reads the view
    navigate({ pathname, search: rest ? `?${rest}` : "", hash }, { replace: true });
  }, [raw]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div key={`${pathname}#${nonce}`} className="contents">{children}</div>;
}
