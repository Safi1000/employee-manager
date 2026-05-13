import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, anonKey);

// Paginate through a Supabase query in chunks of 1000 (PostgREST's default
// response cap) until the entire result set is fetched. Pass a builder that
// creates a fresh filter chain each iteration so we can attach a new .range()
// for each page. Important: the builder MUST set an explicit .order(...) so
// pagination is stable.
export async function fetchAllRows<T>(
  build: () => { range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }> },
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  // Hard ceiling guard in case something pathological happens.
  for (let safety = 0; safety < 200; safety++) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) return out;
    from += pageSize;
  }
  return out;
}

export const EMPLOYEE_DOCS_BUCKET = "employee-documents";
export const EXPENSE_RECEIPTS_BUCKET = "expense-receipts";
export const INVOICE_ATTACHMENTS_BUCKET = "invoice-attachments";

export type UserRole = "super_super_admin" | "super_admin" | "accounting" | "hr";

export type Company = {
  id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  active: boolean;
  subscription_expires_at: string | null;
  created_at?: string;
  updated_at?: string;
};

export type SubscriptionPayment = {
  id: string;
  company_id: string;
  amount: number;
  days_added: number;
  payment_date: string;
  notes: string | null;
  recorded_by: string | null;
  created_at?: string;
};

export type Profile = {
  id: string;
  company_id: string | null;
  role: UserRole;
  title: string | null;
  full_name: string | null;
  email: string | null;
  view_as_company: string | null;
  permissions: string[];
  must_change_password: boolean;
  created_at?: string;
  updated_at?: string;
};

// Feature permission catalog. Grouped for UI grouping.
export const PERMISSION_GROUPS: { label: string; items: { key: string; label: string }[] }[] = [
  {
    label: "Employees",
    items: [
      { key: "employees.view", label: "View employees" },
      { key: "employees.edit", label: "Add / edit / delete employees" },
    ],
  },
  {
    label: "Attendance",
    items: [
      { key: "attendance.view", label: "View attendance" },
      { key: "attendance.edit", label: "Mark / edit attendance" },
      { key: "attendance.bulk_mark", label: "Bulk-mark attendance per employee (calendar)" },
    ],
  },
  {
    label: "Payroll",
    items: [
      { key: "payroll.view", label: "View payroll" },
      { key: "payroll.edit", label: "Edit / disburse payroll" },
    ],
  },
  {
    label: "Banks & Accounting",
    items: [
      { key: "accounting.view", label: "View banks / receivables / payables" },
      { key: "accounting.edit", label: "Edit banks, transfers, reconciliation" },
    ],
  },
  {
    label: "Expenses",
    items: [
      { key: "expenses.view", label: "View expenses & advances" },
      { key: "expenses.edit", label: "Add / edit expenses & advances" },
    ],
  },
  {
    label: "Invoices",
    items: [
      { key: "invoices.view", label: "View invoices" },
      { key: "invoices.edit", label: "Create / edit invoices & payments" },
    ],
  },
  {
    label: "Inventory",
    items: [
      { key: "inventory.view", label: "View inventory & issuances" },
      { key: "inventory.edit", label: "Add / edit inventory" },
    ],
  },
  {
    label: "Documents",
    items: [
      { key: "documents.view", label: "View documents" },
      { key: "documents.edit", label: "Upload / delete documents" },
    ],
  },
  {
    label: "Compliance",
    items: [
      { key: "compliance.view", label: "View important dates & alerts" },
      { key: "compliance.edit", label: "Add / edit dates & alerts" },
    ],
  },
  {
    label: "Reports",
    items: [
      { key: "reports.view", label: "View financial reports & partnership" },
      { key: "cashflow.view", label: "View cashflow" },
    ],
  },
  {
    label: "Settings & Users",
    items: [
      { key: "settings.view", label: "View settings (clients, locations, notifications)" },
      { key: "settings.edit", label: "Edit settings" },
      { key: "users.manage", label: "Create / edit other users" },
    ],
  },
];

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

export type Location = {
  id: string;
  company_id?: string;
  name: string;
  created_at?: string;
};

export type ClientType = "security_services" | "guard_deployment";

export type Client = {
  id: string;
  client_code: string;
  name: string;
  email: string | null;
  phone: string | null;
  allowed_leaves_per_month: number;
  opening_balance: number;
  client_type: ClientType;
  leave_carry_forward: boolean;
  eobi_enabled: boolean;
  eobi_amount: number;
  created_at?: string;
};

export const HARDCODED_EXPENSE_CATEGORIES = [
  "Weapons & Ammunition",
  "Uniform",
  "Equipment & Supplies",
  "Transportation & Fuel",
  "Utilities & Rent",
  "Insurance",
  "Licenses",
  "EOBI",
  "IESSI",
  "PESSI",
  "Taxes",
] as const;

export const isHardcodedCategory = (name: string) =>
  (HARDCODED_EXPENSE_CATEGORIES as readonly string[]).includes(name);

export type Employee = {
  id: string;
  employee_code: string;
  full_name: string;
  phone: string | null;
  location_id: string | null;
  client_id: string | null;
  department: string | null;
  shift: "day" | "night";
  status: "Active" | "On Leave" | "Inactive";
  base_salary: number | null;
  per_day_salary: number | null;
  join_date: string | null;
  bank_name: string | null;
  bank_account: string | null;
  created_at?: string;
  updated_at?: string;
};

export type AttendanceStatus = "Present" | "Absent" | "Leave";

export type AttendanceRecord = {
  id: string;
  employee_id: string;
  attendance_date: string;
  status: AttendanceStatus;
  marked_at?: string;
};

