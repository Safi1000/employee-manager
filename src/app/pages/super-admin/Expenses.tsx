import ThemedSelect from "../../components/ThemedSelect";
import CategoryPicker from "../../components/CategoryPicker";
import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Upload, AlertCircle, X, Loader2, Trash2, Download, Pencil } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import MobileCardList from "../../components/MobileCardList";
import ExportButton from "../../components/ExportButton";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import { exportExpenses, exportAdvances } from "../../lib/excel";
import { formatDate } from "../../lib/date";
import { useFocusTarget, useFocusRow, FOCUS_ROW_CLASS } from "../../lib/focus";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip as RTooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { CHART_TT, CHART_GRID, CHART_LEGEND, CHART_ANIM, CHART_COLORS } from "../../lib/chart";
import {
  supabase,
  fetchAllRows,
  EXPENSE_RECEIPTS_BUCKET,
  isHardcodedCategory,
  PREPAID_THRESHOLD,
  type Expense,
  type ExpenseCategory,
  type ExpensePaymentMode,
  type Client,
  type Vendor,
  type BankAccount,
  type Employee,
  type Advance,
  type Cheque,
  type Branch,
} from "../../lib/supabase";
import { useRegion, withRegion } from "../../lib/region";
import { useAuth, hasPermission } from "../../lib/auth";
import { fetchLedgerStart, monthKeysFrom } from "../../lib/monthRange";
import { loadCustodianOptions, ensureCustodianLocation, type CustodianOption } from "../../lib/custodian";

const PIE_COLORS = CHART_COLORS;

type ExpenseRow = Expense & {
  /** 0268: required when payment_mode is Cash. */
  custodian_location_id: string | null;
  category_name: string | null;
  client_name: string | null;
  vendor_name: string | null;
  bank_name: string | null;
  expense_by_name: string | null;
};

type AdvanceRow = Advance & {
  employee_name: string;
  employee_code: string;
  client_name: string | null;
  bank_name: string | null;
};

/**
 * A fixed expense TEMPLATE — what recurs, with no date of its own.
 *
 * Cheque is absent from the mode union on purpose: a cheque expense names one
 * specific pending cheque, which cannot be known months ahead (see 0174).
 */
type FixedPaymentMode = "Cash" | "Bank" | "Payable";

type FixedExpense = {
  id: string;
  company_id: string;
  category_id: string | null;
  pl_category: "cost_of_services" | "operating_expense";
  client_id: string | null;
  branch_id: string | null;
  vendor_id: string | null;
  description: string | null;
  amount: number;
  payment_mode: FixedPaymentMode;
  bank_account_id: string | null;
  /** Default "Paid By" custodian for cash instances raised from this template (0203). */
  custodian_location_id: string | null;
  due_day: number | null;
  notes: string | null;
  start_month: string;
  end_month: string | null;
  is_active: boolean;
  category?: { name: string } | null;
  client?: { name: string } | null;
  vendor?: { name: string } | null;
};

/**
 * One month of one template, raised on the 1st and awaiting a decision.
 *
 * It is a SNAPSHOT: editing it changes only this month, and it is never
 * rewritten from the template afterwards. Until status flips to 'approved' it
 * has no row in `expenses`, so it has cost nothing and shows up in no report.
 */
type FixedInstance = {
  id: string;
  fixed_expense_id: string;
  period_month: string;
  category_id: string | null;
  pl_category: "cost_of_services" | "operating_expense";
  client_id: string | null;
  branch_id: string | null;
  vendor_id: string | null;
  description: string | null;
  amount: number;
  payment_mode: FixedPaymentMode;
  bank_account_id: string | null;
  due_date: string | null;
  notes: string | null;
  status: "pending" | "approved" | "denied";
  expense_id: string | null;
  decision_note: string | null;
  decided_at: string | null;
  category?: { name: string } | null;
  client?: { name: string } | null;
  vendor?: { name: string } | null;
};

type FixedForm = {
  category_id: string;
  pl_category: "cost_of_services" | "operating_expense";
  client_id: string;
  branch_id: string;
  vendor_id: string;
  description: string;
  amount: string;
  payment_mode: FixedPaymentMode;
  bank_account_id: string;
  due_day: string;
  notes: string;
  start_month: string;
  end_month: string;
  is_active: boolean;
  // Default "Paid By" for cash instances raised from this template. A fixed
  // expense is a template, not a payment, so this only prefills the approval —
  // the custodian is stamped on the real expense when the instance is approved.
  paid_by_employee_id: string;
};

const thisMonthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const emptyFixedForm: FixedForm = {
  category_id: "",
  pl_category: "operating_expense",
  client_id: "",
  branch_id: "",
  vendor_id: "",
  description: "",
  amount: "",
  payment_mode: "Bank",
  bank_account_id: "",
  due_day: "1",
  notes: "",
  start_month: thisMonthKey(),
  end_month: "",
  is_active: true,
  paid_by_employee_id: "",
};

const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

type AdvanceForm = {
  client_id: string;
  employee_id: string;
  amount: string;
  advance_date: string;
  payment_mode: "Cash" | "Bank" | "Cheque";
  bank_account_id: string;
  cheque_id: string;
  notes: string;
  // "Paid By" — the office-staff custodian whose held cash the advance came out
  // of. Cash mode only; the same attribution expenses have carried since 0135,
  // without which the money left Cash in Hand against nobody.
  paid_by_employee_id: string;
};

const emptyAdvanceForm: AdvanceForm = {
  client_id: "",
  employee_id: "",
  amount: "",
  advance_date: new Date().toISOString().slice(0, 10),
  payment_mode: "Cash",
  bank_account_id: "",
  cheque_id: "",
  notes: "",
  paid_by_employee_id: "",
};

/** 0347. Inclusive month count between two "YYYY-MM" strings. The same count
 *  the release run derives in SQL — both ends inclusive, so Mar–Mar is 1. */
const prepaidMonths = (start: string, end: string): number => {
  if (!start || !end) return 0;
  const [sy, sm] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  return (ey - sy) * 12 + (em - sm) + 1;
};

/** 0356. First and last day of the month containing an ISO date. The service
 *  period defaults to these, so a bill covering exactly one month is one click
 *  rather than two date pickers. */
