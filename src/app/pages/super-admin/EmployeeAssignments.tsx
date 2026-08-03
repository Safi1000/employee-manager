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
// Absorbed the old Operations ▸ Deployment page: the contracted-vs-enrolled
// reconciliation belongs on the same screen as the guards it counts, so each
// client's card carries its own Sites / Contracted / Enrolled / Variance figures
// and the totals sit above the list.
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
  UserPlus,
  UserMinus,
  CheckCircle2,
  MapPin,
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
  type ContractAddendum,
  type ContractLineCategory,
  type EmployeeCategory,
  CONTRACT_LINE_CATEGORY_LABEL,
  effectiveCommittedByCategory,
  activeCountByCategory,
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

/**
 * Per-client contracted-vs-enrolled snapshot, from v_client_strength_reconciliation.
 * Variance = contracted − enrolled(active): positive = understaffed (amber),
 * negative = over-enrolled (red), zero = on strength (green).
 */
type ReconRow = {
  client_id: string;
  client_name: string;
  site_count: number;
  contracted_billed_qty: number;
  required_on_ground: number;
  enrolled_active: number;
  enrolled_total: number;
  variance: number;
};

const varianceBadge = (v: number) => {
  if (v === 0) return "bg-success-50 text-success-700 dark:text-success-500 border-success-200";
  if (v < 0) return "bg-danger-50 text-danger-700 dark:text-danger-500 border-danger-200";
  return "bg-warning-50 text-warning-800 dark:text-warning-500 border-warning-200";
};

