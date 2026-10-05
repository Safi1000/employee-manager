// Attendance writes. Each function ports one web handler, named in its comment;
// the shared rules (employment window, dated shift, day conflicts) are the web's
// own code, copied into lib/web by scripts/sync-web-lib.mjs.
import type { Employee } from "../seed";
import { q, rpc, sb, todayIso, uid } from "./core";
import { clearConflictingDayRows } from "../../lib/web/attendanceDay";
import { attendanceWindowError, buildClientCoverage, effectiveWindowContract, hiddenFromAttendance } from "../../lib/web/employmentWindow";
import { loadShiftResolver, type ShiftResolver } from "../../lib/web/shiftOnDate";
import {
  buildAttendanceRows, buildRelieverRows, loadConfirmationGate, loadSheetEmployees, loadSiteByGuard,
} from "../../lib/web/attendanceSheet";
import { deriveAttendanceShifts, exportAttendance, type AttendanceEmployeeRow } from "../../lib/web/excel";
import { fetchAllRows } from "../../lib/web/supabase";

/** VacancyQueue close(). */
export async function dismissVacancy(id: string) {
  await q(sb().from("vacancies").update({ status: "cancelled" } as never).eq("id", id));
}

// ---------------------------------------------------------------- per-employee calendar
export type BulkStatus = "present" | "absent" | "leave" | "double_duty";

export type CalendarContext = {
  resolveShift: ShiftResolver;
  siteShifts: string[];
  defaultShift: string;
  windowBlock: (d: string) => string | null;
  existing: Map<string, string>;
};

/** BulkMarkByEmployeeModal: the guard's dated shifts, site shifts, window and month marks. */
export async function loadCalendar(e: Employee, month: string, contracts: { raw?: any }[]): Promise<CalendarContext> {
  const r = e.raw ?? {};
  const resolveShift = await loadShiftResolver([e.id]);
  const deps = await q<any[]>(sb().from("deployments")
    .select("site_id, shift_code, start_date, end_date, contract_lines:contract_line_id(shift_code)")
    .eq("guard_id", e.id).not("site_id", "is", null).order("start_date", { ascending: false }));
  const today = todayIso();
  const active: any = deps.find((d) => !d.end_date || d.end_date >= today) ?? deps[0];
  const cl = active?.contract_lines;
  const clShift = Array.isArray(cl) ? cl[0]?.shift_code : cl?.shift_code;
  const defaultShift = (active?.shift_code ?? clShift ?? r.shift ?? "day") as string;
  let codes: string[] = [];
  if (active?.site_id) {
    const sd = await q<any[]>(sb().from("shift_definitions").select("shift_code, start_time").eq("site_id", active.site_id).order("start_time", { ascending: true }));
    codes = sd.map((x) => x.shift_code as string);
  }
  const union = codes.includes(defaultShift) ? codes : [...codes, defaultShift];

  const raws = contracts.map((k) => k.raw).filter(Boolean);
  const empContract = effectiveWindowContract(r, new Map(raws.map((c: any) => [c.id, c])), buildClientCoverage(raws));
  const windowBlock = (d: string) => (d > today ? "Future dates can't be marked." : attendanceWindowError(r, empContract, d));

  const [y, m] = month.split("-").map(Number);
  const end = `${month}-${String(new Date(y!, m!, 0).getDate()).padStart(2, "0")}`;
  const rows = await q<any[]>(sb().from("attendance_records").select("attendance_date, status").eq("employee_id", e.id).gte("attendance_date", `${month}-01`).lte("attendance_date", end));
  const existing = new Map<string, string>();
  for (const x of rows) existing.set(x.attendance_date, x.status === "rotation_leave" ? "leave" : x.status);
  return { resolveShift, siteShifts: union.length ? union : [defaultShift], defaultShift, windowBlock, existing };
}

