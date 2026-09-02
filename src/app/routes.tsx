import { createBrowserRouter, createHashRouter, Navigate } from "react-router";
import { isNative, canSellInApp } from "./lib/platform";
import RoleSelection from "./pages/RoleSelection";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import SignupComplete from "./pages/SignupComplete";
import RequireAuth from "./components/RequireAuth";
import RequirePermission from "./components/RequirePermission";
import PublicAnalytics from "./components/PublicAnalytics";
import SuperAdminLayout from "./layouts/SuperAdminLayout";
import SuperSuperAdminLayout from "./layouts/SuperSuperAdminLayout";

import Dashboard from "./pages/super-admin/Dashboard";
import UserManagement from "./pages/super-admin/UserManagement";
import EmployeeManagement from "./pages/super-admin/EmployeeManagement";
import EmployeeAssignments from "./pages/super-admin/EmployeeAssignments";
import AttendanceManagement from "./pages/super-admin/AttendanceManagement";
import AttendanceBoard from "./pages/super-admin/AttendanceBoard";
import PayrollManagement from "./pages/super-admin/PayrollManagement";
import PayrollRun from "./pages/super-admin/PayrollRun";
import Accounting from "./pages/super-admin/Accounting";
import FinancialReports from "./pages/super-admin/FinancialReports";
import Expenses from "./pages/super-admin/Expenses";
import Invoices from "./pages/super-admin/Invoices";
import Cashflow from "./pages/super-admin/CashFlow";
import Inventory from "./pages/super-admin/Inventory";
import ComplianceHub from "./pages/super-admin/ComplianceHub";
import Documents from "./pages/super-admin/Documents";
import Settings from "./pages/super-admin/Settings";
import Tasks from "./pages/super-admin/Tasks";
import Performance from "./pages/super-admin/Performance";
import Clients from "./pages/super-admin/Clients";
import Contracts from "./pages/super-admin/Contracts";
import SitesStrength from "./pages/super-admin/SitesStrength";
import Licences from "./pages/super-admin/Licences";
import Roster from "./pages/super-admin/Roster";
import Incidents from "./pages/super-admin/Incidents";
import ChartOfAccounts from "./pages/super-admin/ChartOfAccounts";
import PeriodClose from "./pages/super-admin/PeriodClose";
import AuditLog from "./pages/super-admin/AuditLog";
import Partners from "./pages/super-admin/Partners";
import ProfitDistribution from "./pages/super-admin/ProfitDistribution";
import ProjectFinancing from "./pages/super-admin/ProjectFinancing";
import Treasury from "./pages/super-admin/Treasury";
import FieldOps from "./pages/super-admin/FieldOps";
import ComplianceCases from "./pages/super-admin/ComplianceCases";
import Assets from "./pages/super-admin/Assets";
import Alerts from "./pages/super-admin/Alerts";
import Governance from "./pages/super-admin/Governance";
import Receivables from "./pages/super-admin/Receivables";
import OpeningBalances from "./pages/super-admin/OpeningBalances";
import RegionalScorecard from "./pages/super-admin/RegionalScorecard";
import ClientRelationships from "./pages/super-admin/ClientRelationships";
// Consolidation restructure — merged / renamed homes.
import AssetsIssuance from "./pages/super-admin/AssetsIssuance";
import AccountingCore from "./pages/super-admin/AccountingCore";
import AccessGovernance from "./pages/super-admin/AccessGovernance";
import DailyReports from "./pages/super-admin/DailyReports";
import IncidentsHub from "./pages/super-admin/IncidentsHub";

import Billing from "./pages/super-admin/Billing";

import Companies from "./pages/super-super-admin/Companies";
import CompanyDetail from "./pages/super-super-admin/CompanyDetail";

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
      { path: "accounting-core", element: guard(["coa.view", "reports.view"], <AccountingCore />) },
      { path: "chart-of-accounts", element: <Navigate to="/super-admin/accounting-core?tab=coa" replace /> },
      { path: "trial-balance", element: <Navigate to="/super-admin/accounting-core?tab=tb" replace /> },
      { path: "journal", element: <Navigate to="/super-admin/accounting-core?tab=journal" replace /> },
      { path: "general-ledger", element: <Navigate to="/super-admin/accounting-core?tab=journal" replace /> },
      { path: "period-close", element: guard(["period_close.manage", "reports.view"], <PeriodClose />) },
      { path: "audit-log", element: <RequireAuth roles={["super_super_admin", "super_admin"]}><AuditLog /></RequireAuth> },
      { path: "employees", element: guard(["employees.view", "employees.edit"], <EmployeeManagement />) },
      // Assignments & Pay: employees grouped under their client, so posting and
      // pay can be edited for one guard or the whole client at once.
      { path: "assignments", element: guard(["employees.view", "employees.edit"], <EmployeeAssignments />) },
      { path: "attendance", element: guard(["attendance.view", "attendance.edit"], <AttendanceBoard />) },
      // Month calendar retained as a CORRECTION-only Timesheet (§8.8), reached
      // from the guard's record (History tab), not the daily flow.
      { path: "attendance/timesheet", element: guard(["attendance.view", "attendance.edit"], <AttendanceManagement />) },
      // Payroll Runs page removed — payroll is the per-employee Payslips view only.
      { path: "payroll", element: guard(["payroll.view", "payroll.edit"], <PayrollManagement />) },
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
      // Inventory + Assets merged → Assets & Issuance (tabs: Register | Issuance).
      { path: "assets-issuance", element: guard(["inventory.view", "inventory.edit", "banks.view"], <AssetsIssuance />) },
      { path: "assets", element: <Navigate to="/super-admin/assets-issuance?tab=register" replace /> },
      { path: "alerts", element: <Alerts /> },
      { path: "governance", element: <Navigate to="/super-admin/access-governance?tab=governance" replace /> },
      { path: "partners", element: guard(["banks.view", "receivables.view", "payables.view", "accounting.edit"], <Partners />) },
      // Cash Custody moved into Banks & Ledgers as a 4th tab; redirect the old route.
      { path: "cash-custody", element: <Navigate to="/super-admin/accounting?tab=cash-custody" replace /> },
      { path: "profit-distribution", element: guard(["banks.view", "receivables.view", "payables.view", "accounting.edit"], <ProfitDistribution />) },
      { path: "project-financing", element: guard(["banks.view", "receivables.view", "payables.view", "accounting.edit"], <ProjectFinancing />) },
      { path: "inventory", element: <Navigate to="/super-admin/assets-issuance?tab=issuance" replace /> },
      { path: "compliance", element: guard(["compliance.view", "compliance.edit"], <ComplianceHub />) },
      { path: "documents", element: guard(["documents.view", "documents.edit"], <Documents />) },
      { path: "settings", element: guard(["settings.view", "settings.edit"], <Settings />) },
      // Plan, guard cap and AI credit. Readable by anyone who can see settings;
      // the edge function is what refuses a non-super-admin trying to spend.
      { path: "billing", element: guard(["settings.view", "settings.edit"], <Billing />) },
      { path: "tasks", element: <Tasks /> },
    ],
  },
  // Legacy panel paths redirect to the unified panel.
  { path: "/hr", element: <Navigate to="/super-admin" replace /> },
  { path: "/hr/*", element: <Navigate to="/super-admin" replace /> },
  { path: "/accounts", element: <Navigate to="/super-admin" replace /> },
  { path: "/accounts/*", element: <Navigate to="/super-admin" replace /> },
  { path: "*", element: <Navigate to="/login" replace /> },
]);
