import { Users, Calendar, Receipt, DollarSign, Building2, TrendingUp, AlertCircle } from "lucide-react";
import Header from "../../components/Header";
import StatCard from "../../components/StatCard";
import Alert from "../../components/Alert";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { hasPermission, useAuth } from "../../lib/auth";

const bankAccounts = [
  { name: "Allied Bank - Operations", balance: 2500000, color: "#3b82f6" },
  { name: "HBL - Payroll", balance: 1800000, color: "#10b981" },
  { name: "MCB - Client Receivables", balance: 950000, color: "#8b5cf6" },
];

const revenueByClient = [
  { id: "a", client: "Client A", revenue: 450000 },
  { id: "b", client: "Client B", revenue: 380000 },
  { id: "c", client: "Client C", revenue: 520000 },
  { id: "d", client: "Client D", revenue: 290000 },
  { id: "e", client: "Client E", revenue: 410000 },
  { id: "f", client: "Client F", revenue: 360000 },
  { id: "g", client: "Client G", revenue: 480000 },
  { id: "h", client: "Client H", revenue: 320000 },
];

const attendanceData = [
  { id: 1, date: "Apr 11", present: 220, absent: 18, leave: 10 },
  { id: 2, date: "Apr 12", present: 228, absent: 12, leave: 8 },
  { id: 3, date: "Apr 13", present: 218, absent: 20, leave: 10 },
  { id: 4, date: "Apr 14", present: 225, absent: 15, leave: 8 },
  { id: 5, date: "Apr 15", present: 222, absent: 16, leave: 10 },
  { id: 6, date: "Apr 16", present: 230, absent: 10, leave: 8 },
  { id: 7, date: "Apr 17", present: 226, absent: 14, leave: 8 },
];

const recentActivity = [
  { action: "License renewal due in 30 days", type: "warning", time: "Today" },
  { action: "New employee added", user: "John Smith", time: "2 hours ago" },
  { action: "Payroll processed for March", user: "System", time: "5 hours ago" },
  { action: "Attendance not marked for F-7 location", type: "alert", time: "Yesterday" },
];