/** secondShiftFor(): the shift BEFORE it in the daily cycle, else any other the site runs. */
function secondShiftFor(sched: string, siteShifts: string[]) {
  const CYCLE = ["day", "evening", "night"];
  const others = siteShifts.filter((c) => c !== sched);
  const i = CYCLE.indexOf(sched);
  const previous = i >= 0 ? CYCLE[(i + CYCLE.length - 1) % CYCLE.length]! : null;
  if (previous && others.includes(previous)) return previous;
  if (others.length > 0) return others[0]!;
  return previous ?? (sched === "day" ? "night" : "day");
}

type Gate = { days: string[]; overrideSet: Set<string>; overrodeCount: number; blockedCount: number; blockedReasons: string[] };

/** gateSelectedDays(): attendance_gate per day; backdated days need an override reason. */
async function gateDays(e: Employee, ctx: CalendarContext, selected: string[], overrideReason: string): Promise<Gate> {
  const days = selected.filter((d) => ctx.windowBlock(d) === null);
  const gates = await Promise.all(days.map(async (d) => {
    const data = await rpc<any>("attendance_gate", { p_guard: e.id, p_date: d });
    return { d, mode: data?.mode ?? "blocked", reason: data?.reason ?? null };
  }));
  const allowed = gates.filter((x) => x.mode === "allowed" || x.mode === "allowed_unposted").map((x) => x.d);
  const overrideDays = gates.filter((x) => x.mode === "override_required").map((x) => x.d);
  const blocked = gates.filter((x) => x.mode === "blocked");
  if (overrideDays.length > 0 && !overrideReason.trim()) {
    throw new Error(`${overrideDays.length} of ${days.length} selected day(s) are backdated beyond the limit. Enter a supervisor override reason to include them, or deselect those days.`);
  }
  const useOverride = !!overrideReason.trim();
  return {
    days: [...allowed, ...(useOverride ? overrideDays : [])], overrideSet: new Set(overrideDays), overrodeCount: useOverride ? overrideDays.length : 0,
    blockedCount: blocked.length, blockedReasons: [...new Set(blocked.map((x) => x.reason).filter(Boolean) as string[])],
  };
}

/** applyMark(): one status across the selected days. Returns the notice the web shows. */
export async function bulkMark(e: Employee, ctx: CalendarContext, selected: string[], status: BulkStatus, overrideReason: string, profile: { id: string; role: string }) {
  const gate = await gateDays(e, ctx, selected, overrideReason);
  if (gate.days.length === 0) throw new Error(gate.blockedReasons.length ? `Nothing written — ${gate.blockedReasons.join("; ")}` : "Nothing written — all selected day(s) are blocked (closed payroll period, archived, or out of employment window).");
  const isDouble = status === "double_duty";
  const nowIso = new Date().toISOString();
  const rows = gate.days.flatMap((d) => {
    const sched = ctx.resolveShift(e.id, d) ?? ctx.defaultShift;
    const shifts = isDouble ? [sched, secondShiftFor(sched, ctx.siteShifts)] : [sched];
    return shifts.map((ws) => ({
      employee_id: e.id, attendance_date: d, status, absent_reason: status === "absent" ? "awol" : null,
      scheduled_shift: sched, worked_shift: ws, entry_type: isDouble ? "double_duty" : "normal", source: "manual",
      marked_by_role: profile.role ?? "hr", marked_by_user_id: profile.id ?? null, marked_at: nowIso,
      supervisor_override: gate.overrideSet.has(d), override_reason: gate.overrideSet.has(d) ? overrideReason.trim() : null,
    }));
  });
  await clearConflictingDayRows(rows);
  await q(sb().from("attendance_records").upsert(rows as never, { onConflict: "employee_id,attendance_date,worked_shift" }));
  const label: Record<BulkStatus, string> = { present: "present", absent: "absent", leave: "leave", double_duty: "double duty" };
  return `Marked ${gate.days.length} day(s) ${label[status]}` + (gate.overrodeCount ? ` (${gate.overrodeCount} backdated via override)` : "") + (gate.blockedCount ? ` · skipped ${gate.blockedCount} blocked / out-of-window` : "") + ".";
}