/** A group of employees shown as one collapsible card. */
type Group = {
  key: string;
  label: string;
  /** Set for a real client group; null for the category / unassigned buckets. */
  clientId: string | null;
  hint: string;
  rows: EmployeeRow[];
  /** Only set for client groups that appear in the reconciliation view. */
  recon?: ReconRow;
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
  const [addendums, setAddendums] = useState<ContractAddendum[]>([]);
  const [recon, setRecon] = useState<ReconRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [showSeparated, setShowSeparated] = useState(false);
  const [onlyMismatch, setOnlyMismatch] = useState(false);
  const [showServicesClients, setShowServicesClients] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Selected employee ids, keyed by group so a bulk edit can't leak across clients. */
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});

  const [bulkGroup, setBulkGroup] = useState<Group | null>(null);
  const [rowTarget, setRowTarget] = useState<EmployeeRow | null>(null);
  const [assignToClient, setAssignToClient] = useState<{ id: string; name: string } | null>(null);
  const [unassignFrom, setUnassignFrom] = useState<{ group: Group; rows: EmployeeRow[] } | null>(null);
  const [poolOpen, setPoolOpen] = useState(false);
  const [changeClientTarget, setChangeClientTarget] = useState<EmployeeRow | null>(null);
  const [changeCategoryTarget, setChangeCategoryTarget] = useState<EmployeeRow | null>(null);
  const [changeShiftTarget, setChangeShiftTarget] = useState<EmployeeRow | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [locRes, cliRes, brRes, empRes, ebRes, conRes, clRes, adRes, recRes] = await Promise.all([
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
      supabase.from("contract_addendums").select("*"),
      supabase.from("v_client_strength_reconciliation").select("*").order("client_name"),
    ]);
    const firstErr = [locRes, cliRes, brRes, empRes].find((r) => r.error)?.error;
    if (firstErr) setError(firstErr.message);
    setLocations(locRes.data ?? []);
    setClients(cliRes.data ?? []);
    setBranches(brRes.data ?? []);
    setContracts((conRes.data ?? []) as Contract[]);
    setContractLines((clRes.data ?? []) as ContractLine[]);
    setAddendums((adRes.data ?? []) as ContractAddendum[]);
    setRecon((recRes.data ?? []) as ReconRow[]);
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

  // A "Services" contract bills for hardware (weapons / equipment), not people, so
  // a client whose contracts are ALL Services has no headcount to assign. They are
  // also junk in the strength reconciliation, which sums contract_lines.billed_qty
  // without caring whether the line counts guards or rifles — a 40-weapon contract
  // reads as "40 contracted, 0 enrolled, +40 short". Hidden from this page.
  // A client with no contracts at all stays visible: absence of evidence isn't
  // evidence that they have no guards.
  const servicesOnlyClientIds = useMemo(() => {
    const seen = new Map<string, boolean>();
    for (const c of contracts) {
      const isServices = c.contract_type === "services";
      seen.set(c.client_id, (seen.get(c.client_id) ?? true) && isServices);
    }
    return new Set([...seen].filter(([, only]) => only).map(([id]) => id));
  }, [contracts]);
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
    for (const e of visible) {
      const cat = (e.category ?? "client") as EmployeeCategory;
      if (cat === "office_staff") office.push(e);
      else if (cat === "reliever") relievers.push(e);
      else if (e.client_id) {
        const arr = byClient.get(e.client_id) ?? [];
        arr.push(e);
        byClient.set(e.client_id, arr);
      }
      // Employees with no client posting aren't a group — they're the candidate
      // pool behind each client's "Assign employees" button.
    }

    // EVERY client gets a card, staffed or not. Building the list from employees
    // alone was a chicken-and-egg trap: "Assign employees" lives on a client card,
    // so a client nobody is posted to yet never rendered one and could never be
    // staffed — a brand-new org showed a completely empty page.
    const reconByClient = new Map(recon.map((r) => [r.client_id, r]));
    const out: Group[] = clients.map((c) => ({
      key: `client:${c.id}`,
      label: c.name,
      clientId: c.id,
      hint: c.employee_id_prefix ? `Prefix ${c.employee_id_prefix}` : "",
      rows: byClient.get(c.id) ?? [],
      recon: reconByClient.get(c.id),
    }));
    out.sort((a, b) => a.label.localeCompare(b.label));

    if (office.length)
      out.push({ key: "office", label: "Office Staff", clientId: null, hint: "No client posting", rows: office });
    if (relievers.length)
      out.push({ key: "relievers", label: "Relievers", clientId: null, hint: "Relief pool", rows: relievers });
    let visibleGroups = showServicesClients
      ? out
      : out.filter((g) => !(g.clientId && servicesOnlyClientIds.has(g.clientId)));
    // While searching for a person, empty client cards are just noise.
    if (q) visibleGroups = visibleGroups.filter((g) => g.rows.length > 0);
    if (onlyMismatch) return visibleGroups.filter((g) => g.recon != null && g.recon.variance !== 0);
    return visibleGroups;
  }, [employees, clients, search, showSeparated, recon, onlyMismatch, servicesOnlyClientIds, showServicesClients]);

  // Hiding a client must never make its guards unreachable — this page is the only
  // place their posting and pay can be edited. If a Services-only client somehow
  // has people on it, say so and offer a way back in.
  const strandedOnServices = useMemo(
    () =>
      showServicesClients
        ? 0
        : employees.filter(
            (e) =>
              e.client_id &&
              servicesOnlyClientIds.has(e.client_id) &&
              (showSeparated || !isSeparatedState(e.lifecycle_state)),
          ).length,
    [employees, servicesOnlyClientIds, showServicesClients, showSeparated],
  );

  // Company-wide strength totals — the old Deployment page's stat row.
  const totals = useMemo(
    () =>
      recon
        .filter((r) => showServicesClients || !servicesOnlyClientIds.has(r.client_id))
        .reduce(
        (acc, r) => {
          acc.contracted += r.contracted_billed_qty;
          acc.enrolled += r.enrolled_active;
          acc.sites += r.site_count;
          if (r.variance !== 0) acc.mismatched += 1;
          return acc;
        },
        { contracted: 0, enrolled: 0, sites: 0, mismatched: 0 },
      ),
    [recon, servicesOnlyClientIds, showServicesClients],
  );

  // Anyone with no open client posting: fresh hires, plus office staff who could
  // be moved onto a client. Separated records are never offered.
  const assignable = useMemo(
    () => employees.filter((e) => !e.client_id && !isSeparatedState(e.lifecycle_state)),
    [employees],
  );

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
        "Group", "Sites", "Contracted", "On-ground req.", "Enrolled (active)", "Variance",
        "Code", "Name", "Category", "Client", "Location", "Branch",
        "Department", "Shift", "Base Salary", "Per Day", "Allowance", "Joined", "Status",
      ],
      rows: groups.flatMap((g) =>
        g.rows.map((e) => [
          g.label,
          g.recon?.site_count ?? "",
          g.recon?.contracted_billed_qty ?? "",
          g.recon?.required_on_ground ?? "",
          g.recon?.enrolled_active ?? "",
          g.recon?.variance ?? "",
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
        subtitle="Posting, pay and contracted-vs-enrolled strength by client — edit one guard or the whole group"
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

        <div className="mb-4 flex flex-wrap gap-2">
          {[
            { label: "Contracted (billed)", value: totals.contracted, icon: Building2, tint: "text-brand-600 dark:text-brand-500" },
            { label: "Enrolled (active)", value: totals.enrolled, icon: Users, tint: "text-success-600 dark:text-success-500" },
            { label: "Sites", value: totals.sites, icon: MapPin, tint: "text-muted-foreground" },
            {
              label: "Clients mismatched",
              value: totals.mismatched,
              icon: AlertCircle,
              tint: totals.mismatched > 0 ? "text-warning-600 dark:text-warning-500" : "text-success-600 dark:text-success-500",
            },
            {
              label: "Awaiting a client",
              value: assignable.length,
              icon: UserPlus,
              tint: assignable.length > 0 ? "text-warning-600 dark:text-warning-500" : "text-muted-foreground",
              // Clickable: without a group of their own, this is the ONLY way to
              // open an unassigned employee's record.
              hint: assignable.length > 0 ? "Open the list — edit or assign them" : undefined,
              onClick: assignable.length > 0 ? () => setPoolOpen(true) : undefined,
            },
          ].map((t) => {
            const onClick = "onClick" in t ? (t.onClick as (() => void) | undefined) : undefined;
            const body = (
              <>
                <t.icon className={`w-4 h-4 shrink-0 ${t.tint}`} strokeWidth={2} />
                <span className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</span>
                <span className="text-base font-semibold tabular-nums text-foreground">{t.value}</span>
              </>
            );
            const cls = "inline-flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-card";
            const title = "hint" in t ? (t.hint as string | undefined) : undefined;
            return onClick ? (
              <button
                key={t.label}
                type="button"
                onClick={onClick}
                title={title}
                className={`${cls} text-left transition-colors hover:border-brand-500/50 hover:bg-accent`}
              >
                {body}
              </button>
            ) : (
              <div key={t.label} title={title} className={cls}>{body}</div>
            );
          })}
        </div>

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
          <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap">
            <input type="checkbox" checked={onlyMismatch} onChange={(e) => setOnlyMismatch(e.target.checked)} />
            Only mismatches
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

        {strandedOnServices > 0 && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-warning-600" strokeWidth={2} />
            <span className="flex-1">
              {strandedOnServices} employee{strandedOnServices === 1 ? " is" : "s are"} posted to a
              Services-only client, which this page hides. Their contract bills for equipment, not
              people — either move them to a guard-deployment client or{" "}
              <button
                type="button"
                onClick={() => setShowServicesClients(true)}
                className="font-medium underline"
              >
                show Services clients
              </button>{" "}
              to edit them here.
            </span>
          </div>
        )}
        {showServicesClients && (
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
            <span>Showing Services-only clients — their contracted figures count equipment, not headcount.</span>
            <button
              type="button"
              onClick={() => setShowServicesClients(false)}
              className="font-medium underline"
            >
              Hide again
            </button>
          </div>
        )}

        <p className="mb-3 text-xs text-muted-foreground">
          Variance = contracted − enrolled(active). Positive (amber) = understaffed; negative (red) = over-enrolled.
        </p>

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
                  {g.recon && (
                    <span className="hidden lg:flex items-center gap-3 text-xs text-muted-foreground tabular-nums shrink-0">
                      <span title="Sites">{g.recon.site_count} site{g.recon.site_count === 1 ? "" : "s"}</span>
                      <span title="Contracted (billed) vs enrolled (active)">
                        {g.recon.enrolled_active}/{g.recon.contracted_billed_qty} enrolled
                      </span>
                      <span title="On-ground requirement">req. {g.recon.required_on_ground}</span>
                      <span
                        className={`inline-block px-2 py-0.5 rounded-md border font-medium ${varianceBadge(g.recon.variance)}`}
                        title="Variance = contracted − enrolled(active)"
                      >
                        {g.recon.variance > 0 ? `+${g.recon.variance}` : g.recon.variance}
                      </span>
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">
                    {money(monthly)}/mo
                  </span>
                  {canEdit && g.clientId && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={assignable.length === 0}
                      title={assignable.length === 0 ? "No unassigned employees" : undefined}
                      onClick={() => setAssignToClient({ id: g.clientId!, name: g.label })}
                    >
                      <UserPlus className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                      Assign employees
                    </Button>
                  )}
                  {canEdit && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={g.rows.length === 0}
                      onClick={() => {
                        if (!open) toggleGroup(g.key);
                        setBulkGroup(g);
                      }}
                    >
                      Bulk edit{sel.size > 0 ? ` (${sel.size})` : ""}
                    </Button>
                  )}
                  {canEdit && g.clientId && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={sel.size === 0}
                      title={sel.size === 0 ? "Tick the employees to unassign" : undefined}
                      onClick={() => {
                        if (!open) toggleGroup(g.key);
                        setUnassignFrom({ group: g, rows: g.rows.filter((r) => sel.has(r.id)) });
                      }}
                    >
                      <UserMinus className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                      Unassign{sel.size > 0 ? ` (${sel.size})` : ""}
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
                        {g.rows.length === 0 && (
                          <tr>
                            <td colSpan={12} className="px-4 py-8 text-center text-sm text-muted-foreground">
                              Nobody is posted to this client yet — use “Assign employees” above.
                            </td>
                          </tr>
                        )}
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
          onChangeClient={() => { const t = rowTarget; setRowTarget(null); setChangeClientTarget(t); }}
          onChangeCategory={() => { const t = rowTarget; setRowTarget(null); setChangeCategoryTarget(t); }}
          onChangeShift={() => { const t = rowTarget; setRowTarget(null); setChangeShiftTarget(t); }}
          onError={setError}
        />
      )}

      {assignToClient && (
        <AssignEmployeesModal
          client={assignToClient}
          candidates={assignable}
          contractsForClient={contractsForClient}
          linesForContract={linesForContract}
          addendums={addendums}
          allEmployees={employees}
          onClose={() => setAssignToClient(null)}
          onDone={async (msg) => { setAssignToClient(null); setNotice(msg); await loadData(); }}
          onError={setError}
        />
      )}

      {poolOpen && (
        <PoolModal
          employees={assignable}
          canEdit={canEdit}
          displayCodeFor={displayCodeFor}
          onClose={() => setPoolOpen(false)}
          onEdit={(e) => { setPoolOpen(false); setRowTarget(e); }}
        />
      )}

      {unassignFrom && (
        <UnassignModal
          clientName={unassignFrom.group.label}
          rows={unassignFrom.rows}
          onClose={() => setUnassignFrom(null)}
          onDone={async (msg) => {
            const key = unassignFrom.group.key;
            setUnassignFrom(null);
            setSelected((prev) => ({ ...prev, [key]: new Set<string>() }));
            setNotice(msg);
            await loadData();
          }}
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
  onClose, onSaved, onChangeClient, onChangeCategory, onChangeShift, onError,
}: {
  employee: EmployeeRow;
  canEdit: boolean;
  displayCode: string;
  locations: Location[];
  branches: Branch[];
  clients: Client[];
  onClose: () => void;
  onSaved: () => Promise<void>;
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
              {canEdit && neverPosted && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Assign from the client's card — use its “Assign employees” button.
                </p>
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
// Assign employees to a client — the first posting for people who have none.
//
// Driven from the client, not the employee: you almost always know which client
// is short-staffed, not which particular new hire is idle, so the flow is "pick
// this client's new guards" rather than "find the guard, then pick a client".
//
// This can NOT go through change_client(): that RPC refuses a draft record
// ("must be Ops-verified before being posted"), and a brand-new hire is always
// draft. Hiring has always been the exception — the posting row is written
// directly, which the enforce_posting_requires_ops_verified trigger allows
// because the employee has no prior client. Moving an ALREADY-posted guard is a
// different action ("Change client") and still goes through the RPC.
// ─────────────────────────────────────────────────────────────────────────────
function AssignEmployeesModal({
  client, candidates, contractsForClient, linesForContract, addendums, allEmployees,
  onClose, onDone, onError,
}: {
  client: { id: string; name: string };
  candidates: EmployeeRow[];
  contractsForClient: (clientId: string) => Contract[];
  linesForContract: (contractId: string) => ContractLine[];
  addendums: ContractAddendum[];
  allEmployees: EmployeeRow[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
  onError: (m: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [contractId, setContractId] = useState("");
  const [contractLineId, setContractLineId] = useState("");
  const [startDate, setStartDate] = useState(todayIso());
  const [shift, setShift] = useState("");
  const [baseSalary, setBaseSalary] = useState("");
  const [allowance, setAllowance] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  // Contract → line → how many slots are left. A client can hold several
  // contracts, so the contract has to be chosen before its lines mean anything.
  const clientContracts = contractsForClient(client.id);
  const lines = useMemo(
    () => (contractId ? linesForContract(contractId) : []),
    [contractId, linesForContract],
  );
  const lineCategoryById = useMemo(() => {
    const m = new Map<string, ContractLineCategory>();
    for (const l of lines) m.set(l.id, l.category);
    return m;
  }, [lines]);

  // Committed vs already-filled for a line's CATEGORY, as of the posting start
  // date. Committed counts every line of that category plus any dated addendum
  // in effect, mirroring the contract page's own arithmetic; filled counts the
  // guards active on that category anywhere on the contract.
  const slotFor = useCallback(
    (lineId: string) => {
      const cat = lineCategoryById.get(lineId);
      if (!cat) return null;
      const adds = addendums.filter((a) => a.contract_id === contractId);
      const committed = effectiveCommittedByCategory(lines, adds, startDate).get(cat) ?? 0;
      const onContract = allEmployees.filter((e) => e.contract_id === contractId);
      const filled = activeCountByCategory(onContract, lineCategoryById, startDate).get(cat) ?? 0;
      return { category: cat, committed, filled, available: Math.max(0, committed - filled) };
    },
    [lineCategoryById, addendums, contractId, lines, startDate, allEmployees],
  );

  const slot = contractLineId ? slotFor(contractLineId) : null;
  // No line chosen (or a contract with no lines at all) = no committed headcount
  // to measure against, so nothing to cap.
  const cap = slot ? slot.available : Infinity;
  const atCap = picked.size >= cap;

  // Changing contract or line invalidates a selection sized against the old cap.
  useEffect(() => { setPicked(new Set()); }, [contractId, contractLineId]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (e) =>
        e.full_name.toLowerCase().includes(q) ||
        (e.employee_code ?? "").toLowerCase().includes(q) ||
        (e.guard_code ?? "").toLowerCase().includes(q) ||
        (e.cnic_number ?? "").toLowerCase().includes(q) ||
        (e.phone ?? "").toLowerCase().includes(q),
    );
  }, [candidates, search]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < cap) next.add(id);
      return next;
    });
  const allShownPicked = shown.length > 0 && shown.every((e) => picked.has(e.id));
  const toggleAllShown = () =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (allShownPicked) {
        shown.forEach((e) => next.delete(e.id));
      } else {
        // Fill up to the remaining slots, then stop.
        for (const e of shown) {
          if (next.size >= cap) break;
          next.add(e.id);
        }
      }
      return next;
    });

  const save = async () => {
    const targets = candidates.filter((e) => picked.has(e.id));
    if (targets.length === 0) { setErr("Pick at least one employee."); return; }
    if (!startDate) { setErr("Pick a start date."); return; }
    if (clientContracts.length > 0 && !contractId) { setErr("Choose which contract this posting is under."); return; }
    if (lines.length > 0 && !contractLineId) { setErr("Choose a contract line — it sets the category and its headcount limit."); return; }
    // Re-check against the live figures: the cap also guards the checkboxes, but
    // the committed count can move (an addendum, another operator) between the
    // dialog opening and Assign being pressed.
    if (slot && targets.length > slot.available) {
      setErr(
        `${CONTRACT_LINE_CATEGORY_LABEL[slot.category]}: only ${slot.available} of ` +
        `${slot.committed} slot${slot.committed === 1 ? "" : "s"} free on this contract ` +
        `(${slot.filled} already filled). Raise the committed count with an addendum to post more.`,
      );
      return;
    }
    const base = baseSalary ? Number(baseSalary) : null;
    if (base != null && (isNaN(base) || base <= 0)) {
      setErr("Enter a valid base salary, or leave it blank.");
      return;
    }

    setSaving(true);
    setErr(null);
    setProgress(0);
    try {
      // The client's default site, resolved once for the whole batch.
      const { data: defSite } = await supabase
        .from("sites").select("id")
        .eq("client_id", client.id).eq("is_default", true).maybeSingle();
      const siteId = (defSite as { id?: string } | null)?.id ?? null;

      // Sequential: each employee needs its own posting row, code and salary seed,
      // and a failure part-way must name the person it stopped on.
      for (let i = 0; i < targets.length; i++) {
        const e = targets[i];
        const fail = (m: string) => new Error(`${e.full_name}: ${m}`);

        // Category and shift are plain columns until the first posting exists.
        const { error: upErr } = await supabase
          .from("employees")
          .update({
            category: "client",
            join_date: e.join_date ?? startDate,
            // The slot the guard occupies. activeCountByCategory reads these off
            // the employee row, so without them the next assignment would see the
            // line as still empty and blow past its committed count.
            contract_id: contractId || null,
            contract_line_id: contractLineId || null,
            assignment_effective_from: contractLineId ? startDate : null,
            assignment_effective_to: null,
            ...(shift ? { shift } : {}),
          })
          .eq("id", e.id);
        if (upErr) throw fail(upErr.message);

        // The posting row. Its sync trigger mirrors client_id onto the employee.
        // shift_code MUST be stamped here: it is what makes shift a dated property.
        // Left null, this segment resolves through to the guard's CURRENT shift, so
        // a later shift change would repaint every earlier day with the new shift.
        const { error: depErr } = await supabase.from("deployments").insert({
          guard_id: e.id,
          client_id: client.id,
          contract_line_id: contractLineId || null,
          site_id: siteId,
          start_date: startDate,
          shift_code: shift || e.shift || "day",
          reason: "new_hire",
        });
        if (depErr) throw fail(depErr.message);

        // Permanent GGS-NNNNN (once, at hiring) + the client-scoped display number.
        if (!e.guard_code) {
          const { error: codeErr } = await supabase.rpc("assign_guard_code", { p_employee_id: e.id });
          if (codeErr) throw fail(codeErr.message);
        }
        const { error: dispErr } = await supabase.rpc("assign_display_number", { p_employee_id: e.id });
        if (dispErr) throw fail(dispErr.message);

        // Seed the first salary-history row — the capture trigger only fires on
        // UPDATE, so without this the guard would have no effective-dated pay.
        if (base != null) {
          const { error: salErr } = await supabase.rpc("set_employee_salary", {
            p_employee_id: e.id,
            p_effective_date: startDate,
            p_base_salary: base,
            p_allowance: allowance ? Math.max(0, Number(allowance)) : 0,
            p_per_day_salary: base / daysInCurrentMonth(),
            p_reason: "Initial salary",
          });
          if (salErr) throw fail(salErr.message);
        }
        setProgress(i + 1);
      }
      await onDone(
        `${targets.length} employee${targets.length === 1 ? "" : "s"} assigned to ${client.name}.`,
      );
    } catch (e: any) {
      const m = e.message ?? String(e);
      setErr(progress > 0 ? `${m} — ${progress} already assigned before this failed.` : m);
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
      title={`Assign employees to ${client.name}`}
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {saving ? `Assigning ${progress} / ${picked.size}…` : `${picked.size} selected`}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={saving || picked.size === 0}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              Assign{picked.size > 0 ? ` ${picked.size}` : ""}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <div>
          <h4 className="text-sm font-medium text-foreground mb-2">Which contract</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Contract</label>
              <ThemedSelect
                value={contractId}
                onChange={(e) => { setContractId(e.target.value); setContractLineId(""); }}
                className={inputCls}
                disabled={clientContracts.length === 0}
              >
                <option value="">{clientContracts.length === 0 ? "No contracts on file" : "— Select —"}</option>
                {clientContracts.map((c) => (
                  <option key={c.id} value={c.id}>{c.contract_code} · {c.status}</option>
                ))}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Contract line (category)</label>
              <ThemedSelect
                value={contractLineId}
                onChange={(e) => setContractLineId(e.target.value)}
                className={inputCls}
                disabled={!contractId || lines.length === 0}
              >
                <option value="">
                  {!contractId ? "Pick a contract first" : lines.length === 0 ? "This contract has no lines" : "— Select —"}
                </option>
                {lines.map((l) => {
                  const si = slotFor(l.id);
                  return (
                    <option key={l.id} value={l.id}>
                      {CONTRACT_LINE_CATEGORY_LABEL[l.category]}
                      {l.location ? ` — ${l.location}` : ""}
                      {si ? ` · ${si.filled}/${si.committed} filled` : ""}
                    </option>
                  );
                })}
              </ThemedSelect>
            </div>
          </div>
          {contractId && lines.length === 0 && (
            <p className="text-xs text-warning-700 dark:text-warning-500 mt-2">
              This contract has no category lines, so there is no committed headcount to check against.
              Add lines on the Contracts page to cap postings by category.
            </p>
          )}
          {slot && (
            <p
              className={`text-xs mt-2 ${
                slot.available === 0 ? "text-danger-600 dark:text-danger-500" : "text-muted-foreground"
              }`}
            >
              {CONTRACT_LINE_CATEGORY_LABEL[slot.category]}: {slot.filled} of {slot.committed} committed
              {slot.committed === 1 ? " slot" : " slots"} filled —{" "}
              <span className="font-medium">
                {slot.available} available
              </span>
              {slot.available === 0 && " · free a slot or raise the count with an addendum"}
            </p>
          )}
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <div className="relative flex-1 min-w-52">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, code, CNIC or phone…"
                className={inputCls + " pl-9"}
                autoFocus
              />
            </div>
            {shown.length > 0 && (
              <Button variant="ghost" size="sm" onClick={toggleAllShown} disabled={cap === 0}>
                {allShownPicked ? "Clear" : `Select ${Math.min(shown.length, cap === Infinity ? shown.length : cap)}`}
              </Button>
            )}
          </div>
          {slot && (
            <p className="text-xs text-muted-foreground mb-2">
              {picked.size} of {slot.available} selectable
              {atCap && slot.available > 0 && " — line is full for this posting"}
            </p>
          )}

          <div className="border border-border rounded-md max-h-72 overflow-y-auto">
            {candidates.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                Everyone already has a client. Add someone first from Workforce ▸ Employees.
              </p>
            ) : shown.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                No unassigned employee matches that search.
              </p>
            ) : (
              shown.map((e) => {
                const checked = picked.has(e.id);
                const cat = (e.category ?? "client") as EmployeeCategory;
                const blocked = !checked && atCap;
                return (
                  <label
                    key={e.id}
                    title={blocked ? "No committed slots left on this contract line" : undefined}
                    className={`flex items-center gap-3 px-3 py-2 border-b border-border last:border-0 transition-colors ${
                      checked ? "bg-brand-500/10" : blocked ? "opacity-45 cursor-not-allowed" : "cursor-pointer hover:bg-accent"
                    }`}
                  >
                    <input type="checkbox" checked={checked} disabled={blocked} onChange={() => toggle(e.id)} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-foreground truncate">{e.full_name}</span>
                      <span className="block text-xs text-muted-foreground truncate">
                        {e.guard_code ?? e.employee_code}
                        {e.cnic_number ? ` · ${e.cnic_number}` : ""}
                        {e.phone ? ` · ${e.phone}` : ""}
                      </span>
                    </span>
                    {cat !== "client" && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-border text-muted-foreground shrink-0">
                        {CATEGORY_LABEL[cat]}
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </div>
        </div>

        <div className="pt-4 border-t border-border">
          <h4 className="text-sm font-medium text-foreground mb-1">Applies to everyone selected</h4>
          <p className="text-xs text-muted-foreground mb-3">
            This is each person's first posting, so it also issues their permanent guard code and
            their client number. Pay can be left blank and set later with Bulk edit.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Start date</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Shift</label>
              <ThemedSelect value={shift} onChange={(e) => setShift(e.target.value)} className={inputCls}>
                <option value="">Keep each employee's current shift</option>
                <option value="day">Day</option>
                <option value="evening">Evening</option>
                <option value="night">Night</option>
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Base salary (PKR)</label>
              <input type="number" value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} className={inputCls} placeholder="Leave blank to set later" />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Allowance (PKR)</label>
              <input type="number" min={0} value={allowance} onChange={(e) => setAllowance(e.target.value)} className={inputCls} placeholder="0" />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Unassign — take guards off a client and return them to the pool.
//
// The posting is a dated row, so this CLOSES the open deployment rather than
// deleting it: the guard's history at that client stays intact and attendance
// already recorded against it is untouched. Closing the last open posting makes
// sync_employee_active_client() null employees.client_id and drop the
// client-scoped display number, which is what puts them back in the "awaiting a
// client" pool. The permanent guard code is never reissued.
//
// Ending on a FUTURE date is refused: that trigger keys off "no open posting",
// so a future end_date would drop the guard off the client immediately while
// claiming they stay until then.
// ─────────────────────────────────────────────────────────────────────────────
function UnassignModal({
  clientName, rows, onClose, onDone, onError,
}: {
  clientName: string;
  rows: EmployeeRow[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
  onError: (m: string) => void;
}) {
  const [endDate, setEndDate] = useState(todayIso());
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (rows.length === 0) { setErr("Nobody selected."); return; }
    if (!endDate) { setErr("Pick a last day."); return; }
    if (endDate > todayIso()) {
      setErr("The last day can't be in the future — unassigning takes effect immediately.");
      return;
    }
    setSaving(true);
    setErr(null);
    setProgress(0);
    try {
      for (let i = 0; i < rows.length; i++) {
        const e = rows[i];
        const fail = (m: string) => new Error(`${e.full_name}: ${m}`);

        // Close the open posting. The sync trigger clears client_id + display_number.
        const { data: closed, error: depErr } = await supabase
          .from("deployments")
          .update({ end_date: endDate, reason: "return_to_pool" })
          .eq("guard_id", e.id)
          .is("end_date", null)
          .select("id");
        if (depErr) throw fail(depErr.message);

        // Older records can carry a client_id with no posting row behind it. With
        // nothing to close the trigger never fires, so clear the mirror directly.
        const orphaned = (closed ?? []).length === 0;

        const { error: upErr } = await supabase
          .from("employees")
          .update({
            contract_id: null,
            contract_line_id: null,
            assignment_effective_from: null,
            assignment_effective_to: null,
            ...(orphaned ? { client_id: null, display_number: null } : {}),
          })
          .eq("id", e.id);
        if (upErr) throw fail(upErr.message);
        setProgress(i + 1);
      }
      await onDone(
        `${rows.length} employee${rows.length === 1 ? "" : "s"} unassigned from ${clientName}.`,
      );
    } catch (e: any) {
      const m = e.message ?? String(e);
      setErr(progress > 0 ? `${m} — ${progress} already unassigned before this failed.` : m);
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
      title={`Unassign from ${clientName}`}
      size="sm"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {saving ? `Unassigning ${progress} / ${rows.length}…` : `${rows.length} selected`}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              Unassign {rows.length}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Their time at {clientName} is kept — the posting is closed on the date below, not deleted, so
          past attendance and payroll stay as they were. They return to the pool and can be assigned to
          another client. Their client number is released; the permanent guard code stays.
        </p>

        <div className="border border-border rounded-md max-h-56 overflow-y-auto">
          {rows.map((e) => (
            <div key={e.id} className="px-3 py-2 border-b border-border last:border-0">
              <span className="block text-sm text-foreground truncate">{e.full_name}</span>
              <span className="block text-xs text-muted-foreground truncate">
                {e.guard_code ?? e.employee_code}
                {e.department ? ` · ${e.department}` : ""}
              </span>
            </div>
          ))}
        </div>

        <div>
          <label className="block text-xs text-muted-foreground mb-1">Last day at this client</label>
          <input
            type="date"
            value={endDate}
            max={todayIso()}
            onChange={(e) => setEndDate(e.target.value)}
            className={inputCls}
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Attendance up to and including this date stays attributed to {clientName}.
          </p>
        </div>

        <p className="text-xs text-muted-foreground">
          To end someone's employment altogether, use Fire on the Employees page instead — this only
          removes the client posting.
        </p>
      </div>
    </Modal>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// The unassigned pool.
//
// People with no client posting deliberately have no card of their own — you
// assign from a client, not from a limbo list. But their record still has to be
// reachable: category, shift, location, branch, department and joining date are
// all set here, and for someone never posted, category is an ordinary column
// they can just pick (an already-posted guard changes it through the dated
// change_category flow instead). Without this dialog an unassigned employee had
// no editor at all.
// ─────────────────────────────────────────────────────────────────────────────
function PoolModal({
  employees, canEdit, displayCodeFor, onClose, onEdit,
}: {
  employees: EmployeeRow[];
  canEdit: boolean;
  displayCodeFor: (e: EmployeeRow) => string;
  onClose: () => void;
  onEdit: (e: EmployeeRow) => void;
}) {
  const [search, setSearch] = useState("");

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(
      (e) =>
        e.full_name.toLowerCase().includes(q) ||
        (e.employee_code ?? "").toLowerCase().includes(q) ||
        (e.guard_code ?? "").toLowerCase().includes(q) ||
        (e.cnic_number ?? "").toLowerCase().includes(q) ||
        (e.phone ?? "").toLowerCase().includes(q),
    );
  }, [employees, search]);

  const inputCls = "w-full px-3 py-2 border border-border rounded-md text-sm bg-card";
  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Employees awaiting a client"
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {employees.length} employee{employees.length === 1 ? "" : "s"} with no client posting
          </span>
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          To post them to a client, use that client's <span className="font-medium">Assign employees</span> button —
          it sets the contract line and respects its headcount limit. Edit here to change category
          (Client / Office Staff / Reliever), shift, location, branch, department or joining date first.
        </p>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, code, CNIC or phone…"
            className={inputCls + " pl-9"}
            autoFocus
          />
        </div>

        <div className="border border-border rounded-md max-h-80 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {employees.length === 0
                ? "Everyone has a client."
                : "Nobody matches that search."}
            </p>
          ) : (
            shown.map((e) => {
              const cat = (e.category ?? "client") as EmployeeCategory;
              return (
                <div
                  key={e.id}
                  className="flex items-center gap-3 px-3 py-2 border-b border-border last:border-0 hover:bg-accent transition-colors"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-foreground truncate">{e.full_name}</span>
                    <span className="block text-xs text-muted-foreground truncate">
                      {displayCodeFor(e)}
                      {e.cnic_number ? ` · ${e.cnic_number}` : ""}
                      {e.phone ? ` · ${e.phone}` : ""}
                    </span>
                  </span>
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-border text-muted-foreground shrink-0">
                    {CATEGORY_LABEL[cat]}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => onEdit(e)}>
                    {canEdit ? "Edit" : "View"}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
}
