import { useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

const dailyData = [
  { id: 1, date: "Apr 11", income: 85000, expenses: 12000, payroll: 0 },
  { id: 2, date: "Apr 12", income: 92000, expenses: 15000, payroll: 0 },
  { id: 3, date: "Apr 13", income: 78000, expenses: 8500, payroll: 0 },
  { id: 4, date: "Apr 14", income: 88000, expenses: 25000, payroll: 0 },
  { id: 5, date: "Apr 15", income: 95000, expenses: 15000, payroll: 120000 },
  { id: 6, date: "Apr 16", income: 82000, expenses: 10000, payroll: 0 },
  { id: 7, date: "Apr 17", income: 89000, expenses: 18000, payroll: 0 },
  { id: 8, date: "Apr 18", income: 91000, expenses: 16000, payroll: 0 },
  { id: 9, date: "Apr 19", income: 86000, expenses: 14000, payroll: 0 },
  { id: 10, date: "Apr 20", income: 94000, expenses: 19000, payroll: 0 },
];

const weeklyData = [
  { id: 1, week: "Week 1", income: 580000, expenses: 45000, payroll: 0 },
  { id: 2, week: "Week 2", income: 615000, expenses: 52000, payroll: 600000 },
  { id: 3, week: "Week 3", income: 592000, expenses: 48000, payroll: 0 },
  { id: 4, week: "Week 4", income: 625000, expenses: 61000, payroll: 0 },
  { id: 5, week: "Week 5", income: 610000, expenses: 55000, payroll: 1800000 },
];

const monthlyData = [
  { id: 1, month: "Jan", income: 2350000, expenses: 180000, payroll: 2400000 },
  { id: 2, month: "Feb", income: 2420000, expenses: 195000, payroll: 2400000 },
  { id: 3, month: "Mar", income: 2580000, expenses: 210000, payroll: 2400000 },
  { id: 4, month: "Apr", income: 2680000, expenses: 206000, payroll: 2400000 },
  { id: 5, month: "May", income: 2520000, expenses: 198000, payroll: 2400000 },
  { id: 6, month: "Jun", income: 2650000, expenses: 215000, payroll: 2400000 },
];

export default function Cashflow() {
  const [activeTab, setActiveTab] = useState<"daily" | "weekly" | "monthly">("daily");

  const getData = () => {
    if (activeTab === "daily") return dailyData;
    if (activeTab === "weekly") return weeklyData;
    return monthlyData;
  };

  const getXAxisKey = () => {
    if (activeTab === "daily") return "date";
    if (activeTab === "weekly") return "week";
    return "month";
  };

  return (
    <>
      <Header title="Cashflow & Reports" />

      <div className="flex-1 overflow-y-auto p-8">
        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-6 border-b border-slate-200 flex items-center justify-between">
            <div className="flex gap-2">
              {(["daily", "weekly", "monthly"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 rounded-md text-sm transition-colors ${
                    activeTab === tab
                      ? "bg-slate-900 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
            <div className="flex gap-2 items-center">
              <Button variant="secondary" size="sm" onClick={() => window.print()}>
                Download {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} Report (PDF)
              </Button>
              <select className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent">
                <option>All Locations</option>
                <option>F-10 Islamabad</option>
                <option>F-7 Islamabad</option>
              </select>
            </div>
          </div>

          <div className="p-6">
            <ResponsiveContainer width="100%" height={350}>
              <LineChart data={getData()}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey={getXAxisKey()} tick={{ fill: '#64748b', fontSize: 12 }} />
                <YAxis tick={{ fill: '#64748b', fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="income" stroke="#10b981" strokeWidth={2} name="Income" />
                <Line type="monotone" dataKey="expenses" stroke="#ef4444" strokeWidth={2} name="Expenses" />
                <Line type="monotone" dataKey="payroll" stroke="#0f172a" strokeWidth={2} name="Payroll" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <h3 className="text-base mb-6 text-slate-900">Income vs Expenses</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={getData()}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey={getXAxisKey()} tick={{ fill: '#64748b', fontSize: 12 }} />
                <YAxis tick={{ fill: '#64748b', fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="income" fill="#10b981" radius={[4, 4, 0, 0]} name="Income" />
                <Bar dataKey="expenses" fill="#ef4444" radius={[4, 4, 0, 0]} name="Expenses" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <h3 className="text-base mb-6 text-slate-900">Payroll Impact</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={getData()}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey={getXAxisKey()} tick={{ fill: '#64748b', fontSize: 12 }} />
                <YAxis tick={{ fill: '#64748b', fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="payroll" fill="#0f172a" radius={[4, 4, 0, 0]} name="Payroll Cost" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </>
  );
}
