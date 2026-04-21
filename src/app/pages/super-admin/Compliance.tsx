import { useState } from "react";
import { Plus, Bell, Calendar as CalendarIcon, AlertCircle } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import Alert from "../../components/Alert";

export default function Compliance() {
  const [isDateModalOpen, setIsDateModalOpen] = useState(false);
  const [isEditDateModalOpen, setIsEditDateModalOpen] = useState(false);
  const [isConfigureAlertModalOpen, setIsConfigureAlertModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"dates" | "alerts" | "recurring">("dates");
  const [selectedDate, setSelectedDate] = useState<any>(null);
  const [selectedRecurringAlert, setSelectedRecurringAlert] = useState<any>(null);

  const [importantDates, setImportantDates] = useState([
    { id: 1, title: "Weapon License Renewal - GL-001-2024", date: "2026-05-18", category: "License", priority: "high", daysRemaining: 30 },
    { id: 2, title: "Operational License Renewal", date: "2026-06-15", category: "License", priority: "high", daysRemaining: 58 },
    { id: 3, title: "Tax Filing Deadline", date: "2026-05-13", category: "Tax", priority: "critical", daysRemaining: 25 },
    { id: 4, title: "Partnership Review Meeting", date: "2026-05-01", category: "Internal", priority: "medium", daysRemaining: 13 },
    { id: 5, title: "Employee Contract Renewals", date: "2026-06-01", category: "HR", priority: "medium", daysRemaining: 44 },
  ]);

  const [alerts, setAlerts] = useState([
    { id: 1, type: "warning", message: "Weapon license GL-001-2024 expires in 30 days", date: "Today", active: true },
    { id: 2, type: "error", message: "Tax filing due on May 13 (automated monthly reminder)", date: "Today", active: true },
    { id: 3, type: "info", message: "5 employee documents pending review", date: "Yesterday", active: true },
    { id: 4, type: "warning", message: "Attendance not marked for F-7 location on April 16", date: "2 days ago", active: true },
  ]);

  const [recurringAlerts, setRecurringAlerts] = useState([
    { id: 1, name: "Monthly Tax Filing Reminder", frequency: "Monthly", day: "13th", advanceNotice: "Same day", active: true },
    { id: 2, name: "License Renewal Warnings", frequency: "Dynamic", day: "-", advanceNotice: "30 days before", active: true },
    { id: 3, name: "Payroll Processing Reminder", frequency: "Monthly", day: "Last working day", advanceNotice: "2 days before", active: true },
    { id: 4, name: "Attendance Completeness Check", frequency: "Daily", day: "Every day", advanceNotice: "9:00 PM", active: true },
  ]);

  const dismissAlert = (id: number) => {
    setAlerts(alerts.filter(alert => alert.id !== id));
  };

  const editDate = (date: any) => {
    setSelectedDate(date);
    setIsEditDateModalOpen(true);
  };

  const configureAlert = (alert: any) => {
    setSelectedRecurringAlert(alert);
    setIsConfigureAlertModalOpen(true);
  };

  const toggleRecurringAlert = (id: number) => {
    setRecurringAlerts(recurringAlerts.map(alert =>
      alert.id === id ? { ...alert, active: !alert.active } : alert
    ));
  };

  return (
    <>
      <Header
        title="Compliance & Alerts"
        actions={
          <Button variant="primary" size="md" onClick={() => setIsDateModalOpen(true)}>
            <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
            Add Important Date
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-8">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-6">
          <div className="bg-red-50 p-4 rounded-lg border border-red-200">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-red-700">Critical Alerts</p>
              <AlertCircle className="w-5 h-5 text-red-600" strokeWidth={1.5} />
            </div>
            <p className="text-2xl text-red-900">1</p>
          </div>
          <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-amber-700">High Priority</p>
              <Bell className="w-5 h-5 text-amber-600" strokeWidth={1.5} />
            </div>
            <p className="text-2xl text-amber-900">2</p>
          </div>
          <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-blue-700">Upcoming Deadlines</p>
              <CalendarIcon className="w-5 h-5 text-blue-600" strokeWidth={1.5} />
            </div>
            <p className="text-2xl text-blue-900">5</p>
          </div>
          <div className="bg-green-50 p-4 rounded-lg border border-green-200">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-green-700">Active Alerts</p>
              <Bell className="w-5 h-5 text-green-600" strokeWidth={1.5} />
            </div>
            <p className="text-2xl text-green-900">4</p>
          </div>
        </div>

        <div className="mb-6 space-y-3">
          {alerts.slice(0, 2).map((alert) => (
            <Alert
              key={alert.id}
              type={alert.type as "success" | "error" | "warning" | "info"}
              message={alert.message}
              onClose={() => console.log("Dismiss")}
            />
          ))}
        </div>

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <div className="flex gap-2">
              {([
                { key: "dates", label: "Important Dates" },
                { key: "alerts", label: "Active Alerts" },
                { key: "recurring", label: "Recurring Alerts" },
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

          {activeTab === "dates" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Title</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Date</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Category</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Days Remaining</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Priority</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {importantDates.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <CalendarIcon
                            className={`w-4 h-4 ${
                              item.priority === "critical"
                                ? "text-red-600"
                                : item.priority === "high"
                                ? "text-amber-600"
                                : "text-blue-600"
                            }`}
                            strokeWidth={1.5}
                          />
                          <span className="text-sm text-slate-900">{item.title}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{item.date}</td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs bg-slate-100 text-slate-700">
                          {item.category}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`text-sm ${
                            item.daysRemaining <= 30 ? "text-red-600" : "text-slate-600"
                          }`}
                        >
                          {item.daysRemaining} days
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                            item.priority === "critical"
                              ? "bg-red-100 text-red-700"
                              : item.priority === "high"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-blue-100 text-blue-700"
                          }`}
                        >
                          {item.priority}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <Button variant="ghost" size="sm" onClick={() => editDate(item)}>
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "alerts" && (
            <div className="divide-y divide-slate-200">
              {alerts.map((alert) => (
                <div key={alert.id} className="p-6 flex items-start gap-4 hover:bg-slate-50 transition-colors">
                  <div className="flex-shrink-0">
                    {alert.type === "error" && <AlertCircle className="w-5 h-5 text-red-600" strokeWidth={1.5} />}
                    {alert.type === "warning" && <AlertCircle className="w-5 h-5 text-amber-600" strokeWidth={1.5} />}
                    {alert.type === "info" && <Bell className="w-5 h-5 text-blue-600" strokeWidth={1.5} />}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-slate-900 mb-1">{alert.message}</p>
                    <p className="text-xs text-slate-500">{alert.date}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => dismissAlert(alert.id)}>
                      Dismiss
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => console.log("View alert details")}>
                      View
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === "recurring" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Alert Name</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Frequency</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Trigger Day</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Advance Notice</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {recurringAlerts.map((alert) => (
                    <tr key={alert.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 text-sm text-slate-900">{alert.name}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{alert.frequency}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{alert.day}</td>
                      <td className="px-6 py-4 text-sm text-blue-600">{alert.advanceNotice}</td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                            alert.active ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {alert.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-6 py-4 flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => configureAlert(alert)}>
                          Configure
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleRecurringAlert(alert.id)}
                        >
                          {alert.active ? "Deactivate" : "Activate"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="mt-6 bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="text-base mb-4 text-slate-900">Calendar View</h3>
          <div className="grid grid-cols-7 gap-2">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
              <div key={day} className="text-center text-xs text-slate-500 py-2">
                {day}
              </div>
            ))}
            {Array.from({ length: 35 }, (_, i) => {
              const dayNum = i - 5;
              const hasEvent = [13, 18, 30].includes(dayNum);
              return (
                <div
                  key={i}
                  className={`aspect-square flex items-center justify-center rounded-md text-sm ${
                    dayNum < 1 || dayNum > 30
                      ? "text-slate-300"
                      : hasEvent
                      ? "bg-red-100 text-red-900 border border-red-300"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {dayNum > 0 && dayNum <= 30 ? dayNum : ""}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <Modal isOpen={isDateModalOpen} onClose={() => setIsDateModalOpen(false)} title="Add Important Date" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Title</label>
            <input
              type="text"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="e.g., License Renewal"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Date</label>
            <input
              type="date"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Category</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
              <option>License</option>
              <option>Tax</option>
              <option>HR</option>
              <option>Internal</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Priority</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
              <option>Critical</option>
              <option>High</option>
              <option>Medium</option>
              <option>Low</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Advance Notice (days)</label>
            <input
              type="number"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="30"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Add Date
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsDateModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isEditDateModalOpen} onClose={() => setIsEditDateModalOpen(false)} title="Edit Important Date" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Title</label>
            <input
              type="text"
              defaultValue={selectedDate?.title}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="e.g., License Renewal"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Date</label>
            <input
              type="date"
              defaultValue={selectedDate?.date}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Category</label>
            <select
              defaultValue={selectedDate?.category}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            >
              <option>License</option>
              <option>Tax</option>
              <option>HR</option>
              <option>Internal</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Priority</label>
            <select
              defaultValue={selectedDate?.priority}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            >
              <option>Critical</option>
              <option>High</option>
              <option>Medium</option>
              <option>Low</option>
            </select>
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Update Date
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsEditDateModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isConfigureAlertModalOpen} onClose={() => setIsConfigureAlertModalOpen(false)} title="Configure Recurring Alert" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Alert Name</label>
            <input
              type="text"
              defaultValue={selectedRecurringAlert?.name}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="e.g., Monthly Tax Filing Reminder"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Frequency</label>
            <select
              defaultValue={selectedRecurringAlert?.frequency}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            >
              <option>Daily</option>
              <option>Weekly</option>
              <option>Monthly</option>
              <option>Dynamic</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Trigger Day</label>
            <input
              type="text"
              defaultValue={selectedRecurringAlert?.day}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="e.g., 13th"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Advance Notice</label>
            <input
              type="text"
              defaultValue={selectedRecurringAlert?.advanceNotice}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="e.g., Same day, 30 days before"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Save Configuration
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsConfigureAlertModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
