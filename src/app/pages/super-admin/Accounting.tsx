import { useEffect, useMemo, useState } from "react";
import { Plus, Building2, Download, AlertCircle, X, Loader2, ArrowDownUp, History, Trash2, CheckCircle2, RotateCcw } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import {
  supabase,
  type BankAccount,
  type BankTransaction,
  type BankTransactionKind,
  type Expense,
  type Vendor,
  type ExpenseCategory,
  type Client,
} from "../../lib/supabase";

type PayableRow = Expense & {
  vendor?: Vendor | null;
  category?: ExpenseCategory | null;
  client?: Client | null;
};

const chartOfAccounts = [
  { id: 1, code: "1000", name: "Assets", type: "Header", balance: 5250000 },
  { id: 2, code: "1100", name: "Current Assets", type: "Subheader", balance: 5250000 },
  { id: 3, code: "1110", name: "Cash and Bank", type: "Detail", balance: 5250000 },
  { id: 4, code: "2000", name: "Liabilities", type: "Header", balance: 1200000 },
  { id: 5, code: "2100", name: "Current Liabilities", type: "Subheader", balance: 1200000 },
  { id: 6, code: "2110", name: "Accounts Payable", type: "Detail", balance: 1200000 },
  { id: 7, code: "3000", name: "Equity", type: "Header", balance: 4050000 },
  { id: 8, code: "4000", name: "Revenue", type: "Header", balance: 1640000 },
  { id: 9, code: "5000", name: "Expenses", type: "Header", balance: 845000 },
];

const receivables = [
  { id: 1, client: "Client A - Security Services", amount: 450000, dueDate: "2026-04-25", status: "Pending" },
  { id: 2, client: "Client B - Guard Deployment", amount: 380000, dueDate: "2026-04-30", status: "Pending" },
  { id: 3, client: "Client C - Facility Management", amount: 520000, dueDate: "2026-05-05", status: "Overdue" },
  { id: 4, client: "Client D - Event Security", amount: 290000, dueDate: "2026-05-10", status: "Pending" },
];

const kindLabel: Record<BankTransactionKind, string> = {
  opening: "Opening",
  deposit: "Deposit",
  withdraw_to_cash: "Withdraw to Cash",
  payroll: "Payroll",
  reconcile: "Reconcile (Bank)",
  adjustment: "Adjustment",
  cash_adjustment: "Cash Adjustment",
  expense: "Expense",
};

const todayStr = () => new Date().toISOString().slice(0, 10);

type PayableDisplayStatus = "Pending" | "Paid" | "Overdue";

const payableDisplayStatus = (row: PayableRow): PayableDisplayStatus => {
  if (row.payable_status === "Paid") return "Paid";
  if (row.due_date && row.due_date < todayStr()) return "Overdue";
  return "Pending";
};