/** clearMarks(): revert the selected days to unmarked. */
export async function bulkClear(e: Employee, ctx: CalendarContext, selected: string[], overrideReason: string) {
  const gate = await gateDays(e, ctx, selected, overrideReason);
  if (gate.days.length === 0) throw new Error(gate.blockedReasons.length ? `Nothing cleared — ${gate.blockedReasons.join("; ")}` : "Nothing cleared — selected day(s) are blocked (closed payroll period or out of employment window).");
  await q(sb().from("attendance_records").delete().eq("employee_id", e.id).in("attendance_date", gate.days));
  return `Cleared ${gate.days.length} day(s) — reverted to unmarked` + (gate.blockedCount ? ` · skipped ${gate.blockedCount} blocked / out-of-window` : "") + ".";
}

/**
 * AttendanceManagement markStatus() for a RELIEVER: a present reliever must name
 * the site he worked; the DB derives the client from it (0449).
 */
export async function markReliever(e: Employee, ctx: CalendarContext, date: string, status: "present" | "absent" | "leave", siteId: string | null, coveringFor: string | null) {
  if (status === "present" && !siteId) throw new Error("Pick which site this reliever worked before marking Present.");
  if (date > todayIso()) throw new Error("Future dates can't be marked.");
  const win = ctx.windowBlock(date);
  if (win) throw new Error(`${e.name}: ${win}`);
  const shift = ctx.resolveShift(e.id, date) ?? ctx.defaultShift;
  await clearConflictingDayRows([{ employee_id: e.id, attendance_date: date, status, worked_shift: shift }]);
  await q(sb().from("attendance_records").upsert({
    employee_id: e.id, attendance_date: date, status, scheduled_shift: shift, worked_shift: shift, worked_for_client_id: null,
    site_id: status === "present" ? siteId : null, covering_for_guard_id: status === "present" ? coveringFor : null,
    marked_by_user_id: await uid(), marked_at: new Date().toISOString(),
  } as never, { onConflict: "employee_id,attendance_date,worked_shift" }));
}

// ---------------------------------------------------------------- Monthly Board (AttendanceSheetModal)
export type HalfVerification = {
  hr_verified_at: string | null; hr_verified_by_name: string | null;
  ops_verified_at: string | null; ops_verified_by_name: string | null;
  finance_verified_at: string | null; finance_verified_by_name: string | null;
};

export type BoardRemark = {
  id: string; parent_id: string | null; kind: "remark" | "reply" | "returned";
  body: string; author_name: string | null; created_at: string;
};

export type MonthlyBoard = {
  rows: AttendanceEmployeeRow[]; cells: Map<string, Map<string, string>>; daysInMonth: number; monthLabel: string; shifts: string[];
  /** A pre-0493 whole-month OPS verification — counts as fully verified. */
  verifiedAt: string | null; runPhase: string | null; financeVerified: boolean;
  /** 0493: the half shown, its day-index range (0-based, inclusive) and its chain. */
  half: 1 | 2; halfFirstIdx: number; halfLastIdx: number; halfLabel: string; halfEnded: boolean;
  halfVer: HalfVerification | null;
  /** Whole-month grid: is each half HR-verified (locked)? A legacy month verification locks both. */
  lockedHalves: { 1: boolean; 2: boolean };
  /** First day index of half 2 (0-based). */
  halfCut: number;
  /** Edits refused: HR verified this half, or a legacy month verification exists. */
  locked: boolean;
  overrides: { employee_id: string; attendance_date: string; after_value: string | null; reason: string; created_at: string }[];
  monthEnded: boolean; outstanding: { empId: string; empName: string; date: string }[]; flagged: Set<string>;
};

/** Same exact-halves rule as attendance_half_of() in the database (0493). */
export function halfRange(month: string, half: 1 | 2) {
  const [y, m] = month.split("-").map(Number);
  const dim = new Date(y!, m!, 0).getDate();
  const cut = Math.floor(dim / 2);
  const first = half === 1 ? 0 : cut;
  const last = half === 1 ? cut - 1 : dim - 1;
  const mon = new Date(y!, m! - 1, 1).toLocaleDateString("en-GB", { month: "short" });
  return { first, last, label: `${first + 1}–${last + 1} ${mon}`, cut, dim };
}

