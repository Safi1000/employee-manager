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
    const fields = Object.keys(changes);
    if (fields.length === 0) return "—";
    if (fields.length <= 3) return fields.join(", ");
    return `${fields.slice(0, 3).join(", ")} +${fields.length - 3} more`;
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
              <select
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value as "all" | AuditedTable)}
                className="w-full px-3 py-2 border border-slate-200 rounded text-sm"
              >
                <option value="all">All tables</option>
                {AUDITED_TABLES.map((t) => (
                  <option key={t} value={t}>{TABLE_LABEL[t] ?? t}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Action</label>
              <select
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value as "all" | AuditAction)}
                className="w-full px-3 py-2 border border-slate-200 rounded text-sm"
              >
                <option value="all">All actions</option>
                <option value="insert">Insert</option>
                <option value="update">Update</option>
                <option value="delete">Delete</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">User</label>
              <select
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
              </select>
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
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${ACTION_COLOUR[e.action]}`}>
                            <ActionIcon className="w-3 h-3" />
                            {e.action}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-700">
                          {TABLE_LABEL[e.table_name] ?? e.table_name}
                          <div className="text-[10px] text-slate-400 font-mono">{e.table_name}</div>
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
  const entries = Object.entries(changes);
  if (entries.length === 0) {
    return <div className="text-xs text-slate-500 italic">No field-level changes recorded.</div>;
  }
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-12 gap-2 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-200">
        <div className="col-span-3">Field</div>
        {action !== "insert" && <div className="col-span-4">Before</div>}
        {action !== "delete" && <div className="col-span-5">After</div>}
      </div>
      {entries.map(([field, v]) => (
        <div key={field} className="grid grid-cols-12 gap-2 px-2 py-1.5 text-xs items-start hover:bg-white">
          <div className="col-span-3 font-mono text-slate-700">{field}</div>
          {action !== "insert" && (
            <div className="col-span-4">
              {v.before === undefined ? (
                <span className="text-slate-400">(unset)</span>
              ) : (
                <ValueCell value={v.before} variant="before" />
              )}
            </div>
          )}
          {action !== "delete" && (
            <div className="col-span-5">
              {v.after === undefined ? (
                <span className="text-slate-400">(unset)</span>
              ) : (
                <ValueCell value={v.after} variant="after" />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ValueCell({ value, variant }: { value: unknown; variant: "before" | "after" }) {
  const styleBase = variant === "before" ? "text-danger-700 bg-danger-50" : "text-success-800 bg-success-50";
  let display: string;
  if (value === null) display = "null";
  else if (typeof value === "object") display = JSON.stringify(value);
  else display = String(value);

  // Truncate very long strings
  const truncated = display.length > 200 ? display.slice(0, 200) + "…" : display;
  return (
    <span className={`inline-block px-2 py-0.5 rounded font-mono text-[11px] break-all ${styleBase}`} title={display}>
      {truncated}
    </span>
  );
}
