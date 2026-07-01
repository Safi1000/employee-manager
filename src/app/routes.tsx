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
import Clients from "./pages/super-admin/Clients";
import Contracts from "./pages/super-admin/Contracts";
import Licences from "./pages/super-admin/Licences";
import Roster from "./pages/super-admin/Roster";
import Incidents from "./pages/super-admin/Incidents";
import ChartOfAccounts from "./pages/super-admin/ChartOfAccounts";
import PeriodClose from "./pages/super-admin/PeriodClose";
import AuditLog from "./pages/super-admin/AuditLog";
import Partners from "./pages/super-admin/Partners";
import CashCustody from "./pages/super-admin/CashCustody";
import ProfitDistribution from "./pages/super-admin/ProfitDistribution";
import ProjectFinancing from "./pages/super-admin/ProjectFinancing";

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
      { path: "relievers/attendance", element: guard(["attendance.view", "attendance.edit"], <AttendanceManagement relieversOnly />) },
      { path: "relievers/payroll", element: guard(["payroll.view", "payroll.edit"], <PayrollManagement relieversOnly />) },
      { path: "accounting", element: guard(["accounting.view", "accounting.edit"], <Accounting />) },
      { path: "reports", element: guard(["reports.view"], <FinancialReports />) },
      { path: "expenses", element: guard(["expenses.view", "expenses.edit"], <Expenses />) },
      { path: "invoices", element: guard(["invoices.view", "invoices.edit"], <Invoices />) },
      { path: "cashflow", element: guard(["cashflow.view"], <Cashflow />) },
      { path: "partners", element: guard(["accounting.view", "accounting.edit"], <Partners />) },
      { path: "cash-custody", element: guard(["accounting.view", "accounting.edit"], <CashCustody />) },
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
