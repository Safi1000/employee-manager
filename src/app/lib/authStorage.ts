// Where the Supabase session lives.
//
// supabase-js defaults to localStorage. In a browser that is fine. Inside
// WKWebView it is not: iOS treats WebView localStorage as evictable cache and
// clears it under storage pressure, when the app is backgrounded for a long
// time, or when the user offloads the app. The symptom is a user who is
// silently logged out every few days for no reason they can see — the single
// most common complaint about Capacitor-wrapped apps that skip this.
//
// Capacitor Preferences maps to UserDefaults (iOS) and SharedPreferences
// (Android), both of which are real persisted storage and survive all of the
// above.
//
// NOTE: neither store is encrypted at rest beyond the OS sandbox. That matches
// the security posture of localStorage on the web, which is what this app
// already relies on — so this is not a downgrade. If refresh tokens ever need
// hardware-backed protection, swap this adapter for a Keychain/Keystore plugin;
// nothing outside this file would change.

import { Preferences } from "@capacitor/preferences";
import { isNative } from "./platform";

/**
 * The storage shape supabase-js expects. It tolerates promises, so the async
 * native API drops straight in.
 */
export type SupabaseAuthStorage = {
  getItem: (key: string) => Promise<string | null> | string | null;
  setItem: (key: string, value: string) => Promise<void> | void;
  removeItem: (key: string) => Promise<void> | void;
};

const nativeStorage: SupabaseAuthStorage = {
  getItem: async (key) => (await Preferences.get({ key })).value,
  setItem: async (key, value) => Preferences.set({ key, value }),
  removeItem: async (key) => Preferences.remove({ key }),
};

/**
 * Native builds get Preferences; the web keeps localStorage. Returning
 * `undefined` on web is deliberate — it lets supabase-js apply its own default
 * rather than us reimplementing it, so browser behaviour is untouched.
 */
export const authStorage: SupabaseAuthStorage | undefined = isNative ? nativeStorage : undefined;
