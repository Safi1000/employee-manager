import { useEffect, useMemo, useState } from "react";
import { Plus, Building2, Download, AlertCircle, X, Loader2, ArrowDownUp, History, Trash2, CheckCircle2, RotateCcw, FileText, Pencil, ArrowLeftRight, Search, Power } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import { formatDate } from "../../lib/date";
import {
  exportReceivableLedger,
  exportTable,
  type LedgerEntry,
} from "../../lib/excel";
import {
  supabase,
  fetchAllRows,
  INVOICE_ATTACHMENTS_BUCKET,
  CHEQUE_ATTACHMENTS_BUCKET,
  type BankAccount,
  type BankTransaction,
  type BankTransactionKind,
  type Expense,
  type Vendor,
  type ExpenseCategory,
  type Client,
  type Invoice,
  type Partner,
  type BankAccountOwnerType,
  type Cheque,
  type ChequeType,
} from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

type PayableRow = Expense & {
  vendor?: Vendor | null;
  category?: ExpenseCategory | null;
  client?: Client | null;
};

type ReceivableRow = Client & {
  total_invoiced: number;
  total_withholding: number;
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
  advance: "Advance",
  transfer: "Transfer",
  cheque: "Cheque",
};

const todayStr = () => new Date().toISOString().slice(0, 10);

type PayableDisplayStatus = "Pending" | "Paid" | "Overdue";

const payableDisplayStatus = (row: PayableRow): PayableDisplayStatus => {
  if (row.payable_status === "Paid") return "Paid";
  if (row.due_date && row.due_date < todayStr()) return "Overdue";
  return "Pending";
};

