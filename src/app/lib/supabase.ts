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
export const CHEQUE_ATTACHMENTS_BUCKET = "cheque-attachments";

export type UserRole = "super_super_admin" | "super_admin" | "accounting" | "hr";

export type Company = {
  id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  active: boolean;
  subscription_expires_at: string | null;
  dashboard_hidden_widgets?: string[] | null;
  invoice_template?: { field: string; title: string }[] | null;
  legal_address?: string | null;
  tax_ntn?: string | null;
  presentation_currency?: string | null;
  fiscal_year_start?: string | null;
  logo_url?: string | null;
  theme?: string | null;
  created_at?: string;
  updated_at?: string;
};

export const DASHBOARD_WIDGET_KEYS = [
  "stat_employees",
  "stat_attendance_today",
  "stat_expenses_mtd",
  "stat_payroll_mtd",
  // Sprint 1-5 additions
  "stat_active_contracts",
  "stat_open_incidents",
  "stat_licences_expiring",
  "stat_roster_gaps",
  "bank_overview",
  "top_clients",
  "attendance_trend",
  "compliance_alerts",
  // Sprint 1-5 additions
  "expenses_pie",
  "contracts_ending",
  "incidents_recent",
  "roster_overview",
  "period_close_status",
] as const;
export type DashboardWidgetKey = (typeof DASHBOARD_WIDGET_KEYS)[number];

export const DASHBOARD_WIDGET_LABELS: Record<DashboardWidgetKey, string> = {
  stat_employees: "Total Employees (stat card)",
  stat_attendance_today: "Attendance Today (stat card)",
  stat_expenses_mtd: "Expenses MTD (stat card)",
  stat_payroll_mtd: "Payroll MTD (stat card)",
  stat_active_contracts: "Active Contracts (stat card)",
  stat_open_incidents: "Open Incidents (stat card)",
  stat_licences_expiring: "Licences expiring <30d (stat card)",
  stat_roster_gaps: "Roster gaps next 7d (stat card)",
  bank_overview: "Bank Account Overview",
  top_clients: "Top 10 Clients",
  attendance_trend: "Attendance Trend (7 days)",
  compliance_alerts: "Compliance Alerts",
  expenses_pie: "Expenses by Category (pie chart)",
  contracts_ending: "Contracts ending soon",
  incidents_recent: "Recent incidents",
  roster_overview: "Deployment roster (next 7 days)",
  period_close_status: "Period close status",
};

export const INVOICE_TEMPLATE_FIELDS = [
  "invoice_number",
  "invoice_date",
  "client_name",
  "client_code",
  "client_email",
  "client_phone",
  "contract_period",
  "description",
  "subtotal",
  "withholding_tax",
  "total",
  "amount_received",
  "balance_due",
  "status",
  "notes",
] as const;
export type InvoiceTemplateField = (typeof INVOICE_TEMPLATE_FIELDS)[number];

export const INVOICE_TEMPLATE_FIELD_LABELS: Record<InvoiceTemplateField, string> = {
  invoice_number: "Invoice Number",
  invoice_date: "Invoice Date",
  client_name: "Client Name",
  client_code: "Client Code",
  client_email: "Client Email",
  client_phone: "Client Phone",
  contract_period: "Contract Period (start → end)",
  description: "Description (line item)",
  subtotal: "Subtotal (invoice amount)",
  withholding_tax: "Withholding Tax",
  total: "Total (after WHT)",
  amount_received: "Amount Received",
  balance_due: "Balance Due",
  status: "Status",
  notes: "Notes",
};

export type InvoiceTemplateItem = { field: InvoiceTemplateField; title: string };

export type TaskStatus = "todo" | "in_progress" | "done";

