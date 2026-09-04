// A leave occupies the whole day (migration 0393).
//
// attendance_records is unique on (employee_id, attendance_date, worked_shift),
// which is right for double duty — genuinely two shifts in one day — and wrong
// for leave, which has no shift at all. Every marking screen upserts on that
// key, so marking a day Leave with the shift picker on `day` and then again on
// `evening` never collides: it ADDS a second row. The Monthly Board then shows L
// twice, or L beside a P, and nothing raised on the way in.
//
// The database now refuses that (trg_leave_is_the_whole_day). It REFUSES rather
// than tidying up around the write, because a trigger that deleted the sibling
// rows itself would make a mistaken mark look like a correct one and take the
// evidence with it. So the caller does the clearing, deliberately and in one
// place — here — and the trigger is what catches the caller who forgot.

import { supabase } from "./supabase";

// The three tokens the board renders as L. Mirrors
// public.attendance_status_is_leave() — change one, change both.
const LEAVE_TOKENS = new Set(["leave", "rotation_leave", "rest_day"]);
export const isLeaveStatus = (raw: unknown): boolean =>
  LEAVE_TOKENS.has(String(raw ?? "").toLowerCase());

type PendingRow = { employee_id: string; attendance_date: string; status: string };

/**
 * Clear whatever on those days would contradict the rows about to be written.
 *
 * For each (employee, date) in the batch:
 *   - writing a LEAVE  → remove every existing row for that day. A leave admits
 *     no company, including another leave: a second leave is the same day
 *     described twice, not a second fact about it.
 *   - writing anything WORKED → remove only the leave rows. Double duty writes
 *     two worked rows on purpose and must survive untouched.
 *
 * Throws on failure. A silent failure here would leave the contradiction in
 * place and let the upsert be refused by the trigger with a message about a
 * state the operator has just tried to clear.
 */
export async function clearConflictingDayRows(rows: PendingRow[]): Promise<void> {
  // Days where the batch writes a leave, and days where it writes work. A day
  // can appear in only one: a batch that marked both would be the very
  // contradiction being prevented, and the trigger refuses it.
  const leaveDays = new Map<string, Set<string>>();
  const workedDays = new Map<string, Set<string>>();
  for (const r of rows) {
    const target = isLeaveStatus(r.status) ? leaveDays : workedDays;
    const dates = target.get(r.employee_id) ?? new Set<string>();
    dates.add(r.attendance_date);
    target.set(r.employee_id, dates);
  }

  for (const [empId, dates] of leaveDays) {
    const { error } = await supabase
      .from("attendance_records")
      .delete()
      .eq("employee_id", empId)
      .in("attendance_date", [...dates]);
    if (error) throw error;
  }

  for (const [empId, dates] of workedDays) {
    // Only the leave rows. Listing the tokens rather than negating the worked
    // ones keeps a status this file has not heard of from being deleted.
    const { error } = await supabase
      .from("attendance_records")
      .delete()
      .eq("employee_id", empId)
      .in("attendance_date", [...dates])
      .in("status", [...LEAVE_TOKENS]);
    if (error) throw error;
  }
}
