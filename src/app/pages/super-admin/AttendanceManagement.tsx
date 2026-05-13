import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar as CalendarIcon, AlertCircle, Loader2, X, CalendarRange, ChevronLeft, ChevronRight, Search } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import { exportAttendance, type AttendanceEmployeeRow } from "../../lib/excel";
import {
  supabase,
  fetchAllRows,
  type AttendanceStatus,
  type AttendanceRecord,
  type Client,
  type Location,
} from "../../lib/supabase";
import { hasPermission, useAuth } from "../../lib/auth";

type EmployeeLite = {
  id: string;
  employee_code: string;
  full_name: string;
  location_id: string | null;
  location_name: string | null;
  client_id: string | null;
  client_name: string | null;
  shift: "day" | "night";
};

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

export default function AttendanceManagement() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [todayRecords, setTodayRecords] = useState<Record<string, AttendanceStatus>>({});
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const [date, setDate] = useState<string>(today());
  const [clientFilter, setClientFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [shiftFilter, setShiftFilter] = useState<"all" | "day" | "night">("all");
  const [unmarkedOnly, setUnmarkedOnly] = useState<boolean>(false);
  const [empSearch, setEmpSearch] = useState("");
  const [historyFrom, setHistoryFrom] = useState<string>(daysAgo(13));
  const [historyTo, setHistoryTo] = useState<string>(today());

  const [detailRecord, setDetailRecord] = useState<HistoryRow | null>(null);

  const { profile } = useAuth();
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

  const bulkEmployee = useMemo(
    () => employees.find((e) => e.id === bulkEmployeeId),
    [employees, bulkEmployeeId],
  );

  const bulkEmployeeOptions = useMemo(() => {
    const q = bulkEmpSearch.trim().toLowerCase();
    if (!q) return employees.slice(0, 50);
    return employees
      .filter(
        (e) =>
          e.full_name.toLowerCase().includes(q) ||
          e.employee_code.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [employees, bulkEmpSearch]);

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
    setIsBulkOpen(true);
  };

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

  const applyBulkDrag = (date: string) => {
    if (!bulkDragMode) return;
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (bulkDragMode === "add") next.add(date);
      else next.delete(date);
      return next;
    });
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
    const [locRes, cliRes, empRes] = await Promise.all([
      supabase.from("locations").select("*").order("name"),
      supabase.from("clients").select("*").order("name"),
      supabase
        .from("employees")
        .select(
          "id, employee_code, full_name, location_id, client_id, shift, location:location_id(name), client:client_id(name)"
        )
        .order("full_name"),
    ]);
    if (locRes.error) setError(locRes.error.message);
    if (cliRes.error) setError(cliRes.error.message);
    if (empRes.error) setError(empRes.error.message);
    setLocations(locRes.data ?? []);
    setClients(cliRes.data ?? []);
    setEmployees(
      (empRes.data ?? []).map((e: any) => ({
        id: e.id,
        employee_code: e.employee_code,
        full_name: e.full_name,
        location_id: e.location_id,
        location_name: e.location?.name ?? null,
        client_id: e.client_id,
        client_name: e.client?.name ?? null,
        shift: e.shift,
      }))
    );
  };

  const loadRecordsForDate = async (d: string) => {
    const { data, error: err } = await supabase
      .from("attendance_records")
      .select("employee_id, status")
      .eq("attendance_date", d);
    if (err) {
      setError(err.message);
      return;
    }
    const map: Record<string, AttendanceStatus> = {};
    (data ?? []).forEach((r: any) => {
      map[r.employee_id] = r.status;
    });
    setTodayRecords(map);
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
  }, []);

  useEffect(() => {
    loadRecordsForDate(date);
  }, [date]);

  useEffect(() => {
    if (employees.length === 0) return;
    loadHistory();
  }, [historyFrom, historyTo, employees, clientFilter, locationFilter, shiftFilter]);

  const filteredEmployees = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    return employees.filter((e) => {
      if (clientFilter !== "all" && e.client_id !== clientFilter) return false;
      if (locationFilter !== "all" && e.location_id !== locationFilter) return false;
      if (shiftFilter !== "all" && e.shift !== shiftFilter) return false;
      if (unmarkedOnly && todayRecords[e.id]) return false;
      if (q && !e.full_name.toLowerCase().includes(q) && !e.employee_code.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [employees, clientFilter, locationFilter, shiftFilter, unmarkedOnly, todayRecords, empSearch]);

  const markStatus = async (employeeId: string, status: AttendanceStatus) => {
    setSaving((s) => ({ ...s, [employeeId]: true }));
    setError(null);
    const prev = todayRecords[employeeId];
    setTodayRecords((m) => ({ ...m, [employeeId]: status }));
    const { error: upErr } = await supabase
      .from("attendance_records")
      .upsert(
        { employee_id: employeeId, attendance_date: date, status },
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
        if (prev) n[employeeId] = prev;
        else delete n[employeeId];
        return n;
      });
      return;
    }
    loadHistory();
  };

  const markAllPresent = async () => {
    if (filteredEmployees.length === 0) return;
    const payload = filteredEmployees.map((e) => ({
      employee_id: e.id,
      attendance_date: date,
      status: "Present" as AttendanceStatus,
    }));
    const optimistic: Record<string, AttendanceStatus> = { ...todayRecords };
    filteredEmployees.forEach((e) => {
      optimistic[e.id] = "Present";
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

    const allowedByClient = new Map<string, number>();
    for (const c of clients) {
      allowedByClient.set(c.id, Number((c as any).allowed_leaves_per_month ?? 0));
    }

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
      const allowed = emp.client_id ? allowedByClient.get(emp.client_id) ?? 0 : 0;
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
        title="Attendance Management"
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
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 text-red-700 border border-red-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Metrics row OR per-employee calendar */}
        {!viewEmployee ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <p className="text-xs text-slate-500 mb-1">Present</p>
              <p className="text-2xl text-green-700">{stats.p}</p>
              <p className="text-[11px] text-slate-400 mt-1">on {date}</p>
            </div>
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <p className="text-xs text-slate-500 mb-1">Absent</p>
              <p className="text-2xl text-red-700">{stats.a}</p>
              <p className="text-[11px] text-slate-400 mt-1">on {date}</p>
            </div>
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <p className="text-xs text-slate-500 mb-1">Leave</p>
              <p className="text-2xl text-amber-700">{stats.l}</p>
              <p className="text-[11px] text-slate-400 mt-1">on {date}</p>
            </div>
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <p className="text-xs text-slate-500 mb-1">Unmarked</p>
              <p className="text-2xl text-slate-700">{stats.unm}</p>
              <p className="text-[11px] text-slate-400 mt-1">{filteredEmployees.length} in filter</p>
            </div>
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
                  <span className="text-green-700">{viewStats.p} present</span> ·{" "}
                  <span className="text-red-700">{viewStats.a} absent</span> ·{" "}
                  <span className="text-amber-700">{viewStats.l} leave</span> ·{" "}
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
                      ? "bg-green-100 text-green-900 border-green-300"
                      : status === "Absent"
                        ? "bg-red-100 text-red-900 border-red-300"
                        : status === "Leave"
                          ? "bg-amber-100 text-amber-900 border-amber-300"
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
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
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
                <span className="text-green-600">{stats.p} present</span> ·{" "}
                <span className="text-red-600">{stats.a} absent</span> ·{" "}
                <span className="text-amber-600">{stats.l} leave</span> ·{" "}
                <span className="text-slate-500">{stats.unm} unmarked</span>
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={markAllPresent}
              disabled={filteredEmployees.length === 0}
              className="self-stretch md:self-auto whitespace-nowrap"
            >
              Mark All Present
            </Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Employee ID</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Name</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
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
                    return (
                      <tr key={employee.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4 text-sm font-mono">
                          <button
                            type="button"
                            onClick={() => setViewEmployee(employee)}
                            className="text-blue-700 hover:text-blue-900 hover:underline"
                            title="View attendance calendar"
                          >
                            {employee.employee_code}
                          </button>
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <button
                            type="button"
                            onClick={() => setViewEmployee(employee)}
                            className="text-slate-900 hover:text-blue-700 hover:underline text-left"
                            title="View attendance calendar"
                          >
                            {employee.full_name}
                          </button>
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {employee.client_name ?? "—"}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-600">
                          {employee.location_name ?? "—"}
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs capitalize ${
                              employee.shift === "day"
                                ? "bg-amber-50 text-amber-700"
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
                                onClick={() => markStatus(employee.id, status)}
                                disabled={isSaving}
                                className={`px-3 py-1.5 rounded text-xs transition-colors ${
                                  current === status
                                    ? status === "Present"
                                      ? "bg-green-100 text-green-700"
                                      : status === "Absent"
                                      ? "bg-red-100 text-red-700"
                                      : "bg-yellow-100 text-yellow-700"
                                    : "bg-slate-50 text-slate-600 hover:bg-slate-100"
                                } disabled:opacity-50`}
                              >
                                {status}
                              </button>
                            ))}
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
                    <td className="px-6 py-4 text-sm text-green-600">{record.present}</td>
                    <td className="px-6 py-4 text-sm text-red-600">{record.absent}</td>
                    <td className="px-6 py-4 text-sm text-yellow-600">{record.leave}</td>
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
              <div className="bg-green-50 p-4 rounded-lg border border-green-200">
                <p className="text-sm text-green-700 mb-1">Present</p>
                <p className="text-2xl text-green-900">{detailRecord.present}</p>
              </div>
              <div className="bg-red-50 p-4 rounded-lg border border-red-200">
                <p className="text-sm text-red-700 mb-1">Absent</p>
                <p className="text-2xl text-red-900">{detailRecord.absent}</p>
              </div>
              <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
                <p className="text-sm text-amber-700 mb-1">Leave</p>
                <p className="text-2xl text-amber-900">{detailRecord.leave}</p>
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
                          ? "bg-green-50 text-green-700"
                          : e.status === "Absent"
                          ? "bg-red-50 text-red-700"
                          : "bg-yellow-50 text-yellow-700"
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
                onMouseUp={() => setBulkDragMode(null)}
                onMouseLeave={() => setBulkDragMode(null)}
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
                          ? "bg-green-50 text-green-800 border-green-200"
                          : status === "Absent"
                            ? "bg-red-50 text-red-800 border-red-200"
                            : status === "Leave"
                              ? "bg-amber-50 text-amber-800 border-amber-200"
                              : "bg-white text-slate-700 border-slate-200";
                      const ring = selected ? "ring-2 ring-slate-900 ring-offset-1" : "";
                      return (
                        <button
                          key={c.date}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            const isSel = bulkSelected.has(c.date!);
                            setBulkDragMode(isSel ? "remove" : "add");
                            toggleBulkCell(c.date!);
                          }}
                          onMouseEnter={() => applyBulkDrag(c.date!)}
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
                  Tap a date to toggle, or click-and-drag to multi-select. P = Present, A = Absent, L = Leave.
                </p>
              </div>

              {bulkError && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded">
                  {bulkError}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => applyBulkStatus("Present")}
                  disabled={bulkSubmitting || bulkSelected.size === 0}
                  className="flex-1 min-w-[120px] px-3 py-2 rounded-md text-sm bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Mark Present
                </button>
                <button
                  type="button"
                  onClick={() => applyBulkStatus("Absent")}
                  disabled={bulkSubmitting || bulkSelected.size === 0}
                  className="flex-1 min-w-[120px] px-3 py-2 rounded-md text-sm bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Mark Absent
                </button>
                <button
                  type="button"
                  onClick={() => applyBulkStatus("Leave")}
                  disabled={bulkSubmitting || bulkSelected.size === 0}
                  className="flex-1 min-w-[120px] px-3 py-2 rounded-md text-sm bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
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
    </>
  );
}
