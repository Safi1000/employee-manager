// Shared plumbing for the billing edge functions: Stripe client, Supabase
// service client, CORS, and the couple of conversions every one of them needs.
//
// Secrets expected on the project (set with `supabase secrets set`):
//   STRIPE_SECRET_KEY      sk_test_… while testing, sk_live_… in production
//   STRIPE_WEBHOOK_SECRET  whsec_… from the webhook endpoint (stripe-webhook only)
//   APP_URL                https://your-app — where Stripe sends the browser back
//   PKR_PER_USD            optional; overrides DEFAULT_PKR_PER_USD

import Stripe from "npm:stripe@17.7.0";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { DEFAULT_PKR_PER_USD } from "./pricing.ts";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
export const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

/** Where Stripe returns the browser. Trailing slash trimmed so joins are clean. */
export const APP_URL = (Deno.env.get("APP_URL") ?? "http://localhost:5173").replace(/\/+$/, "");

/** PKR per USD. Falls back to the value baked into the pricing model. */
export function fxRate(): number {
  const raw = Number(Deno.env.get("PKR_PER_USD"));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PKR_PER_USD;
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  return null;
}

/**
 * Stripe, on Deno's fetch. The explicit fetch http client matters: the SDK's
 * default Node client is not available in the edge runtime.
 */
export function stripeClient(): Stripe {
  if (!STRIPE_SECRET_KEY) throw new Error("stripe_not_configured");
  return new Stripe(STRIPE_SECRET_KEY, {
    // Must match what stripe@17.7.0 ships with, or the SDK's own types and the
    // wire format drift apart. Bump both together, never one alone.
    apiVersion: "2025-02-24.acacia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/** Service-role client: bypasses RLS. Never hand this to anything user-supplied. */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type Caller = {
  user_id: string;
  company_id: string | null;
  role: string;
};

/**
 * Identify the signed-in caller from the Authorization header. Returns null for
 * anything that is not a valid session with a profile.
 */
export async function callerFrom(req: Request, admin: SupabaseClient): Promise<Caller | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("id, company_id, view_as_company, role")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!profile) return null;

  return {
    user_id: data.user.id,
    // view_as_company is how a super-super-admin inspects another org; it is
    // the effective company everywhere else in the app, so it is here too.
    company_id: (profile.view_as_company as string | null) ?? (profile.company_id as string | null),
    role: String(profile.role),
  };
}

/** A URL-safe secret. 32 bytes of CSPRNG, hex-encoded. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
