import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar as CalendarIcon, AlertCircle, Loader2, X } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import ClientFilterSelect from "../../components/ClientFilterSelect";
import {
  supabase,
  type AttendanceStatus,
  type AttendanceRecord,
  type Client,
  type Location,
} from "../../lib/supabase";

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
  const [historyFrom, setHistoryFrom] = useState<string>(daysAgo(13));
  const [historyTo, setHistoryTo] = useState<string>(today());

  const [detailRecord, setDetailRecord] = useState<HistoryRow | null>(null);

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
    const { data, error: err } = await supabase
      .from("attendance_records")
      .select("employee_id, attendance_date, status")
      .gte("attendance_date", historyFrom)
      .lte("attendance_date", historyTo)
      .order("attendance_date", { ascending: false });
    if (err) {
      setError(err.message);
      return;
    }
    setHistory(buildHistoryRows((data ?? []) as AttendanceRecord[]));
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
    return employees.filter((e) => {
      if (clientFilter !== "all" && e.client_id !== clientFilter) return false;
      if (locationFilter !== "all" && e.location_id !== locationFilter) return false;
      if (shiftFilter !== "all" && e.shift !== shiftFilter) return false;
      return true;
    });
  }, [employees, clientFilter, locationFilter, shiftFilter]);

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

  return (
    <>
      <Header
        title="Attendance Management"
        actions={
          <ExportButton onExport={() => console.log("Export")} />
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

        <div className="bg-white rounded-lg border border-slate-200 mb-6 p-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
        </div>

        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-6 border-b border-slate-200 flex items-center justify-between">
            <div>
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
                        <td className="px-6 py-4 text-sm text-slate-600 font-mono">
                          {employee.employee_code}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-900">{employee.full_name}</td>
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
          <div className="p-6 border-b border-slate-200 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <h3 className="text-base text-slate-900">Attendance History</h3>
            <div className="flex items-center gap-3">
              <div className="relative">
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
                  className="pl-9 pr-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
              <span className="text-sm text-slate-400">to</span>
              <div className="relative">
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
                  className="pl-9 pr-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
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
    </>
  );
}
