// Where the app is running. Every native-vs-web branch in the codebase goes
// through here so there is exactly one thing to stub in a test and one thing to
// read when asking "does this run on a phone?".
//
// The web build imports @capacitor/core too — it is a few KB of shims that
// report `web` when no native bridge is present, so nothing here breaks or
// bloats the browser bundle.

import { Capacitor } from "@capacitor/core";

/** Running inside the Android or iOS shell (NOT a mobile browser). */
export const isNative = Capacitor.isNativePlatform();

export const isIOS = Capacitor.getPlatform() === "ios";
export const isAndroid = Capacitor.getPlatform() === "android";
export const isWeb = !isNative;

/** "ios" | "android" | "web" */
export const platform = Capacitor.getPlatform();

/**
 * The public website. Native builds cannot sell a subscription in-app (App
 * Store 3.1.1 / Play Payments policy), so signup, plan changes and the Stripe
 * customer portal are all pushed to this origin in the system browser.
 */
export const WEB_APP_ORIGIN = "https://txs-crm.techxserve.com";

/**
 * Whether this build may show purchase paths — signup, plan upgrade, AI
 * top-ups, "manage billing".
 *
 * Apple and Google both require their own billing for digital goods bought
 * inside an app, and both reject apps that merely LINK OUT to a web purchase
 * from inside the purchase flow. The app is therefore sign-in only: existing
 * subscribers log in, and buying happens on the website. Read-only plan
 * information (guards used, renewal date) is still shown — that is allowed.
 */
export const canSellInApp = !isNative;
