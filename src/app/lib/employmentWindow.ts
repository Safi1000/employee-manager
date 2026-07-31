import { formatDate } from "./date";

// ── The one place that decides whether a date is markable for a guard ────────
// Attendance may only be marked while the guard is actually employed AND their
// contract is running. This mirrors the DB rules in migration 0152
// (attendance_gate + the enforce_attendance_window trigger) so the UI can grey
// a day out before the write is attempted; the DB remains the authority and
// rejects anything that slips past — including bulk paths.
//
// Separation semantics: `last_working_day` is the final day actually worked, so
// it stays markable. `termination_date` is the day the separation takes effect
// ("the date the employee is fired") and is NOT markable — the Fire flow writes
// both to the same date, so firing on the 10th makes the 10th unmarkable.

// Every lifecycle state that means "no longer employed". The DB enum carries
// both the original 'terminated'/'left' and the Phase-3A 'fired'/'absconded'
// values, and separations land on different ones depending on the reason:
//   termination_misconduct / termination_performance → fired
//   absconded                                        → absconded
//   resignation and everything else                  → left
export const SEPARATED_LIFECYCLE_STATES = [
  "terminated",
  "fired",
  "left",
  "absconded",
] as const;

export const isSeparatedState = (state: string | null | undefined): boolean =>
  SEPARATED_LIFECYCLE_STATES.includes(String(state ?? "") as (typeof SEPARATED_LIFECYCLE_STATES)[number]);

export type WindowEmployee = {
  join_date?: string | null;
  last_working_day?: string | null;
  termination_date?: string | null;
  lifecycle_state?: string | null;
};

export type WindowContract = {
  start_date?: string | null;
  end_date?: string | null;
  is_infinite?: boolean | null;
} | null | undefined;

/**
 * Why `date` (YYYY-MM-DD) can't be marked for this guard, or null when it can.
 * Pass the guard's contract when known — a null contract simply skips the
 * contract-window checks (office staff and unassigned guards have none).
 * Does NOT cover the future-date, closed-period or backdate-override rules;
 * those stay where they already live (attendance_gate / the calling screens).
 */
export function attendanceWindowError(
  emp: WindowEmployee,
  contract: WindowContract,
  date: string,
): string | null {
  if (emp.lifecycle_state === "archived") return "Record archived.";

  if (emp.join_date && date < emp.join_date) {
    return `Not employed before ${formatDate(emp.join_date)}.`;
  }
  // The separation date itself is out — see the note above.
  if (emp.termination_date && date >= emp.termination_date) {
    return `Separated on ${formatDate(emp.termination_date)} — that date and later can't be marked.`;
  }
  if (emp.last_working_day && date > emp.last_working_day) {
    return `Employment ended ${formatDate(emp.last_working_day)}.`;
  }

  if (contract) {
    if (contract.start_date && date < contract.start_date) {
      return `Contract starts ${formatDate(contract.start_date)}.`;
    }
    if (!contract.is_infinite && contract.end_date && date > contract.end_date) {
      return `Contract ended ${formatDate(contract.end_date)}.`;
    }
  }
  return null;
}

/** Short marker for the attendance export's day cells (see exportAttendance). */
export const SEPARATION_MARK = "X";
