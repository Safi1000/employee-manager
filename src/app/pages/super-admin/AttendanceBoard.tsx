import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, X, ChevronRight, ChevronLeft, CheckCircle2, Clock, Download, Briefcase, CalendarRange, Search, ChevronDown, FileText, Users, FileSpreadsheet, Loader } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import Tabs from "../../components/Tabs";
import ThemedSelect from "../../components/ThemedSelect";
import { supabase, fetchAllRows, resolveAllowedLeaves } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { guardDisplayCode } from "../../lib/guardCode";
import { brandingFromCompany, type PdfBranding } from "../../lib/pdfBranding";
import { generateClientAttendancePdf, generateGuardAttendancePdf } from "../../lib/attendanceSheetPdf";
import { exportAttendance, type AttendanceEmployeeRow } from "../../lib/excel";

// ── Phase 6: Attendance board by client-shift (§8.1-8.10) ─────────────────────
// Unit of work = client-shift-day. Presume present; operator enters only
// exceptions, then confirms the client-shift with the supervisor's name.

type Status = "present" | "absent" | "rotation_leave" | "rest_day" | "double_duty" | "relief_cover" | "blocked";
type AbsentReason = "awol" | "sick" | "absconded";
type EntryType = "normal" | "swap" | "double_duty" | "relief_cover";

