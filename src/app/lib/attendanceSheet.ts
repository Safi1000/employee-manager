// Builds the monthly attendance-sheet rows (the AttendanceEmployeeRow[] the Excel
// exporter and the on-screen viewer both consume) from attendance_records. Pulled
// out of AttendanceManagement so the timesheet export and the per-client/site
// "View attendance" modal share ONE source of truth for what a month looks like.

import { supabase, fetchAllRows, resolveAllowedLeaves, type Contract, type Client } from "./supabase";
import { loadShiftResolver } from "./shiftOnDate";
import { attendanceWindowError, isSeparatedState, SEPARATION_MARK } from "./employmentWindow";
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

// P/A/L symbol from either vocabulary (legacy Present/Absent/Leave or the spec's
// present/absent/rotation_leave/…). Worked statuses count as present.
const symbolOf = (raw: unknown): "P" | "A" | "L" | "" => {
  const s = String(raw ?? "").toLowerCase();
  if (s === "present" || s === "double_duty" || s === "relief_cover") return "P";
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
}): Promise<{ rows: AttendanceEmployeeRow[]; daysInMonth: number; monthLabel: string }> {
  const { month, employees, contracts, clients } = opts;
  const [yStr, mStr] = month.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const dim = new Date(y, m, 0).getDate();
  const monthStart = `${yStr}-${mStr}-01`;
  const monthEnd = `${yStr}-${mStr}-${String(dim).padStart(2, "0")}`;
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const empIds = employees.map((e) => e.id);
  if (empIds.length === 0) return { rows: [], daysInMonth: dim, monthLabel };

  const records = await fetchAllRows<any>(() =>
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

  const byEmp = new Map<string, Map<number, { sym: string; ws: string }>>();
  for (const r of records ?? []) {
    const day = Number(String(r.attendance_date).slice(8, 10));
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, new Map());
    byEmp.get(r.employee_id)!.set(day, { sym: symbolOf(r.status), ws: (r.worked_shift as string) ?? "day" });
  }

  const resolveShift = await loadShiftResolver(empIds);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const contractById = new Map(contracts.map((c) => [c.id, c]));

  const rows: AttendanceEmployeeRow[] = employees.map((emp, idx) => {
    const dayMap = byEmp.get(emp.id) ?? new Map<number, { sym: string; ws: string }>();
    const contract = emp.contract_id ? contractById.get(emp.contract_id) ?? null : null;
    const statusByDay: string[] = [];
    const shiftByDay: string[] = [];
    let p = 0, a = 0, l = 0;
    for (let d = 1; d <= dim; d += 1) {
      const cell = dayMap.get(d);
      const iso = `${yStr}-${mStr}-${String(d).padStart(2, "0")}`;
      // No record AND not employed that day → "X" (separated / pre-join / off-contract),
      // otherwise blank. A real record always wins — history is reported as-is.
      const sym = cell?.sym ?? (attendanceWindowError(emp, contract, iso) ? SEPARATION_MARK : "");
      statusByDay.push(sym);
      if (sym === "P") p += 1;
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
      name: emp.full_name,
      designation: "",
      empCode: emp.display_code,
      shift: resolveShift(emp.id, monthStart) || "day",
      shiftByDay,
      statusByDay,
      presents: p,
      absents: a,
      leaves: l,
      payDays,
      separationNote: separationNote(emp),
    };
  });

  return { rows, daysInMonth: dim, monthLabel };
}
