import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Loader2, Lock, Plus, Trash2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Tabs from "../../components/Tabs";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import { useAuth, hasAnyPermission, hasPermission } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { useRegion } from "../../lib/region";
import { formatDate } from "../../lib/date";
import { generateOperationsPdf } from "../../lib/dailyBriefPdf";
import { describeUnconfirmed, loadAttendanceSummary, type AttendanceSummary } from "../../lib/attendanceSummary";
import { usePageState } from "../../lib/pageState";

// Operations ▸ Daily Reports. One row per ACTIVE CLIENT for a chosen day, each
// with a free-text Details box; the branded PDF is built straight from those two
// columns. The old per-post form (post / required / present / exception note)
// was removed — this is a written client-by-client note, not a headcount
// reconciliation, and the headcount already lives on the Attendance board.
//
// "Active" is derived: a client with at least one contract in `active` status.
// There is no active flag on the client record itself.
//
// Details are stored per (client, DAY). Nothing needs clearing at midnight: a
// new day simply has no rows, so every box opens empty. Past days stay readable
// for the same reason, and are locked — the record of a day that has ended is
// not edited after the fact.
//
// 0460 added three things, all of which only exist because a screen supplies
// them:
//   * a REGION filter — clients.branch_id is the region, and whatever is
//     filtered here is what the PDF carries;
//   * "No report" per client, which is a claim ("somebody looked and there was
//     nothing") and not the same as an empty box ("nobody looked"). It greys the
//     details box and sorts the client to the bottom of the PDF;
//   * a day-level NEXT DAY TASK, printed at the head of the PDF. 0461 made it a
//     LIST: several tasks a day, each general or assigned to one ACTIVE OFFICE
//     STAFF employee (the database refuses anyone else, not just the picker).
//
// 0517 made Next Day Tasks and Other Updates PER REGION: each region writes its
// own, and "All regions" shows one block per region. Rows written before 0517
// carry no region; they are shown read-only under "All regions (before the
// split)" and are not guessed into one (DECIDED).
//
// The Attendance Report tab reads the PREVIOUS day, deliberately: the day being
// reported on has not been confirmed yet when the report goes out, so the
// attendance that CAN be vouched for is yesterday's. Clients nobody confirmed
// are flagged by name, on screen and in the PDF.

/**
 * Local calendar dates, never UTC.
 *
 * toISOString() converts to UTC first, and Pakistan is UTC+5 — so local midnight
 * is 19:00 the PREVIOUS day in UTC. Round-tripping a date through it silently
 * subtracts a day: "back" jumped two days at once and "next" appeared dead
 * because +1 day −1 timezone day landed back on the date you started from.
 */
const isoOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const todayIso = () => isoOf(new Date());

const shiftDay = (iso: string, days: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  // Month is 0-based; Date normalises overflow, so day 0 and day 32 are fine.
  return isoOf(new Date(y, m - 1, d + days));
};

type ClientRow = { id: string; name: string; branch_id: string | null };
type TaskRow = {
  id: string;
  title: string;
  assignee_employee_id: string | null;
  sort_order: number;
  /** The region (0517); null only on rows written before the split. */
  branch_id: string | null;
  /** 0568: ticked done — usually the day after it was set. Follows status (0569). */
  done_at: string | null;
  /** 0569: progress, set the day after. */
  status: TaskStatus;
  status_note: string | null;
  /** The day the task was set for. */
  report_date: string;
  /** 0571: the report day its status was last reported on. */
  status_reported_on: string | null;
};
type TaskStatus = "pending" | "in_progress" | "completed";
const STATUS_LABEL: Record<TaskStatus, string> = { pending: "Pending", in_progress: "In progress", completed: "Completed" };
/** Map key for the region-less rows written before 0517. */
const BEFORE_SPLIT = "";
const BEFORE_SPLIT_LABEL = "All regions (before the split)";
const TASK_COLS = "id, title, assignee_employee_id, sort_order, branch_id, done_at, status, status_note, report_date, status_reported_on";
/**
 * CARRY-FORWARD (Shayan, 28 Oct 2026): a task still pending or in progress
 * follows on to every later day until it is completed, so it is asked about
 * again instead of being missed. It starts with the tasks set on 27 Oct —
 * tasks set before that are not carried. A carried task is the same row, so
 * its status is updated in one place; once completed it shows once more, on
 * the day it was completed, and then drops off.
 */
const CARRY_FROM = "2026-10-27";
/**
 * 0571 (Shayan, 28 Oct 2026): exporting is refused until every previous task
 * has been reported on the report day itself (from report day 29 Oct), and
 * until HR has explained every client whose attendance was not confirmed or
 * left guards unmarked (from attendance day 28 Oct). Before those days there
 * was nothing to record either with.
 */
const TASKS_REPORTED_FROM = "2026-10-29";
const GAPS_EXPLAINED_FROM = "2026-10-28";
/** A client whose attendance needs HR's explanation: not confirmed, or guards left unmarked. */
const isGap = (c: AttendanceSummary["clients"][number]) => !c.confirmed || c.deployed > c.marked;
/** The local calendar day of a timestamp. */
const dayOf = (ts: string) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
type StaffRow = { id: string; full_name: string; employee_code: string | null };
type Tab = "reports" | "attendance";

/**
 * Enter starts a new bullet instead of a bare newline.
 *
 * Applied to every report field, because the notes are lists of events and were
 * being typed as one run-on paragraph. The line the caret is on is bulleted too
 * where it isn't already — otherwise the first item of every list would be the
 * only one without a bullet.
 *
 * Shift+Enter still inserts a plain newline, for the occasional wrapped line.
 */
