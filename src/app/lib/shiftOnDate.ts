// Single per-date shift source of truth.
//
// A guard's shift is a DATED property of their posting (deployments): a shift
// change closes the old segment and opens a new one (see change_guard_shift /
// migration 0130). "What shift was this guard on for date X" must therefore be
// answered from the deployment segment that CONTAINS X — never from the flat
// employees.shift or the attendance_shift_overrides table, both of which lose
// history. Every consumer (corrections page, bulk-mark, exports, payroll,
// invoicing) resolves per-date shift through here so a mid-month shift change
// splits correctly: days before the change stay on the old shift, days on/after
// land on the new one.

import { supabase } from "./supabase";

export type ShiftResolver = (guardId: string, date: string) => string;

type Segment = {
  start: string;            // inclusive, "YYYY-MM-DD"
  end: string | null;       // inclusive, null = open-ended
  shift: string;            // resolved shift_code for this segment
};

// Build a resolver over a set of guards in ONE round-trip. The returned function
// is synchronous and cheap, so callers can loop over every (guard, day) of a
// month without issuing per-cell queries.
export async function loadShiftResolver(guardIds: string[]): Promise<ShiftResolver> {
  const ids = Array.from(new Set(guardIds.filter(Boolean)));
  if (ids.length === 0) return () => "day";

  // Dated posting segments + the segment's contract-line shift as a fallback for
  // rows created before deployments.shift_code existed.
  const { data: deps } = await supabase
    .from("deployments")
    .select("guard_id, start_date, end_date, shift_code, contract_lines:contract_line_id(shift_code)")
    .in("guard_id", ids)
    .order("start_date", { ascending: true });

  // Last-resort fallback: the guard's current shift (only used where no dated
  // segment covers the date — e.g. dates before the first posting).
  const { data: emps } = await supabase
    .from("employees")
    .select("id, shift")
    .in("id", ids);

  const currentShift = new Map<string, string>();
  for (const e of (emps ?? []) as any[]) currentShift.set(e.id, e.shift ?? "day");

  const byGuard = new Map<string, Segment[]>();
  for (const d of (deps ?? []) as any[]) {
    const shift =
      (d.shift_code as string | null) ??
      (d.contract_lines?.shift_code as string | null) ??
      currentShift.get(d.guard_id) ??
      "day";
    const seg: Segment = { start: d.start_date, end: d.end_date, shift };
    const arr = byGuard.get(d.guard_id);
    if (arr) arr.push(seg);
    else byGuard.set(d.guard_id, [seg]);
  }

  return (guardId: string, date: string): string => {
    const segs = byGuard.get(guardId);
    if (segs) {
      // Segments are start-ordered; the last one that has started by `date` and
      // has not yet ended wins (handles the change-day boundary cleanly).
      for (let i = segs.length - 1; i >= 0; i -= 1) {
        const s = segs[i];
        if (s.start <= date && (s.end === null || date <= s.end)) return s.shift;
      }
    }
    return currentShift.get(guardId) ?? "day";
  };
}

// Convenience single-shot resolver for one guard/date. Prefer loadShiftResolver
// when resolving many cells (it batches the fetch).
export async function shiftOnDate(guardId: string, date: string): Promise<string> {
  const resolve = await loadShiftResolver([guardId]);
  return resolve(guardId, date);
}
