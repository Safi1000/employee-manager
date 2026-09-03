// Builds the monthly attendance-sheet rows (the AttendanceEmployeeRow[] the Excel
// exporter and the on-screen viewer both consume) from attendance_records. Pulled
// out of AttendanceManagement so the timesheet export and the per-client/site
// "View attendance" modal share ONE source of truth for what a month looks like.

import { supabase, fetchAllRows, resolveAllowedLeaves, type Contract, type Client } from "./supabase";
import { loadShiftResolver } from "./shiftOnDate";
import { attendanceWindowError, hiddenFromAttendance, isSeparatedState, SEPARATION_MARK } from "./employmentWindow";
import { guardDisplayCode } from "./guardCode";
import { formatDate } from "./date";
import type { AttendanceEmployeeRow } from "./excel";

export type SheetEmployee = {
  id: string;
  full_name: string;
  display_code: string;
  contract_id: string | null;
  client_id: string | null;
  join_date: string | null;
  last_working_day: string | null;
  termination_date: string | null;
  lifecycle_state: string | null;
  shift: string | null;
};

// P/A/L/DD symbol from either vocabulary (legacy Present/Absent/Leave or the
// spec's present/absent/rotation_leave/…). Worked statuses count as present;
// double duty keeps its own symbol so the sheet can show the second shift.
const symbolOf = (raw: unknown): "P" | "A" | "L" | "DD" | "" => {
  const s = String(raw ?? "").toLowerCase();
  if (s === "double_duty") return "DD";
  if (s === "present" || s === "relief_cover") return "P";
  if (s === "absent") return "A";
  if (s === "leave" || s === "rotation_leave" || s === "rest_day") return "L";
  return "";
};

// "Fired 10/03/2026" / "Resigned 01/04/2026", or null for anyone still employed.
const separationNote = (e: SheetEmployee): string | null => {
  if (!isSeparatedState(e.lifecycle_state)) return null;
  const on = e.termination_date ?? e.last_working_day;
  const label =
    e.lifecycle_state === "left" ? "Resigned / left"
      : e.lifecycle_state === "absconded" ? "Absconded"
        : "Fired";
  return on ? `${label} ${formatDate(on)}` : label;
};

