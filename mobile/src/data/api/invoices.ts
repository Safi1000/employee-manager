// Invoices (web Invoices.tsx): manual create/edit, status, delete, the three
// payment RPCs, attachment on Drive, and the PDF from the web's own templates.
import { driveDelete, driveUpload, PickedFile, q, rpc, sb } from "./core";
import { loadBranding } from "./exports";
import { generateInvoiceDocument } from "../../lib/web/invoiceTemplates";
import { validateFreeText, validateInvoiceNumber } from "../../lib/web/validation";

export type InvoiceForm = { client_id: string; contract_id: string; invoice_number: string; invoice_date: string; invoice_amount: string; notes: string };

/** validateForm(): number format + uniqueness, one invoice per contract per month, positive amount. */
export function invoiceFormError(f: InvoiceForm, invoices: { id: string; raw?: any }[], contracts: { client_id: string; status: string }[], excludeId?: string) {
  if (!f.client_id) return "Select a client.";
  const numErr = validateInvoiceNumber(f.invoice_number);
  if (numErr) return numErr;
  if (invoices.some((i) => i.id !== excludeId && String(i.raw?.invoice_number ?? "").trim().toLowerCase() === f.invoice_number.trim().toLowerCase())) return "That invoice number already exists.";
  if (!f.invoice_date) return "Select an invoice date.";
  if (f.contract_id) {
    const month = f.invoice_date.slice(0, 7);
    if (invoices.some((i) => i.id !== excludeId && i.raw?.contract_id === f.contract_id && String(i.raw?.period_start ?? i.raw?.invoice_date ?? "").slice(0, 7) === month)) return "This contract already has an invoice for that month.";
  } else if (contracts.some((c) => c.client_id === f.client_id && c.status === "active")) {
    return "Select the contract this invoice bills.";
  }
  const amt = Number(f.invoice_amount);
  if (!amt || amt <= 0) return "Enter a positive invoice amount.";
  if (validateFreeText(f.notes)) return "Special characters are not allowed in Notes.";
  return null;
}

/** routeDbError(): the two unique violations become their plain-English reasons. */
function dbError(e: { message?: string; code?: string }) {
  const msg = e?.message ?? "";
  if (/uq_invoice_contract_month/i.test(msg)) return new Error("This contract already has an invoice for that month.");
  if (e?.code === "23505" || /duplicate key|already exists|unique/i.test(msg)) return new Error("That invoice number already exists.");
  return new Error(msg || String(e));
}

async function uploadAttachment(file: PickedFile, company: { id: string; name: string }, entity: { id: string; code: string }) {
  if (!company.id || !company.name) throw new Error("Company not loaded — refresh and try again.");
  return driveUpload(file, { category: "invoices", company_id: company.id, company_name: company.name, entity_id: entity.id, entity_code: entity.code, entity_name: entity.code });
}

export async function createInvoice(f: InvoiceForm, file: PickedFile | null, company: { id: string; name: string }) {
  const { data, error } = await sb().from("invoices").insert({
    client_id: f.client_id, contract_id: f.contract_id || null, invoice_number: f.invoice_number.trim(), invoice_date: `${f.invoice_date.slice(0, 7)}-01`,
    invoice_amount: Number(f.invoice_amount), amount_received: 0, notes: f.notes.trim() || null, attachment_path: null,
  } as never).select().single();
  if (error) throw dbError(error);
  const inv = data as any;
  if (file) {
    const up = await uploadAttachment(file, company, { id: inv.id, code: inv.invoice_number });
    await q(sb().from("invoices").update({ drive_file_id: up.drive_file_id, drive_view_url: up.drive_view_url, attachment_file_name: up.file_name ?? file.name, updated_at: new Date().toISOString() } as never).eq("id", inv.id));
  }
}

/** handleEdit(): a new file replaces the old one on Drive. */
export async function updateInvoice(inv: { id: string; raw?: any }, f: InvoiceForm, file: PickedFile | null, company: { id: string; name: string }) {
  let driveFileId = inv.raw?.drive_file_id ?? null;
  let driveViewUrl = inv.raw?.drive_view_url ?? null;
  let fileName = inv.raw?.attachment_file_name ?? null;
  let legacyPath = inv.raw?.attachment_path ?? null;
  if (file) {
    if (driveFileId) await driveDelete(driveFileId);
    const up = await uploadAttachment(file, company, { id: inv.id, code: f.invoice_number.trim() });
    driveFileId = up.drive_file_id; driveViewUrl = up.drive_view_url; fileName = up.file_name ?? file.name; legacyPath = null;
  }
  const { error } = await sb().from("invoices").update({
    client_id: f.client_id, contract_id: f.contract_id || null, invoice_number: f.invoice_number.trim(), invoice_date: `${f.invoice_date.slice(0, 7)}-01`,
    invoice_amount: Number(f.invoice_amount), notes: f.notes.trim() || null, attachment_path: legacyPath, drive_file_id: driveFileId,
    drive_view_url: driveViewUrl, attachment_file_name: fileName, updated_at: new Date().toISOString(),
  } as never).eq("id", inv.id);
  if (error) throw dbError(error);
}

