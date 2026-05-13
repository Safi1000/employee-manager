import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Upload, AlertCircle, X, Loader2, Trash2, Download, Pencil } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import { exportExpenses, exportAdvances } from "../../lib/excel";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip as RTooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  supabase,
  fetchAllRows,
  EXPENSE_RECEIPTS_BUCKET,
  isHardcodedCategory,
  type Expense,
  type ExpenseCategory,
  type ExpensePaymentMode,
  type Client,
  type Vendor,
  type BankAccount,
  type Employee,
  type Advance,
} from "../../lib/supabase";

const PIE_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#06b6d4",
  "#84cc16",
  "#a855f7",
  "#64748b",
];

type ExpenseRow = Expense & {
  category_name: string | null;
  client_name: string | null;
  vendor_name: string | null;
  bank_name: string | null;
};

type AdvanceRow = Advance & {
  employee_name: string;
  employee_code: string;
  client_name: string | null;
  bank_name: string | null;
};

type AdvanceForm = {
  client_id: string;
  employee_id: string;
  amount: string;
  advance_date: string;
  payment_mode: "Cash" | "Bank";
  bank_account_id: string;
  notes: string;
};

const emptyAdvanceForm: AdvanceForm = {
  client_id: "",
  employee_id: "",
  amount: "",
  advance_date: new Date().toISOString().slice(0, 10),
  payment_mode: "Cash",
  bank_account_id: "",
  notes: "",
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
  const [activeTab, setActiveTab] = useState<"expenses" | "advances">("expenses");
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [advances, setAdvances] = useState<AdvanceRow[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [cashBalance, setCashBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isAdvAddOpen, setIsAdvAddOpen] = useState(false);
  const [advForm, setAdvForm] = useState<AdvanceForm>(emptyAdvanceForm);
  const [advEmpSearch, setAdvEmpSearch] = useState("");
  const [advSubmitting, setAdvSubmitting] = useState(false);

  const [isAdvEditOpen, setIsAdvEditOpen] = useState(false);
  const [advEditing, setAdvEditing] = useState<AdvanceRow | null>(null);
  const [advEditForm, setAdvEditForm] = useState<AdvanceForm>(emptyAdvanceForm);
  const [advEditEmpSearch, setAdvEditEmpSearch] = useState("");

  const [advSearch, setAdvSearch] = useState("");
  const [advClientFilter, setAdvClientFilter] = useState<string>("all");
  const [advModeFilter, setAdvModeFilter] = useState<"all" | "Cash" | "Bank">("all");

  const currentMonthKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [clientFilter, setClientFilter] = useState<"all" | "office" | string>("all");
  const [modeFilter, setModeFilter] = useState<"all" | ExpensePaymentMode>("all");
  const [monthFilter, setMonthFilter] = useState<string>(currentMonthKey());
  const [advMonthFilter, setAdvMonthFilter] = useState<string>(currentMonthKey());

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
    const [catRes, cliRes, venRes, bankRes, treaRes, empRes] = await Promise.all([
      supabase.from("expense_categories").select("*").order("name"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("vendors").select("*").order("name"),
      supabase.from("bank_accounts").select("*").order("bank_name"),
      supabase.from("treasury").select("*").limit(1).maybeSingle(),
      supabase.from("employees").select("*").order("employee_code"),
    ]);
    if (catRes.error) setError(catRes.error.message);
    // Paginate the two potentially-large tables so we never silently miss rows.
    let expData: any[] = [];
    let advData: any[] = [];
    try {
      [expData, advData] = await Promise.all([
        fetchAllRows<any>(() =>
          supabase
            .from("expenses")
            .select("*, category:category_id(name), client:client_id(name), vendor:vendor_id(name), bank:bank_account_id(bank_name)")
            .order("expense_date", { ascending: false })
            .order("created_at", { ascending: false }) as unknown as {
            range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
          },
        ),
        fetchAllRows<any>(() =>
          supabase
            .from("advances")
            .select("*, employee:employee_id(full_name, employee_code), client:client_id(name), bank:bank_account_id(bank_name)")
            .order("advance_date", { ascending: false })
            .order("created_at", { ascending: false }) as unknown as {
            range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
          },
        ),
      ]);
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
    setExpenses(
      (expData ?? []).map((e: any) => ({
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
    setEmployees((empRes.data ?? []) as Employee[]);
    setAdvances(
      (advData ?? []).map((a: any) => ({
        ...a,
        employee_name: a.employee?.full_name ?? "—",
        employee_code: a.employee?.employee_code ?? "",
        client_name: a.client?.name ?? null,
        bank_name: a.bank?.bank_name ?? null,
      }))
    );
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const filteredAdvances = useMemo(() => {
    const q = advSearch.trim().toLowerCase();
    return advances.filter((a) => {
      if (q) {
        const hay = `${a.employee_name} ${a.employee_code} ${a.client_name ?? ""} ${a.notes ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (advMonthFilter !== "all" && (a.advance_date ?? "").slice(0, 7) !== advMonthFilter) return false;
      if (advClientFilter !== "all") {
        if (advClientFilter === "none" && a.client_id) return false;
        if (advClientFilter !== "none" && a.client_id !== advClientFilter) return false;
      }
      if (advModeFilter !== "all" && a.payment_mode !== advModeFilter) return false;
      return true;
    });
  }, [advances, advSearch, advMonthFilter, advClientFilter, advModeFilter]);

  const advTotals = useMemo(() => {
    const t = { count: filteredAdvances.length, total: 0 };
    for (const a of filteredAdvances) t.total += Number(a.amount);
    return t;
  }, [filteredAdvances]);

  const addAdvEmployeeOptions = useMemo(() => {
    const q = advEmpSearch.trim().toLowerCase();
    let list = employees;
    if (advForm.client_id) list = list.filter((e) => e.client_id === advForm.client_id);
    if (q) {
      list = list.filter(
        (e) =>
          e.full_name.toLowerCase().includes(q) ||
          e.employee_code.toLowerCase().includes(q) ||
          (e.phone ?? "").toLowerCase().includes(q)
      );
    }
    return list.slice(0, 25);
  }, [employees, advForm.client_id, advEmpSearch]);

  const editAdvEmployeeOptions = useMemo(() => {
    const q = advEditEmpSearch.trim().toLowerCase();
    let list = employees;
    if (advEditForm.client_id) list = list.filter((e) => e.client_id === advEditForm.client_id);
    if (q) {
      list = list.filter(
        (e) =>
          e.full_name.toLowerCase().includes(q) ||
          e.employee_code.toLowerCase().includes(q) ||
          (e.phone ?? "").toLowerCase().includes(q)
      );
    }
    return list.slice(0, 25);
  }, [employees, advEditForm.client_id, advEditEmpSearch]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return expenses.filter((e) => {
      if (q) {
        const hay = `${e.description ?? ""} ${e.category_name ?? ""} ${e.vendor_name ?? ""} ${e.client_name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (monthFilter !== "all" && (e.expense_date ?? "").slice(0, 7) !== monthFilter) return false;
      if (categoryFilter !== "all" && e.category_id !== categoryFilter) return false;
      if (clientFilter === "office" && e.client_id !== null) return false;
      if (clientFilter !== "all" && clientFilter !== "office" && e.client_id !== clientFilter) return false;
      if (modeFilter !== "all" && e.payment_mode !== modeFilter) return false;
      return true;
    });
  }, [expenses, search, monthFilter, categoryFilter, clientFilter, modeFilter]);

  // Last 18 months of options + "All" for the month select.
  const monthOptions = useMemo(() => {
    const opts: { key: string; label: string }[] = [];
    const d = new Date();
    for (let i = 0; i < 18; i++) {
      const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
      const label = dt.toLocaleDateString(undefined, { month: "short", year: "numeric" });
      opts.push({ key, label });
    }
    return opts;
  }, []);

  const expenseMetrics = useMemo(() => {
    let total = 0;
    const byCategory = new Map<string, { id: string | null; name: string; total: number }>();
    for (const e of filtered) {
      const amt = Number(e.amount);
      total += amt;
      const key = e.category_id ?? "__none__";
      const name = e.category_name ?? "Uncategorized";
      const cur = byCategory.get(key) ?? { id: e.category_id, name, total: 0 };
      cur.total += amt;
      byCategory.set(key, cur);
    }
    const perCategory = Array.from(byCategory.values()).sort((a, b) => b.total - a.total);
    return { total, perCategory };
  }, [filtered]);

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

  const logAdvanceTransaction = async (args: {
    bank_account_id: string | null;
    amount: number;
    cash_delta: number;
    account_delta: number;
    description: string;
    reference_id: string | null;
  }) => {
    const { error: txErr } = await supabase.from("bank_transactions").insert({
      bank_account_id: args.bank_account_id,
      kind: "advance",
      amount: args.amount,
      cash_delta: args.cash_delta,
      account_delta: args.account_delta,
      description: args.description,
      reference_id: args.reference_id,
    });
    if (txErr) throw txErr;
  };

  const describeAdvance = (empName: string, empCode: string, clientName: string | null) => {
    return `Advance · ${empCode} ${empName}${clientName ? ` (${clientName})` : ""}`;
  };

  const validateAdvance = (f: AdvanceForm, existingAmount?: number): string | null => {
    if (!f.employee_id) return "Select an employee.";
    const amt = Number(f.amount);
    if (!amt || amt <= 0) return "Enter a positive amount.";
    if (!f.advance_date) return "Select a date.";
    if (f.payment_mode === "Bank" && !f.bank_account_id) return "Select a bank account.";
    if (f.payment_mode === "Cash") {
      const budget = cashBalance + (existingAmount ?? 0);
      if (amt > budget) return "Cash balance is insufficient.";
    }
    if (f.payment_mode === "Bank") {
      const bank = banks.find((b) => b.id === f.bank_account_id);
      if (bank) {
        const budget = Number(bank.balance) + (existingAmount ?? 0);
        if (amt > budget) return "Selected bank balance is insufficient.";
      }
    }
    return null;
  };

  const resetAdvAddModal = () => {
    setAdvForm(emptyAdvanceForm);
    setAdvEmpSearch("");
    setIsAdvAddOpen(false);
  };

  const handleAddAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateAdvance(advForm);
    if (err) {
      setError(err);
      return;
    }
    setAdvSubmitting(true);
    setError(null);
    try {
      const amount = Number(advForm.amount);
      const emp = employees.find((x) => x.id === advForm.employee_id);
      const client = advForm.client_id ? clients.find((c) => c.id === advForm.client_id) ?? null : null;
      const { data: inserted, error: insErr } = await supabase
        .from("advances")
        .insert({
          employee_id: advForm.employee_id,
          client_id: advForm.client_id || null,
          amount,
          advance_date: advForm.advance_date,
          payment_mode: advForm.payment_mode,
          bank_account_id: advForm.payment_mode === "Bank" ? advForm.bank_account_id : null,
          notes: advForm.notes.trim() || null,
        })
        .select()
        .single();
      if (insErr) throw insErr;
      const advId = (inserted as Advance).id;
      const desc = describeAdvance(emp?.full_name ?? "", emp?.employee_code ?? "", client?.name ?? null);
      if (advForm.payment_mode === "Cash") {
        await applyCashDelta(-amount);
        await logAdvanceTransaction({
          bank_account_id: null,
          amount,
          cash_delta: -amount,
          account_delta: 0,
          description: desc,
          reference_id: advId,
        });
      } else {
        await applyBankDelta(advForm.bank_account_id, -amount);
        await logAdvanceTransaction({
          bank_account_id: advForm.bank_account_id,
          amount,
          cash_delta: 0,
          account_delta: -amount,
          description: desc,
          reference_id: advId,
        });
      }
      resetAdvAddModal();
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setAdvSubmitting(false);
    }
  };

  const openAdvEdit = (adv: AdvanceRow) => {
    setAdvEditing(adv);
    setAdvEditForm({
      client_id: adv.client_id ?? "",
      employee_id: adv.employee_id,
      amount: String(adv.amount),
      advance_date: adv.advance_date,
      payment_mode: adv.payment_mode,
      bank_account_id: adv.bank_account_id ?? "",
      notes: adv.notes ?? "",
    });
    setAdvEditEmpSearch(`${adv.employee_name} (${adv.employee_code})`);
    setIsAdvEditOpen(true);
  };

  const reverseAdvancePayment = async (adv: AdvanceRow) => {
    const amount = Number(adv.amount);
    const desc = `Reverse advance · ${adv.employee_code} ${adv.employee_name}${adv.client_name ? ` (${adv.client_name})` : ""}`;
    if (adv.payment_mode === "Cash") {
      await applyCashDelta(amount);
      await logAdvanceTransaction({
        bank_account_id: null,
        amount,
        cash_delta: amount,
        account_delta: 0,
        description: desc,
        reference_id: adv.id,
      });
    } else if (adv.payment_mode === "Bank" && adv.bank_account_id) {
      await applyBankDelta(adv.bank_account_id, amount);
      await logAdvanceTransaction({
        bank_account_id: adv.bank_account_id,
        amount,
        cash_delta: 0,
        account_delta: amount,
        description: desc,
        reference_id: adv.id,
      });
    }
  };

  const handleEditAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!advEditing) return;
    const sameAccountAsBefore =
      advEditForm.payment_mode === advEditing.payment_mode &&
      (advEditForm.payment_mode === "Cash" ||
        advEditForm.bank_account_id === advEditing.bank_account_id);
    const existingAmount = sameAccountAsBefore ? Number(advEditing.amount) : 0;
    const err = validateAdvance(advEditForm, existingAmount);
    if (err) {
      setError(err);
      return;
    }
    setAdvSubmitting(true);
    setError(null);
    try {
      await reverseAdvancePayment(advEditing);
      const amount = Number(advEditForm.amount);
      const emp = employees.find((x) => x.id === advEditForm.employee_id);
      const client = advEditForm.client_id
        ? clients.find((c) => c.id === advEditForm.client_id) ?? null
        : null;
      const { error: upErr } = await supabase
        .from("advances")
        .update({
          employee_id: advEditForm.employee_id,
          client_id: advEditForm.client_id || null,
          amount,
          advance_date: advEditForm.advance_date,
          payment_mode: advEditForm.payment_mode,
          bank_account_id: advEditForm.payment_mode === "Bank" ? advEditForm.bank_account_id : null,
          notes: advEditForm.notes.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", advEditing.id);
      if (upErr) throw upErr;
      const desc = describeAdvance(emp?.full_name ?? "", emp?.employee_code ?? "", client?.name ?? null);
      if (advEditForm.payment_mode === "Cash") {
        await applyCashDelta(-amount);
        await logAdvanceTransaction({
          bank_account_id: null,
          amount,
          cash_delta: -amount,
          account_delta: 0,
          description: desc,
          reference_id: advEditing.id,
        });
      } else {
        await applyBankDelta(advEditForm.bank_account_id, -amount);
        await logAdvanceTransaction({
          bank_account_id: advEditForm.bank_account_id,
          amount,
          cash_delta: 0,
          account_delta: -amount,
          description: desc,
          reference_id: advEditing.id,
        });
      }
      setIsAdvEditOpen(false);
      setAdvEditing(null);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setAdvSubmitting(false);
    }
  };

  const handleDeleteAdvance = async (adv: AdvanceRow) => {
    if (!window.confirm(`Delete advance of PKR ${Number(adv.amount).toLocaleString()} to ${adv.employee_name}? Cash/Bank movement will be reversed.`))
      return;
    setError(null);
    try {
      await reverseAdvancePayment(adv);
      const { error: delErr } = await supabase.from("advances").delete().eq("id", adv.id);
      if (delErr) throw delErr;
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
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
    if (catMode === "add" && isHardcodedCategory(name)) {
      setError(`"${name}" is a reserved system category.`);
      return;
    }
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
    if (isHardcodedCategory(c.name)) {
      setError(`"${c.name}" is a system category and cannot be deleted.`);
      return;
    }
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
            <ExportButton
              onExport={() => {
                if (activeTab === "advances") {
                  exportAdvances(
                    filteredAdvances.map((a) => ({
                      date: a.advance_date,
                      employee: `${a.employee_code} ${a.employee_name}`.trim(),
                      client: a.client_name ?? "",
                      amount: Number(a.amount),
                      mode: a.payment_mode === "Bank" && a.bank_name
                        ? `Bank · ${a.bank_name}`
                        : a.payment_mode,
                      remarks: a.notes ?? "",
                    })),
                    `Advances ${new Date().toISOString().slice(0, 10)}.xlsx`
                  );
                } else {
                  exportExpenses(
                    filtered.map((e) => ({
                      date: e.expense_date,
                      particulars: e.description ?? "",
                      category: e.category_name ?? "",
                      client: e.client_name ?? "Office",
                      amount: Number(e.amount),
                      mode: e.payment_mode === "Bank" && e.bank_name
                        ? `Bank · ${e.bank_name}`
                        : e.payment_mode,
                    })),
                    `Expenses ${new Date().toISOString().slice(0, 10)}.xlsx`
                  );
                }
              }}
            />
            {activeTab === "expenses" && (
              <Button variant="secondary" size="md" onClick={() => setIsVendorModalOpen(true)}>
                Manage Vendors
              </Button>
            )}
            {activeTab === "expenses" && (
              <Button variant="primary" size="md" onClick={() => setIsAddOpen(true)}>
                <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Add Expense
              </Button>
            )}
            {activeTab === "advances" && (
              <Button
                variant="primary"
                size="md"
                onClick={() => {
                  setAdvForm(emptyAdvanceForm);
                  setAdvEmpSearch("");
                  setIsAdvAddOpen(true);
                }}
              >
                <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Add Advance
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

        <div className="flex items-center gap-2 mb-6">
          {(["expenses", "advances"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setActiveTab(t)}
              className={`px-4 py-2 rounded-md text-sm transition-colors ${
                activeTab === t
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              {t === "expenses" ? "Expenses" : "Advances"}
            </button>
          ))}
        </div>

        {activeTab === "expenses" && (
          <div className="mb-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-1 flex flex-col gap-4">
              <div className="bg-slate-900 p-4 rounded-lg">
                <p className="text-xs text-slate-300 mb-1">Total Expenses</p>
                <p className="text-2xl text-white">
                  PKR {expenseMetrics.total.toLocaleString()}
                </p>
                <p className="text-[11px] text-slate-400 mt-1">
                  {filtered.length} entr{filtered.length === 1 ? "y" : "ies"} in current filter
                </p>
              </div>
              <div className="bg-white p-4 rounded-lg border border-slate-200 flex-1">
                <p className="text-xs text-slate-500 mb-2">By Category</p>
                {expenseMetrics.perCategory.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No expenses match the current filter.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-2 max-h-64 overflow-y-auto">
                    {expenseMetrics.perCategory.map((c, i) => (
                      <div
                        key={c.id ?? c.name}
                        className="flex items-center justify-between px-3 py-1.5 rounded border border-slate-100 bg-slate-50"
                      >
                        <span className="flex items-center gap-2 text-xs text-slate-700 truncate">
                          <span
                            className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                            style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                          />
                          {c.name}
                        </span>
                        <span className="text-xs text-slate-900 ml-2">
                          PKR {c.total.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="lg:col-span-2 bg-white p-4 rounded-lg border border-slate-200">
              <p className="text-xs text-slate-500 mb-2">Category Breakdown</p>
              {expenseMetrics.perCategory.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-sm text-slate-500">
                  No expenses match the current filter.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie
                      data={expenseMetrics.perCategory}
                      dataKey="total"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={100}
                      innerRadius={50}
                      paddingAngle={2}
                    >
                      {expenseMetrics.perCategory.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <RTooltip
                      formatter={(v: number) => `PKR ${Number(v).toLocaleString()}`}
                    />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        )}

        {activeTab === "expenses" && (
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
                value={monthFilter}
                onChange={(e) => setMonthFilter(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                title="Filter by month"
              >
                <option value="all">All Months</option>
                {monthOptions.map((m) => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </select>
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
              <ClientFilterSelect
                clients={clients}
                value={clientFilter}
                onChange={setClientFilter}
                allValue="all"
                extraOption={{ value: "office", label: "Office (no client)" }}
              />
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
        )}

        {activeTab === "expenses" && (
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
              {categories.map((category) => {
                const locked = isHardcodedCategory(category.name);
                return (
                  <div
                    key={category.id}
                    className={`p-3 border rounded-lg flex items-center justify-between ${
                      locked ? "border-slate-300 bg-slate-50" : "border-slate-200"
                    }`}
                  >
                    <div className="min-w-0">
                      <span className="text-sm text-slate-900 truncate block">{category.name}</span>
                      {locked && (
                        <span className="text-[10px] uppercase tracking-wide text-slate-500">
                          System
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      {!locked && (
                        <>
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
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}

        {activeTab === "advances" && (
          <div className="bg-white rounded-lg border border-slate-200">
            <div className="p-6 border-b border-slate-200">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[220px] relative">
                  <Search
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"
                    strokeWidth={1.5}
                  />
                  <input
                    type="text"
                    placeholder="Search employee, code, client, notes…"
                    value={advSearch}
                    onChange={(e) => setAdvSearch(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  />
                </div>
                <select
                  value={advMonthFilter}
                  onChange={(e) => setAdvMonthFilter(e.target.value)}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                  title="Filter by month"
                >
                  <option value="all">All Months</option>
                  {monthOptions.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
                <select
                  value={advClientFilter}
                  onChange={(e) => setAdvClientFilter(e.target.value)}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                >
                  <option value="all">All Clients</option>
                  <option value="none">No Client</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  value={advModeFilter}
                  onChange={(e) => setAdvModeFilter(e.target.value as "all" | "Cash" | "Bank")}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                >
                  <option value="all">All Modes</option>
                  <option value="Cash">Cash</option>
                  <option value="Bank">Bank</option>
                </select>
                <div className="ml-auto text-xs text-slate-500">
                  {advTotals.count} advance{advTotals.count === 1 ? "" : "s"} · PKR {advTotals.total.toLocaleString()}
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-4 py-3 text-xs text-slate-500">Date</th>
                    <th className="text-left px-4 py-3 text-xs text-slate-500">Employee</th>
                    <th className="text-left px-4 py-3 text-xs text-slate-500">Client</th>
                    <th className="text-right px-4 py-3 text-xs text-slate-500">Amount</th>
                    <th className="text-left px-4 py-3 text-xs text-slate-500">Mode</th>
                    <th className="text-left px-4 py-3 text-xs text-slate-500">Notes</th>
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
                  {!loading && filteredAdvances.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">
                        No advances yet. Click "Add Advance" to record one.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    filteredAdvances.map((adv) => (
                      <tr key={adv.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 text-sm text-slate-600">{adv.advance_date}</td>
                        <td className="px-4 py-3 text-sm text-slate-900">
                          <div>{adv.employee_name}</div>
                          <div className="text-xs text-slate-500 font-mono">{adv.employee_code}</div>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-700">
                          {adv.client_name ?? <span className="text-slate-400 italic">—</span>}
                        </td>
                        <td className="px-4 py-3 text-sm text-right text-slate-900">
                          PKR {Number(adv.amount).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
                              adv.payment_mode === "Cash"
                                ? "bg-green-50 text-green-700"
                                : "bg-blue-50 text-blue-700"
                            }`}
                          >
                            {adv.payment_mode}
                            {adv.bank_name ? ` · ${adv.bank_name}` : ""}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600 max-w-xs truncate">
                          {adv.notes ?? "—"}
                        </td>
                        <td className="px-4 py-3 flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openAdvEdit(adv)}>
                            <Pencil className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                            Edit
                          </Button>
                          <button
                            type="button"
                            onClick={() => handleDeleteAdvance(adv)}
                            className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-red-700 hover:bg-red-50"
                            title="Delete advance"
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
        )}
      </div>

      <Modal
        isOpen={isAdvAddOpen}
        onClose={resetAdvAddModal}
        title="Add Advance"
        size="md"
      >
        <form className="space-y-4" onSubmit={handleAddAdvance}>
          {renderAdvanceFields(advForm, setAdvForm, advEmpSearch, setAdvEmpSearch, addAdvEmployeeOptions)}
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" disabled={advSubmitting}>
              {advSubmitting ? "Saving…" : "Add Advance"}
            </Button>
            <Button variant="secondary" size="md" onClick={resetAdvAddModal}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isAdvEditOpen}
        onClose={() => {
          setIsAdvEditOpen(false);
          setAdvEditing(null);
        }}
        title="Edit Advance"
        size="md"
      >
        {advEditing && (
          <form className="space-y-4" onSubmit={handleEditAdvance}>
            {renderAdvanceFields(advEditForm, setAdvEditForm, advEditEmpSearch, setAdvEditEmpSearch, editAdvEmployeeOptions)}
            <div className="flex items-center gap-3 pt-4">
              <Button variant="primary" size="md" className="flex-1" disabled={advSubmitting}>
                {advSubmitting ? "Saving…" : "Update Advance"}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setIsAdvEditOpen(false);
                  setAdvEditing(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>

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

  function renderAdvanceFields(
    state: AdvanceForm,
    setState: (f: AdvanceForm) => void,
    empQuery: string,
    setEmpQuery: (s: string) => void,
    empOptions: Employee[]
  ) {
    const selectedEmp = state.employee_id ? employees.find((e) => e.id === state.employee_id) ?? null : null;
    return (
      <>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Client (optional)</label>
          <select
            value={state.client_id}
            onChange={(e) => {
              const newClientId = e.target.value;
              const emp = employees.find((x) => x.id === state.employee_id);
              const keep = !newClientId || !emp || emp.client_id === newClientId;
              setState({
                ...state,
                client_id: newClientId,
                employee_id: keep ? state.employee_id : "",
              });
              if (!keep) setEmpQuery("");
            }}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
          >
            <option value="">No client (direct)</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1">
            When set, the employee list below is filtered to that client's employees.
          </p>
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Employee *</label>
          {selectedEmp ? (
            <div className="flex items-center justify-between px-3 py-2 border border-slate-200 rounded-md bg-slate-50">
              <div className="text-sm">
                <div className="text-slate-900">{selectedEmp.full_name}</div>
                <div className="text-xs text-slate-500 font-mono">
                  {selectedEmp.employee_code}
                  {selectedEmp.phone ? ` · ${selectedEmp.phone}` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setState({ ...state, employee_id: "" })}
                className="text-xs text-slate-500 hover:text-slate-900"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
                <input
                  type="text"
                  placeholder="Search by name, code, or phone…"
                  value={empQuery}
                  onChange={(e) => setEmpQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
              <div className="mt-2 max-h-40 overflow-y-auto border border-slate-200 rounded-md">
                {empOptions.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-slate-500">No employees match.</div>
                ) : (
                  empOptions.map((emp) => (
                    <button
                      key={emp.id}
                      type="button"
                      onClick={() => {
                        setState({ ...state, employee_id: emp.id });
                        setEmpQuery("");
                      }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                    >
                      <div className="text-slate-900">{emp.full_name}</div>
                      <div className="text-xs text-slate-500 font-mono">
                        {emp.employee_code}
                        {emp.phone ? ` · ${emp.phone}` : ""}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
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
              value={state.advance_date}
              onChange={(e) => setState({ ...state, advance_date: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-slate-700 mb-1">Payment Mode *</label>
          <div className="grid grid-cols-2 gap-2">
            {(["Cash", "Bank"] as const).map((m) => (
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
                  name="adv_payment_mode"
                  checked={state.payment_mode === m}
                  onChange={() =>
                    setState({
                      ...state,
                      payment_mode: m,
                      bank_account_id: m === "Cash" ? "" : state.bank_account_id,
                    })
                  }
                />
                <span>{m}</span>
              </label>
            ))}
          </div>
        </div>
        {state.payment_mode === "Bank" && (
          <div>
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
        <div>
          <label className="block text-sm text-slate-700 mb-1">Notes</label>
          <textarea
            value={state.notes}
            onChange={(e) => setState({ ...state, notes: e.target.value })}
            rows={2}
            className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
          />
        </div>
      </>
    );
  }

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
