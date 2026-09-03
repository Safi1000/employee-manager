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
  // The client whose board this is (null for a category group). A day a roster
  // guard spent as a RELIEVER (attendance_records.worked_for_client_id set) is
  // split out per-day: shown+labelled when they covered THIS client, blanked when
  // they covered another, and always exempt from the no-gaps rule. Reliever marks
  // bypass confirmedOnly (they have no supervisor-confirm loop).
  boardClientId?: string | null;
}): Promise<{ rows: AttendanceEmployeeRow[]; daysInMonth: number; monthLabel: string; cellsByEmp: Map<string, Map<string, string>> }> {
  const { month, employees, contracts, clients, confirmedOnly, boardClientId = null } = opts;
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
      .select("employee_id, attendance_date, status, worked_shift, supervisor_override, worked_for_client_id")
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

  const byEmp = new Map<string, Map<number, { sym: string; ws: string; ovr: boolean; wfc: string | null }>>();
  // Per-(day, shift) status for EVERY visible mark a guard has — the grid renders
  // a cell per shift column from this, so a double-duty day (two worked shifts)
  // shows in both columns. A mark is visible if the supervisor confirmed it OR it
  // was set by an override (the one edit allowed once locked). Keyed `${day}|${shift}`.
  const cellsByEmp = new Map<string, Map<string, string>>();
  for (const r of records ?? []) {
    const day = Number(String(r.attendance_date).slice(8, 10));
    const ws = (r.worked_shift as string) ?? "day";
    const ovr = !!r.supervisor_override;
    const wfc = (r.worked_for_client_id as string | null) ?? null; // set ⇒ reliever day
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, new Map());
    // dayMap keeps one record per day for the export's single-column view (last
    // wins, as before). `cells` below keeps every shift for the on-screen grid.
    byEmp.get(r.employee_id)!.set(day, { sym: symbolOf(r.status), ws, ovr, wfc });
    // A reliever day is shown without confirmation (no confirm loop for it); a
    // reliever day for ANOTHER client isn't this board's mark. Regular days keep
    // the confirmed-only gate.
    const relieverHere = wfc !== null && (!boardClientId || wfc === boardClientId);
    const relieverElsewhere = wfc !== null && !relieverHere;
    const visible = relieverHere || (wfc === null && (!confirmedOnly || confirmedOnly(r.employee_id, String(r.attendance_date), ws) || ovr));
    if (visible && !relieverElsewhere) {
      const m = cellsByEmp.get(r.employee_id) ?? new Map<string, string>();
      m.set(`${day}|${ws}`, symbolOf(r.status));
      cellsByEmp.set(r.employee_id, m);
    }
  }

  const resolveShift = await loadShiftResolver(empIds);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const contractById = new Map(contracts.map((c) => [c.id, c]));

  const rows: AttendanceEmployeeRow[] = roster.map((emp, idx) => {
    const dayMap = byEmp.get(emp.id) ?? new Map<number, { sym: string; ws: string; ovr: boolean; wfc: string | null }>();
    const contract = emp.contract_id ? contractById.get(emp.contract_id) ?? null : null;
    const statusByDay: string[] = [];
    const shiftByDay: string[] = [];
    const relieverByDay: boolean[] = [];
    let p = 0, a = 0, l = 0, dd = 0;
    for (let d = 1; d <= dim; d += 1) {
      const rec = dayMap.get(d);
      const iso = `${yStr}-${mStr}-${String(d).padStart(2, "0")}`;
      // Reliever day (record carried worked_for_client_id) — the per-day category
      // was "reliever", whatever the guard's category is now.
      const isReliever = !!rec && rec.wfc !== null;
      relieverByDay.push(isReliever);
      let sym = "";
      if (rec) {
        if (isReliever) {
          // Shown without confirmation, but only for the client they actually
          // covered; a reliever day for a different client is not this board's.
          sym = !boardClientId || rec.wfc === boardClientId ? rec.sym : "";
        } else {
          // Regular day: hide any mark the supervisor hasn't confirmed (override
          // always shows — the one edit allowed on a locked day).
          const shown = !confirmedOnly || confirmedOnly(emp.id, iso, rec.ws) || rec.ovr;
          sym = shown ? rec.sym : "";
        }
      }
      // No record AND not employed that day → "X" (separated / pre-join /
      // off-contract). Never on a reliever day — a reliever's off-days are blank
      // (allowed gaps), not separation marks.
      if (!sym && !isReliever && attendanceWindowError(emp, contract, iso)) sym = SEPARATION_MARK;
      statusByDay.push(sym);
      if (sym === "P") p += 1;
      else if (sym === "DD") { p += 1; dd += 1; }
      else if (sym === "A") a += 1;
      else if (sym === "L") l += 1;
      shiftByDay.push((rec?.ws ?? resolveShift(emp.id, iso)) || "day");
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
      relieverByDay: relieverByDay.some(Boolean) ? relieverByDay : undefined,
    };
  });

  return { rows, daysInMonth: dim, monthLabel, cellsByEmp };
}

// Standalone reliever-coverage rows for ONE client's Monthly Board: guards who
// stood for this client as a reliever on some day(s) but are NOT on its roster
// (pure relievers, or former relievers now assigned to a different client).
// Coverage is keyed per-day by attendance_records.worked_for_client_id (0030),
// set at mark time for whoever was a reliever that day — so this is day-level and
// category-history-independent. Each guard becomes one row with ONLY those days
// marked, every other day BLANK (never "X" — a reliever gap is expected).
// relieverByDay is all-true, so the OPS-Verify no-gaps rule and the strength
// totals skip them. Not gated on attendance_confirmations (no confirm loop for
// reliever marks). Guards already on the roster are excluded (excludeEmpIds) —
// their reliever-for-this-client days are folded into their roster row instead,
// so nothing is shown twice.
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

  // Any id carrying worked_for_client_id for this client was a reliever on those
  // days (day-level), whatever their category is now — EXCEPT ids already on the
  // roster, whose reliever days are folded into their roster row.
  const empIds = [...new Set(recs.map((r) => r.employee_id))].filter((id) => !exclude.has(id));
  if (empIds.length === 0) return [];
  const { data: emps } = await supabase
    .from("employees")
    .select("id, full_name, guard_code, display_number, employee_code")
    .in("id", empIds);
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
      relieverByDay.push(!!sym); // labelled on the days they actually covered
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
