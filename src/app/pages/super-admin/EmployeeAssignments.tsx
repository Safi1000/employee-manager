// ── Assignments & Pay ────────────────────────────────────────────────────────
// The single home for an employee's POSTING and PAY data — the fields that used
// to be buried in the Add/Edit Employee modals (location, branch, category,
// client, department, shift, salary, allowance, joining date).
//
// Why it exists: those fields are almost always changed for a whole client at
// once (a 10% raise across 50 guards, a branch move, a department rename), and
// doing that one modal at a time is the single most repetitive job in the app.
// So employees are grouped under their client — the same mental model as
// Attendance — and every field is editable for one guard or for the whole group.
//
// Salary is never overwritten in place: a change goes through set_employee_salary
// with an effective date + reason, which writes employee_salary_history and only
// touches the live row when the change is already in effect. Past months keep
// the pay they were actually run on.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Users,
  Search,
  Loader2,
  AlertCircle,
  X,
  ChevronRight,
  Building2,
  CheckCircle2,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import ExportButton from "../../components/ExportButton";
import { exportTable } from "../../lib/excel";
import { formatDate } from "../../lib/date";
import { useRegion, withRegion } from "../../lib/region";
import { isSeparatedState, lifecycleStatusLabel } from "../../lib/employmentWindow";
import { hasPermission, useAuth } from "../../lib/auth";
import {
  supabase,
  type Employee,
  type Client,
  type Branch,
  type Location,
  type Contract,
  type ContractLine,
  type EmployeeCategory,
} from "../../lib/supabase";
import {
  ChangeClientModal,
  ChangeCategoryModal,
  ChangeShiftModal,
  SalaryHistoryPanel,
  type EmployeeRow,
} from "./EmployeeManagement";

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysInCurrentMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
};
const perDayOf = (base: number | null | undefined) =>
  base == null ? null : Math.round(Number(base) / daysInCurrentMonth());
const money = (n: number | null | undefined) =>
  n == null ? "—" : `PKR ${Math.round(Number(n)).toLocaleString()}`;

const CATEGORY_LABEL: Record<EmployeeCategory, string> = {
  client: "Client",
  office_staff: "Office Staff",
  reliever: "Reliever",
};

/** A group of employees shown as one collapsible card. */
type Group = {
  key: string;
  label: string;
  /** Set for a real client group; null for the category / unassigned buckets. */
  clientId: string | null;
  hint: string;
  rows: EmployeeRow[];
};

// ── Bulk edit shape ──────────────────────────────────────────────────────────
type PayMode = "none" | "percent" | "flat" | "set";
type BulkState = {
  baseMode: PayMode;
  baseValue: string;
  allowanceMode: PayMode;
  allowanceValue: string;
  effectiveDate: string;
  reason: string;
  setLocation: boolean;
  locationId: string;
  setBranch: boolean;
  branchId: string;
  setDepartment: boolean;
  department: string;
  setJoinDate: boolean;
  joinDate: string;
};
const emptyBulk = (): BulkState => ({
  baseMode: "none",
  baseValue: "",
  allowanceMode: "none",
  allowanceValue: "",
  effectiveDate: todayIso(),
  reason: "Increment",
  setLocation: false,
  locationId: "",
  setBranch: false,
  branchId: "",
  setDepartment: false,
  department: "",
  setJoinDate: false,
  joinDate: "",
});

/** Apply a pay mode to a current figure. Returns null when nothing changes. */
function applyPayMode(mode: PayMode, raw: string, current: number | null): number | null {
  if (mode === "none") return null;
  const v = Number(raw);
  if (raw === "" || isNaN(v)) return null;
  if (mode === "set") return Math.max(0, Math.round(v));
  const base = current ?? 0;
  if (mode === "percent") return Math.max(0, Math.round(base * (1 + v / 100)));
  return Math.max(0, Math.round(base + v));
}