export async function buildAttendanceRows(opts: {
  month: string; // "YYYY-MM"
  employees: SheetEmployee[];
  contracts: Contract[];
  clients: Client[];
  // When supplied, a day's mark is shown ONLY if this returns true for it. The
  // Monthly Board uses this to display exclusively supervisor-confirmed
  // attendance — an unconfirmed mark (bulk-marked, reported, awaiting) renders
  // as blank, exactly as if it were never entered.
  confirmedOnly?: (empId: string, iso: string, workedShift: string) => boolean;
}): Promise<{ rows: AttendanceEmployeeRow[]; daysInMonth: number; monthLabel: string; cellsByEmp: Map<string, Map<string, string>> }> {
  const { month, employees, contracts, clients, confirmedOnly } = opts;
  const [yStr, mStr] = month.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const dim = new Date(y, m, 0).getDate();
  const monthStart = `${yStr}-${mStr}-01`;
  const monthEnd = `${yStr}-${mStr}-${String(dim).padStart(2, "0")}`;
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // A guard separated BEFORE this month is not on this month's sheet at all.
  // Without this the caller's roster (built for "now") carried anyone who left
  // in July into the August sheet, where every day rendered as X. Someone who
  // left mid-month is kept: his worked days that month are real, and the days
  // after his exit already mark themselves X via attendanceWindowError below.
  const roster = employees.filter((e) => !hiddenFromAttendance(e, monthStart));

  const empIds = roster.map((e) => e.id);
  if (empIds.length === 0) return { rows: [], daysInMonth: dim, monthLabel, cellsByEmp: new Map() };

  const records = await fetchAllRows<any>(() =>
    supabase
      .from("attendance_records")
      .select("employee_id, attendance_date, status, worked_shift, supervisor_override")
      .gte("attendance_date", monthStart)
      .lte("attendance_date", monthEnd)
      .in("employee_id", empIds)
      // Full unique key order (date alone is NOT unique) so paginated range()
      // fetches are STABLE — otherwise rows sharing a date at the 1000-row page
      // boundary get skipped between pages, blanking a whole day for big rosters.
      .order("attendance_date", { ascending: true })
      .order("employee_id", { ascending: true })
      .order("worked_shift", { ascending: true }) as unknown as {
      range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
    },
  );

  const byEmp = new Map<string, Map<number, { sym: string; ws: string; ovr: boolean }>>();
  // Per-(day, shift) status for EVERY visible mark a guard has — the grid renders
  // a cell per shift column from this, so a double-duty day (two worked shifts)
  // shows in both columns. A mark is visible if the supervisor confirmed it OR it
  // was set by an override (the one edit allowed once locked). Keyed `${day}|${shift}`.
  const cellsByEmp = new Map<string, Map<string, string>>();
  for (const r of records ?? []) {
    const day = Number(String(r.attendance_date).slice(8, 10));
    const ws = (r.worked_shift as string) ?? "day";
    const ovr = !!r.supervisor_override;
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, new Map());
    // dayMap keeps one record per day for the export's single-column view (last
    // wins, as before). `cells` below keeps every shift for the on-screen grid.
    byEmp.get(r.employee_id)!.set(day, { sym: symbolOf(r.status), ws, ovr });
    const visible = !confirmedOnly || confirmedOnly(r.employee_id, String(r.attendance_date), ws) || ovr;
    if (visible) {
      const m = cellsByEmp.get(r.employee_id) ?? new Map<string, string>();
      m.set(`${day}|${ws}`, symbolOf(r.status));
      cellsByEmp.set(r.employee_id, m);
    }
  }

  const resolveShift = await loadShiftResolver(empIds);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const contractById = new Map(contracts.map((c) => [c.id, c]));

  const rows: AttendanceEmployeeRow[] = roster.map((emp, idx) => {
    const dayMap = byEmp.get(emp.id) ?? new Map<number, { sym: string; ws: string; ovr: boolean }>();
    const contract = emp.contract_id ? contractById.get(emp.contract_id) ?? null : null;
    const statusByDay: string[] = [];
    const shiftByDay: string[] = [];
    let p = 0, a = 0, l = 0, dd = 0;
    for (let d = 1; d <= dim; d += 1) {
      let cell = dayMap.get(d);
      const iso = `${yStr}-${mStr}-${String(d).padStart(2, "0")}`;
      // Hide any mark the supervisor hasn't confirmed — it reads as unmarked.
      // An override always shows (it's the one edit allowed on a locked day).
      if (cell && confirmedOnly && !confirmedOnly(emp.id, iso, cell.ws) && !cell.ovr) cell = undefined;
      // No record AND not employed that day → "X" (separated / pre-join / off-contract),
      // otherwise blank. A real record always wins — history is reported as-is.
      const sym = cell?.sym ?? (attendanceWindowError(emp, contract, iso) ? SEPARATION_MARK : "");
      statusByDay.push(sym);
      if (sym === "P") p += 1;
      else if (sym === "DD") { p += 1; dd += 1; }
      else if (sym === "A") a += 1;
      else if (sym === "L") l += 1;
      shiftByDay.push((cell?.ws ?? resolveShift(emp.id, iso)) || "day");
    }
    const allowed = resolveAllowedLeaves(
      contract,
      emp.client_id ? clientById.get(emp.client_id) : null,
    );
    const payDays = p + Math.min(l, allowed);
    return {
      serial: idx + 1,
      empId: emp.id,
      name: emp.full_name,
      designation: "",
      empCode: emp.display_code,
      shift: resolveShift(emp.id, monthStart) || "day",
      shiftByDay,
      statusByDay,
      presents: p,
      absents: a,
      leaves: l,
      doubleDuties: dd,
      payDays,
      separationNote: separationNote(emp),
    };
  });

  return { rows, daysInMonth: dim, monthLabel, cellsByEmp };
}

