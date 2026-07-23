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
  // Invoice Structure branding (0114). Logo/stamp are base64 data URLs.
  legal_name?: string | null;
  registration_line?: string | null;
  website?: string | null;
  signature_label?: string | null;
  stamp_url?: string | null;
  contact_phones?: string[] | null;
  invoice_settings?: InvoiceStructureSettings | null;
  created_at?: string;
  updated_at?: string;
};

// Per-company, per-template toggles stored in companies.invoice_settings (0114).
export type InvoiceStructureSettings = {
  fixed_show_previous_balance?: boolean;
  variable_show_previous_balance?: boolean;
  general_show_stamp?: boolean;
  // When true (default) the SLA template derives its tax columns from the
  // client's tax_profile; otherwise it uses sla_tax_columns.
  sla_taxes_dynamic?: boolean;
  sla_tax_columns?: string[];
  // Short company prefix for the invoice Ref number ({CompanyPrefix}-{YY}-{ClientPrefix}-{MM}).
  company_prefix?: string;
  // Brand accent colour (hex) for header/footer rules on the PDF.
  brand_color?: string;
  // Watermark: a separate faded mark (base64 data URL), a toggle, and opacity.
  watermark_url?: string;
  show_watermark?: boolean;
  watermark_opacity?: number; // 0..1
};

