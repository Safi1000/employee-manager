// Daily Reports (web FieldOps.tsx): a note per active client per day, the day's
// Other Updates and Next Day Tasks per region (0517), and the branded PDF built by the web's own
// generateDailyOperationsReportPdf with the previous day's attendance summary.
import { q, sb, uid } from "./core";
import { loadBranding } from "./exports";
import { loadAttendanceSummary, type AttendanceSummary } from "../../lib/web/attendanceSummary";
import { generateDailyOperationsReportPdf } from "../../lib/web/dailyReportPdf";

/** branch_id is the region (0517); null only on rows written before the split. */
export type DayTask = { id: string; title: string; assignee_employee_id: string | null; sort_order: number; branch_id: string | null };
/** Map key for the region-less rows written before 0517 — shown read-only, never guessed into a region. */
export const BEFORE_SPLIT = "";
export const BEFORE_SPLIT_LABEL = "All regions (before the split)";
export type ReportDay = {
  /** otherUpdates: region id (BEFORE_SPLIT for pre-0517 rows) -> that region's note. */
  details: Map<string, string>; noReport: Set<string>; otherUpdates: Map<string, string>; tasks: DayTask[];
  staff: { id: string; full_name: string; employee_code: string }[];
};

export async function loadReportDay(companyId: string, date: string): Promise<ReportDay> {
  const [rep, tasks, staff, day] = await Promise.all([
    q<any[]>(sb().from("daily_client_reports").select("client_id, details, no_report").eq("company_id", companyId).eq("report_date", date)),
    q<DayTask[]>(sb().from("daily_report_tasks").select("id, title, assignee_employee_id, sort_order, branch_id").eq("company_id", companyId).eq("report_date", date).order("sort_order").order("created_at")),
    q<any[]>(sb().from("employees").select("id, full_name, employee_code").eq("company_id", companyId).eq("category", "office_staff").eq("lifecycle_state", "active").order("full_name")),
    q<any[]>(sb().from("daily_report_day_notes").select("branch_id, other_updates").eq("company_id", companyId).eq("report_date", date)),
  ]);
  return {
    details: new Map(rep.map((r) => [r.client_id, r.details ?? ""])),
    noReport: new Set(rep.filter((r) => r.no_report).map((r) => r.client_id)),
    otherUpdates: new Map(day.map((r) => [r.branch_id ?? BEFORE_SPLIT, r.other_updates ?? ""])),
    tasks, staff,
  };
}

/** saveOne(): "No report" is the claim, so its text is cleared; an empty, unflagged row is deleted. */
export async function saveClientNote(companyId: string, clientId: string, date: string, value: string, flag: boolean) {
  const text = flag ? "" : value.trim();
  const userId = await uid();
  if (text || flag) {
    await q(sb().from("daily_client_reports").upsert(
      { company_id: companyId, client_id: clientId, report_date: date, details: text || null, no_report: flag, updated_by: userId } as never,
      { onConflict: "company_id,client_id,report_date" },
    ));
  } else {
    await q(sb().from("daily_client_reports").delete().eq("company_id", companyId).eq("client_id", clientId).eq("report_date", date));
  }
}

/** saveOtherUpdates() (0517): one row per (company, day, region). */
export async function saveOtherUpdates(companyId: string, date: string, branchId: string, value: string) {
  await q(sb().from("daily_report_day_notes").upsert(
    { company_id: companyId, report_date: date, branch_id: branchId, other_updates: value.trim() || null, updated_by: await uid() } as never,
    { onConflict: "company_id,report_date,branch_id" },
  ));
}

/** `existing` is the region's own tasks — sort order runs per region. */
export async function addDayTask(companyId: string, date: string, branchId: string, title: string, assignee: string | null, existing: DayTask[]) {
  if (!title.trim()) throw new Error("Write the task first.");
  await q(sb().from("daily_report_tasks").insert({
    company_id: companyId, report_date: date, branch_id: branchId, title: title.trim(), assignee_employee_id: assignee,
    sort_order: existing.length ? Math.max(...existing.map((t) => t.sort_order)) + 1 : 0, updated_by: await uid(),
  } as never));
}
export async function updateDayTask(id: string, patch: { title?: string; assignee_employee_id?: string | null }) {
  if (patch.title !== undefined && !patch.title.trim()) throw new Error("A task needs a title.");
  await q(sb().from("daily_report_tasks").update({ ...patch, updated_by: await uid() } as never).eq("id", id));
}
export const deleteDayTask = (id: string) => q(sb().from("daily_report_tasks").delete().eq("id", id));

/** The attendance summary for the report is the PREVIOUS day's (web attendanceDate = date − 1). */
export async function loadReportAttendance(companyId: string, date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return loadAttendanceSummary(companyId, d.toISOString().slice(0, 10));
}

/** Cut the summary to the visible region — totals folded from the filtered rows, never carried over. */
export function regionCut(att: AttendanceSummary, regionId: string | null): AttendanceSummary {
  if (!regionId) return att;
  const rows = att.clients.filter((c) => c.branch_id === regionId);
  return {
    date: att.date, clients: rows,
    totals: rows.reduce((t, c) => ({ deployed: t.deployed + c.deployed, present: t.present + c.present, absent: t.absent + c.absent, leave: t.leave + c.leave, other: t.other + c.other }), { deployed: 0, present: 0, absent: 0, leave: 0, other: 0 }),
    unconfirmed: rows.filter((c) => !c.confirmed),
  };
}

/** The region a task or note belongs to, as a block key (BEFORE_SPLIT for pre-0517 rows). */
export const blockKey = (branchId: string | null) => branchId ?? BEFORE_SPLIT;

/** exportPdf(): the PDF, then the export record. `blocks` = the region blocks on screen, in order. */
export async function exportDailyReport(args: {
  companyId: string; date: string; regionLabel: string | null; clients: { id: string; name: string }[]; day: ReportDay; attendance: AttendanceSummary | null;
  blocks: { key: string; label: string }[];
}) {
  const { company } = await loadBranding(args.companyId);
  const staffName = (id: string | null) => (id ? args.day.staff.find((x) => x.id === id)?.full_name ?? "Former staff" : null);
  const rows = args.clients.map((c) => ({ client_name: c.name, details: args.day.details.get(c.id) ?? null, no_report: args.day.noReport.has(c.id) }));
  const filled = args.clients.filter((c) => !args.day.noReport.has(c.id) && (args.day.details.get(c.id) ?? "").trim().length > 0).length;
  generateDailyOperationsReportPdf(company, args.date, rows, {
    regionLabel: args.regionLabel,
    regionSections: args.blocks.map((b) => ({
      label: b.label,
      nextDayTasks: args.day.tasks.filter((t) => blockKey(t.branch_id) === b.key).map((t) => ({ title: t.title, assignee: staffName(t.assignee_employee_id) })),
      otherUpdates: args.day.otherUpdates.get(b.key) ?? null,
    })),
    attendance: args.attendance,
  });
  await q(sb().from("daily_report_exports").insert({
    company_id: args.companyId, report_date: args.date, total_posts: args.clients.length, reported: filled,
    silent: args.clients.length - filled, exceptions: 0, generated_by: await uid(),
  } as never));
}
