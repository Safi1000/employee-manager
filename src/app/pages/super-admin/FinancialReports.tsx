import { useState } from "react";
import { Download } from "lucide-react";
import Header from "../../components/Header";
import ExportButton from "../../components/ExportButton";
import Modal from "../../components/Modal";
import Button from "../../components/Button";

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

const clientStatements = [
  { client: "Client A - Security Services", invoiced: 450000, paid: 250000, balance: 200000 },
  { client: "Client B - Guard Deployment", invoiced: 380000, paid: 380000, balance: 0 },
  { client: "Client C - Facility Management", invoiced: 520000, paid: 420000, balance: 100000 },
  { client: "Client D - Event Security", invoiced: 290000, paid: 150000, balance: 140000 },
  { client: "Client E - Corporate Guards", invoiced: 410000, paid: 410000, balance: 0 },
  { client: "Client F - Residential Security", invoiced: 360000, paid: 300000, balance: 60000 },
  { client: "Client G - Industrial Security", invoiced: 480000, paid: 400000, balance: 80000 },
  { client: "Client H - Retail Security", invoiced: 320000, paid: 280000, balance: 40000 },
];

const partnershipData = [
  { partner: "Partner A", equityShare: "40%", capital: 1620000, distributions: 320000, netEquity: 1300000 },
  { partner: "Partner B", equityShare: "35%", capital: 1417500, distributions: 280000, netEquity: 1137500 },
  { partner: "Partner C", equityShare: "25%", capital: 1012500, distributions: 200000, netEquity: 812500 },
];

export default function FinancialReports() {
  const [activeTab, setActiveTab] = useState<"pl" | "sofp" | "clients" | "partnership">("pl");
  const [isClientStatementModalOpen, setIsClientStatementModalOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<any>(null);

  const viewFullStatement = (client: any) => {
    setSelectedClient(client);
    setIsClientStatementModalOpen(true);
  };

  const totalRevenue = profitLossData[0].items.reduce((sum, item) => sum + item.amount, 0);
  const totalExpenses = profitLossData[1].items.reduce((sum, item) => sum + item.amount, 0);
  const netProfit = totalRevenue - totalExpenses;

  const totalAssets = sofpData[0].items.reduce((sum, item) => sum + item.amount, 0);
  const totalLiabilities = sofpData[1].items.reduce((sum, item) => sum + item.amount, 0);
  const totalEquity = sofpData[2].items.reduce((sum, item) => sum + item.amount, 0);

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
                <p className="text-sm text-slate-500">For the month ending April 2026</p>
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
                <p className="text-sm text-slate-500">As at April 18, 2026</p>
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
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Total Invoiced</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Total Paid</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Outstanding Balance</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {clientStatements.map((client, idx) => (
                    <tr key={idx} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 text-sm text-slate-900">{client.client}</td>
                      <td className="px-6 py-4 text-sm text-blue-600">PKR {client.invoiced.toLocaleString()}</td>
                      <td className="px-6 py-4 text-sm text-green-600">PKR {client.paid.toLocaleString()}</td>
                      <td className="px-6 py-4">
                        <span className={`text-sm ${client.balance > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                          PKR {client.balance.toLocaleString()}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <button className="text-sm text-blue-600 hover:text-blue-700" onClick={() => viewFullStatement(client)}>
                          View Full Statement
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "partnership" && (
            <div className="p-6">
              <div className="mb-6">
                <h3 className="text-lg text-slate-900 mb-2">Partnership Equity & Distribution Report</h3>
                <p className="text-sm text-slate-500">Current period ending April 2026</p>
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
        <div className="space-y-4">
          <div className="pb-4 border-b border-slate-200">
            <h3 className="text-base text-slate-900">{selectedClient?.client}</h3>
            <p className="text-sm text-slate-500 mt-1">Complete financial statement</p>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
              <p className="text-sm text-blue-700 mb-1">Total Invoiced</p>
              <p className="text-xl text-blue-900">PKR {selectedClient?.invoiced.toLocaleString()}</p>
            </div>
            <div className="bg-green-50 p-4 rounded-lg border border-green-200">
              <p className="text-sm text-green-700 mb-1">Total Paid</p>
              <p className="text-xl text-green-900">PKR {selectedClient?.paid.toLocaleString()}</p>
            </div>
            <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
              <p className="text-sm text-amber-700 mb-1">Outstanding Balance</p>
              <p className="text-xl text-amber-900">PKR {selectedClient?.balance.toLocaleString()}</p>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200">
            <h4 className="text-sm text-slate-900 mb-3">Invoice History</h4>
            <div className="space-y-2">
              <div className="p-3 bg-slate-50 rounded-lg">
                <div className="flex justify-between items-center mb-2">
                  <div>
                    <p className="text-sm text-slate-900">Invoice #001</p>
                    <p className="text-xs text-slate-500">Due: {new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0]}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-blue-600">PKR {(selectedClient?.invoiced * 0.4).toLocaleString()}</p>
                    <span className="text-xs text-green-600">Paid</span>
                  </div>
                </div>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg">
                <div className="flex justify-between items-center mb-2">
                  <div>
                    <p className="text-sm text-slate-900">Invoice #002</p>
                    <p className="text-xs text-slate-500">Due: {new Date(Date.now() - 15*24*60*60*1000).toISOString().split('T')[0]}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-blue-600">PKR {(selectedClient?.invoiced * 0.3).toLocaleString()}</p>
                    <span className="text-xs text-green-600">Paid</span>
                  </div>
                </div>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg">
                <div className="flex justify-between items-center mb-2">
                  <div>
                    <p className="text-sm text-slate-900">Invoice #003</p>
                    <p className="text-xs text-slate-500">Due: {new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0]}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-blue-600">PKR {selectedClient?.balance.toLocaleString()}</p>
                    <span className="text-xs text-amber-600">Pending</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
            <Button variant="primary" size="md" className="flex-1">
              <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Download PDF
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsClientStatementModalOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
