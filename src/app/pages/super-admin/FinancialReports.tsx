import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, FileText } from "lucide-react";
import Header from "../../components/Header";
import ExportButton from "../../components/ExportButton";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import {
  supabase,
  INVOICE_ATTACHMENTS_BUCKET,
  type Client,
  type Invoice,
  type Payslip,
  type Expense,
  type Employee,
} from "../../lib/supabase";

const profitLossData = [
  { category: "Revenue", items: [
    { name: "Security Services Revenue", amount: 1450000 },
    { name: "Guard Deployment Revenue", amount: 820000 },
    { name: "Facility Management Revenue", amount: 410000 },
    { name: "Other Income", amount: 45000 },
  ]},
  { category: "Expenses", items: [
    { name: "Payroll & Salaries", amount: 2400000 },
    { name: "Operating Expenses", amount: 206000 },
    { name: "Equipment & Supplies", amount: 125000 },
    { name: "Transportation & Fuel", amount: 85000 },
    { name: "Utilities & Rent", amount: 120000 },
    { name: "Insurance & Licenses", amount: 65000 },
  ]},
];

const sofpData = [
  { category: "Assets", items: [
    { name: "Current Assets", amount: 5250000 },
    { name: "Fixed Assets", amount: 2100000 },
  ]},
  { category: "Liabilities", items: [
    { name: "Current Liabilities", amount: 1200000 },
    { name: "Long-term Liabilities", amount: 450000 },
  ]},
  { category: "Equity", items: [
    { name: "Partner Capital", amount: 4050000 },
    { name: "Retained Earnings", amount: 1650000 },
  ]},
];

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

const monthKey = (iso: string) => iso.slice(0, 7);

const currentMonthKey = () => new Date().toISOString().slice(0, 7);

const priorMonthKeys = (n: number): string[] => {
  const keys: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i += 1) {
    keys.push(d.toISOString().slice(0, 7));
    d.setMonth(d.getMonth() - 1);
  }
  return keys;
};

