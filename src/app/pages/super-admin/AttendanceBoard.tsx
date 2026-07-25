import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, X, ChevronRight, CheckCircle2, Clock, Download, Briefcase } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { guardDisplayCode } from "../../lib/guardCode";
import { brandingFromCompany, type PdfBranding } from "../../lib/pdfBranding";
import { generateClientAttendancePdf, generateGuardAttendancePdf } from "../../lib/attendanceSheetPdf";

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

type RosterGuard = {
  guard_id: string;
  full_name: string;
  guard_code: string | null;
  display_number: number | null;
  employee_code: string;
  client_id: string;
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
  const [markingAll, setMarkingAll] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    // Active deployments on the date + guard + site + client + contract line shift.
    const [{ data: deps, error: depErr }, { data: cls }, { data: confs }, { data: att }, { data: cliRows }, { data: vac }] =
      await Promise.all([
        supabase
          .from("deployments")
          .select(
            "guard_id, site_id, client_id, contract_line_id, start_date, end_date, " +
              "employees:guard_id(full_name, guard_code, display_number, employee_code, shift, join_date, last_working_day, lifecycle_state), " +
              "sites:site_id(name), clients:client_id(name, employee_id_prefix), contract_lines:contract_line_id(shift_code)",
          )
          .is("end_date", null),
        supabase.from("contract_lines").select("site_id, shift_code, billed_qty").not("site_id", "is", null),
        supabase.from("attendance_confirmations").select("*").eq("attendance_date", date),
        supabase.from("attendance_records").select("employee_id, status, absent_reason, worked_shift, site_id:worked_for_client_id").eq("attendance_date", date),
        supabase.from("clients").select("id, name"),
        supabase.from("vacancies").select("*").eq("status", "open").order("opened_at", { ascending: false }),
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
    const confMap = new Map<string, { supervisor_name: string; confirmed_at: string }>();
    for (const c of (confs ?? []) as any[]) confMap.set(`${c.site_id}|${c.shift_code}`, { supervisor_name: c.supervisor_name, confirmed_at: c.confirmed_at });
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
      // employment-window gating (roster membership)
      if (e.join_date && e.join_date > date) continue;
      if (e.last_working_day && e.last_working_day < date) continue;
      if (e.lifecycle_state === "archived") continue;
      if (d.start_date > date) continue;
      const sched = (d.contract_lines?.shift_code ?? e.shift ?? "day") as string;
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

  // Mark All Present — scoped to the active CLIENT filter (§8.5 window already
  // applied in load(): the roster only contains guards whose window contains the
  // date, so out-of-window/archived guards are never force-marked). Writes the
  // full Phase 6 audit fields (status/source/marked_by/marked_at) on every row.
  const markAllPresent = async () => {
    const targetRows = rows.filter((r) => clientFilter === "all" || r.client_id === clientFilter);
    const guards = targetRows.flatMap((r) =>
      r.roster.map((g) => ({ guard_id: g.guard_id, scheduled_shift: g.scheduled_shift, client_id: r.client_id })),
    );
    if (guards.length === 0) { setError("No guards to mark for this filter/date."); return; }
    // §8.5: a closed payroll period (or otherwise blocked date) can't be marked.
    const { data: gate } = await supabase.rpc("attendance_gate", { p_guard: guards[0].guard_id, p_date: date });
    if ((gate as { mode?: string } | null)?.mode === "blocked") {
      setError((gate as { reason?: string }).reason ?? "This date is blocked."); return;
    }
    const scope = clientFilter === "all" ? "all clients" : (clientOptions.find((c) => c[0] === clientFilter)?.[1] ?? "this client");
    if (!confirm(`Mark ${guards.length} guard(s) present for ${date} (${scope})? Existing exceptions are left untouched.`)) return;
    setMarkingAll(true);
    try {
      const nowIso = new Date().toISOString();
      // Presume present, but do NOT overwrite an already-entered exception.
      const toWrite = targetRows.flatMap((r) =>
        r.roster
          .filter((g) => r.marks.get(g.guard_id) == null) // skip guards with an entered exception
          .map((g) => ({
            employee_id: g.guard_id,
            attendance_date: date,
            status: "present",
            scheduled_shift: g.scheduled_shift,
            worked_shift: g.scheduled_shift,
            entry_type: "normal",
            source: "manual",
            worked_for_client_id: r.client_id,
            marked_by_role: profile?.role ?? "hr",
            marked_by_user_id: profile?.id ?? null,
            marked_at: nowIso,
          })),
      );
      if (toWrite.length > 0) {
        const { error: upErr } = await supabase
          .from("attendance_records")
          .upsert(toWrite, { onConflict: "employee_id,attendance_date,worked_shift" });
        if (upErr) throw upErr;
      }
      // Client-scoped bulk mark also records the confirmation (who confirmed it).
      // Global (all clients) is logged purely via each row's marked_by/marked_at.
      if (clientFilter !== "all") {
        const confs = targetRows.map((r) => ({
          client_id: r.client_id, site_id: r.site_id, shift_code: r.shift_code,
          attendance_date: date, supervisor_name: profile?.full_name || "Bulk mark-all", source: "manual",
        }));
        const { error: cErr } = await supabase
          .from("attendance_confirmations")
          .upsert(confs, { onConflict: "site_id,shift_code,attendance_date" });
        if (cErr) throw cErr;
      }
      await load();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setMarkingAll(false);
    }
  };

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
            className="px-3 py-2 border border-slate-200 rounded-md text-sm" />
        }
      />
      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-4">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" /><div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        <div className="flex gap-1 border-b border-slate-200">
          {([["board", "Daily board"], ["vacancies", `Vacancies (${vacancies.length})`]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === k ? "border-brand-600 text-brand-700 font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}>{l}</button>
          ))}
        </div>

        {tab === "board" && (
          <>
            {/* Filter + search + Mark-All (added alongside the Phase 6 model). */}
            <div className="bg-white border border-slate-200 rounded-lg p-3 flex flex-col md:flex-row gap-2 md:items-center">
              <ThemedSelect
                value={clientFilter}
                onChange={(e) => setClientFilter(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm md:w-56"
              >
                <option value="all">All clients</option>
                {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </ThemedSelect>
              <div className="relative flex-1">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={clientFilter === "all" ? "Search guards by name or ID…" : "Search within this client…"}
                  className="w-full pl-3 pr-3 py-2 border border-slate-200 rounded-md text-sm"
                />
              </div>
              <Button size="sm" variant="secondary" disabled={markingAll} onClick={markAllPresent}>
                {markingAll && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                Mark all present{clientFilter === "all" ? " (all)" : ""}
              </Button>
            </div>

            {/* Summary strip */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: "Confirmed", value: `${summary.confirmed}/${summary.total}`, icon: CheckCircle2 },
                { label: "On ground", value: summary.onGround, icon: CheckCircle2 },
                { label: "Exceptions", value: summary.exceptions, icon: AlertCircle },
                { label: "Awaiting", value: summary.awaiting, icon: Clock },
              ].map((t) => (
                <div key={t.label} className="bg-white border border-slate-200 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide"><t.icon className="w-4 h-4" /> {t.label}</div>
                  <div className="mt-1 text-2xl font-bold text-slate-900">{t.value}</div>
                </div>
              ))}
            </div>

            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50">
                      <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Client · site · shift</th>
                      <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">Contracted</th>
                      <th className="text-right px-4 py-3 text-xs text-slate-500 uppercase">On roster</th>
                      <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Exceptions</th>
                      <th className="text-left px-4 py-3 text-xs text-slate-500 uppercase">Status</th>
                      <th className="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {loading && <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…</td></tr>}
                    {!loading && visibleRows.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-500 text-sm">No client-shifts match the current filter/search.</td></tr>}
                    {!loading && visibleRows.map((r) => {
                      const st = rowStatus(r);
                      return (
                        <tr key={r.key} className="hover:bg-slate-50 cursor-pointer" onClick={() => setDrill(r)}>
                          <td className="px-4 py-3 text-sm">
                            <span className="font-medium text-slate-900">{r.client_name}</span>
                            <span className="text-slate-400"> · {r.site_name} · </span>
                            <span className="capitalize inline-block px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-xs">{r.shift_code}</span>
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-slate-600">{r.contracted || "—"}</td>
                          <td className="px-4 py-3 text-sm text-right text-slate-600">{r.roster.length}</td>
                          <td className="px-4 py-3 text-sm text-slate-600">{exceptionSummary(r)}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-block px-2 py-0.5 rounded-md text-xs border capitalize ${badge(st)}`}>{st}</span>
                            {r.confirmation && <span className="block text-[11px] text-slate-400 mt-0.5">by {r.confirmation.supervisor_name}</span>}
                          </td>
                          <td className="px-4 py-3 text-right"><ChevronRight className="w-4 h-4 text-slate-400 inline-block" /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex gap-2">
              <ExportBoardButton rows={visibleRows} date={date} clientNames={clientNames} branding={branding} />
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
  // Row action §8.4: guards who swapped to the other shift (present, worked_shift flips).
  const [swaps, setSwaps] = useState<Set<string>>(new Set());
  const otherShift = (s: string) => (s === "day" ? "night" : "day");
  const [supervisor, setSupervisor] = useState(shift.confirmation?.supervisor_name ?? "");
  const [source, setSource] = useState<"app" | "whatsapp" | "manual">("app");
  const [saving, setSaving] = useState(false);
  const [gate, setGate] = useState<{ mode: string; reason: string | null } | null>(null);
  const [override, setOverride] = useState("");
  // View-only filter over the roster list; never touches `marks` (selections persist).
  const [rosterSearch, setRosterSearch] = useState("");

  useEffect(() => {
    // Gate the shift date using any roster guard (window-independent checks:
    // period-close / backdating apply to the whole shift-day).
    const g = shift.roster[0];
    if (!g) return;
    supabase.rpc("attendance_gate", { p_guard: g.guard_id, p_date: date })
      .then(({ data }) => setGate(data as any));
  }, [shift, date]);

  const setMark = (id: string, status: Status | "present", reason: AbsentReason | null = null) => {
    setMarks((prev) => {
      const next = new Map(prev);
      if (status === "present") next.delete(id);
      else next.set(id, { status, absent_reason: status === "absent" ? reason : null });
      return next;
    });
  };

  const blocked = gate?.mode === "blocked";
  const needsOverride = gate?.mode === "override_required";

  const confirm = async () => {
    if (blocked) { onError(gate?.reason ?? "Blocked"); return; }
    if (!supervisor.trim()) { onError("Supervisor name is required to confirm."); return; }
    if (needsOverride && !override.trim()) { onError("Backdated — a supervisor override reason is required."); return; }
    setSaving(true);
    try {
      // Materialise a row per roster guard: exception status where marked, else
      // present. Every row carries source / marked_by / marked_at (§8.3).
      const rows = shift.roster.map((g) => {
        const mk = marks.get(g.guard_id);
        const status = mk?.status ?? "present";
        const swapped = swaps.has(g.guard_id);
        const entry_type: EntryType = status === "double_duty" ? "double_duty"
          : status === "relief_cover" ? "relief_cover"
          : swapped ? "swap" : "normal";
        return {
          employee_id: g.guard_id,
          attendance_date: date,
          status,
          absent_reason: mk?.absent_reason ?? null,
          scheduled_shift: g.scheduled_shift,
          worked_shift: swapped ? otherShift(g.scheduled_shift) : g.scheduled_shift,
          entry_type,
          source,
          worked_for_client_id: g.client_id,
          marked_by_role: role,
          supervisor_override: needsOverride,
          override_reason: needsOverride ? override.trim() : null,
        };
      });
      const { error: upErr } = await supabase
        .from("attendance_records")
        .upsert(rows, { onConflict: "employee_id,attendance_date,worked_shift" });
      if (upErr) throw upErr;
      const { error: cErr } = await supabase.from("attendance_confirmations").upsert(
        {
          client_id: shift.client_id, site_id: shift.site_id, shift_code: shift.shift_code,
          attendance_date: date, supervisor_name: supervisor.trim(), source,
        },
        { onConflict: "site_id,shift_code,attendance_date" },
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
        <div className="flex items-center gap-2">
          <input value={supervisor} onChange={(e) => setSupervisor(e.target.value)} placeholder="Supervisor name *"
            className="flex-1 px-3 py-2 border border-slate-200 rounded-md text-sm" disabled={blocked} />
          <ThemedSelect value={source} onChange={(e) => setSource(e.target.value as any)} className="px-2 py-2 border border-slate-200 rounded-md text-sm" >
            <option value="app">App</option><option value="whatsapp">WhatsApp</option><option value="manual">Manual</option>
          </ThemedSelect>
          <Button size="sm" onClick={confirm} disabled={saving || blocked}>
            {saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Confirm shift
          </Button>
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
                {/* Row action §8.4: swap — worked the OTHER shift. */}
                <button
                  type="button"
                  title={`Swap to ${otherShift(g.scheduled_shift)} shift`}
                  onClick={() => setSwaps((prev) => {
                    const next = new Set(prev);
                    next.has(g.guard_id) ? next.delete(g.guard_id) : next.add(g.guard_id);
                    return next;
                  })}
                  className={`text-xs px-2 py-1 rounded border ${swaps.has(g.guard_id) ? "bg-brand-50 border-brand-300 text-brand-700" : "border-slate-200 text-slate-400 hover:text-slate-700"}`}
                >
                  ⇄ swap
                </button>
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
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2 text-sm text-slate-700">
        <Briefcase className="w-4 h-4" /> Open vacancies drive recruitment — the client is still contracted for that strength.
      </div>
      {vacancies.length === 0 ? (
        <div className="px-4 py-8 text-center text-slate-500 text-sm">No open vacancies.</div>
      ) : (
        <table className="w-full">
          <tbody className="divide-y divide-slate-100">
            {vacancies.map((v) => (
              <tr key={v.id}>
                <td className="px-4 py-3 text-sm font-medium text-slate-900">{clientNames.get(v.client_id) ?? "—"}</td>
                <td className="px-4 py-3 text-sm text-slate-500">{v.opened_reason}</td>
                <td className="px-4 py-3 text-xs text-slate-400">{new Date(v.opened_at).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => close(v.id)} className="text-xs text-slate-500 hover:text-danger-600">Dismiss</button>
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

function ExportBoardButton({ rows, date, clientNames, branding }: { rows: ClientShift[]; date: string; clientNames: Map<string, string>; branding: PdfBranding }) {
  void clientNames;
  // §8.9 (a) per-client attendance sheet — branded PDF for client submission.
  const exportClient = () => {
    generateClientAttendancePdf(branding, date, rows.map((r) => ({
      client_name: r.client_name, site_name: r.site_name, shift_code: r.shift_code,
      contracted: r.contracted, on_roster: r.roster.length,
      status: r.confirmation ? "confirmed" : r.marks.size > 0 ? "reported" : "awaiting",
      exceptions: [...r.marks.values()].map((m) => m.status).join("; "),
      supervisor: r.confirmation?.supervisor_name ?? "",
    })));
  };
  // §8.9 (b) per-guard sheet — branded PDF for payroll (one row per rostered guard).
  const exportGuard = () => {
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
  };
  return (
    <>
      <Button size="sm" variant="secondary" onClick={exportClient}>
        <Download className="w-4 h-4 mr-1" /> Client attendance sheet (PDF)
      </Button>
      <Button size="sm" variant="secondary" onClick={exportGuard}>
        <Download className="w-4 h-4 mr-1" /> Per-guard payroll sheet (PDF)
      </Button>
    </>
  );
}
