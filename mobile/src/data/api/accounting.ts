// Banks & Ledgers (web Accounting.tsx + CashCustody.tsx). Every money move is
// an RPC, as on the web (0380/0389): nothing here moves a balance itself.
import { driveUpload, PickedFile, q, rpc, sb } from "./core";
import { fetchAllRows, invoiceOutstanding } from "../../lib/web/supabase";
import { loadCustodianOptions, type CustodianOption } from "../../lib/web/custodian";
import { validateBankAccount, validateIban } from "../../lib/web/validation";

export type AccountingData = Awaited<ReturnType<typeof loadAccounting>>;

/** loadAll(): the same reads, then the receivables fold (A1 — gross, cleared by cash + withholding together). */
export async function loadAccounting(companyId: string, withBalances: boolean) {
  const s = sb();
  const [banks, cash, payables, clients, partners, cheques, deposits, linkedPs, linkedEx, linkedAdv, paid, vendorPayments, locations] = await Promise.all([
    q<any[]>(s.from("bank_accounts").select("*").order("created_at", { ascending: false })),
    s.rpc("cash_in_hand" as never, { p_company_id: companyId } as never).maybeSingle(),
    q<any[]>(s.from("expenses").select("*, vendor:vendor_id(id,name), category:category_id(id,name), client:client_id(id,name,client_code)").eq("payment_mode", "Payable").order("due_date", { ascending: true, nullsFirst: false })),
    q<any[]>(s.from("clients").select("*").order("name")),
    q<any[]>(s.from("partners").select("*").order("name")),
    q<any[]>(s.from("cheques").select("*").order("cheque_date", { ascending: false })),
    q<any[]>(s.from("cash_deposits").select("id, bank_account_id, amount, deposit_date, slip_number, notes, deposited_by, cash_location_id, drive_view_url").order("slip_number", { ascending: false })),
    q<any[]>(s.from("payslips").select("cheque_id, net_salary").not("cheque_id", "is", null)),
    q<any[]>(s.from("expenses").select("cheque_id, amount").not("cheque_id", "is", null)),
    q<any[]>(s.from("advances").select("cheque_id, amount").not("cheque_id", "is", null)),
    q<any[]>(s.from("payable_outstanding").select("expense_id, paid_amount").gt("paid_amount", 0)),
    q<any[]>(s.from("vendor_payments").select("*").order("paid_on", { ascending: false }).order("created_at", { ascending: false })),
    q<any[]>(s.from("cash_locations").select("*").eq("company_id", companyId).order("name")),
  ]);
  const [transactions, invoices, payments] = await Promise.all([
    fetchAllRows<any>(() => s.from("bank_transactions").select("*").order("created_at", { ascending: false }) as any),
    fetchAllRows<any>(() => s.from("invoices").select("*").order("invoice_date", { ascending: false }) as any),
    fetchAllRows<any>(() => s.from("invoice_payments").select("id, client_id, invoice_id, amount, withholding_amount, payment_date, payment_mode, bank_account_id, custodian_location_id, cheque_id, notes").order("payment_date", { ascending: false }) as any),
  ]);
  const custodians: CustodianOption[] = await loadCustodianOptions(companyId, withBalances).catch(() => []);

  const linkedSums = new Map<string, number>();
  for (const r of linkedPs) linkedSums.set(r.cheque_id, (linkedSums.get(r.cheque_id) ?? 0) + Number(r.net_salary));
  for (const r of [...linkedEx, ...linkedAdv]) linkedSums.set(r.cheque_id, (linkedSums.get(r.cheque_id) ?? 0) + Number(r.amount));

  const standalone = new Map<string, number>();
  for (const p of payments) {
    if (p.invoice_id || !p.client_id) continue;
    standalone.set(p.client_id, (standalone.get(p.client_id) ?? 0) + Number(p.amount) + Number(p.withholding_amount ?? 0));
  }
  const byClient = new Map<string, any[]>();
  for (const inv of invoices) byClient.set(inv.client_id, [...(byClient.get(inv.client_id) ?? []), inv]);
  const invClient = new Map(invoices.map((i) => [i.id, i.client_id]));
  const wht = new Map<string, number>();
  for (const p of payments) {
    const cid = p.client_id ?? (p.invoice_id ? invClient.get(p.invoice_id) ?? null : null);
    if (cid) wht.set(cid, (wht.get(cid) ?? 0) + Number(p.withholding_amount ?? 0));
  }
  const receivables = clients.map((c) => {
    const invs = byClient.get(c.id) ?? [];
    const total_invoiced = invs.reduce((a, i) => a + Number(i.invoice_amount), 0);
    const total_received = invs.reduce((a, i) => a + Number(i.amount_received), 0) + (standalone.get(c.id) ?? 0);
    return { ...c, total_invoiced, total_withholding: wht.get(c.id) ?? 0, total_received, outstanding: Number(c.opening_balance ?? 0) + total_invoiced - total_received, invoices: invs };
  });

  return {
    banks, cashInHand: Number((cash.data as any)?.cash_balance ?? 0), cashOpening: Number((cash.data as any)?.opening_balance ?? 0),
    payables, paidByExpense: new Map(paid.map((r) => [r.expense_id, Number(r.paid_amount)])), vendorPayments, clients, partners, cheques,
    deposits, linkedSums, transactions, invoices, payments, receivables, custodians, locations,
  };
}

