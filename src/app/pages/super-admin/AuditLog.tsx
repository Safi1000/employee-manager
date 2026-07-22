import ThemedSelect from "../../components/ThemedSelect";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  AlertCircle,
  X,
  Search,
  ChevronDown,
  ChevronRight,
  Plus,
  Pencil,
  Trash2,
  Filter,
  RefreshCw,
  ShieldOff,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { formatDateTime } from "../../lib/date";
import { useAuth } from "../../lib/auth";
import {
  supabase,
  AUDITED_TABLES,
  type AuditLogEntry,
  type AuditAction,
  type AuditedTable,
  type AuditChanges,
} from "../../lib/supabase";

const PAGE_SIZE = 50;

const FIELD_LABELS: Record<string, string> = {
  // Common
  branch_id: "Branch", created_at: "Created", updated_at: "Updated",
  // Employees
  full_name: "Full Name", employee_code: "Employee Code", phone: "Phone",
  status: "Status", shift: "Shift", base_salary: "Base Salary",
  per_day_salary: "Per Day Salary", allowance: "Allowance", join_date: "Join Date",
  category: "Category", client_id: "Client", contract_id: "Contract",
  location_id: "Location", department: "Department", cnic_number: "CNIC",
  bank_name: "Bank Name", bank_account: "Bank Account", iban: "IBAN",
  date_of_birth: "Date of Birth", blood_group: "Blood Group",
  permanent_address: "Permanent Address", current_address: "Current Address",
  emergency_contact_name: "Emergency Contact", emergency_contact_relation: "Emergency Relation",
  emergency_contact_phone: "Emergency Phone", father_or_husband_name: "Father / Husband",
  reporting_to_employee_id: "Reports To", employee_contract_type: "Employment Type",
  probation_end_date: "Probation End", opening_leaves: "Opening Leave Balance",
  weapon_licence_number: "Weapon Licence #", weapon_licence_expiry: "Weapon Licence Expiry",
  guard_service_licence_number: "Guard Service Licence #", guard_service_licence_expiry: "Guard Service Licence Expiry",
  medical_fitness_expiry: "Medical Fitness Expiry", eobi_registration_number: "EOBI Registration #",
  // Clients
  name: "Name", email: "Email", client_code: "Client Code", client_type: "Client Type",
  allowed_leaves_per_month: "Allowed Leaves / Month", leave_carry_forward: "Leave Carry Forward",
  eobi_enabled: "EOBI Enabled", eobi_amount: "EOBI Amount",
  auto_invoice_enabled: "Auto Invoice", auto_invoice_amount: "Auto Invoice Amount",
  auto_invoice_withholding: "Auto Withholding", contract_start: "Contract Start",
  contract_end: "Contract End", advance_payment: "Advance Payment", opening_balance: "Opening Balance",
  // Contracts
  contract_code: "Contract Code", contract_type: "Contract Type",
  start_date: "Start Date", end_date: "End Date",
  number_of_guards: "Total Guards", day_guards: "Day Guards",
  night_guards: "Night Guards", evening_guards: "Evening Guards",
  rate_per_guard_per_month: "Rate / Guard / Month", eobi_deduction: "EOBI Deduction",
  annual_escalation_pct: "Annual Escalation %", renewal_terms: "Renewal Terms",
  guard_rates: "Guard Rates",
  // Invoices
  invoice_number: "Invoice #", invoice_date: "Invoice Date", due_date: "Due Date",
  invoice_amount: "Invoice Amount", withholding_tax: "Withholding Tax",
  amount_received: "Amount Received", period_from: "Period From", period_to: "Period To",
  // Payments & Expenses
  payment_date: "Payment Date", payment_mode: "Payment Mode", bank_account_id: "Bank Account",
  description: "Description", expense_date: "Expense Date", category_id: "Category",
  vendor_id: "Vendor", payable_status: "Payable Status",
  // Payslips
  period_month: "Payroll Month", present_days: "Days Present", absent_days: "Days Absent",
  leave_days: "Leave Days", final_salary: "Final Salary", net_salary: "Net Salary",
  bonus: "Bonus", deductions: "Deductions", income_tax: "Income Tax", eobi: "EOBI",
  advance: "Advance", disbursed: "Disbursed", disbursed_at: "Disbursed At",
  working_days: "Working Days", override_leaves: "Override Leaves",
  effective_present_days: "Effective Present Days", effective_absent_days: "Effective Absent Days",
  // Advances
  advance_date: "Advance Date", repaid: "Repaid", employee_id: "Employee",
  // Cheques
  cheque_number: "Cheque #", cheque_type: "Cheque Type", cheque_date: "Cheque Date",
  cleared_at: "Cleared At", recipient: "Recipient", direction: "Direction",
  // Bank Accounts
  account_number: "Account #", account_type: "Account Type", balance: "Balance",
  owner_type: "Owner Type", active: "Active",
  // Bank Transactions
  kind: "Transaction Type", cash_delta: "Cash Change", account_delta: "Account Change",
  reference_id: "Reference",
  // Roster
  assignment_date: "Assignment Date", is_present: "Present", is_late: "Late",
  // General
  amount: "Amount", invoice_id: "Invoice", notes: "Notes", title: "Title",
  code: "Code", role: "Role", type: "Type", severity: "Severity",
};