function bulletOnEnter(
  e: KeyboardEvent<HTMLTextAreaElement>,
  onChange: (v: string) => void,
): void {
  if (e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault();
  const el = e.currentTarget;
  const value = el.value;
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? start;

  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const currentLine = value.slice(lineStart, start);
  let head = value.slice(0, start);
  let shift = 0;
  if (currentLine.trim().length > 0 && !/^\s*•\s/.test(currentLine)) {
    head = value.slice(0, lineStart) + "• " + value.slice(lineStart, start);
    shift = 2;
  }
  const next = `${head}\n• ${value.slice(end)}`;
  onChange(next);
  // The value is controlled, so the caret has to be restored after React has
  // written the new text back into the same DOM node.
  const caret = start + shift + 3;
  requestAnimationFrame(() => {
    try { el.setSelectionRange(caret, caret); } catch { /* node gone — nothing to place */ }
  });
}

export default function FieldOps() {
  const { company, profile } = useAuth();
  const { regions, regionId: globalRegionId, locked: regionLocked } = useRegion();
  // Writing daily reports requires roster.edit (super_admin + SSA implicit).
  // Backend RLS (0313) enforces it on daily_client_reports; folding it into
  // `locked` makes the textarea read-only AND blocks saveOne for view-only users.
  const canWriteReports = hasPermission(profile, "roster.edit");
  // HR sees the Attendance Report only (Shayan, 28 Oct 2026): the Daily
  // Reports tab needs a key HR does not hold. Attendance explanations are
  // attendance.edit, the key a write to attendance needs (0571).
  const canSeeDaily = hasAnyPermission(profile, ["roster.view", "roster.edit", "incidents.view"]);
  const canExplainAttendance = hasPermission(profile, "attendance.edit");
  const companyId = company?.id ?? "";
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tabPicked, setTab] = usePageState<Tab>("FieldOps.tab", "reports");
  const tab: Tab = canSeeDaily ? tabPicked : "attendance";
  /** 0571: HR's explanation per gap client, for the attendance date. */
  const [gapNotes, setGapNotes] = useState<Map<string, string>>(new Map());
  /** What stopped an export: unreported tasks and unexplained attendance gaps. */
  const [blocked, setBlocked] = useState<{ tasks: TaskRow[]; gaps: AttendanceSummary["clients"] } | null>(null);

  const [date, setDate] = usePageState("FieldOps.date", todayIso());
  // Page-level region filter, seeded from the app-wide selector. A user pinned
  // to one region cannot widen it — the page filter narrows, it never grants.
  const [regionFilter, setRegionFilter] = usePageState<string | null>("FieldOps.regionFilter", globalRegionId);
  useEffect(() => { setRegionFilter(globalRegionId); }, [globalRegionId]);

  const [clients, setClients] = useState<ClientRow[]>([]);
  /** client_id -> details, for the selected day. */
  const [details, setDetails] = useState<Map<string, string>>(new Map());
  /** region id (BEFORE_SPLIT for pre-0517 rows) -> the day's "Other Updates". */
  const [otherUpdates, setOtherUpdates] = useState<Map<string, string>>(new Map());
  const [otherSaving, setOtherSaving] = useState<Set<string>>(new Set());
  const [otherSavedAt, setOtherSavedAt] = useState<Map<string, number>>(new Map());
  /** client_id -> "no report" flag, for the selected day. */
  const [noReport, setNoReport] = useState<Set<string>>(new Set());
  /** 0568: client_id -> ticked urgent, for the selected day. */
  const [urgent, setUrgent] = useState<Set<string>>(new Set());
  /** 0568: the PREVIOUS day's tasks — ticked done here, and listed in the PDF when not. */
  const [prevTasks, setPrevTasks] = useState<TaskRow[]>([]);
  /** The day's Next Day Tasks, in the order they were added. */
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  /** Active office staff — the only people a task can be assigned to (0461). */
  const [staff, setStaff] = useState<StaffRow[]>([]);
  /** Clients whose box is mid-save or just saved, for the inline hint. */
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [savedAt, setSavedAt] = useState<Map<string, number>>(new Map());

  /** Previous day's attendance — the day this report can actually vouch for. */
  const attendanceDate = useMemo(() => shiftDay(date, -1), [date]);
  const [attendance, setAttendance] = useState<AttendanceSummary | null>(null);
  const [attLoading, setAttLoading] = useState(true);

  const isToday = date === todayIso();
  // A day that has ended is a record, not a draft. Future days cannot be typed
  // into either — there is nothing to report on a day that has not happened.
  const locked = !isToday || !canWriteReports;

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setErr(null);
    const [cli, rep, taskRes, staffRes, dayRes, prevRes] = await Promise.all([
      // Active = has at least one active contract. The inner join is what does
      // the filtering; !inner makes PostgREST drop clients with no match.
      supabase
        .from("clients")
        .select("id, name, branch_id, contracts!inner(id, status)")
        .eq("company_id", companyId)
        .eq("contracts.status", "active")
        .order("name"),
      supabase
        .from("daily_client_reports")
        .select("client_id, details, no_report, urgent")
        .eq("company_id", companyId)
        .eq("report_date", date),
      supabase
        .from("daily_report_tasks")
        .select(TASK_COLS)
        .eq("company_id", companyId)
        .eq("report_date", date)
        .order("sort_order")
        .order("created_at"),
      supabase
        .from("employees")
        .select("id, full_name, employee_code")
        .eq("company_id", companyId)
        .eq("category", "office_staff")
        .eq("lifecycle_state", "active")
        .order("full_name"),
      supabase
        .from("daily_report_day_notes")
        .select("branch_id, other_updates")
        .eq("company_id", companyId)
        .eq("report_date", date),
      supabase
        .from("daily_report_tasks")
        .select(TASK_COLS)
        .eq("company_id", companyId)
        // Yesterday's tasks, plus earlier ones that may still be open.
        .gte("report_date", shiftDay(date, -1) < CARRY_FROM ? shiftDay(date, -1) : CARRY_FROM)
        .lt("report_date", date)
        .order("report_date")
        .order("sort_order")
        .order("created_at"),
    ]);
    if (cli.error) { setErr(cli.error.message); setLoading(false); return; }
    if (rep.error) { setErr(rep.error.message); setLoading(false); return; }

    // A client with two active contracts comes back twice through the join.
    const seen = new Map<string, ClientRow>();
    for (const c of (cli.data ?? []) as any[]) {
      if (!seen.has(c.id)) seen.set(c.id, { id: c.id, name: c.name, branch_id: c.branch_id ?? null });
    }
    setClients([...seen.values()]);
    setDetails(
      new Map(((rep.data ?? []) as any[]).map((r) => [r.client_id as string, (r.details ?? "") as string])),
    );
    setNoReport(
      new Set(((rep.data ?? []) as any[]).filter((r) => r.no_report).map((r) => r.client_id as string)),
    );
    setUrgent(
      new Set(((rep.data ?? []) as any[]).filter((r) => r.urgent).map((r) => r.client_id as string)),
    );
    // Every task set yesterday; from earlier days (since CARRY_FROM) the ones
    // not completed, and those completed on this report's day.
    const yday = shiftDay(date, -1);
    setPrevTasks(((prevRes.data ?? []) as TaskRow[]).filter((t) =>
      t.report_date === yday || t.status !== "completed" || (t.done_at != null && dayOf(t.done_at) >= date)));
    if (dayRes.error) setErr(dayRes.error.message);
    setOtherUpdates(
      new Map(
        ((dayRes.data ?? []) as { branch_id: string | null; other_updates: string | null }[]).map((r) => [
          r.branch_id ?? BEFORE_SPLIT,
          r.other_updates ?? "",
        ]),
      ),
    );
    setOtherSavedAt(new Map());
    if (taskRes.error) setErr(taskRes.error.message);
    setTasks((taskRes.data ?? []) as TaskRow[]);
    setStaff((staffRes.data ?? []) as StaffRow[]);
    setLoading(false);
  }, [companyId, date]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    if (!companyId) return;
    setAttLoading(true);
    // Unfiltered here; the region cut is applied below so switching regions
    // doesn't re-query the day.
    Promise.all([
      loadAttendanceSummary(companyId, attendanceDate),
      supabase.from("attendance_gap_notes").select("client_id, note").eq("company_id", companyId).eq("attendance_date", attendanceDate),
    ])
      .then(([s, notes]) => {
        if (cancelled) return;
        setAttendance(s);
        setGapNotes(new Map(((notes.data ?? []) as { client_id: string; note: string }[]).map((n) => [n.client_id, n.note])));
        if (notes.error) setErr(notes.error.message);
        setAttLoading(false);
      })
      .catch((e) => { if (!cancelled) { setErr(e.message ?? String(e)); setAttLoading(false); } });
    return () => { cancelled = true; };
  }, [companyId, attendanceDate]);

  /**
   * Save one client's note. Called on blur rather than on every keystroke — the
   * field is a paragraph, not a search box, and a write per character would be
   * both noisy and racy. A row with neither text nor the no-report flag is
   * deleted, so an accidental entry can be taken back and the day is not
   * littered with blanks.
   */
  const saveOne = async (clientId: string, value: string, flag: boolean, isUrgent: boolean = urgent.has(clientId)) => {
    if (locked) return;
    setSaving((prev) => new Set(prev).add(clientId));
    setErr(null);
    // "No report" is the claim; its text is cleared so the two cannot disagree.
    const text = flag ? "" : value.trim();
    const { data: userData } = await supabase.auth.getUser();
    const { error } = text || flag
      ? await supabase.from("daily_client_reports").upsert(
          {
            company_id: companyId,
            client_id: clientId,
            report_date: date,
            details: text || null,
            no_report: flag,
            // An urgent flag means something only on a written note.
            urgent: !flag && isUrgent,
            updated_by: userData.user?.id ?? null,
          },
          { onConflict: "company_id,client_id,report_date" },
        )
      : await supabase
          .from("daily_client_reports")
          .delete()
          .eq("company_id", companyId)
          .eq("client_id", clientId)
          .eq("report_date", date);
    setSaving((prev) => { const n = new Set(prev); n.delete(clientId); return n; });
    if (error) { setErr(error.message); return; }
    setSavedAt((prev) => new Map(prev).set(clientId, Date.now()));
  };

  const toggleUrgent = async (clientId: string, flag: boolean) => {
    setUrgent((prev) => { const n = new Set(prev); if (flag) n.add(clientId); else n.delete(clientId); return n; });
    await saveOne(clientId, details.get(clientId) ?? "", noReport.has(clientId), flag);
  };

  /**
   * 0569: a task's progress — pending / in progress / completed — and a short
   * remark. Set on a past day too (yesterday's tasks are updated today), by
   * anyone who can write reports. done_at follows the status.
   */
  const setTaskProgress = async (id: string, patch: { status?: TaskStatus; status_note?: string | null }) => {
    if (!canWriteReports) return;
    setErr(null);
    const stamp = patch.status === undefined ? undefined : patch.status === "completed" ? new Date().toISOString() : null;
    const apply = (list: TaskRow[]) => list.map((t) => (t.id === id ? { ...t, ...patch, ...(stamp !== undefined ? { done_at: stamp } : {}), ...(patch.status !== undefined ? { status_reported_on: date } : {}) } : t));
    const beforeT = tasks, beforeP = prevTasks;
    setTasks(apply); setPrevTasks(apply);
    const { data: userData } = await supabase.auth.getUser();
    const row: Record<string, unknown> = { ...patch, updated_by: userData.user?.id ?? null };
    if (patch.status !== undefined) row.status_reported_on = date;
    if (stamp !== undefined) { row.done_at = stamp; row.done_by = stamp ? userData.user?.id ?? null : null; }
    const { error } = await supabase.from("daily_report_tasks").update(row).eq("id", id);
    if (error) { setErr(error.message); setTasks(beforeT); setPrevTasks(beforeP); }
  };

  /** 0571: HR's explanation for one gap client — saved on blur; empty deletes it. */
  const saveGapNote = async (clientId: string, text: string) => {
    if (!canExplainAttendance || !companyId) return;
    const v = text.trim();
    if (v === (gapNotes.get(clientId) ?? "")) return;
    setErr(null);
    const before = gapNotes;
    setGapNotes((m) => { const n = new Map(m); if (v) n.set(clientId, v); else n.delete(clientId); return n; });
    const { data: userData } = await supabase.auth.getUser();
    const { error } = v
      ? await supabase.from("attendance_gap_notes").upsert(
          { company_id: companyId, attendance_date: attendanceDate, client_id: clientId, note: v, updated_by: userData.user?.id ?? null },
          { onConflict: "company_id,attendance_date,client_id" })
      : await supabase.from("attendance_gap_notes").delete().eq("company_id", companyId).eq("attendance_date", attendanceDate).eq("client_id", clientId);
    if (error) { setErr(error.message); setGapNotes(before); }
  };

  const toggleNoReport = async (clientId: string, flag: boolean) => {
    setNoReport((prev) => {
      const n = new Set(prev);
      if (flag) n.add(clientId); else n.delete(clientId);
      return n;
    });
    if (flag) setDetails((prev) => new Map(prev).set(clientId, ""));
    if (flag) setUrgent((prev) => { const n = new Set(prev); n.delete(clientId); return n; });
    await saveOne(clientId, flag ? "" : details.get(clientId) ?? "", flag);
  };

  /**
   * Save one region's Other Updates (0517) — one row per (company, day, region)
   * in daily_report_day_notes, written on blur like the client boxes.
   */
  const saveOtherUpdates = async (branchId: string, value: string) => {
    if (locked) return;
    setOtherSaving((prev) => new Set(prev).add(branchId));
    setErr(null);
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.from("daily_report_day_notes").upsert(
      {
        company_id: companyId,
        report_date: date,
        branch_id: branchId,
        other_updates: value.trim() || null,
        updated_by: userData.user?.id ?? null,
      },
      { onConflict: "company_id,report_date,branch_id" },
    );
    setOtherSaving((prev) => { const n = new Set(prev); n.delete(branchId); return n; });
    if (error) { setErr(error.message); return; }
    setOtherSavedAt((prev) => new Map(prev).set(branchId, Date.now()));
  };

  const addTask = async (branchId: string, title: string, assignee: string | null) => {
    if (locked) return false;
    const text = title.trim();
    if (!text) return false;
    setErr(null);
    const regionTasks = tasks.filter((t) => t.branch_id === branchId);
    const { data: userData } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("daily_report_tasks")
      .insert({
        company_id: companyId,
        report_date: date,
        branch_id: branchId,
        title: text,
        assignee_employee_id: assignee,
        sort_order: regionTasks.length ? Math.max(...regionTasks.map((t) => t.sort_order)) + 1 : 0,
        updated_by: userData.user?.id ?? null,
      })
      .select(TASK_COLS)
      .single();
    if (error) { setErr(error.message); return false; }
    setTasks((prev) => [...prev, data as TaskRow]);
    return true;
  };

  const updateTask = async (id: string, patch: Partial<Pick<TaskRow, "title" | "assignee_employee_id">>) => {
    if (locked) return;
    if (patch.title !== undefined && !patch.title.trim()) return;
    setErr(null);
    const before = tasks;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("daily_report_tasks")
      .update({ ...patch, updated_by: userData.user?.id ?? null })
      .eq("id", id);
    // Put the row back as it was: the database refused it, so the screen must
    // not keep showing a change that did not happen.
    if (error) { setErr(error.message); setTasks(before); }
  };

  const deleteTask = async (id: string) => {
    if (locked) return;
    setErr(null);
    const { error } = await supabase.from("daily_report_tasks").delete().eq("id", id);
    if (error) { setErr(error.message); return; }
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  const staffName = useCallback(
    (id: string | null) => (id ? staff.find((x) => x.id === id)?.full_name ?? "Former staff" : null),
    [staff],
  );

  /** The clients the page — and therefore the PDF — is showing. */
  const visibleClients = useMemo(
    () => (regionFilter ? clients.filter((c) => c.branch_id === regionFilter) : clients),
    [clients, regionFilter],
  );
  const regionLabel = useMemo(
    () => (regionFilter ? regions.find((r) => r.id === regionFilter)?.name ?? "Region" : null),
    [regionFilter, regions],
  );

  /**
   * The blocks of Next Day Tasks / Other Updates the page shows and the PDF
   * prints (0517): the filtered region, or every region under "All regions".
   * The pre-0517 region-less rows get their own read-only block, and only on a
   * day that has some — new days never will.
   */
  const regionBlocks = useMemo(() => {
    const blocks: { key: string; label: string; beforeSplit: boolean }[] = regions
      .filter((r) => !r.is_head_office && (!regionFilter || r.id === regionFilter))
      .map((r) => ({ key: r.id, label: r.name, beforeSplit: false }));
    const hasBeforeSplit =
      tasks.some((t) => t.branch_id === null) || (otherUpdates.get(BEFORE_SPLIT) ?? "").trim().length > 0;
    if (hasBeforeSplit) blocks.push({ key: BEFORE_SPLIT, label: BEFORE_SPLIT_LABEL, beforeSplit: true });
    return blocks;
  }, [regions, regionFilter, tasks, otherUpdates]);
  const tasksOf = useCallback(
    (key: string) => tasks.filter((t) => (t.branch_id ?? BEFORE_SPLIT) === key),
    [tasks],
  );

  /** The attendance summary, cut to the same region as the client list. */
  const cutAttendance = useCallback((regionId: string | null, orphans = false): AttendanceSummary | null => {
    if (!attendance) return null;
    if (!regionId && !orphans) return attendance;
    const rows = attendance.clients.filter((c) => (orphans ? !c.branch_id : c.branch_id === regionId));
    return {
      date: attendance.date,
      clients: rows,
      // Folded from the filtered rows, never carried over from the unfiltered
      // load — a total that can disagree with the table under it is the defect.
      totals: rows.reduce(
        (t, c) => ({
          deployed: t.deployed + c.deployed,
          present: t.present + c.present,
          absent: t.absent + c.absent,
          leave: t.leave + c.leave,
          other: t.other + c.other,
        }),
        { deployed: 0, present: 0, absent: 0, leave: 0, other: 0 },
      ),
      unconfirmed: rows.filter((c) => !c.confirmed),
    };
  }, [attendance]);
  const visibleAttendance = useMemo(() => cutAttendance(regionFilter), [cutAttendance, regionFilter]);

  const rowsForPdf = useMemo(
    () =>
      visibleClients.map((c) => ({
        client_name: c.name,
        details: details.get(c.id) ?? null,
        no_report: noReport.has(c.id),
      })),
    [visibleClients, details, noReport],
  );
  const filledCount = useMemo(
    () =>
      visibleClients.filter((c) => !noReport.has(c.id) && (details.get(c.id) ?? "").trim().length > 0)
        .length,
    [visibleClients, details, noReport],
  );

  /** Yesterday's tasks in view (same region cut), and the ones still open. */
  const prevVisible = useMemo(
    () => prevTasks.filter((t) => !regionFilter || t.branch_id === regionFilter || t.branch_id === null),
    [prevTasks, regionFilter],
  );

  /**
   * 2026-10-28: the daily report, the attendance report, or both in one PDF.
   * Under "All regions" each region is printed whole — its updates, tasks,
   * clients and attendance — before the next one starts (Shayan: "first
   * complete one region everything then next … dont merge it all").
   */
  const exportPdf = async (which: "daily" | "attendance" | "both") => {
    // 0571: refuse while a previous task is unreported today, or a gap in the
    // attendance has no explanation from HR — and say which.
    const unreported = which !== "attendance" && date >= TASKS_REPORTED_FROM
      ? prevVisible.filter((t) => t.status_reported_on !== date) : [];
    const unexplained = which !== "daily" && attendanceDate >= GAPS_EXPLAINED_FROM
      ? (visibleAttendance?.clients ?? []).filter((c) => isGap(c) && !(gapNotes.get(c.client_id) ?? "").trim()) : [];
    if (unreported.length || unexplained.length) { setBlocked({ tasks: unreported, gaps: unexplained }); return; }
    const prevDay = shiftDay(date, -1);
    // WHO ENTERED IT (28 Oct 2026). The PDF names the people who wrote the
    // notes, updates and tasks and who marked the attendance — read off the
    // records — and the person exporting only as "Extracted by".
    setBusy(true);
    const [noteBy, dayBy, taskBy] = await Promise.all([
      supabase.from("daily_client_reports").select("client_id, updated_by, details, no_report").eq("company_id", companyId).eq("report_date", date),
      supabase.from("daily_report_day_notes").select("branch_id, updated_by, other_updates").eq("company_id", companyId).eq("report_date", date),
      supabase.from("daily_report_tasks").select("branch_id, updated_by").eq("company_id", companyId).eq("report_date", date),
    ]);
    const authorIds = new Set<string>();
    const noteRows = ((noteBy.data ?? []) as { client_id: string; updated_by: string | null; details: string | null; no_report: boolean }[])
      .filter((r) => r.updated_by && (r.no_report || (r.details ?? "").trim()));
    const dayRows = ((dayBy.data ?? []) as { branch_id: string | null; updated_by: string | null; other_updates: string | null }[])
      .filter((r) => r.updated_by && (r.other_updates ?? "").trim());
    const taskRows = ((taskBy.data ?? []) as { branch_id: string | null; updated_by: string | null }[]).filter((r) => r.updated_by);
    for (const r of [...noteRows, ...dayRows, ...taskRows]) authorIds.add(r.updated_by!);
    for (const c of attendance?.clients ?? []) for (const u of c.markedBy ?? []) authorIds.add(u);
    const { data: who } = authorIds.size
      // 0570: profiles RLS hides other users from a non-super-admin exporter.
      ? await supabase.rpc("report_author_names", { p_ids: [...authorIds] })
      : { data: [] as { id: string; full_name: string | null }[] };
    const nameOf = new Map(((who ?? []) as { id: string; full_name: string | null }[]).map((x) => [x.id, x.full_name ?? "Unknown user"]));
    // Most entries first, so the main author leads.
    const namesFrom = (ids: string[]) => {
      const n = new Map<string, number>();
      for (const id of ids) { const nm = nameOf.get(id) ?? "Unknown user"; n.set(nm, (n.get(nm) ?? 0) + 1); }
      return [...n.entries()].sort((x, y) => y[1] - x[1]).map(([nm]) => nm);
    };
    const clientBranch = new Map(clients.map((c) => [c.id, c.branch_id]));
    const regionNames = Object.fromEntries(regions.map((r) => [r.id, r.name]));
    const partFor = (regionId: string | null, label: string | null, orphans = false) => {
      const inRegion = (b: string | null) => (orphans ? !b : !regionId || b === regionId);
      const cls = clients.filter((c) => inRegion(c.branch_id));
      const blocks = orphans ? regionBlocks.filter((blk) => blk.beforeSplit)
        : regionBlocks.filter((blk) => !blk.beforeSplit && (!regionId || blk.key === regionId));
      // Before-split tasks (no region) go with the region in view, or to their
      // own part under "All regions".
      const prev = prevTasks.filter((t) => (regionId ? t.branch_id === regionId || t.branch_id === null : inRegion(t.branch_id)));
      const att = cutAttendance(regionId, orphans);
      const preparedBy = namesFrom([
        ...noteRows.filter((r) => inRegion(clientBranch.get(r.client_id) ?? null)).map((r) => r.updated_by!),
        ...dayRows.filter((r) => inRegion(r.branch_id)).map((r) => r.updated_by!),
        ...taskRows.filter((r) => inRegion(r.branch_id)).map((r) => r.updated_by!),
      ]);
      const markedBy = namesFrom((att?.clients ?? []).flatMap((c) => c.markedBy ?? []));
      const daily = which !== "attendance" ? {
        reportDate: date,
        regionLabel: label,
        clients: cls.map((c) => ({
          client_name: c.name,
          details: details.get(c.id) ?? null,
          no_report: noReport.has(c.id),
          urgent: urgent.has(c.id),
        })),
        regions: blocks.map((blk) => ({
          label: blk.label,
          tasks: tasksOf(blk.key).map((t) => ({ title: t.title, assignee: staffName(t.assignee_employee_id), done: !!t.done_at })),
          otherUpdates: otherUpdates.get(blk.key) ?? null,
        })),
        // Only tasks set since status existed (0568/0569, 28 Oct 2026) — an
        // earlier task could not be updated, so "pending" would be false.
        openFromYesterday: prev.filter((t) => t.status === "pending" && t.report_date >= CARRY_FROM).map((t) => ({ title: t.title, assignee: staffName(t.assignee_employee_id), setOn: t.report_date === prevDay ? null : t.report_date })),
        // Tasks set before CARRY_FROM could not be given a status, so an
        // untouched "pending" there means not recorded, not still pending.
        previousTasks: prev.map((t) => ({ title: t.title, assignee: staffName(t.assignee_employee_id), status: t.report_date < CARRY_FROM && (t.status ?? "pending") === "pending" ? "Not recorded" : STATUS_LABEL[t.status ?? "pending"], note: t.status_note, setOn: t.report_date === prevDay ? null : t.report_date })),
        previousDate: prevDay,
        attendance: att,
        attendanceNotes: Object.fromEntries(gapNotes),
        preparedBy,
      } : undefined;
      const attendancePart = which !== "daily" && att && att.clients.length ? { summary: att, regionLabel: label, regionNames, markedBy, explanations: Object.fromEntries(gapNotes) } : undefined;
      return { daily, attendance: attendancePart };
    };
    let parts;
    if (regionFilter) {
      parts = [partFor(regionFilter, regionLabel)];
    } else {
      parts = regions
        .filter((r) => !r.is_head_office || clients.some((c) => c.branch_id === r.id))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => partFor(r.id, r.name))
        .filter((pt) => (pt.daily && (pt.daily.clients.length || pt.daily.previousTasks.length || pt.daily.regions.some((x) => x.tasks.length || (x.otherUpdates ?? "").trim()))) || pt.attendance);
      const orphan = partFor(null, BEFORE_SPLIT_LABEL, true);
      if ((orphan.daily && (orphan.daily.clients.length || orphan.daily.previousTasks.length || orphan.daily.regions.length)) || orphan.attendance) parts.push(orphan);
    }
    const daily = parts.some((pt) => pt.daily);
    generateOperationsPdf(company, parts, regionLabel, profile?.full_name ?? "");
    if (!daily) { setBusy(false); return; }
    const { data: userData } = await supabase.auth.getUser();
    // The export record keeps its original column names; here total_posts counts
    // the clients listed and `reported` the ones with a note written.
    const { error } = await supabase.from("daily_report_exports").insert({
      company_id: companyId,
      report_date: date,
      total_posts: visibleClients.length,
      reported: filledCount,
      silent: visibleClients.length - filledCount,
      exceptions: 0,
      generated_by: userData.user?.id ?? null,
    });
    setBusy(false);
    if (error) setErr(error.message);
  };

  const unconfirmedCount = visibleAttendance?.unconfirmed.length ?? 0;

  return (
    // Header is a SIBLING of the scroll area, not a child of it — that is what
    // makes it stay put. Inside the scrolling div its `sticky top-0` had no
    // fixed ancestor to pin against and it just scrolled away with the content.
    <>
      <Header
        title={canSeeDaily ? "Daily Reports" : "Attendance Report"}
        subtitle={canSeeDaily ? "A written note per active client, day by day, exported as a branded PDF" : "The day's attendance by client, with your explanation for anything not marked or confirmed"}
      >
        {canSeeDaily && visibleClients.length > 0 && (() => {
          // The day's notes as progress (2026-10-20): written, marked "nothing
          // to report", or still blank — so the end-of-day PDF is never sent
          // with gaps nobody noticed.
          const written = visibleClients.filter((c) => (details.get(c.id) ?? "").trim().length > 0).length;
          const none = visibleClients.filter((c) => noReport.has(c.id) && !(details.get(c.id) ?? "").trim()).length;
          const blank = Math.max(0, visibleClients.length - written - none);
          const total = visibleClients.length;
          return (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] gap-2.5">
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-2">
                <div className="flex justify-between"><span className="lbl">{isToday ? "Today's" : "This day's"} notes</span><span className="font-ledger text-sm font-semibold">{written + none} / {total}</span></div>
                <div className="flex h-3 rounded-full overflow-hidden bg-muted">
                  <span className="h-full bg-up" style={{ width: `${(written / total) * 100}%` }} />
                  <span className="h-full bg-calm" style={{ width: `${(none / total) * 100}%` }} />
                </div>
                <span className="text-xs text-muted-foreground">{blank ? `${blank} client${blank === 1 ? "" : "s"} still blank before the PDF goes out` : "Every client has a note — ready to export"}</span>
              </div>
              {[
                { label: "Written", v: written, tone: "text-up" },
                { label: "Nothing to report", v: none, tone: "text-calm" },
                { label: "Blank", v: blank, tone: blank ? "text-heed" : "text-up" },
              ].map((t) => (
                <div key={t.label} className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1"><span className="lbl">{t.label}</span><span className={`font-ledger text-2xl font-semibold leading-none ${t.tone}`}>{t.v}</span></div>
              ))}
            </div>
          );
        })()}
      </Header>

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
        {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

        <div className="space-y-3 pt-2 md:pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setDate((d) => shiftDay(d, -1))}
                className="w-8 h-8 grid place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent"
                aria-label="Previous day"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <input
                type="date"
                value={date}
                max={todayIso()}
                onChange={(e) => setDate(e.target.value || todayIso())}
                className="px-3 py-2 border border-border rounded-md text-sm bg-card"
              />
              <button
                type="button"
                onClick={() => setDate((d) => shiftDay(d, 1))}
                disabled={isToday}
                className="w-8 h-8 grid place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent disabled:opacity-40 disabled:pointer-events-none"
                aria-label="Next day"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              {!isToday && (
                <Button variant="secondary" size="sm" onClick={() => setDate(todayIso())}>
                  Today
                </Button>
              )}
              {/* Region filter. Whatever is selected here is what the page shows
                  AND what the PDF carries — the two cannot diverge because the
                  PDF is built from the same filtered list. */}
              <ThemedSelect
                value={regionFilter ?? "all"}
                onChange={(e) => setRegionFilter(e.target.value === "all" ? null : e.target.value)}
                disabled={regionLocked}
                aria-label="Region"
                className="min-w-[10rem]"
              >
                <option value="all">All regions</option>
                {regions
                  .filter((r) => !r.is_head_office)
                  .map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
              </ThemedSelect>
            </div>
            {/* The daily tab exports the daily report alone or with the
                attendance; the attendance tab exports the attendance only. */}
            <div className="inline-flex items-center rounded-lg border border-border overflow-hidden text-sm">
              <span className="px-2.5 text-xs text-muted-foreground">PDF</span>
              {(tab === "reports"
                ? ([["daily", "Daily report"], ["both", "Daily + attendance"]] as const)
                : ([["attendance", "Attendance report"]] as const)
              ).map(([k, label]) => (
                <button key={k} type="button"
                  disabled={busy || (k !== "attendance" && visibleClients.length === 0) || (k !== "daily" && !visibleAttendance?.clients.length)}
                  onClick={() => void exportPdf(k)}
                  className="px-3 py-1.5 border-l border-border hover:bg-accent disabled:opacity-40 disabled:pointer-events-none">
                  {label}
                </button>
              ))}
            </div>
          </div>

          <Tabs
            items={[
              ...(canSeeDaily ? [{ value: "reports", label: "Daily Reports", count: visibleClients.length }] : []),
              { value: "attendance", label: "Attendance Report", count: visibleAttendance?.clients.length ?? 0 },
            ]}
            value={tab}
            onChange={(v) => setTab(v as Tab)}
          />

          {tab === "reports" ? (
            <>
              {/* Next Day Tasks and Other Updates belong to the DAY and the
                  REGION (0517), not to a client, so they sit above the table —
                  one block per region. Tasks: several per day, each general or
                  assigned to an active office-staff member (0461). */}
              {prevVisible.length > 0 && (
                <div className="border border-border rounded-md p-3 bg-card space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      Previous tasks — set on {formatDate(shiftDay(date, -1))}{prevVisible.some((t) => t.report_date !== shiftDay(date, -1)) ? ", and earlier ones still open" : ""}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {date >= TASKS_REPORTED_FROM && prevVisible.some((t) => t.status_reported_on !== date) && (
                        <span className="text-down font-semibold mr-2">{prevVisible.filter((t) => t.status_reported_on !== date).length} not reported yet ·</span>
                      )}
                      {prevVisible.filter((t) => t.status === "completed").length} completed · {prevVisible.filter((t) => t.status === "in_progress").length} in progress · {prevVisible.filter((t) => t.status === "pending").length} pending
                    </span>
                  </div>
                  <ul className="divide-y divide-border">
                    {prevVisible.map((t) => (
                      <li key={t.id} className="py-2 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_9rem_16rem] md:items-center gap-2 text-sm">
                        {/* A grid, not a flex row: the select stretches to its
                            cell, so it can no longer claim the row and squeeze
                            the title to one word a line. */}
                        <span className="min-w-0 text-foreground break-words">{t.title}
                          <span className="ml-2 text-xs text-muted-foreground whitespace-nowrap">{staffName(t.assignee_employee_id) ?? "General"}</span>
                          {t.report_date !== shiftDay(date, -1) && (
                            <span className="ml-2 text-[11px] font-medium text-heed whitespace-nowrap">carried from {formatDate(t.report_date)}</span>
                          )}
                        </span>
                        {/* 0571: until reported today the select reads "Report status"
                            — choosing any status, even the same one, reports it. */}
                        <ThemedSelect value={date < TASKS_REPORTED_FROM || t.status_reported_on === date ? t.status ?? "pending" : ""} disabled={!canWriteReports} aria-label={`Status: ${t.title}`}
                          onChange={(e) => { if (e.target.value) void setTaskProgress(t.id, { status: e.target.value as TaskStatus }); }}
                          className={`w-full ${date >= TASKS_REPORTED_FROM && t.status_reported_on !== date ? "text-down font-semibold" : t.status === "completed" ? "text-up" : t.status === "in_progress" ? "text-heed" : ""}`}>
                          <option value="">Report status</option>
                          <option value="pending">Pending</option>
                          <option value="in_progress">In progress</option>
                          <option value="completed">Completed</option>
                        </ThemedSelect>
                        <input defaultValue={t.status_note ?? ""} disabled={!canWriteReports} placeholder="Remark (optional)"
                          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (t.status_note ?? "")) void setTaskProgress(t.id, { status_note: v || null }); }}
                          className="w-full px-3 py-1.5 border border-border rounded-md text-sm bg-card" />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {regionBlocks.map((blk) => (
                <div key={blk.key || "before-split"} className="space-y-2">
                  {(regionBlocks.length > 1 || blk.beforeSplit) && (
                    <h3 className="text-sm font-semibold text-foreground pt-1">{blk.label}</h3>
                  )}
                  <NextDayTasks
                    tasks={tasksOf(blk.key)}
                    staff={staff}
                    locked={locked || blk.beforeSplit}
                    loading={loading}
                    staffName={staffName}
                    onAdd={(title, assignee) => addTask(blk.key, title, assignee)}
                    onUpdate={updateTask}
                    onDelete={deleteTask}
                  />
                  <OtherUpdates
                    value={otherUpdates.get(blk.key) ?? ""}
                    locked={locked || blk.beforeSplit}
                    loading={loading}
                    saving={otherSaving.has(blk.key)}
                    savedAt={otherSavedAt.get(blk.key)}
                    onChange={(v) => setOtherUpdates((prev) => new Map(prev).set(blk.key, v))}
                    onCommit={(v) => saveOtherUpdates(blk.key, v)}
                  />
                </div>
              ))}

              <p className="text-xs text-muted-foreground">
                {formatDate(date)} · {visibleClients.length} active client
                {visibleClients.length === 1 ? "" : "s"}
                {regionLabel ? ` in ${regionLabel}` : ""} · {filledCount} with details ·{" "}
                {visibleClients.length - filledCount} no report
                {locked && (
                  <span className="ml-2 inline-flex items-center gap-1 text-warning-700 dark:text-warning-500">
                    <Lock className="w-3 h-3" /> past day — read only
                  </span>
                )}
              </p>

              {unconfirmedCount > 0 && (
                <p className="text-xs inline-flex items-center gap-1.5 text-danger-600 dark:text-danger-500">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {unconfirmedCount} client{unconfirmedCount === 1 ? "" : "s"} unconfirmed on{" "}
                  {formatDate(attendanceDate)} — see the Attendance Report tab
                </p>
              )}

              {/* Not a <table>: with only two columns, a fixed 16rem client column
                  left roughly 60px for the details box on a phone. As a grid the
                  name sits above its textarea on mobile and beside it on desktop,
                  and the textarea is always full width. */}
              <div className="border border-border rounded-md">
                <div className="hidden md:grid md:grid-cols-[16rem_1fr] bg-muted/50 dark:bg-card text-xs text-muted-foreground uppercase">
                  <div className="px-3 py-2">Client</div>
                  <div className="px-3 py-2">Details</div>
                </div>
                <div className="divide-y divide-border">
                  {visibleClients.map((c) => (
                    <DetailsRow
                      key={c.id}
                      client={c}
                      value={details.get(c.id) ?? ""}
                      noReport={noReport.has(c.id)}
                      urgent={urgent.has(c.id)}
                      onToggleUrgent={(f) => void toggleUrgent(c.id, f)}
                      locked={locked}
                      saving={saving.has(c.id)}
                      savedAt={savedAt.get(c.id)}
                      onChange={(v) => setDetails((prev) => new Map(prev).set(c.id, v))}
                      onCommit={(v) => saveOne(c.id, v, noReport.has(c.id))}
                      onToggleNoReport={(f) => toggleNoReport(c.id, f)}
                    />
                  ))}
                  {visibleClients.length === 0 && !loading && (
                    <div className="px-3 py-4 text-muted-foreground text-sm">
                      {clients.length === 0
                        ? "No clients with an active contract."
                        : "No active clients in this region."}
                    </div>
                  )}
                  {loading && (
                    <div className="px-3 py-4 text-muted-foreground text-sm">
                      <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <AttendanceReport
              summary={visibleAttendance}
              loading={attLoading}
              date={attendanceDate}
              regionLabel={regionLabel}
              regionNames={Object.fromEntries(regions.map((r) => [r.id, r.name]))}
              notes={gapNotes}
              canExplain={canExplainAttendance}
              onExplain={(cid, v) => void saveGapNote(cid, v)}
            />
          )}

          <Modal isOpen={!!blocked} onClose={() => setBlocked(null)} title="Not ready to export" size="md"
            footer={<Button onClick={() => setBlocked(null)}>OK</Button>}>
            <div className="space-y-4 text-sm">
              {!!blocked?.tasks.length && (
                <div>
                  <p className="font-semibold text-down mb-1">
                    {blocked.tasks.length} previous task{blocked.tasks.length === 1 ? " has" : "s have"} not been reported today
                  </p>
                  <p className="text-muted-foreground mb-1.5">Set each one's status — Pending, In progress or Completed — under "Previous tasks" on the Daily Reports tab.</p>
                  <ul className="list-disc ml-5 space-y-0.5">
                    {blocked.tasks.map((t) => <li key={t.id}>{t.title}{t.report_date !== shiftDay(date, -1) ? <span className="text-muted-foreground"> (set {formatDate(t.report_date)})</span> : null}</li>)}
                  </ul>
                </div>
              )}
              {!!blocked?.gaps.length && (
                <div>
                  <p className="font-semibold text-down mb-1">
                    {blocked.gaps.length} client{blocked.gaps.length === 1 ? "'s" : "s'"} attendance for {formatDate(attendanceDate)} not explained
                  </p>
                  <p className="text-muted-foreground mb-1.5">Not confirmed or guards left unmarked — HR writes why, on the Attendance Report tab.</p>
                  <ul className="list-disc ml-5 space-y-0.5">
                    {blocked.gaps.map((c) => <li key={c.client_id}>{c.client_name}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </Modal>
        </div>
      </div>
    </>
  );
}

/**
 * The day's Next Day Tasks: a list, each row a task with its assignee. The
 * assignee picker lists ACTIVE OFFICE STAFF only — "General" is the absence of
 * an assignee, not a person. The database enforces the same rule (0461), so a
 * refusal comes back as an error rather than a silent success.
 */
function NextDayTasks({
  tasks, staff, locked, loading, staffName, onAdd, onUpdate, onDelete,
}: {
  tasks: TaskRow[];
  staff: StaffRow[];
  locked: boolean;
  loading: boolean;
  staffName: (id: string | null) => string | null;
  onAdd: (title: string, assignee: string | null) => Promise<boolean>;
  onUpdate: (id: string, patch: Partial<Pick<TaskRow, "title" | "assignee_employee_id">>) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [draftAssignee, setDraftAssignee] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const submit = async () => {
    if (!draft.trim() || adding) return;
    setAdding(true);
    const ok = await onAdd(draft, draftAssignee);
    setAdding(false);
    if (ok) setDraft("");
  };

  const assigneeSelect = (value: string | null, onChange: (v: string | null) => void) => (
    <ThemedSelect
      value={value ?? "general"}
      onChange={(e) => onChange(e.target.value === "general" ? null : e.target.value)}
      aria-label="Assign to"
      className="w-full sm:w-52 shrink-0"
    >
      <option value="general">General</option>
      {/* A task whose assignee has since left keeps showing who it was for. */}
      {value && !staff.some((x) => x.id === value) && (
        <option value={value}>{staffName(value)}</option>
      )}
      {staff.map((x) => (
        <option key={x.id} value={x.id}>
          {x.full_name}{x.employee_code ? ` · ${x.employee_code}` : ""}
        </option>
      ))}
    </ThemedSelect>
  );

  return (
    <div className="border border-border rounded-md p-3 bg-card space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
          Next Day Tasks
        </span>
        <span className="text-[11px] text-muted-foreground">
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </span>
      </div>

      {loading ? null : tasks.length === 0 && locked ? (
        <p className="text-sm text-muted-foreground">—</p>
      ) : (
        <ul className="space-y-1.5">
          {tasks.map((t, i) => (
            <li key={t.id} className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2">
              <span className="text-xs text-muted-foreground w-5 shrink-0 hidden sm:inline">{i + 1}.</span>
              {locked ? (
                <>
                  <span className="flex-1 min-w-0 text-sm text-foreground">{t.title}</span>
                  <span className="text-xs text-muted-foreground sm:w-52 shrink-0">
                    {staffName(t.assignee_employee_id) ?? "General"}
                  </span>
                </>
              ) : (
                <>
                  <input
                    defaultValue={t.title}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (!v) { e.target.value = t.title; return; }
                      if (v !== t.title) onUpdate(t.id, { title: v });
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    className="flex-1 min-w-0 px-3 py-1.5 border border-border rounded-md text-sm bg-card"
                  />
                  <div className="flex items-center gap-2">
                    {assigneeSelect(t.assignee_employee_id, (v) => onUpdate(t.id, { assignee_employee_id: v }))}
                    <button
                      type="button"
                      onClick={() => onDelete(t.id)}
                      className="w-8 h-8 grid place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-danger-600 shrink-0"
                      aria-label="Delete task"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {!locked && !loading && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 pt-1">
          <span className="w-5 shrink-0 hidden sm:inline" />
          <input
            value={draft}
            placeholder="Add a task for tomorrow…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
            className="flex-1 min-w-0 px-3 py-1.5 border border-border rounded-md text-sm bg-card"
          />
          <div className="flex items-center gap-2">
            {assigneeSelect(draftAssignee, setDraftAssignee)}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!draft.trim() || adding}
              className="w-8 h-8 grid place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent disabled:opacity-40 disabled:pointer-events-none shrink-0"
              aria-label="Add task"
            >
              {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-4 h-4" />}
            </button>
          </div>
        </div>
      )}
      {!locked && !loading && staff.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          No active office staff found — tasks can only be added as General.
        </p>
      )}
    </div>
  );
}

/**
 * One client's line. Keeps its own draft while focused so a reload of the day's
 * saved values cannot yank half-typed text out from under the cursor, and only
 * writes on blur.
 */
function DetailsRow({
  client, value, noReport, urgent, onToggleUrgent, locked, saving, savedAt, onChange, onCommit, onToggleNoReport,
}: {
  client: ClientRow;
  value: string;
  noReport: boolean;
  urgent: boolean;
  onToggleUrgent: (flag: boolean) => void;
  locked: boolean;
  saving: boolean;
  savedAt: number | undefined;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
  onToggleNoReport: (flag: boolean) => void;
}) {
  const committed = useRef(value);
  useEffect(() => { committed.current = value; }, [client.id]);

  return (
    <div className="md:grid md:grid-cols-[16rem_1fr] md:items-start">
      <div className="px-3 pt-2 md:py-2 text-foreground font-medium text-sm md:whitespace-nowrap md:truncate">
        {client.name}
        {urgent && <span className="ml-2 inline-flex rounded-full border border-down/40 bg-down/15 px-1.5 py-0.5 text-[10px] font-semibold text-down align-middle">Urgent</span>}
      </div>
      <div className="px-3 pb-2 pt-1 md:py-2">
        {locked ? (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {noReport ? "No report" : value.trim() || "—"}
          </p>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-start gap-2">
              <textarea
                rows={2}
                value={noReport ? "" : value}
                disabled={noReport}
                placeholder={noReport ? "No report for this client today" : "Details for this client today…"}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => bulletOnEnter(e, onChange)}
                onBlur={(e) => {
                  // Nothing typed since the last save = nothing to write.
                  if (e.target.value === committed.current) return;
                  committed.current = e.target.value;
                  onCommit(e.target.value);
                }}
                className="flex-1 min-w-0 px-3 py-2 border border-border rounded-md text-sm bg-card resize-y min-h-[38px] disabled:bg-secondary disabled:text-muted-foreground disabled:cursor-not-allowed"
              />
              <span className="text-[11px] text-muted-foreground pt-2.5 w-12 shrink-0">
                {saving ? "saving…" : savedAt ? "saved" : ""}
              </span>
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer">
              <input
                type="checkbox"
                checked={noReport}
                onChange={(e) => {
                  // The box's draft is discarded on the way in, so the flag and
                  // the text can never both be claiming something.
                  committed.current = "";
                  onToggleNoReport(e.target.checked);
                }}
                className="w-3.5 h-3.5 accent-brand-500"
              />
              No Report
            </label>
            {/* 0568: an urgent note leads the PDF and is listed under Needs attention. */}
            <label className={`ml-4 inline-flex items-center gap-2 text-xs select-none ${noReport || !value.trim() ? "text-muted-foreground/50 cursor-not-allowed" : "text-down cursor-pointer"}`}>
              <input
                type="checkbox"
                checked={urgent}
                disabled={noReport || !value.trim()}
                onChange={(e) => onToggleUrgent(e.target.checked)}
                className="w-3.5 h-3.5 accent-brand-500"
              />
              Urgent
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One region's Other Updates for the day (0475, per region since 0517) — not one
 * per client. Keeps its own "last saved" value so a blur with nothing changed
 * writes nothing.
 */
function OtherUpdates({
  value, locked, loading, saving, savedAt, onChange, onCommit,
}: {
  value: string;
  locked: boolean;
  loading: boolean;
  saving: boolean;
  savedAt: number | undefined;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
}) {
  const committed = useRef(value);
  // A reload (another day, or the same day refetched) resets what "unchanged" means.
  useEffect(() => { if (!loading) committed.current = value; }, [loading]);

  return (
    <div className="border border-border rounded-md p-3 bg-card space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
          Other Updates
        </span>
        <span className="text-[11px] text-muted-foreground">
          {saving ? "saving…" : savedAt ? "saved" : ""}
        </span>
      </div>
      {loading ? null : locked ? (
        <p className="text-sm text-foreground whitespace-pre-wrap">{value.trim() || "—"}</p>
      ) : (
        <textarea
          rows={3}
          value={value}
          placeholder="Anything else for today's report…"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => bulletOnEnter(e, onChange)}
          onBlur={(e) => {
            if (e.target.value === committed.current) return;
            committed.current = e.target.value;
            onCommit(e.target.value);
          }}
          className="w-full px-3 py-2 border border-border rounded-md text-sm bg-card resize-y min-h-[60px]"
        />
      )}
    </div>
  );
}

/**
 * The Attendance Report tab (rebuilt 2026-10-28, the same reading as the PDF):
 * one line saying how the day went, the clients grouped by region with
 * subtotals and an Unmarked column (deployed with no mark at all — counted as
 * present by the figures, shown so a blank register is never read as full),
 * absentees and leave by name on opening a row, and the clients nobody
 * confirmed. It reads the day BEFORE the report's date.
 */
function AttendanceReport({
  summary, loading, date, regionLabel, regionNames, notes, canExplain, onExplain,
}: {
  summary: AttendanceSummary | null;
  loading: boolean;
  date: string;
  regionLabel: string | null;
  regionNames: Record<string, string>;
  /** 0571: HR's explanation per gap client. */
  notes: Map<string, string>;
  canExplain: boolean;
  onExplain: (clientId: string, text: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (loading) {
    return (
      <div className="border border-border rounded-xl px-4 py-6 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading attendance…
      </div>
    );
  }
  if (!summary || summary.clients.length === 0) {
    return (
      <div className="border border-dashed border-border rounded-xl px-4 py-8 text-center text-muted-foreground text-sm">
        No guards deployed on {formatDate(date)}{regionLabel ? ` in ${regionLabel}` : ""}.
      </div>
    );
  }
  const t = summary.totals;
  const un = (c: AttendanceSummary["clients"][number]) => Math.max(0, c.deployed - c.marked);
  const totalUn = summary.clients.reduce((n, c) => n + un(c), 0);
  const present = t.present - totalUn;
  const pct = t.deployed ? Math.round((present / t.deployed) * 1000) / 10 : 0;
  const confirmed = summary.clients.length - summary.unconfirmed.length;
  const groups = new Map<string, AttendanceSummary["clients"]>();
  for (const c of [...summary.clients].sort((a, b) => a.client_name.localeCompare(b.client_name))) {
    const k = c.branch_id ?? "";
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const num = "px-3 py-2 text-right font-ledger";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
        {[
          { k: "Deployed", v: String(t.deployed), tone: "" },
          { k: "Present", v: `${present}`, sub: `${pct}%`, tone: "text-up" },
          { k: "Absent", v: String(t.absent), tone: t.absent ? "text-down" : "" },
          { k: "Leave", v: String(t.leave), tone: "" },
          { k: "Confirmed", v: `${confirmed}/${summary.clients.length}`, tone: summary.unconfirmed.length ? "text-heed" : "text-up" },
        ].map((x) => (
          <div key={x.k} className="rounded-xl border border-border bg-card px-4 py-3">
            <span className="lbl">{x.k}</span>
            <div className={`font-ledger text-2xl font-semibold leading-tight ${x.tone}`}>{x.v}{x.sub && <span className="ml-1.5 text-xs text-muted-foreground font-normal">{x.sub}</span>}</div>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {formatDate(date)} — the day before this report{regionLabel ? ` · ${regionLabel}` : ""}.
        {totalUn ? <span className="text-down"> {totalUn} deployed guard{totalUn === 1 ? " has" : "s have"} no mark at all.</span> : null}
      </p>

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Client</th>
              <th className="text-right px-3 py-2 font-medium">Deployed</th>
              <th className="text-right px-3 py-2 font-medium">Present</th>
              <th className="text-right px-3 py-2 font-medium">Absent</th>
              <th className="text-right px-3 py-2 font-medium">Leave</th>
              <th className="text-right px-3 py-2 font-medium">Unmarked</th>
              <th className="text-left px-3 py-2 font-medium">Confirmed</th>
            </tr>
          </thead>
          {[...groups.entries()].map(([bid, rows]) => {
            const sub = rows.reduce((a, c) => ({ d: a.d + c.deployed, p: a.p + c.present - un(c), ab: a.ab + c.absent, l: a.l + c.leave, u: a.u + un(c) }), { d: 0, p: 0, ab: 0, l: 0, u: 0 });
            return (
              <tbody key={bid} className="divide-y divide-border border-t border-border">
                {groups.size > 1 && (
                  <tr className="bg-muted/30"><td colSpan={7} className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">{regionNames[bid] ?? "No region"}</td></tr>
                )}
                {rows.map((c) => {
                  const names = (c.absentees?.length ?? 0) + (c.onLeave?.length ?? 0);
                  const isOpen = open === c.client_id;
                  return (
                    <Fragment key={c.client_id}>
                      <tr className={`${!c.confirmed ? "bg-down/5" : ""} ${names ? "cursor-pointer hover:bg-muted/40" : ""}`} onClick={() => names && setOpen(isOpen ? null : c.client_id)}>
                        <td className="px-3 py-2 text-foreground">
                          {names ? (isOpen ? <ChevronDown className="w-3.5 h-3.5 inline mr-1 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 inline mr-1 text-muted-foreground" />) : <span className="inline-block w-[18px]" />}
                          {c.client_name}
                        </td>
                        <td className={num}>{c.deployed}</td>
                        <td className={num}>{c.present - un(c)}</td>
                        <td className={`${num} ${c.absent ? "text-down" : ""}`}>{c.absent}</td>
                        <td className={num}>{c.leave}</td>
                        <td className={`${num} ${un(c) ? "text-down font-semibold" : "text-muted-foreground"}`}>{un(c)}</td>
                        <td className="px-3 py-2">
                          {c.confirmed
                            ? <span className="text-xs text-up">{c.confirmed_by ?? "Yes"}</span>
                            : <span className="text-xs font-semibold text-down">{c.partial ? `Partly ${c.sites.filter((x) => x.confirmed).length}/${c.sites.length}` : "Not confirmed"}</span>}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-muted/20">
                          <td colSpan={7} className="px-9 py-2 text-xs space-y-1">
                            {c.absentees?.length ? <div><span className="text-muted-foreground">Absent: </span>{c.absentees.map((g) => g.code ? `${g.name} (${g.code})` : g.name).join(", ")}</div> : null}
                            {c.onLeave?.length ? <div><span className="text-muted-foreground">Leave: </span>{c.onLeave.map((g) => g.code ? `${g.name} (${g.code})` : g.name).join(", ")}</div> : null}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {groups.size > 1 && (
                  <tr className="text-muted-foreground italic">
                    <td className="px-3 py-1.5 text-xs">Subtotal</td>
                    <td className={num}>{sub.d}</td><td className={num}>{sub.p}</td><td className={num}>{sub.ab}</td><td className={num}>{sub.l}</td><td className={num}>{sub.u}</td><td />
                  </tr>
                )}
              </tbody>
            );
          })}
          <tfoot>
            <tr className="border-t-2 border-border font-semibold">
              <td className="px-3 py-2">Total</td>
              <td className={num}>{t.deployed}</td><td className={num}>{present}</td><td className={num}>{t.absent}</td><td className={num}>{t.leave}</td><td className={num}>{totalUn}</td>
              <td className="px-3 py-2 text-xs">{confirmed} of {summary.clients.length}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 0571: HR explains every gap — not confirmed, or guards left
          unmarked; a fully marked, confirmed client needs nothing. Printed
          beside the gap in the attendance report. */}
      {(() => {
        const gaps = summary.clients.filter(isGap).sort((a, b) => a.client_name.localeCompare(b.client_name));
        if (!gaps.length) return null;
        const missing = gaps.filter((c) => !(notes.get(c.client_id) ?? "").trim()).length;
        return (
          <div className="rounded-xl border border-down/40 bg-down/5 px-4 py-3 space-y-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm font-semibold text-down">Not confirmed or not fully marked · {gaps.length}</div>
              <div className={`text-xs ${missing ? "text-down font-semibold" : "text-up"}`}>
                {missing ? `${missing} still need${missing === 1 ? "s" : ""} HR's explanation before export` : "Every gap explained"}
              </div>
            </div>
            <ul className="space-y-2.5">
              {gaps.map((c) => {
                const unmarked = Math.max(0, c.deployed - c.marked);
                const what = [!c.confirmed ? (c.partial ? describeUnconfirmed(c) : `${c.client_name} — not confirmed`) : c.client_name, unmarked ? `${unmarked} guard${unmarked === 1 ? "" : "s"} unmarked` : ""].filter(Boolean).join(" — ");
                return (
                  <li key={c.client_id} className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-1.5 md:gap-3 md:items-start">
                    <span className="text-sm text-foreground pt-1.5">{what}</span>
                    <textarea key={`${date}:${c.client_id}`} defaultValue={notes.get(c.client_id) ?? ""} disabled={!canExplain} rows={1}
                      placeholder={canExplain ? "Why? (HR's explanation — required)" : "Awaiting HR's explanation"}
                      onBlur={(e) => onExplain(c.client_id, e.target.value)}
                      className={`w-full px-3 py-1.5 border rounded-md text-sm bg-card resize-y ${(notes.get(c.client_id) ?? "").trim() ? "border-border" : "border-down/60"}`} />
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })()}
    </div>
  );
}
