import { Suspense } from "react";
import RouteLoading from "../components/RouteLoading";
import { Outlet, useLocation, useNavigate } from "react-router";
import { isCompanyWide } from "../lib/navMeta";
import { useNavBadges } from "../lib/navBadges";
import Sidebar, { type SidebarItem } from "../components/Sidebar";
import InactivityLogout from "../components/InactivityLogout";
import SecurityGate from "../components/SecurityGate";
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
  RotateCcw,
  Users2,
  UserRound,
  MessageSquare,
  Play,
  PieChart,
  Briefcase,
  MapPin,
  ClipboardList,
  ClipboardCheck,
  Smartphone,
} from "lucide-react";
import { ScrollMemory } from "../lib/pageState";
import DriveLinkGuard from "../components/DriveLinkGuard";

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
  const { regions, locked, region, regionId } = useRegion();
  const navBadges = useNavBadges(profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null, regionId);
  const navigate = useNavigate();
  const companyWidePage = isCompanyWide(useLocation().pathname);

  // Companies with a single region have nothing to switch between, so the bar
  // stays out of their way entirely.
  const showRegionBar = locked || regions.length > 1;

  const isSsaViewing =
    profile?.role === "super_super_admin" && !!profile.view_as_company;

  // Module definitions with their permission gates.
  const DASHBOARD: LinkDef = { to: "/app", label: "Dashboard", icon: LayoutDashboard };
  const CLIENTS: LinkDef = { to: "/app/clients", label: "Clients", icon: Building2, perms: ["clients.view", "clients.edit"] };
  const CONTRACTS: LinkDef = { to: "/app/contracts", label: "Contracts", icon: FileSignature, perms: ["contracts.view", "contracts.edit"] };
  const SITES_STRENGTH: LinkDef = { to: "/app/sites-strength", label: "Sites & Strength", icon: MapPin, perms: ["clients.view", "clients.edit", "contracts.view", "contracts.edit"] };
  const INVOICES: LinkDef = { to: "/app/invoices", label: "Invoices", icon: ReceiptText, perms: ["invoices.view", "invoices.edit", "receivables.view", "accounting.edit"] };
  const EMPLOYEES: LinkDef = { to: "/app/employees", label: "Employees", icon: UserCircle, perms: ["employees.view", "employees.edit"] };
  const ASSIGNMENTS: LinkDef = { to: "/app/assignments", label: "Assignments & Pay", icon: ClipboardList, perms: ["assignments.view", "employees.edit"] };
  const ATTENDANCE: LinkDef = { to: "/app/attendance", label: "Attendance", icon: Calendar, perms: ["attendance.view", "attendance.edit"] };
  const ATTENDANCE_RUN: LinkDef = { to: "/app/attendance-run", label: "Attendance Run", icon: ClipboardCheck, perms: ["attendance.run_view", "attendance.ops_verify"] };
  const PAYROLL: LinkDef = { to: "/app/payroll", label: "Payroll", icon: DollarSign, perms: ["payroll.view", "payroll.edit"] };
  const PAYROLL_RUN: LinkDef = { to: "/app/payroll-run", label: "Payroll Run", icon: DollarSign, perms: ["payroll.view", "payroll.edit"] };
  const PERFORMANCE: LinkDef = { to: "/app/performance", label: "Performance", icon: TrendingUp, perms: ["payroll.view", "performance.approve"] };
  const RELIEVER_ATT: LinkDef = { to: "/app/relievers/attendance", label: "Attendance", icon: Calendar, perms: ["attendance.view", "attendance.edit"] };
  const INVENTORY: LinkDef = { to: "/app/inventory", label: "Inventory", icon: Package, perms: ["inventory.view", "inventory.edit"] };
  const ROSTER: LinkDef = { to: "/app/roster", label: "Deployment Roster", icon: CalendarRange, perms: ["roster.view", "roster.edit"] };
  const INCIDENTS: LinkDef = { to: "/app/incidents", label: "Incidents", icon: Siren, perms: ["incidents.view", "incidents.edit"] };
  const BANKS: LinkDef = { to: "/app/accounting", label: "Bank & Ledgers", icon: Landmark, perms: ["banks.view", "accounting.edit"] };
  // Open to everyone (0496): anyone may request an expense. Without expenses.view
  // or .edit the page shows only their own requests (ExpensesEntry).
  const EXPENSES: LinkDef = { to: "/app/expenses", label: "Expenses & Advances", icon: Receipt };
  const CASHFLOW: LinkDef = { to: "/app/cashflow", label: "Cash Flow", icon: TrendingUp, perms: ["cashflow.view"] };
  const REPORTS: LinkDef = { to: "/app/reports", label: "Financial Reports", icon: FileText, perms: ["reports.view"] };
  const ACCOUNTANT: LinkDef = { to: "/app/accountant", label: "Accountant", icon: BookOpen, perms: ["accountant.view"] };
  const CHART_OF_ACCOUNTS: LinkDef = { to: "/app/chart-of-accounts", label: "Chart of Accounts", icon: BookOpen, perms: ["coa.view", "reports.view"] };
  const PERIOD_CLOSE: LinkDef = { to: "/app/period-close", label: "Period Close", icon: Lock, perms: ["period_close.manage", "reports.view"] };
  const AUDIT_LOG: LinkDef = { to: "/app/audit-log", label: "Audit Log", icon: History, roles: ["super_super_admin", "super_admin"] };
  const REVERSALS: LinkDef = { to: "/app/reversals", label: "Reversals", icon: RotateCcw, perms: ["reversals.execute"] };
  const PARTNERS: LinkDef = { to: "/app/partners", label: "Partner Accounts", icon: Users2, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"] };
  // The partnership RUN — drafting, reviewing and posting a month — as opposed
  // to the partnership REPORT, which reads one back.
  const PARTNERSHIP: LinkDef = { to: "/app/partnership", label: "Partnership", icon: Users2, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"] };
  // PROFIT_DIST is deliberately absent: the /profit-distribution route was
  // removed because the screen maintained a share model no ledger function
  // reads. A LinkDef pointing at a removed route is worse than no link.
  const PROJECT_FIN: LinkDef = { to: "/app/project-financing", label: "Project Financing", icon: Briefcase, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"] };
  const COMPLIANCE: LinkDef = { to: "/app/compliance", label: "Compliance Calendar", icon: Bell, perms: ["compliance.view", "compliance.edit"] };
  const DOCUMENTS: LinkDef = { to: "/app/documents", label: "Documents", icon: Folder, perms: ["documents.view", "documents.edit"] };
  const TASKS: LinkDef = { to: "/app/tasks", label: "Tasks", icon: Trello };
  // 0606: everyone — the inbox shows only conversations the viewer is in.
  const COMMENTS: LinkDef = { to: "/app/comments", label: "Comments", icon: MessageSquare };
  const USERS: LinkDef = { to: "/app/users", label: "Users & Permissions", icon: Users, perms: ["users.manage"] };
  const SETTINGS: LinkDef = { to: "/app/settings", label: "Settings", icon: SettingsIcon, perms: ["settings.view", "settings.edit"] };
  const BILLING: LinkDef = { to: "/app/billing", label: "Plan & Billing", icon: CreditCard, perms: ["settings.view", "settings.edit"] };
  // New back-office surfaces (Parts II–VII).
  const TREASURY: LinkDef = { to: "/app/treasury", label: "Treasury & Reserves", icon: Landmark, perms: ["banks.view", "reports.view", "cashflow.view"] };
  const ASSETS: LinkDef = { to: "/app/assets", label: "Assets & Vehicles", icon: Package, perms: ["inventory.view", "inventory.edit", "banks.view"] };
  const FIELD_OPS: LinkDef = { to: "/app/field-ops", label: "Field Operations", icon: Siren, perms: ["roster.view", "roster.edit", "incidents.view", "attendance.view"] };
  const COMPLIANCE_CASES: LinkDef = { to: "/app/compliance-cases", label: "Compliance Cases", icon: ShieldAlert, perms: ["compliance.view", "compliance.edit"] };
  const ALERTS: LinkDef = { to: "/app/alerts", label: "Alerts", icon: Bell };
  const GOVERNANCE: LinkDef = { to: "/app/governance", label: "Governance", icon: Users2, perms: ["users.manage", "payroll.approve", "performance.approve", "accounting.edit"] };
  const RECEIVABLES: LinkDef = { to: "/app/receivables", label: "Receivables", icon: ReceiptText, perms: ["invoices.view", "invoices.edit", "receivables.view"] };
  const OPENING_BAL: LinkDef = { to: "/app/opening-balances", label: "Opening Balances", icon: BookOpen, perms: ["accounting.edit", "coa.view"] };
  // "Regional Operating Expenses" (route /app/regional-scorecard) is
  // hidden from the nav by request — its LinkDef is intentionally not defined
  // here so it isn't listed. The route still exists in routes.tsx.
  const CLIENT_REL: LinkDef = { to: "/app/client-relationships", label: "Client Relationships", icon: Users2, perms: ["clients.view", "clients.edit"] };

  // Consolidation restructure — merged / renamed / moved homes.
  const RELIEVERS: LinkDef = { to: "/app/relievers", label: "Relievers", icon: Shuffle, perms: ["attendance.view", "attendance.edit"] };
  // 0617/0618: site attendance to review and formal warnings to approve, from the field app.
  const FIELD_REVIEW: LinkDef = { to: "/app/field-review", label: "Field Review", icon: ClipboardCheck, perms: ["attendance.field_review", "warnings.approve"] };
  const FIELD_SUPERVISORS: LinkDef = { to: "/app/field-supervisors", label: "Field Supervisors", icon: Smartphone, roles: ["super_admin"] };
  const DAILY_REPORTS: LinkDef = { to: "/app/daily-reports", label: "Daily Reports", icon: FileText, perms: ["roster.view", "roster.edit", "incidents.view", "attendance.view"] };
  const ASSETS_ISSUANCE: LinkDef = { to: "/app/assets-issuance", label: "Assets & Issuance", icon: Package, perms: ["inventory.view", "inventory.edit", "banks.view"] };
  const ACCOUNTING_CORE: LinkDef = { to: "/app/accounting-core", label: "Accounting Core", icon: BookOpen, perms: ["coa.view", "reports.view", "accounting.edit"] };
  // Super admins only — it grants permissions, so it must not be reachable via
  // the permissions it grants. Matches the route guard in routes.tsx.
  const ACCESS_GOVERNANCE: LinkDef = { to: "/app/access-governance", label: "Access & Governance", icon: Users, roles: ["super_super_admin", "super_admin"] };
  // PROFIT_DIST and PARTICIPATION_RULES removed with the route they pointed at.
  // Two labels, one dead screen: "Profit Distribution" was defined and never
  // pushed into a group, "Participation Rules" only ever appeared in the hidden
  // Profit-Share group. A link to a removed route is worse than no link.
  const RMD_STATEMENTS: LinkDef = { to: "/app/partners", label: "RMD Statements", icon: Users2, perms: ["banks.view", "receivables.view", "payables.view", "accounting.edit"] };

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

  // MY PROFILE — only for a login linked to an employee (0424), and first,
  // because for somebody whose account exists SO THAT they can see their own
  // pay, it is the whole reason they logged in. Not routed through linkOrNull:
  // the link is the entitlement, so there is no permission to test.
  if (profile?.employee_id) {
    links.push({
      type: "group",
      label: "Me",
      basePath: "/app/my-profile",
      variant: "section",
      children: [{ to: "/app/my-profile", label: "My Profile", icon: UserRound }],
    });
  }

  // OVERVIEW
  // Tasks sits directly under Dashboard by request. It moved out of Admin, where
  // it was filed with Access & Governance and the Audit Log — screens you visit
  // to administer the system. A task board is not administration; it is the
  // thing you check when you arrive, which is what Overview is for.
  // 2026-10-21: no Overview section any more. The Dashboard is the rail's
  // first icon (and the Bastion mark above it), and Tasks sits beside it as
  // its own icon — two one-tap destinations rather than a flyout of two.
  const dashLink = linkOrNull(profile, DASHBOARD);
  if (dashLink) links.push(dashLink);
  const tasksLink = linkOrNull(profile, TASKS);
  if (tasksLink) links.push(tasksLink);
  const commentsLink = linkOrNull(profile, COMMENTS);
  if (commentsLink) links.push(commentsLink);

  // CLIENTS & CONTRACTS — Sites & Strength split out (headcount → Operations ▸
  // Deployment; billing → Invoices); Client Relationships dissolved (complaints
  // → Incidents, renewals → Compliance, reviews → client record).
  const contractsClients = buildGroup("Clients & Contracts", "/app/billing", [
    CLIENTS,
    CONTRACTS,
    INVOICES,
  ]);
  if (contractsClients) links.push(contractsClients);

  // WORKFORCE — Payroll now hosts Runs as a tab; Relievers is one thin panel
  // (per-day cost nets against the client, separate from salaried Payroll).
  // Recruitment removed; Performance hidden (route kept, just not in the nav).
  const workforce = buildGroup("Workforce", "/app/workforce", [
    EMPLOYEES,
    ASSIGNMENTS,
    ATTENDANCE,
    ATTENDANCE_RUN,
    FIELD_REVIEW,
    PAYROLL,
    PAYROLL_RUN,
    RELIEVERS,
  ]);
  if (workforce) links.push(workforce);

  // OPERATIONS — Roster killed (supervisor handles it); Deployment merged into
  // Workforce ▸ Assignments & Pay; Field Ops repurposed → Daily Reports;
  // Inventory + Assets merged → Assets & Issuance.
  const operations = buildGroup("Operations", "/app/operations", [
    DAILY_REPORTS,
    // Field app logins: who supervises which sites (super admins, 30 Oct 2026).
    FIELD_SUPERVISORS,
    INCIDENTS,
    ASSETS_ISSUANCE,
  ]);
  if (operations) links.push(operations);

  // FINANCE — Opening Balances + Chart of Accounts merged → Accounting Core.
  // Receivables folded into Bank & Ledgers. Treasury moved out to Profit-Share.
  const finance = buildGroup("Finance", "/app/finance", [
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
    ACCOUNTANT,
    // One door for the partnership (2026-10-26): months, partners, statements.
    PARTNERSHIP,
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
    : buildGroup("Profit-Share", "/app/partnership", [
        TREASURY,
        RMD_STATEMENTS,
        PROJECT_FIN,
      ]);
  if (profitShare) links.push(profitShare);

  // COMPLIANCE
  // Licenses & Renewals and Contract Renewals are tabs of the Compliance
  // Calendar now, so it is the group's only entry.
  // Documents and Compliance Cases hidden (routes kept).
  const compliance = buildGroup("Compliance", "/app/comply", [
    COMPLIANCE,
  ]);
  if (compliance) links.push(compliance);

  // ADMIN — Users & Permissions + Governance merged → Access & Governance.
  // Alerts hidden (route kept).
  const admin = buildGroup("Admin", "/app/admin", [
    // TASKS moved to Overview, beneath Dashboard.
    ACCESS_GOVERNANCE,
    AUDIT_LOG,
    REVERSALS,
    SETTINGS,
    BILLING,
  ]);
  if (admin) links.push(admin);

  const handleExitView = async () => {
    await setViewAsCompany(null);
    navigate("/platform", { replace: true });
  };

  return (
    <SecurityGate>
      <div className="app-shell flex h-dvh bg-muted/50">
        <Sidebar
          title={isSsaViewing ? `Viewing: ${company?.name ?? "…"}` : (company?.name ?? "Company Panel")}
          links={links}
          badges={navBadges}
        />
        <div className="flex-1 flex flex-col overflow-hidden">
          {isSsaViewing && (
            <div className="bg-warning-50 border-b border-warning-200 px-6 py-2 flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 text-warning-700 dark:text-warning-500">
                <Eye className="w-4 h-4" strokeWidth={1.5} />
                <span>
                  You are viewing <strong>{company?.name ?? ""}</strong> as Super Super Admin.
                </span>
              </div>
              <button
                onClick={handleExitView}
                className="flex items-center gap-1 px-3 py-1 rounded text-warning-700 dark:text-warning-500 hover:bg-warning-100"
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
                <span className="hidden lg:inline-flex items-center gap-2 text-xs text-muted-foreground truncate">
                  <span className="live-dot w-1.5 h-1.5 rounded-full bg-brand-500 flex-shrink-0" aria-hidden="true" />
                  {locked
                    ? "You see only your region."
                    : region && !region.is_head_office && companyWidePage
                      ? "This page is company-wide; the region does not change it."
                    : region && !region.is_head_office
                      ? `Every figure is ${region.name} only.`
                      : "Every figure is consolidated across regions."}
                </span>
              </>
            )}
          </TopBar>
          {/* Remembers each page's scroll position for the session (pageState.tsx). */}
          <ScrollMemory>
            <Suspense fallback={<RouteLoading />}>
              <Outlet />
            </Suspense>
          </ScrollMemory>
        </div>
        <InactivityLogout />
        <DriveLinkGuard />
      </div>
    </SecurityGate>
  );
}
