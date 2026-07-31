import { useEffect, useMemo, useState } from "react";
import { Loader2, ChevronLeft, ChevronRight, Search } from "lucide-react";
import Modal from "./Modal";
import ClientFilterSelect from "./ClientFilterSelect";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { guardDisplayCode } from "../lib/guardCode";
import { attendanceWindowError } from "../lib/employmentWindow";
import { loadShiftResolver, type ShiftResolver } from "../lib/shiftOnDate";

// ── Shared "Bulk Mark by Employee" calendar ──────────────────────────────────
// Single source of truth used by BOTH the Attendance board and the Attendance
// Timesheet (corrections) page, so the two never diverge. Pick ONE employee →
// month calendar → per-date contract shift chips (D·N·E) → status → mark / clear.
// Writes through the Phase-6 model (status / worked_shift / marked_by / marked_at)
// with §8.5 gating (attendance_gate: out-of-window / archived / period-closed /
// backdated), no future marking, and double-duty multi-shift support.

type Status = "present" | "absent" | "rotation_leave" | "rest_day" | "double_duty" | "relief_cover" | "blocked";

const STATUS_LABEL: Record<Status, string> = {
  present: "Present",
  absent: "Absent",
  rotation_leave: "Leave",
  rest_day: "Rest day",
  double_duty: "Double duty",
  relief_cover: "Relief cover",
  blocked: "Blocked",
};
const STATUS_SHORT: Record<Status, string> = {
  present: "P", absent: "A", rotation_leave: "L", rest_day: "RD", double_duty: "DD", relief_cover: "RC", blocked: "B",
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
// The only four statuses this view offers (Leave = rotation_leave). Double Duty
// carries per-cell shift context; "Clear" is a separate revert action, not a status.
const BULK_STATUS_OPTIONS: { status: Status; label: string; activeBtn: string }[] = [
  { status: "present", label: "Present", activeBtn: "bg-success-600 text-white border-success-600" },
  { status: "absent", label: "Absent", activeBtn: "bg-danger-600 text-white border-danger-600" },
  { status: "rotation_leave", label: "Leave", activeBtn: "bg-warning-500 text-white border-warning-500" },
  { status: "double_duty", label: "Double Duty", activeBtn: "bg-brand-600 text-white border-brand-600" },
];

const VALID_STATUS = new Set<string>(["present", "absent", "rotation_leave", "rest_day", "double_duty", "relief_cover", "blocked"]);
// Legacy rows store capitalized Present/Absent/Leave; normalize to a new-model Status.
function normalizeStatus(raw: unknown): Status {
  const s = String(raw ?? "").toLowerCase();
  if (s === "leave") return "rotation_leave";
  return (VALID_STATUS.has(s) ? s : "present") as Status;
}

const today = () => new Date().toISOString().slice(0, 10);
const catLabel = (c: string): string => c.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
const shiftAbbr = (code: string): string => (code ? code[0].toUpperCase() : "?");

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
  termination_date: string | null;
  contract_id: string | null;
  lifecycle_state: string | null;
  category: string;
};

type BulkContract = { id: string; start_date: string | null; end_date: string | null; is_infinite: boolean | null };

