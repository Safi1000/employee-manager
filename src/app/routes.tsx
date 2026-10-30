import { lazyPage, RouteErrorScreen } from "./lib/lazyPage";
import { createBrowserRouter, Navigate, useLocation } from "react-router";
// Every screen is its own chunk, fetched the first time it is visited. Before
// this the whole app — ~60 pages, jsPDF, xlsx, the landing site — was one
// 3.6 MB file (950 KB gzipped) that had to download and parse before even the
// login form could render, and its hash changed on every deploy so every
// user re-downloaded it. Login stays eager: it is the first thing shown.
// The Suspense boundaries live in App.tsx and the two layouts' <Outlet />, so
// a chunk fetch shows a spinner inside the shell, not a blank page.
const RoleSelection = lazyPage(() => import("./pages/RoleSelection"));
import Login from "./pages/Login";
const Signup = lazyPage(() => import("./pages/Signup"));
const SignupComplete = lazyPage(() => import("./pages/SignupComplete"));
import RequireAuth from "./components/RequireAuth";
import RequirePermission from "./components/RequirePermission";
import PublicAnalytics from "./components/PublicAnalytics";
import SuperAdminLayout from "./layouts/SuperAdminLayout";
import SuperSuperAdminLayout from "./layouts/SuperSuperAdminLayout";

const Dashboard = lazyPage(() => import("./pages/super-admin/Dashboard"));
const UserManagement = lazyPage(() => import("./pages/super-admin/UserManagement"));
const EmployeeManagement = lazyPage(() => import("./pages/super-admin/EmployeeManagement"));
const EmployeeAssignments = lazyPage(() => import("./pages/super-admin/EmployeeAssignments"));
const AttendanceManagement = lazyPage(() => import("./pages/super-admin/AttendanceManagement"));
const AttendanceBoard = lazyPage(() => import("./pages/super-admin/AttendanceBoard"));
const PayrollManagement = lazyPage(() => import("./pages/super-admin/PayrollManagement"));
const PayrollRun = lazyPage(() => import("./pages/super-admin/PayrollRun"));
const ReliefPool = lazyPage(() => import("./pages/super-admin/ReliefPool"));
const AttendanceRun = lazyPage(() => import("./pages/super-admin/AttendanceRun"));
const PayrollAdjustments = lazyPage(() => import("./pages/super-admin/PayrollAdjustments"));
const LeaveBalances = lazyPage(() => import("./pages/super-admin/LeaveBalances"));
import TabHub from "./pages/super-admin/_TabHub";
import { useAuth } from "./lib/auth";
const Accounting = lazyPage(() => import("./pages/super-admin/Accounting"));
const FinancialReports = lazyPage(() => import("./pages/super-admin/FinancialReports"));
const Accountant = lazyPage(() => import("./pages/super-admin/Accountant"));
const ExpensesEntry = lazyPage(() => import("./pages/super-admin/ExpensesEntry"));
const Invoices = lazyPage(() => import("./pages/super-admin/Invoices"));
const Cashflow = lazyPage(() => import("./pages/super-admin/CashFlow"));
const ComplianceHub = lazyPage(() => import("./pages/super-admin/ComplianceHub"));
const Documents = lazyPage(() => import("./pages/super-admin/Documents"));
const Settings = lazyPage(() => import("./pages/super-admin/Settings"));
const Tasks = lazyPage(() => import("./pages/super-admin/Tasks"));
const Comments = lazyPage(() => import("./pages/super-admin/Comments"));
const Performance = lazyPage(() => import("./pages/super-admin/Performance"));
const Clients = lazyPage(() => import("./pages/super-admin/Clients"));
const Contracts = lazyPage(() => import("./pages/super-admin/Contracts"));
const SitesStrength = lazyPage(() => import("./pages/super-admin/SitesStrength"));
const Licences = lazyPage(() => import("./pages/super-admin/Licences"));
const Roster = lazyPage(() => import("./pages/super-admin/Roster"));
const Incidents = lazyPage(() => import("./pages/super-admin/Incidents"));
const ChartOfAccounts = lazyPage(() => import("./pages/super-admin/ChartOfAccounts"));
const PeriodClose = lazyPage(() => import("./pages/super-admin/PeriodClose"));
const AuditLog = lazyPage(() => import("./pages/super-admin/AuditLog"));
const Reversals = lazyPage(() => import("./pages/super-admin/Reversals"));
const PartnershipRun = lazyPage(() => import("./pages/super-admin/PartnershipRun"));
const PartnershipPartners = lazyPage(() => import("./pages/super-admin/PartnershipPartners"));
const PartnershipStatements = lazyPage(() => import("./pages/super-admin/PartnershipStatements"));
const ProjectFinancing = lazyPage(() => import("./pages/super-admin/ProjectFinancing"));
const Treasury = lazyPage(() => import("./pages/super-admin/Treasury"));
const FieldOps = lazyPage(() => import("./pages/super-admin/FieldOps"));
const ComplianceCases = lazyPage(() => import("./pages/super-admin/ComplianceCases"));
const Assets = lazyPage(() => import("./pages/super-admin/Assets"));
const Alerts = lazyPage(() => import("./pages/super-admin/Alerts"));
const Governance = lazyPage(() => import("./pages/super-admin/Governance"));
const Receivables = lazyPage(() => import("./pages/super-admin/Receivables"));
const OpeningBalances = lazyPage(() => import("./pages/super-admin/OpeningBalances"));
const RegionalScorecard = lazyPage(() => import("./pages/super-admin/RegionalScorecard"));
const ClientRelationships = lazyPage(() => import("./pages/super-admin/ClientRelationships"));
// Consolidation restructure — merged / renamed homes.
const AssetsIssuance = lazyPage(() => import("./pages/super-admin/AssetsIssuance"));
const AccountingCore = lazyPage(() => import("./pages/super-admin/AccountingCore"));
const AccessGovernance = lazyPage(() => import("./pages/super-admin/AccessGovernance"));
const MyProfile = lazyPage(() => import("./pages/super-admin/MyProfile"));
const DailyReports = lazyPage(() => import("./pages/super-admin/DailyReports"));
const FieldSupervisors = lazyPage(() => import("./pages/super-admin/FieldSupervisors"));
const IncidentsHub = lazyPage(() => import("./pages/super-admin/IncidentsHub"));

