import { Outlet, useNavigate } from "react-router";
import Sidebar, { type SidebarItem } from "../components/Sidebar";
import AiChatWidget from "../components/AiChatWidget";
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
  FileText,
  Package,
  Bell,
  Folder,
  Shuffle,
  Trello,
  Landmark,
  Building2,
  FileSignature,
  ShieldAlert,
  CalendarRange,
  Siren,
} from "lucide-react";

type LinkDef = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  perms?: string[];
};

const has = (
  profile: Parameters<typeof hasAnyPermission>[0],
  perms?: string[],
) => !perms || hasAnyPermission(profile, perms);

const linkOrNull = (
  profile: Parameters<typeof hasAnyPermission>[0],
  def: LinkDef,
) =>
  has(profile, def.perms)
    ? { to: def.to, label: def.label, icon: def.icon }
    : null;

export default function SuperAdminLayout() {
  const { profile, company, setViewAsCompany } = useAuth();
  const navigate = useNavigate();

  const isSsaViewing =
    profile?.role === "super_super_admin" && !!profile.view_as_company;

  // Module definitions with their permission gates.
  const DASHBOARD: LinkDef = { to: "/super-admin", label: "Dashboard", icon: LayoutDashboard };
  const CLIENTS: LinkDef = { to: "/super-admin/clients", label: "Clients", icon: Building2, perms: ["settings.view", "settings.edit"] };
  const CONTRACTS: LinkDef = { to: "/super-admin/contracts", label: "Contracts", icon: FileSignature, perms: ["settings.view", "settings.edit"] };
  const LICENCES: LinkDef = { to: "/super-admin/licences", label: "Licences & Renewals", icon: ShieldAlert, perms: ["compliance.view", "compliance.edit"] };
  const INVOICES: LinkDef = { to: "/super-admin/invoices", label: "Invoices", icon: ReceiptText, perms: ["invoices.view", "invoices.edit"] };
  const EMPLOYEES: LinkDef = { to: "/super-admin/employees", label: "Employees", icon: UserCircle, perms: ["employees.view", "employees.edit"] };
  const ATTENDANCE: LinkDef = { to: "/super-admin/attendance", label: "Attendance", icon: Calendar, perms: ["attendance.view", "attendance.edit"] };
  const PAYROLL: LinkDef = { to: "/super-admin/payroll", label: "Payroll", icon: DollarSign, perms: ["payroll.view", "payroll.edit"] };
  const RELIEVER_ATT: LinkDef = { to: "/super-admin/relievers/attendance", label: "Attendance", icon: Calendar, perms: ["attendance.view", "attendance.edit"] };
  const RELIEVER_PAY: LinkDef = { to: "/super-admin/relievers/payroll", label: "Payroll", icon: DollarSign, perms: ["payroll.view", "payroll.edit"] };
  const INVENTORY: LinkDef = { to: "/super-admin/inventory", label: "Inventory", icon: Package, perms: ["inventory.view", "inventory.edit"] };
  const ROSTER: LinkDef = { to: "/super-admin/roster", label: "Deployment Roster", icon: CalendarRange, perms: ["attendance.view", "attendance.edit"] };
  const INCIDENTS: LinkDef = { to: "/super-admin/incidents", label: "Incidents", icon: Siren, perms: ["attendance.view", "attendance.edit"] };
  const BANKS: LinkDef = { to: "/super-admin/accounting", label: "Banks & Ledgers", icon: Landmark, perms: ["accounting.view", "accounting.edit"] };
  const EXPENSES: LinkDef = { to: "/super-admin/expenses", label: "Expenses", icon: Receipt, perms: ["expenses.view", "expenses.edit"] };
  const CASHFLOW: LinkDef = { to: "/super-admin/cashflow", label: "Cash Flow", icon: TrendingUp, perms: ["cashflow.view"] };
  const REPORTS: LinkDef = { to: "/super-admin/reports", label: "Financial Reports", icon: FileText, perms: ["reports.view"] };
  const COMPLIANCE: LinkDef = { to: "/super-admin/compliance", label: "Compliance Calendar", icon: Bell, perms: ["compliance.view", "compliance.edit"] };
  const DOCUMENTS: LinkDef = { to: "/super-admin/documents", label: "Documents", icon: Folder, perms: ["documents.view", "documents.edit"] };
  const TASKS: LinkDef = { to: "/super-admin/tasks", label: "Tasks", icon: Trello };
  const USERS: LinkDef = { to: "/super-admin/users", label: "Users & Permissions", icon: Users, perms: ["users.manage"] };
  const SETTINGS: LinkDef = { to: "/super-admin/settings", label: "Settings", icon: SettingsIcon, perms: ["settings.view", "settings.edit"] };

  // Build groups, dropping any link the user lacks permission for. Drop the
  // group entirely if it ends up with no visible children.
  const buildGroup = (
    label: string,
    basePath: string,
    children: Array<LinkDef | { _group: true; label: string; basePath: string; icon?: typeof LayoutDashboard; children: LinkDef[] }>,
  ): SidebarItem | null => {
    const visibleChildren: SidebarItem[] = [];
    for (const c of children) {
      if ("_group" in c) {
        const subChildren = c.children
          .map((cd) => linkOrNull(profile, cd))
          .filter((x): x is { to: string; label: string; icon: typeof LayoutDashboard } => x !== null);
        if (subChildren.length === 0) continue;
        visibleChildren.push({
          type: "group",
          label: c.label,
          icon: c.icon,
          basePath: c.basePath,
          variant: "collapsible",
          children: subChildren,
        });
      } else {
        const link = linkOrNull(profile, c);
        if (link) visibleChildren.push(link);
      }
    }
    if (visibleChildren.length === 0) return null;
    return {
      type: "group",
      label,
      basePath,
      variant: "section",
      children: visibleChildren,
    };
  };

  const links: SidebarItem[] = [];

  // OVERVIEW
  const overview = buildGroup("Overview", "/super-admin/overview", [DASHBOARD]);
  if (overview) links.push(overview);

  // CONTRACTS & CLIENTS
  const contractsClients = buildGroup("Contracts & Clients", "/super-admin/billing", [
    CLIENTS,
    CONTRACTS,
    INVOICES,
  ]);
  if (contractsClients) links.push(contractsClients);

  // WORKFORCE
  const workforce = buildGroup("Workforce", "/super-admin/workforce", [
    EMPLOYEES,
    ATTENDANCE,
    PAYROLL,
    {
      _group: true,
      label: "Relievers",
      basePath: "/super-admin/relievers",
      icon: Shuffle,
      children: [RELIEVER_ATT, RELIEVER_PAY],
    },
  ]);
  if (workforce) links.push(workforce);

  // OPERATIONS
  const operations = buildGroup("Operations", "/super-admin/operations", [
    ROSTER,
    INCIDENTS,
    INVENTORY,
  ]);
  if (operations) links.push(operations);

  // FINANCE
  const finance = buildGroup("Finance", "/super-admin/finance", [
    BANKS,
    EXPENSES,
    CASHFLOW,
    REPORTS,
  ]);
  if (finance) links.push(finance);

  // COMPLIANCE
  const compliance = buildGroup("Compliance", "/super-admin/comply", [
    LICENCES,
    COMPLIANCE,
    DOCUMENTS,
  ]);
  if (compliance) links.push(compliance);

  // ADMIN
  const admin = buildGroup("Admin", "/super-admin/admin", [
    TASKS,
    USERS,
    SETTINGS,
  ]);
  if (admin) links.push(admin);

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
          <div className="bg-warning-50 border-b border-warning-200 px-6 py-2 flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 text-warning-900">
              <Eye className="w-4 h-4" strokeWidth={1.5} />
              <span>
                You are viewing <strong>{company?.name ?? ""}</strong> as Super Super Admin.
              </span>
            </div>
            <button
              onClick={handleExitView}
              className="flex items-center gap-1 px-3 py-1 rounded text-warning-900 hover:bg-warning-100"
            >
              <X className="w-4 h-4" strokeWidth={1.5} /> Exit view
            </button>
          </div>
        )}
        <Outlet />
      </div>
      <AiChatWidget />
    </div>
  );
}