export default function Accounting() {
  const [activeTab, setActiveTab] = useState<"chart" | "receivables" | "payables" | "banks">("chart");

  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [cashBalance, setCashBalance] = useState<number>(0);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [payables, setPayables] = useState<PayableRow[]>([]);
  const [payableStatusFilter, setPayableStatusFilter] = useState<"all" | "pending" | "paid" | "overdue">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [isBankModalOpen, setIsBankModalOpen] = useState(false);
  const [isStatementModalOpen, setIsStatementModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isReconcileModalOpen, setIsReconcileModalOpen] = useState(false);
  const [isEditBankModalOpen, setIsEditBankModalOpen] = useState(false);
  const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState(false);
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [isMarkPaidModalOpen, setIsMarkPaidModalOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<any>(null);
  const [selectedBank, setSelectedBank] = useState<BankAccount | null>(null);
  const [selectedPayable, setSelectedPayable] = useState<PayableRow | null>(null);
  const [markPaidVia, setMarkPaidVia] = useState<"Cash" | "Bank">("Cash");
  const [markPaidBankId, setMarkPaidBankId] = useState<string>("");

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

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [banksRes, treasuryRes, txRes, payablesRes] = await Promise.all([
      supabase.from("bank_accounts").select("*").order("created_at", { ascending: false }),
      supabase.from("treasury").select("*").limit(1).maybeSingle(),
      supabase.from("bank_transactions").select("*").order("created_at", { ascending: false }).limit(100),
      supabase
        .from("expenses")
        .select("*, vendor:vendor_id(id,name), category:category_id(id,name), client:client_id(id,name,client_code)")
        .eq("payment_mode", "Payable")
        .order("due_date", { ascending: true, nullsFirst: false }),
    ]);
    if (banksRes.error) setError(banksRes.error.message);
    if (treasuryRes.error) setError(treasuryRes.error.message);
    if (txRes.error) setError(txRes.error.message);
    if (payablesRes.error) setError(payablesRes.error.message);
    setBanks((banksRes.data ?? []) as BankAccount[]);
    setCashBalance(Number(treasuryRes.data?.cash_balance ?? 0));
    setTransactions((txRes.data ?? []) as BankTransaction[]);
    setPayables((payablesRes.data ?? []) as PayableRow[]);
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

  const viewStatement = (client: any) => {
    setSelectedClient(client);
    setIsStatementModalOpen(true);
  };

  const recordPayment = (client: any) => {
    setSelectedClient(client);
    setIsPaymentModalOpen(true);
  };

  return (
    <>
      <Header
        title="Financial Accounting"
        actions={
          <>
            <ExportButton onExport={() => console.log("Export")} />
            {activeTab === "chart" && (
              <Button variant="primary" size="md" onClick={() => setIsAccountModalOpen(true)}>
                <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Add Account
              </Button>
            )}
            {activeTab === "banks" && (
              <>
                <Button variant="secondary" size="md" onClick={() => setIsLogModalOpen(true)}>
                  <History className="w-4 h-4 mr-2" strokeWidth={1.5} />
                  Transactions
                </Button>
                <Button variant="primary" size="md" onClick={() => setIsBankModalOpen(true)}>
                  <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                  Add Bank Account
                </Button>
              </>
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

        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-6 border-b border-slate-200">
            <div className="flex gap-2">
              {(["chart", "receivables", "payables", "banks"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 rounded-md text-sm transition-colors ${
                    activeTab === tab
                      ? "bg-blue-600 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {tab === "chart" && "Chart of Accounts"}
                  {tab === "receivables" && "Client Receivables"}
                  {tab === "payables" && "Accounts Payable"}
                  {tab === "banks" && "Bank Accounts"}
                </button>
              ))}
            </div>
          </div>

          {activeTab === "chart" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Code</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Account Name</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Balance</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {chartOfAccounts.map((account) => (
                    <tr
                      key={account.id}
                      className={`hover:bg-slate-50 transition-colors ${
                        account.type === "Header" ? "bg-blue-50" : account.type === "Subheader" ? "bg-slate-50" : ""
                      }`}
                    >
                      <td className="px-6 py-4 text-sm text-slate-900">{account.code}</td>
                      <td
                        className={`px-6 py-4 text-sm ${
                          account.type === "Header" ? "text-slate-900" : "text-slate-700"
                        }`}
                        style={{ paddingLeft: account.type === "Detail" ? "3rem" : "1.5rem" }}
                      >
                        {account.name}
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{account.type}</td>
                      <td className="px-6 py-4 text-sm text-slate-900">PKR {account.balance.toLocaleString()}</td>
                      <td className="px-6 py-4">
                        {account.type === "Detail" && (
                          <Button variant="ghost" size="sm">
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "receivables" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Amount Due</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Due Date</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {receivables.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 text-sm text-slate-900">{item.client}</td>
                      <td className="px-6 py-4 text-sm text-blue-600">PKR {item.amount.toLocaleString()}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{item.dueDate}</td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                            item.status === "Overdue"
                              ? "bg-red-50 text-red-700"
                              : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {item.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => viewStatement(item)}>
                          View Statement
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => recordPayment(item)}>
                          Record Payment
                        </Button>
                      </td>
                    </tr>
                  ))}
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
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Cash Balance</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Account Balance</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Total Balance</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {loading && (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-slate-500">
                        <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                        Loading…
                      </td>
                    </tr>
                  )}
                  {!loading && banks.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">
                        No bank accounts yet. Click "Add Bank Account" to create one.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    banks.map((bank) => {
                      const acct = Number(bank.balance ?? 0);
                      const total = cashBalance + acct;
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
                          <td className="px-6 py-4 text-sm text-green-600">PKR {cashBalance.toLocaleString()}</td>
                          <td className="px-6 py-4 text-sm text-blue-600">PKR {acct.toLocaleString()}</td>
                          <td className="px-6 py-4 text-sm font-semibold text-slate-900">PKR {total.toLocaleString()}</td>
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

      <Modal isOpen={isAccountModalOpen} onClose={() => setIsAccountModalOpen(false)} title="Add Account" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Code</label>
            <input
              type="text"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="e.g., 1120"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Name</label>
            <input
              type="text"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="Enter account name"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Type</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
              <option>Header</option>
              <option>Subheader</option>
              <option>Detail</option>
            </select>
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Add Account
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsAccountModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

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
        <div className="space-y-4">
          <div className="pb-4 border-b border-slate-200">
            <h3 className="text-base text-slate-900">{selectedClient?.client}</h3>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
              <p className="text-sm text-blue-700 mb-1">Total Invoiced</p>
              <p className="text-xl text-blue-900">PKR {selectedClient?.amount.toLocaleString()}</p>
            </div>
            <div className="bg-green-50 p-4 rounded-lg border border-green-200">
              <p className="text-sm text-green-700 mb-1">Amount Paid</p>
              <p className="text-xl text-green-900">PKR 0</p>
            </div>
            <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
              <p className="text-sm text-amber-700 mb-1">Outstanding</p>
              <p className="text-xl text-amber-900">PKR {selectedClient?.amount.toLocaleString()}</p>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200">
            <h4 className="text-sm text-slate-900 mb-3">Transaction History</h4>
            <div className="space-y-2">
              <div className="p-3 bg-slate-50 rounded-lg">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-sm text-slate-900">Invoice #{selectedClient?.id}001</p>
                    <p className="text-xs text-slate-500">{selectedClient?.dueDate}</p>
                  </div>
                  <span className="text-sm text-blue-600">PKR {selectedClient?.amount.toLocaleString()}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
            <Button variant="primary" size="md" className="flex-1">
              <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Download Statement
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsStatementModalOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={isPaymentModalOpen} onClose={() => setIsPaymentModalOpen(false)} title="Record Payment" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Client</label>
            <input
              type="text"
              value={selectedClient?.client ?? ""}
              disabled
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Outstanding Amount</label>
            <input
              type="text"
              value={selectedClient ? `PKR ${selectedClient.amount.toLocaleString()}` : ""}
              disabled
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Payment Amount (PKR)</label>
            <input
              type="number"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Payment Date</label>
            <input
              type="date"
              defaultValue={new Date().toISOString().split("T")[0]}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Payment Method</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
              <option>Bank Transfer</option>
              <option>Cash</option>
              <option>Cheque</option>
            </select>
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Record Payment
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsPaymentModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
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
        <div className="max-h-[60vh] overflow-y-auto">
          {transactions.length === 0 ? (
            <p className="text-sm text-slate-500">No transactions yet.</p>
          ) : (
            <table className="w-full">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-slate-200">
                  <th className="text-left px-3 py-2 text-xs text-slate-500">Date</th>
                  <th className="text-left px-3 py-2 text-xs text-slate-500">Kind</th>
                  <th className="text-left px-3 py-2 text-xs text-slate-500">Bank</th>
                  <th className="text-right px-3 py-2 text-xs text-slate-500">Account Δ</th>
                  <th className="text-right px-3 py-2 text-xs text-slate-500">Cash Δ</th>
                  <th className="text-left px-3 py-2 text-xs text-slate-500">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {transactions.map((t) => {
                  const bank = banks.find((b) => b.id === t.bank_account_id);
                  return (
                    <tr key={t.id}>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {t.created_at ? new Date(t.created_at).toLocaleString() : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-700">{kindLabel[t.kind]}</td>
                      <td className="px-3 py-2 text-xs text-slate-700">{bank?.bank_name ?? "—"}</td>
                      <td
                        className={`px-3 py-2 text-xs text-right font-mono ${
                          Number(t.account_delta) > 0
                            ? "text-emerald-700"
                            : Number(t.account_delta) < 0
                            ? "text-red-700"
                            : "text-slate-500"
                        }`}
                      >
                        {Number(t.account_delta) > 0 ? "+" : ""}
                        {Number(t.account_delta).toLocaleString()}
                      </td>
                      <td
                        className={`px-3 py-2 text-xs text-right font-mono ${
                          Number(t.cash_delta) > 0
                            ? "text-emerald-700"
                            : Number(t.cash_delta) < 0
                            ? "text-red-700"
                            : "text-slate-500"
                        }`}
                      >
                        {Number(t.cash_delta) > 0 ? "+" : ""}
                        {Number(t.cash_delta).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">{t.description ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="flex items-center gap-3 pt-4 border-t border-slate-200 mt-4">
            <Button variant="secondary" size="md" className="ml-auto" onClick={() => setIsLogModalOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
