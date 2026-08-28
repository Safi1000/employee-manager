// Cash-custodian attribution (migration 0135).
//
// Every cash movement — client cash received (invoice_payments) and cash paid out
// (expenses) — is stamped with the office-staff custodian who physically handled it,
// via a CUSTODIAN cash_location linked to that employee (custodian_employee_id).
// treasury.cash_balance stays the canonical total; these balances reconcile up to it.
//
// heldCash(location) = opening + net custody_transfers + attributed cash-in − attributed cash-out
// (cash expenses AND cash salary advances, both stamped with custodian_location_id).
// This is the single source of truth reused by Cash Custody, Record Payment, and Expenses.
import { supabase } from "./supabase";

export type CustodianOption = {
  employeeId: string;
  fullName: string;
  /** Existing custodian cash_location for this employee, or null until first stamped. */
  locationId: string | null;
  /** Cash this office-staff member currently holds. 0 when no location exists yet. */
  held: number;
};

/**
 * Load every office-staff member as a selectable custodian, each with the cash they
 * currently hold. Used to render the "who received / who paid" dropdowns.
 */
export async function loadCustodianOptions(companyId: string): Promise<CustodianOption[]> {
  const [{ data: staff }, { data: locs }, { data: tx }, { data: cashPays }, { data: cashExps }, { data: cashAdvances }, { data: cashCheques }, { data: bankWd }] =
    await Promise.all([
      supabase.from("employees").select("id, full_name").eq("category", "office_staff").order("full_name"),
      supabase
        .from("cash_locations")
        .select("id, custodian_employee_id, opening_balance, is_active, location_type")
        .eq("company_id", companyId)
        .not("custodian_employee_id", "is", null),
      supabase.from("custody_transfers").select("from_location_id, to_location_id, amount").eq("company_id", companyId),
      supabase.from("invoice_payments").select("amount, custodian_location_id").eq("payment_mode", "Cash").not("custodian_location_id", "is", null),
      supabase.from("expenses").select("amount, custodian_location_id").not("custodian_location_id", "is", null),
      // Salary advances paid in cash by a custodian (0203) — cash out of their
      // hands, exactly like an expense.
      supabase.from("advances").select("amount, custodian_location_id").eq("payment_mode", "Cash").not("custodian_location_id", "is", null),
      // Cleared cash cheques handed to a custodian — cash they now physically hold.
      supabase.from("cheques").select("amount, custodian_location_id").eq("cheque_type", "cash").eq("status", "cleared").not("custodian_location_id", "is", null),
      // Bank→custodian withdrawals (reference_id = custodian cash_location).
      supabase.from("bank_transactions").select("cash_delta, reference_id").eq("kind", "withdraw_to_cash").not("reference_id", "is", null),
    ]);

  // Payroll paid in cash by a custodian — cash they physically hand out
  // (reference_id = custodian cash_location, cash_delta negative). Fetched
  // separately so the two bank_transactions reads stay independent.
  const { data: payrollCash } = await supabase
    .from("bank_transactions")
    .select("cash_delta, reference_id")
    .eq("kind", "payroll")
    .not("reference_id", "is", null);

  // Most-recent active custodian location per employee.
  const locByEmployee = new Map<string, { id: string; opening: number }>();
  for (const l of (locs ?? []) as any[]) {
    if (l.is_active === false) continue;
    if (!l.custodian_employee_id) continue;
    if (!locByEmployee.has(l.custodian_employee_id)) {
      locByEmployee.set(l.custodian_employee_id, { id: l.id, opening: Number(l.opening_balance ?? 0) });
    }
  }

  const heldByLoc = new Map<string, number>();
  for (const [, v] of locByEmployee) heldByLoc.set(v.id, v.opening);
  for (const t of (tx ?? []) as any[]) {
    if (t.to_location_id && heldByLoc.has(t.to_location_id)) heldByLoc.set(t.to_location_id, (heldByLoc.get(t.to_location_id) ?? 0) + Number(t.amount ?? 0));
    if (t.from_location_id && heldByLoc.has(t.from_location_id)) heldByLoc.set(t.from_location_id, (heldByLoc.get(t.from_location_id) ?? 0) - Number(t.amount ?? 0));
  }
  for (const p of (cashPays ?? []) as any[]) {
    if (p.custodian_location_id && heldByLoc.has(p.custodian_location_id)) heldByLoc.set(p.custodian_location_id, (heldByLoc.get(p.custodian_location_id) ?? 0) + Number(p.amount ?? 0));
  }
  for (const e of (cashExps ?? []) as any[]) {
    if (e.custodian_location_id && heldByLoc.has(e.custodian_location_id)) heldByLoc.set(e.custodian_location_id, (heldByLoc.get(e.custodian_location_id) ?? 0) - Number(e.amount ?? 0));
  }
  for (const a of (cashAdvances ?? []) as any[]) {
    if (a.custodian_location_id && heldByLoc.has(a.custodian_location_id)) heldByLoc.set(a.custodian_location_id, (heldByLoc.get(a.custodian_location_id) ?? 0) - Number(a.amount ?? 0));
  }
  for (const c of (cashCheques ?? []) as any[]) {
    if (c.custodian_location_id && heldByLoc.has(c.custodian_location_id)) heldByLoc.set(c.custodian_location_id, (heldByLoc.get(c.custodian_location_id) ?? 0) + Number(c.amount ?? 0));
  }
  for (const w of (bankWd ?? []) as any[]) {
    if (w.reference_id && heldByLoc.has(w.reference_id)) heldByLoc.set(w.reference_id, (heldByLoc.get(w.reference_id) ?? 0) + Number(w.cash_delta ?? 0));
  }
  // cash_delta is already signed (negative = paid out, positive = reversal).
  for (const pr of (payrollCash ?? []) as any[]) {
    if (pr.reference_id && heldByLoc.has(pr.reference_id)) heldByLoc.set(pr.reference_id, (heldByLoc.get(pr.reference_id) ?? 0) + Number(pr.cash_delta ?? 0));
  }

  return ((staff ?? []) as any[]).map((s) => {
    const loc = locByEmployee.get(s.id);
    return {
      employeeId: s.id,
      fullName: s.full_name,
      locationId: loc?.id ?? null,
      held: loc ? heldByLoc.get(loc.id) ?? 0 : 0,
    };
  });
}

/**
 * Resolve the custodian cash_location id for an office-staff employee, creating an
 * active CUSTODIAN location on first use. Returns the location id to stamp onto the
 * payment / expense record.
 */
export async function ensureCustodianLocation(
  companyId: string,
  employeeId: string,
  fullName: string,
): Promise<string> {
  // One custodian location per office-staff member — reuse it whether active or not
  // (a unique index enforces this at the DB level).
  const { data: existing, error: selErr } = await supabase
    .from("cash_locations")
    .select("id")
    .eq("company_id", companyId)
    .eq("custodian_employee_id", employeeId)
    .eq("location_type", "CUSTODIAN")
    .limit(1)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing?.id) return existing.id as string;

  const { data: inserted, error: insErr } = await supabase
    .from("cash_locations")
    .insert({
      company_id: companyId,
      name: fullName,
      location_type: "CUSTODIAN",
      custodian_employee_id: employeeId,
      opening_balance: 0,
      is_active: true,
    })
    .select("id")
    .single();
  if (insErr) throw insErr;
  return (inserted as any).id as string;
}
