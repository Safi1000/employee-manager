import { useState } from "react";
import { Plus, Search, Building2, Download } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";

const chartOfAccounts = [
  { id: 1, code: "1000", name: "Assets", type: "Header", balance: 5250000 },
  { id: 2, code: "1100", name: "Current Assets", type: "Subheader", balance: 5250000 },
  { id: 3, code: "1110", name: "Cash and Bank", type: "Detail", balance: 5250000 },
  { id: 4, code: "2000", name: "Liabilities", type: "Header", balance: 1200000 },
  { id: 5, code: "2100", name: "Current Liabilities", type: "Subheader", balance: 1200000 },
  { id: 6, code: "2110", name: "Accounts Payable", type: "Detail", balance: 1200000 },
  { id: 7, code: "3000", name: "Equity", type: "Header", balance: 4050000 },
  { id: 8, code: "4000", name: "Revenue", type: "Header", balance: 1640000 },
  { id: 9, code: "5000", name: "Expenses", type: "Header", balance: 845000 },
];

const receivables = [
  { id: 1, client: "Client A - Security Services", amount: 450000, dueDate: "2026-04-25", status: "Pending" },
  { id: 2, client: "Client B - Guard Deployment", amount: 380000, dueDate: "2026-04-30", status: "Pending" },
  { id: 3, client: "Client C - Facility Management", amount: 520000, dueDate: "2026-05-05", status: "Overdue" },
  { id: 4, client: "Client D - Event Security", amount: 290000, dueDate: "2026-05-10", status: "Pending" },
];

const payables = [
  { id: 1, vendor: "Vendor X - Uniforms", amount: 150000, dueDate: "2026-04-20", status: "Pending" },
  { id: 2, vendor: "Vendor Y - Electronics", amount: 280000, dueDate: "2026-04-22", status: "Pending" },
];

const bankAccounts = [
  { id: 1, name: "Allied Bank - Operations", accountNo: "0123456789", balance: 2500000, cashBalance: 500000, accountBalance: 2000000, type: "Current" },
  { id: 2, name: "HBL - Payroll", accountNo: "9876543210", balance: 1800000, cashBalance: 300000, accountBalance: 1500000, type: "Current" },
  { id: 3, name: "MCB - Client Receivables", accountNo: "5555666677", balance: 950000, cashBalance: 150000, accountBalance: 800000, type: "Current" },
];

