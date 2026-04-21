import { Outlet } from "react-router";
import Sidebar from "../components/Sidebar";
import {
  LayoutDashboard,
  Users,
  UserCircle,
  Calendar,
  DollarSign,
  Receipt,
  TrendingUp,
  Settings as SettingsIcon,
  BookOpen,
  FileText,
  Package,
  Bell,
  Folder,
} from "lucide-react";

export default function SuperAdminLayout() {
  const links = [
    { to: "/super-admin", label: "Dashboard", icon: LayoutDashboard },
    { to: "/super-admin/users", label: "User Management", icon: Users },
    { to: "/super-admin/employees", label: "Employees", icon: UserCircle },
    { to: "/super-admin/attendance", label: "Attendance", icon: Calendar },
    { to: "/super-admin/payroll", label: "Payroll", icon: DollarSign },
    { to: "/super-admin/accounting", label: "Accounting", icon: BookOpen },
    { to: "/super-admin/reports", label: "Financial Reports", icon: FileText },
    { to: "/super-admin/expenses", label: "Expenses", icon: Receipt },
    { to: "/super-admin/cashflow", label: "Cashflow", icon: TrendingUp },
    { to: "/super-admin/inventory", label: "Inventory", icon: Package },
    { to: "/super-admin/documents", label: "Documents", icon: Folder },
    { to: "/super-admin/compliance", label: "Compliance & Alerts", icon: Bell },
    { to: "/super-admin/settings", label: "Settings", icon: SettingsIcon },
  ];

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar title="Super Admin" links={links} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