// ---------- bank accounts ----------
export type BankForm = {
  bank_name: string; account_number: string; account_type: string; opening_balance: string; owner_type: "company" | "partner" | "client";
  owner_partner_id: string; owner_client_id: string; iban: string; branch_code: string; branch_name: string; swift_code: string; currency_code: string;
};
export const blankBank = (): BankForm => ({ bank_name: "", account_number: "", account_type: "Current", opening_balance: "", owner_type: "company", owner_partner_id: "", owner_client_id: "", iban: "", branch_code: "", branch_name: "", swift_code: "", currency_code: "PKR" });

function checkBank(f: BankForm) {
  if (!f.bank_name.trim() || !f.account_number.trim()) throw new Error("Bank name and account number are required.");
  const e = validateBankAccount(f.account_number) ?? validateIban(f.iban);
  if (e) throw new Error(e);
  if (f.owner_type === "partner" && !f.owner_partner_id) throw new Error("Select which partner owns this account.");
  if (f.owner_type === "client" && !f.owner_client_id) throw new Error("Select which client owns this account.");
}
const bankFields = (f: BankForm) => ({
  bank_name: f.bank_name.trim(), account_number: f.account_number.trim(), account_type: f.account_type, owner_type: f.owner_type,
  owner_partner_id: f.owner_type === "partner" ? f.owner_partner_id : null, owner_client_id: f.owner_type === "client" ? f.owner_client_id : null,
  iban: f.iban.trim() || null, branch_code: f.branch_code.trim() || null, branch_name: f.branch_name.trim() || null, swift_code: f.swift_code.trim() || null,
  currency_code: f.currency_code || "PKR",
});

/** handleAddBank(): the opening is seeded AND logged as an `opening` transaction. */
export async function addBank(f: BankForm) {
  checkBank(f);
  const opening = f.opening_balance ? Number(f.opening_balance) : 0;
  const row = await q<any>(sb().from("bank_accounts").insert({ ...bankFields(f), opening_balance: opening, balance: opening } as never).select().single());
  if (opening !== 0) {
    await q(sb().from("bank_transactions").insert({ bank_account_id: row.id, kind: "opening", amount: opening, cash_delta: 0, account_delta: opening, description: `Opening balance for ${f.bank_name.trim()}` } as never));
  }
}
export async function editBank(id: string, f: BankForm) {
  const e = validateBankAccount(f.account_number) ?? validateIban(f.iban);
  if (e) throw new Error(e);
  await q(sb().from("bank_accounts").update({ ...bankFields(f), updated_at: new Date().toISOString() } as never).eq("id", id));
}
export const setBankActive = (id: string, active: boolean) => q(sb().from("bank_accounts").update({ active, updated_at: new Date().toISOString() } as never).eq("id", id));

export async function bankTransfer(from: string, to: string, amount: number, date: string, notes: string) {
  if (!from || !to || from === to) throw new Error("Pick two different accounts.");
  if (!amount || amount <= 0) throw new Error("Enter a positive amount.");
  if (!date) throw new Error("Select a transfer date.");
  await rpc("record_bank_transfer", { p_from_bank_account_id: from, p_to_bank_account_id: to, p_amount: amount, p_date: date, p_notes: notes.trim() || null });
}