const Billing = lazyPage(() => import("./pages/super-admin/Billing"));

const Companies = lazyPage(() => import("./pages/super-super-admin/Companies"));
const CompanyDetail = lazyPage(() => import("./pages/super-super-admin/CompanyDetail"));

// Partnership: a partner's own login sees only the month page, scoped to
// what partnership_month_view (0557) gives it. Partners and Statements are
// management pages and are not offered to partner logins.
function PartnershipPage() {
  const { profile } = useAuth();
  if (profile?.user_type === "partner") return <PartnershipRun />;
  return (
    <TabHub tabs={[
      { key: "months", label: "Months", render: () => <PartnershipRun /> },
      { key: "partners", label: "Partners", render: () => <PartnershipPartners /> },
      { key: "statements", label: "Statements", render: () => <PartnershipStatements /> },
    ]} />
  );
}

const guard = (perms: string[], el: React.ReactNode) => (
  <RequirePermission any={perms}>{el}</RequirePermission>
);

const publicRoutes = [
  { path: "/", Component: RoleSelection },
  { path: "/login", Component: Login },
  // Self-serve signup. Two steps with Stripe in the middle: /signup takes the
  // plan and opens Checkout, /signup/complete is where Stripe returns and the
  // company is actually created — but only if the payment is confirmed.
  { path: "/signup", Component: Signup },
  { path: "/signup/complete", Component: SignupComplete },
];

