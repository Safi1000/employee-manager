// Edge function: signup-complete
//
// Step 2 of self-serve signup. PUBLIC — the person still has no account.
// Deploy with --no-verify-jwt.
//
// Body: { token, password, full_name?, session_id? }
// Returns: { ok: true, email }  — the browser then signs in normally.
//
// This is the gate. It creates the company and its super admin, and it refuses
// to do so unless the matching signup_intent is in status 'paid'. Every other
// path into the system (the Sign up button, the /signup form, the CTA on the
// pricing calculator) leads here, so "no sign-up until payment is confirmed"
// holds no matter what the browser does.
//
// The password is chosen here, after payment, and is never stored anywhere but
// auth.users — signup_intents deliberately has no password column.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, json, preflight, stripeClient } from "../_shared/billing.ts";
import { GUARD_BUFFER } from "../_shared/pricing.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const token = String(body.token ?? "").trim();
  const password = String(body.password ?? "");
  const sessionId = body.session_id == null ? null : String(body.session_id).trim() || null;
  const fullNameIn = body.full_name == null ? null : String(body.full_name).trim() || null;

  if (!token) return json({ error: "token_required" }, 400);
  if (password.length < 8) return json({ error: "password_too_short" }, 400);

  const admin = adminClient();

  const { data: intent, error: intentErr } = await admin
    .from("signup_intents")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (intentErr) return json({ error: "lookup_failed", detail: intentErr.message }, 500);
  if (!intent) return json({ error: "invalid_token" }, 404);

  if (intent.status === "claimed") return json({ error: "already_claimed" }, 409);
  if (new Date(intent.expires_at).getTime() < Date.now()) {
    return json({ error: "token_expired" }, 410);
  }

  let status = String(intent.status);
  let subscriptionId: string | null = intent.stripe_subscription_id ?? null;

  // The browser is redirected the instant Stripe finishes, which is often
  // BEFORE the webhook lands. Rather than make the customer sit on a spinner,
  // confirm the payment straight from Stripe. The webhook remains the
  // authority for everything after this — it just is not the only way in.
  if (status !== "paid" && sessionId) {
    try {
      const stripe = stripeClient();
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const paid = session.payment_status === "paid" ||
        session.payment_status === "no_payment_required";
      // The session must be the one this intent created, or a paid session
      // from any other customer could be replayed to claim a free org.
      const belongs = session.metadata?.intent_id === intent.id;
      if (paid && belongs) {
        status = "paid";
        subscriptionId = typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id ?? subscriptionId;
      }
    } catch {
      // Fall through to the not_paid response below.
    }
  }

  if (status !== "paid") return json({ error: "not_paid" }, 402);

  const email = String(intent.email).toLowerCase();
  const fullName = fullNameIn ?? intent.full_name ?? null;

  // Re-check right before creating: someone could have been given an account
  // by another route while this intent sat waiting.
  const { data: clash } = await admin
    .from("profiles").select("id").ilike("email", email).maybeSingle();
  if (clash) return json({ error: "email_in_use" }, 409);

  // Read the live subscription so the opening period matches Stripe exactly,
  // rather than assuming "a month from now".
  let periodEndIso: string | null = null;
  let billingStatus = "active";
  if (subscriptionId) {
    try {
      const stripe = stripeClient();
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      periodEndIso = new Date(sub.current_period_end * 1000).toISOString();
      billingStatus = sub.status === "trialing" ? "trialing" : "active";
    } catch {
      // Non-fatal: the next invoice.paid webhook sets both correctly.
    }
  }

  // --- create the company -------------------------------------------------
  // ai_credit_monthly starts at 0 on purpose; the grant below is what raises it,
  // so the ledger opens with a proper 'monthly_grant' row rather than a balance
  // that appeared from nowhere.
  const { data: company, error: companyErr } = await admin
    .from("companies")
    .insert({
      name: intent.company_name,
      contact_email: email,
      active: true,
      guard_limit: intent.guards,
      guard_buffer: GUARD_BUFFER,
      plan_care: intent.care,
      plan_price_pkr: intent.amount_pkr,
      plan_price_usd_cents: intent.amount_usd_cents,
      plan_fx_rate: intent.fx_rate,
      billing_status: billingStatus,
      stripe_customer_id: intent.stripe_customer_id,
      stripe_subscription_id: subscriptionId,
      current_period_end: periodEndIso,
      subscription_expires_at: periodEndIso ? periodEndIso.slice(0, 10) : null,
      ai_credit_monthly: 0,
    })
    .select("id")
    .single();
  if (companyErr) {
    return json({ error: "company_create_failed", detail: companyErr.message }, 500);
  }

  // --- create the super admin ---------------------------------------------
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (createErr || !created.user) {
    // Nothing is half-built: the company goes with the failed user.
    await admin.from("companies").delete().eq("id", company.id);
    return json({ error: "user_create_failed", detail: createErr?.message }, 400);
  }

  const { error: profileErr } = await admin.from("profiles").insert({
    id: created.user.id,
    company_id: company.id,
    branch_id: null,
    role: "super_admin",
    title: "Super Admin",
    email,
    full_name: fullName,
    permissions: [],
    // They just chose this password. Forcing a change immediately would be
    // confusing — that flag is for accounts whose password someone else set.
    must_change_password: false,
  });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    await admin.from("companies").delete().eq("id", company.id);
    return json({ error: "profile_create_failed", detail: profileErr.message }, 500);
  }

  // Opening AI allowance, written through the same RPC a renewal uses so the
  // ledger reads identically for month 1 and month 12.
  await admin.rpc("ai_credit_reset_period", {
    p_company: company.id,
    p_monthly: Number(intent.ai_credit_monthly ?? 0),
  });

  // Spend the token. Doing this last means any failure above leaves the intent
  // reusable rather than stranding a paying customer with a dead link.
  await admin
    .from("signup_intents")
    .update({
      status: "claimed",
      claimed_at: new Date().toISOString(),
      company_id: company.id,
      stripe_subscription_id: subscriptionId,
    })
    .eq("id", intent.id);

  // Keep the manual subscription ledger the SSA screens already read in step.
  await admin.from("subscription_payments").insert({
    company_id: company.id,
    amount: intent.amount_pkr,
    days_added: 30,
    notes: `Self-serve signup via Stripe · ${intent.guards} guards` +
      (intent.care ? " · Bastion Care" : ""),
  });

  return json({ ok: true, email, company_id: company.id }, 201);
});