/** handleWithdraw(): bank −, custodian held +, one ledger row. */
export async function withdrawToCustodian(bank: { id: string; raw?: any; name: string }, custodian: CustodianOption | undefined, amount: number, date: string, notes: string) {
  if (!amount || amount <= 0) throw new Error("Enter a positive withdrawal amount.");
  if (amount > Number(bank.raw?.balance ?? 0)) throw new Error("Withdrawal exceeds available account balance.");
  if (!custodian?.locationId) throw new Error("Select the office-staff member who receives this cash.");
  await rpc("record_bank_to_custodian", { p_bank_account_id: bank.id, p_custodian_location_id: custodian.locationId, p_amount: amount, p_date: date, p_notes: notes.trim() || `Withdraw from ${bank.name} to ${custodian.fullName}` });
}

const depositMessage = (raw: string, held: number) =>
  raw.includes("insufficient_cash") ? `Deposit exceeds available Cash in Hand.` : raw.includes("no_treasury") ? "No Cash in Hand balance is set up yet. Set an opening cash balance first."
    : raw.includes("amount_must_be_positive") ? "Enter a positive deposit amount." : raw.includes("bank_not_found") ? "That bank account no longer exists." : raw;

/** handleDeposit(): a pure location move; the slip file is optional. Returns the slip number. */
export async function cashDeposit(bankId: string, custodian: CustodianOption | undefined, amount: number, date: string, notes: string, slip: PickedFile | null, company: { id: string; name: string }) {
  if (!bankId) throw new Error("Select a bank account.");
  if (!amount || amount <= 0) throw new Error("Enter a positive deposit amount.");
  if (!date) throw new Error("Select a deposit date.");
  if (!custodian?.locationId) throw new Error("Select who is depositing this cash (custodian).");
  if (amount > custodian.held) throw new Error(`Deposit exceeds ${custodian.fullName}'s held cash (PKR ${Math.round(custodian.held).toLocaleString()}).`);
  const { data, error } = await sb().rpc("record_cash_deposit" as never, { p_bank_account_id: bankId, p_amount: amount, p_date: date, p_notes: notes || null, p_cash_location_id: custodian.locationId } as never);
  if (error) throw new Error(depositMessage(error.message, custodian.held));
  const dep = (Array.isArray(data) ? data[0] : data) as { id: string; slip_number: number };
  if (slip && dep?.id) {
    const up = await driveUpload(slip, { category: "deposits", company_id: company.id, company_name: company.name });
    await sb().from("cash_deposits").update({ drive_file_id: up.drive_file_id, drive_view_url: up.drive_view_url } as never).eq("id", dep.id);
  }
  return dep;
}

// ---------- payables ----------
export async function payVendor(args: { vendorId: string; amount: number; owed: number; via: "Cash" | "Bank"; bankId: string; custodian: CustodianOption | undefined; expenseId: string | null }) {
  const amount = Math.round((args.amount || 0) * 100) / 100;
  if (amount <= 0) throw new Error("Enter the amount paid.");
  if (amount > args.owed + 0.005) throw new Error(`That is more than is owed (PKR ${args.owed.toLocaleString()}).`);
  if (args.via === "Cash" && !args.custodian?.locationId) throw new Error("Select the office-staff member who paid the cash.");
  if (args.via === "Bank" && !args.bankId) throw new Error("Select a bank account.");
  await rpc("pay_vendor_payables", {
    p_vendor_id: args.vendorId, p_amount: amount, p_paid_via: args.via, p_paid_bank_account_id: args.via === "Bank" ? args.bankId : null,
    p_custodian_location_id: args.via === "Cash" ? args.custodian!.locationId : null, p_expense_id: args.expenseId,
  });
}
export const revertVendorPayment = (id: string) => rpc("revert_vendor_payment", { p_vendor_payment_id: id });
export const revertPayable = (expenseId: string) => rpc("revert_payable_expense", { p_expense_id: expenseId });

