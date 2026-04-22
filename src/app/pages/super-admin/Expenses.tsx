import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Upload, AlertCircle, X, Loader2, Trash2, Download } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import {
  supabase,
  EXPENSE_RECEIPTS_BUCKET,
  type Expense,
  type ExpenseCategory,
  type ExpensePaymentMode,
  type Client,
  type Vendor,
  type BankAccount,
} from "../../lib/supabase";

type ExpenseRow = Expense & {
  category_name: string | null;
  client_name: string | null;
  vendor_name: string | null;
  bank_name: string | null;
};

type ExpenseForm = {
  category_id: string;
  client_id: string;
  vendor_id: string;
  description: string;
  amount: string;
  expense_date: string;
  payment_mode: ExpensePaymentMode;
  bank_account_id: string;
  due_date: string;
  notes: string;
  receipt?: File;
};

const emptyForm: ExpenseForm = {
  category_id: "",
  client_id: "",
  vendor_id: "",
  description: "",
  amount: "",
  expense_date: new Date().toISOString().slice(0, 10),
  payment_mode: "Cash",
  bank_account_id: "",
  due_date: "",
  notes: "",
};

export default function Expenses() {
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [cashBalance, setCashBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [clientFilter, setClientFilter] = useState<"all" | "office" | string>("all");
  const [modeFilter, setModeFilter] = useState<"all" | ExpensePaymentMode>("all");

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [selected, setSelected] = useState<ExpenseRow | null>(null);

  const [form, setForm] = useState<ExpenseForm>(emptyForm);
  const [editForm, setEditForm] = useState<ExpenseForm>(emptyForm);
  const [replaceReceipt, setReplaceReceipt] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [isCatModalOpen, setIsCatModalOpen] = useState(false);
  const [catMode, setCatMode] = useState<"add" | "edit">("add");
  const [catInput, setCatInput] = useState("");
  const [catEditingId, setCatEditingId] = useState<string | null>(null);

  const [isVendorModalOpen, setIsVendorModalOpen] = useState(false);
  const [vendorMode, setVendorMode] = useState<"add" | "edit">("add");
  const [vendorName, setVendorName] = useState("");
  const [vendorAccountNumber, setVendorAccountNumber] = useState("");
  const [vendorEditingId, setVendorEditingId] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [expRes, catRes, cliRes, venRes, bankRes, treaRes] = await Promise.all([
      supabase
        .from("expenses")
        .select("*, category:category_id(name), client:client_id(name), vendor:vendor_id(name), bank:bank_account_id(bank_name)")
        .order("expense_date", { ascending: false })
        .order("created_at", { ascending: false }),
      supabase.from("expense_categories").select("*").order("name"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("vendors").select("*").order("name"),
      supabase.from("bank_accounts").select("*").order("bank_name"),
      supabase.from("treasury").select("*").limit(1).maybeSingle(),
    ]);
    if (expRes.error) setError(expRes.error.message);
    if (catRes.error) setError(catRes.error.message);
    setExpenses(
      (expRes.data ?? []).map((e: any) => ({
        ...e,
        category_name: e.category?.name ?? null,
        client_name: e.client?.name ?? null,
        vendor_name: e.vendor?.name ?? null,
        bank_name: e.bank?.bank_name ?? null,
      }))
    );
    setCategories((catRes.data ?? []) as ExpenseCategory[]);
    setClients((cliRes.data ?? []) as Client[]);
    setVendors((venRes.data ?? []) as Vendor[]);
    setBanks((bankRes.data ?? []) as BankAccount[]);
    setCashBalance(Number(treaRes.data?.cash_balance ?? 0));
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return expenses.filter((e) => {
      if (q) {
        const hay = `${e.description ?? ""} ${e.category_name ?? ""} ${e.vendor_name ?? ""} ${e.client_name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (categoryFilter !== "all" && e.category_id !== categoryFilter) return false;
      if (clientFilter === "office" && e.client_id !== null) return false;
      if (clientFilter !== "all" && clientFilter !== "office" && e.client_id !== clientFilter) return false;
      if (modeFilter !== "all" && e.payment_mode !== modeFilter) return false;
      return true;
    });
  }, [expenses, search, categoryFilter, clientFilter, modeFilter]);

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
    const { data } = await supabase.from("bank_accounts").select("balance").eq("id", bankId).single();
    if (!data) throw new Error("Bank account not found");
    const { error: upErr } = await supabase
      .from("bank_accounts")
      .update({ balance: Number(data.balance) + delta, updated_at: new Date().toISOString() })
      .eq("id", bankId);
    if (upErr) throw upErr;
  };

  const logExpenseTransaction = async (args: {
    bank_account_id: string | null;
    amount: number;
    cash_delta: number;
    account_delta: number;
    description: string;
    reference_id: string | null;
  }) => {
    const { error: txErr } = await supabase.from("bank_transactions").insert({
      bank_account_id: args.bank_account_id,
      kind: "expense",
      amount: args.amount,
      cash_delta: args.cash_delta,
      account_delta: args.account_delta,
      description: args.description,
      reference_id: args.reference_id,
    });
    if (txErr) throw txErr;
  };

  const uploadReceipt = async (expenseId: string, file: File): Promise<string> => {
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${expenseId}/${Date.now()}_${safe}`;
    const { error: upErr } = await supabase.storage
      .from(EXPENSE_RECEIPTS_BUCKET)
      .upload(path, file, { upsert: false });
    if (upErr) throw upErr;
    return path;
  };

  const removeReceipt = async (path: string) => {
    await supabase.storage.from(EXPENSE_RECEIPTS_BUCKET).remove([path]);
  };

  const describeExpense = (catId: string, client: string | null, desc: string | null) => {
    const cat = categories.find((c) => c.id === catId)?.name ?? "Expense";
    const who = client ? `(${client})` : "(Office)";
    return `${cat} ${who}${desc ? `: ${desc}` : ""}`;
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(form.amount);
    if (!form.category_id || !amount || amount <= 0 || !form.expense_date) return;
    if (form.payment_mode === "Bank" && !form.bank_account_id) {
      setError("Select a bank account for Bank payment.");
      return;
    }
    if (form.payment_mode === "Payable" && !form.due_date) {
      setError("Select a due date for Payable expense.");
      return;
    }
    if (form.payment_mode === "Payable" && !form.vendor_id) {
      setError("Select a vendor for Payable expense. Add one via Manage Vendors.");
      return;
    }
    if (form.payment_mode === "Cash" && amount > cashBalance) {
      setError("Cash balance is insufficient.");
      return;
    }
    if (form.payment_mode === "Bank") {
      const bank = banks.find((b) => b.id === form.bank_account_id);
      if (bank && amount > Number(bank.balance)) {
        setError("Selected bank balance is insufficient.");
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      const vendorId = form.payment_mode === "Payable" ? form.vendor_id || null : null;
      const clientName = form.client_id ? clients.find((c) => c.id === form.client_id)?.name ?? null : null;

      const { data: inserted, error: insErr } = await supabase
        .from("expenses")
        .insert({
          category_id: form.category_id,
          client_id: form.client_id || null,
          vendor_id: vendorId,
          description: form.description.trim() || null,
          amount,
          expense_date: form.expense_date,
          payment_mode: form.payment_mode,
          bank_account_id: form.payment_mode === "Bank" ? form.bank_account_id : null,
          due_date: form.payment_mode === "Payable" ? form.due_date : null,
          payable_status: form.payment_mode === "Payable" ? "Pending" : null,
          notes: form.notes.trim() || null,
        })
        .select()
        .single();
      if (insErr) throw insErr;
      const expId = (inserted as Expense).id;

      if (form.receipt) {
        const path = await uploadReceipt(expId, form.receipt);
        await supabase.from("expenses").update({ receipt_path: path }).eq("id", expId);
      }

      const desc = describeExpense(form.category_id, clientName, form.description.trim() || null);
      if (form.payment_mode === "Cash") {
        await applyCashDelta(-amount);
        await logExpenseTransaction({
          bank_account_id: null,
          amount,
          cash_delta: -amount,
          account_delta: 0,
          description: desc,
          reference_id: expId,
        });
      } else if (form.payment_mode === "Bank") {
        await applyBankDelta(form.bank_account_id, -amount);
        await logExpenseTransaction({
          bank_account_id: form.bank_account_id,
          amount,
          cash_delta: 0,
          account_delta: -amount,
          description: desc,
          reference_id: expId,
        });
      }

      setForm(emptyForm);
      setIsAddOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (expense: ExpenseRow) => {
    setSelected(expense);
    setEditForm({
      category_id: expense.category_id ?? "",
      client_id: expense.client_id ?? "",
      vendor_id: expense.vendor_id ?? "",
      description: expense.description ?? "",
      amount: String(expense.amount),
      expense_date: expense.expense_date,
      payment_mode: expense.payment_mode,
      bank_account_id: expense.bank_account_id ?? "",
      due_date: expense.due_date ?? "",
      notes: expense.notes ?? "",
    });
    setReplaceReceipt(false);
    setIsEditOpen(true);
  };

  const reverseExistingPayment = async (exp: ExpenseRow) => {
    if (exp.payment_mode === "Cash") {
      await applyCashDelta(Number(exp.amount));
      await logExpenseTransaction({
        bank_account_id: null,
        amount: Number(exp.amount),
        cash_delta: Number(exp.amount),
        account_delta: 0,
        description: `Reverse expense (edit) — ${exp.description ?? exp.category_name ?? ""}`,
        reference_id: exp.id,
      });
    } else if (exp.payment_mode === "Bank" && exp.bank_account_id) {
      await applyBankDelta(exp.bank_account_id, Number(exp.amount));
      await logExpenseTransaction({
        bank_account_id: exp.bank_account_id,
        amount: Number(exp.amount),
        cash_delta: 0,
        account_delta: Number(exp.amount),
        description: `Reverse expense (edit) — ${exp.description ?? exp.category_name ?? ""}`,
        reference_id: exp.id,
      });
    } else if (exp.payment_mode === "Payable" && exp.payable_status === "Paid") {
      if (exp.paid_via === "Cash") {
        await applyCashDelta(Number(exp.amount));
        await logExpenseTransaction({
          bank_account_id: null,
          amount: Number(exp.amount),
          cash_delta: Number(exp.amount),
          account_delta: 0,
          description: `Reverse paid expense (edit) — ${exp.description ?? exp.category_name ?? ""}`,
          reference_id: exp.id,
        });
      } else if (exp.paid_via === "Bank" && exp.paid_bank_account_id) {
        await applyBankDelta(exp.paid_bank_account_id, Number(exp.amount));
        await logExpenseTransaction({
          bank_account_id: exp.paid_bank_account_id,
          amount: Number(exp.amount),
          cash_delta: 0,
          account_delta: Number(exp.amount),
          description: `Reverse paid expense (edit) — ${exp.description ?? exp.category_name ?? ""}`,
          reference_id: exp.id,
        });
      }
    }
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const amount = Number(editForm.amount);
    if (!editForm.category_id || !amount || amount <= 0 || !editForm.expense_date) return;
    if (editForm.payment_mode === "Bank" && !editForm.bank_account_id) {
      setError("Select a bank account for Bank payment.");
      return;
    }
    if (editForm.payment_mode === "Payable" && !editForm.due_date) {
      setError("Select a due date for Payable expense.");
      return;
    }
    if (editForm.payment_mode === "Payable" && !editForm.vendor_id) {
      setError("Select a vendor for Payable expense. Add one via Manage Vendors.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await reverseExistingPayment(selected);

      if (editForm.payment_mode === "Cash" && amount > cashBalance + (selected.payment_mode === "Cash" ? Number(selected.amount) : 0)) {
        setError("Cash balance is insufficient after reversal.");
        setSubmitting(false);
        return;
      }
      if (editForm.payment_mode === "Bank") {
        const bank = banks.find((b) => b.id === editForm.bank_account_id);
        const reversedBack = selected.payment_mode === "Bank" && selected.bank_account_id === editForm.bank_account_id
          ? Number(selected.amount)
          : 0;
        if (bank && amount > Number(bank.balance) + reversedBack) {
          setError("Selected bank balance is insufficient after reversal.");
          setSubmitting(false);
          return;
        }
      }

      const vendorId = editForm.payment_mode === "Payable" ? editForm.vendor_id || null : null;
      const clientName = editForm.client_id ? clients.find((c) => c.id === editForm.client_id)?.name ?? null : null;

      let receiptPath: string | null = selected.receipt_path;
      if (replaceReceipt) {
        if (selected.receipt_path) await removeReceipt(selected.receipt_path);
        receiptPath = null;
        if (editForm.receipt) {
          receiptPath = await uploadReceipt(selected.id, editForm.receipt);
        }
      }

      const payableStatus =
        editForm.payment_mode === "Payable"
          ? (selected.payment_mode === "Payable" ? selected.payable_status ?? "Pending" : "Pending")
          : null;

      const { error: upErr } = await supabase
        .from("expenses")
        .update({
          category_id: editForm.category_id,
          client_id: editForm.client_id || null,
          vendor_id: vendorId,
          description: editForm.description.trim() || null,
          amount,
          expense_date: editForm.expense_date,
          payment_mode: editForm.payment_mode,
          bank_account_id: editForm.payment_mode === "Bank" ? editForm.bank_account_id : null,
          due_date: editForm.payment_mode === "Payable" ? editForm.due_date : null,
          payable_status: payableStatus,
          paid_via: editForm.payment_mode === "Payable" ? selected.paid_via : null,
          paid_bank_account_id: editForm.payment_mode === "Payable" ? selected.paid_bank_account_id : null,
          paid_at: editForm.payment_mode === "Payable" ? selected.paid_at : null,
          notes: editForm.notes.trim() || null,
          receipt_path: receiptPath,
          updated_at: new Date().toISOString(),
        })
        .eq("id", selected.id);
      if (upErr) throw upErr;

      const desc = describeExpense(editForm.category_id, clientName, editForm.description.trim() || null);
      if (editForm.payment_mode === "Cash") {
        await applyCashDelta(-amount);
        await logExpenseTransaction({
          bank_account_id: null,
          amount,
          cash_delta: -amount,
          account_delta: 0,
          description: desc,
          reference_id: selected.id,
        });
      } else if (editForm.payment_mode === "Bank") {
        await applyBankDelta(editForm.bank_account_id, -amount);
        await logExpenseTransaction({
          bank_account_id: editForm.bank_account_id,
          amount,
          cash_delta: 0,
          account_delta: -amount,
          description: desc,
          reference_id: selected.id,
        });
      }

      setIsEditOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (exp: ExpenseRow) => {
    if (!window.confirm(`Delete expense "${exp.description ?? exp.category_name ?? exp.id.slice(0, 6)}"? Any cash/bank movement will be reversed.`))
      return;
    setError(null);
    try {
      await reverseExistingPayment(exp);
      if (exp.receipt_path) await removeReceipt(exp.receipt_path);
      const { error: delErr } = await supabase.from("expenses").delete().eq("id", exp.id);
      if (delErr) throw delErr;
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };

  const openView = (exp: ExpenseRow) => {
    setSelected(exp);
    setIsViewOpen(true);
  };

  const getReceiptUrl = (path: string): string | null => {
    const { data } = supabase.storage.from(EXPENSE_RECEIPTS_BUCKET).getPublicUrl(path);
    return data.publicUrl ?? null;
  };

  const downloadReceipt = async (path: string, fileName?: string) => {
    const { data, error: dErr } = await supabase.storage.from(EXPENSE_RECEIPTS_BUCKET).download(path);
    if (dErr || !data) {
      setError(dErr?.message ?? "Unable to download receipt");
      return;
    }
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName ?? path.split("/").pop() ?? "receipt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const openCatAdd = () => {
    setCatMode("add");
    setCatInput("");
    setCatEditingId(null);
    setIsCatModalOpen(true);
  };
  const openCatEdit = (c: ExpenseCategory) => {
    setCatMode("edit");
    setCatInput(c.name);
    setCatEditingId(c.id);
    setIsCatModalOpen(true);
  };
  const handleSaveCategory = async () => {
    const name = catInput.trim();
    if (!name) return;
    setError(null);
    try {
      if (catMode === "add") {
        const { error: insErr } = await supabase.from("expense_categories").insert({ name });
        if (insErr) throw insErr;
      } else if (catEditingId) {
        const { error: upErr } = await supabase.from("expense_categories").update({ name }).eq("id", catEditingId);
        if (upErr) throw upErr;
      }
      setIsCatModalOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };
  const openVendorAdd = () => {
    setVendorMode("add");
    setVendorName("");
    setVendorAccountNumber("");
    setVendorEditingId(null);
  };
  const openVendorEdit = (v: Vendor) => {
    setVendorMode("edit");
    setVendorName(v.name);
    setVendorAccountNumber(v.account_number ?? "");
    setVendorEditingId(v.id);
  };
  const handleSaveVendor = async () => {
    const n = vendorName.trim();
    if (!n) {
      setError("Vendor name is required.");
      return;
    }
    setError(null);
    try {
      if (vendorMode === "add") {
        const { error: insErr } = await supabase
          .from("vendors")
          .insert({ name: n, account_number: vendorAccountNumber.trim() || null });
        if (insErr) throw insErr;
      } else if (vendorEditingId) {
        const { error: upErr } = await supabase
          .from("vendors")
          .update({ name: n, account_number: vendorAccountNumber.trim() || null })
          .eq("id", vendorEditingId);
        if (upErr) throw upErr;
      }
      openVendorAdd();
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };
  const handleDeleteVendor = async (v: Vendor) => {
    const usedBy = expenses.filter((e) => e.vendor_id === v.id).length;
    if (
      !window.confirm(
        usedBy > 0
          ? `Delete vendor "${v.name}"? ${usedBy} expense${usedBy === 1 ? "" : "s"} using it will have the vendor cleared.`
          : `Delete vendor "${v.name}"?`
      )
    )
      return;
    const { error: delErr } = await supabase.from("vendors").delete().eq("id", v.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    if (vendorEditingId === v.id) openVendorAdd();
    await loadAll();
  };

  const handleDeleteCategory = async (c: ExpenseCategory) => {
    const usedBy = expenses.filter((e) => e.category_id === c.id).length;
    if (!window.confirm(
      usedBy > 0
        ? `Delete category "${c.name}"? ${usedBy} expense${usedBy === 1 ? "" : "s"} using it will have the category cleared.`
        : `Delete category "${c.name}"?`
    )) return;
    const { error: delErr } = await supabase.from("expense_categories").delete().eq("id", c.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadAll();
  };

  const selectedCatName = selected ? categories.find((c) => c.id === selected.category_id)?.name ?? "—" : "";

  return (
    <>
      <Header
        title="Expenses"
        actions={
          <>
            <ExportButton onExport={() => console.log("Export")} />
            <Button variant="secondary" size="md" onClick={() => setIsVendorModalOpen(true)}>
              Manage Vendors
            </Button>
            <Button variant="primary" size="md" onClick={() => setIsAddOpen(true)}>
              <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Add Expense
            </Button>
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

        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-6 border-b border-slate-200">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-[220px] relative">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"
                  strokeWidth={1.5}
                />
                <input
                  type="text"
                  placeholder="Search description, category, client, vendor…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="all">All Categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                value={clientFilter}
                onChange={(e) => setClientFilter(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="all">All Clients</option>
                <option value="office">Office (no client)</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                value={modeFilter}
                onChange={(e) => setModeFilter(e.target.value as "all" | ExpensePaymentMode)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="all">All Modes</option>
                <option value="Cash">Cash</option>
                <option value="Bank">Bank</option>
                <option value="Payable">Payable</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Date</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Category</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Client</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Description</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Amount</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Mode</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Actions</th>
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
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">
                      No expenses yet. Click "Add Expense" to create one.
                    </td>
                  </tr>
                )}
                {!loading &&
                  filtered.map((exp) => (
                    <tr key={exp.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3 text-sm text-slate-600">{exp.expense_date}</td>
                      <td className="px-4 py-3 text-sm text-slate-900">{exp.category_name ?? "—"}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">
                        {exp.client_name ?? <span className="text-slate-400 italic">Office</span>}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600 max-w-xs truncate">
                        {exp.description ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-900">
                        PKR {Number(exp.amount).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
                            exp.payment_mode === "Cash"
                              ? "bg-green-50 text-green-700"
                              : exp.payment_mode === "Bank"
                              ? "bg-blue-50 text-blue-700"
                              : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {exp.payment_mode}
                          {exp.payment_mode === "Payable" && exp.payable_status ? ` · ${exp.payable_status}` : ""}
                        </span>
                      </td>
                      <td className="px-4 py-3 flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openView(exp)}>
                          View
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(exp)}>
                          Edit
                        </Button>
                        <button
                          type="button"
                          onClick={() => handleDelete(exp)}
                          className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-red-700 hover:bg-red-50"
                          title="Delete expense"
                        >
                          <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base text-slate-900">Category Management</h3>
            <Button variant="primary" size="sm" onClick={openCatAdd}>
              <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Add Category
            </Button>
          </div>
          {categories.length === 0 ? (
            <p className="text-sm text-slate-500">No categories yet. Add one to start categorizing expenses.</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {categories.map((category) => (
                <div
                  key={category.id}
                  className="p-3 border border-slate-200 rounded-lg flex items-center justify-between"
                >
                  <span className="text-sm text-slate-900 truncate">{category.name}</span>
                  <div className="flex gap-1 flex-shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => openCatEdit(category)}>
                      Edit
                    </Button>
                    <button
                      type="button"
                      onClick={() => handleDeleteCategory(category)}
                      className="inline-flex items-center justify-center px-2 py-1 rounded-md text-red-700 hover:bg-red-50"
                      title="Delete category"
                    >
                      <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal
        isOpen={isAddOpen}
        onClose={() => {
          setIsAddOpen(false);
          setForm(emptyForm);
        }}
        title="Add Expense"
        size="lg"
      >
        {renderExpenseForm(form, setForm, handleAdd, submitting, "Add Expense", () => {
          setIsAddOpen(false);
          setForm(emptyForm);
        })}
      </Modal>

      <Modal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        title="Edit Expense"
        size="lg"
      >
        {selected &&
          renderExpenseForm(
            editForm,
            setEditForm,
            handleEdit,
            submitting,
            "Update Expense",
            () => setIsEditOpen(false),
            {
              existingReceipt: selected.receipt_path,
              replaceReceipt,
              setReplaceReceipt,
            }
          )}
      </Modal>

      <Modal isOpen={isViewOpen} onClose={() => setIsViewOpen(false)} title="Expense Details" size="lg">
        {selected && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-slate-500 mb-1">Date</p>
                <p className="text-slate-900">{selected.expense_date}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Category</p>
                <p className="text-slate-900">{selectedCatName}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Amount</p>
                <p className="text-slate-900">PKR {Number(selected.amount).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Client</p>
                <p className="text-slate-900">
                  {selected.client_name ?? <span className="text-slate-400 italic">Office</span>}
                </p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Payment Mode</p>
                <p className="text-slate-900">{selected.payment_mode}</p>
              </div>
              {selected.payment_mode === "Bank" && (
                <div>
                  <p className="text-slate-500 mb-1">Bank Account</p>
                  <p className="text-slate-900">{selected.bank_name ?? "—"}</p>
                </div>
              )}
              {selected.payment_mode === "Payable" && (
                <>
                  <div>
                    <p className="text-slate-500 mb-1">Vendor</p>
                    <p className="text-slate-900">{selected.vendor_name ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-slate-500 mb-1">Due Date</p>
                    <p className="text-slate-900">{selected.due_date ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-slate-500 mb-1">Status</p>
                    <p className="text-slate-900">{selected.payable_status ?? "—"}</p>
                  </div>
                  {selected.payable_status === "Paid" && (
                    <div>
                      <p className="text-slate-500 mb-1">Paid Via</p>
                      <p className="text-slate-900">{selected.paid_via ?? "—"}</p>
                    </div>
                  )}
                </>
              )}
            </div>
            {selected.description && (
              <div className="pt-3 border-t border-slate-200">
                <p className="text-slate-500 mb-1 text-sm">Description</p>
                <p className="text-sm text-slate-900">{selected.description}</p>
              </div>
            )}
            {selected.notes && (
              <div className="pt-3 border-t border-slate-200">
                <p className="text-slate-500 mb-1 text-sm">Notes</p>
                <p className="text-sm text-slate-900">{selected.notes}</p>
              </div>
            )}
            <div className="pt-3 border-t border-slate-200">
              <p className="text-slate-500 mb-2 text-sm">Receipt</p>
              {selected.receipt_path ? (
                <div className="border border-slate-200 rounded-lg p-3 flex items-center justify-between">
                  <span className="text-sm text-slate-700 truncate">
                    {selected.receipt_path.split("/").pop()}
                  </span>
                  <div className="flex gap-2">
                    {getReceiptUrl(selected.receipt_path) && (
                      <a
                        href={getReceiptUrl(selected.receipt_path) ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-slate-700 hover:text-slate-900 underline"
                      >
                        View
                      </a>
                    )}
                    <button
                      onClick={() => downloadReceipt(selected.receipt_path!, undefined)}
                      className="inline-flex items-center gap-1 text-sm text-slate-700 hover:text-slate-900"
                    >
                      <Download className="w-4 h-4" strokeWidth={1.5} />
                      Download
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500">No receipt attached.</p>
              )}
            </div>
            <div className="pt-4 border-t border-slate-200 flex gap-3">
              <Button
                variant="primary"
                size="md"
                className="flex-1"
                onClick={() => {
                  setIsViewOpen(false);
                  openEdit(selected);
                }}
              >
                Edit
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsViewOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={isVendorModalOpen}
        onClose={() => setIsVendorModalOpen(false)}
        title="Manage Vendors"
        size="md"
      >
        <div className="space-y-4">
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">
                {vendorMode === "add" ? "New Vendor Name *" : "Vendor Name *"}
              </label>
              <input
                type="text"
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="e.g., Acme Supplies"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Account Number</label>
              <input
                type="text"
                value={vendorAccountNumber}
                onChange={(e) => setVendorAccountNumber(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="Vendor's bank account number"
              />
              <p className="text-xs text-slate-500 mt-1">
                Stored here so you can copy-paste it when paying the vendor from your banking app.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={handleSaveVendor}>
                {vendorMode === "add" ? "Add Vendor" : "Save Changes"}
              </Button>
              {vendorMode === "edit" && (
                <Button variant="secondary" size="sm" onClick={openVendorAdd}>
                  Cancel Edit
                </Button>
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-slate-200">
            <p className="text-xs text-slate-500 mb-2">Existing Vendors</p>
            {vendors.length === 0 ? (
              <p className="text-sm text-slate-500">No vendors yet.</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {vendors.map((v) => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between p-2.5 border border-slate-200 rounded-md"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-slate-900 truncate">{v.name}</p>
                      {v.account_number && (
                        <p className="text-xs text-slate-500 font-mono truncate">{v.account_number}</p>
                      )}
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <Button variant="ghost" size="sm" onClick={() => openVendorEdit(v)}>
                        Edit
                      </Button>
                      <button
                        type="button"
                        onClick={() => handleDeleteVendor(v)}
                        className="inline-flex items-center justify-center px-2 py-1 rounded-md text-red-700 hover:bg-red-50"
                        title="Delete vendor"
                      >
                        <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isCatModalOpen}
        onClose={() => setIsCatModalOpen(false)}
        title={catMode === "add" ? "Add Category" : "Edit Category"}
        size="sm"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Category Name</label>
            <input
              type="text"
              autoFocus
              value={catInput}
              onChange={(e) => setCatInput(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" onClick={handleSaveCategory}>
              Save
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsCatModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );

  function renderExpenseForm(
    state: ExpenseForm,
    setState: (f: ExpenseForm) => void,
    onSubmit: (e: React.FormEvent) => void,
    isSubmitting: boolean,
    submitLabel: string,
    onCancel: () => void,
    edit?: {
      existingReceipt: string | null;
      replaceReceipt: boolean;
      setReplaceReceipt: (b: boolean) => void;
    }
  ) {
    return (
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Category *</label>
            <select
              required
              value={state.category_id}
              onChange={(e) => setState({ ...state, category_id: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">Select category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Client (optional)</label>
            <select
              value={state.client_id}
              onChange={(e) => setState({ ...state, client_id: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">Office (no client)</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500 mt-1">
              Leave empty to log as an Office expense.
            </p>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
            <input
              required
              type="number"
              min={0}
              step="0.01"
              value={state.amount}
              onChange={(e) => setState({ ...state, amount: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Date *</label>
            <input
              required
              type="date"
              value={state.expense_date}
              onChange={(e) => setState({ ...state, expense_date: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Payment Mode *</label>
            <div className="grid grid-cols-3 gap-2">
              {(["Cash", "Bank", "Payable"] as const).map((m) => (
                <label
                  key={m}
                  className={`flex items-center justify-center gap-2 px-3 py-2 border rounded-md cursor-pointer text-sm ${
                    state.payment_mode === m
                      ? "border-slate-900 bg-slate-50"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <input
                    type="radio"
                    name={`payment_mode_${submitLabel}`}
                    checked={state.payment_mode === m}
                    onChange={() => setState({ ...state, payment_mode: m })}
                  />
                  <span>{m}</span>
                </label>
              ))}
            </div>
          </div>
          {state.payment_mode === "Bank" && (
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Bank Account *</label>
              <select
                required
                value={state.bank_account_id}
                onChange={(e) => setState({ ...state, bank_account_id: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">Select bank account</option>
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.bank_name} · {b.account_number} (PKR {Number(b.balance).toLocaleString()})
                  </option>
                ))}
              </select>
            </div>
          )}
          {state.payment_mode === "Payable" && (
            <>
              <div className="col-span-2">
                <label className="block text-sm text-slate-700 mb-1">Vendor *</label>
                <select
                  required
                  value={state.vendor_id}
                  onChange={(e) => setState({ ...state, vendor_id: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                >
                  <option value="">Select vendor</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}{v.account_number ? ` · ${v.account_number}` : ""}
                    </option>
                  ))}
                </select>
                {vendors.length === 0 && (
                  <p className="text-xs text-slate-500 mt-1">
                    No vendors yet. Add one via the <span className="font-medium">Manage Vendors</span> button.
                  </p>
                )}
              </div>
              <div className="col-span-2">
                <label className="block text-sm text-slate-700 mb-1">Due Date *</label>
                <input
                  required
                  type="date"
                  value={state.due_date}
                  onChange={(e) => setState({ ...state, due_date: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                />
                <p className="text-xs text-slate-500 mt-1">
                  This expense will appear in Accounting → Accounts Payable until it is marked Paid.
                </p>
              </div>
            </>
          )}
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Description</label>
            <textarea
              value={state.description}
              onChange={(e) => setState({ ...state, description: e.target.value })}
              rows={2}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Notes</label>
            <textarea
              value={state.notes}
              onChange={(e) => setState({ ...state, notes: e.target.value })}
              rows={2}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Receipt</label>
            {edit?.existingReceipt && !edit.replaceReceipt ? (
              <div className="flex items-center justify-between p-3 border border-slate-200 rounded-md">
                <span className="text-sm text-slate-700 truncate">
                  {edit.existingReceipt.split("/").pop()}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={(ev: React.MouseEvent) => {
                    ev.preventDefault();
                    edit.setReplaceReceipt(true);
                  }}
                >
                  Replace
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <input
                  type="file"
                  onChange={(e) => setState({ ...state, receipt: e.target.files?.[0] })}
                  className="flex-1 px-4 py-2 border border-slate-200 rounded-md text-sm"
                />
                <Upload className="w-4 h-4 text-slate-400" strokeWidth={1.5} />
                {edit?.replaceReceipt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(ev: React.MouseEvent) => {
                      ev.preventDefault();
                      edit.setReplaceReceipt(false);
                      setState({ ...state, receipt: undefined });
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 pt-4">
          <Button variant="primary" size="md" className="flex-1" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : submitLabel}
          </Button>
          <Button variant="secondary" size="md" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }
}
