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
import { Link } from "react-router";
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
import { usePageState } from "../../lib/pageState";

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

/** Audited tables whose rows Reversals can undo (ReversalDialog's kinds). */
const REVERSIBLE_TABLES = new Set([
  "payslips", "advances", "payroll_adjustments", "invoice_payments", "invoices", "expenses",
  "payable_payments", "bank_transfers", "custody_transfers", "cash_deposits", "cheques",
  "partner_account_entries", "journal_entries", "inventory_purchases", "kit_events",
  "fixed_assets", "depreciation_entries", "expense_requests", "employees",
]);

export default function AuditLog() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "super_super_admin" || profile?.role === "super_admin";

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [profiles, setProfiles] = useState<Map<string, ProfileLite>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [from, setFrom] = usePageState<string>("AuditLog.from", daysAgoISO(30));
  const [to, setTo] = usePageState<string>("AuditLog.to", todayISO());
  const [tableFilter, setTableFilter] = usePageState<"all" | AuditedTable>("AuditLog.tableFilter", "all");
  const [actionFilter, setActionFilter] = usePageState<"all" | AuditAction>("AuditLog.actionFilter", "all");
  const [userFilter, setUserFilter] = usePageState<string>("AuditLog.userFilter", "all");
  const [recordIdSearch, setRecordIdSearch] = usePageState("AuditLog.recordIdSearch", "");
  const [fieldSearch, setFieldSearch] = usePageState("AuditLog.fieldSearch", "");
  const [page, setPage] = usePageState("AuditLog.page", 0);
  const [hasMore, setHasMore] = useState(false);

  const [expanded, setExpanded] = usePageState<Set<string>>("AuditLog.expanded", new Set());

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
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <ShieldOff className="w-10 h-10 text-muted-foreground/50" strokeWidth={1.5} />
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
      >
        {entries.length > 0 && (() => {
          // Band (2026-10-20): who changed what, in what is loaded — the
          // busiest records and people, and inserts/updates/deletes. Each
          // record type is a filter.
          const byTable = new Map<string, number>(), byUser = new Map<string, number>();
          const byAction = { insert: 0, update: 0, delete: 0 } as Record<string, number>;
          for (const e of entries) {
            byTable.set(e.table_name, (byTable.get(e.table_name) ?? 0) + 1);
            byUser.set(e.changed_by ?? "", (byUser.get(e.changed_by ?? "") ?? 0) + 1);
            byAction[e.action] = (byAction[e.action] ?? 0) + 1;
          }
          const topT = [...byTable.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
          const topU = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
          const label = (t: string) => ((TABLE_LABEL as Record<string, string> | null)?.[t] ?? t.replace(/_/g, " "));
          return (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-2.5">
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-2">
                <span className="lbl">{entries.length.toLocaleString()} changes loaded</span>
                <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
                  <span className="h-full bg-up" style={{ width: `${(byAction.insert / entries.length) * 100}%` }} title={`${byAction.insert} created`} />
                  <span className="h-full bg-brand-500" style={{ width: `${(byAction.update / entries.length) * 100}%` }} title={`${byAction.update} edited`} />
                  <span className="h-full bg-danger-500" style={{ width: `${(byAction.delete / entries.length) * 100}%` }} title={`${byAction.delete} deleted`} />
                </div>
                <div className="flex gap-3 text-xs text-muted-foreground"><span>{byAction.insert} created</span><span>{byAction.update} edited</span><span className={byAction.delete ? "text-down" : ""}>{byAction.delete} deleted</span></div>
              </div>
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1.5">
                <span className="lbl">Most changed</span>
                <div className="flex flex-wrap gap-1.5">
                  {topT.map(([t, n]) => (
                    <button key={t} type="button" onClick={() => setTableFilter(tableFilter === t ? "all" : (t as AuditedTable))}
                      className={`text-xs px-2.5 py-1 rounded-lg border ${tableFilter === t ? "border-brand-500 bg-brand-500/15" : "border-border hover:border-brand-500/60"}`}>
                      {label(t)} <span className="font-ledger font-semibold">{n}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
                <span className="lbl">Busiest people</span>
                {topU.map(([u, n]) => (
                  <div key={u || "system"} className="flex justify-between text-xs"><span className="truncate">{userName(u || null)}</span><span className="font-ledger font-semibold">{n}</span></div>
                ))}
              </div>
            </div>
          );
        })()}
      </Header>

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        {/* Filters */}
        <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Filter className="w-4 h-4" />
            <span className="font-medium">Filters</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">From</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">To</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Table</label>
              <ThemedSelect
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value as "all" | AuditedTable)}
                className="w-full px-3 py-2 border border-border rounded text-sm"
              >
                <option value="all">All tables</option>
                {AUDITED_TABLES.map((t) => (
                  <option key={t} value={t}>{TABLE_LABEL[t] ?? t}</option>
                ))}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Action</label>
              <ThemedSelect
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value as "all" | AuditAction)}
                className="w-full px-3 py-2 border border-border rounded text-sm"
              >
                <option value="all">All actions</option>
                <option value="insert">Insert</option>
                <option value="update">Update</option>
                <option value="delete">Delete</option>
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">User</label>
              <ThemedSelect
                value={userFilter}
                onChange={(e) => setUserFilter(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded text-sm"
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
              <label className="block text-xs text-muted-foreground mb-1">Record ID</label>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70" />
                <input
                  type="text"
                  value={recordIdSearch}
                  onChange={(e) => setRecordIdSearch(e.target.value)}
                  placeholder="Paste a UUID to trace one record's full history"
                  className="w-full pl-10 pr-3 py-2 border border-border rounded text-sm font-mono"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Field / value search</label>
              <input
                type="text"
                value={fieldSearch}
                onChange={(e) => setFieldSearch(e.target.value)}
                placeholder="e.g., final_salary, 50000…"
                className="w-full px-3 py-2 border border-border rounded text-sm"
              />
              <p className="text-[10px] text-muted-foreground mt-1">Filters loaded page; refine other filters first.</p>
            </div>
          </div>
        </div>

        {/* Entry list */}
        <div className="bg-card border border-border rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="w-8 px-2 py-3"></th>
                  <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase">When</th>
                  <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase">User</th>
                  <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase">Action</th>
                  <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase">Table</th>
                  <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase">Record</th>
                  <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase">Fields changed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                    </td>
                  </tr>
                )}
                {!loading && filteredEntries.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground text-sm">
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
                        className="hover:bg-muted/50 cursor-pointer"
                        onClick={() => toggleExpanded(e.id)}
                      >
                        <td className="w-8 px-2 py-3 text-center">
                          {isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground/70 inline" /> : <ChevronRight className="w-4 h-4 text-muted-foreground/70 inline" />}
                        </td>
                        <td className="px-4 py-3 text-xs text-foreground whitespace-nowrap">
                          {formatDateTime(e.changed_at)}
                        </td>
                        <td className="px-4 py-3 text-sm text-foreground whitespace-nowrap">
                          {userName(e.changed_by)}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border ${ACTION_COLOUR[e.action]}`}>
                            <ActionIcon className="w-3 h-3" />
                            {e.action}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-foreground">
                          {TABLE_LABEL[e.table_name] ?? e.table_name}
                        </td>
                        <td className="px-4 py-3 text-xs font-mono text-muted-foreground max-w-[180px] truncate">
                          {e.record_id ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-xs text-foreground">
                          <span className="flex items-center justify-between gap-3">
                            <span>{summary(e.changes)}</span>
                            {e.record_id && e.action !== "delete" && REVERSIBLE_TABLES.has(e.table_name) && (
                              <Link to={`/app/reversals?reverse=${e.record_id}`} onClick={(ev) => ev.stopPropagation()}
                                className="flex-shrink-0 rounded-lg border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-brand-500/60"
                                title="Open this record in Reversals">
                                Reverse →
                              </Link>
                            )}
                          </span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-muted/30">
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
          <div className="flex items-center justify-between p-3 border-t border-border text-sm">
            <div className="text-xs text-muted-foreground">
              Page {page + 1} · {filteredEntries.length} entr{filteredEntries.length === 1 ? "y" : "ies"} on this page
              {fieldSearch && entries.length !== filteredEntries.length && (
                <span className="ml-1">(of {entries.length} loaded — narrow filters for more)</span>
              )}
            </div>
            <div className="flex gap-1">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="px-3 py-1 text-xs border border-border rounded hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                disabled={!hasMore}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 text-xs border border-border rounded hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed"
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
    return <div className="text-xs text-muted-foreground italic">No field-level changes recorded.</div>;
  }
  return (
    <div className="rounded-md border border-border overflow-hidden">
      <div className="grid grid-cols-12 gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70 bg-muted border-b border-border">
        <div className="col-span-3">Field</div>
        {action !== "insert" && <div className="col-span-4">Before</div>}
        {action !== "delete" && <div className={action === "insert" ? "col-span-9" : "col-span-5"}>After</div>}
      </div>
      {entries.map(([field, v]) => (
        <div key={field} className="grid grid-cols-12 gap-2 px-3 py-2 text-xs items-start border-b border-border last:border-b-0 hover:bg-card">
          <div className="col-span-3 text-foreground font-medium leading-5">
            {fieldLabel(field)}
            <div className="text-[10px] text-muted-foreground/70 font-mono font-normal">{field}</div>
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
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground/70 bg-muted/50 border-t border-border">
          {hiddenCount} system field{hiddenCount > 1 ? "s" : ""} hidden (IDs, timestamps)
        </div>
      )}
    </div>
  );
}

function ValueCell({ value, field, variant }: { value: unknown; field: string; variant: "before" | "after" }) {
  if (value === undefined || value === null) {
    return <span className="text-muted-foreground/70 italic text-[11px]">—</span>;
  }
  const display = formatFieldValue(field, value);
  const isLong = display.length > 120;
  const isJson = typeof value === "object";
  const styleBase = variant === "before"
    ? "text-danger-700 bg-danger-50 border border-danger-100"
    : "text-success-700 dark:text-success-500 bg-success-50 border border-success-100";

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
