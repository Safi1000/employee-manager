import { useEffect, useMemo, useState } from "react";
import { Plus, Building2, Download, AlertCircle, X, Loader2, ArrowDownUp, History, Trash2, CheckCircle2, RotateCcw, FileText, Pencil } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import {
  exportReceivableLedger,
  exportTable,
  type LedgerEntry,
} from "../../lib/excel";
import {
  supabase,
  INVOICE_ATTACHMENTS_BUCKET,
  type BankAccount,
  type BankTransaction,
  type BankTransactionKind,
  type Expense,
  type Vendor,
  type ExpenseCategory,
  type Client,
  type Invoice,
} from "../../lib/supabase";

type PayableRow = Expense & {
  vendor?: Vendor | null;
  category?: ExpenseCategory | null;
  client?: Client | null;
};

type ReceivableRow = Client & {
  total_invoiced: number;
  total_received: number;
  outstanding: number;
  invoices: Invoice[];
};

const kindLabel: Record<BankTransactionKind, string> = {
  opening: "Opening",
  deposit: "Deposit",
  withdraw_to_cash: "Withdraw to Cash",
  payroll: "Payroll",
  reconcile: "Reconcile (Bank)",
  adjustment: "Adjustment",
  cash_adjustment: "Cash Adjustment",
  expense: "Expense",
  receipt: "Receipt",
};

const todayStr = () => new Date().toISOString().slice(0, 10);

type PayableDisplayStatus = "Pending" | "Paid" | "Overdue";

const payableDisplayStatus = (row: PayableRow): PayableDisplayStatus => {
  if (row.payable_status === "Paid") return "Paid";
  if (row.due_date && row.due_date < todayStr()) return "Overdue";
  return "Pending";
};

