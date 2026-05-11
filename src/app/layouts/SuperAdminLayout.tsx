import { Outlet, useNavigate } from "react-router";
import Sidebar from "../components/Sidebar";
import { hasAnyPermission, useAuth } from "../lib/auth";
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

type LinkDef = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  perms?: string[]; // any-of; undefined = always visible
};

export default function SuperAdminLayout() {
  const { profile, company, setViewAsCompany } = useAuth();
  const navigate = useNavigate();

  const isSsaViewing =
    profile?.role === "super_super_admin" && !!profile.view_as_company;

  const allLinks: LinkDef[] = [
    { to: "/super-admin", label: "Dashboard", icon: LayoutDashboard }, // always visible
    { to: "/super-admin/users", label: "User Management", icon: Users, perms: ["users.manage"] },
    { to: "/super-admin/employees", label: "Employees", icon: UserCircle, perms: ["employees.view", "employees.edit"] },
    { to: "/super-admin/attendance", label: "Attendance", icon: Calendar, perms: ["attendance.view", "attendance.edit"] },
    { to: "/super-admin/payroll", label: "Payroll", icon: DollarSign, perms: ["payroll.view", "payroll.edit"] },
    { to: "/super-admin/accounting", label: "Accounting", icon: BookOpen, perms: ["accounting.view", "accounting.edit"] },
    { to: "/super-admin/reports", label: "Financial Reports", icon: FileText, perms: ["reports.view"] },
    { to: "/super-admin/expenses", label: "Expenses", icon: Receipt, perms: ["expenses.view", "expenses.edit"] },
    { to: "/super-admin/invoices", label: "Invoices", icon: ReceiptText, perms: ["invoices.view", "invoices.edit"] },
    { to: "/super-admin/cashflow", label: "Cashflow", icon: TrendingUp, perms: ["cashflow.view"] },
    { to: "/super-admin/inventory", label: "Inventory", icon: Package, perms: ["inventory.view", "inventory.edit"] },
    { to: "/super-admin/documents", label: "Documents", icon: Folder, perms: ["documents.view", "documents.edit"] },
    { to: "/super-admin/compliance", label: "Compliance & Alerts", icon: Bell, perms: ["compliance.view", "compliance.edit"] },
    { to: "/super-admin/settings", label: "Settings", icon: SettingsIcon, perms: ["settings.view", "settings.edit"] },
  ];

  const links = allLinks
    .filter((l) => !l.perms || hasAnyPermission(profile, l.perms))
    .map(({ to, label, icon }) => ({ to, label, icon }));

  const handleExitView = async () => {
    await setViewAsCompany(null);
    navigate("/super-super-admin", { replace: true });
  };

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar
        title={isSsaViewing ? `Viewing: ${company?.name ?? "…"}` : (company?.name ?? "Company Panel")}
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