export async function loadMonthlyBoard(clientId: string, siteId: string | null, month: string, half: 1 | 2 = 1): Promise<MonthlyBoard> {
  const monthStart = `${month}-01`;
  const [cy, cm] = month.split("-").map(Number);
  const monthEnd = `${month}-${String(new Date(cy!, cm!, 0).getDate()).padStart(2, "0")}`;
  const [client, contracts] = await Promise.all([
    q<any>(sb().from("clients").select("id, name, employee_id_prefix, allowed_leaves_per_month").eq("id", clientId).single()),
    q<any[]>(sb().from("contracts").select("id, allowed_leaves_per_month").eq("client_id", clientId)),
  ]);
  const prefix = client?.employee_id_prefix ?? null;
  const siteByGuard = await loadSiteByGuard(clientId);
  const employees = await loadSheetEmployees({ clientId, category: null, siteId, siteByGuard, clientPrefix: prefix });
  const confirmedOnly = await loadConfirmationGate({ clientId, category: null, startDate: monthStart, endDate: monthEnd, siteByGuard });
  const built = await buildAttendanceRows({ month, employees, contracts: contracts as any[], clients: [client] as any[], confirmedOnly });
  const relieverRows = await buildRelieverRows({ month, clientId, clientPrefix: prefix, excludeEmpIds: employees.map((e) => e.id) });
  relieverRows.forEach((r, i) => (r.serial = built.rows.length + i + 1));
  const rows = [...built.rows, ...relieverRows];

  const [ver, ovs, ph, hv] = await Promise.all([
    sb().from("attendance_month_verifications").select("verified_at").eq("period_month", monthStart).eq("client_id", clientId).maybeSingle(),
    sb().from("attendance_overrides").select("employee_id, attendance_date, reason, after_value, created_at").gte("attendance_date", monthStart).lte("attendance_date", `${month}-31`).eq("client_id", clientId).order("created_at", { ascending: false }),
    sb().from("payroll_run_phases").select("phase, finance_verified_at").eq("period_month", monthStart).eq("client_id", clientId).maybeSingle(),
    sb().from("attendance_half_verifications")
      .select("half, hr_verified_at, hr_verified_by_name, ops_verified_at, ops_verified_by_name, finance_verified_at, finance_verified_by_name")
      .eq("period_month", monthStart).eq("client_id", clientId),
  ]);
  const hr = halfRange(month, half);
  const halfRows = ((hv.data ?? []) as (HalfVerification & { half: number })[]);
  const legacyLocked = !!(ver.data as any)?.verified_at;
  const halfLast = new Date(cy!, cm! - 1, hr.last + 1);
  const overrides = ((ovs.data ?? []) as any[]);
  const overridden = new Set(overrides.map((o) => `${o.employee_id}|${o.attendance_date}`));
  const lastDay = new Date(cy!, cm!, 0); const now = new Date();
  lastDay.setHours(0, 0, 0, 0); now.setHours(0, 0, 0, 0); halfLast.setHours(0, 0, 0, 0);

  // Unmarked AND not overridden = flagged (whole month, for the grid); outstanding
  // = flagged within the half being verified. Reliever rows/days never block.
  const flagged = new Set<string>();
  const outstanding: MonthlyBoard["outstanding"] = [];
  for (const row of rows) {
    if (!row.empId || row.isReliever) continue;
    for (let i = 0; i < built.daysInMonth; i += 1) {
      if (row.relieverByDay?.[i]) continue;
      if ((row.statusByDay[i] ?? "") !== "") continue;
      const date = `${month}-${String(i + 1).padStart(2, "0")}`;
      if (overridden.has(`${row.empId}|${date}`)) continue;
      flagged.add(`${row.empId}|${i}`);
      // Only the half being verified blocks HR Verify.
      if (i >= hr.first && i <= hr.last) outstanding.push({ empId: row.empId, empName: row.name, date });
    }
  }
  return {
    rows, cells: built.cellsByEmp, daysInMonth: built.daysInMonth, monthLabel: built.monthLabel, shifts: deriveAttendanceShifts(rows),
    verifiedAt: (ver.data as any)?.verified_at ?? null, runPhase: (ph.data as any)?.phase ?? null, financeVerified: !!(ph.data as any)?.finance_verified_at,
    half, halfFirstIdx: hr.first, halfLastIdx: hr.last, halfLabel: hr.label, halfEnded: halfLast < now,
    halfVer: halfRows.find((r) => r.half === half) ?? null,
    lockedHalves: {
      1: legacyLocked || !!halfRows.find((r) => r.half === 1)?.hr_verified_at,
      2: legacyLocked || !!halfRows.find((r) => r.half === 2)?.hr_verified_at,
    },
    halfCut: hr.cut,
    locked: legacyLocked || !!halfRows.find((r) => r.half === half)?.hr_verified_at,
    overrides, monthEnded: lastDay < now, outstanding, flagged,
  };
}

