import { Outlet, useNavigate } from "react-router";
import Sidebar, { type SidebarItem } from "../components/Sidebar";
import AiChatWidget from "../components/AiChatWidget";
import InactivityLogout from "../components/InactivityLogout";
import RegionSelector from "../components/RegionSelector";
import TopBar from "../components/TopBar";
import { hasAnyPermission, useAuth } from "../lib/auth";
import { useRegion } from "../lib/region";
import { Eye, X } from "lucide-react";
import {
  LayoutDashboard,
  Users,
  UserCircle,
  UserPlus,
  Calendar,
  DollarSign,
  Receipt,
  ReceiptText,
  TrendingUp,
  Settings as SettingsIcon,
  CreditCard,
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
  BookOpen,
  Lock,
  History,
  Users2,
  Play,
  PieChart,
  Briefcase,
  MapPin,
  ClipboardList,
} from "lucide-react";

type LinkDef = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  perms?: string[];
  roles?: string[]; // If set, user role must be in this list (takes priority over perms)
};

const has = (
  profile: Parameters<typeof hasAnyPermission>[0],
  def: LinkDef,
) => {
  if (def.roles) return def.roles.includes(profile?.role ?? "");
  return !def.perms || hasAnyPermission(profile, def.perms);
};

const linkOrNull = (
  profile: Parameters<typeof hasAnyPermission>[0],
  def: LinkDef,
) =>
  has(profile, def)
    ? { to: def.to, label: def.label, icon: def.icon }
    : null;