const monthBounds = (isoDate: string): [string, string] => {
  const [y, m] = isoDate.slice(0, 7).split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${isoDate.slice(0, 7)}-01`, `${isoDate.slice(0, 7)}-${String(last).padStart(2, "0")}`];
};

/** 0356. The same day-weighted split release_prepaid_expenses performs in SQL:
 *  each month takes the days of the period falling inside it over the total
 *  days, and the LAST month takes the remainder so the schedule sums exactly.
 *  Shown in the form so the operator sees the months before committing. It
 *  POSTS NOTHING — release_prepaid_expenses is the authority and 0356 probes
 *  it; scripts/check-service-split.mjs checks this preview against the same
 *  arithmetic, because it already got a timezone wrong once. */
const serviceSplit = (start: string, end: string, amount: number) => {
  if (!start || !end || end < start) return [];
  // LOCAL DATES ON BOTH SIDES. new Date("2026-03-31") is parsed as UTC while
  // new Date(y, m, 0) is local, and in any positive-offset zone — Pakistan is
  // UTC+5 — the month end then compares as EARLIER than the period end. The
  // final-month branch never fired and the schedule came up a rupee short.
  const at = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
  const s = at(start), e = at(end);
  const total = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  if (total <= 0) return [];
  const out: { key: string; days: number; amount: number }[] = [];
  let cur = new Date(s.getFullYear(), s.getMonth(), 1);
  let done = 0;
  while (cur <= e) {
    const mEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const from = cur > s ? cur : s;
    const to = mEnd < e ? mEnd : e;
    const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    const raw = mEnd >= e ? amount - done : (amount * days) / total;
    const amt = Math.round(raw * 100) / 100;
    done += amt;
    out.push({ key: `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`, days, amount: amt });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return out;
};

type ExpenseForm = {
  category_id: string;
  pl_category: "cost_of_services" | "operating_expense";
  client_id: string;
  branch_id: string;
  vendor_id: string;
  description: string;
  amount: string;
  expense_date: string;
  payment_mode: ExpensePaymentMode;
  bank_account_id: string;
  cheque_id: string;
  due_date: string;
  notes: string;
  expense_by: string;
  /**
   * 0347. Prepaid coverage, held as "YYYY-MM" because the decision is MONTHS,
   * not a count — a licence running 14 March to 13 March is 13 touched months
   * and "12" would be wrong at both ends. Empty = not amortised.
   */
  coverage_start: string;
  coverage_end: string;
  /**
   * 0356. Service period, held as full ISO DATES because the split is weighted
   * by DAYS — a bill running 15 Aug to 15 Sep belongs to both months in the
   * proportion of days it spent in each, and truncating to months would put
   * half of September into August. Mutually exclusive with coverage_* by
   * constraint (expenses_one_spreading_mechanism); the form makes it a radio so
   * the invalid pair cannot be typed rather than being refused on submit.
   */
  service_start: string;
  service_end: string;
  receipts?: File[];
};

/** 0401. One row of prepaid_schedule() — a deferred expense and where its
 *  release has got to. Every figure here is COMPUTED BY THE LEDGER: released is
 *  a sum over journal_lines and months_released is counted from the entries
 *  that actually posted, not from the calendar. A screen that recomputed either
 *  would be able to disagree with the trial balance beside it. */
type DeferredRow = {
  expense_id: string;
  expense_date: string;
  description: string | null;
  category_name: string | null;
  shape: "prepaid" | "service_period";
  period_start: string;
  period_end: string;
  amount: number;
  released: number;
  remaining: number;
  months_total: number;
  months_released: number;
  final_month: string;
  is_stale: boolean;
};

const emptyForm: ExpenseForm = {
  category_id: "",
  pl_category: "operating_expense",
  client_id: "",
  branch_id: "",
  vendor_id: "",
  description: "",
  amount: "",
  expense_date: new Date().toISOString().slice(0, 10),
  payment_mode: "Cash",
  bank_account_id: "",
  cheque_id: "",
  due_date: "",
  notes: "",
  expense_by: "",
  coverage_start: "",
  coverage_end: "",
  service_start: "",
  service_end: "",
};

export default function Expenses() {
  const { profile, company } = useAuth();
  // Add / edit expenses & advances — gated on expenses.edit (super_admin + SSA
  // implicit). Backend RLS (0310) enforces it; this hides the controls.
  const canEditExpenses = hasPermission(profile, "expenses.edit");
  // 0346. Approving is a REVIEW and it LOCKS the expense: the database refuses
  // any later edit or delete. The same permission lifts the lock again, because
  // a lock nobody can open is not a control. A permission, never a role
  // literal — asking the role instead was the cause of three defects this week.
  const canApproveExpenses = hasPermission(profile, "expenses.approve");
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

  const { regionId } = useRegion();
  const [activeTab, setActiveTab] = useState<"expenses" | "fixed" | "advances" | "deferred">("expenses");
  // 0401. "What is sitting in prepaid and when does it clear" is a LIST
  // question, not a fact about one expense, so it gets a tab rather than a
  // section on a detail screen. The 1160 balance belongs in the financial
  // reports; the schedule is operational and belongs where expenses are entered.
  const [deferred, setDeferred] = useState<DeferredRow[]>([]);
  const [deferredErr, setDeferredErr] = useState<string | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [advances, setAdvances] = useState<AdvanceRow[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [cheques, setCheques] = useState<Cheque[]>([]);
  const [chequeLinkedSums, setChequeLinkedSums] = useState<Map<string, number>>(new Map());
  const [formError, setFormError] = useState<string | null>(null);

  // Remaining capacity for a cheque, optionally excluding a row currently being edited.
  const chequeRemaining = (chequeId: string, excludeOwnAmount: number = 0): number => {
    const c = cheques.find((x) => x.id === chequeId);
    if (!c) return 0;
    const used = chequeLinkedSums.get(chequeId) ?? 0;
    return Number(c.amount) - used + excludeOwnAmount;
  };
  const [branches, setBranches] = useState<Branch[]>([]);
  const [advBranchFilter, setAdvBranchFilter] = useState("all");
  const [cashBalance, setCashBalance] = useState(0);
  // Office-staff custodians + their held cash — for attributing cash expenses (0135).
  const [custodians, setCustodians] = useState<CustodianOption[]>([]);
  // employeeId → their custodian cash_location id. The "Paid By" filters compare
  // against the stored custodian_location_id, which is what the row actually holds.
  const custodianLocationById = useMemo(
    () => new Map(custodians.filter((c) => c.locationId).map((c) => [c.employeeId, c.locationId!])),
    [custodians],
  );
  const custodianNameByLocation = useMemo(
    () => new Map(custodians.filter((c) => c.locationId).map((c) => [c.locationId!, c.fullName])),
    [custodians],
  );
  const [expenseCustodianId, setExpenseCustodianId] = useState<string>("");
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
  const [advModeFilter, setAdvModeFilter] = useState<"all" | "Cash" | "Bank" | "Cheque">("all");
  // "Paid By" filters — which office-staff custodian's cash the money came from.
  const [advPaidByFilter, setAdvPaidByFilter] = useState<"all" | "none" | string>("all");
  const [fixedPaidByFilter, setFixedPaidByFilter] = useState<"all" | "none" | string>("all");

  const currentMonthKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [clientFilter, setClientFilter] = useState<"all" | "office" | string>("all");
  const [modeFilter, setModeFilter] = useState<"all" | ExpensePaymentMode>("all");
  // "Expense By" — narrows the list (and the category totals / pie above it) to
  // one office-staff member, so spend can be read person by person.
  const [expenseByFilter, setExpenseByFilter] = useState<"all" | "none" | string>("all");
  const [monthFilter, setMonthFilter] = useState<string>(currentMonthKey());
  const [advMonthFilter, setAdvMonthFilter] = useState<string>(currentMonthKey());

  // --- Drill-down from the Journal ----------------------------------------
  //
  // Arriving with ?focus=<id>&focusType=expenses|advances must OPEN that
  // record, not merely land here. Scrolling alone is not enough: the month
  // filter defaults to the current month, so a September link to a June
  // expense would scroll to a row that is not rendered. Every filter that
  // could hide the row is widened first, then the row is scrolled to and
  // marked.
  const focusExpense = useFocusTarget("expenses");
  const focusAdvance = useFocusTarget("advances");
  const focusExpenseRow = useFocusRow(focusExpense);
  const focusAdvanceRow = useFocusRow(focusAdvance);

  useEffect(() => {
    if (focusExpense) {
      setActiveTab("expenses");
      setMonthFilter("all");
      setCategoryFilter("all");
      setClientFilter("all");
      setModeFilter("all");
      setExpenseByFilter("all");
      setSearch("");
    } else if (focusAdvance) {
      setActiveTab("advances");
      setAdvMonthFilter("all");
      setAdvClientFilter("all");
      setAdvModeFilter("all");
      setAdvPaidByFilter("all");
      setAdvBranchFilter("all");
      setAdvSearch("");
    }
  }, [focusExpense, focusAdvance]);

  // Said plainly when the record is not here, rather than leaving the operator
  // on a list that looks like the link worked.
  const focusMissing =
    !loading &&
    ((focusExpense && !expenses.some((e) => e.id === focusExpense)) ||
      (focusAdvance && !advances.some((a) => a.id === focusAdvance)));

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isViewOpen, setIsViewOpen] = useState(false);
  const [selected, setSelected] = useState<ExpenseRow | null>(null);
  const [viewReceipts, setViewReceipts] = useState<{ id: string; drive_file_id: string | null; drive_view_url: string | null; file_name: string | null }[]>([]);

  const [form, setForm] = useState<ExpenseForm>(emptyForm);
  const [editForm, setEditForm] = useState<ExpenseForm>(emptyForm);
  const [replaceReceipt, setReplaceReceipt] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [isCatModalOpen, setIsCatModalOpen] = useState(false);
  const [catMode, setCatMode] = useState<"add" | "edit">("add");
  const [catInput, setCatInput] = useState("");
  const [catEditingId, setCatEditingId] = useState<string | null>(null);

  // ----- Fixed (recurring monthly) expenses -----
  const [fixedExpenses, setFixedExpenses] = useState<FixedExpense[]>([]);
  const [fixedInstances, setFixedInstances] = useState<FixedInstance[]>([]);
  const [fixedMonth, setFixedMonth] = useState<string>(thisMonthKey());
  const [isFixedFormOpen, setIsFixedFormOpen] = useState(false);
  const [fixedEditingId, setFixedEditingId] = useState<string | null>(null);
  const [fixedForm, setFixedForm] = useState<FixedForm>(emptyFixedForm);
  const [fixedSubmitting, setFixedSubmitting] = useState(false);
  const [fixedError, setFixedError] = useState<string | null>(null);
  // The instance being approved / denied / edited, and the custodian who paid
  // it (Cash only — the same attribution a normal cash expense requires).
  const [decisionTarget, setDecisionTarget] = useState<{ row: FixedInstance; action: "approve" | "deny" } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [decisionCustodianId, setDecisionCustodianId] = useState("");
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [instanceEditing, setInstanceEditing] = useState<FixedInstance | null>(null);
  const [instanceForm, setInstanceForm] = useState({ amount: "", description: "", notes: "", due_date: "" });

  const fixedMonthOptions = useMemo(() => {
    const opts: string[] = [];
    const d = new Date();
    d.setDate(1);
    // Six months ahead as well as twelve back: a template can be set up before
    // its start month, and its future instances should be inspectable.
    d.setMonth(d.getMonth() + 6);
    for (let i = 0; i < 18; i += 1) {
      opts.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      d.setMonth(d.getMonth() - 1);
    }
    return opts;
  }, []);

  const [isVendorModalOpen, setIsVendorModalOpen] = useState(false);
  const [vendorMode, setVendorMode] = useState<"add" | "edit">("add");
  const [vendorName, setVendorName] = useState("");
  const [vendorAccountNumber, setVendorAccountNumber] = useState("");
  const [vendorEditingId, setVendorEditingId] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    const [catRes, cliRes, venRes, bankRes, treaRes, empRes, chqRes, brRes] = await Promise.all([
      supabase.from("expense_categories").select("*").order("name"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("vendors").select("*").order("name"),
      supabase.from("bank_accounts").select("*").order("bank_name"),
      supabase.from("treasury").select("*").eq("company_id", treasuryCompanyId ?? "00000000-0000-0000-0000-000000000000").maybeSingle(),
      supabase.from("employees").select("*").order("employee_code"),
      supabase.from("cheques").select("*").order("cheque_date", { ascending: false }),
      supabase.from("branches").select("*").order("is_head_office", { ascending: false }).order("name"),
    ]);
    if (catRes.error) setError(catRes.error.message);

    // 0401. Its own call and its own error: the schedule is the one thing here
    // that depends on a migration the rest of the screen does not, and a
    // failure to read it must not blank the expense list.
    if (treasuryCompanyId) {
      const { data: schedData, error: schedErr } = await supabase.rpc("prepaid_schedule", {
        p_company_id: treasuryCompanyId,
      });
      setDeferredErr(schedErr?.message ?? null);
      setDeferred(((schedData ?? []) as DeferredRow[]).map((d) => ({
        ...d,
        amount: Number(d.amount),
        released: Number(d.released),
        remaining: Number(d.remaining),
      })));
    }
    // Paginate the two potentially-large tables so we never silently miss rows.
    let expData: any[] = [];
    let advData: any[] = [];
    try {
      [expData, advData] = await Promise.all([
        fetchAllRows<any>(() =>
          withRegion(
            supabase
              .from("expenses")
              .select("*, category:category_id(name), client:client_id(name), vendor:vendor_id(name), bank:bank_account_id(bank_name), expense_by_emp:expense_by(full_name)")
              .order("expense_date", { ascending: false })
              .order("created_at", { ascending: false }),
            regionId,
          ) as unknown as {
            range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
          },
        ),
        fetchAllRows<any>(() =>
          withRegion(
            supabase
              .from("advances")
              .select("*, employee:employee_id(full_name, employee_code), client:client_id(name), bank:bank_account_id(bank_name)")
              .order("advance_date", { ascending: false })
              .order("created_at", { ascending: false }),
            regionId,
          ) as unknown as {
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
        expense_by_name: e.expense_by_emp?.full_name ?? null,
      }))
    );
    setCategories((catRes.data ?? []) as ExpenseCategory[]);
    setClients((cliRes.data ?? []) as Client[]);
    setVendors((venRes.data ?? []) as Vendor[]);
    setBanks((bankRes.data ?? []) as BankAccount[]);
    setCheques((chqRes.data ?? []) as Cheque[]);
    setBranches((brRes.data ?? []) as Branch[]);
    await loadFixedTemplates();

    // Aggregate linked sums per cheque (across payslips/expenses/advances/invoice_payments).
    const [linkedPs, linkedEx, linkedAdv, linkedIp] = await Promise.all([
      supabase.from("payslips").select("cheque_id, net_salary").not("cheque_id", "is", null),
      supabase.from("expenses").select("id, cheque_id, amount").not("cheque_id", "is", null),
      supabase.from("advances").select("id, cheque_id, amount").not("cheque_id", "is", null),
      supabase.from("invoice_payments").select("cheque_id, amount").not("cheque_id", "is", null),
    ]);
    const linked = new Map<string, number>();
    for (const r of (linkedPs.data ?? []) as { cheque_id: string; net_salary: number }[]) {
      if (r.cheque_id) linked.set(r.cheque_id, (linked.get(r.cheque_id) ?? 0) + Number(r.net_salary));
    }
    for (const r of (linkedEx.data ?? []) as { cheque_id: string; amount: number }[]) {
      if (r.cheque_id) linked.set(r.cheque_id, (linked.get(r.cheque_id) ?? 0) + Number(r.amount));
    }
    for (const r of (linkedAdv.data ?? []) as { cheque_id: string; amount: number }[]) {
      if (r.cheque_id) linked.set(r.cheque_id, (linked.get(r.cheque_id) ?? 0) + Number(r.amount));
    }
    for (const r of (linkedIp.data ?? []) as { cheque_id: string; amount: number }[]) {
      if (r.cheque_id) linked.set(r.cheque_id, (linked.get(r.cheque_id) ?? 0) + Number(r.amount));
    }
    setChequeLinkedSums(linked);
    setCashBalance(Number(treaRes.data?.cash_balance ?? 0));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId]);

  const clientBranchMap = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const c of clients) m.set(c.id, c.branch_id);
    return m;
  }, [clients]);
  const headOfficeBranchId = useMemo(
    () => branches.find((b) => b.is_head_office)?.id ?? null,
    [branches]
  );
  const employeeBranchMap = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const e of employees) m.set(e.id, e.branch_id ?? null);
    return m;
  }, [employees]);
  // All office staff — the "Expense By" options (who the expense was incurred by).
  const officeStaff = useMemo(
    () => employees.filter((e) => e.category === "office_staff").sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [employees],
  );

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
      if (advPaidByFilter !== "all") {
        const locId = a.custodian_location_id ?? null;
        if (advPaidByFilter === "none") {
          if (locId) return false;
        } else if (locId !== custodianLocationById.get(advPaidByFilter)) return false;
      }
      if (advBranchFilter !== "all") {
        // Advances belong to a branch via the employee (always present). Fall back
        // to the client's branch, then Head Office for legacy rows.
        const empBranch = employeeBranchMap.get(a.employee_id) ?? null;
        const cliBranch = a.client_id ? clientBranchMap.get(a.client_id) ?? null : null;
        const effective = empBranch ?? cliBranch ?? headOfficeBranchId;
        if (effective !== advBranchFilter) return false;
      }
      return true;
    });
  }, [advances, advSearch, advMonthFilter, advClientFilter, advModeFilter, advPaidByFilter, custodianLocationById, advBranchFilter, clientBranchMap, employeeBranchMap, headOfficeBranchId]);

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
      if (expenseByFilter === "none" && e.expense_by) return false;
      if (expenseByFilter !== "all" && expenseByFilter !== "none" && e.expense_by !== expenseByFilter) return false;
      return true;
    });
  }, [expenses, search, monthFilter, categoryFilter, clientFilter, modeFilter, expenseByFilter]);

  // Last 18 months of options + "All" for the month select.
  // Bounded by the ledger's own start, not by a fixed count of months back
  // from today. See src/app/lib/monthRange.ts.
  const [ledgerStart, setLedgerStart] = useState<string | null>(null);
  useEffect(() => { fetchLedgerStart().then(setLedgerStart); }, []);
  const monthOptions = useMemo(() => monthKeysFrom(ledgerStart), [ledgerStart]);

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

  // ---------------------------------------------------------------------
  // Fixed (recurring monthly) expenses
  // ---------------------------------------------------------------------
  const loadFixedTemplates = async () => {
    // Region-scoped like every other list on this page: a fixed expense carries
    // branch_id, so the global region selector must narrow it the same way it
    // narrows the expenses it will eventually become.
    const { data, error: err } = await withRegion(
      supabase
        .from("fixed_expenses")
        .select("*, category:category_id(name), client:client_id(name), vendor:vendor_id(name)")
        .order("created_at", { ascending: false }),
      regionId,
    );
    if (err) {
      setError(err.message);
      return;
    }
    setFixedExpenses((data ?? []) as FixedExpense[]);
  };

  // Raising the month's instances before reading them is what makes them
  // "appear on the 1st" without depending on anyone being logged in that day.
  // generate_fixed_expense_instances is idempotent, so calling it on every
  // month change is free — it inserts only what is genuinely missing, and a
  // cron run that already fired simply leaves nothing to do.
  const loadFixedInstances = async (monthKey: string) => {
    const period = `${monthKey}-01`;
    const { error: genErr } = await supabase.rpc("generate_fixed_expense_instances", { p_month: period });
    if (genErr) setError(genErr.message);
    const { data, error: err } = await withRegion(
      supabase
        .from("fixed_expense_instances")
        .select("*, category:category_id(name), client:client_id(name), vendor:vendor_id(name)")
        .eq("period_month", period)
        .order("created_at", { ascending: true }),
      regionId,
    );
    if (err) {
      setError(err.message);
      return;
    }
    setFixedInstances((data ?? []) as FixedInstance[]);
  };

  useEffect(() => {
    loadFixedInstances(fixedMonth);
    // Templates drive generation, so a newly added one must be able to raise
    // its instance immediately rather than waiting for the next page load.
    // regionId is here because the list is region-scoped — switching region has
    // to re-narrow the raised entries, not just the templates above them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedMonth, fixedExpenses.length, regionId]);

  const openFixedAdd = () => {
    setFixedEditingId(null);
    setFixedForm({ ...emptyFixedForm, start_month: fixedMonth });
    setFixedError(null);
    setIsFixedFormOpen(true);
  };

  const openFixedEdit = (f: FixedExpense) => {
    setFixedEditingId(f.id);
    setFixedForm({
      category_id: f.category_id ?? "",
      pl_category: f.pl_category,
      client_id: f.client_id ?? "",
      branch_id: f.branch_id ?? "",
      vendor_id: f.vendor_id ?? "",
      description: f.description ?? "",
      amount: String(f.amount),
      payment_mode: f.payment_mode,
      bank_account_id: f.bank_account_id ?? "",
      due_day: String(f.due_day ?? 1),
      notes: f.notes ?? "",
      start_month: f.start_month.slice(0, 7),
      end_month: f.end_month ? f.end_month.slice(0, 7) : "",
      is_active: f.is_active,
      paid_by_employee_id:
        custodians.find((c) => c.locationId && c.locationId === f.custodian_location_id)?.employeeId ?? "",
    });
    setFixedError(null);
    setIsFixedFormOpen(true);
  };

  const handleSaveFixed = async (e: React.FormEvent) => {
    e.preventDefault();
    setFixedError(null);
    const amount = Number(fixedForm.amount);
    if (!fixedForm.category_id || !amount || amount <= 0) {
      setFixedError("Pick a category and enter an amount above zero.");
      return;
    }
    if (fixedForm.payment_mode === "Bank" && !fixedForm.bank_account_id) {
      setFixedError("Select a bank account for Bank payment.");
      return;
    }
    if (fixedForm.payment_mode === "Payable" && !fixedForm.vendor_id) {
      setFixedError("Select a vendor for a Payable. Add one via Manage Vendors.");
      return;
    }
    if (fixedForm.end_month && fixedForm.end_month < fixedForm.start_month) {
      setFixedError("The end month cannot be before the start month.");
      return;
    }
    setFixedSubmitting(true);
    try {
      const resolvedBranch =
        fixedForm.branch_id ||
        (fixedForm.client_id ? clients.find((c) => c.id === fixedForm.client_id)?.branch_id ?? null : null) ||
        headOfficeBranchId ||
        null;
      // Resolve the default custodian now so the monthly approval can prefill it.
      let fixedCustodianLocId: string | null = null;
      if (fixedForm.payment_mode === "Cash" && fixedForm.paid_by_employee_id) {
        const cid = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
        const staff = custodians.find((c) => c.employeeId === fixedForm.paid_by_employee_id);
        if (cid && staff) fixedCustodianLocId = await ensureCustodianLocation(cid, staff.employeeId, staff.fullName, staff.kind);
      }
      const payload = {
        category_id: fixedForm.category_id,
        // Locked: always derived from the client, never a manual choice.
        pl_category: (fixedForm.client_id ? "cost_of_services" : "operating_expense") as FixedForm["pl_category"],
        client_id: fixedForm.client_id || null,
        branch_id: resolvedBranch,
        vendor_id: fixedForm.payment_mode === "Payable" ? fixedForm.vendor_id || null : null,
        description: fixedForm.description.trim() || null,
        amount,
        payment_mode: fixedForm.payment_mode,
        bank_account_id: fixedForm.payment_mode === "Bank" ? fixedForm.bank_account_id : null,
        due_day: fixedForm.payment_mode === "Payable" ? Number(fixedForm.due_day) || 1 : null,
        notes: fixedForm.notes.trim() || null,
        start_month: `${fixedForm.start_month}-01`,
        end_month: fixedForm.end_month ? `${fixedForm.end_month}-01` : null,
        is_active: fixedForm.is_active,
        custodian_location_id: fixedCustodianLocId,
      };
      if (fixedEditingId) {
        const { error: upErr } = await supabase.from("fixed_expenses").update(payload).eq("id", fixedEditingId);
        if (upErr) throw upErr;
      } else {
        const { error: insErr } = await supabase.from("fixed_expenses").insert(payload);
        if (insErr) throw insErr;
      }
      setIsFixedFormOpen(false);
      await loadFixedTemplates();
      await loadFixedInstances(fixedMonth);
    } catch (err: any) {
      setFixedError(err.message ?? String(err));
    } finally {
      setFixedSubmitting(false);
    }
  };

  // Deactivating stops FUTURE months being raised. Instances already raised —
  // and anything already approved — are left exactly as they are, because they
  // are a record of what happened, not a projection.
  const toggleFixedActive = async (f: FixedExpense) => {
    const { error: upErr } = await supabase
      .from("fixed_expenses")
      .update({ is_active: !f.is_active })
      .eq("id", f.id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    await loadFixedTemplates();
  };

  const handleDeleteFixed = async (f: FixedExpense) => {
    const approved = fixedInstances.filter((i) => i.fixed_expense_id === f.id && i.status === "approved").length;
    const warn = approved
      ? `\n\n${approved} approved month${approved === 1 ? "" : "s"} in view will lose the link back to this template. The expenses themselves stay.`
      : "";
    if (!window.confirm(`Delete the fixed expense "${f.description || f.category?.name || "Untitled"}"?${warn}\n\nStopping it instead (Deactivate) keeps the history intact.`)) return;
    const { error: delErr } = await supabase.from("fixed_expenses").delete().eq("id", f.id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await loadFixedTemplates();
    await loadFixedInstances(fixedMonth);
  };

  const openInstanceEdit = (row: FixedInstance) => {
    setInstanceEditing(row);
    setInstanceForm({
      amount: String(row.amount),
      description: row.description ?? "",
      notes: row.notes ?? "",
      due_date: row.due_date ?? "",
    });
  };

  const handleSaveInstance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!instanceEditing) return;
    const amount = Number(instanceForm.amount);
    if (!amount || amount <= 0) {
      setError("Enter an amount above zero.");
      return;
    }
    const { error: upErr } = await supabase
      .from("fixed_expense_instances")
      .update({
        amount,
        description: instanceForm.description.trim() || null,
        notes: instanceForm.notes.trim() || null,
        due_date: instanceEditing.payment_mode === "Payable" ? instanceForm.due_date || null : null,
      })
      .eq("id", instanceEditing.id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setInstanceEditing(null);
    await loadFixedInstances(fixedMonth);
  };

  const openDecision = (row: FixedInstance, action: "approve" | "deny") => {
    setDecisionTarget({ row, action });
    setDecisionNote("");
    // Prefill "Paid By" from the template's default payer — still changeable,
    // since the person who actually pays can differ in any given month.
    const template = fixedExpenses.find((f) => f.id === row.fixed_expense_id);
    const defaultLoc = template?.custodian_location_id ?? null;
    setDecisionCustodianId(
      custodians.find((c) => c.locationId && c.locationId === defaultLoc)?.employeeId ?? "",
    );
    setFixedError(null);
  };

  /**
   * Approval is where a fixed expense becomes real money.
   *
   * It deliberately walks the SAME path handleAdd does — insert the expense,
   * move cash or the bank balance, write the bank_transactions line — rather
   * than a shortcut of its own. An approved fixed expense and a hand-typed one
   * must be indistinguishable everywhere downstream (P&L, Cash Flow, client
   * statements), and the only way to guarantee that is to build it identically.
   *
   * The instance is stamped LAST. If anything above fails, nothing is marked
   * approved and the row stays pending for another attempt — the alternative
   * (stamp first) could leave an approved month with no expense behind it.
   */
  const handleDecision = async () => {
    if (!decisionTarget) return;
    const { row, action } = decisionTarget;
    setDecisionBusy(true);
    setFixedError(null);
    try {
      if (action === "deny") {
        const { error: upErr } = await supabase
          .from("fixed_expense_instances")
          .update({
            status: "denied",
            decision_note: decisionNote.trim() || null,
            decided_by: profile?.id ?? null,
            decided_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        if (upErr) throw upErr;
      } else {
        const amount = Number(row.amount);
        // Company-wide treasury block removed with the one on the add form —
        // approving a fixed expense creates an ordinary expense, and a
        // custodian may be overdrawn by design.
        if (row.payment_mode === "Cash" && !decisionCustodianId) {
          throw new Error("Select the office-staff member who paid the cash.");
        }
        if (row.payment_mode === "Bank") {
          if (!row.bank_account_id) throw new Error("This fixed expense has no bank account set. Edit it first.");
          const bank = banks.find((b) => b.id === row.bank_account_id);
          if (bank && amount > Number(bank.balance)) throw new Error("Selected bank balance is insufficient.");
        }

        let custodianLocId: string | null = null;
        if (row.payment_mode === "Cash") {
          custodianLocId = await requireCustodianLoc(decisionCustodianId, "paid this cash");
        }

        // Dated to the 1st of the month it belongs to, not the day it happened
        // to be approved: a February rent approved on the 6th is February's.
        //
        // 0364, same as the Add form: one call, one transaction. pl_category IS
        // sent here — it comes off the fixed_expenses definition and may
        // legitimately differ from "does this name a client", so the function
        // takes the caller's word rather than overruling it.
        const { data: newId, error: insErr } = await supabase.rpc("record_expense", {
          p_category_id: row.category_id,
          p_amount: amount,
          p_expense_date: row.period_month,
          p_payment_mode: row.payment_mode,
          p_client_id: row.client_id,
          p_branch_id: row.branch_id,
          p_vendor_id: row.payment_mode === "Payable" ? row.vendor_id : null,
          p_description: row.description,
          p_custodian_location_id: custodianLocId,
          p_bank_account_id: row.payment_mode === "Bank" ? row.bank_account_id : null,
          p_due_date: row.payment_mode === "Payable" ? row.due_date : null,
          p_notes: row.notes,
          p_pl_category: row.pl_category,
        });
        if (insErr) throw insErr;
        const expId = newId as string;

        const { error: upErr } = await supabase
          .from("fixed_expense_instances")
          .update({
            status: "approved",
            expense_id: expId,
            decision_note: decisionNote.trim() || null,
            decided_by: profile?.id ?? null,
            decided_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        if (upErr) throw upErr;
      }
      setDecisionTarget(null);
      await Promise.all([loadFixedInstances(fixedMonth), loadAll()]);
    } catch (err: any) {
      setFixedError(err.message ?? String(err));
    } finally {
      setDecisionBusy(false);
    }
  };

  // Reopening a denial is safe: a denied instance never created an expense, so
  // there is no ledger entry to unwind. Approvals are NOT reversible here —
  // undoing one means deleting a real expense, which is what the Expenses tab
  // is for, and doing it silently from a list would leave the cash unrestored.
  const reopenInstance = async (row: FixedInstance) => {
    const { error: upErr } = await supabase
      .from("fixed_expense_instances")
      .update({ status: "pending", decision_note: null, decided_by: null, decided_at: null })
      .eq("id", row.id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    await loadFixedInstances(fixedMonth);
  };

  // Templates narrowed by their default payer.
  const filteredFixedExpenses = useMemo(() => {
    if (fixedPaidByFilter === "all") return fixedExpenses;
    return fixedExpenses.filter((f) => {
      const locId = f.custodian_location_id ?? null;
      if (fixedPaidByFilter === "none") return !locId;
      return locId === custodianLocationById.get(fixedPaidByFilter);
    });
  }, [fixedExpenses, fixedPaidByFilter, custodianLocationById]);

  const fixedTotals = useMemo(() => {
    let pending = 0, approved = 0, denied = 0;
    for (const i of fixedInstances) {
      const amt = Number(i.amount);
      if (i.status === "pending") pending += amt;
      else if (i.status === "approved") approved += amt;
      else denied += amt;
    }
    return { pending, approved, denied, count: fixedInstances.length };
  }, [fixedInstances]);

  // 0380/0381. applyCashDelta, applyBankDelta and logExpenseTransaction are
  // GONE. Every one of them moved money in its own round trip, outside any
  // transaction, and read-then-wrote a balance it had already released the
  // lock on. apply_money_delta() in the database does the arithmetic under the
  // row lock, asserts its own row count, and is only ever reached from inside
  // the transaction that carries the row the money belongs to.
  //
  // Nothing in this screen moves a balance any more. If something here needs
  // to, it needs an RPC, not a helper.

  // Receipts now upload to Google Drive (under <Company>/Expenses/<year>/).
  // Returns the triple we persist on the expenses row. Legacy rows still
  // carry receipt_path on Supabase Storage and the rest of the file falls
  // back to that whenever drive_file_id is null.
  const uploadReceiptToDrive = async (
    file: File,
  ): Promise<{ drive_file_id: string; drive_view_url: string; file_name: string }> => {
    const effectiveCompanyId =
      profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
    if (!effectiveCompanyId || !company?.name) {
      throw new Error("Company not loaded — refresh and try again.");
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("category", "expenses");
    fd.append("company_id", effectiveCompanyId);
    fd.append("company_name", company.name);
    const { data, error: fnErr } = await supabase.functions.invoke("gdrive-upload", { body: fd });
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

  // Cleans up an expense receipt regardless of whether it lives on Drive
  // (new uploads) or legacy Supabase Storage. Both calls are idempotent.
  const removeReceipt = async (row: {
    drive_file_id?: string | null;
    receipt_path?: string | null;
  }) => {
    if (row.drive_file_id) {
      await supabase.functions
        .invoke("gdrive-delete", { body: { drive_file_id: row.drive_file_id } })
        .catch(() => { /* idempotent */ });
      return;
    }
    if (row.receipt_path) {
      await supabase.storage.from(EXPENSE_RECEIPTS_BUCKET).remove([row.receipt_path]);
    }
  };

  // 0380. describeExpense moved into the database as describe_expense(), so
  // the sentence on an expense's audit line is built in one place whether the
  // expense was created, amended or reversed.

  // 0347. Amortisation is offered only above the threshold, so an amount edited
  // back down below it must not leave a stale coverage window behind — the
  // expenses_coverage_valid constraint would refuse the insert, correctly but
  // opaquely. Deriving it from both facts here means the form cannot send one
  // without the other.
  const isAmortising = (f: ExpenseForm) =>
    !!f.coverage_start && !!f.coverage_end && Number(f.amount) >= PREPAID_THRESHOLD;

  // 0356. A service period is sent only when it says something the expense date
  // does not. A period that is exactly the expense's own month puts the cost in
  // the month it would have landed in anyway — so sending it would defer the
  // whole amount into 1160 and make it wait on a monthly run for no gain. The
  // default the form offers IS that month, because it is the common case; the
  // common case therefore posts normally and the field is still explained.
  const isServicePeriod = (f: ExpenseForm) => {
    if (!f.service_start || !f.service_end || f.service_end < f.service_start) return false;
    const [a, b] = monthBounds(f.expense_date);
    return !(f.service_start === a && f.service_end === b);
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const amount = Number(form.amount);
    if (!form.category_id) { setFormError("Pick a category."); return; }
    if (!amount || amount <= 0 || !form.expense_date) return;
    if (form.payment_mode === "Bank" && !form.bank_account_id) {
      setFormError("Select a bank account for Bank payment.");
      return;
    }
    if (form.payment_mode === "Cheque" && !form.cheque_id) {
      setFormError("Select a pending cheque for Cheque payment.");
      return;
    }
    if (form.payment_mode === "Cheque") {
      const remaining = chequeRemaining(form.cheque_id);
      if (amount > remaining + 0.005) {
        setFormError(`This expense (PKR ${amount.toLocaleString()}) exceeds the cheque's remaining capacity (PKR ${remaining.toLocaleString()}).`);
        return;
      }
    }
    if (form.payment_mode === "Payable" && !form.due_date) {
      setFormError("Select a due date for Payable expense.");
      return;
    }
    if (form.payment_mode === "Payable" && !form.vendor_id) {
      setFormError("Select a vendor for Payable expense. Add one via Manage Vendors.");
      return;
    }
    // 0349-era fix: THE COMPANY-WIDE CASH BLOCK IS GONE, DELIBERATELY.
    //
    // What stood here refused the expense when `amount > cashBalance`, and
    // cashBalance is `treasury.cash_balance` — one cached company-wide scalar.
    // GGS deliberately allows a custodian to go overdrawn: they spend on the
    // company's behalf and are reimbursed later. A custodian who spends more
    // than they hold has created a PAYABLE, not negative cash, and the ledger
    // already models that — no_negative_custodian_balance reads 2 today
    // (Gul Rehman −1,640, M. Zamir Khan −10,093) and is an accepted red that
    // surfaces the position for someone to settle.
    //
    // The guard also asked the wrong question. It compared one expense against
    // the COMPANY total, while the per-custodian test — the one that matches
    // how this actually works — already sits immediately below as a
    // NON-BLOCKING confirm. Repointing the blocker at a better source would
    // have entangled this with the treasury de-duplication; deleting it does
    // not, because the correct test was already written.
    if (form.payment_mode === "Cash" && !expenseCustodianId) {
      setFormError("Select the office-staff member who paid the cash.");
      return;
    }
    if (form.payment_mode === "Cash") {
      // Non-blocking warning: let the user proceed even if the amount exceeds the
      // chosen custodian's held cash (they may have cash not yet attributed).
      const staff = custodians.find((c) => c.employeeId === expenseCustodianId);
      if (staff && amount > staff.held) {
        const ok = window.confirm(
          `This expense (PKR ${amount.toLocaleString()}) exceeds ${staff.fullName}'s held cash (PKR ${Math.round(staff.held).toLocaleString()}). Record it anyway?`,
        );
        if (!ok) return;
      }
    }
    if (form.payment_mode === "Bank") {
      const bank = banks.find((b) => b.id === form.bank_account_id);
      if (bank && amount > Number(bank.balance)) {
        setFormError("Selected bank balance is insufficient.");
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      const vendorId = form.payment_mode === "Payable" ? form.vendor_id || null : null;

      const chequeBank =
        form.payment_mode === "Cheque"
          ? cheques.find((c) => c.id === form.cheque_id)?.bank_account_id ?? null
          : null;
      // Resolve branch: explicit form value → client's branch → Head Office.
      const resolvedBranch =
        form.branch_id ||
        (form.client_id ? clients.find((c) => c.id === form.client_id)?.branch_id ?? null : null) ||
        headOfficeBranchId ||
        null;
      // Attribute cash paid to the office-staff custodian who paid it (0135).
      let custodianLocId: string | null = null;
      if (form.payment_mode === "Cash") {
        custodianLocId = await requireCustodianLoc(expenseCustodianId, "paid this cash");
      }
      // 0364. ONE CALL. This used to be an insert, then a read of the balance,
      // then a write-back of (read + delta), then a bank_transactions insert —
      // four round trips with no transaction around them. A failure after the
      // first left a recorded expense whose money never moved, and the bank
      // write-back could affect ZERO ROWS AND RETURN NO ERROR when RLS hid the
      // account. record_expense is SECURITY INVOKER, so every policy still
      // applies; what it adds is that all of it commits together or not at all.
      const { data: newId, error: insErr } = await supabase.rpc("record_expense", {
        p_category_id: form.category_id,
        p_amount: amount,
        p_expense_date: form.expense_date,
        p_payment_mode: form.payment_mode,
        p_client_id: form.client_id || null,
        p_branch_id: resolvedBranch,
        p_vendor_id: vendorId,
        p_description: form.description.trim() || null,
        p_custodian_location_id: custodianLocId,
        p_bank_account_id:
          form.payment_mode === "Bank"
            ? form.bank_account_id
            : form.payment_mode === "Cheque"
              ? chequeBank
              : null,
        p_cheque_id: form.payment_mode === "Cheque" ? form.cheque_id : null,
        p_due_date: form.payment_mode === "Payable" ? form.due_date : null,
        p_notes: form.notes.trim() || null,
        p_expense_by: form.expense_by || null,
        // 0347. Both or neither, and only above the threshold — the
        // expenses_coverage_valid constraint enforces the same rule, because
        // this form is not the only writer.
        p_coverage_start: isAmortising(form) ? `${form.coverage_start}-01` : null,
        p_coverage_end: isAmortising(form) ? `${form.coverage_end}-01` : null,
        // 0356. Day-granular, and mutually exclusive with the pair above: the
        // radio guarantees at most one is set, the constraint proves it.
        p_service_start: isServicePeriod(form) ? form.service_start : null,
        p_service_end: isServicePeriod(form) ? form.service_end : null,
        // pl_category is NOT sent: it is always derived from whether a client is
        // named, and 0364 moved that derivation into the function so the rule
        // has one home rather than one per caller.
      });
      if (insErr) throw insErr;
      const expId = newId as string;

      // Receipts upload AFTER the money is settled. They are slow, they are
      // optional, and a failed upload must not be able to strand a balance.
      if (form.receipts && form.receipts.length > 0) {
        const effectiveCompanyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
        let firstDrive: { drive_file_id: string; drive_view_url: string; file_name: string } | null = null;
        for (const file of form.receipts) {
          const drive = await uploadReceiptToDrive(file);
          if (!firstDrive) firstDrive = drive;
          if (effectiveCompanyId) {
            await supabase.from("expense_receipts").insert({ expense_id: expId, company_id: effectiveCompanyId, drive_file_id: drive.drive_file_id, drive_view_url: drive.drive_view_url, file_name: drive.file_name });
          }
        }
        if (firstDrive) {
          await supabase.from("expenses").update({ drive_file_id: firstDrive.drive_file_id, drive_view_url: firstDrive.drive_view_url, receipt_file_name: firstDrive.file_name }).eq("id", expId);
        }
      }

      setForm(emptyForm);
      setExpenseCustodianId("");
      setIsAddOpen(false);
      await loadAll();
    } catch (err: any) {
      setFormError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // 0268. Four Cash paths resolved a custodian with
  //
  //     if (cid && staff) locId = await ensureCustodianLocation(...)
  //
  // and carried on with null when either was missing, writing a cash row that
  // named nobody. Under 0268's CHECK that becomes a raw Postgres error AFTER
  // the balances have already moved, which is worse than the silent null it
  // replaces. Resolution now throws, before any money moves, with a sentence
  // an operator can act on — the same fix 0315 made in Accounting.tsx.
  const requireCustodianLoc = async (employeeId: string, what: string): Promise<string> => {
    const cid = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
    if (!cid) throw new Error("No company is selected — reload the page and try again.");
    const staff = custodians.find((c) => c.employeeId === employeeId);
    if (!staff) throw new Error(`Select the office-staff member who ${what}.`);
    const loc = await ensureCustodianLocation(cid, staff.employeeId, staff.fullName, staff.kind);
    if (!loc) throw new Error(`Could not open a cash location for ${staff.fullName}.`);
    return loc;
  };

  // 0346. Approve stamps who and when; unapprove clears the lock and is itself
  // recorded (unapproved_at / unapproved_by are written by the trigger, so the
  // trail survives even if this screen is not the caller). The trigger refuses
  // an unapproval that arrives bundled with an edit, which is why this sends
  // the approval fields ALONE.
  const toggleApproval = async (expense: ExpenseRow) => {
    const approving = !expense.approved_at;
    if (approving) {
      if (!window.confirm(
        `Approve this expense of PKR ${Number(expense.amount).toLocaleString()}?\n\n` +
        `It locks: no further edits, no deletion. A correction after this is a reversal. ` +
        `You can unapprove it again if you need to.`,
      )) return;
    }
    setError(null);
    const { error: apErr } = await supabase
      .from("expenses")
      .update(
        approving
          ? { approved_at: new Date().toISOString(), approved_by: profile?.id ?? null }
          : { approved_at: null },
      )
      .eq("id", expense.id);
    if (apErr) { setError(apErr.message); return; }
    await loadAll();
  };

  const openEdit = (expense: ExpenseRow) => {
    setSelected(expense);
    // 0268: seed the custodian picker from the row, so an edit that keeps Cash
    // keeps its custodian instead of clearing it.
    setExpenseCustodianId(
      custodians.find((c) => c.locationId && c.locationId === expense.custodian_location_id)
        ?.employeeId ?? "",
    );
    setEditForm({
      category_id: expense.category_id ?? "",
      pl_category: expense.pl_category ?? "operating_expense",
      client_id: expense.client_id ?? "",
      branch_id: expense.branch_id ?? "",
      vendor_id: expense.vendor_id ?? "",
      description: expense.description ?? "",
      amount: String(expense.amount),
      expense_date: expense.expense_date,
      payment_mode: expense.payment_mode,
      bank_account_id: expense.bank_account_id ?? "",
      cheque_id: expense.cheque_id ?? "",
      due_date: expense.due_date ?? "",
      notes: expense.notes ?? "",
      expense_by: expense.expense_by ?? "",
      // Stored as first-of-month dates; the <input type="month"> wants YYYY-MM.
      coverage_start: expense.coverage_start?.slice(0, 7) ?? "",
      coverage_end: expense.coverage_end?.slice(0, 7) ?? "",
      // 0356. Stored as real dates; <input type="date"> wants them whole.
      service_start: expense.service_start?.slice(0, 10) ?? "",
      service_end: expense.service_end?.slice(0, 10) ?? "",
    });
    setReplaceReceipt(false);
    setIsEditOpen(true);
  };

  // 0381. reverseExistingPayment is GONE. It spelled out "undo the money this
  // expense represents" — four rules, including the one everybody forgets,
  // that a settled payable refunds out of paid_via and not bank_account_id —
  // and it did it in round trips with no transaction around them, so a refusal
  // on the write that followed left the money already moved.
  //
  // It now lives once, in the database, as expense_reverse_money(), reading the
  // mode and the account OFF THE ROW rather than from whatever the caller
  // passes. amend_expense() and delete_expense() both call it inside the same
  // transaction as the row they change.

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!selected) return;
    const amount = Number(editForm.amount);
    if (!editForm.category_id) { setFormError("Pick a category."); return; }
    if (!amount || amount <= 0 || !editForm.expense_date) return;
    if (editForm.payment_mode === "Bank" && !editForm.bank_account_id) {
      setFormError("Select a bank account for Bank payment.");
      return;
    }
    if (editForm.payment_mode === "Cheque" && !editForm.cheque_id) {
      setFormError("Select a pending cheque for Cheque payment.");
      return;
    }
    if (editForm.payment_mode === "Cheque") {
      const ownPrev =
        selected?.cheque_id === editForm.cheque_id && selected?.payment_mode === "Cheque"
          ? Number(selected.amount)
          : 0;
      const remaining = chequeRemaining(editForm.cheque_id, ownPrev);
      if (amount > remaining + 0.005) {
        setFormError(`This expense (PKR ${amount.toLocaleString()}) exceeds the cheque's remaining capacity (PKR ${remaining.toLocaleString()}).`);
        return;
      }
    }
    if (editForm.payment_mode === "Payable" && !editForm.due_date) {
      setFormError("Select a due date for Payable expense.");
      return;
    }
    if (editForm.payment_mode === "Payable" && !editForm.vendor_id) {
      setFormError("Select a vendor for Payable expense. Add one via Manage Vendors.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // The "insufficient after reversal" block is gone for the same reason as
      // the one on the add form: it measured a company-wide cached scalar, and
      // an overdrawn custodian is a payable the ledger already holds.
      if (editForm.payment_mode === "Bank") {
        const bank = banks.find((b) => b.id === editForm.bank_account_id);
        const reversedBack = selected.payment_mode === "Bank" && selected.bank_account_id === editForm.bank_account_id
          ? Number(selected.amount)
          : 0;
        if (bank && amount > Number(bank.balance) + reversedBack) {
          setFormError("Selected bank balance is insufficient after reversal.");
          setSubmitting(false);
          return;
        }
      }

      const vendorId = editForm.payment_mode === "Payable" ? editForm.vendor_id || null : null;

      // Receipt edit: keep existing values unless the user opted to replace.
      let receiptPath: string | null = selected.receipt_path;
      let receiptDriveFileId: string | null = selected.drive_file_id;
      let receiptDriveViewUrl: string | null = selected.drive_view_url;
      let receiptFileName: string | null = selected.receipt_file_name;
      if (replaceReceipt) {
        // Remove old expense_receipts rows and their Drive files.
        const { data: oldReceipts } = await supabase.from("expense_receipts").select("drive_file_id").eq("expense_id", selected.id);
        for (const r of oldReceipts ?? []) {
          if (r.drive_file_id) await supabase.functions.invoke("gdrive-delete", { body: { drive_file_id: r.drive_file_id } }).catch(() => {});
        }
        await supabase.from("expense_receipts").delete().eq("expense_id", selected.id);
        await removeReceipt({ drive_file_id: selected.drive_file_id, receipt_path: selected.receipt_path });
        receiptPath = null;
        receiptDriveFileId = null;
        receiptDriveViewUrl = null;
        receiptFileName = null;
        if (editForm.receipts && editForm.receipts.length > 0) {
          const effectiveCompanyId = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
          let firstDrive: { drive_file_id: string; drive_view_url: string; file_name: string } | null = null;
          for (const file of editForm.receipts) {
            const drive = await uploadReceiptToDrive(file);
            if (!firstDrive) firstDrive = drive;
            if (effectiveCompanyId) {
              await supabase.from("expense_receipts").insert({ expense_id: selected.id, company_id: effectiveCompanyId, drive_file_id: drive.drive_file_id, drive_view_url: drive.drive_view_url, file_name: drive.file_name });
            }
          }
          if (firstDrive) {
            receiptDriveFileId = firstDrive.drive_file_id;
            receiptDriveViewUrl = firstDrive.drive_view_url;
            receiptFileName = firstDrive.file_name;
          }
        }
      }

      // 0268. The edit form let the mode be changed to Cash but HID the
      // custodian picker (`&& !edit`) and never wrote the column, so a
      // Bank -> Cash edit produced a cash expense naming nobody. The picker is
      // now shown on edit too and its value is written here.
      const editCustodianLocId =
        editForm.payment_mode === "Cash"
          ? await requireCustodianLoc(expenseCustodianId, "paid this cash")
          : null;
      const resolvedEditBranch =
        editForm.branch_id ||
        (editForm.client_id ? clients.find((c) => c.id === editForm.client_id)?.branch_id ?? null : null) ||
        headOfficeBranchId ||
        null;
      // 0381. ONE CALL. The old money comes back, the row changes and the new
      // money goes out inside a single transaction, so a refusal on any of the
      // three leaves all three undone. Before this, the reversal above had
      // already committed by the time the UPDATE was refused.
      //
      // payable_status, paid_via, paid_bank_account_id and paid_at are no
      // longer computed here: amend_expense carries them forward from the
      // stored row, which is the only place that knows whether this payable
      // was already settled. The cheque's bank account is resolved there too.
      const { error: amendErr } = await supabase.rpc("amend_expense", {
        p_expense_id: selected.id,
        p_category_id: editForm.category_id,
        p_amount: amount,
        p_expense_date: editForm.expense_date,
        p_payment_mode: editForm.payment_mode,
        p_client_id: editForm.client_id || null,
        p_branch_id: resolvedEditBranch,
        p_vendor_id: vendorId,
        p_description: editForm.description.trim() || null,
        p_custodian_location_id: editCustodianLocId,
        p_bank_account_id: editForm.payment_mode === "Bank" ? editForm.bank_account_id : null,
        p_cheque_id: editForm.payment_mode === "Cheque" ? editForm.cheque_id : null,
        p_due_date: editForm.payment_mode === "Payable" ? editForm.due_date : null,
        p_notes: editForm.notes.trim() || null,
        p_expense_by: editForm.expense_by || null,
        // 0347. Same derivation as the insert. Dropping below the threshold on
        // edit clears the window rather than leaving one the constraint refuses.
        p_coverage_start: isAmortising(editForm) ? `${editForm.coverage_start}-01` : null,
        p_coverage_end: isAmortising(editForm) ? `${editForm.coverage_end}-01` : null,
        p_service_start: isServicePeriod(editForm) ? editForm.service_start : null,
        p_service_end: isServicePeriod(editForm) ? editForm.service_end : null,
        p_receipt_path: receiptPath,
        p_drive_file_id: receiptDriveFileId,
        p_drive_view_url: receiptDriveViewUrl,
        p_receipt_file_name: receiptFileName,
      });
      if (amendErr) throw amendErr;

      setIsEditOpen(false);
      await loadAll();
    } catch (err: any) {
      setFormError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (exp: ExpenseRow) => {
    if (!window.confirm(`Delete expense "${exp.description ?? exp.category_name ?? exp.id.slice(0, 6)}"? Any cash/bank movement will be reversed.`))
      return;
    setError(null);
    try {
      // 0381. The money and the row go together. The receipt is removed FIRST
      // and deliberately: Drive is not part of the transaction, so it is the
      // one step that cannot be rolled back, and a receipt left behind for a
      // deletion that was refused is recoverable in a way a missing one is not.
      await removeReceipt({
        drive_file_id: exp.drive_file_id,
        receipt_path: exp.receipt_path,
      });
      const { error: delErr } = await supabase.rpc("delete_expense", { p_expense_id: exp.id });
      if (delErr) throw delErr;
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };

  const openView = async (exp: ExpenseRow) => {
    setSelected(exp);
    setViewReceipts([]);
    setIsViewOpen(true);
    const { data } = await supabase.from("expense_receipts").select("id, drive_file_id, drive_view_url, file_name").eq("expense_id", exp.id).order("created_at");
    setViewReceipts((data ?? []) as typeof viewReceipts);
  };

  // 0382. logAdvanceTransaction and describeAdvance moved into the database
  // alongside the advance RPCs, for the same reason their expense twins did.

  const validateAdvance = (f: AdvanceForm, existingAmount?: number): string | null => {
    if (!f.employee_id) return "Select an employee.";
    const amt = Number(f.amount);
    if (!amt || amt <= 0) return "Enter a positive amount.";
    if (!f.advance_date) return "Select a date.";
    if (f.payment_mode === "Bank" && !f.bank_account_id) return "Select a bank account.";
    if (f.payment_mode === "Cash" && !f.paid_by_employee_id) return "Select who paid the cash.";
    if (f.payment_mode === "Cheque" && !f.cheque_id) return "Select a pending cheque.";
    if (f.payment_mode === "Cheque") {
      const ownPrev = existingAmount ?? 0;
      const remaining = chequeRemaining(f.cheque_id, ownPrev);
      if (amt > remaining + 0.005) {
        return `Advance exceeds the cheque's remaining capacity (PKR ${remaining.toLocaleString()}).`;
      }
    }
    // An ADVANCE paid in cash is the same act as an expense paid in cash: the
    // custodian hands over money on the company's behalf. Blocked on the same
    // company-wide scalar, removed for the same reason. The BANK test below
    // stays — a bank account genuinely cannot go below its own balance, that
    // figure is per-account rather than a shared cached total, and nobody has
    // ruled that an overdrawn bank account is allowed.
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
    setFormError(null);
  };

  const handleAddAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const err = validateAdvance(advForm);
    if (err) {
      setFormError(err);
      return;
    }
    setAdvSubmitting(true);
    setError(null);
    try {
      const amount = Number(advForm.amount);
      const emp = employees.find((x) => x.id === advForm.employee_id);
      const client = advForm.client_id ? clients.find((c) => c.id === advForm.client_id) ?? null : null;
      const chequeBank =
        advForm.payment_mode === "Cheque"
          ? cheques.find((c) => c.id === advForm.cheque_id)?.bank_account_id ?? null
          : null;
      // Attribute cash paid to the office-staff custodian who handed it over,
      // exactly as a cash expense does.
      let advCustodianLocId: string | null = null;
      if (advForm.payment_mode === "Cash") {
        advCustodianLocId = await requireCustodianLoc(
          advForm.paid_by_employee_id, "handed over this cash");
      }
      // 0382. ONE CALL: the advance row and the cash or bank movement in one
      // transaction. advances only gained a permission at all in 0372
      // (expenses.edit, provisionally), so this flow became genuinely
      // cross-key — expenses.edit for the row, accounting.edit for a bank
      // balance — which is exactly when a transaction boundary starts to
      // matter. Cheque mode still moves nothing here: the cheque trigger
      // reserves the balance and the money leaves when it clears.
      const { error: advErr } = await supabase.rpc("record_advance", {
        p_employee_id: advForm.employee_id,
        p_amount: amount,
        p_advance_date: advForm.advance_date,
        p_payment_mode: advForm.payment_mode,
        p_client_id: advForm.client_id || null,
        p_bank_account_id: advForm.payment_mode === "Bank" ? advForm.bank_account_id : null,
        p_cheque_id: advForm.payment_mode === "Cheque" ? advForm.cheque_id : null,
        p_custodian_location_id: advCustodianLocId,
        p_notes: advForm.notes.trim() || null,
      });
      if (advErr) throw advErr;
            // Cheque mode: balance already deducted by cheque trigger; no cashflow until cleared.
      resetAdvAddModal();
      await loadAll();
    } catch (err: any) {
      setFormError(err.message ?? String(err));
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
      cheque_id: adv.cheque_id ?? "",
      notes: adv.notes ?? "",
      paid_by_employee_id:
        custodians.find((c) => c.locationId && c.locationId === adv.custodian_location_id)?.employeeId ?? "",
    });
    setAdvEditEmpSearch(`${adv.employee_name} (${adv.employee_code})`);
    setIsAdvEditOpen(true);
  };

  // 0382. reverseAdvancePayment is GONE, for the same reason
  // reverseExistingPayment is: it moved money in its own round trip and left
  // the caller to write the row afterwards. advance_reverse_money() in the
  // database reads the mode and the account off the stored row, and
  // amend_advance()/delete_advance() call it inside their own transaction.

  const handleEditAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!advEditing) return;
    const sameAccountAsBefore =
      advEditForm.payment_mode === advEditing.payment_mode &&
      (advEditForm.payment_mode === "Cash" ||
        advEditForm.bank_account_id === advEditing.bank_account_id);
    const existingAmount = sameAccountAsBefore ? Number(advEditing.amount) : 0;
    const err = validateAdvance(advEditForm, existingAmount);
    if (err) {
      setFormError(err);
      return;
    }
    setAdvSubmitting(true);
    setError(null);
    try {
      const amount = Number(advEditForm.amount);
      let advEditCustodianLocId: string | null = null;
      if (advEditForm.payment_mode === "Cash") {
        advEditCustodianLocId = await requireCustodianLoc(
          advEditForm.paid_by_employee_id, "handed over this cash");
      }
      // 0382. Old money back, row changed, new money out — one transaction.
      // The reversal reads the OLD mode off the row, which is what makes a
      // Cash -> Bank edit return the cash rather than crediting the bank twice.
      const { error: advEditErr } = await supabase.rpc("amend_advance", {
        p_advance_id: advEditing.id,
        p_employee_id: advEditForm.employee_id,
        p_amount: amount,
        p_advance_date: advEditForm.advance_date,
        p_payment_mode: advEditForm.payment_mode,
        p_client_id: advEditForm.client_id || null,
        p_bank_account_id: advEditForm.payment_mode === "Bank" ? advEditForm.bank_account_id : null,
        p_cheque_id: advEditForm.payment_mode === "Cheque" ? advEditForm.cheque_id : null,
        p_custodian_location_id: advEditCustodianLocId,
        p_notes: advEditForm.notes.trim() || null,
      });
      if (advEditErr) throw advEditErr;

            // Cheque: balance reserved by cheque trigger, no immediate cashflow.
      setIsAdvEditOpen(false);
      setAdvEditing(null);
      await loadAll();
    } catch (err: any) {
      setFormError(err.message ?? String(err));
    } finally {
      setAdvSubmitting(false);
    }
  };

  const handleDeleteAdvance = async (adv: AdvanceRow) => {
    if (!window.confirm(`Delete advance of PKR ${Number(adv.amount).toLocaleString()} to ${adv.employee_name}? Cash/Bank movement will be reversed.`))
      return;
    setError(null);
    try {
      const { error: delErr } = await supabase.rpc("delete_advance", { p_advance_id: adv.id });
      if (delErr) throw delErr;
      await loadAll();
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };

  // Resolves the URL for an expense receipt regardless of storage backend.
  // Drive rows store a webViewLink directly; legacy rows still come from
  // Supabase Storage and need a public URL lookup.
  const getReceiptUrl = (row: {
    drive_view_url?: string | null;
    receipt_path?: string | null;
  }): string | null => {
    if (row.drive_view_url) return row.drive_view_url;
    if (row.receipt_path) {
      const { data } = supabase.storage
        .from(EXPENSE_RECEIPTS_BUCKET)
        .getPublicUrl(row.receipt_path);
      return data.publicUrl ?? null;
    }
    return null;
  };

  const downloadReceipt = async (row: {
    drive_view_url?: string | null;
    receipt_path?: string | null;
    receipt_file_name?: string | null;
  }) => {
    if (row.drive_view_url) {
      window.open(row.drive_view_url, "_blank");
      return;
    }
    const path = row.receipt_path;
    if (!path) return;
    const { data, error: dErr } = await supabase.storage
      .from(EXPENSE_RECEIPTS_BUCKET)
      .download(path);
    if (dErr || !data) {
      setError(dErr?.message ?? "Unable to download receipt");
      return;
    }
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = row.receipt_file_name ?? path.split("/").pop() ?? "receipt";
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
        subtitle="Operating expenses and employee advances ledger"
        actions={
          <>
            <ExportButton
              onExport={() => {
                if (activeTab === "fixed") {
                  // The month's raised entries, decision included — an approved
                  // one is also in the Expenses export, as a real expense.
                  exportExpenses(
                    fixedInstances.map((i) => ({
                      date: i.period_month,
                      particulars: `${i.description ?? ""}${i.status === "pending" ? " (pending)" : i.status === "denied" ? " (denied)" : ""}`.trim(),
                      category: i.category?.name ?? "",
                      client: i.client?.name ?? "Office",
                      amount: Number(i.amount),
                      mode: i.payment_mode,
                    })),
                    `Fixed Expenses ${monthLabel(fixedMonth)}.xlsx`,
                  );
                } else if (activeTab === "deferred") {
                  // Export what the tab SHOWS. Falling through to the expense
                  // export would have handed somebody a file from a different
                  // tab without saying so, which is the quietest kind of wrong.
                  exportExpenses(
                    deferred.map((d) => ({
                      date: d.expense_date,
                      particulars: `${d.description ?? ""} — ${d.months_released}/${d.months_total} months released, finishes ${monthLabel(d.final_month.slice(0, 7))}${d.is_stale ? " (STUCK)" : ""}`.trim(),
                      category: d.category_name ?? "",
                      client: d.shape === "prepaid" ? "Prepaid" : "Service period",
                      amount: d.remaining,
                      mode: `${formatDate(d.period_start)}–${formatDate(d.period_end)}`,
                    })),
                    `Deferred Expenses ${new Date().toISOString().slice(0, 10)}.xlsx`,
                  );
                } else if (activeTab === "advances") {
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
            {activeTab === "expenses" && canEditExpenses && (
              <Button variant="secondary" size="md" onClick={() => setIsVendorModalOpen(true)}>
                Manage Vendors
              </Button>
            )}
            {activeTab === "expenses" && canEditExpenses && (
              <Button variant="primary" size="md" onClick={() => { setExpenseCustodianId(""); setIsAddOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Add Expense
              </Button>
            )}
            {activeTab === "advances" && canEditExpenses && (
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

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {focusMissing && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              The record this ledger entry points at is not on this screen — it may have
              been deleted, or it may be outside the region you can see.
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 mb-6 overflow-x-auto">
          {([
            ["expenses", "Expenses"],
            ["fixed", "Fixed Expenses"],
            ["advances", "Advances"],
            ["deferred", "Deferred"],
          ] as const).map(([t, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => setActiveTab(t)}
              // shrink-0 + nowrap: the "Fixed Expenses" tab carries an extra
              // "N pending" suffix, which wrapped to a second line on a narrow
              // screen and made that one button taller than its neighbours.
              // The active tab also needs a transparent border, or it sits 2px
              // shorter than the bordered inactive ones.
              className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-md text-sm border transition-colors ${
                activeTab === t
                  ? "bg-brand-600 text-[#fff] border-transparent"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {label}
              {t === "fixed" && fixedTotals.count > 0 && (
                <span className="ml-2 text-[11px] opacity-75">
                  {fixedInstances.filter((i) => i.status === "pending").length} pending
                </span>
              )}
              {/* The count is of what is still OPEN. A settled schedule is
                  listed but is not something anybody is waiting on. */}
              {t === "deferred" && deferred.some((d) => d.remaining !== 0) && (
                <span className="ml-2 text-[11px] opacity-75">
                  {deferred.filter((d) => d.remaining !== 0).length} open
                </span>
              )}
            </button>
          ))}
        </div>

        {activeTab === "expenses" && (
          <div className="mb-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-1 flex flex-col gap-4">
              <div className="bg-[#14160f] text-[#fff] p-4 rounded-lg">
                <p className="text-xs text-slate-300 mb-1">Total Expenses</p>
                <p className="text-2xl text-[#fff]">
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
                    <Legend {...CHART_LEGEND} />
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
              <ThemedSelect
                value={monthFilter}
                onChange={(e) => setMonthFilter(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                title="Filter by month"
              >
                <option value="all">All Months</option>
                {monthOptions.map((m) => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </ThemedSelect>
              <ThemedSelect
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
              </ThemedSelect>
              <ClientFilterSelect
                clients={clients}
                value={clientFilter}
                onChange={setClientFilter}
                allValue="all"
                extraOption={{ value: "office", label: "Office (no client)" }}
              />
              <ThemedSelect
                value={modeFilter}
                onChange={(e) => setModeFilter(e.target.value as "all" | ExpensePaymentMode)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="all">All Modes</option>
                <option value="Cash">Cash</option>
                <option value="Bank">Bank</option>
                <option value="Cheque">Cheque</option>
                <option value="Payable">Payable</option>
              </ThemedSelect>
              <ThemedSelect
                value={expenseByFilter}
                onChange={(e) => setExpenseByFilter(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                title="Filter by who the expense was incurred by"
              >
                <option value="all">All Expense By</option>
                <option value="none">Unassigned</option>
                {officeStaff.map((s) => (
                  <option key={s.id} value={s.id}>{s.full_name}</option>
                ))}
              </ThemedSelect>
            </div>
          </div>

          {/* Phone: one card per expense. Recording and checking spend is the
              most common thing anyone does on this page away from a desk. */}
          <MobileCardList
            rows={loading ? [] : filtered}
            loading={loading}
            empty='No expenses yet. Tap "Add Expense" to create one.'
            rowKey={(exp) => exp.id}
            title={(exp) => exp.category_name ?? "—"}
            subtitle={(exp) => `${formatDate(exp.expense_date)} · ${exp.client_name ?? "Office"}`}
            badge={(exp) => (
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
                  exp.payment_mode === "Cash"
                    ? "bg-success-50 text-success-700"
                    : exp.payment_mode === "Bank"
                      ? "bg-brand-50 text-brand-700"
                      : "bg-warning-50 text-warning-700"
                }`}
              >
                {exp.payment_mode}
                {exp.payment_mode === "Payable" && exp.payable_status ? ` · ${exp.payable_status}` : ""}
              </span>
            )}
            fields={[
              {
                label: "Amount",
                value: (exp) => <span className="tabular-nums">PKR {Number(exp.amount).toLocaleString()}</span>,
              },
              { label: "Expense By", value: (exp) => exp.expense_by_name ?? "—" },
              { label: "Description", full: true, value: (exp) => exp.description ?? "—" },
            ]}
            actions={(exp) => (
              <>
                <Button variant="ghost" size="sm" onClick={() => openView(exp)}>View</Button>
                {/* Same rule as the table: an approved expense offers neither. */}
                {!exp.approved_at && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(exp)}>Edit</Button>
                    <button
                      type="button"
                      onClick={() => handleDelete(exp)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-danger-700"
                    >
                      <Trash2 className="w-4 h-4" strokeWidth={1.5} /> Delete
                    </button>
                  </>
                )}
                {canApproveExpenses && (
                  <Button variant="ghost" size="sm" onClick={() => toggleApproval(exp)}>
                    {exp.approved_at ? "Unapprove" : "Approve"}
                  </Button>
                )}
              </>
            )}
          />

          <div className="hidden md:block overflow-auto max-h-[480px]">
            <table className="w-full">
              <thead className="sticky top-0 z-10 bg-white">
                <tr className="border-b border-slate-200">
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Date</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Category</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Client</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Description</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Amount</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Mode</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Expense By</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500">Actions</th>
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
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-6 py-10 text-center text-slate-500 text-sm">
                      No expenses yet. Click "Add Expense" to create one.
                    </td>
                  </tr>
                )}
                {!loading &&
                  filtered.map((exp) => (
                    <tr
                      key={exp.id}
                      ref={exp.id === focusExpense ? focusExpenseRow : undefined}
                      className={`hover:bg-slate-50 transition-colors ${
                        exp.id === focusExpense ? FOCUS_ROW_CLASS : ""
                      }`}
                    >
                      <td className="px-4 py-3 text-sm text-slate-600">{formatDate(exp.expense_date)}</td>
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
                              ? "bg-success-50 text-success-700"
                              : exp.payment_mode === "Bank"
                              ? "bg-brand-50 text-brand-700"
                              : "bg-warning-50 text-warning-700"
                          }`}
                        >
                          {exp.payment_mode}
                          {exp.payment_mode === "Payable" && exp.payable_status ? ` · ${exp.payable_status}` : ""}
                        </span>
                        {/* Approval is a REVIEW state, separate from payable_status,
                            which answers payment. Both can show at once. */}
                        {exp.approved_at && (
                          <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded text-xs bg-success-50 text-success-700" title={`Approved ${exp.approved_at.slice(0, 10)} — locked against edits`}>
                            Approved
                          </span>
                        )}
                        {exp.service_start && exp.service_end && (
                          <span
                            className="ml-1 inline-flex items-center px-2 py-0.5 rounded text-xs bg-brand-50 text-brand-700"
                            title={`Split across ${serviceSplit(exp.service_start.slice(0, 10), exp.service_end.slice(0, 10), Number(exp.amount))
                              .map((x) => `${monthLabel(x.key)} ${x.days}d`)
                              .join(", ")}`}
                          >
                            Service period
                          </span>
                        )}
                        {exp.coverage_start && exp.coverage_end && (
                          <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded text-xs bg-brand-50 text-brand-700" title={`Spread over ${prepaidMonths(exp.coverage_start.slice(0, 7), exp.coverage_end.slice(0, 7))} months`}>
                            Prepaid
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-700">
                        {exp.expense_by_name ?? <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-3 flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openView(exp)}>
                          View
                        </Button>
                        {/* Edit and Delete disappear once approved rather than
                            failing on click. The database refuses them either
                            way (0346); showing a control that cannot work is
                            how a lock gets mistaken for a bug. */}
                        {!exp.approved_at && (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => openEdit(exp)}>
                              Edit
                            </Button>
                            <button
                              type="button"
                              onClick={() => handleDelete(exp)}
                              className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-danger-700 hover:bg-danger-50"
                              title="Delete expense"
                            >
                              <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                            </button>
                          </>
                        )}
                        {canApproveExpenses && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleApproval(exp)}
                            title={
                              exp.approved_at
                                ? "Unapprove — reopens the expense for editing. Recorded."
                                : "Approve — locks the expense against edits and deletion."
                            }
                          >
                            {exp.approved_at ? "Unapprove" : "Approve"}
                          </Button>
                        )}
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
                            className="inline-flex items-center justify-center px-2 py-1 rounded-md text-danger-700 hover:bg-danger-50"
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

        {activeTab === "deferred" && (
          <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200">
              <h3 className="text-sm font-medium text-slate-900">Deferred expenses</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Costs that left the bank in full but reach the profit and loss a month at a time.
                Until they do, the remainder sits on account 1160 Prepaid Expenses. The monthly
                run releases each month as it arrives.
              </p>
            </div>

            {deferredErr && (
              <div className="px-4 py-3 text-sm text-danger-700 bg-danger-50 border-b border-danger-200">
                {deferredErr}
              </div>
            )}

            {deferred.length === 0 && !deferredErr ? (
              <div className="px-4 py-8 text-sm text-slate-500 text-center">
                Nothing is deferred. An expense is deferred by choosing a service period or a
                prepaid coverage window when it is entered.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      {["Expense", "Shape", "Period", "Amount", "Released", "Remaining", "Progress", "Finishes"].map((h) => (
                        <th key={h} className="px-4 py-2 text-left text-xs font-medium text-slate-500">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {deferred.map((d) => (
                      <tr key={d.expense_id} className={d.is_stale ? "bg-danger-50" : undefined}>
                        <td className="px-4 py-3 text-sm">
                          <div className="text-slate-900">{d.description ?? "—"}</div>
                          <div className="text-xs text-slate-500">
                            {d.category_name ?? "—"} · {formatDate(d.expense_date)}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-700">
                          {d.shape === "prepaid" ? "Prepaid" : "Service period"}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-700 whitespace-nowrap">
                          {formatDate(d.period_start)} – {formatDate(d.period_end)}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-900">PKR {d.amount.toLocaleString()}</td>
                        <td className="px-4 py-3 text-sm text-slate-700">PKR {d.released.toLocaleString()}</td>
                        <td className="px-4 py-3 text-sm text-slate-900">PKR {d.remaining.toLocaleString()}</td>
                        <td className="px-4 py-3 text-sm text-slate-700 whitespace-nowrap">
                          {d.months_released} of {d.months_total} months
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-700 whitespace-nowrap">
                          {monthLabel(d.final_month.slice(0, 7))}
                          {/* THE ONE ROW-LEVEL ALARM. no_stale_prepaid_balance
                              goes red for the company; this says WHICH expense,
                              because "something is stuck" is not an instruction. */}
                          {d.is_stale && (
                            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs bg-danger-100 text-danger-700"
                                  title="Its period has fully passed and it still carries a balance on 1160 — the monthly release run has not finished it.">
                              Stuck
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-50 border-t border-slate-200">
                    {/* Folded from the rows above, not fetched. A footer that
                        can contradict the table it sits under is worse than the
                        duplication — see CLAUDE.md, the stated exception. */}
                    <tr>
                      <td colSpan={5} className="px-4 py-2 text-sm text-slate-600 text-right">
                        Still on 1160 for the rows shown
                      </td>
                      <td colSpan={3} className="px-4 py-2 text-sm font-medium text-slate-900">
                        PKR {deferred.reduce((a, d) => a + d.remaining, 0).toLocaleString()}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === "fixed" && (
          <div className="space-y-6">
            {/* ---- This month's raised instances ---- */}
            <div className="bg-white rounded-lg border border-slate-200">
              <div className="p-6 border-b border-slate-200 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-lg text-slate-900 mb-1">{monthLabel(fixedMonth)}</h3>
                  <p className="text-sm text-slate-500">
                    Raised automatically on the 1st. Nothing here has been spent until it is approved.
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="text-sm text-slate-600">Month:</label>
                  <ThemedSelect
                    value={fixedMonth}
                    onChange={(e) => setFixedMonth(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    {fixedMonthOptions.map((m) => (
                      <option key={m} value={m}>{monthLabel(m)}</option>
                    ))}
                  </ThemedSelect>
                  <ThemedSelect
                    value={fixedPaidByFilter}
                    onChange={(e) => setFixedPaidByFilter(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                    title="Filter templates by their default payer"
                  >
                    <option value="all">All Paid By</option>
                    <option value="none">No default</option>
                    {custodians.map((c) => (
                      <option key={c.employeeId} value={c.employeeId}>{c.fullName}</option>
                    ))}
                  </ThemedSelect>
                  <Button variant="primary" size="md" onClick={openFixedAdd}>
                    <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                    Add Fixed Expense
                  </Button>
                </div>
              </div>

              <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3 border-b border-slate-200">
                <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-warning-500">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Awaiting Decision</p>
                  <p className="text-lg text-warning-900">PKR {fixedTotals.pending.toLocaleString()}</p>
                </div>
                <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-success-500">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Approved (posted)</p>
                  <p className="text-lg text-success-900">PKR {fixedTotals.approved.toLocaleString()}</p>
                </div>
                <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-slate-400">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Denied</p>
                  <p className="text-lg text-slate-700">PKR {fixedTotals.denied.toLocaleString()}</p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Description</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Category</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Client / Vendor</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Mode</th>
                      <th className="text-right px-6 py-3 text-sm text-slate-500">Amount</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                      <th className="text-right px-6 py-3 text-sm text-slate-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {fixedInstances.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">
                          {fixedExpenses.filter((f) => f.is_active).length === 0
                            ? "No fixed expenses set up yet. Add one and it will appear here on the 1st of every month."
                            : `Nothing raised for ${monthLabel(fixedMonth)} — the active templates all start later or have ended.`}
                        </td>
                      </tr>
                    )}
                    {fixedInstances.map((row) => (
                      <tr key={row.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4 text-sm text-slate-900">
                          {row.description || <span className="text-slate-400">—</span>}
                          {row.due_date && (
                            <div className="text-xs text-slate-500">Due {formatDate(row.due_date)}</div>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">{row.category?.name ?? "—"}</td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {row.client?.name ?? row.vendor?.name ?? <span className="text-slate-400">Office</span>}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">{row.payment_mode}</td>
                        <td className="px-6 py-4 text-sm text-right text-slate-900">
                          PKR {Number(row.amount).toLocaleString()}
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-md border text-xs ${
                              row.status === "approved"
                                ? "bg-success-50 text-success-700 border-success-200"
                                : row.status === "denied"
                                  ? "bg-slate-100 text-slate-600 border-slate-200"
                                  : "bg-warning-50 text-warning-800 border-warning-200"
                            }`}
                          >
                            {row.status === "approved" ? "Approved" : row.status === "denied" ? "Denied" : "Pending"}
                          </span>
                          {row.decision_note && (
                            <div className="text-xs text-slate-500 mt-1 max-w-[220px]">{row.decision_note}</div>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center justify-end gap-2">
                            {row.status === "pending" && (
                              <>
                                <button
                                  className="text-sm text-slate-600 hover:text-slate-900"
                                  onClick={() => openInstanceEdit(row)}
                                  title="Edit this month's amount or description"
                                >
                                  <Pencil className="w-4 h-4" strokeWidth={1.5} />
                                </button>
                                <Button variant="secondary" size="sm" onClick={() => openDecision(row, "deny")}>
                                  Deny
                                </Button>
                                <Button variant="primary" size="sm" onClick={() => openDecision(row, "approve")}>
                                  Approve
                                </Button>
                              </>
                            )}
                            {row.status === "denied" && (
                              <Button variant="secondary" size="sm" onClick={() => reopenInstance(row)}>
                                Reopen
                              </Button>
                            )}
                            {row.status === "approved" && (
                              <span className="text-xs text-slate-500">Posted to Expenses</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ---- The templates themselves ---- */}
            <div className="bg-white rounded-lg border border-slate-200">
              <div className="p-6 border-b border-slate-200">
                <h3 className="text-lg text-slate-900 mb-1">Recurring Definitions</h3>
                <p className="text-sm text-slate-500">
                  Each of these raises one entry per month between its start and end.
                  Deactivating stops future months; months already raised keep whatever was decided.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Description</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Category</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Client / Vendor</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Mode</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Paid By</th>
                      <th className="text-right px-6 py-3 text-sm text-slate-500">Amount</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Runs</th>
                      <th className="text-right px-6 py-3 text-sm text-slate-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {filteredFixedExpenses.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-6 py-10 text-center text-slate-500 text-sm">
                          {fixedExpenses.length === 0
                            ? "No fixed expenses yet."
                            : "No fixed expenses match the current Paid By filter."}
                        </td>
                      </tr>
                    )}
                    {filteredFixedExpenses.map((f) => (
                      <tr key={f.id} className={`hover:bg-slate-50 transition-colors ${f.is_active ? "" : "opacity-60"}`}>
                        <td className="px-6 py-4 text-sm text-slate-900">
                          {f.description || <span className="text-slate-400">—</span>}
                          {!f.is_active && <span className="ml-2 text-xs text-slate-500">(inactive)</span>}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">{f.category?.name ?? "—"}</td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {f.client?.name ?? f.vendor?.name ?? <span className="text-slate-400">Office</span>}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">{f.payment_mode}</td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {custodianNameByLocation.get(f.custodian_location_id ?? "") ?? (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-right text-slate-900">
                          PKR {Number(f.amount).toLocaleString()}
                        </td>
                        <td className="px-6 py-4 text-xs text-slate-600">
                          {monthLabel(f.start_month.slice(0, 7))} →{" "}
                          {f.end_month ? monthLabel(f.end_month.slice(0, 7)) : "ongoing"}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              className="text-sm text-slate-600 hover:text-slate-900"
                              onClick={() => openFixedEdit(f)}
                              title="Edit"
                            >
                              <Pencil className="w-4 h-4" strokeWidth={1.5} />
                            </button>
                            <Button variant="secondary" size="sm" onClick={() => toggleFixedActive(f)}>
                              {f.is_active ? "Deactivate" : "Activate"}
                            </Button>
                            <button
                              className="text-sm text-danger-600 hover:text-danger-700"
                              onClick={() => handleDeleteFixed(f)}
                              title="Delete"
                            >
                              <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
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
                <ThemedSelect
                  value={advMonthFilter}
                  onChange={(e) => setAdvMonthFilter(e.target.value)}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                  title="Filter by month"
                >
                  <option value="all">All Months</option>
                  {monthOptions.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </ThemedSelect>
                <ThemedSelect
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
                </ThemedSelect>
                <ThemedSelect
                  value={advBranchFilter}
                  onChange={(e) => setAdvBranchFilter(e.target.value)}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                >
                  <option value="all">All Branches</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </ThemedSelect>
                <ThemedSelect
                  value={advModeFilter}
                  onChange={(e) => setAdvModeFilter(e.target.value as "all" | "Cash" | "Bank" | "Cheque")}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                >
                  <option value="all">All Modes</option>
                  <option value="Cash">Cash</option>
                  <option value="Bank">Bank</option>
                  <option value="Cheque">Cheque</option>
                </ThemedSelect>
                <ThemedSelect
                  value={advPaidByFilter}
                  onChange={(e) => setAdvPaidByFilter(e.target.value)}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                  title="Filter by who paid the cash"
                >
                  <option value="all">All Paid By</option>
                  <option value="none">Unattributed</option>
                  {custodians.map((c) => (
                    <option key={c.employeeId} value={c.employeeId}>{c.fullName}</option>
                  ))}
                </ThemedSelect>
                <div className="ml-auto text-xs text-slate-500">
                  {advTotals.count} advance{advTotals.count === 1 ? "" : "s"} · PKR {advTotals.total.toLocaleString()}
                </div>
              </div>
            </div>
            {/* Phone: one card per advance. Salary advances get asked for and
                recorded at a site office more than anywhere else. */}
            <MobileCardList
              rows={loading ? [] : filteredAdvances}
              loading={loading}
              empty='No advances yet. Tap "Add Advance" to record one.'
              rowKey={(adv) => adv.id}
              title={(adv) => adv.employee_name}
              subtitle={(adv) => `${adv.employee_code} · ${adv.advance_date}`}
              badge={(adv) => (
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
                    adv.payment_mode === "Cash" ? "bg-success-50 text-success-700" : "bg-brand-50 text-brand-700"
                  }`}
                >
                  {adv.payment_mode}
                  {adv.bank_name ? ` · ${adv.bank_name}` : ""}
                </span>
              )}
              fields={[
                {
                  label: "Amount",
                  value: (adv) => <span className="tabular-nums">PKR {Number(adv.amount).toLocaleString()}</span>,
                },
                { label: "Client", value: (adv) => adv.client_name ?? "—" },
                {
                  label: "Paid By",
                  value: (adv) =>
                    custodianNameByLocation.get(adv.custodian_location_id ?? "") ?? "—",
                },
                { label: "Notes", full: true, value: (adv) => adv.notes ?? "—" },
              ]}
              actions={(adv) => (
                <>
                  <Button variant="ghost" size="sm" onClick={() => openAdvEdit(adv)}>
                    <Pencil className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} /> Edit
                  </Button>
                  <button
                    type="button"
                    onClick={() => handleDeleteAdvance(adv)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-danger-700"
                  >
                    <Trash2 className="w-4 h-4" strokeWidth={1.5} /> Delete
                  </button>
                </>
              )}
            />

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-4 py-3 text-xs text-slate-500">Date</th>
                    <th className="text-left px-4 py-3 text-xs text-slate-500">Employee</th>
                    <th className="text-left px-4 py-3 text-xs text-slate-500">Client</th>
                    <th className="text-right px-4 py-3 text-xs text-slate-500">Amount</th>
                    <th className="text-left px-4 py-3 text-xs text-slate-500">Mode</th>
                    <th className="text-left px-4 py-3 text-xs text-slate-500">Paid By</th>
                    <th className="text-left px-4 py-3 text-xs text-slate-500">Notes</th>
                    <th className="text-left px-4 py-3 text-xs text-slate-500">Actions</th>
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
                  {!loading && filteredAdvances.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-6 py-10 text-center text-slate-500 text-sm">
                        No advances yet. Click "Add Advance" to record one.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    filteredAdvances.map((adv) => (
                      <tr
                        key={adv.id}
                        ref={adv.id === focusAdvance ? focusAdvanceRow : undefined}
                        className={`hover:bg-slate-50 transition-colors ${
                          adv.id === focusAdvance ? FOCUS_ROW_CLASS : ""
                        }`}
                      >
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
                                ? "bg-success-50 text-success-700"
                                : "bg-brand-50 text-brand-700"
                            }`}
                          >
                            {adv.payment_mode}
                            {adv.bank_name ? ` · ${adv.bank_name}` : ""}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-700">
                          {custodianNameByLocation.get(adv.custodian_location_id ?? "") ?? (
                            <span className="text-slate-400">—</span>
                          )}
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
                            className="inline-flex items-center justify-center px-2.5 py-1.5 rounded-md text-danger-700 hover:bg-danger-50"
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
              // Display label: prefer the Drive-side file name, fall back to
              // the legacy path's basename, or null if nothing attached.
              existingReceipt:
                selected.receipt_file_name
                ?? selected.receipt_path
                ?? (selected.drive_view_url ? "Attached receipt" : null),
              replaceReceipt,
              setReplaceReceipt,
            }
          )}
      </Modal>

      {/* ---- Fixed expense template: add / edit ---- */}
      <Modal
        isOpen={isFixedFormOpen}
        onClose={() => setIsFixedFormOpen(false)}
        title={fixedEditingId ? "Edit Fixed Expense" : "Add Fixed Expense"}
        size="lg"
      >
        <form onSubmit={handleSaveFixed} className="space-y-4">
          {fixedError && (
            <div className="p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
              {fixedError}
            </div>
          )}
          <p className="text-xs text-slate-500">
            This describes what recurs. One entry is raised from it on the 1st of every month between
            the start and end months, and nothing is spent until that entry is approved.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Category *</label>
              <CategoryPicker
                categories={categories}
                value={fixedForm.category_id}
                onChange={(v) => setFixedForm({ ...fixedForm, category_id: v })}
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">P&amp;L Treatment *</label>
              <ThemedSelect
                value={fixedForm.pl_category}
                disabled
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm bg-slate-50 text-slate-500 cursor-not-allowed"
              >
                <option value="operating_expense">Operating Expense</option>
                <option value="cost_of_services">Cost of Services</option>
              </ThemedSelect>
              <p className="text-[11px] text-slate-500 mt-1">
                Set from the Client below: a client → Cost of Services, Office → Operating Expense.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Description</label>
            <input
              type="text"
              value={fixedForm.description}
              onChange={(e) => setFixedForm({ ...fixedForm, description: e.target.value })}
              placeholder="Head office rent"
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={fixedForm.amount}
                onChange={(e) => setFixedForm({ ...fixedForm, amount: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                required
              />
              <p className="text-[11px] text-slate-500 mt-1">
                The default each month. Any month's entry can be edited before it is approved.
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Payment Mode *</label>
              <ThemedSelect
                value={fixedForm.payment_mode}
                onChange={(e) =>
                  setFixedForm({ ...fixedForm, payment_mode: e.target.value as FixedPaymentMode })
                }
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="Bank">Bank</option>
                <option value="Cash">Cash</option>
                <option value="Payable">Payable</option>
              </ThemedSelect>
              <p className="text-[11px] text-slate-500 mt-1">
                Cheque is not offered — a cheque expense must name one specific pending cheque,
                which cannot be known months ahead.
              </p>
            </div>
          </div>

          {fixedForm.payment_mode === "Cash" && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Paid By (Office Staff)</label>
              <ThemedSelect
                value={fixedForm.paid_by_employee_id}
                onChange={(e) => setFixedForm({ ...fixedForm, paid_by_employee_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">No default — choose at approval</option>
                {custodians.map((c) => (
                  <option key={c.employeeId} value={c.employeeId}>
                    {c.fullName} — holds PKR {Math.round(c.held).toLocaleString()}
                  </option>
                ))}
              </ThemedSelect>
              <p className="text-[11px] text-slate-500 mt-1">
                Who normally pays this. It prefills the approval each month; the money only moves,
                and only lands against a custodian, when that month's entry is approved.
              </p>
            </div>
          )}

          {fixedForm.payment_mode === "Bank" && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Bank Account *</label>
              <ThemedSelect
                value={fixedForm.bank_account_id}
                onChange={(e) => setFixedForm({ ...fixedForm, bank_account_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
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

          {fixedForm.payment_mode === "Payable" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-slate-700 mb-1">Vendor *</label>
                <ThemedSelect
                  value={fixedForm.vendor_id}
                  onChange={(e) => setFixedForm({ ...fixedForm, vendor_id: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                >
                  <option value="">Select vendor</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </ThemedSelect>
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-1">Due on day of month</label>
                <input
                  type="number"
                  min="1"
                  max="28"
                  value={fixedForm.due_day}
                  onChange={(e) => setFixedForm({ ...fixedForm, due_day: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                />
                <p className="text-[11px] text-slate-500 mt-1">1–28, so every month has the day.</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Client (optional)</label>
              <ClientFilterSelect
                clients={clients}
                value={fixedForm.client_id}
                allValue=""
                allLabel="Office (no client)"
                buttonClassName="w-full"
                onChange={(id) => {
                  const c = id ? clients.find((x) => x.id === id) : null;
                  // Locks the P&L treatment and auto-fills the region.
                  setFixedForm({
                    ...fixedForm,
                    client_id: id,
                    branch_id: c?.branch_id ?? fixedForm.branch_id,
                    pl_category: id ? "cost_of_services" : "operating_expense",
                  });
                }}
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Region</label>
              <ThemedSelect
                value={fixedForm.branch_id}
                onChange={(e) => setFixedForm({ ...fixedForm, branch_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">Auto (client's region, else head office)</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </ThemedSelect>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">First month *</label>
              <input
                type="month"
                value={fixedForm.start_month}
                onChange={(e) => setFixedForm({ ...fixedForm, start_month: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                required
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Nothing is raised before this, so a new template cannot conjure past months.
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Last month (optional)</label>
              <input
                type="month"
                value={fixedForm.end_month}
                onChange={(e) => setFixedForm({ ...fixedForm, end_month: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
              <p className="text-[11px] text-slate-500 mt-1">Leave blank to run indefinitely.</p>
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-700 mb-1">Notes</label>
            <textarea
              value={fixedForm.notes}
              onChange={(e) => setFixedForm({ ...fixedForm, notes: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>

          <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
            <Button type="submit" variant="primary" size="md" className="flex-1" disabled={fixedSubmitting}>
              {fixedSubmitting ? "Saving…" : fixedEditingId ? "Save changes" : "Add fixed expense"}
            </Button>
            <Button type="button" variant="secondary" size="md" onClick={() => setIsFixedFormOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      {/* ---- Edit ONE month's entry (before approval) ---- */}
      <Modal
        isOpen={!!instanceEditing}
        onClose={() => setInstanceEditing(null)}
        title={instanceEditing ? `Edit ${monthLabel(fixedMonth)} entry` : "Edit entry"}
        size="md"
      >
        {instanceEditing && (
          <form onSubmit={handleSaveInstance} className="space-y-4">
            <p className="text-xs text-slate-500">
              This changes {monthLabel(fixedMonth)} only. The recurring definition, and every other
              month, are untouched.
            </p>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={instanceForm.amount}
                onChange={(e) => setInstanceForm({ ...instanceForm, amount: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Description</label>
              <input
                type="text"
                value={instanceForm.description}
                onChange={(e) => setInstanceForm({ ...instanceForm, description: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            {instanceEditing.payment_mode === "Payable" && (
              <div>
                <label className="block text-sm text-slate-700 mb-1">Due date</label>
                <input
                  type="date"
                  value={instanceForm.due_date}
                  onChange={(e) => setInstanceForm({ ...instanceForm, due_date: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                />
              </div>
            )}
            <div>
              <label className="block text-sm text-slate-700 mb-1">Notes</label>
              <textarea
                value={instanceForm.notes}
                onChange={(e) => setInstanceForm({ ...instanceForm, notes: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
              <Button type="submit" variant="primary" size="md" className="flex-1">
                Save
              </Button>
              <Button type="button" variant="secondary" size="md" onClick={() => setInstanceEditing(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---- Approve / deny ---- */}
      <Modal
        isOpen={!!decisionTarget}
        onClose={() => setDecisionTarget(null)}
        title={decisionTarget?.action === "approve" ? "Approve fixed expense" : "Deny fixed expense"}
        size="md"
      >
        {decisionTarget && (
          <div className="space-y-4">
            {fixedError && (
              <div className="p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
                {fixedError}
              </div>
            )}
            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
              <p className="text-sm text-slate-900">
                {decisionTarget.row.description || decisionTarget.row.category?.name || "Fixed expense"}
              </p>
              <p className="text-lg text-slate-900 mt-1">
                PKR {Number(decisionTarget.row.amount).toLocaleString()}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {monthLabel(fixedMonth)} · {decisionTarget.row.payment_mode}
                {decisionTarget.row.client?.name ? ` · ${decisionTarget.row.client.name}` : " · Office"}
              </p>
            </div>

            <p className="text-xs text-slate-500">
              {decisionTarget.action === "approve"
                ? `Approving records a real expense dated ${formatDate(decisionTarget.row.period_month)} and moves the money, exactly as adding it by hand would.`
                : "Denying records the decision and nothing else — no expense, no money moved. It can be reopened later."}
            </p>

            {decisionTarget.action === "approve" && decisionTarget.row.payment_mode === "Cash" && (
              <div>
                <label className="block text-sm text-slate-700 mb-1">Paid By (Office Staff) *</label>
                <ThemedSelect
                  value={decisionCustodianId}
                  onChange={(e) => setDecisionCustodianId(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                >
                  <option value="">Select who paid</option>
                  {custodians.map((c) => (
                    <option key={c.employeeId} value={c.employeeId}>
                      {c.fullName} — holds PKR {Math.round(c.held).toLocaleString()}
                    </option>
                  ))}
                </ThemedSelect>
              </div>
            )}

            <div>
              <label className="block text-sm text-slate-700 mb-1">
                Note {decisionTarget.action === "deny" ? "(why it was denied)" : "(optional)"}
              </label>
              <textarea
                value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>

            <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
              <Button
                variant={decisionTarget.action === "approve" ? "primary" : "danger"}
                size="md"
                className="flex-1"
                disabled={decisionBusy}
                onClick={handleDecision}
              >
                {decisionBusy
                  ? "Working…"
                  : decisionTarget.action === "approve"
                    ? "Approve and post"
                    : "Deny"}
              </Button>
              <Button variant="secondary" size="md" onClick={() => setDecisionTarget(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={isViewOpen} onClose={() => setIsViewOpen(false)} title="Expense Details" size="lg">
        {selected && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-slate-500 mb-1">Date</p>
                <p className="text-slate-900">{formatDate(selected.expense_date)}</p>
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
              {/* 0401. Somebody looking at one expense should not have to leave
                  it to find out it was split. Read from the same function the
                  Deferred tab reads, so the two cannot disagree. */}
              {(() => {
                const d = deferred.find((x) => x.expense_id === selected.id);
                if (!d) return null;
                return (
                  <div className="sm:col-span-2">
                    <p className="text-slate-500 mb-1">
                      {d.shape === "prepaid" ? "Prepaid — spread over the months it covers" : "Service period — split across the months it covers"}
                    </p>
                    <p className="text-slate-900">
                      {formatDate(d.period_start)} – {formatDate(d.period_end)} · {d.months_released} of{" "}
                      {d.months_total} months released · PKR {d.released.toLocaleString()} of{" "}
                      {d.amount.toLocaleString()}, PKR {d.remaining.toLocaleString()} still on 1160 ·
                      finishes {monthLabel(d.final_month.slice(0, 7))}
                      {d.is_stale && " — STUCK: its period has passed and it still carries a balance."}
                    </p>
                  </div>
                );
              })()}
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
                    <p className="text-slate-900">{selected.due_date ? formatDate(selected.due_date) : "—"}</p>
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
              <p className="text-slate-500 mb-2 text-sm">Receipt(s)</p>
              {viewReceipts.length > 0 ? (
                <div className="space-y-2">
                  {viewReceipts.map((r) => (
                    <div key={r.id} className="border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-3">
                      <span className="text-sm text-slate-700 truncate flex-1">{r.file_name ?? "Receipt"}</span>
                      {r.drive_view_url && (
                        <a
                          href={r.drive_view_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-slate-700 hover:text-slate-900 underline shrink-0"
                        >
                          <Download className="w-4 h-4" strokeWidth={1.5} />
                          View / Download
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              ) : (selected.drive_view_url || selected.receipt_path) ? (
                <div className="border border-slate-200 rounded-lg p-3 flex items-center justify-between">
                  <span className="text-sm text-slate-700 truncate">
                    {selected.receipt_file_name ?? selected.receipt_path?.split("/").pop() ?? "Receipt"}
                  </span>
                  <div className="flex gap-2">
                    {getReceiptUrl(selected) && (
                      <a href={getReceiptUrl(selected) ?? "#"} target="_blank" rel="noreferrer" className="text-sm text-slate-700 hover:text-slate-900 underline">
                        View
                      </a>
                    )}
                    <button onClick={() => downloadReceipt(selected)} className="inline-flex items-center gap-1 text-sm text-slate-700 hover:text-slate-900">
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
        error={error}
        onDismissError={() => setError(null)}
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
                        className="inline-flex items-center justify-center px-2 py-1 rounded-md text-danger-700 hover:bg-danger-50"
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
        error={error}
        onDismissError={() => setError(null)}
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
        {formError && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={2} />
            <div className="flex-1">{formError}</div>
            <button type="button" onClick={() => setFormError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <div>
          <label className="block text-sm text-slate-700 mb-1">Client (optional)</label>
          <ThemedSelect
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
          </ThemedSelect>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {(["Cash", "Bank", "Cheque"] as const).map((m) => (
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
                      cheque_id: m === "Cheque" ? state.cheque_id : "",
                    })
                  }
                />
                <span>{m}</span>
              </label>
            ))}
          </div>
        </div>
        {/* Same "Paid By" a cash expense asks for: without it the cash leaves
            Cash in Hand attributed to nobody. */}
        {state.payment_mode === "Cash" && (
          <div>
            <label className="block text-sm text-slate-700 mb-1">Paid By (Office Staff) *</label>
            <ThemedSelect
              required
              value={state.paid_by_employee_id}
              onChange={(e) => setState({ ...state, paid_by_employee_id: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">Select who paid the cash…</option>
              {custodians.map((c) => (
                <option key={c.employeeId} value={c.employeeId}>
                  {c.fullName} — holds PKR {Math.round(c.held).toLocaleString()}
                </option>
              ))}
            </ThemedSelect>
            {(() => {
              const staff = custodians.find((c) => c.employeeId === state.paid_by_employee_id);
              const amt = Number(state.amount);
              return staff && amt > 0 && amt > staff.held ? (
                <p className="text-[11px] text-warning-700 mt-1.5">
                  This exceeds {staff.fullName}'s held cash (PKR {Math.round(staff.held).toLocaleString()}). You can still record it.
                </p>
              ) : null;
            })()}
          </div>
        )}
        {state.payment_mode === "Bank" && (
          <div>
            <label className="block text-sm text-slate-700 mb-1">Bank Account *</label>
            <ThemedSelect
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
            </ThemedSelect>
          </div>
        )}
        {state.payment_mode === "Cheque" && (
          <div>
            <label className="block text-sm text-slate-700 mb-1">Cheque *</label>
            <ThemedSelect
              required
              value={state.cheque_id}
              onChange={(e) => setState({ ...state, cheque_id: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">Select a pending cheque</option>
              {cheques
                .filter((c) => c.status === "pending" || c.id === state.cheque_id)
                .map((c) => {
                  const bank = banks.find((b) => b.id === c.bank_account_id);
                  const remaining = chequeRemaining(c.id);
                  return (
                    <option key={c.id} value={c.id}>
                      #{c.cheque_number} · {bank?.bank_name ?? "Bank"} · PKR {Number(c.amount).toLocaleString()} (remaining PKR {remaining.toLocaleString()}) · {c.status}
                    </option>
                  );
                })}
            </ThemedSelect>
            <p className="text-xs text-slate-500 mt-1">
              Cashflow recognises this advance only when the cheque is marked Cleared.
            </p>
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
        {formError && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={2} />
            <div className="flex-1">{formError}</div>
            <button type="button" onClick={() => setFormError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Client (optional)</label>
            <ClientFilterSelect
              clients={clients}
              value={state.client_id}
              allValue=""
              allLabel="Office (no client)"
              buttonClassName="w-full"
              filterFn={(c) => !state.branch_id || c.branch_id === state.branch_id}
              onChange={(id) => {
                const c = id ? clients.find((x) => x.id === id) : null;
                // Picking a client auto-fills its branch and LOCKS the P&L
                // category: a client makes it Cost of Services, Office makes it
                // Operating Expense. It can no longer be overridden by hand.
                setState({
                  ...state,
                  client_id: id,
                  branch_id: c?.branch_id ?? state.branch_id,
                  pl_category: id ? "cost_of_services" : "operating_expense",
                });
              }}
            />
            <p className="text-xs text-slate-500 mt-1">
              {state.branch_id
                ? "Showing clients in the selected branch only."
                : "Leave empty to log as an Office expense (Head Office)."}
            </p>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Branch (optional)</label>
            <ThemedSelect
              value={state.branch_id}
              onChange={(e) => {
                const newBranch = e.target.value;
                // If current client doesn't match the new branch, clear it — and
                // with it, drop the P&L category back to Operating Expense.
                const cur = clients.find((c) => c.id === state.client_id);
                const keepClient = !newBranch || !cur || cur.branch_id === newBranch;
                setState({
                  ...state,
                  branch_id: newBranch,
                  client_id: keepClient ? state.client_id : "",
                  pl_category: keepClient ? state.pl_category : "operating_expense",
                });
              }}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">Head Office (default)</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </ThemedSelect>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Category *</label>
            <CategoryPicker
              categories={categories}
              value={state.category_id}
              onChange={(v) => setState({ ...state, category_id: v })}
            />
          </div>
          <div className="col-span-full">
            <label className="block text-sm text-slate-700 mb-1">P&amp;L Category *</label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { value: "cost_of_services", label: "Cost of Services", hint: "Tied to a client / contract (guard payroll, equipment, transport)" },
                  { value: "operating_expense", label: "Operating Expense", hint: "Head-office overhead (rent, office salaries, utilities)" },
                ] as const
              ).map((opt) => {
                const active = state.pl_category === opt.value;
                // Locked: derived from the Client field, never clicked directly.
                return (
                  <div
                    key={opt.value}
                    aria-disabled="true"
                    className={`flex flex-col items-start gap-1 px-3 py-2 border rounded-md text-sm cursor-not-allowed ${
                      active ? "border-slate-900 bg-slate-50" : "border-slate-200 opacity-60"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`pl_category_${submitLabel}`}
                        checked={active}
                        readOnly
                        disabled
                      />
                      <span>{opt.label}</span>
                    </div>
                    <span className="text-xs text-slate-500 ml-6">{opt.hint}</span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Set automatically from the Client: a client → Cost of Services, Office → Operating Expense. Not editable.
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

          {/* 0347 + 0356 — WHICH MONTHS THIS COST BELONGS TO.

              ONE QUESTION, THREE ANSWERS, AND A RADIO RATHER THAN TWO
              CHECKBOXES. expenses_one_spreading_mechanism refuses an expense
              carrying BOTH a coverage window and a service period, because it
              would be released twice. A radio cannot hold both, so the invalid
              combination is unreachable instead of being typed and then refused
              — the difference between a form that teaches the rule and a form
              that enforces it by rejecting people.

              The two spreads are not the same mechanism and the wording says so:
                * SERVICE PERIOD (0356) — day-granular, weighted by the days of
                  the period falling in each month, at any amount.
                * PREPAID (0347) — month-granular, split equally, offered only
                  from PKR 50,000 because eleven entries to move 166 rupees each
                  is more bookkeeping than the accuracy is worth.

              Either way the cash leaves in full today. Only the P&L is spread. */}
          <div className="col-span-2 border border-slate-200 rounded-md p-3 bg-slate-50">
            <div className="text-sm font-medium text-slate-800">Which months does this cost belong to?</div>
            <p className="text-[11px] text-slate-500 mt-0.5 mb-2">
              Almost every expense belongs entirely to the month it was paid. Two do not: a bill
              that pays for a stretch of service, and a cost paid a long way ahead. In both, the
              full amount still leaves the bank today and the cash flow shows that — only the
              profit and loss takes it a month at a time.
            </p>

            {(() => {
              const belowThreshold = Number(state.amount) < PREPAID_THRESHOLD;
              const mode = state.coverage_start ? "prepaid" : state.service_start ? "service" : "none";
              const pick = (next: "none" | "service" | "prepaid") => {
                if (next === "none") {
                  setState({ ...state, coverage_start: "", coverage_end: "", service_start: "", service_end: "" });
                } else if (next === "service") {
                  const [a, b] = monthBounds(state.expense_date);
                  setState({ ...state, coverage_start: "", coverage_end: "", service_start: a, service_end: b });
                } else {
                  const m = state.expense_date.slice(0, 7);
                  setState({ ...state, service_start: "", service_end: "", coverage_start: m, coverage_end: m });
                }
              };
              const opts: { key: "none" | "service" | "prepaid"; label: string; hint: string; disabled?: boolean }[] = [
                {
                  key: "none",
                  label: "All of it in the expense month",
                  hint: "The whole cost lands in the month of the date above. Right for almost everything.",
                },
                {
                  key: "service",
                  label: "It pays for a period of service",
                  hint: "A bill covering 15 August to 15 September belongs to both months, split by how many days of the period fall in each. Any amount.",
                },
                {
                  key: "prepaid",
                  label: "Paid ahead — spread over the months it covers",
                  hint: belowThreshold
                    ? "Insurance six months ahead, a licence paid for a year. Offered from PKR 50,000 upwards."
                    : "Insurance six months ahead, a licence paid for a year. Split equally across the months, the last taking the remainder.",
                  disabled: belowThreshold,
                },
              ];
              return (
                <div className="space-y-2">
                  {opts.map((o) => (
                    <label
                      key={o.key}
                      className={`block border rounded-md px-3 py-2 ${
                        mode === o.key ? "border-slate-900 bg-white" : "border-slate-200"
                      } ${o.disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                    >
                      <div className="flex items-center gap-2 text-sm text-slate-800">
                        <input
                          type="radio"
                          name={`spread_${submitLabel}`}
                          checked={mode === o.key}
                          disabled={o.disabled}
                          onChange={() => pick(o.key)}
                        />
                        <span>{o.label}</span>
                      </div>
                      <p className="text-[11px] text-slate-500 ml-6 mt-0.5">{o.hint}</p>
                    </label>
                  ))}

                  {/* The amount can be edited back down after prepaid was chosen.
                      Say so rather than silently dropping the window at submit,
                      which is what isAmortising does — correctly, and invisibly. */}
                  {mode === "prepaid" && belowThreshold && (
                    <p className="text-[11px] text-warning-700">
                      Below PKR {PREPAID_THRESHOLD.toLocaleString()} this is not applied — the whole
                      cost will land in the expense month.
                    </p>
                  )}

                  {mode === "service" && (
                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div>
                        <label className="block text-xs text-slate-600 mb-1">Service from *</label>
                        <input
                          type="date"
                          required
                          value={state.service_start}
                          onChange={(e) => setState({ ...state, service_start: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-600 mb-1">Service to *</label>
                        <input
                          type="date"
                          required
                          min={state.service_start}
                          value={state.service_end}
                          onChange={(e) => setState({ ...state, service_end: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                        />
                      </div>
                      <div className="col-span-2 text-[11px] text-slate-600">
                        {(() => {
                          const parts = serviceSplit(state.service_start, state.service_end, Number(state.amount) || 0);
                          if (parts.length === 0) return "The end of the period cannot be before its start.";
                          if (parts.length === 1)
                            return "The period sits inside one month, so nothing is spread — the cost lands in " +
                              monthLabel(parts[0].key) + ".";
                          return parts
                            .map((x) => `${monthLabel(x.key)}: ${x.days}d, PKR ${x.amount.toLocaleString()}`)
                            .join(" · ");
                        })()}
                      </div>
                    </div>
                  )}

                  {mode === "prepaid" && !belowThreshold && (
                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div>
                        <label className="block text-xs text-slate-600 mb-1">First month covered *</label>
                        <input
                          type="month"
                          required
                          value={state.coverage_start}
                          onChange={(e) => setState({ ...state, coverage_start: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-600 mb-1">Last month covered *</label>
                        <input
                          type="month"
                          required
                          min={state.coverage_start}
                          value={state.coverage_end}
                          onChange={(e) => setState({ ...state, coverage_end: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                        />
                      </div>
                      {state.coverage_end >= state.coverage_start && (
                        <p className="col-span-2 text-[11px] text-slate-600">
                          {(() => {
                            const n = prepaidMonths(state.coverage_start, state.coverage_end);
                            const amt = Number(state.amount) || 0;
                            const per = Math.round((amt / n) * 100) / 100;
                            const last = Math.round((amt - per * (n - 1)) * 100) / 100;
                            return `${n} month${n === 1 ? "" : "s"} · PKR ${per.toLocaleString()} each` +
                              (last !== per
                                ? `, PKR ${last.toLocaleString()} in the final month so the schedule sums to the amount exactly.`
                                : ".");
                          })()}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Payment Mode *</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(["Cash", "Bank", "Cheque", "Payable"] as const).map((m) => (
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
                    onChange={() => setState({ ...state, payment_mode: m, cheque_id: m === "Cheque" ? state.cheque_id : "" })}
                  />
                  <span>{m}</span>
                </label>
              ))}
            </div>
          </div>
          {state.payment_mode === "Cash" && (
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Paid By (Office Staff) *</label>
              <ThemedSelect
                required
                value={expenseCustodianId}
                onChange={(e) => setExpenseCustodianId(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">Select who paid the cash…</option>
                {custodians.map((c) => (
                  <option key={c.employeeId} value={c.employeeId}>
                    {c.fullName} — holds PKR {Math.round(c.held).toLocaleString()}
                  </option>
                ))}
              </ThemedSelect>
              {(() => {
                const staff = custodians.find((c) => c.employeeId === expenseCustodianId);
                const amt = Number(state.amount);
                return staff && amt > 0 && amt > staff.held ? (
                  <p className="text-[11px] text-warning-700 mt-1.5">
                    This exceeds {staff.fullName}'s held cash (PKR {Math.round(staff.held).toLocaleString()}). You can still record it.
                  </p>
                ) : null;
              })()}
            </div>
          )}
          <div className="col-span-2">
            <label className="block text-sm text-slate-700 mb-1">Expense By (Office Staff)</label>
            <ThemedSelect
              value={state.expense_by}
              onChange={(e) => setState({ ...state, expense_by: e.target.value })}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
            >
              <option value="">Select who the expense is by…</option>
              {officeStaff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name}
                </option>
              ))}
            </ThemedSelect>
          </div>
          {state.payment_mode === "Bank" && (
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Bank Account *</label>
              <ThemedSelect
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
              </ThemedSelect>
            </div>
          )}
          {state.payment_mode === "Cheque" && (
            <div className="col-span-2">
              <label className="block text-sm text-slate-700 mb-1">Cheque *</label>
              <ThemedSelect
                required
                value={state.cheque_id}
                onChange={(e) => setState({ ...state, cheque_id: e.target.value })}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">Select a pending cheque</option>
                {cheques
                  .filter((c) => c.status === "pending" || c.id === state.cheque_id)
                  .map((c) => {
                    const bank = banks.find((b) => b.id === c.bank_account_id);
                    return (
                      <option key={c.id} value={c.id}>
                        #{c.cheque_number} · {bank?.bank_name ?? "Bank"} · PKR {Number(c.amount).toLocaleString()} · {c.status}
                      </option>
                    );
                  })}
              </ThemedSelect>
              <p className="text-xs text-slate-500 mt-1">
                Cashflow recognises this expense only when the cheque is marked Cleared in Bank Accounts → Cheques.
              </p>
            </div>
          )}
          {state.payment_mode === "Payable" && (
            <>
              <div className="col-span-2">
                <label className="block text-sm text-slate-700 mb-1">Vendor *</label>
                <ThemedSelect
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
                </ThemedSelect>
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
            <label className="block text-sm text-slate-700 mb-1">Receipt(s)</label>
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
              <div className="space-y-2">
                <label className="flex items-center gap-3 cursor-pointer px-4 py-2 border border-slate-200 border-dashed rounded-md hover:bg-slate-50 transition-colors">
                  <Upload className="w-4 h-4 text-slate-400 shrink-0" strokeWidth={1.5} />
                  <span className="text-sm text-slate-500 flex-1">
                    {state.receipts?.length
                      ? `${state.receipts.length} file(s) selected`
                      : "Click to choose file(s)…"}
                  </span>
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => setState({ ...state, receipts: e.target.files ? Array.from(e.target.files) : undefined })}
                  />
                </label>
                {state.receipts && state.receipts.length > 0 && (
                  <ul className="space-y-1">
                    {state.receipts.map((f, i) => (
                      <li key={i} className="flex items-center justify-between text-xs text-slate-600 bg-slate-50 px-3 py-1.5 rounded">
                        <span className="truncate">{f.name}</span>
                        <button
                          type="button"
                          onClick={() => setState({ ...state, receipts: state.receipts?.filter((_, j) => j !== i) })}
                          className="ml-2 text-slate-400 hover:text-slate-700"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {edit?.replaceReceipt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(ev: React.MouseEvent) => {
                      ev.preventDefault();
                      edit.setReplaceReceipt(false);
                      setState({ ...state, receipts: undefined });
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