// ---------- receivables ----------
/** 0423: the receipt AND the invoice it settles move together. */
export async function recordWithholding(paymentId: string, amount: number) {
  if (!paymentId) throw new Error("Choose the receipt the client deducted this tax from.");
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Enter the withholding amount, or 0 to clear it.");
  await rpc("record_payment_withholding", { p_payment_id: paymentId, p_withholding: amount });
}
export async function setClientOpening(clientId: string, value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Enter a non-negative opening balance.");
  await q(sb().from("clients").update({ opening_balance: value } as never).eq("id", clientId));
}

/** handleRecordPayment(): cheque → record_cheque (clears later); otherwise record_invoice_payment, invoice-targeted or on account. */
export async function recordClientReceipt(client: { id: string; name: string; invoices: any[] }, f: {
  via: "Bank" | "Cash" | "Cheque"; amount: number; date: string; bankId: string; custodian: CustodianOption | undefined; notes: string;
  standalone: boolean; invoiceId: string; chequeNumber: string; chequeDate: string;
}) {
  if (!f.amount || f.amount <= 0) throw new Error("Enter a positive payment amount.");
  if ((f.via === "Bank" || f.via === "Cheque") && !f.bankId) throw new Error("Select the bank account.");
  if (f.via === "Cash" && !f.custodian?.locationId) throw new Error("Select the office-staff member who received the cash.");
  if (f.via === "Cheque") {
    if (!f.chequeNumber.trim()) throw new Error("Enter the cheque number.");
    if (!f.chequeDate) throw new Error("Enter the cheque date.");
    const invoiceId = !f.standalone && f.invoiceId ? f.invoiceId : null;
    if (!f.standalone && !invoiceId) throw new Error("Select an invoice to apply this cheque to.");
    await rpc("record_cheque", {
      p_bank_account_id: f.bankId, p_cheque_number: f.chequeNumber.trim(), p_amount: f.amount, p_cheque_date: f.chequeDate, p_cheque_type: "payment",
      p_direction: "incoming", p_recipient: client.name, p_notes: f.notes.trim() || null, p_invoice_id: invoiceId, p_client_id: client.id,
    });
    return;
  }
  const custodianLoc = f.via === "Cash" ? f.custodian!.locationId : null;
  if (f.standalone) {
    await rpc("record_invoice_payment", {
      p_invoice_id: null, p_client_id: client.id, p_amount: f.amount, p_payment_date: f.date, p_payment_mode: f.via,
      p_bank_account_id: f.via === "Bank" ? f.bankId : null, p_notes: f.notes.trim() || null, p_withholding: 0, p_custodian_location_id: custodianLoc,
    });
    return;
  }
  const inv = client.invoices.find((i) => i.id === f.invoiceId);
  if (!inv) throw new Error("Select an invoice to apply this payment to.");
  const open = invoiceOutstanding(inv);
  if (f.amount > open) throw new Error(`Payment exceeds the outstanding amount on this invoice (PKR ${open.toLocaleString()}).`);
  await rpc("record_invoice_payment", {
    p_invoice_id: inv.id, p_amount: f.amount, p_payment_date: f.date, p_payment_mode: f.via, p_bank_account_id: f.via === "Bank" ? f.bankId : null,
    p_notes: f.notes.trim() || null, p_withholding: 0, p_custodian_location_id: custodianLoc,
  });
}