const SKIP_FIELDS = new Set(["id", "company_id", "created_at", "updated_at", "drive_file_id", "drive_view_url", "attachment_path", "receipt_path", "storage_path"]);

const CURRENCY_FIELDS = new Set([
  "base_salary", "per_day_salary", "allowance", "amount", "net_salary", "final_salary",
  "rate_per_guard_per_month", "invoice_amount", "withholding_tax", "amount_received",
  "opening_balance", "advance", "bonus", "deductions", "eobi", "income_tax",
  "eobi_amount", "auto_invoice_amount", "balance", "cash_delta", "account_delta",
  "advance_payment",
]);

const ENUM_LABELS: Record<string, string> = {
  services: "Services", guard_deployment: "Guard Deployment",
  day: "Day", night: "Night", evening: "Evening",
  Active: "Active", Inactive: "Inactive",
  active: "Active", expired: "Expired", terminated: "Terminated", draft: "Draft",
  pending: "Pending", cleared: "Cleared",
  Paid: "Paid", Unpaid: "Unpaid",
  Cash: "Cash", Bank: "Bank", Cheque: "Cheque",
  client: "Client", branch: "Branch",
  outgoing: "Outgoing", incoming: "Incoming",
  payment: "Payment", cash: "Cash",
  company: "Company", partner: "Partner",
  Current: "Current", Savings: "Savings",
  opening: "Opening Balance", deposit: "Deposit",
  withdraw_to_cash: "Withdraw to Cash", payroll: "Payroll",
  reconcile: "Reconcile", adjustment: "Adjustment", cash_adjustment: "Cash Adjustment",
  expense: "Expense", receipt: "Receipt", transfer: "Transfer", cheque: "Cheque",
};

const isISODate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isISODatetime = (s: string) => /^\d{4}-\d{2}-\d{2}T/.test(s);
const isUUID = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const fieldLabel = (field: string): string =>
  FIELD_LABELS[field] ?? field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const formatFieldValue = (field: string, value: unknown): string => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") {
    if (isISODatetime(value)) {
      try { return new Date(value).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return value; }
    }
    if (isISODate(value)) {
      try { return new Date(value + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); } catch { return value; }
    }
    if (isUUID(value)) return `(ID: ${value.slice(0, 8)}…)`;
    if (ENUM_LABELS[value] !== undefined) return ENUM_LABELS[value];
    return value;
  }
  if (typeof value === "number") {
    if (CURRENCY_FIELDS.has(field)) return `PKR ${value.toLocaleString()}`;
    return String(value);
  }
  if (typeof value === "object") {
    const s = JSON.stringify(value, null, 2);
    return s.length > 400 ? s.slice(0, 400) + "…" : s;
  }
  return String(value);
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const ACTION_COLOUR: Record<AuditAction, string> = {
  insert: "bg-success-50 text-success-700 border-success-200",
  update: "bg-brand-50 text-brand-700 border-brand-200",
  delete: "bg-danger-50 text-danger-700 border-danger-200",
};

