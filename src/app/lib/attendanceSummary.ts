import { supabase } from "./supabase";
import { hiddenFromAttendance } from "./employmentWindow";

// A client-by-client attendance summary for ONE date, built for the Daily
// Reports page (screen tab + PDF section).
//
// Why this exists beside the Attendance board's own loader: the board builds
// client-SHIFT-SITE cards with rosters, gap rows, reliever cover and a drill-in
// — several hundred lines of grouping this screen needs none of. What the daily
// report asks is narrower and per CLIENT: how many were deployed, how many were
// an exception, and — the part that matters — WAS THE DAY CONFIRMED. A client
// whose attendance was never confirmed is the thing the report has to flag, and
// an unflagged one reads as confirmed, which is the failure this guards.
//
// Presume-present, exactly as the board does: a deployed guard with no
// attendance row is present. Exceptions are the rows that exist and say
// otherwise. So `present` is derived from deployment minus exceptions, never
// from counting "present" rows — those are only written when somebody clears an
// earlier exception.

export type ClientAttendanceSummary = {
  client_id: string;
  client_name: string;
  branch_id: string | null;
  /** Guards posted to this client on the date (roster strength). */
  deployed: number;
  /** Deployed minus the exception statuses below. */
  present: number;
  absent: number;
  leave: number;
  /** Rest day / blocked / anything else non-present. */
  other: number;
  /** Guards with an attendance row of any kind — how much was actually touched. */
  marked: number;
  confirmed: boolean;
  confirmed_by: string | null;
  confirmed_at: string | null;
};

export type AttendanceSummary = {
  date: string;
  clients: ClientAttendanceSummary[];
  totals: { deployed: number; present: number; absent: number; leave: number; other: number };
  /** Clients with guards deployed and no confirmation on the date. */
  unconfirmed: ClientAttendanceSummary[];
};

const EXCEPTION = new Set(["absent", "rotation_leave", "leave", "rest_day", "blocked"]);

/**
 * Load the summary for `date`, optionally narrowed to one region.
 *
 * `regionId` filters on the CLIENT's branch, matching how the Daily Reports
 * page filters its client list — so the summary in the PDF covers exactly the
 * clients the report above it covers.
 */
