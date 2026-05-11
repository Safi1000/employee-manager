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
      { path: "employees", element: guard(["employees.view", "employees.edit"], <EmployeeManagement />) },
      { path: "attendance", element: guard(["attendance.view", "attendance.edit"], <AttendanceManagement />) },
      { path: "payroll", element: guard(["payroll.view", "payroll.edit"], <PayrollManagement />) },
      { path: "accounting", element: guard(["accounting.view", "accounting.edit"], <Accounting />) },
      { path: "reports", element: guard(["reports.view"], <FinancialReports />) },
      { path: "expenses", element: guard(["expenses.view", "expenses.edit"], <Expenses />) },
      { path: "invoices", element: guard(["invoices.view", "invoices.edit"], <Invoices />) },
      { path: "cashflow", element: guard(["cashflow.view"], <Cashflow />) },
      { path: "inventory", element: guard(["inventory.view", "inventory.edit"], <Inventory />) },
      { path: "compliance", element: guard(["compliance.view", "compliance.edit"], <Compliance />) },
      { path: "documents", element: guard(["documents.view", "documents.edit"], <Documents />) },
      { path: "settings", element: guard(["settings.view", "settings.edit"], <Settings />) },
    ],
  },
  // Legacy panel paths redirect to the unified panel.
  { path: "/hr", element: <Navigate to="/super-admin" replace /> },
  { path: "/hr/*", element: <Navigate to="/super-admin" replace /> },
  { path: "/accounts", element: <Navigate to="/super-admin" replace /> },
  { path: "/accounts/*", element: <Navigate to="/super-admin" replace /> },
  { path: "*", element: <Navigate to="/login" replace /> },
]);
