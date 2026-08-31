import ThemedSelect from "../../components/ThemedSelect";
import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, FileText, Plus, Lock, Trash2, BookOpen, Settings2 } from "lucide-react";
import Header from "../../components/Header";
import { formatDate, invoicePeriodFilter } from "../../lib/date";
import ExportButton from "../../components/ExportButton";
import PartnerFormModal from "../../components/PartnerFormModal";
import PartnerDetailModal from "../../components/PartnerDetailModal";
import {
  exportProfitLoss,
  exportClientStatements,
  exportTable,
} from "../../lib/excel";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import Partners from "./Partners";
import Cashflow from "./CashFlow";
import {
  supabase,
  INVOICE_ATTACHMENTS_BUCKET,
  type Client,
  type Invoice,
  type Payslip,
  type Expense,
  type Employee,
  type ExpenseCategory,
  type BankAccount,
  type ClientType,
  type Partner,
  type Branch,
} from "../../lib/supabase";

type ClientStatementRow = Client & {
  total_invoiced: number;
  payroll_expense: number;
  expenses: number;
  /** This client's share of its region's own unattributed cost. */
  regional_overhead: number;
  /** This client's share of head office, pro-rata by revenue. */
  ho_share: number;
  total_income: number;
  invoices: Invoice[];
};

/** One row of public.client_statement_loaded. */
type LoadedStatement = {
  client_id: string;
  revenue: number;
  direct_payroll: number;
  direct_expenses: number;
  regional_overhead: number;
  ho_share: number;
  net: number;
};

const monthKeyFromDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const previousMonthKey = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return monthKeyFromDate(d);
};