// ---------- cheques ----------
export async function newCheque(f: {
  bankId: string; number: string; amount: number; date: string; direction: "outgoing" | "incoming"; type: "payment" | "cash"; recipient: string; notes: string;
  custodian: CustodianOption | undefined; bankBalance: number; file: PickedFile | null;
}, company: { id: string; name: string }) {
  if (!f.bankId || !f.number || !f.amount || f.amount <= 0 || !f.date) throw new Error("Bank, cheque number, amount and date are required.");
  const isCash = f.direction === "outgoing" && f.type === "cash";
  if (isCash && !f.custodian?.locationId) throw new Error("Select the office-staff member who receives this cash cheque.");
  if (f.direction !== "incoming" && f.amount > f.bankBalance) throw new Error(`Cheque amount (PKR ${f.amount.toLocaleString()}) exceeds the bank's available balance (PKR ${f.bankBalance.toLocaleString()}).`);
  const id = await rpc<string>("record_cheque", {
    p_bank_account_id: f.bankId, p_cheque_number: f.number.trim(), p_amount: f.amount, p_cheque_date: f.date,
    p_cheque_type: f.direction === "incoming" ? "cash" : f.type, p_direction: f.direction, p_recipient: isCash ? f.custodian!.fullName : f.recipient.trim() || null,
    p_notes: f.notes.trim() || null, p_custodian_location_id: isCash ? f.custodian!.locationId : null,
  });
  if (f.file) {
    const up = await driveUpload(f.file, { category: "cheques", company_id: company.id, company_name: company.name });
    await q(sb().from("cheques").update({ drive_file_id: up.drive_file_id, drive_view_url: up.drive_view_url, attachment_file_name: up.file_name ?? f.file.name } as never).eq("id", id));
  }
}
/** A payment cheque clears only when its linked items sum to its amount. */
export const canClearCheque = (c: any, linkedSum: number) => ((c.direction ?? "outgoing") === "incoming" ? true : c.cheque_type === "payment" ? Math.abs(linkedSum - Number(c.amount)) < 0.005 : true);
export const clearCheque = (id: string) => rpc("set_cheque_status", { p_cheque_id: id, p_status: "cleared" });
export const bounceCheque = (id: string, reason: string) => rpc("set_cheque_status", { p_cheque_id: id, p_status: "bounced", p_bounce_reason: reason.trim() || null });

// ---------- cash custody (CashCustody.tsx) ----------
export type LocationForm = { id?: string; name: string; location_type: string; employee_id: string; partner_id: string; branch_id: string; opening_balance: string; is_active: boolean };
export async function saveLocation(companyId: string, f: LocationForm, staffName: string | null, existing: any[]) {
  const name = staffName || f.name.trim();
  if (!name) throw new Error("Name the location.");
  const payload = {
    company_id: companyId, name, location_type: f.location_type, custodian_partner_id: f.partner_id || null, custodian_employee_id: f.employee_id || null,
    branch_id: f.branch_id || null, opening_balance: parseFloat(f.opening_balance) || 0, is_active: f.is_active,
  };
  if (f.id) { await q(sb().from("cash_locations").update(payload as never).eq("id", f.id)); return; }
  const dup = (f.employee_id || f.partner_id) ? existing.find((l) => l.location_type === "CUSTODIAN" && (f.employee_id ? l.custodian_employee_id === f.employee_id : l.custodian_partner_id === f.partner_id)) : null;
  if (dup) throw new Error(`${name} already has a custody location. Edit it from the list instead.`);
  await q(sb().from("cash_locations").insert(payload as never));
}
export async function deleteLocation(loc: any, hasHistory: boolean) {
  if (hasHistory) throw new Error(`"${loc.name}" has cash movements recorded and can't be deleted. Deactivate it instead.`);
  await q(sb().from("cash_locations").delete().eq("id", loc.id));
}
export async function custodyTransfer(f: { fromType: "staff" | "bank"; fromLocation: string; fromBank: string; to: string; amount: number; date: string; notes: string }) {
  if (!f.to || !f.amount) throw new Error("Pick where the cash goes and how much.");
  if (f.fromType === "bank") {
    if (!f.fromBank) throw new Error("Select the bank to withdraw from.");
    await rpc("record_bank_to_custodian", { p_bank_account_id: f.fromBank, p_custodian_location_id: f.to, p_amount: f.amount, p_date: f.date, p_notes: f.notes || null });
    return;
  }
  if (!f.fromLocation) throw new Error("Pick where the cash comes from.");
  if (f.fromLocation === f.to) throw new Error("From and To locations must be different.");
  await rpc("record_custody_transfer", { p_from_location_id: f.fromLocation, p_to_location_id: f.to, p_amount: f.amount, p_date: f.date, p_notes: f.notes || null });
}

