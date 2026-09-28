// Mirrors PERMISSION_GROUPS + hasPermission() in the web app's src/app/lib/supabase.ts.
// can() only hides UI; the database (RLS + has_perm / require_perm) is the real gate.

export type UserRole =
  | "super_super_admin"
  | "super_admin"
  | "accounting"
  | "hr"
  | "ops_manager"
  | "ops_director"
  | "finance_director";

export const ROLE_LABEL: Record<UserRole, string> = {
  super_super_admin: "Platform owner",
  super_admin: "Super Admin",
  accounting: "Accounts",
  hr: "HR",
  ops_manager: "Ops Manager",
  ops_director: "Ops Director",
  finance_director: "Finance Director",
};

export const PERMISSION_GROUPS: { label: string; items: { key: string; label: string }[] }[] = [
  { label: "Employees", items: [
    { key: "employees.view", label: "View employees" },
    { key: "employees.edit", label: "Add / edit / delete employees" },
    { key: "employees.ops_verify", label: "Ops-verify a draft employee record" },
    { key: "employees.finance_approve", label: "Finance-approve an Ops-verified record" },
  ] },
  { label: "Assignments & Pay", items: [
    { key: "assignments.view", label: "View Assignments & Pay" },
    { key: "assignments.accounts", label: "Edit pay & joining date, view fired" },
    { key: "assignments.hr", label: "Fire, rehire, transfer, posting" },
  ] },
  { label: "Attendance", items: [
    { key: "attendance.view", label: "View attendance" },
    { key: "attendance.edit", label: "Mark / edit attendance" },
    { key: "attendance.bulk_mark", label: "Bulk-mark per employee" },
    { key: "attendance.backdate", label: "Backdate past the cutoff" },
    { key: "attendance.ops_verify", label: "OPS-verify a finished month" },
  ] },
  { label: "Payroll", items: [
    { key: "payroll.view", label: "View payroll" },
    { key: "payroll.edit", label: "Edit / disburse payroll" },
    { key: "payroll.adjust", label: "Raise and settle adjustments" },
    { key: "payroll.approve", label: "Approve payroll runs" },
    { key: "performance.approve", label: "Approve performance" },
  ] },
  { label: "Banks & Accounting", items: [
    { key: "banks.view", label: "View bank accounts & cash custody" },
    { key: "receivables.view", label: "View client receivables" },
    { key: "payables.view", label: "View accounts payable" },
    { key: "accounting.edit", label: "Edit banks, transfers, reconciliation" },
  ] },
  { label: "Expenses", items: [
    { key: "expenses.view", label: "View expenses & advances" },
    { key: "expenses.edit", label: "Add / edit expenses & advances" },
    { key: "expenses.approve", label: "Approve / unapprove expenses" },
  ] },
  { label: "Invoices", items: [
    { key: "invoices.view", label: "View invoices" },
    { key: "invoices.edit", label: "Create / edit invoices & payments" },
  ] },
  { label: "Inventory", items: [
    { key: "inventory.view", label: "View inventory & issuances" },
    { key: "inventory.edit", label: "Stock, purchases, issue / return" },
    { key: "clearance.ops", label: "Clearance — assess kit (Ops)" },
    { key: "clearance.finance", label: "Clearance — settle dues (Finance)" },
  ] },
  { label: "Documents", items: [
    { key: "documents.view", label: "View documents" },
    { key: "documents.edit", label: "Upload / delete documents" },
  ] },
  { label: "Compliance", items: [
    { key: "compliance.view", label: "View important dates & alerts" },
    { key: "compliance.edit", label: "Add / edit dates & alerts" },
    { key: "compliance.filings", label: "File / edit statutory filings" },
  ] },
  { label: "Clients & Contracts", items: [
    { key: "clients.view", label: "View clients" },
    { key: "clients.edit", label: "Add / edit clients" },
    { key: "contracts.view", label: "View contracts" },
    { key: "contracts.edit", label: "Add / edit / delete contracts" },
  ] },
  { label: "Operations", items: [
    { key: "roster.view", label: "View daily reports" },
    { key: "roster.edit", label: "Write daily reports" },
    { key: "incidents.view", label: "View incidents" },
    { key: "incidents.edit", label: "Log / edit incidents" },
  ] },
  { label: "Reports", items: [
    { key: "reports.view", label: "View financial reports & partnership" },
    { key: "cashflow.view", label: "View cashflow" },
    { key: "coa.view", label: "View Chart of Accounts & Trial Balance" },
    { key: "period_close.manage", label: "Close / reopen periods" },
    { key: "partnership.post", label: "Post / reverse a partnership run" },
  ] },
  { label: "Admin", items: [
    { key: "settings.view", label: "View settings" },
    { key: "settings.edit", label: "Edit settings" },
    { key: "users.manage", label: "Create / edit other users" },
    { key: "audit_log.view", label: "View audit log" },
  ] },
];

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

export type ProfileLike = { role: UserRole; permissions: string[] | null } | null | undefined;

export const isAdmin = (p: ProfileLike) => p?.role === "super_admin" || p?.role === "super_super_admin";

export const hasPermission = (p: ProfileLike, key: string) => isAdmin(p) || (p?.permissions ?? []).includes(key);

export const hasAny = (p: ProfileLike, keys: string[]) => keys.length === 0 || keys.some((k) => hasPermission(p, k));