export type Task = {
  id: string;
  company_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee_id: string | null;
  created_by: string | null;
  due_date: string | null;
  position: number;
  created_at?: string;
  updated_at?: string;
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
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
  branch_id: string | null;
  role: UserRole;
  title: string | null;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  display_company_name: string | null;
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
    label: "Clients & Contracts",
    items: [
      { key: "clients.view", label: "View clients" },
      { key: "clients.edit", label: "Add / edit clients" },
      { key: "contracts.view", label: "View contracts" },
      { key: "contracts.edit", label: "Add / edit contracts" },
    ],
  },
  {
    label: "Deployment & Incidents",
    items: [
      { key: "roster.view", label: "View deployment roster" },
      { key: "roster.edit", label: "Edit roster / manage posts" },
      { key: "incidents.view", label: "View incidents" },
      { key: "incidents.edit", label: "Log / edit incidents" },
    ],
  },
  {
    label: "Reports & Finance",
    items: [
      { key: "reports.view", label: "View financial reports & partnership" },
      { key: "cashflow.view", label: "View cashflow" },
      { key: "coa.view", label: "View Chart of Accounts & Trial Balance" },
      { key: "period_close.manage", label: "Close / reopen accounting periods" },
    ],
  },
  {
    label: "Settings & Users",
    items: [
      { key: "settings.view", label: "View settings (locations, notifications)" },
      { key: "settings.edit", label: "Edit settings" },
      { key: "users.manage", label: "Create / edit other users" },
      { key: "audit_log.view", label: "View audit log" },
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
export type ClientFilerStatus = "filer" | "non_filer";

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
  leave_carry_start: string | null;
  eobi_enabled: boolean;
  eobi_amount: number;
  branch_id: string | null;
  auto_invoice_enabled: boolean;
  auto_invoice_amount: number;
  auto_invoice_withholding: number;
  contract_start: string | null;
  contract_end: string | null;
  advance_payment: boolean;
  contract_drive_file_id: string | null;
  contract_drive_view_url: string | null;
  contract_file_name: string | null;
  // Sprint 2 additions (spec section 3.1)
  ntn: string | null;
  strn: string | null;
  filer_status: ClientFilerStatus | null;
  withholding_tax_rate: number | null;
  billing_address: string | null;
  authorised_signatory: string | null;
  signatory_cnic: string | null;
  industry: string | null;
  created_at?: string;
};

// Sprint 2: separate Contracts entity (spec section 3.2).
export type ContractType = "services" | "guard_deployment";
export type ContractShift = "day" | "night" | "evening";
export type ContractStatus = "active" | "expired" | "terminated" | "draft";

export type GuardRates = {
  senior_supervisor?: number;
  assistant_supervisor?: number;
  supervisor?: number;
  ex_military?: number;
  civ_guard?: number;
  walkie_talkie?: number;
  weapons_guard?: number;
};

export type Contract = {
  id: string;
  company_id?: string;
  client_id: string;
  contract_code: string;
  contract_type: ContractType;
  start_date: string;
  end_date: string | null;
  number_of_guards: number;
  day_guards: number;
  night_guards: number;
  evening_guards: number;
  guard_rates: GuardRates;
  rate_per_guard_per_month: number;
  allowed_leaves_per_month: number | null;
  eobi_deduction: boolean;
  eobi_amount: number | null;
  annual_escalation_pct: number | null;
  auto_invoice_enabled: boolean;
  renewal_terms: string | null;
  status: ContractStatus;
  drive_file_id: string | null;
  drive_view_url: string | null;
  contract_file_name: string | null;
  created_at?: string;
  updated_at?: string;
};

export const CONTRACT_TYPE_LABEL: Record<ContractType, string> = {
  services: "Services",
  guard_deployment: "Guard Deployment",
};

export const CONTRACT_SHIFT_LABEL: Record<ContractShift, string> = {
  day: "Day",
  night: "Night",
  evening: "Evening",
};

export const GUARD_RATE_LABELS: Record<keyof GuardRates, string> = {
  senior_supervisor: "Senior Supervisor",
  assistant_supervisor: "Assistant Supervisor",
  supervisor: "Supervisor",
  ex_military: "Ex-Military",
  civ_guard: "Civ Guard",
  walkie_talkie: "Walkie Talkie",
  weapons_guard: "Weapons Guard",
};

export const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = {
  active: "Active",
  expired: "Expired",
  terminated: "Terminated",
  draft: "Draft",
};

export const PAKISTAN_INDUSTRIES = [
  "Banking",
  "Education",
  "Residential",
  "Retail",
  "Industrial",
  "Healthcare",
  "Hospitality",
  "Telecom",
  "Government",
  "NGO",
  "Other",
] as const;

export const PAKISTAN_BANKS = [
  "Allied Bank Limited",
  "Askari Bank Limited",
  "Bank Alfalah Limited",
  "Bank AL Habib Limited",
  "BankIslami Pakistan",
  "Dubai Islamic Bank Pakistan",
  "Faysal Bank Limited",
  "Habib Bank Limited (HBL)",
  "Habib Metropolitan Bank",
  "JS Bank Limited",
  "MCB Bank Limited",
  "Meezan Bank Limited",
  "National Bank of Pakistan (NBP)",
  "Soneri Bank Limited",
  "Standard Chartered Pakistan",
  "Summit Bank Limited",
  "The Bank of Khyber",
  "The Bank of Punjab",
  "United Bank Limited (UBL)",
  "Other",
] as const;

export type Branch = {
  id: string;
  company_id?: string;
  name: string;
  is_head_office: boolean;
  created_at?: string;
  updated_at?: string;
};

export type EmployeeCategory = "client" | "office_staff" | "reliever";

export type EmployeeContractType =
  | "permanent"
  | "contract"
  | "probation"
  | "daily_wages";

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"] as const;
export const EMERGENCY_CONTACT_RELATIONS = [
  "Spouse",
  "Parent",
  "Sibling",
  "Child",
  "Friend",
  "Other",
] as const;

export type ChequeType = "payment" | "cash";
export type ChequeDirection = "outgoing" | "incoming";

export type Cheque = {
  id: string;
  company_id?: string;
  bank_account_id: string;
  cheque_number: string;
  amount: number;
  cheque_date: string;
  cheque_type: ChequeType;
  direction: ChequeDirection;
  status: "pending" | "cleared";
  attachment_path: string | null;
  drive_file_id: string | null;
  drive_view_url: string | null;
  attachment_file_name: string | null;
  notes: string | null;
  recipient: string | null;
  cleared_at: string | null;
  invoice_id?: string | null;
  client_id?: string | null;
  created_at?: string;
  updated_at?: string;
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
  category: EmployeeCategory;
  branch_id: string | null;
  department: string | null;
  shift: "day" | "night" | "evening";
  status: "Active" | "On Leave" | "Inactive";
  base_salary: number | null;
  per_day_salary: number | null;
  // Always disbursed alongside salary, regardless of attendance. Untaxed.
  allowance: number | null;
  // One-time opening leave balance that OVERRIDES the accumulated carry-forward
  // balance from `opening_leaves_month` forward. null = never set yet (form still
  // editable); any number incl. 0 = set (form locks it).
  opening_leaves: number | null;
  // Month (first-of-month) the opening override takes effect. Set alongside
  // opening_leaves; null when no opening is set.
  opening_leaves_month: string | null;
  join_date: string | null;
  bank_name: string | null;
  bank_account: string | null;
  // Sprint 2 HR field expansion (spec section 3.3 + Appendix A.1)
  cnic_number: string | null;
  date_of_birth: string | null;
  father_or_husband_name: string | null;
  blood_group: string | null;
  permanent_address: string | null;
  current_address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_relation: string | null;
  emergency_contact_phone: string | null;
  reporting_to_employee_id: string | null;
  employee_contract_type: EmployeeContractType | null;
  probation_end_date: string | null;
  contract_id: string | null;
  weapon_licence_number: string | null;
  weapon_licence_expiry: string | null;
  guard_service_licence_number: string | null;
  guard_service_licence_expiry: string | null;
  medical_fitness_expiry: string | null;
  eobi_registration_number: string | null;
  iban: string | null;
  created_at?: string;
  updated_at?: string;
};

export type AttendanceStatus = "Present" | "Absent" | "Leave";

export type AttendanceRecord = {
  id: string;
  employee_id: string;
  attendance_date: string;
  status: AttendanceStatus;
  /** Per-day client attribution used for relievers (NULL for everyone else;
   * regular staff inherit their primary client from employees.client_id). */
  worked_for_client_id?: string | null;
  // Sprint 3 enhancements
  half_day?: boolean;
  late_arrival?: boolean;
  hours_worked?: number | null;
  overtime_hours?: number;
  marked_at?: string;
};

// Sprint 3 — Posts / Deployment Sites (spec section 4.1)
export type Post = {
  id: string;
  company_id?: string;
  client_id: string;
  branch_id: string | null;
  contract_id: string | null;
  name: string;
  address: string | null;
  required_guards: number;
  shift_pattern: ContractShift;
  active: boolean;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
};

// Sprint 3 — Deployment Roster (spec section 3.4 + 4.1)
export type RosterShift = "day" | "night" | "evening";
export type RosterStatus =
  | "assigned"
  | "confirmed"
  | "leave_requested"
  | "reliever_needed"
  | "unassigned";

export type RosterAssignment = {
  id: string;
  company_id?: string;
  employee_id: string;
  post_id: string | null;
  client_id: string | null;
  assignment_date: string;
  shift: RosterShift;
  status: RosterStatus;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
};

export const ROSTER_STATUS_LABEL: Record<RosterStatus, string> = {
  assigned: "Assigned",
  confirmed: "Confirmed",
  leave_requested: "Leave Requested",
  reliever_needed: "Reliever Needed",
  unassigned: "Unassigned",
};

// Sprint 3 — Incidents (spec section 4.2)
export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentCategory =
  | "theft"
  | "altercation"
  | "guard_injury"
  | "weapon_discharge"
  | "no_show"
  | "asset_damage"
  | "client_complaint"
  | "other";
export type IncidentStatus =
  | "open"
  | "under_investigation"
  | "resolved"
  | "closed";

export type Incident = {
  id: string;
  company_id?: string;
  incident_code: string;
  occurred_at: string;
  client_id: string | null;
  post_id: string | null;
  severity: IncidentSeverity;
  category: IncidentCategory;
  description: string | null;
  client_notified: boolean;
  client_notified_at: string | null;
  action_taken: string | null;
  status: IncidentStatus;
  drive_file_id: string | null;
  drive_view_url: string | null;
  attachment_file_name: string | null;
  created_at?: string;
  updated_at?: string;
};

export type IncidentGuard = {
  incident_id: string;
  employee_id: string;
};

export const INCIDENT_SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const INCIDENT_CATEGORY_LABEL: Record<IncidentCategory, string> = {
  theft: "Theft",
  altercation: "Altercation",
  guard_injury: "Guard Injury",
  weapon_discharge: "Weapon Discharge",
  no_show: "No-show",
  asset_damage: "Asset Damage",
  client_complaint: "Client Complaint",
  other: "Other",
};

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  open: "Open",
  under_investigation: "Under Investigation",
  resolved: "Resolved",
  closed: "Closed",
};

