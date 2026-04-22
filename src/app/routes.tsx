import { createBrowserRouter } from "react-router";
import RoleSelection from "./pages/RoleSelection";
import Login from "./pages/Login";
import SuperAdminLayout from "./layouts/SuperAdminLayout";
import HRLayout from "./layouts/HRLayout";
import AccountsLayout from "./layouts/AccountsLayout";

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

export const router = createBrowserRouter([
  {
    path: "/",
    Component: RoleSelection,
  },
  {
    path: "/login",
    Component: Login,
  },
  {
    path: "/super-admin",
    Component: SuperAdminLayout,
    children: [
      { index: true, Component: Dashboard },
      { path: "users", Component: UserManagement },
      { path: "employees", Component: EmployeeManagement },
      { path: "attendance", Component: AttendanceManagement },
      { path: "payroll", Component: PayrollManagement },
      { path: "accounting", Component: Accounting },
      { path: "reports", Component: FinancialReports },
      { path: "expenses", Component: Expenses },
      { path: "invoices", Component: Invoices },
      { path: "cashflow", Component: Cashflow },
      { path: "inventory", Component: Inventory },
      { path: "compliance", Component: Compliance },
      { path: "documents", Component: Documents },
      { path: "settings", Component: Settings },
    ],
  },
  {
    path: "/hr",
    Component: HRLayout,
    children: [
      { index: true, Component: Dashboard },
      { path: "employees", Component: EmployeeManagement },
      { path: "attendance", Component: AttendanceManagement },
      { path: "documents", Component: Documents },
    ],
  },
  {
    path: "/accounts",
    Component: AccountsLayout,
    children: [
      { index: true, Component: Dashboard },
      { path: "attendance", Component: AttendanceManagement },
      { path: "payroll", Component: PayrollManagement },
      { path: "expenses", Component: Expenses },
      { path: "cashflow", Component: Cashflow },
    ],
  },
]);
