// Expenses & Advances (web Expenses.tsx). Every money move is an RPC —
// record_expense / amend_expense / delete_expense (0364/0381), record_advance /
// amend_advance / delete_advance (0382) — and receipts are uploaded AFTER the
// money settles, deleted only once the amend has committed.
import { driveDelete, driveUpload, PickedFile, q, rpc, sb, uid } from "./core";
import { fetchAllRows, isHardcodedCategory, PREPAID_THRESHOLD } from "../../lib/web/supabase";
import { loadCustodianOptions, type CustodianOption } from "../../lib/web/custodian";

export { PREPAID_THRESHOLD };

export async function loadExpensesData(companyId: string, withBalances: boolean, month: string) {
  const s = sb();
  const [categories, vendors, cheques, banks, branches, linkedEx, linkedPs, linkedAdv, templates] = await Promise.all([
    q<any[]>(s.from("expense_categories").select("*").order("name")),
    q<any[]>(s.from("vendors").select("*").order("name")),
    q<any[]>(s.from("cheques").select("*").eq("status", "pending").order("cheque_date", { ascending: false })),
    q<any[]>(s.from("bank_accounts").select("*").order("bank_name")),
    q<any[]>(s.from("branches").select("id, name, is_head_office")),
    q<any[]>(s.from("expenses").select("cheque_id, amount").not("cheque_id", "is", null)),
    q<any[]>(s.from("payslips").select("cheque_id, net_salary").not("cheque_id", "is", null)),
    q<any[]>(s.from("advances").select("cheque_id, amount").not("cheque_id", "is", null)),
    q<any[]>(s.from("fixed_expenses").select("*, category:category_id(name), client:client_id(name), vendor:vendor_id(name)").order("created_at", { ascending: false })),
  ]);
  await s.rpc("generate_fixed_expense_instances" as never, { p_month: `${month}-01` } as never);
  const instances = await q<any[]>(s.from("fixed_expense_instances").select("*, category:category_id(name), client:client_id(name), vendor:vendor_id(name)").eq("period_month", `${month}-01`).order("created_at", { ascending: true }));
  const [expenses, advances] = await Promise.all([
    fetchAllRows<any>(() => s.from("expenses").select("*, category:category_id(name), client:client_id(name), vendor:vendor_id(name), bank:bank_account_id(bank_name), expense_by_emp:expense_by(full_name)").order("expense_date", { ascending: false }).order("created_at", { ascending: false }) as any),
    fetchAllRows<any>(() => s.from("advances").select("*, employee:employee_id(full_name, employee_code, guard_code), client:client_id(name)").order("advance_date", { ascending: false }) as any),
  ]);
  const deferred = await rpc<any[]>("prepaid_schedule", { p_company_id: companyId }).catch(() => [] as any[]);
  const custodians: CustodianOption[] = await loadCustodianOptions(companyId, withBalances).catch(() => []);
  const linked = new Map<string, number>();
  for (const r of [...linkedEx, ...linkedAdv]) linked.set(r.cheque_id, (linked.get(r.cheque_id) ?? 0) + Number(r.amount));
  for (const r of linkedPs) linked.set(r.cheque_id, (linked.get(r.cheque_id) ?? 0) + Number(r.net_salary));
  return {
    categories, vendors, cheques, banks, branches, linked, templates, instances, expenses, advances, deferred: deferred ?? [], custodians,
    headOfficeId: branches.find((b) => b.is_head_office)?.id ?? null,
  };
}
export type ExpensesData = Awaited<ReturnType<typeof loadExpensesData>>;

/** chequeRemaining(): a cheque's capacity left after what is already linked to it. */
export const chequeRemaining = (d: ExpensesData, chequeId: string, excludeOwn = 0) => {
  const c = d.cheques.find((x) => x.id === chequeId);
  return c ? Number(c.amount) - (d.linked.get(chequeId) ?? 0) + excludeOwn : 0;
};

