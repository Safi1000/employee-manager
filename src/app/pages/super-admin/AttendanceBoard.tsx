import { isIsoDate } from "../../lib/date";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Building2, MapPin, Loader2, X, ChevronRight, ChevronLeft, CheckCircle2, Clock, Download, Briefcase, CalendarRange, Search, ChevronDown, FileText, Users, FileSpreadsheet, Loader } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import Tabs from "../../components/Tabs";
import ThemedSelect from "../../components/ThemedSelect";
import { supabase, fetchAllRows, resolveAllowedLeaves } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { guardDisplayCode } from "../../lib/guardCode";
import BulkMarkByEmployeeModal from "../../components/BulkMarkByEmployeeModal";
import AttendanceSheetModal from "../../components/AttendanceSheetModal";
import { brandingFromCompany, type PdfBranding } from "../../lib/pdfBranding";
import { generateClientAttendancePdf, generateGuardAttendancePdf } from "../../lib/attendanceSheetPdf";
import { exportAttendance, type AttendanceEmployeeRow } from "../../lib/excel";
import { loadShiftResolver } from "../../lib/shiftOnDate";
import { hiddenFromAttendance } from "../../lib/employmentWindow";
import { saveText } from "../../lib/saveFile";
import { useRegion } from "../../lib/region";

// ── Phase 6: Attendance board by client-shift (§8.1-8.10) ─────────────────────
// Unit of work = client-shift-day. Presume present; operator enters only
// exceptions, then confirms the client-shift with the supervisor's name.

type Status = "present" | "absent" | "rotation_leave" | "rest_day" | "double_duty" | "relief_cover" | "blocked";
type AbsentReason = "awol" | "sick" | "absconded";
type EntryType = "normal" | "swap" | "double_duty" | "relief_cover";

const STATUS_LABEL: Record<Status, string> = {
  present: "Present",
  absent: "Absent",
  rotation_leave: "Leave",
  rest_day: "Rest day",
  double_duty: "Double duty",
  relief_cover: "Relief cover",
  blocked: "Blocked",
};
// The exception statuses offered when marking (besides the default Present).
// Rest day / Relief cover are retired from the picker (legacy rows still render
// via the maps above); Leave = rotation_leave.
const EXCEPTION_STATUSES: Status[] = ["absent", "rotation_leave", "double_duty"];

// Short calendar-cell code + cell colouring per status (for the bulk-by-employee
// month calendar). Legacy/existing rows may carry double_duty / relief_cover.
const STATUS_SHORT: Record<Status, string> = {
  present: "P", absent: "A", rotation_leave: "RL", rest_day: "RD", double_duty: "DD", relief_cover: "RC", blocked: "B",
};
const STATUS_CELL_CLASS: Record<Status, string> = {
  present: "bg-success-50 text-success-700 dark:text-success-500 border-success-200",
  absent: "bg-danger-50 text-danger-700 dark:text-danger-500 border-danger-200",
  rotation_leave: "bg-warning-50 text-warning-700 dark:text-warning-500 border-warning-200",
  rest_day: "bg-warning-50 text-warning-700 dark:text-warning-500 border-warning-200",
  double_duty: "bg-brand-50 text-brand-700 border-brand-200",
  relief_cover: "bg-brand-50 text-brand-700 border-brand-200",
  blocked: "bg-slate-100 text-slate-500 border-slate-200",
};
// The only four statuses the bulk-by-employee view offers (Leave = rotation_leave).
// Double Duty here carries full shift context (see the shift selector), matching the
// normal attendance board. "Clear" is a separate revert action, not a status.
const BULK_STATUS_OPTIONS: { status: Status; label: string; activeBtn: string }[] = [
  { status: "present", label: "Present", activeBtn: "bg-success-600 text-white border-success-600" },
  { status: "absent", label: "Absent", activeBtn: "bg-danger-600 text-white border-danger-600" },
  { status: "rotation_leave", label: "Leave", activeBtn: "bg-warning-500 text-white border-warning-500" },
  { status: "double_duty", label: "Double Duty", activeBtn: "bg-brand-600 text-white border-brand-600" },
];

// Board (new-model) status → the P/A/L vocabulary of the shared monthly export
// (lib/excel exportAttendance). Worked statuses count as Present; leave-type
// statuses as Leave; blocked/unknown leave the cell blank.
const EXPORT_SYMBOL: Record<Status, string> = {
  present: "P", double_duty: "P", relief_cover: "P",
  absent: "A", rotation_leave: "L", rest_day: "L", blocked: "",
};

const VALID_STATUS = new Set<string>(["present", "absent", "rotation_leave", "rest_day", "double_duty", "relief_cover", "blocked"]);
// Legacy attendance rows (pre-Phase-6) store capitalized Present/Absent/Leave and
// have none of the new-model fields. Normalize any raw / legacy / missing status
// to a valid new-model Status so the board NEVER crashes on old data. Unknown or
// missing values degrade to 'present' (a non-exception), never throw.
function normalizeStatus(raw: unknown): Status {
  const s = String(raw ?? "").toLowerCase();
  if (s === "leave") return "rotation_leave";
  return (VALID_STATUS.has(s) ? s : "present") as Status;
}

const today = () => new Date().toISOString().slice(0, 10);

// Humanized label for a non-client category (office_staff → "Office Staff").
// Dynamic: any future category renders as a title-cased row group.
const catLabel = (c: string): string =>
  c.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

// Compact one-letter shift badge for the calendar cells (day → D, night → N,
// evening → E). Data-driven from the shift_code, never a hardcoded set.
const shiftAbbr = (code: string): string => (code ? code[0].toUpperCase() : "?");

type RosterGuard = {
  guard_id: string;
  full_name: string;
  guard_code: string | null;
  display_number: number | null;
  employee_code: string;
  client_id: string | null; // null for non-client categories (office staff, …)
  scheduled_shift: string;
  /** The guard's own region, used to scope synthetic category rows. */
  branch_id?: string | null;
};

type ClientShift = {
  key: string;
  site_id: string;
  site_name: string;
  client_id: string;
  client_name: string;
  client_prefix: string | null;
  /** Confirmation / grouping key: the site, or the client when there is no site. */
  group_key: string;
  /**
   * Shifts this row's client actually runs, from the contract. Used by the
   * marking form where there is no site to read shift_definitions from — without
   * it a siteless client could only ever offer the one shift being viewed.
   */
  contract_shifts: string[];
  shift_code: string;
  contracted: number;
  roster: RosterGuard[];
  // existing attendance rows for this shift-day (exceptions already entered)
  marks: Map<string, { status: Status; absent_reason: AbsentReason | null }>;
  confirmation: { supervisor_name: string; confirmed_at: string } | null;
  // A synthetic (category, shift) group for a non-client category with no client
  // site — marked like any row, but with no site-based confirmation.
  synthetic?: boolean;
  /**
   * Region (branches.id) this row belongs to, for the global region selector.
   * Taken from the CLIENT for a client-shift; deployments carry no branch_id of
   * their own. Synthetic category rows have no client, so they carry null and
   * are filtered on their guards' own branch instead.
   */
  branch_id: string | null;
};

type Vacancy = {
  id: string;
  client_id: string;
  site_id: string | null;
  shift_code: string | null;
  opened_at: string;
  opened_reason: string | null;
  status: string;
};

