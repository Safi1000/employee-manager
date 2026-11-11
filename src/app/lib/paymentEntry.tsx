import { supabase } from "./supabase";
import { askReason } from "../components/askReason";

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
      const typed = await askReason({
        title: w.duplicates.length ? "Is this a second payment?" : "Backdated payment",
        subject: { title: `PKR ${pkr(args.p_amount)}`, meta: `Dated ${args.p_payment_date}` },
        message: w.duplicates.length ? (
          <>
            <p>This client already has a payment that looks the same:</p>
            <ul className="space-y-1.5">
              {w.duplicates.map((d, i) => (
                <li key={i} className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
                  <span className="font-semibold">PKR {pkr(d.amount)}</span> dated {d.payment_date}
                  <span className="text-muted-foreground"> · entered {d.entered_on} by {d.entered_by ?? "someone"}{d.invoice ? ` · ${d.invoice}` : ""}</span>
                </li>
              ))}
            </ul>
            <p>Save only if this is a separate payment, not the same one entered again.</p>
          </>
        ) : undefined,
        warning: w.backdated_days
          ? <>This payment is dated <span className="font-semibold">{w.backdated_days} days ago</span>. That is normal for a cheque that cleared later — say so below.</>
          : undefined,
        label: "Why save it anyway?",
        placeholder: w.duplicates.length ? "e.g. Second instalment for the same month" : "e.g. Cheque dated 20 Oct, cleared 11 Nov",
        hint: "Kept with the payment, and the super admins are told.",
        confirmLabel: "Save payment",
        minLength: 5,
      });
      if (typed === null) return { error: null, cancelled: true };
      reason = typed;
    }
  }
  const { error } = await supabase.rpc("record_invoice_payment_checked", { ...args, p_entry_reason: reason });
  return { error };
}