// ---------- the client statement ledger (web statementLedger) ----------
export function statementLedger(client: any, data: AccountingData, month: string | "all") {
  const monthly = month !== "all";
  const start = monthly ? `${month}-01` : null;
  const end = monthly ? (() => { const [y, m] = month.split("-").map(Number); return `${month}-${String(new Date(y!, m!, 0).getDate()).padStart(2, "0")}`; })() : null;
  const inScope = (d: string) => !monthly || (d >= start! && d <= end!);
  const invMonth = (i: any) => String(i.service_month ?? i.period_start ?? i.invoice_date ?? "").slice(0, 7);
  const bankLabel = (id: string | null | undefined) => { const b = id ? data.banks.find((x) => x.id === id) : null; if (!b) return null; const tail = String(b.account_number ?? "").slice(-4); return tail ? `${b.bank_name} ····${tail}` : b.bank_name; };
  const describe = (p: any) => {
    if (p.cheque_id) { const c = data.cheques.find((x) => x.id === p.cheque_id); const on = bankLabel(c?.bank_account_id ?? p.bank_account_id); return c ? `Cheque #${c.cheque_number}${on ? ` · ${on}` : ""}` : `Cheque${on ? ` · ${on}` : ""}`; }
    if (p.custodian_location_id) { const h = data.custodians.find((c) => c.locationId === p.custodian_location_id); return h ? `Cash · ${h.fullName}` : "Cash"; }
    return bankLabel(p.bank_account_id) ?? (p.payment_mode ?? "—");
  };
  type Entry = { key: string; date: string; rank: number; label: string; reference: string; account: string; debit: number; credit: number; withholding: number; balance: number };
  const entries: Entry[] = [];
  const clientOfInvoice = new Map(data.invoices.map((i) => [i.id, i.client_id]));
  const number = new Map(data.invoices.map((i) => [i.id, i.invoice_number]));
  for (const inv of data.invoices) {
    if (inv.client_id !== client.id || (monthly && invMonth(inv) !== month)) continue;
    entries.push({ key: `inv:${inv.id}`, date: String(inv.invoice_date ?? "").slice(0, 10), rank: 0, label: "Invoice", reference: inv.invoice_number ?? "—", account: invMonth(inv), debit: Number(inv.invoice_amount ?? 0), credit: 0, withholding: 0, balance: 0 });
  }
  const tracked = new Map<string, number>();
  let seq = 0;
  for (const p of data.payments) {
    const rc = p.client_id ?? (p.invoice_id ? clientOfInvoice.get(p.invoice_id) ?? null : null);
    const settled = Number(p.amount ?? 0) + Number(p.withholding_amount ?? 0);
    if (p.invoice_id) tracked.set(p.invoice_id, (tracked.get(p.invoice_id) ?? 0) + settled);
    if (rc !== client.id) continue;
    const date = String(p.payment_date ?? start ?? "").slice(0, 10);
    if (!inScope(date)) continue;
    const mode = p.payment_mode ? `${p.payment_mode} receipt` : "Receipt";
    entries.push({ key: `pay:${seq++}`, date, rank: 1, label: p.invoice_id ? mode : `${mode} (on account)`, reference: p.invoice_id ? number.get(p.invoice_id) ?? "—" : (p.notes ?? "").trim() || "No invoice", account: describe(p), debit: 0, credit: settled, withholding: Number(p.withholding_amount ?? 0), balance: 0 });
  }
  for (const inv of data.invoices) {
    if (inv.client_id !== client.id) continue;
    const residual = Number(inv.amount_received ?? 0) - (tracked.get(inv.id) ?? 0);
    if (residual <= 0.001) continue;
    const date = String(inv.invoice_date ?? "").slice(0, 10);
    if (!inScope(date)) continue;
    entries.push({ key: `res:${inv.id}`, date, rank: 2, label: "Receipt (untracked)", reference: inv.invoice_number ?? "—", account: "Not recorded", debit: 0, credit: residual, withholding: 0, balance: 0 });
  }
  entries.sort((a, b) => (a.date === b.date ? a.rank - b.rank : a.date.localeCompare(b.date)));
  const opening = Number(client.opening_balance ?? 0);
  let running = opening, debits = 0, credits = 0, withheld = 0;
  for (const e of entries) { running += e.debit - e.credit; e.balance = running; debits += e.debit; credits += e.credit; withheld += e.withholding; }
  return { opening, entries, debits, credits, withheld, closing: running, rowOutstanding: client.outstanding, scopeLabel: monthly ? month : "All months" };
}