/** An old /super-admin… or /super-super-admin… address, sent to the same page under its new prefix. */
function LegacyPrefix({ from, to }: { from: string; to: string }) {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${to}${pathname.slice(from.length)}${search}${hash}`} replace />;
}

export const router = createBrowserRouter([
  // Everything public sits under one pathless layout route whose only job is to
  // switch Google Analytics on. The panels below are deliberately OUTSIDE it:
  // that boundary is what keeps authenticated URLs — and anything identifying a
  // tenant, client or employee — from reaching Google. See PublicAnalytics.
  {
    element: <PublicAnalytics />,
    errorElement: <RouteErrorScreen />,
    children: publicRoutes,
  },
  {
    path: "/platform",
    errorElement: <RouteErrorScreen />,
    element: (
      <RequireAuth roles={["super_super_admin"]}>
        <SuperSuperAdminLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, Component: Companies },
      { path: "companies/:id", Component: CompanyDetail },
    ],
  },
  {
    path: "/app",
    errorElement: <RouteErrorScreen />,
    element: (
      <RequireAuth roles={["super_admin", "hr", "accounting", "ops_manager", "ops_director", "finance_director"]}>
        <SuperAdminLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, Component: Dashboard },
      // Users & Permissions + Governance merged → Access & Governance (tabs).
      // Access & Governance is super-admin only. It hands out permissions and
      // approval authority, so gating it on the very permissions it grants let
      // anyone with accounting.edit or payroll.approve widen their own access.
      // Role, not permission — same guard the Audit Log uses.
      { path: "access-governance", element: <RequireAuth roles={["super_super_admin", "super_admin"]}><AccessGovernance /></RequireAuth> },
      { path: "users", element: <Navigate to="/app/access-governance?tab=users" replace /> },
      { path: "clients", element: guard(["clients.view", "clients.edit"], <Clients />) },
      { path: "contracts", element: guard(["contracts.view", "contracts.edit"], <Contracts />) },
      // Deployment merged into Workforce ▸ Assignments & Pay: the contracted-vs-
      // enrolled reconciliation now sits on the same screen as the guards it counts.
      { path: "deployment", element: <Navigate to="/app/assignments" replace /> },
      { path: "sites-strength", element: <Navigate to="/app/assignments" replace /> },
      // Licenses & Renewals and the contract renewal pipeline are tabs of the
      // Compliance Calendar now — one home for everything with an expiry on it.
      { path: "licences", element: <Navigate to="/app/compliance?tab=licences" replace /> },
      // Deployment Roster killed (supervisor handles daily assignment) → Assignments & Pay.
      { path: "roster", element: <Navigate to="/app/assignments" replace /> },
      // Incidents now also hosts client complaints (from dissolved Client Relationships).
      { path: "incidents", element: guard(["incidents.view", "incidents.edit"], <IncidentsHub />) },
      // Opening Balances + Chart of Accounts (which hosts TB + GL) merged → Accounting Core.
      { path: "accounting-core", element: guard(["coa.view"], <AccountingCore />) },
      { path: "chart-of-accounts", element: <Navigate to="/app/accounting-core?tab=coa" replace /> },
      { path: "trial-balance", element: <Navigate to="/app/accounting-core?tab=tb" replace /> },
      { path: "journal", element: <Navigate to="/app/accounting-core?tab=journal" replace /> },
      { path: "general-ledger", element: <Navigate to="/app/accounting-core?tab=journal" replace /> },
      { path: "period-close", element: guard(["period_close.manage"], <PeriodClose />) },
      { path: "audit-log", element: <RequireAuth roles={["super_super_admin", "super_admin"]}><AuditLog /></RequireAuth> },
      // 0502-0506: undo a recorded action.
      { path: "reversals", element: guard(["reversals.execute"], <Reversals />) },
      { path: "employees", element: guard(["employees.view", "employees.edit"], <EmployeeManagement />) },
      // Assignments & Pay: employees grouped under their client, so posting and
      // pay can be edited for one guard or the whole client at once.
      // assignments.view gates whether the page is shown at all; Accounts / HR
      // then gate what can be edited inside it. employees.edit stays a grandfathered
      // superset (super_admin/SSA pass implicitly).
      { path: "assignments", element: guard(["assignments.view", "employees.edit"], <EmployeeAssignments />) },
      { path: "attendance", element: guard(["attendance.view", "attendance.edit"], <AttendanceBoard />) },
      { path: "attendance-run", element: guard(["attendance.run_view", "attendance.ops_verify"], <AttendanceRun />) },
      // Month calendar retained as a CORRECTION-only Timesheet (§8.8), reached
      // from the guard's record (History tab), not the daily flow.
      { path: "attendance/timesheet", element: guard(["attendance.view", "attendance.edit"], <AttendanceManagement />) },
      // Payroll Runs page removed — payroll is the per-employee Payslips view only.
      // siteGrouped: the roster is grouped into collapsible site rows, the same
      // shape Payroll Run already uses. Passed here rather than defaulted on the
      // component, because the OTHER embed (the per-client accordion inside
      // Payroll Run's Review step) is deliberately flat and flipping the default
      // would silently group that one too.
      // 0437: Payslips | Adjustments. An adjustment is a correction that sits
      // beside a payslip; the tab is where open ones are seen before a period
      // closes.
      { path: "payroll", element: guard(["payroll.view", "payroll.edit", "payroll.adjust"], (
        <TabHub tabs={[
          { key: "payslips", label: "Payslips", render: () => <PayrollManagement siteGrouped /> },
          { key: "adjustments", label: "Adjustments", render: () => <PayrollAdjustments /> },
          // 0438: leave earned per period by days present — the ledger and the opening.
          { key: "leave", label: "Leave", render: () => <LeaveBalances /> },
        ]} />
      )) },
      { path: "payroll-run", element: guard(["payroll.view", "payroll.edit"], <PayrollRun />) },
      { path: "payroll-runs", element: <Navigate to="/app/payroll" replace /> },
      { path: "performance", element: guard(["payroll.view", "performance.approve"], <Performance />) },
      // Recruitment page deleted — intake is set on the employee form itself.
      { path: "recruitment", element: <Navigate to="/app/employees" replace /> },
      // Relievers (DECIDED 2026-10-23): the pool board — who is where, the gaps,
      // days per client — and their attendance. Pay is in the Payroll Run, under
      // "Relievers", like every other group.
      { path: "relievers", element: guard(["attendance.view", "attendance.edit"], (
        <TabHub tabs={[
          { key: "pool", label: "Pool board", render: () => <ReliefPool /> },
          { key: "attendance", label: "Attendance", render: () => <AttendanceManagement relieversOnly /> },
        ]} />
      )) },
      { path: "relievers/attendance", element: <Navigate to="/app/relievers?tab=attendance" replace /> },
      { path: "relievers/payroll", element: <Navigate to="/app/payroll-run" replace /> },
      { path: "accounting", element: guard(["banks.view", "receivables.view", "payables.view", "accounting.edit"], <Accounting />) },
      // Financial Reports, rebuilt (Overview, Client profit, Statements,
      // Ledgers, Scenarios). The Partnership Report below is a separate page.
      { path: "reports", element: guard(["reports.view"], <FinancialReports key="reports" />) },
      // 2026-10-20: the accountant's working page, granted per person from
      // Access & Governance (accountant.view).
      { path: "accountant", element: guard(["accountant.view"], <Accountant />) },
      // Partnership (redesigned 2026-10-26): one page — Months (draft, check,
      // post, and every posted month in full), Partners (shares and policy) and
      // Statements (each partner's ledger). The two old pages redirect here.
      { path: "partnership", element: guard(["banks.view", "receivables.view", "payables.view", "accounting.edit"], (
        <PartnershipPage />
      )) },
      { path: "partnership-report", element: <Navigate to="/app/partnership?tab=partners" replace /> },
      { path: "partnership-run", element: <Navigate to="/app/partnership?tab=months" replace /> },
      // Everyone (0496): requesting is open; ExpensesEntry shows the ledger only to expenses.view/edit.
      { path: "expenses", element: <ExpensesEntry /> },
      { path: "invoices", element: guard(["invoices.view", "invoices.edit", "receivables.view", "accounting.edit"], <Invoices />) },
      { path: "cashflow", element: guard(["cashflow.view"], <Cashflow />) },
      { path: "treasury", element: guard(["banks.view", "reports.view", "cashflow.view"], <Treasury />) },
      // Receivables folded into Bank & Ledgers (Accounting has a Receivables tab).
      { path: "receivables", element: <Navigate to="/app/invoices?tab=receivables" replace /> },
      { path: "opening-balances", element: <Navigate to="/app/accounting-core?tab=opening" replace /> },
      { path: "regional-scorecard", element: guard(["reports.view", "banks.view"], <RegionalScorecard />) },
      // Client Relationships dissolved: complaints → Incidents, renewals → Compliance,
      // reviews → client record. Landing on the client list.
      { path: "client-relationships", element: <Navigate to="/app/clients" replace /> },
      // Field Operations repurposed → Daily Reports (date-wise client report → PDF + record).
      { path: "daily-reports", element: guard(["roster.view", "roster.edit", "incidents.view", "attendance.view"], <DailyReports />) },
      { path: "field-ops", element: <Navigate to="/app/daily-reports" replace /> },
      // Field app logins and site coverage. Role, not permission: admin_field_* refuse anyone but a super admin.
      { path: "field-supervisors", element: <RequireAuth roles={["super_admin"]}><FieldSupervisors /></RequireAuth> },
      { path: "compliance-cases", element: guard(["compliance.view", "compliance.edit"], <ComplianceCases />) },
      // Assets & Issuance — tabs: Store | Issuance | Clearance | Register.
      // Inventory.tsx was deleted with this rebuild: it read inventory_items
      // (one `unit_value`, free-text type) and issuances (issue + return date),
      // neither of which can carry two costs or a guard-to-guard handover. Both
      // tables were empty on production, so nothing was migrated.
      { path: "assets-issuance", element: guard(["inventory.view", "inventory.edit", "banks.view"], <AssetsIssuance />) },
      { path: "assets", element: <Navigate to="/app/assets-issuance?tab=register" replace /> },
      { path: "alerts", element: <Alerts /> },
      { path: "governance", element: <Navigate to="/app/access-governance?tab=governance" replace /> },
      { path: "partners", element: <Navigate to="/app/partnership?tab=statements" replace /> },
      // Cash Custody moved into Banks & Ledgers as a 4th tab; redirect the old route.
      { path: "cash-custody", element: <Navigate to="/app/accounting?tab=cash-custody" replace /> },
      // PROFIT DISTRIBUTION: ROUTE REMOVED. The screen maintained
      // profit_distribution_rules / profit_distribution_rule_lines /
      // referral_arrangements, which NO ledger function reads — configuring a
      // partner there changed nothing at all. The component and the tables are
      // deliberately left in place: removing a route is reversible, removing
      // tables is not, and the referral model it describes has no equivalent
      // anywhere else yet. See the 0078b subsystem report.
      { path: "project-financing", element: guard(["banks.view", "receivables.view", "payables.view", "accounting.edit"], <ProjectFinancing />) },
      { path: "inventory", element: <Navigate to="/app/assets-issuance?tab=issuance" replace /> },
      { path: "compliance", element: guard(["compliance.view", "compliance.edit"], <ComplianceHub />) },
      { path: "documents", element: guard(["documents.view", "documents.edit"], <Documents />) },
      { path: "settings", element: guard(["settings.view", "settings.edit"], <Settings />) },
      // Plan, guard cap and AI credit. Readable by anyone who can see settings;
      // the edge function is what refuses a non-super-admin trying to spend.
      { path: "billing", element: guard(["settings.view", "settings.edit"], <Billing />) },
      { path: "tasks", element: <Tasks /> },
      // 0606: anyone signed in — the page shows only conversations they are in.
      { path: "comments", element: <Comments /> },
      // 0424. Deliberately NOT permission-guarded: the employee link IS the
      // entitlement, and it entitles you to yourself. The page says so plainly
      // when the login has no link.
      { path: "my-profile", element: <RequireAuth><MyProfile /></RequireAuth> },
    ],
  },
  // Legacy panel paths redirect to the unified panel.
  { path: "/hr", element: <Navigate to="/app" replace /> },
  { path: "/hr/*", element: <Navigate to="/app" replace /> },
  { path: "/accounts", element: <Navigate to="/app" replace /> },
  { path: "/accounts/*", element: <Navigate to="/app" replace /> },
  // 2026-10-29: the panels moved from /super-admin and /super-super-admin to
  // /app and /platform (every role shares one panel; the old name showed
  // "super-admin" in everyone's address bar). Old links — bookmarks, emails,
  // Stripe's billing return — land on the same page at the new address.
  { path: "/super-admin/*", element: <LegacyPrefix from="/super-admin" to="/app" /> },
  { path: "/super-admin", element: <LegacyPrefix from="/super-admin" to="/app" /> },
  { path: "/super-super-admin/*", element: <LegacyPrefix from="/super-super-admin" to="/platform" /> },
  { path: "/super-super-admin", element: <LegacyPrefix from="/super-super-admin" to="/platform" /> },
  { path: "*", element: <Navigate to="/login" replace /> },
]);