export const DEFAULT_INVOICE_SETTINGS: InvoiceStructureSettings = {
  fixed_show_previous_balance: true,
  variable_show_previous_balance: true,
  general_show_stamp: true,
  sla_taxes_dynamic: true,
  sla_tax_columns: [],
  company_prefix: "",
  brand_color: "",
  watermark_url: "",
  show_watermark: false,
  watermark_opacity: 0.1,
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

export type TaskPriority = "low" | "medium" | "high" | "urgent";

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export const TASK_PRIORITY_BADGE: Record<TaskPriority, string> = {
  low: "bg-slate-100 text-slate-600 border-slate-200",
  medium: "bg-brand-50 text-brand-700 border-brand-200",
  high: "bg-warning-50 text-warning-700 border-warning-200",
  urgent: "bg-danger-50 text-danger-700 border-danger-200",
};

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
  // §17 tasking upgrade (migration 0093): priority + completion timestamp
  // (completed_at is stamped by a DB trigger when status becomes 'done').
  priority: TaskPriority;
  completed_at: string | null;
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
      { key: "attendance.backdate", label: "Backdate attendance past the marking cutoff" },
    ],
  },
  {
    label: "Payroll",
    items: [
      { key: "payroll.view", label: "View payroll" },
      { key: "payroll.edit", label: "Edit / disburse payroll" },
      // Sign-off gate on a payroll run (spec §13): only holders (plus
      // super_admin/SSA) may move a run from Review to Approved, which locks it.
      { key: "payroll.approve", label: "Approve payroll runs (COO/Finance sign-off)" },
      // Part IV §14/§16: COO gate on enrollment, appraisal approval, bonus pools.
      { key: "performance.approve", label: "Approve performance (enrollment, appraisals, bonus pools)" },
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

// Phase 3: client billing/tax profile.
export type ClientBillingType = "STANDARD" | "SLA";
export type ClientInvoiceGroup = "FIXED" | "VARIABLE" | "SLA";
export type TaxBase = "WHOLE_INVOICE" | "SPECIFIC_COMPONENT" | "COMPOUND";
export type TaxDirection = "ADDED" | "WITHHELD";

export type TaxLine = {
  name: string;
  rate: number; // percent
  base: TaxBase;
  direction: TaxDirection;
  component?: string; // free-text placeholder until Phase 5 SLA components exist
};

export type RemitAccount = {
  account_title: string;
  account_number: string; // account no. / IBAN
  bank_name: string;
  is_default: boolean;
};

export const CLIENT_BILLING_TYPE_LABEL: Record<ClientBillingType, string> = {
  STANDARD: "Standard",
  SLA: "SLA",
};

export const CLIENT_INVOICE_GROUP_LABEL: Record<ClientInvoiceGroup, string> = {
  FIXED: "Fixed",
  VARIABLE: "Variable",
  SLA: "SLA",
};

export const TAX_BASE_LABEL: Record<TaxBase, string> = {
  WHOLE_INVOICE: "Whole invoice",
  SPECIFIC_COMPONENT: "Specific component",
  COMPOUND: "Compound",
};

export const TAX_DIRECTION_LABEL: Record<TaxDirection, string> = {
  ADDED: "Added",
  WITHHELD: "Withheld",
};

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
  // Phase 3 additions
  tax_profile: TaxLine[];
  remit_accounts: RemitAccount[];
  billing_type: ClientBillingType;
  invoice_group: ClientInvoiceGroup;
  // Manual prefix that drives client-scoped employee codes ({prefix}-NNN).
  // null on clients that haven't set one yet (existing clients stay EMP-XXXX
  // until a prefix is set). Unique per company where not null.
  employee_id_prefix: string | null;
  created_at?: string;
};

// One row per employee-code change (0073). Surfaced on the Employee View modal
// as an ID history trail. reason: 'assigned' (first) | 'reassigned' | 'prefix_changed'.
export type EmployeeCodeHistory = {
  id: string;
  company_id?: string;
  employee_id: string;
  old_code: string | null;
  new_code: string;
  client_id: string | null;
  reason: "assigned" | "reassigned" | "prefix_changed";
  changed_by: string | null;
  changed_at: string;
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
  // Open-ended contract: end_date is ignored and termination is governed by
  // notice_period_days instead (0072).
  is_infinite: boolean;
  notice_period_days: number | null;
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

// Phase 1: per-category contract lines (committed headcount + rate per category).
// Enum is extensible — add values in a migration and here. Supersedes main's
// guard_rates JSONB (which stored a rate per type but no count).
export type ContractLineCategory =
  | "SR_SUPERVISOR"
  | "SUPERVISOR"
  | "ASST_SUPERVISOR"
  | "GUARD"
  | "RELIEVER"
  | "WEAPON"
  | "EQUIPMENT";

export const CONTRACT_LINE_CATEGORY_LABEL: Record<ContractLineCategory, string> = {
  SR_SUPERVISOR: "Senior Supervisor",
  SUPERVISOR: "Supervisor",
  ASST_SUPERVISOR: "Assistant Supervisor",
  GUARD: "Guard",
  RELIEVER: "Reliever",
  WEAPON: "Weapon",
  EQUIPMENT: "Equipment",
};

/**
 * Which line categories a contract may use, by contract type. A Services contract
 * bills for hardware (weapons/equipment); a Guard Deployment contract bills for
 * people. The two sets are disjoint, so the category dropdown offers only the ones
 * valid for the contract's type.
 */
export const CONTRACT_TYPE_LINE_CATEGORIES: Record<ContractType, ContractLineCategory[]> = {
  services: ["WEAPON", "EQUIPMENT"],
  guard_deployment: ["SR_SUPERVISOR", "ASST_SUPERVISOR", "SUPERVISOR", "GUARD", "RELIEVER"],
};

// Order categories appear in the default Contract Lines table.
export const CONTRACT_LINE_CATEGORY_ORDER: ContractLineCategory[] = [
  "SR_SUPERVISOR",
  "ASST_SUPERVISOR",
  "SUPERVISOR",
  "GUARD",
  "RELIEVER",
  "WEAPON",
  "EQUIPMENT",
];

export type ContractLine = {
  id: string;
  company_id?: string;
  contract_id: string;
  category: ContractLineCategory;
  label: string | null;
  location: string | null;
  committed_count: number;
  unit_rate: number;
  cost_components: Record<string, unknown> | null;
  taxable: boolean;
  created_at?: string;
  updated_at?: string;
};

// Contract value from its lines = Σ(committed_count × unit_rate).
export function contractLinesValue(lines: Pick<ContractLine, "committed_count" | "unit_rate">[]): number {
  return lines.reduce((sum, l) => sum + (Number(l.committed_count) || 0) * (Number(l.unit_rate) || 0), 0);
}

// Total committed headcount across all lines of a contract.
export function contractLinesCommitted(lines: Pick<ContractLine, "committed_count">[]): number {
  return lines.reduce((sum, l) => sum + (Number(l.committed_count) || 0), 0);
}

// Phase 2: contract addendums — dated changes to committed headcount / rate.
export type AddendumChangeType = "ADD_HEADCOUNT" | "REDUCE_HEADCOUNT" | "RATE_CHANGE";
export type AddendumSource = "SIGNED_CONTRACT" | "EMAIL" | "VERBAL" | "OTHER";

export const ADDENDUM_CHANGE_TYPE_LABEL: Record<AddendumChangeType, string> = {
  ADD_HEADCOUNT: "Add headcount",
  REDUCE_HEADCOUNT: "Reduce headcount",
  RATE_CHANGE: "Rate change",
};

export const ADDENDUM_SOURCE_LABEL: Record<AddendumSource, string> = {
  SIGNED_CONTRACT: "Signed contract",
  EMAIL: "Email",
  VERBAL: "Verbal",
  OTHER: "Other",
};

export type ContractAddendum = {
  id: string;
  company_id?: string;
  contract_id: string;
  contract_line_id: string | null; // null = introduces a new line (see `category`)
  category: ContractLineCategory | null;
  change_type: AddendumChangeType;
  count_delta: number; // magnitude; sign comes from change_type
  new_rate: number | null;
  effective_from: string;
  source: AddendumSource;
  reference: string | null;
  drive_file_id: string | null;
  drive_view_url: string | null;
  reference_file_name: string | null;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
};

// Signed headcount delta an addendum applies (0 for a pure rate change).
export function addendumHeadcountDelta(a: Pick<ContractAddendum, "change_type" | "count_delta">): number {
  const mag = Math.abs(Number(a.count_delta) || 0);
  if (a.change_type === "ADD_HEADCOUNT") return mag;
  if (a.change_type === "REDUCE_HEADCOUNT") return -mag;
  return 0;
}

// The category an addendum affects: its line's category, or its own for new lines.
function addendumCategory(
  a: ContractAddendum,
  lineCategoryById: Map<string, ContractLineCategory>,
): ContractLineCategory | null {
  if (a.contract_line_id) return lineCategoryById.get(a.contract_line_id) ?? a.category ?? null;
  return a.category ?? null;
}

/**
 * Effective committed count per category on a given date:
 *   base committed_count (from lines) + Σ addendum deltas with effective_from <= date.
 * Never negative.
 */
export function effectiveCommittedByCategory(
  lines: ContractLine[],
  addendums: ContractAddendum[],
  onDate: string,
): Map<ContractLineCategory, number> {
  const result = new Map<ContractLineCategory, number>();
  const lineCategoryById = new Map<string, ContractLineCategory>();
  for (const l of lines) {
    lineCategoryById.set(l.id, l.category);
    result.set(l.category, (result.get(l.category) ?? 0) + (Number(l.committed_count) || 0));
  }
  for (const a of addendums) {
    if (a.effective_from > onDate) continue;
    const cat = addendumCategory(a, lineCategoryById);
    if (!cat) continue;
    result.set(cat, (result.get(cat) ?? 0) + addendumHeadcountDelta(a));
  }
  for (const [cat, n] of result) result.set(cat, Math.max(0, n));
  return result;
}

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

export type RegionKind = "regional" | "head_office";

export type Branch = {
  id: string;
  company_id?: string;
  name: string;
  is_head_office: boolean;
  /** Stable handle for the region (HO, ISB-RWP, LHR). Unique per company. */
  code: string | null;
  /** Generated from is_head_office in the DB — never write it. */
  kind: RegionKind;
  active: boolean;
  created_at?: string;
  updated_at?: string;
};

// A branch IS a region (migration 0074 promoted the table in place rather than
// adding a second concept to keep in sync). `Region` is the name the region
// model uses; both refer to the same rows.
export type Region = Branch;

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
  // Phase 4: contract-line assignment (which category slot this employee fills)
  contract_line_id: string | null;
  assignment_effective_from: string | null;
  assignment_effective_to: string | null;
  // §11 Employee Data Form — full paper-form capture (migration 0088).
  // Header
  interview_date: string | null;
  form_serial_no: string | null;
  photo_url: string | null;
  // Personal (extended)
  cnic_expiry: string | null;
  education: string | null;
  marital_status: MaritalStatus | null;
  height_cm: number | null;
  weight_kg: number | null;
  build: string | null;
  uniform_size: string | null;
  shoe_size: string | null;
  special_skills: string | null;
  // Second emergency contact (the first lives in emergency_contact_*)
  emergency_contact2_name: string | null;
  emergency_contact2_relation: string | null;
  emergency_contact2_phone: string | null;
  // Political / locality
  post_office: string | null;
  police_station: string | null;
  area_nazim: string | null;
  union_council: string | null;
  // Family
  spouse_name: string | null;
  next_of_kin_name: string | null;
  next_of_kin_relation: string | null;
  next_of_kin_cnic: string | null;
  next_of_kin_contact: string | null;
  // Ex-service
  is_ex_serviceman: boolean;
  army_number: string | null;
  service_unit: string | null;
  service_rank: string | null;
  service_trade: string | null;
  service_join_date: string | null;
  service_discharge_date: string | null;
  discharging_officer: string | null;
  // Experience
  weapons_trained: string | null;
  // Internal office data
  designation: string | null;
  project: string | null;
  company_id_card_number: string | null;
  social_security_status: SocialSecurityStatus | null;
  social_security_number: string | null;
  insurance_provider: string | null;
  insurance_number: string | null;
  remarks: string | null;
  form_signed_on: string | null;
  // §11 identity lock (migration 0089)
  identity_verified: boolean;
  identity_verified_at: string | null;
  identity_verified_by: string | null;
  // §12 lifecycle state machine (migration 0082)
  lifecycle_state: EmployeeLifecycleState;
  rehire_count: number;
  eligible_for_rehire: boolean | null;
  exit_reason: string | null;
  exit_date: string | null;
  blacklisted: boolean;
  blacklist_reason: string | null;
  physical_copy_present: boolean;
  referral_source: string | null;
  referred_by_employee_id: string | null;
  referred_by_name: string | null;
  pending_termination_review: boolean;
  // §12 vetting + competence (migration 0083)
  police_verification_status: VettingStatus;
  police_verification_date: string | null;
  nadra_verisys_status: VettingStatus;
  nadra_verisys_date: string | null;
  orientation_done: boolean;
  orientation_date: string | null;
  weapons_certified: boolean;
  weapons_cert_expiry: string | null;
  refresher_due_date: string | null;
  created_at?: string;
  updated_at?: string;
};

export type EmployeeLifecycleState =
  | "applicant"
  | "waitlisted"
  | "active"
  | "on_leave"
  | "left"
  | "terminated";

export const LIFECYCLE_STATE_LABEL: Record<EmployeeLifecycleState, string> = {
  applicant: "Applicant",
  waitlisted: "Waiting list",
  active: "Active",
  on_leave: "On leave",
  left: "Left",
  terminated: "Fired",
};

// Allowed transitions, mirrored from lifecycle_transition_allowed (migration 0082).
export const LIFECYCLE_TRANSITIONS: Record<EmployeeLifecycleState, EmployeeLifecycleState[]> = {
  applicant: ["waitlisted", "active", "left"],
  waitlisted: ["active", "left"],
  active: ["on_leave", "left", "terminated"],
  on_leave: ["active", "left", "terminated"],
  left: ["active"],
  terminated: ["active"],
};

export type VettingStatus = "pending" | "cleared" | "adverse";
export type TrainingKind =
  | "orientation"
  | "weapons_certification"
  | "weapons_refresher"
  | "refresher"
  | "other";

export const TRAINING_KIND_LABEL: Record<TrainingKind, string> = {
  orientation: "Orientation",
  weapons_certification: "Weapons certification",
  weapons_refresher: "Weapons refresher",
  refresher: "Refresher",
  other: "Other",
};

export type EmployeeTrainingRecord = {
  id: string;
  company_id?: string;
  employee_id: string;
  kind: TrainingKind;
  completed_on: string;
  expires_on: string | null;
  provider: string | null;
  notes: string | null;
  created_at?: string;
};

export type DisciplinaryWarning = {
  id: string;
  company_id?: string;
  employee_id: string;
  warning_number: number;
  issued_on: string;
  reason: string;
  issued_by: string | null;
  rescinded: boolean;
  rescinded_reason: string | null;
  created_at?: string;
};

export type ClearanceCertificate = {
  id: string;
  company_id?: string;
  employee_id: string;
  initiated_on: string;
  status: "pending" | "cleared" | "blocked";
  kit_returned: boolean | null;
  outstanding_kit_count: number | null;
  advance_settled: boolean | null;
  outstanding_advance: number | null;
  incidents_reviewed: boolean | null;
  open_incident_count: number | null;
  undisbursed_salary: number | null;
  dues_released: boolean;
  dues_released_on: string | null;
  notes: string | null;
};

export type ServiceHistoryRow = {
  employee_id: string;
  company_id: string;
  kind: string;
  event_at: string;
  title: string;
  detail: string | null;
};

export type MaritalStatus = "single" | "married" | "divorced" | "widowed";
export type SocialSecurityStatus = "registered" | "not_registered" | "exempt";
export type ReferenceType = "uc_gazetted" | "blood_relation";
export type ChecklistDocType =
  | "police_verification"
  | "medical_certificate"
  | "halaf_nama"
  | "photographs"
  | "education_certificate"
  | "discharge_certificate"
  | "pension_book"
  | "id_copies"
  | "biometrics"
  | "utility_bill";

export const CHECKLIST_DOC_LABEL: Record<ChecklistDocType, string> = {
  police_verification: "Police verification",
  medical_certificate: "Medical certificate",
  halaf_nama: "Halaf nama (affidavit)",
  photographs: "Photographs",
  education_certificate: "Education certificate",
  discharge_certificate: "Discharge certificate",
  pension_book: "Pension book",
  id_copies: "ID copies",
  biometrics: "Biometrics",
  utility_bill: "Utility bill",
};

// §11 repeating sections (migration 0088)
export type EmployeeChild = {
  id: string;
  company_id?: string;
  employee_id: string;
  name: string;
  date_of_birth: string | null;
  gender: string | null;
  notes: string | null;
  created_at?: string;
};

export type EmployeeReference = {
  id: string;
  company_id?: string;
  employee_id: string;
  reference_type: ReferenceType;
  name: string;
  cnic: string | null;
  address: string | null;
  contact: string | null;
  id_copy_document_id: string | null;
  notes: string | null;
  created_at?: string;
};

export type EmployeePreviousJob = {
  id: string;
  company_id?: string;
  employee_id: string;
  seq: number;
  employer: string | null;
  designation: string | null;
  from_date: string | null;
  to_date: string | null;
  reason_for_leaving: string | null;
  created_at?: string;
};

export type EmployeeDocumentChecklistItem = {
  id: string;
  company_id?: string;
  employee_id: string;
  doc_type: ChecklistDocType;
  received: boolean;
  document_id: string | null;
  verified_by: string | null;
  verified_at: string | null;
  notes: string | null;
};

// §11 identity amendment log row (view employee_identity_amendments)
export type EmployeeIdentityAmendment = {
  employee_id: string;
  company_id: string;
  changed_at: string;
  changed_by: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
};

// Phase 4: an employee consumes a slot on a line only while Active AND within
// its assignment window. Inactive/On-Leave/ended assignments free the slot.
export function assignmentActiveOn(
  emp: Pick<Employee, "status" | "assignment_effective_from" | "assignment_effective_to">,
  onDate: string,
): boolean {
  if (emp.status !== "Active") return false;
  if (emp.assignment_effective_from && emp.assignment_effective_from > onDate) return false;
  if (emp.assignment_effective_to && emp.assignment_effective_to < onDate) return false;
  return true;
}

// Count active assignments per contract_line on a date.
export function activeCountByLine(
  employees: Pick<Employee, "status" | "contract_line_id" | "assignment_effective_from" | "assignment_effective_to">[],
  onDate: string,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of employees) {
    if (!e.contract_line_id) continue;
    if (!assignmentActiveOn(e, onDate)) continue;
    m.set(e.contract_line_id, (m.get(e.contract_line_id) ?? 0) + 1);
  }
  return m;
}

