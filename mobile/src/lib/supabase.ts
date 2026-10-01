// The Supabase client, exactly as the build brief specifies (lib/supabase.ts).
// It is only created when both EXPO_PUBLIC_ vars are set. Without them the app
// runs in demo mode on local fixtures and never touches the network, which is
// the safe default: the anon key points at PRODUCTION and there is no dev DB.
import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform } from "react-native";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// The web client's permissionAwareFetch (src/app/lib/supabase.ts): a REST write
// refused by RLS or a require_perm() guard reads as one plain sentence instead
// of "new row violates row-level security policy".
export const PERMISSION_DENIED_MESSAGE =
  "You don't have permission to do this. Contact your administrator if you need access.";
const permissionAwareFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input as RequestInfo, init);
  if (res.ok) return res;
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  if (!href || !href.includes("/rest/v1/")) return res;
  try {
    const text = await res.clone().text();
    if (!/42501|row-level security|permission denied/i.test(text)) return res;
    let body: Record<string, unknown> | null = null;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!body || typeof body !== "object") return res;
    body.message = PERMISSION_DENIED_MESSAGE;
    if ("hint" in body) body.hint = null;
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers });
  } catch {
    return res;
  }
};

export const supabase: SupabaseClient<Database> | null =
  url && anonKey
    ? createClient<Database>(url, anonKey, {
        global: { fetch: permissionAwareFetch },
        auth: {
          storage: AsyncStorage,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
      })
    : null;

export const isLive = supabase !== null;

if (supabase && Platform.OS !== "web") {
  AppState.addEventListener("change", (state) => {
    if (state === "active") supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
