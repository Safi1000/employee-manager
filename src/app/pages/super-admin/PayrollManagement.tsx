import { useState } from "react";
import { Search, Download } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";

const employees = [
  { id: 1, name: "Muhammad Usman", baseSalary: 50000, presentDays: 22, absentDays: 0, workingDays: 22, salaryCleared: true },
  { id: 2, name: "Ayesha Malik", baseSalary: 55000, presentDays: 21, absentDays: 1, workingDays: 22, salaryCleared: true },
  { id: 3, name: "Bilal Ahmed", baseSalary: 48000, presentDays: 22, absentDays: 0, workingDays: 22, salaryCleared: false },
  { id: 4, name: "Zainab Hassan", baseSalary: 52000, presentDays: 20, absentDays: 2, workingDays: 22, salaryCleared: false },
  { id: 5, name: "Hamza Khan", baseSalary: 60000, presentDays: 22, absentDays: 0, workingDays: 22, salaryCleared: true },
];

export default function PayrollManagement() {
  const [selectedEmployee, setSelectedEmployee] = useState<number | null>(null);
  const [bonus, setBonus] = useState(0);
  const [deduction, setDeduction] = useState(0);
  const [isPayslipModalOpen, setIsPayslipModalOpen] = useState(false);
  const [payslipEmployee, setPayslipEmployee] = useState<any>(null);

  const calculateSalary = (baseSalary: number, presentDays: number, workingDays: number) => {
    const perDaySalary = baseSalary / workingDays;
    const calculatedSalary = perDaySalary * presentDays;
    return Math.round(calculatedSalary + bonus - deduction);
  };

  const generatePayslip = (employee: any) => {
    setPayslipEmployee(employee);
    setIsPayslipModalOpen(true);
  };

  const selectedEmp = employees.find((emp) => emp.id === selectedEmployee);

  return (
    <>
      <Header
        title="Payroll Management"
        actions={
          <>
            <Button variant="secondary" size="md">
              <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Export CSV
            </Button>
            <Button variant="primary" size="md">
              <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Export PDF
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto p-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <div className="bg-white rounded-lg border border-slate-200">
              <div className="p-6 border-b border-slate-200">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
                  <input
                    type="text"
                    placeholder="Search employees..."
                    className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  />
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Employee Name</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Base Salary</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Present Days</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Final Salary</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {employees.map((employee) => (
                      <tr
                        key={employee.id}
                        className={`hover:bg-slate-50 transition-colors cursor-pointer ${
                          selectedEmployee === employee.id ? "bg-slate-50" : ""
                        }`}
                        onClick={() => setSelectedEmployee(employee.id)}
                      >
                        <td className="px-6 py-4 text-sm text-slate-900">{employee.name}</td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          PKR {employee.baseSalary.toLocaleString()}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {employee.presentDays}/{employee.workingDays}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-900">
                          PKR{" "}
                          {calculateSalary(
                            employee.baseSalary,
                            employee.presentDays,
                            employee.workingDays
                          ).toLocaleString()}
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                              employee.salaryCleared
                                ? "bg-green-50 text-green-700"
                                : "bg-amber-50 text-amber-700"
                            }`}
                          >
                            {employee.salaryCleared ? "Cleared" : "Pending"}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <Button variant="ghost" size="sm">
                            View
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg border border-slate-200 p-6">
              <h3 className="text-base mb-6 text-slate-900">Salary Calculation</h3>

              {selectedEmp ? (
                <div className="space-y-4">
                  <div className="pb-4 border-b border-slate-200">
                    <p className="text-sm text-slate-500 mb-1">Employee</p>
                    <p className="text-base text-slate-900">{selectedEmp.name}</p>
                  </div>

                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-slate-600">Base Salary</span>
                      <span className="text-sm text-slate-900">PKR {selectedEmp.baseSalary.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-slate-600">Working Days</span>
                      <span className="text-sm text-slate-900">{selectedEmp.workingDays}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-slate-600">Present Days</span>
                      <span className="text-sm text-green-600">{selectedEmp.presentDays}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-slate-600">Absent Days</span>
                      <span className="text-sm text-red-600">{selectedEmp.absentDays}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-slate-600">Per Day Salary</span>
                      <span className="text-sm text-slate-900">
                        PKR {Math.round(selectedEmp.baseSalary / selectedEmp.workingDays).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-slate-200 space-y-3">
                    <div>
                      <label className="block text-sm text-slate-700 mb-1">Bonus (PKR)</label>
                      <input
                        type="number"
                        value={bonus}
                        onChange={(e) => setBonus(Number(e.target.value))}
                        className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                        placeholder="0"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-slate-700 mb-1">Deduction (PKR)</label>
                      <input
                        type="number"
                        value={deduction}
                        onChange={(e) => setDeduction(Number(e.target.value))}
                        className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                        placeholder="0"
                      />
                    </div>
                  </div>

                  <div className="pt-4 border-t border-slate-200">
                    <div className="flex justify-between items-center mb-4">
                      <span className="text-base text-slate-900">Final Salary</span>
                      <span className="text-xl text-slate-900">
                        PKR{" "}
                        {calculateSalary(
                          selectedEmp.baseSalary,
                          selectedEmp.presentDays,
                          selectedEmp.workingDays
                        ).toLocaleString()}
                      </span>
                    </div>
                    <Button variant="primary" size="md" className="w-full" onClick={() => generatePayslip(selectedEmp)}>
                      Generate Payslip
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500 text-center py-8">Select an employee to view salary details</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <Modal isOpen={isPayslipModalOpen} onClose={() => setIsPayslipModalOpen(false)} title="Payslip Preview" size="lg">
        <div className="space-y-4 bg-white">
          <div className="text-center pb-4 border-b border-slate-200">
            <h3 className="text-lg text-slate-900">Company Name</h3>
            <p className="text-sm text-slate-500">Payslip for {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-slate-500 mb-1">Employee Name</p>
              <p className="text-sm text-slate-900">{payslipEmployee?.name}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Employee ID</p>
              <p className="text-sm text-slate-900">EMP-{String(payslipEmployee?.id).padStart(4, '0')}</p>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200">
            <h4 className="text-sm text-slate-900 mb-3">Earnings</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">Base Salary</span>
                <span className="text-slate-900">PKR {payslipEmployee?.baseSalary.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Working Days</span>
                <span className="text-slate-900">{payslipEmployee?.workingDays}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Present Days</span>
                <span className="text-green-600">{payslipEmployee?.presentDays}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Per Day Salary</span>
                <span className="text-slate-900">PKR {payslipEmployee ? Math.round(payslipEmployee.baseSalary / payslipEmployee.workingDays).toLocaleString() : 0}</span>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200">
            <h4 className="text-sm text-slate-900 mb-3">Deductions</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">Absent Days</span>
                <span className="text-red-600">{payslipEmployee?.absentDays}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">Deduction Amount</span>
                <span className="text-red-600">PKR {payslipEmployee ? (Math.round(payslipEmployee.baseSalary / payslipEmployee.workingDays) * payslipEmployee.absentDays).toLocaleString() : 0}</span>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t-2 border-slate-300">
            <div className="flex justify-between items-center mb-4">
              <span className="text-base text-slate-900">Net Salary</span>
              <span className="text-xl text-slate-900">
                PKR {payslipEmployee ? calculateSalary(payslipEmployee.baseSalary, payslipEmployee.presentDays, payslipEmployee.workingDays).toLocaleString() : 0}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
            <Button variant="primary" size="md" className="flex-1">
              <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Download PDF
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsPayslipModalOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