// Active assignments tallied by CATEGORY, given a line→category lookup. Slot
// validation is per-category (all lines of a category share the committed pool).
export function activeCountByCategory(
  employees: Pick<Employee, "status" | "contract_line_id" | "assignment_effective_from" | "assignment_effective_to">[],
  lineCategoryById: Map<string, ContractLineCategory>,
  onDate: string,
): Map<ContractLineCategory, number> {
  const m = new Map<ContractLineCategory, number>();
  for (const e of employees) {
    if (!e.contract_line_id) continue;
    if (!assignmentActiveOn(e, onDate)) continue;
    const cat = lineCategoryById.get(e.contract_line_id);
    if (!cat) continue;
    m.set(cat, (m.get(cat) ?? 0) + 1);
  }
  return m;
}

/**
 * Leave allowance and EOBI now live on the CONTRACT. The matching client columns are
 * no longer editable (the Contract Defaults section was removed from the Client modal)
 * and survive only as a fallback for records predating the move — which is what the
 * contract form's "Inherits client default if blank" placeholder has always promised.
 * A contract value of null therefore means "inherit", not "zero".
 */
export function resolveAllowedLeaves(
  contract: Pick<Contract, "allowed_leaves_per_month"> | null | undefined,
  client: Pick<Client, "allowed_leaves_per_month"> | null | undefined,
): number {
  if (contract?.allowed_leaves_per_month != null) return Number(contract.allowed_leaves_per_month);
  return Number(client?.allowed_leaves_per_month ?? 0);
}

