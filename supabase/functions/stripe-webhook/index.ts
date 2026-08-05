// Edge function: stripe-webhook
//
// The only place that is allowed to believe money moved. PUBLIC endpoint, but
// authenticated by Stripe's signature rather than a JWT — deploy with
// --no-verify-jwt, and it will reject anything that is not signed with
// STRIPE_WEBHOOK_SECRET.
//
// Handles:
//   checkout.session.completed   signup paid → intent becomes claimable
//                                AI top-up paid → credit granted
//   invoice.paid                 renewal → period extended, AI credit reset
//   invoice.payment_failed       → past_due
//   customer.subscription.updated / .deleted  → status + access mirrored
//
// Idempotency: every event id is inserted into billing_events FIRST. Stripe
// retries deliveries, and a retry that granted a second month of AI credit or
// extended the subscription twice would be a silent, compounding bug. The
// unique index on stripe_event_id is what makes the retry a no-op.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type Stripe from "npm:stripe@17.7.0";
import {
  CORS, STRIPE_WEBHOOK_SECRET, adminClient, json, stripeClient,
} from "../_shared/billing.ts";

type Admin = ReturnType<typeof adminClient>;

/** ISO date (no time) for companies.subscription_expires_at, which is a DATE. */
function isoDate(epochSeconds: number | null | undefined): string | null {
  if (!epochSeconds) return null;
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function isoTimestamp(epochSeconds: number | null | undefined): string | null {
  if (!epochSeconds) return null;
  return new Date(epochSeconds * 1000).toISOString();
}

/** Stripe subscription status → the values companies.billing_status allows. */
function mapStatus(s: string): string {
  switch (s) {
    case "trialing": return "trialing";
    case "active": return "active";
    case "past_due": return "past_due";
    case "unpaid": return "unpaid";
    case "canceled": return "canceled";
    default: return "incomplete";
  }
}

// ---------------------------------------------------------------------------
// checkout.session.completed
// ---------------------------------------------------------------------------
async function onCheckoutCompleted(
  admin: Admin,
  session: Stripe.Checkout.Session,
): Promise<string | null> {
  const kind = session.metadata?.kind ?? "";

  // --- an existing org bought AI credit -----------------------------------
  if (kind === "ai_topup") {
    const companyId = session.metadata?.company_id ?? null;
    const credit = Number(session.metadata?.credit_pkr ?? 0);
    if (!companyId || !(credit > 0)) return null;
    // Money already captured — mode:'payment' sessions only complete on success.
    await admin.rpc("ai_credit_topup", {
      p_company: companyId,
      p_amount: credit,
      p_reference: session.id,
      p_description: "AI credit top-up (Stripe)",
    });
    return companyId;
  }

  // --- a new org paid its first subscription invoice ------------------------
  if (kind !== "signup") return null;

  // Belt and braces: only treat it as paid if Stripe says it is. A session can
  // complete with payment_status 'unpaid' for delayed payment methods.
  const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required";
  if (!paid) return null;

  const intentId = session.metadata?.intent_id ?? null;
  if (!intentId) return null;

  await admin
    .from("signup_intents")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      stripe_subscription_id: typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null,
      stripe_customer_id: typeof session.customer === "string"
        ? session.customer
        : session.customer?.id ?? null,
      // The visitor has 24h from payment to choose a password; without this
      // they could pay, close the tab, and find the token dead an hour later
      // because the clock started when they opened checkout.
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    })
    .eq("id", intentId)
    .eq("status", "pending");

  return null;
}

// ---------------------------------------------------------------------------
// invoice.paid — the monthly renewal
// ---------------------------------------------------------------------------
async function onInvoicePaid(
  admin: Admin,
  stripe: ReturnType<typeof stripeClient>,
  invoice: Stripe.Invoice,
): Promise<string | null> {
  const subId = typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription?.id ?? null;
  if (!subId) return null;

  const { data: company } = await admin
    .from("companies")
    .select("id, ai_credit_monthly")
    .eq("stripe_subscription_id", subId)
    .maybeSingle();

  // The very first invoice is paid before the company exists — the org has not
  // chosen a password yet. Nothing to do: signup-complete sets the opening
  // period and credit from the same subscription.
  if (!company) return null;

  const sub = await stripe.subscriptions.retrieve(subId);
  const periodEnd = sub.current_period_end;

  await admin
    .from("companies")
    .update({
      billing_status: mapStatus(sub.status),
      // Paying reinstates an org that expiry had switched off.
      active: true,
      current_period_end: isoTimestamp(periodEnd),
      subscription_expires_at: isoDate(periodEnd),
      updated_at: new Date().toISOString(),
    })
    .eq("id", company.id);

  // New period, fresh allowance. The amount comes from the subscription's own
  // metadata so a plan change is reflected the moment it is billed.
  const monthly = Number(sub.metadata?.ai_credit_monthly ?? company.ai_credit_monthly ?? 0);
  await admin.rpc("ai_credit_reset_period", {
    p_company: company.id,
    p_monthly: monthly,
  });

  return company.id;
}

