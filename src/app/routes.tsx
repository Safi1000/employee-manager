import { lazy } from "react";
import { createBrowserRouter, createHashRouter, Navigate } from "react-router";
import { isNative, canSellInApp } from "./lib/platform";
// Every screen is its own chunk, fetched the first time it is visited. Before
// this the whole app — ~60 pages, jsPDF, xlsx, the landing site — was one
// 3.6 MB file (950 KB gzipped) that had to download and parse before even the
// login form could render, and its hash changed on every deploy so every
// user re-downloaded it. Login stays eager: it is the first thing shown.
// The Suspense boundaries live in App.tsx and the two layouts' <Outlet />, so
// a chunk fetch shows a spinner inside the shell, not a blank page.
const RoleSelection = lazy(() => import("./pages/RoleSelection"));
import Login from "./pages/Login";
const Signup = lazy(() => import("./pages/Signup"));
const SignupComplete = lazy(() => import("./pages/SignupComplete"));
import RequireAuth from "./components/RequireAuth";
import RequirePermission from "./components/RequirePermission";
import PublicAnalytics from "./components/PublicAnalytics";
import SuperAdminLayout from "./layouts/SuperAdminLayout";
import SuperSuperAdminLayout from "./layouts/SuperSuperAdminLayout";

const Dashboard = lazy(() => import("./pages/super-admin/Dashboard"));
const UserManagement = lazy(() => import("./pages/super-admin/UserManagement"));
const EmployeeManagement = lazy(() => import("./pages/super-admin/EmployeeManagement"));
const EmployeeAssignments = lazy(() => import("./pages/super-admin/EmployeeAssignments"));
const AttendanceManagement = lazy(() => import("./pages/super-admin/AttendanceManagement"));
const AttendanceBoard = lazy(() => import("./pages/super-admin/AttendanceBoard"));
const PayrollManagement = lazy(() => import("./pages/super-admin/PayrollManagement"));
const PayrollRun = lazy(() => import("./pages/super-admin/PayrollRun"));
const PayrollAdjustments = lazy(() => import("./pages/super-admin/PayrollAdjustments"));
const LeaveBalances = lazy(() => import("./pages/super-admin/LeaveBalances"));
import TabHub from "./pages/super-admin/_TabHub";
const Accounting = lazy(() => import("./pages/super-admin/Accounting"));
const FinancialReports = lazy(() => import("./pages/super-admin/FinancialReports"));
const Expenses = lazy(() => import("./pages/super-admin/Expenses"));
const Invoices = lazy(() => import("./pages/super-admin/Invoices"));
const Cashflow = lazy(() => import("./pages/super-admin/CashFlow"));
const ComplianceHub = lazy(() => import("./pages/super-admin/ComplianceHub"));
const Documents = lazy(() => import("./pages/super-admin/Documents"));
const Settings = lazy(() => import("./pages/super-admin/Settings"));
const Tasks = lazy(() => import("./pages/super-admin/Tasks"));
const Performance = lazy(() => import("./pages/super-admin/Performance"));
const Clients = lazy(() => import("./pages/super-admin/Clients"));
const Contracts = lazy(() => import("./pages/super-admin/Contracts"));
const SitesStrength = lazy(() => import("./pages/super-admin/SitesStrength"));
const Licences = lazy(() => import("./pages/super-admin/Licences"));
const Roster = lazy(() => import("./pages/super-admin/Roster"));
const Incidents = lazy(() => import("./pages/super-admin/Incidents"));
const ChartOfAccounts = lazy(() => import("./pages/super-admin/ChartOfAccounts"));
const PeriodClose = lazy(() => import("./pages/super-admin/PeriodClose"));
const AuditLog = lazy(() => import("./pages/super-admin/AuditLog"));
const Partners = lazy(() => import("./pages/super-admin/Partners"));
const PartnershipRun = lazy(() => import("./pages/super-admin/PartnershipRun"));
const ProjectFinancing = lazy(() => import("./pages/super-admin/ProjectFinancing"));
const Treasury = lazy(() => import("./pages/super-admin/Treasury"));
const FieldOps = lazy(() => import("./pages/super-admin/FieldOps"));
const ComplianceCases = lazy(() => import("./pages/super-admin/ComplianceCases"));
const Assets = lazy(() => import("./pages/super-admin/Assets"));
const Alerts = lazy(() => import("./pages/super-admin/Alerts"));
const Governance = lazy(() => import("./pages/super-admin/Governance"));
const Receivables = lazy(() => import("./pages/super-admin/Receivables"));
const OpeningBalances = lazy(() => import("./pages/super-admin/OpeningBalances"));
const RegionalScorecard = lazy(() => import("./pages/super-admin/RegionalScorecard"));
const ClientRelationships = lazy(() => import("./pages/super-admin/ClientRelationships"));
// Consolidation restructure — merged / renamed homes.
const AssetsIssuance = lazy(() => import("./pages/super-admin/AssetsIssuance"));
const AccountingCore = lazy(() => import("./pages/super-admin/AccountingCore"));
const AccessGovernance = lazy(() => import("./pages/super-admin/AccessGovernance"));
const MyProfile = lazy(() => import("./pages/super-admin/MyProfile"));
const DailyReports = lazy(() => import("./pages/super-admin/DailyReports"));
const IncidentsHub = lazy(() => import("./pages/super-admin/IncidentsHub"));