// EOBI withheld per employee per month. A contract only overrides when it both enables
// the deduction and names an amount; otherwise the client fallback stands.
export function resolveEobiAmount(
  contract: Pick<Contract, "eobi_deduction" | "eobi_amount"> | null | undefined,
  client: Pick<Client, "eobi_enabled" | "eobi_amount"> | null | undefined,
): number {
  if (contract?.eobi_deduction && contract.eobi_amount != null) return Number(contract.eobi_amount);
  return client?.eobi_enabled ? Number(client.eobi_amount ?? 0) : 0;
}

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

export type InvoiceStatus = "Pending" | "Delivered" | "Unpaid" | "Partly-Paid" | "Paid";

export type Invoice = {
  id: string;
  client_id: string;
  // Which contract this invoice bills (0109). Null on legacy/unlinked invoices
  // and on multi-contract clients that weren't auto-backfilled. Enforces the
  // "one invoice per contract per month" rule together with period_start.
  contract_id?: string | null;
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
  // Phase 6 generation fields (null on legacy ad-hoc invoices)
  period_start?: string | null;
  period_end?: string | null;
  subtotal?: number;
  tax_added_total?: number;
  tax_withheld_total?: number;
  previous_balance?: number;
  total_due?: number;
  amount_in_words?: string | null;
  remit_account?: RemitAccount | null;
  override_reason?: string | null;
  financial_year?: string | null;
  invoice_group?: ClientInvoiceGroup | null;
  generated?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type InvoiceLine = {
  id?: string;
  company_id?: string;
  invoice_id?: string;
  category: ContractLineCategory | null;
  label: string;
  quantity: number;
  unit_rate: number;
  amount: number;
  taxable: boolean;
  sort_order?: number;
};

export type InvoiceTax = {
  id?: string;
  company_id?: string;
  invoice_id?: string;
  name: string;
  rate: number;
  base: TaxBase;
  direction: TaxDirection;
  component?: string | null;
  amount: number;
  sort_order?: number;
};

// Compute each tax's amount from a subtotal per its base/direction, in order.
//  - WHOLE_INVOICE / SPECIFIC_COMPONENT: rate% of the subtotal.
//  - COMPOUND: rate% of (subtotal + running total of ADDED taxes so far).
// ADDED taxes increase the total; WITHHELD taxes reduce Total Due.
export function computeInvoiceTaxes(
  subtotal: number,
  taxes: Omit<InvoiceTax, "amount">[],
): { computed: InvoiceTax[]; addedTotal: number; withheldTotal: number } {
  let addedSoFar = 0;
  let addedTotal = 0;
  let withheldTotal = 0;
  const computed: InvoiceTax[] = taxes.map((t) => {
    const base = t.base === "COMPOUND" ? subtotal + addedSoFar : subtotal;
    const amount = Math.round(base * (Number(t.rate) || 0)) / 100;
    if (t.direction === "ADDED") {
      addedSoFar += amount;
      addedTotal += amount;
    } else {
      withheldTotal += amount;
    }
    return { ...t, amount };
  });
  return { computed, addedTotal, withheldTotal };
}

// Outstanding on a posted invoice = current-period net still owed.
export function invoiceOutstanding(inv: Pick<Invoice, "invoice_amount" | "withholding_tax" | "amount_received">): number {
  return Number(inv.invoice_amount ?? 0) - Number(inv.withholding_tax ?? 0) - Number(inv.amount_received ?? 0);
}

// A client's carried previous balance = Σ outstanding of prior Unpaid/Partly-Paid invoices.
export function clientPreviousBalance(invoices: Invoice[], clientId: string, beforeDate: string): number {
  return invoices
    .filter(
      (i) =>
        i.client_id === clientId &&
        (i.status === "Unpaid" || i.status === "Partly-Paid") &&
        i.invoice_date < beforeDate,
    )
    .reduce((sum, i) => sum + invoiceOutstanding(i), 0);
}

// Pakistani financial year label (Jul–Jun): "FY 2025-26" for a July 2025 date.
export function financialYearLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-based; FY starts July (month 6)
  const startYear = m >= 6 ? y : y - 1;
  const endYear = (startYear + 1) % 100;
  return `FY ${startYear}-${String(endYear).padStart(2, "0")}`;
}

