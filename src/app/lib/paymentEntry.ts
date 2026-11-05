import { supabase } from "./supabase";

/**
 * Recording a client payment, with the 0640 entry checks (4 Nov 2026: a 5 Oct
 * cash payment was entered twice, the second time on 2 Nov, and quietly
 * settled the next month's invoice).
 *
 * Before saving it asks the database what the checks would say. If the client
 * already has a payment of the same amount dated within 3 days, or the payment
 * is dated more than 7 days ago, the person sees the earlier payment and must
 * give a reason to save it anyway; the reason is kept on the payment and the
 * super admins are told. The database refuses the same entries without a
 * reason whatever screen sends them, so this is the explanation, not the guard.
 */
type Warnings = {
  duplicates: { amount: number; payment_date: string; entered_on: string; entered_by: string | null; invoice: string | null }[];
  backdated_days: number;
};
type PaymentArgs = Record<string, unknown> & { p_amount: number; p_payment_date: string };

const pkr = (n: number) => Number(n).toLocaleString("en-PK", { maximumFractionDigits: 0 });

export async function recordPaymentChecked(
  args: PaymentArgs,
  clientId: string | null | undefined,
): Promise<{ error: { message: string } | null; cancelled?: boolean }> {
  let reason: string | null = null;
  if (clientId) {
    const { data } = await supabase.rpc("payment_entry_warnings", {
      p_client_id: clientId, p_amount: args.p_amount, p_payment_date: args.p_payment_date,
    });
    const w = data as Warnings | null;
    if (w && (w.duplicates.length || w.backdated_days)) {
      const parts: string[] = [];
      if (w.duplicates.length) {
        parts.push("This client already has:");
        for (const d of w.duplicates) {
          parts.push(`• PKR ${pkr(d.amount)} dated ${d.payment_date}, entered ${d.entered_on} by ${d.entered_by ?? "someone"}${d.invoice ? ` (${d.invoice})` : ""}`);
        }
        parts.push("", "Is this a SECOND, separate payment?");
      }
      if (w.backdated_days) parts.push(`This payment is dated ${w.backdated_days} days ago.`);
      parts.push("", "To save it anyway, say why (it is kept with the payment). Cancel to go back.");
      const typed = window.prompt(parts.join("\n"));
      if (typed === null || !typed.trim()) return { error: null, cancelled: true };
      if (typed.trim().length < 5) return { error: { message: "Give a reason of at least a few words." } };
      reason = typed.trim();
    }
  }
  const { error } = await supabase.rpc("record_invoice_payment_checked", { ...args, p_entry_reason: reason });
  return { error };
}
