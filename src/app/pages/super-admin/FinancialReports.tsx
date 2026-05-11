import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, FileText, Plus, Lock, Trash2, Pencil } from "lucide-react";
import Header from "../../components/Header";
import ExportButton from "../../components/ExportButton";
import {
  exportProfitLoss,
  exportClientStatements,
  exportTable,
} from "../../lib/excel";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import {
  supabase,
  INVOICE_ATTACHMENTS_BUCKET,
  isHardcodedCategory,
  type Client,
  type Invoice,
  type Payslip,
  type Expense,
  type Employee,
  type ExpenseCategory,
  type BankAccount,
  type ClientType,
  type Partner,
  type BankTransaction,
} from "../../lib/supabase";

type ClientStatementRow = Client & {
  total_invoiced: number;
  payroll_expense: number;
  expenses: number;
  total_income: number;
  invoices: Invoice[];
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

export default function FinancialReports() {
  const [activeTab, setActiveTab] = useState<"pl" | "chart" | "clients" | "partnership">("pl");
  const [isClientStatementModalOpen, setIsClientStatementModalOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<ClientStatementRow | null>(null);

  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);

  const [chartPeriod, setChartPeriod] = useState<string>(previousMonthKey());
  const [chartInvoices, setChartInvoices] = useState<Invoice[]>([]);
  const [chartExpenses, setChartExpenses] = useState<Expense[]>([]);
  const [chartCategories, setChartCategories] = useState<ExpenseCategory[]>([]);
  const [chartBanks, setChartBanks] = useState<BankAccount[]>([]);
  const [chartCashBalance, setChartCashBalance] = useState<number>(0);
  const [loadingChart, setLoadingChart] = useState(false);

  type PlInvoiceRow = { invoice_amount: number; client?: { client_type: ClientType } | null };
  type PlExpenseRow = { amount: number; category?: { name: string } | null };
  const [plPeriod, setPlPeriod] = useState<string>(previousMonthKey());
  const [plInvoices, setPlInvoices] = useState<PlInvoiceRow[]>([]);
  const [plPayslips, setPlPayslips] = useState<{ final_salary: number }[]>([]);
  const [plExpenses, setPlExpenses] = useState<PlExpenseRow[]>([]);
  const [loadingPl, setLoadingPl] = useState(false);

  const [statementPeriod, setStatementPeriod] = useState<string>(previousMonthKey());

  // ----- Partnership tab state -----
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnershipPeriod, setPartnershipPeriod] = useState<string>(previousMonthKey());
  const [partnerBanks, setPartnerBanks] = useState<BankAccount[]>([]);
  const [allInvoicesForPl, setAllInvoicesForPl] = useState<{ invoice_date: string; invoice_amount: number; client?: { client_type: ClientType } | null }[]>([]);
  const [allPayslipsForPl, setAllPayslipsForPl] = useState<{ period_month: string; final_salary: number }[]>([]);
  const [allExpensesForPl, setAllExpensesForPl] = useState<{ expense_date: string; amount: number }[]>([]);
  const [allPartnerTxns, setAllPartnerTxns] = useState<BankTransaction[]>([]);
  const [loadingPartnership, setLoadingPartnership] = useState(false);
  const [partnerError, setPartnerError] = useState<string | null>(null);

  const [newPartnerName, setNewPartnerName] = useState("");
  const [newPartnerShare, setNewPartnerShare] = useState("");
  const [newPartnerOpening, setNewPartnerOpening] = useState("");
  const [partnerSubmitting, setPartnerSubmitting] = useState(false);

  const [editPartnerId, setEditPartnerId] = useState<string | null>(null);
  const [editPartnerShare, setEditPartnerShare] = useState("");
  const [editPartnerOpening, setEditPartnerOpening] = useState("");

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
    const loadChart = async () => {
      setLoadingChart(true);
      const start = firstOfMonth(chartPeriod);
      const end = lastOfMonth(chartPeriod);
      const [invRes, expRes, catRes, bankRes, treaRes] = await Promise.all([
        supabase
          .from("invoices")
          .select("id, invoice_amount, invoice_date")
          .gte("invoice_date", start)
          .lte("invoice_date", end),
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
          .select("invoice_amount, invoice_date, client:client_id(client_type)")
          .gte("invoice_date", start)
          .lte("invoice_date", end),
        supabase
          .from("payslips")
          .select("final_salary")
          .eq("period_month", `${plPeriod}-01`),
        supabase
          .from("expenses")
          .select("amount, expense_date, category_id, category:category_id(name)")
          .gte("expense_date", start)
          .lte("expense_date", end),
      ]);
      setPlInvoices((invRes.data ?? []) as unknown as PlInvoiceRow[]);
      setPlPayslips((psRes.data ?? []) as { final_salary: number }[]);
      setPlExpenses((expRes.data ?? []) as unknown as PlExpenseRow[]);
      setLoadingPl(false);
    };
    loadPl();
  }, [plPeriod]);

  const plFigures = useMemo(() => {
    let securityRevenue = 0;
    let guardRevenue = 0;
    for (const i of plInvoices) {
      const t = (i.client?.client_type ?? "security_services") as ClientType;
      const amt = Number(i.invoice_amount);
      if (t === "guard_deployment") guardRevenue += amt;
      else securityRevenue += amt;
    }
    const payroll = plPayslips.reduce((s, p) => s + Number(p.final_salary), 0);
    let equipment = 0;
    let transportation = 0;
    let utilities = 0;
    let insurance = 0;
    let licenses = 0;
    let eobi = 0;
    let iessi = 0;
    let pessi = 0;
    let taxes = 0;
    let operating = 0;
    for (const e of plExpenses) {
      const name = e.category?.name ?? "";
      const amt = Number(e.amount);
      if (name === "Equipment & Supplies") equipment += amt;
      else if (name === "Transportation & Fuel") transportation += amt;
      else if (name === "Utilities & Rent") utilities += amt;
      else if (name === "Insurance") insurance += amt;
      else if (name === "Licenses") licenses += amt;
      else if (name === "EOBI") eobi += amt;
      else if (name === "IESSI") iessi += amt;
      else if (name === "PESSI") pessi += amt;
      else if (name === "Taxes") taxes += amt;
      else if (!isHardcodedCategory(name)) operating += amt;
    }
    const totalRevenue = securityRevenue + guardRevenue;
    const totalExpenses =
      payroll + equipment + transportation + utilities + insurance + licenses + eobi + iessi + pessi + operating;
    const grossProfit = totalRevenue - totalExpenses;
    const netProfit = grossProfit - taxes;
    return {
      securityRevenue,
      guardRevenue,
      totalRevenue,
      payroll,
      equipment,
      transportation,
      utilities,
      insurance,
      licenses,
      eobi,
      iessi,
      pessi,
      operating,
      totalExpenses,
      grossProfit,
      taxes,
      netProfit,
    };
  }, [plInvoices, plPayslips, plExpenses]);

  useEffect(() => {
    const loadClientData = async () => {
      setLoadingClients(true);
      const start = firstOfMonth(statementPeriod);
      const end = lastOfMonth(statementPeriod);
      const [cliRes, invRes, psRes, empRes, expRes] = await Promise.all([
        supabase.from("clients").select("*").order("name"),
        supabase.from("invoices").select("*").gte("invoice_date", start).lte("invoice_date", end),
        supabase.from("payslips").select("*").eq("period_month", `${statementPeriod}-01`),
        supabase
          .from("employees")
          .select(
            "id, client_id, full_name, employee_code, base_salary, per_day_salary, shift, status, location_id, department, join_date, phone, bank_account, created_at, updated_at"
          ),
        supabase.from("expenses").select("*").gte("expense_date", start).lte("expense_date", end),
      ]);
      setClients((cliRes.data ?? []) as Client[]);
      setInvoices((invRes.data ?? []) as Invoice[]);
      setPayslips((psRes.data ?? []) as Payslip[]);
      setEmployees((empRes.data ?? []) as Employee[]);
      setExpenses((expRes.data ?? []) as Expense[]);
      setLoadingClients(false);
    };
    loadClientData();
  }, [statementPeriod]);

  const clientStatementRows: ClientStatementRow[] = useMemo(() => {
    const empByClient = new Map<string, Set<string>>();
    for (const e of employees) {
      if (!e.client_id) continue;
      const set = empByClient.get(e.client_id) ?? new Set<string>();
      set.add(e.id);
      empByClient.set(e.client_id, set);
    }

    return clients.map((c) => {
      const clientInvoices = invoices.filter((i) => i.client_id === c.id);
      const total_invoiced = clientInvoices.reduce((s, i) => s + Number(i.invoice_amount), 0);

      const empIds = empByClient.get(c.id) ?? new Set<string>();
      const payroll_expense = payslips
        .filter((p) => empIds.has(p.employee_id))
        .reduce((s, p) => s + Number(p.final_salary), 0);

      let expense_sum = 0;
      for (const ex of expenses) {
        if (ex.client_id !== c.id) continue;
        expense_sum += Number(ex.amount);
      }

      return {
        ...c,
        total_invoiced,
        payroll_expense,
        expenses: expense_sum,
        total_income: total_invoiced - payroll_expense - expense_sum,
        invoices: clientInvoices.sort((a, b) => (a.invoice_date < b.invoice_date ? 1 : -1)),
      };
    });
  }, [clients, invoices, payslips, employees, expenses]);

  const statementTotals = useMemo(() => {
    let invoiced = 0;
    let payroll = 0;
    let exp = 0;
    let income = 0;
    for (const r of clientStatementRows) {
      invoiced += r.total_invoiced;
      payroll += r.payroll_expense;
      exp += r.expenses;
      income += r.total_income;
    }
    return { invoiced, payroll, expenses: exp, income };
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
    const [pRes, bRes, iRes, sRes, eRes] = await Promise.all([
      supabase.from("partners").select("*").order("name"),
      supabase.from("bank_accounts").select("*").eq("owner_type", "partner"),
      supabase.from("invoices").select("invoice_date, invoice_amount, client:client_id(client_type)"),
      supabase.from("payslips").select("period_month, final_salary"),
      supabase.from("expenses").select("expense_date, amount"),
    ]);
    const partnerList = (pRes.data ?? []) as Partner[];
    const partnerAccounts = (bRes.data ?? []) as BankAccount[];
    const partnerAccountIds = partnerAccounts.map((b) => b.id);
    const txRes = partnerAccountIds.length
      ? await supabase.from("bank_transactions").select("*").in("bank_account_id", partnerAccountIds)
      : { data: [] as BankTransaction[] };
    setPartners(partnerList);
    setPartnerBanks(partnerAccounts);
    setAllInvoicesForPl(((iRes.data ?? []) as unknown) as typeof allInvoicesForPl);
    setAllPayslipsForPl((sRes.data ?? []) as typeof allPayslipsForPl);
    setAllExpensesForPl((eRes.data ?? []) as typeof allExpensesForPl);
    setAllPartnerTxns((txRes.data ?? []) as BankTransaction[]);
    setLoadingPartnership(false);
  };

  useEffect(() => {
    if (activeTab === "partnership") loadPartnership();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const bankToPartnerId = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const b of partnerBanks) m.set(b.id, b.owner_partner_id);
    return m;
  }, [partnerBanks]);

  // Monthly net P&L = invoices − payroll − expenses for that month.
  const monthlyPL = (period: string) => {
    const start = firstOfMonth(period);
    const end = lastOfMonth(period);
    const rev = allInvoicesForPl
      .filter((i) => i.invoice_date >= start && i.invoice_date <= end)
      .reduce((s, i) => s + Number(i.invoice_amount), 0);
    const pay = allPayslipsForPl
      .filter((s) => s.period_month >= start && s.period_month <= end)
      .reduce((s, x) => s + Number(x.final_salary), 0);
    const exp = allExpensesForPl
      .filter((e) => e.expense_date >= start && e.expense_date <= end)
      .reduce((s, x) => s + Number(x.amount), 0);
    return rev - pay - exp;
  };

  // Cumulative net P&L through the END of the given period.
  const cumulativePLThrough = (periodEndDate: string) => {
    const rev = allInvoicesForPl
      .filter((i) => i.invoice_date <= periodEndDate)
      .reduce((s, i) => s + Number(i.invoice_amount), 0);
    const pay = allPayslipsForPl
      .filter((s) => s.period_month <= periodEndDate)
      .reduce((s, x) => s + Number(x.final_salary), 0);
    const exp = allExpensesForPl
      .filter((e) => e.expense_date <= periodEndDate)
      .reduce((s, x) => s + Number(x.amount), 0);
    return rev - pay - exp;
  };

  // For a partner, the cumulative transaction impact (sum of -account_delta) through a date.
  const cumulativeTxImpact = (partnerId: string, throughDate: string) => {
    let total = 0;
    for (const tx of allPartnerTxns) {
      if (!tx.bank_account_id) continue;
      const pid = bankToPartnerId.get(tx.bank_account_id);
      if (pid !== partnerId) continue;
      const txDate = (tx.created_at ?? "").slice(0, 10);
      if (txDate <= throughDate) total += -Number(tx.account_delta);
    }
    return total;
  };

  // Same but bounded within a [start, end] window.
  const txImpactInRange = (partnerId: string, start: string, end: string) => {
    let total = 0;
    for (const tx of allPartnerTxns) {
      if (!tx.bank_account_id) continue;
      const pid = bankToPartnerId.get(tx.bank_account_id);
      if (pid !== partnerId) continue;
      const txDate = (tx.created_at ?? "").slice(0, 10);
      if (txDate >= start && txDate <= end) total += -Number(tx.account_delta);
    }
    return total;
  };

  const partnerRows = useMemo(() => {
    const start = firstOfMonth(partnershipPeriod);
    const end = lastOfMonth(partnershipPeriod);
    // Day before start = previous month end
    const prevDay = (() => {
      const d = new Date(start);
      d.setDate(d.getDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    return partners.map((p) => {
      const share = Number(p.profit_share_percent) / 100;
      const openingForMonth =
        Number(p.opening_balance) +
        share * cumulativePLThrough(prevDay) +
        cumulativeTxImpact(p.id, prevDay);
      const profitForMonth = share * monthlyPL(partnershipPeriod);
      const adjustmentsForMonth = txImpactInRange(p.id, start, end);
      const remaining = openingForMonth + profitForMonth + adjustmentsForMonth;
      return {
        partner: p,
        opening: openingForMonth,
        profit: profitForMonth,
        adjustments: adjustmentsForMonth,
        remaining,
      };
    });
  }, [partners, partnershipPeriod, allInvoicesForPl, allPayslipsForPl, allExpensesForPl, allPartnerTxns, bankToPartnerId]);

  const totalShare = useMemo(
    () => partners.reduce((s, p) => s + Number(p.profit_share_percent), 0),
    [partners]
  );

  const handleAddPartner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPartnerName.trim()) return;
    const share = Number(newPartnerShare || 0);
    if (share < 0 || share > 100) {
      setPartnerError("Profit share must be between 0 and 100.");
      return;
    }
    if (totalShare + share > 100) {
      setPartnerError(`Total profit share would exceed 100% (currently ${totalShare}%).`);
      return;
    }
    const opening = Number(newPartnerOpening || 0);
    setPartnerSubmitting(true);
    setPartnerError(null);
    const { error: insErr } = await supabase.from("partners").insert({
      name: newPartnerName.trim(),
      profit_share_percent: share,
      opening_balance: opening,
      opening_balance_locked: opening !== 0,
    });
    setPartnerSubmitting(false);
    if (insErr) {
      setPartnerError(insErr.message);
      return;
    }
    setNewPartnerName("");
    setNewPartnerShare("");
    setNewPartnerOpening("");
    await loadPartnership();
  };

  const handleDeletePartner = async (p: Partner) => {
    if (!window.confirm(`Delete partner "${p.name}"? Any bank accounts owned by them will be left orphaned; reassign or delete those first.`)) return;
    const { error: delErr } = await supabase.from("partners").delete().eq("id", p.id);
    if (delErr) {
      setPartnerError(delErr.message);
      return;
    }
    await loadPartnership();
  };

  const openEditPartner = (p: Partner) => {
    setEditPartnerId(p.id);
    setEditPartnerShare(String(p.profit_share_percent));
    setEditPartnerOpening(p.opening_balance_locked ? "" : String(p.opening_balance));
  };

  const handleSavePartnerEdit = async (p: Partner) => {
    const share = Number(editPartnerShare);
    if (Number.isNaN(share) || share < 0 || share > 100) {
      setPartnerError("Profit share must be between 0 and 100.");
      return;
    }
    const otherShare = totalShare - Number(p.profit_share_percent);
    if (otherShare + share > 100) {
      setPartnerError(`Total profit share would exceed 100% (other partners already use ${otherShare}%).`);
      return;
    }
    const update: Partial<Partner> = { profit_share_percent: share };
    if (!p.opening_balance_locked && editPartnerOpening !== "") {
      update.opening_balance = Number(editPartnerOpening);
      update.opening_balance_locked = true;
    }
    setPartnerError(null);
    const { error: upErr } = await supabase.from("partners").update(update).eq("id", p.id);
    if (upErr) {
      setPartnerError(upErr.message);
      return;
    }
    setEditPartnerId(null);
    await loadPartnership();
  };

  return (
    <>
      <Header
        title="Financial Reports"
        actions={
          <ExportButton
            onExport={() => {
              if (activeTab === "pl") {
                exportProfitLoss(
                  {
                    revenue: plFigures.totalRevenue,
                    payroll: plFigures.payroll,
                    operating: plFigures.operating,
                    equipment: plFigures.equipment,
                    transportation: plFigures.transportation,
                    utilities: plFigures.utilities,
                    insurance: plFigures.insurance,
                    licenses: plFigures.licenses,
                    eobi: plFigures.eobi,
                    iessi: plFigures.iessi,
                    pessi: plFigures.pessi,
                    totalExpenses: plFigures.totalExpenses,
                    total: plFigures.netProfit,
                  },
                  formatPeriod(plPeriod),
                  `P&L ${formatPeriod(plPeriod)}.xlsx`
                );
              } else if (activeTab === "clients") {
                exportClientStatements(
                  clientStatementRows.map((r) => ({
                    client: `${r.name} (${r.client_code})`,
                    totalReceivable: r.total_invoiced,
                    payrollExpenses: r.payroll_expense,
                    otherExpenses: r.expenses,
                    netIncome: r.total_income,
                  })),
                  formatPeriod(statementPeriod),
                  `Client Statement ${formatPeriod(statementPeriod)}.xlsx`
                );
              } else if (activeTab === "chart") {
                exportTable({
                  fileName: `Chart of Accounts ${formatPeriod(chartPeriod)}.xlsx`,
                  sheetName: "Chart of Accounts",
                  title: `Chart of Accounts — ${formatPeriod(chartPeriod)}`,
                  headers: ["Code", "Account Name", "Balance"],
                  rows: [
                    ["1000", "Assets", chartFigures.weapons],
                    ["1100", "Current Assets", chartFigures.uniform + chartFigures.cashAndBank],
                    ["2000", "Liabilities", "None"],
                    ["2100", "Current Liabilities", chartFigures.currentLiabilities],
                    ["3000", "Equity", "To be configured"],
                    ["4000", "Revenue", chartFigures.revenue],
                    ["5000", "Expenses", chartFigures.expenses],
                  ],
                });
              } else if (activeTab === "partnership") {
                exportTable({
                  fileName: `Partnership Report ${formatPeriod(partnershipPeriod)}.xlsx`,
                  sheetName: "Partnership",
                  title: `Partnership Report — ${formatPeriod(partnershipPeriod)}`,
                  headers: [
                    "Partner",
                    "Profit Share %",
                    "Opening Balance",
                    "P&L Share",
                    "Adjustments",
                    "Remaining Balance",
                  ],
                  rows: partnerRows.map((r) => [
                    r.partner.name,
                    Number(r.partner.profit_share_percent),
                    Number(r.opening),
                    Number(r.profit),
                    Number(r.adjustments),
                    Number(r.remaining),
                  ]),
                });
              }
            }}
          />
        }
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-4 md:p-6 border-b border-slate-200 overflow-x-auto">
            <div className="flex gap-2 min-w-max">
              {([
                { key: "pl", label: "Profit & Loss" },
                { key: "clients", label: "Client Statements" },
                { key: "chart", label: "Chart of Accounts" },
                { key: "partnership", label: "Partnership Report" },
              ] as const).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2 rounded-md text-sm whitespace-nowrap transition-colors ${activeTab === tab.key
                      ? "bg-blue-600 text-white"
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
                <div className="flex items-center gap-2">
                  <label className="text-sm text-slate-600">Month:</label>
                  <select
                    value={plPeriod}
                    onChange={(e) => setPlPeriod(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    {chartPeriodOptions.map((p) => (
                      <option key={p} value={p}>
                        {formatPeriod(p)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {loadingPl ? (
                <div className="py-12 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                </div>
              ) : (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-sm text-slate-900 mb-3 pb-2 border-b border-slate-200">Revenue</h4>
                    <div className="space-y-2 mb-3">
                      <div className="flex justify-between items-center pl-4">
                        <span className="text-sm text-slate-600">Security Services Revenue</span>
                        <span className="text-sm text-green-600">
                          PKR {plFigures.securityRevenue.toLocaleString()}
                        </span>
                      </div>
                      <div className="flex justify-between items-center pl-4">
                        <span className="text-sm text-slate-600">Guard Deployment Revenue</span>
                        <span className="text-sm text-green-600">
                          PKR {plFigures.guardRevenue.toLocaleString()}
                        </span>
                      </div>
                    </div>
                    <div className="flex justify-between items-center pl-4 pt-2 border-t border-slate-200">
                      <span className="text-sm text-slate-900">Total Revenue</span>
                      <span className="text-sm text-green-600">
                        PKR {plFigures.totalRevenue.toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm text-slate-900 mb-3 pb-2 border-b border-slate-200">Expenses</h4>
                    <div className="space-y-2 mb-3">
                      {[
                        { name: "Payroll & Salaries", amount: plFigures.payroll },
                        { name: "Operating Expenses", amount: plFigures.operating },
                        { name: "Equipment & Supplies", amount: plFigures.equipment },
                        { name: "Transportation & Fuel", amount: plFigures.transportation },
                        { name: "Utilities & Rent", amount: plFigures.utilities },
                        { name: "Insurance", amount: plFigures.insurance },
                        { name: "Licenses", amount: plFigures.licenses },
                        { name: "EOBI", amount: plFigures.eobi },
                        { name: "IESSI", amount: plFigures.iessi },
                        { name: "PESSI", amount: plFigures.pessi },
                      ].map((item) => (
                        <div key={item.name} className="flex justify-between items-center pl-4">
                          <span className="text-sm text-slate-600">{item.name}</span>
                          <span className="text-sm text-red-600">
                            PKR {item.amount.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between items-center pl-4 pt-2 border-t border-slate-200">
                      <span className="text-sm text-slate-900">Total Expenses</span>
                      <span className="text-sm text-red-600">
                        PKR {plFigures.totalExpenses.toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <div className="pt-4 border-t-2 border-slate-300">
                    <div className="flex justify-between items-center">
                      <span className="text-base text-slate-900">Gross Profit</span>
                      <span
                        className={`text-lg ${plFigures.grossProfit >= 0 ? "text-green-600" : "text-red-600"}`}
                      >
                        PKR {plFigures.grossProfit.toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <div className="pt-2">
                    <div className="flex justify-between items-center pl-4">
                      <span className="text-sm text-slate-600">Taxes</span>
                      <span className="text-sm text-red-600">
                        PKR {plFigures.taxes.toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <div className="pt-4 border-t-2 border-slate-300">
                    <div className="flex justify-between items-center">
                      <span className="text-base text-slate-900">Net Profit</span>
                      <span
                        className={`text-xl ${plFigures.netProfit >= 0 ? "text-green-600" : "text-red-600"}`}
                      >
                        PKR {plFigures.netProfit.toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "chart" && (
            <div className="p-6">
              <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-lg text-slate-900 mb-1">Chart of Accounts</h3>
                  <p className="text-sm text-slate-500">
                    For {formatPeriod(chartPeriod)} ({firstOfMonth(chartPeriod)} – {lastOfMonth(chartPeriod)})
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-slate-600">Month:</label>
                  <select
                    value={chartPeriod}
                    onChange={(e) => setChartPeriod(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    {chartPeriodOptions.map((p) => (
                      <option key={p} value={p}>
                        {formatPeriod(p)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {loadingChart ? (
                <div className="py-12 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="text-left px-6 py-3 text-sm text-slate-500">Code</th>
                        <th className="text-left px-6 py-3 text-sm text-slate-500">Account Name</th>
                        <th className="text-right px-6 py-3 text-sm text-slate-500">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      <tr className="bg-blue-50">
                        <td className="px-6 py-3 text-sm text-slate-900">1000</td>
                        <td className="px-6 py-3 text-sm text-slate-900">Assets</td>
                        <td className="px-6 py-3 text-sm text-slate-900 text-right">
                          PKR {chartFigures.weapons.toLocaleString()}
                        </td>
                      </tr>
                      <tr className="bg-blue-50">
                        <td className="px-6 py-3 text-sm text-slate-900">1100</td>
                        <td className="px-6 py-3 text-sm text-slate-900">Current Assets</td>
                        <td className="px-6 py-3 text-sm text-slate-900 text-right">
                          PKR {(chartFigures.uniform + chartFigures.cashAndBank).toLocaleString()}
                        </td>
                      </tr>
                      <tr className="bg-blue-50">
                        <td className="px-6 py-3 text-sm text-slate-900">2000</td>
                        <td className="px-6 py-3 text-sm text-slate-900">Liabilities</td>
                        <td className="px-6 py-3 text-sm text-slate-500 text-right">None</td>
                      </tr>
                      <tr className="bg-blue-50">
                        <td className="px-6 py-3 text-sm text-slate-900">2100</td>
                        <td className="px-6 py-3 text-sm text-slate-900">Current Liabilities</td>
                        <td className="px-6 py-3 text-sm text-slate-900 text-right">
                          PKR {chartFigures.currentLiabilities.toLocaleString()}
                        </td>
                      </tr>
                      <tr className="bg-blue-50">
                        <td className="px-6 py-3 text-sm text-slate-900">3000</td>
                        <td className="px-6 py-3 text-sm text-slate-900">Equity</td>
                        <td className="px-6 py-3 text-sm text-slate-400 text-right">To be configured</td>
                      </tr>
                      <tr className="bg-blue-50">
                        <td className="px-6 py-3 text-sm text-slate-900">4000</td>
                        <td className="px-6 py-3 text-sm text-slate-900">Revenue</td>
                        <td className="px-6 py-3 text-sm text-green-700 text-right">
                          PKR {chartFigures.revenue.toLocaleString()}
                        </td>
                      </tr>
                      <tr className="bg-blue-50">
                        <td className="px-6 py-3 text-sm text-slate-900">5000</td>
                        <td className="px-6 py-3 text-sm text-slate-900">Expenses</td>
                        <td className="px-6 py-3 text-sm text-red-700 text-right">
                          PKR {chartFigures.expenses.toLocaleString()}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === "clients" && (
            <div>
              <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-sm text-slate-600">Month:</label>
                  <select
                    value={statementPeriod}
                    onChange={(e) => setStatementPeriod(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    {chartPeriodOptions.map((p) => (
                      <option key={p} value={p}>
                        {formatPeriod(p)}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="text-xs text-slate-500">
                  Total Income = Total Invoiced − (Payroll + Expenses)
                </span>
              </div>

              <div className="p-4 grid grid-cols-1 md:grid-cols-4 gap-3 border-b border-slate-200">
                <div className="bg-blue-50 p-3 rounded-lg border border-blue-200">
                  <p className="text-xs text-blue-700 mb-1">Total Invoiced</p>
                  <p className="text-lg text-blue-900">
                    PKR {statementTotals.invoiced.toLocaleString()}
                  </p>
                </div>
                <div className="bg-red-50 p-3 rounded-lg border border-red-200">
                  <p className="text-xs text-red-700 mb-1">Payroll Expense</p>
                  <p className="text-lg text-red-900">
                    PKR {statementTotals.payroll.toLocaleString()}
                  </p>
                </div>
                <div className="bg-red-50 p-3 rounded-lg border border-red-200">
                  <p className="text-xs text-red-700 mb-1">Other Expenses</p>
                  <p className="text-lg text-red-900">
                    PKR {statementTotals.expenses.toLocaleString()}
                  </p>
                </div>
                <div
                  className={`p-3 rounded-lg border ${
                    statementTotals.income >= 0
                      ? "bg-green-50 border-green-200"
                      : "bg-red-50 border-red-200"
                  }`}
                >
                  <p
                    className={`text-xs mb-1 ${
                      statementTotals.income >= 0 ? "text-green-700" : "text-red-700"
                    }`}
                  >
                    Total Income
                  </p>
                  <p
                    className={`text-lg ${
                      statementTotals.income >= 0 ? "text-green-900" : "text-red-900"
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
                      <th className="text-right px-6 py-3 text-sm text-slate-500">Expenses</th>
                      <th className="text-right px-6 py-3 text-sm text-slate-500">Total Income</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {loadingClients && (
                      <tr>
                        <td colSpan={6} className="px-6 py-10 text-center text-slate-500">
                          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                        </td>
                      </tr>
                    )}
                    {!loadingClients && clientStatementRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-6 py-10 text-center text-slate-500 text-sm">
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
                          <td className="px-6 py-4 text-sm text-blue-600 text-right">
                            PKR {client.total_invoiced.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-sm text-red-600 text-right">
                            PKR {client.payroll_expense.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-sm text-red-600 text-right">
                            PKR {client.expenses.toLocaleString()}
                          </td>
                          <td className="px-6 py-4 text-sm text-right">
                            <span className={client.total_income >= 0 ? "text-green-600" : "text-red-600"}>
                              PKR {client.total_income.toLocaleString()}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <button
                              className="text-sm text-blue-600 hover:text-blue-700"
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
                    For {formatPeriod(partnershipPeriod)} · Total share allocated:{" "}
                    <span className={totalShare > 100 ? "text-red-600" : "text-slate-900"}>
                      {totalShare}%
                    </span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-slate-600">Month:</label>
                  <select
                    value={partnershipPeriod}
                    onChange={(e) => setPartnershipPeriod(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  >
                    {chartPeriodOptions.map((p) => (
                      <option key={p} value={p}>{formatPeriod(p)}</option>
                    ))}
                  </select>
                </div>
              </div>

              {partnerError && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-2 rounded mb-4">{partnerError}</div>
              )}

              <form onSubmit={handleAddPartner} className="bg-slate-50 border border-slate-200 rounded-lg p-4 mb-6 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
                <div className="md:col-span-2">
                  <label className="block text-xs text-slate-700 mb-1">Partner Name</label>
                  <input
                    type="text"
                    value={newPartnerName}
                    onChange={(e) => setNewPartnerName(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                    placeholder="Full name"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-700 mb-1">Profit Share %</label>
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    max="100"
                    value={newPartnerShare}
                    onChange={(e) => setNewPartnerShare(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-700 mb-1">Opening Balance (PKR)</label>
                  <input
                    type="number"
                    value={newPartnerOpening}
                    onChange={(e) => setNewPartnerOpening(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                    placeholder="0"
                  />
                  <p className="text-[10px] text-slate-500 mt-1">Locks once non-zero is saved.</p>
                </div>
                <div>
                  <Button type="submit" variant="primary" size="sm" disabled={partnerSubmitting || !newPartnerName.trim()}>
                    <Plus className="w-4 h-4 mr-1" /> Add Partner
                  </Button>
                </div>
              </form>

              <div className="overflow-x-auto">
                {loadingPartnership ? (
                  <div className="py-12 text-center text-slate-500">
                    <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                  </div>
                ) : partnerRows.length === 0 ? (
                  <div className="py-12 text-center text-slate-500 text-sm">
                    No partners yet. Add the first one above.
                  </div>
                ) : (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Partner</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Profit Share</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Opening Balance</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">P&amp;L Share</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Adjustments</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Remaining</th>
                        <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {partnerRows.map(({ partner: p, opening, profit, adjustments, remaining }) => {
                        const editing = editPartnerId === p.id;
                        return (
                          <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                            <td className="px-4 py-3 text-sm text-slate-900">
                              {p.name}
                              {p.opening_balance_locked && (
                                <Lock className="w-3 h-3 text-slate-400 inline-block ml-2" />
                              )}
                            </td>
                            <td className="px-4 py-3 text-sm text-right">
                              {editing ? (
                                <input
                                  type="number"
                                  step="0.001"
                                  min="0"
                                  max="100"
                                  value={editPartnerShare}
                                  onChange={(e) => setEditPartnerShare(e.target.value)}
                                  className="w-20 px-2 py-1 border border-slate-200 rounded text-sm text-right"
                                />
                              ) : (
                                <span className="text-blue-600">{Number(p.profit_share_percent)}%</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-sm text-right text-slate-700">
                              {editing && !p.opening_balance_locked ? (
                                <input
                                  type="number"
                                  value={editPartnerOpening}
                                  onChange={(e) => setEditPartnerOpening(e.target.value)}
                                  placeholder="Lock once entered"
                                  className="w-32 px-2 py-1 border border-slate-200 rounded text-sm text-right"
                                />
                              ) : (
                                <>PKR {Number(opening).toLocaleString(undefined, { maximumFractionDigits: 2 })}</>
                              )}
                            </td>
                            <td className={`px-4 py-3 text-sm text-right ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                              PKR {Number(profit).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </td>
                            <td className={`px-4 py-3 text-sm text-right ${adjustments >= 0 ? "text-green-600" : "text-red-600"}`}>
                              PKR {Number(adjustments).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </td>
                            <td className={`px-4 py-3 text-sm text-right ${remaining >= 0 ? "text-slate-900" : "text-red-600"}`}>
                              PKR {Number(remaining).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {editing ? (
                                <div className="flex gap-1 justify-end">
                                  <Button variant="primary" size="sm" onClick={() => handleSavePartnerEdit(p)}>Save</Button>
                                  <Button variant="ghost" size="sm" onClick={() => setEditPartnerId(null)}>Cancel</Button>
                                </div>
                              ) : (
                                <div className="flex gap-1 justify-end">
                                  <button
                                    onClick={() => openEditPartner(p)}
                                    className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
                                    title="Edit"
                                  >
                                    <Pencil className="w-4 h-4" />
                                  </button>
                                  <button
                                    onClick={() => handleDeletePartner(p)}
                                    className="p-1.5 rounded text-red-600 hover:bg-red-50"
                                    title="Delete"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                <div className="bg-slate-50 border border-slate-200 p-3 rounded">
                  <p className="text-slate-500 text-xs mb-1">Total profit share allocated</p>
                  <p className={`text-lg ${totalShare > 100 ? "text-red-600" : "text-slate-900"}`}>{totalShare}%</p>
                </div>
                <div className="bg-slate-50 border border-slate-200 p-3 rounded">
                  <p className="text-slate-500 text-xs mb-1">Month P&amp;L</p>
                  <p className={`text-lg ${monthlyPL(partnershipPeriod) >= 0 ? "text-green-700" : "text-red-600"}`}>
                    PKR {Number(monthlyPL(partnershipPeriod)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </p>
                </div>
                <div className="bg-slate-50 border border-slate-200 p-3 rounded">
                  <p className="text-slate-500 text-xs mb-1">Sum of remaining balances</p>
                  <p className="text-lg text-slate-900">
                    PKR {partnerRows.reduce((s, r) => s + r.remaining, 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </p>
                </div>
              </div>

              <p className="mt-4 text-xs text-slate-500">
                Remaining balance carries forward: this month's remaining becomes next month's opening. Use the month selector to step through history.
              </p>
            </div>
          )}
        </div>
      </div>

      <Modal isOpen={isClientStatementModalOpen} onClose={() => setIsClientStatementModalOpen(false)} title="Full Client Statement" size="lg">
        {selectedClient && (
          <div className="space-y-4">
            <div className="pb-4 border-b border-slate-200">
              <h3 className="text-base text-slate-900">{selectedClient.name}</h3>
              <p className="text-xs text-slate-500 font-mono">{selectedClient.client_code}</p>
              <p className="text-xs text-slate-500 mt-1">Month: {formatPeriod(statementPeriod)}</p>
            </div>

            <div className="grid grid-cols-4 gap-3">
              <div className="bg-blue-50 p-3 rounded-lg border border-blue-200">
                <p className="text-xs text-blue-700 mb-1">Total Invoiced</p>
                <p className="text-lg text-blue-900">PKR {selectedClient.total_invoiced.toLocaleString()}</p>
              </div>
              <div className="bg-red-50 p-3 rounded-lg border border-red-200">
                <p className="text-xs text-red-700 mb-1">Payroll Expense</p>
                <p className="text-lg text-red-900">PKR {selectedClient.payroll_expense.toLocaleString()}</p>
              </div>
              <div className="bg-red-50 p-3 rounded-lg border border-red-200">
                <p className="text-xs text-red-700 mb-1">Expenses</p>
                <p className="text-lg text-red-900">PKR {selectedClient.expenses.toLocaleString()}</p>
              </div>
              <div className={`p-3 rounded-lg border ${selectedClient.total_income >= 0 ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
                <p className={`text-xs mb-1 ${selectedClient.total_income >= 0 ? "text-green-700" : "text-red-700"}`}>Total Income</p>
                <p className={`text-lg ${selectedClient.total_income >= 0 ? "text-green-900" : "text-red-900"}`}>
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