// Amount in words, Pakistani numbering (crore/lakh/thousand), Rupees + Paisa.
export function amountInWords(amount: number): string {
  const n = Math.floor(Math.abs(amount));
  const paisa = Math.round((Math.abs(amount) - n) * 100);
  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
  ];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const twoDigits = (x: number): string => {
    if (x < 20) return ones[x];
    return `${tens[Math.floor(x / 10)]}${x % 10 ? " " + ones[x % 10] : ""}`;
  };
  const threeDigits = (x: number): string => {
    const h = Math.floor(x / 100);
    const r = x % 100;
    return `${h ? ones[h] + " Hundred" + (r ? " " : "") : ""}${r ? twoDigits(r) : ""}`;
  };
  const words = (x: number): string => {
    if (x === 0) return "Zero";
    const crore = Math.floor(x / 10000000);
    const lakh = Math.floor((x % 10000000) / 100000);
    const thousand = Math.floor((x % 100000) / 1000);
    const rest = x % 1000;
    const parts: string[] = [];
    if (crore) parts.push(`${words(crore)} Crore`);
    if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
    if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
    if (rest) parts.push(threeDigits(rest));
    return parts.join(" ").trim();
  };
  const rupeeWords = words(n);
  const paisaWords = paisa > 0 ? ` and ${twoDigits(paisa)} Paisa` : "";
  return `Rupees ${rupeeWords}${paisaWords} Only`;
}

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