export default function Accounting() {
  const [activeTab, setActiveTab] = useState<"receivables" | "payables" | "banks">("receivables");

  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [cashBalance, setCashBalance] = useState<number>(0);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [payables, setPayables] = useState<PayableRow[]>([]);
  const [receivables, setReceivables] = useState<ReceivableRow[]>([]);
  const [payableStatusFilter, setPayableStatusFilter] = useState<"all" | "pending" | "paid" | "overdue">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isBankModalOpen, setIsBankModalOpen] = useState(false);
  const [isStatementModalOpen, setIsStatementModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isOpeningBalanceOpen, setIsOpeningBalanceOpen] = useState(false);
  const [isReconcileModalOpen, setIsReconcileModalOpen] = useState(false);
  const [isEditBankModalOpen, setIsEditBankModalOpen] = useState(false);
  const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState(false);
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [isReceivablesLogOpen, setIsReceivablesLogOpen] = useState(false);
  const [isPayablesLogOpen, setIsPayablesLogOpen] = useState(false);
  const [logBankFilter, setLogBankFilter] = useState<string>("all");
  const [logScope, setLogScope] = useState<"all" | "cash" | "account">("all");
  const [isMarkPaidModalOpen, setIsMarkPaidModalOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<ReceivableRow | null>(null);
  const [selectedBank, setSelectedBank] = useState<BankAccount | null>(null);
  const [selectedPayable, setSelectedPayable] = useState<PayableRow | null>(null);
  const [markPaidVia, setMarkPaidVia] = useState<"Cash" | "Bank">("Cash");
  const [markPaidBankId, setMarkPaidBankId] = useState<string>("");

  const [openingBalanceValue, setOpeningBalanceValue] = useState<string>("");
  const [paymentInvoiceId, setPaymentInvoiceId] = useState<string>("");
  const [paymentAmount, setPaymentAmount] = useState<string>("");
  const [paymentVia, setPaymentVia] = useState<"Cash" | "Bank">("Bank");
  const [paymentBankId, setPaymentBankId] = useState<string>("");
  const [paymentNotes, setPaymentNotes] = useState<string>("");

  const [newBank, setNewBank] = useState({
    bank_name: "",
    account_number: "",
    account_type: "Current" as "Current" | "Savings",
    opening_balance: "",
  });
  const [editBankForm, setEditBankForm] = useState({
    bank_name: "",
    account_number: "",
    account_type: "Current" as "Current" | "Savings",
  });
  const [reconcileTarget, setReconcileTarget] = useState<"account" | "cash" | "total">("account");
  const [reconcileValue, setReconcileValue] = useState("");
  const [reconcileNotes, setReconcileNotes] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawNotes, setWithdrawNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const totalAccountBalance = useMemo(
    () => banks.reduce((acc, b) => acc + Number(b.balance ?? 0), 0),
    [banks]
  );
  const grandTotal = cashBalance + totalAccountBalance;

  const receivableTotals = useMemo(() => {
    let opening = 0;
    let invoiced = 0;
    let received = 0;
    let outstanding = 0;
    for (const r of receivables) {
      opening += Number(r.opening_balance ?? 0);
      invoiced += r.total_invoiced;
      received += r.total_received;
      outstanding += r.outstanding;
    }
    return { opening, invoiced, received, outstanding };
  }, [receivables]);

  const balanceLedger = useMemo(() => {
    const ledger = new Map<string, { cash?: { before: number; after: number }; bank?: { before: number; after: number } }>();
    const sortedAsc = [...transactions].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return ta - tb;
    });
    let cashRunning = 0;
    const bankRunning = new Map<string, number>();
    for (const t of sortedAsc) {
      const cd = Number(t.cash_delta) || 0;
      const ad = Number(t.account_delta) || 0;
      const entry: { cash?: { before: number; after: number }; bank?: { before: number; after: number } } = {};
      if (cd !== 0) {
        const before = cashRunning;
        const after = before + cd;
        entry.cash = { before, after };
        cashRunning = after;
      }
      if (ad !== 0 && t.bank_account_id) {
        const before = bankRunning.get(t.bank_account_id) ?? 0;
        const after = before + ad;
        entry.bank = { before, after };
        bankRunning.set(t.bank_account_id, after);
      }
      ledger.set(t.id, entry);
    }
    return ledger;
  }, [transactions]);

  const payableTotals = useMemo(() => {
    let total = 0;
    let pending = 0;
    let paid = 0;
    let overdue = 0;
    for (const p of payables) {
      const amt = Number(p.amount);
      total += amt;
      const st = payableDisplayStatus(p);
      if (st === "Pending") pending += amt;
      else if (st === "Paid") paid += amt;
      else if (st === "Overdue") overdue += amt;
    }
    return { total, pending, paid, overdue };
  }, [payables]);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [banksRes, treasuryRes, txRes, payablesRes, clientsRes, invoicesRes] = await Promise.all([
      supabase.from("bank_accounts").select("*").order("created_at", { ascending: false }),
      supabase.from("treasury").select("*").limit(1).maybeSingle(),
      supabase.from("bank_transactions").select("*").order("created_at", { ascending: false }),
      supabase
        .from("expenses")
        .select("*, vendor:vendor_id(id,name), category:category_id(id,name), client:client_id(id,name,client_code)")
        .eq("payment_mode", "Payable")
        .order("due_date", { ascending: true, nullsFirst: false }),
      supabase.from("clients").select("*").order("name"),
      supabase.from("invoices").select("*").order("invoice_date", { ascending: false }),
    ]);
    if (banksRes.error) setError(banksRes.error.message);
    if (treasuryRes.error) setError(treasuryRes.error.message);
    if (txRes.error) setError(txRes.error.message);
    if (payablesRes.error) setError(payablesRes.error.message);
    if (clientsRes.error) setError(clientsRes.error.message);
    if (invoicesRes.error) setError(invoicesRes.error.message);
    setBanks((banksRes.data ?? []) as BankAccount[]);
    setCashBalance(Number(treasuryRes.data?.cash_balance ?? 0));
    setTransactions((txRes.data ?? []) as BankTransaction[]);
    setPayables((payablesRes.data ?? []) as PayableRow[]);

    const allClients = (clientsRes.data ?? []) as Client[];
    const allInvoices = (invoicesRes.data ?? []) as Invoice[];
    const byClient = new Map<string, Invoice[]>();
    for (const inv of allInvoices) {
      const arr = byClient.get(inv.client_id) ?? [];
      arr.push(inv);
      byClient.set(inv.client_id, arr);
    }
    const rec: ReceivableRow[] = allClients.map((c) => {
      const invs = byClient.get(c.id) ?? [];
      const total_invoiced = invs.reduce((s, i) => s + Number(i.invoice_amount), 0);
      const total_received = invs.reduce((s, i) => s + Number(i.amount_received), 0);
      const outstanding = Number(c.opening_balance ?? 0) + total_invoiced - total_received;
      return {
        ...c,
        total_invoiced,
        total_received,
        outstanding,
        invoices: invs,
      };
    });
    setReceivables(rec);

    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

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

  const handleAddBank = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBank.bank_name.trim() || !newBank.account_number.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const opening = newBank.opening_balance ? Number(newBank.opening_balance) : 0;
      const { data, error: insErr } = await supabase
        .from("bank_accounts")
        .insert({
          bank_name: newBank.bank_name.trim(),
          account_number: newBank.account_number.trim(),
          account_type: newBank.account_type,
          opening_balance: opening,
          balance: opening,
        })
        .select()
        .single();
      if (insErr) throw insErr;
      if (opening !== 0) {
        await logTransaction({
          bank_account_id: (data as BankAccount).id,
          kind: "opening",
          amount: opening,
          cash_delta: 0,
          account_delta: opening,
          description: `Opening balance for ${newBank.bank_name.trim()}`,
        });
      }
      setNewBank({ bank_name: "", account_number: "", account_type: "Current", opening_balance: "" });
      setIsBankModalOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openEditBank = (bank: BankAccount) => {
    setSelectedBank(bank);
    setEditBankForm({
      bank_name: bank.bank_name,
      account_number: bank.account_number,
      account_type: bank.account_type,
    });
    setIsEditBankModalOpen(true);
  };

  const handleEditBank = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBank) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: upErr } = await supabase
        .from("bank_accounts")
        .update({
          bank_name: editBankForm.bank_name.trim(),
          account_number: editBankForm.account_number.trim(),
          account_type: editBankForm.account_type,
          updated_at: new Date().toISOString(),
        })
        .eq("id", selectedBank.id);
      if (upErr) throw upErr;
      setIsEditBankModalOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteBank = async (bank: BankAccount) => {
    if (!window.confirm(`Delete "${bank.bank_name} (${bank.account_number})"? Transaction history is preserved (account reference will be cleared).`))
      return;
    setError(null);
    const { error: delErr } = await supabase.from("bank_accounts").delete().eq("id", bank.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const openWithdraw = (bank: BankAccount) => {
    setSelectedBank(bank);
    setWithdrawAmount("");
    setWithdrawNotes("");
    setIsWithdrawModalOpen(true);
  };

  const handleWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBank) return;
    const amount = Number(withdrawAmount);
    if (!amount || amount <= 0) {
      setError("Enter a positive withdrawal amount.");
      return;
    }
    if (amount > Number(selectedBank.balance)) {
      setError("Withdrawal exceeds available account balance.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { error: upErr } = await supabase
        .from("bank_accounts")
        .update({
          balance: Number(selectedBank.balance) - amount,
          updated_at: new Date().toISOString(),
        })
        .eq("id", selectedBank.id);
      if (upErr) throw upErr;
      await applyCashDelta(amount);
      await logTransaction({
        bank_account_id: selectedBank.id,
        kind: "withdraw_to_cash",
        amount,
        cash_delta: amount,
        account_delta: -amount,
        description:
          withdrawNotes.trim() ||
          `Withdraw PKR ${amount.toLocaleString()} from ${selectedBank.bank_name} to cash`,
      });
      setIsWithdrawModalOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openReconcile = (bank: BankAccount) => {
    setSelectedBank(bank);
    setReconcileTarget("account");
    setReconcileValue("");
    setReconcileNotes("");
    setIsReconcileModalOpen(true);
  };

  const handleReconcile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBank) return;
    const actual = Number(reconcileValue);
    if (Number.isNaN(actual)) {
      setError("Enter a numeric actual balance.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (reconcileTarget === "account") {
        const delta = actual - Number(selectedBank.balance);
        if (delta !== 0) {
          const { error: upErr } = await supabase
            .from("bank_accounts")
            .update({ balance: actual, updated_at: new Date().toISOString() })
            .eq("id", selectedBank.id);
          if (upErr) throw upErr;
          await logTransaction({
            bank_account_id: selectedBank.id,
            kind: "reconcile",
            amount: Math.abs(delta),
            cash_delta: 0,
            account_delta: delta,
            description:
              reconcileNotes.trim() ||
              `Reconcile ${selectedBank.bank_name} account balance → PKR ${actual.toLocaleString()}`,
          });
        }
      } else if (reconcileTarget === "cash") {
        const delta = actual - cashBalance;
        if (delta !== 0) {
          await applyCashDelta(delta);
          await logTransaction({
            bank_account_id: null,
            kind: "cash_adjustment",
            amount: Math.abs(delta),
            cash_delta: delta,
            account_delta: 0,
            description:
              reconcileNotes.trim() ||
              `Reconcile cash balance → PKR ${actual.toLocaleString()}`,
          });
        }
      } else {
        // total = cash + sum(account balances). Apply delta to cash balance.
        const delta = actual - grandTotal;
        if (delta !== 0) {
          await applyCashDelta(delta);
          await logTransaction({
            bank_account_id: null,
            kind: "adjustment",
            amount: Math.abs(delta),
            cash_delta: delta,
            account_delta: 0,
            description:
              reconcileNotes.trim() ||
              `Reconcile total balance → PKR ${actual.toLocaleString()} (adjusted via cash)`,
          });
        }
      }
      setIsReconcileModalOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openMarkPaid = (row: PayableRow) => {
    setSelectedPayable(row);
    setMarkPaidVia("Cash");
    setMarkPaidBankId(banks[0]?.id ?? "");
    setIsMarkPaidModalOpen(true);
  };

  const handleMarkPaid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPayable) return;
    const amount = Number(selectedPayable.amount);
    if (!amount || amount <= 0) {
      setError("Invalid payable amount.");
      return;
    }
    if (markPaidVia === "Cash" && amount > cashBalance) {
      setError("Insufficient cash balance.");
      return;
    }
    if (markPaidVia === "Bank") {
      if (!markPaidBankId) {
        setError("Select a bank account.");
        return;
      }
      const bank = banks.find((b) => b.id === markPaidBankId);
      if (!bank) {
        setError("Bank account not found.");
        return;
      }
      if (amount > Number(bank.balance)) {
        setError("Insufficient bank balance.");
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      const nowIso = new Date().toISOString();
      const vendorName = selectedPayable.vendor?.name ?? "vendor";
      if (markPaidVia === "Cash") {
        await applyCashDelta(-amount);
        await logTransaction({
          bank_account_id: null,
          kind: "expense",
          amount,
          cash_delta: -amount,
          account_delta: 0,
          description: `Payable settled (cash) · ${vendorName}`,
          reference_id: selectedPayable.id,
        });
      } else {
        await applyBankDelta(markPaidBankId, -amount);
        await logTransaction({
          bank_account_id: markPaidBankId,
          kind: "expense",
          amount,
          cash_delta: 0,
          account_delta: -amount,
          description: `Payable settled (bank) · ${vendorName}`,
          reference_id: selectedPayable.id,
        });
      }
      const { error: upErr } = await supabase
        .from("expenses")
        .update({
          payable_status: "Paid",
          paid_via: markPaidVia,
          paid_bank_account_id: markPaidVia === "Bank" ? markPaidBankId : null,
          paid_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", selectedPayable.id);
      if (upErr) throw upErr;
      setIsMarkPaidModalOpen(false);
      setSelectedPayable(null);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevertToPending = async (row: PayableRow) => {
    if (row.payable_status !== "Paid") return;
    if (!window.confirm(`Revert payment for "${row.vendor?.name ?? "vendor"}" back to Pending? The original deduction will be reversed.`))
      return;
    setError(null);
    try {
      const amount = Number(row.amount);
      const vendorName = row.vendor?.name ?? "vendor";
      if (row.paid_via === "Cash") {
        await applyCashDelta(amount);
        await logTransaction({
          bank_account_id: null,
          kind: "expense",
          amount,
          cash_delta: amount,
          account_delta: 0,
          description: `Payable reverted to pending (cash refund) · ${vendorName}`,
          reference_id: row.id,
        });
      } else if (row.paid_via === "Bank" && row.paid_bank_account_id) {
        await applyBankDelta(row.paid_bank_account_id, amount);
        await logTransaction({
          bank_account_id: row.paid_bank_account_id,
          kind: "expense",
          amount,
          cash_delta: 0,
          account_delta: amount,
          description: `Payable reverted to pending (bank refund) · ${vendorName}`,
          reference_id: row.id,
        });
      }
      const { error: upErr } = await supabase
        .from("expenses")
        .update({
          payable_status: "Pending",
          paid_via: null,
          paid_bank_account_id: null,
          paid_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (upErr) throw upErr;
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };

  const filteredPayables = useMemo(() => {
    if (payableStatusFilter === "all") return payables;
    return payables.filter((p) => {
      const status = payableDisplayStatus(p);
      if (payableStatusFilter === "pending") return status === "Pending";
      if (payableStatusFilter === "paid") return status === "Paid";
      if (payableStatusFilter === "overdue") return status === "Overdue";
      return true;
    });
  }, [payables, payableStatusFilter]);

  const payablesSummary = useMemo(() => {
    let pendingTotal = 0;
    let paidTotal = 0;
    let overdueTotal = 0;
    for (const p of payables) {
      const status = payableDisplayStatus(p);
      const amt = Number(p.amount);
      if (status === "Pending") pendingTotal += amt;
      else if (status === "Paid") paidTotal += amt;
      else if (status === "Overdue") overdueTotal += amt;
    }
    return { pendingTotal, paidTotal, overdueTotal };
  }, [payables]);

  const viewStatement = (client: ReceivableRow) => {
    setSelectedClient(client);
    setIsStatementModalOpen(true);
  };

  const recordPayment = (client: ReceivableRow) => {
    setSelectedClient(client);
    const openInvoice = client.invoices.find(
      (i) => Number(i.invoice_amount) - Number(i.amount_received) > 0
    );
    setPaymentInvoiceId(openInvoice?.id ?? "");
    setPaymentAmount("");
    setPaymentVia("Bank");
    setPaymentBankId(banks[0]?.id ?? "");
    setPaymentNotes("");
    setIsPaymentModalOpen(true);
  };

  const openEditOpeningBalance = (client: ReceivableRow) => {
    setSelectedClient(client);
    setOpeningBalanceValue(String(client.opening_balance ?? 0));
    setIsOpeningBalanceOpen(true);
  };

  const handleSaveOpeningBalance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClient) return;
    const nextVal = Number(openingBalanceValue);
    if (!Number.isFinite(nextVal) || nextVal < 0) {
      setError("Enter a non-negative opening balance.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { error: upErr } = await supabase
        .from("clients")
        .update({ opening_balance: nextVal })
        .eq("id", selectedClient.id);
      if (upErr) throw upErr;
      setIsOpeningBalanceOpen(false);
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClient) return;
    if (!paymentInvoiceId) {
      setError("Select an invoice to apply this payment to.");
      return;
    }
    const amount = Number(paymentAmount);
    if (!amount || amount <= 0) {
      setError("Enter a positive payment amount.");
      return;
    }
    const invoice = selectedClient.invoices.find((i) => i.id === paymentInvoiceId);
    if (!invoice) {
      setError("Selected invoice not found.");
      return;
    }
    const openAmount = Number(invoice.invoice_amount) - Number(invoice.amount_received);
    if (amount > openAmount) {
      setError(`Payment exceeds the outstanding amount on this invoice (PKR ${openAmount.toLocaleString()}).`);
      return;
    }
    if (paymentVia === "Bank" && !paymentBankId) {
      setError("Select the bank account that received the payment.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (paymentVia === "Cash") {
        await applyCashDelta(amount);
        await logTransaction({
          bank_account_id: null,
          kind: "receipt",
          amount,
          cash_delta: amount,
          account_delta: 0,
          description: `Payment received (cash) · ${selectedClient.name} · Invoice ${invoice.invoice_number}`,
          reference_id: invoice.id,
        });
      } else {
        await applyBankDelta(paymentBankId, amount);
        await logTransaction({
          bank_account_id: paymentBankId,
          kind: "receipt",
          amount,
          cash_delta: 0,
          account_delta: amount,
          description: `Payment received (bank) · ${selectedClient.name} · Invoice ${invoice.invoice_number}`,
          reference_id: invoice.id,
        });
      }
      const { error: upErr } = await supabase
        .from("invoices")
        .update({
          amount_received: Number(invoice.amount_received) + amount,
          notes: paymentNotes.trim()
            ? `${invoice.notes ? invoice.notes + "\n" : ""}[${new Date().toISOString().slice(0, 10)}] Payment PKR ${amount.toLocaleString()} via ${paymentVia}: ${paymentNotes.trim()}`
            : invoice.notes,
          updated_at: new Date().toISOString(),
        })
        .eq("id", invoice.id);
      if (upErr) throw upErr;
      setIsPaymentModalOpen(false);
      await loadAll();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const viewInvoiceAttachment = (path: string) => {
    const { data } = supabase.storage.from(INVOICE_ATTACHMENTS_BUCKET).getPublicUrl(path);
    if (data?.publicUrl) window.open(data.publicUrl, "_blank");
  };

  return (
    <>
      <Header
        title="Financial Accounting"
        actions={
          <>
            <ExportButton
              onExport={async () => {
                if (activeTab === "receivables") {
                  const invoiceIds = receivables.flatMap((r) => r.invoices.map((i) => i.id));
                  let paymentsByInvoice = new Map<string, any[]>();
                  if (invoiceIds.length > 0) {
                    const { data: payRows } = await supabase
                      .from("invoice_payments")
                      .select("invoice_id, amount, payment_date, payment_mode, bank_account_id")
                      .in("invoice_id", invoiceIds);
                    for (const p of payRows ?? []) {
                      if (!paymentsByInvoice.has(p.invoice_id)) {
                        paymentsByInvoice.set(p.invoice_id, []);
                      }
                      paymentsByInvoice.get(p.invoice_id)!.push(p);
                    }
                  }
                  const ledgerClients = receivables
                    .filter((c) => c.invoices.length > 0 || Number(c.opening_balance ?? 0) > 0)
                    .map((c) => {
                      const entries: LedgerEntry[] = [];
                      const open = Number(c.opening_balance ?? 0);
                      if (open > 0) {
                        entries.push({
                          kind: "invoice",
                          date: c.created_at ?? "1970-01-01",
                          description: "Opening Balance",
                          invoiceAmount: open,
                        });
                      }
                      for (const inv of c.invoices) {
                        entries.push({
                          kind: "invoice",
                          date: inv.invoice_date,
                          description: `Invoice ${inv.invoice_number}`,
                          invoiceAmount: Number(inv.invoice_amount),
                        });
                        const payments = paymentsByInvoice.get(inv.id) ?? [];
                        for (const p of payments) {
                          const bankName =
                            p.payment_mode === "Bank" && p.bank_account_id
                              ? banks.find((b) => b.id === p.bank_account_id)?.bank_name ?? "Bank"
                              : "Cash";
                          entries.push({
                            kind: "payment",
                            date: p.payment_date,
                            description: `Payment via ${bankName} · Invoice ${inv.invoice_number}`,
                            amount: Number(p.amount),
                          });
                        }
                      }
                      return {
                        name: `${c.name} (${c.client_code})`,
                        entries,
                      };
                    });
                  exportReceivableLedger(ledgerClients, "Receivable Ledger.xlsx");
                } else if (activeTab === "payables") {
                  const filtered = payables.filter((p) => {
                    if (payableStatusFilter === "all") return true;
                    return payableDisplayStatus(p).toLowerCase() === payableStatusFilter;
                  });
                  exportTable({
                    fileName: "Accounts Payable.xlsx",
                    sheetName: "Payables",
                    title: "Accounts Payable",
                    headers: [
                      "Date",
                      "Vendor",
                      "Category",
                      "Client",
                      "Description",
                      "Amount",
                      "Due Date",
                      "Status",
                    ],
                    rows: filtered.map((p) => [
                      p.expense_date,
                      p.vendor?.name ?? "",
                      p.category?.name ?? "",
                      p.client?.name ?? "",
                      p.description ?? "",
                      Number(p.amount),
                      p.due_date ?? "",
                      payableDisplayStatus(p),
                    ]),
                  });
                } else if (activeTab === "banks") {
                  exportTable({
                    fileName: "Bank Accounts.xlsx",
                    sheetName: "Bank Accounts",
                    title: "Bank Accounts",
                    headers: ["Bank Name", "Account Number", "Type", "Balance"],
                    rows: banks.map((b) => [
                      b.bank_name,
                      b.account_number,
                      b.account_type,
                      Number(b.balance ?? 0),
                    ]),
                  });
                }
              }}
            />
            {activeTab === "banks" && (
              <>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => {
                    setLogBankFilter("all");
                    setLogScope("all");
                    setIsLogModalOpen(true);
                  }}
                >
                  <History className="w-4 h-4 mr-2" strokeWidth={1.5} />
                  Transactions
                </Button>
                <Button variant="primary" size="md" onClick={() => setIsBankModalOpen(true)}>
                  <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                  Add Bank Account
                </Button>
              </>
            )}
            {activeTab === "receivables" && (
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setLogBankFilter("all");
                  setLogScope("all");
                  setIsReceivablesLogOpen(true);
                }}
              >
                <History className="w-4 h-4 mr-2" strokeWidth={1.5} />
                History
              </Button>
            )}
            {activeTab === "payables" && (
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setLogBankFilter("all");
                  setLogScope("all");
                  setIsPayablesLogOpen(true);
                }}
              >
                <History className="w-4 h-4 mr-2" strokeWidth={1.5} />
                History
              </Button>
            )}
          </>
        }
      />

      <div className="flex-1 overflow-y-auto p-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 text-red-700 border border-red-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {activeTab === "banks" && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-green-50 p-4 rounded-lg border border-green-200">
              <p className="text-xs text-green-700 mb-1">Cash Balance (Treasury)</p>
              <p className="text-2xl text-green-900">PKR {cashBalance.toLocaleString()}</p>
            </div>
            <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
              <p className="text-xs text-blue-700 mb-1">Total Account Balance</p>
              <p className="text-2xl text-blue-900">PKR {totalAccountBalance.toLocaleString()}</p>
            </div>
            <div className="bg-slate-900 p-4 rounded-lg">
              <p className="text-xs text-slate-300 mb-1">Total Balance</p>
              <p className="text-2xl text-white">PKR {grandTotal.toLocaleString()}</p>
            </div>
          </div>
        )}

        {activeTab === "receivables" && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
              <p className="text-xs text-slate-600 mb-1">Opening Balance</p>
              <p className="text-xl text-slate-900">
                PKR {receivableTotals.opening.toLocaleString()}
              </p>
            </div>
            <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
              <p className="text-xs text-blue-700 mb-1">Total Invoiced</p>
              <p className="text-xl text-blue-900">
                PKR {receivableTotals.invoiced.toLocaleString()}
              </p>
            </div>
            <div className="bg-green-50 p-4 rounded-lg border border-green-200">
              <p className="text-xs text-green-700 mb-1">Total Received</p>
              <p className="text-xl text-green-900">
                PKR {receivableTotals.received.toLocaleString()}
              </p>
            </div>
            <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
              <p className="text-xs text-amber-700 mb-1">Outstanding</p>
              <p className="text-xl text-amber-900">
                PKR {receivableTotals.outstanding.toLocaleString()}
              </p>
            </div>
          </div>
        )}

        {activeTab === "payables" && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-slate-900 p-4 rounded-lg">
              <p className="text-xs text-slate-300 mb-1">Total Payable</p>
              <p className="text-xl text-white">
                PKR {payableTotals.total.toLocaleString()}
              </p>
            </div>
            <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
              <p className="text-xs text-amber-700 mb-1">Pending</p>
              <p className="text-xl text-amber-900">
                PKR {payableTotals.pending.toLocaleString()}
              </p>
            </div>
            <div className="bg-red-50 p-4 rounded-lg border border-red-200">
              <p className="text-xs text-red-700 mb-1">Overdue</p>
              <p className="text-xl text-red-900">
                PKR {payableTotals.overdue.toLocaleString()}
              </p>
            </div>
            <div className="bg-green-50 p-4 rounded-lg border border-green-200">
              <p className="text-xs text-green-700 mb-1">Paid</p>
              <p className="text-xl text-green-900">
                PKR {payableTotals.paid.toLocaleString()}
              </p>
            </div>
          </div>
        )}

        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-6 border-b border-slate-200">
            <div className="flex gap-2">
              {(["receivables", "payables", "banks"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 rounded-md text-sm transition-colors ${
                    activeTab === tab
                      ? "bg-blue-600 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {tab === "receivables" && "Client Receivables"}
                  {tab === "payables" && "Accounts Payable"}
                  {tab === "banks" && "Bank Accounts"}
                </button>
              ))}
            </div>
          </div>

          {activeTab === "receivables" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Opening Balance</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Invoiced</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Received</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Outstanding</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {loading && (
                    <tr>
                      <td colSpan={6} className="px-6 py-10 text-center text-slate-500">
                        <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                      </td>
                    </tr>
                  )}
                  {!loading && receivables.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-6 py-10 text-center text-slate-500 text-sm">
                        No clients yet. Add them from Settings.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    receivables.map((item) => {
                      const canEditOpening = item.outstanding === 0;
                      return (
                        <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-6 py-4 text-sm text-slate-900">
                            <div className="flex items-center gap-2">
                              <Building2 className="w-3.5 h-3.5 text-slate-400" strokeWidth={1.5} />
                              <span>{item.name}</span>
                            </div>
                            <div className="text-xs text-slate-500 font-mono ml-5">{item.client_code}</div>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-700 text-right">
                            <div className="inline-flex items-center gap-2 justify-end">
                              <span>PKR {Number(item.opening_balance ?? 0).toLocaleString()}</span>
                              <button
                                type="button"
                                disabled={!canEditOpening}
                                onClick={() => openEditOpeningBalance(item)}
                                className={`inline-flex items-center justify-center w-6 h-6 rounded ${
                                  canEditOpening
                                    ? "text-slate-600 hover:bg-slate-100"
                                    : "text-slate-300 cursor-not-allowed"
                                }`}
                                title={
                                  canEditOpening
                                    ? "Edit opening balance"
                                    : "Clear outstanding balance before editing opening balance"
                                }
                              >
                                <Pencil className="w-3 h-3" strokeWidth={1.5} />
                              </button>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-blue-600 text-right">
                            PKR {item.total_invoiced.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-sm text-green-600 text-right">
                            PKR {item.total_received.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-sm text-right">
                            <span className={item.outstanding > 0 ? "text-amber-600" : "text-green-600"}>
                              PKR {item.outstanding.toLocaleString()}
                            </span>
                          </td>
                          <td className="px-6 py-4 flex gap-2">
                            <Button variant="ghost" size="sm" onClick={() => viewStatement(item)}>
                              View Statement
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => recordPayment(item)}
                              disabled={item.invoices.every(
                                (i) => Number(i.invoice_amount) - Number(i.amount_received) <= 0
                              )}
                            >
                              Record Payment
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "payables" && (
            <>
              <div className="p-6 border-b border-slate-200 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-slate-500">Status:</span>
                  {(["all", "pending", "overdue", "paid"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setPayableStatusFilter(s)}
                      className={`px-3 py-1 rounded-md text-xs capitalize transition-colors ${
                        payableStatusFilter === s
                          ? "bg-slate-900 text-white"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <div className="ml-auto flex flex-wrap gap-3 text-xs">
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-50 text-amber-800">
                    Pending: PKR {payablesSummary.pendingTotal.toLocaleString()}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-red-50 text-red-700">
                    Overdue: PKR {payablesSummary.overdueTotal.toLocaleString()}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-50 text-emerald-700">
                    Paid: PKR {payablesSummary.paidTotal.toLocaleString()}
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Vendor</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Category</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Amount Due</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Expense Date</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Due Date</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {loading && (
                      <tr>
                        <td colSpan={8} className="px-6 py-10 text-center text-slate-500">
                          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                          Loading…
                        </td>
                      </tr>
                    )}
                    {!loading && filteredPayables.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-6 py-10 text-center text-slate-500 text-sm">
                          {payables.length === 0
                            ? "No payables yet. Create an expense with payment mode 'Payable' to see it here."
                            : "No payables match the selected filter."}
                        </td>
                      </tr>
                    )}
                    {!loading &&
                      filteredPayables.map((item) => {
                        const status = payableDisplayStatus(item);
                        const statusClass =
                          status === "Paid"
                            ? "bg-emerald-50 text-emerald-700"
                            : status === "Overdue"
                            ? "bg-red-50 text-red-700"
                            : "bg-amber-50 text-amber-700";
                        return (
                          <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-4 text-sm text-slate-900">{item.vendor?.name ?? "—"}</td>
                            <td className="px-6 py-4 text-sm text-slate-600">{item.category?.name ?? "—"}</td>
                            <td className="px-6 py-4 text-sm text-slate-600">
                              {item.client?.name ?? <span className="text-slate-400">Office</span>}
                            </td>
                            <td className="px-6 py-4 text-sm text-red-600">
                              PKR {Number(item.amount).toLocaleString()}
                            </td>
                            <td className="px-6 py-4 text-sm text-slate-600">{item.expense_date}</td>
                            <td className="px-6 py-4 text-sm text-slate-600">{item.due_date ?? "—"}</td>
                            <td className="px-6 py-4">
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${statusClass}`}>
                                {status}
                              </span>
                              {status === "Paid" && item.paid_via && (
                                <div className="text-[10px] text-slate-500 mt-1">
                                  via {item.paid_via}
                                  {item.paid_at ? ` · ${new Date(item.paid_at).toLocaleDateString()}` : ""}
                                </div>
                              )}
                            </td>
                            <td className="px-6 py-4">
                              {item.payable_status === "Paid" ? (
                                <Button variant="ghost" size="sm" onClick={() => handleRevertToPending(item)}>
                                  <RotateCcw className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                                  Revert
                                </Button>
                              ) : (
                                <Button variant="ghost" size="sm" onClick={() => openMarkPaid(item)}>
                                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                                  Mark Paid
                                </Button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {activeTab === "banks" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Bank Name</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Account Number</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Account Balance</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {loading && (
                    <tr>
                      <td colSpan={5} className="px-6 py-10 text-center text-slate-500">
                        <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                        Loading…
                      </td>
                    </tr>
                  )}
                  {!loading && banks.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-10 text-center text-slate-500 text-sm">
                        No bank accounts yet. Click "Add Bank Account" to create one.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    banks.map((bank) => {
                      const acct = Number(bank.balance ?? 0);
                      return (
                        <tr key={bank.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <Building2 className="w-4 h-4 text-blue-600" strokeWidth={1.5} />
                              <span className="text-sm text-slate-900">{bank.bank_name}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600 font-mono">{bank.account_number}</td>
                          <td className="px-6 py-4 text-sm text-slate-600">{bank.account_type}</td>
                          <td className="px-6 py-4 text-sm text-blue-600">PKR {acct.toLocaleString()}</td>
                          <td className="px-6 py-4 flex gap-2 flex-wrap">
                            <Button variant="ghost" size="sm" onClick={() => openWithdraw(bank)}>
                              <ArrowDownUp className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                              Withdraw
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openReconcile(bank)}>
                              Reconcile
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openEditBank(bank)}>
                              Edit
                            </Button>
                            <button
                              type="button"
                              onClick={() => handleDeleteBank(bank)}
                              className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-red-700 hover:bg-red-50"
                              title="Delete bank account"
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
          )}
        </div>
      </div>

      <Modal isOpen={isBankModalOpen} onClose={() => setIsBankModalOpen(false)} title="Add Bank Account" size="md">
        <form className="space-y-4" onSubmit={handleAddBank}>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Bank Name *</label>
            <input
              required
              type="text"
              value={newBank.bank_name}
              onChange={(e) => setNewBank({ ...newBank, bank_name: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="e.g., Allied Bank"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Number *</label>
            <input
              required
              type="text"
              value={newBank.account_number}
              onChange={(e) => setNewBank({ ...newBank, account_number: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="Enter account number"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Type</label>
            <select
              value={newBank.account_type}
              onChange={(e) => setNewBank({ ...newBank, account_type: e.target.value as "Current" | "Savings" })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            >
              <option value="Current">Current</option>
              <option value="Savings">Savings</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Opening Balance (PKR)</label>
            <input
              type="number"
              value={newBank.opening_balance}
              onChange={(e) => setNewBank({ ...newBank, opening_balance: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="0"
            />
            <p className="text-xs text-slate-500 mt-1">
              Seeded into Account Balance and logged as an opening transaction.
            </p>
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
              {submitting ? "Saving…" : "Add Bank Account"}
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsBankModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isWithdrawModalOpen} onClose={() => setIsWithdrawModalOpen(false)} title="Withdraw to Cash" size="md">
        {selectedBank && (
          <form className="space-y-4" onSubmit={handleWithdraw}>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Bank Account</label>
              <input
                type="text"
                value={`${selectedBank.bank_name} · ${selectedBank.account_number}`}
                disabled
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-slate-700 mb-1">Account Balance</label>
                <input
                  type="text"
                  value={`PKR ${Number(selectedBank.balance).toLocaleString()}`}
                  disabled
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Cash Balance</label>
                <input
                  type="text"
                  value={`PKR ${cashBalance.toLocaleString()}`}
                  disabled
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Amount to Withdraw (PKR) *</label>
              <input
                required
                type="number"
                min={1}
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
                placeholder="0"
              />
              <p className="text-xs text-slate-500 mt-1">
                Deducts from Account Balance and adds to Cash Balance.
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Notes</label>
              <textarea
                value={withdrawNotes}
                onChange={(e) => setWithdrawNotes(e.target.value)}
                rows={2}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              />
            </div>
            <div className="flex items-center gap-3 pt-2">
              <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
                {submitting ? "Processing…" : "Withdraw"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsWithdrawModalOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal isOpen={isStatementModalOpen} onClose={() => setIsStatementModalOpen(false)} title="Client Statement" size="lg">
        {selectedClient && (
          <div className="space-y-4">
            <div className="pb-4 border-b border-slate-200">
              <h3 className="text-base text-slate-900">{selectedClient.name}</h3>
              <p className="text-xs text-slate-500 font-mono">{selectedClient.client_code}</p>
            </div>

            <div className="grid grid-cols-4 gap-3">
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                <p className="text-xs text-slate-600 mb-1">Opening Balance</p>
                <p className="text-lg text-slate-900">PKR {Number(selectedClient.opening_balance ?? 0).toLocaleString()}</p>
              </div>
              <div className="bg-blue-50 p-3 rounded-lg border border-blue-200">
                <p className="text-xs text-blue-700 mb-1">Total Invoiced</p>
                <p className="text-lg text-blue-900">PKR {selectedClient.total_invoiced.toLocaleString()}</p>
              </div>
              <div className="bg-green-50 p-3 rounded-lg border border-green-200">
                <p className="text-xs text-green-700 mb-1">Received</p>
                <p className="text-lg text-green-900">PKR {selectedClient.total_received.toLocaleString()}</p>
              </div>
              <div className="bg-amber-50 p-3 rounded-lg border border-amber-200">
                <p className="text-xs text-amber-700 mb-1">Outstanding</p>
                <p className="text-lg text-amber-900">PKR {selectedClient.outstanding.toLocaleString()}</p>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200">
              <h4 className="text-sm text-slate-900 mb-3">Invoices</h4>
              {selectedClient.invoices.length === 0 ? (
                <p className="text-sm text-slate-500">No invoices yet for this client.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="text-left px-3 py-2 text-xs text-slate-500">Invoice #</th>
                        <th className="text-left px-3 py-2 text-xs text-slate-500">Date</th>
                        <th className="text-right px-3 py-2 text-xs text-slate-500">Amount</th>
                        <th className="text-right px-3 py-2 text-xs text-slate-500">Received</th>
                        <th className="text-right px-3 py-2 text-xs text-slate-500">Outstanding</th>
                        <th className="text-left px-3 py-2 text-xs text-slate-500">Attachment</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedClient.invoices.map((inv) => {
                        const out = Number(inv.invoice_amount) - Number(inv.amount_received);
                        return (
                          <tr key={inv.id}>
                            <td className="px-3 py-2 text-xs font-mono text-slate-900">{inv.invoice_number}</td>
                            <td className="px-3 py-2 text-xs text-slate-600">{inv.invoice_date}</td>
                            <td className="px-3 py-2 text-xs text-right text-blue-600">
                              PKR {Number(inv.invoice_amount).toLocaleString()}
                            </td>
                            <td className="px-3 py-2 text-xs text-right text-green-600">
                              PKR {Number(inv.amount_received).toLocaleString()}
                            </td>
                            <td className="px-3 py-2 text-xs text-right">
                              <span className={out > 0 ? "text-amber-600" : "text-green-600"}>
                                PKR {out.toLocaleString()}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-xs">
                              {inv.attachment_path ? (
                                <button
                                  type="button"
                                  onClick={() => viewInvoiceAttachment(inv.attachment_path!)}
                                  className="text-blue-600 hover:text-blue-700 inline-flex items-center gap-1"
                                >
                                  <FileText className="w-3 h-3" strokeWidth={1.5} />
                                  View
                                </button>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
              <Button variant="primary" size="md" className="flex-1" onClick={() => window.print()}>
                <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Print / Save PDF
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsStatementModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={isOpeningBalanceOpen} onClose={() => setIsOpeningBalanceOpen(false)} title="Edit Opening Balance" size="md">
        {selectedClient && (
          <form className="space-y-4" onSubmit={handleSaveOpeningBalance}>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Client</label>
              <input
                type="text"
                value={selectedClient.name}
                disabled
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Opening Balance (PKR) *</label>
              <input
                required
                type="number"
                min="0"
                step="0.01"
                value={openingBalanceValue}
                onChange={(e) => setOpeningBalanceValue(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
              <p className="text-xs text-slate-500 mt-1">
                Editable only while the client has no outstanding balance. Adds on top of invoice totals.
              </p>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
                {submitting ? "Saving…" : "Save"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsOpeningBalanceOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal isOpen={isPaymentModalOpen} onClose={() => setIsPaymentModalOpen(false)} title="Record Payment" size="md">
        {selectedClient && (
          <form className="space-y-4" onSubmit={handleRecordPayment}>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Client</label>
              <input
                type="text"
                value={selectedClient.name}
                disabled
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Apply to Invoice *</label>
              <select
                required
                value={paymentInvoiceId}
                onChange={(e) => setPaymentInvoiceId(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="">Select an open invoice…</option>
                {selectedClient.invoices
                  .filter((i) => Number(i.invoice_amount) - Number(i.amount_received) > 0)
                  .map((i) => {
                    const out = Number(i.invoice_amount) - Number(i.amount_received);
                    return (
                      <option key={i.id} value={i.id}>
                        {i.invoice_number} · {i.invoice_date} · Outstanding PKR {out.toLocaleString()}
                      </option>
                    );
                  })}
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Payment Amount (PKR) *</label>
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-2">Received Via *</label>
              <div className="grid grid-cols-2 gap-2">
                {(["Cash", "Bank"] as const).map((v) => (
                  <label
                    key={v}
                    className={`flex items-center justify-center gap-2 px-3 py-2 border rounded-md cursor-pointer text-sm ${
                      paymentVia === v
                        ? "border-slate-900 bg-slate-50"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="pay-via"
                      checked={paymentVia === v}
                      onChange={() => setPaymentVia(v)}
                    />
                    <span>{v}</span>
                  </label>
                ))}
              </div>
            </div>
            {paymentVia === "Bank" && (
              <div>
                <label className="block text-sm text-slate-700 mb-1">Bank Account *</label>
                <select
                  required
                  value={paymentBankId}
                  onChange={(e) => setPaymentBankId(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                >
                  <option value="">Select bank account…</option>
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.bank_name} · {b.account_number}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm text-slate-700 mb-1">Notes</label>
              <textarea
                value={paymentNotes}
                onChange={(e) => setPaymentNotes(e.target.value)}
                rows={2}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
            </div>
            <div className="flex items-center gap-3 pt-2">
              <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
                {submitting ? "Recording…" : "Record Payment"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsPaymentModalOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal isOpen={isReconcileModalOpen} onClose={() => setIsReconcileModalOpen(false)} title="Reconcile" size="md">
        {selectedBank && (
          <form className="space-y-4" onSubmit={handleReconcile}>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Bank Account</label>
              <input
                type="text"
                value={`${selectedBank.bank_name} · ${selectedBank.account_number}`}
                disabled
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-2">Reconcile Against</label>
              <div className="grid grid-cols-3 gap-2">
                {(["account", "cash", "total"] as const).map((t) => (
                  <label
                    key={t}
                    className={`flex items-center justify-center gap-2 px-3 py-2 border rounded-md cursor-pointer text-sm capitalize ${
                      reconcileTarget === t
                        ? "border-slate-900 bg-slate-50"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="rec-target"
                      checked={reconcileTarget === t}
                      onChange={() => setReconcileTarget(t)}
                    />
                    <span>{t === "account" ? "Account Balance" : t === "cash" ? "Cash Balance" : "Total Balance"}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Current System Balance</label>
              <input
                type="text"
                value={`PKR ${(reconcileTarget === "account"
                  ? Number(selectedBank.balance)
                  : reconcileTarget === "cash"
                  ? cashBalance
                  : grandTotal
                ).toLocaleString()}`}
                disabled
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Actual Balance (PKR) *</label>
              <input
                required
                type="number"
                value={reconcileValue}
                onChange={(e) => setReconcileValue(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              />
              <p className="text-xs text-slate-500 mt-1">
                {reconcileTarget === "account" && "Updates this bank account's balance."}
                {reconcileTarget === "cash" && "Updates the global cash balance."}
                {reconcileTarget === "total" && "Adjusts the cash balance to match the desired total."}
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Notes</label>
              <textarea
                value={reconcileNotes}
                onChange={(e) => setReconcileNotes(e.target.value)}
                rows={2}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              />
            </div>
            <div className="flex items-center gap-3 pt-2">
              <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
                {submitting ? "Saving…" : "Complete Reconciliation"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsReconcileModalOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal isOpen={isEditBankModalOpen} onClose={() => setIsEditBankModalOpen(false)} title="Edit Bank Account" size="md">
        {selectedBank && (
          <form className="space-y-4" onSubmit={handleEditBank}>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Bank Name</label>
              <input
                required
                type="text"
                value={editBankForm.bank_name}
                onChange={(e) => setEditBankForm({ ...editBankForm, bank_name: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Account Number</label>
              <input
                required
                type="text"
                value={editBankForm.account_number}
                onChange={(e) => setEditBankForm({ ...editBankForm, account_number: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Account Type</label>
              <select
                value={editBankForm.account_type}
                onChange={(e) => setEditBankForm({ ...editBankForm, account_type: e.target.value as "Current" | "Savings" })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              >
                <option value="Current">Current</option>
                <option value="Savings">Savings</option>
              </select>
            </div>
            <p className="text-xs text-slate-500">
              Balance cannot be edited here — use Reconcile to adjust.
            </p>
            <div className="flex items-center gap-3 pt-4">
              <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
                {submitting ? "Saving…" : "Update Account"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsEditBankModalOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal isOpen={isMarkPaidModalOpen} onClose={() => setIsMarkPaidModalOpen(false)} title="Mark Payable as Paid" size="md">
        {selectedPayable && (
          <form className="space-y-4" onSubmit={handleMarkPaid}>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-slate-700 mb-1">Vendor</label>
                <input
                  type="text"
                  value={selectedPayable.vendor?.name ?? "—"}
                  disabled
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Amount Due</label>
                <input
                  type="text"
                  value={`PKR ${Number(selectedPayable.amount).toLocaleString()}`}
                  disabled
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-2">Pay Via *</label>
              <div className="grid grid-cols-2 gap-2">
                {(["Cash", "Bank"] as const).map((v) => (
                  <label
                    key={v}
                    className={`flex items-center justify-center gap-2 px-3 py-2 border rounded-md cursor-pointer text-sm ${
                      markPaidVia === v
                        ? "border-slate-900 bg-slate-50"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="mark-paid-via"
                      checked={markPaidVia === v}
                      onChange={() => setMarkPaidVia(v)}
                    />
                    <span>{v}</span>
                  </label>
                ))}
              </div>
            </div>
            {markPaidVia === "Cash" && (
              <div>
                <label className="block text-sm text-slate-700 mb-1">Cash Balance</label>
                <input
                  type="text"
                  value={`PKR ${cashBalance.toLocaleString()}`}
                  disabled
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
                />
              </div>
            )}
            {markPaidVia === "Bank" && (
              <div>
                <label className="block text-sm text-slate-700 mb-1">Bank Account *</label>
                <select
                  required
                  value={markPaidBankId}
                  onChange={(e) => setMarkPaidBankId(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
                >
                  <option value="">Select bank account…</option>
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.bank_name} · {b.account_number} (PKR {Number(b.balance).toLocaleString()})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-center gap-3 pt-2">
              <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
                {submitting ? "Processing…" : "Confirm Payment"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsMarkPaidModalOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal isOpen={isLogModalOpen} onClose={() => setIsLogModalOpen(false)} title="Transaction Log" size="lg">
        <HistoryBody
          transactions={transactions}
          banks={banks}
          balanceLedger={balanceLedger}
          bankFilter={logBankFilter}
          setBankFilter={setLogBankFilter}
          scope={logScope}
          setScope={setLogScope}
          onClose={() => setIsLogModalOpen(false)}
          emptyText="No transactions yet."
        />
      </Modal>

      <Modal
        isOpen={isReceivablesLogOpen}
        onClose={() => setIsReceivablesLogOpen(false)}
        title="Receivables History"
        size="lg"
      >
        <HistoryBody
          transactions={transactions.filter((t) => t.kind === "receipt")}
          banks={banks}
          balanceLedger={balanceLedger}
          bankFilter={logBankFilter}
          setBankFilter={setLogBankFilter}
          scope={logScope}
          setScope={setLogScope}
          onClose={() => setIsReceivablesLogOpen(false)}
          emptyText="No receipts recorded yet."
        />
      </Modal>

      <Modal
        isOpen={isPayablesLogOpen}
        onClose={() => setIsPayablesLogOpen(false)}
        title="Payables History"
        size="lg"
      >
        <HistoryBody
          transactions={transactions.filter((t) => t.kind === "expense")}
          banks={banks}
          balanceLedger={balanceLedger}
          bankFilter={logBankFilter}
          setBankFilter={setLogBankFilter}
          scope={logScope}
          setScope={setLogScope}
          onClose={() => setIsPayablesLogOpen(false)}
          emptyText="No payable settlements yet."
        />
      </Modal>
    </>
  );
}

type LedgerEntry = {
  cash?: { before: number; after: number };
  bank?: { before: number; after: number };
};

function HistoryBody({
  transactions,
  banks,
  balanceLedger,
  bankFilter,
  setBankFilter,
  scope,
  setScope,
  onClose,
  emptyText,
}: {
  transactions: BankTransaction[];
  banks: BankAccount[];
  balanceLedger: Map<string, LedgerEntry>;
  bankFilter: string;
  setBankFilter: (v: string) => void;
  scope: "all" | "cash" | "account";
  setScope: (s: "all" | "cash" | "account") => void;
  onClose: () => void;
  emptyText: string;
}) {
  const filtered = transactions.filter((t) => {
    if (bankFilter !== "all") {
      if (bankFilter === "__cash__") {
        if (Number(t.cash_delta) === 0) return false;
      } else {
        if (t.bank_account_id !== bankFilter) return false;
      }
    }
    if (scope === "cash" && Number(t.cash_delta) === 0) return false;
    if (scope === "account" && Number(t.account_delta) === 0) return false;
    return true;
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 items-center pb-3 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">Account</label>
          <select
            value={bankFilter}
            onChange={(e) => setBankFilter(e.target.value)}
            className="px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            <option value="all">All accounts</option>
            <option value="__cash__">Cash (Treasury)</option>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.bank_name} · {b.account_number}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          {(["all", "cash", "account"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`px-3 py-1.5 rounded-md text-xs ${
                scope === s
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              {s === "all" ? "All" : s === "cash" ? "Cash only" : "Account only"}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-slate-500">
          {filtered.length} entr{filtered.length === 1 ? "y" : "ies"}
        </span>
      </div>

      <div className="max-h-[60vh] overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-sm text-slate-500 py-6 text-center">{emptyText}</p>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-slate-200">
                <th className="text-left px-3 py-2 text-xs text-slate-500">Date</th>
                <th className="text-left px-3 py-2 text-xs text-slate-500">Kind</th>
                <th className="text-left px-3 py-2 text-xs text-slate-500">Account</th>
                <th className="text-right px-3 py-2 text-xs text-slate-500">Δ</th>
                <th className="text-right px-3 py-2 text-xs text-slate-500">Before → After</th>
                <th className="text-left px-3 py-2 text-xs text-slate-500">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {filtered.map((t) => {
                const bank = banks.find((b) => b.id === t.bank_account_id);
                const ledger = balanceLedger.get(t.id) ?? {};
                const cd = Number(t.cash_delta);
                const ad = Number(t.account_delta);
                return (
                  <tr key={t.id}>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {t.created_at ? new Date(t.created_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-700">{kindLabel[t.kind]}</td>
                    <td className="px-3 py-2 text-xs text-slate-700">
                      {ad !== 0 && bank ? bank.bank_name : cd !== 0 ? "Cash" : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-right font-mono">
                      {ad !== 0 && (
                        <div
                          className={
                            ad > 0 ? "text-emerald-700" : ad < 0 ? "text-red-700" : "text-slate-500"
                          }
                        >
                          {ad > 0 ? "+" : ""}
                          {ad.toLocaleString()}
                        </div>
                      )}
                      {cd !== 0 && (
                        <div
                          className={
                            cd > 0 ? "text-emerald-700" : cd < 0 ? "text-red-700" : "text-slate-500"
                          }
                        >
                          {cd > 0 ? "+" : ""}
                          {cd.toLocaleString()}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-right font-mono text-slate-700">
                      {ledger.bank && (
                        <div>
                          <span className="text-slate-400">Bank </span>
                          {ledger.bank.before.toLocaleString()} →{" "}
                          {ledger.bank.after.toLocaleString()}
                        </div>
                      )}
                      {ledger.cash && (
                        <div>
                          <span className="text-slate-400">Cash </span>
                          {ledger.cash.before.toLocaleString()} →{" "}
                          {ledger.cash.after.toLocaleString()}
                        </div>
                      )}
                      {!ledger.bank && !ledger.cash && <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">{t.description ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
        <Button variant="secondary" size="md" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
