import ThemedSelect from "../../components/ThemedSelect";
import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  AlertCircle,
  X,
  Loader2,
  Trash2,
  Pencil,
  FileText,
  Download,
  Upload,
  Building2,
  Wallet,
  Settings2,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import {
  supabase,
  fetchAllRows,
  INVOICE_ATTACHMENTS_BUCKET,
  CONTRACT_TYPE_LABEL,
  type Client,
  type Contract,
  type ContractLine,
  type Invoice,
  type InvoiceLine,
  type InvoiceTax,
  type InvoiceStatus,
  type BankAccount,
  type BankTransactionKind,
  type InvoicePayment,
  type Branch,
} from "../../lib/supabase";
import { useRegion, withRegion } from "../../lib/region";
import { useAuth } from "../../lib/auth";
import { generateInvoiceDocument } from "../../lib/invoiceTemplates";
import InvoiceGenerate from "../../components/InvoiceGenerate";
import InvoiceStructureModal from "../../components/InvoiceStructureModal";
import { validateInvoiceNumber, validateAmount, validateFreeText } from "../../lib/validation";
import { formatDate } from "../../lib/date";

type InvoiceRow = Invoice & { client?: { name: string; client_code: string } | null };

type PaymentRow = InvoicePayment & {
  bank?: { bank_name: string } | null;
};

type InvoiceForm = {
  client_id: string;
  contract_id: string;
  invoice_number: string;
  invoice_date: string;
  invoice_amount: string;
  withholding_tax: string;
  notes: string;
  attachment_file: File | null;
  // Existing attachment metadata for edit modal — either a legacy Storage path
  // or the Drive triple. Falls back to whichever the row has.
  existing_attachment_path: string | null;
  existing_drive_file_id: string | null;
  existing_drive_view_url: string | null;
  existing_attachment_file_name: string | null;
};

type PaymentForm = {
  amount: string;
  payment_date: string;
  payment_mode: "Cash" | "Bank";
  bank_account_id: string;
  notes: string;
};

const todayStr = () => new Date().toISOString().slice(0, 10);

const currentMonthStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const monthLabel = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const [yStr, mStr] = iso.slice(0, 7).split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!y || !m) return iso;
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
};

const emptyForm = (): InvoiceForm => ({
  client_id: "",
  contract_id: "",
  invoice_number: "",
  invoice_date: currentMonthStr(),
  invoice_amount: "",
  withholding_tax: "",
  notes: "",
  attachment_file: null,
  existing_attachment_path: null,
  existing_drive_file_id: null,
  existing_drive_view_url: null,
  existing_attachment_file_name: null,
});

const emptyPaymentForm = (): PaymentForm => ({
  amount: "",
  payment_date: todayStr(),
  payment_mode: "Cash",
  bank_account_id: "",
  notes: "",
});