// Standalone reliever-coverage rows for ONE client's Monthly Board: employees who
// are CURRENTLY relievers (category='reliever') and stood for this client on some
// day(s), keyed by attendance_records.worked_for_client_id (0030). Detection is by
// current category — NOT by worked_for_client_id alone, because the Attendance
// board's confirm() writes worked_for_client_id for every roster guard, so that
// column is set on ordinary regular-guard attendance too and cannot mark a
// reliever day on its own. Each reliever becomes one row with ONLY the days they
// covered marked, every other day BLANK (never "X" — a reliever gap is expected).
// relieverByDay is all-true, so the OPS-Verify no-gaps rule and the strength
// totals skip them. Not gated on attendance_confirmations (no confirm loop for
// reliever marks). Guards on the roster are excluded (excludeEmpIds) as a safety
// net — a reliever has no client_id so isn't on a roster anyway.
export async function buildRelieverRows(opts: {
  month: string; // "YYYY-MM"
  clientId: string; // real client uuid (relievers never attribute to a category group)
  clientPrefix?: string | null;
  excludeEmpIds?: Iterable<string>; // roster ids already rendered as regular rows
}): Promise<AttendanceEmployeeRow[]> {
  const { month, clientId, clientPrefix = null } = opts;
  const exclude = new Set(opts.excludeEmpIds ?? []);
  const [yStr, mStr] = month.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const dim = new Date(y, m, 0).getDate();
  const monthStart = `${yStr}-${mStr}-01`;
  const monthEnd = `${yStr}-${mStr}-${String(dim).padStart(2, "0")}`;

  const records = await fetchAllRows<any>(() =>
    supabase
      .from("attendance_records")
      .select("employee_id, attendance_date, status, worked_shift")
      .eq("worked_for_client_id", clientId)
      .gte("attendance_date", monthStart)
      .lte("attendance_date", monthEnd)
      .order("attendance_date", { ascending: true })
      .order("employee_id", { ascending: true })
      .order("worked_shift", { ascending: true }) as unknown as {
      range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
    },
  );
  const recs = (records ?? []) as any[];
  if (recs.length === 0) return [];

  const empIds = [...new Set(recs.map((r) => r.employee_id))].filter((id) => !exclude.has(id));
  if (empIds.length === 0) return [];
  // Only CURRENT relievers. worked_for_client_id is written for all roster guards
  // by confirm(), so filtering by it alone would surface every regular guard here.
  const { data: emps } = await supabase
    .from("employees")
    .select("id, full_name, guard_code, display_number, employee_code")
    .in("id", empIds)
    .eq("category", "reliever");
  const empById = new Map(((emps ?? []) as any[]).map((e) => [e.id, e]));
  if (empById.size === 0) return [];

  const byEmp = new Map<string, Map<number, { sym: string; ws: string }>>();
  for (const r of recs) {
    if (!empById.has(r.employee_id)) continue;
    const day = Number(String(r.attendance_date).slice(8, 10));
    const ws = (r.worked_shift as string) ?? "day";
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, new Map());
    byEmp.get(r.employee_id)!.set(day, { sym: symbolOf(r.status), ws });
  }

  const rows: AttendanceEmployeeRow[] = [];
  for (const [empId, dayMap] of byEmp) {
    const e = empById.get(empId)!;
    const statusByDay: string[] = [];
    const shiftByDay: string[] = [];
    const relieverByDay: boolean[] = [];
    let p = 0, a = 0, l = 0, dd = 0;
    for (let d = 1; d <= dim; d += 1) {
      const cell = dayMap.get(d);
      const sym = cell?.sym ?? ""; // unworked day → blank, never X
      statusByDay.push(sym);
      relieverByDay.push(true); // whole row is reliever cover → every day gap-exempt
      if (sym === "P") p += 1;
      else if (sym === "DD") { p += 1; dd += 1; }
      else if (sym === "A") a += 1;
      else if (sym === "L") l += 1;
      shiftByDay.push(cell?.ws ?? "day");
    }
    rows.push({
      serial: 0,
      empId,
      name: e.full_name,
      designation: "Reliever",
      empCode: guardDisplayCode(e, clientPrefix),
      shift: shiftByDay.find((s) => s) ?? "day",
      shiftByDay,
      statusByDay,
      presents: p,
      absents: a,
      leaves: l,
      doubleDuties: dd,
      payDays: p, // display only — reliever pay is per-day, computed in payroll
      isReliever: true,
      relieverByDay,
    });
  }
  rows.sort((x, z) => x.name.localeCompare(z.name));
  rows.forEach((r, i) => (r.serial = i + 1));
  return rows;
}
