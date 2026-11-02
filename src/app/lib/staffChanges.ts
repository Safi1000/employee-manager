import { supabase } from "./supabase";

/**
 * STAFF CHANGES (0632) — who was hired, left, re-hired, moved or had their pay
 * changed, ENTERED since the last attendance report was exported (so a
 * backdated hire still appears once), and documents running out in 30 days.
 * Read from hr_changes(); nobody types any of it.
 */
export type StaffChanges = {
  from: string; to: string;
  hired: { name: string; code: string | null; category: string | null; client: string | null; join_date: string | null; branch_id: string | null }[];
  separated: { name: string; code: string | null; to_state: string; reason: string | null; last_day: string | null; branch_id: string | null }[];
  rehired: { name: string; code: string | null; join_date: string | null; branch_id: string | null }[];
  transferred: { name: string; code: string | null; to_client: string; from: string; branch_id: string | null }[];
  salary_changes: { name: string; code: string | null; from_date: string; base: number; reason: string | null; branch_id: string | null }[];
  expiring: { name: string; code: string | null; document: string; date: string; branch_id: string | null }[];
};

/** The period starts where the last exported attendance report ended (report_period_start('hr')). */
export async function loadStaffChanges(from?: string, to?: string): Promise<StaffChanges | null> {
  let start = from;
  if (!start) {
    const { data } = await supabase.rpc("report_period_start", { p_kind: "hr" });
    start = (data as string | null) ?? new Date(Date.now() - 86400000).toISOString();
  }
  const { data, error } = await supabase.rpc("hr_changes", { p_from: start, p_to: to ?? new Date().toISOString() });
  if (error || !data) return null;
  return data as StaffChanges;
}

/** One region's share; null region = everything. */
export function staffForRegion(s: StaffChanges, regionId: string | null): StaffChanges {
  if (!regionId) return s;
  const keep = <T extends { branch_id: string | null }>(xs: T[]) => xs.filter((x) => x.branch_id === regionId);
  return { ...s, hired: keep(s.hired), separated: keep(s.separated), rehired: keep(s.rehired), transferred: keep(s.transferred), salary_changes: keep(s.salary_changes), expiring: keep(s.expiring) };
}

export const staffChangeCount = (s: StaffChanges) => s.hired.length + s.separated.length + s.rehired.length + s.transferred.length + s.salary_changes.length;

/** Record the export, so the next attendance report starts here. Company-wide exports only. */
export async function logStaffReport(s: StaffChanges) {
  await supabase.rpc("log_report_run", { p_kind: "hr", p_from: s.from, p_to: s.to });
}

export const STATE_LABEL: Record<string, string> = { left: "Resigned", terminated: "Terminated", fired: "Fired", absconded: "Absconded" };