// ---------------------------------------------------------------------------
// subscription lifecycle
// ---------------------------------------------------------------------------
async function onSubscriptionChanged(
  admin: Admin,
  sub: Stripe.Subscription,
): Promise<string | null> {
  const { data: company } = await admin
    .from("companies").select("id").eq("stripe_subscription_id", sub.id).maybeSingle();
  if (!company) return null;

  const status = mapStatus(sub.status);
  // Losing the subscription locks the org out; enforce_subscription_expiry
  // already does this on a date basis, this is the immediate version.
  const stillAllowed = status === "active" || status === "trialing" || status === "past_due";

  await admin
    .from("companies")
    .update({
      billing_status: status,
      active: stillAllowed,
      current_period_end: isoTimestamp(sub.current_period_end),
      subscription_expires_at: isoDate(sub.current_period_end),
      updated_at: new Date().toISOString(),
    })
    .eq("id", company.id);

  return company.id;
}

async function onPaymentFailed(admin: Admin, invoice: Stripe.Invoice): Promise<string | null> {
  const subId = typeof invoice.subscription === "string"
    ? invoice.subscription
    : invoice.subscription?.id ?? null;
  if (!subId) return null;

  const { data: company } = await admin
    .from("companies").select("id").eq("stripe_subscription_id", subId).maybeSingle();
  if (!company) return null;

  // Deliberately does NOT deactivate. Stripe retries a failed card for days;
  // cutting access on the first failure would lock out an org over a temporary
  // bank decline. Access ends when the subscription itself is canceled, or
  // when subscription_expires_at passes.
  await admin
    .from("companies")
    .update({ billing_status: "past_due", updated_at: new Date().toISOString() })
    .eq("id", company.id);

  return company.id;
}

// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!STRIPE_WEBHOOK_SECRET) return json({ error: "webhook_not_configured" }, 500);

  const signature = req.headers.get("stripe-signature");
  if (!signature) return json({ error: "missing_signature" }, 400);

  // Signature is computed over the exact bytes Stripe sent, so the body must be
  // read as raw text and never parsed first.
  const raw = await req.text();

  let stripe: ReturnType<typeof stripeClient>;
  try { stripe = stripeClient(); } catch { return json({ error: "stripe_not_configured" }, 500); }

  let event: Stripe.Event;
  try {
    // Async variant: the sync one needs Node crypto, which the edge runtime
    // does not have.
    event = await stripe.webhooks.constructEventAsync(raw, signature, STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return json({ error: "invalid_signature", detail: e instanceof Error ? e.message : String(e) }, 400);
  }

  const admin = adminClient();

  // Claim the event. A duplicate delivery loses the race on the unique index
  // and returns 200 without doing the work twice.
  const { error: claimErr } = await admin
    .from("billing_events")
    .insert({ stripe_event_id: event.id, type: event.type, payload: event.data.object as never });
  if (claimErr) {
    if (claimErr.code === "23505") return json({ received: true, duplicate: true });
    return json({ error: "event_log_failed", detail: claimErr.message }, 500);
  }

  let companyId: string | null = null;
  try {
    switch (event.type) {
      case "checkout.session.completed":
        companyId = await onCheckoutCompleted(admin, event.data.object as Stripe.Checkout.Session);
        break;
      case "invoice.paid":
        companyId = await onInvoicePaid(admin, stripe, event.data.object as Stripe.Invoice);
        break;
      case "invoice.payment_failed":
        companyId = await onPaymentFailed(admin, event.data.object as Stripe.Invoice);
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        companyId = await onSubscriptionChanged(admin, event.data.object as Stripe.Subscription);
        break;
      default:
        break; // Unsubscribed event types are logged and ignored.
    }

    await admin
      .from("billing_events")
      .update({ handled: true, company_id: companyId })
      .eq("stripe_event_id", event.id);

    return json({ received: true });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);

    // Release the claim, or Stripe's retry would be swallowed as a duplicate
    // and the event would never be applied. The failure is kept as its own
    // row (suffixed id, so it cannot collide with the real one) so a silent
    // handler bug still leaves a trail.
    await admin.from("billing_events").delete().eq("stripe_event_id", event.id);
    await admin.from("billing_events").insert({
      stripe_event_id: `${event.id}:failed:${Date.now()}`,
      type: event.type,
      payload: event.data.object as never,
      handled: false,
      error: detail,
    });

    // 500 tells Stripe to retry.
    return json({ error: "handler_failed", detail }, 500);
  }
});
