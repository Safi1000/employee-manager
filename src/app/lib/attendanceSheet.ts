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

/** Every ISO date from start..end inclusive. The sheet's columns, in order. */
export function enumerateDates(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const last = new Date(ey, em - 1, ed);
  while (cur <= last) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** The window a caller asked for, as dates + a label, from EITHER a month or an
 *  explicit range. One place decides what "the sheet's columns" means. */
function windowOf(opts: { month?: string; startDate?: string; endDate?: string }) {
  if (opts.month) {
    const [yStr, mStr] = opts.month.split("-");
    const y = Number(yStr), m = Number(mStr);
    const dim = new Date(y, m, 0).getDate();
    return {
      dates: enumerateDates(`${opts.month}-01`, `${opts.month}-${String(dim).padStart(2, "0")}`),
      label: new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    };
  }
  const start = opts.startDate!, end = opts.endDate!;
  const fmtLong = (iso: string) => {
    const [yy, mm, dd] = iso.split("-").map(Number);
    return new Date(yy, mm - 1, dd).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  return {
    dates: enumerateDates(start, end),
    label: start.slice(0, 7) === end.slice(0, 7)
      ? new Date(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })
      : `${fmtLong(start)} – ${fmtLong(end)}`,
  };
}

/** Guard → the site they are posted to for this client. Open posting (end_date
 *  null) wins; otherwise the most recent closed one, so a separated guard's
 *  confirmed attendance still matches the site it was confirmed under instead
 *  of silently failing the site test and rendering blank. */
export async function loadSiteByGuard(clientId: string | null): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!clientId) return out;
  const { data } = await supabase
    .from("deployments").select("guard_id, site_id, end_date").eq("client_id", clientId)
    .order("end_date", { ascending: false, nullsFirst: true });
  for (const d of (data ?? []) as any[]) if (!out.has(d.guard_id)) out.set(d.guard_id, d.site_id ?? null);
  return out;
}

/**
 * THE CONFIRMATION GATE — the single definition of "this mark is real".
 *
 * A mark counts only where the supervisor confirmed that (site, shift, date).
 * A confirmation carrying site_id null is client-wide (or a category group) and
 * matches any of the client's sites.
 *
 * This used to live inline in AttendanceSheetModal while the Daily Board's
 * exporter applied NO gate at all, so the same client and month produced two
 * different sheets — 305 marks against 251 on Dolmen City for August 2026. It
 * is a function here so there is one answer rather than one per caller.
 */
export async function loadConfirmationGate(opts: {
  clientId?: string | null;
  category?: string | null;
  startDate: string;
  endDate: string;
  siteByGuard: Map<string, string | null>;
}): Promise<(empId: string, iso: string, workedShift: string) => boolean> {
  const q = supabase
    .from("attendance_confirmations")
    .select("site_id, shift_code, attendance_date")
    .gte("attendance_date", opts.startDate)
    .lte("attendance_date", opts.endDate);
  const { data } = await (opts.category ? q.eq("category", opts.category) : q.eq("client_id", opts.clientId as string));

  const anySite = new Set<string>(); // `${shift}|${date}`
  const bySite = new Set<string>();  // `${site}|${shift}|${date}`
  for (const c of (data ?? []) as any[]) {
    if (c.site_id) bySite.add(`${c.site_id}|${c.shift_code}|${c.attendance_date}`);
    else anySite.add(`${c.shift_code}|${c.attendance_date}`);
  }
  return (empId, iso, ws) => {
    if (anySite.has(`${ws}|${iso}`)) return true;
    const site = opts.siteByGuard.get(empId) ?? null;
    return site ? bySite.has(`${site}|${ws}|${iso}`) : false;
  };
}

/** The roster a sheet is built from: one client's guards, or a synthetic
 *  category group. Relievers and archived rows are excluded — a reliever is
 *  never on a roster and is surfaced by buildRelieverRows instead. */