const Billing = lazy(() => import("./pages/super-admin/Billing"));

const Companies = lazy(() => import("./pages/super-super-admin/Companies"));
const CompanyDetail = lazy(() => import("./pages/super-super-admin/CompanyDetail"));

const guard = (perms: string[], el: React.ReactNode) => (
  <RequirePermission any={perms}>{el}</RequirePermission>
);

// History-API routing needs a server that serves index.html for every path —
// on the web that is the vercel.json rewrite. The native shell serves the
// bundle off the local filesystem with no such rewrite, so a deep path or a
// reload lands on a blank screen. Hash routing needs no server at all.
const createRouter = isNative ? createHashRouter : createBrowserRouter;

// The public marketing surface — landing page, signup, Stripe return — is not
// part of the phone app. It exists to SELL the product, which is the one thing
// the app store rules do not allow an app to do outside their billing, and it
// is desktop marketing copy that has no business on a phone. Native builds send
// all four straight to the login screen. See lib/platform.ts.
const publicRoutes = canSellInApp
  ? [
      { path: "/", Component: RoleSelection },
      { path: "/login", Component: Login },
      // Self-serve signup. Two steps with Stripe in the middle: /signup takes the
      // plan and opens Checkout, /signup/complete is where Stripe returns and the
      // company is actually created — but only if the payment is confirmed.
      { path: "/signup", Component: Signup },
      { path: "/signup/complete", Component: SignupComplete },
    ]
  : [
      { path: "/", element: <Navigate to="/login" replace /> },
      { path: "/login", Component: Login },
      { path: "/signup", element: <Navigate to="/login" replace /> },
      { path: "/signup/complete", element: <Navigate to="/login" replace /> },
    ];