export async function removeInvoiceAttachment(inv: { id: string; raw?: any }) {
  if (inv.raw?.drive_file_id) await driveDelete(inv.raw.drive_file_id);
  await q(sb().from("invoices").update({ attachment_path: null, drive_file_id: null, drive_view_url: null, attachment_file_name: null, updated_at: new Date().toISOString() } as never).eq("id", inv.id));
}

export const setInvoiceStatus = (id: string, status: string) => q(sb().from("invoices").update({ status, updated_at: new Date().toISOString() } as never).eq("id", id));

export async function deleteInvoice(inv: { id: string; raw?: any }) {
  if (inv.raw?.drive_file_id) await driveDelete(inv.raw.drive_file_id);
  await q(sb().from("invoices").delete().eq("id", inv.id));
}

export type PaymentInput = { amount: string; date: string; mode: string; bank_account_id: string; custodian_location_id: string; notes: string; withholding: string };

function checkPayment(p: PaymentInput) {
  const amt = Number(p.amount);
  if (!amt || amt <= 0) throw new Error("Enter a positive payment amount.");
  if (!p.date) throw new Error("Select a payment date.");
  if (p.mode === "Bank" && !p.bank_account_id) throw new Error("Select a bank account for Bank payments.");
  if (p.mode === "Cash" && !p.custodian_location_id) throw new Error("Select the custodian who received the cash.");
  return amt;
}

/** 0281: withholding prefilled from the client's agreed rate on the outstanding, still editable. */
export const suggestedWithholding = (outstanding: number, clientRate: number) => (clientRate > 0 ? String(Math.round(outstanding * clientRate) / 100) : "0");

/** handleRecordPayment(): ONE transaction — allocation, receivable, cash/bank move, ledger. */
export async function recordPayment(invoiceId: string, p: PaymentInput) {
  const amt = checkPayment(p);
  await rpc("record_invoice_payment", {
    p_invoice_id: invoiceId, p_amount: amt, p_payment_date: p.date, p_payment_mode: p.mode,
    p_bank_account_id: p.mode === "Bank" ? p.bank_account_id : null, p_notes: p.notes.trim() || null,
    p_withholding: Number(p.withholding || 0), p_custodian_location_id: p.mode === "Cash" ? p.custodian_location_id : null,
  });
}

/** 0383: amend moves amount + withholding both ways in one call; withholding itself is not re-apportioned. */
export async function amendPayment(paymentId: string, p: PaymentInput) {
  const amt = checkPayment({ ...p, withholding: "0" });
  await rpc("amend_invoice_payment", {
    p_payment_id: paymentId, p_amount: amt, p_payment_date: p.date, p_payment_mode: p.mode,
    p_bank_account_id: p.mode === "Bank" ? p.bank_account_id : null, p_custodian_location_id: p.mode === "Cash" ? p.custodian_location_id : null,
    p_notes: p.notes.trim() || null,
  });
}
export const deletePayment = (paymentId: string) => rpc("delete_invoice_payment", { p_payment_id: paymentId });

export const loadPayments = (invoiceId: string) =>
  q<any[]>(sb().from("invoice_payments").select("*").eq("invoice_id", invoiceId).order("payment_date", { ascending: false }));

/** downloadInvoicePdf(): the company's template with the invoice's own lines and taxes. */
export async function downloadInvoicePdf(inv: { id: string; raw?: any }, clientRaw: any, contractRaw: any, companyId: string) {
  const { company } = await loadBranding(companyId);
  const [lines, taxes, cls] = await Promise.all([
    q<any[]>(sb().from("invoice_lines").select("*").eq("invoice_id", inv.id).order("sort_order")),
    q<any[]>(sb().from("invoice_taxes").select("*").eq("invoice_id", inv.id).order("sort_order")),
    inv.raw?.contract_id ? q<any[]>(sb().from("contract_lines").select("*").eq("contract_id", inv.raw.contract_id)) : Promise.resolve([]),
  ]);
  const full = await q<any>(sb().from("invoices").select("*").eq("id", inv.id).single());
  generateInvoiceDocument({ invoice: full, client: clientRaw ?? null, company, contract: contractRaw ?? null, contractLines: cls, invoiceLines: lines, taxes } as never);
}