export default function Invoices() {
  const { profile, company } = useAuth();
  const { regionId } = useRegion();
  const [clients, setClients] = useState<Client[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<"ledger" | "generate">("ledger");
  const [clientFilter, setClientFilter] = useState<string>("");
  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [monthFilter, setMonthFilter] = useState<string>("all");

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [structureOpen, setStructureOpen] = useState(false);
  const [form, setForm] = useState<InvoiceForm>(emptyForm());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  // Modal-scoped submit error, so create/edit failures show inside the dialog
  // instead of the page banner hidden behind it.
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<InvoiceForm>(emptyForm());
  const [editInvoice, setEditInvoice] = useState<InvoiceRow | null>(null);
  const [editPayments, setEditPayments] = useState<PaymentRow[]>([]);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [paymentInvoice, setPaymentInvoice] = useState<InvoiceRow | null>(null);
  const [paymentForm, setPaymentForm] = useState<PaymentForm>(emptyPaymentForm());
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);

  const [isEditPaymentOpen, setIsEditPaymentOpen] = useState(false);
  const [editingPayment, setEditingPayment] = useState<PaymentRow | null>(null);
  const [editPaymentForm, setEditPaymentForm] = useState<PaymentForm>(emptyPaymentForm());
  const [editPaymentSubmitting, setEditPaymentSubmitting] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [cliRes, conRes, bankRes, brRes] = await Promise.all([
      supabase.from("clients").select("*").order("name"),
      supabase.from("contracts").select("*"),
      supabase.from("bank_accounts").select("*").order("bank_name"),
      supabase.from("branches").select("*").order("is_head_office", { ascending: false }).order("name"),
    ]);
    if (cliRes.error) setError(cliRes.error.message);
    if (bankRes.error) setError(bankRes.error.message);
    if (brRes.error) setError(brRes.error.message);
    setClients((cliRes.data ?? []) as Client[]);
    setContracts((conRes.data ?? []) as Contract[]);
    setBanks((bankRes.data ?? []) as BankAccount[]);
    setBranches((brRes.data ?? []) as Branch[]);
    try {
      const invRows = await fetchAllRows<InvoiceRow>(() =>
        withRegion(
          supabase
            .from("invoices")
            .select("*, client:client_id(name, client_code)")
            .order("invoice_date", { ascending: false }),
          regionId,
        ) as unknown as {
          range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
        },
      );
      setInvoices(invRows);
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId]);

  const loadPaymentsFor = async (invoiceId: string) => {
    const { data, error: pErr } = await supabase
      .from("invoice_payments")
      .select("*, bank:bank_account_id(bank_name)")
      .eq("invoice_id", invoiceId)
      .order("payment_date", { ascending: false });
    if (pErr) {
      setError(pErr.message);
      return;
    }
    setEditPayments((data ?? []) as PaymentRow[]);
  };

  // Item 7: distinct YYYY-MM present in invoices, newest first, for the month filter.
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of invoices) if (i.invoice_date) set.add(i.invoice_date.slice(0, 7));
    return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
  }, [invoices]);

  const filteredInvoices = useMemo(() => {
    const clientBranch = new Map<string, string | null>();
    for (const c of clients) clientBranch.set(c.id, c.branch_id);
    return invoices.filter((i) => {
      if (clientFilter && i.client_id !== clientFilter) return false;
      if (branchFilter !== "all" && clientBranch.get(i.client_id) !== branchFilter) return false;
      if (monthFilter !== "all" && (i.invoice_date ?? "").slice(0, 7) !== monthFilter) return false;
      return true;
    });
  }, [invoices, clientFilter, branchFilter, monthFilter, clients]);

  const summary = useMemo(() => {
    let invoiced = 0;
    let received = 0;
    for (const i of filteredInvoices) {
      invoiced += Number(i.invoice_amount);
      received += Number(i.amount_received);
    }
    return { invoiced, received, outstanding: invoiced - received };
  }, [filteredInvoices]);

  // Upload to Google Drive under <Company>/Invoices/<year>/.
  // Returns the triple we persist on the invoices row.
  const uploadAttachmentToDrive = async (
    file: File,
  ): Promise<{ drive_file_id: string; drive_view_url: string; file_name: string }> => {
    const effectiveCompanyId =
      profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
    if (!effectiveCompanyId || !company?.name) {
      throw new Error("Company not loaded — refresh and try again.");
    }
    const form = new FormData();
    form.append("file", file);
    form.append("category", "invoices");
    form.append("company_id", effectiveCompanyId);
    form.append("company_name", company.name);
    const { data, error: fnErr } = await supabase.functions.invoke("gdrive-upload", { body: form });
    if (fnErr) {
      let detail = fnErr.message;
      try {
        const ctx = (fnErr as { context?: Response }).context;
        if (ctx) detail = (await ctx.clone().json())?.error ?? detail;
      } catch { /* ignore */ }
      throw new Error(`Drive upload failed: ${detail}`);
    }
    if (!data?.drive_file_id) throw new Error(data?.error ?? "Upload failed");
    return {
      drive_file_id: data.drive_file_id as string,
      drive_view_url: data.drive_view_url as string,
      file_name: (data.file_name as string) ?? file.name,
    };
  };

  // Removes the attachment whether it lives on Drive or legacy Storage.
  const removeAttachment = async (row: {
    drive_file_id?: string | null;
    attachment_path?: string | null;
  }) => {
    if (row.drive_file_id) {
      await supabase.functions
        .invoke("gdrive-delete", { body: { drive_file_id: row.drive_file_id } })
        .catch(() => { /* idempotent */ });
      return;
    }
    if (row.attachment_path) {
      await supabase.storage.from(INVOICE_ATTACHMENTS_BUCKET).remove([row.attachment_path]);
    }
  };

  // Opens whichever URL the invoice has — Drive view link or legacy public URL.
  const viewAttachment = (row: {
    drive_view_url?: string | null;
    attachment_path?: string | null;
  }) => {
    if (row.drive_view_url) {
      window.open(row.drive_view_url, "_blank");
      return;
    }
    if (row.attachment_path) {
      const { data } = supabase.storage
        .from(INVOICE_ATTACHMENTS_BUCKET)
        .getPublicUrl(row.attachment_path);
      if (data?.publicUrl) window.open(data.publicUrl, "_blank");
    }
  };

  // Legacy storage rows still need a "download" path; Drive view URL already
  // serves the file inline, so we just re-open it.
  const downloadAttachment = async (row: {
    drive_view_url?: string | null;
    attachment_path?: string | null;
  }) => {
    if (row.drive_view_url) {
      window.open(row.drive_view_url, "_blank");
      return;
    }
    const path = row.attachment_path;
    if (!path) return;
    const { data, error: dErr } = await supabase.storage
      .from(INVOICE_ATTACHMENTS_BUCKET)
      .download(path);
    if (dErr) {
      setError(dErr.message);
      return;
    }
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = path.split("/").pop() ?? "attachment";
    a.click();
    URL.revokeObjectURL(url);
  };

  const applyCashDelta = async (delta: number) => {
    const { data } = await supabase.from("treasury").select("id, cash_balance").limit(1).maybeSingle();
    if (!data) {
      const { error: insErr } = await supabase.from("treasury").insert({ cash_balance: delta });
      if (insErr) throw insErr;
      return;
    }
    const { error: upErr } = await supabase
      .from("treasury")
      .update({ cash_balance: Number(data.cash_balance) + delta, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (upErr) throw upErr;
  };

  const applyBankDelta = async (bankId: string, delta: number) => {
    const { data: bank, error: selErr } = await supabase
      .from("bank_accounts")
      .select("balance")
      .eq("id", bankId)
      .maybeSingle();
    if (selErr) throw selErr;
    if (!bank) throw new Error("Bank account not found.");
    const { error: upErr } = await supabase
      .from("bank_accounts")
      .update({ balance: Number(bank.balance) + delta, updated_at: new Date().toISOString() })
      .eq("id", bankId);
    if (upErr) throw upErr;
  };

  const logTransaction = async (row: {
    bank_account_id: string | null;
    kind: BankTransactionKind;
    amount: number;
    cash_delta: number;
    account_delta: number;
    description: string | null;
    reference_id?: string | null;
  }) => {
    const { error: logErr } = await supabase.from("bank_transactions").insert(row);
    if (logErr) throw logErr;
  };

  const validateForm = (f: InvoiceForm, excludeId?: string): string | null => {
    if (!f.client_id) return "Select a client.";
    const numErr = validateInvoiceNumber(f.invoice_number);
    if (numErr) return numErr;
    // Reject duplicate invoice numbers anywhere in the company. `invoices` is
    // already company-scoped (RLS + single-company view), so a match on the
    // number alone means the number is taken. Blocks saving a duplicate.
    const dup = invoices.some(
      (i) =>
        i.id !== excludeId &&
        i.invoice_number.trim().toLowerCase() === f.invoice_number.trim().toLowerCase(),
    );
    if (dup) return "That invoice number already exists.";
    if (!f.invoice_date) return "Select an invoice date.";
    // One invoice per contract per month (mirrors the DB uq_invoice_contract_month
    // index). Enforced only when a contract is linked; if the client has active
    // contracts a selection is required (see InvoiceFields), so ad-hoc invoices
    // without a contract only remain for clients that have none.
    if (f.contract_id) {
      const month = f.invoice_date.slice(0, 7);
      const clash = invoices.some(
        (i) =>
          i.id !== excludeId &&
          i.contract_id === f.contract_id &&
          ((i.period_start ?? i.invoice_date) ?? "").slice(0, 7) === month,
      );
      if (clash) return "This contract already has an invoice for that month.";
    } else if (f.client_id && contracts.some((c) => c.client_id === f.client_id && c.status === "active")) {
      return "Select the contract this invoice bills.";
    }
    const amt = Number(f.invoice_amount);
    if (!amt || amt <= 0) return "Enter a positive invoice amount.";
    if (validateFreeText(f.notes)) return "Special characters are not allowed in Notes.";
    return null;
  };

  // Surface a submit error inside the open modal. Invoice-number problems
  // (format or duplicate) land inline under the field; anything else shows in
  // the modal's own error banner.
  const routeSubmitError = (msg: string) => {
    if (/invoice number/i.test(msg)) {
      setFieldErrors((p) => ({ ...p, invoice_number: msg }));
    } else {
      setModalError(msg);
    }
  };

  // Map a DB write failure to a friendly modal message. A unique-constraint
  // violation on (client_id, invoice_number) becomes the duplicate message.
  const routeDbError = (e: any) => {
    const msg = e?.message ?? "";
    // A contract-month clash and an invoice-number clash are both 23505; tell
    // them apart by the index/constraint name so the message is actionable.
    if (/uq_invoice_contract_month/i.test(msg)) {
      setModalError("This contract already has an invoice for that month.");
      return;
    }
    const isDup = e?.code === "23505" || /duplicate key|already exists|unique/i.test(msg);
    routeSubmitError(isDup ? "That invoice number already exists." : msg || String(e));
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    const err = validateForm(form);
    if (err) {
      routeSubmitError(err);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const invAmt = Number(form.invoice_amount);
      const wht = Number(form.withholding_tax || 0);
      const { data, error: insErr } = await supabase
        .from("invoices")
        .insert({
          client_id: form.client_id,
          contract_id: form.contract_id || null,
          invoice_number: form.invoice_number.trim(),
          invoice_date: `${form.invoice_date.slice(0, 7)}-01`,
          invoice_amount: invAmt,
          withholding_tax: wht,
          amount_received: 0,
          notes: form.notes.trim() || null,
          attachment_path: null,
        })
        .select()
        .single();
      if (insErr) throw insErr;
      const inv = data as Invoice;
      if (form.attachment_file) {
        const drive = await uploadAttachmentToDrive(form.attachment_file);
        const { error: upErr } = await supabase
          .from("invoices")
          .update({
            drive_file_id: drive.drive_file_id,
            drive_view_url: drive.drive_view_url,
            attachment_file_name: drive.file_name,
            updated_at: new Date().toISOString(),
          })
          .eq("id", inv.id);
        if (upErr) throw upErr;
      }
      setForm(emptyForm());
      setIsAddOpen(false);
      await loadAll();
    } catch (e: any) {
      routeDbError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = async (row: InvoiceRow) => {
    setEditingId(row.id);
    setEditInvoice(row);
    setEditForm({
      client_id: row.client_id,
      contract_id: row.contract_id ?? "",
      invoice_number: row.invoice_number,
      invoice_date: row.invoice_date.slice(0, 7),
      invoice_amount: String(row.invoice_amount),
      withholding_tax: String(row.withholding_tax ?? 0),
      notes: row.notes ?? "",
      attachment_file: null,
      existing_attachment_path: row.attachment_path,
      existing_drive_file_id: row.drive_file_id ?? null,
      existing_drive_view_url: row.drive_view_url ?? null,
      existing_attachment_file_name: row.attachment_file_name ?? null,
    });
    setEditPayments([]);
    setFieldErrors({});
    setModalError(null);
    setIsEditOpen(true);
    await loadPaymentsFor(row.id);
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    setModalError(null);
    const err = validateForm(editForm, editingId);
    if (err) {
      routeSubmitError(err);
      return;
    }
    setEditSubmitting(true);
    setError(null);
    try {
      // Replace path: keep whatever was there unless the user picked a new file.
      let driveFileId = editForm.existing_drive_file_id;
      let driveViewUrl = editForm.existing_drive_view_url;
      let attachmentFileName = editForm.existing_attachment_file_name;
      let legacyPath = editForm.existing_attachment_path;
      if (editForm.attachment_file) {
        // Wipe the previous attachment (Drive or legacy) before uploading new.
        await removeAttachment({
          drive_file_id: editForm.existing_drive_file_id,
          attachment_path: editForm.existing_attachment_path,
        });
        const drive = await uploadAttachmentToDrive(editForm.attachment_file);
        driveFileId = drive.drive_file_id;
        driveViewUrl = drive.drive_view_url;
        attachmentFileName = drive.file_name;
        legacyPath = null;
      }
      const invAmt = Number(editForm.invoice_amount);
      const wht = Number(editForm.withholding_tax || 0);
      const { error: upErr } = await supabase
        .from("invoices")
        .update({
          client_id: editForm.client_id,
          contract_id: editForm.contract_id || null,
          invoice_number: editForm.invoice_number.trim(),
          invoice_date: `${editForm.invoice_date.slice(0, 7)}-01`,
          invoice_amount: invAmt,
          withholding_tax: wht,
          notes: editForm.notes.trim() || null,
          attachment_path: legacyPath,
          drive_file_id: driveFileId,
          drive_view_url: driveViewUrl,
          attachment_file_name: attachmentFileName,
          updated_at: new Date().toISOString(),
        })
        .eq("id", editingId);
      if (upErr) throw upErr;
      setIsEditOpen(false);
      setEditingId(null);
      setEditInvoice(null);
      setEditPayments([]);
      setEditForm(emptyForm());
      await loadAll();
    } catch (e: any) {
      routeDbError(e);
    } finally {
      setEditSubmitting(false);
    }
  };

  const clearEditAttachment = async () => {
    if (!editingId) return;
    const hasAttachment =
      editForm.existing_drive_file_id || editForm.existing_attachment_path;
    if (!hasAttachment) return;
    if (!window.confirm("Remove the current attachment?")) return;
    try {
      await removeAttachment({
        drive_file_id: editForm.existing_drive_file_id,
        attachment_path: editForm.existing_attachment_path,
      });
      const { error: upErr } = await supabase
        .from("invoices")
        .update({
          attachment_path: null,
          drive_file_id: null,
          drive_view_url: null,
          attachment_file_name: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", editingId);
      if (upErr) throw upErr;
      setEditForm({
        ...editForm,
        existing_attachment_path: null,
        existing_drive_file_id: null,
        existing_drive_view_url: null,
        existing_attachment_file_name: null,
      });
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  const handleStatusChange = async (row: InvoiceRow, next: InvoiceStatus) => {
    if (row.status === next) return;
    setError(null);
    const prev = row.status;
    setInvoices((cur) => cur.map((i) => (i.id === row.id ? { ...i, status: next } : i)));
    const { error: upErr } = await supabase
      .from("invoices")
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (upErr) {
      setError(upErr.message);
      setInvoices((cur) => cur.map((i) => (i.id === row.id ? { ...i, status: prev } : i)));
    }
  };

  const handleDelete = async (row: InvoiceRow) => {
    if (!window.confirm(`Delete invoice "${row.invoice_number}"? This cannot be undone.`)) return;
    setError(null);
    try {
      await removeAttachment({
        drive_file_id: row.drive_file_id,
        attachment_path: row.attachment_path,
      });
      const { error: delErr } = await supabase.from("invoices").delete().eq("id", row.id);
      if (delErr) throw delErr;
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  const openPayment = (row: InvoiceRow) => {
    setPaymentInvoice(row);
    setPaymentForm(emptyPaymentForm());
    setIsPaymentOpen(true);
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paymentInvoice) return;
    const amt = Number(paymentForm.amount);
    if (!amt || amt <= 0) {
      setError("Enter a positive payment amount.");
      return;
    }
    if (!paymentForm.payment_date) {
      setError("Select a payment date.");
      return;
    }
    if (paymentForm.payment_mode === "Bank" && !paymentForm.bank_account_id) {
      setError("Select a bank account for Bank payments.");
      return;
    }
    setPaymentSubmitting(true);
    setError(null);
    try {
      // Single atomic DB transaction: oldest-first allocation across invoices,
      // amount_received updates, the bank/cash move and the ledger entry all
      // commit or roll back together — so a partial failure can never leave an
      // orphaned payment row again.
      const { error: rpcErr } = await supabase.rpc("record_invoice_payment", {
        p_invoice_id: paymentInvoice.id,
        p_amount: amt,
        p_payment_date: paymentForm.payment_date,
        p_payment_mode: paymentForm.payment_mode,
        p_bank_account_id:
          paymentForm.payment_mode === "Bank" ? paymentForm.bank_account_id : null,
        p_notes: paymentForm.notes.trim() || null,
      });
      if (rpcErr) throw rpcErr;

      setIsPaymentOpen(false);
      setPaymentInvoice(null);
      setPaymentForm(emptyPaymentForm());
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setPaymentSubmitting(false);
    }
  };

  const openEditPayment = (p: PaymentRow) => {
    setEditingPayment(p);
    setEditPaymentForm({
      amount: String(p.amount),
      payment_date: p.payment_date,
      payment_mode: p.payment_mode,
      bank_account_id: p.bank_account_id ?? "",
      notes: p.notes ?? "",
    });
    setIsEditPaymentOpen(true);
  };

  const reverseOldPaymentEffects = async (p: PaymentRow, invoiceNumber: string, clientName: string) => {
    const oldAmt = Number(p.amount);
    const desc = `Payment edit reversal (${p.payment_mode.toLowerCase()}) · ${clientName} · Invoice ${invoiceNumber}`;
    if (p.payment_mode === "Cash") {
      await applyCashDelta(-oldAmt);
      await logTransaction({
        bank_account_id: null,
        kind: "receipt",
        amount: oldAmt,
        cash_delta: -oldAmt,
        account_delta: 0,
        description: desc,
        reference_id: p.id,
      });
    } else if (p.bank_account_id) {
      await applyBankDelta(p.bank_account_id, -oldAmt);
      await logTransaction({
        bank_account_id: p.bank_account_id,
        kind: "receipt",
        amount: oldAmt,
        cash_delta: 0,
        account_delta: -oldAmt,
        description: desc,
        reference_id: p.id,
      });
    }
  };

  const handleEditPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPayment || !editInvoice) return;
    const newAmt = Number(editPaymentForm.amount);
    if (!newAmt || newAmt <= 0) {
      setError("Enter a positive payment amount.");
      return;
    }
    if (!editPaymentForm.payment_date) {
      setError("Select a payment date.");
      return;
    }
    if (editPaymentForm.payment_mode === "Bank" && !editPaymentForm.bank_account_id) {
      setError("Select a bank account for Bank payments.");
      return;
    }
    const oldAmt = Number(editingPayment.amount);
    const currentReceived = Number(editInvoice.amount_received);
    const receivedWithoutThis = currentReceived - oldAmt;
    const maxAllowed = Number(editInvoice.invoice_amount) - receivedWithoutThis;
    if (newAmt > maxAllowed + 0.0001) {
      setError(`Amount exceeds invoice total. Max allowed: PKR ${maxAllowed.toLocaleString()}.`);
      return;
    }
    setEditPaymentSubmitting(true);
    setError(null);
    try {
      const invoiceNumber = editInvoice.invoice_number;
      const clientName = editInvoice.client?.name ?? "Client";

      await reverseOldPaymentEffects(editingPayment, invoiceNumber, clientName);

      const newBankId =
        editPaymentForm.payment_mode === "Bank" ? editPaymentForm.bank_account_id : null;
      const desc = `Payment updated (${editPaymentForm.payment_mode.toLowerCase()}) · ${clientName} · Invoice ${invoiceNumber}`;
      if (editPaymentForm.payment_mode === "Cash") {
        await applyCashDelta(newAmt);
        await logTransaction({
          bank_account_id: null,
          kind: "receipt",
          amount: newAmt,
          cash_delta: newAmt,
          account_delta: 0,
          description: desc,
          reference_id: editingPayment.id,
        });
      } else {
        await applyBankDelta(newBankId!, newAmt);
        await logTransaction({
          bank_account_id: newBankId,
          kind: "receipt",
          amount: newAmt,
          cash_delta: 0,
          account_delta: newAmt,
          description: desc,
          reference_id: editingPayment.id,
        });
      }

      const { error: upPayErr } = await supabase
        .from("invoice_payments")
        .update({
          amount: newAmt,
          payment_date: editPaymentForm.payment_date,
          payment_mode: editPaymentForm.payment_mode,
          bank_account_id: newBankId,
          notes: editPaymentForm.notes.trim() || null,
        })
        .eq("id", editingPayment.id);
      if (upPayErr) throw upPayErr;

      const newReceived = receivedWithoutThis + newAmt;
      const { error: invUpErr } = await supabase
        .from("invoices")
        .update({ amount_received: newReceived, updated_at: new Date().toISOString() })
        .eq("id", editInvoice.id);
      if (invUpErr) throw invUpErr;

      setIsEditPaymentOpen(false);
      setEditingPayment(null);
      setEditPaymentForm(emptyPaymentForm());
      await loadAll();
      const refreshedInv = (await supabase
        .from("invoices")
        .select("*, client:client_id(name, client_code)")
        .eq("id", editInvoice.id)
        .maybeSingle()).data as InvoiceRow | null;
      if (refreshedInv) setEditInvoice(refreshedInv);
      await loadPaymentsFor(editInvoice.id);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setEditPaymentSubmitting(false);
    }
  };

  const handleDeletePayment = async (p: PaymentRow) => {
    if (!editInvoice) return;
    if (!window.confirm(`Delete this PKR ${Number(p.amount).toLocaleString()} payment? The amount will be reversed from balances.`)) return;
    setError(null);
    try {
      const invoiceNumber = editInvoice.invoice_number;
      const clientName = editInvoice.client?.name ?? "Client";
      await reverseOldPaymentEffects(p, invoiceNumber, clientName);
      const { error: delErr } = await supabase
        .from("invoice_payments")
        .delete()
        .eq("id", p.id);
      if (delErr) throw delErr;
      const newReceived = Number(editInvoice.amount_received) - Number(p.amount);
      const { error: invUpErr } = await supabase
        .from("invoices")
        .update({ amount_received: newReceived, updated_at: new Date().toISOString() })
        .eq("id", editInvoice.id);
      if (invUpErr) throw invUpErr;
      await loadAll();
      const refreshedInv = (await supabase
        .from("invoices")
        .select("*, client:client_id(name, client_code)")
        .eq("id", editInvoice.id)
        .maybeSingle()).data as InvoiceRow | null;
      if (refreshedInv) setEditInvoice(refreshedInv);
      await loadPaymentsFor(editInvoice.id);
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  const editInvoiceAmount = Number(editForm.invoice_amount) || 0;
  const editReceived = editInvoice ? Number(editInvoice.amount_received) : 0;
  const editWht = editInvoice ? Number(editInvoice.withholding_tax ?? 0) : 0;
  const editOutstanding = Math.max(0, editInvoiceAmount - editWht - editReceived);

  const paymentOutstanding = paymentInvoice
    ? Number(paymentInvoice.invoice_amount) -
      Number(paymentInvoice.withholding_tax ?? 0) -
      Number(paymentInvoice.amount_received)
    : 0;

  const editPaymentMaxAllowed = editingPayment && editInvoice
    ? Number(editInvoice.invoice_amount) - (Number(editInvoice.amount_received) - Number(editingPayment.amount))
    : 0;

  return (
    <>
      <Header
        title="Invoices"
        subtitle="Invoice ledger, payment tracking and PDF export"
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={async () => {
                if (!window.confirm("Run auto-invoice issue now for all eligible clients?")) return;
                setError(null);
                try {
                  const { data, error: rpcErr } = await supabase.rpc("run_auto_invoices");
                  if (rpcErr) throw rpcErr;
                  await loadAll();
                  window.alert(`Auto-invoice issued: ${data ?? 0} invoice(s).`);
                } catch (e: any) {
                  setError(e.message ?? String(e));
                }
              }}
            >
              Run Auto-Invoices
            </Button>
            <Button variant="secondary" size="md" onClick={() => setStructureOpen(true)}>
              <Settings2 className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Invoice Structure
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                // Prefill the next invoice number as INV-0NN (total invoices + 1,
                // zero-padded to at least 3 digits) — e.g. 56 invoices → INV-057.
                setForm({
                  ...emptyForm(),
                  invoice_number: `INV-${String(invoices.length + 1).padStart(3, "0")}`,
                });
                setFieldErrors({});
                setModalError(null);
                setIsAddOpen(true);
              }}
            >
              <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              New Invoice
            </Button>
          </div>
        }
      />

      <InvoiceStructureModal isOpen={structureOpen} onClose={() => setStructureOpen(false)} />

      <div className="flex-1 overflow-y-auto p-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="flex gap-1 mb-6 border-b border-slate-200">
          {(["ledger", "generate"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm -mb-px border-b-2 ${
                tab === t
                  ? "border-brand-500 text-brand-700 font-medium"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {t === "ledger" ? "Invoices" : "Generate"}
            </button>
          ))}
        </div>

        {tab === "generate" && <InvoiceGenerate onPosted={loadAll} />}

        {tab === "ledger" && (
        <>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-brand-500">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total Invoiced</p>
            <p className="text-2xl text-brand-900">PKR {summary.invoiced.toLocaleString()}</p>
          </div>
          <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-success-500">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total Received</p>
            <p className="text-2xl text-success-900">PKR {summary.received.toLocaleString()}</p>
          </div>
          <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-warning-500">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Outstanding</p>
            <p className="text-2xl text-warning-900">PKR {summary.outstanding.toLocaleString()}</p>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-600">Client:</label>
              <ClientFilterSelect
                clients={clients}
                value={clientFilter}
                onChange={setClientFilter}
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-600">Branch:</label>
              <ThemedSelect
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                className="px-3 py-1.5 border border-slate-200 rounded-md text-sm"
              >
                <option value="all">All Branches</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </ThemedSelect>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-600">Month:</label>
              <ThemedSelect
                value={monthFilter}
                onChange={(e) => setMonthFilter(e.target.value)}
                className="px-3 py-1.5 border border-slate-200 rounded-md text-sm"
              >
                <option value="all">All Months</option>
                {monthOptions.map((m) => (
                  <option key={m} value={m}>{monthLabel(m)}</option>
                ))}
              </ThemedSelect>
            </div>
            <div className="ml-auto text-sm text-slate-500">
              {filteredInvoices.length} invoice{filteredInvoices.length === 1 ? "" : "s"}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Invoice #</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Invoice Month</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Invoice Amount</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Withholding</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Received</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Outstanding</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Attachment</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading && (
                  <tr>
                    <td colSpan={10} className="px-6 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filteredInvoices.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-6 py-10 text-center text-slate-500 text-sm">
                      No invoices yet. Click "New Invoice" to create one.
                    </td>
                  </tr>
                )}
                {!loading &&
                  filteredInvoices.map((inv) => {
                    const wht = Number(inv.withholding_tax ?? 0);
                    const outstanding = Number(inv.invoice_amount) - wht - Number(inv.amount_received);
                    const isSettled = outstanding <= 0;
                    return (
                      <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4 text-sm text-slate-900 font-mono">
                          {inv.invoice_number}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-900">
                          <div className="flex items-center gap-2">
                            <Building2 className="w-3.5 h-3.5 text-slate-400" strokeWidth={1.5} />
                            <span>{inv.client?.name ?? "—"}</span>
                          </div>
                          <div className="text-xs text-slate-500 font-mono ml-5">
                            {inv.client?.client_code ?? ""}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">{monthLabel(inv.invoice_date)}</td>
                        <td className="px-6 py-4 text-sm text-brand-600 text-right">
                          PKR {Number(inv.invoice_amount).toLocaleString()}
                        </td>
                        <td className="px-6 py-4 text-sm text-danger-600 text-right">
                          {wht > 0 ? `PKR ${wht.toLocaleString()}` : "—"}
                        </td>
                        <td className="px-6 py-4 text-sm text-success-600 text-right">
                          PKR {Number(inv.amount_received).toLocaleString()}
                        </td>
                        <td className="px-6 py-4 text-sm text-right">
                          <span className={outstanding > 0 ? "text-warning-600" : "text-success-600"}>
                            PKR {outstanding.toLocaleString()}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <ThemedSelect
                            value={inv.status}
                            onChange={(e) =>
                              handleStatusChange(inv, e.target.value as InvoiceStatus)
                            }
                            className={`text-xs rounded-md px-2 py-1 border focus:outline-none focus:ring-2 focus:ring-slate-900 ${
                              inv.status === "Delivered" || inv.status === "Paid"
                                ? "bg-success-50 text-success-700 border-success-200"
                                : inv.status === "Partly-Paid"
                                ? "bg-brand-50 text-brand-700 border-brand-200"
                                : "bg-warning-50 text-warning-700 border-warning-200"
                            }`}
                          >
                            <option value="Pending">Pending</option>
                            <option value="Delivered">Delivered</option>
                            <option value="Unpaid">Unpaid</option>
                            <option value="Partly-Paid">Partly-Paid</option>
                            <option value="Paid">Paid</option>
                          </ThemedSelect>
                        </td>
                        <td className="px-6 py-4 text-sm">
                          {(inv.drive_view_url || inv.attachment_path) ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => viewAttachment(inv)}
                                className="text-brand-600 hover:text-brand-700 inline-flex items-center gap-1"
                              >
                                <FileText className="w-3.5 h-3.5" strokeWidth={1.5} />
                                View
                              </button>
                              <button
                                type="button"
                                onClick={() => downloadAttachment(inv)}
                                className="text-slate-600 hover:text-slate-900"
                                title="Download"
                              >
                                <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
                              </button>
                            </div>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={async () => {
                              const cli = clients.find((c) => c.id === inv.client_id) ?? null;
                              const contract = contracts.find((c) => c.id === inv.contract_id) ?? null;
                              const [lineRes, taxRes, clRes] = await Promise.all([
                                supabase.from("invoice_lines").select("*").eq("invoice_id", inv.id).order("sort_order"),
                                supabase.from("invoice_taxes").select("*").eq("invoice_id", inv.id).order("sort_order"),
                                inv.contract_id
                                  ? supabase.from("contract_lines").select("*").eq("contract_id", inv.contract_id)
                                  : Promise.resolve({ data: [] as ContractLine[] }),
                              ]);
                              generateInvoiceDocument({
                                invoice: inv,
                                client: cli,
                                company: company ?? null,
                                contract,
                                contractLines: (clRes.data ?? []) as ContractLine[],
                                invoiceLines: (lineRes.data ?? []) as InvoiceLine[],
                                taxes: (taxRes.data ?? []) as InvoiceTax[],
                              });
                            }}
                            title="Download PDF using your company invoice template"
                          >
                            <Download className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                            PDF
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openPayment(inv)}
                            disabled={isSettled}
                            title={isSettled ? "Invoice fully paid" : "Record payment"}
                          >
                            <Wallet className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                            Record Payment
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => openEdit(inv)}>
                            <Pencil className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                            Edit
                          </Button>
                          <button
                            type="button"
                            onClick={() => handleDelete(inv)}
                            className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-danger-700 hover:bg-danger-50"
                            title="Delete invoice"
                          >
                            <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
        </>
        )}
      </div>

      <Modal
        isOpen={isAddOpen}
        onClose={() => {
          setIsAddOpen(false);
          setForm(emptyForm());
          setModalError(null);
        }}
        title="New Invoice"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleAdd}>
          {modalError && (
            <div className="flex items-start gap-2 p-3 rounded-md border border-danger-200 bg-danger-50 text-sm text-danger-700">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={2} />
              <span>{modalError}</span>
            </div>
          )}
          <InvoiceFields
            form={form}
            setForm={setForm}
            clients={clients}
            contracts={contracts}
            allowClearAttachment={false}
            onClearAttachment={() => {}}
            errors={fieldErrors}
            onFieldBlur={(k, err) => setFieldErrors((p) => ({ ...p, [k]: err }))}
            invoices={invoices}
          />
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
              {submitting ? "Saving…" : "Create Invoice"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsAddOpen(false);
                setForm(emptyForm());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isEditOpen}
        onClose={() => {
          setIsEditOpen(false);
          setEditingId(null);
          setEditInvoice(null);
          setEditPayments([]);
          setEditForm(emptyForm());
          setModalError(null);
        }}
        title="Edit Invoice"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleEdit}>
          {modalError && (
            <div className="flex items-start gap-2 p-3 rounded-md border border-danger-200 bg-danger-50 text-sm text-danger-700">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={2} />
              <span>{modalError}</span>
            </div>
          )}
          <InvoiceFields
            form={editForm}
            setForm={setEditForm}
            clients={clients}
            contracts={contracts}
            allowClearAttachment
            onClearAttachment={clearEditAttachment}
            errors={fieldErrors}
            onFieldBlur={(k, err) => setFieldErrors((p) => ({ ...p, [k]: err }))}
            invoices={invoices}
            excludeId={editingId ?? undefined}
          />

          <div className="grid grid-cols-3 gap-2">
            <div className="p-2 rounded-md border border-brand-200 bg-brand-50">
              <p className="text-[11px] text-brand-700">Invoice Amount</p>
              <p className="text-sm text-brand-900">
                PKR {editInvoiceAmount.toLocaleString()}
              </p>
            </div>
            <div className="p-2 rounded-md border border-success-200 bg-success-50">
              <p className="text-[11px] text-success-700">Received</p>
              <p className="text-sm text-success-900">
                PKR {editReceived.toLocaleString()}
              </p>
            </div>
            <div className="p-2 rounded-md border border-warning-200 bg-warning-50">
              <p className="text-[11px] text-warning-700">Outstanding</p>
              <p className="text-sm text-warning-900">
                PKR {editOutstanding.toLocaleString()}
              </p>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-slate-700">Payment History</label>
              <span className="text-xs text-slate-500">
                {editPayments.length} payment{editPayments.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="rounded-md border border-slate-200 max-h-48 overflow-y-auto">
              {editPayments.length === 0 ? (
                <div className="p-3 text-sm text-slate-500 text-center">
                  No payments recorded yet. Use "Record Payment" from the invoice list.
                </div>
              ) : (
                <table className="w-full">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 text-xs text-slate-500">Date</th>
                      <th className="text-right px-3 py-2 text-xs text-slate-500">Amount</th>
                      <th className="text-left px-3 py-2 text-xs text-slate-500">Mode</th>
                      <th className="text-left px-3 py-2 text-xs text-slate-500">Notes</th>
                      <th className="text-right px-3 py-2 text-xs text-slate-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {editPayments.map((p) => (
                      <tr key={p.id}>
                        <td className="px-3 py-2 text-xs text-slate-600">{formatDate(p.payment_date)}</td>
                        <td className="px-3 py-2 text-xs text-success-700 text-right">
                          PKR {Number(p.amount).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-700">
                          {p.payment_mode}
                          {p.payment_mode === "Bank" && p.bank?.bank_name
                            ? ` · ${p.bank.bank_name}`
                            : ""}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-500 truncate max-w-[140px]">
                          {p.notes ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openEditPayment(p)}
                              className="p-1 rounded text-brand-600 hover:bg-brand-50"
                              title="Edit payment"
                            >
                              <Pencil className="w-3.5 h-3.5" strokeWidth={1.5} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeletePayment(p)}
                              className="p-1 rounded text-danger-600 hover:bg-danger-50"
                              title="Delete payment"
                            >
                              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={editSubmitting}>
              {editSubmitting ? "Saving…" : "Update Invoice"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsEditOpen(false);
                setEditingId(null);
                setEditInvoice(null);
                setEditPayments([]);
                setEditForm(emptyForm());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isPaymentOpen}
        onClose={() => {
          setIsPaymentOpen(false);
          setPaymentInvoice(null);
          setPaymentForm(emptyPaymentForm());
        }}
        title="Record Payment"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleRecordPayment}>
          {paymentInvoice && (
            <div className="grid grid-cols-3 gap-2">
              <div className="p-2 rounded-md border border-brand-200 bg-brand-50">
                <p className="text-[11px] text-brand-700">Invoice Amount</p>
                <p className="text-sm text-brand-900">
                  PKR {Number(paymentInvoice.invoice_amount).toLocaleString()}
                </p>
              </div>
              <div className="p-2 rounded-md border border-success-200 bg-success-50">
                <p className="text-[11px] text-success-700">Received</p>
                <p className="text-sm text-success-900">
                  PKR {Number(paymentInvoice.amount_received).toLocaleString()}
                </p>
              </div>
              <div className="p-2 rounded-md border border-warning-200 bg-warning-50">
                <p className="text-[11px] text-warning-700">Outstanding</p>
                <p className="text-sm text-warning-900">
                  PKR {paymentOutstanding.toLocaleString()}
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
              <input
                required
                type="number"
                min="0"
                step="0.01"
                value={paymentForm.amount}
                onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Payment Date *</label>
              <input
                required
                type="date"
                value={paymentForm.payment_date}
                onChange={(e) =>
                  setPaymentForm({ ...paymentForm, payment_date: e.target.value })
                }
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Payment Mode *</label>
            <div className="flex gap-2">
              {(["Cash", "Bank"] as const).map((mode) => (
                <label
                  key={mode}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm border cursor-pointer ${
                    paymentForm.payment_mode === mode
                      ? "bg-brand-600 text-[#fff] border-brand-600"
                      : "bg-white text-slate-700 border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="payment_mode"
                    className="hidden"
                    checked={paymentForm.payment_mode === mode}
                    onChange={() =>
                      setPaymentForm({
                        ...paymentForm,
                        payment_mode: mode,
                        bank_account_id: mode === "Cash" ? "" : paymentForm.bank_account_id,
                      })
                    }
                  />
                  {mode}
                </label>
              ))}
            </div>
          </div>

          {paymentForm.payment_mode === "Bank" && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Bank Account *</label>
              <ThemedSelect
                required
                value={paymentForm.bank_account_id}
                onChange={(e) =>
                  setPaymentForm({ ...paymentForm, bank_account_id: e.target.value })
                }
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="">Select bank account</option>
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.bank_name} — {b.account_number}
                  </option>
                ))}
              </ThemedSelect>
            </div>
          )}

          <div>
            <label className="block text-sm text-slate-700 mb-1">Notes</label>
            <textarea
              value={paymentForm.notes}
              onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })}
              rows={2}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="Optional notes"
            />
          </div>

          <div className="flex items-center gap-3 pt-4">
            <Button
              variant="primary"
              size="md"
              className="flex-1"
              disabled={paymentSubmitting}
            >
              {paymentSubmitting ? "Recording…" : "Record Payment"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsPaymentOpen(false);
                setPaymentInvoice(null);
                setPaymentForm(emptyPaymentForm());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isEditPaymentOpen}
        onClose={() => {
          setIsEditPaymentOpen(false);
          setEditingPayment(null);
          setEditPaymentForm(emptyPaymentForm());
        }}
        title="Edit Payment"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleEditPayment}>
          {editingPayment && editInvoice && (
            <div className="p-3 rounded-md border border-slate-200 bg-slate-50 text-xs text-slate-600 space-y-1">
              <div className="flex justify-between">
                <span>Invoice</span>
                <span className="font-mono text-slate-900">{editInvoice.invoice_number}</span>
              </div>
              <div className="flex justify-between">
                <span>Original amount</span>
                <span className="text-slate-900">
                  PKR {Number(editingPayment.amount).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Max allowed</span>
                <span className="text-slate-900">
                  PKR {editPaymentMaxAllowed.toLocaleString()}
                </span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
              <input
                required
                type="number"
                min="0"
                step="0.01"
                value={editPaymentForm.amount}
                onChange={(e) =>
                  setEditPaymentForm({ ...editPaymentForm, amount: e.target.value })
                }
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Payment Date *</label>
              <input
                required
                type="date"
                value={editPaymentForm.payment_date}
                onChange={(e) =>
                  setEditPaymentForm({ ...editPaymentForm, payment_date: e.target.value })
                }
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Payment Mode *</label>
            <div className="flex gap-2">
              {(["Cash", "Bank"] as const).map((mode) => (
                <label
                  key={mode}
                  className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm border cursor-pointer ${
                    editPaymentForm.payment_mode === mode
                      ? "bg-brand-600 text-[#fff] border-brand-600"
                      : "bg-white text-slate-700 border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="edit_payment_mode"
                    className="hidden"
                    checked={editPaymentForm.payment_mode === mode}
                    onChange={() =>
                      setEditPaymentForm({
                        ...editPaymentForm,
                        payment_mode: mode,
                        bank_account_id:
                          mode === "Cash" ? "" : editPaymentForm.bank_account_id,
                      })
                    }
                  />
                  {mode}
                </label>
              ))}
            </div>
          </div>

          {editPaymentForm.payment_mode === "Bank" && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Bank Account *</label>
              <ThemedSelect
                required
                value={editPaymentForm.bank_account_id}
                onChange={(e) =>
                  setEditPaymentForm({ ...editPaymentForm, bank_account_id: e.target.value })
                }
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="">Select bank account</option>
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.bank_name} — {b.account_number}
                  </option>
                ))}
              </ThemedSelect>
            </div>
          )}

          <div>
            <label className="block text-sm text-slate-700 mb-1">Notes</label>
            <textarea
              value={editPaymentForm.notes}
              onChange={(e) =>
                setEditPaymentForm({ ...editPaymentForm, notes: e.target.value })
              }
              rows={2}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="Optional notes"
            />
          </div>

          <div className="flex items-center gap-3 pt-4">
            <Button
              variant="primary"
              size="md"
              className="flex-1"
              disabled={editPaymentSubmitting}
            >
              {editPaymentSubmitting ? "Saving…" : "Save Changes"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setIsEditPaymentOpen(false);
                setEditingPayment(null);
                setEditPaymentForm(emptyPaymentForm());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function InvoiceFields({
  form,
  setForm,
  clients,
  contracts,
  allowClearAttachment,
  onClearAttachment,
  errors,
  onFieldBlur,
  invoices,
  excludeId,
}: {
  form: InvoiceForm;
  setForm: (f: InvoiceForm) => void;
  clients: Client[];
  contracts: Contract[];
  allowClearAttachment: boolean;
  onClearAttachment: () => void;
  errors: Record<string, string | null>;
  onFieldBlur: (key: string, err: string | null) => void;
  invoices: InvoiceRow[];
  excludeId?: string;
}) {
  // Active contracts for the chosen client. When any exist, a selection is
  // required so the one-invoice-per-contract-per-month rule can apply.
  const clientContracts = contracts.filter((c) => c.client_id === form.client_id && c.status === "active");
  return (
    <>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Client *</label>
        <ThemedSelect
          required
          value={form.client_id}
          onChange={(e) => setForm({ ...form, client_id: e.target.value, contract_id: "" })}
          className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
        >
          <option value="">Select client</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.client_code})
            </option>
          ))}
        </ThemedSelect>
      </div>
      {form.client_id && (
        <div>
          <label className="block text-sm text-slate-700 mb-1">
            Contract {clientContracts.length > 0 ? "*" : ""}
          </label>
          {clientContracts.length === 0 ? (
            <p className="text-xs text-slate-500 py-2">
              This client has no active contracts — the invoice will be recorded without a contract link.
            </p>
          ) : (
            <ThemedSelect
              required
              value={form.contract_id}
              onChange={(e) => setForm({ ...form, contract_id: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            >
              <option value="">Select contract</option>
              {clientContracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.contract_code} ({CONTRACT_TYPE_LABEL[c.contract_type]})
                </option>
              ))}
            </ThemedSelect>
          )}
          <p className="text-[10px] text-slate-500 mt-1">
            One invoice per contract per month is enforced.
          </p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-slate-700 mb-1">Invoice # *</label>
          <input
            required
            type="text"
            value={form.invoice_number}
            onChange={(e) => setForm({ ...form, invoice_number: e.target.value })}
            onBlur={(e) => {
              const dup = invoices.some(
                (i) =>
                  i.id !== excludeId &&
                  i.invoice_number.trim().toLowerCase() === e.target.value.trim().toLowerCase(),
              );
              onFieldBlur(
                "invoice_number",
                validateInvoiceNumber(e.target.value) ?? (dup ? "That invoice number already exists." : null),
              );
            }}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            placeholder="INV-001"
          />
          {errors.invoice_number && <p className="text-xs text-danger-600 mt-1">{errors.invoice_number}</p>}
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Invoice Month *</label>
          <input
            required
            type="month"
            value={form.invoice_date}
            onChange={(e) => setForm({ ...form, invoice_date: e.target.value })}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
          />
        </div>
      </div>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Invoice Amount (PKR) *</label>
        <input
          required
          type="number"
          min="0"
          step="0.01"
          value={form.invoice_amount}
          onChange={(e) => setForm({ ...form, invoice_amount: e.target.value })}
          onBlur={(e) => onFieldBlur("invoice_amount", validateAmount(e.target.value))}
          className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
        />
        {errors.invoice_amount && <p className="text-xs text-danger-600 mt-1">{errors.invoice_amount}</p>}
      </div>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Withholding Tax (PKR)</label>
        <input
          type="number"
          min="0"
          step="0.01"
          value={form.withholding_tax}
          onChange={(e) => setForm({ ...form, withholding_tax: e.target.value })}
          placeholder="0 (optional)"
          className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
        />
        <p className="text-xs text-slate-500 mt-1">Deducted from the receivable balance for this invoice.</p>
      </div>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Attachment</label>
        {(form.existing_drive_view_url || form.existing_attachment_path) && !form.attachment_file && (
          <div className="flex items-center gap-2 text-xs text-slate-600 mb-2">
            <FileText className="w-3.5 h-3.5" strokeWidth={1.5} />
            <span className="font-mono truncate flex-1">
              {form.existing_attachment_file_name
                ?? form.existing_attachment_path?.split("/").pop()
                ?? "Attached"}
            </span>
            {form.existing_drive_view_url && (
              <a
                href={form.existing_drive_view_url}
                target="_blank"
                rel="noreferrer"
                className="text-brand-700 hover:text-brand-800"
              >
                View
              </a>
            )}
            {allowClearAttachment && (
              <button
                type="button"
                onClick={onClearAttachment}
                className="text-danger-700 hover:text-danger-800"
              >
                Remove
              </button>
            )}
          </div>
        )}
        <label className="flex items-center justify-center gap-2 px-4 py-2 border border-dashed border-slate-300 rounded-md cursor-pointer hover:border-slate-400 text-sm text-slate-600">
          <Upload className="w-4 h-4" strokeWidth={1.5} />
          <span>
            {form.attachment_file
              ? form.attachment_file.name
              : (form.existing_drive_view_url || form.existing_attachment_path)
              ? "Replace attachment…"
              : "Upload invoice (PDF / image)"}
          </span>
          <input
            type="file"
            accept="application/pdf,image/*"
            className="hidden"
            onChange={(e) =>
              setForm({ ...form, attachment_file: e.target.files?.[0] ?? null })
            }
          />
        </label>
      </div>
      <div>
        <label className="block text-sm text-slate-700 mb-1">Notes</label>
        <textarea
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          rows={2}
          className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
          placeholder="Optional notes"
        />
      </div>
    </>
  );
}