export default function Accounting() {
  const { profile, company } = useAuth();
  const isAdmin = profile?.role === "super_super_admin" || profile?.role === "super_admin";
  const [activeTab, setActiveTab] = useState<"receivables" | "payables" | "banks">("receivables");

  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [cheques, setCheques] = useState<Cheque[]>([]);
  const [chequeLinkedSums, setChequeLinkedSums] = useState<Map<string, number>>(new Map());
  const [isChequeAddOpen, setIsChequeAddOpen] = useState(false);
  const [chequeForm, setChequeForm] = useState<{
    bank_account_id: string;
    cheque_number: string;
    amount: string;
    cheque_date: string;
    cheque_type: ChequeType;
    recipient: string;
    notes: string;
    attachment?: File;
  }>({
    bank_account_id: "",
    cheque_number: "",
    amount: "",
    cheque_date: new Date().toISOString().slice(0, 10),
    cheque_type: "payment",
    recipient: "",
    notes: "",
  });
  const [chequeFormError, setChequeFormError] = useState<string | null>(null);
  const [chequeView, setChequeView] = useState<Cheque | null>(null);
  const [chequeViewItems, setChequeViewItems] = useState<{
    kind: "Payslip" | "Expense" | "Advance" | "Invoice Payment";
    description: string;
    amount: number;
    date: string;
  }[]>([]);
  const [chequeViewAttachmentUrl, setChequeViewAttachmentUrl] = useState<string | null>(null);
  const [chequeSubmitting, setChequeSubmitting] = useState(false);
  const [chequeFilter, setChequeFilter] = useState<"all" | "pending" | "cleared">("all");
  const [chequeBankFilter, setChequeBankFilter] = useState<string>("all");
  const [chequeMonthFilter, setChequeMonthFilter] = useState<string>("all");
  const [cashBalance, setCashBalance] = useState<number>(0);
  const [cashOpeningBalance, setCashOpeningBalance] = useState<number>(0);
  const [cashOpeningLocked, setCashOpeningLocked] = useState<boolean>(false);
  const [treasuryId, setTreasuryId] = useState<string | null>(null);
  const [isCashOpeningOpen, setIsCashOpeningOpen] = useState(false);
  const [cashOpeningInput, setCashOpeningInput] = useState<string>("");
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [payables, setPayables] = useState<PayableRow[]>([]);
  const [receivables, setReceivables] = useState<ReceivableRow[]>([]);
  const [allClientsForRec, setAllClientsForRec] = useState<Client[]>([]);
  const [allInvoicesForRec, setAllInvoicesForRec] = useState<Invoice[]>([]);
  const [payableStatusFilter, setPayableStatusFilter] = useState<"all" | "pending" | "paid" | "overdue">("all");
  const currentMonthKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const [receivablesMonth, setReceivablesMonth] = useState<string>(currentMonthKey());
  const [receivablesBranchFilter, setReceivablesBranchFilter] = useState<string>("all");
  const [receivablesClientFilter, setReceivablesClientFilter] = useState<string>("all");
  const [receivablesSearch, setReceivablesSearch] = useState<string>("");
  const [branchesList, setBranchesList] = useState<{ id: string; name: string }[]>([]);
  const [payablesMonth, setPayablesMonth] = useState<string>(currentMonthKey());
  const [txLogMonth, setTxLogMonth] = useState<string>("all");
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
  const [paymentStandalone, setPaymentStandalone] = useState<boolean>(false);
  const [standalonePayments, setStandalonePayments] = useState<Map<string, number>>(new Map());
  // All invoice_payment rows with dates — used to compute month-aware
  // carry-forward in the Receivables view.
  const [allPaymentEvents, setAllPaymentEvents] = useState<
    { client_id: string | null; invoice_id: string | null; amount: number; payment_date: string }[]
  >([]);
  const [paymentVia, setPaymentVia] = useState<"Cash" | "Bank">("Bank");
  const [paymentBankId, setPaymentBankId] = useState<string>("");
  const [paymentNotes, setPaymentNotes] = useState<string>("");
  const [paymentDate, setPaymentDate] = useState<string>(todayStr());

  const [newBank, setNewBank] = useState({
    bank_name: "",
    account_number: "",
    account_type: "Current" as "Current" | "Savings",
    opening_balance: "",
    owner_type: "company" as BankAccountOwnerType,
    owner_partner_id: "",
    owner_client_id: "",
    iban: "",
    branch_code: "",
    branch_name: "",
    swift_code: "",
    currency_code: "PKR",
  });
  const [editBankForm, setEditBankForm] = useState({
    bank_name: "",
    account_number: "",
    account_type: "Current" as "Current" | "Savings",
    owner_type: "company" as BankAccountOwnerType,
    owner_partner_id: "",
    owner_client_id: "",
    iban: "",
    branch_code: "",
    branch_name: "",
    swift_code: "",
    currency_code: "PKR",
  });
  const [partners, setPartners] = useState<Partner[]>([]);

  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [transferFromId, setTransferFromId] = useState<string>("");
  const [transferToId, setTransferToId] = useState<string>("");
  const [transferAmount, setTransferAmount] = useState<string>("");
  const [transferNotes, setTransferNotes] = useState<string>("");
  const [transferDate, setTransferDate] = useState<string>(todayStr());
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
  // Per-bank pending cheque amounts (locked but not yet cleared).
  const pendingChequesByBank = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cheques) {
      if (c.status !== "pending") continue;
      m.set(c.bank_account_id, (m.get(c.bank_account_id) ?? 0) + Number(c.amount));
    }
    return m;
  }, [cheques]);
  const totalPendingCheques = useMemo(
    () => Array.from(pendingChequesByBank.values()).reduce((s, n) => s + n, 0),
    [pendingChequesByBank]
  );
  const grandTotal = cashBalance + totalAccountBalance + totalPendingCheques;

  // Apply month filter to receivables. For a specific month, the displayed
  // "Opening Balance" carries forward from the prior period: it equals the
  // client's *cumulative outstanding* through the day before the selected month
  // started. The "Outstanding" column then = Opening + this-month invoiced
  // − withholding − payments in this month, which is the running balance at
  // month-end.
  const displayedReceivables = useMemo(() => {
    if (receivablesMonth === "all") return receivables;

    const monthStart = `${receivablesMonth}-01`;
    const [yStr, mStr] = receivablesMonth.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    const lastDay = new Date(y, m, 0).getDate();
    const monthEnd = `${receivablesMonth}-${String(lastDay).padStart(2, "0")}`;

    // Build dated payment events for every client. For invoice_payments rows
    // missing a date (legacy data) and for the residual gap between an
    // invoice's amount_received and the sum of its invoice_payment rows, we
    // fall back to the invoice's own date.
    const paymentsByInvoice = new Map<string, number>();
    const datedPayments: { clientId: string; amount: number; date: string }[] = [];
    for (const p of allPaymentEvents) {
      let clientId = p.client_id ?? null;
      if (!clientId && p.invoice_id) {
        const inv = allInvoicesForRec.find((i) => i.id === p.invoice_id);
        if (inv) clientId = inv.client_id;
      }
      if (!clientId) continue;
      if (p.invoice_id) {
        paymentsByInvoice.set(
          p.invoice_id,
          (paymentsByInvoice.get(p.invoice_id) ?? 0) + Number(p.amount ?? 0),
        );
      }
      datedPayments.push({
        clientId,
        amount: Number(p.amount ?? 0),
        date: (p.payment_date ?? monthStart).slice(0, 10),
      });
    }
    // Add residuals: invoice.amount_received minus what we already counted via
    // invoice_payments rows — dated at the invoice's invoice_date.
    for (const inv of allInvoicesForRec) {
      const tracked = paymentsByInvoice.get(inv.id) ?? 0;
      const residual = Number(inv.amount_received ?? 0) - tracked;
      if (residual > 0.001) {
        datedPayments.push({
          clientId: inv.client_id,
          amount: residual,
          date: inv.invoice_date.slice(0, 10),
        });
      }
    }

    const sumInRange = (
      clientId: string,
      arr: { date: string; amount: number; clientId: string }[],
      from: string | null,
      to: string,
    ) =>
      arr
        .filter(
          (r) =>
            r.clientId === clientId &&
            (from === null || r.date >= from) &&
            r.date <= to,
        )
        .reduce((s, r) => s + r.amount, 0);

    const dayBeforeMonthStart = (() => {
      const d = new Date(monthStart);
      d.setDate(d.getDate() - 1);
      return d.toISOString().slice(0, 10);
    })();

    const rows: ReceivableRow[] = [];
    for (const c of allClientsForRec) {
      const allInvs = allInvoicesForRec.filter((i) => i.client_id === c.id);
      const monthInvs = allInvs.filter(
        (i) => (i.invoice_date ?? "").slice(0, 7) === receivablesMonth,
      );
      const priorInvs = allInvs.filter((i) => i.invoice_date < monthStart);

      const priorInvoiced = priorInvs.reduce((s, i) => s + Number(i.invoice_amount), 0);
      const priorWithholding = priorInvs.reduce(
        (s, i) => s + Number(i.withholding_tax ?? 0),
        0,
      );
      const priorReceived = sumInRange(c.id, datedPayments, null, dayBeforeMonthStart);

      // Opening for this month = cumulative outstanding through end of prior month.
      const openingForMonth =
        Number(c.opening_balance ?? 0) + priorInvoiced - priorWithholding - priorReceived;

      const total_invoiced = monthInvs.reduce((s, i) => s + Number(i.invoice_amount), 0);
      const total_withholding = monthInvs.reduce(
        (s, i) => s + Number(i.withholding_tax ?? 0),
        0,
      );
      const total_received = sumInRange(c.id, datedPayments, monthStart, monthEnd);

      const outstanding =
        openingForMonth + total_invoiced - total_withholding - total_received;

      // Show clients with any activity in this month OR a non-zero opening.
      const hasActivity =
        monthInvs.length > 0 ||
        total_received !== 0 ||
        Math.abs(openingForMonth) > 0.001;
      if (!hasActivity) continue;

      rows.push({
        ...c,
        opening_balance: openingForMonth,
        total_invoiced,
        total_withholding,
        total_received,
        outstanding,
        invoices: monthInvs,
      });
    }
    return rows;
  }, [receivables, receivablesMonth, allClientsForRec, allInvoicesForRec, allPaymentEvents]);

  const branchScopedReceivables = useMemo(() => {
    if (receivablesBranchFilter === "all") return displayedReceivables;
    return displayedReceivables.filter((r) => r.branch_id === receivablesBranchFilter);
  }, [displayedReceivables, receivablesBranchFilter]);

  const filteredReceivables = useMemo(() => {
    const q = receivablesSearch.trim().toLowerCase();
    return branchScopedReceivables.filter((r) => {
      if (receivablesClientFilter !== "all" && r.id !== receivablesClientFilter) return false;
      if (!q) return true;
      return (
        (r.name ?? "").toLowerCase().includes(q) ||
        (r.client_code ?? "").toLowerCase().includes(q)
      );
    });
  }, [branchScopedReceivables, receivablesClientFilter, receivablesSearch]);

  const receivableTotals = useMemo(() => {
    let opening = 0;
    let invoiced = 0;
    let withholding = 0;
    let received = 0;
    let outstanding = 0;
    for (const r of filteredReceivables) {
      opening += Number(r.opening_balance ?? 0);
      invoiced += r.total_invoiced;
      withholding += r.total_withholding;
      received += r.total_received;
      outstanding += r.outstanding;
    }
    return { opening, invoiced, withholding, received, outstanding };
  }, [filteredReceivables]);

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
    const [
      banksRes,
      treasuryRes,
      payablesRes,
      clientsRes,
      partnersRes,
      chequesRes,
    ] = await Promise.all([
      supabase.from("bank_accounts").select("*").order("created_at", { ascending: false }),
      supabase.from("treasury").select("*").limit(1).maybeSingle(),
      supabase
        .from("expenses")
        .select("*, vendor:vendor_id(id,name), category:category_id(id,name), client:client_id(id,name,client_code)")
        .eq("payment_mode", "Payable")
        .order("due_date", { ascending: true, nullsFirst: false }),
      supabase.from("clients").select("*").order("name"),
      supabase.from("partners").select("*").order("name"),
      supabase.from("cheques").select("*").order("cheque_date", { ascending: false }),
    ]);

    // Load branches for the receivables branch filter.
    {
      const { data: brData } = await supabase
        .from("branches")
        .select("id, name, is_head_office")
        .order("is_head_office", { ascending: false })
        .order("name");
      setBranchesList((brData ?? []) as { id: string; name: string }[]);
    }

    // Aggregate linked amounts per cheque (payment cheques use this for clearance).
    const [linkedPs, linkedEx, linkedAdv] = await Promise.all([
      supabase.from("payslips").select("cheque_id, net_salary").not("cheque_id", "is", null),
      supabase.from("expenses").select("cheque_id, amount").not("cheque_id", "is", null),
      supabase.from("advances").select("cheque_id, amount").not("cheque_id", "is", null),
    ]);
    const linkedMap = new Map<string, number>();
    for (const r of (linkedPs.data ?? []) as { cheque_id: string; net_salary: number }[]) {
      if (!r.cheque_id) continue;
      linkedMap.set(r.cheque_id, (linkedMap.get(r.cheque_id) ?? 0) + Number(r.net_salary));
    }
    for (const r of (linkedEx.data ?? []) as { cheque_id: string; amount: number }[]) {
      if (!r.cheque_id) continue;
      linkedMap.set(r.cheque_id, (linkedMap.get(r.cheque_id) ?? 0) + Number(r.amount));
    }
    for (const r of (linkedAdv.data ?? []) as { cheque_id: string; amount: number }[]) {
      if (!r.cheque_id) continue;
      linkedMap.set(r.cheque_id, (linkedMap.get(r.cheque_id) ?? 0) + Number(r.amount));
    }
    setChequeLinkedSums(linkedMap);
    // Paginate the three potentially-large tables.
    let txRows: BankTransaction[] = [];
    let invRows: Invoice[] = [];
    let allPayRows: {
      client_id: string | null;
      invoice_id: string | null;
      amount: number;
      payment_date: string;
    }[] = [];
    try {
      [txRows, invRows, allPayRows] = await Promise.all([
        fetchAllRows<BankTransaction>(() =>
          supabase
            .from("bank_transactions")
            .select("*")
            .order("created_at", { ascending: false }) as unknown as {
            range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
          },
        ),
        fetchAllRows<Invoice>(() =>
          supabase
            .from("invoices")
            .select("*")
            .order("invoice_date", { ascending: false }) as unknown as {
            range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
          },
        ),
        fetchAllRows<{
          client_id: string | null;
          invoice_id: string | null;
          amount: number;
          payment_date: string;
        }>(() =>
          supabase
            .from("invoice_payments")
            .select("client_id, invoice_id, amount, payment_date")
            .order("payment_date", { ascending: false }) as unknown as {
            range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
          },
        ),
      ]);
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
    setPartners((partnersRes.data ?? []) as Partner[]);
    setAllPaymentEvents(allPayRows);
    const standaloneMap = new Map<string, number>();
    for (const row of allPayRows) {
      if (row.invoice_id) continue; // only standalone (no invoice) here
      if (!row.client_id) continue;
      standaloneMap.set(row.client_id, (standaloneMap.get(row.client_id) ?? 0) + Number(row.amount));
    }
    setStandalonePayments(standaloneMap);
    if (banksRes.error) setError(banksRes.error.message);
    if (treasuryRes.error) setError(treasuryRes.error.message);
    if (payablesRes.error) setError(payablesRes.error.message);
    if (clientsRes.error) setError(clientsRes.error.message);
    setBanks((banksRes.data ?? []) as BankAccount[]);
    if (chequesRes.error) setError(chequesRes.error.message);
    setCheques((chequesRes.data ?? []) as Cheque[]);
    setCashBalance(Number(treasuryRes.data?.cash_balance ?? 0));
    setCashOpeningBalance(Number(treasuryRes.data?.cash_opening_balance ?? 0));
    setCashOpeningLocked(Boolean(treasuryRes.data?.cash_opening_locked ?? false));
    setTreasuryId(treasuryRes.data?.id ?? null);
    setTransactions(txRows);
    setPayables((payablesRes.data ?? []) as PayableRow[]);

    const allClients = (clientsRes.data ?? []) as Client[];
    const allInvoices = invRows;
    setAllClientsForRec(allClients);
    setAllInvoicesForRec(allInvoices);
    const byClient = new Map<string, Invoice[]>();
    for (const inv of allInvoices) {
      const arr = byClient.get(inv.client_id) ?? [];
      arr.push(inv);
      byClient.set(inv.client_id, arr);
    }
    const rec: ReceivableRow[] = allClients.map((c) => {
      const invs = byClient.get(c.id) ?? [];
      const total_invoiced = invs.reduce((s, i) => s + Number(i.invoice_amount), 0);
      const total_withholding = invs.reduce((s, i) => s + Number(i.withholding_tax ?? 0), 0);
      const invoice_received = invs.reduce((s, i) => s + Number(i.amount_received), 0);
      const standalone_received = standaloneMap.get(c.id) ?? 0;
      const total_received = invoice_received + standalone_received;
      const outstanding =
        Number(c.opening_balance ?? 0) + total_invoiced - total_withholding - total_received;
      return {
        ...c,
        total_invoiced,
        total_withholding,
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
    created_at?: string;
  }) => {
    const { error: logErr } = await supabase.from("bank_transactions").insert(row);
    if (logErr) throw logErr;
  };

  // Convert a YYYY-MM-DD date into a midday ISO timestamp so the ledger entry
  // lands on the chosen day regardless of timezone.
  const dateToTs = (d: string) => new Date(`${d}T12:00:00`).toISOString();

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
    if (newBank.owner_type === "partner" && !newBank.owner_partner_id) {
      setError("Select which partner owns this account.");
      return;
    }
    if (newBank.owner_type === "client" && !newBank.owner_client_id) {
      setError("Select which client owns this account.");
      return;
    }
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
          owner_type: newBank.owner_type,
          owner_partner_id: newBank.owner_type === "partner" ? newBank.owner_partner_id : null,
          owner_client_id: newBank.owner_type === "client" ? newBank.owner_client_id : null,
          iban: newBank.iban.trim() || null,
          branch_code: newBank.branch_code.trim() || null,
          branch_name: newBank.branch_name.trim() || null,
          swift_code: newBank.swift_code.trim() || null,
          currency_code: newBank.currency_code || "PKR",
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
      setNewBank({
        bank_name: "",
        account_number: "",
        account_type: "Current",
        opening_balance: "",
        owner_type: "company",
        owner_partner_id: "",
        owner_client_id: "",
        iban: "",
        branch_code: "",
        branch_name: "",
        swift_code: "",
        currency_code: "PKR",
      });
      setIsBankModalOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetCashOpening = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cashOpeningLocked) return;
    const amt = Number(cashOpeningInput);
    if (!Number.isFinite(amt) || amt < 0) {
      setError("Opening cash balance must be a non-negative number.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let id = treasuryId;
      if (!id) {
        const { data: ins, error: insErr } = await supabase
          .from("treasury")
          .insert({
            cash_balance: amt,
            cash_opening_balance: amt,
            cash_opening_locked: true,
          })
          .select("id")
          .single();
        if (insErr) throw insErr;
        id = (ins as { id: string }).id;
      } else {
        const { error: upErr } = await supabase
          .from("treasury")
          .update({
            cash_balance: cashBalance + amt,
            cash_opening_balance: amt,
            cash_opening_locked: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);
        if (upErr) throw upErr;
      }
      await logTransaction({
        bank_account_id: null,
        kind: "opening",
        amount: amt,
        cash_delta: amt,
        account_delta: 0,
        description: "Opening cash balance",
      });
      setIsCashOpeningOpen(false);
      setCashOpeningInput("");
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transferFromId || !transferToId || transferFromId === transferToId) {
      setError("Pick two different accounts.");
      return;
    }
    const amount = Number(transferAmount);
    if (!amount || amount <= 0) {
      setError("Enter a positive amount.");
      return;
    }
    if (!transferDate) {
      setError("Select a transfer date.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const fromBank = banks.find((b) => b.id === transferFromId);
      const toBank = banks.find((b) => b.id === transferToId);
      const pairId = crypto.randomUUID();
      const noteSuffix = transferNotes.trim() ? ` · ${transferNotes.trim()}` : "";
      const desc = `Transfer ${fromBank?.bank_name ?? "?"} → ${toBank?.bank_name ?? "?"}${noteSuffix}`;
      const ts = dateToTs(transferDate);
      await applyBankDelta(transferFromId, -amount);
      await applyBankDelta(transferToId, amount);
      await logTransaction({
        bank_account_id: transferFromId,
        kind: "transfer",
        amount,
        cash_delta: 0,
        account_delta: -amount,
        description: desc,
        reference_id: pairId,
        created_at: ts,
      });
      await logTransaction({
        bank_account_id: transferToId,
        kind: "transfer",
        amount,
        cash_delta: 0,
        account_delta: amount,
        description: desc,
        reference_id: pairId,
        created_at: ts,
      });
      // Mark transfer_pair_id explicitly on both rows
      await supabase
        .from("bank_transactions")
        .update({ transfer_pair_id: pairId })
        .eq("reference_id", pairId);

      setTransferFromId("");
      setTransferToId("");
      setTransferAmount("");
      setTransferNotes("");
      setIsTransferModalOpen(false);
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
      owner_type: bank.owner_type,
      owner_partner_id: bank.owner_partner_id ?? "",
      owner_client_id: bank.owner_client_id ?? "",
      iban: bank.iban ?? "",
      branch_code: bank.branch_code ?? "",
      branch_name: bank.branch_name ?? "",
      swift_code: bank.swift_code ?? "",
      currency_code: bank.currency_code ?? "PKR",
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
          owner_type: editBankForm.owner_type,
          owner_partner_id: editBankForm.owner_type === "partner" ? editBankForm.owner_partner_id : null,
          owner_client_id: editBankForm.owner_type === "client" ? editBankForm.owner_client_id : null,
          iban: editBankForm.iban.trim() || null,
          branch_code: editBankForm.branch_code.trim() || null,
          branch_name: editBankForm.branch_name.trim() || null,
          swift_code: editBankForm.swift_code.trim() || null,
          currency_code: editBankForm.currency_code || "PKR",
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

  const handleToggleBankActive = async (bank: BankAccount) => {
    const next = !bank.active;
    const msg = next
      ? `Activate "${bank.bank_name} (${bank.account_number})"? It will be selectable again for payments and reconciliation.`
      : `Deactivate "${bank.bank_name} (${bank.account_number})"? Its balance and history are preserved; it just won't appear in new payment/selection lists.`;
    if (!window.confirm(msg)) return;
    setError(null);
    const { error: delErr } = await supabase
      .from("bank_accounts")
      .update({ active: next, updated_at: new Date().toISOString() })
      .eq("id", bank.id);
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
    return payables.filter((p) => {
      if (
        payablesMonth !== "all" &&
        (p.expense_date ?? "").slice(0, 7) !== payablesMonth
      ) {
        return false;
      }
      if (payableStatusFilter === "all") return true;
      const status = payableDisplayStatus(p);
      if (payableStatusFilter === "pending") return status === "Pending";
      if (payableStatusFilter === "paid") return status === "Paid";
      if (payableStatusFilter === "overdue") return status === "Overdue";
      return true;
    });
  }, [payables, payableStatusFilter, payablesMonth]);

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
      (i) =>
        Number(i.invoice_amount) -
          Number(i.withholding_tax ?? 0) -
          Number(i.amount_received) >
        0,
    );
    // If admin and there are no open invoices, default to standalone mode.
    const noOpen = !openInvoice;
    setPaymentStandalone(isAdmin && noOpen);
    setPaymentInvoiceId(openInvoice?.id ?? "");
    setPaymentAmount("");
    setPaymentVia("Bank");
    setPaymentBankId(banks[0]?.id ?? "");
    setPaymentNotes("");
    setPaymentDate(todayStr());
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
    const amount = Number(paymentAmount);
    if (!amount || amount <= 0) {
      setError("Enter a positive payment amount.");
      return;
    }
    if (paymentVia === "Bank" && !paymentBankId) {
      setError("Select the bank account that received the payment.");
      return;
    }

    // Standalone payment (no invoice). Only allowed for SSA / Super Admin.
    if (paymentStandalone) {
      if (!isAdmin) {
        setError("Only Super Admin can record payments without an invoice.");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const ts = dateToTs(paymentDate);
        const desc = `Payment received (${paymentVia.toLowerCase()}) · ${selectedClient.name} · No invoice`;
        if (paymentVia === "Cash") {
          await applyCashDelta(amount);
          await logTransaction({
            bank_account_id: null,
            kind: "receipt",
            amount,
            cash_delta: amount,
            account_delta: 0,
            description: desc,
            reference_id: selectedClient.id,
            created_at: ts,
          });
        } else {
          await applyBankDelta(paymentBankId, amount);
          await logTransaction({
            bank_account_id: paymentBankId,
            kind: "receipt",
            amount,
            cash_delta: 0,
            account_delta: amount,
            description: desc,
            reference_id: selectedClient.id,
            created_at: ts,
          });
        }
        const { error: payErr } = await supabase.from("invoice_payments").insert({
          invoice_id: null,
          client_id: selectedClient.id,
          amount,
          payment_date: paymentDate,
          payment_mode: paymentVia,
          bank_account_id: paymentVia === "Bank" ? paymentBankId : null,
          notes: paymentNotes.trim() || null,
        });
        if (payErr) throw payErr;
        setIsPaymentModalOpen(false);
        await loadAll();
      } catch (e: any) {
        setError(e.message ?? String(e));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Invoice-linked payment.
    if (!paymentInvoiceId) {
      setError("Select an invoice to apply this payment to.");
      return;
    }
    const invoice = selectedClient.invoices.find((i) => i.id === paymentInvoiceId);
    if (!invoice) {
      setError("Selected invoice not found.");
      return;
    }
    const openAmount =
      Number(invoice.invoice_amount) -
      Number(invoice.withholding_tax ?? 0) -
      Number(invoice.amount_received);
    if (amount > openAmount) {
      setError(`Payment exceeds the outstanding amount on this invoice (PKR ${openAmount.toLocaleString()}).`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const ts = dateToTs(paymentDate);
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
          created_at: ts,
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
          created_at: ts,
        });
      }
      const { error: upErr } = await supabase
        .from("invoices")
        .update({
          amount_received: Number(invoice.amount_received) + amount,
          notes: paymentNotes.trim()
            ? `${invoice.notes ? invoice.notes + "\n" : ""}[${paymentDate}] Payment PKR ${amount.toLocaleString()} via ${paymentVia}: ${paymentNotes.trim()}`
            : invoice.notes,
          updated_at: new Date().toISOString(),
        })
        .eq("id", invoice.id);
      if (upErr) throw upErr;
      // Also log to invoice_payments so Cashflow's payment-based Revenue picks it up.
      await supabase.from("invoice_payments").insert({
        invoice_id: invoice.id,
        client_id: selectedClient.id,
        amount,
        payment_date: paymentDate,
        payment_mode: paymentVia,
        bank_account_id: paymentVia === "Bank" ? paymentBankId : null,
        notes: paymentNotes.trim() || null,
      });
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
        title="Banks & Ledgers"
        subtitle="Bank accounts, cheques and reconciliation"
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
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => {
                    setTransferFromId("");
                    setTransferToId("");
                    setTransferAmount("");
                    setTransferNotes("");
                    setTransferDate(todayStr());
                    setIsTransferModalOpen(true);
                  }}
                  disabled={banks.length < 2}
                  title={banks.length < 2 ? "Need at least 2 accounts" : "Wire money between accounts"}
                >
                  <ArrowLeftRight className="w-4 h-4 mr-2" strokeWidth={1.5} />
                  Wire Transfer
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
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {activeTab === "banks" && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-success-500">
              <div className="flex items-center justify-between">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Cash in Hand</p>
                {!cashOpeningLocked ? (
                  <button
                    type="button"
                    onClick={() => {
                      setCashOpeningInput("");
                      setIsCashOpeningOpen(true);
                    }}
                    className="text-[11px] px-2 py-0.5 rounded border border-success-300 text-success-800 hover:bg-success-100"
                  >
                    Set Opening
                  </button>
                ) : (
                  <span className="text-[10px] text-success-700/70" title={`Opening balance set to PKR ${cashOpeningBalance.toLocaleString()}`}>
                    Opening locked
                  </span>
                )}
              </div>
              <p className="text-2xl text-success-900">PKR {cashBalance.toLocaleString()}</p>
              {cashOpeningLocked && (
                <p className="text-[11px] text-success-700/80 mt-1">
                  Opening: PKR {cashOpeningBalance.toLocaleString()}
                </p>
              )}
            </div>
            <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-brand-500">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Bank Balance</p>
              <p className="text-2xl text-brand-900">PKR {totalAccountBalance.toLocaleString()}</p>
            </div>
            <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-warning-500">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Cheques in Transit</p>
              <p className="text-2xl text-warning-900">PKR {totalPendingCheques.toLocaleString()}</p>
            </div>
            <div className="bg-slate-900 p-4 rounded-lg">
              <p className="text-xs text-slate-300 mb-1">Net Available Cash</p>
              <p className="text-2xl text-white">PKR {grandTotal.toLocaleString()}</p>
            </div>
          </div>
        )}

        {activeTab === "receivables" && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
              <p className="text-xs text-slate-600 mb-1">Opening Balance</p>
              <p className="text-xl text-slate-900">
                PKR {receivableTotals.opening.toLocaleString()}
              </p>
            </div>
            <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-brand-500">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total Invoiced</p>
              <p className="text-xl text-brand-900">
                PKR {receivableTotals.invoiced.toLocaleString()}
              </p>
            </div>
            <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-danger-500">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Withholding Tax</p>
              <p className="text-xl text-danger-900">
                PKR {receivableTotals.withholding.toLocaleString()}
              </p>
            </div>
            <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-success-500">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total Received</p>
              <p className="text-xl text-success-900">
                PKR {receivableTotals.received.toLocaleString()}
              </p>
            </div>
            <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-warning-500">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Outstanding</p>
              <p className="text-xl text-warning-900">
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
            <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-warning-500">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Pending</p>
              <p className="text-xl text-warning-900">
                PKR {payableTotals.pending.toLocaleString()}
              </p>
            </div>
            <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-danger-500">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Overdue</p>
              <p className="text-xl text-danger-900">
                PKR {payableTotals.overdue.toLocaleString()}
              </p>
            </div>
            <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-success-500">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Paid</p>
              <p className="text-xl text-success-900">
                PKR {payableTotals.paid.toLocaleString()}
              </p>
            </div>
          </div>
        )}

        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-6 border-b border-slate-200 flex flex-wrap items-center gap-3">
            <div className="flex gap-2 flex-wrap">
              {(["receivables", "payables", "banks"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 rounded-md text-sm transition-colors ${
                    activeTab === tab
                      ? "bg-brand-600 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {tab === "receivables" && "Client Receivables"}
                  {tab === "payables" && "Accounts Payable"}
                  {tab === "banks" && "Bank Accounts"}
                </button>
              ))}
            </div>
            {activeTab === "receivables" && (
              <div className="ml-auto flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" strokeWidth={1.5} />
                  <input
                    type="text"
                    value={receivablesSearch}
                    onChange={(e) => setReceivablesSearch(e.target.value)}
                    placeholder="Search client / code…"
                    className="pl-8 pr-3 py-1.5 border border-slate-200 rounded-md text-sm w-56"
                  />
                </div>
                <label className="text-xs text-slate-500">Client:</label>
                <select
                  value={receivablesClientFilter}
                  onChange={(e) => setReceivablesClientFilter(e.target.value)}
                  className="px-3 py-1.5 border border-slate-200 rounded-md text-sm max-w-[14rem]"
                >
                  <option value="all">All Clients</option>
                  {[...allClientsForRec]
                    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
                    .map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                </select>
                <label className="text-xs text-slate-500">Branch:</label>
                <select
                  value={receivablesBranchFilter}
                  onChange={(e) => setReceivablesBranchFilter(e.target.value)}
                  className="px-3 py-1.5 border border-slate-200 rounded-md text-sm"
                >
                  <option value="all">All Branches</option>
                  {branchesList.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                <label className="text-xs text-slate-500">Month:</label>
                <select
                  value={receivablesMonth}
                  onChange={(e) => setReceivablesMonth(e.target.value)}
                  className="px-3 py-1.5 border border-slate-200 rounded-md text-sm"
                >
                  <option value="all">All Months</option>
                  {monthOptions.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              </div>
            )}
            {activeTab === "payables" && (
              <div className="ml-auto flex items-center gap-2">
                <label className="text-xs text-slate-500">Month:</label>
                <select
                  value={payablesMonth}
                  onChange={(e) => setPayablesMonth(e.target.value)}
                  className="px-3 py-1.5 border border-slate-200 rounded-md text-sm"
                >
                  <option value="all">All Months</option>
                  {monthOptions.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {activeTab === "receivables" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Opening Balance</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Invoiced</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Withholding</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Received</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Outstanding</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {loading && (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-slate-500">
                        <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                      </td>
                    </tr>
                  )}
                  {!loading && filteredReceivables.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">
                        No client activity matching the current filters.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    filteredReceivables.map((item) => {
                      const isMonthView = receivablesMonth !== "all";
                      const canEditOpening = item.outstanding === 0 && !isMonthView;
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
                              <span title={isMonthView ? "Carried forward from prior period" : undefined}>
                                PKR {Number(item.opening_balance ?? 0).toLocaleString()}
                              </span>
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
                                  isMonthView
                                    ? "Switch to 'All Months' to edit the opening balance"
                                    : canEditOpening
                                      ? "Edit opening balance"
                                      : "Clear outstanding balance before editing opening balance"
                                }
                              >
                                <Pencil className="w-3 h-3" strokeWidth={1.5} />
                              </button>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-brand-600 text-right">
                            PKR {item.total_invoiced.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-sm text-danger-600 text-right">
                            PKR {item.total_withholding.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-sm text-success-600 text-right">
                            PKR {item.total_received.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-sm text-right">
                            <span className={item.outstanding > 0 ? "text-warning-600" : "text-success-600"}>
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
                              disabled={
                                !isAdmin &&
                                item.invoices.every(
                                  (i) =>
                                    Number(i.invoice_amount) -
                                      Number(i.withholding_tax ?? 0) -
                                      Number(i.amount_received) <=
                                    0,
                                )
                              }
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
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-warning-50 text-warning-800">
                    Pending: PKR {payablesSummary.pendingTotal.toLocaleString()}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-danger-50 text-danger-700">
                    Overdue: PKR {payablesSummary.overdueTotal.toLocaleString()}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-success-50 text-success-700">
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
                            ? "bg-success-50 text-success-700"
                            : status === "Overdue"
                            ? "bg-danger-50 text-danger-700"
                            : "bg-warning-50 text-warning-700";
                        return (
                          <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-4 text-sm text-slate-900">{item.vendor?.name ?? "—"}</td>
                            <td className="px-6 py-4 text-sm text-slate-600">{item.category?.name ?? "—"}</td>
                            <td className="px-6 py-4 text-sm text-slate-600">
                              {item.client?.name ?? <span className="text-slate-400">Office</span>}
                            </td>
                            <td className="px-6 py-4 text-sm text-danger-600">
                              PKR {Number(item.amount).toLocaleString()}
                            </td>
                            <td className="px-6 py-4 text-sm text-slate-600">{formatDate(item.expense_date)}</td>
                            <td className="px-6 py-4 text-sm text-slate-600">{item.due_date ? formatDate(item.due_date) : "—"}</td>
                            <td className="px-6 py-4">
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${statusClass}`}>
                                {status}
                              </span>
                              {status === "Paid" && item.paid_via && (
                                <div className="text-[10px] text-slate-500 mt-1">
                                  via {item.paid_via}
                                  {item.paid_at ? ` · ${formatDate(item.paid_at)}` : ""}
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
            <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Bank Name</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Account Number</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Owner</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Account Balance</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Cheque Balance</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Total Balance</th>
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
                  {!loading && banks.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-6 py-10 text-center text-slate-500 text-sm">
                        No bank accounts yet. Click "Add Bank Account" to create one.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    banks.map((bank) => {
                      const acct = Number(bank.balance ?? 0);
                      const pendChq = pendingChequesByBank.get(bank.id) ?? 0;
                      const totalBal = acct + pendChq;
                      return (
                        <tr key={bank.id} className={`hover:bg-slate-50 transition-colors ${bank.active ? "" : "opacity-60"}`}>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <Building2 className="w-4 h-4 text-brand-600" strokeWidth={1.5} />
                              <span className="text-sm text-slate-900">{bank.bank_name}</span>
                              {!bank.active && (
                                <span className="inline-block px-2 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-600 border border-slate-200">
                                  Inactive
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-600 font-mono">{bank.account_number}</td>
                          <td className="px-6 py-4 text-sm text-slate-600">{bank.account_type}</td>
                          <td className="px-6 py-4 text-sm text-slate-600">
                            {bank.owner_type === "company" && <span className="text-slate-500">Company</span>}
                            {bank.owner_type === "partner" && (
                              <span className="text-purple-700">
                                Partner: {partners.find((p) => p.id === bank.owner_partner_id)?.name ?? "—"}
                              </span>
                            )}
                            {bank.owner_type === "client" && (
                              <span className="text-warning-700">
                                Client: {receivables.find((c) => c.id === bank.owner_client_id)?.name ?? "—"}
                              </span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-sm text-brand-600">PKR {acct.toLocaleString()}</td>
                          <td className="px-6 py-4 text-sm text-warning-600">
                            {pendChq > 0 ? `PKR ${pendChq.toLocaleString()}` : "—"}
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-900">PKR {totalBal.toLocaleString()}</td>
                          <td className="px-6 py-4 flex gap-2 flex-wrap">
                            <Button variant="ghost" size="sm" onClick={() => openReconcile(bank)}>
                              Reconcile
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openEditBank(bank)}>
                              Edit
                            </Button>
                            <button
                              type="button"
                              onClick={() => handleToggleBankActive(bank)}
                              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs ${
                                bank.active
                                  ? "text-danger-700 hover:bg-danger-50"
                                  : "text-success-700 hover:bg-success-50"
                              }`}
                              title={bank.active ? "Deactivate bank account" : "Activate bank account"}
                            >
                              <Power className="w-4 h-4" strokeWidth={1.5} />
                              {bank.active ? "Deactivate" : "Activate"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>

            <div className="border-t border-slate-200 p-6">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-base text-slate-900">Cheques</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Outgoing cheques deduct the bank's Account Balance immediately. Pending cheques add to the Total Balance until cleared.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={chequeBankFilter}
                    onChange={(e) => setChequeBankFilter(e.target.value)}
                    className="px-3 py-1.5 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="all">All Banks</option>
                    {banks.map((b) => (
                      <option key={b.id} value={b.id}>{b.bank_name}</option>
                    ))}
                  </select>
                  <select
                    value={chequeFilter}
                    onChange={(e) => setChequeFilter(e.target.value as "all" | "pending" | "cleared")}
                    className="px-3 py-1.5 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="all">All Status</option>
                    <option value="pending">Pending</option>
                    <option value="cleared">Cleared</option>
                  </select>
                  <select
                    value={chequeMonthFilter}
                    onChange={(e) => setChequeMonthFilter(e.target.value)}
                    className="px-3 py-1.5 border border-slate-200 rounded-md text-sm"
                  >
                    <option value="all">All Months</option>
                    {monthOptions.map((m) => (
                      <option key={m.key} value={m.key}>{m.label}</option>
                    ))}
                  </select>
                  <Button variant="primary" size="sm" onClick={() => setIsChequeAddOpen(true)} disabled={banks.length === 0}>
                    <Plus className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                    New Cheque
                  </Button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50">
                      <th className="text-left px-4 py-2 text-xs text-slate-500 uppercase tracking-wide">Cheque #</th>
                      <th className="text-left px-4 py-2 text-xs text-slate-500 uppercase tracking-wide">Type</th>
                      <th className="text-left px-4 py-2 text-xs text-slate-500 uppercase tracking-wide">Bank</th>
                      <th className="text-left px-4 py-2 text-xs text-slate-500 uppercase tracking-wide">Date</th>
                      <th className="text-left px-4 py-2 text-xs text-slate-500 uppercase tracking-wide">Recipient</th>
                      <th className="text-right px-4 py-2 text-xs text-slate-500 uppercase tracking-wide">Amount</th>
                      <th className="text-right px-4 py-2 text-xs text-slate-500 uppercase tracking-wide">Used / Linked</th>
                      <th className="text-left px-4 py-2 text-xs text-slate-500 uppercase tracking-wide">Status</th>
                      <th className="text-left px-4 py-2 text-xs text-slate-500 uppercase tracking-wide">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {cheques
                      .filter((c) => chequeBankFilter === "all" || c.bank_account_id === chequeBankFilter)
                      .filter((c) => chequeFilter === "all" || c.status === chequeFilter)
                      .filter((c) => chequeMonthFilter === "all" || (c.cheque_date ?? "").slice(0, 7) === chequeMonthFilter)
                      .map((c) => {
                        const bank = banks.find((b) => b.id === c.bank_account_id);
                        const linkedSum = chequeLinkedSums.get(c.id) ?? 0;
                        const isPayment = c.cheque_type === "payment";
                        const canClear = isPayment ? Math.abs(linkedSum - Number(c.amount)) < 0.005 : true;
                        return (
                          <tr key={c.id} className="hover:bg-slate-50">
                            <td className="px-4 py-2 text-sm text-slate-900 font-mono">{c.cheque_number}</td>
                            <td className="px-4 py-2 text-sm">
                              {isPayment ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-indigo-50 text-indigo-700">Payment</span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-teal-50 text-teal-700">Cash</span>
                              )}
                            </td>
                            <td className="px-4 py-2 text-sm text-slate-600">{bank?.bank_name ?? "—"}</td>
                            <td className="px-4 py-2 text-sm text-slate-600">{formatDate(c.cheque_date)}</td>
                            <td className="px-4 py-2 text-sm text-slate-600">{c.recipient ?? "—"}</td>
                            <td className="px-4 py-2 text-sm text-slate-900 text-right">
                              PKR {Number(c.amount).toLocaleString()}
                            </td>
                            <td className="px-4 py-2 text-sm text-right">
                              {isPayment ? (
                                <span className={canClear ? "text-success-700" : "text-warning-700"}>
                                  PKR {linkedSum.toLocaleString()} / {Number(c.amount).toLocaleString()}
                                </span>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              {c.status === "pending" ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-warning-50 text-warning-700">
                                  Pending
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-success-50 text-success-700">
                                  Cleared{c.cleared_at ? ` · ${c.cleared_at.slice(0, 10)}` : ""}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2 flex gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={async () => {
                                  setChequeView(c);
                                  setChequeViewItems([]);
                                  setChequeViewAttachmentUrl(null);
                                  const [psR, exR, advR, ipR] = await Promise.all([
                                    supabase
                                      .from("payslips")
                                      .select("id, net_salary, period_month, employee:employee_id(full_name, employee_code)")
                                      .eq("cheque_id", c.id),
                                    supabase
                                      .from("expenses")
                                      .select("id, amount, expense_date, description, category:category_id(name), client:client_id(name)")
                                      .eq("cheque_id", c.id),
                                    supabase
                                      .from("advances")
                                      .select("id, amount, advance_date, employee:employee_id(full_name, employee_code), client:client_id(name)")
                                      .eq("cheque_id", c.id),
                                    supabase
                                      .from("invoice_payments")
                                      .select("id, amount, payment_date, invoice:invoice_id(invoice_number), client:client_id(name)")
                                      .eq("cheque_id", c.id),
                                  ]);
                                  const items: typeof chequeViewItems = [];
                                  for (const p of (psR.data ?? []) as any[]) {
                                    items.push({
                                      kind: "Payslip",
                                      description: `${p.employee?.employee_code ?? ""} ${p.employee?.full_name ?? ""} · ${String(p.period_month ?? "").slice(0, 7)}`,
                                      amount: Number(p.net_salary ?? 0),
                                      date: String(p.period_month ?? "").slice(0, 10),
                                    });
                                  }
                                  for (const e of (exR.data ?? []) as any[]) {
                                    items.push({
                                      kind: "Expense",
                                      description: `${e.category?.name ?? "Expense"}${e.client?.name ? ` · ${e.client.name}` : ""}${e.description ? ` · ${e.description}` : ""}`,
                                      amount: Number(e.amount ?? 0),
                                      date: e.expense_date,
                                    });
                                  }
                                  for (const a of (advR.data ?? []) as any[]) {
                                    items.push({
                                      kind: "Advance",
                                      description: `${a.employee?.employee_code ?? ""} ${a.employee?.full_name ?? ""}${a.client?.name ? ` · ${a.client.name}` : ""}`,
                                      amount: Number(a.amount ?? 0),
                                      date: a.advance_date,
                                    });
                                  }
                                  for (const p of (ipR.data ?? []) as any[]) {
                                    items.push({
                                      kind: "Invoice Payment",
                                      description: `${p.invoice?.invoice_number ?? ""}${p.client?.name ? ` · ${p.client.name}` : ""}`,
                                      amount: Number(p.amount ?? 0),
                                      date: p.payment_date,
                                    });
                                  }
                                  items.sort((a, b) => (a.date < b.date ? 1 : -1));
                                  setChequeViewItems(items);
                                  // Prefer Drive URL when present (new uploads).
                                  // Fall back to a signed Storage URL for legacy rows.
                                  if (c.drive_view_url) {
                                    setChequeViewAttachmentUrl(c.drive_view_url);
                                  } else if (c.attachment_path) {
                                    const { data: signed } = await supabase.storage
                                      .from(CHEQUE_ATTACHMENTS_BUCKET)
                                      .createSignedUrl(c.attachment_path, 3600);
                                    setChequeViewAttachmentUrl(signed?.signedUrl ?? null);
                                  }
                                }}
                              >
                                <FileText className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                                View
                              </Button>
                              {c.status === "pending" && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={!canClear}
                                  title={
                                    canClear
                                      ? (isPayment
                                          ? "Mark cleared (bank balance stays deducted)"
                                          : "Mark cleared (cash balance increases by cheque amount)")
                                      : `Linked items total PKR ${linkedSum.toLocaleString()} must equal cheque amount PKR ${Number(c.amount).toLocaleString()} before clearing.`
                                  }
                                  onClick={async () => {
                                    const msg = isPayment
                                      ? "Mark this payment cheque as cleared? Bank stays deducted; cashflow recognises linked expenses/salaries/advances now."
                                      : "Mark this cash cheque as cleared? Bank stays deducted; PKR " + Number(c.amount).toLocaleString() + " will be added to the Cash (Treasury) balance.";
                                    if (!window.confirm(msg)) return;
                                    const { error: e } = await supabase
                                      .from("cheques")
                                      .update({ status: "cleared" })
                                      .eq("id", c.id);
                                    if (e) { setError(e.message); return; }
                                    await loadAll();
                                  }}
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                                  Mark Cleared
                                </Button>
                              )}
                              {c.status === "pending" && (
                                <button
                                  type="button"
                                  className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-danger-700 hover:bg-danger-50"
                                  title="Delete cheque (restores bank balance)"
                                  onClick={async () => {
                                    if (!window.confirm("Delete this pending cheque? The reserved amount will be restored to the bank.")) return;
                                    const { error: e } = await supabase.from("cheques").delete().eq("id", c.id);
                                    if (e) { setError(e.message); return; }
                                    await loadAll();
                                  }}
                                >
                                  <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    {cheques.filter((c) => chequeBankFilter === "all" || c.bank_account_id === chequeBankFilter)
                            .filter((c) => chequeFilter === "all" || c.status === chequeFilter)
                            .filter((c) => chequeMonthFilter === "all" || (c.cheque_date ?? "").slice(0, 7) === chequeMonthFilter).length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-4 py-6 text-center text-sm text-slate-500">
                          No cheques to show.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            </>
          )}
        </div>
      </div>

      <Modal isOpen={isChequeAddOpen} onClose={() => { setIsChequeAddOpen(false); setChequeFormError(null); }} title="New Cheque" size="md">
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setChequeFormError(null);
            const amount = Number(chequeForm.amount);
            if (!chequeForm.bank_account_id || !chequeForm.cheque_number || !amount || amount <= 0 || !chequeForm.cheque_date) return;
            // Block over-issue at the moment of cheque creation: amount must not exceed
            // the issuing bank account's available balance.
            const issuingBank = banks.find((b) => b.id === chequeForm.bank_account_id);
            if (issuingBank && amount > Number(issuingBank.balance)) {
              setChequeFormError(`Cheque amount (PKR ${amount.toLocaleString()}) exceeds the bank's available balance (PKR ${Number(issuingBank.balance).toLocaleString()}).`);
              return;
            }
            setChequeSubmitting(true);
            setError(null);
            try {
              const { data: inserted, error: insErr } = await supabase
                .from("cheques")
                .insert({
                  bank_account_id: chequeForm.bank_account_id,
                  cheque_number: chequeForm.cheque_number.trim(),
                  amount,
                  cheque_date: chequeForm.cheque_date,
                  cheque_type: chequeForm.cheque_type,
                  recipient: chequeForm.recipient.trim() || null,
                  notes: chequeForm.notes.trim() || null,
                  status: "pending",
                })
                .select()
                .single();
              if (insErr) throw insErr;
              const chequeId = (inserted as Cheque).id;
              if (chequeForm.attachment) {
                const file = chequeForm.attachment;
                const effectiveCompanyId =
                  profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
                if (!effectiveCompanyId || !company?.name) {
                  throw new Error("Company not loaded — refresh and try again.");
                }
                const fd = new FormData();
                fd.append("file", file);
                fd.append("category", "cheques");
                fd.append("company_id", effectiveCompanyId);
                fd.append("company_name", company.name);
                const { data: uploaded, error: fnErr } = await supabase.functions.invoke(
                  "gdrive-upload",
                  { body: fd },
                );
                if (fnErr) {
                  let detail = fnErr.message;
                  try {
                    const ctx = (fnErr as { context?: Response }).context;
                    if (ctx) detail = (await ctx.clone().json())?.error ?? detail;
                  } catch { /* ignore */ }
                  throw new Error(`Drive upload failed: ${detail}`);
                }
                if (!uploaded?.drive_file_id) {
                  throw new Error(uploaded?.error ?? "Upload failed");
                }
                await supabase.from("cheques").update({
                  drive_file_id: uploaded.drive_file_id,
                  drive_view_url: uploaded.drive_view_url,
                  attachment_file_name: uploaded.file_name ?? file.name,
                }).eq("id", chequeId);
              }
              setIsChequeAddOpen(false);
              setChequeForm({
                bank_account_id: "",
                cheque_number: "",
                amount: "",
                cheque_date: new Date().toISOString().slice(0, 10),
                cheque_type: "payment",
                recipient: "",
                notes: "",
                attachment: undefined,
              });
              await loadAll();
            } catch (err: any) {
              setChequeFormError(err.message ?? String(err));
            } finally {
              setChequeSubmitting(false);
            }
          }}
        >
          {chequeFormError && (
            <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={2} />
              <div className="flex-1">{chequeFormError}</div>
              <button type="button" onClick={() => setChequeFormError(null)}>
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
          <div>
            <label className="block text-sm text-slate-700 mb-1">Cheque Type *</label>
            <div className="grid grid-cols-2 gap-2">
              <label
                className={`flex items-start gap-2 px-3 py-2 border rounded-md cursor-pointer text-sm ${
                  chequeForm.cheque_type === "payment" ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:border-slate-300"
                }`}
              >
                <input
                  type="radio"
                  name="cheque_type"
                  checked={chequeForm.cheque_type === "payment"}
                  onChange={() => setChequeForm({ ...chequeForm, cheque_type: "payment" })}
                  className="mt-1"
                />
                <span>
                  <strong>Payment Cheque</strong>
                  <span className="block text-[11px] text-slate-500">Used to pay expenses/salaries/advances. Clears only when the linked items' total matches exactly.</span>
                </span>
              </label>
              <label
                className={`flex items-start gap-2 px-3 py-2 border rounded-md cursor-pointer text-sm ${
                  chequeForm.cheque_type === "cash" ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:border-slate-300"
                }`}
              >
                <input
                  type="radio"
                  name="cheque_type"
                  checked={chequeForm.cheque_type === "cash"}
                  onChange={() => setChequeForm({ ...chequeForm, cheque_type: "cash" })}
                  className="mt-1"
                />
                <span>
                  <strong>Cash Cheque</strong>
                  <span className="block text-[11px] text-slate-500">Withdraw from this bank. On clearance, the amount lands in the Cash (Treasury) balance.</span>
                </span>
              </label>
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Bank Account *</label>
            <select
              required
              value={chequeForm.bank_account_id}
              onChange={(e) => setChequeForm({ ...chequeForm, bank_account_id: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">Select bank</option>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.bank_name} · {b.account_number} (PKR {Number(b.balance).toLocaleString()})
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Cheque Number *</label>
              <input
                required
                type="text"
                value={chequeForm.cheque_number}
                onChange={(e) => setChequeForm({ ...chequeForm, cheque_number: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm font-mono"
                placeholder="e.g., 000123"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Date *</label>
              <input
                required
                type="date"
                value={chequeForm.cheque_date}
                onChange={(e) => setChequeForm({ ...chequeForm, cheque_date: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
              <input
                required
                type="number"
                step="0.01"
                value={chequeForm.amount}
                onChange={(e) => setChequeForm({ ...chequeForm, amount: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="0.00"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Recipient</label>
              <input
                type="text"
                value={chequeForm.recipient}
                onChange={(e) => setChequeForm({ ...chequeForm, recipient: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
                placeholder="Payee name"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Notes</label>
              <textarea
                value={chequeForm.notes}
                onChange={(e) => setChequeForm({ ...chequeForm, notes: e.target.value })}
                rows={2}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Attachment (optional)</label>
              <input
                type="file"
                onChange={(e) => setChequeForm({ ...chequeForm, attachment: e.target.files?.[0] })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              />
              {chequeForm.attachment && (
                <p className="text-xs text-slate-500 mt-1">Selected: {chequeForm.attachment.name}</p>
              )}
            </div>
          </div>
          <div className="bg-warning-50 border border-warning-200 rounded-md p-3 text-xs text-warning-800">
            Issuing this cheque will <strong>reserve</strong> PKR {Number(chequeForm.amount || 0).toLocaleString()} from the selected bank's Account Balance.{" "}
            {chequeForm.cheque_type === "cash" ? (
              <>On clearance, this amount will be added to the <strong>Cash (Treasury)</strong> balance.</>
            ) : (
              <>This payment cheque can only be cleared once linked expenses/salaries/advances total exactly its amount.</>
            )}
            {" "}Deleting it while Pending restores the bank balance.
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" disabled={chequeSubmitting}>
              {chequeSubmitting ? "Saving…" : "Issue Cheque"}
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsChequeAddOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!chequeView} onClose={() => setChequeView(null)} title={chequeView ? `Cheque #${chequeView.cheque_number}` : ""} size="lg">
        {chequeView && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-slate-500">Type</p>
                <p>
                  {chequeView.cheque_type === "payment" ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-indigo-50 text-indigo-700">Payment</span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-teal-50 text-teal-700">Cash</span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Status</p>
                <p>
                  {chequeView.status === "pending" ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-warning-50 text-warning-700">Pending</span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-success-50 text-success-700">
                      Cleared{chequeView.cleared_at ? ` · ${chequeView.cleared_at.slice(0, 10)}` : ""}
                    </span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Bank</p>
                <p className="text-slate-900">{banks.find((b) => b.id === chequeView.bank_account_id)?.bank_name ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Date</p>
                <p className="text-slate-900">{formatDate(chequeView.cheque_date)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Recipient</p>
                <p className="text-slate-900">{chequeView.recipient ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Amount</p>
                <p className="text-slate-900">PKR {Number(chequeView.amount).toLocaleString()}</p>
              </div>
              {chequeView.notes && (
                <div className="col-span-2">
                  <p className="text-xs text-slate-500">Notes</p>
                  <p className="text-slate-900 whitespace-pre-wrap">{chequeView.notes}</p>
                </div>
              )}
              {(chequeView.drive_view_url || chequeView.attachment_path) && (
                <div className="col-span-2">
                  <p className="text-xs text-slate-500 mb-1">Attachment</p>
                  {chequeViewAttachmentUrl ? (
                    <a
                      href={chequeViewAttachmentUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"
                    >
                      <FileText className="w-4 h-4" strokeWidth={1.5} />
                      Open attachment
                    </a>
                  ) : (
                    <span className="text-xs text-slate-400">Loading…</span>
                  )}
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 pt-3">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm text-slate-900">Linked Items</h4>
                {chequeView.cheque_type === "payment" && (() => {
                  const linked = chequeViewItems.reduce((s, x) => s + x.amount, 0);
                  const cap = Number(chequeView.amount);
                  const remaining = cap - linked;
                  return (
                    <span className={`text-xs ${remaining === 0 ? "text-success-700" : remaining > 0 ? "text-warning-700" : "text-danger-700"}`}>
                      Linked PKR {linked.toLocaleString()} · Remaining PKR {remaining.toLocaleString()}
                    </span>
                  );
                })()}
              </div>
              {chequeViewItems.length === 0 ? (
                <p className="text-sm text-slate-500">Nothing linked to this cheque yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
                        <th className="text-left px-3 py-2">Kind</th>
                        <th className="text-left px-3 py-2">Description</th>
                        <th className="text-left px-3 py-2">Date</th>
                        <th className="text-right px-3 py-2">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {chequeViewItems.map((it, idx) => (
                        <tr key={idx}>
                          <td className="px-3 py-2 text-xs">
                            <span className="inline-flex items-center px-2 py-0.5 rounded bg-slate-100 text-slate-700">{it.kind}</span>
                          </td>
                          <td className="px-3 py-2 text-slate-700">{it.description}</td>
                          <td className="px-3 py-2 text-slate-500">{it.date}</td>
                          <td className="px-3 py-2 text-right text-slate-900">PKR {it.amount.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
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
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
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
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              placeholder="Enter account number"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">IBAN</label>
            <input
              type="text"
              value={newBank.iban}
              maxLength={24}
              onChange={(e) => setNewBank({ ...newBank, iban: e.target.value.toUpperCase().replace(/\s+/g, "") })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent font-mono"
              placeholder="PKxx XXXX XXXX XXXX XXXX XXXX"
            />
            {newBank.iban && newBank.iban.length !== 24 && (
              <p className="text-xs text-warning-700 mt-1">
                Pakistani IBANs are 24 characters (currently {newBank.iban.length}).
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Branch Code</label>
              <input
                type="text"
                value={newBank.branch_code}
                onChange={(e) => setNewBank({ ...newBank, branch_code: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                placeholder="e.g., 0123"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Branch Name</label>
              <input
                type="text"
                value={newBank.branch_name}
                onChange={(e) => setNewBank({ ...newBank, branch_name: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                placeholder="e.g., DHA Phase 5"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">SWIFT Code</label>
              <input
                type="text"
                value={newBank.swift_code}
                onChange={(e) => setNewBank({ ...newBank, swift_code: e.target.value.toUpperCase() })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent font-mono"
                placeholder="ABPAPKKA"
              />
              <p className="text-[10px] text-slate-500 mt-1">Optional — for future foreign transfers.</p>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Currency</label>
              <select
                value={newBank.currency_code}
                onChange={(e) => setNewBank({ ...newBank, currency_code: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              >
                <option value="PKR">PKR — Pakistani Rupee</option>
                <option value="USD">USD — US Dollar</option>
                <option value="AED">AED — UAE Dirham</option>
                <option value="GBP">GBP — British Pound</option>
                <option value="EUR">EUR — Euro</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Type</label>
            <select
              value={newBank.account_type}
              onChange={(e) => setNewBank({ ...newBank, account_type: e.target.value as "Current" | "Savings" })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
            >
              <option value="Current">Current</option>
              <option value="Savings">Savings</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account For *</label>
            <select
              value={newBank.owner_type}
              onChange={(e) => setNewBank({ ...newBank, owner_type: e.target.value as BankAccountOwnerType, owner_partner_id: "", owner_client_id: "" })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
            >
              <option value="company">Company</option>
              <option value="partner">Partner</option>
              <option value="client">Client</option>
            </select>
          </div>
          {newBank.owner_type === "partner" && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Partner *</label>
              <select
                required
                value={newBank.owner_partner_id}
                onChange={(e) => setNewBank({ ...newBank, owner_partner_id: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              >
                <option value="">Select partner…</option>
                {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {partners.length === 0 && (
                <p className="text-xs text-warning-700 mt-1">No partners yet. Add partners in the Partnership Report first.</p>
              )}
            </div>
          )}
          {newBank.owner_type === "client" && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Client *</label>
              <select
                required
                value={newBank.owner_client_id}
                onChange={(e) => setNewBank({ ...newBank, owner_client_id: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              >
                <option value="">Select client…</option>
                {receivables.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm text-slate-700 mb-1">Opening Balance (PKR)</label>
            <input
              type="number"
              value={newBank.opening_balance}
              onChange={(e) => setNewBank({ ...newBank, opening_balance: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
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
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
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
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
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
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-slate-400">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Opening Balance</p>
                <p className="text-lg text-slate-900">PKR {Number(selectedClient.opening_balance ?? 0).toLocaleString()}</p>
              </div>
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-brand-500">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total Invoiced</p>
                <p className="text-lg text-brand-700">PKR {selectedClient.total_invoiced.toLocaleString()}</p>
              </div>
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-success-500">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Received</p>
                <p className="text-lg text-success-700">PKR {selectedClient.total_received.toLocaleString()}</p>
              </div>
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-warning-500">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Outstanding</p>
                <p className="text-lg text-warning-700">PKR {selectedClient.outstanding.toLocaleString()}</p>
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
                            <td className="px-3 py-2 text-xs text-slate-600">{formatDate(inv.invoice_date)}</td>
                            <td className="px-3 py-2 text-xs text-right text-brand-600">
                              PKR {Number(inv.invoice_amount).toLocaleString()}
                            </td>
                            <td className="px-3 py-2 text-xs text-right text-success-600">
                              PKR {Number(inv.amount_received).toLocaleString()}
                            </td>
                            <td className="px-3 py-2 text-xs text-right">
                              <span className={out > 0 ? "text-warning-600" : "text-success-600"}>
                                PKR {out.toLocaleString()}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-xs">
                              {inv.attachment_path ? (
                                <button
                                  type="button"
                                  onClick={() => viewInvoiceAttachment(inv.attachment_path!)}
                                  className="text-brand-600 hover:text-brand-700 inline-flex items-center gap-1"
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
            {isAdmin && (
              <label className="flex items-start gap-2 text-sm text-slate-700 bg-warning-50 border border-warning-200 rounded p-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={paymentStandalone}
                  onChange={(e) => setPaymentStandalone(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="text-slate-900">No specific invoice</span> — apply to client balance
                  (advance / unallocated receipt). Admin-only.
                </span>
              </label>
            )}
            {!paymentStandalone && (
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
                    .filter(
                      (i) =>
                        Number(i.invoice_amount) -
                          Number(i.withholding_tax ?? 0) -
                          Number(i.amount_received) >
                        0,
                    )
                    .map((i) => {
                      const out =
                        Number(i.invoice_amount) -
                        Number(i.withholding_tax ?? 0) -
                        Number(i.amount_received);
                      return (
                        <option key={i.id} value={i.id}>
                          {i.invoice_number} · {formatDate(i.invoice_date)} · Outstanding PKR {out.toLocaleString()}
                        </option>
                      );
                    })}
                </select>
              </div>
            )}
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
              <label className="block text-sm text-slate-700 mb-1">Payment Date *</label>
              <input
                required
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
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
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
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
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
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
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Account Number</label>
              <input
                required
                type="text"
                value={editBankForm.account_number}
                onChange={(e) => setEditBankForm({ ...editBankForm, account_number: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">IBAN</label>
              <input
                type="text"
                maxLength={24}
                value={editBankForm.iban}
                onChange={(e) => setEditBankForm({ ...editBankForm, iban: e.target.value.toUpperCase().replace(/\s+/g, "") })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent font-mono"
                placeholder="PKxx XXXX XXXX XXXX XXXX XXXX"
              />
              {editBankForm.iban && editBankForm.iban.length !== 24 && (
                <p className="text-xs text-warning-700 mt-1">
                  Pakistani IBANs are 24 characters (currently {editBankForm.iban.length}).
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-slate-700 mb-1">Branch Code</label>
                <input
                  type="text"
                  value={editBankForm.branch_code}
                  onChange={(e) => setEditBankForm({ ...editBankForm, branch_code: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Branch Name</label>
                <input
                  type="text"
                  value={editBankForm.branch_name}
                  onChange={(e) => setEditBankForm({ ...editBankForm, branch_name: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-slate-700 mb-1">SWIFT Code</label>
                <input
                  type="text"
                  value={editBankForm.swift_code}
                  onChange={(e) => setEditBankForm({ ...editBankForm, swift_code: e.target.value.toUpperCase() })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent font-mono"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Currency</label>
                <select
                  value={editBankForm.currency_code}
                  onChange={(e) => setEditBankForm({ ...editBankForm, currency_code: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                >
                  <option value="PKR">PKR</option>
                  <option value="USD">USD</option>
                  <option value="AED">AED</option>
                  <option value="GBP">GBP</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Account Type</label>
              <select
                value={editBankForm.account_type}
                onChange={(e) => setEditBankForm({ ...editBankForm, account_type: e.target.value as "Current" | "Savings" })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              >
                <option value="Current">Current</option>
                <option value="Savings">Savings</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Account For</label>
              <select
                value={editBankForm.owner_type}
                onChange={(e) => setEditBankForm({ ...editBankForm, owner_type: e.target.value as BankAccountOwnerType, owner_partner_id: "", owner_client_id: "" })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              >
                <option value="company">Company</option>
                <option value="partner">Partner</option>
                <option value="client">Client</option>
              </select>
            </div>
            {editBankForm.owner_type === "partner" && (
              <div>
                <label className="block text-sm text-slate-700 mb-1">Partner *</label>
                <select
                  required
                  value={editBankForm.owner_partner_id}
                  onChange={(e) => setEditBankForm({ ...editBankForm, owner_partner_id: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                >
                  <option value="">Select partner…</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
            {editBankForm.owner_type === "client" && (
              <div>
                <label className="block text-sm text-slate-700 mb-1">Client *</label>
                <select
                  required
                  value={editBankForm.owner_client_id}
                  onChange={(e) => setEditBankForm({ ...editBankForm, owner_client_id: e.target.value })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                >
                  <option value="">Select client…</option>
                  {receivables.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
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

      <Modal
        isOpen={isCashOpeningOpen}
        onClose={() => setIsCashOpeningOpen(false)}
        title="Set Opening Cash Balance"
        size="sm"
      >
        <form className="space-y-4" onSubmit={handleSetCashOpening}>
          <div>
            <p className="text-sm text-slate-600 mb-3">
              Enter the cash on hand at the start of operations. This locks once saved —
              you won&apos;t be able to change it later. Use <b>Reconcile</b> if you need
              to correct the live balance afterwards.
            </p>
            <label className="block text-sm text-slate-700 mb-1">Opening Cash (PKR) *</label>
            <input
              required
              autoFocus
              type="number"
              step="0.01"
              min="0"
              value={cashOpeningInput}
              onChange={(e) => setCashOpeningInput(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
              placeholder="0.00"
            />
          </div>
          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" variant="primary" size="md" className="flex-1" disabled={submitting}>
              {submitting ? "Saving…" : "Set & Lock"}
            </Button>
            <Button type="button" variant="secondary" size="md" onClick={() => setIsCashOpeningOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isTransferModalOpen} onClose={() => setIsTransferModalOpen(false)} title="Wire Transfer" size="md">
        <form className="space-y-4" onSubmit={handleTransfer}>
          <div>
            <label className="block text-sm text-slate-700 mb-1">From Account *</label>
            <select
              required
              value={transferFromId}
              onChange={(e) => setTransferFromId(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
            >
              <option value="">Select source…</option>
              {banks.map((b) => {
                const ownerLabel = b.owner_type === "company" ? "Company" :
                  b.owner_type === "partner" ? `Partner: ${partners.find((p) => p.id === b.owner_partner_id)?.name ?? "?"}` :
                  `Client: ${receivables.find((c) => c.id === b.owner_client_id)?.name ?? "?"}`;
                return (
                  <option key={b.id} value={b.id}>
                    {b.bank_name} · {b.account_number} ({ownerLabel}) · PKR {Number(b.balance).toLocaleString()}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">To Account *</label>
            <select
              required
              value={transferToId}
              onChange={(e) => setTransferToId(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
            >
              <option value="">Select destination…</option>
              {banks.filter((b) => b.id !== transferFromId).map((b) => {
                const ownerLabel = b.owner_type === "company" ? "Company" :
                  b.owner_type === "partner" ? `Partner: ${partners.find((p) => p.id === b.owner_partner_id)?.name ?? "?"}` :
                  `Client: ${receivables.find((c) => c.id === b.owner_client_id)?.name ?? "?"}`;
                return (
                  <option key={b.id} value={b.id}>
                    {b.bank_name} · {b.account_number} ({ownerLabel})
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              value={transferAmount}
              onChange={(e) => setTransferAmount(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Transfer Date *</label>
            <input
              required
              type="date"
              value={transferDate}
              onChange={(e) => setTransferDate(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Notes</label>
            <textarea
              value={transferNotes}
              onChange={(e) => setTransferNotes(e.target.value)}
              rows={2}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              placeholder="Optional"
            />
          </div>
          <div className="flex items-center gap-3 pt-2">
            <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
              {submitting ? "Transferring…" : "Wire Transfer"}
            </Button>
            <Button type="button" variant="secondary" size="md" onClick={() => setIsTransferModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
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
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
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
          monthFilter={txLogMonth}
          setMonthFilter={setTxLogMonth}
          monthOptions={monthOptions}
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
          monthFilter={txLogMonth}
          setMonthFilter={setTxLogMonth}
          monthOptions={monthOptions}
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
          monthFilter={txLogMonth}
          setMonthFilter={setTxLogMonth}
          monthOptions={monthOptions}
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
  monthFilter,
  setMonthFilter,
  monthOptions,
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
  monthFilter: string;
  setMonthFilter: (v: string) => void;
  monthOptions: { key: string; label: string }[];
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
    if (monthFilter !== "all") {
      const m = (t.created_at ?? "").slice(0, 7);
      if (m !== monthFilter) return false;
    }
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
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">Month</label>
          <select
            value={monthFilter}
            onChange={(e) => setMonthFilter(e.target.value)}
            className="px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            <option value="all">All</option>
            {monthOptions.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
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
                            ad > 0 ? "text-success-700" : ad < 0 ? "text-danger-700" : "text-slate-500"
                          }
                        >
                          {ad > 0 ? "+" : ""}
                          {ad.toLocaleString()}
                        </div>
                      )}
                      {cd !== 0 && (
                        <div
                          className={
                            cd > 0 ? "text-success-700" : cd < 0 ? "text-danger-700" : "text-slate-500"
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
