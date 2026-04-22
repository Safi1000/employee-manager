import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, anonKey);

export const EMPLOYEE_DOCS_BUCKET = "employee-documents";
export const EXPENSE_RECEIPTS_BUCKET = "expense-receipts";
export const INVOICE_ATTACHMENTS_BUCKET = "invoice-attachments";

export type Location = {
  id: string;
  name: string;
  created_at?: string;
};

export type Client = {
  id: string;
  client_code: string;
  name: string;
  email: string | null;
  phone: string | null;
  allowed_leaves_per_month: number;
  opening_balance: number;
  created_at?: string;
};

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

export type BankAccount = {
  id: string;
  bank_name: string;
  account_number: string;
  account_type: "Current" | "Savings";
  opening_balance: number;
  balance: number;
  created_at?: string;
  updated_at?: string;
};

export type Treasury = {
  id: string;
  cash_balance: number;
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
  | "receipt";

export type BankTransaction = {
  id: string;
  bank_account_id: string | null;
  kind: BankTransactionKind;
  amount: number;
  cash_delta: number;
  account_delta: number;
  description: string | null;
  reference_id: string | null;
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
  final_salary: number;
  net_salary: number;
  payment_mode: PaymentMode;
  bank_account_id: string | null;
  status: PayslipStatus;
  disbursed: boolean;
  disbursed_at: string | null;
  notes: string | null;
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

export type Invoice = {
  id: string;
  client_id: string;
  invoice_number: string;
  invoice_date: string;
  invoice_amount: number;
  amount_received: number;
  attachment_path: string | null;
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
