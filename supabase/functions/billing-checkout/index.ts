// Edge function: billing-checkout
//
// Step 1 of self-serve signup. PUBLIC — no session exists yet, by definition.
// Deploy with --no-verify-jwt.
//
// Body: { email, full_name?, company_name, guards, care }
// Returns: { url, token }
//
// It records a signup_intent and opens a Stripe Checkout subscription session.
// It creates NOTHING else: no company, no auth user, no profile. Those are made
// by signup-complete, and only once Stripe says the money arrived. That split
// is the whole "no sign-up until payment is made" rule — a visitor who
// abandons checkout leaves behind one pending row and nothing to sign in with.
//
// The price is recomputed here from guards+care. The amount the browser
// calculated is never read, so a tampered request buys the plan it actually
// asked for at the real price.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  APP_URL, adminClient, fxRate, json, preflight, randomToken, stripeClient,
} from "../_shared/billing.ts";
import { GUARD_BUFFER, computePricing, pkrToUsdCents } from "../_shared/pricing.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const email = String(body.email ?? "").trim().toLowerCase();
  const fullName = body.full_name == null ? null : String(body.full_name).trim() || null;
  const companyName = String(body.company_name ?? "").trim();
  const care = body.care === true || body.care === "true";
  const guardsRaw = Number(body.guards);

  if (!email || !email.includes("@")) return json({ error: "valid_email_required" }, 400);
  if (!companyName) return json({ error: "company_name_required" }, 400);
  if (!Number.isFinite(guardsRaw) || guardsRaw < 1) return json({ error: "guards_required" }, 400);

  const admin = adminClient();

  // An email that already belongs to an account must sign in, not sign up
  // again. Two orgs on one login is not a thing the app can represent, and
  // paying a second time would create a company they could never reach.
  const { data: existingProfile } = await admin
    .from("profiles").select("id").ilike("email", email).maybeSingle();
  if (existingProfile) return json({ error: "email_in_use" }, 409);

  // Price it server-side. The quote object is what both the intent row and the
  // Stripe line item are built from, so they cannot disagree.
  const quote = computePricing(guardsRaw, care);
  const rate = fxRate();
  const usdCents = pkrToUsdCents(quote.total, rate);

  let stripe: ReturnType<typeof stripeClient>;
  try { stripe = stripeClient(); } catch { return json({ error: "stripe_not_configured" }, 500); }

  const token = randomToken();

  try {
    // Reuse a customer if this email already abandoned a checkout, so a person
    // who tries twice does not end up as two customers in the Stripe dashboard.
    const found = await stripe.customers.list({ email, limit: 1 });
    const customer = found.data[0] ??
      await stripe.customers.create({ email, name: fullName ?? companyName });

    const { data: intent, error: intentErr } = await admin
      .from("signup_intents")
      .insert({
        token,
        email,
        full_name: fullName,
        company_name: companyName,
        guards: quote.guards,
        care,
        amount_pkr: quote.total,
        amount_usd_cents: usdCents,
        fx_rate: rate,
        ai_credit_monthly: quote.aiCredit,
        stripe_customer_id: customer.id,
        status: "pending",
      })
      .select("id")
      .single();
    if (intentErr) return json({ error: "intent_failed", detail: intentErr.message }, 500);

    const description =
      `${quote.guards} guards · PKR ${Math.round(quote.total).toLocaleString("en-US")}/month` +
      (care ? " · Bastion Care" : "") +
      ` · includes PKR ${quote.aiCredit.toLocaleString("en-US")} AI credit`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      client_reference_id: intent.id,
      // Inline price_data instead of a dashboard Price: the amount is a pure
      // function of guard count, so pre-creating one Price per possible plan
      // would mean thousands of them.
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: usdCents,
          recurring: { interval: "month" },
          product_data: {
            name: `Bastion — ${companyName}`,
            description,
          },
        },
      }],
      // The token is what the browser comes back with; session_id lets
      // signup-complete confirm payment directly with Stripe if the webhook
      // has not landed yet.
      success_url: `${APP_URL}/signup/complete?token=${token}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/signup?canceled=1`,
      metadata: {
        kind: "signup",
        intent_id: intent.id,
        token,
        guards: String(quote.guards),
        care: care ? "1" : "0",
        amount_pkr: String(quote.total),
        ai_credit_monthly: String(quote.aiCredit),
        guard_buffer: String(GUARD_BUFFER),
      },
      subscription_data: {
        metadata: {
          kind: "signup",
          intent_id: intent.id,
          guards: String(quote.guards),
          care: care ? "1" : "0",
          amount_pkr: String(quote.total),
          ai_credit_monthly: String(quote.aiCredit),
        },
      },
    });

    await admin
      .from("signup_intents")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", intent.id);

    return json({ url: session.url, token, amount_pkr: quote.total, amount_usd_cents: usdCents });
  } catch (e) {
    return json({ error: "checkout_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});
