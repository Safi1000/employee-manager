import { isIsoDate } from "../../lib/date";
import ThemedSelect from "../../components/ThemedSelect";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Calendar as CalendarIcon, AlertCircle, Loader2, X, CalendarRange, ChevronLeft, ChevronRight, Search, Clock, MoreHorizontal, SlidersHorizontal, ChevronDown, Check } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import BulkMarkByEmployeeModal from "../../components/BulkMarkByEmployeeModal";
import { exportAttendance, type AttendanceEmployeeRow } from "../../lib/excel";
import { loadShiftResolver, type ShiftResolver } from "../../lib/shiftOnDate";
import {
  supabase,
  fetchAllRows,
  resolveAllowedLeaves,
  STATUS_LABEL,
  type AttendanceStatus,
  type AttendanceRecord,
  type Client,
  type Branch,
  type Contract,
} from "../../lib/supabase";
import { useRegion, withRegion } from "../../lib/region";
import { hasPermission, useAuth } from "../../lib/auth";
import { guardDisplayCode } from "../../lib/guardCode";
import { attendanceWindowError, isSeparatedState, hiddenFromAttendance, buildClientCoverage, effectiveWindowContract, SEPARATION_MARK } from "../../lib/employmentWindow";
import { formatDate } from "../../lib/date";
import { clearConflictingDayRows } from "../../lib/attendanceDay";

type EmployeeLite = {
  id: string;
  employee_code: string;
  // Phase 2/3: client-prefixed display code (primary) + permanent GGS code.
  display_code: string;
  permanent_code: string;
  full_name: string;
  location_id: string | null;
  location_name: string | null;
  client_id: string | null;
  client_name: string | null;
  contract_id: string | null;
  branch_id: string | null;
  additional_branch_ids: string[];
  shift: "day" | "night";
  category: "client" | "office_staff" | "reliever";
  assignment_effective_from: string | null;
  // Employment window (join → separation) + lifecycle, for gating and for the
  // separation markers in the Excel export.
  join_date: string | null;
  last_working_day: string | null;
  termination_date: string | null;
  lifecycle_state: string | null;
};

type ContractLeaveRow = Pick<
  Contract,
  "id" | "allowed_leaves_per_month" | "start_date" | "end_date" | "is_infinite" | "client_id" | "status"
>;

type HistoryRow = {
  date: string;
  location_name: string | null;
  client_name: string | null;
  present: number;
  absent: number;
  leave: number;
  employees: {
    employee_id: string;
    full_name: string;
    employee_code: string;
    display_code: string;
    status: AttendanceStatus;
  }[];
};

const today = () => new Date().toISOString().slice(0, 10);

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const STATUSES: AttendanceStatus[] = ["present", "absent", "leave"];

type AttendanceManagementProps = { relieversOnly?: boolean };