export async function loadSheetEmployees(opts: {
  clientId?: string | null;
  category?: string | null;
  siteId?: string | null;
  siteByGuard?: Map<string, string | null>;
  clientPrefix?: string | null;
}): Promise<SheetEmployee[]> {
  const q = supabase
    .from("employees")
    .select("id, full_name, display_number, guard_code, employee_code, contract_id, client_id, join_date, last_working_day, termination_date, lifecycle_state, shift")
    .neq("lifecycle_state", "archived")
    .neq("category", "reliever");
  const { data } = await (opts.category ? q.eq("category", opts.category) : q.eq("client_id", opts.clientId as string));

  let list = (data ?? []) as any[];
  if (opts.siteId && opts.siteByGuard) list = list.filter((e) => opts.siteByGuard!.get(e.id) === opts.siteId);

  return list
    .map((e) => ({
      id: e.id,
      full_name: e.full_name,
      display_code: guardDisplayCode(e, opts.clientPrefix ?? null),
      contract_id: e.contract_id ?? null,
      client_id: e.client_id ?? null,
      join_date: e.join_date ?? null,
      last_working_day: e.last_working_day ?? null,
      termination_date: e.termination_date ?? null,
      lifecycle_state: e.lifecycle_state ?? null,
      shift: e.shift ?? null,
    }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export async function buildAttendanceRows(opts: {
  // The window, given as EITHER a month or an explicit inclusive range. The
  // Monthly Board passes a month; the Attendance board's client-range export
  // passes two dates and may span a month boundary (20 Jul → 10 Aug). Columns
  // are indexed positionally, so both work through the same code.
  month?: string; // "YYYY-MM"
  startDate?: string; // "YYYY-MM-DD", with endDate, when month is not given
  endDate?: string;
  employees: SheetEmployee[];
  contracts: Contract[];
  clients: Client[];
  // When supplied, a day's mark is shown ONLY if this returns true for it. The
  // Monthly Board uses this to display exclusively supervisor-confirmed
  // attendance — an unconfirmed mark (bulk-marked, reported, awaiting) renders
  // as blank, exactly as if it were never entered.
  confirmedOnly?: (empId: string, iso: string, workedShift: string) => boolean;
}): Promise<{ rows: AttendanceEmployeeRow[]; daysInMonth: number; monthLabel: string; cellsByEmp: Map<string, Map<string, string>> }> {
  const { employees, contracts, clients, confirmedOnly } = opts;
  const { dates, label: monthLabel } = windowOf(opts);
  const dim = dates.length;
  const monthStart = dates[0];
  const monthEnd = dates[dim - 1];
  // Column index (0-based) for a date. For a whole month this is day-of-month
  // minus one, which is why nothing downstream had to change; for a range that
  // crosses a month boundary it is the only key that does not collide.
  const dateIndex = new Map(dates.map((d, i) => [d, i]));

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

  type Mark = { sym: string; ws: string; ovr: boolean };
  // Every visible mark a guard has, grouped by day — a day legitimately holds
  // several, because a double duty is two (or three) shifts and writes a row per
  // shift. Keyed `${day}|${shift}` in cellsByEmp for the grid's per-shift cells;
  // gathered per day in marksByDay so the day's SINGLE symbol can be derived
  // from all of them below. A mark is visible if the supervisor confirmed it OR
  // it was set by an override (the one edit allowed once locked).
  const marksByDay = new Map<string, Map<number, Mark[]>>();
  const cellsByEmp = new Map<string, Map<string, string>>();
  for (const r of records ?? []) {
    // 1-based column index. Identical to day-of-month for a whole-month sheet,
    // which is the key AttendanceSheetModal's grid already reads
    // (`${i + 1}|${shift}`), so the viewer is untouched.
    const idx0 = dateIndex.get(String(r.attendance_date).slice(0, 10));
    if (idx0 === undefined) continue;
    const day = idx0 + 1;
    const ws = (r.worked_shift as string) ?? "day";
    const ovr = !!r.supervisor_override;
    const visible = !confirmedOnly || confirmedOnly(r.employee_id, String(r.attendance_date), ws) || ovr;
    if (!visible) continue;
    const perDay = marksByDay.get(r.employee_id) ?? new Map<number, Mark[]>();
    perDay.set(day, [...(perDay.get(day) ?? []), { sym: symbolOf(r.status), ws, ovr }]);
    marksByDay.set(r.employee_id, perDay);
    const m = cellsByEmp.get(r.employee_id) ?? new Map<string, string>();
    m.set(`${day}|${ws}`, symbolOf(r.status));
    cellsByEmp.set(r.employee_id, m);
  }

  // ── The day's one symbol, DERIVED ──────────────────────────────────────────
  //
  // This used to be "last row wins": each record overwrote the day as it was
  // read, so the surviving symbol was whichever shift sorted last — `day` before
  // `evening` before `night`, alphabetically and for no other reason.
  //
  // A double duty writes the base shift as `present` and each extra shift as
  // `double_duty`. So the day's DD survived only when the extra shift's NAME
  // sorted after the base's. A night guard covering a day shift wrote
  // day=double_duty + night=present, `night` sorted last, and the day was
  // counted a plain present. That silently lost 99 of 259 double duties on
  // production — 38% — which is the discrepancy between this board and the daily
  // one. The daily board is the source of truth: it recorded two shifts, so the
  // month must read two shifts, whatever the shifts are called.
  //
  // Precedence, highest first:
  //   L   a leave is the whole day and cannot be worked (0393)
  //   DD  a double duty, but ONLY if it really spans two or more shifts
  //   P   worked
  //   A   did not turn up
  const symbolForDay = (marks: Mark[]): string => {
    if (marks.some((m) => m.sym === "L")) return "L";
    // "At least 2 shifts" is the whole point of the mark: one DD row on its own
    // is half a record — the extra duty without the shift it was extra TO — and
    // counting it as a double duty would credit a second shift nobody logged.
    // It still counts as the one shift that was worked.
    if (marks.some((m) => m.sym === "DD")) return marks.length >= 2 ? "DD" : "P";
    if (marks.some((m) => m.sym === "P")) return "P";
    if (marks.some((m) => m.sym === "A")) return "A";
    return marks[0]?.sym ?? "";
  };

  const byEmp = new Map<string, Map<number, Mark>>();
  for (const [empId, perDay] of marksByDay) {
    const dayMap = new Map<number, Mark>();
    for (const [day, marks] of perDay) {
      // The primary column follows the BASE shift — the one that is not an extra
      // duty — so the grid puts the day's symbol on the shift the guard was
      // rostered to and leaves the cover shifts to cellsByEmp.
      const base = marks.find((m) => m.sym !== "DD") ?? marks[0];
      dayMap.set(day, {
        sym: symbolForDay(marks),
        ws: base.ws,
        ovr: marks.some((m) => m.ovr),
      });
    }
    byEmp.set(empId, dayMap);
  }

  // A leave is the WHOLE day, so it cannot share the day with a P/A/DD in
  // another shift column, and it cannot appear twice (migration 0393). The
  // database now refuses to record that and 0393 repaired every past case, but
  // this code may be pointed at a database that predates the trigger. So the
  // grid folds a leave day down to one L here too: given a choice between
  // showing a contradiction and showing the leave, show the leave. Displaying
  // both is how nobody noticed for seventeen days' worth.
  for (const [empId, cells] of cellsByEmp) {
    const leaveDays = new Set<string>();
    for (const [key, sym] of cells) if (sym === "L") leaveDays.add(key.split("|")[0]);
    if (leaveDays.size === 0) continue;
    let kept = cells;
    for (const [key, sym] of cells) {
      const day = key.split("|")[0];
      if (!leaveDays.has(day)) continue;
      // Everything on a leave day goes except ONE L — the first in shift order,
      // which is the order the records were fetched in and so is stable.
      if (sym !== "L" || [...kept.keys()].some((k) => k.startsWith(`${day}|`) && kept.get(k) === "L" && k < key)) {
        kept = new Map(kept);
        kept.delete(key);
      }
    }
    cellsByEmp.set(empId, kept);
  }
  // (The single-column view needs no equivalent fold: symbolForDay already gives
  // a leave precedence over everything else on the day.)

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
      const iso = dates[d - 1];
      // Unconfirmed marks were already dropped when the day was gathered, so a
      // cell here is a visible one. Re-testing confirmation on cell.ws would now
      // be wrong: ws is the BASE shift, and a double duty whose base shift is
      // unconfirmed while its cover shift is would vanish entirely.
      const cell = dayMap.get(d);
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
  month?: string; // "YYYY-MM"
  startDate?: string; // or an explicit inclusive range, as buildAttendanceRows
  endDate?: string;
  clientId: string; // real client uuid (relievers never attribute to a category group)
  clientPrefix?: string | null;
  excludeEmpIds?: Iterable<string>; // roster ids already rendered as regular rows
}): Promise<AttendanceEmployeeRow[]> {
  const { clientId, clientPrefix = null } = opts;
  const exclude = new Set(opts.excludeEmpIds ?? []);
  const { dates } = windowOf(opts);
  const dim = dates.length;
  const monthStart = dates[0];
  const monthEnd = dates[dim - 1];
  const dateIndex = new Map(dates.map((d, i) => [d, i]));

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
    const idx0 = dateIndex.get(String(r.attendance_date).slice(0, 10));
    if (idx0 === undefined) continue;
    const day = idx0 + 1;
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