export default function AttendanceBoard() {
  const { profile, company } = useAuth();
  const { regionId } = useRegion();
  const branding = brandingFromCompany(company);
  const [date, setDate] = useState(today());
  const [tab, setTab] = useState<"board" | "vacancies">("board");
  const [rows, setRows] = useState<ClientShift[]>([]);
  const [vacancies, setVacancies] = useState<Vacancy[]>([]);
  const [clientNames, setClientNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<ClientShift | null>(null);
  /** Expanded client cards, then expanded sites within them. */
  const [openClients, setOpenClients] = useState<Set<string>>(new Set());
  const [openSites, setOpenSites] = useState<Set<string>>(new Set());
  // Which client/site's monthly attendance sheet is open in the viewer.
  const [sheetView, setSheetView] = useState<{ clientId: string; clientName: string; siteId?: string; siteName?: string } | null>(null);
  const toggleIn = (k: string, set: (fn: (p: Set<string>) => Set<string>) => void) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  // Controls added onto the board (alongside the Phase 6 model, not replacing it).
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  // Bulk Mark by Employee (calendar) — same permission gate as the Relievers tab.
  const canBulk = hasPermission(profile, "attendance.bulk_mark");
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    // Active deployments on the date + guard + site + client + contract line shift.
    const [{ data: deps, error: depErr }, { data: cls }, { data: siteRows }, { data: confs }, { data: att }, { data: cliRows }, { data: cons }, { data: vac }, { data: staff }] =
      await Promise.all([
        supabase
          .from("deployments")
          .select(
            // `id` is the last-resort tie-break when two segments start the same
            // day and are both open/both closed — it just needs to be stable.
            "id, guard_id, site_id, client_id, contract_line_id, shift_code, start_date, end_date, " +
              // termination_date and exit_date are read by hiddenFromAttendance.
              // They were missing here, so the roster's separation cutoff was
              // computed from an undefined field and a guard separated via the
              // Lifecycle panel never dropped off the board.
              "employees:guard_id(full_name, guard_code, display_number, employee_code, shift, category, join_date, last_working_day, termination_date, exit_date, lifecycle_state), " +
              "sites:site_id(name), clients:client_id(name, employee_id_prefix, branch_id), contract_lines:contract_line_id(shift_code)",
          )
          .range(0, 9999)
          // The posting whose DATED segment contains the viewed date — not just
          // the current one. So a separated guard drops off from the day after
          // their last working day, and a shift change shows the OLD shift for
          // old dates / the NEW shift from the change date (history never moves).
          .lte("start_date", date)
          .or(`end_date.is.null,end_date.gte.${date}`),
        supabase.from("contract_lines").select("site_id, shift_code, billed_qty").not("site_id", "is", null),
        supabase.from("sites").select("id, client_id, name"),
        supabase.from("attendance_confirmations").select("*").eq("attendance_date", date),
        supabase.from("attendance_records").select("employee_id, status, absent_reason, worked_shift, site_id:worked_for_client_id").eq("attendance_date", date),
        supabase.from("clients").select("id, name, employee_id_prefix, branch_id"),
        // The contract's per-shift headcount decides which shifts a client runs.
        supabase
          .from("contracts")
          .select("client_id, contract_type, status, day_guards, night_guards, evening_guards, start_date, end_date, is_infinite")
          .eq("status", "active")
          .eq("contract_type", "guard_deployment")
          // In force ON the viewed date — a contract starting in 2026 must not
          // put rows on a 2024 board.
          .lte("start_date", date)
          .or(`is_infinite.eq.true,end_date.is.null,end_date.gte.${date}`),
        supabase.from("vacancies").select("*").eq("status", "open").order("opened_at", { ascending: false }),
        // Non-client categories (office staff + any future category) have no
        // client posting; load them directly so they appear on the board too.
        // Relievers are EXCLUDED — they live on the Relievers tab.
        supabase
          .from("employees")
          .select("id, full_name, guard_code, display_number, employee_code, shift, category, join_date, last_working_day, termination_date, exit_date, lifecycle_state, branch_id")
          .neq("category", "reliever")
          .neq("category", "client"),
      ]);
    if (depErr) { setError(depErr.message); setLoading(false); return; }

    setClientNames(new Map((cliRows ?? []).map((c: any) => [c.id, c.name])));
    setVacancies((vac ?? []) as Vacancy[]);

    // contracted strength per (site, shift)
    const contracted = new Map<string, number>();
    for (const l of (cls ?? []) as any[]) {
      if (!l.site_id) continue;
      const k = `${l.site_id}|${l.shift_code ?? "day"}`;
      contracted.set(k, (contracted.get(k) ?? 0) + (l.billed_qty ?? 0));
    }
    // Committed headcount per (client, shift), summed across the client's active
    // guard-deployment contracts. A shift with 0 committed simply isn't run.
    const shiftStrength = new Map<string, Map<string, number>>();
    for (const k of (cons ?? []) as any[]) {
      // Belt and braces: the query already windows on the date, but a null
      // start_date would slip through PostgREST's filter.
      if (k.start_date && k.start_date > date) continue;
      if (!k.is_infinite && k.end_date && k.end_date < date) continue;
      const per = shiftStrength.get(k.client_id) ?? new Map<string, number>();
      for (const [shift, n] of [
        ["day", k.day_guards], ["night", k.night_guards], ["evening", k.evening_guards],
      ] as const) {
        const v = Number(n) || 0;
        if (v > 0) per.set(shift, (per.get(shift) ?? 0) + v);
      }
      if (per.size > 0) shiftStrength.set(k.client_id, per);
    }

    // confirmations per (site, shift)
    // Keyed by group_key (0132): a client-shift's group_key is its site_id, a
    // category group's is 'cat:<category>' — so both kinds read back their state.
    const confMap = new Map<string, { supervisor_name: string; confirmed_at: string }>();
    for (const c of (confs ?? []) as any[]) confMap.set(`${c.group_key}|${c.shift_code}`, { supervisor_name: c.supervisor_name, confirmed_at: c.confirmed_at });
    // marks per guard (attendance rows already entered for this date)
    const markByGuard = new Map<string, { status: Status; absent_reason: AbsentReason | null; shift: string }>();
    for (const a of (att ?? []) as any[]) {
      // Legacy rows may lack worked_shift — key defensively so nothing is dropped.
      const ws = a.worked_shift ?? a.scheduled_shift ?? "day";
      markByGuard.set(`${a.employee_id}|${ws}`, { status: normalizeStatus(a.status), absent_reason: a.absent_reason ?? null, shift: ws });
    }

    // A guard stands at ONE site on ONE shift on a given date. Overlapping
    // posting segments break that: an old segment whose end_date still covers
    // `date` sits beside the current one, and the guard is rendered once per
    // segment — on two sites and two shifts at the same time.
    //
    // Migration 0183 closes the overlaps in the data. This picks the winner at
    // render time as well, so a board is never wrong while that is pending or if
    // an overlap is reintroduced: latest start_date wins (the most recent
    // posting decision), and an OPEN segment beats a closed one starting the
    // same day, because closing is what supersession looks like here.
    //
    // Deliberately keyed on guard alone, not guard+shift: a genuine same-day
    // double duty is recorded as a second ATTENDANCE row on the date (see
    // migration 0173), not as a second posting, so collapsing to one posting
    // does not cost the board any real double-duty case.
    const bestByGuard = new Map<string, any>();
    for (const d of (deps ?? []) as any[]) {
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

    // Build client-shift rows from active deployments, applying the §8.6 window.
    const byKey = new Map<string, ClientShift>();
    // A guard can hold overlapping deployment segments that all cover `date`;
    // without this they'd appear several times in the same shift roster.
    const seenInGroup = new Set<string>();
    for (const d of bestByGuard.values() as Iterable<any>) {
      const e = d.employees;
      if (!e) continue;
      // Relievers belong to the Relievers tab, never the workforce board.
      if (e.category === "reliever") continue;
      // employment-window gating (roster membership). A separated guard drops off
      // from their last working day onward (inclusive) — fired today = gone today.
      if (e.join_date && e.join_date > date) continue;
      if (hiddenFromAttendance(e, date)) continue;
      if (e.lifecycle_state === "archived") continue;
      if (d.start_date > date) continue;
      // Shift of THIS dated posting segment: explicit shift_code first, then the
      // posting's contract-line shift, then the guard's current shift.
      const sched = (d.shift_code ?? d.contract_lines?.shift_code ?? e.shift ?? "day") as string;
      // Group per CLIENT-shift. The site is the finer unit where sites exist, but
      // it is nullable — falling back to the client keeps two clients from
      // collapsing into one "null|<shift>" row (and one shared confirmation).
      const groupKey = (d.site_id ?? d.client_id) as string;
      const key = `${groupKey}|${sched}`;
      // One row per guard per shift-group, even with overlapping segments.
      if (seenInGroup.has(`${key}|${d.guard_id}`)) continue;
      seenInGroup.add(`${key}|${d.guard_id}`);
      let row = byKey.get(key);
      if (!row) {
        row = {
          key,
          site_id: d.site_id,
          site_name: d.sites?.name ?? "—",
          client_id: d.client_id,
          client_name: d.clients?.name ?? "—",
          client_prefix: d.clients?.employee_id_prefix ?? null,
          group_key: groupKey,
          contract_shifts: [...(shiftStrength.get(d.client_id)?.keys() ?? [])],
          shift_code: sched,
          contracted:
            contracted.get(`${d.site_id}|${sched}`) ??
            shiftStrength.get(d.client_id)?.get(sched) ??
            0,
          roster: [],
          marks: new Map(),
          confirmation: confMap.get(key) ?? null,
          branch_id: (d.clients?.branch_id as string | null) ?? null,
        };
        byKey.set(key, row);
      }
      row.roster.push({
        guard_id: d.guard_id,
        full_name: e.full_name,
        guard_code: e.guard_code,
        display_number: e.display_number,
        employee_code: e.employee_code,
        client_id: d.client_id,
        scheduled_shift: sched,
      });
      const mk = markByGuard.get(`${d.guard_id}|${sched}`);
      if (mk && mk.status !== "present") row.marks.set(d.guard_id, { status: mk.status, absent_reason: mk.absent_reason });
    }

    // A shift the contract commits to must appear even with nobody posted to it
    // yet — that empty row IS the signal that the shift is unstaffed. Rows built
    // from real postings win; this only fills the gaps. Clients with 0 across all
    // three shifts contribute nothing, which is the "no attendance" case.
    //
    // The gap row must land in the SAME group as the client's staffed rows. Where
    // a client has sites, that means a site: 68 HS has one site and staffs it by
    // day, but bills its night guards on a contract-wide line, so a client-keyed
    // night row split the client into a "68 HS" card and a second "All shifts"
    // card holding the one empty night row. Only a client with no sites at all
    // groups by shift alone.
    const clientById = new Map((cliRows ?? []).map((c: any) => [c.id, c]));
    const sitesByClient = new Map<string, { id: string; name: string }[]>();
    for (const s of (siteRows ?? []) as any[]) {
      const arr = sitesByClient.get(s.client_id) ?? [];
      arr.push({ id: s.id, name: s.name });
      sitesByClient.set(s.client_id, arr);
    }
    // Which of a client's sites bill a given shift, from their own contract
    // lines. A shift no site names is contract-wide, so it belongs to all of them.
    const siteShifts = new Map<string, Set<string>>();
    for (const l of (cls ?? []) as any[]) {
      if (!l.site_id || !l.shift_code) continue;
      const set = siteShifts.get(l.site_id) ?? new Set<string>();
      set.add(l.shift_code);
      siteShifts.set(l.site_id, set);
    }

    for (const [clientId, perShift] of shiftStrength) {
      const clientSites = sitesByClient.get(clientId) ?? [];
      for (const [shift, committed] of perShift) {
        const c = clientById.get(clientId);
        // Sites that bill this shift; none naming it means it is contract-wide.
        const named = clientSites.filter((s) => siteShifts.get(s.id)?.has(shift));
        const targets: ({ id: string; name: string } | null)[] =
          clientSites.length === 0 ? [null] : named.length > 0 ? named : clientSites;

        for (const site of targets) {
          const groupKey = site ? site.id : clientId;
          // Skip when this group already has a row on that shift — per site, so a
          // multi-site client showing night at one site still gets the empty row
          // at a site that has nobody on nights.
          const already = [...byKey.values()].some(
            (r) => r.group_key === groupKey && r.shift_code === shift,
          );
          if (already) continue;
          const key = `${groupKey}|${shift}`;
          byKey.set(key, {
            key,
            // Siteless clients keep "": it matches how the category rows mark
            // themselves, and the drill-down skips its per-site shift lookup
            // when it is falsy.
            site_id: site ? site.id : "",
            group_key: groupKey,
            contract_shifts: [...perShift.keys()],
            site_name: site ? site.name : "—",
            client_id: clientId,
            client_name: c?.name ?? "—",
            client_prefix: c?.employee_id_prefix ?? null,
            shift_code: shift,
            contracted: site ? contracted.get(`${site.id}|${shift}`) ?? committed : committed,
            roster: [],
            marks: new Map(),
            confirmation: confMap.get(`${groupKey}|${shift}`) ?? null,
            branch_id: (c?.branch_id as string | null) ?? null,
          });
        }
      }
    }

    // Non-client categories (office staff, …): no client posting, so group them
    // into synthetic (category, shift) rows. Same employment-window gating; no
    // site-based confirmation (they aren't a client-shift-day unit).
    for (const e of (staff ?? []) as any[]) {
      if (e.category === "reliever" || e.category === "client") continue;
      if (e.join_date && e.join_date > date) continue;
      if (hiddenFromAttendance(e, date)) continue;
      if (e.lifecycle_state === "archived") continue;
      const sched = (e.shift ?? "day") as string;
      const key = `cat:${e.category}|${sched}`;
      let row = byKey.get(key);
      if (!row) {
        row = {
          key,
          site_id: "",
          group_key: `cat:${e.category}`,
          contract_shifts: [],
          site_name: "—",
          client_id: `cat:${e.category}`,
          client_name: catLabel(e.category),
          client_prefix: null,
          shift_code: sched,
          contracted: 0,
          roster: [],
          marks: new Map(),
          confirmation: confMap.get(`cat:${e.category}|${sched}`) ?? null,
          synthetic: true,
          // No client, so no client branch — these are scoped per guard below.
          branch_id: null,
        };
        byKey.set(key, row);
      }
      row.roster.push({
        guard_id: e.id,
        full_name: e.full_name,
        guard_code: e.guard_code,
        display_number: e.display_number,
        employee_code: e.employee_code,
        client_id: null,
        scheduled_shift: sched,
        branch_id: (e.branch_id as string | null) ?? null,
      });
      const mk = markByGuard.get(`${e.id}|${sched}`);
      if (mk && mk.status !== "present") row.marks.set(e.id, { status: mk.status, absent_reason: mk.absent_reason });
    }

    setRows([...byKey.values()]);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);

  const rowStatus = (r: ClientShift): "awaiting" | "reported" | "confirmed" =>
    r.confirmation ? "confirmed" : r.marks.size > 0 ? "reported" : "awaiting";

  const sorted = useMemo(() => {
    const order = { awaiting: 0, reported: 1, confirmed: 2 };
    return [...rows].sort((a, b) => {
      const sa = rowStatus(a), sb = rowStatus(b);
      if (order[sa] !== order[sb]) return order[sa] - order[sb];
      if (sa === "awaiting") return b.roster.length - a.roster.length; // largest first
      return a.client_name.localeCompare(b.client_name);
    });
  }, [rows]);

  // Distinct clients present on the board, for the filter dropdown.
  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.client_id, r.client_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  // The client/group currently chosen in the filter dropdown — the scope for the
  // monthly export. null when "all" is selected (export then disabled).
  const selectedClient = useMemo(() => {
    if (clientFilter === "all") return null;
    const r = rows.find((x) => x.client_id === clientFilter);
    if (!r) return null;
    return { id: r.client_id, name: r.client_name, prefix: r.client_prefix, synthetic: !!r.synthetic };
  }, [rows, clientFilter]);

  // Rows shown = client filter, then (within it) name/code search over the roster.
  /**
   * Rows for the selected region. This board previously ignored the global
   * region selector entirely — picking ISB/RWP or Kashmir changed nothing here,
   * while every other screen narrowed.
   *
   * A client-shift's region is its CLIENT's branch: deployments carry no
   * branch_id, and the client is what a branch owns. Office-staff rows have no
   * client, so they are narrowed to the guards whose own branch matches, and
   * drop out when that leaves nobody.
   */
  const regionRows = useMemo(() => {
    if (!regionId) return sorted;
    const out: ClientShift[] = [];
    for (const r of sorted) {
      if (!r.synthetic) {
        if (r.branch_id === regionId) out.push(r);
        continue;
      }
      const roster = r.roster.filter((g) => g.branch_id === regionId);
      if (roster.length === 0) continue;
      const keep = new Set(roster.map((g) => g.guard_id));
      out.push({
        ...r,
        roster,
        marks: new Map([...r.marks].filter(([id]) => keep.has(id))),
      });
    }
    return out;
  }, [sorted, regionId]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return regionRows.filter((r) => {
      if (clientFilter !== "all" && r.client_id !== clientFilter) return false;
      if (!q) return true;
      return r.roster.some((g) =>
        g.full_name.toLowerCase().includes(q) ||
        (g.guard_code ?? "").toLowerCase().includes(q) ||
        (g.employee_code ?? "").toLowerCase().includes(q) ||
        guardDisplayCode(g, r.client_prefix).toLowerCase().includes(q),
      );
    });
  }, [regionRows, clientFilter, search]);

  /**
   * The flat client-shift rows folded into client → site → shift. The rows are
   * untouched: the drill-down still receives exactly the ClientShift it always
   * did, so marking and confirmation behave identically. This only changes how
   * they are presented.
   */
  const tree = useMemo(() => {
    const byClient = new Map<
      string,
      {
        clientId: string;
        clientName: string;
        sites: Map<string, { siteId: string; siteName: string; shifts: ClientShift[] }>;
      }
    >();
    for (const r of visibleRows) {
      const c =
        byClient.get(r.client_id) ??
        { clientId: r.client_id, clientName: r.client_name, sites: new Map() };
      const siteKey = r.site_id || "__none__";
      const site =
        c.sites.get(siteKey) ??
        {
          siteId: siteKey,
          // A siteless client-shift is still a real unit of work, so label it
          // plainly rather than inventing a site name for it.
          siteName: r.site_id ? r.site_name : "All shifts",
          shifts: [] as ClientShift[],
        };
      site.shifts.push(r);
      c.sites.set(siteKey, site);
      byClient.set(r.client_id, c);
    }
    return [...byClient.values()]
      .map((c) => ({ ...c, sites: [...c.sites.values()] }))
      .sort((a, b) => a.clientName.localeCompare(b.clientName));
  }, [visibleRows]);

  const summary = useMemo(() => {
    let confirmed = 0, onGround = 0, exceptions = 0, awaiting = 0;
    for (const r of visibleRows) {
      if (r.confirmation) confirmed++;
      if (rowStatus(r) === "awaiting") awaiting++;
      exceptions += r.marks.size;
      onGround += r.roster.length - [...r.marks.values()].filter((m) => m.status === "absent").length;
    }
    return { confirmed, total: visibleRows.length, onGround, exceptions, awaiting };
  }, [visibleRows]);

  const exceptionSummary = (r: ClientShift): string => {
    if (r.marks.size === 0) return "—";
    const counts = new Map<Status, number>();
    for (const m of r.marks.values()) counts.set(m.status, (counts.get(m.status) ?? 0) + 1);
    // Guard the label lookup — a normalized status is always valid, but never throw.
    return [...counts.entries()].map(([s, n]) => `${n} ${(STATUS_LABEL[s] ?? String(s)).toLowerCase()}`).join(", ");
  };

  const badge = (s: "awaiting" | "reported" | "confirmed") =>
    s === "confirmed" ? "bg-success-50 text-success-700 border-success-200"
      : s === "reported" ? "bg-warning-50 text-warning-800 border-warning-200"
        : "bg-slate-100 text-slate-600 border-slate-200";

  return (
    <>
      <Header
        title="Attendance"
        subtitle="Daily board by client-shift — presume present, enter only exceptions, confirm per shift"
        actions={
          <input type="date" value={date} onChange={(e) => { if (isIsoDate(e.target.value)) setDate(e.target.value); }}
            className="px-3 py-2 border border-border bg-card rounded-md text-sm text-foreground" />
        }
      />
      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" /><div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "board", label: "Daily board" },
            { value: "vacancies", label: "Vacancies", count: vacancies.length },
          ]}
        />

        {tab === "board" && (
          <>
            {/* Filter + search + Mark-All (added alongside the Phase 6 model). */}
            <div className="bg-card border border-border rounded-lg p-3 flex flex-col md:flex-row gap-2 md:items-center">
              <ThemedSelect
                value={clientFilter}
                onChange={(e) => setClientFilter(e.target.value)}
                className="px-3 py-2 border border-border bg-card rounded-md text-sm md:w-56"
              >
                <option value="all">All groups</option>
                {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </ThemedSelect>
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={clientFilter === "all" ? "Search guards by name or ID…" : "Search within this client…"}
                  className="w-full pl-10 pr-3 py-2 border border-border bg-card rounded-md text-sm text-foreground"
                />
              </div>
              {canBulk && (
                <Button size="sm" variant="secondary" onClick={() => setBulkOpen(true)}>
                  <CalendarRange className="w-4 h-4 mr-1" /> Bulk Mark by Employee
                </Button>
              )}
              {/* Exports (§8.9) — one menu at the TOP, accessible without scrolling.
                  The two PDFs cover the selected day; the monthly sheet is scoped
                  to the client chosen above + the month of the selected date. */}
              <div className="md:ml-auto">
                <ExportMenu rows={visibleRows} date={date} branding={branding} client={selectedClient} />
              </div>
            </div>

            {/* Compact summary strip — clear at a glance, minimal footprint. */}
            <div className="flex flex-wrap gap-2">
              {[
                { label: "Confirmed", value: `${summary.confirmed}/${summary.total}`, icon: CheckCircle2, tint: "text-success-600 dark:text-success-500" },
                { label: "On ground", value: summary.onGround, icon: Users, tint: "text-brand-600 dark:text-brand-500" },
                { label: "Exceptions", value: summary.exceptions, icon: AlertCircle, tint: "text-danger-600 dark:text-danger-500" },
                { label: "Awaiting", value: summary.awaiting, icon: Clock, tint: "text-warning-600 dark:text-warning-500" },
              ].map((t) => (
                <div key={t.label} className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-card">
                  <t.icon className={`w-4 h-4 shrink-0 ${t.tint}`} strokeWidth={2} />
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</span>
                  <span className="text-base font-semibold tabular-nums text-foreground">{t.value}</span>
                </div>
              ))}
            </div>

            {/* Client → site → shift. The shift row is the unit of work: opening
                one is what marks attendance, exactly as the flat list did. */}
            {loading && (
              <div className="bg-card border border-border rounded-lg px-4 py-10 text-center text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
              </div>
            )}
            {!loading && tree.length === 0 && (
              <div className="bg-card border border-border rounded-lg px-4 py-10 text-center text-sm text-muted-foreground">
                No client-shifts match the current filter/search.
              </div>
            )}

            <div className="space-y-3">
              {!loading && tree.map((c) => {
                const cOpen = openClients.has(c.clientId);
                const allShifts = c.sites.flatMap((st) => st.shifts);
                const rosterTotal = allShifts.reduce((n, r) => n + r.roster.length, 0);
                const pending = allShifts.filter((r) => rowStatus(r) !== "confirmed").length;
                return (
                  <div key={c.clientId} className="bg-card border border-border rounded-lg overflow-hidden">
                    <div className="flex items-stretch">
                    <button
                      type="button"
                      onClick={() => toggleIn(c.clientId, setOpenClients)}
                      aria-expanded={cOpen}
                      className="flex-1 min-w-0 flex items-center gap-3 px-4 py-3 text-left hover:bg-accent transition-colors"
                    >
                      <ChevronRight
                        className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${cOpen ? "rotate-90" : ""}`}
                        strokeWidth={1.75}
                      />
                      <Building2 className="w-4 h-4 shrink-0 text-brand-600 dark:text-brand-500" strokeWidth={1.5} />
                      <span className="font-medium text-foreground truncate flex-1">{c.clientName}</span>
                      <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">
                        {/* "1 site" tells nobody anything once the site level is
                            collapsed away — count the shifts they open onto. */}
                        {c.sites.length === 1
                          ? `${allShifts.length} shift${allShifts.length === 1 ? "" : "s"}`
                          : `${c.sites.length} sites`}{" "}
                        · {rosterTotal} on roster
                      </span>
                      {pending > 0 ? (
                        <span className="text-xs px-2 py-0.5 rounded-md border bg-warning-50 text-warning-800 dark:text-warning-500 border-warning-200 shrink-0">
                          {pending} to confirm
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-md border bg-success-50 text-success-700 dark:text-success-500 border-success-200 shrink-0">
                          All confirmed
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSheetView({ clientId: c.clientId, clientName: c.clientName })}
                      className="px-3 flex items-center gap-1.5 text-xs text-muted-foreground hover:bg-accent border-l border-border shrink-0"
                      title="View monthly attendance sheet"
                    >
                      <FileSpreadsheet className="w-4 h-4" strokeWidth={1.5} />
                      <span className="hidden md:inline">View attendance</span>
                    </button>
                    </div>

                    {cOpen && (
                      <div className="border-t border-border">
                        {c.sites.map((st) => {
                          const sKey = `${c.clientId}|${st.siteId}`;
                          // A client with a single site has nothing to choose
                          // between: the row just repeats the client's name and
                          // costs a second click to reach the shifts. Open
                          // straight onto them. Multi-site clients (Nova, MIU,
                          // Apex) keep the level, since there the site is a real
                          // choice.
                          const flat = c.sites.length === 1;
                          const sOpen = flat || openSites.has(sKey);
                          const sRoster = st.shifts.reduce((n, r) => n + r.roster.length, 0);
                          return (
                            <div key={sKey} className="border-b border-border last:border-0">
                              {!flat && (
                              <div className="flex items-stretch">
                              <button
                                type="button"
                                onClick={() => toggleIn(sKey, setOpenSites)}
                                aria-expanded={sOpen}
                                className="flex-1 min-w-0 flex items-center gap-2 px-4 py-2.5 pl-8 text-left hover:bg-accent transition-colors"
                              >
                                <ChevronRight
                                  className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${sOpen ? "rotate-90" : ""}`}
                                  strokeWidth={1.75}
                                />
                                <MapPin className="w-4 h-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                                <span className="text-sm text-foreground truncate flex-1">{st.siteName}</span>
                                <span className="text-xs text-muted-foreground shrink-0">
                                  {st.shifts.length} shift{st.shifts.length === 1 ? "" : "s"} · {sRoster} on roster
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setSheetView({ clientId: c.clientId, clientName: c.clientName, siteId: st.siteId, siteName: st.siteName })}
                                className="px-3 flex items-center gap-1.5 text-xs text-muted-foreground hover:bg-accent border-l border-border shrink-0"
                                title="View this site's monthly attendance sheet"
                              >
                                <FileSpreadsheet className="w-4 h-4" strokeWidth={1.5} />
                                <span className="hidden md:inline">View</span>
                              </button>
                              </div>
                              )}

                              {sOpen && (
                                <div className={`overflow-x-auto ${flat ? "" : "border-t border-border"}`}>
                                  <table className="w-full">
                                    <thead>
                                      <tr className="border-b border-border bg-slate-50">
                                        <th className={`text-left px-4 py-2 ${flat ? "pl-8" : "pl-14"} text-xs text-muted-foreground uppercase tracking-wide`}>Shift</th>
                                        <th className="text-right px-4 py-2 text-xs text-muted-foreground uppercase tracking-wide">Contracted</th>
                                        <th className="text-right px-4 py-2 text-xs text-muted-foreground uppercase tracking-wide">On roster</th>
                                        <th className="text-left px-4 py-2 text-xs text-muted-foreground uppercase tracking-wide">Exceptions</th>
                                        <th className="text-left px-4 py-2 text-xs text-muted-foreground uppercase tracking-wide">Status</th>
                                        <th className="px-4 py-2"></th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border">
                                      {st.shifts.map((r) => {
                                        const rst = rowStatus(r);
                                        return (
                                          <tr
                                            key={r.key}
                                            className="hover:bg-accent/50 cursor-pointer transition-colors"
                                            onClick={() => setDrill(r)}
                                          >
                                            <td className={`px-4 py-3 ${flat ? "pl-8" : "pl-14"} text-sm`}>
                                              <span className="capitalize inline-block px-1.5 py-0.5 rounded bg-secondary text-muted-foreground text-xs">
                                                {r.shift_code}
                                              </span>
                                            </td>
                                            <td className="px-4 py-3 text-sm text-right text-muted-foreground">{r.contracted || "—"}</td>
                                            <td className="px-4 py-3 text-sm text-right text-muted-foreground">{r.roster.length}</td>
                                            <td className="px-4 py-3 text-sm text-muted-foreground">{exceptionSummary(r)}</td>
                                            <td className="px-4 py-3">
                                              <span className={`inline-block px-2 py-0.5 rounded-md text-xs border capitalize ${badge(rst)}`}>{rst}</span>
                                              {r.confirmation && (
                                                <span className="block text-[11px] text-muted-foreground mt-0.5">
                                                  by {r.confirmation.supervisor_name}
                                                </span>
                                              )}
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                              <ChevronRight className="w-4 h-4 text-muted-foreground inline-block" />
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {tab === "vacancies" && (
          <VacancyQueue vacancies={vacancies} clientNames={clientNames} onChanged={load} />
        )}
      </div>

      {drill && (
        <ShiftDrillModal
          shift={drill}
          date={date}
          role={profile?.role ?? "hr"}
          onClose={() => setDrill(null)}
          onDone={async () => { setDrill(null); await load(); }}
          onError={setError}
        />
      )}

      {bulkOpen && (
        <BulkMarkByEmployeeModal
          onClose={() => setBulkOpen(false)}
          onSaved={load}
        />
      )}

      {sheetView && (
        <AttendanceSheetModal
          clientId={sheetView.clientId}
          clientName={sheetView.clientName}
          siteId={sheetView.siteId}
          siteName={sheetView.siteName}
          onClose={() => setSheetView(null)}
        />
      )}
    </>
  );
}

// ── Drill-in: roster with presume-present + exception marking + Confirm ───────
function ShiftDrillModal({
  shift, date, role, onClose, onDone, onError,
}: {
  shift: ClientShift; date: string; role: string;
  onClose: () => void; onDone: () => Promise<void>; onError: (m: string) => void;
}) {
  // per-guard exception (undefined = presumed present)
  const [marks, setMarks] = useState<Map<string, { status: Status; absent_reason: AbsentReason | null }>>(new Map(shift.marks));
  // §7/§8.4 worked-shift selection per guard. Options come ENTIRELY from this
  // site's shift_definitions (loaded below) — never a hardcoded or per-client
  // list. Absent from the map ⇒ default to the guard's scheduled_shift. For
  // status = double_duty the value holds MULTIPLE shifts (one attendance row
  // each, worked_shift distinct ⇒ no uniqueness conflict).
  const [siteShifts, setSiteShifts] = useState<string[]>([shift.shift_code]);
  const [worked, setWorked] = useState<Map<string, string[]>>(new Map());
  const [supervisor, setSupervisor] = useState(shift.confirmation?.supervisor_name ?? "");
  const [source, setSource] = useState<"app" | "whatsapp" | "manual">("app");
  const [saving, setSaving] = useState(false);
  const [gate, setGate] = useState<{ mode: string; reason: string | null } | null>(null);
  const [override, setOverride] = useState("");
  // View-only filter over the roster list; never touches `marks` (selections persist).
  const [rosterSearch, setRosterSearch] = useState("");
  // Inline validation for the required supervisor name — shown INSIDE the modal
  // footer (not the page-level banner, which sits behind the modal overlay).
  const [supError, setSupError] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fail = (m: string) => { setErr(m); onError(m); };

  useEffect(() => {
    // Gate the shift date using any roster guard (window-independent checks:
    // period-close / backdating apply to the whole shift-day).
    const g = shift.roster[0];
    if (!g) return;
    supabase.rpc("attendance_gate", { p_guard: g.guard_id, p_date: date })
      .then(({ data }) => setGate(data as any));
  }, [shift, date]);

  useEffect(() => {
    // The shift options for every row = this SITE's actual shift_definitions
    // (Phase 1), ordered chronologically. Data-driven: two-shift sites show two,
    // three-shift sites show three, whatever a site is configured with. The
    // rostered scheduled_shift is always included so the default stays selectable
    // even where a site's shift_definitions are not fully seeded.
    let cancelled = false;
    if (!shift.site_id) {
      // No site to read shift_definitions from, so the contract's own
      // day/night/evening split states what this client runs — and it is the
      // ONLY thing that does. The row's own shift is deliberately not merged in:
      // a guard wrongly posted to a shift the contract does not staff would
      // otherwise make that shift selectable for the whole row.
      const fromContract = shift.contract_shifts ?? [];
      setSiteShifts(fromContract.length ? fromContract : [shift.shift_code]);
      return;
    }
    supabase
      .from("shift_definitions")
      .select("shift_code, start_time")
      .eq("site_id", shift.site_id)
      .order("start_time", { ascending: true })
      .then(({ data }) => {
        if (cancelled) return;
        const codes = (data ?? []).map((r: any) => r.shift_code as string);
        const union = codes.includes(shift.shift_code) ? codes : [...codes, shift.shift_code];
        setSiteShifts(union.length ? union : [shift.shift_code]);
      });
    return () => { cancelled = true; };
  }, [shift.site_id, shift.shift_code]);

  const setMark = (id: string, status: Status | "present", reason: AbsentReason | null = null) => {
    setMarks((prev) => {
      const next = new Map(prev);
      if (status === "present") next.delete(id);
      else next.set(id, { status, absent_reason: status === "absent" ? reason : null });
      return next;
    });
    // Leaving double_duty collapses any multi-shift selection back to one.
    if (status !== "double_duty") {
      setWorked((prev) => {
        const cur = prev.get(id);
        if (!cur || cur.length <= 1) return prev;
        const next = new Map(prev);
        next.set(id, [cur[0]]);
        return next;
      });
    }
  };

  // Selected worked shift(s) for a guard; default = their scheduled shift.
  const getWorked = (g: RosterGuard): string[] => worked.get(g.guard_id) ?? [g.scheduled_shift];

  const setWorkedShift = (g: RosterGuard, code: string, multi: boolean) => {
    setWorked((prev) => {
      const next = new Map(prev);
      const cur = next.get(g.guard_id) ?? [g.scheduled_shift];
      if (!multi) {
        next.set(g.guard_id, [code]); // single-select
        return next;
      }
      // Multi-select (double duty): toggle, keep ≥1, order by siteShifts.
      const chosen = cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code];
      const ordered = siteShifts.filter((c) => (chosen.length ? chosen : [code]).includes(c));
      next.set(g.guard_id, ordered.length ? ordered : [code]);
      return next;
    });
  };

  const blocked = gate?.mode === "blocked";
  const needsOverride = gate?.mode === "override_required";

  const confirm = async () => {
    if (blocked) { fail(gate?.reason ?? "Blocked"); return; }
    if (!supervisor.trim()) { setSupError("Supervisor name is required to confirm."); return; }
    setSupError(null);
    if (needsOverride && !override.trim()) { fail("Backdated — a supervisor override reason is required."); return; }
    setSaving(true);
    setErr(null);
    try {
      // Materialise attendance per roster guard: exception status where marked,
      // else present. Each selected worked_shift becomes its own row — double
      // duty writes MULTIPLE rows (distinct worked_shift ⇒ no uniqueness clash).
      // Every row carries source / marked_by / marked_at (§8.3).
      const rows = shift.roster.flatMap((g) => {
        const mk = marks.get(g.guard_id);
        const status = mk?.status ?? "present";
        const entry_type: EntryType = status === "double_duty" ? "double_duty"
          : status === "relief_cover" ? "relief_cover"
          : "normal";
        const sel = getWorked(g);
        const workedShifts = status === "double_duty"
          ? [...new Set(sel)]                        // one row per chosen shift
          : [sel[0] ?? g.scheduled_shift];           // single worked shift
        return workedShifts.map((ws) => ({
          employee_id: g.guard_id,
          attendance_date: date,
          // Store leave under the single canonical "Leave" token (Rotation leave
          // is folded into Leave); everything else keeps its spec value.
          status: status === "rotation_leave" ? "Leave" : status,
          absent_reason: mk?.absent_reason ?? null,
          scheduled_shift: g.scheduled_shift,
          worked_shift: ws,
          entry_type,
          source,
          worked_for_client_id: g.client_id,
          marked_by_role: role,
          supervisor_override: needsOverride,
          override_reason: needsOverride ? override.trim() : null,
        }));
      });
      const { error: upErr } = await supabase
        .from("attendance_records")
        .upsert(rows, { onConflict: "employee_id,attendance_date,worked_shift" });
      if (upErr) throw upErr;
      // Confirmation keyed by group_key (0132): a client-shift keys on its site,
      // a category group (office staff, …) on 'cat:<category>' with null site.
      const groupKey = shift.group_key;
      const { error: cErr } = await supabase.from("attendance_confirmations").upsert(
        {
          group_key: groupKey,
          category: shift.synthetic ? shift.client_id.replace(/^cat:/, "") : null,
          client_id: shift.synthetic ? null : shift.client_id,
          site_id: shift.synthetic ? null : shift.site_id,
          shift_code: shift.shift_code,
          attendance_date: date, supervisor_name: supervisor.trim(), source,
        },
        { onConflict: "group_key,shift_code,attendance_date" },
      );
      if (cErr) throw cErr;
      await onDone();
    } catch (e: any) {
      fail(e.message ?? String(e));
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} size="lg"
      error={err}
      onDismissError={() => setErr(null)}
      title={`${shift.client_name} · ${shift.site_name} · ${shift.shift_code} — ${date}`}
      footer={
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <input value={supervisor}
              onChange={(e) => { setSupervisor(e.target.value); if (supError) setSupError(null); }}
              placeholder="Supervisor name *"
              aria-invalid={!!supError}
              className={`flex-1 px-3 py-2 border rounded-md text-sm ${supError ? "border-danger-300" : "border-slate-200"}`}
              disabled={blocked} />
            <ThemedSelect value={source} onChange={(e) => setSource(e.target.value as any)} className="px-2 py-2 border border-slate-200 rounded-md text-sm" >
              <option value="app">App</option><option value="whatsapp">WhatsApp</option><option value="manual">Manual</option>
            </ThemedSelect>
            <Button size="sm" onClick={confirm} disabled={saving || blocked}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Confirm shift
            </Button>
          </div>
          {supError && <p className="text-xs text-danger-600">{supError}</p>}
        </div>
      }
    >
      <div className="space-y-3">
        {blocked && (
          <div className="p-3 bg-slate-100 text-slate-600 border border-slate-200 rounded text-sm">🔒 {gate?.reason}</div>
        )}
        {needsOverride && (
          <div className="p-3 bg-warning-50 border border-warning-200 rounded text-sm space-y-2">
            <div className="text-warning-800">{gate?.reason}</div>
            <input value={override} onChange={(e) => setOverride(e.target.value)} placeholder="Supervisor override reason *"
              className="w-full px-3 py-2 border border-warning-300 rounded-md text-sm" />
          </div>
        )}
        <p className="text-xs text-slate-500">
          {shift.roster.length} on roster — all presumed <strong>present</strong>. Mark only the exceptions, then confirm.
        </p>
        <input
          type="text"
          value={rosterSearch}
          onChange={(e) => setRosterSearch(e.target.value)}
          placeholder="Search this roster by name or code (e.g. Riaz or HMC-042)…"
          className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
        />
        <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
          {shift.roster
            .filter((g) => {
              // View-only filter by name / permanent code / display code. Never
              // affects `marks` — already-set statuses persist through searching.
              const q = rosterSearch.trim().toLowerCase();
              if (!q) return true;
              return (
                g.full_name.toLowerCase().includes(q) ||
                (g.guard_code ?? "").toLowerCase().includes(q) ||
                (g.employee_code ?? "").toLowerCase().includes(q) ||
                guardDisplayCode(g, shift.client_prefix).toLowerCase().includes(q)
              );
            })
            .map((g) => {
            const mk = marks.get(g.guard_id);
            return (
              <div key={g.guard_id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-900 truncate">{g.full_name}</p>
                  <p className="text-xs text-slate-400 font-mono">{guardDisplayCode(g, shift.client_prefix)}</p>
                </div>
                <ThemedSelect
                  value={mk?.status ?? "present"}
                  onChange={(e) => {
                    const v = e.target.value as Status | "present";
                    setMark(g.guard_id, v, v === "absent" ? "awol" : null);
                  }}
                  className="px-2 py-1.5 border border-slate-200 rounded-md text-sm"
                >
                  <option value="present">Present</option>
                  {EXCEPTION_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </ThemedSelect>
                {mk?.status === "absent" && (
                  <ThemedSelect value={mk.absent_reason ?? "awol"} onChange={(e) => setMark(g.guard_id, "absent", e.target.value as AbsentReason)}
                    className="px-2 py-1.5 border border-slate-200 rounded-md text-sm">
                    <option value="awol">AWOL</option><option value="sick">Sick</option><option value="absconded">Absconded</option>
                  </ThemedSelect>
                )}
                {/* §7/§8.4 worked-shift selector — options are THIS site's actual
                    shift_definitions. Single-select normally; multi-select (any
                    number of the site's shifts) when status = double duty. */}
                {(() => {
                  const multi = (mk?.status ?? "present") === "double_duty";
                  const sel = getWorked(g);
                  return (
                    <div
                      className="flex items-center gap-1 shrink-0"
                      title={multi ? "Double duty — pick one or more shifts" : "Worked shift"}
                    >
                      {siteShifts.map((code) => {
                        const active = sel.includes(code);
                        return (
                          <button
                            key={code}
                            type="button"
                            aria-pressed={active}
                            onClick={() => setWorkedShift(g, code, multi)}
                            className={`text-xs px-2 py-1 rounded border capitalize ${active ? "bg-brand-50 border-brand-300 text-brand-700" : "border-slate-200 text-slate-400 hover:text-slate-700"}`}
                          >
                            {code}
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

// ── Vacancy queue (§8.10) ─────────────────────────────────────────────────────
function VacancyQueue({ vacancies, clientNames, onChanged }: {
  vacancies: Vacancy[]; clientNames: Map<string, string>; onChanged: () => Promise<void>;
}) {
  const close = async (id: string) => {
    await supabase.from("vacancies").update({ status: "cancelled" }).eq("id", id);
    await onChanged();
  };
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 text-sm text-muted-foreground">
        <Briefcase className="w-4 h-4" /> Open vacancies drive recruitment — the client is still contracted for that strength.
      </div>
      {vacancies.length === 0 ? (
        <div className="px-4 py-8 text-center text-muted-foreground text-sm">No open vacancies.</div>
      ) : (
        <table className="w-full">
          <tbody className="divide-y divide-border">
            {vacancies.map((v) => (
              <tr key={v.id} className="hover:bg-accent/50 transition-colors">
                <td className="px-4 py-3 text-sm font-medium text-foreground">{clientNames.get(v.client_id) ?? "—"}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{v.opened_reason}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(v.opened_at).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => close(v.id)} className="text-xs text-muted-foreground hover:text-danger-600">Dismiss</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Exports (§8.9): two templates — per-client sheet + per-guard sheet ─────────
function downloadCsv(name: string, lines: string[]) {
  // saveText is a download on the web and a share sheet in the native shell,
  // where an <a download> click does nothing at all.
  void saveText(lines.join("\n"), name);
}

type ExportClient = { id: string; name: string; prefix: string | null; synthetic: boolean };

// §8.9 (a) per-client attendance sheet — branded PDF for client submission.
function exportClientSheet(branding: PdfBranding, date: string, rows: ClientShift[]) {
  generateClientAttendancePdf(branding, date, rows.map((r) => ({
    client_name: r.client_name, site_name: r.site_name, shift_code: r.shift_code,
    contracted: r.contracted, on_roster: r.roster.length,
    status: r.confirmation ? "confirmed" : r.marks.size > 0 ? "reported" : "awaiting",
    exceptions: [...r.marks.values()].map((m) => m.status).join("; "),
    supervisor: r.confirmation?.supervisor_name ?? "",
  })));
}

// §8.9 (b) per-guard sheet — branded PDF for payroll (one row per rostered guard).
function exportGuardSheet(branding: PdfBranding, date: string, rows: ClientShift[]) {
  const gr: { full_name: string; code: string; client_name: string; site_name: string; shift_code: string; status: string }[] = [];
  for (const r of rows) {
    for (const g of r.roster) {
      gr.push({
        full_name: g.full_name, code: guardDisplayCode(g, r.client_prefix),
        client_name: r.client_name, site_name: r.site_name, shift_code: r.shift_code,
        status: r.marks.get(g.guard_id)?.status ?? "present",
      });
    }
  }
  generateGuardAttendancePdf(branding, date, gr);
}

// §8.9 (c) monthly attendance sheet — SCOPED to one selected client + one month.
// Reuses the shared exportAttendance format (identical columns to the Timesheet
// page's export); only the scope is narrowed to the chosen client + the month of
// the selected date. exportAttendance emits the same XLSX the existing monthly
// export always has — the format is preserved, only the filter changed.
async function exportClientMonth(client: ExportClient, date: string) {
  const [yStr, mStr] = date.split("-");
  const y = Number(yStr), m = Number(mStr);
  const monthStart = `${yStr}-${mStr}-01`;
  const dim = new Date(y, m, 0).getDate();
  const monthEnd = `${yStr}-${mStr}-${String(dim).padStart(2, "0")}`;
  return exportClientRange(client, monthStart, monthEnd);
}

// Enumerate every ISO date from start..end inclusive (both "YYYY-MM-DD").
function enumerateDates(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const last = new Date(ey, em - 1, ed);
  while (cur <= last) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// Client attendance sheet over an arbitrary [startDate, endDate] range. Same XLSX
// format as the monthly export; columns are one-per-date (labelled by day-of-month
// so the sheet can span a month boundary, e.g. 20 Jul → 10 Aug).
async function exportClientRange(client: ExportClient, startDate: string, endDate: string) {
  const dates = enumerateDates(startDate, endDate);
  if (dates.length === 0) return 0;
  const monthStart = startDate;
  const monthEnd = endDate;
  const dayIndex = new Map(dates.map((d, i) => [d, i]));
  const fmtLong = (iso: string) => {
    const [yy, mm, dd] = iso.split("-").map(Number);
    return new Date(yy, mm - 1, dd).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const monthLabel = startDate.slice(0, 7) === endDate.slice(0, 7)
    ? new Date(Number(startDate.slice(0, 4)), Number(startDate.slice(5, 7)) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : `${fmtLong(startDate)} – ${fmtLong(endDate)}`;

  // The selected client's employees (real client_id, or the category for a
  // synthetic office-staff group). Relievers + archived excluded, mirroring
  // the board's roster rules.
  let q = supabase
    .from("employees")
    .select("id, full_name, employee_code, guard_code, display_number, shift, contract_id, client_id, clients:client_id(employee_id_prefix)")
    .neq("category", "reliever")
    .neq("lifecycle_state", "archived");
  q = client.synthetic ? q.eq("category", client.id.replace(/^cat:/, "")) : q.eq("client_id", client.id);
  const { data: empData, error: empErr } = await q.order("full_name");
  if (empErr) throw empErr;
  const emps = (empData ?? []) as any[];
  if (emps.length === 0) return 0;
  const empIds = emps.map((e) => e.id);

  // Month's attendance for exactly those employees. worked_shift decides the
  // D/N column so a day guard who covered one night lands under N that day.
  const records = await fetchAllRows<any>(() =>
    supabase.from("attendance_records")
      .select("employee_id, attendance_date, status, worked_shift")
      .gte("attendance_date", monthStart)
      .lte("attendance_date", monthEnd)
      .in("employee_id", empIds)
      .order("attendance_date", { ascending: true }) as any,
  );
  // Keyed by column index within the range (not day-of-month, which would collide
  // across a month boundary).
  const byEmp = new Map<string, Map<number, { st: Status; ws: string }>>();
  for (const r of records ?? []) {
    const idx = dayIndex.get(String(r.attendance_date).slice(0, 10));
    if (idx === undefined) continue;
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, new Map());
    byEmp.get(r.employee_id)!.set(idx, { st: normalizeStatus(r.status), ws: (r.worked_shift as string) ?? "day" });
  }

  // Allowed leaves for the pay-day tally (contract value, client fallback).
  const contractIds = [...new Set(emps.map((e) => e.contract_id).filter(Boolean))];
  const clientIds = [...new Set(emps.map((e) => e.client_id).filter(Boolean))];
  const [{ data: conRows }, { data: cliRows }] = await Promise.all([
    contractIds.length ? supabase.from("contracts").select("id, allowed_leaves_per_month").in("id", contractIds) : Promise.resolve({ data: [] as any[] }),
    clientIds.length ? supabase.from("clients").select("id, allowed_leaves_per_month").in("id", clientIds) : Promise.resolve({ data: [] as any[] }),
  ]);
  const conById = new Map((conRows ?? []).map((c: any) => [c.id, c]));
  const cliById = new Map((cliRows ?? []).map((c: any) => [c.id, c]));

  // Per-date shift from the dated posting segments. employees.shift is only the
  // CURRENT shift, so using it for unmarked days back-dates a shift change over
  // the whole range — a guard who moved to nights on the 15th would read as
  // nights from the 1st.
  const resolveShift = await loadShiftResolver(empIds);

  const rows: AttendanceEmployeeRow[] = emps.map((emp, idx) => {
    const dayMap = byEmp.get(emp.id) ?? new Map<number, { st: Status; ws: string }>();
    const statusByDay: string[] = [];
    const shiftByDay: string[] = [];
    // Row-level shift is a fallback only (shiftByDay is always supplied); take it
    // from the first date in range rather than "now".
    const defShift: string = resolveShift(emp.id, dates[0]) || "day";
    let p = 0, a = 0, l = 0;
    for (let d = 0; d < dates.length; d += 1) {
      const cell = dayMap.get(d);
      const sym = cell ? EXPORT_SYMBOL[cell.st] : "";
      statusByDay.push(sym);
      if (sym === "P") p += 1; else if (sym === "A") a += 1; else if (sym === "L") l += 1;
      // The shift column follows the shift actually worked that day, falling back
      // to the shift the guard was rostered on for THAT date. Real shift code
      // (day/night/evening/…) — the exporter builds columns from these.
      const ws = cell?.ws ?? resolveShift(emp.id, dates[d]);
      shiftByDay.push(ws || "day");
    }
    const allowed = resolveAllowedLeaves(conById.get(emp.contract_id) ?? null, cliById.get(emp.client_id) ?? null);
    const payDays = p + Math.min(l, allowed);
    return {
      serial: idx + 1,
      name: emp.full_name,
      designation: "",
      empCode: guardDisplayCode(emp, emp.clients?.employee_id_prefix ?? client.prefix),
      shift: defShift,
      shiftByDay, statusByDay,
      presents: p, absents: a, leaves: l, payDays,
    };
  });

  exportAttendance({
    monthLabel, daysInMonth: dates.length, clientLabel: client.name, rows,
    dayLabels: dates.map((d) => Number(d.slice(8, 10))),
    fileName: `Attendance ${client.name} ${monthLabel}.xlsx`,
  });
  return rows.length;
}

// One tidy dropdown gathering all three exports (§8.9). A single "Export" trigger
// opens a menu with the two day-scoped PDFs and the client-scoped monthly sheet.
function ExportMenu({ rows, date, branding, client }: {
  rows: ClientShift[]; date: string; branding: PdfBranding; client: ExportClient | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rangeMode, setRangeMode] = useState(false);
  const monthKey = date.slice(0, 7);
  const monthStart = `${monthKey}-01`;
  const [rangeStart, setRangeStart] = useState(monthStart);
  const [rangeEnd, setRangeEnd] = useState(date);
  const prettyDate = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const monthLabel = new Date(`${monthKey}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const runMonthly = async () => {
    if (!client) return;
    setOpen(false);
    setBusy(true);
    try {
      const n = await exportClientMonth(client, date);
      if (n === 0) alert(`No employees found for ${client.name}.`);
    } catch (err: any) {
      alert(`Export failed: ${err?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const runRange = async () => {
    if (!client) return;
    if (rangeEnd < rangeStart) { alert("End date must be on or after the start date."); return; }
    setOpen(false);
    setRangeMode(false);
    setBusy(true);
    try {
      const n = await exportClientRange(client, rangeStart, rangeEnd);
      if (n === 0) alert(`No employees found for ${client.name}.`);
    } catch (err: any) {
      alert(`Export failed: ${err?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const Item = ({ icon: Icon, tint, title, subtitle, onClick, disabled, keepOpen }: {
    icon: typeof FileText; tint: string; title: string; subtitle: string;
    onClick: () => void; disabled?: boolean; keepOpen?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => { if (disabled) return; if (!keepOpen) setOpen(false); onClick(); }}
      className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors ${disabled ? "cursor-not-allowed opacity-45" : "hover:bg-accent"}`}
    >
      <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tint}`}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
      </span>
    </button>
  );

  return (
    <div className="relative">
      <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} disabled={busy}>
        {busy
          ? <Loader className="w-4 h-4 mr-1.5 animate-spin" />
          : <Download className="w-4 h-4 mr-1.5" />}
        {busy ? "Exporting…" : "Export"}
        <ChevronDown className={`w-3.5 h-3.5 ml-1.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </Button>

      {open && (
        <>
          <button className="fixed inset-0 z-40 cursor-default" aria-hidden onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 origin-top-right overflow-hidden rounded-xl border border-border bg-card shadow-xl ring-1 ring-black/5">
            <div className="px-3 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Selected day · {prettyDate}
            </div>
            <Item
              icon={FileText} tint="bg-brand-50 text-brand-600"
              title="Client attendance sheet"
              subtitle="Branded PDF for client submission"
              onClick={() => exportClientSheet(branding, date, rows)}
            />
            <Item
              icon={Users} tint="bg-violet-50 text-violet-600"
              title="Per-guard payroll sheet"
              subtitle="One row per rostered guard · PDF"
              onClick={() => exportGuardSheet(branding, date, rows)}
            />
            <div className="my-1 border-t border-border" />
            <div className="px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Full month · {monthLabel}
            </div>
            <Item
              icon={FileSpreadsheet} tint="bg-success-50 text-success-700"
              title="Client month sheet"
              subtitle={client ? `${client.name} · Excel (.xlsx)` : "Pick a client in the filter first"}
              onClick={runMonthly}
              disabled={!client}
            />
            <div className="my-1 border-t border-border" />
            <div className="px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Custom date range
            </div>
            {!rangeMode ? (
              <Item
                icon={CalendarRange} tint="bg-amber-50 text-amber-600"
                title="Pick a date range"
                subtitle={client ? `${client.name} · Excel (.xlsx)` : "Pick a client in the filter first"}
                onClick={() => setRangeMode(true)}
                disabled={!client}
                keepOpen
              />
            ) : (
              <div className="px-3 py-2.5 space-y-2" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-2">
                  <label className="w-10 text-xs text-muted-foreground">From</label>
                  <input
                    type="date" value={rangeStart} max={rangeEnd}
                    onChange={(e) => { if (isIsoDate(e.target.value)) setRangeStart(e.target.value); }}
                    className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="w-10 text-xs text-muted-foreground">To</label>
                  <input
                    type="date" value={rangeEnd} min={rangeStart}
                    onChange={(e) => { if (isIsoDate(e.target.value)) setRangeEnd(e.target.value); }}
                    className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-0.5">
                  <Button size="sm" variant="ghost" onClick={() => setRangeMode(false)}>Cancel</Button>
                  <Button size="sm" onClick={runRange} disabled={!client}>Export</Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