export type ExpenseForm = {
  category_id: string; amount: string; expense_date: string; payment_mode: "Cash" | "Bank" | "Cheque" | "Payable"; client_id: string; branch_id: string;
  vendor_id: string; description: string; bank_account_id: string; cheque_id: string; due_date: string; notes: string; expense_by: string;
  custodian: string; coverage_start: string; coverage_end: string; service_start: string; service_end: string;
};
export const blankExpense = (today: string): ExpenseForm => ({
  category_id: "", amount: "", expense_date: today, payment_mode: "Cash", client_id: "", branch_id: "", vendor_id: "", description: "", bank_account_id: "",
  cheque_id: "", due_date: "", notes: "", expense_by: "", custodian: "", coverage_start: "", coverage_end: "", service_start: "", service_end: "",
});
export const expenseFormFrom = (x: any, custodians: CustodianOption[]): ExpenseForm => ({
  category_id: x.category_id ?? "", amount: String(x.amount), expense_date: x.expense_date, payment_mode: x.payment_mode, client_id: x.client_id ?? "", branch_id: x.branch_id ?? "",
  vendor_id: x.vendor_id ?? "", description: x.description ?? "", bank_account_id: x.bank_account_id ?? "", cheque_id: x.cheque_id ?? "", due_date: x.due_date ?? "",
  notes: x.notes ?? "", expense_by: x.expense_by ?? "", custodian: custodians.find((c) => c.locationId === x.custodian_location_id)?.locationId ?? "",
  coverage_start: x.coverage_start?.slice(0, 7) ?? "", coverage_end: x.coverage_end?.slice(0, 7) ?? "", service_start: x.service_start?.slice(0, 10) ?? "", service_end: x.service_end?.slice(0, 10) ?? "",
});

const monthBounds = (iso: string): [string, string] => {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  return [`${iso.slice(0, 7)}-01`, `${iso.slice(0, 7)}-${String(new Date(y!, m!, 0).getDate()).padStart(2, "0")}`];
};
/** 0347: an amortising window only with both ends AND at/above the threshold. */
export const isAmortising = (f: ExpenseForm) => !!f.coverage_start && !!f.coverage_end && Number(f.amount) >= PREPAID_THRESHOLD;
/** 0356: a service period only when it says something the expense date does not. */
export const isServicePeriod = (f: ExpenseForm) => {
  if (!f.service_start || !f.service_end || f.service_end < f.service_start) return false;
  const [a, b] = monthBounds(f.expense_date);
  return !(f.service_start === a && f.service_end === b);
};

/** Shared form checks (handleAdd / handleEdit). */
export function expenseError(f: ExpenseForm, d: ExpensesData, existing: any | null): string | null {
  const amount = Number(f.amount);
  if (!f.category_id) return "Pick a category.";
  if (!amount || amount <= 0) return "Enter an amount above zero.";
  if (!f.expense_date) return "Pick the expense date.";
  if (f.payment_mode === "Bank" && !f.bank_account_id) return "Select a bank account for Bank payment.";
  if (f.payment_mode === "Cheque" && !f.cheque_id) return "Select a pending cheque for Cheque payment.";
  if (f.payment_mode === "Cheque") {
    const own = existing?.cheque_id === f.cheque_id && existing?.payment_mode === "Cheque" ? Number(existing.amount) : 0;
    const left = chequeRemaining(d, f.cheque_id, own);
    if (amount > left + 0.005) return `This expense (PKR ${amount.toLocaleString()}) exceeds the cheque's remaining capacity (PKR ${left.toLocaleString()}).`;
  }
  if (f.payment_mode === "Payable" && !f.due_date) return "Select a due date for Payable expense.";
  if (f.payment_mode === "Payable" && !f.vendor_id) return "Select a vendor for Payable expense. Add one via Manage Vendors.";
  if (f.payment_mode === "Cash" && !f.custodian) return "Select the office-staff member who paid the cash.";
  if (f.payment_mode === "Bank") {
    const bank = d.banks.find((b) => b.id === f.bank_account_id);
    const back = existing && existing.payment_mode === "Bank" && existing.bank_account_id === f.bank_account_id ? Number(existing.amount) : 0;
    if (bank && amount > Number(bank.balance) + back) return existing ? "Selected bank balance is insufficient after reversal." : "Selected bank balance is insufficient.";
  }
  return null;
}

