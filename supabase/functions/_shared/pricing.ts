// The pricing model, in exactly one place.
//
// This file is the single source of truth for what a customer is charged. It is
// imported by:
//   * the landing page calculator      (src/app/landing/interactions.ts)
//   * the signup screen                (src/app/pages/Signup.tsx)
//   * the checkout edge function       (supabase/functions/billing-checkout)
//   * the webhook + upgrade functions  (supabase/functions/stripe-webhook, billing-manage)
//
// It lives under supabase/functions/_shared so Deno can import it with no build
// step; src/app/lib/pricing.ts re-exports it for the browser. Keeping ONE copy
// matters more than the slightly odd location: if the slider and the charge can
// disagree, sooner or later they will, and the customer is billed a number they
// never saw.
//
// No imports, no Deno/browser APIs — it must run unchanged in both.

export const PRICING = {
  /** What the customer is quoted in. */
  currency: "PKR",
  /** Flat monthly platform fee. Covers the first `includedGuards` guards. */
  platformFee: 7500,
  includedGuards: 50,
  /** Optional add-on. */
  care: { label: "Bastion Care", price: 5000 },
  /** Shown in the CTA. */
  offerDeadline: "15 August",
  /** Slider range; the number input may go higher (see inputMax). */
  slider: { min: 1, max: 1000, step: 1, default: 180 },
  inputMax: 5000,
  /**
   * MARGINAL bands: a guard is charged only at the rate of the band they
   * fall in, not at one flat rate for the whole headcount. `to: null` = the
   * open-ended top band. Bands must be contiguous and ascending.
   */
  bands: [
    { from: 1, to: 50 as number | null, rate: 0 },
    { from: 51, to: 100 as number | null, rate: 85 },
    { from: 101, to: 250 as number | null, rate: 70 },
    { from: 251, to: 500 as number | null, rate: 55 },
    { from: 501, to: null as number | null, rate: 45 },
  ],
  /** Included monthly AI credit, set by the highest band the count reaches. */
  aiTiers: [
    { upTo: 50 as number | null, credit: 250 },
    { upTo: 100 as number | null, credit: 500 },
    { upTo: 250 as number | null, credit: 1250 },
    { upTo: 500 as number | null, credit: 2500 },
    { upTo: null as number | null, credit: 5000 },
  ],
};

/**
 * Guards allowed over the paid headcount before the app refuses to add more.
 * The customer is told about the buffer the moment they enter it — it is
 * breathing room for a normal week's hiring, not a free extra five guards.
 */
export const GUARD_BUFFER = 5;

/**
 * PKR per 1 USD.
 *
 * Stripe has no Pakistani merchant country, so the landing page quotes PKR and
 * Stripe charges the USD equivalent. This rate converts one to the other, and
 * is stored on every charge so an old invoice can still be explained after the
 * rate is changed. Override at runtime with the PKR_PER_USD function secret.
 *
 * REVIEW THIS PERIODICALLY — if the real rate moves and this does not, you are
 * silently discounting or overcharging.
 */
export const DEFAULT_PKR_PER_USD = 280;

/** Prepaid AI credit packs, in PKR. Bought when the monthly credit runs out. */
export const AI_TOPUP_PACKS = [
  { id: "ai_1000", credit: 1000, label: "PKR 1,000 of AI credit" },
  { id: "ai_2500", credit: 2500, label: "PKR 2,500 of AI credit" },
  { id: "ai_5000", credit: 5000, label: "PKR 5,000 of AI credit" },
];

/**
 * What one AI request costs us, per million tokens, in USD, at list price for
 * the model the assistant runs (gpt-5-mini). `markup` is what turns our cost
 * into the customer's cost — 1.0 would be selling at cost.
 */
export const AI_COST = {
  model: "gpt-5-mini",
  usdPerMillionInput: 0.25,
  usdPerMillionOutput: 2.0,
  markup: 2.0,
};

export type PriceLine = { label: string; detail: string; amount: number };
export type Quote = {
  guards: number;
  care: boolean;
  lines: PriceLine[];
  /** Monthly total in PKR. */
  total: number;
  perGuard: number;
  aiCredit: number;
};

/** Whole guards, at least one — the only shape the rest of the math accepts. */
export function normaliseGuards(raw: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < PRICING.slider.min) return PRICING.slider.min;
  return Math.min(n, PRICING.inputMax);
}

/**
 * The whole pricing model, in one function.
 *   total = platform fee + Σ (guards in band × band rate) + Bastion Care
 * Reference case: 180 guards, no Care →
 *   7,500 + (50 × 85) + (80 × 70) = 17,350; per guard 96; AI credit 1,250.
 */
export function computePricing(guardsRaw: number, careOn: boolean): Quote {
  const guards = normaliseGuards(guardsRaw);

  const lines: PriceLine[] = [{
    label: "Platform fee",
    detail: "includes the first " + PRICING.includedGuards + " guards",
    amount: PRICING.platformFee,
  }];

  for (const band of PRICING.bands) {
    // How many guards land inside this band, given the headcount.
    const top = band.to == null ? guards : Math.min(guards, band.to);
    const count = top - band.from + 1;
    if (count <= 0 || band.rate === 0) continue; // band 1 is inside the platform fee
    lines.push({
      label: "Guards " + band.from + (band.to == null ? "+" : "–" + band.to),
      detail: count + " × " + band.rate,
      amount: count * band.rate,
    });
  }

  if (careOn) {
    lines.push({ label: PRICING.care.label, detail: "add-on", amount: PRICING.care.price });
  }

  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  const tier = PRICING.aiTiers.find((t) => t.upTo == null || guards <= t.upTo);

  return {
    guards,
    care: careOn,
    lines,
    total,
    perGuard: total / guards,
    aiCredit: tier ? tier.credit : 0,
  };
}

/** "PKR 17,350" — always a rounded integer, never a float artifact. */
export function money(n: number): string {
  return PRICING.currency + " " + Math.round(n).toLocaleString("en-US");
}

/**
 * PKR → USD cents for Stripe. Rounded UP to the cent so rounding can never
 * quietly bill less than the quote; Stripe rejects amounts under 50 cents, so
 * that is the floor.
 */
export function pkrToUsdCents(pkr: number, rate: number = DEFAULT_PKR_PER_USD): number {
  const effective = rate > 0 ? rate : DEFAULT_PKR_PER_USD;
  return Math.max(50, Math.ceil((pkr / effective) * 100));
}

/** USD → PKR, for turning a model bill back into the customer's unit. */
export function usdToPkr(usd: number, rate: number = DEFAULT_PKR_PER_USD): number {
  const effective = rate > 0 ? rate : DEFAULT_PKR_PER_USD;
  return usd * effective;
}

/**
 * What to charge a customer's AI credit for one completed request, in PKR.
 * Our token cost at list price, times the markup, converted at the same rate
 * used for subscriptions so one rupee means the same thing everywhere.
 */
export function aiCostPkr(
  promptTokens: number,
  completionTokens: number,
  rate: number = DEFAULT_PKR_PER_USD,
): { usd: number; pkr: number } {
  const usd =
    (promptTokens / 1_000_000) * AI_COST.usdPerMillionInput +
    (completionTokens / 1_000_000) * AI_COST.usdPerMillionOutput;
  const billed = usd * AI_COST.markup;
  return { usd, pkr: usdToPkr(billed, rate) };
}