// Sprint 4 — Chart of Accounts (spec section 8.1)
export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type AccountNormalSide = "debit" | "credit";

export type ChartAccount = {
  id: string;
  company_id?: string;
  account_code: string;
  account_name: string;
  account_type: AccountType;
  normal_side: AccountNormalSide;
  parent_id: string | null;
  system_key: string | null;
  system_account: boolean;
  active: boolean;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
};

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  revenue: "Revenue",
  expense: "Expenses",
};

export const ACCOUNT_TYPE_ORDER: AccountType[] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
];

// Sprint 4 — Period close (spec section 6.5 + 8.4)
export type AccountingPeriod = {
  id: string;
  company_id?: string;
  period_month: string;   // YYYY-MM-01
  closed_by: string | null;
  closed_at: string;
  note: string | null;
};

// Sprint 4 — Audit log (spec section 6.4)
export type AuditAction = "insert" | "update" | "delete";

// changes shape:
//   insert: { field: { after: value } }
//   update: { field: { before: old, after: new } }
//   delete: { field: { before: value } }
export type AuditChanges = Record<string, { before?: unknown; after?: unknown }>;

export type AuditLogEntry = {
  id: string;
  company_id: string | null;
  table_name: string;
  record_id: string | null;
  action: AuditAction;
  changed_by: string | null;
  changed_at: string;
  changes: AuditChanges;
};

