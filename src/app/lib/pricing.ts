// Browser-side entry point for the pricing model.
//
// The implementation deliberately lives in supabase/functions/_shared/pricing.ts
// so that the edge functions — which charge the card — and the UI that quotes
// the price cannot drift apart. This file exists only so app code can write
// `from "../lib/pricing"` instead of reaching across the repo.
//
// Do not add logic here. Change the shared file.
export * from "../../../supabase/functions/_shared/pricing.ts";
