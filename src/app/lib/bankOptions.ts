import { supabase } from "./supabase";
import { hasAnyPermission } from "./auth";

/**
 * Bank pickers and cheque totals without reading the money (0530, 2026-10-21).
 *
 * People who may PAY from a bank (expenses, payroll, receipts) need the list of
 * accounts to choose from, not their balances — and once 0531 gates
 * bank_accounts by banks.view they cannot read the table at all. So a picker
 * asks bank_account_options() (no balance, last four digits), and only someone
 * with banking access reads the table itself.
 *
 * Until 0530 is applied the function does not exist, so each helper falls back
 * to the read the screen made before. The release and the migration can land
 * in either order.
 */
export type BankOption = {
  id: string;
  bank_name: string;
  account_number: string;
  account_type: string | null;
  active: boolean;
  owner_type: string | null;
  owner_partner_id: string | null;
  owner_client_id: string | null;
  /** 0 when read through the picker function — the balance is not offered. */
  balance: number;
  /** Set when the balance was withheld; ask bankCovers() instead of reading it. */
  balanceHidden?: boolean;
};

/** The keys 0531 lets read bank_accounts — keep in step with its perm_read policy. */
export const BANK_READ_KEYS = ["banks.view", "accounting.edit", "reports.view", "cashflow.view", "accountant.view", "reversals.execute"];
export const canReadBankBalances = (profile: Parameters<typeof hasAnyPermission>[0]) => hasAnyPermission(profile, BANK_READ_KEYS);

/** The keys 0531 lets read invoices — the same list as its perm_read policy. */
export const INVOICE_READ_KEYS = ["invoices.view", "invoices.edit", "receivables.view", "accounting.edit", "reports.view", "cashflow.view", "period_close.manage", "accountant.view", "reversals.execute"];
export const canReadInvoices = (profile: Parameters<typeof hasAnyPermission>[0]) => hasAnyPermission(profile, INVOICE_READ_KEYS);

export async function loadBankOptions<T = BankOption>(companyId: string | null, fullAccess: boolean, select = "*"): Promise<T[]> {
  const table = async () => {
    let q = supabase.from("bank_accounts").select(select);
    if (companyId) q = q.eq("company_id", companyId);
    const { data } = await q.order("bank_name");
    return (data ?? []) as unknown as T[];
  };
  if (fullAccess || !companyId) return table();
  const { data, error } = await supabase.rpc("bank_account_options", { p_company_id: companyId });
  if (error) return table();
  return ((data ?? []) as { id: string; bank_name: string; account_last4: string | null; account_type: string | null; active: boolean; owner_type: string | null; owner_partner_id: string | null; owner_client_id: string | null }[])
    .map((b) => ({ id: b.id, bank_name: b.bank_name, account_number: b.account_last4 ? `•••• ${b.account_last4}` : "", account_type: b.account_type, active: b.active, owner_type: b.owner_type, owner_partner_id: b.owner_partner_id, owner_client_id: b.owner_client_id, balance: 0, balanceHidden: true })) as unknown as T[];
}

/** Per cheque, what is already linked to it (payslips, expenses, advances, receipts). */
export async function loadChequeLinkedSums(companyId: string | null): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  if (companyId) {
    const { data, error } = await supabase.rpc("cheque_linked_amounts", { p_company_id: companyId });
    if (!error) {
      for (const r of (data ?? []) as { cheque_id: string; linked: number }[]) m.set(r.cheque_id, Number(r.linked));
      return m;
    }
  }
  // Before 0530: the four reads the screens made themselves.
  const [ps, ex, adv, ip] = await Promise.all([
    supabase.from("payslips").select("cheque_id, net_salary").not("cheque_id", "is", null),
    supabase.from("expenses").select("cheque_id, amount").not("cheque_id", "is", null),
    supabase.from("advances").select("cheque_id, amount").not("cheque_id", "is", null),
    supabase.from("invoice_payments").select("cheque_id, amount").not("cheque_id", "is", null),
  ]);
  const add = (id: string | null, v: number) => { if (id) m.set(id, (m.get(id) ?? 0) + v); };
  for (const r of (ps.data ?? []) as { cheque_id: string; net_salary: number }[]) add(r.cheque_id, Number(r.net_salary));
  for (const r of (ex.data ?? []) as { cheque_id: string; amount: number }[]) add(r.cheque_id, Number(r.amount));
  for (const r of (adv.data ?? []) as { cheque_id: string; amount: number }[]) add(r.cheque_id, Number(r.amount));
  for (const r of (ip.data ?? []) as { cheque_id: string; amount: number }[]) add(r.cheque_id, Number(r.amount));
  return m;
}

/**
 * Can this account pay `amount`? The screens are the only thing refusing an
 * overdraft (apply_money_delta does not), so the guard has to survive for
 * someone who is not shown the balance: they ask bank_can_cover(), which
 * answers yes or no and never the figure. `headroom` is money this same action
 * puts back first (an edit reversing its own earlier payment).
 */
export async function bankCovers(bank: { id: string; balance: number | string; balanceHidden?: boolean }, amount: number, headroom = 0): Promise<boolean> {
  if (!bank.balanceHidden) return amount <= Number(bank.balance) + headroom;
  const { data, error } = await supabase.rpc("bank_can_cover", { p_bank_account_id: bank.id, p_amount: amount - headroom });
  // Unable to confirm is a refusal: the alternative is paying blind.
  return !error && data === true;
}