// The tables that are wired up to the audit log trigger. Kept in sync with
// the array in migration 0041.
export const AUDITED_TABLES = [
  "employees",
  "clients",
  "contracts",
  "invoices",
  "invoice_payments",
  "expenses",
  "payslips",
  "advances",
  "cheques",
  "bank_accounts",
  "bank_transactions",
  "branches",
  "profiles",
  "chart_of_accounts",
  "accounting_periods",
  "posts",
  "incidents",
  "roster_assignments",
] as const;

export type AuditedTable = (typeof AUDITED_TABLES)[number];

// Sprint 5 — Double-entry journal (spec section 6.2)
export type JournalEntry = {
  id: string;
  company_id?: string;
  entry_date: string;
  description: string | null;
  source_table: string | null;
  source_id: string | null;
  is_reversal: boolean;
  manual: boolean;
  posted_by: string | null;
  created_at?: string;
};

export type JournalLine = {
  id: string;
  journal_entry_id: string;
  account_id: string;
  debit: number;
  credit: number;
};

export type EmployeeDocument = {
  id: string;
  employee_id: string;
  doc_type: string;
  file_name: string;
  /** Legacy: Supabase Storage path. NULL on new (Drive) uploads. Kept so old
   * rows still resolve via storage.getPublicUrl. */
  storage_path: string | null;
  /** Google Drive file ID for new uploads. NULL on legacy storage_path rows. */
  drive_file_id: string | null;
  /** Drive's webViewLink — the canonical share URL. */
  drive_view_url: string | null;
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
  branch_id: string | null;
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
  iban: string | null;
  branch_code: string | null;
  branch_name: string | null;
  swift_code: string | null;
  currency_code: string;
  active: boolean;
  auto_zero_monthly?: boolean;
  last_zeroed_month?: string | null;
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
  | "transfer"
  | "cheque";

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

export type PaymentMode = "Cash" | "Bank" | "Cheque";
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
  allowance: number;
  final_salary: number;
  net_salary: number;
  payment_mode: PaymentMode;
  bank_account_id: string | null;
  cheque_id: string | null;
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
  branch_id: string | null;
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
  drive_file_id: string | null;
  drive_view_url: string | null;
  attachment_file_name: string | null;
  notes: string | null;
  status: InvoiceStatus;
  created_at?: string;
  updated_at?: string;
};

export type Advance = {
  id: string;
  employee_id: string;
  client_id: string | null;
  branch_id: string | null;
  amount: number;
  advance_date: string;
  payment_mode: "Cash" | "Bank" | "Cheque";
  bank_account_id: string | null;
  cheque_id: string | null;
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

export type ExpensePaymentMode = "Cash" | "Bank" | "Payable" | "Cheque";
export type PayableStatus = "Pending" | "Paid";
export type ExpensePlCategory = "cost_of_services" | "operating_expense";

export type Expense = {
  id: string;
  category_id: string | null;
  pl_category: ExpensePlCategory;
  client_id: string | null;
  branch_id: string | null;
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
  cheque_id: string | null;
  receipt_path: string | null;
  drive_file_id: string | null;
  drive_view_url: string | null;
  receipt_file_name: string | null;
  notes: string | null;
  created_at?: string;
  updated_at?: string;
};