export default function BulkMarkByEmployeeModal({ onClose, onSaved }: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { profile } = useAuth();
  const [employees, setEmployees] = useState<BulkEmp[]>([]);
  const [contracts, setContracts] = useState<BulkContract[]>([]);
  const [loadingEmps, setLoadingEmps] = useState(true);
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [empId, setEmpId] = useState("");
  const [month, setMonth] = useState(today().slice(0, 7));
  const [existing, setExisting] = useState<Map<string, Status>>(new Map());
  // Shift(s) actually worked on each already-marked date (from the saved
  // worked_shift), so a marked cell pre-highlights the shift it was saved under
  // — e.g. a day guard's one-off night stays on N after saving.
  const [existingShift, setExistingShift] = useState<Map<string, string[]>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingMonth, setLoadingMonth] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [siteShifts, setSiteShifts] = useState<string[]>([]);
  const [cellShifts, setCellShifts] = useState<Map<string, string[]>>(new Map());
  const [pendingStatus, setPendingStatus] = useState<Status>("present");
  const [defaultShift, setDefaultShift] = useState<string>("day");
  // Per-date shift comes from the dated deployment segment for THAT date, so a
  // mid-month shift change pre-highlights the correct chip per day (not the
  // guard's current shift for every day). Falls back to defaultShift until loaded.
  const [resolveShift, setResolveShift] = useState<ShiftResolver | null>(null);
  const [dragMode, setDragMode] = useState<"add" | "remove" | null>(null);
  const [dragAnchor, setDragAnchor] = useState<string | null>(null);
  const [dragBase, setDragBase] = useState<Set<string>>(new Set());

  const emp = useMemo(() => employees.find((e) => e.id === empId) ?? null, [employees, empId]);

  useEffect(() => {
    (async () => {
      setLoadingEmps(true);
      // Contracts come along because the markable window is the intersection of
      // the employment window and the assigned contract's dates.
      const [{ data, error }, conRes] = await Promise.all([
        supabase
          .from("employees")
          .select(
            "id, full_name, guard_code, display_number, employee_code, client_id, shift, " +
              "join_date, last_working_day, termination_date, contract_id, lifecycle_state, category, " +
              "clients:client_id(name, employee_id_prefix)",
          )
          .neq("category", "reliever")
          .order("full_name"),
        supabase.from("contracts").select("id, start_date, end_date, is_infinite"),
      ]);
      if (error) { setBulkError(error.message); setLoadingEmps(false); return; }
      setContracts((conRes.data ?? []) as BulkContract[]);
      setEmployees((data ?? []).map((e: any) => ({
        id: e.id, full_name: e.full_name, guard_code: e.guard_code, display_number: e.display_number,
        employee_code: e.employee_code, client_id: e.client_id, client_name: e.clients?.name ?? null,
        client_prefix: e.clients?.employee_id_prefix ?? null, shift: (e.shift ?? "day") as "day" | "night",
        join_date: e.join_date, last_working_day: e.last_working_day,
        termination_date: e.termination_date, contract_id: e.contract_id,
        lifecycle_state: e.lifecycle_state,
        category: e.category,
      })));
      setLoadingEmps(false);
    })();
  }, []);

  useEffect(() => {
    if (!emp) { setSiteShifts([]); setDefaultShift("day"); setResolveShift(null); return; }
    let cancelled = false;
    (async () => {
      const resolver = await loadShiftResolver([emp.id]);
      if (!cancelled) setResolveShift(() => resolver);
      const { data: deps } = await supabase
        .from("deployments")
        .select("site_id, shift_code, start_date, end_date, contract_lines:contract_line_id(shift_code)")
        .eq("guard_id", emp.id)
        .not("site_id", "is", null)
        .order("start_date", { ascending: false });
      const active: any = (deps ?? []).find((d: any) => !d.end_date || d.end_date >= today()) ?? (deps ?? [])[0];
      const siteId = active?.site_id ?? null;
      const cl = active?.contract_lines;
      const clShift = Array.isArray(cl) ? cl[0]?.shift_code : cl?.shift_code;
      const contractShift = (active?.shift_code ?? clShift ?? emp.shift) as string;
      let codes: string[] = [];
      if (siteId) {
        const { data: sd } = await supabase
          .from("shift_definitions")
          .select("shift_code, start_time")
          .eq("site_id", siteId)
          .order("start_time", { ascending: true });
        codes = (sd ?? []).map((r: any) => r.shift_code as string);
      }
      if (cancelled) return;
      const union = codes.includes(contractShift) ? codes : [...codes, contractShift];
      setDefaultShift(contractShift);
      setSiteShifts(union.length ? union : [contractShift]);
    })();
    return () => { cancelled = true; };
  }, [emp]);

  useEffect(() => {
    setCellShifts(new Map());
    setPendingStatus("present");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empId]);

  // Groups to filter the employee list by: every client that has staff, plus a
  // "cat:<category>" bucket per category for staff with no client. Shaped for
  // ClientFilterSelect (id/name), which only renders those two fields.
  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees) {
      if (e.client_id) m.set(e.client_id, e.client_name ?? "—");
      else m.set(`cat:${e.category}`, `${catLabel(e.category)} (no client)`);
    }
    return [...m.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => ({ id, name }));
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
      .select("attendance_date, status, worked_shift")
      .eq("employee_id", employeeId)
      .gte("attendance_date", start)
      .lte("attendance_date", end);
    if (error) setBulkError(error.message);
    const map = new Map<string, Status>();
    const shiftMap = new Map<string, string[]>();
    for (const r of (data ?? []) as any[]) {
      map.set(r.attendance_date, normalizeStatus(r.status));
      const ws = (r.worked_shift as string) ?? "day";
      const arr = shiftMap.get(r.attendance_date);
      if (arr) { if (!arr.includes(ws)) arr.push(ws); } else shiftMap.set(r.attendance_date, [ws]);
    }
    setExisting(map);
    setExistingShift(shiftMap);
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

  const empContract = useMemo(
    () => (emp?.contract_id ? contracts.find((c) => c.id === emp.contract_id) ?? null : null),
    [emp, contracts],
  );

  // Why this date can't be marked, or null. Shared with the timesheet screens
  // and mirrored by the DB trigger (migration 0152), so a day greyed out here is
  // a day the database will refuse regardless of how it's submitted.
  const windowBlock = (d: string): string | null => {
    if (!emp) return "No employee selected.";
    if (d > today()) return "Future dates can't be marked.";
    return attendanceWindowError(emp, empContract, d);
  };

  const inWindow = (d: string): boolean => windowBlock(d) === null;

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
      if (!inWindow(d)) continue;
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

  // The shift active on `date` per the dated deployment segment (single source
  // of truth); falls back to the current default until the resolver loads.
  const defaultShiftFor = (date: string): string =>
    (resolveShift && emp ? resolveShift(emp.id, date) : defaultShift);
  // Priority: a manual pick this session → the shift already saved for that date
  // → the dated segment default.
  const shiftsFor = (date: string): string[] =>
    cellShifts.get(date) ?? existingShift.get(date) ?? (emp ? [defaultShiftFor(date)] : []);

  const changeStatus = (s: Status) => {
    setPendingStatus(s);
    if (s !== "double_duty") {
      setCellShifts((prev) => {
        const next = new Map<string, string[]>();
        for (const [d, arr] of prev) next.set(d, arr.length ? [arr[0]] : arr);
        return next;
      });
    }
  };

  const pickCellShift = (date: string, code: string) => {
    if (!inWindow(date)) return;
    setSelected((prev) => new Set(prev).add(date));
    setCellShifts((prev) => {
      const next = new Map(prev);
      const cur = next.get(date) ?? existingShift.get(date) ?? (emp ? [defaultShiftFor(date)] : []);
      if (pendingStatus !== "double_duty") { next.set(date, [code]); return next; }
      const chosen = cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code];
      const ordered = siteShifts.filter((c) => chosen.includes(c));
      next.set(date, ordered.length ? ordered : [code]);
      return next;
    });
  };

  const gateSelectedDays = async (): Promise<{ days: string[]; overrideSet: Set<string>; overrodeCount: number; blockedCount: number } | null> => {
    if (!emp) return null;
    const days = [...selected].filter(inWindow);
    const gates = await Promise.all(days.map((d) =>
      supabase.rpc("attendance_gate", { p_guard: emp.id, p_date: d })
        .then(({ data }) => ({ d, mode: (data as { mode?: string } | null)?.mode ?? "blocked" }))));
    const allowedDays = gates.filter((x) => x.mode === "allowed" || x.mode === "allowed_unposted").map((x) => x.d);
    const overrideDays = gates.filter((x) => x.mode === "override_required").map((x) => x.d);
    const blockedCount = gates.filter((x) => x.mode === "blocked").length;
    if (overrideDays.length > 0 && !overrideReason.trim()) {
      setBulkError(`${overrideDays.length} of ${days.length} selected day(s) are backdated beyond the limit. Enter a supervisor override reason below to include them, or deselect those days.`);
      return null;
    }
    const useOverride = !!overrideReason.trim();
    return {
      days: [...allowedDays, ...(useOverride ? overrideDays : [])],
      overrideSet: new Set(overrideDays),
      overrodeCount: useOverride ? overrideDays.length : 0,
      blockedCount,
    };
  };

  const applyMark = async () => {
    if (!emp || selected.size === 0) return;
    const status = pendingStatus;
    const isDouble = status === "double_duty";
    setSubmitting(true); setBulkError(null); setNotice(null);
    const gate = await gateSelectedDays();
    if (!gate) { setSubmitting(false); return; }
    if (gate.days.length === 0) {
      setSubmitting(false);
      setBulkError(`Nothing written — all selected day(s) are blocked (closed payroll period, archived, or out of employment window).`);
      return;
    }
    const nowIso = new Date().toISOString();
    const rows = gate.days.flatMap((d) => {
      const picks = shiftsFor(d);
      const sched = defaultShiftFor(d);
      const shifts = isDouble ? picks : [picks[0] ?? sched];
      return shifts.map((ws) => ({
        employee_id: emp.id,
        attendance_date: d,
        // Fold Rotation leave into the single canonical "Leave" token.
        status: status === "rotation_leave" ? "Leave" : status,
        absent_reason: status === "absent" ? "awol" : null,
        scheduled_shift: sched,
        worked_shift: ws,
        entry_type: isDouble ? "double_duty" : "normal",
        source: "manual",
        // worked_for_client_id is deliberately NOT sent: this calendar marks a
        // whole month at once, and the guard's current client is the wrong
        // answer for any date before a transfer. The DB derives it per date
        // from the posting that covers that date (migration 0155).
        marked_by_role: profile?.role ?? "hr",
        marked_by_user_id: profile?.id ?? null,
        marked_at: nowIso,
        supervisor_override: gate.overrideSet.has(d),
        override_reason: gate.overrideSet.has(d) ? overrideReason.trim() : null,
      }));
    });
    const { error } = await supabase
      .from("attendance_records")
      .upsert(rows, { onConflict: "employee_id,attendance_date,worked_shift" });
    setSubmitting(false);
    if (error) { setBulkError(error.message); return; }
    setNotice(
      `Marked ${gate.days.length} day(s) ${STATUS_LABEL[status].toLowerCase()}` +
      (isDouble ? " · double duty" : "") +
      (gate.overrodeCount ? ` (${gate.overrodeCount} backdated via override)` : "") +
      (gate.blockedCount ? ` · skipped ${gate.blockedCount} blocked / out-of-window` : "") + ".",
    );
    setOverrideReason("");
    await loadMonth(emp.id, month);
    setSelected(new Set());
    setCellShifts(new Map());
    await onSaved();
  };

  const clearMarks = async () => {
    if (!emp || selected.size === 0) return;
    setSubmitting(true); setBulkError(null); setNotice(null);
    const gate = await gateSelectedDays();
    if (!gate) { setSubmitting(false); return; }
    if (gate.days.length === 0) {
      setSubmitting(false);
      setBulkError(`Nothing cleared — selected day(s) are blocked (closed payroll period or out of employment window).`);
      return;
    }
    const { error } = await supabase
      .from("attendance_records")
      .delete()
      .eq("employee_id", emp.id)
      .in("attendance_date", gate.days);
    setSubmitting(false);
    if (error) { setBulkError(error.message); return; }
    setNotice(
      `Cleared ${gate.days.length} day(s) — reverted to unmarked` +
      (gate.blockedCount ? ` · skipped ${gate.blockedCount} blocked / out-of-window` : "") + ".",
    );
    setOverrideReason("");
    await loadMonth(emp.id, month);
    setSelected(new Set());
    setCellShifts(new Map());
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
                <ClientFilterSelect
                  clients={clientOptions}
                  value={clientFilter}
                  onChange={setClientFilter}
                  allValue="all"
                  allLabel="All groups"
                  className="sm:w-56 flex-shrink-0"
                  buttonClassName=""
                />
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
              <button type="button" onClick={() => { setSelected(new Set()); setCellShifts(new Map()); }} className="px-2 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-50">Clear selection</button>
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
                    if (!c.date) return <div key={i} className="h-16 rounded-lg bg-muted/40" />;
                    const block = windowBlock(c.date);
                    const win = block === null;
                    const status = existing.get(c.date);
                    const sel = selected.has(c.date);
                    const picks = shiftsFor(c.date);
                    const cellClass = !win
                      ? "bg-slate-100 text-slate-300 border-slate-200 cursor-not-allowed"
                      : status ? STATUS_CELL_CLASS[status] : "bg-card text-foreground border-border hover:border-brand-500/50";
                    const ring = sel ? "ring-2 ring-brand-500 ring-offset-2 ring-offset-card border-brand-500" : "";
                    return (
                      <div key={c.date}
                        onMouseDown={(e) => { if (!win) return; e.preventDefault(); startDrag(c.date!); }}
                        onMouseEnter={() => win && extendDrag(c.date!)}
                        className={`h-16 rounded-lg border p-1.5 flex flex-col justify-between transition-all ${win ? "cursor-pointer" : ""} ${cellClass} ${ring}`}
                        title={block ?? (status ? `Currently: ${STATUS_LABEL[status]}` : "Unmarked")}>
                        <div className="flex items-start justify-between">
                          <span className="text-xs font-medium tabular-nums">{c.day}</span>
                          {win && status && <span className="text-[9px] font-bold uppercase tracking-wider">{STATUS_SHORT[status]}</span>}
                        </div>
                        {win && siteShifts.length > 0 && (
                          <div className="flex flex-wrap gap-0.5">
                            {siteShifts.map((code) => {
                              const chosen = picks.includes(code);
                              const cls = chosen
                                ? sel
                                  ? "bg-brand-600 text-white border-brand-600"
                                  : "bg-brand-50 text-brand-700 border-brand-400"
                                : "bg-card/70 text-muted-foreground border-slate-200 hover:border-brand-400";
                              return (
                                <button key={code} type="button"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => { e.stopPropagation(); pickCellShift(c.date!, code); }}
                                  title={catLabel(code)}
                                  className={`px-1 py-0.5 rounded text-[9px] font-bold leading-none border transition-colors ${cls}`}>
                                  {shiftAbbr(code)}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground mt-2.5">
                Tap a date to toggle, or press and drag to select a range. Greyed days can't be marked —
                they're in the future, before joining, on/after the separation date, or outside the
                contract's dates. Hover a greyed day for the reason.
              </p>
            </div>

            {/* Controls: status → mark / clear. Shift per date is chosen in the cells. */}
            {selected.size > 0 && (
              <div className="space-y-3 pt-2 border-t border-slate-200">
                {pendingStatus === "double_duty" && (
                  <p className="text-[11px] text-brand-700 bg-brand-50 border border-brand-200 rounded px-2.5 py-1.5">
                    Double duty — tap more than one shift (e.g. D and N) in a date cell to record both.
                  </p>
                )}

                <div>
                  <label className="block text-xs uppercase tracking-wider text-slate-500 mb-2">Status</label>
                  <div className="flex flex-wrap gap-2">
                    {BULK_STATUS_OPTIONS.map((o) => {
                      const active = pendingStatus === o.status;
                      return (
                        <button key={o.status} type="button" onClick={() => changeStatus(o.status)}
                          className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${active ? o.activeBtn : "bg-card text-foreground border-slate-200 hover:border-slate-300"}`}>
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-500 mb-1">
                    Supervisor override reason <span className="text-slate-400">(only needed for days older than 3 days)</span>
                  </label>
                  <input
                    type="text"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="e.g. Late WhatsApp report — approved by supervisor"
                    className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                  />
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <button type="button" onClick={applyMark} disabled={submitting}
                    className="flex-1 min-w-[150px] px-3 py-2 rounded-md text-sm text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed">
                    {submitting ? "Saving…" : `Mark ${BULK_STATUS_OPTIONS.find((o) => o.status === pendingStatus)?.label}`}
                  </button>
                  <button type="button" onClick={clearMarks} disabled={submitting}
                    className="px-3 py-2 rounded-md text-sm border border-danger-200 text-danger-700 hover:bg-danger-50 disabled:opacity-50 disabled:cursor-not-allowed">
                    Clear (unmark)
                  </button>
                  {submitting && (
                    <span className="self-center text-xs text-slate-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Saving…</span>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