export default function SuperAdminDashboard() {
  const { profile } = useAuth();

  const can = {
    compliance: hasPermission(profile, "compliance.view"),
    employees: hasPermission(profile, "employees.view"),
    attendance: hasPermission(profile, "attendance.view"),
    expenses: hasPermission(profile, "expenses.view"),
    payroll: hasPermission(profile, "payroll.view"),
    accounting: hasPermission(profile, "accounting.view"),
    reports: hasPermission(profile, "reports.view"),
  };

  const visibleStatCards =
    [can.employees, can.attendance, can.expenses, can.payroll].filter(Boolean).length;
  const visibleMidCharts =
    [can.accounting, can.reports].filter(Boolean).length;
  const visibleBottomCharts =
    [can.attendance, true /* recent activity always visible */].filter(Boolean).length;

  const nothingToShow =
    !can.compliance &&
    !can.employees &&
    !can.attendance &&
    !can.expenses &&
    !can.payroll &&
    !can.accounting &&
    !can.reports;

  return (
    <>
      <Header title="Dashboard" />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {nothingToShow && (
          <div className="bg-white border border-slate-200 rounded-lg p-12 text-center">
            <h3 className="text-base text-slate-900 mb-2">Nothing to show yet</h3>
            <p className="text-sm text-slate-500">
              You don&apos;t have any feature permissions yet. Ask a Super Admin to grant you access.
            </p>
          </div>
        )}

        {can.compliance && (
          <div className="mb-6">
            <Alert type="warning" message="Weapon license renewal required by May 18, 2026 - 30 days remaining" />
          </div>
        )}

        {visibleStatCards > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-6 md:mb-8">
            {can.employees && (
              <StatCard
                title="Total Employees"
                value={248}
                icon={Users}
                trend={{ value: "+12 this month", positive: true }}
              />
            )}
            {can.attendance && (
              <StatCard
                title="Attendance Today"
                value="92%"
                icon={Calendar}
                trend={{ value: "+3% from yesterday", positive: true }}
              />
            )}
            {can.expenses && (
              <StatCard
                title="Total Expenses"
                value="PKR 61,000"
                icon={Receipt}
                trend={{ value: "+15% from last month", positive: false }}
              />
            )}
            {can.payroll && (
              <StatCard
                title="Payroll"
                value="PKR 2.4M"
                icon={DollarSign}
                trend={{ value: "Processed", positive: true }}
              />
            )}
          </div>
        )}

        {visibleMidCharts > 0 && (
          <div className={`grid grid-cols-1 ${visibleMidCharts === 2 ? "lg:grid-cols-2" : ""} gap-6 mb-6 md:mb-8`}>
            {can.accounting && (
              <div className="bg-white rounded-lg border border-slate-200 p-6">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-base text-slate-900">Bank Account Overview</h3>
                  <Building2 className="w-5 h-5 text-blue-600" strokeWidth={1.5} />
                </div>
                <div className="space-y-4">
                  {bankAccounts.map((account, index) => (
                    <div key={index} className="border-l-4 pl-4 py-2" style={{ borderColor: account.color }}>
                      <div className="flex justify-between items-center mb-1">
                        <p className="text-sm text-slate-700">{account.name}</p>
                        <p className="text-base" style={{ color: account.color }}>
                          PKR {account.balance.toLocaleString()}
                        </p>
                      </div>
                      <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(account.balance / 2500000) * 100}%`,
                            backgroundColor: account.color,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                  <div className="pt-4 border-t border-slate-200">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-slate-600">Total Cash Balance</span>
                      <span className="text-lg text-slate-900">
                        PKR {bankAccounts.reduce((sum, acc) => sum + acc.balance, 0).toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {can.reports && (
              <div className="bg-white rounded-lg border border-slate-200 p-6">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-base text-slate-900">Revenue by Client (Monthly)</h3>
                  <TrendingUp className="w-5 h-5 text-green-600" strokeWidth={1.5} />
                </div>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={revenueByClient}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="client" tick={{ fill: '#64748b', fontSize: 12 }} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="revenue" fill="#10b981" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}

        {visibleBottomCharts > 0 && (
          <div className={`grid grid-cols-1 ${visibleBottomCharts === 2 ? "lg:grid-cols-2" : ""} gap-6 mb-6 md:mb-8`}>
            {can.attendance && (
              <div className="bg-white rounded-lg border border-slate-200 p-6">
                <h3 className="text-base mb-6 text-slate-900">Attendance Trend (7 Days)</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={attendanceData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 12 }} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 12 }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="present" stroke="#10b981" strokeWidth={2} dot={{ fill: '#10b981' }} name="Present" />
                    <Line type="monotone" dataKey="absent" stroke="#ef4444" strokeWidth={2} dot={{ fill: '#ef4444' }} name="Absent" />
                    <Line type="monotone" dataKey="leave" stroke="#f59e0b" strokeWidth={2} dot={{ fill: '#f59e0b' }} name="Leave" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            <div className="bg-white rounded-lg border border-slate-200">
              <div className="p-6 border-b border-slate-200">
                <h3 className="text-base text-slate-900">Recent Activity & Alerts</h3>
              </div>
              <div className="divide-y divide-slate-200">
                {recentActivity.map((item, index) => (
                  <div key={index} className="p-4 flex items-start gap-3 hover:bg-slate-50 transition-colors">
                    {item.type === "warning" && (
                      <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" strokeWidth={1.5} />
                    )}
                    {item.type === "alert" && (
                      <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" strokeWidth={1.5} />
                    )}
                    <div className="flex-1">
                      <p className="text-sm text-slate-900 mb-1">{item.action}</p>
                      {item.user && <p className="text-xs text-slate-500">{item.user}</p>}
                    </div>
                    <span className="text-xs text-slate-400">{item.time}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