export default function AttendanceManagement({ relieversOnly = false }: AttendanceManagementProps = {}) {
  const [clients, setClients] = useState<Client[]>([]);
  const [contracts, setContracts] = useState<ContractLeaveRow[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  // Per-date shift resolver over the dated deployment segments (single source of
  // truth). Used so marking on a given date records the shift active THAT date,
  // never the guard's flat current shift.
  const [shiftResolver, setShiftResolver] = useState<ShiftResolver | null>(null);
  const [todayRecords, setTodayRecords] = useState<Record<string, AttendanceStatus>>({});
  // For relievers: per-day client attribution. Mirrors todayRecords.
  const [todayWorkedFor, setTodayWorkedFor] = useState<Record<string, string | null>>({});
  // The worked_shift of the row the daily page is showing for each employee, so a
  // mark/unmark hits that exact row (and doesn't create a duplicate or wipe a
  // sibling shift on a multi-shift day). Absent = mark a fresh row on dayShift.
  const [todayShift, setTodayShift] = useState<Record<string, string>>({});
  // Who marked each employee today (marked_by_user_id) → resolved to a name via
  // profilesById, so the daily list can show "reported by <name>".
  const [todayMarkedBy, setTodayMarkedBy] = useState<Record<string, string | null>>({});
  const [profilesById, setProfilesById] = useState<Record<string, string>>({});
  // Supervisor sign-off per client/site group for the selected date. Keyed by the
  // same group_key we write ("daily:<clientId>" / "daily:cat:<category>").
  const [confirmedGroups, setConfirmedGroups] = useState<Record<string, { by: string; at: string }>>({});
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  // Snapshot of the prior state before a "Mark All Present" bulk action, so it
  // can be undone. `prev` maps employee_id → their status before the action
  // (null = they were unmarked). Cleared once undone or when the date changes.
  const [lastBulk, setLastBulk] = useState<{
    date: string;
    prev: Record<string, AttendanceStatus | null>;
  } | null>(null);
  const [undoing, setUndoing] = useState(false);

  const [date, setDate] = useState<string>(today());
  const [clientFilter, setClientFilter] = useState("all");
  const [shiftFilter, setShiftFilter] = useState<"all" | "day" | "night">("all");
  // Employee category filter (same set as the Employees tab) — e.g. Office Staff only.
  const [categoryFilter, setCategoryFilter] = useState<"all" | "client" | "office_staff" | "reliever">("all");
  const [unmarkedOnly, setUnmarkedOnly] = useState<boolean>(false);
  const [empSearch, setEmpSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount =
    (clientFilter !== "all" ? 1 : 0) +
    (categoryFilter !== "all" ? 1 : 0) +
    (shiftFilter !== "all" ? 1 : 0);
  const [historyFrom, setHistoryFrom] = useState<string>(daysAgo(13));
  const [historyTo, setHistoryTo] = useState<string>(today());

  const [detailRecord, setDetailRecord] = useState<HistoryRow | null>(null);

  const { profile } = useAuth();
  const { regionId } = useRegion();
  const canBulk = hasPermission(profile, "attendance.bulk_mark");

  // ---- Export dialog: which month to export (defaults to the shown date's) ----
  const [exportOpen, setExportOpen] = useState(false);
  const [exportMonth, setExportMonth] = useState<string>(today().slice(0, 7));
  const [exporting, setExporting] = useState(false);

  // ---- Bulk-mark calendar modal (shared BulkMarkByEmployeeModal) ----
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  // Preselected employee when the calendar is opened from a specific row's
  // "Monthly Board" link (null = the modal's own picker chooses).
  const [bulkEmpId, setBulkEmpId] = useState<string | null>(null);

  // Open the shared Bulk-Mark-by-Employee calendar (BulkMarkByEmployeeModal owns
  // its own employee picker, filters, month state and marking logic).
  const openBulkMark = () => { setBulkEmpId(null); setIsBulkOpen(true); };
  // Open it focused on one employee's month (from their attendance row).
  const openMonthlyBoard = (empId: string) => { setBulkEmpId(empId); setIsBulkOpen(true); };

  // ---- Inline employee calendar (read-only swap of metrics area) ----
  const [viewEmployee, setViewEmployee] = useState<EmployeeLite | null>(null);

  // Sprint 3: detail editor for half-day / late / OT (only meaningful when Present).
  const [detailsEmp, setDetailsEmp] = useState<EmployeeLite | null>(null);
  const [detailsForm, setDetailsForm] = useState<{
    half_day: boolean;
    late_arrival: boolean;
    hours_worked: string;
    overtime_hours: string;
  }>({ half_day: false, late_arrival: false, hours_worked: "", overtime_hours: "0" });
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [viewMonth, setViewMonth] = useState<string>(today().slice(0, 7));
  const [viewRecords, setViewRecords] = useState<Map<string, AttendanceStatus>>(new Map());
  const [viewLoading, setViewLoading] = useState(false);

  useEffect(() => {
    if (!viewEmployee) return;
    let cancelled = false;
    (async () => {
      setViewLoading(true);
      const start = `${viewMonth}-01`;
      const [y, m] = viewMonth.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      const end = `${viewMonth}-${String(lastDay).padStart(2, "0")}`;
      const { data } = await supabase
        .from("attendance_records")
        .select("attendance_date, status")
        .eq("employee_id", viewEmployee.id)
        .gte("attendance_date", start)
        .lte("attendance_date", end);
      if (cancelled) return;
      const map = new Map<string, AttendanceStatus>();
      for (const r of (data ?? []) as { attendance_date: string; status: AttendanceStatus }[]) {
        map.set(r.attendance_date, r.status);
      }
      setViewRecords(map);
      setViewLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [viewEmployee, viewMonth]);

  const viewCalendarCells = useMemo(() => {
    const [y, m] = viewMonth.split("-").map(Number);
    const first = new Date(y, m - 1, 1);
    const lastDay = new Date(y, m, 0).getDate();
    const leading = first.getDay();
    const cells: { date: string | null; day: number | null }[] = [];
    for (let i = 0; i < leading; i++) cells.push({ date: null, day: null });
    for (let d = 1; d <= lastDay; d++) {
      const date = `${viewMonth}-${String(d).padStart(2, "0")}`;
      cells.push({ date, day: d });
    }
    while (cells.length % 7 !== 0) cells.push({ date: null, day: null });
    return cells;
  }, [viewMonth]);

  const viewStats = useMemo(() => {
    let p = 0, a = 0, l = 0;
    for (const s of viewRecords.values()) {
      if (s === "present") p++;
      else if (s === "absent") a++;
      else if (s === "leave") l++;
    }
    return { p, a, l };
  }, [viewRecords]);

  const shiftViewMonth = (delta: number) => {
    const [y, m] = viewMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setViewMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const dateInputRef = useRef<HTMLInputElement>(null);
  const fromInputRef = useRef<HTMLInputElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);

  const loadStaticData = async () => {
    const [cliRes, brRes, empRes, ebRes, conRes, profRes] = await Promise.all([
      supabase.from("clients").select("*").order("name"),
      supabase.from("branches").select("*").order("is_head_office", { ascending: false }).order("name"),
      // The employee roster drives the whole attendance grid, so scoping it to
      // the selected region scopes the screen.
      withRegion(
        supabase
          .from("employees")
          .select(
            "id, employee_code, guard_code, display_number, full_name, location_id, client_id, contract_id, branch_id, shift, category, assignment_effective_from, join_date, last_working_day, termination_date, lifecycle_state, location:location_id(name), client:client_id(name, employee_id_prefix)"
          )
          .order("full_name"),
        regionId,
      ),
      supabase.from("employee_branches").select("employee_id, branch_id"),
      // client_id + status feed buildClientCoverage: guards with no contract_id of
      // their own are judged against their CLIENT's contract coverage instead.
      supabase.from("contracts").select("id, allowed_leaves_per_month, start_date, end_date, is_infinite, client_id, status"),
      supabase.from("profiles").select("id, full_name, email"),
    ]);
    if (cliRes.error) setError(cliRes.error.message);
    if (brRes.error) setError(brRes.error.message);
    if (empRes.error) setError(empRes.error.message);
    if (ebRes.error) setError(ebRes.error.message);
    if (conRes.error) setError(conRes.error.message);
    setClients(cliRes.data ?? []);
    setBranches((brRes.data ?? []) as Branch[]);
    setContracts((conRes.data ?? []) as ContractLeaveRow[]);
    const pmap: Record<string, string> = {};
    for (const p of (profRes.data ?? []) as { id: string; full_name: string | null; email: string | null }[]) {
      pmap[p.id] = p.full_name ?? p.email ?? "—";
    }
    setProfilesById(pmap);
    const addlMap = new Map<string, string[]>();
    for (const r of (ebRes.data ?? []) as { employee_id: string; branch_id: string }[]) {
      const arr = addlMap.get(r.employee_id) ?? [];
      arr.push(r.branch_id);
      addlMap.set(r.employee_id, arr);
    }
    setEmployees(
      (empRes.data ?? []).map((e: any) => ({
        id: e.id,
        employee_code: e.employee_code,
        display_code: guardDisplayCode(e, e.client?.employee_id_prefix),
        permanent_code: e.guard_code ?? e.employee_code,
        full_name: e.full_name,
        location_id: e.location_id,
        location_name: e.location?.name ?? null,
        client_id: e.client_id,
        client_name: e.client?.name ?? null,
        contract_id: e.contract_id ?? null,
        branch_id: e.branch_id ?? null,
        additional_branch_ids: addlMap.get(e.id) ?? [],
        shift: e.shift,
        category: e.category,
        assignment_effective_from: e.assignment_effective_from ?? null,
        join_date: e.join_date ?? null,
        last_working_day: e.last_working_day ?? null,
        termination_date: e.termination_date ?? null,
        lifecycle_state: e.lifecycle_state ?? null,
      }))
    );
  };

  const loadRecordsForDate = async (d: string) => {
    const { data, error: err } = await supabase
      .from("attendance_records")
      .select("employee_id, status, worked_for_client_id, worked_shift, marked_by_user_id")
      .eq("attendance_date", d);
    if (err) {
      setError(err.message);
      return;
    }
    // Supervisor sign-offs for this date (namespaced group_key so they never
    // collide with the Attendance board's per-shift confirmation rows).
    const { data: confs } = await supabase
      .from("attendance_confirmations")
      .select("group_key, supervisor_name, confirmed_at")
      .eq("attendance_date", d)
      .like("group_key", "daily:%");
    const confMap: Record<string, { by: string; at: string }> = {};
    for (const c of (confs ?? []) as { group_key: string; supervisor_name: string; confirmed_at: string }[]) {
      confMap[c.group_key] = { by: c.supervisor_name, at: c.confirmed_at };
    }
    setConfirmedGroups(confMap);
    // A date can carry more than one shift row (a guard on two shifts). The daily
    // page marks ONE shift — the dated-segment shift (dayShift) — so it must also
    // READ that same shift's row, otherwise it would show a sibling shift's status
    // while a mark quietly overwrote a different row. Pick the dayShift row per
    // employee (fall back to any row for legacy data), keeping daily in step with
    // the month calendar and board, which key per worked_shift.
    const rowsByEmp = new Map<string, any[]>();
    (data ?? []).forEach((r: any) => {
      const list = rowsByEmp.get(r.employee_id);
      if (list) list.push(r);
      else rowsByEmp.set(r.employee_id, [r]);
    });
    const shiftForDate = (empId: string): string =>
      (shiftResolver ? shiftResolver(empId, d) : null) ??
      employees.find((e) => e.id === empId)?.shift ??
      "day";
    const statusMap: Record<string, AttendanceStatus> = {};
    const clientMap: Record<string, string | null> = {};
    const shiftMap: Record<string, string> = {};
    const markedByMap: Record<string, string | null> = {};
    for (const [empId, rows] of rowsByEmp) {
      const want = shiftForDate(empId);
      const chosen = rows.find((r) => r.worked_shift === want) ?? rows[0];
      statusMap[empId] = chosen.status;
      clientMap[empId] = chosen.worked_for_client_id ?? null;
      shiftMap[empId] = chosen.worked_shift ?? want;
      markedByMap[empId] = chosen.marked_by_user_id ?? null;
    }
    setTodayRecords(statusMap);
    setTodayWorkedFor(clientMap);
    setTodayShift(shiftMap);
    setTodayMarkedBy(markedByMap);
  };

  const loadHistory = async () => {
    try {
      const rows = await fetchAllRows<AttendanceRecord>(() =>
        supabase
          .from("attendance_records")
          .select("employee_id, attendance_date, status")
          .gte("attendance_date", historyFrom)
          .lte("attendance_date", historyTo)
          .order("attendance_date", { ascending: false }) as unknown as {
          range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
        },
      );
      setHistory(buildHistoryRows(rows));
    } catch (err: any) {
      setError(err.message ?? String(err));
    }
  };

  const buildHistoryRows = (rows: AttendanceRecord[]): HistoryRow[] => {
    const byDate: Record<string, HistoryRow[]> = {};
    for (const r of rows) {
      const emp = employees.find((e) => e.id === r.employee_id);
      if (!emp) continue;
      if (clientFilter !== "all" && emp.client_id !== clientFilter) continue;
      if (shiftFilter !== "all" && emp.shift !== shiftFilter) continue;
      const groupKey = `${r.attendance_date}|${emp.location_id ?? "none"}|${emp.client_id ?? "none"}`;
      const list = (byDate[r.attendance_date] ??= []);
      let row = list.find(
        (x) =>
          x.location_name === (emp.location_name ?? null) &&
          x.client_name === (emp.client_name ?? null)
      );
      if (!row) {
        row = {
          date: r.attendance_date,
          location_name: emp.location_name ?? null,
          client_name: emp.client_name ?? null,
          present: 0,
          absent: 0,
          leave: 0,
          employees: [],
        };
        list.push(row);
      }
      if (r.status === "present") row.present++;
      else if (r.status === "absent") row.absent++;
      else row.leave++;
      row.employees.push({
        employee_id: emp.id,
        full_name: emp.full_name,
        employee_code: emp.employee_code,
        display_code: emp.display_code,
        status: r.status,
      });
      // unused groupKey, keep logic simple
      void groupKey;
    }
    const out: HistoryRow[] = [];
    Object.keys(byDate)
      .sort((a, b) => (a < b ? 1 : -1))
      .forEach((k) => out.push(...byDate[k]));
    return out;
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      await loadStaticData();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId]);

  useEffect(() => {
    loadRecordsForDate(date);
  }, [date]);

  useEffect(() => {
    if (employees.length === 0) { setShiftResolver(null); return; }
    let cancelled = false;
    (async () => {
      const resolver = await loadShiftResolver(employees.map((e) => e.id));
      if (!cancelled) setShiftResolver(() => resolver);
    })();
    return () => { cancelled = true; };
  }, [employees]);

  useEffect(() => {
    if (employees.length === 0) return;
    loadHistory();
  }, [historyFrom, historyTo, employees, clientFilter, shiftFilter]);

  const filteredEmployees = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    return employees.filter((e) => {
      // Reliever panel only shows relievers; main panel hides them.
      // Separated guards drop off the roster from their last working day onward
      // (shown up to it so final days can still be marked) — no locked row.
      if (hiddenFromAttendance(e, date)) return false;
      if (relieversOnly && e.category !== "reliever") return false;
      if (!relieversOnly && e.category === "reliever") return false;
      if (clientFilter !== "all" && e.client_id !== clientFilter) return false;
      if (shiftFilter !== "all" && e.shift !== shiftFilter) return false;
      if (categoryFilter !== "all" && e.category !== categoryFilter) return false;
      if (unmarkedOnly && todayRecords[e.id]) return false;
      if (q && !e.full_name.toLowerCase().includes(q) && !e.employee_code.toLowerCase().includes(q) && !e.display_code.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [employees, clientFilter, shiftFilter, categoryFilter, unmarkedOnly, todayRecords, empSearch, relieversOnly, date]);

  // Why `d` isn't markable for this employee, or null. Employment window ∩
  // contract window — mirrored by the DB trigger in migration 0152, so this is
  // a friendlier restatement of a rule the database enforces on every path.
  // Guards attached to a client but not to a specific contract row fall back to
  // that client's contract coverage, so attendance stops being markable once the
  // client's contract has ended — not only when the guard's own contract has.
  const contractById = useMemo(
    () => new Map(contracts.map((c) => [c.id, c])),
    [contracts],
  );
  const clientCoverage = useMemo(() => buildClientCoverage(contracts), [contracts]);

  const windowBlockFor = (e: EmployeeLite, d: string): string | null =>
    attendanceWindowError(e, effectiveWindowContract(e, contractById, clientCoverage), d);

  // "Fired 10/03/2026" / "Resigned 01/04/2026" — null for anyone still employed.
  // Dated off termination_date (the day the separation took effect), falling
  // back to the last working day for legacy records that only carry that.
  const separationNoteFor = (e: EmployeeLite): string | null => {
    if (!isSeparatedState(e.lifecycle_state)) return null;
    const on = e.termination_date ?? e.last_working_day;
    const label =
      e.lifecycle_state === "left"
        ? "Resigned / left"
        : e.lifecycle_state === "absconded"
          ? "Absconded"
          : "Fired";
    return on ? `${label} ${formatDate(on)}` : label;
  };

  // Shift active for an employee on the currently-selected date, from the dated
  // deployment segment (falls back to the flat shift only until the resolver
  // loads / for dates before the first posting).
  const dayShift = (employeeId: string): string =>
    (shiftResolver ? shiftResolver(employeeId, date) : null) ??
    employees.find((e) => e.id === employeeId)?.shift ??
    "day";

  const markStatus = async (
    employeeId: string,
    status: AttendanceStatus,
    workedForClientId?: string | null,
  ) => {
    const employee = employees.find((e) => e.id === employeeId);
    const isReliever = employee?.category === "reliever";
    // Relievers marked Present must have a client picked.
    if (isReliever && status === "present" && !workedForClientId) {
      setError("Pick which client this reliever worked for before marking Present.");
      return;
    }
    // No future attendance (same rule as the board).
    if (date > today()) {
      setError("Future dates can't be marked.");
      return;
    }
    // Employment + contract window. The DB trigger (0152) rejects these anyway;
    // checking here turns a raw Postgres error into a readable reason.
    const windowErr = employee ? windowBlockFor(employee, date) : null;
    if (windowErr) {
      setError(`${employee?.full_name ?? "This employee"}: ${windowErr}`);
      return;
    }
    // Update the row the page is showing (if any); otherwise a fresh mark lands
    // on the dated-segment shift. Keeps daily on the same worked_shift row the
    // month calendar / board key on — no duplicate, no sibling-shift clobber.
    const shift = todayShift[employeeId] ?? dayShift(employeeId);
    setSaving((s) => ({ ...s, [employeeId]: true }));
    setError(null);
    const prevStatus = todayRecords[employeeId];
    const prevClient = todayWorkedFor[employeeId] ?? null;
    setTodayRecords((m) => ({ ...m, [employeeId]: status }));
    setTodayShift((m) => ({ ...m, [employeeId]: shift }));
    setTodayMarkedBy((m) => ({ ...m, [employeeId]: profile?.id ?? null }));
    setTodayWorkedFor((m) => ({
      ...m,
      [employeeId]: status === "present" ? workedForClientId ?? null : null,
    }));
    // A leave is the whole day and must replace it, not join it (0393).
    try {
      await clearConflictingDayRows([{ employee_id: employeeId, attendance_date: date, status }]);
    } catch (e) {
      setSaving((s) => { const n = { ...s }; delete n[employeeId]; return n; });
      setError((e as { message?: string }).message ?? "Could not clear the existing marks on that day.");
      return;
    }
    const { error: upErr } = await supabase
      .from("attendance_records")
      .upsert(
        {
          employee_id: employeeId,
          attendance_date: date,
          status,
          scheduled_shift: shift,
          worked_shift: shift,
          worked_for_client_id: status === "present" ? workedForClientId ?? null : null,
          // Record who reported this mark, so the daily list can show it.
          marked_by_user_id: profile?.id ?? null,
          marked_at: new Date().toISOString(),
        },
        { onConflict: "employee_id,attendance_date,worked_shift" }
      );
    setSaving((s) => {
      const n = { ...s };
      delete n[employeeId];
      return n;
    });
    if (upErr) {
      setError(upErr.message);
      setTodayRecords((m) => {
        const n = { ...m };
        if (prevStatus) n[employeeId] = prevStatus;
        else delete n[employeeId];
        return n;
      });
      setTodayWorkedFor((m) => ({ ...m, [employeeId]: prevClient }));
      return;
    }
    loadHistory();
  };

  // Clear a single employee's mark for the selected date (delete the row).
  const unmarkStatus = async (employeeId: string) => {
    const prevStatus = todayRecords[employeeId];
    if (!prevStatus) return;
    const prevClient = todayWorkedFor[employeeId] ?? null;
    const prevShift = todayShift[employeeId] ?? dayShift(employeeId); // capture before optimistic clear
    setSaving((s) => ({ ...s, [employeeId]: true }));
    setError(null);
    // optimistic removal
    setTodayRecords((m) => {
      const n = { ...m };
      delete n[employeeId];
      return n;
    });
    setTodayWorkedFor((m) => {
      const n = { ...m };
      delete n[employeeId];
      return n;
    });
    // Normally delete only the shift this page manages — a multi-shift day's
    // sibling row (e.g. a night mark made on the board/calendar) must survive a
    // daily unmark.
    //
    // A DOUBLE DUTY is the exception, and it has to be: it is two rows that are
    // only meaningful together (0395), so removing one leg would leave half a
    // double duty — which the database refuses at commit, and rightly. Unmarking
    // one shift of a double duty means unmarking the day.
    const wasDoubleDuty = prevStatus === "double_duty";
    let del = supabase
      .from("attendance_records")
      .delete()
      .eq("employee_id", employeeId)
      .eq("attendance_date", date);
    if (!wasDoubleDuty) del = del.eq("worked_shift", prevShift);
    const { error: delErr } = await del;
    setSaving((s) => {
      const n = { ...s };
      delete n[employeeId];
      return n;
    });
    if (delErr) {
      setError(delErr.message);
      // roll back
      setTodayRecords((m) => ({ ...m, [employeeId]: prevStatus }));
      setTodayWorkedFor((m) => ({ ...m, [employeeId]: prevClient }));
      return;
    }
    loadHistory();
  };

  // Sprint 3: open the half-day / late / OT editor for a given employee on the
  // currently-selected date. Loads any existing detail values from the
  // attendance_records row.
  const openDetailsEditor = async (employee: EmployeeLite) => {
    setDetailsEmp(employee);
    const { data } = await supabase
      .from("attendance_records")
      .select("half_day, late_arrival, hours_worked, overtime_hours")
      .eq("employee_id", employee.id)
      .eq("attendance_date", date)
      .maybeSingle();
    setDetailsForm({
      half_day: !!data?.half_day,
      late_arrival: !!data?.late_arrival,
      hours_worked: data?.hours_worked != null ? String(data.hours_worked) : "",
      overtime_hours: data?.overtime_hours != null ? String(data.overtime_hours) : "0",
    });
  };

  const saveDetails = async () => {
    if (!detailsEmp) return;
    setDetailsSaving(true);
    const { error: upErr } = await supabase
      .from("attendance_records")
      .update({
        half_day: detailsForm.half_day,
        late_arrival: detailsForm.late_arrival,
        hours_worked: detailsForm.hours_worked === "" ? null : Number(detailsForm.hours_worked),
        overtime_hours: Number(detailsForm.overtime_hours) || 0,
      })
      .eq("employee_id", detailsEmp.id)
      .eq("attendance_date", date);
    setDetailsSaving(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setDetailsEmp(null);
  };

  const markAllPresent = async () => {
    if (filteredEmployees.length === 0) return;
    // No future attendance (same rule as the board).
    if (date > today()) {
      setError("Future dates can't be marked.");
      return;
    }
    // Mark-all skips relievers without a picked client (each must be set
    // individually so attribution stays correct).
    const skipped: string[] = [];
    const outsideWindow: string[] = [];
    const payload = filteredEmployees
      .filter((e) => {
        // Don't mark before the assignment's effective_from (same gate as the
        // per-row buttons). Null effective_from is left ungated.
        if (e.assignment_effective_from && date < e.assignment_effective_from) {
          return false;
        }
        // Silently skip anyone outside their employment/contract window — one
        // separated guard in the list must not fail the whole batch on the
        // trigger (0152).
        if (windowBlockFor(e, date)) {
          outsideWindow.push(e.full_name);
          return false;
        }
        if (e.category === "reliever" && !todayWorkedFor[e.id]) {
          skipped.push(e.full_name);
          return false;
        }
        return true;
      })
      .map((e) => {
        // Update the row already on screen (if any) rather than spawning a second
        // shift row — same rule as the per-row mark.
        const shift = todayShift[e.id] ?? dayShift(e.id);
        return {
          employee_id: e.id,
          attendance_date: date,
          status: "present" as AttendanceStatus,
          scheduled_shift: shift,
          worked_shift: shift,
          worked_for_client_id:
            e.category === "reliever" ? todayWorkedFor[e.id] ?? null : null,
          marked_by_user_id: profile?.id ?? null,
          marked_at: new Date().toISOString(),
        };
      });
    if (payload.length === 0) {
      setError(
        outsideWindow.length > 0
          ? `Nothing marked — all ${outsideWindow.length} visible row${outsideWindow.length === 1 ? " is" : "s are"} outside their employment or contract window for this date.`
          : "All visible rows are relievers without a picked client. Set their client first.",
      );
      return;
    }
    // Capture the prior status of every affected row so the action can be
    // undone (null = the employee was unmarked before this action).
    const snapshot: Record<string, AttendanceStatus | null> = {};
    payload.forEach((r) => {
      snapshot[r.employee_id] = todayRecords[r.employee_id] ?? null;
    });
    const optimistic: Record<string, AttendanceStatus> = { ...todayRecords };
    payload.forEach((r) => {
      optimistic[r.employee_id] = "present";
    });
    setTodayRecords(optimistic);
    setTodayMarkedBy((m) => {
      const n = { ...m };
      payload.forEach((r) => { n[r.employee_id] = profile?.id ?? null; });
      return n;
    });
    // Bulk "mark present" must clear any leave already standing on those days —
    // a present beside a leave is the contradiction 0393 refuses.
    try {
      await clearConflictingDayRows(payload);
    } catch (e) {
      setError((e as { message?: string }).message ?? "Could not clear the existing marks on that day.");
      await loadRecordsForDate(date);
      return;
    }
    const { error: upErr } = await supabase
      .from("attendance_records")
      .upsert(payload, { onConflict: "employee_id,attendance_date,worked_shift" });
    if (upErr) {
      setError(upErr.message);
      await loadRecordsForDate(date);
      return;
    }
    setLastBulk({ date, prev: snapshot });
    // One audit entry for the bulk action (attendance_bulk_events, 0069).
    // Best-effort: a logging failure must not break the mark itself.
    await supabase.from("attendance_bulk_events").insert({
      action: "mark_all_present",
      attendance_date: date,
      affected_count: payload.length,
    });
    const notes: string[] = [];
    if (skipped.length > 0) {
      notes.push(
        `${skipped.length} reliever${skipped.length === 1 ? "" : "s"} without a picked client: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}`,
      );
    }
    if (outsideWindow.length > 0) {
      notes.push(
        `${outsideWindow.length} outside their employment/contract window: ${outsideWindow.slice(0, 3).join(", ")}${outsideWindow.length > 3 ? "…" : ""}`,
      );
    }
    if (notes.length > 0) setError(`Skipped — ${notes.join("; ")}.`);
    loadHistory();
  };

  const undoMarkAll = async () => {
    if (!lastBulk || lastBulk.date !== date) return;
    setUndoing(true);
    setError(null);
    const entries = Object.entries(lastBulk.prev);
    // Rows that had a prior status get that status written back; rows that were
    // previously unmarked get their record for this date removed.
    const toRestore = entries
      .filter(([, prev]) => prev !== null)
      .map(([employee_id, prev]) => {
        const shift = todayShift[employee_id] ?? dayShift(employee_id);
        return {
          employee_id,
          attendance_date: lastBulk.date,
          status: prev as AttendanceStatus,
          scheduled_shift: shift,
          worked_shift: shift,
        };
      });
    const toDelete = entries
      .filter(([, prev]) => prev === null)
      .map(([employee_id]) => employee_id);

    if (toRestore.length > 0) {
      const { error: rErr } = await supabase
        .from("attendance_records")
        .upsert(toRestore, { onConflict: "employee_id,attendance_date,worked_shift" });
      if (rErr) {
        setError(rErr.message);
        setUndoing(false);
        await loadRecordsForDate(date);
        return;
      }
    }
    if (toDelete.length > 0) {
      // Delete ONLY the shift mark-all created for each employee, so a sibling
      // shift row (from the board/calendar) survives the undo. Grouped by shift
      // value → at most a couple of queries, not one per employee.
      const byShift = new Map<string, string[]>();
      for (const empId of toDelete) {
        const sh = todayShift[empId] ?? dayShift(empId);
        const list = byShift.get(sh);
        if (list) list.push(empId);
        else byShift.set(sh, [empId]);
      }
      for (const [sh, emps] of byShift) {
        const { error: dErr } = await supabase
          .from("attendance_records")
          .delete()
          .eq("attendance_date", lastBulk.date)
          .in("employee_id", emps)
          .eq("worked_shift", sh);
        if (dErr) {
          setError(dErr.message);
          setUndoing(false);
          await loadRecordsForDate(date);
          return;
        }
      }
    }
    // One audit entry for the undo (attendance_bulk_events, 0069). Best-effort.
    await supabase.from("attendance_bulk_events").insert({
      action: "undo_mark_all_present",
      attendance_date: lastBulk.date,
      affected_count: entries.length,
    });
    setLastBulk(null);
    setUndoing(false);
    await loadRecordsForDate(date);
    loadHistory();
  };

  const stats = useMemo(() => {
    let p = 0,
      a = 0,
      l = 0,
      unm = 0;
    filteredEmployees.forEach((e) => {
      const s = todayRecords[e.id];
      if (s === "present") p++;
      else if (s === "absent") a++;
      else if (s === "leave") l++;
      else unm++;
    });
    return { p, a, l, unm };
  }, [filteredEmployees, todayRecords]);

  // ── Report → confirm, grouped by client/site ──────────────────────────────
  // Each client (or a "no client" category bucket) is a group. A group is
  // "X/Y reported" — X employees marked of Y in the group — and a supervisor
  // signs it off once all are reported.
  const groupKeyOf = (e: EmployeeLite): string =>
    e.client_id ? `daily:${e.client_id}` : `daily:cat:${e.category}`;
  const catLabel = (c: string) => c.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

  const groupedEmployees = useMemo(() => {
    const groups = new Map<string, { key: string; clientId: string | null; category: string; label: string; employees: EmployeeLite[] }>();
    for (const e of filteredEmployees) {
      const key = groupKeyOf(e);
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          clientId: e.client_id,
          category: e.category,
          label: e.client_name ?? `${catLabel(e.category)} (no client)`,
          employees: [],
        };
        groups.set(key, g);
      }
      g.employees.push(e);
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [filteredEmployees]);

  // Confirm one client/site group for the selected date (supervisor sign-off).
  const confirmGroup = async (g: { key: string; clientId: string | null; category: string }) => {
    if (!profile) return;
    setConfirmingKey(g.key);
    setError(null);
    const nowIso = new Date().toISOString();
    const supName = profile.full_name ?? profile.email ?? "—";
    const { error: cErr } = await supabase.from("attendance_confirmations").upsert(
      {
        group_key: g.key,
        shift_code: "all",
        attendance_date: date,
        client_id: g.clientId,
        category: g.clientId ? null : g.category,
        supervisor_name: supName,
        source: "manual",
        confirmed_by: profile.id,
        confirmed_at: nowIso,
      },
      { onConflict: "company_id,group_key,shift_code,attendance_date" },
    );
    setConfirmingKey(null);
    if (cErr) {
      setError(cErr.message);
      return;
    }
    setConfirmedGroups((m) => ({ ...m, [g.key]: { by: supName, at: nowIso } }));
  };

  // `month` is a YYYY-MM key chosen in the export dialog — the export is no
  // longer tied to whichever day the timesheet happens to be showing.
  const handleExport = async (month: string) => {
    const [yStr, mStr] = month.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    const monthStart = `${yStr}-${mStr}-01`;
    const dim = new Date(y, m, 0).getDate();
    const monthEnd = `${yStr}-${mStr}-${String(dim).padStart(2, "0")}`;
    const monthLabel = new Date(y, m - 1, 1).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });

    const empIds = filteredEmployees.map((e) => e.id);
    if (empIds.length === 0) return;

    let records: any[] = [];
    try {
      records = await fetchAllRows<any>(() =>
        supabase
          .from("attendance_records")
          .select("employee_id, attendance_date, status, worked_shift")
          .gte("attendance_date", monthStart)
          .lte("attendance_date", monthEnd)
          .in("employee_id", empIds)
          .order("attendance_date", { ascending: true }) as unknown as {
          range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
        },
      );
    } catch (err: any) {
      setError(err.message ?? String(err));
      return;
    }

    // Per day: the P/A/L symbol AND the shift the guard actually worked that day
    // (worked_shift on the row — so a day guard who covered one night lands under
    // N for that day). Status is normalized across the legacy (Present/Absent/
    // Leave) and spec (present/absent/rotation_leave/…) vocabularies.
    const symbolOf = (raw: unknown): "P" | "A" | "L" | "DD" | "" => {
      const s = String(raw ?? "").toLowerCase();
      // Double duty keeps its own symbol so the sheet shows the second shift.
      if (s === "double_duty") return "DD";
      if (s === "present" || s === "relief_cover") return "P";
      if (s === "absent") return "A";
      if (s === "leave" || s === "rotation_leave" || s === "rest_day") return "L";
      return "";
    };
    const byEmp = new Map<string, Map<number, { sym: string; ws: string }>>();
    for (const r of records ?? []) {
      const day = Number(String(r.attendance_date).slice(8, 10));
      if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, new Map());
      byEmp.get(r.employee_id)!.set(day, {
        sym: symbolOf(r.status),
        ws: (r.worked_shift as string) ?? "day",
      });
    }

    // Per-date shift from the dated posting segments. employees.shift is only the
    // CURRENT shift, so using it for unmarked days back-dates a shift change over
    // the whole month — a guard who moved to nights on the 15th would read as
    // nights from the 1st. Loaded fresh here rather than reusing the component's
    // resolver, which may not have settled yet when the export is triggered.
    const resolveShift = await loadShiftResolver(empIds);

    // Leave allowance comes from the employee's contract, falling back to their client
    // for records predating the move of this setting onto contracts.
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const contractById = new Map(contracts.map((c) => [c.id, c]));

    // filteredEmployees is gated on the SELECTED DAY, which is the wrong window
    // for a month export: sitting on a July date and exporting August carried
    // guards who had already left in July into the August sheet. Re-gate on the
    // first of the exported month — a guard separated before the month started
    // is off the sheet entirely, while one who left mid-month still appears (his
    // worked days are real) with X from the separation onward.
    const monthRoster = filteredEmployees.filter(
      (emp) => !hiddenFromAttendance(emp, monthStart),
    );

    const rows: AttendanceEmployeeRow[] = monthRoster.map((emp, idx) => {
      const dayMap = byEmp.get(emp.id) ?? new Map<number, { sym: string; ws: string }>();
      const statusByDay: string[] = [];
      const shiftByDay: string[] = [];
      let p = 0;
      let a = 0;
      let l = 0;
      let dd = 0;
      for (let d = 1; d <= dim; d += 1) {
        const cell = dayMap.get(d);
        const iso = `${yStr}-${mStr}-${String(d).padStart(2, "0")}`;
        // No record AND not employed that day → "X" rather than a blank, so a
        // guard who was fired mid-month reads as separated, not unmarked.
        // A real record always wins: historical data is reported as-is.
        const sym = cell?.sym ?? (windowBlockFor(emp, iso) ? SEPARATION_MARK : "");
        statusByDay.push(sym);
        // A double-duty day is still one day present; dd counts the extra duty.
        if (sym === "P") p += 1;
        else if (sym === "DD") { p += 1; dd += 1; }
        else if (sym === "A") a += 1;
        else if (sym === "L") l += 1;
        // The shift column follows the shift actually worked that day, falling
        // back to the shift the guard was rostered on for THAT date. Real shift
        // code (day/night/evening/…) — the exporter builds columns from these.
        const ws = cell?.ws ?? resolveShift(emp.id, iso);
        shiftByDay.push(ws || "day");
      }
      const allowed = resolveAllowedLeaves(
        emp.contract_id ? contractById.get(emp.contract_id) : null,
        emp.client_id ? clientById.get(emp.client_id) : null,
      );
      const countableLeaves = Math.min(l, allowed);
      const payDays = p + countableLeaves;
      return {
        serial: idx + 1,
        name: emp.full_name,
        designation: "",
        empCode: emp.display_code,
        // Fallback only (shiftByDay is always supplied); take it from the first of
        // the month rather than "now".
        shift: resolveShift(emp.id, monthStart) || "day",
        shiftByDay,
        statusByDay,
        presents: p,
        absents: a,
        leaves: l,
        doubleDuties: dd,
        payDays,
        separationNote: separationNoteFor(emp),
      };
    });

    const clientLabel =
      clientFilter !== "all"
        ? clients.find((c) => c.id === clientFilter)?.name ?? undefined
        : undefined;

    exportAttendance({
      monthLabel,
      daysInMonth: dim,
      clientLabel,
      rows,
      fileName: `Attendance ${monthLabel}.xlsx`,
    });
  };

  return (
    <>
      <Header
        title={relieversOnly ? "Reliever Attendance" : "Attendance Timesheet (corrections)"}
        subtitle={
          relieversOnly
            ? "Pick the client a reliever covered, then mark present"
            : "Daily attendance, bulk marking and historical timesheet"
        }
        actions={
          <>
            {canBulk && (
              <Button variant="secondary" size="md" onClick={openBulkMark}>
                <CalendarRange className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Bulk Mark by Employee
              </Button>
            )}
            <ExportButton
              onExport={() => {
                setExportMonth(date.slice(0, 7));
                setExportOpen(true);
              }}
            />
          </>
        }
      />

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
        {/* Phase 6 §8.8: this page is now the CORRECTION-only Timesheet (reached
            from a guard's History tab). Daily marking lives on the Attendance
            board. The Shift Override tab and Mark-All-Present are removed. */}
        <div className="mb-6 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-md px-3 py-2">
          Correction tool — for backfilling or fixing past attendance. Daily marking is done on the Attendance board.
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Metrics row OR per-employee calendar */}
        {!viewEmployee ? (
          /* Compact summary bar — clear at a glance, minimal footprint. */
          <div className="flex flex-wrap items-center gap-2 mb-6">
            <div className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-card">
              <span className="w-2.5 h-2.5 rounded-full bg-success-500 shrink-0" />
              <span className="text-xs text-muted-foreground">Present</span>
              <span className="text-base font-semibold tabular-nums text-success-700 dark:text-success-500">{stats.p}</span>
            </div>
            <div className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-card">
              <span className="w-2.5 h-2.5 rounded-full bg-danger-500 shrink-0" />
              <span className="text-xs text-muted-foreground">Absent</span>
              <span className="text-base font-semibold tabular-nums text-danger-700 dark:text-danger-500">{stats.a}</span>
            </div>
            <div className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-card">
              <span className="w-2.5 h-2.5 rounded-full bg-warning-500 shrink-0" />
              <span className="text-xs text-muted-foreground">Leave</span>
              <span className="text-base font-semibold tabular-nums text-warning-700 dark:text-warning-500">{stats.l}</span>
            </div>
            {/* §28.2: unmarked silently underpays — keep it dominant (red) and clickable. */}
            <button
              type="button"
              onClick={() => setUnmarkedOnly((v) => !v)}
              title="Show only unmarked"
              className={`inline-flex items-center gap-2.5 px-3.5 py-2 rounded-lg border transition-colors ${
                stats.unm > 0
                  ? "bg-danger-50 border-danger-200 hover:bg-danger-100"
                  : "bg-card border-border hover:bg-accent"
              } ${unmarkedOnly ? "ring-2 ring-danger-500" : ""}`}
            >
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${stats.unm > 0 ? "bg-danger-500" : "bg-success-500"}`} />
              <span className="text-xs text-muted-foreground">Unmarked</span>
              <span className={`text-base font-semibold tabular-nums ${stats.unm > 0 ? "text-danger-700 dark:text-danger-500" : "text-success-700 dark:text-success-500"}`}>{stats.unm}</span>
              <span className="text-[10px] text-muted-foreground border-l border-border pl-2 ml-0.5 hidden sm:inline">click to filter</span>
            </button>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-slate-200 mb-6 p-4 md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
              <div className="min-w-0">
                <h3 className="text-base text-slate-900 truncate">
                  {viewEmployee.full_name}
                </h3>
                <p className="text-xs text-slate-500 font-mono">
                  {viewEmployee.display_code}
                  {viewEmployee.client_name && ` · ${viewEmployee.client_name}`}
                  {viewEmployee.location_name && ` · ${viewEmployee.location_name}`}
                </p>
                <p className="text-xs text-slate-600 mt-2">
                  <span className="text-success-700">{viewStats.p} present</span> ·{" "}
                  <span className="text-danger-700">{viewStats.a} absent</span> ·{" "}
                  <span className="text-warning-700">{viewStats.l} leave</span> ·{" "}
                  <span className="text-slate-500">view-only</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => shiftViewMonth(-1)}
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-700"
                  title="Previous month"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm text-slate-900 min-w-[110px] text-center">
                  {new Date(`${viewMonth}-01T00:00:00`).toLocaleDateString(undefined, {
                    month: "long",
                    year: "numeric",
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => shiftViewMonth(1)}
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-700"
                  title="Next month"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewEmployee(null)}
                  className="ml-2 text-xs text-slate-500 hover:text-slate-900 underline"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="grid grid-cols-7 gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground mb-1.5">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div key={d} className="text-center py-1">{d}</div>
              ))}
            </div>

            {viewLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-6">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : (
              <div className="grid grid-cols-7 gap-1.5">
                {viewCalendarCells.map((c, i) => {
                  if (!c.date) {
                    return <div key={i} className="h-14 rounded-lg bg-muted/40" />;
                  }
                  const status = viewRecords.get(c.date);
                  const tone =
                    status === "present"
                      ? "bg-success-50 text-success-700 dark:text-success-500 border-success-200"
                      : status === "absent"
                        ? "bg-danger-50 text-danger-700 dark:text-danger-500 border-danger-200"
                        : status === "leave"
                          ? "bg-warning-50 text-warning-700 dark:text-warning-500 border-warning-200"
                          : "bg-card text-muted-foreground border-border";
                  return (
                    <div
                      key={c.date}
                      className={`h-14 rounded-lg border p-1.5 flex flex-col justify-between transition-colors ${tone}`}
                      title={status ? `${c.date}: ${STATUS_LABEL[status]}` : `${c.date}: Unmarked`}
                    >
                      <div className="text-xs font-medium tabular-nums">{c.day}</div>
                      {status && (
                        <div className="text-[9px] font-bold uppercase tracking-wider self-end">
                          {status[0]}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground mt-2.5">
              View-only. P = Present, A = Absent, L = Leave.
            </p>
          </div>
        )}

        <div className="bg-card rounded-xl border border-border mb-6 p-4">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Date — the primary control for attendance */}
            <div className="relative">
              <CalendarIcon
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground cursor-pointer"
                strokeWidth={1.5}
                onClick={() => dateInputRef.current?.showPicker()}
              />
              <input
                ref={dateInputRef}
                type="date"
                value={date}
                max={today()}
                onChange={(e) => { if (isIsoDate(e.target.value)) setDate(e.target.value); }}
                className="pl-10 pr-3 py-2 border border-border rounded-md text-sm bg-input-background focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500"
              />
            </div>
            {/* Search — flex to fill */}
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
              <input
                type="text"
                placeholder="Search employee by name or ID…"
                value={empSearch}
                onChange={(e) => setEmpSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-border rounded-md text-sm bg-input-background focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500"
              />
            </div>
            {/* Unmarked-only quick toggle (kept prominent — it's the "who still needs marking" shortcut) */}
            <button
              type="button"
              onClick={() => setUnmarkedOnly((v) => !v)}
              title={`Show only employees with no attendance for ${date}`}
              className={`px-3 py-2 text-sm rounded-md border transition-colors whitespace-nowrap ${
                unmarkedOnly
                  ? "border-danger-500 bg-danger-50 text-danger-700 dark:text-danger-500 font-medium"
                  : "border-border text-muted-foreground hover:bg-accent"
              }`}
            >
              Unmarked only
            </button>
            {/* Filters toggle */}
            <button
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-md border border-border text-foreground hover:bg-accent transition-colors"
            >
              <SlidersHorizontal className="w-4 h-4" strokeWidth={1.5} />
              Filters
              {activeFilterCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full bg-brand-500 text-[#241a06]">{activeFilterCount}</span>
              )}
              <ChevronDown className={`w-4 h-4 transition-transform ${filtersOpen ? "rotate-180" : ""}`} strokeWidth={1.5} />
            </button>
          </div>
          {filtersOpen && (
            <div className="mt-3 pt-3 border-t border-border flex flex-wrap gap-2">
              <ClientFilterSelect
                clients={clients}
                value={clientFilter}
                onChange={setClientFilter}
                allValue="all"
              />
              {!relieversOnly && (
                <ThemedSelect
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value as typeof categoryFilter)}
                  className="px-3 py-2 border border-border rounded-md text-sm"
                >
                  <option value="all">All Categories</option>
                  <option value="client">Client</option>
                  <option value="office_staff">Office Staff</option>
                  <option value="reliever">Reliever</option>
                </ThemedSelect>
              )}
              <ThemedSelect
                value={shiftFilter}
                onChange={(e) => setShiftFilter(e.target.value as "all" | "day" | "night")}
                className="px-3 py-2 border border-border rounded-md text-sm"
              >
                <option value="all">All Shifts</option>
                <option value="day">Day</option>
                <option value="night">Night</option>
              </ThemedSelect>
            </div>
          )}
        </div>

        <div className="bg-card rounded-xl border border-border mb-6">
          <div className="p-4 md:p-6 border-b border-border flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-foreground">Mark Attendance — {date}</h3>
              <p className="text-xs text-muted-foreground mt-1">
                {filteredEmployees.length} employee{filteredEmployees.length === 1 ? "" : "s"} •{" "}
                <span className="text-success-600 dark:text-success-500">{stats.p} present</span> ·{" "}
                <span className="text-danger-600 dark:text-danger-500">{stats.a} absent</span> ·{" "}
                <span className="text-warning-600 dark:text-warning-500">{stats.l} leave</span> ·{" "}
                <span className="text-muted-foreground">{stats.unm} unmarked</span>
              </p>
            </div>
            {/* Phase 6: Mark-All-Present and its Undo are removed. Confirmation
                is per client-shift on the Attendance board. */}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-slate-50">
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Employee ID</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Name</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {relieversOnly ? "Worked for" : "Client"}
                  </th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Location</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Shift</th>
                  <th className="text-left px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loading && (
                  <tr>
                    <td colSpan={6} className="px-6 py-10 text-center text-slate-500">
                      <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                      Loading…
                    </td>
                  </tr>
                )}
                {!loading && filteredEmployees.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-10 text-center text-slate-500 text-sm">
                      No employees match the current filters.
                    </td>
                  </tr>
                )}
                {!loading &&
                  groupedEmployees.map((g) => {
                    const reported = g.employees.filter((e) => todayRecords[e.id]).length;
                    const total = g.employees.length;
                    const allReported = total > 0 && reported === total;
                    const conf = confirmedGroups[g.key];
                    return (
                      <Fragment key={g.key}>
                        <tr className="bg-slate-100/70 border-t border-border">
                          <td colSpan={6} className="px-6 py-2.5">
                            <div className="flex flex-wrap items-center gap-3">
                              <span className="text-sm font-semibold text-foreground">{g.label}</span>
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                                  allReported
                                    ? "bg-success-50 text-success-700 border-success-200"
                                    : "bg-warning-50 text-warning-800 border-warning-200"
                                }`}
                              >
                                {allReported ? "All reported" : `${reported}/${total} reported`}
                              </span>
                              {conf ? (
                                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success-700 dark:text-success-500 ml-auto">
                                  <Check className="w-3.5 h-3.5" strokeWidth={2} />
                                  Confirmed by {conf.by}
                                </span>
                              ) : (
                                canBulk && (
                                  <button
                                    type="button"
                                    disabled={!allReported || confirmingKey === g.key}
                                    onClick={() => confirmGroup(g)}
                                    title={
                                      allReported
                                        ? "Supervisor: confirm this group's attendance for the day"
                                        : "All employees must be reported before this can be confirmed"
                                    }
                                    className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border border-brand-500 text-brand-700 hover:bg-brand-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    {confirmingKey === g.key ? (
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                      <Check className="w-3.5 h-3.5" strokeWidth={2} />
                                    )}
                                    Confirm
                                  </button>
                                )
                              )}
                            </div>
                          </td>
                        </tr>
                        {g.employees.map((employee) => {
                    const current = todayRecords[employee.id];
                    const isSaving = !!saving[employee.id];
                    // Gate marking before the assignment takes effect. Only
                    // employees with a real effective_from are gated; a null
                    // (most existing employees) is left ungated.
                    const beforeEffective =
                      !!employee.assignment_effective_from &&
                      date < employee.assignment_effective_from;
                    return (
                      <tr key={employee.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4 text-sm font-mono">
                          <button
                            type="button"
                            onClick={() => setViewEmployee(employee)}
                            className="text-brand-700 hover:text-brand-900 hover:underline"
                            title="View attendance calendar"
                          >
                            {employee.display_code}
                          </button>
                          <span className="block text-[11px] text-slate-400 font-mono">{employee.permanent_code}</span>
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <button
                            type="button"
                            onClick={() => setViewEmployee(employee)}
                            className="text-slate-900 hover:text-brand-700 hover:underline text-left"
                            title="View attendance calendar"
                          >
                            {employee.full_name}
                          </button>
                          {current && todayMarkedBy[employee.id] && (
                            <span className="block text-[11px] text-muted-foreground mt-0.5">
                              reported by {profilesById[todayMarkedBy[employee.id]!] ?? "—"}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {employee.category === "reliever" ? (
                            <ThemedSelect
                              value={todayWorkedFor[employee.id] ?? ""}
                              onChange={(e) => {
                                const newClient = e.target.value || null;
                                setTodayWorkedFor((m) => ({ ...m, [employee.id]: newClient }));
                                // If they're already marked Present, persist the change.
                                if (current === "present" && newClient) {
                                  markStatus(employee.id, "present", newClient);
                                }
                              }}
                              className="px-2 py-1 border border-slate-200 rounded text-sm max-w-[12rem]"
                            >
                              <option value="">Pick client…</option>
                              {clients.map((c) => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                              ))}
                            </ThemedSelect>
                          ) : (
                            employee.client_name ?? "—"
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {employee.location_name ?? "—"}
                        </td>
                        <td className="px-6 py-4">
                          {(() => {
                            const onDate = dayShift(employee.id);
                            return (
                              <span
                                title={
                                  onDate === employee.shift
                                    ? undefined
                                    : `Shift on ${date} — currently ${employee.shift}`
                                }
                                className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border capitalize ${
                                  onDate === "day"
                                    ? "bg-warning-50 text-warning-700 dark:text-warning-500 border-warning-200"
                                    : "bg-info-50 text-info-700 dark:text-info-500 border-info-200"
                                }`}
                              >
                                {onDate}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex gap-1.5 items-center">
                            {STATUSES.map((status) => {
                              const on = current === status;
                              const dim = !!current && !on; // another status is set — mute the rest
                              const cls =
                                status === "present"
                                  ? on
                                    ? "bg-success-500 text-[#fff] border-success-500 shadow-sm"
                                    : "bg-success-50 text-success-700 dark:text-success-500 border-success-200 hover:bg-success-100 hover:border-success-500"
                                  : status === "absent"
                                  ? on
                                    ? "bg-danger-500 text-[#fff] border-danger-500 shadow-sm"
                                    : "bg-danger-50 text-danger-700 dark:text-danger-500 border-danger-200 hover:bg-danger-100 hover:border-danger-500"
                                  : on
                                  ? "bg-warning-500 text-[#241a06] border-warning-500 shadow-sm"
                                  : "bg-warning-50 text-warning-700 dark:text-warning-500 border-warning-200 hover:bg-warning-100 hover:border-warning-500";
                              return (
                                <button
                                  key={status}
                                  onClick={() =>
                                    markStatus(
                                      employee.id,
                                      status,
                                      employee.category === "reliever"
                                        ? todayWorkedFor[employee.id] ?? null
                                        : null,
                                    )
                                  }
                                  disabled={
                                    isSaving ||
                                    beforeEffective ||
                                    (employee.category === "reliever" &&
                                      status === "present" &&
                                      !todayWorkedFor[employee.id])
                                  }
                                  title={
                                    beforeEffective
                                      ? `Assignment starts ${employee.assignment_effective_from}. Attendance can't be marked before this date.`
                                      : `Mark ${STATUS_LABEL[status]}`
                                  }
                                  className={`px-3.5 py-1.5 text-xs font-semibold rounded-md border transition-all disabled:opacity-50 ${cls} ${dim ? "opacity-55" : ""}`}
                                >
                                  {STATUS_LABEL[status]}
                                </button>
                              );
                            })}
                            {current && (
                              <button
                                type="button"
                                onClick={() => unmarkStatus(employee.id)}
                                disabled={isSaving}
                                className="p-1.5 rounded-md text-muted-foreground hover:bg-danger-50 hover:text-danger-600 dark:hover:text-danger-500 transition-colors disabled:opacity-50"
                                title="Unmark — clear this attendance"
                              >
                                <X className="w-4 h-4" strokeWidth={2} />
                              </button>
                            )}
                            {current === "present" && (
                              <button
                                type="button"
                                onClick={() => openDetailsEditor(employee)}
                                className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                                title="Half-day / Late / Overtime"
                              >
                                <MoreHorizontal className="w-4 h-4" />
                              </button>
                            )}
                            {canBulk && (
                              <button
                                type="button"
                                onClick={() => openMonthlyBoard(employee.id)}
                                className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                                title="Monthly Board — mark this employee's whole month"
                              >
                                <CalendarRange className="w-4 h-4" />
                              </button>
                            )}
                            {isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
                          </div>
                        </td>
                      </tr>
                    );
                        })}
                      </Fragment>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-4 md:p-6 border-b border-slate-200 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <h3 className="text-base text-slate-900">Attendance History</h3>
            <div className="flex flex-wrap items-center gap-2 md:gap-3">
              <div className="relative flex-1 md:flex-none min-w-[140px]">
                <CalendarIcon
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 cursor-pointer"
                  strokeWidth={1.5}
                  onClick={() => fromInputRef.current?.showPicker()}
                />
                <input
                  ref={fromInputRef}
                  type="date"
                  value={historyFrom}
                  onChange={(e) => { if (isIsoDate(e.target.value)) setHistoryFrom(e.target.value); }}
                  className="w-full pl-9 pr-2 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
              <span className="text-sm text-slate-400">to</span>
              <div className="relative flex-1 md:flex-none min-w-[140px]">
                <CalendarIcon
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 cursor-pointer"
                  strokeWidth={1.5}
                  onClick={() => toInputRef.current?.showPicker()}
                />
                <input
                  ref={toInputRef}
                  type="date"
                  value={historyTo}
                  onChange={(e) => { if (isIsoDate(e.target.value)) setHistoryTo(e.target.value); }}
                  className="w-full pl-9 pr-2 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Date</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Location</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Present</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Absent</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Leave</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {history.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">
                      No attendance records in this range.
                    </td>
                  </tr>
                )}
                {history.map((record, index) => (
                  <tr
                    key={`${record.date}-${record.location_name}-${record.client_name}-${index}`}
                    className="hover:bg-slate-50 transition-colors"
                  >
                    <td className="px-6 py-4 text-sm text-slate-900">{record.date}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{record.location_name ?? "—"}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{record.client_name ?? "—"}</td>
                    <td className="px-6 py-4 text-sm text-success-600">{record.present}</td>
                    <td className="px-6 py-4 text-sm text-danger-600">{record.absent}</td>
                    <td className="px-6 py-4 text-sm text-warning-600">{record.leave}</td>
                    <td className="px-6 py-4">
                      <Button variant="ghost" size="sm" onClick={() => setDetailRecord(record)}>
                        View Details
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      <Modal
        isOpen={detailRecord !== null}
        error={error}
        onDismissError={() => setError(null)}
        onClose={() => setDetailRecord(null)}
        title="Attendance Details"
        size="lg"
      >
        {detailRecord && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pb-4 border-b border-slate-200 text-sm">
              <div>
                <p className="text-slate-500 mb-1">Date</p>
                <p className="text-slate-900">{detailRecord.date}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Location</p>
                <p className="text-slate-900">{detailRecord.location_name ?? "—"}</p>
              </div>
              <div>
                <p className="text-slate-500 mb-1">Client</p>
                <p className="text-slate-900">{detailRecord.client_name ?? "—"}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-success-500">
                <p className="text-sm text-success-700 mb-1">Present</p>
                <p className="text-2xl text-success-900">{detailRecord.present}</p>
              </div>
              <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-danger-500">
                <p className="text-sm text-danger-700 mb-1">Absent</p>
                <p className="text-2xl text-danger-900">{detailRecord.absent}</p>
              </div>
              <div className="bg-white p-4 rounded-lg border border-slate-200 border-l-4 border-l-warning-500">
                <p className="text-sm text-warning-700 mb-1">Leave</p>
                <p className="text-2xl text-warning-900">{detailRecord.leave}</p>
              </div>
            </div>

            <div className="pt-4">
              <h4 className="text-sm text-slate-900 mb-3">Employees</h4>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {detailRecord.employees.map((e) => (
                  <div
                    key={e.employee_id}
                    className="flex items-center justify-between text-sm p-2 rounded hover:bg-slate-50"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-slate-500">{e.display_code}</span>
                      <span className="text-slate-900">{e.full_name}</span>
                    </div>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
                        e.status === "present"
                          ? "bg-success-50 text-success-700"
                          : e.status === "absent"
                          ? "bg-danger-50 text-danger-700"
                          : "bg-warning-50 text-warning-700"
                      }`}
                    >
                      {STATUS_LABEL[e.status as AttendanceStatus] ?? e.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200">
              <Button
                variant="secondary"
                size="md"
                className="w-full"
                onClick={() => setDetailRecord(null)}
              >
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Export — pick the month to export (the current filters still apply). */}
      <Modal
        isOpen={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Export attendance to Excel"
        size="sm"
        footer={
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="md"
              className="flex-1"
              disabled={exporting || !exportMonth}
              onClick={async () => {
                setExporting(true);
                try {
                  await handleExport(exportMonth);
                  setExportOpen(false);
                } finally {
                  setExporting(false);
                }
              }}
            >
              {exporting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {exporting ? "Preparing…" : "Export"}
            </Button>
            <Button variant="secondary" size="md" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs uppercase tracking-wider text-slate-500 mb-1.5">Month</label>
            <input
              type="month"
              value={exportMonth}
              max={today().slice(0, 7)}
              onChange={(e) => setExportMonth(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
            />
          </div>
          <p className="text-xs text-slate-500">
            Exports the {filteredEmployees.length} employee{filteredEmployees.length === 1 ? "" : "s"} currently
            in view (the filters above still apply). Days a guard was no longer employed are marked{" "}
            <strong>{SEPARATION_MARK}</strong>, and separations are listed with their date at the bottom of the sheet.
          </p>
        </div>
      </Modal>

      {/* Bulk Mark by Employee — the shared calendar (same UI/logic as the board). */}
      {isBulkOpen && (
        <BulkMarkByEmployeeModal
          initialEmployeeId={bulkEmpId ?? undefined}
          initialMonth={date.slice(0, 7)}
          onClose={() => { setIsBulkOpen(false); setBulkEmpId(null); }}
          onSaved={async () => { await loadRecordsForDate(date); }}
        />
      )}

      {/* Sprint 3 — half-day / late / OT editor for a Present employee */}
      <Modal
        isOpen={detailsEmp !== null}
        error={error}
        onDismissError={() => setError(null)}
        onClose={() => setDetailsEmp(null)}
        title={detailsEmp ? `Attendance details — ${detailsEmp.full_name}` : ""}
        size="sm"
      >
        {detailsEmp && (
          <div className="space-y-3">
            <div className="text-xs text-slate-500">
              Date: <strong className="text-slate-700">{date}</strong> ·
              <span className="ml-1 font-mono">{detailsEmp.display_code}</span>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={detailsForm.half_day}
                onChange={(e) => setDetailsForm({ ...detailsForm, half_day: e.target.checked })}
              />
              <span>Half-day</span>
            </label>
            {detailsForm.half_day && (
              <div>
                <label className="block text-xs text-slate-700 mb-1">Hours worked</label>
                <input
                  type="number"
                  step="0.25"
                  min="0"
                  max="12"
                  value={detailsForm.hours_worked}
                  onChange={(e) => setDetailsForm({ ...detailsForm, hours_worked: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                  placeholder="e.g., 4"
                />
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={detailsForm.late_arrival}
                onChange={(e) => setDetailsForm({ ...detailsForm, late_arrival: e.target.checked })}
              />
              <span>Late arrival</span>
              <span className="text-xs text-slate-500">(does not affect Present status)</span>
            </label>
            <div>
              <label className="block text-xs text-slate-700 mb-1 inline-flex items-center gap-1">
                <Clock className="w-3 h-3" /> Overtime hours
              </label>
              <input
                type="number"
                step="0.25"
                min="0"
                max="12"
                value={detailsForm.overtime_hours}
                onChange={(e) => setDetailsForm({ ...detailsForm, overtime_hours: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div className="flex items-center gap-2 pt-3 border-t border-slate-200">
              <Button variant="primary" size="md" disabled={detailsSaving} onClick={saveDetails} className="flex-1">
                {detailsSaving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
                Save details
              </Button>
              <Button variant="secondary" size="md" onClick={() => setDetailsEmp(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