const STATUS_LABEL: Record<Status, string> = {
  present: "Present",
  absent: "Absent",
  rotation_leave: "Rotation leave",
  rest_day: "Rest day",
  double_duty: "Double duty",
  relief_cover: "Relief cover",
  blocked: "Blocked",
};
const EXCEPTION_STATUSES: Status[] = ["absent", "rotation_leave", "rest_day", "double_duty", "relief_cover"];

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
// Statuses offered by the bulk-by-employee action bar. double_duty / relief_cover
// are intentionally excluded — they need shift / cover-attribution context that a
// blanket month-calendar mark can't supply (use the per-shift drill-in for those).
const BULK_STATUSES: { status: Status; label: string; btn: string }[] = [
  { status: "present", label: "Mark Present", btn: "bg-success-600 hover:bg-success-700" },
  { status: "absent", label: "Mark Absent", btn: "bg-danger-600 hover:bg-danger-700" },
  { status: "rotation_leave", label: "Rotation Leave", btn: "bg-warning-500 hover:bg-warning-600" },
  { status: "rest_day", label: "Rest Day", btn: "bg-brand-600 hover:bg-brand-700" },
  { status: "blocked", label: "Blocked", btn: "bg-slate-500 hover:bg-slate-600" },
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

type RosterGuard = {
  guard_id: string;
  full_name: string;
  guard_code: string | null;
  display_number: number | null;
  employee_code: string;
  client_id: string | null; // null for non-client categories (office staff, …)
  scheduled_shift: string;
};

type ClientShift = {
  key: string;
  site_id: string;
  site_name: string;
  client_id: string;
  client_name: string;
  client_prefix: string | null;
  shift_code: string;
  contracted: number;
  roster: RosterGuard[];
  // existing attendance rows for this shift-day (exceptions already entered)
  marks: Map<string, { status: Status; absent_reason: AbsentReason | null }>;
  confirmation: { supervisor_name: string; confirmed_at: string } | null;
  // A synthetic (category, shift) group for a non-client category with no client
  // site — marked like any row, but with no site-based confirmation.
  synthetic?: boolean;
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
  const branding = brandingFromCompany(company);
  const [date, setDate] = useState(today());
  const [tab, setTab] = useState<"board" | "vacancies">("board");
  const [rows, setRows] = useState<ClientShift[]>([]);
  const [vacancies, setVacancies] = useState<Vacancy[]>([]);
  const [clientNames, setClientNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<ClientShift | null>(null);
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
    const [{ data: deps, error: depErr }, { data: cls }, { data: confs }, { data: att }, { data: cliRows }, { data: vac }, { data: staff }] =
      await Promise.all([
        supabase
          .from("deployments")
          .select(
            "guard_id, site_id, client_id, contract_line_id, shift_code, start_date, end_date, " +
              "employees:guard_id(full_name, guard_code, display_number, employee_code, shift, category, join_date, last_working_day, lifecycle_state), " +
              "sites:site_id(name), clients:client_id(name, employee_id_prefix), contract_lines:contract_line_id(shift_code)",
          )
          // The posting whose DATED segment contains the viewed date — not just
          // the current one. So a separated guard drops off from the day after
          // their last working day, and a shift change shows the OLD shift for
          // old dates / the NEW shift from the change date (history never moves).
          .lte("start_date", date)
          .or(`end_date.is.null,end_date.gte.${date}`),
        supabase.from("contract_lines").select("site_id, shift_code, billed_qty").not("site_id", "is", null),
        supabase.from("attendance_confirmations").select("*").eq("attendance_date", date),
        supabase.from("attendance_records").select("employee_id, status, absent_reason, worked_shift, site_id:worked_for_client_id").eq("attendance_date", date),
        supabase.from("clients").select("id, name"),
        supabase.from("vacancies").select("*").eq("status", "open").order("opened_at", { ascending: false }),
        // Non-client categories (office staff + any future category) have no
        // client posting; load them directly so they appear on the board too.
        // Relievers are EXCLUDED — they live on the Relievers tab.
        supabase
          .from("employees")
          .select("id, full_name, guard_code, display_number, employee_code, shift, category, join_date, last_working_day, lifecycle_state")
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

    // Build client-shift rows from active deployments, applying the §8.6 window.
    const byKey = new Map<string, ClientShift>();
    for (const d of (deps ?? []) as any[]) {
      const e = d.employees;
      if (!e) continue;
      // Relievers belong to the Relievers tab, never the workforce board.
      if (e.category === "reliever") continue;
      // employment-window gating (roster membership)
      if (e.join_date && e.join_date > date) continue;
      if (e.last_working_day && e.last_working_day < date) continue;
      if (e.lifecycle_state === "archived") continue;
      if (d.start_date > date) continue;
      // Shift of THIS dated posting segment: explicit shift_code first, then the
      // posting's contract-line shift, then the guard's current shift.
      const sched = (d.shift_code ?? d.contract_lines?.shift_code ?? e.shift ?? "day") as string;
      const key = `${d.site_id}|${sched}`;
      let row = byKey.get(key);
      if (!row) {
        row = {
          key,
          site_id: d.site_id,
          site_name: d.sites?.name ?? "—",
          client_id: d.client_id,
          client_name: d.clients?.name ?? "—",
          client_prefix: d.clients?.employee_id_prefix ?? null,
          shift_code: sched,
          contracted: contracted.get(key) ?? 0,
          roster: [],
          marks: new Map(),
          confirmation: confMap.get(key) ?? null,
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

    // Non-client categories (office staff, …): no client posting, so group them
    // into synthetic (category, shift) rows. Same employment-window gating; no
    // site-based confirmation (they aren't a client-shift-day unit).
    for (const e of (staff ?? []) as any[]) {
      if (e.category === "reliever" || e.category === "client") continue;
      if (e.join_date && e.join_date > date) continue;
      if (e.last_working_day && e.last_working_day < date) continue;
      if (e.lifecycle_state === "archived") continue;
      const sched = (e.shift ?? "day") as string;
      const key = `cat:${e.category}|${sched}`;
      let row = byKey.get(key);
      if (!row) {
        row = {
          key,
          site_id: "",
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
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sorted.filter((r) => {
      if (clientFilter !== "all" && r.client_id !== clientFilter) return false;
      if (!q) return true;
      return r.roster.some((g) =>
        g.full_name.toLowerCase().includes(q) ||
        (g.guard_code ?? "").toLowerCase().includes(q) ||
        (g.employee_code ?? "").toLowerCase().includes(q) ||
        guardDisplayCode(g, r.client_prefix).toLowerCase().includes(q),
      );
    });
  }, [sorted, clientFilter, search]);

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
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
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

            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-slate-50">
                      <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Client · site · shift</th>
                      <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Contracted</th>
                      <th className="text-right px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">On roster</th>
                      <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Exceptions</th>
                      <th className="text-left px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Status</th>
                      <th className="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {loading && <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…</td></tr>}
                    {!loading && visibleRows.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground text-sm">No client-shifts match the current filter/search.</td></tr>}
                    {!loading && visibleRows.map((r) => {
                      const st = rowStatus(r);
                      return (
                        <tr key={r.key} className="hover:bg-accent/50 cursor-pointer transition-colors" onClick={() => setDrill(r)}>
                          <td className="px-4 py-3 text-sm">
                            <span className="font-medium text-foreground">{r.client_name}</span>
                            <span className="text-muted-foreground"> · {r.site_name} · </span>
                            <span className="capitalize inline-block px-1.5 py-0.5 rounded bg-secondary text-muted-foreground text-xs">{r.shift_code}</span>
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-muted-foreground">{r.contracted || "—"}</td>
                          <td className="px-4 py-3 text-sm text-right text-muted-foreground">{r.roster.length}</td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">{exceptionSummary(r)}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-block px-2 py-0.5 rounded-md text-xs border capitalize ${badge(st)}`}>{st}</span>
                            {r.confirmation && <span className="block text-[11px] text-muted-foreground mt-0.5">by {r.confirmation.supervisor_name}</span>}
                          </td>
                          <td className="px-4 py-3 text-right"><ChevronRight className="w-4 h-4 text-muted-foreground inline-block" /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
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
    if (blocked) { onError(gate?.reason ?? "Blocked"); return; }
    if (!supervisor.trim()) { setSupError("Supervisor name is required to confirm."); return; }
    setSupError(null);
    if (needsOverride && !override.trim()) { onError("Backdated — a supervisor override reason is required."); return; }
    setSaving(true);
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
          status,
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
      const groupKey = shift.synthetic ? shift.client_id : shift.site_id;
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
      onError(e.message ?? String(e));
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} size="lg"
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

// ── Bulk Mark by Employee (calendar) ─────────────────────────────────────────
// Mirrors the Relievers-tab "Bulk Mark by Employee" UX (pick ONE employee → month
// calendar → drag-select days → apply a status), but writes through the Phase 6
// model (status / source / marked_by_user_id / marked_at / worked_shift) and
// enforces §8.5 employment-window gating via attendance_gate: out-of-window /
// archived / period-closed / backdated days are skipped, never force-marked.
type BulkEmp = {
  id: string;
  full_name: string;
  guard_code: string | null;
  display_number: number | null;
  employee_code: string;
  client_id: string | null;
  client_name: string | null;
  client_prefix: string | null;
  shift: "day" | "night";
  join_date: string | null;
  last_working_day: string | null;
  lifecycle_state: string | null;
  category: string;
};

function BulkMarkByEmployeeModal({ onClose, onSaved }: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { profile } = useAuth();
  const [employees, setEmployees] = useState<BulkEmp[]>([]);
  const [loadingEmps, setLoadingEmps] = useState(true);
  const [search, setSearch] = useState("");
  // Client / group filter — mirrors the Relievers-board filter above.
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [empId, setEmpId] = useState("");
  const [month, setMonth] = useState(today().slice(0, 7));
  const [existing, setExisting] = useState<Map<string, Status>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingMonth, setLoadingMonth] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Supervisor override reason for backdated days (same rule as the Relievers tab):
  // days older than the backdate limit are written only when this is filled in.
  const [overrideReason, setOverrideReason] = useState("");
  // Gallery-style range drag: anchor + pre-drag snapshot, recomputed on each move.
  const [dragMode, setDragMode] = useState<"add" | "remove" | null>(null);
  const [dragAnchor, setDragAnchor] = useState<string | null>(null);
  const [dragBase, setDragBase] = useState<Set<string>>(new Set());

  const emp = useMemo(() => employees.find((e) => e.id === empId) ?? null, [employees, empId]);

  useEffect(() => {
    (async () => {
      setLoadingEmps(true);
      const { data, error } = await supabase
        .from("employees")
        .select(
          "id, full_name, guard_code, display_number, employee_code, client_id, shift, " +
            "join_date, last_working_day, lifecycle_state, category, clients:client_id(name, employee_id_prefix)",
        )
        .neq("category", "reliever")
        .order("full_name");
      if (error) { setBulkError(error.message); setLoadingEmps(false); return; }
      setEmployees((data ?? []).map((e: any) => ({
        id: e.id, full_name: e.full_name, guard_code: e.guard_code, display_number: e.display_number,
        employee_code: e.employee_code, client_id: e.client_id, client_name: e.clients?.name ?? null,
        client_prefix: e.clients?.employee_id_prefix ?? null, shift: (e.shift ?? "day") as "day" | "night",
        join_date: e.join_date, last_working_day: e.last_working_day, lifecycle_state: e.lifecycle_state,
        category: e.category,
      })));
      setLoadingEmps(false);
    })();
  }, []);

  // Client / group options for the filter: each distinct client, plus non-client
  // categories (office staff, …) as "cat:<category>" — same grouping as the board.
  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees) {
      if (e.client_id) m.set(e.client_id, e.client_name ?? "—");
      else m.set(`cat:${e.category}`, catLabel(e.category));
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [employees]);

  const options = useMemo(() => {
    const q = search.trim().toLowerCase();
    let pool = employees;
    if (clientFilter !== "all") {
      pool = clientFilter.startsWith("cat:")
        ? pool.filter((e) => !e.client_id && `cat:${e.category}` === clientFilter)
        : pool.filter((e) => e.client_id === clientFilter);
    }
    if (q) pool = pool.filter((e) =>
      e.full_name.toLowerCase().includes(q) ||
      e.employee_code.toLowerCase().includes(q) ||
      (e.guard_code ?? "").toLowerCase().includes(q) ||
      guardDisplayCode(e, e.client_prefix).toLowerCase().includes(q) ||
      (e.client_name?.toLowerCase().includes(q) ?? false));
    return pool.slice(0, 100);
  }, [employees, search, clientFilter]);

  const loadMonth = async (employeeId: string, monthKey: string) => {
    setLoadingMonth(true);
    const start = `${monthKey}-01`;
    const [y, m] = monthKey.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const end = `${monthKey}-${String(lastDay).padStart(2, "0")}`;
    const { data, error } = await supabase
      .from("attendance_records")
      .select("attendance_date, status")
      .eq("employee_id", employeeId)
      .gte("attendance_date", start)
      .lte("attendance_date", end);
    if (error) setBulkError(error.message);
    const map = new Map<string, Status>();
    for (const r of (data ?? []) as any[]) map.set(r.attendance_date, normalizeStatus(r.status));
    setExisting(map);
    setLoadingMonth(false);
  };

  useEffect(() => {
    if (!empId) return;
    setSelected(new Set());
    setNotice(null);
    loadMonth(empId, month);
    // eslint-disable-next-line
  }, [empId, month]);

  const cells = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const first = new Date(y, m - 1, 1);
    const lastDay = new Date(y, m, 0).getDate();
    const leading = first.getDay();
    const out: { date: string | null; day: number | null }[] = [];
    for (let i = 0; i < leading; i++) out.push({ date: null, day: null });
    for (let d = 1; d <= lastDay; d++) out.push({ date: `${month}-${String(d).padStart(2, "0")}`, day: d });
    while (out.length % 7 !== 0) out.push({ date: null, day: null });
    return out;
  }, [month]);

  const orderedDates = useMemo(() => cells.filter((c) => c.date).map((c) => c.date as string), [cells]);
  const dateIndex = useMemo(() => {
    const m = new Map<string, number>();
    orderedDates.forEach((d, i) => m.set(d, i));
    return m;
  }, [orderedDates]);

  // §8.5: only days inside the guard's employment window are selectable.
  // (period-close / backdate blocks are enforced additionally at apply time.)
  const inWindow = (d: string): boolean => {
    if (!emp) return false;
    if (emp.lifecycle_state === "archived") return false;
    if (emp.join_date && d < emp.join_date) return false;
    if (emp.last_working_day && d > emp.last_working_day) return false;
    return true;
  };

  const shiftMonth = (delta: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const applyRange = (base: Set<string>, from: string, to: string, mode: "add" | "remove"): Set<string> => {
    const a = dateIndex.get(from), b = dateIndex.get(to);
    if (a == null || b == null) return base;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const next = new Set(base);
    for (let i = lo; i <= hi; i++) {
      const d = orderedDates[i];
      if (!inWindow(d)) continue; // never select out-of-window days
      if (mode === "add") next.add(d); else next.delete(d);
    }
    return next;
  };
  const startDrag = (date: string) => {
    if (!inWindow(date)) return;
    const mode: "add" | "remove" = selected.has(date) ? "remove" : "add";
    const base = new Set(selected);
    setDragMode(mode); setDragAnchor(date); setDragBase(base);
    setSelected(applyRange(base, date, date, mode));
  };
  const extendDrag = (date: string) => {
    if (!dragMode || !dragAnchor) return;
    setSelected(applyRange(dragBase, dragAnchor, date, dragMode));
  };
  const endDrag = () => { setDragMode(null); setDragAnchor(null); };

  const applyStatus = async (status: Status) => {
    if (!emp || selected.size === 0) return;
    setSubmitting(true); setBulkError(null); setNotice(null);
    const days = [...selected].filter(inWindow);
    // §8.5 gate every day. 'allowed' / 'allowed_unposted' write normally;
    // 'override_required' (backdated) writes only with a supervisor override reason
    // (same as the Relievers tab); 'blocked' (period-close / archived / window) is
    // always skipped.
    const gates = await Promise.all(days.map((d) =>
      supabase.rpc("attendance_gate", { p_guard: emp.id, p_date: d })
        .then(({ data }) => ({ d, mode: (data as { mode?: string } | null)?.mode ?? "blocked" }))));
    const allowedDays = gates.filter((x) => x.mode === "allowed" || x.mode === "allowed_unposted").map((x) => x.d);
    const overrideDays = gates.filter((x) => x.mode === "override_required").map((x) => x.d);
    const blockedCount = gates.filter((x) => x.mode === "blocked").length;

    // Backdated days need a reason before they can be written.
    if (overrideDays.length > 0 && !overrideReason.trim()) {
      setSubmitting(false);
      setBulkError(`${overrideDays.length} of ${days.length} selected day(s) are backdated beyond the limit. Enter a supervisor override reason below to include them, or deselect those days.`);
      return;
    }
    const overrideSet = new Set(overrideDays);
    const toWrite = [...allowedDays, ...(overrideReason.trim() ? overrideDays : [])];
    if (toWrite.length === 0) {
      setSubmitting(false);
      setBulkError(`Nothing written — all ${days.length} selected day(s) are blocked (closed payroll period, archived, or out of employment window).`);
      return;
    }
    const nowIso = new Date().toISOString();
    const shift = emp.shift ?? "day";
    const rows = toWrite.map((d) => ({
      employee_id: emp.id,
      attendance_date: d,
      status,
      absent_reason: status === "absent" ? "awol" : null,
      scheduled_shift: shift,
      worked_shift: shift,
      entry_type: "normal",
      source: "manual",
      worked_for_client_id: emp.client_id,
      marked_by_role: profile?.role ?? "hr",
      marked_by_user_id: profile?.id ?? null,
      marked_at: nowIso,
      supervisor_override: overrideSet.has(d),
      override_reason: overrideSet.has(d) ? overrideReason.trim() : null,
    }));
    const { error } = await supabase
      .from("attendance_records")
      .upsert(rows, { onConflict: "employee_id,attendance_date,worked_shift" });
    setSubmitting(false);
    if (error) { setBulkError(error.message); return; }
    const overrodeCount = overrideReason.trim() ? overrideDays.length : 0;
    setNotice(
      `Marked ${toWrite.length} day(s) ${STATUS_LABEL[status].toLowerCase()}` +
      (overrodeCount ? ` (${overrodeCount} backdated via override)` : "") +
      (blockedCount ? ` · skipped ${blockedCount} blocked / out-of-window` : "") + ".",
    );
    setOverrideReason("");
    await loadMonth(emp.id, month);
    setSelected(new Set());
    await onSaved();
  };

  return (
    <Modal isOpen onClose={onClose} size="lg" title="Bulk Mark by Employee">
      <div className="space-y-4">
        {bulkError && (
          <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2 rounded">{bulkError}</div>
        )}
        {notice && (
          <div className="text-sm text-success-700 bg-success-50 border border-success-200 px-3 py-2 rounded">{notice}</div>
        )}

        {/* Employee picker */}
        <div>
          <label className="block text-xs uppercase tracking-wider text-slate-500 mb-2">Employee</label>
          {emp ? (
            <div className="flex items-center justify-between gap-3 p-3 border border-slate-200 rounded-md bg-slate-50">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-900 truncate">{emp.full_name}</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium border capitalize ${emp.shift === "day" ? "bg-warning-50 text-warning-700 border-warning-200" : "bg-info-50 text-info-700 border-info-200"}`} title="Guard's default shift">{emp.shift} shift</span>
                </div>
                <div className="text-xs text-slate-500 font-mono">
                  {guardDisplayCode(emp, emp.client_prefix)}{emp.client_name && ` · ${emp.client_name}`}
                </div>
              </div>
              <button type="button" onClick={() => { setEmpId(""); setSelected(new Set()); }} className="text-xs text-slate-500 hover:text-slate-900 underline">Change</button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-col sm:flex-row gap-2">
                <ThemedSelect
                  value={clientFilter}
                  onChange={(e) => setClientFilter(e.target.value)}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm sm:w-56"
                >
                  <option value="all">All groups</option>
                  {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </ThemedSelect>
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
                  <input autoFocus type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={clientFilter === "all" ? "Search name, code or client…" : "Search within this group…"}
                    className="w-full pl-10 pr-3 py-2 border border-slate-200 rounded-md text-sm" />
                </div>
              </div>
              <div className="max-h-44 overflow-y-auto border border-slate-200 rounded-md">
                {loadingEmps ? (
                  <div className="px-3 py-2 text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>
                ) : options.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-slate-500">No matches.</div>
                ) : (
                  options.map((e) => (
                    <button type="button" key={e.id} onClick={() => setEmpId(e.id)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-b-0">
                      <div className="text-slate-900">{e.full_name}</div>
                      <div className="text-xs text-slate-500 font-mono">
                        {guardDisplayCode(e, e.client_prefix)}{e.client_name && ` · ${e.client_name}`}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {emp && (
          <>
            {/* Month nav */}
            <div className="flex items-center justify-between">
              <button type="button" onClick={() => shiftMonth(-1)} className="p-2 rounded hover:bg-slate-100 text-slate-700"><ChevronLeft className="w-4 h-4" /></button>
              <div className="text-sm text-slate-900">{new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</div>
              <button type="button" onClick={() => shiftMonth(1)} className="p-2 rounded hover:bg-slate-100 text-slate-700"><ChevronRight className="w-4 h-4" /></button>
            </div>

            {/* Selection helpers */}
            <div className="flex flex-wrap gap-2 text-xs">
              <button type="button" onClick={() => { const s = new Set<string>(); for (const c of cells) if (c.date && inWindow(c.date)) s.add(c.date); setSelected(s); }} className="px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50">Select month</button>
              <button type="button" onClick={() => { const s = new Set<string>(); for (const c of cells) { if (!c.date || !inWindow(c.date)) continue; const dow = new Date(`${c.date}T00:00:00`).getDay(); if (dow !== 0 && dow !== 6) s.add(c.date); } setSelected(s); }} className="px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50">Weekdays only</button>
              <button type="button" onClick={() => setSelected(new Set())} className="px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50">Clear selection</button>
              <span className="ml-auto text-slate-500 self-center">{selected.size} day{selected.size === 1 ? "" : "s"} selected</span>
            </div>

            {/* Calendar grid */}
            <div className="select-none" onMouseUp={endDrag} onMouseLeave={endDrag}>
              <div className="grid grid-cols-7 gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground mb-1.5">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="text-center py-1">{d}</div>)}
              </div>
              {loadingMonth ? (
                <div className="flex items-center gap-2 text-muted-foreground py-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
              ) : (
                <div className="grid grid-cols-7 gap-1.5">
                  {cells.map((c, i) => {
                    if (!c.date) return <div key={i} className="h-14 rounded-lg bg-muted/40" />;
                    const win = inWindow(c.date);
                    const status = existing.get(c.date);
                    const sel = selected.has(c.date);
                    const cellClass = !win
                      ? "bg-slate-100 text-slate-300 border-slate-200 cursor-not-allowed"
                      : status ? STATUS_CELL_CLASS[status] : "bg-card text-foreground border-border hover:border-brand-500/50";
                    const ring = sel ? "ring-2 ring-brand-500 ring-offset-2 ring-offset-card border-brand-500" : "";
                    return (
                      <button key={c.date} type="button" disabled={!win}
                        onMouseDown={(e) => { e.preventDefault(); startDrag(c.date!); }}
                        onMouseEnter={() => extendDrag(c.date!)}
                        className={`h-14 rounded-lg border p-1.5 flex flex-col justify-between text-left transition-all ${cellClass} ${ring}`}
                        title={!win ? "Outside employment window" : status ? `Currently: ${STATUS_LABEL[status]}` : "Unmarked"}>
                        <span className="text-xs font-medium tabular-nums">{c.day}</span>
                        {win && status && <div className="text-[9px] font-bold uppercase tracking-wider self-end">{STATUS_SHORT[status]}</div>}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground mt-2.5">
                Tap a date to toggle, or press and drag to select a range. Greyed days are outside the guard's employment window and can't be marked.
              </p>
            </div>

            {/* Supervisor override for backdated days (older than the 3-day limit). */}
            <div className="pt-2">
              <label className="block text-xs text-slate-500 mb-1">
                Supervisor override reason <span className="text-slate-400">(only needed to mark days older than 3 days)</span>
              </label>
              <input
                type="text"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="e.g. Late WhatsApp report — approved by supervisor"
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>

            {/* Action buttons — Phase 6 write path (status/source/marked_by/marked_at). */}
            <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200">
              {BULK_STATUSES.map((b) => (
                <button key={b.status} type="button" onClick={() => applyStatus(b.status)}
                  disabled={submitting || selected.size === 0}
                  className={`flex-1 min-w-[110px] px-3 py-2 rounded-md text-sm text-[#fff] disabled:opacity-50 disabled:cursor-not-allowed ${b.btn}`}>
                  {b.label}
                </button>
              ))}
              {submitting && (
                <span className="self-center text-xs text-slate-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Saving…</span>
              )}
            </div>
          </>
        )}
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
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
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
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

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

  // Month's attendance for exactly those employees.
  const records = await fetchAllRows<any>(() =>
    supabase.from("attendance_records")
      .select("employee_id, attendance_date, status")
      .gte("attendance_date", monthStart)
      .lte("attendance_date", monthEnd)
      .in("employee_id", empIds)
      .order("attendance_date", { ascending: true }) as any,
  );
  const byEmp = new Map<string, Map<number, Status>>();
  for (const r of records ?? []) {
    const day = Number(String(r.attendance_date).slice(8, 10));
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, new Map());
    byEmp.get(r.employee_id)!.set(day, normalizeStatus(r.status));
  }

  // Per-day D/N override so a swapped day lands in the correct column.
  const ovrByEmp = new Map<string, Map<number, "day" | "night">>();
  const { data: ovrData } = await supabase
    .from("attendance_shift_overrides")
    .select("employee_id, attendance_date, override_shift")
    .gte("attendance_date", monthStart)
    .lte("attendance_date", monthEnd)
    .in("employee_id", empIds);
  for (const r of (ovrData ?? []) as any[]) {
    const day = Number(String(r.attendance_date).slice(8, 10));
    if (!ovrByEmp.has(r.employee_id)) ovrByEmp.set(r.employee_id, new Map());
    ovrByEmp.get(r.employee_id)!.set(day, r.override_shift);
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

  const rows: AttendanceEmployeeRow[] = emps.map((emp, idx) => {
    const dayMap = byEmp.get(emp.id) ?? new Map<number, Status>();
    const ovrMap = ovrByEmp.get(emp.id) ?? new Map<number, "day" | "night">();
    const statusByDay: string[] = [];
    const shiftByDay: ("day" | "night")[] = [];
    const defShift: "day" | "night" = emp.shift === "night" ? "night" : "day";
    let p = 0, a = 0, l = 0;
    for (let d = 1; d <= dim; d += 1) {
      const s = dayMap.get(d);
      const sym = s ? EXPORT_SYMBOL[s] : "";
      statusByDay.push(sym);
      if (sym === "P") p += 1; else if (sym === "A") a += 1; else if (sym === "L") l += 1;
      shiftByDay.push(ovrMap.get(d) ?? defShift);
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
    monthLabel, daysInMonth: dim, clientLabel: client.name, rows,
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
  const monthKey = date.slice(0, 7);
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

  const Item = ({ icon: Icon, tint, title, subtitle, onClick, disabled }: {
    icon: typeof FileText; tint: string; title: string; subtitle: string;
    onClick: () => void; disabled?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => { if (disabled) return; setOpen(false); onClick(); }}
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
          </div>
        </>
      )}
    </div>
  );
}
