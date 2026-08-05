// Edge function: billing-manage
//
// Everything an existing, signed-in org does to its own subscription. Requires
// a valid session and the super_admin role (or a super-super-admin acting on a
// company). Deploy WITH jwt verification.
//
// Body: { action, ... }
//   { action: "portal" }
//       → { url }  Stripe billing portal: card on file, invoices, cancel.
//   { action: "quote", guards, care }
//       → the price of a plan change, without changing anything.
//   { action: "change_plan", guards, care }
//       → repriced subscription + new guard cap. Stripe prorates.
//   { action: "ai_topup", pack }
//       → { url }  one-off Checkout for a prepaid AI credit pack.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  APP_URL, adminClient, callerFrom, fxRate, json, preflight, stripeClient,
} from "../_shared/billing.ts";
import { AI_TOPUP_PACKS, computePricing, pkrToUsdCents } from "../_shared/pricing.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = adminClient();
  const caller = await callerFrom(req, admin);
  if (!caller) return json({ error: "invalid_token" }, 401);
  if (caller.role !== "super_admin" && caller.role !== "super_super_admin") {
    // Billing is the person-who-pays's business. Other roles can see the
    // screen (read-only) but cannot move money.
    return json({ error: "forbidden" }, 403);
  }
  if (!caller.company_id) return json({ error: "company_id_required" }, 400);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const action = String(body.action ?? "");

  const { data: company, error: companyErr } = await admin
    .from("companies")
    .select("id, name, guard_limit, guard_buffer, plan_care, ai_credit_monthly, stripe_customer_id, stripe_subscription_id")
    .eq("id", caller.company_id)
    .maybeSingle();
  if (companyErr || !company) return json({ error: "company_not_found" }, 404);

  let stripe: ReturnType<typeof stripeClient>;
  try { stripe = stripeClient(); } catch { return json({ error: "stripe_not_configured" }, 500); }

  const rate = fxRate();

  try {
    // ---------------------------------------------------------------------
    // quote — what a change would cost. Reads nothing, writes nothing.
    // ---------------------------------------------------------------------
    if (action === "quote") {
      const quote = computePricing(Number(body.guards), body.care === true);
      return json({
        quote,
        amount_usd_cents: pkrToUsdCents(quote.total, rate),
        fx_rate: rate,
      });
    }

    // ---------------------------------------------------------------------
    // portal — card, invoices, cancellation. Stripe hosts all of it.
    // ---------------------------------------------------------------------
    if (action === "portal") {
      if (!company.stripe_customer_id) return json({ error: "no_stripe_customer" }, 400);
      const session = await stripe.billingPortal.sessions.create({
        customer: company.stripe_customer_id,
        return_url: `${APP_URL}/super-admin/billing`,
      });
      return json({ url: session.url });
    }

    // ---------------------------------------------------------------------
    // change_plan — the "Upgrade" the guard cap points people at.
    // ---------------------------------------------------------------------
    if (action === "change_plan") {
      if (!company.stripe_subscription_id) return json({ error: "no_subscription" }, 400);

      const care = body.care === true;
      const quote = computePricing(Number(body.guards), care);

      // A downgrade below the guards actually on the books would leave the org
      // instantly over its own cap and unable to add anyone. Refuse it and say
      // what they would have to remove.
      const { data: usedRaw } = await admin
        .rpc("billable_guard_count", { p_company: company.id });
      const used = Number(usedRaw ?? 0);
      if (quote.guards < used) {
        return json({ error: "below_current_headcount", detail: String(used), guards_used: used }, 400);
      }

      const sub = await stripe.subscriptions.retrieve(company.stripe_subscription_id);
      const item = sub.items.data[0];
      if (!item) return json({ error: "no_subscription_item" }, 500);

      // A fresh Price for the new monthly amount. Inline product_data means no
      // dashboard setup and no orphaned Products to manage.
      const price = await stripe.prices.create({
        currency: "usd",
        unit_amount: pkrToUsdCents(quote.total, rate),
        recurring: { interval: "month" },
        product_data: { name: `Bastion — ${company.name}` },
      });

      await stripe.subscriptions.update(company.stripe_subscription_id, {
        items: [{ id: item.id, price: price.id }],
        // Stripe works out the part-month credit and charge; it lands on the
        // next invoice rather than taking money the moment they click.
        proration_behavior: "create_prorations",
        metadata: {
          ...sub.metadata,
          guards: String(quote.guards),
          care: care ? "1" : "0",
          amount_pkr: String(quote.total),
          ai_credit_monthly: String(quote.aiCredit),
        },
      });

      await admin
        .from("companies")
        .update({
          guard_limit: quote.guards,
          plan_care: care,
          plan_price_pkr: quote.total,
          plan_price_usd_cents: pkrToUsdCents(quote.total, rate),
          plan_fx_rate: rate,
          // The new tier applies from now, not from the next invoice — the
          // customer has just agreed to pay for it.
          ai_credit_monthly: quote.aiCredit,
          updated_at: new Date().toISOString(),
        })
        .eq("id", company.id);

      const previous = Number(company.ai_credit_monthly ?? 0);
      if (quote.aiCredit !== previous) {
        await admin.from("ai_credit_ledger").insert({
          company_id: company.id,
          kind: "adjustment",
          amount_pkr: quote.aiCredit - previous,
          monthly_after: quote.aiCredit,
          description: `Monthly AI credit changed with plan (${previous} → ${quote.aiCredit})`,
        });
      }

      return json({ ok: true, quote, guard_limit: quote.guards });
    }

    // ---------------------------------------------------------------------
    // ai_topup — prepaid credit when the monthly allowance runs out.
    // ---------------------------------------------------------------------
    if (action === "ai_topup") {
      const pack = AI_TOPUP_PACKS.find((p) => p.id === String(body.pack ?? ""));
      if (!pack) return json({ error: "unknown_pack" }, 400);
      if (!company.stripe_customer_id) return json({ error: "no_stripe_customer" }, 400);

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: company.stripe_customer_id,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: pkrToUsdCents(pack.credit, rate),
            product_data: {
              name: pack.label,
              description: "Prepaid AI assistant credit. Does not expire.",
            },
          },
        }],
        success_url: `${APP_URL}/super-admin/billing?topup=success`,
        cancel_url: `${APP_URL}/super-admin/billing?topup=canceled`,
        // The webhook reads these to know who to credit and how much. Nothing
        // about the grant is taken from the browser.
        metadata: {
          kind: "ai_topup",
          company_id: company.id,
          credit_pkr: String(pack.credit),
          pack: pack.id,
        },
      });

      return json({ url: session.url });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: "billing_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});