const resolveBranch = (f: ExpenseForm, d: ExpensesData, clients: { id: string; branch_id: string }[]) =>
  f.branch_id || (f.client_id ? clients.find((c) => c.id === f.client_id)?.branch_id ?? null : null) || d.headOfficeId || null;

const upload = (file: PickedFile, category: string, company: { id: string; name: string }) => {
  if (!company.id || !company.name) throw new Error("Company not loaded — refresh and try again.");
  return driveUpload(file, { category, company_id: company.id, company_name: company.name });
};

export async function addExpense(f: ExpenseForm, d: ExpensesData, clients: { id: string; branch_id: string }[], receipts: PickedFile[], company: { id: string; name: string }) {
  const chequeBank = f.payment_mode === "Cheque" ? d.cheques.find((c) => c.id === f.cheque_id)?.bank_account_id ?? null : null;
  const id = await rpc<string>("record_expense", {
    p_category_id: f.category_id, p_amount: Number(f.amount), p_expense_date: f.expense_date, p_payment_mode: f.payment_mode, p_client_id: f.client_id || null,
    p_branch_id: resolveBranch(f, d, clients), p_vendor_id: f.payment_mode === "Payable" ? f.vendor_id || null : null, p_description: f.description.trim() || null,
    p_custodian_location_id: f.payment_mode === "Cash" ? f.custodian : null,
    p_bank_account_id: f.payment_mode === "Bank" ? f.bank_account_id : f.payment_mode === "Cheque" ? chequeBank : null,
    p_cheque_id: f.payment_mode === "Cheque" ? f.cheque_id : null, p_due_date: f.payment_mode === "Payable" ? f.due_date : null, p_notes: f.notes.trim() || null,
    p_expense_by: f.expense_by || null, p_coverage_start: isAmortising(f) ? `${f.coverage_start}-01` : null, p_coverage_end: isAmortising(f) ? `${f.coverage_end}-01` : null,
    p_service_start: isServicePeriod(f) ? f.service_start : null, p_service_end: isServicePeriod(f) ? f.service_end : null,
  });
  let first: { drive_file_id: string; drive_view_url: string; file_name?: string } | null = null;
  for (const file of receipts) {
    const up = await upload(file, "expenses", company);
    if (!first) first = up;
    await sb().from("expense_receipts").insert({ expense_id: id, company_id: company.id, drive_file_id: up.drive_file_id, drive_view_url: up.drive_view_url, file_name: up.file_name ?? file.name } as never);
  }
  if (first) await sb().from("expenses").update({ drive_file_id: first.drive_file_id, drive_view_url: first.drive_view_url, receipt_file_name: first.file_name } as never).eq("id", id);
}

/**
 * handleEdit(): upload the replacement first, file its rows alongside the old,
 * ONE amend_expense call, and only then delete what it superseded. A failure
 * anywhere undoes the replacement, never the original.
 */
