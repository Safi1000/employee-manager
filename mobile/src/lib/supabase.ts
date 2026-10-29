// The Supabase client for the field app (0607). Anon key only — it is public
// and ships in every web bundle too; what a supervisor login can reach is
// decided by api_request_gate on the server, not by anything in this app.
//
// Every request carries x-bastion-device: this phone's id. The gate refuses a
// supervisor everything except /rpc/field_*, and refuses those too unless the
// header names the login's APPROVED phone.
import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { AppState, Platform } from "react-native";
import { createClient } from "@supabase/supabase-js";

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "https://mmkfpnshxjcyijhuydgr.supabase.co";
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

const DEVICE_KEY = "ggs.field.device";

/** This phone's id: random, made once, kept until the app is uninstalled. */
export const deviceId: Promise<string> = (async () => {
  try {
    const kept = await AsyncStorage.getItem(DEVICE_KEY);
    if (kept && kept.length >= 8) return kept;
  } catch { /* first run */ }
  const made = Crypto.randomUUID();
  await AsyncStorage.setItem(DEVICE_KEY, made).catch(() => {});
  return made;
})();

/** What the office sees beside this phone on the approval screen. */
export function deviceLabel(): string {
  const c = (Platform.constants ?? {}) as { Brand?: string; Model?: string; Manufacturer?: string };
  return [c.Brand ?? c.Manufacturer, c.Model].filter(Boolean).join(" ") || `${Platform.OS} phone`;
}

const deviceFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("x-bastion-device", await deviceId);
  return fetch(input as RequestInfo, { ...init, headers });
};

export const supabase = createClient(url, anonKey, {
  global: { fetch: deviceFetch },
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
});

if (Platform.OS !== "web") {
  AppState.addEventListener("change", (state) => {
    if (state === "active") supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}

const FIELD_DOMAIN = "field.techxserve.com";
/** Mirrors fieldEmail() in supabase/functions/field-account — change both together. */
export function fieldEmail(code: string): string {
  return `${code.trim().toLowerCase().replace(/[^a-z0-9-]/g, "")}@${FIELD_DOMAIN}`;
}
/** Mirrors fieldPassword() in supabase/functions/field-account — change both together. */
export function fieldPassword(code: string, pin: string): string {
  return `Bastion-field:${code.trim().toUpperCase()}:${pin}`;
}
