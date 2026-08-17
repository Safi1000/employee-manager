// Everything the native shell has to do that a browser does for free.
//
// Called once from main.tsx before React mounts. On the web every function
// here is a no-op, so there is no branch at the call site.

import { App as CapApp } from "@capacitor/app";
import { StatusBar, Style } from "@capacitor/status-bar";
import { SplashScreen } from "@capacitor/splash-screen";
import { Keyboard } from "@capacitor/keyboard";
import { isNative, isAndroid, isIOS } from "./platform";

/** The site the app mirrors. Deep links arrive as https URLs on this host. */
const APP_HOST = "txs-crm.techxserve.com";

/**
 * Match the status bar to the current colour mode. The web app writes a `dark`
 * class on <html> before paint (see index.html); this mirrors that decision
 * onto the native chrome, and is re-run by ModeProvider whenever it flips.
 *
 * Style.Dark means DARK CONTENT (dark icons on a light bar) — the naming is
 * inverted from what you would guess, so it is spelled out here rather than
 * being silently wrong.
 */
export async function syncStatusBar(dark: boolean): Promise<void> {
  if (!isNative) return;
  try {
    await StatusBar.setStyle({ style: dark ? Style.Light : Style.Dark });
    if (isAndroid) {
      // Android draws a solid bar unless told otherwise; iOS always overlays.
      await StatusBar.setOverlaysWebView({ overlay: true });
      await StatusBar.setBackgroundColor({ color: "#00000000" });
    }
  } catch {
    // A status-bar call failing is never worth breaking the app over.
  }
}

/** Dismiss the launch image. Called once auth has resolved. */
export async function hideSplash(): Promise<void> {
  if (!isNative) return;
  try {
    await SplashScreen.hide();
  } catch {
    /* no splash to hide */
  }
}

/**
 * Android's hardware/gesture back button. Without this handler Android's
 * default is to close the app on every back press, ignoring in-app history —
 * so backing out of a modal would quit the CRM.
 *
 * Back exits the app ONLY at a root screen with nothing left in history.
 */
function wireBackButton(): void {
  if (!isAndroid) return;
  void CapApp.addListener("backButton", ({ canGoBack }) => {
    // Let an open dialog/drawer claim the press first. Anything rendering an
    // overlay dispatches this and calls preventDefault to keep the app open.
    const claimed = !window.dispatchEvent(
      new CustomEvent("native:back", { cancelable: true }),
    );
    if (claimed) return;
    if (canGoBack || window.history.length > 1) window.history.back();
    else void CapApp.exitApp();
  });
}

/**
 * Deep links. Supabase password-reset and email-confirm links point at the
 * website; with Android App Links / iOS Universal Links configured for
 * APP_HOST, tapping one while the app is installed opens the app instead of
 * the browser, and this maps the URL onto an in-app route.
 */
function wireDeepLinks(): void {
  if (!isNative) return;
  void CapApp.addListener("appUrlOpen", ({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.host && parsed.host !== APP_HOST) return;
      // Supabase puts tokens in the fragment (#access_token=...); keep the
      // whole tail so the auth layer can read either half.
      const target = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      if (target && target !== "/") window.location.replace(target);
    } catch {
      /* a malformed deep link is not worth crashing on */
    }
  });
}

/**
 * iOS shows an accessory bar above the keyboard with Prev/Next/Done. On a form
 * this is useful; the "scroll assist" that comes with it fights our own
 * scrolling containers, so only the bar is kept.
 */
function wireKeyboard(): void {
  if (!isIOS) return;
  void Keyboard.setAccessoryBarVisible({ isVisible: true });
}

/**
 * Initialise the native shell. Safe to call on the web, where it returns
 * immediately.
 */
export function initNativeShell(): void {
  if (!isNative) return;
  // Gates every rule in styles/native.css. Set before React mounts so safe-area
  // padding and the 16px input floor apply to the first paint, not the second.
  document.documentElement.classList.add("native", `platform-${isIOS ? "ios" : "android"}`);
  wireBackButton();
  wireDeepLinks();
  wireKeyboard();
  void syncStatusBar(document.documentElement.classList.contains("dark"));

  // Failsafe. `launchAutoHide` is false, so the splash is dismissed by exactly
  // one line of app code (AuthProvider, once loading resolves). If that line
  // never runs — an exception before React mounts, a hung auth call, a future
  // refactor that drops the effect — the user is left staring at the launch
  // image with no way forward and nothing in the logs. Eight seconds is well
  // past AuthProvider's own 4s timeout, so in a healthy boot this never fires;
  // when it does, showing a broken screen beats showing a frozen one.
  setTimeout(() => { void hideSplash(); }, 8000);
}
