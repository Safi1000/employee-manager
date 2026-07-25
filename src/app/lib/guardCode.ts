// Client-prefixed DISPLAY code (Phase 2/3) — the primary identifier shown in the
// UI everywhere a guard/employee ID appears (Employees, Attendance, Payroll,
// Roster, exports, dropdowns, search). The permanent immutable guard_code
// (GGS-…) is the secondary/fallback identifier.
//
// display_code = {current client's employee_id_prefix}-{padded display_number}
// Falls back to guard_code (or employee_code) when there is no client prefix or
// no display number (office staff, unposted, client-without-prefix).

export function guardDisplayCode(
  e: {
    display_number?: number | null;
    guard_code?: string | null;
    employee_code?: string | null;
  },
  clientPrefix?: string | null,
): string {
  const fallback = e.guard_code ?? e.employee_code ?? "";
  if (e.display_number == null || !clientPrefix) return fallback;
  return `${clientPrefix}-${String(e.display_number).padStart(3, "0")}`;
}

// The permanent code shown as the secondary line under the display code.
export function guardPermanentCode(e: {
  guard_code?: string | null;
  employee_code?: string | null;
}): string {
  return e.guard_code ?? e.employee_code ?? "";
}