export default function SuperAdminLayout() {
  const { profile, company, setViewAsCompany } = useAuth();
  const { regions, locked, region } = useRegion();
  const navigate = useNavigate();

  // Companies with a single region have nothing to switch between, so the bar
  // stays out of their way entirely.
  const showRegionBar = locked || regions.length > 1;

  const isSsaViewing =
    profile?.role === "super_super_admin" && !!profile.view_as_company;

  // Module definitions with their permission gates.
  const DASHBOARD: LinkDef = { to: "/super-admin", label: "Dashboard", icon: LayoutDashboard };
  const CLIENTS: LinkDef = { to: "/super-admin/clients", label: "Clients", icon: Building2, perms: ["clients.view", "clients.edit"] };
  const CONTRACTS: LinkDef = { to: "/super-admin/contracts", label: "Contracts", icon: FileSignature, perms: ["contracts.view", "contracts.edit"] };
  const SITES_STRENGTH: LinkDef = { to: "/super-admin/sites-strength", label: "Sites & Strength", icon: MapPin, perms: ["clients.view", "clients.edit", "contracts.view", "contracts.edit"] };
  const INVOICES: LinkDef = { to: "/super-admin/invoices", label: "Invoices", icon: ReceiptText, perms: ["invoices.view", "invoices.edit"] };
  const EMPLOYEES: LinkDef = { to: "/super-admin/employees", label: "Employees", icon: UserCircle, perms: ["employees.view", "employees.edit"] };
  const ASSIGNMENTS: LinkDef = { to: "/super-admin/assignments", label: "Assignments & Pay", icon: ClipboardList, perms: ["employees.view", "employees.edit"] };
  const ATTENDANCE: LinkDef = { to: "/super-admin/attendance", label: "Attendance", icon: Calendar, perms: ["attendance.view", "attendance.edit"] };
  const PAYROLL: LinkDef = { to: "/super-admin/payroll", label: "Payroll", icon: DollarSign, perms: ["payroll.view", "payroll.edit"] };
  const PAYROLL_RUN: LinkDef = { to: "/super-admin/payroll-run", label: "Payroll Run", icon: DollarSign, perms: ["payroll.view", "payroll.edit"] };
  const PERFORMANCE: LinkDef = { to: "/super-admin/performance", label: "Performance", icon: TrendingUp, perms: ["payroll.view", "performance.approve"] };
  const RELIEVER_ATT: LinkDef = { to: "/super-admin/relievers/attendance", label: "Attendance", icon: Calendar, perms: ["attendance.view", "attendance.edit"] };
  const RELIEVER_PAY: LinkDef = { to: "/super-admin/relievers/payroll", label: "Payroll", icon: DollarSign, perms: ["payroll.view", "payroll.edit"] };
  const INVENTORY: LinkDef = { to: "/super-admin/inventory", label: "Inventory", icon: Package, perms: ["inventory.view", "inventory.edit"] };
  const ROSTER: LinkDef = { to: "/super-admin/roster", label: "Deployment Roster", icon: CalendarRange, perms: ["roster.view", "roster.edit"] };
  const INCIDENTS: LinkDef = { to: "/super-admin/incidents", label: "Incidents", icon: Siren, perms: ["incidents.view", "incidents.edit"] };
  const BANKS: LinkDef = { to: "/super-admin/accounting", label: "Bank & Ledgers", icon: Landmark, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"] };
  const EXPENSES: LinkDef = { to: "/super-admin/expenses", label: "Expenses & Advances", icon: Receipt, perms: ["expenses.view", "expenses.edit"] };
  const CASHFLOW: LinkDef = { to: "/super-admin/cashflow", label: "Cash Flow", icon: TrendingUp, perms: ["cashflow.view"] };
  const REPORTS: LinkDef = { to: "/super-admin/reports", label: "Financial Reports", icon: FileText, perms: ["reports.view"] };
  const CHART_OF_ACCOUNTS: LinkDef = { to: "/super-admin/chart-of-accounts", label: "Chart of Accounts", icon: BookOpen, perms: ["coa.view", "reports.view"] };
  const PERIOD_CLOSE: LinkDef = { to: "/super-admin/period-close", label: "Period Close", icon: Lock, perms: ["period_close.manage", "reports.view"] };
  const AUDIT_LOG: LinkDef = { to: "/super-admin/audit-log", label: "Audit Log", icon: History, roles: ["super_super_admin", "super_admin"] };
  const PARTNERS: LinkDef = { to: "/super-admin/partners", label: "Partner Accounts", icon: Users2, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"] };
  // The partnership RUN — drafting, reviewing and posting a month — as opposed
  // to the partnership REPORT, which reads one back.
  const PARTNERSHIP_RUN: LinkDef = { to: "/super-admin/partnership-run", label: "Partnership Run", icon: Play, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"] };
  // PROFIT_DIST is deliberately absent: the /profit-distribution route was
  // removed because the screen maintained a share model no ledger function
  // reads. A LinkDef pointing at a removed route is worse than no link.
  const PROJECT_FIN: LinkDef = { to: "/super-admin/project-financing", label: "Project Financing", icon: Briefcase, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"] };
  const COMPLIANCE: LinkDef = { to: "/super-admin/compliance", label: "Compliance Calendar", icon: Bell, perms: ["compliance.view", "compliance.edit"] };
  const DOCUMENTS: LinkDef = { to: "/super-admin/documents", label: "Documents", icon: Folder, perms: ["documents.view", "documents.edit"] };
  const TASKS: LinkDef = { to: "/super-admin/tasks", label: "Tasks", icon: Trello };
  const USERS: LinkDef = { to: "/super-admin/users", label: "Users & Permissions", icon: Users, perms: ["users.manage"] };
  const SETTINGS: LinkDef = { to: "/super-admin/settings", label: "Settings", icon: SettingsIcon, perms: ["settings.view", "settings.edit"] };
  const BILLING: LinkDef = { to: "/super-admin/billing", label: "Plan & Billing", icon: CreditCard, perms: ["settings.view", "settings.edit"] };
  // New back-office surfaces (Parts II–VII).
  const TREASURY: LinkDef = { to: "/super-admin/treasury", label: "Treasury & Reserves", icon: Landmark, perms: ["banks.view", "reports.view", "cashflow.view"] };
  const ASSETS: LinkDef = { to: "/super-admin/assets", label: "Assets & Vehicles", icon: Package, perms: ["inventory.view", "inventory.edit", "banks.view"] };
  const FIELD_OPS: LinkDef = { to: "/super-admin/field-ops", label: "Field Operations", icon: Siren, perms: ["roster.view", "roster.edit", "incidents.view", "attendance.view"] };
  const COMPLIANCE_CASES: LinkDef = { to: "/super-admin/compliance-cases", label: "Compliance Cases", icon: ShieldAlert, perms: ["compliance.view", "compliance.edit"] };
  const ALERTS: LinkDef = { to: "/super-admin/alerts", label: "Alerts", icon: Bell };
  const GOVERNANCE: LinkDef = { to: "/super-admin/governance", label: "Governance", icon: Users2, perms: ["users.manage", "payroll.approve", "performance.approve", "accounting.edit"] };
  const RECEIVABLES: LinkDef = { to: "/super-admin/receivables", label: "Receivables", icon: ReceiptText, perms: ["invoices.view", "invoices.edit", "receivables.view"] };
  const OPENING_BAL: LinkDef = { to: "/super-admin/opening-balances", label: "Opening Balances", icon: BookOpen, perms: ["accounting.edit", "coa.view"] };
  // "Regional Operating Expenses" (route /super-admin/regional-scorecard) is
  // hidden from the nav by request — its LinkDef is intentionally not defined
  // here so it isn't listed. The route still exists in routes.tsx.
  const CLIENT_REL: LinkDef = { to: "/super-admin/client-relationships", label: "Client Relationships", icon: Users2, perms: ["clients.view", "clients.edit"] };

  // Consolidation restructure — merged / renamed / moved homes.
  const RELIEVERS: LinkDef = { to: "/super-admin/relievers", label: "Relievers", icon: Shuffle, perms: ["attendance.view", "attendance.edit"] };
  const DAILY_REPORTS: LinkDef = { to: "/super-admin/daily-reports", label: "Daily Reports", icon: FileText, perms: ["roster.view", "roster.edit", "incidents.view", "attendance.view"] };
  const ASSETS_ISSUANCE: LinkDef = { to: "/super-admin/assets-issuance", label: "Assets & Issuance", icon: Package, perms: ["inventory.view", "inventory.edit", "banks.view"] };
  const ACCOUNTING_CORE: LinkDef = { to: "/super-admin/accounting-core", label: "Accounting Core", icon: BookOpen, perms: ["coa.view", "reports.view", "accounting.edit"] };
  // Super admins only — it grants permissions, so it must not be reachable via
  // the permissions it grants. Matches the route guard in routes.tsx.
  const ACCESS_GOVERNANCE: LinkDef = { to: "/super-admin/access-governance", label: "Access & Governance", icon: Users, roles: ["super_super_admin", "super_admin"] };
  // PROFIT_DIST and PARTICIPATION_RULES removed with the route they pointed at.
  // Two labels, one dead screen: "Profit Distribution" was defined and never
  // pushed into a group, "Participation Rules" only ever appeared in the hidden
  // Profit-Share group. A link to a removed route is worse than no link.
  const RMD_STATEMENTS: LinkDef = { to: "/super-admin/partners", label: "RMD Statements", icon: Users2, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"] };
  const PARTNERSHIP_REPORT: LinkDef = { to: "/super-admin/partnership-report", label: "Partnership Report", icon: Users2, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"] };

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

  // CLIENTS & CONTRACTS — Sites & Strength split out (headcount → Operations ▸
  // Deployment; billing → Invoices); Client Relationships dissolved (complaints
  // → Incidents, renewals → Compliance, reviews → client record).
  const contractsClients = buildGroup("Clients & Contracts", "/super-admin/billing", [
    CLIENTS,
    CONTRACTS,
    INVOICES,
  ]);
  if (contractsClients) links.push(contractsClients);

  // WORKFORCE — Payroll now hosts Runs as a tab; Relievers is one thin panel
  // (per-day cost nets against the client, separate from salaried Payroll).
  // Recruitment removed; Performance hidden (route kept, just not in the nav).
  const workforce = buildGroup("Workforce", "/super-admin/workforce", [
    EMPLOYEES,
    ASSIGNMENTS,
    ATTENDANCE,
    PAYROLL,
    PAYROLL_RUN,
    RELIEVERS,
  ]);
  if (workforce) links.push(workforce);

  // OPERATIONS — Roster killed (supervisor handles it); Deployment merged into
  // Workforce ▸ Assignments & Pay; Field Ops repurposed → Daily Reports;
  // Inventory + Assets merged → Assets & Issuance.
  const operations = buildGroup("Operations", "/super-admin/operations", [
    DAILY_REPORTS,
    INCIDENTS,
    ASSETS_ISSUANCE,
  ]);
  if (operations) links.push(operations);

  // FINANCE — Opening Balances + Chart of Accounts merged → Accounting Core.
  // Receivables folded into Bank & Ledgers. Treasury moved out to Profit-Share.
  const finance = buildGroup("Finance", "/super-admin/finance", [
    BANKS,
    // Unhidden. It was hidden when it was a merge of two screens nobody used;
    // it is now the only way in to the Chart of Accounts, the Trial Balance,
    // the Journal and Opening Balances, which are its four tabs. Hiding the
    // entrance to the ledger while asking people to enter financials against it
    // is the wrong way round.
    ACCOUNTING_CORE,
    EXPENSES,
    // Cash Flow is now merged into Financial Reports as a top-level tab, so its
    // own nav link is hidden (CASHFLOW LinkDef and the /cashflow route are kept).
    REPORTS,
    // Its own Finance entry rather than a tab inside Financial Reports: it is a
    // report about partners, not about the P&L, and burying it behind another
    // report's tab strip is what kept it hard to find.
    PARTNERSHIP_REPORT,
    // The run itself, beside the report it is a run of. One door: this is the
    // only way to draft, review, post or reverse a month, and it is in the nav
    // rather than behind a route only a typed URL reaches.
    PARTNERSHIP_RUN,
    // REGIONAL_SCORECARD ("Regional Operating Expenses") is hidden from the nav
    // by request. The route still exists (routes.tsx) so a saved link resolves;
    // it just isn't listed. Re-add it here to bring it back.
    PERIOD_CLOSE,
  ]);
  if (finance) links.push(finance);

  // PROFIT-SHARE — hidden in its entirety. Treasury & Reserves lives here now,
  // so it is hidden with the group. Regional Scorecard used to be listed here
  // and has been moved to Finance, where it is visible. Every route still
  // resolves if opened directly.
  const PROFIT_SHARE_HIDDEN = true;
  const profitShare = PROFIT_SHARE_HIDDEN
    ? null
    : buildGroup("Profit-Share", "/super-admin/partnership", [
        TREASURY,
        RMD_STATEMENTS,
        PROJECT_FIN,
      ]);
  if (profitShare) links.push(profitShare);

  // COMPLIANCE
  // Licenses & Renewals and Contract Renewals are tabs of the Compliance
  // Calendar now, so it is the group's only entry.
  // Documents and Compliance Cases hidden (routes kept).
  const compliance = buildGroup("Compliance", "/super-admin/comply", [
    COMPLIANCE,
  ]);
  if (compliance) links.push(compliance);

  // ADMIN — Users & Permissions + Governance merged → Access & Governance.
  // Alerts hidden (route kept).
  const admin = buildGroup("Admin", "/super-admin/admin", [
    TASKS,
    ACCESS_GOVERNANCE,
    AUDIT_LOG,
    SETTINGS,
    BILLING,
  ]);
  if (admin) links.push(admin);

  const handleExitView = async () => {
    await setViewAsCompany(null);
    navigate("/super-super-admin", { replace: true });
  };

  return (
    <div className="app-shell flex h-dvh bg-slate-50">
      <Sidebar
        title={isSsaViewing ? `Viewing: ${company?.name ?? "…"}` : (company?.name ?? "Company Panel")}
        links={links}
      />
      <div className="flex-1 flex flex-col overflow-hidden">
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
        <TopBar>
          {showRegionBar && (
            <>
              <RegionSelector />
              {/* Hidden below `lg`: the selector button next to it already
                  names the current scope ("Head Office / All Regions", or the
                  region), so on a phone this sentence only ever appeared as a
                  truncated fragment competing for the same row. */}
              <span className="hidden lg:inline text-xs text-muted-foreground truncate">
                {locked
                  ? "You see only your region."
                  : region
                    ? `Showing ${region.name} only.`
                    : "Showing all regions (consolidated)."}
              </span>
            </>
          )}
        </TopBar>
        <Outlet />
      </div>
      <AiChatWidget />
      <InactivityLogout />
    </div>
  );
}
