import { loadEmployeeCodeIndex, useEmployeeCodeIndex } from "../../lib/employeeCodes";
import { relabelEmployeeCodes } from "../../lib/guardCode";
import ThemedSelect from "../../components/ThemedSelect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Plus, Building2, Download, AlertCircle, X, Loader2, ArrowDownUp, History, Trash2, Ban, CheckCircle2, RotateCcw, FileText, Pencil, ArrowLeftRight, Search, Power, Copy } from "lucide-react";
import Header from "../../components/Header";
import { useRegion } from "../../lib/region";
import Tabs from "../../components/Tabs";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import { formatDate, invoiceMonth } from "../../lib/date";
import {
  exportClientStatementLedger,
  exportReceivableLedger,
  exportTable,
  exportBankStatement,
  type BankStatementRow,
  type LedgerEntry,
} from "../../lib/excel";
import {
  supabase,
  fetchAllRows,
  INVOICE_ATTACHMENTS_BUCKET,
  CHEQUE_ATTACHMENTS_BUCKET,
  invoiceOutstanding,
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
  type ChequeDirection,
} from "../../lib/supabase";
import { validateBankAccount, validateIban } from "../../lib/validation";
import { useFocusTarget, useFocusRow, FOCUS_ROW_CLASS } from "../../lib/focus";
import { useAuth, hasPermission } from "../../lib/auth";
import { bankCovers, canReadBankBalances, loadBankOptions } from "../../lib/bankOptions";
import SecurityDeposits from "../../components/SecurityDeposits";
import BankReconciliation from "../../components/BankReconciliation";
import { fetchLedgerStart, monthKeysFrom } from "../../lib/monthRange";
import { CashCustodyPanel } from "./CashCustody";
import { generateDepositSlipPdf } from "../../lib/depositSlip";
import { loadCustodianOptions, ensureCustodianLocation, type CustodianOption } from "../../lib/custodian";
import AmountInWords from "../../components/AmountInWords";
import { usePageState } from "../../lib/pageState";

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

/** A payment to a vendor (0470), applied to its bills oldest first. */
type VendorPaymentRow = {
  id: string;
  vendor_id: string;
  amount: number;
  paid_via: "Cash" | "Bank";
  paid_bank_account_id: string | null;
  custodian_location_id: string | null;
  paid_on: string;
  notes: string | null;
};

const payableDisplayStatus = (row: PayableRow): PayableDisplayStatus => {
  if (row.payable_status === "Paid") return "Paid";
  if (row.due_date && row.due_date < todayStr()) return "Overdue";
  return "Pending";
};

/** The frame around the page's band: the page Header on its own route, a
 *  dark sub-band inside Expenses or Invoices when one tab is embedded there. */
function BandFrame({ embed, actions, children, ...rest }: { embed?: string; title: string; subtitle: string; actions: React.ReactNode; children: React.ReactNode }) {
  if (!embed) return <Header title={rest.title} subtitle={rest.subtitle} actions={actions}>{children}</Header>;
  return (
    <div className="band on-dark rounded-[22px] px-4 md:px-6 py-4 mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
      {children}
    </div>
  );
}

/**
 * BANKS & LEDGERS. 2026-10-21: Client receivables moved to Invoices and
 * Accounts payable to Expenses & Advances, where each is worked from — this
 * page keeps the bank accounts and cash custody. The two moved tabs are THIS
 * component rendered with `embed`, so their figures, actions and modals stay
 * one implementation; a stale ?tab=receivables / ?tab=payables link here is
 * forwarded to the new home with its focus intact.
 */