export type HalfAction =
  | "hr_verify" | "ops_verify" | "finance_verify"
  | "undo_hr" | "undo_ops" | "undo_finance"
  | "return_to_hr" | "return_to_ops";

/**
 * One step of the HR -> Ops -> Finance chain on a half-month board (0493). The
 * database checks the stage key, the order, the half having ended and payroll
 * still being in Draft, and stamps who did it.
 */
export async function halfAction(clientId: string, month: string, board: MonthlyBoard, action: HalfAction, note?: string) {
  if (action === "hr_verify") {
    if (!board.halfEnded) throw new Error(`This half (${board.halfLabel}) hasn't ended yet. It can be verified from the day after.`);
    if (board.outstanding.length > 0) {
      const preview = board.outstanding.slice(0, 6).map((o) => `${o.empName} (${o.date})`).join(", ");
      throw new Error(`${board.outstanding.length} unconfirmed day(s) in this half: ${preview}${board.outstanding.length > 6 ? "…" : ""}. Confirm or override them first.`);
    }
  }
  if ((action === "return_to_hr" || action === "return_to_ops") && !note?.trim()) throw new Error("Say why it is being sent back.");
  await q(sb().rpc("attendance_half_action", {
    p_client_id: clientId, p_category: null, p_period_month: `${month}-01`, p_half: board.half, p_action: action, p_note: note?.trim() || null,
  } as never));
}

export async function loadBoardRemarks(clientId: string, month: string, half: 1 | 2): Promise<BoardRemark[]> {
  return q<BoardRemark[]>(sb().from("attendance_board_remarks")
    .select("id, parent_id, kind, body, author_name, created_at")
    .eq("client_id", clientId).eq("period_month", `${month}-01`).eq("half", half)
    .order("created_at", { ascending: true }));
}

/** A remark on the board, or a reply to one. The author is stamped by the database. */
export async function postBoardRemark(clientId: string, month: string, half: 1 | 2, body: string, parentId: string | null) {
  if (!body.trim()) throw new Error("Write something first.");
  await q(sb().rpc("attendance_board_remark", {
    p_client_id: clientId, p_category: null, p_period_month: `${month}-01`, p_half: half, p_body: body.trim(), p_parent_id: parentId,
  } as never));
}

const LETTER: Record<string, string> = { present: "P", absent: "A", leave: "L" };