export const router = createRouter([
  // Everything public sits under one pathless layout route whose only job is to
  // switch Google Analytics on. The panels below are deliberately OUTSIDE it:
  // that boundary is what keeps authenticated URLs — and anything identifying a
  // tenant, client or employee — from reaching Google. See PublicAnalytics.
  {
    element: <PublicAnalytics />,
    children: publicRoutes,
  },
  {
    path: "/super-super-admin",
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
    path: "/super-admin",
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
      { path: "users", element: <Navigate to="/super-admin/access-governance?tab=users" replace /> },
      { path: "clients", element: guard(["clients.view", "clients.edit"], <Clients />) },
      { path: "contracts", element: guard(["contracts.view", "contracts.edit"], <Contracts />) },
      // Deployment merged into Workforce ▸ Assignments & Pay: the contracted-vs-
      // enrolled reconciliation now sits on the same screen as the guards it counts.
      { path: "deployment", element: <Navigate to="/super-admin/assignments" replace /> },
      { path: "sites-strength", element: <Navigate to="/super-admin/assignments" replace /> },
      // Licenses & Renewals and the contract renewal pipeline are tabs of the
      // Compliance Calendar now — one home for everything with an expiry on it.
      { path: "licences", element: <Navigate to="/super-admin/compliance?tab=licences" replace /> },
      // Deployment Roster killed (supervisor handles daily assignment) → Assignments & Pay.
      { path: "roster", element: <Navigate to="/super-admin/assignments" replace /> },
      // Incidents now also hosts client complaints (from dissolved Client Relationships).
      { path: "incidents", element: guard(["incidents.view", "incidents.edit"], <IncidentsHub />) },
      // Opening Balances + Chart of Accounts (which hosts TB + GL) merged → Accounting Core.
      { path: "accounting-core", element: guard(["coa.view"], <AccountingCore />) },
      { path: "chart-of-accounts", element: <Navigate to="/super-admin/accounting-core?tab=coa" replace /> },
      { path: "trial-balance", element: <Navigate to="/super-admin/accounting-core?tab=tb" replace /> },
      { path: "journal", element: <Navigate to="/super-admin/accounting-core?tab=journal" replace /> },
      { path: "general-ledger", element: <Navigate to="/super-admin/accounting-core?tab=journal" replace /> },
      { path: "period-close", element: guard(["period_close.manage"], <PeriodClose />) },
      { path: "audit-log", element: <RequireAuth roles={["super_super_admin", "super_admin"]}><AuditLog /></RequireAuth> },
      { path: "employees", element: guard(["employees.view", "employees.edit"], <EmployeeManagement />) },
      // Assignments & Pay: employees grouped under their client, so posting and
      // pay can be edited for one guard or the whole client at once.
      // assignments.view gates whether the page is shown at all; Accounts / HR
      // then gate what can be edited inside it. employees.edit stays a grandfathered
      // superset (super_admin/SSA pass implicitly).
      { path: "assignments", element: guard(["assignments.view", "employees.edit"], <EmployeeAssignments />) },
      { path: "attendance", element: guard(["attendance.view", "attendance.edit"], <AttendanceBoard />) },
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
      { path: "payroll-runs", element: <Navigate to="/super-admin/payroll" replace /> },
      { path: "performance", element: guard(["payroll.view", "performance.approve"], <Performance />) },
      // Recruitment page deleted — intake is set on the employee form itself.
      { path: "recruitment", element: <Navigate to="/super-admin/employees" replace /> },
      // Relievers: one thin panel (per-day cost nets vs client), separate from salaried Payroll.
      { path: "relievers", element: guard(["attendance.view", "attendance.edit"], <AttendanceManagement relieversOnly />) },
      { path: "relievers/attendance", element: <Navigate to="/super-admin/relievers" replace /> },
      { path: "relievers/payroll", element: guard(["payroll.view", "payroll.edit"], <PayrollManagement relieversOnly />) },
      { path: "accounting", element: guard(["banks.view", "receivables.view", "payables.view", "accounting.edit"], <Accounting />) },
      // Distinct `key` per route: both render the same FinancialReports, so
      // without it React reuses one instance across the two paths and the
      // activeTab state leaks (Financial Reports would show the Partnership tab
      // and vice versa). The key forces a fresh mount per page.
      { path: "reports", element: guard(["reports.view"], <FinancialReports key="reports" />) },
      // Partnership Report is its own page under Finance now, not a tab of
      // Financial Reports. Same component, pinned to that one report.
      { path: "partnership-report", element: guard(["banks.view", "receivables.view", "payables.view", "accounting.edit"], <FinancialReports key="partnership" standalone="partnership" />) },
      // Partnership Run — draft / review / post. The database has been able to
      // do this since 0361; nothing could reach it until now.
      { path: "partnership-run", element: guard(["banks.view", "receivables.view", "payables.view", "accounting.edit"], <PartnershipRun />) },
      { path: "expenses", element: guard(["expenses.view", "expenses.edit"], <Expenses />) },
      { path: "invoices", element: guard(["invoices.view", "invoices.edit"], <Invoices />) },
      { path: "cashflow", element: guard(["cashflow.view"], <Cashflow />) },
      { path: "treasury", element: guard(["banks.view", "reports.view", "cashflow.view"], <Treasury />) },
      // Receivables folded into Bank & Ledgers (Accounting has a Receivables tab).
      { path: "receivables", element: <Navigate to="/super-admin/accounting?tab=receivables" replace /> },
      { path: "opening-balances", element: <Navigate to="/super-admin/accounting-core?tab=opening" replace /> },
      { path: "regional-scorecard", element: guard(["reports.view", "banks.view"], <RegionalScorecard />) },
      // Client Relationships dissolved: complaints → Incidents, renewals → Compliance,
      // reviews → client record. Landing on the client list.
      { path: "client-relationships", element: <Navigate to="/super-admin/clients" replace /> },
      // Field Operations repurposed → Daily Reports (date-wise client report → PDF + record).
      { path: "daily-reports", element: guard(["roster.view", "roster.edit", "incidents.view", "attendance.view"], <DailyReports />) },
      { path: "field-ops", element: <Navigate to="/super-admin/daily-reports" replace /> },
      { path: "compliance-cases", element: guard(["compliance.view", "compliance.edit"], <ComplianceCases />) },
      // Assets & Issuance — tabs: Store | Issuance | Clearance | Register.
      // Inventory.tsx was deleted with this rebuild: it read inventory_items
      // (one `unit_value`, free-text type) and issuances (issue + return date),
      // neither of which can carry two costs or a guard-to-guard handover. Both
      // tables were empty on production, so nothing was migrated.
      { path: "assets-issuance", element: guard(["inventory.view", "inventory.edit", "banks.view"], <AssetsIssuance />) },
      { path: "assets", element: <Navigate to="/super-admin/assets-issuance?tab=register" replace /> },
      { path: "alerts", element: <Alerts /> },
      { path: "governance", element: <Navigate to="/super-admin/access-governance?tab=governance" replace /> },
      { path: "partners", element: guard(["banks.view", "receivables.view", "payables.view", "accounting.edit"], <Partners />) },
      // Cash Custody moved into Banks & Ledgers as a 4th tab; redirect the old route.
      { path: "cash-custody", element: <Navigate to="/super-admin/accounting?tab=cash-custody" replace /> },
      // PROFIT DISTRIBUTION: ROUTE REMOVED. The screen maintained
      // profit_distribution_rules / profit_distribution_rule_lines /
      // referral_arrangements, which NO ledger function reads — configuring a
      // partner there changed nothing at all. The component and the tables are
      // deliberately left in place: removing a route is reversible, removing
      // tables is not, and the referral model it describes has no equivalent
      // anywhere else yet. See the 0078b subsystem report.
      { path: "project-financing", element: guard(["banks.view", "receivables.view", "payables.view", "accounting.edit"], <ProjectFinancing />) },
      { path: "inventory", element: <Navigate to="/super-admin/assets-issuance?tab=issuance" replace /> },
      { path: "compliance", element: guard(["compliance.view", "compliance.edit"], <ComplianceHub />) },
      { path: "documents", element: guard(["documents.view", "documents.edit"], <Documents />) },
      { path: "settings", element: guard(["settings.view", "settings.edit"], <Settings />) },
      // Plan, guard cap and AI credit. Readable by anyone who can see settings;
      // the edge function is what refuses a non-super-admin trying to spend.
      { path: "billing", element: guard(["settings.view", "settings.edit"], <Billing />) },
      { path: "tasks", element: <Tasks /> },
      // 0424. Deliberately NOT permission-guarded: the employee link IS the
      // entitlement, and it entitles you to yourself. The page says so plainly
      // when the login has no link.
      { path: "my-profile", element: <RequireAuth><MyProfile /></RequireAuth> },
    ],
  },
  // Legacy panel paths redirect to the unified panel.
  { path: "/hr", element: <Navigate to="/super-admin" replace /> },
  { path: "/hr/*", element: <Navigate to="/super-admin" replace /> },
  { path: "/accounts", element: <Navigate to="/super-admin" replace /> },
  { path: "/accounts/*", element: <Navigate to="/super-admin" replace /> },
  { path: "*", element: <Navigate to="/login" replace /> },
]);