export async function amendExpense(x: any, f: ExpenseForm, d: ExpensesData, clients: { id: string; branch_id: string }[], replace: PickedFile[] | null, company: { id: string; name: string }) {
  let receipt = { path: x.receipt_path ?? null, id: x.drive_file_id ?? null, url: x.drive_view_url ?? null, name: x.receipt_file_name ?? null };
  const uploaded: string[] = [];
  const inserted: string[] = [];
  let staleRows: string[] = [];
  let staleDrive: string[] = [];
  try {
    if (replace) {
      const ups: { drive_file_id: string; drive_view_url: string; file_name?: string }[] = [];
      for (const file of replace) { const up = await upload(file, "expenses", company); uploaded.push(up.drive_file_id); ups.push({ ...up, file_name: up.file_name ?? file.name }); }
      const old = await q<any[]>(sb().from("expense_receipts").select("id, drive_file_id").eq("expense_id", x.id));
      staleRows = old.map((r) => r.id);
      staleDrive = Array.from(new Set([...old.map((r) => r.drive_file_id).filter(Boolean), ...(x.drive_file_id ? [x.drive_file_id] : [])]));
      for (const up of ups) {
        const ins = await q<any>(sb().from("expense_receipts").insert({ expense_id: x.id, company_id: company.id, drive_file_id: up.drive_file_id, drive_view_url: up.drive_view_url, file_name: up.file_name } as never).select("id").single());
        if (ins?.id) inserted.push(ins.id);
      }
      receipt = { path: null, id: ups[0]?.drive_file_id ?? null, url: ups[0]?.drive_view_url ?? null, name: ups[0]?.file_name ?? null };
    }
    await rpc("amend_expense", {
      p_expense_id: x.id, p_category_id: f.category_id, p_amount: Number(f.amount), p_expense_date: f.expense_date, p_payment_mode: f.payment_mode,
      p_client_id: f.client_id || null, p_branch_id: resolveBranch(f, d, clients), p_vendor_id: f.payment_mode === "Payable" ? f.vendor_id || null : null,
      p_description: f.description.trim() || null, p_custodian_location_id: f.payment_mode === "Cash" ? f.custodian : null,
      p_bank_account_id: f.payment_mode === "Bank" ? f.bank_account_id : null, p_cheque_id: f.payment_mode === "Cheque" ? f.cheque_id : null,
      p_due_date: f.payment_mode === "Payable" ? f.due_date : null, p_notes: f.notes.trim() || null, p_expense_by: f.expense_by || null,
      p_coverage_start: isAmortising(f) ? `${f.coverage_start}-01` : null, p_coverage_end: isAmortising(f) ? `${f.coverage_end}-01` : null,
      p_service_start: isServicePeriod(f) ? f.service_start : null, p_service_end: isServicePeriod(f) ? f.service_end : null,
      p_receipt_path: receipt.path, p_drive_file_id: receipt.id, p_drive_view_url: receipt.url, p_receipt_file_name: receipt.name,
    });
  } catch (e) {
    if (inserted.length) await sb().from("expense_receipts").delete().in("id", inserted);
    for (const id of uploaded) await driveDelete(id);
    throw e;
  }
  for (const id of staleDrive) await driveDelete(id);
  if (staleRows.length) await sb().from("expense_receipts").delete().in("id", staleRows);
}

/** handleDelete(): the receipt first (Drive cannot roll back), then the money and the row together. */
export async function deleteExpense(x: any) {
  if (x.drive_file_id) await driveDelete(x.drive_file_id);
  await rpc("delete_expense", { p_expense_id: x.id });
}

/** 0346: approval fields ALONE — the trigger refuses an unapproval bundled with an edit. */
export async function setExpenseApproval(id: string, approving: boolean) {
  await q(sb().from("expenses").update((approving ? { approved_at: new Date().toISOString(), approved_by: await uid() } : { approved_at: null }) as never).eq("id", id));
}
export const loadReceipts = (expenseId: string) => q<any[]>(sb().from("expense_receipts").select("id, drive_file_id, drive_view_url, file_name").eq("expense_id", expenseId).order("created_at"));

