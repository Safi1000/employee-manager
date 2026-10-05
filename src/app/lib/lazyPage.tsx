// Pages that survive a deploy.
//
// "Failed to fetch dynamically imported module …/assets/PayrollManagement-XXXX.js"
// (reported 2026-10-05, "happens randomly"). It is not random: every page is
// its own chunk, named by a hash of its content, and each deploy replaces the
// set. A tab opened BEFORE a deploy still runs the old build and, the first time
// it opens a page it has not loaded yet, asks for the OLD chunk name — which no
// longer exists. appUpdate.tsx moves open tabs onto the new build, but a tab in
// the foreground waits for a moment that cannot cost unsaved work, and inside
// that window a navigation hits the missing file.
//
// Navigating to another page IS such a moment: whatever was on the page being
// left is being left anyway. So when a page's code fails to load because it is
// gone, reload — the URL is already the page being opened, so the reload lands
// there, on the new build. Guarded so a genuinely broken network cannot reload
// in a loop: at most once per 30 seconds, after which the error is shown.

import { lazy, type ComponentType } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { RefreshCw } from "lucide-react";

const RELOAD_KEY = "chunkReloadAt";

/** Is this the "the build changed under me" failure, as opposed to a bug? */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk .* failed|text\/html.*MIME type|is not a valid JavaScript MIME type/i.test(msg);
}

/** Reload once to pick up the new build. Returns false if we just tried. */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // No storage: still reload once; the browser's own history stops a loop
    // being anything worse than a second reload.
  }
  window.location.reload();
  return true;
}

/** React.lazy, plus: a page whose chunk vanished in a deploy reloads into the new build. */
export function lazyPage<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(() =>
    factory().catch((err: unknown) => {
      if (isChunkLoadError(err) && reloadForNewBuild()) {
        // Never settles: the page is going away.
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }),
  );
}

/**
 * Route error screen. Replaces react-router's developer default ("Unexpected
 * Application Error! … Hey developer"). A stale-build failure reloads itself;
 * anything else says so plainly and offers a reload.
 */
export function RouteErrorScreen() {
  const error = useRouteError();
  const stale = isChunkLoadError(error);
  if (stale && reloadForNewBuild()) return null;

  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error ?? "");

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-card border border-border rounded-xl p-6 text-center space-y-3">
        <h1 className="text-lg font-semibold text-foreground">
          {stale ? "A new version of the app is available" : "Something went wrong on this page"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {stale
            ? "The app was updated while this tab was open. Reload to continue — it takes a second."
            : "Reloading usually fixes it. If it keeps happening, send the message below to support."}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700"
        >
          <RefreshCw className="w-4 h-4" /> Reload
        </button>
        {!stale && detail && (
          <p className="text-[11px] text-muted-foreground break-words font-mono">{detail}</p>
        )}
      </div>
    </div>
  );
}
