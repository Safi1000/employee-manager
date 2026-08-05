// Client-side billing helpers: the billing_summary RPC, the edge-function
// calls behind the Billing screen, and the guard-cap arithmetic the rest of
// the app shows warnings from.
//
// The pricing model itself is in ./pricing — do not duplicate rates here.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";

export type BillingSummary = {
  company_id: string;
  company_name: string;
  billing_status: string | null;
  active: boolean;
  /** Guards paid for. null = a company created by hand, with no cap. */
  guard_limit: number | null;
  guard_buffer: number;
  guards_used: number;
  plan_care: boolean;
  plan_price_pkr: number | null;
  current_period_end: string | null;
  subscription_expires_at: string | null;
  has_subscription: boolean;
  ai_credit_monthly: number;
  ai_credit_used: number;
  ai_credit_topup: number;
  ai_credit_available: number;
};

/** Where a company sits against the guards it paid for. */
export type GuardCapState = {
  /** No plan on file — nothing is enforced. */
  uncapped: boolean;
  limit: number;
  buffer: number;
  used: number;
  /** Guards that can still be added before the database refuses. */
  remaining: number;
  /** Over the paid count but inside the buffer: allowed, but they must be told. */
  inBuffer: boolean;
  /** At the hard ceiling. The next guard will be rejected. */
  atHardLimit: boolean;
};

export function guardCapState(s: BillingSummary | null): GuardCapState {
  if (!s || s.guard_limit == null) {
    return {
      uncapped: true, limit: 0, buffer: 0, used: s?.guards_used ?? 0,
      remaining: Number.POSITIVE_INFINITY, inBuffer: false, atHardLimit: false,
    };
  }
  const limit = s.guard_limit;
  const buffer = s.guard_buffer ?? 0;
  const used = s.guards_used;
  return {
    uncapped: false,
    limit,
    buffer,
    used,
    remaining: Math.max(limit + buffer - used, 0),
    inBuffer: used > limit && used <= limit + buffer,
    atHardLimit: used >= limit + buffer,
  };
}

export async function fetchBillingSummary(): Promise<BillingSummary | null> {
  const { data, error } = await supabase.rpc("billing_summary");
  if (error || !data) return null;
  return data as BillingSummary;
}

/** Billing summary with a refresh handle, for screens that change the plan. */
export function useBilling() {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setSummary(await fetchBillingSummary());
    setLoading(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  return { summary, loading, reload };
}

// ---------------------------------------------------------------------------
// Edge functions
// ---------------------------------------------------------------------------

/**
 * supabase-js throws away a non-2xx body and replaces it with a generic
 * message, which for billing would turn "your card was declined" into "Edge
 * Function returned a non-2xx status code". Dig the real payload back out.
 */
async function unwrap(error: unknown): Promise<{ code: string; detail?: string }> {
  const fallback = error instanceof Error ? error.message : String(error);
  const ctx = (error as { context?: Response })?.context;
  if (!ctx || typeof ctx.clone !== "function") return { code: fallback };
  try {
    const body = await ctx.clone().json();
    return { code: String(body?.error ?? fallback), detail: body?.detail ? String(body.detail) : undefined };
  } catch {
    return { code: fallback };
  }
}

export const BILLING_ERRORS: Record<string, string> = {
  email_in_use: "That email already has an account. Sign in instead.",
  valid_email_required: "Enter a valid email address.",
  company_name_required: "Enter your company name.",
  guards_required: "Enter how many guards you run.",
  stripe_not_configured: "Payments are not set up yet. Contact support.",
  not_paid: "We haven't received your payment yet. If you just paid, wait a moment and refresh.",
  invalid_token: "That signup link is not valid.",
  token_expired: "That signup link has expired. Start again and your card will not be charged twice.",
  already_claimed: "This signup has already been completed. Sign in instead.",
  password_too_short: "Password must be at least 8 characters.",
  no_subscription: "No active subscription on this company.",
  no_stripe_customer: "This company has no Stripe customer — it was created by hand.",
  below_current_headcount: "You already have more guards than that. Remove them first, or pick a higher number.",
  forbidden: "Only the super admin who owns the subscription can change billing.",
  unknown_pack: "That top-up pack no longer exists.",
};

export function billingMessage(code: string, detail?: string): string {
  const friendly = BILLING_ERRORS[code];
  if (friendly) return detail && code === "below_current_headcount"
    ? `You already have ${detail} guards. Pick that number or higher.`
    : friendly;
  return detail ? `${code}: ${detail}` : code;
}

/** Step 1 of signup. Returns the Stripe Checkout URL to send the browser to. */
export async function startCheckout(input: {
  email: string;
  full_name?: string | null;
  company_name: string;
  guards: number;
  care: boolean;
}): Promise<{ url: string; token: string } | { error: string }> {
  const { data, error } = await supabase.functions.invoke("billing-checkout", { body: input });
  if (error) {
    const { code, detail } = await unwrap(error);
    return { error: billingMessage(code, detail) };
  }
  return data as { url: string; token: string };
}

/** Step 2 of signup. Only succeeds once Stripe has confirmed the payment. */
export async function completeSignup(input: {
  token: string;
  password: string;
  full_name?: string | null;
  session_id?: string | null;
}): Promise<{ ok: true; email: string } | { error: string }> {
  const { data, error } = await supabase.functions.invoke("signup-complete", { body: input });
  if (error) {
    const { code, detail } = await unwrap(error);
    return { error: billingMessage(code, detail) };
  }
  return data as { ok: true; email: string };
}

type ManageResult = { url?: string; ok?: boolean; guard_limit?: number };

async function manage(body: Record<string, unknown>): Promise<ManageResult | { error: string }> {
  const { data, error } = await supabase.functions.invoke("billing-manage", { body });
  if (error) {
    const { code, detail } = await unwrap(error);
    return { error: billingMessage(code, detail) };
  }
  return data as ManageResult;
}

export const openBillingPortal = () => manage({ action: "portal" });
export const changePlan = (guards: number, care: boolean) =>
  manage({ action: "change_plan", guards, care });
export const buyAiTopup = (pack: string) => manage({ action: "ai_topup", pack });