export default function Accounting() {
  const [activeTab, setActiveTab] = useState<"chart" | "receivables" | "payables" | "banks">("chart");
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [isBankModalOpen, setIsBankModalOpen] = useState(false);
  const [isStatementModalOpen, setIsStatementModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isReconcileModalOpen, setIsReconcileModalOpen] = useState(false);
  const [isEditBankModalOpen, setIsEditBankModalOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<any>(null);
  const [selectedBank, setSelectedBank] = useState<any>(null);

  const viewStatement = (client: any) => {
    setSelectedClient(client);
    setIsStatementModalOpen(true);
  };

  const recordPayment = (client: any) => {
    setSelectedClient(client);
    setIsPaymentModalOpen(true);
  };

  const reconcileBank = (bank: any) => {
    setSelectedBank(bank);
    setIsReconcileModalOpen(true);
  };

  const editBank = (bank: any) => {
    setSelectedBank(bank);
    setIsEditBankModalOpen(true);
  };

  return (
    <>
      <Header
        title="Financial Accounting"
        actions={
          <>
            <ExportButton onExport={() => console.log("Export")} />
            {activeTab === "chart" && (
              <Button variant="primary" size="md" onClick={() => setIsAccountModalOpen(true)}>
                <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Add Account
              </Button>
            )}
            {activeTab === "banks" && (
              <Button variant="primary" size="md" onClick={() => setIsBankModalOpen(true)}>
                <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Add Bank Account
              </Button>
            )}
          </>
        }
      />

      <div className="flex-1 overflow-y-auto p-8">
        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-6 border-b border-slate-200">
            <div className="flex gap-2">
              {(["chart", "receivables", "payables", "banks"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 rounded-md text-sm transition-colors ${
                    activeTab === tab
                      ? "bg-blue-600 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {tab === "chart" && "Chart of Accounts"}
                  {tab === "receivables" && "Client Receivables"}
                  {tab === "payables" && "Accounts Payable"}
                  {tab === "banks" && "Bank Accounts"}
                </button>
              ))}
            </div>
          </div>

          {activeTab === "chart" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Code</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Account Name</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Balance</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {chartOfAccounts.map((account) => (
                    <tr
                      key={account.id}
                      className={`hover:bg-slate-50 transition-colors ${
                        account.type === "Header" ? "bg-blue-50" : account.type === "Subheader" ? "bg-slate-50" : ""
                      }`}
                    >
                      <td className="px-6 py-4 text-sm text-slate-900">{account.code}</td>
                      <td
                        className={`px-6 py-4 text-sm ${
                          account.type === "Header" ? "text-slate-900" : "text-slate-700"
                        }`}
                        style={{ paddingLeft: account.type === "Detail" ? "3rem" : "1.5rem" }}
                      >
                        {account.name}
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{account.type}</td>
                      <td className="px-6 py-4 text-sm text-slate-900">PKR {account.balance.toLocaleString()}</td>
                      <td className="px-6 py-4">
                        {account.type === "Detail" && (
                          <Button variant="ghost" size="sm">
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "receivables" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Amount Due</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Due Date</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {receivables.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 text-sm text-slate-900">{item.client}</td>
                      <td className="px-6 py-4 text-sm text-blue-600">PKR {item.amount.toLocaleString()}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{item.dueDate}</td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                            item.status === "Overdue"
                              ? "bg-red-50 text-red-700"
                              : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {item.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => viewStatement(item)}>
                          View Statement
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => recordPayment(item)}>
                          Record Payment
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "payables" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Vendor</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Amount Due</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Due Date</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {payables.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 text-sm text-slate-900">{item.vendor}</td>
                      <td className="px-6 py-4 text-sm text-red-600">PKR {item.amount.toLocaleString()}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{item.dueDate}</td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                            item.status === "Overdue"
                              ? "bg-red-50 text-red-700"
                              : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {item.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "banks" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Bank Name</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Account Number</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Cash Balance</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Account Balance</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Total Balance</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {bankAccounts.map((bank) => (
                    <tr key={bank.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Building2 className="w-4 h-4 text-blue-600" strokeWidth={1.5} />
                          <span className="text-sm text-slate-900">{bank.name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{bank.accountNo}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{bank.type}</td>
                      <td className="px-6 py-4 text-sm text-green-600">PKR {bank.cashBalance?.toLocaleString()}</td>
                      <td className="px-6 py-4 text-sm text-blue-600">PKR {bank.accountBalance?.toLocaleString()}</td>
                      <td className="px-6 py-4 text-sm font-semibold text-slate-900">PKR {bank.balance.toLocaleString()}</td>
                      <td className="px-6 py-4 flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => reconcileBank(bank)}>
                          Reconcile
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => editBank(bank)}>
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <Modal isOpen={isAccountModalOpen} onClose={() => setIsAccountModalOpen(false)} title="Add Account" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Code</label>
            <input
              type="text"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="e.g., 1120"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Name</label>
            <input
              type="text"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="Enter account name"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Type</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
              <option>Header</option>
              <option>Subheader</option>
              <option>Detail</option>
            </select>
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Add Account
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsAccountModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isBankModalOpen} onClose={() => setIsBankModalOpen(false)} title="Add Bank Account" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Bank Name</label>
            <input
              type="text"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="e.g., Allied Bank"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Number</label>
            <input
              type="text"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="Enter account number"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Type</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
              <option>Current</option>
              <option>Savings</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Opening Balance (PKR)</label>
            <input
              type="number"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="0"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Add Bank Account
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsBankModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isStatementModalOpen} onClose={() => setIsStatementModalOpen(false)} title="Client Statement" size="lg">
        <div className="space-y-4">
          <div className="pb-4 border-b border-slate-200">
            <h3 className="text-base text-slate-900">{selectedClient?.client}</h3>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
              <p className="text-sm text-blue-700 mb-1">Total Invoiced</p>
              <p className="text-xl text-blue-900">PKR {selectedClient?.amount.toLocaleString()}</p>
            </div>
            <div className="bg-green-50 p-4 rounded-lg border border-green-200">
              <p className="text-sm text-green-700 mb-1">Amount Paid</p>
              <p className="text-xl text-green-900">PKR 0</p>
            </div>
            <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
              <p className="text-sm text-amber-700 mb-1">Outstanding</p>
              <p className="text-xl text-amber-900">PKR {selectedClient?.amount.toLocaleString()}</p>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200">
            <h4 className="text-sm text-slate-900 mb-3">Transaction History</h4>
            <div className="space-y-2">
              <div className="p-3 bg-slate-50 rounded-lg">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-sm text-slate-900">Invoice #{selectedClient?.id}001</p>
                    <p className="text-xs text-slate-500">{selectedClient?.dueDate}</p>
                  </div>
                  <span className="text-sm text-blue-600">PKR {selectedClient?.amount.toLocaleString()}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
            <Button variant="primary" size="md" className="flex-1">
              <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Download Statement
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsStatementModalOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={isPaymentModalOpen} onClose={() => setIsPaymentModalOpen(false)} title="Record Payment" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Client</label>
            <input
              type="text"
              value={selectedClient?.client}
              disabled
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Outstanding Amount</label>
            <input
              type="text"
              value={`PKR ${selectedClient?.amount.toLocaleString()}`}
              disabled
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Payment Amount (PKR)</label>
            <input
              type="number"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="Enter payment amount"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Payment Date</label>
            <input
              type="date"
              defaultValue={new Date().toISOString().split('T')[0]}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Payment Method</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
              <option>Bank Transfer</option>
              <option>Cash</option>
              <option>Cheque</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Reference Number</label>
            <input
              type="text"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="Enter reference number"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Record Payment
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsPaymentModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isReconcileModalOpen} onClose={() => setIsReconcileModalOpen(false)} title="Reconcile Bank Account" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Bank Account</label>
            <input
              type="text"
              value={selectedBank?.name}
              disabled
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Current System Balance</label>
            <input
              type="text"
              value={`PKR ${selectedBank?.balance.toLocaleString()}`}
              disabled
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm bg-slate-50"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Actual Bank Balance (PKR)</label>
            <input
              type="number"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="Enter actual bank balance"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Reconciliation Date</label>
            <input
              type="date"
              defaultValue={new Date().toISOString().split('T')[0]}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Notes</label>
            <textarea
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              rows={3}
              placeholder="Enter reconciliation notes"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Complete Reconciliation
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsReconcileModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isEditBankModalOpen} onClose={() => setIsEditBankModalOpen(false)} title="Edit Bank Account" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Bank Name</label>
            <input
              type="text"
              defaultValue={selectedBank?.name}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="e.g., Allied Bank"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Number</label>
            <input
              type="text"
              defaultValue={selectedBank?.accountNo}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="Enter account number"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Account Type</label>
            <select
              defaultValue={selectedBank?.type}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            >
              <option>Current</option>
              <option>Savings</option>
            </select>
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Update Account
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsEditBankModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