// ---------- advances ----------
export type AdvanceForm = { employee_id: string; amount: string; advance_date: string; payment_mode: "Cash" | "Bank" | "Cheque"; client_id: string; bank_account_id: string; cheque_id: string; notes: string; custodian: string };
export function advanceError(f: AdvanceForm, d: ExpensesData, existingAmount = 0): string | null {
  if (!f.employee_id) return "Select an employee.";
  const amt = Number(f.amount);
  if (!amt || amt <= 0) return "Enter a positive amount.";
  if (!f.advance_date) return "Select a date.";
  if (f.payment_mode === "Bank" && !f.bank_account_id) return "Select a bank account.";
  if (f.payment_mode === "Cash" && !f.custodian) return "Select who paid the cash.";
  if (f.payment_mode === "Cheque" && !f.cheque_id) return "Select a pending cheque.";
  if (f.payment_mode === "Cheque") { const left = chequeRemaining(d, f.cheque_id, existingAmount); if (amt > left + 0.005) return `Advance exceeds the cheque's remaining capacity (PKR ${left.toLocaleString()}).`; }
  if (f.payment_mode === "Bank") { const bank = d.banks.find((b) => b.id === f.bank_account_id); if (bank && amt > Number(bank.balance) + existingAmount) return "Selected bank balance is insufficient."; }
  return null;
}
const advArgs = (f: AdvanceForm) => ({
  p_employee_id: f.employee_id, p_amount: Number(f.amount), p_advance_date: f.advance_date, p_payment_mode: f.payment_mode, p_client_id: f.client_id || null,
  p_bank_account_id: f.payment_mode === "Bank" ? f.bank_account_id : null, p_cheque_id: f.payment_mode === "Cheque" ? f.cheque_id : null,
  p_custodian_location_id: f.payment_mode === "Cash" ? f.custodian : null, p_notes: f.notes.trim() || null,
});
export async function addAdvance(f: AdvanceForm, file: PickedFile | null, company: { id: string; name: string }) {
  const id = await rpc<string>("record_advance", advArgs(f));
  if (file && id) {
    const up = await upload(file, "advances", company);
    await q(sb().from("advances").update({ drive_file_id: up.drive_file_id, drive_view_url: up.drive_view_url, attachment_file_name: up.file_name ?? file.name } as never).eq("id", id));
  }
}
export async function amendAdvance(id: string, f: AdvanceForm, file: PickedFile | null, company: { id: string; name: string }) {
  await rpc("amend_advance", { p_advance_id: id, ...advArgs(f) });
  if (file) {
    const up = await upload(file, "advances", company);
    await q(sb().from("advances").update({ drive_file_id: up.drive_file_id, drive_view_url: up.drive_view_url, attachment_file_name: up.file_name ?? file.name } as never).eq("id", id));
  }
}
export const deleteAdvance = (id: string) => rpc("delete_advance", { p_advance_id: id });