export default function Accounting({ embed }: { embed?: "receivables" | "payables" } = {}) {
  const codeIndex = useEmployeeCodeIndex();
  // The region bar narrows what is owed to us and what we owe (both carry a
  // region). Banks and custodian cash are the company's and stay whole.
  const { regionId } = useRegion();
  const { profile, company } = useAuth();
  // Every treasury write here used to omit company_id, which produced
  //   'null value in column "company_id" of relation "treasury"'
  // when setting cash in hand.
  //
  // public.treasury has NO fill_company_id trigger — it is one of 27
  // company-scoped NOT NULL tables that do not have one, against 97 that do —
  // so nothing was ever going to supply the column on the caller's behalf.
  // This failed for every user, not only an unscoped Super Super Admin. There
  // are 0 treasury rows on production, which is consistent: this path has never
  // once succeeded.
  //
  // The read was unscoped too — `.limit(1)` with no company filter, against an
  // RLS policy that shows an unscoped SSA every company's row — so it could
  // pick up, and then UPDATE, a treasury belonging to somebody else. One
  // company on production today makes that harmless; it would not stay so.
  const treasuryCompanyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
  const canReadBanks = canReadBankBalances(profile);

  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<"receivables" | "payables" | "banks" | "cash-custody">(() => {
    if (embed) return embed;
    const t = searchParams.get("tab");
    return t === "cash-custody" || t === "receivables" || t === "payables" ? t : "banks";
  });
  // On its own route this page no longer shows receivables or payables: any
  // request for them (a URL, a focus link, a ledger drill) goes to their home.
  useEffect(() => {
    if (embed || (activeTab !== "receivables" && activeTab !== "payables")) return;
    const q = new URLSearchParams(searchParams);
    q.set("tab", activeTab);
    navigate(`${activeTab === "receivables" ? "/super-admin/invoices" : "/super-admin/expenses"}?${q.toString()}`, { replace: true });
  }, [embed, activeTab, searchParams, navigate]);
  useEffect(() => { if (embed && activeTab !== embed) setActiveTab(embed); }, [embed, activeTab]);

  // Which tabs this user may see. banks.view / receivables.view /
  // payables.view were split out of a single accounting.view, so each tab is
  // gated on its own key; accounting.edit implies all of them, because someone
  // who may edit banks and reconciliation can already see everything here.
  const canEditAccounting = hasPermission(profile, "accounting.edit");
  const visibleTabs = useMemo(() => {
    const all = (embed ? [embed] : ["banks", "cash-custody"]) as readonly ("receivables" | "payables" | "banks" | "cash-custody")[];
    return all.filter((t) => {
      if (canEditAccounting) return true;
      if (t === "receivables") return hasPermission(profile, "receivables.view");
      if (t === "payables") return hasPermission(profile, "payables.view");
      return hasPermission(profile, "banks.view"); // banks + cash custody
    });
  }, [profile, canEditAccounting, embed]);

  // A tab in the URL the user cannot see must not be honoured, and the default
  // must be a tab that exists for them — otherwise the screen renders its
  // chrome around nothing and looks broken rather than restricted.
  // Someone who could only ever see receivables or payables here is sent to
  // where those live now, rather than shown an empty page.
  useEffect(() => {
    if (embed || visibleTabs.length > 0) return;
    if (hasPermission(profile, "receivables.view")) navigate("/super-admin/invoices?tab=receivables", { replace: true });
    else if (hasPermission(profile, "payables.view")) navigate("/super-admin/expenses?tab=payables", { replace: true });
  }, [embed, visibleTabs, profile, navigate]);
  useEffect(() => {
    if (visibleTabs.length === 0) return;
    if (activeTab === "receivables" || activeTab === "payables") return; // forwarded above
    if (!visibleTabs.includes(activeTab)) setActiveTab(visibleTabs[0]);
  }, [visibleTabs, activeTab]);

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
    direction: ChequeDirection;
    recipient: string;
    // For a Cash cheque: the office-staff custodian who receives the cash.
    custodian_employee_id: string;
    notes: string;
    attachment?: File;
  }>({
    bank_account_id: "",
    cheque_number: "",
    amount: "",
    cheque_date: new Date().toISOString().slice(0, 10),
    cheque_type: "payment",
    direction: "outgoing",
    recipient: "",
    custodian_employee_id: "",
    notes: "",
  });
  const [chequeFormError, setChequeFormError] = useState<string | null>(null);
  const [chequeView, setChequeView] = useState<Cheque | null>(null);
  // Bounce is a real form, not a browser prompt — it needs a reason field, the
  // balance consequence spelled out, and a busy state while it saves.
  const [bounceTarget, setBounceTarget] = useState<Cheque | null>(null);
  const [bounceReason, setBounceReason] = useState("");
  const [bounceSubmitting, setBounceSubmitting] = useState(false);
  const [bounceError, setBounceError] = useState<string | null>(null);
  const [chequeViewItems, setChequeViewItems] = useState<{
    kind: "Payslip" | "Expense" | "Advance" | "Invoice Payment";
    description: string;
    amount: number;
    date: string;
  }[]>([]);
  const [chequeViewAttachmentUrl, setChequeViewAttachmentUrl] = useState<string | null>(null);
  const [chequeSubmitting, setChequeSubmitting] = useState(false);
  const [chequeFilter, setChequeFilter] = usePageState<"all" | "pending" | "cleared" | "bounced">("Accounting.chequeFilter", "all");
  // Which record type the Cheques section shows: cheques or cash deposits.
  const [chequeSectionView, setChequeSectionView] = useState<"cheques" | "deposits">("cheques");
  const [chequeBankFilter, setChequeBankFilter] = usePageState<string>("Accounting.chequeBankFilter", "all");
  const [chequeMonthFilter, setChequeMonthFilter] = usePageState<string>("Accounting.chequeMonthFilter", "all");

  // --- Drill-down from the Journal ----------------------------------------
  //
  // Cheques used to be linked to /treasury, which does not read the table at
  // all. They are listed here, on Payables. Three filters can hide the row —
  // bank, status and month — and all three are widened before it is marked.
  const focusCheque = useFocusTarget("cheques");
  const focusChequeRow = useFocusRow(focusCheque);
  useEffect(() => {
    if (!focusCheque) return;
    setActiveTab("banks");
    setChequeSectionView("cheques");
    setChequeBankFilter("all");
    setChequeFilter("all");
    setChequeMonthFilter("all");
  }, [focusCheque]);
  const [cashBalance, setCashBalance] = useState<number>(0);
  const [cashOpeningBalance, setCashOpeningBalance] = useState<number>(0);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  // Receivables list: which clients, and in what order (2026-10-21).
  const [recvQuick, setRecvQuick] = usePageState<"all" | "owing" | "settled">("Accounting.recvQuick", "all");
  const [recvSort, setRecvSort] = usePageState<"owed" | "name">("Accounting.recvSort", "owed");
  const [payablesAll, setPayables] = useState<PayableRow[]>([]);
  const payables = useMemo(
    () => (regionId ? payablesAll.filter((p) => (p as { branch_id?: string | null }).branch_id === regionId) : payablesAll),
    [payablesAll, regionId],
  );
  const [receivables, setReceivables] = useState<ReceivableRow[]>([]);
  const [allClientsForRec, setAllClientsForRec] = useState<Client[]>([]);
  const [allInvoicesForRec, setAllInvoicesForRec] = useState<Invoice[]>([]);
  const [payableStatusFilter, setPayableStatusFilter] = usePageState<"all" | "pending" | "paid" | "overdue">("Accounting.payableStatusFilter", "all");
  const currentMonthKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const [receivablesMonth, setReceivablesMonth] = usePageState<string>("Accounting.receivablesMonth", currentMonthKey());
  const [receivablesBranchFilter, setReceivablesBranchFilter] = usePageState<string>("Accounting.receivablesBranchFilter", "all");
  const [receivablesClientFilter, setReceivablesClientFilter] = usePageState<string>("Accounting.receivablesClientFilter", "all");
  const [receivablesSearch, setReceivablesSearch] = usePageState<string>("Accounting.receivablesSearch", "");
  const [branchesList, setBranchesList] = useState<{ id: string; name: string }[]>([]);
  const [payablesMonth, setPayablesMonth] = usePageState<string>("Accounting.payablesMonth", currentMonthKey());
  const [txLogMonth, setTxLogMonth] = usePageState<string>("Accounting.txLogMonth", "all");
  // Bounded by the ledger's own start, not by a fixed count of months back
  // from today. See src/app/lib/monthRange.ts.
  const [ledgerStart, setLedgerStart] = useState<string | null>(null);
  useEffect(() => { fetchLedgerStart(treasuryCompanyId).then(setLedgerStart); }, [treasuryCompanyId]);
  const monthOptions = useMemo(() => monthKeysFrom(ledgerStart), [ledgerStart]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Cash Custody exposes its "Add Location" / "Record Transfer" actions here so
  // they can live in the page Header row, same placement as the Bank Accounts
  // buttons. Wiring only — the panel still owns the handlers/modals.
  const custodyApiRef = useRef<{ addLocation: () => void; recordTransfer: () => void; openTransactions: () => void } | null>(null);
  // Cash Custody summary figures, reported up by the panel so the cards render
  // above the tab bar (same slot as the Bank Accounts cards).
  const [custodySummary, setCustodySummary] = useState<{ totalCash: number; totalPartnerOwed: number; freeCash: number } | null>(null);
  const [isBankModalOpen, setIsBankModalOpen] = useState(false);
  const [isStatementModalOpen, setIsStatementModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isOpeningBalanceOpen, setIsOpeningBalanceOpen] = useState(false);
  const [isEditBankModalOpen, setIsEditBankModalOpen] = useState(false);
  const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState(false);
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [isReceivablesLogOpen, setIsReceivablesLogOpen] = useState(false);
  const [isPayablesLogOpen, setIsPayablesLogOpen] = useState(false);
  const [logBankFilter, setLogBankFilter] = usePageState<string>("Accounting.logBankFilter", "all");
  const [logScope, setLogScope] = useState<"all" | "cash" | "account">("all");
  // Bank statement export modal
  const [isBankExportOpen, setIsBankExportOpen] = useState(false);
  const [bankExportBankId, setBankExportBankId] = useState<string>("all");
  const [bankExportFrom, setBankExportFrom] = useState<string>("");
  const [bankExportTo, setBankExportTo] = useState<string>("");
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
    {
      // Record WHT names the receipt it amends by primary key.
      id?: string;
      client_id: string | null;
      invoice_id: string | null;
      amount: number;
      // 0281 splits a receipt: `amount` is the CASH that arrived and
      // `withholding_amount` is what the client kept and paid to the FBR.
      // invoices.amount_received moves by the two together, so anything
      // reconciling against it has to add them back.
      withholding_amount: number;
      payment_date: string;
      // Statement-only: the INSTRUMENT. A ledger has to say which bank account,
      // which cheque, or whose cash — "Received 1,246,511" with no account
      // against it cannot be reconciled to a bank statement by anybody.
      // payment_mode is text in the database and 'Cheque' is a real value in it,
      // so it is typed wider here than the InvoicePayment type admits.
      payment_mode?: string | null;
      bank_account_id?: string | null;
      custodian_location_id?: string | null;
      cheque_id?: string | null;
      notes?: string | null;
    }[]
  >([]);
  const [paymentVia, setPaymentVia] = useState<"Cash" | "Bank" | "Cheque">("Bank");
  const [paymentBankId, setPaymentBankId] = useState<string>("");
  // Office-staff custodian who physically holds cash (migration 0135). Used for cash
  // client-payments received (Change 2) and cash payables settled (Change 3).
  const [custodians, setCustodians] = useState<CustodianOption[]>([]);
  const [paymentCustodianId, setPaymentCustodianId] = useState<string>("");
  const [markPaidCustodianId, setMarkPaidCustodianId] = useState<string>("");
  // 0470: what each bill has been paid through vendor payments, read from the
  // payable_outstanding view, and the vendor payments themselves.
  const [paidByExpense, setPaidByExpense] = useState<Map<string, number>>(new Map());
  const [vendorPayments, setVendorPayments] = useState<VendorPaymentRow[]>([]);
  // Pay modal. expenseId set = pay only that bill's balance; null = the vendor's
  // bills, oldest first.
  const [payTarget, setPayTarget] = useState<
    { vendorId: string; vendorName: string; expenseId: string | null; owed: number } | null
  >(null);
  const [payAmount, setPayAmount] = useState("");
  const [payVia, setPayVia] = useState<"Cash" | "Bank">("Cash");
  const [payBankId, setPayBankId] = useState("");
  const [payCustodianId, setPayCustodianId] = useState("");
  // Record WHT (0423). Withholding used to be a field on the Record Payment
  // form and nowhere else, so a deduction the client only told you about later
  // could never be entered — the receipt stood at zero for ever. It is its own
  // act now, against a receipt that already exists.
  const [isWhtModalOpen, setIsWhtModalOpen] = useState(false);
  const [whtPaymentId, setWhtPaymentId] = useState<string>("");
  const [whtAmount, setWhtAmount] = useState<string>("");
  const [paymentNotes, setPaymentNotes] = useState<string>("");
  const [paymentDate, setPaymentDate] = useState<string>(todayStr());
  const [paymentChequeNumber, setPaymentChequeNumber] = useState<string>("");
  const [paymentChequeDate, setPaymentChequeDate] = useState<string>(todayStr());

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
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawNotes, setWithdrawNotes] = useState("");
  // Office-staff custodian who receives the withdrawn cash (attributes it so
  // Cash in Hand reconciles per custodian).
  const [withdrawCustodianId, setWithdrawCustodianId] = useState<string>("");
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositDate, setDepositDate] = useState(todayStr());
  const [depositDescription, setDepositDescription] = useState("");
  const [depositSlipFile, setDepositSlipFile] = useState<File | null>(null);
  const [depositNotes, setDepositNotes] = useState("");
  // Target bank when Cash Deposit is opened from the toolbar (no pre-selected row).
  const [depositBankId, setDepositBankId] = useState<string>("");
  // The custodian whose held cash this deposit comes out of (0411). Value is the
  // custodian's cash_location id — what the RPC stamps and what held-cash reads.
  const [depositCustodianId, setDepositCustodianId] = useState<string>("");
  const [depositError, setDepositError] = useState<string | null>(null);
  // Set after a successful deposit so the modal shows a "Download Slip" confirmation.
  const [depositSuccess, setDepositSuccess] = useState<null | {
    slip_number: number; bank_name: string; account_number: string;
    amount: number; deposit_date: string; notes: string | null; cash_location_id?: string | null;
  }>(null);
  // Past deposit slips (by cash_deposits.id) for re-download from the history log.
  const [depositsById, setDepositsById] = useState<Map<string, {
    id: string; bank_account_id: string; amount: number; deposit_date: string;
    slip_number: number; notes: string | null; deposited_by: string | null;
    cash_location_id: string | null;
    drive_view_url?: string | null;
  }>>(new Map());
  const [profileNames, setProfileNames] = useState<Map<string, string>>(new Map());
  const [submitting, setSubmitting] = useState(false);

  const totalAccountBalance = useMemo(
    () => banks.reduce((acc, b) => acc + Number(b.balance ?? 0), 0),
    [banks]
  );
  // Per-bank pending outgoing cheque amounts (locked but not yet cleared).
  // Incoming deposit cheques are excluded — they haven't changed the bank balance yet.
  const pendingChequesByBank = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cheques) {
      if (c.status !== "pending") continue;
      if ((c.direction ?? "outgoing") !== "outgoing") continue;
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
  // − payments in this month, which is the running balance at month-end.
  // Withholding is NOT a third term: A1 makes it part of the payment, and it is
  // reported in its own column from the receipts that carry it.
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
    // The withholding half of the same receipts, dated identically, so the
    // Withholding column lands in the month the client actually deducted it.
    const datedWht: { clientId: string; amount: number; date: string }[] = [];
    for (const p of allPaymentEvents) {
      let clientId = p.client_id ?? null;
      if (!clientId && p.invoice_id) {
        const inv = allInvoicesForRec.find((i) => i.id === p.invoice_id);
        if (inv) clientId = inv.client_id;
      }
      if (!clientId) continue;
      // Cash + withholding, because that is what invoices.amount_received moved
      // by. Counting cash alone left the withholding to fall out of the residual
      // loop below and be re-dated to the INVOICE date, putting it in the wrong
      // month on a screen whose whole purpose is the month.
      const settled = Number(p.amount ?? 0) + Number(p.withholding_amount ?? 0);
      const date = (p.payment_date ?? monthStart).slice(0, 10);
      if (p.invoice_id) {
        paymentsByInvoice.set(
          p.invoice_id,
          (paymentsByInvoice.get(p.invoice_id) ?? 0) + settled,
        );
      }
      datedPayments.push({ clientId, amount: settled, date });
      datedWht.push({ clientId, amount: Number(p.withholding_amount ?? 0), date });
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
      // Bucket by BILLING month, matching the Invoices list and the P&L. June's
      // service invoiced in August is June revenue; keying on invoice_date put
      // the same invoice in a different month on every screen.
      const monthInvs = allInvs.filter((i) => invoiceMonth(i) === receivablesMonth);
      const priorInvs = allInvs.filter((i) => invoiceMonth(i) < monthStart.slice(0, 7));

      const priorInvoiced = priorInvs.reduce((s, i) => s + Number(i.invoice_amount), 0);
      const priorReceived = sumInRange(c.id, datedPayments, null, dayBeforeMonthStart);

      // Opening for this month = cumulative outstanding through end of prior month.
      const openingForMonth =
        Number(c.opening_balance ?? 0) + priorInvoiced - priorReceived;

      const total_invoiced = monthInvs.reduce((s, i) => s + Number(i.invoice_amount), 0);
      // From the RECEIPTS in this month, not from the invoices — see the "all"
      // path above for why the source moved.
      const total_withholding = sumInRange(c.id, datedWht, monthStart, monthEnd);
      const total_received = sumInRange(c.id, datedPayments, monthStart, monthEnd);

      const outstanding = openingForMonth + total_invoiced - total_received;

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

  // Age of what each client owes on open invoices (2026-10-21): 0–30, 31–60,
  // 61–90 and 90+ days since the invoice date. Opening balances are not
  // invoices and are not aged here.
  const ageByClient = useMemo(() => {
    const m = new Map<string, [number, number, number, number]>();
    const today = new Date(new Date().toDateString()).getTime();
    for (const i of allInvoicesForRec) {
      const owed = invoiceOutstanding(i);
      if (!(owed > 0) || !i.client_id) continue;
      const days = Math.floor((today - new Date(`${i.invoice_date.slice(0, 10)}T00:00:00`).getTime()) / 86400000);
      const b = m.get(i.client_id) ?? [0, 0, 0, 0];
      b[days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3] += owed;
      m.set(i.client_id, b);
    }
    return m;
  }, [allInvoicesForRec]);

  const branchScopedReceivables = useMemo(() => {
    const branch = regionId ?? (receivablesBranchFilter === "all" ? null : receivablesBranchFilter);
    if (!branch) return displayedReceivables;
    return displayedReceivables.filter((r) => r.branch_id === branch);
  }, [displayedReceivables, receivablesBranchFilter, regionId]);

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

  /**
   * Which bank account, which cheque, or whose cash — the instrument a receipt
   * actually arrived through.
   *
   * A ledger line that says only "Received 1,246,511" cannot be tied to a bank
   * statement by the person holding one, which is most of what a client ledger
   * is FOR. A cheque names its number and the bank it was drawn on; a bank
   * transfer names the account and its last four digits; cash names the
   * custodian who took it, because that is the person the money is with.
   */
  const describeInstrument = useCallback(
    (p: {
      payment_mode?: string | null;
      bank_account_id?: string | null;
      custodian_location_id?: string | null;
      cheque_id?: string | null;
    }): string => {
      const bankLabel = (id: string | null | undefined) => {
        const b = id ? banks.find((x) => x.id === id) : null;
        if (!b) return null;
        const tail = (b.account_number ?? "").slice(-4);
        return tail ? `${b.bank_name} ····${tail}` : b.bank_name;
      };
      if (p.cheque_id) {
        const c = cheques.find((x) => x.id === p.cheque_id);
        const drawnOn = bankLabel(c?.bank_account_id ?? p.bank_account_id);
        if (c) return `Cheque #${c.cheque_number}${drawnOn ? ` · ${drawnOn}` : ""}`;
        // The row is gone or out of scope, but the payment still went through a
        // cheque — say that rather than silently calling it a bank transfer.
        return `Cheque${drawnOn ? ` · ${drawnOn}` : ""}`;
      }
      if (p.custodian_location_id) {
        const held = custodians.find((c) => c.locationId === p.custodian_location_id);
        return held ? `Cash · ${held.fullName}` : "Cash";
      }
      const bank = bankLabel(p.bank_account_id);
      if (bank) return bank;
      return p.payment_mode ?? "—";
    },
    [banks, cheques, custodians],
  );

  /**
   * The client statement's running ledger — every event that moved this client's
   * receivable, in date order, with the balance after each one.
   *
   * It is built from the SAME three sources the Receivables table sums
   * (`opening_balance`, invoices, and payment events plus their residuals), in
   * the same order and with the same scoping, so the closing balance is the
   * Outstanding figure on the row you clicked rather than a second computation
   * of it. A statement that disagrees with the row it was opened from is worse
   * than no statement.
   *
   * Scope follows the Month selector: "All Months" is the client's whole life,
   * and a month opens at the carried-forward balance the table already shows as
   * Opening and closes at that month's Outstanding.
   *
   * A receipt is credited GROSS — cash plus withholding — because that is what
   * clears the receivable (A1). The withholding column says how much of the
   * credit the client kept back and paid to the FBR.
   */
  const statementLedger = useMemo(() => {
    if (!selectedClient) return null;
    const cid = selectedClient.id;
    const monthly = receivablesMonth !== "all";
    const monthStart = monthly ? `${receivablesMonth}-01` : null;
    const monthEnd = (() => {
      if (!monthly) return null;
      const [yStr, mStr] = receivablesMonth.split("-");
      const lastDay = new Date(Number(yStr), Number(mStr), 0).getDate();
      return `${receivablesMonth}-${String(lastDay).padStart(2, "0")}`;
    })();
    const inDateScope = (d: string) => !monthly || (d >= monthStart! && d <= monthEnd!);

    type Entry = {
      key: string;
      date: string;
      rank: number;
      kind: "invoice" | "receipt" | "residual";
      label: string;
      reference: string;
      account: string;
      debit: number;
      credit: number;
      withholding: number;
      balance: number;
    };
    const entries: Entry[] = [];

    const clientOfInvoice = new Map(allInvoicesForRec.map((i) => [i.id, i.client_id]));
    const invoiceNumber = new Map(allInvoicesForRec.map((i) => [i.id, i.invoice_number]));

    for (const inv of allInvoicesForRec) {
      if (inv.client_id !== cid) continue;
      // Invoices are scoped by BILLING month (A4), the same as the table.
      if (monthly && invoiceMonth(inv) !== receivablesMonth) continue;
      entries.push({
        key: `inv:${inv.id}`,
        date: (inv.invoice_date ?? "").slice(0, 10),
        rank: 0,
        kind: "invoice",
        label: "Invoice",
        reference: inv.invoice_number ?? "—",
        // An invoice settles through no instrument — it is the obligation, not
        // the money. The period it bills is the useful thing to say instead.
        account: invoiceMonth(inv)
          ? new Date(`${invoiceMonth(inv)}-01`).toLocaleDateString("en-GB", { month: "short", year: "numeric" })
          : "",
        debit: Number(inv.invoice_amount ?? 0),
        credit: 0,
        withholding: 0,
        balance: 0,
      });
    }

    // Receipts, scoped by PAYMENT date. `tracked` also feeds the residual pass:
    // it counts every receipt against an invoice regardless of month, because a
    // residual is the part of amount_received that no receipt row explains at
    // all — a month window would manufacture one.
    const tracked = new Map<string, number>();
    let seq = 0;
    for (const p of allPaymentEvents) {
      const rowClient = p.client_id ?? (p.invoice_id ? clientOfInvoice.get(p.invoice_id) ?? null : null);
      const settled = Number(p.amount ?? 0) + Number(p.withholding_amount ?? 0);
      if (p.invoice_id) tracked.set(p.invoice_id, (tracked.get(p.invoice_id) ?? 0) + settled);
      if (rowClient !== cid) continue;
      const date = (p.payment_date ?? monthStart ?? "").slice(0, 10);
      if (!inDateScope(date)) continue;
      const mode = p.payment_mode ? `${p.payment_mode} receipt` : "Receipt";
      entries.push({
        key: `pay:${seq++}`,
        date,
        rank: 1,
        kind: "receipt",
        label: p.invoice_id ? mode : `${mode} (on account)`,
        reference: (p.invoice_id ? invoiceNumber.get(p.invoice_id) ?? "—" : (p.notes ?? "").trim() || "No invoice"),
        account: describeInstrument(p),
        debit: 0,
        credit: settled,
        withholding: Number(p.withholding_amount ?? 0),
        balance: 0,
      });
    }

    // The gap between an invoice's amount_received and the receipts that explain
    // it — legacy rows written before invoice_payments existed. Dated at the
    // invoice, which is the only date they have.
    for (const inv of allInvoicesForRec) {
      if (inv.client_id !== cid) continue;
      const residual = Number(inv.amount_received ?? 0) - (tracked.get(inv.id) ?? 0);
      if (residual <= 0.001) continue;
      const date = (inv.invoice_date ?? "").slice(0, 10);
      if (!inDateScope(date)) continue;
      entries.push({
        key: `res:${inv.id}`,
        date,
        rank: 2,
        kind: "residual",
        label: "Receipt (untracked)",
        reference: inv.invoice_number ?? "—",
        // By definition no receipt row explains it, so there is no instrument to
        // name. Saying so is the point: this is the money nobody recorded how.
        account: "Not recorded",
        debit: 0,
        credit: residual,
        withholding: 0,
        balance: 0,
      });
    }

    entries.sort((a, b) => (a.date === b.date ? a.rank - b.rank : a.date.localeCompare(b.date)));

    const opening = Number(selectedClient.opening_balance ?? 0);
    let running = opening;
    let debits = 0;
    let credits = 0;
    let withheld = 0;
    for (const e of entries) {
      running += e.debit - e.credit;
      e.balance = running;
      debits += e.debit;
      credits += e.credit;
      withheld += e.withholding;
    }

    return {
      opening,
      entries,
      debits,
      credits,
      withheld,
      closing: running,
      // The row this statement was opened from. Any drift between the two is a
      // bug in one of them, so it is shown rather than hidden.
      rowOutstanding: selectedClient.outstanding,
      scopeLabel: monthly
        ? (monthOptions.find((m) => m.key === receivablesMonth)?.label ?? receivablesMonth)
        : "All months",
    };
  }, [selectedClient, receivablesMonth, allInvoicesForRec, allPaymentEvents, monthOptions, describeInstrument]);

  const balanceLedger = useMemo(() => {
    const ledger = new Map<string, { cash?: { before: number; after: number }; bank?: { before: number; after: number } }>();
    const sortedAsc = [...transactions].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return ta - tb;
    });
    // CASH starts at zero because its opening IS a transaction — the `opening`
    // row with no bank_account_id, carrying the whole amount as cash_delta. So
    // it arrives through the loop like any other movement.
    //
    // A BANK's opening does not. It was seeded straight onto
    // bank_accounts.opening_balance with no transaction row behind it (see the
    // 0308 note in loadAll, which is about the damage that seeding caused). So
    // starting a bank at zero here understated every Before/After in its
    // Transaction Log by exactly its opening balance — Askari's log ran up to
    // 423,151 while the account correctly read 4,042,972, and the two figures
    // sat on the same screen disagreeing by the 3,619,821 it opened with.
    //
    // Seeding from the account is what makes the log's last After equal the
    // balance shown on the card. The reconciliation holds on real data: for all
    // four accounts, opening + every account_delta = the stored balance exactly.
    let cashRunning = 0;
    const bankRunning = new Map<string, number>(
      banks.map((b) => [b.id, Number(b.opening_balance) || 0]),
    );
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
        // ?? 0 only reaches a transaction on an account that is not in `banks`
        // (deleted, or outside this region's scope). Its running total is then
        // relative rather than absolute, which is the best available answer.
        const before = bankRunning.get(t.bank_account_id) ?? 0;
        const after = before + ad;
        entry.bank = { before, after };
        bankRunning.set(t.bank_account_id, after);
      }
      ledger.set(t.id, entry);
    }
    return ledger;
  }, [transactions, banks]);

  // A bill's paid part: all of it once Paid, otherwise what vendor payments
  // have applied to it (0470). What is still owed is the rest.
  const paidOf = useCallback(
    (p: PayableRow) => (p.payable_status === "Paid" ? Number(p.amount) : paidByExpense.get(p.id) ?? 0),
    [paidByExpense],
  );
  const owedOf = useCallback((p: PayableRow) => Number(p.amount) - paidOf(p), [paidOf]);

  const payableTotals = useMemo(() => {
    let total = 0;
    let pending = 0;
    let paid = 0;
    let overdue = 0;
    for (const p of payables) {
      total += Number(p.amount);
      paid += paidOf(p);
      const st = payableDisplayStatus(p);
      if (st === "Pending") pending += owedOf(p);
      else if (st === "Overdue") overdue += owedOf(p);
    }
    return { total, pending, paid, overdue };
  }, [payables, paidOf, owedOf]);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    // 0308 removed the apply_monthly_account_zeroing() call that used to run
    // here, on every load of this page.
    //
    // It did not zero anything. Its last statement recomputed
    // bank_accounts.balance from bank_transactions alone, and every opening
    // balance in this system was seeded directly onto that column with no
    // transaction row — so one call silently discarded the opening balance of
    // any flagged account. Proved in 0308 before the function was dropped:
    // 1,250,000 seeded, 0 afterwards, nothing recorded to explain it.
    //
    // The error was also being swallowed, and not by the catch: supabase.rpc()
    // resolves with an error object rather than throwing, so a failure here was
    // discarded silently for as long as this call existed.
    const [
      banksRes,
      treasuryRes,
      payablesRes,
      clientsRes,
      partnersRes,
      chequesRes,
    ] = await Promise.all([
      // A user who may not read banks (0531) gets the picker list without balances.
      canReadBanks
        ? supabase.from("bank_accounts").select("*").order("created_at", { ascending: false })
        : loadBankOptions<BankAccount>(treasuryCompanyId, false).then((data) => ({ data, error: null })),
      // Scoped: an unscoped SSA sees every company's treasury row through the
      // ssa_all policy, and .limit(1) would pick an arbitrary one.
      // Cash in Hand = Σ custodian held cash (0466), not treasury.cash_balance.
      supabase.rpc("cash_in_hand", { p_company_id: treasuryCompanyId }).maybeSingle<{ cash_balance: number; opening_balance: number }>(),
      supabase
        .from("expenses")
        .select("*, vendor:vendor_id(id,name,bank_name,account_title,account_number,branch_code), category:category_id(id,name), client:client_id(id,name,client_code)")
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

    // Past cash-deposit slips (for re-download) + user names for slip attribution.
    {
      const [{ data: depData }, { data: profData }] = await Promise.all([
        supabase
          .from("cash_deposits")
          .select("id, bank_account_id, amount, deposit_date, slip_number, notes, deposited_by, cash_location_id, drive_view_url")
          .order("slip_number", { ascending: false }),
        supabase.from("profiles").select("id, full_name, email"),
      ]);
      const dMap = new Map<string, {
        id: string; bank_account_id: string; amount: number; deposit_date: string;
        slip_number: number; notes: string | null; deposited_by: string | null;
        cash_location_id: string | null;
      }>();
      for (const d of (depData ?? []) as any[]) dMap.set(d.id, d);
      setDepositsById(dMap);
      const nMap = new Map<string, string>();
      for (const p of (profData ?? []) as any[]) nMap.set(p.id, p.full_name || p.email || "—");
      setProfileNames(nMap);
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
      withholding_amount: number;
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
          id: string;
          client_id: string | null;
          invoice_id: string | null;
          amount: number;
          withholding_amount: number;
          payment_date: string;
          payment_mode: string | null;
          bank_account_id: string | null;
          custodian_location_id: string | null;
          cheque_id: string | null;
          notes: string | null;
        }>(() =>
          supabase
            .from("invoice_payments")
            .select(
              "id, client_id, invoice_id, amount, withholding_amount, payment_date, payment_mode, bank_account_id, custodian_location_id, cheque_id, notes",
            )
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
      // Cash + withholding. A standalone receipt has no invoice whose
      // amount_received could carry the withholding half, so counting only
      // `amount` left the client owing the withholding for ever.
      standaloneMap.set(
        row.client_id,
        (standaloneMap.get(row.client_id) ?? 0) +
          Number(row.amount) +
          Number(row.withholding_amount ?? 0),
      );
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
    // 0466: Cash in Hand's opening IS the sum of every custodian's opening
    // balance, read from cash_in_hand() alongside the current figure. It is set
    // per custodian on Cash Custody, so there is no "Set Opening" here any more.
    setCashOpeningBalance(Number(treasuryRes.data?.opening_balance ?? 0));
    // 0390: the treasury row id is no longer held. Nothing in this screen
    // writes that row any more — set_cash_opening_balance() does, by company —
    // and a balance row id kept in component state is an invitation to.
    // History text names employees by the permanent code (GGS-…); show the
    // code of the client each one works for instead, old rows included.
    const codeIdx = await loadEmployeeCodeIndex().catch(() => null);
    setTransactions(
      codeIdx
        ? txRows.map((t) => ({ ...t, description: t.description ? relabelEmployeeCodes(t.description, codeIdx.byPermanent) : t.description }))
        : txRows,
    );
    setPayables((payablesRes.data ?? []) as PayableRow[]);
    const [paidRes, vpRes] = await Promise.all([
      supabase.from("payable_outstanding").select("expense_id, paid_amount").gt("paid_amount", 0),
      supabase.from("vendor_payments").select("*").order("paid_on", { ascending: false }).order("created_at", { ascending: false }),
    ]);
    if (paidRes.error) setError(paidRes.error.message);
    if (vpRes.error) setError(vpRes.error.message);
    setPaidByExpense(
      new Map(((paidRes.data ?? []) as { expense_id: string; paid_amount: number }[]).map((r) => [r.expense_id, Number(r.paid_amount)])),
    );
    setVendorPayments((vpRes.data ?? []) as VendorPaymentRow[]);

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
    // A1 / 0316: withholding is deducted BY THE CLIENT AT PAYMENT, so the
    // Withholding column is the sum of invoice_payments.withholding_amount.
    // It used to be summed from invoices.withholding_tax. 0316 removed the three
    // writers of that column, and a column nothing writes still reads as a
    // number — repointing the reader is the other half of removing the writer,
    // or the screen would have shown 0 withholding for every client from 0316
    // onward and looked like a quiet reporting bug months later.
    const invClient = new Map(allInvoices.map((i) => [i.id, i.client_id]));
    const whtByClient = new Map<string, number>();
    for (const p of allPayRows) {
      const cid = p.client_id ?? (p.invoice_id ? invClient.get(p.invoice_id) ?? null : null);
      if (!cid) continue;
      whtByClient.set(cid, (whtByClient.get(cid) ?? 0) + Number(p.withholding_amount ?? 0));
    }
    const rec: ReceivableRow[] = allClients.map((c) => {
      const invs = byClient.get(c.id) ?? [];
      const total_invoiced = invs.reduce((s, i) => s + Number(i.invoice_amount), 0);
      const total_withholding = whtByClient.get(c.id) ?? 0;
      const invoice_received = invs.reduce((s, i) => s + Number(i.amount_received), 0);
      const standalone_received = standaloneMap.get(c.id) ?? 0;
      const total_received = invoice_received + standalone_received;
      // A1: the receivable is GROSS and is cleared by cash and withholding
      // TOGETHER, both of which are already inside total_received. Subtracting
      // withholding again here relieved it twice — the same shape as 0313.
      const outstanding =
        Number(c.opening_balance ?? 0) + total_invoiced - total_received;
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

    // Office-staff custodians + their held cash (for the cash Record-Payment /
    // Mark-Paid dropdowns). Best-effort — never block the ledger on it.
    {
      const cid = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
      if (cid) {
        try {
          setCustodians(await loadCustodianOptions(cid));
        } catch {
          /* ignore — custodian attribution is optional */
        }
      }
    }

    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  // 0380/0389. applyCashDelta and applyBankDelta are GONE from this screen.
  // Both read a balance, released the lock, and wrote back a figure computed
  // from what they had read — and both were called one leg at a time, outside
  // any transaction. apply_money_delta() in the database does the arithmetic
  // under the row lock and asserts its own row count, and every caller reaches
  // it from inside the transaction that carries the row the money belongs to.
  //
  // NOTHING ON THIS SCREEN MOVES A BALANCE FROM THE BROWSER ANY MORE.
  // Withdrawals, deposits and transfers are all RPCs.

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

  // 0389. dateToTs went with the transfer: record_bank_transfer() dates both
  // legs itself, at noon on the transfer date, for the same timezone reason
  // this helper existed.

  const handleAddBank = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBank.bank_name.trim() || !newBank.account_number.trim()) return;
    const bankFmtErr = validateBankAccount(newBank.account_number) ?? validateIban(newBank.iban);
    if (bankFmtErr) {
      setError(bankFmtErr);
      return;
    }
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
          // auto_zero_monthly is not written here any more (0308). The column
          // survives until 0309 drops it and nothing reads or sets it in
          // between, which is what lets that drop be an ordinary Stage D
          // change rather than a coordinated release.
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
      // 0389. ONE CALL. This was five round trips with nothing around them —
      // debit, credit, two log lines, then a pairing update — and a failure
      // between the first two DESTROYED MONEY: the company's total bank
      // balance fell and nothing anywhere said why.
      //
      // Not a cross-key defect: a transfer needs accounting.edit and nothing
      // else. The same shape one layer down — several writes that are only
      // correct together, issued separately.
      //
      // The description, the pair id and the noon-dated timestamp are all
      // built in the RPC now, from the two account rows it reads rather than
      // from whatever this screen has cached.
      const { error: transferErr } = await supabase.rpc("record_bank_transfer", {
        p_from_bank_account_id: transferFromId,
        p_to_bank_account_id: transferToId,
        p_amount: amount,
        p_date: transferDate,
        p_notes: transferNotes.trim() || null,
      });
      if (transferErr) throw transferErr;

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
    const bankFmtErr = validateBankAccount(editBankForm.account_number) ?? validateIban(editBankForm.iban);
    if (bankFmtErr) {
      setError(bankFmtErr);
      return;
    }
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
    setWithdrawCustodianId("");
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
    if (!(await bankCovers(selectedBank, amount))) {
      setError("Withdrawal exceeds available account balance.");
      return;
    }
    const staff = custodians.find((c) => c.employeeId === withdrawCustodianId);
    if (!staff) {
      setError("Select the office-staff member who receives this cash.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const cid = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
      if (!cid) throw new Error("Company not loaded — refresh and try again.");
      const custodianLocId = await ensureCustodianLocation(cid, staff.employeeId, staff.fullName);
      // Atomic: bank −, Cash in Hand +, custodian held +, and a withdraw_to_cash
      // ledger row (shows in the Transaction Log like a cheque).
      const { error: rpcErr } = await supabase.rpc("record_bank_to_custodian", {
        p_bank_account_id: selectedBank.id,
        p_custodian_location_id: custodianLocId,
        p_amount: amount,
        p_date: todayStr(),
        p_notes: withdrawNotes.trim() || `Withdraw from ${selectedBank.bank_name} to ${staff.fullName}`,
      });
      if (rpcErr) throw rpcErr;
      setIsWithdrawModalOpen(false);
      setWithdrawCustodianId("");
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const resetDepositForm = () => {
    setDepositAmount("");
    setDepositDate(todayStr());
    setDepositDescription("");
    setDepositNotes("");
    setDepositCustodianId("");
    setDepositSlipFile(null);
    setDepositError(null);
    setDepositSuccess(null);
  };

  // Per-row entry point: bank is fixed to the row clicked.
  const openCashDeposit = () => {
    setSelectedBank(null);
    setDepositBankId(banks[0]?.id ?? "");
    resetDepositForm();
    setIsDepositModalOpen(true);
  };

  const depositErrorMessage = (raw: string): string => {
    if (raw.includes("insufficient_cash"))
      return `Deposit exceeds available Cash in Hand (PKR ${cashBalance.toLocaleString()}).`;
    if (raw.includes("no_treasury"))
      return "No Cash in Hand balance is set up yet. Set an opening cash balance first.";
    if (raw.includes("amount_must_be_positive")) return "Enter a positive deposit amount.";
    if (raw.includes("bank_not_found")) return "That bank account no longer exists.";
    return raw;
  };

  // Cash deposit = pure location move (Cash in Hand → bank). Done atomically in a
  // single RPC so it can't leave cash and bank out of balance; it must NOT create
  // an expense / payroll / partner entry.
  const handleDeposit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDepositError(null);
    // Bank is either the pre-selected row (per-row Deposit) or the toolbar dropdown.
    const targetBank = selectedBank ?? banks.find((b) => b.id === depositBankId) ?? null;
    if (!targetBank) {
      setDepositError("Select a bank account.");
      return;
    }
    const amount = Number(depositAmount);
    if (!amount || amount <= 0) {
      setDepositError("Enter a positive deposit amount.");
      return;
    }
    if (!depositDate) {
      setDepositError("Select a deposit date.");
      return;
    }
    const selCust = custodians.find((c) => c.locationId === depositCustodianId);
    if (!selCust) {
      setDepositError("Select who is depositing this cash (custodian).");
      return;
    }
    if (amount > selCust.held) {
      setDepositError(`Deposit exceeds ${selCust.fullName}'s held cash (PKR ${Math.round(selCust.held).toLocaleString()}).`);
      return;
    }
    const notes = [depositDescription.trim(), depositNotes.trim()].filter(Boolean).join(" · ") || null;
    setSubmitting(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc("record_cash_deposit", {
        p_bank_account_id: targetBank.id,
        p_amount: amount,
        p_date: depositDate,
        p_notes: notes,
        p_cash_location_id: selCust.locationId,
      });
      if (rpcErr) throw rpcErr;
      const dep = (Array.isArray(data) ? data[0] : data) as { id: string; slip_number: number };
      if (depositSlipFile && dep.id) {
        const effectiveCompanyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
        if (effectiveCompanyId && company?.name) {
          const fd = new FormData();
          fd.append("file", depositSlipFile);
          fd.append("category", "deposits");
          fd.append("company_id", effectiveCompanyId);
          fd.append("company_name", company.name);
          const { data: uploaded, error: fnErr } = await supabase.functions.invoke("gdrive-upload", { body: fd });
          if (!fnErr && uploaded?.drive_file_id) {
            await supabase.from("cash_deposits").update({
              drive_file_id: uploaded.drive_file_id,
              drive_view_url: uploaded.drive_view_url,
            }).eq("id", dep.id);
          }
        }
      }
      setDepositSuccess({
        slip_number: dep.slip_number,
        bank_name: targetBank.bank_name,
        account_number: targetBank.account_number,
        amount,
        deposit_date: depositDate,
        notes,
        cash_location_id: selCust.locationId,
      });
      await loadAll();
    } catch (err: any) {
      setDepositError(depositErrorMessage(err?.message ?? String(err)));
    } finally {
      setSubmitting(false);
    }
  };

  // A deposit is now made BY a custodian (0411); show that person. Old deposits
  // (no cash_location_id) fall back to the user who recorded them.
  const custodianNameByLoc = (locId: string | null | undefined): string | null =>
    locId ? (custodians.find((c) => c.locationId === locId)?.fullName ?? null) : null;

  const downloadDepositSlip = (d: {
    slip_number: number; bank_name: string; account_number: string;
    amount: number; deposit_date: string; notes: string | null; deposited_by?: string | null;
    cash_location_id?: string | null;
  }) => {
    const by = custodianNameByLoc(d.cash_location_id)
      ?? (d.deposited_by
        ? (profileNames.get(d.deposited_by) ?? "—")
        : (profile?.full_name || profile?.email || "—"));
    generateDepositSlipPdf(
      {
        slipNumber: d.slip_number,
        date: d.deposit_date,
        bankName: d.bank_name,
        accountNumber: d.account_number,
        amount: d.amount,
        depositedBy: by,
        reference: d.notes,
      },
      company,
    );
  };

  // Re-download a past deposit slip from the transaction log (reference_id ==
  // cash_deposits.id). Bank name/number resolved from the loaded banks list.
  const downloadSlipByRef = (referenceId: string) => {
    const dep = depositsById.get(referenceId);
    if (!dep) return;
    const bank = banks.find((b) => b.id === dep.bank_account_id);
    downloadDepositSlip({
      slip_number: dep.slip_number,
      bank_name: bank?.bank_name ?? "—",
      account_number: bank?.account_number ?? "—",
      amount: Number(dep.amount),
      deposit_date: dep.deposit_date,
      notes: dep.notes,
      deposited_by: dep.deposited_by,
      cash_location_id: dep.cash_location_id,
    });
  };

  const openPay = (vendorId: string, vendorName: string, owed: number, expenseId: string | null = null) => {
    setPayTarget({ vendorId, vendorName, expenseId, owed });
    setPayAmount(expenseId ? String(owed) : "");
    setPayVia("Cash");
    setPayBankId(banks[0]?.id ?? "");
    setPayCustodianId("");
    setError(null);
  };

  /**
   * How the entered amount would clear the vendor's open bills, oldest first.
   * A PREVIEW of what pay_vendor_payables does — the RPC decides, in the same
   * order (expense_date, then created_at).
   */
  const payPreview = useMemo(() => {
    if (!payTarget) return [];
    let left = Math.max(0, Number(payAmount) || 0);
    const open = payables
      .filter((p) => (payTarget.expenseId ? p.id === payTarget.expenseId : p.vendor_id === payTarget.vendorId))
      .filter((p) => p.payable_status !== "Paid" && owedOf(p) > 0)
      .sort((a, b) => a.expense_date.localeCompare(b.expense_date) || (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    return open.map((p) => {
      const owed = owedOf(p);
      const take = Math.min(left, owed);
      left -= take;
      return { bill: p, owed, take, remaining: owed - take };
    });
  }, [payTarget, payAmount, payables, owedOf]);

  const handlePay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payTarget) return;
    const amount = Math.round((Number(payAmount) || 0) * 100) / 100;
    if (amount <= 0) {
      setError("Enter the amount paid.");
      return;
    }
    if (amount > payTarget.owed + 0.005) {
      setError(`That is more than is owed (PKR ${payTarget.owed.toLocaleString()}).`);
      return;
    }
    if (payVia === "Cash" && !payCustodianId) {
      setError("Select the office-staff member who paid the cash.");
      return;
    }
    if (payVia === "Bank" && !payBankId) {
      setError("Select a bank account.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let custodianLocId: string | null = null;
      if (payVia === "Cash") {
        const cid = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
        const staff = custodians.find((c) => c.employeeId === payCustodianId);
        if (cid && staff) custodianLocId = await ensureCustodianLocation(cid, staff.employeeId, staff.fullName);
      }
      // 0470. One call: the payment, its application to the bills oldest first,
      // each bill's posting, and the money — together or not at all.
      const { error: payErr } = await supabase.rpc("pay_vendor_payables", {
        p_vendor_id: payTarget.vendorId,
        p_amount: amount,
        p_paid_via: payVia,
        p_paid_bank_account_id: payVia === "Bank" ? payBankId : null,
        p_custodian_location_id: custodianLocId,
        p_expense_id: payTarget.expenseId,
      });
      if (payErr) throw payErr;
      setPayTarget(null);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevertVendorPayment = async (vp: VendorPaymentRow) => {
    if (!window.confirm(`Revert this vendor payment of PKR ${Number(vp.amount).toLocaleString()}? The bills it cleared go back to what they owed, and the money is returned.`))
      return;
    setError(null);
    try {
      const { error: revErr } = await supabase.rpc("revert_vendor_payment", { p_vendor_payment_id: vp.id });
      if (revErr) throw revErr;
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };

  const handleRevertToPending = async (row: PayableRow) => {
    if (row.payable_status !== "Paid") return;
    if (!window.confirm(`Revert payment for "${row.vendor?.name ?? "vendor"}" back to Pending? The original deduction will be reversed.`))
      return;
    setError(null);
    try {
      // 0381. The refund and the status change together. The refund reads
      // paid_via off the row — a payable settled in cash is refunded to cash
      // even if the expense itself names a bank account — which is the case
      // this screen used to spell out for itself, and the one that goes wrong
      // when it is spelled out anywhere twice.
      const { error: revertErr } = await supabase.rpc("revert_payable_expense", {
        p_expense_id: row.id,
      });
      if (revertErr) throw revertErr;
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

  // Cash Deposit History — reuses the Cheques toolbar filters (bank / status /
  // month). Cash deposits are always completed, so the "pending" status filter
  // hides them (nothing is ever pending). Newest slip first.
  const filteredDeposits = useMemo(() => {
    return Array.from(depositsById.values())
      .filter((d) => chequeBankFilter === "all" || d.bank_account_id === chequeBankFilter)
      .filter((d) => chequeMonthFilter === "all" || (d.deposit_date ?? "").slice(0, 7) === chequeMonthFilter)
      .filter(() => chequeFilter !== "pending")
      .sort((a, b) => b.slip_number - a.slip_number);
  }, [depositsById, chequeBankFilter, chequeMonthFilter, chequeFilter]);

  const payablesSummary = useMemo(() => {
    let pendingTotal = 0;
    let paidTotal = 0;
    let overdueTotal = 0;
    for (const p of payables) {
      const status = payableDisplayStatus(p);
      paidTotal += paidOf(p);
      if (status === "Pending") pendingTotal += owedOf(p);
      else if (status === "Overdue") overdueTotal += owedOf(p);
    }
    return { pendingTotal, paidTotal, overdueTotal };
  }, [payables, paidOf, owedOf]);

  // One row per vendor: every filtered payable to the same vendor folds into a
  // single line, and View opens that vendor's transactions. Totals are the sum
  // of the rows the breakdown shows, so the two cannot disagree.
  const [payableVendorKey, setPayableVendorKey] = useState<string | null>(null);
  const payableGroups = useMemo(() => {
    const groups = new Map<string, {
      key: string; name: string; items: PayableRow[];
      outstanding: number; paid: number; overdue: boolean; pending: boolean; nextDue: string | null;
    }>();
    for (const p of filteredPayables) {
      const key = p.vendor_id ?? "no-vendor";
      let g = groups.get(key);
      if (!g) {
        g = { key, name: p.vendor?.name ?? "—", items: [], outstanding: 0, paid: 0, overdue: false, pending: false, nextDue: null };
        groups.set(key, g);
      }
      g.items.push(p);
      const status = payableDisplayStatus(p);
      g.paid += paidOf(p);
      if (status !== "Paid") {
        g.outstanding += owedOf(p);
        if (status === "Overdue") g.overdue = true; else g.pending = true;
        if (p.due_date && (!g.nextDue || p.due_date < g.nextDue)) g.nextDue = p.due_date;
      }
    }
    for (const g of groups.values()) {
      g.items.sort((a, b) => (b.expense_date ?? "").localeCompare(a.expense_date ?? ""));
    }
    return Array.from(groups.values()).sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name));
  }, [filteredPayables, paidOf, owedOf]);
  const payableVendorGroup = payableVendorKey ? payableGroups.find((g) => g.key === payableVendorKey) ?? null : null;

  /**
   * This client's receipts, newest first — what Record WHT picks from.
   *
   * Read from the same `allPaymentEvents` the statement ledger uses, so the
   * receipt you choose here is the line you saw there. A receipt with no client
   * of its own belongs to the client on its invoice.
   */
  const receiptsForWht = useMemo(() => {
    if (!selectedClient) return [];
    const clientOfInvoice = new Map(allInvoicesForRec.map((i) => [i.id, i.client_id]));
    const invoiceNumber = new Map(allInvoicesForRec.map((i) => [i.id, i.invoice_number]));
    return allPaymentEvents
      .filter((p) => {
        if (!p.id) return false;
        const owner = p.client_id ?? (p.invoice_id ? clientOfInvoice.get(p.invoice_id) ?? null : null);
        return owner === selectedClient.id;
      })
      .map((p) => ({
        id: p.id as string,
        date: (p.payment_date ?? "").slice(0, 10),
        amount: Number(p.amount ?? 0),
        withholding: Number(p.withholding_amount ?? 0),
        instrument: describeInstrument(p),
        against: p.invoice_id ? invoiceNumber.get(p.invoice_id) ?? "an invoice" : "on account",
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [selectedClient, allPaymentEvents, allInvoicesForRec, describeInstrument]);

  const selectedWhtReceipt = useMemo(
    () => receiptsForWht.find((r) => r.id === whtPaymentId) ?? null,
    [receiptsForWht, whtPaymentId],
  );

  // Land on the most recent receipt when the modal opens. The receipts come out
  // of a memo, so this cannot be done in the click handler — the list is not
  // built yet at that point.
  useEffect(() => {
    if (!isWhtModalOpen || whtPaymentId || receiptsForWht.length === 0) return;
    setWhtPaymentId(receiptsForWht[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWhtModalOpen, receiptsForWht]);

  // Prefill at the client's agreed rate — the prefill that used to live on the
  // Record Payment form, moved here with the field it belongs to. Applied to
  // the CASH of the chosen receipt, and only while the box is untouched, so a
  // figure the user has typed is never overwritten.
  useEffect(() => {
    if (!isWhtModalOpen || !selectedWhtReceipt) return;
    if (selectedWhtReceipt.withholding > 0) {
      setWhtAmount(String(selectedWhtReceipt.withholding));
      return;
    }
    const rate = Number(selectedClient?.withholding_tax_rate ?? 0);
    setWhtAmount(
      rate > 0 ? String(Math.round(selectedWhtReceipt.amount * rate) / 100) : "",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWhtModalOpen, whtPaymentId]);

  /**
   * Open Record WHT on the client's MOST RECENT receipt, prefilled at their
   * agreed rate. The most recent one is very nearly always the one being
   * corrected — the deduction is discovered when the payment is reconciled —
   * and every other receipt is one selection away.
   */
  const recordWithholding = (client: ReceivableRow) => {
    setSelectedClient(client);
    setWhtPaymentId("");
    setWhtAmount("");
    setError(null);
    setIsWhtModalOpen(true);
  };

  const handleRecordWht = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!whtPaymentId) {
      setError("Choose the receipt the client deducted this tax from.");
      return;
    }
    const amount = Number(whtAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      setError("Enter the withholding amount, or 0 to clear it.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // 0423. The receipt AND the invoice it settles move together — a bare
      // update of withholding_amount would leave the invoice reading as
      // under-received by exactly the tax that was withheld.
      const { error: rpcErr } = await supabase.rpc("record_payment_withholding", {
        p_payment_id: whtPaymentId,
        p_withholding: amount,
      });
      if (rpcErr) throw rpcErr;
      setIsWhtModalOpen(false);
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const viewStatement = (client: ReceivableRow) => {
    setSelectedClient(client);
    setIsStatementModalOpen(true);
  };

  const recordPayment = (client: ReceivableRow) => {
    setSelectedClient(client);
    const openInvoice = client.invoices.find((i) => invoiceOutstanding(i) > 0);
    // No open invoices → default to standalone. A client can be owed money with
    // nothing open: an opening balance carries a receivable with no invoice row
    // behind it, so this is the ordinary case at cutover and whenever a client
    // pays down a prior balance — not a privileged one.
    const noOpen = !openInvoice;
    setPaymentStandalone(canEditAccounting && noOpen);
    setPaymentInvoiceId(openInvoice?.id ?? "");
    setPaymentAmount("");
    setPaymentVia("Bank");
    setPaymentBankId(banks[0]?.id ?? "");
    setPaymentCustodianId("");
    setPaymentNotes("");
    setPaymentDate(todayStr());
    setPaymentChequeNumber("");
    setPaymentChequeDate(todayStr());
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
    if ((paymentVia === "Bank" || paymentVia === "Cheque") && !paymentBankId) {
      setError("Select the bank account.");
      return;
    }
    if (paymentVia === "Cash" && !paymentCustodianId) {
      setError("Select the office-staff member who received the cash.");
      return;
    }

    // Resolve (creating on first use) the custodian cash_location for the chosen
    // office-staff member, so cash received is attributed to who holds it (0135).
    // Throws rather than returning null. The guard above checks that a custodian
    // was SELECTED; this checks that the selection RESOLVES. When the company id
    // cannot be resolved the two are different things, and returning null sent a
    // cash receipt with no custodian into the database, where it met a check
    // constraint and surfaced as a raw Postgres error in a toast. 0281 went to
    // some trouble to make that refusal legible; this is the same courtesy.
    const resolvePaymentCustodianLoc = async (): Promise<string> => {
      const cid = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
      if (!cid) throw new Error("No company is selected — reload the page and try again.");
      const staff = custodians.find((c) => c.employeeId === paymentCustodianId);
      if (!staff) throw new Error("Select the office-staff member who received the cash.");
      const loc = await ensureCustodianLocation(cid, staff.employeeId, staff.fullName);
      if (!loc) throw new Error(`Could not open a cash location for ${staff.fullName}.`);
      return loc;
    };

    // Cheque payment: record incoming cheque, no immediate balance change.
    // Outstanding and bank balance only update when the cheque is cleared.
    if (paymentVia === "Cheque") {
      if (!paymentChequeNumber.trim()) {
        setError("Enter the cheque number.");
        return;
      }
      if (!paymentChequeDate) {
        setError("Enter the cheque date.");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const invoiceId = !paymentStandalone && paymentInvoiceId ? paymentInvoiceId : null;
        if (!paymentStandalone && !invoiceId) {
          setError("Select an invoice to apply this cheque to.");
          setSubmitting(false);
          return;
        }
        const { error: insErr } = await supabase.rpc("record_cheque", {
          p_bank_account_id: paymentBankId,
          p_cheque_number: paymentChequeNumber.trim(),
          p_amount: amount,
          p_cheque_date: paymentChequeDate,
          p_cheque_type: "payment",
          p_direction: "incoming",
          p_recipient: selectedClient.name,
          p_notes: paymentNotes.trim() || null,
          p_invoice_id: invoiceId,
          p_client_id: selectedClient.id,
        });
        if (insErr) throw insErr;
        setIsPaymentModalOpen(false);
        await loadAll();
      } catch (e: any) {
        setError(e.message ?? String(e));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Standalone payment (no invoice) — gated on accounting.edit, the same
    // permission as every other write on this screen. It used to ask for the
    // super_admin ROLE, which blocked accountants who hold accounting.edit from
    // an ordinary act; an unallocated receipt is no more privileged than an
    // allocated one, and the role check did not manage the risk it looked like
    // it was managing. (The real control for a misposting hidden in an
    // unallocated receipt is a report of those outstanding, not who may make
    // one.)
    if (paymentStandalone) {
      if (!canEditAccounting) {
        setError("You don't have permission to record payments.");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        // 0315: the client-only entry point. This screen used to insert into
        // invoice_payments directly and move the balances itself — a second
        // implementation of payment application. record_invoice_payment does the
        // oldest-first waterfall, the pro-rata withholding split,
        // assert_same_company, the balance move and the bank_transactions row.
        // Doing any of that here as well would double-count it.
        //
        // With nothing open this settles no document: journal_on_invoice_payment
        // posts Dr Bank/Cash, Cr 1100, which CLEARS AN OPENING BALANCE. That
        // requires the opening to be in the ledger already — the opening batch
        // must be posted first, or this credit drives the receivable control
        // negative and ar_control_equals_open_invoices reports a gap the wrong
        // way round. See the ordering note on the Opening Balances screen.
        const { error: rpcErr } = await supabase.rpc("record_invoice_payment", {
          p_invoice_id: null,
          p_client_id: selectedClient.id,
          p_amount: amount,
          p_payment_date: paymentDate,
          p_payment_mode: paymentVia,
          p_bank_account_id: paymentVia === "Bank" ? paymentBankId : null,
          p_notes: paymentNotes.trim() || null,
          // 0423: withholding is recorded by Record WHT, never here. An
          // explicit 0 (not null) so the client's agreed rate is not applied
          // behind the user's back on a form that no longer shows it.
          p_withholding: 0,
          p_custodian_location_id:
            paymentVia === "Cash" ? await resolvePaymentCustodianLoc() : null,
        });
        if (rpcErr) throw rpcErr;
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
    const openAmount = invoiceOutstanding(invoice);
    if (amount > openAmount) {
      setError(`Payment exceeds the outstanding amount on this invoice (PKR ${openAmount.toLocaleString()}).`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // 0315: naming the invoice TARGETS it; the RPC then settles the client's
      // open invoices oldest first from that starting point, which is the tested
      // existing behaviour. The hand-rolled amount_received update, the balance
      // move and the bank_transactions row are all the RPC's job now — doing
      // them here as well would double-count every receipt.
      //
      // The waterfall can reach an invoice the operator is not looking at. That
      // is safe because NO CLIENT SPANS MORE THAN ONE REGION, so everything it
      // can reach sits in the same region as the invoice in front of them. If a
      // client ever does span regions, this is the comment that has to change.
      const { error: rpcErr } = await supabase.rpc("record_invoice_payment", {
        p_invoice_id: invoice.id,
        p_amount: amount,
        p_payment_date: paymentDate,
        p_payment_mode: paymentVia,
        p_bank_account_id: paymentVia === "Bank" ? paymentBankId : null,
        p_notes: paymentNotes.trim() || null,
        p_withholding: 0,
        p_custodian_location_id:
          paymentVia === "Cash" ? await resolvePaymentCustodianLoc() : null,
      });
      if (rpcErr) throw rpcErr;
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
      <BandFrame
        embed={embed}
        title="Banks & Ledgers"
        subtitle="Bank accounts, cheques, deposits and the cash each custodian holds"
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
                  setBankExportBankId("all");
                  setBankExportFrom("");
                  setBankExportTo("");
                  setIsBankExportOpen(true);
                  return;
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
            {activeTab === "cash-custody" && (
              <>
                <Button variant="secondary" size="md" onClick={() => custodyApiRef.current?.openTransactions()}>
                  <History className="w-4 h-4 mr-2" strokeWidth={1.5} />
                  Transactions
                </Button>
                <Button variant="secondary" size="md" onClick={() => custodyApiRef.current?.recordTransfer()}>
                  <ArrowLeftRight className="w-4 h-4 mr-2" strokeWidth={1.5} />
                  Record Transfer
                </Button>
                <Button variant="primary" size="md" onClick={() => custodyApiRef.current?.addLocation()}>
                  <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                  Add Location
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
      >
        <div className="flex flex-col gap-3">
          {!embed && <>
          {/* Net position (2026-10-20): the four ledgers on one line — what we
              hold, what we are owed, what we owe — read from the same totals
              each tab shows below. */}
          <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="lbl">Net position</span>
            {[
              { k: regionId ? "Bank (company)" : "Bank", v: totalAccountBalance },
              { k: regionId ? "Cash held (company)" : "Cash held", v: cashBalance },
              { k: "Owed to us", v: receivableTotals.outstanding },
              { k: "We owe", v: -(payableTotals.pending + payableTotals.overdue) },
            ].map((x) => (
              <span key={x.k} className="flex items-baseline gap-2 text-sm">
                <span className="text-muted-foreground">{x.k}</span>
                <span className={`font-ledger font-semibold ${x.v < 0 ? "text-down" : "text-foreground"}`}>{x.v < 0 ? "−" : ""}{Math.abs(Math.round(x.v)).toLocaleString()}</span>
              </span>
            ))}
            <span className="ml-auto flex items-baseline gap-2">
              <span className="text-muted-foreground text-sm">=</span>
              <span className="font-ledger text-xl font-semibold text-up"><span className="cur">PKR</span>{Math.round(totalAccountBalance + cashBalance + receivableTotals.outstanding - payableTotals.pending - payableTotals.overdue).toLocaleString()}</span>
            </span>
          </div>
          <Tabs<typeof activeTab>
            value={activeTab}
            onChange={setActiveTab}
            items={visibleTabs.map((t) => ({ value: t, label: ({ receivables: "Client receivables", payables: "Accounts payable", banks: "Bank accounts", "cash-custody": "Cash custody" } as Record<string, string>)[t] }))}
          />
          </>}
        {activeTab === "banks" && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2.5">
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <div className="flex items-center justify-between">
                <p className="lbl mb-1">Cash in Hand</p>
                <span className="text-[10px] text-muted-foreground" title="Cash in Hand is the sum of every custodian's held cash">
                  Σ custodians
                </span>
              </div>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-2xl text-up"><span className="cur">PKR</span>{cashBalance.toLocaleString()}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Opening: PKR {cashOpeningBalance.toLocaleString()}
              </p>
            </div>
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <p className="lbl mb-1">Bank Balance</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-2xl text-brand-700 dark:text-brand-500"><span className="cur">PKR</span>{totalAccountBalance.toLocaleString()}</p>
            </div>
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <p className="lbl mb-1">Cheques in Transit</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-2xl text-warning-700 dark:text-warning-500"><span className="cur">PKR</span>{totalPendingCheques.toLocaleString()}</p>
            </div>
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-brand-500/60">
              <p className="lbl mb-1">Net Available Cash</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-2xl text-foreground"><span className="cur">PKR</span>{grandTotal.toLocaleString()}</p>
            </div>
          </div>
        )}

        {activeTab === "receivables" && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <p className="lbl mb-1">Opening Balance</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-xl text-foreground">
                <span className="cur">PKR</span>{receivableTotals.opening.toLocaleString()}
              </p>
            </div>
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <p className="lbl mb-1">Total Invoiced</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-xl text-brand-700 dark:text-brand-500">
                <span className="cur">PKR</span>{receivableTotals.invoiced.toLocaleString()}
              </p>
            </div>
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <p className="lbl mb-1">Withholding Tax</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-xl text-danger-700 dark:text-danger-500">
                <span className="cur">PKR</span>{receivableTotals.withholding.toLocaleString()}
              </p>
            </div>
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <p className="lbl mb-1">Total Received</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-xl text-success-700 dark:text-success-500">
                <span className="cur">PKR</span>{receivableTotals.received.toLocaleString()}
              </p>
            </div>
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <p className="lbl mb-1">Outstanding</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-xl text-warning-700 dark:text-warning-500">
                <span className="cur">PKR</span>{receivableTotals.outstanding.toLocaleString()}
              </p>
            </div>
          </div>
        )}

        {activeTab === "receivables" && (() => {
          // Collected = received against what was there to collect (opening +
          // invoiced), from the same totals as the tiles above. The bar shows
          // who holds the outstanding, largest first; tap one to filter.
          const due = receivableTotals.opening + receivableTotals.invoiced;
          const pctIn = due > 0 ? Math.min(1, receivableTotals.received / due) : 0;
          const owing = filteredReceivables.filter((r) => r.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding);
          const top = owing.slice(0, 6);
          const rest = owing.slice(6).reduce((n, r) => n + r.outstanding, 0);
          const whole = Math.max(1, owing.reduce((n, r) => n + r.outstanding, 0));
          const shades = ["bg-brand-500", "bg-heed", "bg-calm", "bg-up", "bg-down", "bg-settled"];
          return (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(220px,1fr)_3fr] gap-2.5">
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1.5">
                <span className="lbl">Collected</span>
                <span className="font-ledger text-2xl font-semibold leading-none">{Math.round(pctIn * 100)}%</span>
                <span className="h-1.5 rounded-full bg-muted overflow-hidden"><span className="block h-full rounded-full bg-up" style={{ width: `${pctIn * 100}%` }} /></span>
                <span className="text-xs text-muted-foreground">{owing.length} client{owing.length === 1 ? "" : "s"} still owe · {filteredReceivables.length - owing.length} settled</span>
              </div>
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-2 min-w-0">
                <span className="lbl">Who holds the outstanding · tap to filter</span>
                {owing.length === 0 ? (
                  <span className="text-sm text-up">Nobody owes anything in this view.</span>
                ) : (
                  <>
                    <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
                      {top.map((r, i) => <span key={r.id} className={shades[i % shades.length]} style={{ width: `${(r.outstanding / whole) * 100}%` }} title={`${r.name}: PKR ${r.outstanding.toLocaleString()}`} />)}
                      {rest > 0 && <span className="bg-rest" style={{ width: `${(rest / whole) * 100}%` }} />}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {top.map((r, i) => (
                        <button key={r.id} type="button" onClick={() => setReceivablesClientFilter(receivablesClientFilter === r.id ? "all" : r.id)}
                          className={`flex items-center gap-1.5 text-xs ${receivablesClientFilter === r.id ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`}>
                          <span className={`w-2 h-2 rounded-full ${shades[i % shades.length]}`} />
                          <span className="truncate max-w-[12rem]">{r.name}</span>
                          <span className="font-ledger">{Math.round(r.outstanding).toLocaleString()}</span>
                        </button>
                      ))}
                      {rest > 0 && <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="w-2 h-2 rounded-full bg-rest" />{owing.length - top.length} more · <span className="font-ledger">{Math.round(rest).toLocaleString()}</span></span>}
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })()}

        {activeTab === "payables" && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-brand-500/60">
              <p className="lbl mb-1">Total Payable</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-xl text-foreground">
                <span className="cur">PKR</span>{payableTotals.total.toLocaleString()}
              </p>
            </div>
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <p className="lbl mb-1">Pending</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-xl text-warning-700 dark:text-warning-500">
                <span className="cur">PKR</span>{payableTotals.pending.toLocaleString()}
              </p>
            </div>
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <p className="lbl mb-1">Overdue</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-xl text-danger-700 dark:text-danger-500">
                <span className="cur">PKR</span>{payableTotals.overdue.toLocaleString()}
              </p>
            </div>
            {(() => {
              // Bills still owed whose due date falls in the next seven days.
              const today = new Date(new Date().toDateString()).getTime();
              const soon = payables.filter((p) => {
                if (owedOf(p) <= 0 || !p.due_date) return false;
                const d = (new Date(p.due_date + "T00:00:00").getTime() - today) / 86400000;
                return d >= 0 && d <= 7;
              });
              return (
                <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
                  <p className="lbl mb-1">Due in 7 days</p>
                  <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-xl text-heed"><span className="cur">PKR</span>{Math.round(soon.reduce((n, p) => n + owedOf(p), 0)).toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground mt-1">{soon.length} bill{soon.length === 1 ? "" : "s"}</p>
                </div>
              );
            })()}
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <p className="lbl mb-1">Paid</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-xl text-success-700 dark:text-success-500">
                <span className="cur">PKR</span>{payableTotals.paid.toLocaleString()}
              </p>
            </div>
          </div>
        )}

        {activeTab === "cash-custody" && custodySummary && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <p className="lbl mb-1">Total Cash in Hand</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-2xl text-success-700 dark:text-success-500"><span className="cur">PKR</span>{Math.round(custodySummary.totalCash).toLocaleString()}</p>
            </div>
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-border">
              <p className="lbl mb-1">Owed to Partners (Undrawn)</p>
              <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-2xl text-warning-700 dark:text-warning-500"><span className="cur">PKR</span>{Math.round(custodySummary.totalPartnerOwed).toLocaleString()}</p>
            </div>
            <div className="bg-card p-4 md:p-4 rounded-2xl border border-brand-500/60">
              <p className="lbl mb-1">Free Company Cash</p>
              <p className={`font-ledger whitespace-nowrap font-semibold tracking-tight text-2xl ${custodySummary.freeCash < 0 ? "text-danger-500" : "text-on-fill"}`}><span className="cur">PKR</span>{Math.round(custodySummary.freeCash).toLocaleString()}</p>
            </div>
          </div>
        )}

        </div>
      </BandFrame>

      <div className={embed ? "" : "flex-1 overflow-y-auto px-3 py-4 md:p-8"}>
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-xl text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* One surface per tab (2026-10-21): receivables and payables are a
            card with a single filter strip; banks and custody are their own
            cards laid straight on the page, not cards inside a card. */}
        <div className={activeTab === "banks" || activeTab === "cash-custody" ? "mb-6" : "bg-card rounded-2xl border border-border mb-6 overflow-hidden"}>
          {activeTab === "receivables" && (
          <div className="px-6 py-4 border-b border-border flex flex-wrap items-center gap-3">

            {activeTab === "receivables" && (
              <Tabs<"all" | "owing" | "settled">
                size="sm"
                value={recvQuick}
                onChange={setRecvQuick}
                items={[
                  { value: "all", label: "All", count: filteredReceivables.length },
                  { value: "owing", label: "Owing", count: filteredReceivables.filter((r) => r.outstanding > 0).length },
                  { value: "settled", label: "Settled", count: filteredReceivables.filter((r) => r.outstanding <= 0).length },
                ]}
              />
            )}
            {activeTab === "receivables" && (
              <div className="ml-auto flex items-center gap-2 flex-wrap">
                <ThemedSelect value={recvSort} onChange={(e) => setRecvSort(e.target.value as "owed" | "name")} aria-label="Sort" className="px-3 py-1.5 border border-border rounded-xl bg-card text-sm">
                  <option value="owed">Most owed first</option>
                  <option value="name">A → Z</option>
                </ThemedSelect>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-muted-foreground/70 absolute left-2.5 top-1/2 -translate-y-1/2" strokeWidth={1.5} />
                  <input
                    type="text"
                    value={receivablesSearch}
                    onChange={(e) => setReceivablesSearch(e.target.value)}
                    placeholder="Search client / code…"
                    className="pl-8 pr-3 py-1.5 border border-border rounded-xl bg-card text-sm w-56"
                  />
                </div>
                <label className="text-xs text-muted-foreground">Client:</label>
                <ThemedSelect
                  value={receivablesClientFilter}
                  onChange={(e) => setReceivablesClientFilter(e.target.value)}
                  className="px-3 py-1.5 border border-border rounded-xl bg-card text-sm max-w-[14rem]"
                >
                  <option value="all">All Clients</option>
                  {[...allClientsForRec]
                    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
                    .map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                </ThemedSelect>
                <label className="text-xs text-muted-foreground">Branch:</label>
                <ThemedSelect
                  disabled={!!regionId}
                  title={regionId ? "Set by the region bar at the top" : undefined}
                  value={regionId ?? receivablesBranchFilter}
                  onChange={(e) => setReceivablesBranchFilter(e.target.value)}
                  className="px-3 py-1.5 border border-border rounded-xl bg-card text-sm"
                >
                  <option value="all">All Branches</option>
                  {branchesList.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </ThemedSelect>
                <label className="text-xs text-muted-foreground">Month:</label>
                <ThemedSelect
                  value={receivablesMonth}
                  onChange={(e) => setReceivablesMonth(e.target.value)}
                  className="px-3 py-1.5 border border-border rounded-xl bg-card text-sm"
                >
                  <option value="all">All Months</option>
                  {monthOptions.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </ThemedSelect>
              </div>
            )}
          </div>
          )}

          {activeTab === "receivables" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Client</th>
                    <th className="text-right px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Opening Balance</th>
                    <th className="text-right px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Invoiced</th>
                    <th className="text-right px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Withholding</th>
                    <th className="text-right px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Received</th>
                    <th className="text-right px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Outstanding</th>
                    <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground" title="Open invoices by days since invoiced">Age</th>
                    <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {loading && (
                    <tr>
                      <td colSpan={8} className="px-6 py-10 text-center text-muted-foreground">
                        <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                      </td>
                    </tr>
                  )}
                  {!loading && filteredReceivables.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-6 py-10 text-center text-muted-foreground text-sm">
                        No client activity matching the current filters.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    filteredReceivables
                      .filter((r) => recvQuick === "all" || (recvQuick === "owing" ? r.outstanding > 0 : r.outstanding <= 0))
                      .sort((a, b) => (recvSort === "owed" ? b.outstanding - a.outstanding : (a.name ?? "").localeCompare(b.name ?? "")))
                      .map((item) => {
                      const isMonthView = receivablesMonth !== "all";
                      const canEditOpening = item.outstanding === 0 && !isMonthView;
                      // Row colour is the client's settlement state at a glance:
                      // green = nothing owed, red = something still outstanding.
                      // Same predicate as the Outstanding cell's own colour, so
                      // the row and the figure inside it cannot disagree.
                      const owing = item.outstanding > 0;
                      return (
                        <tr key={item.id} className="hover:bg-muted/50 transition-colors">
                          <td className={`pl-5 pr-6 py-3.5 text-sm text-foreground border-l-[3px] ${owing ? "border-l-danger-500" : "border-l-success-500"}`}>
                            <div className="flex items-center gap-3">
                              <span className="h-8 w-8 rounded-xl bg-muted flex items-center justify-center text-[11px] font-bold text-muted-foreground flex-shrink-0">
                                {(item.name ?? "?").split(/\s+/).map((w: string) => w[0]).slice(0, 2).join("").toUpperCase()}
                              </span>
                              <span className="min-w-0">
                                <span className="block font-medium truncate">{item.name}</span>
                                <span className="block text-xs text-muted-foreground font-ledger">{item.client_code}</span>
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-3.5 text-sm text-foreground text-right">
                            <div className="inline-flex items-center gap-2 justify-end whitespace-nowrap">
                              <span className="font-ledger" title={isMonthView ? "Carried forward from prior period" : undefined}>
                                {Number(item.opening_balance ?? 0).toLocaleString()}
                              </span>
                              <button
                                type="button"
                                disabled={!canEditOpening}
                                onClick={() => openEditOpeningBalance(item)}
                                className={`inline-flex items-center justify-center w-6 h-6 rounded ${
                                  canEditOpening
                                    ? "text-muted-foreground hover:bg-muted"
                                    : "text-muted-foreground/50 cursor-not-allowed"
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
                          <td className="px-6 py-3.5 text-sm font-ledger text-foreground text-right">
                            {item.total_invoiced.toLocaleString()}
                          </td>
                          <td className="px-6 py-3.5 text-sm font-ledger text-muted-foreground text-right">
                            {item.total_withholding ? item.total_withholding.toLocaleString() : "—"}
                          </td>
                          <td className="px-6 py-3.5 text-sm font-ledger text-success-700 dark:text-success-500 text-right">
                            {item.total_received.toLocaleString()}
                          </td>
                          <td className="px-6 py-3.5 text-sm text-right">
                            {(() => {
                              const base = Number(item.opening_balance ?? 0) + item.total_invoiced;
                              const pct = base > 0 ? Math.min(1, item.total_received / base) : owing ? 0 : 1;
                              return (
                                <div className="flex flex-col items-end gap-1">
                                  <span className={`font-ledger font-semibold whitespace-nowrap ${owing ? "text-danger-700 dark:text-danger-500" : "text-success-700 dark:text-success-500"}`}>
                                    {item.outstanding.toLocaleString()}
                                  </span>
                                  <span className="w-24 h-1 rounded-full bg-muted overflow-hidden" title={`${Math.round(pct * 100)}% collected`}>
                                    <span className={`block h-full rounded-full ${owing ? "bg-brand-500" : "bg-success-500"}`} style={{ width: `${pct * 100}%` }} />
                                  </span>
                                  <span className="text-[10px] text-muted-foreground">{owing ? `${Math.round(pct * 100)}% collected` : "settled"}</span>
                                </div>
                              );
                            })()}
                          </td>
                          <td className="px-4 py-3.5">
                            {(() => {
                              const b = ageByClient.get(item.id);
                              const tot = b ? b[0] + b[1] + b[2] + b[3] : 0;
                              if (!b || tot <= 0) return <span className="text-xs text-muted-foreground">{owing ? "opening only" : "—"}</span>;
                              const cls = ["bg-success-500", "bg-brand-500", "bg-warning-500", "bg-danger-500"];
                              const lbl = ["0–30", "31–60", "61–90", "90+"];
                              return (
                                <div className="flex flex-col gap-1 w-28" title={b.map((v, k) => `${lbl[k]} days: ${Math.round(v).toLocaleString()}`).join("\n")}>
                                  <span className="flex h-1.5 rounded-full overflow-hidden bg-muted">
                                    {b.map((v, k) => v > 0 && <span key={k} className={cls[k]} style={{ width: `${(v / tot) * 100}%` }} />)}
                                  </span>
                                  <span className={`text-[10px] ${b[3] > 0 ? "text-danger-700 dark:text-danger-500 font-semibold" : "text-muted-foreground"}`}>
                                    {b[3] > 0 ? `${Math.round(b[3]).toLocaleString()} past 90 days` : b[2] > 0 ? `${Math.round(b[2]).toLocaleString()} at 61–90` : "all under 60 days"}
                                  </span>
                                </div>
                              );
                            })()}
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
                                !canEditAccounting &&
                                item.invoices.every((i) => invoiceOutstanding(i) <= 0)
                              }
                            >
                              Record Payment
                            </Button>
                            {/* Separate act, deliberately: a client often names
                                what they withheld days after they pay. */}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => recordWithholding(item)}
                              disabled={!canEditAccounting}
                              title="Record withholding tax the client deducted from a receipt already entered"
                            >
                              Record WHT
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
              <div className="px-6 py-4 border-b border-border flex flex-wrap items-center gap-3">
                <Tabs<"all" | "pending" | "overdue" | "paid">
                  size="sm"
                  value={payableStatusFilter}
                  onChange={setPayableStatusFilter}
                  items={[
                    { value: "all", label: "All" },
                    { value: "pending", label: "Pending" },
                    { value: "overdue", label: "Overdue" },
                    { value: "paid", label: "Paid" },
                  ]}
                />
                <span className="ml-auto text-xs text-muted-foreground">{payableGroups.length} vendor{payableGroups.length === 1 ? "" : "s"} in this view</span>
                <ThemedSelect
                  value={payablesMonth}
                  onChange={(e) => setPayablesMonth(e.target.value)}
                  aria-label="Month"
                  className="px-3 py-1.5 border border-border rounded-xl bg-card text-sm"
                >
                  <option value="all">All Months</option>
                  {monthOptions.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </ThemedSelect>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Vendor</th>
                      <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Transactions</th>
                      <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Outstanding</th>
                      <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Paid</th>
                      <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Next Due</th>
                      <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Status</th>
                      <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {loading && (
                      <tr>
                        <td colSpan={7} className="px-6 py-10 text-center text-muted-foreground">
                          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                          Loading…
                        </td>
                      </tr>
                    )}
                    {!loading && filteredPayables.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-6 py-10 text-center text-muted-foreground text-sm">
                          {payables.length === 0
                            ? "No payables yet. Create an expense with payment mode 'Payable' to see it here."
                            : "No payables match the selected filter."}
                        </td>
                      </tr>
                    )}
                    {!loading &&
                      payableGroups.map((g) => {
                        const status = g.overdue ? "Overdue" : g.pending ? "Pending" : "Paid";
                        const statusClass =
                          status === "Paid"
                            ? "bg-success-50 text-success-700 dark:text-success-500"
                            : status === "Overdue"
                            ? "bg-danger-50 text-danger-700 dark:text-danger-500"
                            : "bg-warning-50 text-warning-700 dark:text-warning-500";
                        const whole = g.outstanding + g.paid;
                        const paidPct = whole > 0 ? g.paid / whole : 1;
                        const dueIn = g.nextDue ? Math.round((new Date(g.nextDue + "T00:00:00").getTime() - new Date(new Date().toDateString()).getTime()) / 86400000) : null;
                        return (
                          <tr key={g.key} className="hover:bg-muted/50 transition-colors">
                            <td className={`pl-5 pr-6 py-3.5 text-sm text-foreground border-l-[3px] ${status === "Overdue" ? "border-l-danger-500" : status === "Pending" ? "border-l-warning-500" : "border-l-success-500"}`}>
                              <div className="flex items-center gap-3">
                                <span className="h-8 w-8 rounded-xl bg-muted flex items-center justify-center text-[11px] font-bold text-muted-foreground flex-shrink-0">
                                  {(g.name ?? "?").split(/\s+/).map((w: string) => w[0]).slice(0, 2).join("").toUpperCase()}
                                </span>
                                <span className="font-medium">{g.name}</span>
                              </div>
                            </td>
                            <td className="px-6 py-3.5 text-sm text-muted-foreground font-ledger">{g.items.length}</td>
                            <td className="px-6 py-3.5 text-sm">
                              <div className="flex flex-col gap-1">
                                <span className={`font-ledger font-semibold ${g.outstanding > 0 ? "text-danger-700 dark:text-danger-500" : "text-muted-foreground"}`}>{g.outstanding > 0 ? `PKR ${g.outstanding.toLocaleString()}` : "—"}</span>
                                <span className="w-24 h-1 rounded-full bg-muted overflow-hidden" title={`${Math.round(paidPct * 100)}% paid`}><span className="block h-full rounded-full bg-success-500" style={{ width: `${paidPct * 100}%` }} /></span>
                              </div>
                            </td>
                            <td className="px-6 py-3.5 text-sm font-ledger text-success-700 dark:text-success-500">{g.paid.toLocaleString()}</td>
                            <td className="px-6 py-3.5 text-sm">
                              {g.nextDue ? (
                                <span className="flex flex-col">
                                  <span className="text-foreground">{formatDate(g.nextDue)}</span>
                                  {g.outstanding > 0 && dueIn != null && <span className={`text-xs ${dueIn < 0 ? "text-danger-700 dark:text-danger-500" : dueIn <= 7 ? "text-warning-700 dark:text-warning-500" : "text-muted-foreground"}`}>{dueIn < 0 ? `${-dueIn}d late` : dueIn === 0 ? "due today" : `in ${dueIn}d`}</span>}
                                </span>
                              ) : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="px-6 py-3.5">
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full font-semibold text-xs ${statusClass}`}>
                                {status}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-1">
                                <Button variant="ghost" size="sm" onClick={() => setPayableVendorKey(g.key)}>
                                  <FileText className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                                  View
                                </Button>
                                {g.key !== "no-vendor" && g.outstanding > 0 && (
                                  <Button variant="ghost" size="sm" onClick={() => openPay(g.key, g.name, g.outstanding)}>
                                    <CheckCircle2 className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                                    Pay
                                  </Button>
                                )}
                              </div>
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
            {/* One card per account (2026-10-21): balance first, what is in
                transit under it, and the account's share of the company's
                bank money as a bar. Same figures the table carried. */}
            <div className="mb-5">
              {loading ? (
                <div className="py-10 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…</div>
              ) : banks.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">No bank accounts yet. Add the first with "Add Bank Account" above.</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {[...banks].sort((x, y) => Number(y.active) - Number(x.active) || Number(y.balance ?? 0) - Number(x.balance ?? 0)).map((bank) => {
                    const acct = Number(bank.balance ?? 0);
                    const pendChq = pendingChequesByBank.get(bank.id) ?? 0;
                    const totalBal = acct + pendChq;
                    const share = totalAccountBalance > 0 ? Math.max(0, acct) / totalAccountBalance : 0;
                    const owner =
                      bank.owner_type === "partner" ? `Partner · ${partners.find((p) => p.id === bank.owner_partner_id)?.name ?? "—"}`
                      : bank.owner_type === "client" ? `Client · ${receivables.find((c) => c.id === bank.owner_client_id)?.name ?? "—"}`
                      : "Company";
                    return (
                      <article key={bank.id} className={`rounded-2xl border border-border bg-card p-4 flex flex-col gap-3 ${bank.active ? "" : "opacity-60"}`}>
                        <div className="flex items-start gap-3">
                          <span className="h-10 w-10 rounded-xl bg-brand-500/15 text-brand-700 dark:text-brand-500 flex items-center justify-center flex-shrink-0">
                            <Building2 className="w-5 h-5" strokeWidth={1.6} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-foreground truncate">{bank.bank_name}</p>
                            <p className="text-xs text-muted-foreground font-ledger truncate">{bank.account_number} · {bank.account_type}</p>
                          </div>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${!bank.active ? "bg-muted text-muted-foreground" : bank.owner_type === "company" ? "bg-muted text-muted-foreground" : "bg-info-50 text-info-700 dark:text-info-500"}`}>
                            {bank.active ? owner : "Inactive"}
                          </span>
                        </div>
                        <div>
                          <p className="lbl">Balance</p>
                          <p className={`font-ledger text-2xl font-semibold tracking-tight leading-tight ${acct < 0 ? "text-danger-700 dark:text-danger-500" : "text-foreground"}`}><span className="cur">PKR</span>{acct.toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {pendChq > 0 ? <>+ <span className="font-ledger text-warning-700 dark:text-warning-500">{pendChq.toLocaleString()}</span> in pending cheques = <span className="font-ledger text-foreground">{totalBal.toLocaleString()}</span></> : "no cheques in transit"}
                          </p>
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="h-1.5 rounded-full bg-muted overflow-hidden"><span className="block h-full rounded-full bg-brand-500" style={{ width: `${share * 100}%` }} /></span>
                          <span className="text-[11px] text-muted-foreground">{Math.round(share * 100)}% of the company's bank money</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border">
                          <Button variant="ghost" size="sm" onClick={() => openWithdraw(bank)} disabled={!bank.active}>Withdraw</Button>
                          <Button variant="ghost" size="sm" onClick={() => openEditBank(bank)}>Edit</Button>
                          <button
                            type="button"
                            onClick={() => handleToggleBankActive(bank)}
                            className={`ml-auto inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs ${bank.active ? "text-danger-700 dark:text-danger-500 hover:bg-danger-50" : "text-success-700 dark:text-success-500 hover:bg-success-50"}`}
                            title={bank.active ? "Deactivate bank account" : "Activate bank account"}
                          >
                            <Power className="w-3.5 h-3.5" strokeWidth={1.5} />
                            {bank.active ? "Deactivate" : "Activate"}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="bg-card border border-border rounded-2xl p-5 md:p-6">
              <Tabs<"cheques" | "deposits">
                size="sm"
                className="mb-3"
                value={chequeSectionView}
                onChange={setChequeSectionView}
                items={[
                  { value: "cheques", label: "Cheques", count: cheques.filter((c) => c.status === "pending").length || undefined },
                  { value: "deposits", label: "Cash deposits" },
                ]}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div>
                  {chequeSectionView === "cheques" ? (
                    <>
                      <h3 className="font-display text-lg font-bold tracking-tight text-foreground">Cheques</h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Cheques deduct the bank balance immediately when issued.
                      </p>
                    </>
                  ) : (
                    <>
                      <h3 className="font-display text-lg font-bold tracking-tight text-foreground">Cash Deposits</h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Cash moved from Cash in Hand into a bank account.
                      </p>
                    </>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ThemedSelect
                    value={chequeBankFilter}
                    onChange={(e) => setChequeBankFilter(e.target.value)}
                    className="px-3 py-1.5 border border-border rounded-xl bg-card text-sm"
                  >
                    <option value="all">All Banks</option>
                    {banks.map((b) => (
                      <option key={b.id} value={b.id}>{b.bank_name}</option>
                    ))}
                  </ThemedSelect>
                  {/* Cash deposits are atomic/immediate — no status concept, so the
                      Status filter only applies to cheques. */}
                  {chequeSectionView === "cheques" && (
                    <ThemedSelect
                      value={chequeFilter}
                      onChange={(e) => setChequeFilter(e.target.value as "all" | "pending" | "cleared" | "bounced")}
                      className="px-3 py-1.5 border border-border rounded-xl bg-card text-sm"
                    >
                      <option value="all">All Status</option>
                      <option value="pending">Pending</option>
                      <option value="cleared">Cleared</option>
                      <option value="bounced">Bounced</option>
                    </ThemedSelect>
                  )}
                  <ThemedSelect
                    value={chequeMonthFilter}
                    onChange={(e) => setChequeMonthFilter(e.target.value)}
                    className="px-3 py-1.5 border border-border rounded-xl bg-card text-sm"
                  >
                    <option value="all">All Months</option>
                    {monthOptions.map((m) => (
                      <option key={m.key} value={m.key}>{m.label}</option>
                    ))}
                  </ThemedSelect>
                  {chequeSectionView === "cheques" ? (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => { setChequeForm((f) => ({ ...f, direction: "outgoing", cheque_type: "payment" })); setIsChequeAddOpen(true); }}
                        disabled={banks.length === 0}
                      >
                        <Plus className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                        New Cheque
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={openCashDeposit}
                      disabled={banks.length === 0}
                    >
                      <Plus className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                      Cash Deposit
                    </Button>
                  )}
                </div>
              </div>

              {/* 2026-10-21: the history scrolls inside a fixed box (headers stay put)
                  so the panels below it — reconciliation, security deposits — are
                  reachable without scrolling past every cheque ever written. */}
              {chequeSectionView === "cheques" && (
              <div className="overflow-auto max-h-[26rem] rounded-xl border border-border overscroll-contain">
                <table className="w-full">
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="border-b border-border bg-muted/50">
                      <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Cheque #</th>
                      <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Type</th>
                      <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Bank</th>
                      <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Date</th>
                      <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Recipient / Payer</th>
                      <th className="text-right px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Amount</th>
                      <th className="text-right px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Used / Linked</th>
                      <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Status</th>
                      <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {cheques
                      .filter((c) => chequeBankFilter === "all" || c.bank_account_id === chequeBankFilter)
                      .filter((c) => chequeFilter === "all" || c.status === chequeFilter)
                      .filter((c) => chequeMonthFilter === "all" || (c.cheque_date ?? "").slice(0, 7) === chequeMonthFilter)
                      .map((c) => {
                        const bank = banks.find((b) => b.id === c.bank_account_id);
                        const linkedSum = chequeLinkedSums.get(c.id) ?? 0;
                        const isPayment = c.cheque_type === "payment";
                        const isIncoming = (c.direction ?? "outgoing") === "incoming";
                        const isReceivables = isIncoming && (c.invoice_id != null || c.client_id != null);
                        const canClear = isIncoming
                          ? true
                          : isPayment
                            ? Math.abs(linkedSum - Number(c.amount)) < 0.005
                            : true;
                        return (
                          <tr
                            key={c.id}
                            ref={c.id === focusCheque ? focusChequeRow : undefined}
                            className={`hover:bg-muted/50 ${
                              c.id === focusCheque ? FOCUS_ROW_CLASS : ""
                            }`}
                          >
                            <td className="px-4 py-2 text-sm text-foreground font-mono">{c.cheque_number}</td>
                            <td className="px-4 py-2 text-sm">
                              {isReceivables ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-info-50 text-info-700">Receivables</span>
                              ) : isIncoming ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-success-50 text-success-700">Deposit</span>
                              ) : isPayment ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-info-50 text-info-700">Payment</span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-info-50 text-info-700">Cash</span>
                              )}
                            </td>
                            <td className="px-4 py-2 text-sm text-muted-foreground">{bank?.bank_name ?? "—"}</td>
                            <td className="px-4 py-2 text-sm text-muted-foreground">{formatDate(c.cheque_date)}</td>
                            <td className="px-4 py-2 text-sm text-muted-foreground">{c.recipient ?? "—"}</td>
                            <td className="px-4 py-2 text-sm text-foreground text-right">
                              PKR {Number(c.amount).toLocaleString()}
                            </td>
                            <td className="px-4 py-2 text-sm text-right">
                              {!isIncoming && isPayment ? (
                                <span className={canClear ? "text-success-700" : "text-warning-700"}>
                                  PKR {linkedSum.toLocaleString()} / {Number(c.amount).toLocaleString()}
                                </span>
                              ) : (
                                <span className="text-muted-foreground/70">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              {c.status === "bounced" ? (
                                <span
                                  className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-danger-50 text-danger-700 border border-danger-200"
                                  title={c.bounce_reason ?? undefined}
                                >
                                  Bounced{c.bounced_at ? ` · ${c.bounced_at.slice(0, 10)}` : ""}
                                </span>
                              ) : c.status === "pending" ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-warning-50 text-warning-700">
                                  Pending
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-success-50 text-success-700">
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
                                      .select("id, net_salary, period_month, employee_id, employee:employee_id(full_name, employee_code)")
                                      .eq("cheque_id", c.id),
                                    supabase
                                      .from("expenses")
                                      .select("id, amount, expense_date, description, category:category_id(name), client:client_id(name)")
                                      .eq("cheque_id", c.id),
                                    supabase
                                      .from("advances")
                                      .select("id, amount, advance_date, employee_id, employee:employee_id(full_name, employee_code), client:client_id(name)")
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
                                      description: `${codeIndex.byId.get(p.employee_id) ?? p.employee?.employee_code ?? ""} ${p.employee?.full_name ?? ""} · ${String(p.period_month ?? "").slice(0, 7)}`,
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
                                      description: `${codeIndex.byId.get(a.employee_id) ?? a.employee?.employee_code ?? ""} ${a.employee?.full_name ?? ""}${a.client?.name ? ` · ${a.client.name}` : ""}`,
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
                                      ? (isReceivables
                                          ? `Mark cleared — PKR ${Number(c.amount).toLocaleString()} credited to bank, outstanding reduced`
                                          : isIncoming
                                            ? `Mark cleared (PKR ${Number(c.amount).toLocaleString()} will be credited to bank balance)`
                                            : isPayment
                                              ? "Mark cleared (bank balance stays deducted)"
                                              : "Mark cleared (cash balance increases by cheque amount)")
                                      : `Linked items total PKR ${linkedSum.toLocaleString()} must equal cheque amount PKR ${Number(c.amount).toLocaleString()} before clearing.`
                                  }
                                  onClick={async () => {
                                    const msg = isReceivables
                                      ? `Mark this receivables cheque as cleared?\n\nPKR ${Number(c.amount).toLocaleString()} will be credited to ${bank?.bank_name ?? "the bank"} and the client's outstanding balance will be reduced.`
                                      : isIncoming
                                        ? `Mark this deposit cheque as cleared? PKR ${Number(c.amount).toLocaleString()} will be added to ${bank?.bank_name ?? "the bank"}'s balance.`
                                        : isPayment
                                          ? "Mark this payment cheque as cleared? Bank stays deducted; cashflow recognises linked expenses/salaries/advances now."
                                          : "Mark this cash cheque as cleared? Bank stays deducted; PKR " + Number(c.amount).toLocaleString() + " will be added to the Cash (Treasury) balance.";
                                    if (!window.confirm(msg)) return;
                                    const { error: e } = await supabase.rpc("set_cheque_status", {
                                      p_cheque_id: c.id,
                                      p_status: "cleared",
                                    });
                                    if (e) { setError(e.message); return; }
                                    await loadAll();
                                  }}
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                                  Mark Cleared
                                </Button>
                              )}
              {/* A failed cheque is BOUNCED, never deleted — the bank remembers
                  it either way, and a reconciliation with no trace of it is
                  unexplainable. The row stays with its history. */}
              {/* Only a PENDING cheque can bounce. A cleared one has settled —
                  money moved, invoice payment recorded — so calling it bounced
                  after the fact rewrites a settled event. Revert the clearance
                  first; the two steps then stay separately audited. */}
                              {c.status === "pending" && (
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-sm text-danger-700 hover:bg-danger-50"
                                  title={
                                    isIncoming
                                      ? "Mark bounced — the payment never arrived"
                                      : "Mark bounced — the reserved amount returns to the bank"
                                  }
                                  onClick={() => { setBounceTarget(c); setBounceReason(""); setBounceError(null); }}
                                >
                                  <Ban className="w-3.5 h-3.5" strokeWidth={1.5} />
                                  Bounced
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
                        <td colSpan={9} className="px-4 py-6 text-center text-sm text-muted-foreground">
                          No cheques to show.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              )}

              {chequeSectionView === "deposits" && (
              <div className="overflow-auto max-h-[26rem] rounded-xl border border-border overscroll-contain">
                <table className="w-full">
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="border-b border-border">
                      <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Slip #</th>
                      <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Bank</th>
                      <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Date</th>
                      <th className="text-right px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Amount</th>
                      <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Deposited By</th>
                      <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Reference / Notes</th>
                      <th className="text-right px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredDeposits.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                          No cash deposits to show.
                        </td>
                      </tr>
                    )}
                    {filteredDeposits.map((d) => {
                      const bank = banks.find((b) => b.id === d.bank_account_id);
                      return (
                        <tr key={d.id} className="hover:bg-muted/50 transition-colors">
                          <td className="px-4 py-2 text-sm text-foreground font-mono">#{d.slip_number}</td>
                          <td className="px-4 py-2 text-sm text-muted-foreground">{bank ? `${bank.bank_name} · ${bank.account_number}` : "—"}</td>
                          <td className="px-4 py-2 text-sm text-muted-foreground">{formatDate(d.deposit_date)}</td>
                          <td className="px-4 py-2 text-sm text-foreground text-right font-mono">PKR {Number(d.amount).toLocaleString()}</td>
                          <td className="px-4 py-2 text-sm text-muted-foreground">{custodianNameByLoc(d.cash_location_id) ?? (d.deposited_by ? (profileNames.get(d.deposited_by) ?? "—") : "—")}</td>
                          <td className="px-4 py-2 text-sm text-muted-foreground">{d.notes ?? "—"}</td>
                          <td className="px-4 py-2 text-right flex gap-2 justify-end">
                            <Button variant="ghost" size="sm" onClick={() => downloadSlipByRef(d.id)}>
                              <FileText className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                              Download Slip
                            </Button>
                            {d.drive_view_url && (
                              <a
                                href={d.drive_view_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs text-brand-700 hover:bg-brand-50"
                              >
                                View Upload
                              </a>
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
            <BankReconciliation companyId={treasuryCompanyId} banks={banks} canEdit={canEditAccounting} onMoved={() => { void loadAll(); }} />
            <SecurityDeposits companyId={treasuryCompanyId} banks={banks} canEdit={canEditAccounting} onMoved={() => { void loadAll(); }} />
            </>
          )}

          {activeTab === "cash-custody" && (
            <div>
              <CashCustodyPanel onReady={(api) => { custodyApiRef.current = api; }} onSummary={setCustodySummary} />
            </div>
          )}
        </div>
      </div>

      <Modal
        isOpen={isChequeAddOpen}
        onClose={() => { setIsChequeAddOpen(false); setChequeFormError(null); }}
        title={chequeForm.direction === "incoming" ? "Record Deposit Cheque" : "New Cheque"}
        size="md"
      >
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setChequeFormError(null);
            const amount = Number(chequeForm.amount);
            if (!chequeForm.bank_account_id || !chequeForm.cheque_number || !amount || amount <= 0 || !chequeForm.cheque_date) return;
            // A Cash cheque is handed to an office-staff custodian, who then holds
            // the cash once it is encashed. It is recorded pending and clears on
            // the same manual step a payment cheque uses.
            const isCashCheque = chequeForm.direction === "outgoing" && chequeForm.cheque_type === "cash";
            const cashStaff = isCashCheque ? custodians.find((c) => c.employeeId === chequeForm.custodian_employee_id) : null;
            if (isCashCheque && !cashStaff) {
              setChequeFormError("Select the office-staff member who receives this cash cheque.");
              return;
            }
            // For outgoing cheques only: block over-issue if bank balance is insufficient
            if (chequeForm.direction !== "incoming") {
              const issuingBank = banks.find((b) => b.id === chequeForm.bank_account_id);
              if (issuingBank && !(await bankCovers(issuingBank, amount))) {
                setChequeFormError(issuingBank.balanceHidden
                  ? `Cheque amount (PKR ${amount.toLocaleString()}) exceeds the bank's available balance.`
                  : `Cheque amount (PKR ${amount.toLocaleString()}) exceeds the bank's available balance (PKR ${Number(issuingBank.balance).toLocaleString()}).`);
                return;
              }
            }
            setChequeSubmitting(true);
            setError(null);
            try {
              const cid = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
              // Resolve (creating on first use) the custodian cash_location for a cash cheque.
              const custodianLocId = isCashCheque && cashStaff && cid
                ? await ensureCustodianLocation(cid, cashStaff.employeeId, cashStaff.fullName)
                : null;
              const { data: newChequeId, error: insErr } = await supabase.rpc("record_cheque", {
                p_bank_account_id: chequeForm.bank_account_id,
                p_cheque_number: chequeForm.cheque_number.trim(),
                p_amount: amount,
                p_cheque_date: chequeForm.cheque_date,
                p_cheque_type: chequeForm.direction === "incoming" ? "cash" : chequeForm.cheque_type,
                p_direction: chequeForm.direction,
                p_recipient: isCashCheque ? cashStaff!.fullName : (chequeForm.recipient.trim() || null),
                p_notes: chequeForm.notes.trim() || null,
                p_custodian_location_id: custodianLocId,
              });
              if (insErr) throw insErr;
              const chequeId = newChequeId as string;
              // A cash cheque stays PENDING until someone marks it cleared, exactly
              // like a payment cheque. It used to clear the instant it was written,
              // which recorded the cash as in the custodian's hands before the bank
              // had actually paid it out — there was no way to represent a cash
              // cheque that had been issued but not yet encashed, and no way to
              // bounce one. The custodian attribution is already on the row via
              // custodian_location_id, so clearing later still lands on the right
              // person.
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
                direction: "outgoing",
                recipient: "",
                custodian_employee_id: "",
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
            <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-xl text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={2} />
              <div className="flex-1">{chequeFormError}</div>
              <button type="button" onClick={() => setChequeFormError(null)}>
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
          {chequeForm.direction === "incoming" ? (
            <div className="p-3 bg-success-50 border border-success-200 rounded-xl text-xs text-success-700">
              <strong>Deposit Cheque</strong> — Recording a cheque received from a payer. The bank balance will be credited <strong>only when you mark it as cleared</strong>. No balance change on issue.
            </div>
          ) : (
          <div>
            <label className="block text-sm text-foreground mb-1">Cheque Type *</label>
            <div className="grid grid-cols-2 gap-2">
              <label
                className={`flex items-start gap-2 px-3 py-2 border rounded-xl cursor-pointer text-sm ${
                  chequeForm.cheque_type === "payment" ? "border-foreground bg-muted/50" : "border-border hover:border-border"
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
                  <span className="block text-[11px] text-muted-foreground">Used to pay expenses/salaries/advances. Clears only when the linked items' total matches exactly.</span>
                </span>
              </label>
              <label
                className={`flex items-start gap-2 px-3 py-2 border rounded-xl cursor-pointer text-sm ${
                  chequeForm.cheque_type === "cash" ? "border-foreground bg-muted/50" : "border-border hover:border-border"
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
                  <span className="block text-[11px] text-muted-foreground">Withdraw from this bank. On clearance, the amount lands in the Cash (Treasury) balance.</span>
                </span>
              </label>
            </div>
          </div>
          )}
          <div>
            <label className="block text-sm text-foreground mb-1">Bank Account *</label>
            <ThemedSelect
              required
              value={chequeForm.bank_account_id}
              onChange={(e) => setChequeForm({ ...chequeForm, bank_account_id: e.target.value })}
              className="w-full px-4 py-2 border border-border rounded-xl text-sm"
            >
              <option value="">Select bank</option>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.bank_name} · {b.account_number}{b.balanceHidden ? "" : ` (PKR ${Number(b.balance).toLocaleString()})`}
                </option>
              ))}
            </ThemedSelect>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-foreground mb-1">Cheque Number *</label>
              <input
                required
                type="text"
                value={chequeForm.cheque_number}
                onChange={(e) => setChequeForm({ ...chequeForm, cheque_number: e.target.value })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm font-mono"
                placeholder="e.g., 000123"
              />
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Date *</label>
              <input
                required
                type="date"
                value={chequeForm.cheque_date}
                onChange={(e) => setChequeForm({ ...chequeForm, cheque_date: e.target.value })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm"
              />
            </div>
            <div className="col-span-full">
              <label className="block text-sm text-foreground mb-1">Amount (PKR) *</label>
              <input
                required
                type="number"
                step="0.01"
                value={chequeForm.amount}
                onChange={(e) => setChequeForm({ ...chequeForm, amount: e.target.value })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm"
                placeholder="0.00"
              />
              <AmountInWords value={chequeForm.amount} />
            </div>
            <div className="col-span-full">
              <label className="block text-sm text-foreground mb-1">
                {chequeForm.direction === "incoming"
                  ? "Received From (Payer)"
                  : chequeForm.cheque_type === "cash"
                    ? "Cash Received By (Office Staff)"
                    : "Recipient"}
              </label>
              {chequeForm.direction === "outgoing" && chequeForm.cheque_type === "cash" ? (
                <>
                  <ThemedSelect
                    value={chequeForm.custodian_employee_id}
                    onChange={(e) => setChequeForm({ ...chequeForm, custodian_employee_id: e.target.value })}
                    className="w-full px-4 py-2 border border-border rounded-xl text-sm"
                  >
                    <option value="">Select office-staff recipient…</option>
                    {custodians.map((c) => (
                      <option key={c.employeeId} value={c.employeeId}>{c.fullName} — holds {`PKR ${Math.round(c.held).toLocaleString()}`}</option>
                    ))}
                  </ThemedSelect>
                  <p className="text-[11px] text-muted-foreground mt-1">Once the cheque is marked cleared, the cash lands in this custodian's held cash and in Cash in Hand.</p>
                </>
              ) : (
                <input
                  type="text"
                  value={chequeForm.recipient}
                  onChange={(e) => setChequeForm({ ...chequeForm, recipient: e.target.value })}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm"
                  placeholder={chequeForm.direction === "incoming" ? "Payer / drawer name" : "Payee name"}
                />
              )}
            </div>
            <div className="col-span-full">
              <label className="block text-sm text-foreground mb-1">Notes</label>
              <textarea
                value={chequeForm.notes}
                onChange={(e) => setChequeForm({ ...chequeForm, notes: e.target.value })}
                rows={2}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm"
              />
            </div>
            <div className="col-span-full">
              <label className="block text-sm text-foreground mb-1">Attachment (optional)</label>
              <input
                type="file"
                onChange={(e) => setChequeForm({ ...chequeForm, attachment: e.target.files?.[0] })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm"
              />
              {chequeForm.attachment && (
                <p className="text-xs text-muted-foreground mt-1">Selected: {chequeForm.attachment.name}</p>
              )}
            </div>
          </div>
          {chequeForm.direction === "outgoing" && chequeForm.cheque_type === "cash" && (
            <div className="bg-brand-50 border border-brand-200 rounded-xl p-3 text-xs text-brand-700 dark:text-brand-500">
              Issuing this cheque will <strong>reserve</strong> PKR {Number(chequeForm.amount || 0).toLocaleString()} from the selected bank's Account Balance.{" "}
              It stays <strong>Pending</strong> until you mark it cleared — only then does the cash move into <strong>Cash in Hand</strong> and the selected custodian's held cash.
              {" "}Deleting it while Pending restores the bank balance.
            </div>
          )}
          {chequeForm.direction === "outgoing" && chequeForm.cheque_type === "payment" && (
            <div className="bg-warning-50 border border-warning-200 rounded-xl p-3 text-xs text-warning-700 dark:text-warning-500">
              Issuing this cheque will <strong>reserve</strong> PKR {Number(chequeForm.amount || 0).toLocaleString()} from the selected bank's Account Balance.{" "}
              This payment cheque can only be cleared once linked expenses/salaries/advances total exactly its amount.
              {" "}Deleting it while Pending restores the bank balance.
            </div>
          )}
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" disabled={chequeSubmitting}>
              {chequeSubmitting ? "Saving…" : chequeForm.direction === "incoming" ? "Record Deposit Cheque" : "Issue Cheque"}
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsChequeAddOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!bounceTarget}
        error={bounceError}
        onDismissError={() => setBounceError(null)}
        onClose={() => setBounceTarget(null)}
        title={bounceTarget ? `Bounce cheque #${bounceTarget.cheque_number}` : ""}
        size="sm"
      >
        {bounceTarget && (() => {
          const isIncoming = (bounceTarget.direction ?? "outgoing") === "incoming";
          const bankName =
            banks.find((b) => b.id === bounceTarget.bank_account_id)?.bank_name ?? "the bank";
          const amount = `PKR ${Number(bounceTarget.amount).toLocaleString()}`;
          return (
            <form
              className="space-y-4"
              onSubmit={async (ev) => {
                ev.preventDefault();
                setBounceSubmitting(true);
                setBounceError(null);
                const { error: e } = await supabase.rpc("set_cheque_status", {
                  p_cheque_id: bounceTarget.id,
                  p_status: "bounced",
                  p_bounce_reason: bounceReason.trim() || null,
                });
                setBounceSubmitting(false);
                if (e) { setBounceError(e.message); return; }
                setBounceTarget(null);
                await loadAll();
              }}
            >
              <div className="rounded-xl border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm text-danger-700 dark:text-danger-500">
                {isIncoming
                  ? `No balance change — ${bankName} was never credited for this cheque.`
                  : `${amount} returns to ${bankName}: the amount was reserved when the cheque was issued and the money never left.`}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Amount</p>
                  <p className="text-foreground">{amount}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Bank</p>
                  <p className="text-foreground">{bankName}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Date</p>
                  <p className="text-foreground">{formatDate(bounceTarget.cheque_date)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{isIncoming ? "From" : "To"}</p>
                  <p className="text-foreground">{bounceTarget.recipient ?? "—"}</p>
                </div>
              </div>
              <div>
                <label className="block text-sm text-foreground mb-1">Reason</label>
                <textarea
                  rows={3}
                  autoFocus
                  value={bounceReason}
                  onChange={(ev) => setBounceReason(ev.target.value)}
                  className="w-full px-3 py-2 border border-border rounded-xl text-sm"
                  placeholder="e.g. Insufficient funds, signature mismatch, stale-dated"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Optional, but it is what the bank statement will need explaining against later.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                The cheque is kept and marked Bounced — it is never deleted, so the record still
                matches the bank.
              </p>
              <div className="flex gap-2 pt-1">
                <Button variant="danger" size="md" className="flex-1" disabled={bounceSubmitting}>
                  {bounceSubmitting ? "Saving…" : "Mark Bounced"}
                </Button>
                <Button variant="secondary" size="md" onClick={() => setBounceTarget(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          );
        })()}
      </Modal>

      <Modal isOpen={!!chequeView} onClose={() => setChequeView(null)} title={chequeView ? `Cheque #${chequeView.cheque_number}` : ""} size="lg">
        {chequeView && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Direction / Type</p>
                <p className="flex gap-1">
                  {(chequeView.direction ?? "outgoing") === "incoming" ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-success-50 text-success-700">Deposit (Incoming)</span>
                  ) : chequeView.cheque_type === "payment" ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-info-50 text-info-700">Payment (Outgoing)</span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-info-50 text-info-700">Cash (Outgoing)</span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <p>
                  {chequeView.status === "bounced" ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-danger-50 text-danger-700 border border-danger-200">
                      Bounced{chequeView.bounced_at ? ` · ${chequeView.bounced_at.slice(0, 10)}` : ""}
                    </span>
                  ) : chequeView.status === "pending" ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-warning-50 text-warning-700">Pending</span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full font-semibold text-xs bg-success-50 text-success-700">
                      Cleared{chequeView.cleared_at ? ` · ${chequeView.cleared_at.slice(0, 10)}` : ""}
                    </span>
                  )}
                  {chequeView.bounce_reason && (
                    <span className="block text-xs text-muted-foreground mt-1">{chequeView.bounce_reason}</span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Bank</p>
                <p className="text-foreground">{banks.find((b) => b.id === chequeView.bank_account_id)?.bank_name ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Date</p>
                <p className="text-foreground">{formatDate(chequeView.cheque_date)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  {(chequeView.direction ?? "outgoing") === "incoming" ? "Received From" : "Recipient"}
                </p>
                <p className="text-foreground">{chequeView.recipient ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Amount</p>
                <p className="text-foreground">PKR {Number(chequeView.amount).toLocaleString()}</p>
              </div>
              {chequeView.notes && (
                <div className="col-span-full">
                  <p className="text-xs text-muted-foreground">Notes</p>
                  <p className="text-foreground whitespace-pre-wrap">{chequeView.notes}</p>
                </div>
              )}
              {(chequeView.drive_view_url || chequeView.attachment_path) && (
                <div className="col-span-full">
                  <p className="text-xs text-muted-foreground mb-1">Attachment</p>
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
                    <span className="text-xs text-muted-foreground/70">Loading…</span>
                  )}
                </div>
              )}
            </div>

            {(chequeView.direction ?? "outgoing") !== "incoming" && (
            <div className="border-t border-border pt-3">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm text-foreground">Linked Items</h4>
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
                <p className="text-sm text-muted-foreground">Nothing linked to this cheque yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        <th className="text-left px-3 py-2">Kind</th>
                        <th className="text-left px-3 py-2">Description</th>
                        <th className="text-left px-3 py-2">Date</th>
                        <th className="text-right px-3 py-2">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {chequeViewItems.map((it, idx) => (
                        <tr key={idx}>
                          <td className="px-3 py-2 text-xs">
                            <span className="inline-flex items-center px-2 py-0.5 rounded bg-muted text-foreground">{it.kind}</span>
                          </td>
                          <td className="px-3 py-2 text-foreground">{it.description}</td>
                          <td className="px-3 py-2 text-muted-foreground">{it.date}</td>
                          <td className="px-3 py-2 text-right text-foreground">PKR {it.amount.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            )}
          </div>
        )}
      </Modal>

      <Modal isOpen={isBankModalOpen} error={error} onDismissError={() => setError(null)} onClose={() => setIsBankModalOpen(false)} title="Add Bank Account" size="md">
        <form className="space-y-4" onSubmit={handleAddBank}>
          <div>
            <label className="block text-sm text-foreground mb-1">Bank Name *</label>
            <input
              required
              type="text"
              value={newBank.bank_name}
              onChange={(e) => setNewBank({ ...newBank, bank_name: e.target.value })}
              className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              placeholder="e.g., Allied Bank"
            />
          </div>
          <div>
            <label className="block text-sm text-foreground mb-1">Account Number *</label>
            <input
              required
              type="text"
              value={newBank.account_number}
              onChange={(e) => setNewBank({ ...newBank, account_number: e.target.value })}
              className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              placeholder="Enter account number"
            />
          </div>
          <div>
            <label className="block text-sm text-foreground mb-1">IBAN</label>
            <input
              type="text"
              value={newBank.iban}
              maxLength={24}
              onChange={(e) => setNewBank({ ...newBank, iban: e.target.value.toUpperCase().replace(/\s+/g, "") })}
              className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent font-mono"
              placeholder="PKxx XXXX XXXX XXXX XXXX XXXX"
            />
            {newBank.iban && newBank.iban.length !== 24 && (
              <p className="text-xs text-warning-700 mt-1">
                Pakistani IBANs are 24 characters (currently {newBank.iban.length}).
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-foreground mb-1">Branch Code</label>
              <input
                type="text"
                value={newBank.branch_code}
                onChange={(e) => setNewBank({ ...newBank, branch_code: e.target.value })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                placeholder="e.g., 0123"
              />
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Branch Name</label>
              <input
                type="text"
                value={newBank.branch_name}
                onChange={(e) => setNewBank({ ...newBank, branch_name: e.target.value })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                placeholder="e.g., DHA Phase 5"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-foreground mb-1">SWIFT Code</label>
              <input
                type="text"
                value={newBank.swift_code}
                onChange={(e) => setNewBank({ ...newBank, swift_code: e.target.value.toUpperCase() })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent font-mono"
                placeholder="ABPAPKKA"
              />
              <p className="text-[10px] text-muted-foreground mt-1">Optional — for future foreign transfers.</p>
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Currency</label>
              <ThemedSelect
                value={newBank.currency_code}
                onChange={(e) => setNewBank({ ...newBank, currency_code: e.target.value })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              >
                <option value="PKR">PKR — Pakistani Rupee</option>
                <option value="USD">USD — US Dollar</option>
                <option value="AED">AED — UAE Dirham</option>
                <option value="GBP">GBP — British Pound</option>
                <option value="EUR">EUR — Euro</option>
              </ThemedSelect>
            </div>
          </div>
          <div>
            <label className="block text-sm text-foreground mb-1">Account Type</label>
            <ThemedSelect
              value={newBank.account_type}
              onChange={(e) => setNewBank({ ...newBank, account_type: e.target.value as "Current" | "Savings" })}
              className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
            >
              <option value="Current">Current</option>
              <option value="Savings">Savings</option>
            </ThemedSelect>
          </div>
          <div>
            <label className="block text-sm text-foreground mb-1">Account For *</label>
            <ThemedSelect
              value={newBank.owner_type}
              onChange={(e) => setNewBank({ ...newBank, owner_type: e.target.value as BankAccountOwnerType, owner_partner_id: "", owner_client_id: "" })}
              className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
            >
              <option value="company">Company</option>
              <option value="partner">Partner</option>
              <option value="client">Client</option>
            </ThemedSelect>
          </div>
          {newBank.owner_type === "partner" && (
            <div>
              <label className="block text-sm text-foreground mb-1">Partner *</label>
              <ThemedSelect
                required
                value={newBank.owner_partner_id}
                onChange={(e) => setNewBank({ ...newBank, owner_partner_id: e.target.value })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              >
                <option value="">Select partner…</option>
                {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </ThemedSelect>
              {partners.length === 0 && (
                <p className="text-xs text-warning-700 mt-1">No partners yet. Add partners in the Partnership Report first.</p>
              )}
            </div>
          )}
          {newBank.owner_type === "client" && (
            <div>
              <label className="block text-sm text-foreground mb-1">Client *</label>
              <ThemedSelect
                required
                value={newBank.owner_client_id}
                onChange={(e) => setNewBank({ ...newBank, owner_client_id: e.target.value })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              >
                <option value="">Select client…</option>
                {receivables.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </ThemedSelect>
            </div>
          )}
          <div>
            <label className="block text-sm text-foreground mb-1">Opening Balance (PKR)</label>
            <input
              type="number"
              value={newBank.opening_balance}
              onChange={(e) => setNewBank({ ...newBank, opening_balance: e.target.value })}
              className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              placeholder="0"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Seeded into Account Balance and logged as an opening transaction.
            </p>
          </div>
          {/* The "Reset balance to 0 at each month-end" checkbox was removed by
              0308 along with the function behind it. It described itself as
              removing the remaining balance "via an adjusting entry"; what it
              actually did was recompute the balance from bank_transactions and
              discard anything not built from that log — including the opening
              balance. Nothing replaces it: an account that should be emptied
              needs a transfer that posts, not a flag that rewrites a number. */}
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

      <Modal isOpen={isDepositModalOpen} error={error} onDismissError={() => setError(null)} onClose={() => setIsDepositModalOpen(false)} title="Cash Deposit" size="md">
        {depositSuccess && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 p-3 bg-success-50 border border-success-200 rounded-xl">
              <CheckCircle2 className="w-5 h-5 text-success-600 mt-0.5" strokeWidth={1.5} />
              <div className="text-sm text-success-700 dark:text-success-500">
                Deposited <strong>PKR {depositSuccess.amount.toLocaleString()}</strong> to {depositSuccess.bank_name}.
                Cash in Hand reduced; bank balance increased. Slip <strong>#{depositSuccess.slip_number}</strong>.
              </div>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <Button variant="primary" size="md" className="flex-1" onClick={() => downloadDepositSlip(depositSuccess)}>
                <Download className="w-4 h-4 mr-2" strokeWidth={1.5} /> Download Slip
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsDepositModalOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        )}
        {!depositSuccess && (
          <form className="space-y-4" onSubmit={handleDeposit}>
            <div>
              <label className="block text-sm text-foreground mb-1">Deposited By (custodian) *</label>
              <ThemedSelect
                required
                value={depositCustodianId}
                onChange={(e) => setDepositCustodianId(e.target.value)}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              >
                <option value="">Select who is depositing this cash…</option>
                {custodians.map((c) => (
                  <option key={c.locationId ?? c.employeeId} value={c.locationId ?? ""}>
                    {c.fullName} — holds PKR {Math.round(c.held).toLocaleString()}
                  </option>
                ))}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Source</label>
              {(() => {
                const sel = custodians.find((c) => c.locationId === depositCustodianId);
                return (
                  <input
                    type="text"
                    value={sel ? `${sel.fullName}'s cash · PKR ${Math.round(sel.held).toLocaleString()} available` : "Select a custodian above"}
                    disabled
                    className="w-full px-4 py-2 border border-border rounded-xl text-sm bg-muted/50"
                  />
                );
              })()}
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Bank Account</label>
              {selectedBank ? (
                <input
                  type="text"
                  value={`${selectedBank.bank_name} · ${selectedBank.account_number}`}
                  disabled
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm bg-muted/50"
                />
              ) : (
                <ThemedSelect
                  required
                  value={depositBankId}
                  onChange={(e) => setDepositBankId(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                >
                  <option value="">Select bank account…</option>
                  {banks.filter((b) => b.active).map((b) => (
                    <option key={b.id} value={b.id}>{b.bank_name} · {b.account_number}</option>
                  ))}
                </ThemedSelect>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-foreground mb-1">Deposit Date *</label>
                <input
                  required
                  type="date"
                  value={depositDate}
                  onChange={(e) => setDepositDate(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm text-foreground mb-1">Amount (PKR) *</label>
                <input
                  required
                  type="number"
                  min={1}
                  step="0.01"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                  placeholder="0"
                />
                <AmountInWords value={depositAmount} />
              </div>
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Reference / Notes</label>
              <input
                type="text"
                value={depositNotes}
                onChange={(e) => setDepositNotes(e.target.value)}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                placeholder="Optional note (e.g. source of funds)"
              />
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Deposit Slip (optional)</label>
              <input
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => setDepositSlipFile(e.target.files?.[0] ?? null)}
                className="w-full text-sm text-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:bg-muted file:text-foreground hover:file:bg-muted"
              />
              {depositSlipFile && (
                <p className="text-xs text-muted-foreground mt-1">{depositSlipFile.name} will be uploaded to Google Drive.</p>
              )}
            </div>
            {depositError && (
              <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-xl text-sm">
                <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
                <div className="flex-1">{depositError}</div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Moves money from the selected custodian's held cash into this bank account — a pure
              location transfer. It does not create an expense, payroll, or partner entry.
            </p>
            <div className="flex items-center gap-3 pt-2">
              <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
                {submitting ? "Processing…" : "Deposit"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsDepositModalOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal isOpen={isWithdrawModalOpen} error={error} onDismissError={() => setError(null)} onClose={() => setIsWithdrawModalOpen(false)} title="Withdraw to Cash" size="md">
        {selectedBank && (
          <form className="space-y-4" onSubmit={handleWithdraw}>
            <div>
              <label className="block text-sm text-foreground mb-1">Bank Account</label>
              <input
                type="text"
                value={`${selectedBank.bank_name} · ${selectedBank.account_number}`}
                disabled
                className="w-full px-4 py-2 border border-border rounded-xl text-sm bg-muted/50"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-foreground mb-1">Account Balance</label>
                <input
                  type="text"
                  value={`PKR ${Number(selectedBank.balance).toLocaleString()}`}
                  disabled
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm bg-muted/50"
                />
              </div>
              <div>
                <label className="block text-sm text-foreground mb-1">Cash Balance</label>
                <input
                  type="text"
                  value={`PKR ${cashBalance.toLocaleString()}`}
                  disabled
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm bg-muted/50"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Amount to Withdraw (PKR) *</label>
              <input
                required
                type="number"
                min={1}
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                placeholder="0"
              />
              <AmountInWords value={withdrawAmount} />
              <p className="text-xs text-muted-foreground mt-1">
                Deducts from Account Balance and adds to Cash Balance.
              </p>
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Cash Received By (Office Staff) *</label>
              <ThemedSelect
                value={withdrawCustodianId}
                onChange={(e) => setWithdrawCustodianId(e.target.value)}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              >
                <option value="">Select office-staff recipient…</option>
                {custodians.map((c) => (
                  <option key={c.employeeId} value={c.employeeId}>{c.fullName} — holds {`PKR ${Math.round(c.held).toLocaleString()}`}</option>
                ))}
              </ThemedSelect>
              <p className="text-xs text-muted-foreground mt-1">The withdrawn cash is added to this custodian's held cash.</p>
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Notes</label>
              <textarea
                value={withdrawNotes}
                onChange={(e) => setWithdrawNotes(e.target.value)}
                rows={2}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
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
            <div className="pb-4 border-b border-border">
              <h3 className="font-display text-lg font-bold tracking-tight text-foreground">{selectedClient.name}</h3>
              <p className="text-xs text-muted-foreground font-mono">{selectedClient.client_code}</p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="bg-card p-3 md:p-4 rounded-2xl border border-border">
                <p className="lbl mb-1">Opening Balance</p>
                <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-lg text-foreground"><span className="cur">PKR</span>{Number(selectedClient.opening_balance ?? 0).toLocaleString()}</p>
              </div>
              <div className="bg-card p-3 md:p-4 rounded-2xl border border-border">
                <p className="lbl mb-1">Total Invoiced</p>
                <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-lg text-brand-700"><span className="cur">PKR</span>{selectedClient.total_invoiced.toLocaleString()}</p>
              </div>
              <div className="bg-card p-3 md:p-4 rounded-2xl border border-border">
                <p className="lbl mb-1">Received</p>
                <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-lg text-success-700"><span className="cur">PKR</span>{selectedClient.total_received.toLocaleString()}</p>
              </div>
              <div className="bg-card p-3 md:p-4 rounded-2xl border border-border">
                <p className="lbl mb-1">Withholding</p>
                <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-lg text-danger-700"><span className="cur">PKR</span>{selectedClient.total_withholding.toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">deducted by the client</p>
              </div>
              <div className="bg-card p-3 md:p-4 rounded-2xl border border-border">
                <p className="lbl mb-1">Outstanding</p>
                <p className="font-ledger whitespace-nowrap font-semibold tracking-tight text-lg text-warning-700"><span className="cur">PKR</span>{selectedClient.outstanding.toLocaleString()}</p>
              </div>
            </div>

            {statementLedger && (
              <div className="pt-4 border-t border-border">
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                  <h4 className="text-sm text-foreground">Ledger</h4>
                  <span className="text-xs text-muted-foreground">
                    {statementLedger.scopeLabel} &middot; {statementLedger.entries.length}{" "}
                    {statementLedger.entries.length === 1 ? "entry" : "entries"}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left px-3 py-2 text-xs text-muted-foreground">Date</th>
                        <th className="text-left px-3 py-2 text-xs text-muted-foreground">Entry</th>
                        <th className="text-left px-3 py-2 text-xs text-muted-foreground">Reference</th>
                        <th className="text-left px-3 py-2 text-xs text-muted-foreground">Account / Instrument</th>
                        <th className="text-right px-3 py-2 text-xs text-muted-foreground">Invoiced</th>
                        <th className="text-right px-3 py-2 text-xs text-muted-foreground">Received</th>
                        <th className="text-right px-3 py-2 text-xs text-muted-foreground">Withholding</th>
                        <th className="text-right px-3 py-2 text-xs text-muted-foreground">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      <tr className="bg-muted/50">
                        <td className="px-3 py-2 text-xs text-muted-foreground">&mdash;</td>
                        <td className="px-3 py-2 text-xs text-foreground" colSpan={3}>
                          Opening balance
                          {receivablesMonth !== "all" && (
                            <span className="text-muted-foreground"> &middot; carried forward</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-right text-muted-foreground/50">&mdash;</td>
                        <td className="px-3 py-2 text-xs text-right text-muted-foreground/50">&mdash;</td>
                        <td className="px-3 py-2 text-xs text-right text-muted-foreground/50">&mdash;</td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums text-foreground">
                          PKR {Math.round(statementLedger.opening).toLocaleString()}
                        </td>
                      </tr>
                      {statementLedger.entries.map((e) => (
                        <tr key={e.key}>
                          <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                            {e.date ? formatDate(e.date) : <span className="text-muted-foreground/50">&mdash;</span>}
                          </td>
                          <td className="px-3 py-2 text-xs text-foreground whitespace-nowrap">{e.label}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground font-mono max-w-[12rem] truncate" title={e.reference}>
                            {e.reference}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground max-w-[14rem] truncate" title={e.account}>
                            {e.account || <span className="text-muted-foreground/50">&mdash;</span>}
                          </td>
                          <td className="px-3 py-2 text-xs text-right tabular-nums text-brand-600">
                            {e.debit ? `PKR ${Math.round(e.debit).toLocaleString()}` : <span className="text-muted-foreground/50">&mdash;</span>}
                          </td>
                          <td className="px-3 py-2 text-xs text-right tabular-nums text-success-600">
                            {e.credit ? `PKR ${Math.round(e.credit).toLocaleString()}` : <span className="text-muted-foreground/50">&mdash;</span>}
                          </td>
                          <td className="px-3 py-2 text-xs text-right tabular-nums text-danger-600">
                            {e.withholding ? `PKR ${Math.round(e.withholding).toLocaleString()}` : <span className="text-muted-foreground/50">&mdash;</span>}
                          </td>
                          <td className="px-3 py-2 text-xs text-right tabular-nums text-foreground">
                            PKR {Math.round(e.balance).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {/* Folded from the rows above, never fetched separately: a
                        footer that can disagree with its own table is worse than
                        no footer. */}
                    <tfoot>
                      <tr className="border-t-2 border-border bg-muted/50">
                        <td className="px-3 py-2 text-xs text-foreground" colSpan={4}>Closing balance</td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums text-brand-700">
                          PKR {Math.round(statementLedger.debits).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums text-success-700">
                          PKR {Math.round(statementLedger.credits).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums text-danger-700">
                          PKR {Math.round(statementLedger.withheld).toLocaleString()}
                        </td>
                        <td className={`px-3 py-2 text-xs text-right tabular-nums ${statementLedger.closing > 0 ? "text-warning-700" : "text-success-700"}`}>
                          PKR {Math.round(statementLedger.closing).toLocaleString()}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {statementLedger.entries.length === 0 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Nothing invoiced or received in this period &mdash; the balance is the carried-forward opening.
                  </p>
                )}
                {Math.abs(statementLedger.closing - statementLedger.rowOutstanding) > 1 && (
                  <p className="mt-2 text-xs text-warning-700">
                    This ledger closes at PKR {Math.round(statementLedger.closing).toLocaleString()} but the
                    Receivables row reads PKR {Math.round(statementLedger.rowOutstanding).toLocaleString()}.
                    One of the two is wrong &mdash; reconcile before sending this statement out.
                  </p>
                )}
              </div>
            )}

            <div className="pt-4 border-t border-border">
              <h4 className="text-sm text-foreground mb-3">Invoices</h4>
              {selectedClient.invoices.length === 0 ? (
                <p className="text-sm text-muted-foreground">No invoices yet for this client.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left px-3 py-2 text-xs text-muted-foreground">Invoice #</th>
                        <th className="text-left px-3 py-2 text-xs text-muted-foreground">Date</th>
                        <th className="text-right px-3 py-2 text-xs text-muted-foreground">Amount</th>
                        <th className="text-right px-3 py-2 text-xs text-muted-foreground">Received</th>
                        <th className="text-right px-3 py-2 text-xs text-muted-foreground">Outstanding</th>
                        <th className="text-left px-3 py-2 text-xs text-muted-foreground">Attachment</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {selectedClient.invoices.map((inv) => {
                        const out = Number(inv.invoice_amount) - Number(inv.amount_received);
                        return (
                          <tr key={inv.id}>
                            <td className="px-3 py-2 text-xs font-mono text-foreground">{inv.invoice_number}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(inv.invoice_date)}</td>
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
                                <span className="text-muted-foreground/70">—</span>
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

            <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-border">
              <Button variant="primary" size="md" className="flex-1" onClick={() => window.print()}>
                <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Print / Save PDF
              </Button>
              {/* Fed the ledger the modal is showing, figure for figure, so the
                  sheet cannot disagree with the screen it came from. */}
              <Button
                variant="secondary"
                size="md"
                disabled={!statementLedger}
                onClick={() => {
                  if (!statementLedger) return;
                  exportClientStatementLedger({
                    clientName: selectedClient.name,
                    clientCode: selectedClient.client_code,
                    periodLabel: statementLedger.scopeLabel,
                    opening: statementLedger.opening,
                    rows: statementLedger.entries.map((e) => ({
                      date: e.date,
                      label: e.label,
                      reference: e.reference,
                      account: e.account,
                      debit: e.debit,
                      credit: e.credit,
                      withholding: e.withholding,
                      balance: e.balance,
                    })),
                    debits: statementLedger.debits,
                    credits: statementLedger.credits,
                    withheld: statementLedger.withheld,
                    closing: statementLedger.closing,
                    fileName: `Client Statement - ${selectedClient.name} - ${statementLedger.scopeLabel}.xlsx`,
                  });
                }}
              >
                <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Export to Excel
              </Button>
              <Button variant="secondary" size="md" onClick={() => setIsStatementModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Record WHT (0423) ──
          Withholding a client deducted, recorded against a receipt that already
          exists. It is not a money movement — the cash that arrived already
          arrived — but it DOES settle the receivable, so the RPC moves the
          receipt and the invoice it paid in one transaction. */}
      <Modal isOpen={isWhtModalOpen} error={error} onDismissError={() => setError(null)} onClose={() => setIsWhtModalOpen(false)} title="Record Withholding Tax" size="md">
        {selectedClient && (
          <form className="space-y-4" onSubmit={handleRecordWht}>
            <div>
              <label className="block text-sm text-foreground mb-1">Client</label>
              <input
                type="text"
                value={`${selectedClient.name} (${selectedClient.client_code})`}
                disabled
                className="w-full px-4 py-2 border border-border rounded-xl text-sm bg-muted/50"
              />
            </div>

            {receiptsForWht.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This client has no recorded receipts yet. Withholding is deducted from a
                payment, so record the payment first — then come back here.
              </p>
            ) : (
              <>
                <div>
                  <label className="block text-sm text-foreground mb-1">Receipt *</label>
                  <ThemedSelect
                    value={whtPaymentId}
                    onChange={(e) => setWhtPaymentId(e.target.value)}
                    className="w-full px-4 py-2 border border-border rounded-xl text-sm"
                  >
                    {receiptsForWht.map((r) => (
                      <option key={r.id} value={r.id}>
                        {formatDate(r.date)} · PKR {Math.round(r.amount).toLocaleString()} · {r.instrument} · {r.against}
                        {r.withholding > 0 ? ` · WHT ${Math.round(r.withholding).toLocaleString()}` : ""}
                      </option>
                    ))}
                  </ThemedSelect>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Newest first. The most recent receipt is selected for you — it is
                    nearly always the one being corrected.
                  </p>
                </div>

                <div>
                  <label className="block text-sm text-foreground mb-1">
                    Withholding Deducted (PKR) *
                  </label>
                  <input
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    value={whtAmount}
                    onChange={(e) => setWhtAmount(e.target.value)}
                    className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                  />
                  <AmountInWords value={whtAmount} />
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    {Number(selectedClient.withholding_tax_rate ?? 0) > 0
                      ? `Prefilled at ${selectedClient.withholding_tax_rate}% of this receipt — edit if the client deducted something else.`
                      : "This client has no agreed withholding rate."}{" "}
                    This REPLACES the withholding on the receipt; enter 0 to clear it.
                  </p>
                </div>

                {selectedWhtReceipt && (
                  <div className="rounded-xl border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
                    <p>
                      Cash received: <strong>PKR {Math.round(selectedWhtReceipt.amount).toLocaleString()}</strong>{" "}
                      via {selectedWhtReceipt.instrument}
                    </p>
                    <p>
                      This receipt will settle{" "}
                      <strong>
                        PKR {Math.round(selectedWhtReceipt.amount + Number(whtAmount || 0)).toLocaleString()}
                      </strong>{" "}
                      of what the client owes — cash plus withholding together.
                    </p>
                    <p className="text-muted-foreground">
                      No bank or cash balance moves: the money that arrived already arrived.
                    </p>
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2">
                  <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
                    {submitting ? "Saving…" : "Record Withholding"}
                  </Button>
                  <Button variant="secondary" size="md" onClick={() => setIsWhtModalOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </form>
        )}
      </Modal>

      <Modal isOpen={isOpeningBalanceOpen} error={error} onDismissError={() => setError(null)} onClose={() => setIsOpeningBalanceOpen(false)} title="Edit Opening Balance" size="md">
        {selectedClient && (
          <form className="space-y-4" onSubmit={handleSaveOpeningBalance}>
            <div>
              <label className="block text-sm text-foreground mb-1">Client</label>
              <input
                type="text"
                value={selectedClient.name}
                disabled
                className="w-full px-4 py-2 border border-border rounded-xl text-sm bg-muted/50"
              />
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Opening Balance (PKR) *</label>
              <input
                required
                type="number"
                min="0"
                step="0.01"
                value={openingBalanceValue}
                onChange={(e) => setOpeningBalanceValue(e.target.value)}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
              />
              <p className="text-xs text-muted-foreground mt-1">
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

      <Modal isOpen={isPaymentModalOpen} error={error} onDismissError={() => setError(null)} onClose={() => setIsPaymentModalOpen(false)} title="Record Payment" size="md">
        {selectedClient && (
          <form className="space-y-4" onSubmit={handleRecordPayment}>
            <div>
              <label className="block text-sm text-foreground mb-1">Client</label>
              <input
                type="text"
                value={selectedClient.name}
                disabled
                className="w-full px-4 py-2 border border-border rounded-xl text-sm bg-muted/50"
              />
            </div>
            {canEditAccounting && (
              <label className="flex items-start gap-2 text-sm text-foreground bg-warning-50 border border-warning-200 rounded p-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={paymentStandalone}
                  onChange={(e) => setPaymentStandalone(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="text-foreground">No specific invoice</span> — apply to client balance
                  (advance / unallocated receipt, or paying down an opening balance).
                </span>
              </label>
            )}
            {!paymentStandalone && (
              <div>
                <label className="block text-sm text-foreground mb-1">Apply to Invoice *</label>
                <ThemedSelect
                  required
                  value={paymentInvoiceId}
                  onChange={(e) => setPaymentInvoiceId(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                >
                  <option value="">Select an open invoice…</option>
                  {selectedClient.invoices
                    .filter((i) => invoiceOutstanding(i) > 0)
                    .map((i) => {
                      const out = invoiceOutstanding(i);
                      return (
                        <option key={i.id} value={i.id}>
                          {i.invoice_number} · {formatDate(i.invoice_date)} · Outstanding PKR {out.toLocaleString()}
                        </option>
                      );
                    })}
                </ThemedSelect>
              </div>
            )}
            <div>
              <label className="block text-sm text-foreground mb-1">Payment Amount (PKR) *</label>
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
              />
              <AmountInWords value={paymentAmount} />
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Payment Date *</label>
              <input
                required
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-foreground mb-2">Received Via *</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {(["Cash", "Bank", "Cheque"] as const).map((v) => (
                  <label
                    key={v}
                    className={`flex items-center justify-center gap-2 px-3 py-2 border rounded-xl cursor-pointer text-sm ${
                      paymentVia === v
                        ? "border-foreground bg-muted/50"
                        : "border-border hover:border-border"
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
              {paymentVia === "Cheque" && (
                <p className="text-[11px] text-warning-700 mt-1.5">
                  Outstanding and bank balance will not change until the cheque is cleared in the Cheques section.
                </p>
              )}
            </div>
            {paymentVia === "Cash" && (
              <div>
                <label className="block text-sm text-foreground mb-1">Received By (Office Staff) *</label>
                <ThemedSelect
                  required
                  value={paymentCustodianId}
                  onChange={(e) => setPaymentCustodianId(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                >
                  <option value="">Select who received the cash…</option>
                  {custodians.map((c) => (
                    <option key={c.employeeId} value={c.employeeId}>
                      {c.fullName} — holds PKR {Math.round(c.held).toLocaleString()}
                    </option>
                  ))}
                </ThemedSelect>
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  This cash will be added to the selected staff member's custody balance.
                </p>
              </div>
            )}
            {(paymentVia === "Bank" || paymentVia === "Cheque") && (
              <div>
                <label className="block text-sm text-foreground mb-1">Bank Account *</label>
                <ThemedSelect
                  required
                  value={paymentBankId}
                  onChange={(e) => setPaymentBankId(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                >
                  <option value="">Select bank account…</option>
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.bank_name} · {b.account_number}
                    </option>
                  ))}
                </ThemedSelect>
              </div>
            )}
            {paymentVia === "Cheque" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-foreground mb-1">Cheque Number *</label>
                  <input
                    required
                    type="text"
                    value={paymentChequeNumber}
                    onChange={(e) => setPaymentChequeNumber(e.target.value)}
                    className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                    placeholder="e.g. 001234"
                  />
                </div>
                <div>
                  <label className="block text-sm text-foreground mb-1">Cheque Date *</label>
                  <input
                    required
                    type="date"
                    value={paymentChequeDate}
                    onChange={(e) => setPaymentChequeDate(e.target.value)}
                    className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
                  />
                </div>
              </div>
            )}
            {/* Withholding is NOT entered here any more — it moved to Record
                WHT (0423). A client frequently names what they deducted days
                after the money lands, and a field that could only be filled at
                the moment of the receipt meant those deductions were never
                recorded at all. */}
            <p className="text-[11px] text-muted-foreground -mt-1">
              Enter the cash that actually arrived. If the client withheld tax, record it
              with <strong>Record WHT</strong> on their row — before or after this receipt,
              it settles the same balance either way.
            </p>
            <div>
              <label className="block text-sm text-foreground mb-1">Notes</label>
              <textarea
                value={paymentNotes}
                onChange={(e) => setPaymentNotes(e.target.value)}
                rows={2}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent"
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

      <Modal isOpen={isEditBankModalOpen} error={error} onDismissError={() => setError(null)} onClose={() => setIsEditBankModalOpen(false)} title="Edit Bank Account" size="md">
        {selectedBank && (
          <form className="space-y-4" onSubmit={handleEditBank}>
            <div>
              <label className="block text-sm text-foreground mb-1">Bank Name</label>
              <input
                required
                type="text"
                value={editBankForm.bank_name}
                onChange={(e) => setEditBankForm({ ...editBankForm, bank_name: e.target.value })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Account Number</label>
              <input
                required
                type="text"
                value={editBankForm.account_number}
                onChange={(e) => setEditBankForm({ ...editBankForm, account_number: e.target.value })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">IBAN</label>
              <input
                type="text"
                maxLength={24}
                value={editBankForm.iban}
                onChange={(e) => setEditBankForm({ ...editBankForm, iban: e.target.value.toUpperCase().replace(/\s+/g, "") })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent font-mono"
                placeholder="PKxx XXXX XXXX XXXX XXXX XXXX"
              />
              {editBankForm.iban && editBankForm.iban.length !== 24 && (
                <p className="text-xs text-warning-700 mt-1">
                  Pakistani IBANs are 24 characters (currently {editBankForm.iban.length}).
                </p>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-foreground mb-1">Branch Code</label>
                <input
                  type="text"
                  value={editBankForm.branch_code}
                  onChange={(e) => setEditBankForm({ ...editBankForm, branch_code: e.target.value })}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm text-foreground mb-1">Branch Name</label>
                <input
                  type="text"
                  value={editBankForm.branch_name}
                  onChange={(e) => setEditBankForm({ ...editBankForm, branch_name: e.target.value })}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-foreground mb-1">SWIFT Code</label>
                <input
                  type="text"
                  value={editBankForm.swift_code}
                  onChange={(e) => setEditBankForm({ ...editBankForm, swift_code: e.target.value.toUpperCase() })}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent font-mono"
                />
              </div>
              <div>
                <label className="block text-sm text-foreground mb-1">Currency</label>
                <ThemedSelect
                  value={editBankForm.currency_code}
                  onChange={(e) => setEditBankForm({ ...editBankForm, currency_code: e.target.value })}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                >
                  <option value="PKR">PKR</option>
                  <option value="USD">USD</option>
                  <option value="AED">AED</option>
                  <option value="GBP">GBP</option>
                  <option value="EUR">EUR</option>
                </ThemedSelect>
              </div>
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Account Type</label>
              <ThemedSelect
                value={editBankForm.account_type}
                onChange={(e) => setEditBankForm({ ...editBankForm, account_type: e.target.value as "Current" | "Savings" })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              >
                <option value="Current">Current</option>
                <option value="Savings">Savings</option>
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">Account For</label>
              <ThemedSelect
                value={editBankForm.owner_type}
                onChange={(e) => setEditBankForm({ ...editBankForm, owner_type: e.target.value as BankAccountOwnerType, owner_partner_id: "", owner_client_id: "" })}
                className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              >
                <option value="company">Company</option>
                <option value="partner">Partner</option>
                <option value="client">Client</option>
              </ThemedSelect>
            </div>
            {editBankForm.owner_type === "partner" && (
              <div>
                <label className="block text-sm text-foreground mb-1">Partner *</label>
                <ThemedSelect
                  required
                  value={editBankForm.owner_partner_id}
                  onChange={(e) => setEditBankForm({ ...editBankForm, owner_partner_id: e.target.value })}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                >
                  <option value="">Select partner…</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </ThemedSelect>
              </div>
            )}
            {editBankForm.owner_type === "client" && (
              <div>
                <label className="block text-sm text-foreground mb-1">Client *</label>
                <ThemedSelect
                  required
                  value={editBankForm.owner_client_id}
                  onChange={(e) => setEditBankForm({ ...editBankForm, owner_client_id: e.target.value })}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                >
                  <option value="">Select client…</option>
                  {receivables.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </ThemedSelect>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Balance reflects actual transactions recorded in the system.
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

      <Modal isOpen={isTransferModalOpen} error={error} onDismissError={() => setError(null)} onClose={() => setIsTransferModalOpen(false)} title="Wire Transfer" size="md">
        <form className="space-y-4" onSubmit={handleTransfer}>
          <div>
            <label className="block text-sm text-foreground mb-1">From Account *</label>
            <ThemedSelect
              required
              value={transferFromId}
              onChange={(e) => setTransferFromId(e.target.value)}
              className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
            >
              <option value="">Select source…</option>
              {banks.map((b) => {
                const ownerLabel = b.owner_type === "company" ? "Company" :
                  b.owner_type === "partner" ? `Partner: ${partners.find((p) => p.id === b.owner_partner_id)?.name ?? "?"}` :
                  `Client: ${receivables.find((c) => c.id === b.owner_client_id)?.name ?? "?"}`;
                return (
                  <option key={b.id} value={b.id}>
                    {b.bank_name} · {b.account_number} ({ownerLabel}){b.balanceHidden ? "" : ` · PKR ${Number(b.balance).toLocaleString()}`}
                  </option>
                );
              })}
            </ThemedSelect>
          </div>
          <div>
            <label className="block text-sm text-foreground mb-1">To Account *</label>
            <ThemedSelect
              required
              value={transferToId}
              onChange={(e) => setTransferToId(e.target.value)}
              className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
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
            </ThemedSelect>
          </div>
          <div>
            <label className="block text-sm text-foreground mb-1">Amount (PKR) *</label>
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              value={transferAmount}
              onChange={(e) => setTransferAmount(e.target.value)}
              className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
              placeholder="0.00"
            />
            <AmountInWords value={transferAmount} />
          </div>
          <div>
            <label className="block text-sm text-foreground mb-1">Transfer Date *</label>
            <input
              required
              type="date"
              value={transferDate}
              onChange={(e) => setTransferDate(e.target.value)}
              className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-foreground mb-1">Notes</label>
            <textarea
              value={transferNotes}
              onChange={(e) => setTransferNotes(e.target.value)}
              rows={2}
              className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
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

      <Modal
        isOpen={!!payableVendorGroup}
        onClose={() => setPayableVendorKey(null)}
        title={payableVendorGroup ? `Payables — ${payableVendorGroup.name}` : "Payables"}
        size="lg"
      >
        {payableVendorGroup && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3 text-xs">
              <span className="px-2.5 py-1 rounded bg-muted text-foreground">{payableVendorGroup.items.length} transaction(s)</span>
              <span className="px-2.5 py-1 rounded bg-danger-50 text-danger-700">Outstanding: PKR {payableVendorGroup.outstanding.toLocaleString()}</span>
              <span className="px-2.5 py-1 rounded bg-success-50 text-success-700">Paid: PKR {payableVendorGroup.paid.toLocaleString()}</span>
              {payableVendorGroup.key !== "no-vendor" && payableVendorGroup.outstanding > 0 && (
                <Button
                  variant="primary"
                  size="sm"
                  className="ml-auto"
                  onClick={() => openPay(payableVendorGroup.key, payableVendorGroup.name, payableVendorGroup.outstanding)}
                >
                  Pay
                </Button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Category</th>
                    <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Client</th>
                    <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Amount Due</th>
                    <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Expense Date</th>
                    <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Due Date</th>
                    <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Status</th>
                    <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {payableVendorGroup.items.map((item) => {
                        const status = payableDisplayStatus(item);
                        const statusClass =
                          status === "Paid"
                            ? "bg-success-50 text-success-700"
                            : status === "Overdue"
                            ? "bg-danger-50 text-danger-700"
                            : "bg-warning-50 text-warning-700";
                        return (
                          <tr key={item.id} className="hover:bg-muted/50 transition-colors">
                            <td className="px-6 py-4 text-sm text-muted-foreground">{item.category?.name ?? "—"}</td>
                            <td className="px-6 py-4 text-sm text-muted-foreground">
                              {item.client?.name ?? <span className="text-muted-foreground/70">Office</span>}
                            </td>
                            <td className="px-6 py-4 text-sm text-danger-600">
                              PKR {Number(item.amount).toLocaleString()}
                              {status !== "Paid" && paidOf(item) > 0 && (
                                <div className="text-[10px] text-muted-foreground mt-1">
                                  Paid PKR {paidOf(item).toLocaleString()} · Remaining PKR {owedOf(item).toLocaleString()}
                                </div>
                              )}
                            </td>
                            <td className="px-6 py-4 text-sm text-muted-foreground">{formatDate(item.expense_date)}</td>
                            <td className="px-6 py-4 text-sm text-muted-foreground">{item.due_date ? formatDate(item.due_date) : "—"}</td>
                            <td className="px-6 py-4">
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full font-semibold text-xs ${statusClass}`}>
                                {status !== "Paid" && paidOf(item) > 0 ? "Partially paid" : status}
                              </span>
                              {status === "Paid" && item.paid_via && (
                                <div className="text-[10px] text-muted-foreground mt-1">
                                  via {item.paid_via}
                                  {item.paid_at ? ` · ${formatDate(item.paid_at)}` : ""}
                                </div>
                              )}
                            </td>
                            <td className="px-6 py-4">
                              {paidByExpense.has(item.id) ? (
                                item.payable_status === "Paid" ? (
                                  // Cleared by vendor payments: undone by reverting the
                                  // payment below, not the bill.
                                  <span className="text-[11px] text-muted-foreground">Vendor payment</span>
                                ) : (
                                  <Button variant="ghost" size="sm" onClick={() => openPay(payableVendorGroup.key, payableVendorGroup.name, owedOf(item), item.id)}>
                                    <CheckCircle2 className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                                    Pay Rest
                                  </Button>
                                )
                              ) : item.payable_status === "Paid" ? (
                                <Button variant="ghost" size="sm" onClick={() => handleRevertToPending(item)}>
                                  <RotateCcw className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                                  Revert
                                </Button>
                              ) : item.vendor_id ? (
                                <Button variant="ghost" size="sm" onClick={() => openPay(payableVendorGroup.key, payableVendorGroup.name, owedOf(item), item.id)}>
                                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                                  Mark Paid
                                </Button>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                </tbody>
              </table>
            </div>
            {(() => {
              const vps = vendorPayments.filter((v) => v.vendor_id === payableVendorGroup.key);
              if (vps.length === 0) return null;
              return (
                <div className="border-t border-border pt-3">
                  <div className="text-sm font-medium text-foreground mb-2">Vendor payments</div>
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left px-6 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Date</th>
                        <th className="text-left px-6 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Amount</th>
                        <th className="text-left px-6 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Paid via</th>
                        <th className="text-left px-6 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {vps.map((v) => (
                        <tr key={v.id}>
                          <td className="px-6 py-2 text-sm text-muted-foreground">{formatDate(v.paid_on)}</td>
                          <td className="px-6 py-2 text-sm text-success-700">PKR {Number(v.amount).toLocaleString()}</td>
                          <td className="px-6 py-2 text-sm text-muted-foreground">
                            {v.paid_via === "Bank"
                              ? `Bank · ${banks.find((b) => b.id === v.paid_bank_account_id)?.bank_name ?? "—"}`
                              : `Cash · ${custodians.find((c) => c.locationId === v.custodian_location_id)?.fullName ?? "custodian"}`}
                          </td>
                          <td className="px-6 py-2">
                            <Button variant="ghost" size="sm" onClick={() => handleRevertVendorPayment(v)}>
                              <RotateCcw className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} />
                              Revert
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!payTarget}
        error={error}
        onDismissError={() => setError(null)}
        onClose={() => setPayTarget(null)}
        title={payTarget ? `Pay ${payTarget.vendorName}` : "Pay vendor"}
        size="md"
      >
        {payTarget && (
          <form className="space-y-4" onSubmit={handlePay}>
            {(() => {
              // The vendor's bank details (0488), to pay them from a banking app.
              const v = payables.find((p) => p.vendor_id === payTarget.vendorId)?.vendor;
              const rows = ([
                ["Bank", v?.bank_name],
                ["Account title", v?.account_title],
                ["Account number", v?.account_number],
                ["Branch code", v?.branch_code],
              ] as [string, string | null | undefined][]).filter(([, val]) => !!val) as [string, string][];
              return (
                <div className="rounded-xl border border-border bg-muted/50 px-4 py-3">
                  <div className="text-xs text-muted-foreground mb-2">Vendor bank details</div>
                  {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None recorded. Add them in Expenses ▸ Manage Vendors.</p>
                  ) : (
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      {rows.map(([label, val]) => (
                        <div key={label} className="min-w-0">
                          <dt className="text-xs text-muted-foreground">{label}</dt>
                          <dd className="flex items-center gap-1.5 text-foreground">
                            <span className={`truncate ${label === "Account number" || label === "Branch code" ? "font-mono" : ""}`}>{val}</span>
                            <button
                              type="button"
                              title={`Copy ${label.toLowerCase()}`}
                              onClick={() => { void navigator.clipboard?.writeText(val); }}
                              className="flex-shrink-0 p-0.5 rounded text-muted-foreground/70 hover:text-foreground hover:bg-border"
                            >
                              <Copy className="w-3.5 h-3.5" strokeWidth={1.5} />
                            </button>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              );
            })()}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-foreground mb-1">Outstanding</label>
                <input
                  type="text"
                  value={`PKR ${payTarget.owed.toLocaleString()}`}
                  disabled
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm bg-muted/50"
                />
              </div>
              <div>
                <label className="block text-sm text-foreground mb-1">Amount Paid *</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  max={payTarget.owed}
                  required
                  autoFocus
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm"
                  placeholder="e.g. 1500"
                />
              </div>
            </div>

            {payPreview.length > 0 && Number(payAmount) > 0 && (
              <div className="border border-border rounded-xl overflow-hidden">
                <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs text-muted-foreground">
                  Clears bills oldest first
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left px-3 py-1.5">Bill date</th>
                      <th className="text-right px-3 py-1.5">Owed</th>
                      <th className="text-right px-3 py-1.5">Paid now</th>
                      <th className="text-right px-3 py-1.5">Remaining</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {payPreview.map((r) => (
                      <tr key={r.bill.id} className={r.take === 0 ? "text-muted-foreground/70" : ""}>
                        <td className="px-3 py-1.5">{formatDate(r.bill.expense_date)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.owed.toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.take.toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {r.remaining === 0 ? <span className="text-success-700">Paid</span> : r.remaining.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div>
              <label className="block text-sm text-foreground mb-2">Pay Via *</label>
              <div className="grid grid-cols-2 gap-2">
                {(["Cash", "Bank"] as const).map((v) => (
                  <label
                    key={v}
                    className={`flex items-center justify-center gap-2 px-3 py-2 border rounded-xl cursor-pointer text-sm ${
                      payVia === v ? "border-foreground bg-muted/50" : "border-border hover:border-border"
                    }`}
                  >
                    <input type="radio" name="pay-via" checked={payVia === v} onChange={() => setPayVia(v)} />
                    <span>{v}</span>
                  </label>
                ))}
              </div>
            </div>
            {payVia === "Cash" && (
              <div>
                <label className="block text-sm text-foreground mb-1">Paid By (Office Staff) *</label>
                <ThemedSelect
                  required
                  value={payCustodianId}
                  onChange={(e) => setPayCustodianId(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                >
                  <option value="">Select who paid the cash…</option>
                  {custodians.map((c) => (
                    <option key={c.employeeId} value={c.employeeId}>
                      {c.fullName} — holds PKR {Math.round(c.held).toLocaleString()}
                    </option>
                  ))}
                </ThemedSelect>
                {(() => {
                  const staff = custodians.find((c) => c.employeeId === payCustodianId);
                  return staff && Number(payAmount) > staff.held ? (
                    <p className="text-[11px] text-warning-700 mt-1.5">
                      This exceeds {staff.fullName}'s held cash (PKR {Math.round(staff.held).toLocaleString()}). You can still proceed.
                    </p>
                  ) : null;
                })()}
              </div>
            )}
            {payVia === "Bank" && (
              <div>
                <label className="block text-sm text-foreground mb-1">Bank Account *</label>
                <ThemedSelect
                  required
                  value={payBankId}
                  onChange={(e) => setPayBankId(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent"
                >
                  <option value="">Select bank account…</option>
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.bank_name} · {b.account_number}{b.balanceHidden ? "" : ` (PKR ${Number(b.balance).toLocaleString()})`}
                    </option>
                  ))}
                </ThemedSelect>
              </div>
            )}
            <div className="flex items-center gap-3 pt-2">
              <Button variant="primary" size="md" className="flex-1" disabled={submitting}>
                {submitting ? "Processing…" : "Confirm Payment"}
              </Button>
              <Button type="button" variant="secondary" size="md" onClick={() => setPayTarget(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* Bank Statement Export Modal */}
      <Modal isOpen={isBankExportOpen} error={error} onDismissError={() => setError(null)} onClose={() => setIsBankExportOpen(false)} title="Export Bank Statement" size="sm">
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-foreground mb-1">Bank Account</label>
            <ThemedSelect
              value={bankExportBankId}
              onChange={(e) => setBankExportBankId(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-xl text-sm"
            >
              <option value="all">All Banks</option>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>{b.bank_name} — {b.account_number}</option>
              ))}
            </ThemedSelect>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-foreground mb-1">From Date</label>
              <input
                type="date"
                value={bankExportFrom}
                onChange={(e) => setBankExportFrom(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-xl text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-foreground mb-1">To Date</label>
              <input
                type="date"
                value={bankExportTo}
                onChange={(e) => setBankExportTo(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-xl text-sm"
              />
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <Button
              variant="primary"
              size="md"
              className="flex-1"
              onClick={() => {
                const bankById = new Map(banks.map((b) => [b.id, b]));
                let txs = transactions;
                if (bankExportBankId !== "all") txs = txs.filter((t) => t.bank_account_id === bankExportBankId);
                if (bankExportFrom) txs = txs.filter((t) => (t.created_at ?? "") >= bankExportFrom);
                if (bankExportTo) txs = txs.filter((t) => (t.created_at ?? "").slice(0, 10) <= bankExportTo);
                const rows: BankStatementRow[] = txs
                  .slice()
                  .sort((a, b) => (a.created_at ?? "") < (b.created_at ?? "") ? -1 : 1)
                  .map((t) => {
                    const bk = t.bank_account_id ? bankById.get(t.bank_account_id) : null;
                    return {
                      date: (t.created_at ?? "").slice(0, 10),
                      kind: kindLabel[t.kind] ?? t.kind,
                      description: t.description,
                      bankName: bk ? `${bk.bank_name} (${bk.account_number})` : "Cash",
                      credit: t.account_delta > 0 ? t.account_delta : 0,
                      debit: t.account_delta < 0 ? -t.account_delta : 0,
                      cashIn: t.cash_delta > 0 ? t.cash_delta : 0,
                      cashOut: t.cash_delta < 0 ? -t.cash_delta : 0,
                    };
                  });
                const bankLabel = bankExportBankId === "all"
                  ? "All Banks"
                  : (() => { const b = bankById.get(bankExportBankId); return b ? `${b.bank_name} (${b.account_number})` : ""; })();
                const dateRange = bankExportFrom || bankExportTo ? `_${bankExportFrom || "start"}_to_${bankExportTo || "end"}` : "";
                exportBankStatement(rows, { fromDate: bankExportFrom || undefined, toDate: bankExportTo || undefined, bankLabel }, `Bank Statement${dateRange}.xlsx`);
                setIsBankExportOpen(false);
              }}
            >
              <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Download Excel
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsBankExportOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
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
          depositRefs={new Set(depositsById.keys())}
          onDownloadSlip={downloadSlipByRef}
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

type TxLedgerEntry = {
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
  depositRefs,
  onDownloadSlip,
}: {
  transactions: BankTransaction[];
  banks: BankAccount[];
  balanceLedger: Map<string, TxLedgerEntry>;
  bankFilter: string;
  setBankFilter: (v: string) => void;
  scope: "all" | "cash" | "account";
  setScope: (s: "all" | "cash" | "account") => void;
  monthFilter: string;
  setMonthFilter: (v: string) => void;
  monthOptions: { key: string; label: string }[];
  onClose: () => void;
  emptyText: string;
  depositRefs?: Set<string>;
  onDownloadSlip?: (referenceId: string) => void;
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
      <div className="flex flex-wrap gap-3 items-center pb-3 border-b border-border">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Account</label>
          <ThemedSelect
            value={bankFilter}
            onChange={(e) => setBankFilter(e.target.value)}
            className="px-3 py-1.5 border border-border rounded-xl bg-card text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          >
            <option value="all">All accounts</option>
            <option value="__cash__">Cash (Treasury)</option>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.bank_name} · {b.account_number}
              </option>
            ))}
          </ThemedSelect>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Month</label>
          <ThemedSelect
            value={monthFilter}
            onChange={(e) => setMonthFilter(e.target.value)}
            className="px-3 py-1.5 border border-border rounded-xl bg-card text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          >
            <option value="all">All</option>
            {monthOptions.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </ThemedSelect>
        </div>
        <div className="flex items-center gap-1">
          {(["all", "cash", "account"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`px-3 py-1.5 rounded-xl text-xs ${
                scope === s
                  ? "bg-foreground text-background font-semibold"
                  : "bg-card text-muted-foreground border border-border hover:bg-muted/50"
              }`}
            >
              {s === "all" ? "All" : s === "cash" ? "Cash only" : "Account only"}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} entr{filtered.length === 1 ? "y" : "ies"}
        </span>
      </div>

      {/* overflow-x on the SAME element as overflow-y, not a nested wrapper:
          the sticky <thead> below positions against its nearest scroll
          container, so introducing a second one detaches the header. */}
      <div className="max-h-[60vh] overflow-auto">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">{emptyText}</p>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border">
                <th className="text-left px-3 py-2 text-xs text-muted-foreground">Date</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground">Kind</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground">Account</th>
                <th className="text-right px-3 py-2 text-xs text-muted-foreground">Δ</th>
                <th className="text-right px-3 py-2 text-xs text-muted-foreground">Before → After</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((t) => {
                const bank = banks.find((b) => b.id === t.bank_account_id);
                const ledger = balanceLedger.get(t.id) ?? {};
                const cd = Number(t.cash_delta);
                const ad = Number(t.account_delta);
                return (
                  <tr key={t.id}>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {t.created_at ? new Date(t.created_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-foreground">{kindLabel[t.kind]}</td>
                    <td className="px-3 py-2 text-xs text-foreground">
                      {bank ? (
                        <>
                          <div className="font-medium text-foreground">{bank.bank_name}</div>
                          <div className="font-mono text-muted-foreground">{bank.account_number}</div>
                          {(bank.branch_name || bank.branch_code) && (
                            <div className="text-muted-foreground/70">
                              {[bank.branch_name, bank.branch_code].filter(Boolean).join(" · ")}
                            </div>
                          )}
                          {cd !== 0 && <div className="text-muted-foreground">↔ Cash</div>}
                        </>
                      ) : cd !== 0 ? "Cash" : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-right font-mono">
                      {ad !== 0 && (
                        <div
                          className={
                            ad > 0 ? "text-success-700" : ad < 0 ? "text-danger-700" : "text-muted-foreground"
                          }
                        >
                          {ad > 0 ? "+" : ""}
                          {ad.toLocaleString()}
                        </div>
                      )}
                      {cd !== 0 && (
                        <div
                          className={
                            cd > 0 ? "text-success-700" : cd < 0 ? "text-danger-700" : "text-muted-foreground"
                          }
                        >
                          {cd > 0 ? "+" : ""}
                          {cd.toLocaleString()}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-right font-mono text-foreground">
                      {ledger.bank && (
                        <div>
                          <span className="text-muted-foreground/70">Bank </span>
                          {ledger.bank.before.toLocaleString()} →{" "}
                          {ledger.bank.after.toLocaleString()}
                        </div>
                      )}
                      {ledger.cash && (
                        <div>
                          <span className="text-muted-foreground/70">Cash </span>
                          {ledger.cash.before.toLocaleString()} →{" "}
                          {ledger.cash.after.toLocaleString()}
                        </div>
                      )}
                      {!ledger.bank && !ledger.cash && <span className="text-muted-foreground/70">—</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <span className="flex-1">{t.description ?? "—"}</span>
                        {t.kind === "deposit" && t.reference_id && onDownloadSlip && depositRefs?.has(t.reference_id) && (
                          <button
                            type="button"
                            title="Download deposit slip"
                            onClick={() => onDownloadSlip(t.reference_id as string)}
                            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <FileText className="w-3.5 h-3.5" strokeWidth={1.5} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center gap-3 pt-4 border-t border-border">
        <Button variant="secondary" size="md" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
