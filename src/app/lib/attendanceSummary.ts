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

/** One site of a client on the date, with its own confirmation. */
export type SiteConfirmation = {
  /** null for guards posted to the client with no site. */
  site_id: string | null;
  site_name: string;
  deployed: number;
  confirmed: boolean;
  confirmed_by: string | null;
};

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
  /** Every site with guards on the date is confirmed. */
  confirmed: boolean;
  /** Some sites confirmed, others not — `sites` says which. */
  partial: boolean;
  confirmed_by: string | null;
  confirmed_at: string | null;
  /** Per-site confirmation, unconfirmed sites first. */
  sites: SiteConfirmation[];
};

export type AttendanceSummary = {
  date: string;
  clients: ClientAttendanceSummary[];
  totals: { deployed: number; present: number; absent: number; leave: number; other: number };
  /** Clients not FULLY confirmed on the date — none of their sites, or only some. */
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
      supabase.from("sites").select("id, client_id, name"),
      supabase.from("clients").select("id, name, branch_id").eq("company_id", companyId),
    ]);

  const clientById = new Map(
    ((cliRows ?? []) as any[]).map((c) => [c.id as string, c as { id: string; name: string; branch_id: string | null }]),
  );
  const clientOfSite = new Map(((siteRows ?? []) as any[]).map((s) => [s.id as string, s.client_id as string]));
  const siteName = new Map(((siteRows ?? []) as any[]).map((s) => [s.id as string, (s.name ?? "—") as string]));

  // Confirmation is per SITE: a client with three sites confirmed at two is not
  // a confirmed client, and saying so by client alone would hide the third.
  //
  // A confirmation carrying a site (site_id, or a group_key that is a site id)
  // covers that site. One carrying a client and NO site is client-wide and covers
  // every site of that client — the same reading loadConfirmationGate uses for
  // the attendance sheets, so the two cannot disagree about what is confirmed.
  type Conf = { supervisor_name: string | null; confirmed_at: string | null };
  const confBySite = new Map<string, Conf>();
  const confClientWide = new Map<string, Conf>();
  for (const c of (confs ?? []) as any[]) {
    const entry: Conf = { supervisor_name: c.supervisor_name ?? null, confirmed_at: c.confirmed_at ?? null };
    const siteId =
      (c.site_id as string | null) ??
      (clientOfSite.has(String(c.group_key ?? "")) ? String(c.group_key) : null);
    if (siteId) {
      if (!confBySite.has(siteId)) confBySite.set(siteId, entry);
      continue;
    }
    const cid = (c.client_id as string | null) ?? null;
    if (cid && !confClientWide.has(cid)) confClientWide.set(cid, entry);
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
      confirmed: false, partial: false, confirmed_by: null, confirmed_at: null, sites: [],
    };
  };

  for (const d of bestByGuard.values() as Iterable<any>) {
    const cid = d.client_id as string;
    // A deployment pointing at a client this company cannot read is not this
    // company's row; skip rather than inventing a "—" client.
    if (!clientById.has(cid)) continue;
    const row = byClient.get(cid) ?? blank(cid);
    row.deployed += 1;
    const sid = (d.site_id as string | null) ?? null;
    let site = row.sites.find((x) => x.site_id === sid);
    if (!site) {
      site = {
        site_id: sid,
        site_name: sid ? siteName.get(sid) ?? "—" : "No site",
        deployed: 0, confirmed: false, confirmed_by: null,
      };
      row.sites.push(site);
    }
    site.deployed += 1;
    const st = statusByGuard.get(d.guard_id);
    if (st) row.marked += 1;
    if (st === "absent") row.absent += 1;
    else if (st === "rotation_leave" || st === "leave") row.leave += 1;
    else if (st && EXCEPTION.has(st)) row.other += 1;
    byClient.set(cid, row);
  }

  for (const row of byClient.values()) {
    row.present = row.deployed - row.absent - row.leave - row.other;
    const wide = confClientWide.get(row.client_id) ?? null;
    let firstConf: Conf | null = wide;
    for (const site of row.sites) {
      const conf = (site.site_id ? confBySite.get(site.site_id) : null) ?? wide;
      if (!conf) continue;
      site.confirmed = true;
      site.confirmed_by = conf.supervisor_name;
      firstConf ??= conf;
    }
    const done = row.sites.filter((x) => x.confirmed).length;
    row.confirmed = row.sites.length > 0 && done === row.sites.length;
    row.partial = done > 0 && done < row.sites.length;
    if (firstConf && done > 0) {
      row.confirmed_by = firstConf.supervisor_name;
      row.confirmed_at = firstConf.confirmed_at;
    }
    row.sites.sort((a, b) =>
      a.confirmed === b.confirmed ? a.site_name.localeCompare(b.site_name) : a.confirmed ? 1 : -1,
    );
  }

  let clients = [...byClient.values()];
  if (regionId) clients = clients.filter((c) => c.branch_id === regionId);
  // Not confirmed, then partly confirmed, then confirmed — the flagged ones are
  // what the page is for.
  const rank = (c: ClientAttendanceSummary) => (c.confirmed ? 2 : c.partial ? 1 : 0);
  clients.sort((a, b) => rank(a) - rank(b) || a.client_name.localeCompare(b.client_name));

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

/**
 * The flag line for a client that is not fully confirmed. A partly confirmed
 * client names the sites still open, so the reader knows exactly where to go;
 * a wholly unconfirmed one needs no breakdown — every site is open.
 * Shared by the screen and the PDF so the two spell the flag the same way.
 */
export function describeUnconfirmed(c: ClientAttendanceSummary): string {
  if (!c.partial) return c.client_name;
  const open = c.sites.filter((s) => !s.confirmed).map((s) => s.site_name);
  return `${c.client_name} (not confirmed: ${open.join(", ")})`;
}
