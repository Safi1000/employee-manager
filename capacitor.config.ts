import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Native shell config for the Bastion CRM.
 *
 * The app ships the SAME Vite build the web CRM runs (`dist/`), wrapped in a
 * WebView. Anything that must behave differently on a phone is branched at
 * runtime through `src/app/lib/platform.ts` — never by forking the codebase.
 *
 * `androidScheme: "https"` is required: Supabase stores its session in
 * localStorage, and localStorage is partitioned per-origin. On the default
 * `http://localhost` scheme Android treats the origin as insecure, which
 * breaks both the session and any crypto the Supabase client reaches for.
 */
const config: CapacitorConfig = {
  appId: "com.techxserve.bastion",
  appName: "Bastion",
  webDir: "dist",

  server: {
    androidScheme: "https",
    // Supabase auth emails and Stripe returns come back to the website, not the
    // app. Only these hosts are allowed to load INSIDE the WebView; every other
    // link is pushed out to the system browser by `openExternal()`.
    allowNavigation: ["txs-crm.techxserve.com"],
  },

  ios: {
    // Let the web layer paint under the status bar / home indicator so the CSS
    // safe-area insets in `styles/native.css` control the padding.
    contentInset: "never",
    // A CRM is a document surface, not a scroll toy — the iOS rubber-band
    // bounce makes fixed headers detach and looks broken on a table page.
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: false,
  },

  android: {
    // WebView debugging (chrome://inspect) is OFF in a shipped build — it would
    // let anyone with a cable read the signed-in user's session out of the
    // running app. `npm run cap:dev` sets CAP_DEBUG=1 to turn it on for a
    // device-attached session.
    //
    // This must be opt-IN rather than "off only in production": a release build
    // that accidentally ships with it enabled is a security hole, while a debug
    // session without it is merely inconvenient. Guessing wrong should cost you
    // the inconvenience, not the hole.
    webContentsDebuggingEnabled: process.env.CAP_DEBUG === "1",
    allowMixedContent: false,
  },

  plugins: {
    SplashScreen: {
      // Held manually: `hideSplash()` fires once auth has resolved, so the user
      // never sees a flash of the login screen before being restored.
      launchAutoHide: false,
      backgroundColor: "#0B0F14",
      androidSplashResourceName: "splash",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
    },
    Keyboard: {
      // Resize the WebView itself rather than the body, so a focused input in a
      // long form scrolls into view instead of being covered by the keyboard.
      resize: "native",
      resizeOnFullScreen: true,
    },
    StatusBar: {
      overlaysWebView: true,
      backgroundColor: "#00000000",
    },
  },
};

export default config;
