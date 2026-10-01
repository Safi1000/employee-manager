// Daily Reports (web FieldOps.tsx): a note per active client per day, the day's
// Other Updates, Next Day Tasks, and the branded PDF built by the web's own
// generateDailyOperationsReportPdf with the previous day's attendance summary.
import { q, sb, uid } from "./core";
import { loadBranding } from "./exports";
import { loadAttendanceSummary, type AttendanceSummary } from "../../lib/web/attendanceSummary";
import { generateDailyOperationsReportPdf } from "../../lib/web/dailyReportPdf";

export type DayTask = { id: string; title: string; assignee_employee_id: string | null; sort_order: number };
export type ReportDay = {
  details: Map<string, string>; noReport: Set<string>; otherUpdates: string; tasks: DayTask[];
  staff: { id: string; full_name: string; employee_code: string }[];
};

export async function loadReportDay(companyId: string, date: string): Promise<ReportDay> {
  const [rep, tasks, staff, day] = await Promise.all([
    q<any[]>(sb().from("daily_client_reports").select("client_id, details, no_report").eq("company_id", companyId).eq("report_date", date)),
    q<DayTask[]>(sb().from("daily_report_tasks").select("id, title, assignee_employee_id, sort_order").eq("company_id", companyId).eq("report_date", date).order("sort_order").order("created_at")),
    q<any[]>(sb().from("employees").select("id, full_name, employee_code").eq("company_id", companyId).eq("category", "office_staff").eq("lifecycle_state", "active").order("full_name")),
    sb().from("daily_report_day_notes").select("other_updates").eq("company_id", companyId).eq("report_date", date).maybeSingle(),
  ]);
  return {
    details: new Map(rep.map((r) => [r.client_id, r.details ?? ""])),
    noReport: new Set(rep.filter((r) => r.no_report).map((r) => r.client_id)),
    otherUpdates: ((day.data as any)?.other_updates ?? "") as string,
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

/** saveOtherUpdates() (0475): one row per (company, day). */
export async function saveOtherUpdates(companyId: string, date: string, value: string) {
  await q(sb().from("daily_report_day_notes").upsert(
    { company_id: companyId, report_date: date, other_updates: value.trim() || null, updated_by: await uid() } as never,
    { onConflict: "company_id,report_date" },
  ));
}

export async function addDayTask(companyId: string, date: string, title: string, assignee: string | null, existing: DayTask[]) {
  if (!title.trim()) throw new Error("Write the task first.");
  await q(sb().from("daily_report_tasks").insert({
    company_id: companyId, report_date: date, title: title.trim(), assignee_employee_id: assignee,
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

/** exportPdf(): the PDF, then the export record. */
export async function exportDailyReport(args: {
  companyId: string; date: string; regionLabel: string | null; clients: { id: string; name: string }[]; day: ReportDay; attendance: AttendanceSummary | null;
}) {
  const { company } = await loadBranding(args.companyId);
  const staffName = (id: string | null) => (id ? args.day.staff.find((x) => x.id === id)?.full_name ?? "Former staff" : null);
  const rows = args.clients.map((c) => ({ client_name: c.name, details: args.day.details.get(c.id) ?? null, no_report: args.day.noReport.has(c.id) }));
  const filled = args.clients.filter((c) => !args.day.noReport.has(c.id) && (args.day.details.get(c.id) ?? "").trim().length > 0).length;
  generateDailyOperationsReportPdf(company, args.date, rows, {
    regionLabel: args.regionLabel,
    nextDayTasks: args.day.tasks.map((t) => ({ title: t.title, assignee: staffName(t.assignee_employee_id) })),
    otherUpdates: args.day.otherUpdates,
    attendance: args.attendance,
  });
  await q(sb().from("daily_report_exports").insert({
    company_id: args.companyId, report_date: args.date, total_posts: args.clients.length, reported: filled,
    silent: args.clients.length - filled, exceptions: 0, generated_by: await uid(),
  } as never));
}