export type EmployeeDocument = {
  id: string;
  employee_id: string;
  doc_type: string;
  file_name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_at?: string;
};

export type InventoryKind = "weapon" | "uniform";
export type InventoryStatus = "Available" | "Issued" | "Maintenance";
export type ReturnCondition = "Good" | "Fair" | "Damaged";

export type InventoryItem = {
  id: string;
  kind: InventoryKind;
  item_type: string;
  serial_number: string | null;
  size: string | null;
  quantity: number;
  location_id: string | null;
  license_expiry: string | null;
  status: InventoryStatus;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
};

export type BankAccountOwnerType = "company" | "partner" | "client";

export type BankAccount = {
  id: string;
  bank_name: string;
  account_number: string;
  account_type: "Current" | "Savings";
  opening_balance: number;
  balance: number;
  owner_type: BankAccountOwnerType;
  owner_partner_id: string | null;
  owner_client_id: string | null;
  created_at?: string;
  updated_at?: string;
};

export type Partner = {
  id: string;
  company_id?: string;
  name: string;
  profit_share_percent: number;
  opening_balance: number;
  opening_balance_locked: boolean;
  start_month: string | null;
  created_at?: string;
  updated_at?: string;
};

export type Treasury = {
  id: string;
  cash_balance: number;
  cash_opening_balance: number;
  cash_opening_locked: boolean;
  updated_at?: string;
};

export type BankTransactionKind =
  | "opening"
  | "deposit"
  | "withdraw_to_cash"
  | "payroll"
  | "reconcile"
  | "adjustment"
  | "cash_adjustment"
  | "expense"
  | "receipt"
  | "advance"
  | "transfer";

export type BankTransaction = {
  id: string;
  bank_account_id: string | null;
  kind: BankTransactionKind;
  amount: number;
  cash_delta: number;
  account_delta: number;
  description: string | null;
  reference_id: string | null;
  transfer_pair_id: string | null;
  created_at?: string;
};

export type PaymentMode = "Cash" | "Bank";
export type PayslipStatus = "Pending" | "Cleared";

export type Payslip = {
  id: string;
  employee_id: string;
  period_month: string;
  working_days: number;
  present_days: number;
  absent_days: number;
  leave_days: number;
  base_salary: number;
  per_day_salary: number | null;
  bonus: number;
  deductions: number;
  advance: number;
  income_tax: number;
  eobi: number;
  final_salary: number;
  net_salary: number;
  payment_mode: PaymentMode;
  bank_account_id: string | null;
  status: PayslipStatus;
  disbursed: boolean;
  disbursed_at: string | null;
  notes: string | null;
  override_leaves: boolean;
  created_at?: string;
  updated_at?: string;
};

export type Issuance = {
  id: string;
  item_id: string;
  employee_id: string | null;
  client_id: string | null;
  location_id: string | null;
  issue_date: string;
  return_date: string | null;
  condition: ReturnCondition | null;
  notes: string | null;
  created_at?: string;
};

export type ExpenseCategory = {
  id: string;
  name: string;
  created_at?: string;
};

export type Vendor = {
  id: string;
  name: string;
  account_number: string | null;
  created_at?: string;
};

export type InvoiceStatus = "Pending" | "Delivered";

export type Invoice = {
  id: string;
  client_id: string;
  invoice_number: string;
  invoice_date: string;
  invoice_amount: number;
  withholding_tax: number;
  amount_received: number;
  attachment_path: string | null;
  notes: string | null;
  status: InvoiceStatus;
  created_at?: string;
  updated_at?: string;
};

export type Advance = {
  id: string;
  employee_id: string;
  client_id: string | null;
  amount: number;
  advance_date: string;
  payment_mode: "Cash" | "Bank";
  bank_account_id: string | null;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
};

export type InvoicePayment = {
  id: string;
  invoice_id: string | null;
  client_id: string | null;
  amount: number;
  payment_date: string;
  payment_mode: "Cash" | "Bank";
  bank_account_id: string | null;
  notes: string | null;
  created_at?: string;
};

export const COMPLIANCE_CATEGORIES = [
  "License",
  "Tax",
  "HR",
  "Payroll",
  "Inventory",
  "Client",
  "Invoice",
  "Operations",
  "Other",
] as const;
export type ComplianceCategory = (typeof COMPLIANCE_CATEGORIES)[number];

export type CompliancePriority = "critical" | "high" | "medium" | "low";

export type ImportantDate = {
  id: string;
  title: string;
  due_date: string;
  category: ComplianceCategory;
  priority: CompliancePriority;
  advance_notice_days: number;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
};

export type RecurringFrequency = "Daily" | "Weekly" | "Monthly" | "Yearly";

export type RecurringAlert = {
  id: string;
  name: string;
  category: ComplianceCategory;
  frequency: RecurringFrequency;
  trigger_day: string;
  advance_notice_days: number;
  active: boolean;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
};

export type ExpensePaymentMode = "Cash" | "Bank" | "Payable";
export type PayableStatus = "Pending" | "Paid";

export type Expense = {
  id: string;
  category_id: string | null;
  client_id: string | null;
  vendor_id: string | null;
  description: string | null;
  amount: number;
  expense_date: string;
  payment_mode: ExpensePaymentMode;
  bank_account_id: string | null;
  due_date: string | null;
  payable_status: PayableStatus | null;
  paid_via: "Cash" | "Bank" | null;
  paid_bank_account_id: string | null;
  paid_at: string | null;
  receipt_path: string | null;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
};
