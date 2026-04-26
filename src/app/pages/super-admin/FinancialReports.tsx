import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, FileText } from "lucide-react";
import Header from "../../components/Header";
import ExportButton from "../../components/ExportButton";
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
} from "../../lib/supabase";

const partnershipData = [
  { partner: "Partner A", equityShare: "40%", capital: 1620000, distributions: 320000, netEquity: 1300000 },
  { partner: "Partner B", equityShare: "35%", capital: 1417500, distributions: 280000, netEquity: 1137500 },
  { partner: "Partner C", equityShare: "25%", capital: 1012500, distributions: 200000, netEquity: 812500 },
];

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
          .eq("period_month", plPeriod),
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
        supabase.from("payslips").select("*").eq("period_month", statementPeriod),
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


  return (
    <>
      <Header
        title="Financial Reports"
        actions={<ExportButton onExport={() => console.log("Export")} />}
      />

      <div className="flex-1 overflow-y-auto p-8">
        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <div className="flex gap-2">
              {([
                { key: "pl", label: "Profit & Loss" },
                { key: "clients", label: "Client Statements" },
                { key: "chart", label: "Chart of Accounts" },
                { key: "partnership", label: "Partnership Report" },
              ] as const).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2 rounded-md text-sm transition-colors ${activeTab === tab.key
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
              <div className="mb-6">
                <h3 className="text-lg text-slate-900 mb-2">Partnership Equity & Distribution Report</h3>
                <p className="text-sm text-slate-500">Current period ending {new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" })}</p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Partner</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Equity Share</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Capital Contribution</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Distributions</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Net Equity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {partnershipData.map((partner, idx) => (
                      <tr key={idx} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4 text-sm text-slate-900">{partner.partner}</td>
                        <td className="px-6 py-4 text-sm text-blue-600">{partner.equityShare}</td>
                        <td className="px-6 py-4 text-sm text-green-600">PKR {partner.capital.toLocaleString()}</td>
                        <td className="px-6 py-4 text-sm text-red-600">PKR {partner.distributions.toLocaleString()}</td>
                        <td className="px-6 py-4 text-sm text-slate-900">PKR {partner.netEquity.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-6 pt-6 border-t border-slate-200">
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-green-50 p-4 rounded-lg border border-green-200">
                    <p className="text-sm text-green-700 mb-1">Total Capital</p>
                    <p className="text-xl text-green-900">
                      PKR {partnershipData.reduce((sum, p) => sum + p.capital, 0).toLocaleString()}
                    </p>
                  </div>
                  <div className="bg-red-50 p-4 rounded-lg border border-red-200">
                    <p className="text-sm text-red-700 mb-1">Total Distributions</p>
                    <p className="text-xl text-red-900">
                      PKR {partnershipData.reduce((sum, p) => sum + p.distributions, 0).toLocaleString()}
                    </p>
                  </div>
                  <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                    <p className="text-sm text-blue-700 mb-1">Total Net Equity</p>
                    <p className="text-xl text-blue-900">
                      PKR {partnershipData.reduce((sum, p) => sum + p.netEquity, 0).toLocaleString()}
                    </p>
                  </div>
                </div>
              </div>
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
