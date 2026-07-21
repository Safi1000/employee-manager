import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar as CalendarIcon, AlertCircle, Loader2, X, CalendarRange, ChevronLeft, ChevronRight, Search, Clock, MoreHorizontal } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import { exportAttendance, type AttendanceEmployeeRow } from "../../lib/excel";
import {
  supabase,
  fetchAllRows,
  resolveAllowedLeaves,
  type AttendanceStatus,
  type AttendanceRecord,
  type Client,
  type Location,
  type Branch,
  type Contract,
} from "../../lib/supabase";
import { useRegion, withRegion } from "../../lib/region";
import { hasPermission, useAuth } from "../../lib/auth";

type EmployeeLite = {
  id: string;
  employee_code: string;
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
};

type ContractLeaveRow = Pick<Contract, "id" | "allowed_leaves_per_month">;

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
    status: AttendanceStatus;
  }[];
};

const today = () => new Date().toISOString().slice(0, 10);

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const STATUSES: AttendanceStatus[] = ["Present", "Absent", "Leave"];

type AttendanceManagementProps = { relieversOnly?: boolean };

export default function AttendanceManagement({ relieversOnly = false }: AttendanceManagementProps = {}) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [contracts, setContracts] = useState<ContractLeaveRow[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [todayRecords, setTodayRecords] = useState<Record<string, AttendanceStatus>>({});
  // For relievers: per-day client attribution. Mirrors todayRecords.
  const [todayWorkedFor, setTodayWorkedFor] = useState<Record<string, string | null>>({});
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
  const [locationFilter, setLocationFilter] = useState("all");
  const [branchFilter, setBranchFilter] = useState("all");
  const [shiftFilter, setShiftFilter] = useState<"all" | "day" | "night">("all");
  // Employee category filter (same set as the Employees tab) — e.g. Office Staff only.
  const [categoryFilter, setCategoryFilter] = useState<"all" | "client" | "office_staff" | "reliever">("all");
  const [unmarkedOnly, setUnmarkedOnly] = useState<boolean>(false);
  const [empSearch, setEmpSearch] = useState("");
  const [historyFrom, setHistoryFrom] = useState<string>(daysAgo(13));
  const [historyTo, setHistoryTo] = useState<string>(today());

  const [detailRecord, setDetailRecord] = useState<HistoryRow | null>(null);

  const { profile } = useAuth();
  const { regionId } = useRegion();
  const canBulk = hasPermission(profile, "attendance.bulk_mark");

  // ---- Bulk-mark calendar modal ----
  const [isBulkOpen, setIsBulkOpen] = useState(false);
  const [bulkEmpSearch, setBulkEmpSearch] = useState("");
  const [bulkEmployeeId, setBulkEmployeeId] = useState<string>("");
  const [bulkMonth, setBulkMonth] = useState<string>(today().slice(0, 7));
  const [bulkExisting, setBulkExisting] = useState<Map<string, AttendanceStatus>>(new Map());
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkDragMode, setBulkDragMode] = useState<"add" | "remove" | null>(null);
  // Gallery-style range drag: anchor = where the drag started, base = the selection
  // snapshot before the drag, so the live range can be recomputed on every move.
  const [bulkDragAnchor, setBulkDragAnchor] = useState<string | null>(null);
  const [bulkDragBase, setBulkDragBase] = useState<Set<string>>(new Set());
  // ---- Bulk-mark filters (mirror the daily attendance tab filters) ----
  const [bulkClientFilter, setBulkClientFilter] = useState("all");
  const [bulkLocationFilter, setBulkLocationFilter] = useState("all");
  const [bulkBranchFilter, setBulkBranchFilter] = useState("all");
  const [bulkShiftFilter, setBulkShiftFilter] = useState<"all" | "day" | "night">("all");
  const [bulkCategoryFilter, setBulkCategoryFilter] = useState<"all" | "client" | "office_staff" | "reliever">("all");

  // ---- Main tab ----
  const [mainTab, setMainTab] = useState<"attendance" | "shift_override">("attendance");

  // ---- Shift Override tab ----
  const [overrideDate, setOverrideDate] = useState<string>(today());
  const [overrides, setOverrides] = useState<Map<string, "day" | "night">>(new Map());
  const [overrideSaving, setOverrideSaving] = useState<Set<string>>(new Set());
  const [overrideShiftFilter, setOverrideShiftFilter] = useState<"all" | "day" | "night">("all");
  const [overrideSearch, setOverrideSearch] = useState("");

  const bulkEmployee = useMemo(
    () => employees.find((e) => e.id === bulkEmployeeId),
    [employees, bulkEmployeeId],
  );

  const bulkEmployeeOptions = useMemo(() => {
    let pool = employees;
    if (relieversOnly) pool = pool.filter((e) => e.category === "reliever");
    if (bulkClientFilter !== "all") pool = pool.filter((e) => e.client_id === bulkClientFilter);
    if (bulkLocationFilter !== "all") pool = pool.filter((e) => e.location_id === bulkLocationFilter);
    if (bulkBranchFilter !== "all") pool = pool.filter((e) => e.branch_id === bulkBranchFilter || e.additional_branch_ids?.includes(bulkBranchFilter));
    if (bulkShiftFilter !== "all") pool = pool.filter((e) => e.shift === bulkShiftFilter);
    if (bulkCategoryFilter !== "all") pool = pool.filter((e) => e.category === bulkCategoryFilter);
    const q = bulkEmpSearch.trim().toLowerCase();
    if (q) pool = pool.filter((e) => e.full_name.toLowerCase().includes(q) || e.employee_code.toLowerCase().includes(q));
    return pool.slice(0, 100);
  }, [employees, bulkEmpSearch, bulkClientFilter, bulkLocationFilter, bulkBranchFilter, bulkShiftFilter, bulkCategoryFilter, relieversOnly]);

  const loadBulkMonth = async (employeeId: string, monthKey: string) => {
    setBulkLoading(true);
    setBulkError(null);
    const start = `${monthKey}-01`;
    const [y, m] = monthKey.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const end = `${monthKey}-${String(lastDay).padStart(2, "0")}`;
    const { data, error: err } = await supabase
      .from("attendance_records")
      .select("attendance_date, status")
      .eq("employee_id", employeeId)
      .gte("attendance_date", start)
      .lte("attendance_date", end);
    if (err) setBulkError(err.message);
    const map = new Map<string, AttendanceStatus>();
    for (const r of (data ?? []) as { attendance_date: string; status: AttendanceStatus }[]) {
      map.set(r.attendance_date, r.status);
    }
    setBulkExisting(map);
    setBulkLoading(false);
  };

  useEffect(() => {
    if (!isBulkOpen || !bulkEmployeeId) return;
    setBulkSelected(new Set());
    loadBulkMonth(bulkEmployeeId, bulkMonth);
  }, [isBulkOpen, bulkEmployeeId, bulkMonth]);

  const openBulkMark = () => {
    setBulkEmployeeId("");
    setBulkEmpSearch("");
    setBulkMonth(today().slice(0, 7));
    setBulkSelected(new Set());
    setBulkExisting(new Map());
    setBulkError(null);
    setBulkClientFilter("all");
    setBulkLocationFilter("all");
    setBulkBranchFilter("all");
    setBulkShiftFilter("all");
    setBulkCategoryFilter("all");
    setIsBulkOpen(true);
  };

  // ---- Shift Override functions ----
  const loadOverrides = async (dt: string) => {
    const companyId = profile?.view_as_company ?? profile?.company_id ?? null;
    if (!companyId) return;
    const { data } = await supabase
      .from("attendance_shift_overrides")
      .select("employee_id, override_shift")
      .eq("company_id", companyId)
      .eq("attendance_date", dt);
    const map = new Map<string, "day" | "night">();
    for (const r of (data ?? [])) map.set(r.employee_id, r.override_shift as "day" | "night");
    setOverrides(map);
  };

  const toggleShiftOverride = async (emp: EmployeeLite) => {
    const companyId = profile?.view_as_company ?? profile?.company_id ?? null;
    if (!companyId) return;
    setOverrideSaving((s) => new Set(s).add(emp.id));
    if (overrides.has(emp.id)) {
      await supabase
        .from("attendance_shift_overrides")
        .delete()
        .eq("employee_id", emp.id)
        .eq("attendance_date", overrideDate);
      setOverrides((prev) => { const m = new Map(prev); m.delete(emp.id); return m; });
    } else {
      const overrideShift = emp.shift === "day" ? "night" : "day";
      await supabase
        .from("attendance_shift_overrides")
        .upsert(
          { employee_id: emp.id, company_id: companyId, attendance_date: overrideDate, override_shift: overrideShift },
          { onConflict: "employee_id,attendance_date" }
        );
      setOverrides((prev) => new Map(prev).set(emp.id, overrideShift as "day" | "night"));
    }
    setOverrideSaving((s) => { const n = new Set(s); n.delete(emp.id); return n; });
  };

  const filteredOverrideEmployees = useMemo(() => {
    let pool = employees.filter((e) => e.category === "client" || e.category === "reliever");
    if (overrideShiftFilter !== "all") pool = pool.filter((e) => e.shift === overrideShiftFilter);
    const q = overrideSearch.trim().toLowerCase();
    if (q) pool = pool.filter((e) => e.full_name.toLowerCase().includes(q) || e.employee_code.toLowerCase().includes(q));
    return pool;
  }, [employees, overrideShiftFilter, overrideSearch]);

  const bulkCalendarCells = useMemo(() => {
    const [y, m] = bulkMonth.split("-").map(Number);
    const first = new Date(y, m - 1, 1);
    const lastDay = new Date(y, m, 0).getDate();
    const leading = first.getDay(); // 0=Sun
    const cells: { date: string | null; day: number | null }[] = [];
    for (let i = 0; i < leading; i++) cells.push({ date: null, day: null });
    for (let d = 1; d <= lastDay; d++) {
      const date = `${bulkMonth}-${String(d).padStart(2, "0")}`;
      cells.push({ date, day: d });
    }
    while (cells.length % 7 !== 0) cells.push({ date: null, day: null });
    return cells;
  }, [bulkMonth]);

  const shiftBulkMonth = (delta: number) => {
    const [y, m] = bulkMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setBulkMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const toggleBulkCell = (date: string) => {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  // Chronological list of selectable dates + their index, for range computation.
  const bulkOrderedDates = useMemo(
    () => bulkCalendarCells.filter((c) => c.date).map((c) => c.date as string),
    [bulkCalendarCells],
  );
  const bulkDateIndex = useMemo(() => {
    const m = new Map<string, number>();
    bulkOrderedDates.forEach((d, i) => m.set(d, i));
    return m;
  }, [bulkOrderedDates]);

  const applyBulkRange = (
    base: Set<string>,
    from: string,
    to: string,
    mode: "add" | "remove",
  ): Set<string> => {
    const a = bulkDateIndex.get(from);
    const b = bulkDateIndex.get(to);
    if (a == null || b == null) return base;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const next = new Set(base);
    for (let i = lo; i <= hi; i += 1) {
      const d = bulkOrderedDates[i];
      if (mode === "add") next.add(d);
      else next.delete(d);
    }
    return next;
  };

  // Begin a drag from `date`: remember the anchor and pre-drag selection, then
  // apply the (single-cell) range so a plain tap still toggles.
  const startBulkDrag = (date: string) => {
    const mode: "add" | "remove" = bulkSelected.has(date) ? "remove" : "add";
    const base = new Set(bulkSelected);
    setBulkDragMode(mode);
    setBulkDragAnchor(date);
    setBulkDragBase(base);
    setBulkSelected(applyBulkRange(base, date, date, mode));
  };

  // Recompute the live selection as the pointer moves over `date` during a drag:
  // everything between the anchor and the current cell takes the drag's mode,
  // even cells the pointer skipped — like selecting in a phone gallery.
  const extendBulkDrag = (date: string) => {
    if (!bulkDragMode || !bulkDragAnchor) return;
    setBulkSelected(applyBulkRange(bulkDragBase, bulkDragAnchor, date, bulkDragMode));
  };

  const endBulkDrag = () => {
    setBulkDragMode(null);
    setBulkDragAnchor(null);
  };

  const applyBulkStatus = async (status: AttendanceStatus) => {
    if (!bulkEmployeeId || bulkSelected.size === 0) return;
    setBulkSubmitting(true);
    setBulkError(null);
    const rows = Array.from(bulkSelected).map((d) => ({
      employee_id: bulkEmployeeId,
      attendance_date: d,
      status,
    }));
    const { error: err } = await supabase
      .from("attendance_records")
      .upsert(rows, { onConflict: "employee_id,attendance_date" });
    setBulkSubmitting(false);
    if (err) {
      setBulkError(err.message);
      return;
    }
    await loadBulkMonth(bulkEmployeeId, bulkMonth);
    setBulkSelected(new Set());
  };

  const clearBulkSelected = async () => {
    if (!bulkEmployeeId || bulkSelected.size === 0) return;
    if (!window.confirm(`Clear marks for ${bulkSelected.size} day(s)?`)) return;
    setBulkSubmitting(true);
    setBulkError(null);
    const { error: err } = await supabase
      .from("attendance_records")
      .delete()
      .eq("employee_id", bulkEmployeeId)
      .in("attendance_date", Array.from(bulkSelected));
    setBulkSubmitting(false);
    if (err) {
      setBulkError(err.message);
      return;
    }
    await loadBulkMonth(bulkEmployeeId, bulkMonth);
    setBulkSelected(new Set());
  };

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
      if (s === "Present") p++;
      else if (s === "Absent") a++;
      else if (s === "Leave") l++;
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
    const [locRes, cliRes, brRes, empRes, ebRes, conRes] = await Promise.all([
      supabase.from("locations").select("*").order("name"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("branches").select("*").order("is_head_office", { ascending: false }).order("name"),
      // The employee roster drives the whole attendance grid, so scoping it to
      // the selected region scopes the screen.
      withRegion(
        supabase
          .from("employees")
          .select(
            "id, employee_code, full_name, location_id, client_id, contract_id, branch_id, shift, category, assignment_effective_from, location:location_id(name), client:client_id(name)"
          )
          .order("full_name"),
        regionId,
      ),
      supabase.from("employee_branches").select("employee_id, branch_id"),
      supabase.from("contracts").select("id, allowed_leaves_per_month"),
    ]);
    if (locRes.error) setError(locRes.error.message);
    if (cliRes.error) setError(cliRes.error.message);
    if (brRes.error) setError(brRes.error.message);
    if (empRes.error) setError(empRes.error.message);
    if (ebRes.error) setError(ebRes.error.message);
    if (conRes.error) setError(conRes.error.message);
    setLocations(locRes.data ?? []);
    setClients(cliRes.data ?? []);
    setBranches((brRes.data ?? []) as Branch[]);
    setContracts((conRes.data ?? []) as ContractLeaveRow[]);
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
      }))
    );
  };

  const loadRecordsForDate = async (d: string) => {
    const { data, error: err } = await supabase
      .from("attendance_records")
      .select("employee_id, status, worked_for_client_id")
      .eq("attendance_date", d);
    if (err) {
      setError(err.message);
      return;
    }
    const statusMap: Record<string, AttendanceStatus> = {};
    const clientMap: Record<string, string | null> = {};
    (data ?? []).forEach((r: any) => {
      statusMap[r.employee_id] = r.status;
      clientMap[r.employee_id] = r.worked_for_client_id ?? null;
    });
    setTodayRecords(statusMap);
    setTodayWorkedFor(clientMap);
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
      if (locationFilter !== "all" && emp.location_id !== locationFilter) continue;
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
      if (r.status === "Present") row.present++;
      else if (r.status === "Absent") row.absent++;
      else row.leave++;
      row.employees.push({
        employee_id: emp.id,
        full_name: emp.full_name,
        employee_code: emp.employee_code,
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
    if (employees.length === 0) return;
    loadHistory();
  }, [historyFrom, historyTo, employees, clientFilter, locationFilter, branchFilter, shiftFilter]);

  useEffect(() => {
    if (mainTab === "shift_override") loadOverrides(overrideDate);
  }, [overrideDate, mainTab]);

  const filteredEmployees = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    return employees.filter((e) => {
      // Reliever panel only shows relievers; main panel hides them.
      if (relieversOnly && e.category !== "reliever") return false;
      if (!relieversOnly && e.category === "reliever") return false;
      if (clientFilter !== "all" && e.client_id !== clientFilter) return false;
      if (locationFilter !== "all" && e.location_id !== locationFilter) return false;
      if (branchFilter !== "all") {
        const inPrimary = e.branch_id === branchFilter;
        const inAdditional = (e.additional_branch_ids ?? []).includes(branchFilter);
        if (!inPrimary && !inAdditional) return false;
      }
      if (shiftFilter !== "all" && e.shift !== shiftFilter) return false;
      if (categoryFilter !== "all" && e.category !== categoryFilter) return false;
      if (unmarkedOnly && todayRecords[e.id]) return false;
      if (q && !e.full_name.toLowerCase().includes(q) && !e.employee_code.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [employees, clientFilter, locationFilter, branchFilter, shiftFilter, categoryFilter, unmarkedOnly, todayRecords, empSearch, relieversOnly]);

  const markStatus = async (
    employeeId: string,
    status: AttendanceStatus,
    workedForClientId?: string | null,
  ) => {
    const employee = employees.find((e) => e.id === employeeId);
    const isReliever = employee?.category === "reliever";
    // Relievers marked Present must have a client picked.
    if (isReliever && status === "Present" && !workedForClientId) {
      setError("Pick which client this reliever worked for before marking Present.");
      return;
    }
    setSaving((s) => ({ ...s, [employeeId]: true }));
    setError(null);
    const prevStatus = todayRecords[employeeId];
    const prevClient = todayWorkedFor[employeeId] ?? null;
    setTodayRecords((m) => ({ ...m, [employeeId]: status }));
    setTodayWorkedFor((m) => ({
      ...m,
      [employeeId]: status === "Present" ? workedForClientId ?? null : null,
    }));
    const { error: upErr } = await supabase
      .from("attendance_records")
      .upsert(
        {
          employee_id: employeeId,
          attendance_date: date,
          status,
          worked_for_client_id: status === "Present" ? workedForClientId ?? null : null,
        },
        { onConflict: "employee_id,attendance_date" }
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
    // Mark-all skips relievers without a picked client (each must be set
    // individually so attribution stays correct).
    const skipped: string[] = [];
    const payload = filteredEmployees
      .filter((e) => {
        // Don't mark before the assignment's effective_from (same gate as the
        // per-row buttons). Null effective_from is left ungated.
        if (e.assignment_effective_from && date < e.assignment_effective_from) {
          return false;
        }
        if (e.category === "reliever" && !todayWorkedFor[e.id]) {
          skipped.push(e.full_name);
          return false;
        }
        return true;
      })
      .map((e) => ({
        employee_id: e.id,
        attendance_date: date,
        status: "Present" as AttendanceStatus,
        worked_for_client_id:
          e.category === "reliever" ? todayWorkedFor[e.id] ?? null : null,
      }));
    if (payload.length === 0) {
      setError(
        "All visible rows are relievers without a picked client. Set their client first.",
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
      optimistic[r.employee_id] = "Present";
    });
    setTodayRecords(optimistic);
    const { error: upErr } = await supabase
      .from("attendance_records")
      .upsert(payload, { onConflict: "employee_id,attendance_date" });
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
    if (skipped.length > 0) {
      setError(
        `Skipped ${skipped.length} reliever${skipped.length === 1 ? "" : "s"} without a picked client: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}.`,
      );
    }
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
      .map(([employee_id, prev]) => ({
        employee_id,
        attendance_date: lastBulk.date,
        status: prev as AttendanceStatus,
      }));
    const toDelete = entries
      .filter(([, prev]) => prev === null)
      .map(([employee_id]) => employee_id);

    if (toRestore.length > 0) {
      const { error: rErr } = await supabase
        .from("attendance_records")
        .upsert(toRestore, { onConflict: "employee_id,attendance_date" });
      if (rErr) {
        setError(rErr.message);
        setUndoing(false);
        await loadRecordsForDate(date);
        return;
      }
    }
    if (toDelete.length > 0) {
      const { error: dErr } = await supabase
        .from("attendance_records")
        .delete()
        .eq("attendance_date", lastBulk.date)
        .in("employee_id", toDelete);
      if (dErr) {
        setError(dErr.message);
        setUndoing(false);
        await loadRecordsForDate(date);
        return;
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
      if (s === "Present") p++;
      else if (s === "Absent") a++;
      else if (s === "Leave") l++;
      else unm++;
    });
    return { p, a, l, unm };
  }, [filteredEmployees, todayRecords]);

  const handleExport = async () => {
    const [yStr, mStr] = date.split("-");
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

    let records: AttendanceRecord[] = [];
    try {
      records = await fetchAllRows<AttendanceRecord>(() =>
        supabase
          .from("attendance_records")
          .select("employee_id, attendance_date, status")
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

    const byEmp = new Map<string, Map<number, AttendanceStatus>>();
    for (const r of records ?? []) {
      const day = Number((r as any).attendance_date.slice(8, 10));
      if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, new Map());
      byEmp.get(r.employee_id)!.set(day, (r as any).status as AttendanceStatus);
    }

    // Leave allowance comes from the employee's contract, falling back to their client
    // for records predating the move of this setting onto contracts.
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const contractById = new Map(contracts.map((c) => [c.id, c]));

    const rows: AttendanceEmployeeRow[] = filteredEmployees.map((emp, idx) => {
      const dayMap = byEmp.get(emp.id) ?? new Map<number, AttendanceStatus>();
      const statusByDay: string[] = [];
      let p = 0;
      let a = 0;
      let l = 0;
      for (let d = 1; d <= dim; d += 1) {
        const s = dayMap.get(d);
        if (s === "Present") {
          statusByDay.push("P");
          p += 1;
        } else if (s === "Absent") {
          statusByDay.push("A");
          a += 1;
        } else if (s === "Leave") {
          statusByDay.push("L");
          l += 1;
        } else {
          statusByDay.push("");
        }
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
        empCode: emp.employee_code,
        shift: emp.shift,
        statusByDay,
        presents: p,
        absents: a,
        leaves: l,
        payDays,
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
        title={relieversOnly ? "Reliever Attendance" : "Attendance Management"}
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
            <ExportButton onExport={handleExport} />
          </>
        }
      />

      <div className="flex-1 overflow-y-auto p-8">
        {/* Main tab bar */}
        <div className="flex gap-1 bg-slate-100 rounded-md p-1 mb-6 w-fit">
          {(["attendance", "shift_override"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setMainTab(t)}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${mainTab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
            >
              {t === "attendance" ? "Daily Attendance" : "Shift Override"}
            </button>
          ))}
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

        {mainTab === "attendance" && (<>

        {/* Metrics row OR per-employee calendar */}
        {!viewEmployee ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-lg border border-slate-200 border-l-4 border-l-success-500 p-4">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Present</p>
              <p className="text-2xl text-success-700">{stats.p}</p>
              <p className="text-[11px] text-slate-400 mt-1">on {date}</p>
            </div>
            <div className="bg-white rounded-lg border border-slate-200 border-l-4 border-l-danger-500 p-4">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Absent</p>
              <p className="text-2xl text-danger-700">{stats.a}</p>
              <p className="text-[11px] text-slate-400 mt-1">on {date}</p>
            </div>
            <div className="bg-white rounded-lg border border-slate-200 border-l-4 border-l-warning-500 p-4">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Leave</p>
              <p className="text-2xl text-warning-700">{stats.l}</p>
              <p className="text-[11px] text-slate-400 mt-1">on {date}</p>
            </div>
            {/* §28.2: unmarked is the figure that silently underpays — make it
                dominant (red) the moment any post is still unmarked for the day. */}
            <button
              type="button"
              onClick={() => setUnmarkedOnly((v) => !v)}
              title="Show only unmarked"
              className={`text-left rounded-lg border p-4 transition-colors ${
                stats.unm > 0
                  ? "bg-danger-50 border-danger-200 border-l-4 border-l-danger-500 hover:bg-danger-100"
                  : "bg-white border-slate-200 border-l-4 border-l-success-500"
              } ${unmarkedOnly ? "ring-2 ring-danger-400" : ""}`}
            >
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Unmarked</p>
              <p className={`text-2xl ${stats.unm > 0 ? "text-danger-700 font-semibold" : "text-success-700"}`}>{stats.unm}</p>
              <p className="text-[11px] text-slate-400 mt-1">{filteredEmployees.length} in filter · click to filter</p>
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
                  {viewEmployee.employee_code}
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

            <div className="grid grid-cols-7 gap-1 text-[10px] uppercase tracking-wider text-slate-500 mb-1">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div key={d} className="text-center py-1">{d}</div>
              ))}
            </div>

            {viewLoading ? (
              <div className="flex items-center gap-2 text-slate-500 py-6">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : (
              <div className="grid grid-cols-7 gap-1">
                {viewCalendarCells.map((c, i) => {
                  if (!c.date) {
                    return <div key={i} className="h-12 rounded bg-slate-50/50" />;
                  }
                  const status = viewRecords.get(c.date);
                  const tone =
                    status === "Present"
                      ? "bg-success-100 text-success-900 border-success-300"
                      : status === "Absent"
                        ? "bg-danger-100 text-danger-900 border-danger-300"
                        : status === "Leave"
                          ? "bg-warning-100 text-warning-900 border-warning-300"
                          : "bg-white text-slate-500 border-slate-200";
                  return (
                    <div
                      key={c.date}
                      className={`h-12 rounded border text-left p-1.5 ${tone}`}
                      title={status ? `${c.date}: ${status}` : `${c.date}: Unmarked`}
                    >
                      <div className="text-xs">{c.day}</div>
                      {status && (
                        <div className="text-[9px] uppercase tracking-wider opacity-80">
                          {status[0]}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-slate-500 mt-2">
              View-only. P = Present, A = Absent, L = Leave. White = unmarked.
            </p>
          </div>
        )}

        <div className="bg-white rounded-lg border border-slate-200 mb-6 p-6">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-2">Date</label>
              <div className="relative">
                <CalendarIcon
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 cursor-pointer"
                  strokeWidth={1.5}
                  onClick={() => dateInputRef.current?.showPicker()}
                />
                <input
                  ref={dateInputRef}
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-2">Search Employee</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
                <input
                  type="text"
                  placeholder="Name or ID…"
                  value={empSearch}
                  onChange={(e) => setEmpSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-2">Client</label>
              <ClientFilterSelect
                clients={clients}
                value={clientFilter}
                onChange={setClientFilter}
                allValue="all"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-2">Location</label>
              <select
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Locations</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-2">Branch</label>
              <select
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Branches</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            {!relieversOnly && (
              <div>
                <label className="block text-sm text-slate-700 mb-2">Category</label>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value as typeof categoryFilter)}
                  className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                >
                  <option value="all">All Categories</option>
                  <option value="client">Client</option>
                  <option value="office_staff">Office Staff</option>
                  <option value="reliever">Reliever</option>
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm text-slate-700 mb-2">Shift</label>
              <select
                value={shiftFilter}
                onChange={(e) => setShiftFilter(e.target.value as "all" | "day" | "night")}
                className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option value="all">All Shifts</option>
                <option value="day">Day</option>
                <option value="night">Night</option>
              </select>
            </div>
          </div>
          <label className="mt-4 inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={unmarkedOnly}
              onChange={(e) => setUnmarkedOnly(e.target.checked)}
              className="rounded border-slate-300"
            />
            <span>
              Show only employees with no attendance for{" "}
              <span className="font-mono text-slate-900">{date}</span>
            </span>
          </label>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-4 md:p-6 border-b border-slate-200 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base text-slate-900">Mark Attendance — {date}</h3>
              <p className="text-xs text-slate-500 mt-1">
                {filteredEmployees.length} employee{filteredEmployees.length === 1 ? "" : "s"} •{" "}
                <span className="text-success-600">{stats.p} present</span> ·{" "}
                <span className="text-danger-600">{stats.a} absent</span> ·{" "}
                <span className="text-warning-600">{stats.l} leave</span> ·{" "}
                <span className="text-slate-500">{stats.unm} unmarked</span>
              </p>
            </div>
            <div className="flex items-center gap-2 self-stretch md:self-auto">
              {lastBulk && lastBulk.date === date && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={undoMarkAll}
                  disabled={undoing}
                  className="whitespace-nowrap"
                >
                  {undoing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    "Undo Mark All"
                  )}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={markAllPresent}
                disabled={filteredEmployees.length === 0}
                className="whitespace-nowrap"
              >
                Mark All Present
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Employee ID</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Name</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">
                    {relieversOnly ? "Worked for" : "Client"}
                  </th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Location</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Shift</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
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
                  filteredEmployees.map((employee) => {
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
                            {employee.employee_code}
                          </button>
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
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {employee.category === "reliever" ? (
                            <select
                              value={todayWorkedFor[employee.id] ?? ""}
                              onChange={(e) => {
                                const newClient = e.target.value || null;
                                setTodayWorkedFor((m) => ({ ...m, [employee.id]: newClient }));
                                // If they're already marked Present, persist the change.
                                if (current === "Present" && newClient) {
                                  markStatus(employee.id, "Present", newClient);
                                }
                              }}
                              className="px-2 py-1 border border-slate-200 rounded text-sm max-w-[12rem]"
                            >
                              <option value="">Pick client…</option>
                              {clients.map((c) => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                              ))}
                            </select>
                          ) : (
                            employee.client_name ?? "—"
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {employee.location_name ?? "—"}
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs capitalize ${
                              employee.shift === "day"
                                ? "bg-warning-50 text-warning-700"
                                : "bg-indigo-50 text-indigo-700"
                            }`}
                          >
                            {employee.shift}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex gap-2 items-center">
                            {STATUSES.map((status) => (
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
                                    status === "Present" &&
                                    !todayWorkedFor[employee.id])
                                }
                                title={
                                  beforeEffective
                                    ? `Assignment starts ${employee.assignment_effective_from}. Attendance can't be marked before this date.`
                                    : undefined
                                }
                                className={`px-3 py-1.5 rounded text-xs transition-colors ${
                                  current === status
                                    ? status === "Present"
                                      ? "bg-success-100 text-success-700"
                                      : status === "Absent"
                                      ? "bg-danger-100 text-danger-700"
                                      : "bg-warning-100 text-warning-700"
                                    : "bg-slate-50 text-slate-600 hover:bg-slate-100"
                                } disabled:opacity-50`}
                              >
                                {status}
                              </button>
                            ))}
                            {current === "Present" && (
                              <button
                                type="button"
                                onClick={() => openDetailsEditor(employee)}
                                className="p-1.5 rounded text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                                title="Half-day / Late / Overtime"
                              >
                                <MoreHorizontal className="w-4 h-4" />
                              </button>
                            )}
                            {isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
                          </div>
                        </td>
                      </tr>
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
                  onChange={(e) => setHistoryFrom(e.target.value)}
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
                  onChange={(e) => setHistoryTo(e.target.value)}
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

        </>)}

        {mainTab === "shift_override" && (
          <div className="space-y-4">
            {/* Filters */}
            <div className="bg-white rounded-lg border border-slate-200 p-4 flex flex-wrap gap-4 items-end">
              <div>
                <label className="block text-sm text-slate-700 mb-2">Date</label>
                <input
                  type="date"
                  value={overrideDate}
                  onChange={(e) => setOverrideDate(e.target.value)}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-2">Base Shift</label>
                <select
                  value={overrideShiftFilter}
                  onChange={(e) => setOverrideShiftFilter(e.target.value as typeof overrideShiftFilter)}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                >
                  <option value="all">All Shifts</option>
                  <option value="day">Day</option>
                  <option value="night">Night</option>
                </select>
              </div>
              <div className="flex-1 min-w-[180px]">
                <label className="block text-sm text-slate-700 mb-2">Search Employee</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
                  <input
                    type="text"
                    placeholder="Name or ID…"
                    value={overrideSearch}
                    onChange={(e) => setOverrideSearch(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                  />
                </div>
              </div>
            </div>

            {/* Override table */}
            <div className="bg-white rounded-lg border border-slate-200">
              <div className="p-4 border-b border-slate-200">
                <h3 className="text-base text-slate-900">Shift Overrides — {overrideDate}</h3>
                <p className="text-xs text-slate-500 mt-1">
                  Toggle a guard's shift for this day only. Attendance will be marked against the working shift.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Employee</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Base Shift</th>
                      <th className="text-left px-6 py-3 text-sm text-slate-500">Working Shift</th>
                      <th className="text-right px-6 py-3 text-sm text-slate-500">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {filteredOverrideEmployees.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-6 py-10 text-center text-slate-500 text-sm">
                          No guards found.
                        </td>
                      </tr>
                    )}
                    {filteredOverrideEmployees.map((emp) => {
                      const overrideShift = overrides.get(emp.id);
                      const workingShift = overrideShift ?? emp.shift;
                      const isSaving = overrideSaving.has(emp.id);
                      return (
                        <tr key={emp.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-6 py-4">
                            <p className="text-sm text-slate-900">{emp.full_name}</p>
                            <p className="text-xs text-slate-500 font-mono">{emp.employee_code}</p>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${emp.shift === "day" ? "bg-amber-50 text-amber-700" : "bg-indigo-50 text-indigo-700"}`}>
                              {emp.shift === "day" ? "Day" : "Night"}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs ${workingShift === "day" ? "bg-amber-50 text-amber-700" : "bg-indigo-50 text-indigo-700"}`}>
                              {workingShift === "day" ? "Day" : "Night"}
                              {overrideShift && <span className="text-slate-500">(override)</span>}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <Button
                              variant={overrideShift ? "danger" : "secondary"}
                              size="sm"
                              disabled={isSaving}
                              onClick={() => toggleShiftOverride(emp)}
                            >
                              {isSaving
                                ? "Saving…"
                                : overrideShift
                                ? "Revert"
                                : `Switch to ${emp.shift === "day" ? "Night" : "Day"}`}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

      </div>

      <Modal
        isOpen={detailRecord !== null}
        onClose={() => setDetailRecord(null)}
        title="Attendance Details"
        size="lg"
      >
        {detailRecord && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4 pb-4 border-b border-slate-200 text-sm">
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

            <div className="grid grid-cols-3 gap-4">
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
                      <span className="font-mono text-slate-500">{e.employee_code}</span>
                      <span className="text-slate-900">{e.full_name}</span>
                    </div>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
                        e.status === "Present"
                          ? "bg-success-50 text-success-700"
                          : e.status === "Absent"
                          ? "bg-danger-50 text-danger-700"
                          : "bg-warning-50 text-warning-700"
                      }`}
                    >
                      {e.status}
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

      <Modal
        isOpen={isBulkOpen}
        onClose={() => setIsBulkOpen(false)}
        title="Bulk Mark Attendance"
        size="lg"
      >
        <div className="space-y-4">
          {/* Filters */}
          {!bulkEmployee && (
            <div className="grid grid-cols-2 gap-2">
              {!relieversOnly && (
                <select
                  value={bulkCategoryFilter}
                  onChange={(e) => { setBulkCategoryFilter(e.target.value as typeof bulkCategoryFilter); setBulkEmployeeId(""); }}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm"
                >
                  <option value="all">All Categories</option>
                  <option value="client">Client Guards</option>
                  <option value="office_staff">Office Staff</option>
                  <option value="reliever">Relievers</option>
                </select>
              )}
              <select
                value={bulkShiftFilter}
                onChange={(e) => { setBulkShiftFilter(e.target.value as typeof bulkShiftFilter); setBulkEmployeeId(""); }}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="all">All Shifts</option>
                <option value="day">Day</option>
                <option value="night">Night</option>
              </select>
              <select
                value={bulkClientFilter}
                onChange={(e) => { setBulkClientFilter(e.target.value); setBulkEmployeeId(""); }}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="all">All Clients</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select
                value={bulkLocationFilter}
                onChange={(e) => { setBulkLocationFilter(e.target.value); setBulkEmployeeId(""); }}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="all">All Locations</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <select
                value={bulkBranchFilter}
                onChange={(e) => { setBulkBranchFilter(e.target.value); setBulkEmployeeId(""); }}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm col-span-2"
              >
                <option value="all">All Branches</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}

          {/* Employee picker */}
          <div>
            <label className="block text-xs uppercase tracking-wider text-slate-500 mb-2">
              Employee
            </label>
            {bulkEmployee ? (
              <div className="flex items-center justify-between gap-3 p-3 border border-slate-200 rounded-md bg-slate-50">
                <div className="min-w-0">
                  <div className="text-sm text-slate-900 truncate">{bulkEmployee.full_name}</div>
                  <div className="text-xs text-slate-500 font-mono">
                    {bulkEmployee.employee_code}
                    {bulkEmployee.client_name && ` · ${bulkEmployee.client_name}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setBulkEmployeeId("");
                    setBulkSelected(new Set());
                  }}
                  className="text-xs text-slate-500 hover:text-slate-900 underline"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
                  <input
                    autoFocus
                    type="text"
                    value={bulkEmpSearch}
                    onChange={(e) => setBulkEmpSearch(e.target.value)}
                    placeholder="Search name or code…"
                    className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <div className="max-h-44 overflow-y-auto border border-slate-200 rounded-md">
                  {bulkEmployeeOptions.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-slate-500">No matches.</div>
                  ) : (
                    bulkEmployeeOptions.map((e) => (
                      <button
                        type="button"
                        key={e.id}
                        onClick={() => setBulkEmployeeId(e.id)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                      >
                        <div className="text-slate-900">{e.full_name}</div>
                        <div className="text-xs text-slate-500 font-mono">
                          {e.employee_code}
                          {e.client_name && ` · ${e.client_name}`}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {bulkEmployee && (
            <>
              {/* Month nav */}
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => shiftBulkMonth(-1)}
                  className="p-2 rounded hover:bg-slate-100 text-slate-700"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="text-sm text-slate-900">
                  {new Date(`${bulkMonth}-01T00:00:00`).toLocaleDateString(undefined, {
                    month: "long",
                    year: "numeric",
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => shiftBulkMonth(1)}
                  className="p-2 rounded hover:bg-slate-100 text-slate-700"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Selection helpers */}
              <div className="flex flex-wrap gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    const all = new Set<string>();
                    for (const c of bulkCalendarCells) {
                      if (c.date) all.add(c.date);
                    }
                    setBulkSelected(all);
                  }}
                  className="px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50"
                >
                  Select month
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const wk = new Set<string>();
                    for (const c of bulkCalendarCells) {
                      if (!c.date) continue;
                      const d = new Date(`${c.date}T00:00:00`).getDay();
                      if (d !== 0 && d !== 6) wk.add(c.date);
                    }
                    setBulkSelected(wk);
                  }}
                  className="px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50"
                >
                  Weekdays only
                </button>
                <button
                  type="button"
                  onClick={() => setBulkSelected(new Set())}
                  className="px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50"
                >
                  Clear selection
                </button>
                <span className="ml-auto text-slate-500 self-center">
                  {bulkSelected.size} day{bulkSelected.size === 1 ? "" : "s"} selected
                </span>
              </div>

              {/* Calendar grid */}
              <div
                className="select-none"
                onMouseUp={endBulkDrag}
                onMouseLeave={endBulkDrag}
              >
                <div className="grid grid-cols-7 gap-1 text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                    <div key={d} className="text-center py-1">{d}</div>
                  ))}
                </div>
                {bulkLoading ? (
                  <div className="flex items-center gap-2 text-slate-500 py-6">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                  </div>
                ) : (
                  <div className="grid grid-cols-7 gap-1">
                    {bulkCalendarCells.map((c, i) => {
                      if (!c.date) {
                        return <div key={i} className="h-12 rounded bg-slate-50/50" />;
                      }
                      const status = bulkExisting.get(c.date);
                      const selected = bulkSelected.has(c.date);
                      const statusClass =
                        status === "Present"
                          ? "bg-success-50 text-success-800 border-success-200"
                          : status === "Absent"
                            ? "bg-danger-50 text-danger-800 border-danger-200"
                            : status === "Leave"
                              ? "bg-warning-50 text-warning-800 border-warning-200"
                              : "bg-white text-slate-700 border-slate-200";
                      const ring = selected ? "ring-2 ring-slate-900 ring-offset-1" : "";
                      return (
                        <button
                          key={c.date}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            startBulkDrag(c.date!);
                          }}
                          onMouseEnter={() => extendBulkDrag(c.date!)}
                          className={`h-12 rounded border text-left p-1.5 transition-colors ${statusClass} ${ring}`}
                          title={status ? `Currently: ${status}` : "Unmarked"}
                        >
                          <div className="text-xs">{c.day}</div>
                          {status && (
                            <div className="text-[9px] uppercase tracking-wider opacity-70">
                              {status[0]}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="text-[11px] text-slate-500 mt-2">
                  Tap a date to toggle, or press and drag to select a whole range (everything between the
                  start and where you drag fills in automatically). P = Present, A = Absent, L = Leave.
                </p>
              </div>

              {bulkError && (
                <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2 rounded">
                  {bulkError}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => applyBulkStatus("Present")}
                  disabled={bulkSubmitting || bulkSelected.size === 0}
                  className="flex-1 min-w-[120px] px-3 py-2 rounded-md text-sm bg-success-600 text-white hover:bg-success-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Mark Present
                </button>
                <button
                  type="button"
                  onClick={() => applyBulkStatus("Absent")}
                  disabled={bulkSubmitting || bulkSelected.size === 0}
                  className="flex-1 min-w-[120px] px-3 py-2 rounded-md text-sm bg-danger-600 text-white hover:bg-danger-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Mark Absent
                </button>
                <button
                  type="button"
                  onClick={() => applyBulkStatus("Leave")}
                  disabled={bulkSubmitting || bulkSelected.size === 0}
                  className="flex-1 min-w-[120px] px-3 py-2 rounded-md text-sm bg-warning-500 text-white hover:bg-warning-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Mark Leave
                </button>
                <button
                  type="button"
                  onClick={clearBulkSelected}
                  disabled={bulkSubmitting || bulkSelected.size === 0}
                  className="px-3 py-2 rounded-md text-sm border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Clear marks
                </button>
                {bulkSubmitting && (
                  <span className="self-center text-xs text-slate-500 flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Saving…
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* Sprint 3 — half-day / late / OT editor for a Present employee */}
      <Modal
        isOpen={detailsEmp !== null}
        onClose={() => setDetailsEmp(null)}
        title={detailsEmp ? `Attendance details — ${detailsEmp.full_name}` : ""}
        size="sm"
      >
        {detailsEmp && (
          <div className="space-y-3">
            <div className="text-xs text-slate-500">
              Date: <strong className="text-slate-700">{date}</strong> ·
              <span className="ml-1 font-mono">{detailsEmp.employee_code}</span>
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
