import { Outlet } from "react-router";
import Sidebar from "../components/Sidebar";
import {
  LayoutDashboard,
  Calendar,
  DollarSign,
  Receipt,
  TrendingUp,
} from "lucide-react";

export default function AccountsLayout() {
  const links = [
    { to: "/accounts", label: "Dashboard", icon: LayoutDashboard },
    { to: "/accounts/attendance", label: "Attendance", icon: Calendar },
    { to: "/accounts/payroll", label: "Payroll", icon: DollarSign },
    { to: "/accounts/expenses", label: "Expenses", icon: Receipt },
    { to: "/accounts/cashflow", label: "Cash Flow", icon: TrendingUp },
  ];

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar title="Accounts Panel" links={links} />
      <div className="flex-1 flex flex-col overflow-hidden pt-12 md:pt-0">
        <Outlet />
      </div>
    </div>
  );
}