/** OverrideModal save(): sanctioned clear, the mark, then the permanent audit row. */
export async function overrideCell(args: {
  clientId: string; empId: string; date: string; shift: string; current: string; status: "present" | "absent" | "leave";
  presentOnly: boolean; reason: string; locked: boolean; profile: { id: string; role: string };
}) {
  if (args.locked) throw new Error("This half is verified and locked. Ops must send it back to HR before it can be changed.");
  if (!args.reason.trim()) throw new Error("A reason is required to override.");
  const reason = args.reason.trim();
  await rpc("clear_attendance_conflicts", { p_employee: args.empId, p_date: args.date, p_leave_only: args.presentOnly ? true : args.status !== "leave", p_reason: reason });
  const base = {
    employee_id: args.empId, attendance_date: args.date, source: "manual", marked_by_role: args.profile.role ?? "hr",
    marked_by_user_id: args.profile.id, marked_at: new Date().toISOString(), supervisor_override: true, override_reason: reason,
  };
  if (args.presentOnly) {
    // A second shift makes the day a double duty: both rows in ONE upsert (0395 is deferred to commit).
    const existing = await q<any[]>(sb().from("attendance_records").select("worked_shift").eq("employee_id", args.empId).eq("attendance_date", args.date).in("status", ["present", "double_duty"]));
    const shiftSet = new Set<string>([args.shift, ...existing.map((x) => String(x.worked_shift))]);
    const rows = [...shiftSet].map((sh) => ({ ...base, status: "double_duty", absent_reason: null, scheduled_shift: sh, worked_shift: sh, entry_type: "double_duty" }));
    await q(sb().from("attendance_records").upsert(rows as never, { onConflict: "employee_id,attendance_date,worked_shift" }));
  } else {
    await q(sb().from("attendance_records").upsert({
      ...base, status: args.status, absent_reason: args.status === "absent" ? "awol" : null, scheduled_shift: args.shift, worked_shift: args.shift, entry_type: "normal",
    } as never, { onConflict: "employee_id,attendance_date,worked_shift" }));
  }
  await q(sb().from("attendance_overrides").insert({
    client_id: args.clientId, category: null, employee_id: args.empId, attendance_date: args.date, reason,
    before_value: args.current === "" ? "unmarked" : args.current, after_value: args.presentOnly ? "DD" : LETTER[args.status], created_by: args.profile.id,
  } as never));
}

/** clearDay() / clearMonth(): server-side, audited, stops at the OPS-verified lock. */
export async function clearAttendanceDay(empId: string, date: string, reason: string, locked: boolean) {
  if (locked) throw new Error("This half is verified and locked. Ops must send it back to HR before it can be changed.");
  if (!reason.trim()) throw new Error("A reason is required to clear this day.");
  await rpc("clear_attendance_day", { p_employee: empId, p_date: date, p_reason: reason.trim() });
}
export async function clearAttendanceMonth(empId: string, month: string, reason: string, locked: boolean) {
  if (locked) throw new Error("This half is verified and locked. Ops must send it back to HR before it can be changed.");
  if (!reason.trim()) throw new Error("A reason is required to clear the month.");
  await rpc("clear_attendance_month", { p_employee: empId, p_month: month, p_reason: reason.trim() });
}

/** download(): the web's own Excel writer, same rows. */
export function downloadMonthlyBoard(board: MonthlyBoard, label: string) {
  return exportAttendance({ monthLabel: board.monthLabel, daysInMonth: board.daysInMonth, clientLabel: label, rows: board.rows, fileName: `Attendance ${label} ${board.monthLabel}.xlsx` });
}

// ---------------------------------------------------------------- the daily board (AttendanceBoard load())

export type BoardGuard = { guard_id: string; full_name: string; code: string; client_id: string; scheduled_shift: string; raw: any };
export type BoardRow = {
  key: string; site_id: string; group_key: string; site_name: string; client_id: string; client_name: string; client_prefix: string | null;
  shift_code: string; contracted: number; roster: BoardGuard[]; marks: Map<string, { status: string; absent_reason: string | null }>;
  confirmation: { supervisor_name: string; confirmed_at: string } | null; branch_id: string | null;
};

/**
 * The client-shift rows of the Attendance board ON `date`: the dated posting in
 * force that day (latest segment wins), separated guards dropped from their
 * cutoff, contracted strength from contract lines (else the contract's per-shift
 * headcount), and an empty row for every contracted shift nobody is posted to.
 * Relievers and office-staff groups are not client-shift rows and are not built here.
 */