const firstOfMonth = (periodMonth: string) => `${periodMonth}-01`;
const lastOfMonth = (periodMonth: string) => {
  const [y, m] = periodMonth.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${periodMonth}-${String(last).padStart(2, "0")}`;
};
const formatPeriod = (periodMonth: string) => {
  const [y, m] = periodMonth.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

/**
 * `standalone="partnership"` renders ONLY the Partnership Report — its own page
 * under Finance, reached from the nav rather than from a tab in here. The report
 * shares all of this component's partner/allocation state, so it is pinned as a
 * mode instead of being copied into a second component that would drift.
 */
export default function FinancialReports({ standalone }: { standalone?: "partnership" } = {}) {
  const partnershipOnly = standalone === "partnership";
  const [activeTab, setActiveTab] = useState<"pl" | "clients" | "partnership" | "rmd">(
    partnershipOnly ? "partnership" : "pl",
  );
  // Top-level switch merging the Financial Report and Cash Flow pages under one
  // roof — Cash Flow is rendered from its own (embedded) component.
  const [topTab, setTopTab] = useState<"financial" | "cashflow">("financial");
  // Once Cash Basis has been opened, keep <Cashflow> mounted and just hide it on
  // other tabs — so it fetches once instead of re-loading on every visit.
  const [cashflowOpened, setCashflowOpened] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [plBranchFilter, setPlBranchFilter] = useState<string>("all");
  const [statementBranchFilter, setStatementBranchFilter] = useState<string>("all");
  const [isClientStatementModalOpen, setIsClientStatementModalOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<ClientStatementRow | null>(null);

  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  // client_id → payroll cost for the statement period, split by days worked
  // (payroll_cost_by_client, migration 0155).
  const [payrollByClient, setPayrollByClient] = useState<Map<string, number>>(new Map());
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loadedStatements, setLoadedStatements] = useState<LoadedStatement[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);

  const [chartPeriod, setChartPeriod] = useState<string>(previousMonthKey());
  const [chartInvoices, setChartInvoices] = useState<Invoice[]>([]);
  const [chartExpenses, setChartExpenses] = useState<Expense[]>([]);
  const [chartCategories, setChartCategories] = useState<ExpenseCategory[]>([]);
  const [chartBanks, setChartBanks] = useState<BankAccount[]>([]);
  const [chartCashBalance, setChartCashBalance] = useState<number>(0);
  const [loadingChart, setLoadingChart] = useState(false);

  type PlInvoiceRow = { invoice_amount: number; client?: { client_type: ClientType; branch_id: string | null } | null };
  type PlExpenseRow = {
    amount: number;
    pl_category: "cost_of_services" | "operating_expense";
    client_id?: string | null;
    client?: { branch_id: string | null } | null;
    category?: { name: string } | null;
  };
  type PlPayslipRow = {
    final_salary: number;
    employee?: { branch_id: string | null; category: "client" | "office_staff" | "reliever" } | null;
  };
  const [plPeriod, setPlPeriod] = useState<string>(previousMonthKey());
  const [plInvoices, setPlInvoices] = useState<PlInvoiceRow[]>([]);
  const [plPayslips, setPlPayslips] = useState<PlPayslipRow[]>([]);
  const [plExpenses, setPlExpenses] = useState<PlExpenseRow[]>([]);
  const [loadingPl, setLoadingPl] = useState(false);

  const [statementPeriod, setStatementPeriod] = useState<string>(previousMonthKey());

  // ----- Partnership tab state -----
  const [partners, setPartners] = useState<Partner[]>([]);
  // Company remuneration basis — 0232 dropped partners.basis, so the label
  // below is one company-wide setting rather than a per-partner field.
  const [companyBasis, setCompanyBasis] = useState<"cash" | "revenue" | null>(null);
  const [partnershipPeriod, setPartnershipPeriod] = useState<string>(previousMonthKey());
  const [loadingPartnership, setLoadingPartnership] = useState(false);
  const [partnerError, setPartnerError] = useState<string | null>(null);

  // Add / edit partner dialog, and the per-partner drawer the pencil opens.
  // Both own their own form state — the page no longer keeps a dozen loose
  // new*/edit* fields for an inline form that no longer exists.
  const [isPartnerFormOpen, setIsPartnerFormOpen] = useState(false);
  const [formPartner, setFormPartner] = useState<Partner | null>(null);
  const [detailPartner, setDetailPartner] = useState<Partner | null>(null);

  const chartPeriodOptions = useMemo(() => {
    const opts: string[] = [];
    const d = new Date();
    d.setDate(1);
    for (let i = 0; i < 12; i += 1) {
      opts.push(monthKeyFromDate(d));
      d.setMonth(d.getMonth() - 1);
    }
    return opts;
  }, []);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("branches")
        .select("*")
        .order("is_head_office", { ascending: false })
        .order("name");
      setBranches((data ?? []) as Branch[]);
    })();
  }, []);

  useEffect(() => {
    const loadChart = async () => {
      setLoadingChart(true);
      const start = firstOfMonth(chartPeriod);
      const end = lastOfMonth(chartPeriod);
      const [invRes, expRes, catRes, bankRes, treaRes] = await Promise.all([
        supabase
          .from("invoices")
          .select("id, invoice_amount, invoice_date, period_start")
          .or(invoicePeriodFilter(start, end)),
        supabase
          .from("expenses")
          .select("*")
          .gte("expense_date", start)
          .lte("expense_date", end),
        supabase.from("expense_categories").select("*"),
        supabase.from("bank_accounts").select("id, balance"),
        supabase.from("treasury").select("cash_balance").limit(1).maybeSingle(),
      ]);
      setChartInvoices((invRes.data ?? []) as Invoice[]);
      setChartExpenses((expRes.data ?? []) as Expense[]);
      setChartCategories((catRes.data ?? []) as ExpenseCategory[]);
      setChartBanks((bankRes.data ?? []) as BankAccount[]);
      setChartCashBalance(Number(treaRes.data?.cash_balance ?? 0));
      setLoadingChart(false);
    };
    loadChart();
  }, [chartPeriod]);

  const chartFigures = useMemo(() => {
    const weaponsCatId = chartCategories.find((c) => c.name === "Weapons & Ammunition")?.id ?? null;
    const uniformCatId = chartCategories.find((c) => c.name === "Uniform")?.id ?? null;

    let weaponsTotal = 0;
    let uniformTotal = 0;
    let expensesTotal = 0;
    let currentLiabilities = 0;
    for (const ex of chartExpenses) {
      const amt = Number(ex.amount);
      expensesTotal += amt;
      if (ex.category_id && ex.category_id === weaponsCatId) weaponsTotal += amt;
      if (ex.category_id && ex.category_id === uniformCatId) uniformTotal += amt;
      if (ex.payment_mode === "Payable" && ex.payable_status === "Pending") {
        currentLiabilities += amt;
      }
    }

    const bankTotal = chartBanks.reduce((s, b) => s + Number(b.balance ?? 0), 0);
    const cashAndBank = chartCashBalance + bankTotal;
    const revenue = chartInvoices.reduce((s, i) => s + Number(i.invoice_amount), 0);

    return {
      weapons: weaponsTotal,
      uniform: uniformTotal,
      cashAndBank,
      cash: chartCashBalance,
      bank: bankTotal,
      currentLiabilities,
      revenue,
      expenses: expensesTotal,
    };
  }, [chartExpenses, chartCategories, chartBanks, chartCashBalance, chartInvoices]);

  useEffect(() => {
    const loadPl = async () => {
      setLoadingPl(true);
      const start = firstOfMonth(plPeriod);
      const end = lastOfMonth(plPeriod);
      const [invRes, psRes, expRes] = await Promise.all([
        supabase
          .from("invoices")
          .select("invoice_amount, invoice_date, period_start, client:client_id(client_type, branch_id)")
          .or(invoicePeriodFilter(start, end)),
        supabase
          .from("payslips")
          .select("final_salary, employee:employee_id(branch_id, category)")
          .eq("period_month", `${plPeriod}-01`),
        supabase
          .from("expenses")
          .select("amount, expense_date, category_id, client_id, pl_category, category:category_id(name), client:client_id(branch_id)")
          .gte("expense_date", start)
          .lte("expense_date", end),
      ]);
      setPlInvoices((invRes.data ?? []) as unknown as PlInvoiceRow[]);
      setPlPayslips((psRes.data ?? []) as unknown as PlPayslipRow[]);
      setPlExpenses((expRes.data ?? []) as unknown as PlExpenseRow[]);
      setLoadingPl(false);
    };
    loadPl();
  }, [plPeriod]);

  const plFigures = useMemo(() => {
    const headOfficeId = branches.find((b) => b.is_head_office)?.id ?? null;
    const isHeadOfficeSelected = plBranchFilter === headOfficeId;
    const branchOk = (bid: string | null | undefined): boolean =>
      plBranchFilter === "all" ? true : bid === plBranchFilter;

    // --- Revenue ---
    let securityRevenue = 0;
    let guardRevenue = 0;
    for (const i of plInvoices) {
      if (!branchOk(i.client?.branch_id)) continue;
      const t = (i.client?.client_type ?? "security_services") as ClientType;
      const amt = Number(i.invoice_amount);
      if (t === "guard_deployment") guardRevenue += amt;
      else securityRevenue += amt;
    }
    const totalRevenue = securityRevenue + guardRevenue;

    // --- Payroll: split by employee category ---
    // Guards/relievers are deployed → Cost of Services.
    // Office staff are non-billable → Operating Expense.
    let guardPayroll = 0;
    let officePayroll = 0;
    for (const p of plPayslips) {
      if (!branchOk(p.employee?.branch_id)) continue;
      const amt = Number(p.final_salary);
      if (p.employee?.category === "office_staff") officePayroll += amt;
      else guardPayroll += amt;
    }

    // --- Expenses: split by pl_category (with named buckets for the well-known
    // hardcoded categories so the report keeps showing the same line items). ---
    let cosStatutory = 0;     // EOBI + IESSI + PESSI billed by company
    let cosTransport = 0;     // Transportation & Fuel
    let cosEquipment = 0;     // Equipment & Supplies
    let cosOther = 0;         // any other COS expense
    let opUtilities = 0;
    let opInsurance = 0;
    let opLicenses = 0;
    let opOther = 0;
    let taxes = 0;
    for (const e of plExpenses) {
      // Office expenses (no client) belong to Head Office. So they count under
      // "All Branches" AND under "Head Office", but not under any other branch.
      if (plBranchFilter !== "all") {
        if (!e.client_id) {
          if (!isHeadOfficeSelected) continue;
        } else if (e.client?.branch_id !== plBranchFilter) {
          continue;
        }
      }
      const name = e.category?.name ?? "";
      const amt = Number(e.amount);

      // Item 8: the well-known hardcoded categories map to a fixed P&L line by
      // NAME, regardless of the pl_category stored on the expense (the form
      // defaults to operating_expense, which previously dumped CoS categories
      // like Transportation/Equipment into "Other Operating Expenses" so their
      // named line showed nothing). Only genuinely custom categories fall back
      // to the user-chosen pl_category.
      if (name === "Taxes") { taxes += amt; continue; }
      if (name === "Equipment & Supplies") { cosEquipment += amt; continue; }
      if (name === "Transportation & Fuel") { cosTransport += amt; continue; }
      if (name === "EOBI" || name === "IESSI" || name === "PESSI") { cosStatutory += amt; continue; }
      if (name === "Weapons & Ammunition" || name === "Uniform") { cosOther += amt; continue; }
      if (name === "Utilities & Rent") { opUtilities += amt; continue; }
      if (name === "Insurance") { opInsurance += amt; continue; }
      if (name === "Licenses") { opLicenses += amt; continue; }

      if (e.pl_category === "cost_of_services") cosOther += amt;
      else opOther += amt;
    }

    const totalCos =
      guardPayroll + cosStatutory + cosTransport + cosEquipment + cosOther;
    const grossProfit = totalRevenue - totalCos;
    const totalOpex = officePayroll + opUtilities + opInsurance + opLicenses + opOther;
    const operatingProfit = grossProfit - totalOpex;
    // No "Other Income / (Expenses)" line yet — EBT == Operating Profit.
    const ebt = operatingProfit;
    const netProfit = ebt - taxes;

    return {
      securityRevenue,
      guardRevenue,
      totalRevenue,
      guardPayroll,
      cosStatutory,
      cosTransport,
      cosEquipment,
      cosOther,
      totalCos,
      grossProfit,
      officePayroll,
      opUtilities,
      opInsurance,
      opLicenses,
      opOther,
      totalOpex,
      operatingProfit,
      ebt,
      taxes,
      netProfit,
    };
  }, [plInvoices, plPayslips, plExpenses, plBranchFilter, branches]);

  useEffect(() => {
    const loadClientData = async () => {
      setLoadingClients(true);
      const start = firstOfMonth(statementPeriod);
      const end = lastOfMonth(statementPeriod);
      const [cliRes, invRes, psRes, empRes, expRes, costRes, loadedRes] = await Promise.all([
        supabase.from("clients").select("*").order("name"),
        supabase.from("invoices").select("*").or(invoicePeriodFilter(start, end)),
        supabase.from("payslips").select("*").eq("period_month", `${statementPeriod}-01`),
        supabase
          .from("employees")
          .select(
            "id, client_id, full_name, employee_code, base_salary, per_day_salary, shift, status, location_id, department, join_date, phone, bank_account, created_at, updated_at"
          ),
        supabase.from("expenses").select("*").gte("expense_date", start).lte("expense_date", end),
        // Payroll cost split across the clients each guard actually worked for
        // that month (migration 0155). A guard who transferred mid-month lands
        // partly on each client instead of wholly on whoever they're posted to
        // now — which is what the old employees.client_id grouping did.
        supabase.rpc("payroll_cost_by_client", { p_period_month: `${statementPeriod}-01` }),
        // Revenue basis: this is the Financial Reports twin of the cash-basis
        // statement on the Cash Flow page.
        supabase.rpc("client_statement_loaded", { p_start: start, p_end: end, p_basis: "revenue" }),
      ]);
      setClients((cliRes.data ?? []) as Client[]);
      setInvoices((invRes.data ?? []) as Invoice[]);
      setPayslips((psRes.data ?? []) as Payslip[]);
      setEmployees((empRes.data ?? []) as Employee[]);
      setExpenses((expRes.data ?? []) as Expense[]);
      const costMap = new Map<string, number>();
      for (const r of ((costRes.data ?? []) as { client_id: string; cost: number }[])) {
        costMap.set(r.client_id, Number(r.cost) || 0);
      }
      setPayrollByClient(costMap);
      setLoadedStatements((loadedRes.data ?? []) as LoadedStatement[]);
      setLoadingClients(false);
    };
    loadClientData();
  }, [statementPeriod]);

  // Every figure but the invoice list now comes from client_statement_loaded,
  // which carries regional and head-office cost down to the client. Computing
  // it here would mean re-deriving an apportionment that the Partnership Report
  // already derives in SQL, and the two would drift.
  const clientStatementRows: ClientStatementRow[] = useMemo(() => {
    const filteredClients = statementBranchFilter === "all"
      ? clients
      : clients.filter((c) => c.branch_id === statementBranchFilter);
    const byId = new Map(loadedStatements.map((r) => [r.client_id, r]));

    return filteredClients.map((c) => {
      const clientInvoices = invoices.filter((i) => i.client_id === c.id);
      const l = byId.get(c.id);
      const total_invoiced = Number(l?.revenue ?? 0);
      // Days-weighted share of every payslip that touched this client, so a
      // mid-month transfer bills each client for the days it actually got.
      const payroll_expense = Number(l?.direct_payroll ?? 0);
      const expense_sum = Number(l?.direct_expenses ?? 0);
      const regional_overhead = Number(l?.regional_overhead ?? 0);
      const ho_share = Number(l?.ho_share ?? 0);

      return {
        ...c,
        total_invoiced,
        payroll_expense,
        expenses: expense_sum,
        regional_overhead,
        ho_share,
        total_income: Number(l?.net ?? 0),
        invoices: clientInvoices.sort((a, b) => (a.invoice_date < b.invoice_date ? 1 : -1)),
      };
    });
  }, [clients, invoices, loadedStatements, statementBranchFilter]);

  const statementTotals = useMemo(() => {
    let invoiced = 0;
    let payroll = 0;
    let exp = 0;
    let regional = 0;
    let ho = 0;
    let income = 0;
    for (const r of clientStatementRows) {
      invoiced += r.total_invoiced;
      payroll += r.payroll_expense;
      exp += r.expenses;
      regional += r.regional_overhead;
      ho += r.ho_share;
      income += r.total_income;
    }
    return { invoiced, payroll, expenses: exp, regional, ho, income };
  }, [clientStatementRows]);

  const viewFullStatement = (client: ClientStatementRow) => {
    setSelectedClient(client);
    setIsClientStatementModalOpen(true);
  };

  const viewInvoiceAttachment = (path: string) => {
    const { data } = supabase.storage.from(INVOICE_ATTACHMENTS_BUCKET).getPublicUrl(path);
    if (data?.publicUrl) window.open(data.publicUrl, "_blank");
  };

  // -------- Partnership: data load + monthly computations --------
  const loadPartnership = async () => {
    setLoadingPartnership(true);
    setPartnerError(null);
    // The report is the partner list and their shares, nothing more — no
    // all-time invoice/payslip/expense scans, no partner bank transactions.
    const pRes = await supabase.from("partners").select("*").order("name");
    setPartners((pRes.data ?? []) as Partner[]);
    supabase.from("finance_settings").select("partner_remuneration_basis").maybeSingle()
      .then(({ data }) => setCompanyBasis(((data as { partner_remuneration_basis?: string } | null)
        ?.partner_remuneration_basis ?? null) as "cash" | "revenue" | null));
    setLoadingPartnership(false);
  };

  useEffect(() => {
    if (activeTab === "partnership") loadPartnership();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Shares are only comparable WITHIN a tier: equity shares divide the residual
  // pool, a region's shares divide that region's profit. Summing all partners
  // together — which is what this used to do — capped a company at 100% across
  // two independent pools and blocked legitimate additions.
  const equityShareTotal = useMemo(
    () => partners.filter((p) => p.scope !== "BRANCH").reduce((s, p) => s + Number(p.profit_share_percent), 0),
    [partners],
  );
  const handleDeletePartner = async (p: Partner) => {
    if (!window.confirm(`Delete ${p.name}? Their ledger entries and any per-client share overrides go with them.`)) return;
    const { error: delErr } = await supabase.from("partners").delete().eq("id", p.id);
    if (delErr) { setPartnerError(delErr.message); return; }
    await loadPartnership();
  };

  // Rendered inside the Client Statements filter row, in the same slot the
  // cash-basis statement puts it — not in the page Header, which still carries
  // the P&L and Partnership exports.
  const clientStatementExportBtn = (
    <ExportButton
      onExport={() =>
        exportClientStatements(
          clientStatementRows.map((r) => ({
            client: `${r.name} (${r.client_code})`,
            totalReceivable: r.total_invoiced,
            payrollExpenses: r.payroll_expense,
            // Direct plus both apportioned layers, so the exported
            // columns still add up to netIncome.
            otherExpenses: r.expenses + r.regional_overhead + r.ho_share,
            netIncome: r.total_income,
          })),
          formatPeriod(statementPeriod),
          `Client Statement ${formatPeriod(statementPeriod)}.xlsx`,
        )
      }
    />
  );

  return (
    <>
      <Header
        title={
          partnershipOnly ? "Partnership Report" : (
          <span className="inline-flex items-center gap-4">
            Financial Reports
            {/* Basis toggle — compact segmented control (white active thumb on a
                grey track), vertically centered beside the heading. Revenue Basis =
                accrual Financial Report, Cash Basis = Cash Flow. */}
            <span className="inline-flex items-center rounded-lg bg-slate-100 p-0.5">
              {([
                { key: "financial", label: "Revenue Basis" },
                { key: "cashflow", label: "Cash Basis" },
              ] as const).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => { setTopTab(t.key); if (t.key === "cashflow") setCashflowOpened(true); }}
                  className={`px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                    topTab === t.key
                      ? "bg-white text-brand-700 shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </span>
          </span>
          )
        }
        subtitle={partnershipOnly
          ? "Regional and equity partner allocation, and each partner's running account"
          : "P&L, client statements and cash flow"}
        actions={
          topTab === "cashflow" || activeTab === "rmd" || activeTab === "clients" ? undefined : (
          <ExportButton
            onExport={() => {
              if (activeTab === "pl") {
                exportProfitLoss(
                  {
                    securityRevenue: plFigures.securityRevenue,
                    guardRevenue: plFigures.guardRevenue,
                    totalRevenue: plFigures.totalRevenue,
                    guardPayroll: plFigures.guardPayroll,
                    cosStatutory: plFigures.cosStatutory,
                    cosTransport: plFigures.cosTransport,
                    cosEquipment: plFigures.cosEquipment,
                    cosOther: plFigures.cosOther,
                    totalCos: plFigures.totalCos,
                    grossProfit: plFigures.grossProfit,
                    officePayroll: plFigures.officePayroll,
                    opUtilities: plFigures.opUtilities,
                    opInsurance: plFigures.opInsurance,
                    opLicenses: plFigures.opLicenses,
                    opOther: plFigures.opOther,
                    totalOpex: plFigures.totalOpex,
                    operatingProfit: plFigures.operatingProfit,
                    ebt: plFigures.ebt,
                    taxes: plFigures.taxes,
                    netProfit: plFigures.netProfit,
                  },
                  formatPeriod(plPeriod),
                  `P&L ${formatPeriod(plPeriod)}.xlsx`
                );
              } else if (activeTab === "partnership") {
                exportTable({
                  fileName: `Partnership Report ${formatPeriod(partnershipPeriod)}.xlsx`,
                  sheetName: "Partnership",
                  title: `Partnership Report — ${formatPeriod(partnershipPeriod)}`,
                  headers: ["Partner", "Kind", "Profit Share %"],
                  rows: partners.map((p) => [
                    p.name,
                    p.scope === "BRANCH"
                      ? `Regional · ${branches.find((b) => b.id === p.branch_id)?.name ?? "no region"}`
                      : "Equity",
                    Number(p.profit_share_percent),
                  ]),
                });
              }
            }}
          />
          )
        }
      />

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
        {/* Mounted once opened, then just hidden on other tabs so it keeps its
            loaded data instead of re-fetching on every return to Cash Basis. */}
        {cashflowOpened && (
          <div className={topTab === "cashflow" ? undefined : "hidden"}>
            <Cashflow embedded />
          </div>
        )}

        {topTab === "financial" && (
        <div className="bg-white rounded-lg border border-slate-200">
          {/* One report, no tab strip to choose from, when this is the standalone
              Partnership Report page. */}
          <div className={`p-4 md:p-6 border-b border-slate-200 overflow-x-auto${partnershipOnly ? " hidden" : ""}`}>
            <div className="flex gap-2 min-w-max">
              {/* Partnership Report has its own page under Finance now, so it is
                  no longer a tab here — this component still renders it, but only
                  in `standalone` mode (see the top of the file). RMD Statements
                  stays hidden: its tab-content block below remains, just not
                  reachable from the tab bar. */}
              {([
                { key: "pl", label: "Profit & Loss" },
                { key: "clients", label: "Client Statements" },
              ] as const).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2 rounded-md text-sm whitespace-nowrap transition-colors ${activeTab === tab.key
                      ? "bg-brand-600 text-[#fff]"
                      : "text-slate-600 hover:bg-slate-100"
                    }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {activeTab === "pl" && (
            <div className="p-6">
              <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-lg text-slate-900 mb-1">Profit & Loss Statement</h3>
                  <p className="text-sm text-slate-500">
                    For {formatPeriod(plPeriod)} ({firstOfMonth(plPeriod)} – {lastOfMonth(plPeriod)})
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="text-sm text-slate-600">Branch:</label>
                  <ThemedSelect
                    value={plBranchFilter}
                    onChange={(e) => setPlBranchFilter(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    <option value="all">All Branches</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </ThemedSelect>
                  <label className="text-sm text-slate-600">Month:</label>
                  <ThemedSelect
                    value={plPeriod}
                    onChange={(e) => setPlPeriod(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    {chartPeriodOptions.map((p) => (
                      <option key={p} value={p}>
                        {formatPeriod(p)}
                      </option>
                    ))}
                  </ThemedSelect>
                </div>
              </div>

              {loadingPl ? (
                <div className="py-12 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Revenue */}
                  <div>
                    <h4 className="text-sm text-slate-900 mb-3 pb-2 border-b border-slate-200">Revenue</h4>
                    <div className="space-y-2 mb-3">
                      <div className="flex justify-between items-center pl-4">
                        <span className="text-sm text-slate-600">Security Services Revenue</span>
                        <span className="text-sm text-success-600">
                          PKR {plFigures.securityRevenue.toLocaleString()}
                        </span>
                      </div>
                      <div className="flex justify-between items-center pl-4">
                        <span className="text-sm text-slate-600">Guard Deployment Revenue</span>
                        <span className="text-sm text-success-600">
                          PKR {plFigures.guardRevenue.toLocaleString()}
                        </span>
                      </div>
                    </div>
                    <div className="flex justify-between items-center pl-4 pt-2 border-t border-slate-200">
                      <span className="text-sm text-slate-900">Total Revenue</span>
                      <span className="text-sm text-success-600">
                        PKR {plFigures.totalRevenue.toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {/* Cost of Services */}
                  <div>
                    <h4 className="text-sm text-slate-900 mb-3 pb-2 border-b border-slate-200">Cost of Services</h4>
                    <div className="space-y-2 mb-3">
                      {[
                        { name: "Guard Payroll & Salaries", amount: plFigures.guardPayroll },
                        { name: "Guard Statutory (EOBI / IESSI / PESSI)", amount: plFigures.cosStatutory },
                        { name: "Transportation & Fuel", amount: plFigures.cosTransport },
                        { name: "Equipment & Supplies", amount: plFigures.cosEquipment },
                        { name: "Other Cost of Services", amount: plFigures.cosOther },
                      ].map((item) => (
                        <div key={item.name} className="flex justify-between items-center pl-4">
                          <span className="text-sm text-slate-600">{item.name}</span>
                          <span className="text-sm text-danger-600">
                            PKR {item.amount.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between items-center pl-4 pt-2 border-t border-slate-200">
                      <span className="text-sm text-slate-900">Total Cost of Services</span>
                      <span className="text-sm text-danger-600">
                        PKR {plFigures.totalCos.toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {/* Gross Profit */}
                  <div className="pt-4 border-t-2 border-slate-300">
                    <div className="flex justify-between items-center">
                      <span className="text-base text-slate-900">{plFigures.grossProfit < 0 ? "Gross Loss" : "Gross Profit"}</span>
                      <span
                        className={`text-lg ${plFigures.grossProfit >= 0 ? "text-success-600" : "text-danger-600"}`}
                      >
                        PKR {Math.abs(plFigures.grossProfit).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {/* Operating Expenses */}
                  <div>
                    <h4 className="text-sm text-slate-900 mb-3 pb-2 border-b border-slate-200">Operating Expenses</h4>
                    <div className="space-y-2 mb-3">
                      {[
                        { name: "Office Salaries (non-billable staff)", amount: plFigures.officePayroll },
                        { name: "Utilities & Rent (HQ)", amount: plFigures.opUtilities },
                        { name: "Insurance", amount: plFigures.opInsurance },
                        { name: "Licences (company-level)", amount: plFigures.opLicenses },
                        { name: "Other Operating Expenses", amount: plFigures.opOther },
                      ].map((item) => (
                        <div key={item.name} className="flex justify-between items-center pl-4">
                          <span className="text-sm text-slate-600">{item.name}</span>
                          <span className="text-sm text-danger-600">
                            PKR {item.amount.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between items-center pl-4 pt-2 border-t border-slate-200">
                      <span className="text-sm text-slate-900">Total Operating Expenses</span>
                      <span className="text-sm text-danger-600">
                        PKR {plFigures.totalOpex.toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {/* Operating Profit */}
                  <div className="pt-4 border-t-2 border-slate-300">
                    <div className="flex justify-between items-center">
                      <span className="text-base text-slate-900">{plFigures.operatingProfit < 0 ? "Operating Loss" : "Operating Profit"}</span>
                      <span
                        className={`text-lg ${plFigures.operatingProfit >= 0 ? "text-success-600" : "text-danger-600"}`}
                      >
                        PKR {Math.abs(plFigures.operatingProfit).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {/* EBT / Tax / Net */}
                  <div className="pt-2 space-y-2">
                    <div className="flex justify-between items-center pl-4">
                      <span className="text-sm text-slate-600">Earnings Before Tax (EBT)</span>
                      <span className={`text-sm ${plFigures.ebt >= 0 ? "text-slate-900" : "text-danger-600"}`}>
                        PKR {plFigures.ebt.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between items-center pl-4">
                      <span className="text-sm text-slate-600">Income Tax</span>
                      <span className="text-sm text-danger-600">
                        PKR {plFigures.taxes.toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <div className="pt-4 border-t-2 border-slate-300">
                    <div className="flex justify-between items-center">
                      <span className="text-base text-slate-900">Net Profit</span>
                      <span
                        className={`text-xl ${plFigures.netProfit >= 0 ? "text-success-600" : "text-danger-600"}`}
                      >
                        PKR {plFigures.netProfit.toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "clients" && (
            <div>
              {/* Deliberately the same header shape as the cash-basis statement
                  in CashFlow's ClientStatementsTab: basis-named heading and
                  period on the left, Branch → Month → Export on the right, note
                  underneath. Switching basis must never move a control. */}
              <div className="p-6 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-lg text-slate-900 mb-1">Client Statements — Revenue Basis</h3>
                  <p className="text-sm text-slate-500">
                    For {formatPeriod(statementPeriod)} ({firstOfMonth(statementPeriod)} – {lastOfMonth(statementPeriod)})
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="text-sm text-slate-600">Branch:</label>
                  <ThemedSelect
                    value={statementBranchFilter}
                    onChange={(e) => setStatementBranchFilter(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    <option value="all">All Branches</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </ThemedSelect>
                  <label className="text-sm text-slate-600">Month:</label>
                  <ThemedSelect
                    value={statementPeriod}
                    onChange={(e) => setStatementPeriod(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    {chartPeriodOptions.map((p) => (
                      <option key={p} value={p}>
                        {formatPeriod(p)}
                      </option>
                    ))}
                  </ThemedSelect>
                  {clientStatementExportBtn}
                </div>
                <span className="text-xs text-slate-500">
                  Total Income = Invoiced − (Payroll + Direct Expenses + Regional Overhead + Head Office).
                  Overhead is apportioned pro-rata by revenue.
                </span>
              </div>

              <div className="p-4 grid grid-cols-2 md:grid-cols-6 gap-3 border-b border-slate-200">
                <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-brand-500">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total Invoiced</p>
                  <p className="text-lg text-brand-900">
                    PKR {statementTotals.invoiced.toLocaleString()}
                  </p>
                </div>
                <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-danger-500">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Payroll Expense</p>
                  <p className="text-lg text-danger-900">
                    PKR {statementTotals.payroll.toLocaleString()}
                  </p>
                </div>
                <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-danger-500">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Direct Expenses</p>
                  <p className="text-lg text-danger-900">
                    PKR {statementTotals.expenses.toLocaleString()}
                  </p>
                </div>
                <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-slate-400">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Regional Overhead</p>
                  <p className="text-lg text-slate-700">
                    PKR {Math.round(statementTotals.regional).toLocaleString()}
                  </p>
                </div>
                <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-slate-400">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Head Office</p>
                  <p className="text-lg text-slate-700">
                    PKR {Math.round(statementTotals.ho).toLocaleString()}
                  </p>
                </div>
                <div
                  className={`p-3 rounded-lg border ${
                    statementTotals.income >= 0
                      ? "bg-success-50 border-success-200"
                      : "bg-danger-50 border-danger-200"
                  }`}
                >
                  <p
                    className={`text-xs mb-1 ${
                      statementTotals.income >= 0 ? "text-success-700" : "text-danger-700"
                    }`}
                  >
                    Total Income
                  </p>
                  <p
                    className={`text-lg ${
                      statementTotals.income >= 0 ? "text-success-900" : "text-danger-900"
                    }`}
                  >
                    PKR {statementTotals.income.toLocaleString()}
                  </p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
                      <th className="text-right px-6 py-3 text-sm text-slate-500">Total Invoiced</th>
                      <th className="text-right px-6 py-3 text-sm text-slate-500">Payroll Expense</th>
                      <th className="text-right px-6 py-3 text-sm text-slate-500">Direct Expenses</th>
                      <th className="text-right px-6 py-3 text-sm text-slate-500">Regional Overhead</th>
                      <th className="text-right px-6 py-3 text-sm text-slate-500">Total Income</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {loadingClients && (
                      <tr>
                        <td colSpan={7} className="px-6 py-10 text-center text-slate-500">
                          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                        </td>
                      </tr>
                    )}
                    {!loadingClients && clientStatementRows.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">
                          No clients yet.
                        </td>
                      </tr>
                    )}
                    {!loadingClients &&
                      clientStatementRows.map((client) => (
                        <tr key={client.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-6 py-4 text-sm text-slate-900">
                            <div>{client.name}</div>
                            <div className="text-xs text-slate-500 font-mono">{client.client_code}</div>
                          </td>
                          <td className="px-6 py-4 text-sm text-brand-600 text-right">
                            PKR {client.total_invoiced.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-sm text-danger-600 text-right">
                            PKR {client.payroll_expense.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-sm text-danger-600 text-right">
                            PKR {client.expenses.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-500 text-right">
                            PKR {Math.round(client.regional_overhead).toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-sm text-right">
                            <span className={client.total_income >= 0 ? "text-success-600" : "text-danger-600"}>
                              PKR {client.total_income.toLocaleString()}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <button
                              className="text-sm text-brand-600 hover:text-brand-700"
                              onClick={() => viewFullStatement(client)}
                            >
                              View Full Statement
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === "partnership" && (
            <div className="p-6">
              <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-lg text-slate-900 mb-1">Partnership Report</h3>
                  <p className="text-sm text-slate-500">
                    For {formatPeriod(partnershipPeriod)} · Equity shares allocated:{" "}
                    <span className={equityShareTotal > 100 ? "text-danger-600" : "text-slate-900"}>
                      {equityShareTotal}%
                    </span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-slate-600">Month:</label>
                  <ThemedSelect
                    value={partnershipPeriod}
                    onChange={(e) => setPartnershipPeriod(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    {chartPeriodOptions.map((p) => (
                      <option key={p} value={p}>{formatPeriod(p)}</option>
                    ))}
                  </ThemedSelect>
                </div>
              </div>

              {partnerError && (
                <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-4 py-2 rounded mb-4">{partnerError}</div>
              )}

              <div className="mb-6 flex justify-end">
                <Button variant="primary" size="md" onClick={() => { setFormPartner(null); setIsPartnerFormOpen(true); }}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add Partner
                </Button>
              </div>


              <div className="overflow-x-auto">
                {loadingPartnership ? (
                  <div className="py-12 text-center text-slate-500">
                    <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                  </div>
                ) : partners.length === 0 ? (
                  <div className="py-12 text-center text-slate-500 text-sm">
                    No partners yet. Add the first one above.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-slate-200">
                          <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Partner</th>
                          <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Profit Share</th>
                          <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {partners.map((p) => (
                          <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                            <td className="px-4 py-3 text-sm text-slate-900">
                              {p.name}
                              {p.opening_balance_locked && (
                                <Lock className="w-3 h-3 text-slate-400 inline-block ml-2" />
                              )}
                              {/* Which tier the share belongs to — without this the
                                  Profit Share column reads as one pool when it is
                                  really two. */}
                              <div className="text-[11px] text-slate-500 mt-0.5">
                                {p.scope === "BRANCH"
                                  ? `Regional · ${branches.find((b) => b.id === p.branch_id)?.name ?? "no region"}`
                                  : "Equity"}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-sm text-right">
                              <span className="text-brand-600">{Number(p.profit_share_percent)}%</span>
                              {p.scope === "BRANCH" && companyBasis && (
                                <div className="text-[10px] text-slate-500">
                                  of {companyBasis === "cash" ? "Net Cash" : "Total Income"}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex gap-1 justify-end">
                                {/* The pencil opens the partner's drawer: what each
                                    client contributes, and their running ledger. */}
                                <button
                                  onClick={() => setDetailPartner(p)}
                                  className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
                                  title="Client breakdown (view) & ledger (record payments)"
                                >
                                  <BookOpen className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => { setFormPartner(p); setIsPartnerFormOpen(true); }}
                                  className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
                                  title="Edit client shares (partner details locked)"
                                >
                                  <Settings2 className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => handleDeletePartner(p)}
                                  className="p-1.5 rounded text-danger-600 hover:bg-danger-50"
                                  title="Delete"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div className="bg-slate-50 border border-slate-200 p-3 rounded">
                  <p className="text-slate-500 text-xs mb-1">Equity share allocated</p>
                  <p className={`text-lg ${equityShareTotal > 100 ? "text-danger-600" : "text-slate-900"}`}>{equityShareTotal}%</p>
                </div>
                <div className="bg-slate-50 border border-slate-200 p-3 rounded">
                  <p className="text-slate-500 text-xs mb-1">Partners</p>
                  <p className="text-lg text-slate-900">{partners.length}</p>
                </div>
              </div>

              <p className="mt-4 text-xs text-slate-500">
                Equity shares divide the company-wide residual; a regional partner's share divides
                their own region. The two are separate pools, so they are not summed together.
              </p>
            </div>
          )}

          {activeTab === "rmd" && (
            <div className="p-4 md:p-6">
              <Partners embedded />
            </div>
          )}
        </div>
        )}
      </div>

      <PartnerFormModal
        isOpen={isPartnerFormOpen}
        partner={formPartner}
        branches={branches}
        equityShareTotal={equityShareTotal}
        period={partnershipPeriod}
        regionName={formPartner?.branch_id
          ? branches.find((b) => b.id === formPartner.branch_id)?.name ?? null
          : null}
        onClose={() => setIsPartnerFormOpen(false)}
        onSaved={() => { setIsPartnerFormOpen(false); setFormPartner(null); loadPartnership(); }}
        onChanged={() => loadPartnership()}
      />

      <PartnerDetailModal
        isOpen={detailPartner !== null}
        partner={detailPartner}
        period={partnershipPeriod}
        periodOptions={chartPeriodOptions}
        regionName={detailPartner?.branch_id
          ? branches.find((b) => b.id === detailPartner.branch_id)?.name ?? null
          : null}
        onClose={() => setDetailPartner(null)}
        onChanged={() => loadPartnership()}
      />

      <Modal isOpen={isClientStatementModalOpen} onClose={() => setIsClientStatementModalOpen(false)} title="Full Client Statement" size="lg">
        {selectedClient && (
          <div className="space-y-4">
            <div className="pb-4 border-b border-slate-200">
              <h3 className="text-base text-slate-900">{selectedClient.name}</h3>
              <p className="text-xs text-slate-500 font-mono">{selectedClient.client_code}</p>
              <p className="text-xs text-slate-500 mt-1">Month: {formatPeriod(statementPeriod)}</p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-brand-500">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total Invoiced</p>
                <p className="text-lg text-brand-900">PKR {selectedClient.total_invoiced.toLocaleString()}</p>
              </div>
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-danger-500">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Payroll Expense</p>
                <p className="text-lg text-danger-900">PKR {selectedClient.payroll_expense.toLocaleString()}</p>
              </div>
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-danger-500">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Direct Expenses</p>
                <p className="text-lg text-danger-900">PKR {selectedClient.expenses.toLocaleString()}</p>
              </div>
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-slate-400">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Regional Overhead</p>
                <p className="text-lg text-slate-700">PKR {Math.round(selectedClient.regional_overhead).toLocaleString()}</p>
              </div>
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-slate-400">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Head Office</p>
                <p className="text-lg text-slate-700">PKR {Math.round(selectedClient.ho_share).toLocaleString()}</p>
              </div>
              <div className={`p-3 rounded-lg border ${selectedClient.total_income >= 0 ? "bg-success-50 border-success-200" : "bg-danger-50 border-danger-200"}`}>
                <p className={`text-xs mb-1 ${selectedClient.total_income >= 0 ? "text-success-700" : "text-danger-700"}`}>Total Income</p>
                <p className={`text-lg ${selectedClient.total_income >= 0 ? "text-success-900" : "text-danger-900"}`}>
                  PKR {selectedClient.total_income.toLocaleString()}
                </p>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200">
              <h4 className="text-sm text-slate-900 mb-3">Invoices</h4>
              {selectedClient.invoices.length === 0 ? (
                <p className="text-sm text-slate-500">No invoices for this client.</p>
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
              <Button variant="secondary" size="md" onClick={() => setIsClientStatementModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