export async function loadAttendanceSummary(
  companyId: string,
  date: string,
  regionId: string | null = null,
): Promise<AttendanceSummary> {
  const [{ data: deps }, { data: att }, { data: confs }, { data: siteRows }, { data: cliRows }] =
    await Promise.all([
      supabase
        .from("deployments")
        .select(
          "guard_id, client_id, site_id, start_date, end_date, " +
            "employees:guard_id(category, join_date, last_working_day, termination_date, exit_date, lifecycle_state)",
        )
        .range(0, 9999)
        // The dated segment containing the date — a guard separated last week is
        // not on this day's roster, and last month's posting is not today's.
        .lte("start_date", date)
        .or(`end_date.is.null,end_date.gte.${date}`),
      supabase
        .from("attendance_records")
        .select("employee_id, status")
        .eq("attendance_date", date),
      supabase
        .from("attendance_confirmations")
        .select("client_id, site_id, group_key, supervisor_name, confirmed_at")
        .eq("attendance_date", date),
      supabase.from("sites").select("id, client_id"),
      supabase.from("clients").select("id, name, branch_id").eq("company_id", companyId),
    ]);

  const clientById = new Map(
    ((cliRows ?? []) as any[]).map((c) => [c.id as string, c as { id: string; name: string; branch_id: string | null }]),
  );
  const clientOfSite = new Map(((siteRows ?? []) as any[]).map((s) => [s.id as string, s.client_id as string]));

  // A confirmation names its client directly, or names a site (group_key is the
  // site id on a client-shift card). Both resolve to one client here — the page
  // reports per client, not per site, and one confirmed site is evidence the
  // client's day was looked at.
  const confByClient = new Map<string, { supervisor_name: string | null; confirmed_at: string | null }>();
  for (const c of (confs ?? []) as any[]) {
    const cid =
      (c.client_id as string | null) ??
      clientOfSite.get(String(c.site_id ?? c.group_key ?? "")) ??
      null;
    if (!cid || confByClient.has(cid)) continue;
    confByClient.set(cid, { supervisor_name: c.supervisor_name ?? null, confirmed_at: c.confirmed_at ?? null });
  }

  // One status per guard per day, the exception winning where a day carries both
  // (the board's own rule — a double-marked day is an exception day).
  const statusByGuard = new Map<string, string>();
  for (const a of (att ?? []) as any[]) {
    const s = String(a.status ?? "").toLowerCase();
    const prev = statusByGuard.get(a.employee_id);
    if (!prev || (EXCEPTION.has(s) && !EXCEPTION.has(prev))) statusByGuard.set(a.employee_id, s);
  }

  // A guard can hold overlapping posting segments covering the same date; count
  // them once, under the latest-starting open segment (the board's tie-break).
  const bestByGuard = new Map<string, any>();
  for (const d of (deps ?? []) as any[]) {
    if (!d.client_id) continue;
    const e = d.employees;
    if (!e) continue;
    if (e.category === "reliever") continue;
    if (e.join_date && e.join_date > date) continue;
    if (hiddenFromAttendance(e, date)) continue;
    if (e.lifecycle_state === "archived") continue;
    const prev = bestByGuard.get(d.guard_id);
    if (!prev) { bestByGuard.set(d.guard_id, d); continue; }
    const better =
      d.start_date !== prev.start_date
        ? d.start_date > prev.start_date
        : (d.end_date === null) !== (prev.end_date === null)
          ? d.end_date === null
          : String(d.id ?? "") > String(prev.id ?? "");
    if (better) bestByGuard.set(d.guard_id, d);
  }

  const byClient = new Map<string, ClientAttendanceSummary>();
  const blank = (cid: string): ClientAttendanceSummary => {
    const c = clientById.get(cid);
    return {
      client_id: cid,
      client_name: c?.name ?? "—",
      branch_id: c?.branch_id ?? null,
      deployed: 0, present: 0, absent: 0, leave: 0, other: 0, marked: 0,
      confirmed: false, confirmed_by: null, confirmed_at: null,
    };
  };

  for (const d of bestByGuard.values() as Iterable<any>) {
    const cid = d.client_id as string;
    // A deployment pointing at a client this company cannot read is not this
    // company's row; skip rather than inventing a "—" client.
    if (!clientById.has(cid)) continue;
    const row = byClient.get(cid) ?? blank(cid);
    row.deployed += 1;
    const st = statusByGuard.get(d.guard_id);
    if (st) row.marked += 1;
    if (st === "absent") row.absent += 1;
    else if (st === "rotation_leave" || st === "leave") row.leave += 1;
    else if (st && EXCEPTION.has(st)) row.other += 1;
    byClient.set(cid, row);
  }

  for (const row of byClient.values()) {
    row.present = row.deployed - row.absent - row.leave - row.other;
    const conf = confByClient.get(row.client_id);
    if (conf) {
      row.confirmed = true;
      row.confirmed_by = conf.supervisor_name;
      row.confirmed_at = conf.confirmed_at;
    }
  }

  let clients = [...byClient.values()];
  if (regionId) clients = clients.filter((c) => c.branch_id === regionId);
  // Unconfirmed first, then by name — the flagged ones are what the page is for.
  clients.sort((a, b) =>
    a.confirmed === b.confirmed ? a.client_name.localeCompare(b.client_name) : a.confirmed ? 1 : -1,
  );

  const totals = clients.reduce(
    (t, c) => ({
      deployed: t.deployed + c.deployed,
      present: t.present + c.present,
      absent: t.absent + c.absent,
      leave: t.leave + c.leave,
      other: t.other + c.other,
    }),
    { deployed: 0, present: 0, absent: 0, leave: 0, other: 0 },
  );

  return { date, clients, totals, unconfirmed: clients.filter((c) => !c.confirmed) };
}
