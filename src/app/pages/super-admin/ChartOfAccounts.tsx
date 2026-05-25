import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  X,
  Search,
  Download,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import { exportTable } from "../../lib/excel";
import {
  supabase,
  fetchAllRows,
  ACCOUNT_TYPE_LABEL,
  ACCOUNT_TYPE_ORDER,
  type ChartAccount,
  type AccountType,
  type AccountNormalSide,
  type Invoice,
  type Expense,
  type Payslip,
  type BankAccount,
  type Treasury,
  type Client,
  type BankTransaction,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

type Tab = "coa" | "tb" | "gl";

type Balances = Map<string, number>;
type LedgerEntry = {
  date: string;
  description: string;
  source: string;
  debit: number;
  credit: number;
};

const fmtPKR = (n: number) =>
  `PKR ${Math.round(n).toLocaleString()}`;

const todayISO = () => new Date().toISOString().slice(0, 10);
const monthStartISO = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};
const yearStartISO = () => `${new Date().getFullYear()}-01-01`;

export default function ChartOfAccounts() {
  const { profile } = useAuth();
  const isSuper = profile?.role === "super_admin" || profile?.role === "super_super_admin";

  const [tab, setTab] = useState<Tab>("coa");
  const [accounts, setAccounts] = useState<ChartAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Date range applied to TB and GL.
  const [periodStart, setPeriodStart] = useState<string>(yearStartISO());
  const [periodEnd, setPeriodEnd] = useState<string>(todayISO());

  // Transaction data — pulled once per period change.
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<{ id: string; invoice_id: string | null; payment_date: string; amount: number; method: string | null; client_id: string | null }[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [employeesByCategory, setEmployeesByCategory] = useState<Map<string, "client" | "office_staff" | "reliever">>(new Map());
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [bankTxns, setBankTxns] = useState<BankTransaction[]>([]);
  const [expenseCategoryById, setExpenseCategoryById] = useState<Map<string, string>>(new Map());
  const [clients, setClients] = useState<Client[]>([]);
  const [txLoading, setTxLoading] = useState(false);

  // CoA modal state
  const [addOpen, setAddOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<ChartAccount | null>(null);
  const [form, setForm] = useState({
    account_code: "",
    account_name: "",
    account_type: "expense" as AccountType,
    normal_side: "debit" as AccountNormalSide,
    parent_id: "",
    active: true,
  });
  const [submitting, setSubmitting] = useState(false);

  // GL drill-down
  const [glAccountId, setGlAccountId] = useState<string | null>(null);

  // Search/filters
  const [coaSearch, setCoaSearch] = useState("");
  const [tbHideZero, setTbHideZero] = useState(true);

  const loadAccounts = async () => {
    setLoading(true);
    const { data, error: cErr } = await supabase
      .from("chart_of_accounts")
      .select("*")
      .order("account_code");
    if (cErr) setError(cErr.message);
    setAccounts((data ?? []) as ChartAccount[]);
    setLoading(false);
  };

  useEffect(() => {
    loadAccounts();
  }, []);

  // Pull every transaction in the period, plus all-time bank balances.
  const loadTx = async () => {
    setTxLoading(true);
    setError(null);
    try {
      const [invRes, payRes, expRes, psRes, empRes, bankRes, treaRes, txRes, catRes, cliRes] = await Promise.all([
        fetchAllRows<Invoice>(() =>
          supabase
            .from("invoices")
            .select("*")
            .gte("invoice_date", periodStart)
            .lte("invoice_date", periodEnd)
            .order("invoice_date") as unknown as { range: (a: number, b: number) => Promise<{ data: unknown; error: { message: string } | null }> },
        ),
        fetchAllRows<{ id: string; invoice_id: string | null; payment_date: string; amount: number; method: string | null; client_id: string | null }>(() =>
          supabase
            .from("invoice_payments")
            .select("id, invoice_id, payment_date, amount, method, client_id")
            .gte("payment_date", periodStart)
            .lte("payment_date", periodEnd)
            .order("payment_date") as unknown as { range: (a: number, b: number) => Promise<{ data: unknown; error: { message: string } | null }> },
        ),
        fetchAllRows<Expense>(() =>
          supabase
            .from("expenses")
            .select("*")
            .gte("expense_date", periodStart)
            .lte("expense_date", periodEnd)
            .order("expense_date") as unknown as { range: (a: number, b: number) => Promise<{ data: unknown; error: { message: string } | null }> },
        ),
        fetchAllRows<Payslip>(() =>
          supabase
            .from("payslips")
            .select("*")
            .gte("period_month", periodStart.slice(0, 7) + "-01")
            .lte("period_month", periodEnd.slice(0, 7) + "-31")
            .order("period_month") as unknown as { range: (a: number, b: number) => Promise<{ data: unknown; error: { message: string } | null }> },
        ),
        supabase.from("employees").select("id, category"),
        supabase.from("bank_accounts").select("*"),
        supabase.from("treasury").select("*").limit(1).maybeSingle(),
        fetchAllRows<BankTransaction>(() =>
          supabase
            .from("bank_transactions")
            .select("*")
            .gte("created_at", periodStart + "T00:00:00Z")
            .lte("created_at", periodEnd + "T23:59:59Z")
            .order("created_at") as unknown as { range: (a: number, b: number) => Promise<{ data: unknown; error: { message: string } | null }> },
        ),
        supabase.from("expense_categories").select("id, name"),
        supabase.from("clients").select("id, name"),
      ]);
      setInvoices(invRes);
      setPayments(payRes);
      setExpenses(expRes);
      setPayslips(psRes);
      setEmployeesByCategory(new Map(((empRes.data ?? []) as { id: string; category: "client" | "office_staff" | "reliever" }[]).map((e) => [e.id, e.category])));
      setBanks((bankRes.data ?? []) as BankAccount[]);
      setTreasury(treaRes.data as Treasury | null);
      setBankTxns(txRes);
      setExpenseCategoryById(new Map(((catRes.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name])));
      setClients((cliRes.data ?? []) as Client[]);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setTxLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "tb" || tab === "gl") loadTx();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, periodStart, periodEnd]);

  const accountBySystemKey = useMemo(() => {
    const m = new Map<string, ChartAccount>();
    for (const a of accounts) if (a.system_key) m.set(a.system_key, a);
    return m;
  }, [accounts]);

  // ---------------------------------------------------------------
  // Derive Trial Balance entries from existing transactions.
  // Each transaction posts as a (debit_account, credit_account, amount).
  // For accounts whose normal side is debit, debit increases the balance;
  // credit decreases it. Opposite for credit-normal accounts.
  //
  // Returns:
  //   balances: Map<accountId, signed balance in account's normal side>
  //   ledger:   Map<accountId, LedgerEntry[]>
  // ---------------------------------------------------------------
  const { balances, ledger } = useMemo(() => {
    const bal: Balances = new Map();
    const led: Map<string, LedgerEntry[]> = new Map();
    const acctByKey = accountBySystemKey;
    const get = (key: string): ChartAccount | undefined => acctByKey.get(key);
    const clientById = new Map(clients.map((c) => [c.id, c]));

    const post = (accountKey: string, side: "debit" | "credit", amount: number, entry: Omit<LedgerEntry, "debit" | "credit">) => {
      if (!amount || amount === 0) return;
      const acct = get(accountKey);
      if (!acct) return;
      // Signed balance from the account's own perspective: positive on its normal side.
      const signed = acct.normal_side === side ? amount : -amount;
      bal.set(acct.id, (bal.get(acct.id) ?? 0) + signed);
      const arr = led.get(acct.id) ?? [];
      arr.push({
        ...entry,
        debit: side === "debit" ? amount : 0,
        credit: side === "credit" ? amount : 0,
      });
      led.set(acct.id, arr);
    };

    // INVOICES: AR debit, Revenue credit. Withholding goes to WHT Payable as a contra.
    for (const inv of invoices) {
      const amt = Number(inv.invoice_amount);
      const wht = Number(inv.withholding_tax ?? 0);
      const clientName = inv.client_id ? clientById.get(inv.client_id)?.name ?? "" : "";
      const desc = `Invoice ${inv.invoice_number}${clientName ? ` — ${clientName}` : ""}`;
      const isGuard = (inv as unknown as { client_type?: string }).client_type === "guard_deployment";
      post("ar", "debit", amt - wht, { date: inv.invoice_date, description: desc, source: `INV ${inv.invoice_number}` });
      post(isGuard ? "revenue_guard" : "revenue_security", "credit", amt - wht, { date: inv.invoice_date, description: desc, source: `INV ${inv.invoice_number}` });
      if (wht > 0) {
        post("wht_payable", "credit", wht, { date: inv.invoice_date, description: `Withholding on ${inv.invoice_number}`, source: `INV ${inv.invoice_number}` });
      }
    }

    // PAYMENTS: Cash/Bank debit, AR credit.
    for (const p of payments) {
      const amt = Number(p.amount);
      const dest = (p.method ?? "Bank") === "Cash" ? "cash" : "bank";
      const desc = `Payment received`;
      post(dest, "debit", amt, { date: p.payment_date, description: desc, source: "Payment" });
      post("ar", "credit", amt, { date: p.payment_date, description: desc, source: "Payment" });
    }

    // EXPENSES: Expense debit, Cash/Bank/AP credit (depending on payment_mode).
    for (const ex of expenses) {
      const amt = Number(ex.amount);
      const catName = ex.category_id ? expenseCategoryById.get(ex.category_id) ?? "" : "";
      const expenseKey = mapExpenseToCoa(catName, ex.pl_category, ex.client_id);
      const desc = `${catName || "Expense"}${ex.description ? ` — ${ex.description}` : ""}`;
      post(expenseKey, "debit", amt, { date: ex.expense_date, description: desc, source: "Expense" });
      const credit = ex.payment_mode === "Cash" ? "cash"
        : ex.payment_mode === "Bank" || ex.payment_mode === "Cheque" ? "bank"
        : "ap";
      post(credit, "credit", amt, { date: ex.expense_date, description: desc, source: "Expense" });
    }

    // PAYSLIPS (disbursed only): Payroll expense debit, Cash/Bank credit. Split
    // between guard payroll (COS) and office payroll (OpEx).
    for (const ps of payslips) {
      if (!ps.disbursed) continue;
      const amt = Number(ps.final_salary);
      const cat = employeesByCategory.get(ps.employee_id);
      const isOffice = cat === "office_staff";
      const acct = isOffice ? "opex_office_payroll" : "cos_payroll";
      const desc = `Payroll — ${ps.period_month.slice(0, 7)}`;
      post(acct, "debit", amt, { date: ps.period_month, description: desc, source: "Payslip" });
      const credit = ps.payment_mode === "Cash" ? "cash" : "bank";
      post(credit, "credit", amt, { date: ps.period_month, description: desc, source: "Payslip" });
      // EOBI portion as a separate statutory line if present.
      if (Number(ps.eobi) > 0) {
        post("cos_statutory", "debit", Number(ps.eobi), { date: ps.period_month, description: `EOBI deduction`, source: "Payslip" });
        post("eobi_payable", "credit", Number(ps.eobi), { date: ps.period_month, description: `EOBI deduction`, source: "Payslip" });
      }
    }

    return { balances: bal, ledger: led };
  }, [invoices, payments, expenses, payslips, employeesByCategory, accountBySystemKey, expenseCategoryById, clients]);

  // The Cash and Bank accounts have live closing balances on treasury / bank_accounts.
  // Use those as the authoritative figures for the Trial Balance display rather
  // than the period-only derived movement.
  const liveBalances = useMemo(() => {
    const m = new Map<string, number>();
    const cashAcct = accountBySystemKey.get("cash");
    const bankAcct = accountBySystemKey.get("bank");
    if (cashAcct && treasury) m.set(cashAcct.id, Number(treasury.cash_balance ?? 0));
    if (bankAcct) m.set(bankAcct.id, banks.reduce((s, b) => s + Number(b.balance ?? 0), 0));
    return m;
  }, [accountBySystemKey, treasury, banks]);

  const filteredAccounts = useMemo(() => {
    const q = coaSearch.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(
      (a) =>
        a.account_code.toLowerCase().includes(q) ||
        a.account_name.toLowerCase().includes(q),
    );
  }, [accounts, coaSearch]);

  const accountsByType = useMemo(() => {
    const m = new Map<AccountType, ChartAccount[]>();
    for (const t of ACCOUNT_TYPE_ORDER) m.set(t, []);
    for (const a of filteredAccounts) m.get(a.account_type)!.push(a);
    return m;
  }, [filteredAccounts]);

  const getDisplayBalance = (a: ChartAccount): number => {
    return liveBalances.get(a.id) ?? balances.get(a.id) ?? 0;
  };

  const tbRows = useMemo(() => {
    return accounts
      .filter((a) => a.active)
      .map((a) => {
        const signed = getDisplayBalance(a);
        return {
          account: a,
          debit: a.normal_side === "debit" ? Math.max(signed, 0) : Math.max(-signed, 0),
          credit: a.normal_side === "credit" ? Math.max(signed, 0) : Math.max(-signed, 0),
        };
      })
      .filter((r) => !tbHideZero || r.debit !== 0 || r.credit !== 0)
      .sort((a, b) => a.account.account_code.localeCompare(b.account.account_code));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, balances, liveBalances, tbHideZero]);

  const tbTotals = useMemo(() => {
    let d = 0;
    let c = 0;
    for (const r of tbRows) {
      d += r.debit;
      c += r.credit;
    }
    return { d, c };
  }, [tbRows]);

  // -- CoA CRUD --
  const resetForm = () => {
    setForm({
      account_code: "",
      account_name: "",
      account_type: "expense",
      normal_side: "debit",
      parent_id: "",
      active: true,
    });
  };

  const openAdd = () => {
    resetForm();
    setEditingRow(null);
    setAddOpen(true);
  };

  const openEdit = (a: ChartAccount) => {
    setEditingRow(a);
    setForm({
      account_code: a.account_code,
      account_name: a.account_name,
      account_type: a.account_type,
      normal_side: a.normal_side,
      parent_id: a.parent_id ?? "",
      active: a.active,
    });
    setAddOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const payload = {
      account_code: form.account_code.trim(),
      account_name: form.account_name.trim(),
      account_type: form.account_type,
      normal_side: form.normal_side,
      parent_id: form.parent_id || null,
      active: form.active,
    };
    if (editingRow) {
      const { error: upErr } = await supabase
        .from("chart_of_accounts")
        .update(payload)
        .eq("id", editingRow.id);
      if (upErr) {
        setError(upErr.message);
        setSubmitting(false);
        return;
      }
    } else {
      const { error: insErr } = await supabase
        .from("chart_of_accounts")
        .insert(payload);
      if (insErr) {
        setError(insErr.message);
        setSubmitting(false);
        return;
      }
    }
    setSubmitting(false);
    setAddOpen(false);
    resetForm();
    setEditingRow(null);
    await loadAccounts();
  };

  const handleDelete = async (a: ChartAccount) => {
    if (a.system_account) {
      setError(`"${a.account_name}" is a system account — deactivate instead of deleting.`);
      return;
    }
    if (!window.confirm(`Delete account "${a.account_code} — ${a.account_name}"?`)) return;
    const { error: delErr } = await supabase
      .from("chart_of_accounts")
      .delete()
      .eq("id", a.id);
    if (delErr) { setError(delErr.message); return; }
    await loadAccounts();
  };

  const glEntries = useMemo<LedgerEntry[]>(() => {
    if (!glAccountId) return [];
    return (ledger.get(glAccountId) ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
  }, [glAccountId, ledger]);

  const glRunning = useMemo(() => {
    if (!glAccountId) return [] as { entry: LedgerEntry; running: number }[];
    const acct = accounts.find((a) => a.id === glAccountId);
    if (!acct) return [];
    let r = 0;
    return glEntries.map((entry) => {
      const delta = acct.normal_side === "debit" ? entry.debit - entry.credit : entry.credit - entry.debit;
      r += delta;
      return { entry, running: r };
    });
  }, [glAccountId, glEntries, accounts]);

  return (
    <>
      <Header
        title="Chart of Accounts"
        subtitle="Editable account list, Trial Balance, and per-account General Ledger drill-down"
        actions={
          <ExportButton
            onExport={() => {
              if (tab === "coa") {
                exportTable({
                  fileName: "Chart of Accounts.xlsx",
                  sheetName: "CoA",
                  title: "Chart of Accounts",
                  headers: ["Code", "Name", "Type", "Normal Side", "Active"],
                  rows: accounts.map((a) => [
                    a.account_code,
                    a.account_name,
                    ACCOUNT_TYPE_LABEL[a.account_type],
                    a.normal_side,
                    a.active ? "Yes" : "No",
                  ]),
                });
              } else if (tab === "tb") {
                exportTable({
                  fileName: `Trial Balance ${periodStart} to ${periodEnd}.xlsx`,
                  sheetName: "Trial Balance",
                  title: `Trial Balance — ${periodStart} to ${periodEnd}`,
                  headers: ["Code", "Account", "Type", "Debit (PKR)", "Credit (PKR)"],
                  rows: [
                    ...tbRows.map((r) => [
                      r.account.account_code,
                      r.account.account_name,
                      ACCOUNT_TYPE_LABEL[r.account.account_type],
                      r.debit,
                      r.credit,
                    ]),
                    ["", "TOTAL", "", tbTotals.d, tbTotals.c],
                  ],
                });
              } else if (glAccountId) {
                const acct = accounts.find((a) => a.id === glAccountId);
                exportTable({
                  fileName: `GL ${acct?.account_code ?? ""}.xlsx`,
                  sheetName: "General Ledger",
                  title: `General Ledger — ${acct?.account_code} ${acct?.account_name}`,
                  headers: ["Date", "Source", "Description", "Debit", "Credit", "Running"],
                  rows: glRunning.map((r) => [
                    r.entry.date,
                    r.entry.source,
                    r.entry.description,
                    r.entry.debit,
                    r.entry.credit,
                    r.running,
                  ]),
                });
              }
            }}
          />
        }
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="bg-white rounded-lg border border-slate-200">
          {/* Tabs */}
          <div className="p-4 md:p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              {([
                { v: "coa", label: "Chart of Accounts" },
                { v: "tb", label: "Trial Balance" },
                { v: "gl", label: "General Ledger" },
              ] as const).map((t) => (
                <button
                  key={t.v}
                  onClick={() => setTab(t.v)}
                  className={`px-4 py-2 rounded-md text-sm transition-colors ${
                    tab === t.v ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {(tab === "tb" || tab === "gl") && (
              <div className="flex items-center gap-2 text-sm">
                <label className="text-slate-600">From</label>
                <input
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  className="px-2 py-1 border border-slate-200 rounded text-sm"
                />
                <label className="text-slate-600">To</label>
                <input
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  className="px-2 py-1 border border-slate-200 rounded text-sm"
                />
                <button
                  type="button"
                  onClick={() => { setPeriodStart(monthStartISO()); setPeriodEnd(todayISO()); }}
                  className="px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50"
                >
                  MTD
                </button>
                <button
                  type="button"
                  onClick={() => { setPeriodStart(yearStartISO()); setPeriodEnd(todayISO()); }}
                  className="px-2 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50"
                >
                  YTD
                </button>
              </div>
            )}
          </div>

          {/* CoA tab */}
          {tab === "coa" && (
            <div className="p-4 md:p-6 space-y-4">
              <div className="flex flex-wrap items-center gap-2 justify-between">
                <div className="relative flex-1 max-w-md">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={coaSearch}
                    onChange={(e) => setCoaSearch(e.target.value)}
                    placeholder="Search by code or name…"
                    className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-md text-sm"
                  />
                </div>
                {isSuper && (
                  <Button variant="primary" size="md" onClick={openAdd}>
                    <Plus className="w-4 h-4 mr-2" /> Add Account
                  </Button>
                )}
              </div>

              {loading ? (
                <div className="py-10 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                </div>
              ) : (
                <div className="space-y-5">
                  {ACCOUNT_TYPE_ORDER.map((type) => {
                    const rows = accountsByType.get(type) ?? [];
                    if (rows.length === 0) return null;
                    return (
                      <CoaTypeSection
                        key={type}
                        type={type}
                        rows={rows}
                        isSuper={isSuper}
                        onEdit={openEdit}
                        onDelete={handleDelete}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Trial Balance tab */}
          {tab === "tb" && (
            <div className="p-4 md:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-slate-600">
                  Balances derived from invoices, payments, expenses, payslips
                  in the selected period. Cash & Bank show live closing balances.
                </p>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={tbHideZero}
                    onChange={(e) => setTbHideZero(e.target.checked)}
                  />
                  Hide zero balances
                </label>
              </div>

              {txLoading ? (
                <div className="py-10 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Computing…
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50">
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Code</th>
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Account</th>
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Type</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Debit</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Credit</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {tbRows.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-4 py-10 text-center text-slate-500 text-sm">
                            No activity in this period.
                          </td>
                        </tr>
                      )}
                      {tbRows.map((r) => (
                        <tr key={r.account.id} className="hover:bg-slate-50">
                          <td className="px-4 py-2 text-xs font-mono text-slate-900">{r.account.account_code}</td>
                          <td className="px-4 py-2 text-sm text-slate-900">{r.account.account_name}</td>
                          <td className="px-4 py-2 text-xs text-slate-500">{ACCOUNT_TYPE_LABEL[r.account.account_type]}</td>
                          <td className="px-4 py-2 text-right text-sm">{r.debit !== 0 ? fmtPKR(r.debit) : ""}</td>
                          <td className="px-4 py-2 text-right text-sm">{r.credit !== 0 ? fmtPKR(r.credit) : ""}</td>
                          <td className="px-4 py-2 text-right">
                            <button
                              onClick={() => { setGlAccountId(r.account.id); setTab("gl"); }}
                              className="text-xs text-brand-600 hover:text-brand-700"
                            >
                              View ledger →
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-slate-300 bg-slate-50">
                        <td colSpan={3} className="px-4 py-3 text-sm text-slate-900 font-medium text-right">TOTAL</td>
                        <td className="px-4 py-3 text-right text-sm text-slate-900 font-medium">{fmtPKR(tbTotals.d)}</td>
                        <td className="px-4 py-3 text-right text-sm text-slate-900 font-medium">{fmtPKR(tbTotals.c)}</td>
                        <td></td>
                      </tr>
                      <tr>
                        <td colSpan={6} className="px-4 py-2 text-xs text-right">
                          Difference (debit − credit):{" "}
                          <span className={Math.abs(tbTotals.d - tbTotals.c) < 1 ? "text-success-700" : "text-warning-700"}>
                            {fmtPKR(tbTotals.d - tbTotals.c)}
                          </span>
                          {Math.abs(tbTotals.d - tbTotals.c) >= 1 && (
                            <span className="text-slate-500 ml-2">
                              (gap reflects Cash/Bank using live closing balances; full balance
                              requires the double-entry shadow journal — see Sprint 5)
                            </span>
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* General Ledger tab */}
          {tab === "gl" && (
            <div className="p-4 md:p-6 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setTab("tb")}
                  className="text-sm text-brand-600 hover:text-brand-700 inline-flex items-center gap-1"
                >
                  <ChevronLeft className="w-4 h-4" /> Back to Trial Balance
                </button>
                <select
                  value={glAccountId ?? ""}
                  onChange={(e) => setGlAccountId(e.target.value || null)}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm min-w-[280px]"
                >
                  <option value="">— Select an account —</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.account_code} — {a.account_name}
                    </option>
                  ))}
                </select>
              </div>

              {!glAccountId ? (
                <p className="text-sm text-slate-500">
                  Pick an account above (or click "View ledger" from the Trial Balance) to see every transaction posted to it.
                </p>
              ) : txLoading ? (
                <div className="py-10 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50">
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Date</th>
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Source</th>
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Description</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Debit</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Credit</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Running</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {glRunning.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-4 py-10 text-center text-slate-500 text-sm">
                            No entries for this account in the selected period.
                          </td>
                        </tr>
                      )}
                      {glRunning.map((r, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          <td className="px-4 py-2 text-xs text-slate-700">{r.entry.date}</td>
                          <td className="px-4 py-2 text-xs text-slate-700">{r.entry.source}</td>
                          <td className="px-4 py-2 text-sm text-slate-900">{r.entry.description}</td>
                          <td className="px-4 py-2 text-right text-sm">{r.entry.debit ? fmtPKR(r.entry.debit) : ""}</td>
                          <td className="px-4 py-2 text-right text-sm">{r.entry.credit ? fmtPKR(r.entry.credit) : ""}</td>
                          <td className="px-4 py-2 text-right text-sm text-slate-900">{fmtPKR(r.running)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* CoA add/edit modal */}
      <Modal
        isOpen={addOpen}
        onClose={() => { setAddOpen(false); setEditingRow(null); resetForm(); }}
        title={editingRow ? `Edit ${editingRow.account_code}` : "Add Account"}
        size="md"
      >
        <form className="space-y-3" onSubmit={handleSubmit}>
          {editingRow?.system_account && (
            <div className="text-xs text-warning-700 bg-warning-50 border border-warning-200 rounded p-2">
              System account — code and type drive the Trial Balance mapping. Rename is fine; changing type is not recommended.
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Account Code *</label>
              <input
                required
                type="text"
                value={form.account_code}
                onChange={(e) => setForm({ ...form, account_code: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm font-mono"
                placeholder="e.g., 6400"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Account Type *</label>
              <select
                value={form.account_type}
                onChange={(e) => {
                  const t = e.target.value as AccountType;
                  setForm({
                    ...form,
                    account_type: t,
                    normal_side: t === "asset" || t === "expense" ? "debit" : "credit",
                  });
                }}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                {ACCOUNT_TYPE_ORDER.map((t) => (
                  <option key={t} value={t}>{ACCOUNT_TYPE_LABEL[t]}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Account Name *</label>
              <input
                required
                type="text"
                value={form.account_name}
                onChange={(e) => setForm({ ...form, account_name: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Normal Side</label>
              <select
                value={form.normal_side}
                onChange={(e) => setForm({ ...form, normal_side: e.target.value as AccountNormalSide })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                />
                Active
              </label>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-3 border-t border-slate-200">
            <Button variant="primary" size="md" disabled={submitting} className="flex-1">
              {submitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {editingRow ? "Save Changes" : "Add Account"}
            </Button>
            <Button variant="secondary" size="md" onClick={() => { setAddOpen(false); resetForm(); setEditingRow(null); }}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function CoaTypeSection({
  type,
  rows,
  isSuper,
  onEdit,
  onDelete,
}: {
  type: AccountType;
  rows: ChartAccount[];
  isSuper: boolean;
  onEdit: (a: ChartAccount) => void;
  onDelete: (a: ChartAccount) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-slate-200 rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-slate-50 hover:bg-slate-100 text-sm text-slate-900 transition-colors"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <span className="flex-1 text-left">{ACCOUNT_TYPE_LABEL[type]}</span>
        <span className="text-xs text-slate-500">{rows.length} account{rows.length === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <table className="w-full">
          <tbody className="divide-y divide-slate-100">
            {rows.map((a) => (
              <tr key={a.id} className={a.active ? "" : "opacity-50"}>
                <td className="px-4 py-2 text-xs font-mono text-slate-700 w-20">{a.account_code}</td>
                <td className="px-4 py-2 text-sm text-slate-900">
                  {a.account_name}
                  {a.system_account && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">system</span>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500 capitalize w-20">{a.normal_side}</td>
                <td className="px-4 py-2 text-right">
                  {isSuper && (
                    <div className="flex gap-1 justify-end">
                      <button
                        onClick={() => onEdit(a)}
                        className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      {!a.system_account && (
                        <button
                          onClick={() => onDelete(a)}
                          className="p-1.5 rounded text-danger-600 hover:bg-danger-50"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Map an expense to the right CoA system_key based on its category name and pl_category.
function mapExpenseToCoa(
  catName: string,
  plCat: "cost_of_services" | "operating_expense",
  clientId: string | null,
): string {
  if (catName === "Equipment & Supplies") return "cos_equipment";
  if (catName === "Transportation & Fuel") return "cos_transport";
  if (catName === "EOBI" || catName === "IESSI" || catName === "PESSI") return "cos_statutory";
  if (catName === "Utilities & Rent") return "opex_utilities";
  if (catName === "Insurance") return "opex_insurance";
  if (catName === "Licenses") return "opex_licences";
  if (catName === "Taxes") return "income_tax";
  // Fallback: trust pl_category / client linkage.
  if (plCat === "cost_of_services" || clientId) return "cos_other";
  return "opex_other";
}