export default function FinancialReports() {
  const [activeTab, setActiveTab] = useState<"pl" | "sofp" | "clients" | "partnership">("pl");
  const [isClientStatementModalOpen, setIsClientStatementModalOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<ClientStatementRow | null>(null);

  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);

  useEffect(() => {
    const loadClientData = async () => {
      setLoadingClients(true);
      const windowMonths = priorMonthKeys(7);
      const sinceMonth = windowMonths[windowMonths.length - 1] + "-01";
      const [cliRes, invRes, psRes, empRes, expRes] = await Promise.all([
        supabase.from("clients").select("*").order("name"),
        supabase.from("invoices").select("*"),
        supabase.from("payslips").select("*").eq("disbursed", true).gte("period_month", sinceMonth),
        supabase.from("employees").select("id, client_id, full_name, employee_code, base_salary, per_day_salary, shift, status, location_id, department, join_date, phone, bank_account, employee_code, created_at, updated_at"),
        supabase.from("expenses").select("*"),
      ]);
      setClients((cliRes.data ?? []) as Client[]);
      setInvoices((invRes.data ?? []) as Invoice[]);
      setPayslips((psRes.data ?? []) as Payslip[]);
      setEmployees((empRes.data ?? []) as Employee[]);
      setExpenses((expRes.data ?? []) as Expense[]);
      setLoadingClients(false);
    };
    loadClientData();
  }, []);

  const clientStatementRows: ClientStatementRow[] = useMemo(() => {
    const windowMonths = new Set(priorMonthKeys(7));
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
        .filter((p) => empIds.has(p.employee_id) && windowMonths.has(monthKey(p.period_month)))
        .reduce((s, p) => s + Number(p.net_salary), 0);

      let expense_sum = 0;
      for (const ex of expenses) {
        if (ex.client_id !== c.id) continue;
        if (ex.payment_mode === "Payable") {
          if (ex.payable_status === "Paid" && ex.paid_at) {
            expense_sum += Number(ex.amount);
          }
        } else {
          expense_sum += Number(ex.amount);
        }
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

  const viewFullStatement = (client: ClientStatementRow) => {
    setSelectedClient(client);
    setIsClientStatementModalOpen(true);
  };

  const viewInvoiceAttachment = (path: string) => {
    const { data } = supabase.storage.from(INVOICE_ATTACHMENTS_BUCKET).getPublicUrl(path);
    if (data?.publicUrl) window.open(data.publicUrl, "_blank");
  };

  const totalRevenue = profitLossData[0].items.reduce((sum, item) => sum + item.amount, 0);
  const totalExpenses = profitLossData[1].items.reduce((sum, item) => sum + item.amount, 0);
  const netProfit = totalRevenue - totalExpenses;

  const totalAssets = sofpData[0].items.reduce((sum, item) => sum + item.amount, 0);
  const totalLiabilities = sofpData[1].items.reduce((sum, item) => sum + item.amount, 0);
  const totalEquity = sofpData[2].items.reduce((sum, item) => sum + item.amount, 0);

  const statementWindowLabel = useMemo(() => {
    const keys = priorMonthKeys(7).sort();
    const from = keys[0];
    const to = keys[keys.length - 1];
    const fmt = (k: string) => {
      const [y, m] = k.split("-").map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
    };
    return `${fmt(from)} – ${fmt(to)}`;
  }, []);

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
                { key: "sofp", label: "Financial Position" },
                { key: "clients", label: "Client Statements" },
                { key: "partnership", label: "Partnership Report" },
              ] as const).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2 rounded-md text-sm transition-colors ${
                    activeTab === tab.key
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
              <div className="mb-6">
                <h3 className="text-lg text-slate-900 mb-2">Profit & Loss Statement</h3>
                <p className="text-sm text-slate-500">For the month ending {new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" })}</p>
              </div>

              <div className="space-y-6">
                {profitLossData.map((section, idx) => (
                  <div key={idx}>
                    <h4 className="text-sm text-slate-900 mb-3 pb-2 border-b border-slate-200">{section.category}</h4>
                    <div className="space-y-2 mb-3">
                      {section.items.map((item, itemIdx) => (
                        <div key={itemIdx} className="flex justify-between items-center pl-4">
                          <span className="text-sm text-slate-600">{item.name}</span>
                          <span className={`text-sm ${idx === 0 ? 'text-green-600' : 'text-red-600'}`}>
                            PKR {item.amount.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between items-center pl-4 pt-2 border-t border-slate-200">
                      <span className="text-sm text-slate-900">Total {section.category}</span>
                      <span className={`text-sm ${idx === 0 ? 'text-green-600' : 'text-red-600'}`}>
                        PKR {section.items.reduce((sum, item) => sum + item.amount, 0).toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))}

                <div className="pt-4 border-t-2 border-slate-300">
                  <div className="flex justify-between items-center">
                    <span className="text-base text-slate-900">Net Profit</span>
                    <span className={`text-lg ${netProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      PKR {netProfit.toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "sofp" && (
            <div className="p-6">
              <div className="mb-6">
                <h3 className="text-lg text-slate-900 mb-2">Statement of Financial Position</h3>
                <p className="text-sm text-slate-500">As at {new Date().toLocaleDateString()}</p>
              </div>

              <div className="space-y-6">
                {sofpData.map((section, idx) => (
                  <div key={idx}>
                    <h4 className="text-sm text-slate-900 mb-3 pb-2 border-b border-slate-200">{section.category}</h4>
                    <div className="space-y-2 mb-3">
                      {section.items.map((item, itemIdx) => (
                        <div key={itemIdx} className="flex justify-between items-center pl-4">
                          <span className="text-sm text-slate-600">{item.name}</span>
                          <span className="text-sm text-blue-600">PKR {item.amount.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between items-center pl-4 pt-2 border-t border-slate-200">
                      <span className="text-sm text-slate-900">Total {section.category}</span>
                      <span className="text-sm text-blue-600">
                        PKR {section.items.reduce((sum, item) => sum + item.amount, 0).toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))}

                <div className="pt-4 border-t-2 border-slate-300">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-base text-slate-900">Total Assets</span>
                    <span className="text-lg text-blue-600">PKR {totalAssets.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-base text-slate-900">Total Liabilities & Equity</span>
                    <span className="text-lg text-blue-600">
                      PKR {(totalLiabilities + totalEquity).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "clients" && (
            <div>
              <div className="p-4 border-b border-slate-200 flex items-center justify-between text-sm">
                <span className="text-slate-600">
                  Payroll & expenses aggregated for {statementWindowLabel}.
                </span>
                <span className="text-slate-500">
                  Total Income = Total Invoiced − (Payroll + Expenses)
                </span>
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
              <p className="text-xs text-slate-500 mt-1">Window: {statementWindowLabel}</p>
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
