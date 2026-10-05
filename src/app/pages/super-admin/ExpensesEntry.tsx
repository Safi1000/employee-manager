// Expenses route entry (0495). Someone who can see or edit expenses gets the
// full Expenses page. Someone who can only REQUEST an expense gets their own
// requests and the Request Expense form — not a ledger they cannot read.

import { lazy } from "react";
import { useAuth, hasPermission } from "../../lib/auth";

const Expenses = lazy(() => import("./Expenses"));
const MyExpenseRequestsPage = lazy(() => import("../../components/ExpenseRequests"));

export default function ExpensesEntry() {
  const { profile } = useAuth();
  const fullAccess = hasPermission(profile, "expenses.view") || hasPermission(profile, "expenses.edit");
  return fullAccess ? <Expenses /> : <MyExpenseRequestsPage />;
}
