import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ShieldAlert, LogOut } from "lucide-react";
import { useAuth } from "../lib/auth";

/**
 * App-wide inactivity auto-logout (hard security timeout).
 *
 * - 15 minutes of no real user interaction → full sign-out + redirect to /login.
 * - At 14 minutes (1 min before cutoff) a non-dismissible warning modal with a
 *   live countdown appears; "Stay logged in" resets the full 15-minute timer.
 * - Only genuine DOM interaction (mouse/keyboard/scroll/touch) resets the timer,
 *   never background polling.
 * - Cross-tab: the "last activity" timestamp lives in localStorage and is shared
 *   by every tab, so activity in ANY tab keeps ALL tabs alive, and logout in one
 *   tab propagates to the others. See LS_LAST / LS_LOGOUT below.
 *
 * Mount once inside each authenticated layout — it self-disables when there is
 * no session, and RequireAuth handles the redirect once signOut() clears it.
 */

const IDLE_LIMIT_MS =15 * 60 * 1000; // total inactivity before logout
const WARN_MS = 60 * 1000; // show the warning this long before the cutoff
const WRITE_THROTTLE_MS = 2000; // don't hammer localStorage on every mousemove

// Shared across tabs.
const LS_LAST = "txs.lastActivity";
const LS_LOGOUT = "txs.logout_reason"; // consumed by the Login page for its banner

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "wheel"] as const;

function readLast(): number {
  try {
    const v = Number(localStorage.getItem(LS_LAST));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function writeLast(t: number): void {
  try {
    localStorage.setItem(LS_LAST, String(t));
  } catch {
    /* ignore */
  }
}

export default function InactivityLogout() {
  const { session, signOut } = useAuth();
  const active = !!session;

  const [warning, setWarning] = useState(false);
  const [remaining, setRemaining] = useState(Math.ceil(WARN_MS / 1000));

  const warnRef = useRef(false);
  const lastWriteRef = useRef(0);
  const loggingOutRef = useRef(false);

  // Keep signOut in a ref so the callbacks below stay identity-stable. Without
  // this, signOut is a fresh function on every AuthProvider render (e.g. a
  // supabase token refresh on tab-return), which would re-run the watcher effect
  // and reset the inactivity clock — silently defeating the wall-clock check
  // exactly when returning from a long background/sleep.
  const signOutRef = useRef(signOut);
  useEffect(() => {
    signOutRef.current = signOut;
  }, [signOut]);

  // Reset the shared inactivity clock. `force` bypasses the write-throttle
  // (used for the "Stay logged in" action and on login). Stable identity.
  const resetTimer = useCallback((force: boolean) => {
    const t = Date.now();
    if (force || t - lastWriteRef.current > WRITE_THROTTLE_MS) {
      lastWriteRef.current = t;
      writeLast(t);
    }
    if (warnRef.current) {
      warnRef.current = false;
      setWarning(false);
    }
  }, []);

  const doLogout = useCallback(async () => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    try {
      localStorage.setItem(LS_LOGOUT, "inactivity");
    } catch {
      /* ignore */
    }
    try {
      await signOutRef.current();
    } finally {
      // RequireAuth redirects to /login once the session is cleared.
      warnRef.current = false;
      setWarning(false);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      // Logged out: clear any warning state and stop watching.
      warnRef.current = false;
      loggingOutRef.current = false;
      setWarning(false);
      return;
    }

    // Fresh session → start the clock now (ignore any stale timestamp from a
    // previous session, which would otherwise log the user out immediately).
    resetTimer(true);

    const onActivity = () => {
      // While the warning is up, only the explicit "Stay logged in" button
      // resets — passive mouse movement must not silently cancel the countdown.
      if (warnRef.current) return;
      resetTimer(false);
    };

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }

    const evaluate = () => {
      if (loggingOutRef.current) return;
      const last = readLast() || Date.now();
      const elapsed = Date.now() - last;

      if (elapsed >= IDLE_LIMIT_MS) {
        void doLogout();
        return;
      }

      if (elapsed >= IDLE_LIMIT_MS - WARN_MS) {
        if (!warnRef.current) {
          warnRef.current = true;
          setWarning(true);
        }
        setRemaining(Math.max(0, Math.ceil((IDLE_LIMIT_MS - elapsed) / 1000)));
      } else if (warnRef.current) {
        warnRef.current = false;
        setWarning(false);
      }
    };

    const tick = window.setInterval(evaluate, 1000);

    // Cross-tab + return-from-background: re-evaluate immediately on storage
    // changes and when the tab regains focus/visibility.
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_LOGOUT && e.newValue) {
        // Another tab logged out for inactivity — follow it here too.
        void doLogout();
        return;
      }
      if (e.key === LS_LAST) evaluate();
    };
    // Re-check the wall-clock elapsed the instant the tab is shown again — after
    // being backgrounded, the PC waking from sleep, or a bfcache page restore.
    // This catches an expired session immediately instead of waiting for the
    // throttled/paused 1s interval to resume.
    const onVisible = () => {
      if (document.visibilityState === "visible") evaluate();
    };
    const onPageShow = () => evaluate();

    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onPageShow);

    evaluate();

    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
      window.clearInterval(tick);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [active, resetTimer, doLogout]);

  if (!active || !warning) return null;

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const countdown = `${mins}:${String(secs).padStart(2, "0")}`;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="idle-title"
      aria-describedby="idle-desc"
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl md:p-8">
        <div className="mb-5 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-warning-50">
            <ShieldAlert className="h-6 w-6 text-warning-600" strokeWidth={1.5} />
          </div>
          <h2 id="idle-title" className="mb-1 text-xl font-bold text-foreground">
            Still there?
          </h2>
          <p id="idle-desc" className="text-sm text-muted-foreground">
            You&apos;ve been inactive for a while. For your security, you&apos;ll be signed out in
          </p>
          <p className="mt-3 font-ledger text-4xl font-bold tabular-nums text-warning-700 dark:text-warning-500">
            {countdown}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => resetTimer(true)}
            className="w-full rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-[#241a06] shadow-sm transition-colors hover:bg-brand-600"
          >
            Stay logged in
          </button>
          <button
            type="button"
            onClick={() => void doLogout()}
            className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LogOut className="h-4 w-4" strokeWidth={1.5} />
            Log out now
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