export default function EmployeeAssignments() {
  const { profile } = useAuth();
  const { regionId } = useRegion();
  const canEdit = hasPermission(profile, "employees.edit");

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [contractLines, setContractLines] = useState<ContractLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [showSeparated, setShowSeparated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Selected employee ids, keyed by group so a bulk edit can't leak across clients. */
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});

  const [bulkGroup, setBulkGroup] = useState<Group | null>(null);
  const [rowTarget, setRowTarget] = useState<EmployeeRow | null>(null);
  const [assignTarget, setAssignTarget] = useState<EmployeeRow | null>(null);
  const [changeClientTarget, setChangeClientTarget] = useState<EmployeeRow | null>(null);
  const [changeCategoryTarget, setChangeCategoryTarget] = useState<EmployeeRow | null>(null);
  const [changeShiftTarget, setChangeShiftTarget] = useState<EmployeeRow | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [locRes, cliRes, brRes, empRes, ebRes, conRes, clRes] = await Promise.all([
      supabase.from("locations").select("*").order("name"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("branches").select("*").order("is_head_office", { ascending: false }).order("name"),
      withRegion(
        supabase
          .from("employees")
          .select("*, location:location_id(name), client:client_id(name), branch:branch_id(name)")
          .order("full_name"),
        regionId,
      ),
      supabase.from("employee_branches").select("employee_id, branch_id"),
      supabase.from("contracts").select("*").order("start_date", { ascending: false }),
      supabase.from("contract_lines").select("*"),
    ]);
    const firstErr = [locRes, cliRes, brRes, empRes].find((r) => r.error)?.error;
    if (firstErr) setError(firstErr.message);
    setLocations(locRes.data ?? []);
    setClients(cliRes.data ?? []);
    setBranches(brRes.data ?? []);
    setContracts((conRes.data ?? []) as Contract[]);
    setContractLines((clRes.data ?? []) as ContractLine[]);
    const addl = new Map<string, string[]>();
    for (const r of (ebRes.data ?? []) as { employee_id: string; branch_id: string }[]) {
      const arr = addl.get(r.employee_id) ?? [];
      arr.push(r.branch_id);
      addl.set(r.employee_id, arr);
    }
    setEmployees(
      (empRes.data ?? []).map((e: any) => ({
        ...e,
        location_name: e.location?.name ?? null,
        client_name: e.client?.name ?? null,
        branch_name: e.branch?.name ?? null,
        additional_branch_ids: addl.get(e.id) ?? [],
        doc_count: 0,
      })) as EmployeeRow[],
    );
    setLoading(false);
  }, [regionId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Keep the row-edit modal pointed at fresh data after a save.
  useEffect(() => {
    if (!rowTarget) return;
    const fresh = employees.find((e) => e.id === rowTarget.id);
    if (fresh && fresh !== rowTarget) setRowTarget(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees]);

  const clientById = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const contractsForClient = useCallback(
    (clientId: string) => contracts.filter((c) => c.client_id === clientId),
    [contracts],
  );
  const linesForContract = useCallback(
    (contractId: string) => contractLines.filter((l) => l.contract_id === contractId),
    [contractLines],
  );
  const displayCodeFor = useCallback(
    (e: Pick<Employee, "client_id" | "display_number" | "guard_code" | "employee_code">) => {
      const fallback = e.guard_code ?? e.employee_code;
      if (e.display_number == null || !e.client_id) return fallback;
      const prefix = clientById.get(e.client_id)?.employee_id_prefix;
      return prefix ? `${prefix}-${String(e.display_number).padStart(3, "0")}` : fallback;
    },
    [clientById],
  );

  // ── Grouping: one card per client, then the category / unassigned buckets ──
  const groups = useMemo<Group[]>(() => {
    const q = search.trim().toLowerCase();
    const visible = employees.filter((e) => {
      if (!showSeparated && isSeparatedState(e.lifecycle_state)) return false;
      if (!q) return true;
      return (
        e.full_name.toLowerCase().includes(q) ||
        (e.employee_code ?? "").toLowerCase().includes(q) ||
        (e.guard_code ?? "").toLowerCase().includes(q) ||
        (e.cnic_number ?? "").toLowerCase().includes(q)
      );
    });

    const byClient = new Map<string, EmployeeRow[]>();
    const office: EmployeeRow[] = [];
    const relievers: EmployeeRow[] = [];
    const unassigned: EmployeeRow[] = [];
    for (const e of visible) {
      const cat = (e.category ?? "client") as EmployeeCategory;
      if (cat === "office_staff") office.push(e);
      else if (cat === "reliever") relievers.push(e);
      else if (e.client_id) {
        const arr = byClient.get(e.client_id) ?? [];
        arr.push(e);
        byClient.set(e.client_id, arr);
      } else unassigned.push(e);
    }

    const out: Group[] = [];
    for (const [clientId, rows] of byClient) {
      const c = clientById.get(clientId);
      out.push({
        key: `client:${clientId}`,
        label: c?.name ?? "Unknown client",
        clientId,
        hint: c?.employee_id_prefix ? `Prefix ${c.employee_id_prefix}` : "",
        rows,
      });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));

    if (unassigned.length)
      out.unshift({
        key: "unassigned",
        label: "Unassigned",
        clientId: null,
        hint: "Newly added — give them a client, shift and salary",
        rows: unassigned,
      });
    if (office.length)
      out.push({ key: "office", label: "Office Staff", clientId: null, hint: "No client posting", rows: office });
    if (relievers.length)
      out.push({ key: "relievers", label: "Relievers", clientId: null, hint: "Relief pool", rows: relievers });
    return out;
  }, [employees, search, showSeparated, clientById]);

  const toggleGroup = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const selectionFor = (key: string) => selected[key] ?? new Set<string>();
  const toggleRow = (key: string, id: string) =>
    setSelected((prev) => {
      const next = new Set(prev[key] ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, [key]: next };
    });
  const toggleAll = (g: Group) =>
    setSelected((prev) => {
      const cur = prev[g.key] ?? new Set<string>();
      const all = cur.size === g.rows.length;
      return { ...prev, [g.key]: all ? new Set<string>() : new Set(g.rows.map((r) => r.id)) };
    });

  const handleExport = () =>
    exportTable({
      fileName: "assignments-and-pay",
      sheetName: "Assignments",
      headers: [
        "Group", "Code", "Name", "Category", "Client", "Location", "Branch",
        "Department", "Shift", "Base Salary", "Per Day", "Allowance", "Joined", "Status",
      ],
      rows: groups.flatMap((g) =>
        g.rows.map((e) => [
          g.label,
          displayCodeFor(e),
          e.full_name,
          CATEGORY_LABEL[(e.category ?? "client") as EmployeeCategory],
          e.client_name ?? "",
          e.location_name ?? "",
          e.branch_name ?? "",
          e.department ?? "",
          e.shift,
          e.base_salary ?? "",
          perDayOf(e.base_salary) ?? "",
          e.allowance ?? "",
          e.join_date ?? "",
          lifecycleStatusLabel(e),
        ]),
      ),
    });

  const totalShown = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <>
      <Header
        title="Assignments & Pay"
        subtitle="Posting and pay for every employee, grouped by client — edit one or the whole group"
        actions={<ExportButton onExport={handleExport} label="Export" />}
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}
        {notice && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-success-50 text-success-800 border border-success-200 rounded-md text-sm">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={2} />
            <div className="flex-1">{notice}</div>
            <button onClick={() => setNotice(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-56">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, code or CNIC…"
              className="w-full pl-9 pr-4 py-2 border border-border rounded-md text-sm bg-card"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={showSeparated} onChange={(e) => setShowSeparated(e.target.checked)} />
            Include separated
          </label>
          <span className="text-sm text-muted-foreground">
            {groups.length} group{groups.length === 1 ? "" : "s"} · {totalShown} employee{totalShown === 1 ? "" : "s"}
          </span>
        </div>

        {loading && (
          <div className="py-16 text-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
          </div>
        )}

        {!loading && groups.length === 0 && (
          <div className="py-16 text-center text-sm text-muted-foreground">
            No employees match this search.
          </div>
        )}

        <div className="space-y-3">
          {groups.map((g) => {
            const open = expanded.has(g.key);
            const sel = selectionFor(g.key);
            const monthly = g.rows.reduce(
              (sum, e) => sum + Number(e.base_salary ?? 0) + Number(e.allowance ?? 0),
              0,
            );
            return (
              <div key={g.key} className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.key)}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left"
                    aria-expanded={open}
                  >
                    <ChevronRight
                      className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                      strokeWidth={1.75}
                    />
                    {g.clientId ? (
                      <Building2 className="w-4 h-4 shrink-0 text-brand-600 dark:text-brand-500" strokeWidth={1.5} />
                    ) : (
                      <Users className="w-4 h-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                    )}
                    <span className="font-medium text-foreground truncate">{g.label}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {g.rows.length} employee{g.rows.length === 1 ? "" : "s"}
                    </span>
                    {g.hint && <span className="text-xs text-muted-foreground truncate hidden md:inline">· {g.hint}</span>}
                  </button>
                  <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">
                    {money(monthly)}/mo
                  </span>
                  {canEdit && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        if (!open) toggleGroup(g.key);
                        setBulkGroup(g);
                      }}
                    >
                      Bulk edit{sel.size > 0 ? ` (${sel.size})` : ""}
                    </Button>
                  )}
                </div>

                {open && (
                  <div className="overflow-x-auto border-t border-border">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border bg-slate-50">
                          <th className="px-3 py-2 w-9">
                            <input
                              type="checkbox"
                              checked={sel.size > 0 && sel.size === g.rows.length}
                              onChange={() => toggleAll(g)}
                              aria-label={`Select all in ${g.label}`}
                            />
                          </th>
                          {["Code", "Name", "Location", "Branch", "Department", "Shift", "Base", "Per day", "Allowance", "Joined"].map((h) => (
                            <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground whitespace-nowrap">
                              {h}
                            </th>
                          ))}
                          <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sticky right-0 z-10 bg-slate-50 border-l border-border">
                            Edit
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.rows.map((e) => (
                          <tr key={e.id} className="group border-b border-border last:border-0 transition-colors hover:bg-accent">
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={sel.has(e.id)}
                                onChange={() => toggleRow(g.key, e.id)}
                                aria-label={`Select ${e.full_name}`}
                              />
                            </td>
                            <td className="px-3 py-2 text-sm font-mono text-foreground whitespace-nowrap">{displayCodeFor(e)}</td>
                            <td className="px-3 py-2 text-sm text-foreground whitespace-nowrap">
                              {e.full_name}
                              {isSeparatedState(e.lifecycle_state) && (
                                <span className="ml-2 text-[10px] uppercase tracking-wide text-danger-700 dark:text-danger-500">
                                  {lifecycleStatusLabel(e)}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-sm text-muted-foreground whitespace-nowrap">{e.location_name ?? "—"}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground whitespace-nowrap">{e.branch_name ?? "—"}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground whitespace-nowrap">{e.department ?? "—"}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground capitalize whitespace-nowrap">{e.shift}</td>
                            <td className="px-3 py-2 text-sm text-foreground tabular-nums whitespace-nowrap">{money(e.base_salary)}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground tabular-nums whitespace-nowrap">{money(perDayOf(e.base_salary))}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground tabular-nums whitespace-nowrap">{money(e.allowance)}</td>
                            <td className="px-3 py-2 text-sm text-muted-foreground whitespace-nowrap">
                              {e.join_date ? formatDate(e.join_date) : "—"}
                            </td>
                            {/* Sticky column: opaque in every state, or the columns
                                underneath show through while scrolling sideways. */}
                            <td className="px-3 py-2 sticky right-0 z-10 border-l border-border bg-card group-hover:bg-accent transition-colors">
                              <Button variant="ghost" size="sm" onClick={() => setRowTarget(e)}>
                                {canEdit ? "Edit" : "View"}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {bulkGroup && (
        <BulkEditModal
          group={bulkGroup}
          selectedIds={selectionFor(bulkGroup.key)}
          locations={locations}
          branches={branches}
          onClose={() => setBulkGroup(null)}
          onDone={async (msg) => {
            setBulkGroup(null);
            setSelected((prev) => ({ ...prev, [bulkGroup.key]: new Set<string>() }));
            setNotice(msg);
            await loadData();
          }}
        />
      )}

      {rowTarget && (
        <RowEditModal
          employee={rowTarget}
          canEdit={canEdit}
          displayCode={displayCodeFor(rowTarget)}
          locations={locations}
          branches={branches}
          clients={clients}
          onClose={() => setRowTarget(null)}
          onSaved={async () => { setRowTarget(null); await loadData(); }}
          onAssignClient={() => { const t = rowTarget; setRowTarget(null); setAssignTarget(t); }}
          onChangeClient={() => { const t = rowTarget; setRowTarget(null); setChangeClientTarget(t); }}
          onChangeCategory={() => { const t = rowTarget; setRowTarget(null); setChangeCategoryTarget(t); }}
          onChangeShift={() => { const t = rowTarget; setRowTarget(null); setChangeShiftTarget(t); }}
          onError={setError}
        />
      )}

      {assignTarget && (
        <FirstAssignmentModal
          employee={assignTarget}
          clients={clients}
          contractsForClient={contractsForClient}
          linesForContract={linesForContract}
          onClose={() => setAssignTarget(null)}
          onDone={async (msg) => { setAssignTarget(null); setNotice(msg); await loadData(); }}
          onError={setError}
        />
      )}

      {changeClientTarget && (
        <ChangeClientModal
          guard={changeClientTarget}
          clients={clients}
          contractsForClient={contractsForClient}
          linesForContract={linesForContract}
          displayCode={displayCodeFor(changeClientTarget)}
          onClose={() => setChangeClientTarget(null)}
          onDone={async () => { setChangeClientTarget(null); await loadData(); }}
          onError={setError}
        />
      )}
      {changeCategoryTarget && (
        <ChangeCategoryModal
          guard={changeCategoryTarget}
          clients={clients}
          contractsForClient={contractsForClient}
          linesForContract={linesForContract}
          displayCode={displayCodeFor(changeCategoryTarget)}
          onClose={() => setChangeCategoryTarget(null)}
          onDone={async () => { setChangeCategoryTarget(null); await loadData(); }}
          onError={setError}
        />
      )}
      {changeShiftTarget && (
        <ChangeShiftModal
          guard={changeShiftTarget}
          displayCode={displayCodeFor(changeShiftTarget)}
          onClose={() => setChangeShiftTarget(null)}
          onDone={async () => { setChangeShiftTarget(null); await loadData(); }}
          onError={setError}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk edit — the reason this page exists. Applies one change to every selected
// employee in a group (or the whole group when nothing is ticked).
// ─────────────────────────────────────────────────────────────────────────────
function BulkEditModal({
  group, selectedIds, locations, branches, onClose, onDone,
}: {
  group: Group;
  selectedIds: Set<string>;
  locations: Location[];
  branches: Branch[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [bulk, setBulk] = useState<BulkState>(emptyBulk);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof BulkState>(k: K, v: BulkState[K]) => setBulk((b) => ({ ...b, [k]: v }));

  // Nothing ticked = the whole group; that's the common case ("raise everyone").
  const targets = useMemo(
    () => (selectedIds.size > 0 ? group.rows.filter((r) => selectedIds.has(r.id)) : group.rows),
    [group, selectedIds],
  );

  const payChanges = useMemo(
    () =>
      targets
        .map((e) => {
          const nextBase = applyPayMode(bulk.baseMode, bulk.baseValue, e.base_salary as number | null);
          const nextAllow = applyPayMode(bulk.allowanceMode, bulk.allowanceValue, e.allowance as number | null);
          if (nextBase == null && nextAllow == null) return null;
          return {
            employee: e,
            base: nextBase ?? (e.base_salary != null ? Math.round(Number(e.base_salary)) : 0),
            allowance: nextAllow ?? (e.allowance != null ? Math.round(Number(e.allowance)) : 0),
          };
        })
        .filter(Boolean) as { employee: EmployeeRow; base: number; allowance: number }[],
    [targets, bulk.baseMode, bulk.baseValue, bulk.allowanceMode, bulk.allowanceValue],
  );

  const fieldPatch = useMemo(() => {
    const patch: Record<string, unknown> = {};
    if (bulk.setLocation) patch.location_id = bulk.locationId || null;
    if (bulk.setBranch) patch.branch_id = bulk.branchId || null;
    if (bulk.setDepartment) patch.department = bulk.department.trim() || null;
    if (bulk.setJoinDate) patch.join_date = bulk.joinDate || null;
    return patch;
  }, [bulk]);

  const hasFieldChange = Object.keys(fieldPatch).length > 0;
  const hasPayChange = payChanges.length > 0;

  const apply = async () => {
    if (!hasPayChange && !hasFieldChange) {
      setErr("Nothing to apply — set a pay change or tick a field to update.");
      return;
    }
    if (hasPayChange && !bulk.effectiveDate) {
      setErr("Pick an effective date for the pay change.");
      return;
    }
    setSaving(true);
    setErr(null);
    setProgress(0);
    try {
      if (hasFieldChange) {
        const { error } = await supabase
          .from("employees")
          .update(fieldPatch)
          .in("id", targets.map((t) => t.id));
        if (error) throw error;
      }
      // Salary is per-employee: each needs its own dated history row, so this is
      // a loop, not one statement. Sequential keeps the error message useful.
      for (let i = 0; i < payChanges.length; i++) {
        const c = payChanges[i];
        const { error } = await supabase.rpc("set_employee_salary", {
          p_employee_id: c.employee.id,
          p_effective_date: bulk.effectiveDate,
          p_base_salary: c.base,
          p_allowance: c.allowance,
          p_per_day_salary: c.base / daysInCurrentMonth(),
          p_reason: bulk.reason.trim() || "Increment",
        });
        if (error) throw new Error(`${c.employee.full_name}: ${error.message}`);
        setProgress(i + 1);
      }
      const bits: string[] = [];
      if (hasPayChange) bits.push(`pay updated for ${payChanges.length}`);
      if (hasFieldChange) bits.push(`details updated for ${targets.length}`);
      await onDone(`${group.label}: ${bits.join(", ")}.`);
    } catch (e: any) {
      setErr(e.message ?? String(e));
      setSaving(false);
    }
  };

  const inputCls = "w-full px-3 py-2 border border-border rounded-md text-sm bg-card";
  const modeSelect = (mode: PayMode, onChange: (m: PayMode) => void) => (
    <ThemedSelect value={mode} onChange={(e) => onChange(e.target.value as PayMode)} className={inputCls}>
      <option value="none">No change</option>
      <option value="percent">Increase by %</option>
      <option value="flat">Add fixed amount</option>
      <option value="set">Set to exact amount</option>
    </ThemedSelect>
  );

  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title={`Bulk edit — ${group.label}`}
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {saving && payChanges.length > 0
              ? `Applying ${progress} / ${payChanges.length}…`
              : `Applies to ${targets.length} employee${targets.length === 1 ? "" : "s"}${
                  selectedIds.size > 0 ? " (selected)" : " (whole group)"
                }`}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={apply} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Apply
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        <section>
          <h4 className="text-sm font-medium text-foreground mb-1">Salary &amp; allowance</h4>
          <p className="text-xs text-muted-foreground mb-3">
            Recorded as a dated increment per employee — earlier months keep the salary they were paid on.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Base salary</label>
              {modeSelect(bulk.baseMode, (m) => set("baseMode", m))}
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                {bulk.baseMode === "percent" ? "Percent (%)" : "Amount (PKR)"}
              </label>
              <input
                type="number"
                value={bulk.baseValue}
                disabled={bulk.baseMode === "none"}
                onChange={(e) => set("baseValue", e.target.value)}
                className={inputCls + (bulk.baseMode === "none" ? " opacity-50" : "")}
                placeholder={bulk.baseMode === "percent" ? "10" : "3000"}
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Allowance</label>
              {modeSelect(bulk.allowanceMode, (m) => set("allowanceMode", m))}
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                {bulk.allowanceMode === "percent" ? "Percent (%)" : "Amount (PKR)"}
              </label>
              <input
                type="number"
                value={bulk.allowanceValue}
                disabled={bulk.allowanceMode === "none"}
                onChange={(e) => set("allowanceValue", e.target.value)}
                className={inputCls + (bulk.allowanceMode === "none" ? " opacity-50" : "")}
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Effective date</label>
              <input type="date" value={bulk.effectiveDate} onChange={(e) => set("effectiveDate", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Reason</label>
              <input value={bulk.reason} onChange={(e) => set("reason", e.target.value)} className={inputCls} placeholder="Annual increment" />
            </div>
          </div>

          {payChanges.length > 0 && (
            <div className="mt-3 border border-border rounded-md max-h-56 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50">
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-1.5 px-2 font-medium">Employee</th>
                    <th className="py-1.5 px-2 font-medium">Base</th>
                    <th className="py-1.5 px-2 font-medium">Allowance</th>
                  </tr>
                </thead>
                <tbody>
                  {payChanges.map((c) => (
                    <tr key={c.employee.id} className="border-b border-border last:border-0">
                      <td className="py-1.5 px-2 text-foreground">{c.employee.full_name}</td>
                      <td className="py-1.5 px-2 tabular-nums text-muted-foreground">
                        {money(c.employee.base_salary)} <span className="text-muted-foreground">→</span>{" "}
                        <span className="text-foreground font-medium">{money(c.base)}</span>
                      </td>
                      <td className="py-1.5 px-2 tabular-nums text-muted-foreground">
                        {money(c.employee.allowance)} <span className="text-muted-foreground">→</span>{" "}
                        <span className="text-foreground font-medium">{money(c.allowance)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="pt-4 border-t border-border">
          <h4 className="text-sm font-medium text-foreground mb-3">Other details</h4>
          <div className="space-y-3">
            <BulkField
              label="Location"
              checked={bulk.setLocation}
              onToggle={(v) => set("setLocation", v)}
            >
              <ThemedSelect value={bulk.locationId} onChange={(e) => set("locationId", e.target.value)} className={inputCls}>
                <option value="">— Clear —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </ThemedSelect>
            </BulkField>
            <BulkField
              label="Primary branch"
              checked={bulk.setBranch}
              onToggle={(v) => set("setBranch", v)}
            >
              <ThemedSelect value={bulk.branchId} onChange={(e) => set("branchId", e.target.value)} className={inputCls}>
                <option value="">Head Office (default)</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </ThemedSelect>
            </BulkField>
            <BulkField
              label="Department"
              checked={bulk.setDepartment}
              onToggle={(v) => set("setDepartment", v)}
            >
              <input value={bulk.department} onChange={(e) => set("department", e.target.value)} className={inputCls} placeholder="e.g. Security" />
            </BulkField>
            <BulkField
              label="Joining date"
              checked={bulk.setJoinDate}
              onToggle={(v) => set("setJoinDate", v)}
            >
              <input type="date" value={bulk.joinDate} onChange={(e) => set("joinDate", e.target.value)} className={inputCls} />
            </BulkField>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Client, category and shift are dated posting changes and stay one-at-a-time — use Edit on the row.
          </p>
        </section>
      </div>
    </Modal>
  );
}

function BulkField({
  label, checked, onToggle, children,
}: {
  label: string;
  checked: boolean;
  onToggle: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-2 sm:items-center">
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
        {label}
      </label>
      <div className={checked ? "" : "opacity-40 pointer-events-none"}>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// One employee's assignment + pay. Plain fields save straight through; client,
// category and shift are dated posting changes handed to their own modals; pay
// goes through the dated increment panel.
// ─────────────────────────────────────────────────────────────────────────────
function RowEditModal({
  employee, canEdit, displayCode, locations, branches, clients,
  onClose, onSaved, onAssignClient, onChangeClient, onChangeCategory, onChangeShift, onError,
}: {
  employee: EmployeeRow;
  canEdit: boolean;
  displayCode: string;
  locations: Location[];
  branches: Branch[];
  clients: Client[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onAssignClient: () => void;
  onChangeClient: () => void;
  onChangeCategory: () => void;
  onChangeShift: () => void;
  onError: (m: string) => void;
}) {
  const [locationId, setLocationId] = useState(employee.location_id ?? "");
  const [branchId, setBranchId] = useState(employee.branch_id ?? "");
  const [additional, setAdditional] = useState<string[]>([...(employee.additional_branch_ids ?? [])]);
  const [department, setDepartment] = useState(employee.department ?? "");
  const [joinDate, setJoinDate] = useState(employee.join_date ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const category = (employee.category ?? "client") as EmployeeCategory;
  const clientName = clients.find((c) => c.id === employee.client_id)?.name ?? "—";
  const canPost =
    ["active", "on_leave"].includes(employee.lifecycle_state ?? "") && employee.record_state !== "draft";
  // Before the first client posting exists there is no dated history to protect,
  // so category and shift are ordinary columns the user can just set.
  const neverPosted = !employee.client_id;
  const [shift, setShift] = useState<string>(employee.shift);
  const [draftCategory, setDraftCategory] = useState<EmployeeCategory>(category);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const { error } = await supabase
        .from("employees")
        .update({
          location_id: locationId || null,
          branch_id: branchId || null,
          department: department.trim() || null,
          join_date: joinDate || null,
          ...(neverPosted ? { shift, category: draftCategory } : {}),
        })
        .eq("id", employee.id);
      if (error) throw error;

      // employee_branches junction: additional visibility only, never the primary.
      const desired = new Set(additional.filter((id) => id && id !== branchId));
      const { data: existing, error: e1 } = await supabase
        .from("employee_branches").select("branch_id").eq("employee_id", employee.id);
      if (e1) throw e1;
      const have = new Set((existing ?? []).map((r: any) => r.branch_id as string));
      const toRemove = [...have].filter((id) => !desired.has(id));
      const toAdd = [...desired].filter((id) => !have.has(id));
      if (toRemove.length) {
        const { error } = await supabase
          .from("employee_branches").delete().eq("employee_id", employee.id).in("branch_id", toRemove);
        if (error) throw error;
      }
      if (toAdd.length) {
        const { error } = await supabase
          .from("employee_branches")
          .insert(toAdd.map((branch_id) => ({ employee_id: employee.id, branch_id })));
        if (error) throw error;
      }
      await onSaved();
    } catch (e: any) {
      const m = e.message ?? String(e);
      setErr(m);
      onError(m);
      setSaving(false);
    }
  };

  const inputCls = "w-full px-3 py-2 border border-border rounded-md text-sm bg-card";
  const lockedCls = "w-full px-3 py-2 border border-border rounded-md text-sm bg-slate-50 text-slate-500 cursor-not-allowed";

  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title={`${employee.full_name} · ${displayCode}`}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Close</Button>
          {canEdit && (
            <Button size="sm" onClick={save} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Save
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-6">
        <section>
          <h4 className="text-sm font-medium text-foreground mb-3">Posting</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Category</label>
              {neverPosted && canEdit ? (
                <ThemedSelect value={draftCategory} onChange={(e) => setDraftCategory(e.target.value as EmployeeCategory)} className={inputCls}>
                  <option value="client">Client</option>
                  <option value="office_staff">Office Staff</option>
                  <option value="reliever">Reliever</option>
                </ThemedSelect>
              ) : (
                <>
                  <input value={CATEGORY_LABEL[category]} disabled readOnly className={lockedCls} />
                  {canEdit && canPost && (
                    <button type="button" onClick={onChangeCategory} className="text-xs text-brand-700 dark:text-brand-500 hover:underline mt-1">
                      Change category (dated)
                    </button>
                  )}
                </>
              )}
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Client</label>
              <input value={category === "client" ? clientName : "—"} disabled readOnly className={lockedCls} />
              {canEdit && neverPosted && draftCategory === "client" && (
                <button type="button" onClick={onAssignClient} className="text-xs text-brand-700 dark:text-brand-500 hover:underline mt-1">
                  Assign to a client…
                </button>
              )}
              {canEdit && !neverPosted && canPost && category === "client" && (
                <button type="button" onClick={onChangeClient} className="text-xs text-brand-700 dark:text-brand-500 hover:underline mt-1">
                  Change client (dated)
                </button>
              )}
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Shift</label>
              {neverPosted && canEdit ? (
                <ThemedSelect value={shift} onChange={(e) => setShift(e.target.value)} className={inputCls}>
                  <option value="day">Day</option>
                  <option value="evening">Evening</option>
                  <option value="night">Night</option>
                </ThemedSelect>
              ) : (
                <>
                  <input value={employee.shift} disabled readOnly className={lockedCls + " capitalize"} />
                  {canEdit && canPost && category === "client" && (
                    <button type="button" onClick={onChangeShift} className="text-xs text-brand-700 dark:text-brand-500 hover:underline mt-1">
                      Change shift (dated)
                    </button>
                  )}
                </>
              )}
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Department</label>
              <input
                value={department}
                disabled={!canEdit}
                onChange={(e) => setDepartment(e.target.value)}
                className={canEdit ? inputCls : lockedCls}
              />
            </div>
          </div>
          {!canPost && (
            <p className="text-xs text-muted-foreground mt-2">
              Client / category / shift changes need an Ops-verified, active employee.
            </p>
          )}
        </section>

        <section className="pt-4 border-t border-border">
          <h4 className="text-sm font-medium text-foreground mb-3">Location &amp; branches</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Location</label>
              <ThemedSelect value={locationId} disabled={!canEdit} onChange={(e) => setLocationId(e.target.value)} className={canEdit ? inputCls : lockedCls}>
                <option value="">Select location</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Primary branch</label>
              <ThemedSelect
                value={branchId}
                disabled={!canEdit}
                onChange={(e) => {
                  setBranchId(e.target.value);
                  setAdditional((prev) => prev.filter((id) => id !== e.target.value));
                }}
                className={canEdit ? inputCls : lockedCls}
              >
                <option value="">Head Office (default)</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </ThemedSelect>
              <p className="text-[11px] text-muted-foreground mt-1">Payroll routing, P&amp;L attribution and cost ownership.</p>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs text-muted-foreground mb-1">Additional branches (visibility)</label>
              <div className={`flex flex-wrap gap-2 p-2 border border-border rounded-md ${canEdit ? "" : "opacity-60 pointer-events-none"}`}>
                {branches.filter((b) => b.id !== branchId).map((b) => {
                  const checked = additional.includes(b.id);
                  return (
                    <label
                      key={b.id}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer border ${
                        checked ? "border-brand-500 bg-brand-500/10 text-foreground" : "border-border text-muted-foreground hover:border-brand-500/50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setAdditional((prev) => (checked ? prev.filter((id) => id !== b.id) : [...prev, b.id]))
                        }
                      />
                      {b.name}
                    </label>
                  );
                })}
                {branches.filter((b) => b.id !== branchId).length === 0 && (
                  <span className="text-xs text-muted-foreground">No other branches available.</span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Branched users in these branches can see this employee without owning the cost.
              </p>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Joining date</label>
              <input
                type="date"
                value={joinDate}
                disabled={!canEdit}
                onChange={(e) => setJoinDate(e.target.value)}
                className={canEdit ? inputCls : lockedCls}
              />
            </div>
          </div>
        </section>

        <section className="pt-4 border-t border-border">
          <h4 className="text-sm font-medium text-foreground mb-3">Pay</h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Base salary</label>
              <input value={money(employee.base_salary)} disabled readOnly className={lockedCls} />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Per day</label>
              <input value={money(perDayOf(employee.base_salary))} disabled readOnly className={lockedCls} />
              <p className="text-[11px] text-muted-foreground mt-1">Base ÷ {daysInCurrentMonth()} days this month.</p>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Allowance</label>
              <input value={money(employee.allowance)} disabled readOnly className={lockedCls} />
            </div>
          </div>
          {canEdit && (
            <SalaryHistoryPanel
              employeeId={employee.id}
              currentBase={employee.base_salary != null ? String(employee.base_salary) : ""}
              currentAllowance={employee.allowance != null ? String(employee.allowance) : ""}
              onApplied={() => { void onSaved(); }}
            />
          )}
        </section>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// First client assignment for a freshly added employee.
//
// This can NOT go through change_client(): that RPC refuses a draft record
// ("must be Ops-verified before being posted"), and a brand-new hire is always
// draft. Hiring has always been the exception — the posting row is written
// directly, which the enforce_posting_requires_ops_verified trigger allows
// because the employee has no prior client. This mirrors what the Add Employee
// modal used to do inline, now that assignment lives on this page.
// ─────────────────────────────────────────────────────────────────────────────
function FirstAssignmentModal({
  employee, clients, contractsForClient, linesForContract, onClose, onDone, onError,
}: {
  employee: EmployeeRow;
  clients: Client[];
  contractsForClient: (clientId: string) => Contract[];
  linesForContract: (contractId: string) => ContractLine[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
  onError: (m: string) => void;
}) {
  const [clientId, setClientId] = useState("");
  const [contractLineId, setContractLineId] = useState("");
  const [startDate, setStartDate] = useState(employee.join_date ?? todayIso());
  const [shift, setShift] = useState<string>(employee.shift);
  const [baseSalary, setBaseSalary] = useState(employee.base_salary != null ? String(employee.base_salary) : "");
  const [allowance, setAllowance] = useState(employee.allowance != null ? String(employee.allowance) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const lines = clientId ? contractsForClient(clientId).flatMap((c) => linesForContract(c.id)) : [];

  const save = async () => {
    if (!clientId) { setErr("Select a client."); return; }
    if (!startDate) { setErr("Pick a start date."); return; }
    setSaving(true);
    setErr(null);
    try {
      // Shift and category are plain columns until the first posting exists.
      const { error: upErr } = await supabase
        .from("employees")
        .update({ shift, category: "client", join_date: employee.join_date ?? startDate })
        .eq("id", employee.id);
      if (upErr) throw upErr;

      // The posting row. Its sync trigger mirrors client_id onto the employee.
      const { data: defSite } = await supabase
        .from("sites").select("id")
        .eq("client_id", clientId).eq("is_default", true).maybeSingle();
      const { error: depErr } = await supabase.from("deployments").insert({
        guard_id: employee.id,
        client_id: clientId,
        contract_line_id: contractLineId || null,
        site_id: (defSite as { id?: string } | null)?.id ?? null,
        start_date: startDate,
        reason: "new_hire",
      });
      if (depErr) throw depErr;

      // Permanent GGS-NNNNN (once, at hiring) + the client-scoped display number.
      if (!employee.guard_code) {
        const { error: codeErr } = await supabase.rpc("assign_guard_code", { p_employee_id: employee.id });
        if (codeErr) throw codeErr;
      }
      const { error: dispErr } = await supabase.rpc("assign_display_number", { p_employee_id: employee.id });
      if (dispErr) throw dispErr;

      // Seed the first salary-history row — the capture trigger only fires on
      // UPDATE, so without this the guard would have no effective-dated pay.
      if (baseSalary) {
        const base = Number(baseSalary);
        if (isNaN(base) || base <= 0) throw new Error("Enter a valid base salary.");
        const { error: salErr } = await supabase.rpc("set_employee_salary", {
          p_employee_id: employee.id,
          p_effective_date: startDate,
          p_base_salary: base,
          p_allowance: allowance ? Math.max(0, Number(allowance)) : 0,
          p_per_day_salary: base / daysInCurrentMonth(),
          p_reason: "Initial salary",
        });
        if (salErr) throw salErr;
      }
      const name = clients.find((c) => c.id === clientId)?.name ?? "client";
      await onDone(`${employee.full_name} assigned to ${name}.`);
    } catch (e: any) {
      const m = e.message ?? String(e);
      setErr(m);
      onError(m);
      setSaving(false);
    }
  };

  const inputCls = "w-full px-3 py-2 border border-border rounded-md text-sm bg-card";
  return (
    <Modal
      isOpen
      error={err}
      onDismissError={() => setErr(null)}
      onClose={onClose}
      title={`Assign ${employee.full_name} to a client`}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Assign
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          This is the first posting, so it also issues the permanent guard code and the
          client number, and records the opening salary.
        </p>
        <label className="block">
          <span className="text-xs text-muted-foreground">Client</span>
          <ThemedSelect value={clientId} onChange={(e) => { setClientId(e.target.value); setContractLineId(""); }} className={inputCls}>
            <option value="">— Select —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </ThemedSelect>
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Contract line (optional)</span>
          <ThemedSelect value={contractLineId} onChange={(e) => setContractLineId(e.target.value)} className={inputCls}>
            <option value="">— None —</option>
            {lines.map((l) => <option key={l.id} value={l.id}>{l.label ?? l.category}</option>)}
          </ThemedSelect>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-muted-foreground">Start date</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Shift</span>
            <ThemedSelect value={shift} onChange={(e) => setShift(e.target.value)} className={inputCls}>
              <option value="day">Day</option>
              <option value="evening">Evening</option>
              <option value="night">Night</option>
            </ThemedSelect>
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Base salary (PKR)</span>
            <input type="number" value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} className={inputCls} placeholder="50000" />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Allowance (PKR)</span>
            <input type="number" min={0} value={allowance} onChange={(e) => setAllowance(e.target.value)} className={inputCls} placeholder="0" />
          </label>
        </div>
      </div>
    </Modal>
  );
}
