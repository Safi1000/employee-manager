import { Outlet, useNavigate } from "react-router";
import Sidebar from "../components/Sidebar";
import { useAuth } from "../lib/auth";
import { Eye, X } from "lucide-react";
import {
  LayoutDashboard,
  Users,
  UserCircle,
  Calendar,
  DollarSign,
  Receipt,
  ReceiptText,
  TrendingUp,
  Settings as SettingsIcon,
  BookOpen,
  FileText,
  Package,
  Bell,
  Folder,
} from "lucide-react";

export default function SuperAdminLayout() {
  const { profile, company, setViewAsCompany } = useAuth();
  const navigate = useNavigate();

  const isSsaViewing =
    profile?.role === "super_super_admin" && !!profile.view_as_company;

  const links = [
    { to: "/super-admin", label: "Dashboard", icon: LayoutDashboard },
    { to: "/super-admin/users", label: "User Management", icon: Users },
    { to: "/super-admin/employees", label: "Employees", icon: UserCircle },
    { to: "/super-admin/attendance", label: "Attendance", icon: Calendar },
    { to: "/super-admin/payroll", label: "Payroll", icon: DollarSign },
    { to: "/super-admin/accounting", label: "Accounting", icon: BookOpen },
    { to: "/super-admin/reports", label: "Financial Reports", icon: FileText },
    { to: "/super-admin/expenses", label: "Expenses", icon: Receipt },
    { to: "/super-admin/invoices", label: "Invoices", icon: ReceiptText },
    { to: "/super-admin/cashflow", label: "Cashflow", icon: TrendingUp },
    { to: "/super-admin/inventory", label: "Inventory", icon: Package },
    { to: "/super-admin/documents", label: "Documents", icon: Folder },
    { to: "/super-admin/compliance", label: "Compliance & Alerts", icon: Bell },
    { to: "/super-admin/settings", label: "Settings", icon: SettingsIcon },
  ];

  const handleExitView = async () => {
    await setViewAsCompany(null);
    navigate("/super-super-admin", { replace: true });
  };

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar
        title={isSsaViewing ? `Viewing: ${company?.name ?? "…"}` : "Super Admin"}
        links={links}
      />
      <div className="flex-1 flex flex-col overflow-hidden pt-12 md:pt-0">
        {isSsaViewing && (
          <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 text-amber-900">
              <Eye className="w-4 h-4" strokeWidth={1.5} />
              <span>
                You are viewing <strong>{company?.name ?? ""}</strong> as Super Super Admin.
              </span>
            </div>
            <button
              onClick={handleExitView}
              className="flex items-center gap-1 px-3 py-1 rounded text-amber-900 hover:bg-amber-100"
            >
              <X className="w-4 h-4" strokeWidth={1.5} /> Exit view
            </button>
          </div>
        )}
        <Outlet />
      </div>
    </div>
  );
}
