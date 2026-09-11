import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { isNative } from "./platform";

/**
 * "When I push, everyone's open tab gets the new version."
 *
 * HOW IT KNOWS. Every `vite build` writes `public`-adjacent `/build-id.json`
 * holding the id of that build, and the same id is compiled into the bundle as
 * `__BUILD_ID__`. A tab therefore carries the id of the build IT is running,
 * and can ask the server what the current one is. When the two differ, the code
 * in that tab is stale.
 *
 * Vercel serves `/build-id.json` with `no-store` (see vercel.json) — without
 * that header the CDN would hand back the cached copy of the OLD id and the
 * check would answer "you are up to date" for ever, which is the worst kind of
 * failure: a control that cannot fire.
 *
 * WHEN IT RELOADS, AND WHY NOT ALWAYS IMMEDIATELY. Reloading a tab throws away
 * whatever is in it. On this app that can be a half-entered payroll row, an
 * expense someone is mid-way through, an unsaved opening balance — work that
 * has no draft and cannot be recovered. A deploy is not a good enough reason to
 * destroy it, and "force refresh everyone" would do exactly that to whoever
 * happened to be typing.
 *
 * So the reload is immediate in every case where nothing can be lost, and
 * announced in the one case where something can:
 *
 *   - tab in the BACKGROUND when the new build lands → reload straight away,
 *     silently. Nobody is typing into a tab they are not looking at, and they
 *     come back to the new version with no idea anything happened. In practice
 *     this is most people most of the time.
 *   - tab in the FOREGROUND → a banner appears with a Reload button, and the
 *     tab reloads by itself the moment it next goes to the background. So it
 *     still costs nobody a decision: switch away to answer Slack, come back to
 *     the new version.
 *
 * The net effect is the one that was asked for — after a push, open sessions
 * end up on the new build without anybody being told to hard-refresh — without
 * a deploy ever being able to eat someone's unsaved work.
 *
 * NATIVE IS EXCLUDED. Under Capacitor the bundle is read from the device, not
 * the network: `/build-id.json` is the file that shipped inside the app, so it
 * can never disagree with `__BUILD_ID__`. Polling it would be a request that is
 * guaranteed to find nothing. A native build updates through the store.
 */

// Injected by vite.config.ts at build time. Falls back in dev, where the dev
// server hot-reloads anyway and this whole mechanism is inert.
declare const __BUILD_ID__: string;
const CURRENT_BUILD = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

const POLL_MS = 2 * 60 * 1000;

async function fetchDeployedBuildId(signal?: AbortSignal): Promise<string | null> {
  try {
    // cache: no-store on the request as well as the response header: a Service
    // Worker or an aggressive browser cache is the other way this can go quietly
    // blind, and belt-and-braces costs one field.
    const res = await fetch(`/build-id.json?t=${Date.now()}`, { cache: "no-store", signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { buildId?: string };
    return typeof body.buildId === "string" ? body.buildId : null;
  } catch {
    // Offline, or a deploy mid-flight serving a 404. Not an error worth showing
    // anyone — the next poll answers the question again.
    return null;
  }
}

/**
 * True once the deployed build differs from the one this tab is running.
 * Never goes back to false: once stale, always stale.
 */
export function useAppUpdate(): { stale: boolean; reload: () => void } {
  const [stale, setStale] = useState(false);
  const staleRef = useRef(false);

  useEffect(() => {
    // The dev server has no dist/build-id.json to serve and hot-reloads on its
    // own, so every poll there would be a guaranteed 404.
    if (isNative || import.meta.env.DEV || CURRENT_BUILD === "dev") return;
    let cancelled = false;
    const ac = new AbortController();

    const check = async () => {
      if (cancelled || staleRef.current) return;
      const deployed = await fetchDeployedBuildId(ac.signal);
      if (cancelled || !deployed || deployed === CURRENT_BUILD) return;
      staleRef.current = true;
      // Background tab: just take the new version. Nothing is being typed into
      // a tab nobody is looking at.
      if (document.visibilityState === "hidden") {
        window.location.reload();
        return;
      }
      setStale(true);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        // Already known to be stale and the user has looked away — this is the
        // moment the reload is free.
        if (staleRef.current) window.location.reload();
        return;
      }
      // Coming back to the tab is the highest-value moment to check: it is both
      // the likeliest time for a deploy to have happened since they last looked,
      // and a point at which they are not mid-keystroke.
      void check();
    };

    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    return () => {
      cancelled = true;
      ac.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, []);

  return { stale, reload: () => window.location.reload() };
}

/**
 * The banner. Mounted once at the app root, so it is on every screen including
 * the login page — a stale tab sitting on login is exactly the one that will
 * otherwise fail on a chunk that no longer exists.
 */
export default function AppUpdateBanner() {
  const { stale, reload } = useAppUpdate();
  if (!stale) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-[9999] flex flex-wrap items-center justify-center gap-3 border-t border-brand-500/40 bg-brand-500/95 px-4 py-2.5 text-sm text-[#fff] shadow-lg"
      style={{ paddingBottom: "max(0.625rem, env(safe-area-inset-bottom))" }}
    >
      <RefreshCw className="w-4 h-4 shrink-0" strokeWidth={1.75} />
      <span>
        A new version of Bastion has been deployed. This tab is running the old one.
      </span>
      <button
        type="button"
        onClick={reload}
        className="rounded-md bg-[#fff]/20 px-3 py-1 font-medium hover:bg-[#fff]/30 transition-colors"
      >
        Reload now
      </button>
      <span className="text-[11px] text-[#fff]/80">
        Finish what you are typing first — it reloads on its own when you switch away.
      </span>
    </div>
  );
}
