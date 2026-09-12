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

type PendingRow = { employee_id: string; attendance_date: string; status: string; worked_shift?: string | null };

/**
 * Clear whatever on those days would contradict the rows about to be written.
 *
 * For each (employee, date) in the batch:
 *   - writing a LEAVE  → remove every existing row for that day. A leave admits
 *     no company, including another leave: a second leave is the same day
 *     described twice, not a second fact about it.
 *   - writing a SINGLE worked shift (present/absent/…, not a double duty) →
 *     remove the leave rows AND any `present` left on a DIFFERENT shift. That
 *     stray present is what a SHIFT CHANGE leaves behind: the old shift keeps
 *     its present, the roster now reads the new shift, and marking the new one
 *     makes two same-day presents — which migration 0395 refuses (a two-shift
 *     day must be a double duty, both rows `double_duty`). A single worked mark
 *     means "this is the one shift worked that day", so the stale one goes.
 *   - writing a DOUBLE DUTY → remove only the leave rows. The two `double_duty`
 *     rows are written on purpose and must survive untouched; deleting one leg
 *     would strand the other (0395 refuses a lone double_duty), so a genuine
 *     double duty is never touched here.
 *
 * Only `present` is cleared from the other shift — `double_duty` is left alone
 * (see above) and `absent`/`relief_cover` do not count toward the double-duty
 * rule, so they raise no conflict.
 *
 * Throws on failure. A silent failure here would leave the contradiction in
 * place and let the upsert be refused by the trigger with a message about a
 * state the operator has just tried to clear.
 */
export async function clearConflictingDayRows(rows: PendingRow[]): Promise<void> {
  // Per (employee, date): does the batch write a leave, which worked shifts does
  // it write, and is it a double duty? A day is one or the other — a batch that
  // marked both leave and work would be the very contradiction being prevented.
  type Agg = { empId: string; date: string; leave: boolean; shifts: Set<string>; double: boolean };
  const byKey = new Map<string, Agg>();
  for (const r of rows) {
    const key = `${r.employee_id}|${r.attendance_date}`;
    const a = byKey.get(key) ?? { empId: r.employee_id, date: r.attendance_date, leave: false, shifts: new Set<string>(), double: false };
    if (isLeaveStatus(r.status)) a.leave = true;
    else {
      if (r.worked_shift) a.shifts.add(r.worked_shift);
      if (r.status === "double_duty") a.double = true;
    }
    byKey.set(key, a);
  }

  for (const a of byKey.values()) {
    if (a.leave) {
      const { error } = await supabase
        .from("attendance_records")
        .delete()
        .eq("employee_id", a.empId)
        .eq("attendance_date", a.date);
      if (error) throw error;
      continue;
    }
    // Worked day: never a leave. Listing the tokens rather than negating the
    // worked ones keeps a status this file has not heard of from being deleted.
    {
      const { error } = await supabase
        .from("attendance_records")
        .delete()
        .eq("employee_id", a.empId)
        .eq("attendance_date", a.date)
        .in("status", [...LEAVE_TOKENS]);
      if (error) throw error;
    }
    // A single worked mark supersedes a stale `present` on any OTHER shift (the
    // shift-change case). Skipped for a double duty (its two legs are the point)
    // and when no shift was supplied (the caller can't say which is "other").
    if (!a.double && a.shifts.size > 0) {
      const { error } = await supabase
        .from("attendance_records")
        .delete()
        .eq("employee_id", a.empId)
        .eq("attendance_date", a.date)
        .eq("status", "present")
        .not("worked_shift", "in", `(${[...a.shifts].join(",")})`);
      if (error) throw error;
    }
  }
}