const ACTION_ICON: Record<AuditAction, React.ComponentType<{ className?: string }>> = {
  insert: Plus,
  update: Pencil,
  delete: Trash2,
};

const TABLE_LABEL: Record<string, string> = {
  employees: "Employees",
  clients: "Clients",
  contracts: "Contracts",
  invoices: "Invoices",
  invoice_payments: "Invoice Payments",
  expenses: "Expenses",
  payslips: "Payslips",
  advances: "Advances",
  cheques: "Cheques",
  bank_accounts: "Bank Accounts",
  bank_transactions: "Bank Transactions",
  branches: "Branches",
  profiles: "Users",
  chart_of_accounts: "Chart of Accounts",
  accounting_periods: "Period Close",
  posts: "Posts",
  incidents: "Incidents",
  roster_assignments: "Roster",
};

type ProfileLite = { id: string; full_name: string | null; email: string | null };

export default function AuditLog() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "super_super_admin" || profile?.role === "super_admin";

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [profiles, setProfiles] = useState<Map<string, ProfileLite>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [from, setFrom] = useState<string>(daysAgoISO(30));
  const [to, setTo] = useState<string>(todayISO());
  const [tableFilter, setTableFilter] = useState<"all" | AuditedTable>("all");
  const [actionFilter, setActionFilter] = useState<"all" | AuditAction>("all");
  const [userFilter, setUserFilter] = useState<string>("all");
  const [recordIdSearch, setRecordIdSearch] = useState("");
  const [fieldSearch, setFieldSearch] = useState("");
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadProfiles = async () => {
    const { data } = await supabase.from("profiles").select("id, full_name, email");
    const m = new Map<string, ProfileLite>();
    for (const p of (data ?? []) as ProfileLite[]) m.set(p.id, p);
    setProfiles(m);
  };

  const loadEntries = async () => {
    setLoading(true);
    setError(null);
    let q = supabase
      .from("audit_log")
      .select("*")
      .gte("changed_at", from + "T00:00:00Z")
      .lte("changed_at", to + "T23:59:59Z")
      .order("changed_at", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

    if (tableFilter !== "all") q = q.eq("table_name", tableFilter);
    if (actionFilter !== "all") q = q.eq("action", actionFilter);
    if (userFilter !== "all") q = q.eq("changed_by", userFilter);
    if (recordIdSearch.trim()) q = q.eq("record_id", recordIdSearch.trim());

    const { data, error: eErr } = await q;
    if (eErr) {
      setError(eErr.message);
      setLoading(false);
      return;
    }
    const rows = (data ?? []) as AuditLogEntry[];
    setHasMore(rows.length > PAGE_SIZE);
    setEntries(rows.slice(0, PAGE_SIZE));
    setLoading(false);
  };

  useEffect(() => {
    loadProfiles();
  }, []);

  useEffect(() => {
    loadEntries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, tableFilter, actionFilter, userFilter, recordIdSearch, page]);

  // Reset page when filters change.
  useEffect(() => {
    setPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, tableFilter, actionFilter, userFilter, recordIdSearch]);

  const filteredEntries = useMemo(() => {
    if (!fieldSearch.trim()) return entries;
    const q = fieldSearch.trim().toLowerCase();
    return entries.filter((e) => {
      for (const [k, v] of Object.entries(e.changes)) {
        if (k.toLowerCase().includes(q)) return true;
        if (v.before != null && String(v.before).toLowerCase().includes(q)) return true;
        if (v.after != null && String(v.after).toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [entries, fieldSearch]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const userName = (uid: string | null): string => {
    if (!uid) return "(system)";
    const p = profiles.get(uid);
    return p?.full_name ?? p?.email ?? uid.slice(0, 8);
  };

  const userList = useMemo(() => {
    return Array.from(profiles.values())
      .filter((p) => !!p.full_name || !!p.email)
      .sort((a, b) => (a.full_name ?? a.email ?? "").localeCompare(b.full_name ?? b.email ?? ""));
  }, [profiles]);

  const summary = (changes: AuditChanges): string => {
    const displayFields = Object.keys(changes)
      .filter((f) => !SKIP_FIELDS.has(f))
      .map(fieldLabel);
    if (displayFields.length === 0) return Object.keys(changes).map(fieldLabel).join(", ") || "—";
    if (displayFields.length <= 3) return displayFields.join(", ");
    return `${displayFields.slice(0, 3).join(", ")} +${displayFields.length - 3} more`;
  };

  if (!isAdmin) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-500">
        <ShieldOff className="w-10 h-10 text-slate-300" strokeWidth={1.5} />
        <p className="text-sm">Audit Log is restricted to Super Admin and above.</p>
      </div>
    );
  }

  return (
    <>
      <Header
        title="Audit Log"
        subtitle="Every change to every financial and operational record — who, when, what, before, after"
        actions={
          <Button variant="secondary" size="md" onClick={() => loadEntries()}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        {/* Filters */}
        <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <Filter className="w-4 h-4" />
            <span className="font-medium">Filters</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs text-slate-600 mb-1">From</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">To</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Table</label>
              <ThemedSelect
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value as "all" | AuditedTable)}
                className="w-full px-3 py-2 border border-slate-200 rounded text-sm"
              >
                <option value="all">All tables</option>
                {AUDITED_TABLES.map((t) => (
                  <option key={t} value={t}>{TABLE_LABEL[t] ?? t}</option>
                ))}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Action</label>
              <ThemedSelect
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value as "all" | AuditAction)}
                className="w-full px-3 py-2 border border-slate-200 rounded text-sm"
              >
                <option value="all">All actions</option>
                <option value="insert">Insert</option>
                <option value="update">Update</option>
                <option value="delete">Delete</option>
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">User</label>
              <ThemedSelect
                value={userFilter}
                onChange={(e) => setUserFilter(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded text-sm"
              >
                <option value="all">Anyone</option>
                {userList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name ?? p.email}
                  </option>
                ))}
              </ThemedSelect>
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-slate-600 mb-1">Record ID</label>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={recordIdSearch}
                  onChange={(e) => setRecordIdSearch(e.target.value)}
                  placeholder="Paste a UUID to trace one record's full history"
                  className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded text-sm font-mono"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Field / value search</label>
              <input
                type="text"
                value={fieldSearch}
                onChange={(e) => setFieldSearch(e.target.value)}
                placeholder="e.g., final_salary, 50000…"
                className="w-full px-3 py-2 border border-slate-200 rounded text-sm"
              />
              <p className="text-[10px] text-slate-500 mt-1">Filters loaded page; refine other filters first.</p>
            </div>
          </div>
        </div>

        {/* Entry list */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="w-8 px-2 py-3"></th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">When</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">User</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Action</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Table</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Record</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Fields changed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filteredEntries.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500 text-sm">
                      No audit entries match the current filters.
                    </td>
                  </tr>
                )}
                {!loading && filteredEntries.map((e) => {
                  const isOpen = expanded.has(e.id);
                  const ActionIcon = ACTION_ICON[e.action];
                  return (
                    <Fragment key={e.id}>
                      <tr
                        className="hover:bg-slate-50 cursor-pointer"
                        onClick={() => toggleExpanded(e.id)}
                      >
                        <td className="w-8 px-2 py-3 text-center">
                          {isOpen ? <ChevronDown className="w-4 h-4 text-slate-400 inline" /> : <ChevronRight className="w-4 h-4 text-slate-400 inline" />}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-700 whitespace-nowrap">
                          {formatDateTime(e.changed_at)}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-900 whitespace-nowrap">
                          {userName(e.changed_by)}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border ${ACTION_COLOUR[e.action]}`}>
                            <ActionIcon className="w-3 h-3" />
                            {e.action}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-700">
                          {TABLE_LABEL[e.table_name] ?? e.table_name}
                        </td>
                        <td className="px-4 py-3 text-xs font-mono text-slate-500 max-w-[180px] truncate">
                          {e.record_id ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-700">{summary(e.changes)}</td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-slate-50/60">
                          <td colSpan={7} className="px-4 py-3">
                            <ChangesDiff changes={e.changes} action={e.action} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between p-3 border-t border-slate-200 text-sm">
            <div className="text-xs text-slate-500">
              Page {page + 1} · {filteredEntries.length} entr{filteredEntries.length === 1 ? "y" : "ies"} on this page
              {fieldSearch && entries.length !== filteredEntries.length && (
                <span className="ml-1">(of {entries.length} loaded — narrow filters for more)</span>
              )}
            </div>
            <div className="flex gap-1">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="px-3 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                disabled={!hasMore}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 text-xs border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ChangesDiff({ changes, action }: { changes: AuditChanges; action: AuditAction }) {
  const allEntries = Object.entries(changes);
  const visibleEntries = allEntries.filter(([f]) => !SKIP_FIELDS.has(f));
  const hiddenCount = allEntries.length - visibleEntries.length;
  const entries = visibleEntries.length > 0 ? visibleEntries : allEntries;

  if (entries.length === 0) {
    return <div className="text-xs text-slate-500 italic">No field-level changes recorded.</div>;
  }
  return (
    <div className="rounded-md border border-slate-200 overflow-hidden">
      <div className="grid grid-cols-12 gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wide text-slate-400 bg-slate-100 border-b border-slate-200">
        <div className="col-span-3">Field</div>
        {action !== "insert" && <div className="col-span-4">Before</div>}
        {action !== "delete" && <div className={action === "insert" ? "col-span-9" : "col-span-5"}>After</div>}
      </div>
      {entries.map(([field, v]) => (
        <div key={field} className="grid grid-cols-12 gap-2 px-3 py-2 text-xs items-start border-b border-slate-100 last:border-b-0 hover:bg-white">
          <div className="col-span-3 text-slate-800 font-medium leading-5">
            {fieldLabel(field)}
            <div className="text-[10px] text-slate-400 font-mono font-normal">{field}</div>
          </div>
          {action !== "insert" && (
            <div className="col-span-4">
              <ValueCell value={v.before} field={field} variant="before" />
            </div>
          )}
          {action !== "delete" && (
            <div className={action === "insert" ? "col-span-9" : "col-span-5"}>
              <ValueCell value={v.after} field={field} variant="after" />
            </div>
          )}
        </div>
      ))}
      {hiddenCount > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-slate-400 bg-slate-50 border-t border-slate-100">
          {hiddenCount} system field{hiddenCount > 1 ? "s" : ""} hidden (IDs, timestamps)
        </div>
      )}
    </div>
  );
}

function ValueCell({ value, field, variant }: { value: unknown; field: string; variant: "before" | "after" }) {
  if (value === undefined || value === null) {
    return <span className="text-slate-400 italic text-[11px]">—</span>;
  }
  const display = formatFieldValue(field, value);
  const isLong = display.length > 120;
  const isJson = typeof value === "object";
  const styleBase = variant === "before"
    ? "text-danger-700 bg-danger-50 border border-danger-100"
    : "text-success-800 bg-success-50 border border-success-100";

  if (isJson || isLong) {
    return (
      <pre className={`px-2 py-1 rounded text-[11px] break-all whitespace-pre-wrap max-h-32 overflow-y-auto ${styleBase}`}>
        {display}
      </pre>
    );
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[11px] break-all ${styleBase}`}>
      {display}
    </span>
  );
}
