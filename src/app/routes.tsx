import { createBrowserRouter, Navigate } from "react-router";
import RoleSelection from "./pages/RoleSelection";
import Login from "./pages/Login";
import RequireAuth from "./components/RequireAuth";
import RequirePermission from "./components/RequirePermission";
import SuperAdminLayout from "./layouts/SuperAdminLayout";
import SuperSuperAdminLayout from "./layouts/SuperSuperAdminLayout";

import Dashboard from "./pages/super-admin/Dashboard";
import UserManagement from "./pages/super-admin/UserManagement";
import EmployeeManagement from "./pages/super-admin/EmployeeManagement";
import AttendanceManagement from "./pages/super-admin/AttendanceManagement";
import PayrollManagement from "./pages/super-admin/PayrollManagement";
import Accounting from "./pages/super-admin/Accounting";
import FinancialReports from "./pages/super-admin/FinancialReports";
import Expenses from "./pages/super-admin/Expenses";
import Invoices from "./pages/super-admin/Invoices";
import Cashflow from "./pages/super-admin/Cashflow";
import Inventory from "./pages/super-admin/Inventory";
import Compliance from "./pages/super-admin/Compliance";
import Documents from "./pages/super-admin/Documents";
import Settings from "./pages/super-admin/Settings";
import Tasks from "./pages/super-admin/Tasks";
import Performance from "./pages/super-admin/Performance";
import Clients from "./pages/super-admin/Clients";
import Contracts from "./pages/super-admin/Contracts";
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
import PayrollRuns from "./pages/super-admin/PayrollRuns";
import FieldOps from "./pages/super-admin/FieldOps";
import ComplianceCases from "./pages/super-admin/ComplianceCases";
import Assets from "./pages/super-admin/Assets";
import Alerts from "./pages/super-admin/Alerts";
import Governance from "./pages/super-admin/Governance";
import Receivables from "./pages/super-admin/Receivables";
import OpeningBalances from "./pages/super-admin/OpeningBalances";
import RegionalScorecard from "./pages/super-admin/RegionalScorecard";
import ClientRelationships from "./pages/super-admin/ClientRelationships";

import Companies from "./pages/super-super-admin/Companies";
import CompanyDetail from "./pages/super-super-admin/CompanyDetail";

const guard = (perms: string[], el: React.ReactNode) => (
  <RequirePermission any={perms}>{el}</RequirePermission>
);

export const router = createBrowserRouter([
  { path: "/", Component: RoleSelection },
  { path: "/login", Component: Login },
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
      <RequireAuth roles={["super_admin", "hr", "accounting"]}>
        <SuperAdminLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, Component: Dashboard },
      { path: "users", element: guard(["users.manage"], <UserManagement />) },
      { path: "clients", element: guard(["clients.view", "clients.edit"], <Clients />) },
      { path: "contracts", element: guard(["contracts.view", "contracts.edit"], <Contracts />) },
      { path: "licences", element: guard(["compliance.view", "compliance.edit"], <Licences />) },
      { path: "roster", element: guard(["roster.view", "roster.edit"], <Roster />) },
      { path: "incidents", element: guard(["incidents.view", "incidents.edit"], <Incidents />) },
      { path: "chart-of-accounts", element: guard(["coa.view", "reports.view"], <ChartOfAccounts />) },
      { path: "period-close", element: guard(["period_close.manage", "reports.view"], <PeriodClose />) },
      { path: "audit-log", element: <RequireAuth roles={["super_super_admin", "super_admin"]}><AuditLog /></RequireAuth> },
      { path: "employees", element: guard(["employees.view", "employees.edit"], <EmployeeManagement />) },
      { path: "attendance", element: guard(["attendance.view", "attendance.edit"], <AttendanceManagement />) },
      { path: "payroll", element: guard(["payroll.view", "payroll.edit"], <PayrollManagement />) },
      { path: "payroll-runs", element: guard(["payroll.view", "payroll.edit", "payroll.approve"], <PayrollRuns />) },
      { path: "performance", element: guard(["payroll.view", "performance.approve"], <Performance />) },
      { path: "relievers/attendance", element: guard(["attendance.view", "attendance.edit"], <AttendanceManagement relieversOnly />) },
      { path: "relievers/payroll", element: guard(["payroll.view", "payroll.edit"], <PayrollManagement relieversOnly />) },
      { path: "accounting", element: guard(["accounting.view", "accounting.edit"], <Accounting />) },
      { path: "reports", element: guard(["reports.view"], <FinancialReports />) },
      { path: "expenses", element: guard(["expenses.view", "expenses.edit"], <Expenses />) },
      { path: "invoices", element: guard(["invoices.view", "invoices.edit"], <Invoices />) },
      { path: "cashflow", element: guard(["cashflow.view"], <Cashflow />) },
      { path: "treasury", element: guard(["accounting.view", "reports.view", "cashflow.view"], <Treasury />) },
      { path: "receivables", element: guard(["invoices.view", "invoices.edit", "accounting.view"], <Receivables />) },
      { path: "opening-balances", element: guard(["accounting.edit", "coa.view"], <OpeningBalances />) },
      { path: "regional-scorecard", element: guard(["reports.view", "accounting.view"], <RegionalScorecard />) },
      { path: "client-relationships", element: guard(["clients.view", "clients.edit"], <ClientRelationships />) },
      { path: "field-ops", element: guard(["roster.view", "roster.edit", "incidents.view", "attendance.view"], <FieldOps />) },
      { path: "compliance-cases", element: guard(["compliance.view", "compliance.edit"], <ComplianceCases />) },
      { path: "assets", element: guard(["inventory.view", "inventory.edit", "accounting.view"], <Assets />) },
      { path: "alerts", element: <Alerts /> },
      { path: "governance", element: guard(["users.manage", "payroll.approve", "performance.approve", "accounting.edit"], <Governance />) },
      { path: "partners", element: guard(["accounting.view", "accounting.edit"], <Partners />) },
      // Cash Custody moved into Banks & Ledgers as a 4th tab; redirect the old route.
      { path: "cash-custody", element: <Navigate to="/super-admin/accounting?tab=cash-custody" replace /> },
      { path: "profit-distribution", element: guard(["accounting.view", "accounting.edit"], <ProfitDistribution />) },
      { path: "project-financing", element: guard(["accounting.view", "accounting.edit"], <ProjectFinancing />) },
      { path: "inventory", element: guard(["inventory.view", "inventory.edit"], <Inventory />) },
      { path: "compliance", element: guard(["compliance.view", "compliance.edit"], <Compliance />) },
      { path: "documents", element: guard(["documents.view", "documents.edit"], <Documents />) },
      { path: "settings", element: guard(["settings.view", "settings.edit"], <Settings />) },
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