// ---------- fixed expenses ----------
export type FixedForm = {
  category_id: string; client_id: string; branch_id: string; vendor_id: string; description: string; amount: string; payment_mode: "Cash" | "Bank" | "Payable";
  bank_account_id: string; due_day: string; notes: string; start_month: string; end_month: string; is_active: boolean; custodian: string;
};
export async function saveFixed(id: string | null, f: FixedForm, d: ExpensesData, clients: { id: string; branch_id: string }[]) {
  const amount = Number(f.amount);
  if (!f.category_id || !amount || amount <= 0) throw new Error("Pick a category and enter an amount above zero.");
  if (f.payment_mode === "Bank" && !f.bank_account_id) throw new Error("Select a bank account for Bank payment.");
  if (f.payment_mode === "Payable" && !f.vendor_id) throw new Error("Select a vendor for a Payable. Add one via Manage Vendors.");
  if (f.end_month && f.end_month < f.start_month) throw new Error("The end month cannot be before the start month.");
  const payload = {
    category_id: f.category_id, pl_category: f.client_id ? "cost_of_services" : "operating_expense", client_id: f.client_id || null,
    branch_id: f.branch_id || (f.client_id ? clients.find((c) => c.id === f.client_id)?.branch_id ?? null : null) || d.headOfficeId || null,
    vendor_id: f.payment_mode === "Payable" ? f.vendor_id || null : null, description: f.description.trim() || null, amount, payment_mode: f.payment_mode,
    bank_account_id: f.payment_mode === "Bank" ? f.bank_account_id : null, due_day: f.payment_mode === "Payable" ? Number(f.due_day) || 1 : null,
    notes: f.notes.trim() || null, start_month: `${f.start_month}-01`, end_month: f.end_month ? `${f.end_month}-01` : null, is_active: f.is_active,
    custodian_location_id: f.payment_mode === "Cash" && f.custodian ? f.custodian : null,
  };
  if (id) await q(sb().from("fixed_expenses").update(payload as never).eq("id", id));
  else await q(sb().from("fixed_expenses").insert(payload as never));
}
export const toggleFixed = (id: string, active: boolean) => q(sb().from("fixed_expenses").update({ is_active: active } as never).eq("id", id));
export const deleteFixed = (id: string) => q(sb().from("fixed_expenses").delete().eq("id", id));
export async function saveInstance(row: any, f: { amount: string; description: string; notes: string; due_date: string }) {
  const amount = Number(f.amount);
  if (!amount || amount <= 0) throw new Error("Enter an amount above zero.");
  await q(sb().from("fixed_expense_instances").update({ amount, description: f.description.trim() || null, notes: f.notes.trim() || null, due_date: row.payment_mode === "Payable" ? f.due_date || null : null } as never).eq("id", row.id));
}
/** handleDecision(): approving walks the SAME record_expense path; the instance is stamped LAST. */
export async function decideInstance(row: any, action: "approve" | "deny", note: string, custodian: string, d: ExpensesData) {
  const me = await uid();
  if (action === "deny") {
    await q(sb().from("fixed_expense_instances").update({ status: "denied", decision_note: note.trim() || null, decided_by: me, decided_at: new Date().toISOString() } as never).eq("id", row.id));
    return;
  }
  const amount = Number(row.amount);
  if (row.payment_mode === "Cash" && !custodian) throw new Error("Select the office-staff member who paid the cash.");
  if (row.payment_mode === "Bank") {
    if (!row.bank_account_id) throw new Error("This fixed expense has no bank account set. Edit it first.");
    const bank = d.banks.find((b) => b.id === row.bank_account_id);
    if (bank && amount > Number(bank.balance)) throw new Error("Selected bank balance is insufficient.");
  }
  const expId = await rpc<string>("record_expense", {
    p_category_id: row.category_id, p_amount: amount, p_expense_date: row.period_month, p_payment_mode: row.payment_mode, p_client_id: row.client_id,
    p_branch_id: row.branch_id, p_vendor_id: row.payment_mode === "Payable" ? row.vendor_id : null, p_description: row.description,
    p_custodian_location_id: row.payment_mode === "Cash" ? custodian : null, p_bank_account_id: row.payment_mode === "Bank" ? row.bank_account_id : null,
    p_due_date: row.payment_mode === "Payable" ? row.due_date : null, p_notes: row.notes, p_pl_category: row.pl_category,
  });
  await q(sb().from("fixed_expense_instances").update({ status: "approved", expense_id: expId, decision_note: note.trim() || null, decided_by: me, decided_at: new Date().toISOString() } as never).eq("id", row.id));
}
export const reopenInstance = (id: string) => q(sb().from("fixed_expense_instances").update({ status: "pending", decision_note: null, decided_by: null, decided_at: null } as never).eq("id", id));

// ---------- categories & vendors ----------
export async function saveCategory(id: string | null, name: string) {
  const n = name.trim();
  if (!n) throw new Error("Name the category.");
  if (!id && isHardcodedCategory(n)) throw new Error(`"${n}" is a reserved system category.`);
  if (id) await q(sb().from("expense_categories").update({ name: n } as never).eq("id", id));
  else await q(sb().from("expense_categories").insert({ name: n } as never));
}
export async function deleteCategory(c: { id: string; name: string }) {
  if (isHardcodedCategory(c.name)) throw new Error(`"${c.name}" is a system category and cannot be deleted.`);
  await q(sb().from("expense_categories").delete().eq("id", c.id));
}
export async function saveVendor(id: string | null, name: string, account: string) {
  const n = name.trim();
  if (!n) throw new Error("Vendor name is required.");
  if (id) await q(sb().from("vendors").update({ name: n, account_number: account.trim() || null } as never).eq("id", id));
  else await q(sb().from("vendors").insert({ name: n, account_number: account.trim() || null } as never));
}
export const deleteVendor = (id: string) => q(sb().from("vendors").delete().eq("id", id));