export async function loadDayBoard(date: string): Promise<BoardRow[]> {
  const s = sb();
  const [deps, cls, siteRows, confs, att, cliRows, cons] = await Promise.all([
    fetchAllRows<any>(() => s.from("deployments")
      .select("id, guard_id, site_id, client_id, contract_line_id, shift_code, start_date, end_date, employees:guard_id(full_name, guard_code, display_number, employee_code, shift, category, join_date, last_working_day, termination_date, exit_date, lifecycle_state), sites:site_id(name), clients:client_id(name, employee_id_prefix, branch_id), contract_lines:contract_line_id(shift_code)")
      .lte("start_date", date).or(`end_date.is.null,end_date.gte.${date}`).order("id") as any),
    fetchAllRows<any>(() => s.from("contract_lines").select("site_id, shift_code, billed_qty").not("site_id", "is", null).order("id") as any),
    fetchAllRows<any>(() => s.from("sites").select("id, client_id, name").order("id") as any),
    fetchAllRows<any>(() => s.from("attendance_confirmations").select("group_key, shift_code, supervisor_name, confirmed_at").eq("attendance_date", date).order("id") as any),
    fetchAllRows<any>(() => s.from("attendance_records").select("employee_id, status, absent_reason, worked_shift, scheduled_shift").eq("attendance_date", date).order("id") as any),
    fetchAllRows<any>(() => s.from("clients").select("id, name, employee_id_prefix, branch_id").order("id") as any),
    fetchAllRows<any>(() => s.from("contracts").select("client_id, contract_type, status, day_guards, night_guards, evening_guards, start_date, end_date, is_infinite")
      .eq("status", "active").eq("contract_type", "guard_deployment").lte("start_date", date).or(`is_infinite.eq.true,end_date.is.null,end_date.gte.${date}`).order("client_id") as any),
  ]);

  const contracted = new Map<string, number>();
  for (const l of cls) { const k = `${l.site_id}|${l.shift_code ?? "day"}`; contracted.set(k, (contracted.get(k) ?? 0) + (l.billed_qty ?? 0)); }
  const shiftStrength = new Map<string, Map<string, number>>();
  for (const k of cons) {
    if (k.start_date && k.start_date > date) continue;
    if (!k.is_infinite && k.end_date && k.end_date < date) continue;
    const per = shiftStrength.get(k.client_id) ?? new Map<string, number>();
    for (const [sh, n] of [["day", k.day_guards], ["night", k.night_guards], ["evening", k.evening_guards]] as const) {
      const v = Number(n) || 0;
      if (v > 0) per.set(sh, (per.get(sh) ?? 0) + v);
    }
    if (per.size > 0) shiftStrength.set(k.client_id, per);
  }
  const confMap = new Map<string, { supervisor_name: string; confirmed_at: string }>();
  for (const c of confs) confMap.set(`${c.group_key}|${c.shift_code}`, { supervisor_name: c.supervisor_name, confirmed_at: c.confirmed_at });
  const markByGuard = new Map<string, { status: string; absent_reason: string | null }>();
  for (const a of att) {
    const ws = a.worked_shift ?? a.scheduled_shift ?? "day";
    markByGuard.set(`${a.employee_id}|${ws}`, { status: a.status === "rotation_leave" ? "leave" : a.status, absent_reason: a.absent_reason ?? null });
  }

  const best = new Map<string, any>();
  for (const d of deps) {
    const prev = best.get(d.guard_id);
    if (!prev) { best.set(d.guard_id, d); continue; }
    const better = d.start_date !== prev.start_date ? d.start_date > prev.start_date
      : (d.end_date === null) !== (prev.end_date === null) ? d.end_date === null : String(d.id ?? "") > String(prev.id ?? "");
    if (better) best.set(d.guard_id, d);
  }

  const byKey = new Map<string, BoardRow>();
  const seen = new Set<string>();
  for (const d of best.values()) {
    const e = d.employees;
    if (!e || e.category === "reliever") continue;
    if (e.join_date && e.join_date > date) continue;
    if (hiddenFromAttendance(e, date) || e.lifecycle_state === "archived" || d.start_date > date) continue;
    const sched = (d.shift_code ?? d.contract_lines?.shift_code ?? e.shift ?? "day") as string;
    const groupKey = (d.site_id ?? d.client_id) as string;
    const key = `${groupKey}|${sched}`;
    if (seen.has(`${key}|${d.guard_id}`)) continue;
    seen.add(`${key}|${d.guard_id}`);
    let row = byKey.get(key);
    if (!row) {
      row = {
        key, site_id: d.site_id ?? "", group_key: groupKey, site_name: d.sites?.name ?? "—", client_id: d.client_id, client_name: d.clients?.name ?? "—",
        client_prefix: d.clients?.employee_id_prefix ?? null, shift_code: sched,
        contracted: contracted.get(`${d.site_id}|${sched}`) ?? shiftStrength.get(d.client_id)?.get(sched) ?? 0,
        roster: [], marks: new Map(), confirmation: confMap.get(key) ?? null, branch_id: d.clients?.branch_id ?? null,
      };
      byKey.set(key, row);
    }
    const prefix = d.clients?.employee_id_prefix ?? null;
    const code = e.display_number != null && prefix ? `${prefix}-${String(e.display_number).padStart(3, "0")}` : e.guard_code ?? e.employee_code ?? "";
    row.roster.push({ guard_id: d.guard_id, full_name: e.full_name, code, client_id: d.client_id, scheduled_shift: sched, raw: e });
    const mk = markByGuard.get(`${d.guard_id}|${sched}`);
    if (mk && mk.status !== "present") row.marks.set(d.guard_id, mk);
  }

  // Gap rows: a contracted shift with nobody posted still appears (empty = unstaffed).
  const clientById = new Map(cliRows.map((c) => [c.id, c]));
  const sitesByClient = new Map<string, { id: string; name: string }[]>();
  for (const x of siteRows) sitesByClient.set(x.client_id, [...(sitesByClient.get(x.client_id) ?? []), { id: x.id, name: x.name }]);
  const siteShiftSet = new Map<string, Set<string>>();
  for (const l of cls) { if (!l.shift_code) continue; siteShiftSet.set(l.site_id, (siteShiftSet.get(l.site_id) ?? new Set<string>()).add(l.shift_code)); }
  for (const [clientId, perShift] of shiftStrength) {
    const clientSites = sitesByClient.get(clientId) ?? [];
    for (const [shift, committed] of perShift) {
      const c = clientById.get(clientId);
      const named = clientSites.filter((x) => siteShiftSet.get(x.id)?.has(shift));
      const targets: ({ id: string; name: string } | null)[] = clientSites.length === 0 ? [null] : named.length > 0 ? named : clientSites;
      for (const site of targets) {
        const groupKey = site ? site.id : clientId;
        if ([...byKey.values()].some((r) => r.group_key === groupKey && r.shift_code === shift)) continue;
        const key = `${groupKey}|${shift}`;
        byKey.set(key, {
          key, site_id: site ? site.id : "", group_key: groupKey, site_name: site ? site.name : "—", client_id: clientId, client_name: c?.name ?? "—",
          client_prefix: c?.employee_id_prefix ?? null, shift_code: shift, contracted: site ? contracted.get(`${site.id}|${shift}`) ?? committed : committed,
          roster: [], marks: new Map(), confirmation: confMap.get(`${groupKey}|${shift}`) ?? null, branch_id: c?.branch_id ?? null,
        });
      }
    }
  }
  const order = ["day", "evening", "night"];
  return [...byKey.values()].sort((a, b) => a.client_name.localeCompare(b.client_name) || a.site_name.localeCompare(b.site_name) || order.indexOf(a.shift_code) - order.indexOf(b.shift_code));
}
