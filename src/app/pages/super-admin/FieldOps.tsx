import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Lock } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Tabs from "../../components/Tabs";
import ThemedSelect from "../../components/ThemedSelect";
import { useAuth, hasPermission } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { useRegion } from "../../lib/region";
import { formatDate } from "../../lib/date";
import { generateDailyOperationsReportPdf } from "../../lib/dailyReportPdf";
import { describeUnconfirmed, loadAttendanceSummary, type AttendanceSummary } from "../../lib/attendanceSummary";

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
//   * a day-level NEXT DAY TASK, printed at the head of the PDF.
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
  const companyId = company?.id ?? "";
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("reports");

  const [date, setDate] = useState(todayIso());
  // Page-level region filter, seeded from the app-wide selector. A user pinned
  // to one region cannot widen it — the page filter narrows, it never grants.
  const [regionFilter, setRegionFilter] = useState<string | null>(globalRegionId);
  useEffect(() => { setRegionFilter(globalRegionId); }, [globalRegionId]);

  const [clients, setClients] = useState<ClientRow[]>([]);
  /** client_id -> details, for the selected day. */
  const [details, setDetails] = useState<Map<string, string>>(new Map());
  /** client_id -> "no report" flag, for the selected day. */
  const [noReport, setNoReport] = useState<Set<string>>(new Set());
  const [nextDayTask, setNextDayTask] = useState("");
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
    const [cli, rep, dayNote] = await Promise.all([
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
        .select("client_id, details, no_report")
        .eq("company_id", companyId)
        .eq("report_date", date),
      supabase
        .from("daily_report_day_notes")
        .select("next_day_task")
        .eq("company_id", companyId)
        .eq("report_date", date)
        .maybeSingle(),
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
    setNextDayTask(((dayNote.data as any)?.next_day_task ?? "") as string);
    setLoading(false);
  }, [companyId, date]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    if (!companyId) return;
    setAttLoading(true);
    // Unfiltered here; the region cut is applied below so switching regions
    // doesn't re-query the day.
    loadAttendanceSummary(companyId, attendanceDate)
      .then((s) => { if (!cancelled) { setAttendance(s); setAttLoading(false); } })
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
  const saveOne = async (clientId: string, value: string, flag: boolean) => {
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

  const toggleNoReport = async (clientId: string, flag: boolean) => {
    setNoReport((prev) => {
      const n = new Set(prev);
      if (flag) n.add(clientId); else n.delete(clientId);
      return n;
    });
    if (flag) setDetails((prev) => new Map(prev).set(clientId, ""));
    await saveOne(clientId, flag ? "" : details.get(clientId) ?? "", flag);
  };

  const saveNextDayTask = async (value: string) => {
    if (locked) return;
    setErr(null);
    const text = value.trim();
    const { data: userData } = await supabase.auth.getUser();
    const { error } = text
      ? await supabase.from("daily_report_day_notes").upsert(
          {
            company_id: companyId,
            report_date: date,
            next_day_task: text,
            updated_by: userData.user?.id ?? null,
          },
          { onConflict: "company_id,report_date" },
        )
      : await supabase
          .from("daily_report_day_notes")
          .delete()
          .eq("company_id", companyId)
          .eq("report_date", date);
    if (error) setErr(error.message);
  };

  /** The clients the page — and therefore the PDF — is showing. */
  const visibleClients = useMemo(
    () => (regionFilter ? clients.filter((c) => c.branch_id === regionFilter) : clients),
    [clients, regionFilter],
  );
  const regionLabel = useMemo(
    () => (regionFilter ? regions.find((r) => r.id === regionFilter)?.name ?? "Region" : null),
    [regionFilter, regions],
  );

  /** The attendance summary, cut to the same region as the client list. */
  const visibleAttendance = useMemo<AttendanceSummary | null>(() => {
    if (!attendance) return null;
    if (!regionFilter) return attendance;
    const rows = attendance.clients.filter((c) => c.branch_id === regionFilter);
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
  }, [attendance, regionFilter]);

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

  const exportPdf = async () => {
    generateDailyOperationsReportPdf(company, date, rowsForPdf, {
      regionLabel,
      nextDayTask,
      attendance: visibleAttendance,
    });
    setBusy(true);
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
        title="Daily Reports"
        subtitle="A written note per active client, day by day, exported as a branded PDF"
      />

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
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || visibleClients.length === 0}
              onClick={exportPdf}
            >
              Download PDF
            </Button>
          </div>

          <Tabs
            items={[
              { value: "reports", label: "Daily Reports", count: visibleClients.length },
              { value: "attendance", label: "Attendance Report", count: visibleAttendance?.clients.length ?? 0 },
            ]}
            value={tab}
            onChange={(v) => setTab(v as Tab)}
          />

          {tab === "reports" ? (
            <>
              {/* Next Day Task is a property of the DAY, not of a client, so it
                  sits above the table and is stored once (0460). */}
              <div className="border border-border rounded-md p-3 bg-card space-y-1.5">
                <label className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  Next Day Task
                </label>
                {locked ? (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                    {nextDayTask.trim() || "—"}
                  </p>
                ) : loading ? null : (
                  <NextDayTaskField
                    key={date}
                    value={nextDayTask}
                    onChange={setNextDayTask}
                    onCommit={saveNextDayTask}
                  />
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {formatDate(date)} · {visibleClients.length} active client
                {visibleClients.length === 1 ? "" : "s"}
                {regionLabel ? ` in ${regionLabel}` : ""} · {filledCount} with details ·{" "}
                {visibleClients.length - filledCount} no report
                {locked && (
                  <span className="ml-2 inline-flex items-center gap-1 text-amber-700 dark:text-amber-500">
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
                <div className="hidden md:grid md:grid-cols-[16rem_1fr] bg-slate-50 dark:bg-card text-xs text-muted-foreground uppercase">
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
            />
          )}
        </div>
      </div>
    </>
  );
}

/** The day's Next Day Task. Enter bullets, blur saves. */
function NextDayTaskField({
  value, onChange, onCommit,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
}) {
  const committed = useRef(value);
  // The saved value arrives after the day loads; adopt it so blurring an
  // untouched field doesn't write back what it just read.
  useEffect(() => { committed.current = value; /* eslint-disable-next-line */ }, []);

  return (
    <textarea
      rows={2}
      value={value}
      placeholder="What has to happen tomorrow…"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => bulletOnEnter(e, onChange)}
      onBlur={(e) => {
        if (e.target.value === committed.current) return;
        committed.current = e.target.value;
        onCommit(e.target.value);
      }}
      className="w-full px-3 py-2 border border-border rounded-md text-sm bg-card resize-y min-h-[38px]"
    />
  );
}

/**
 * One client's line. Keeps its own draft while focused so a reload of the day's
 * saved values cannot yank half-typed text out from under the cursor, and only
 * writes on blur.
 */
function DetailsRow({
  client, value, noReport, locked, saving, savedAt, onChange, onCommit, onToggleNoReport,
}: {
  client: ClientRow;
  value: string;
  noReport: boolean;
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
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Attendance Report tab: the same summary the PDF prints, for the day BEFORE
 * the report's date. Unconfirmed clients sort to the top and are tinted — the
 * point of the tab is the ones nobody signed off, not the ones who did.
 */
function AttendanceReport({
  summary, loading, date, regionLabel,
}: {
  summary: AttendanceSummary | null;
  loading: boolean;
  date: string;
  regionLabel: string | null;
}) {
  if (loading) {
    return (
      <div className="border border-border rounded-md px-3 py-4 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading attendance…
      </div>
    );
  }
  if (!summary || summary.clients.length === 0) {
    return (
      <div className="border border-border rounded-md px-3 py-4 text-muted-foreground text-sm">
        No guards deployed on {formatDate(date)}
        {regionLabel ? ` in ${regionLabel}` : ""}.
      </div>
    );
  }

  const t = summary.totals;
  const confirmed = summary.clients.length - summary.unconfirmed.length;
  const partial = summary.unconfirmed.filter((c) => c.partial).length;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Attendance for {formatDate(date)} — the day before this report
        {regionLabel ? ` · ${regionLabel}` : ""} · {summary.clients.length} client
        {summary.clients.length === 1 ? "" : "s"} · {confirmed} confirmed,{" "}
        {partial > 0 ? `${partial} partly, ` : ""}
        {summary.unconfirmed.length - partial} not
      </p>

      {summary.unconfirmed.length > 0 && (
        <div className="border border-danger-200 bg-danger-50 dark:bg-danger-500/10 rounded-md px-3 py-2">
          <p className="text-sm font-medium text-danger-700 dark:text-danger-500 inline-flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4" />
            Attendance not confirmed — {summary.unconfirmed.length} client
            {summary.unconfirmed.length === 1 ? "" : "s"}
          </p>
          <p className="text-xs text-danger-700/80 dark:text-danger-500/80 mt-1">
            {summary.unconfirmed.filter((c) => !c.partial).map((c) => c.client_name).join(", ")}
          </p>
          {/* Partly confirmed clients get a line each, naming the open sites —
              a client-level "not confirmed" would send someone to re-check the
              sites that are already done. */}
          {summary.unconfirmed.filter((c) => c.partial).map((c) => (
            <p key={c.client_id} className="text-xs text-danger-700/80 dark:text-danger-500/80 mt-1">
              {describeUnconfirmed(c)}
            </p>
          ))}
        </div>
      )}

      <div className="border border-border rounded-md overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-card text-xs text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Client</th>
              <th className="px-3 py-2 text-right font-medium">Deployed</th>
              <th className="px-3 py-2 text-right font-medium">Present</th>
              <th className="px-3 py-2 text-right font-medium">Absent</th>
              <th className="px-3 py-2 text-right font-medium">Leave</th>
              <th className="px-3 py-2 text-right font-medium">Other</th>
              <th className="px-3 py-2 text-left font-medium">Attendance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {summary.clients.map((c) => (
              <tr key={c.client_id} className={c.confirmed ? "" : "bg-danger-50/60 dark:bg-danger-500/10"}>
                <td className="px-3 py-2 text-foreground">{c.client_name}</td>
                <td className="px-3 py-2 text-right tabular-nums">{c.deployed}</td>
                <td className="px-3 py-2 text-right tabular-nums">{c.present}</td>
                <td className="px-3 py-2 text-right tabular-nums">{c.absent}</td>
                <td className="px-3 py-2 text-right tabular-nums">{c.leave}</td>
                <td className="px-3 py-2 text-right tabular-nums">{c.other}</td>
                <td className="px-3 py-2">
                  {c.confirmed ? (
                    <span className="inline-flex items-center gap-1.5 text-success-700 dark:text-success-500 text-xs">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Confirmed{c.confirmed_by ? ` · ${c.confirmed_by}` : ""}
                    </span>
                  ) : c.partial ? (
                    <div className="space-y-0.5">
                      <span className="inline-flex items-center gap-1.5 text-warning-700 dark:text-warning-500 text-xs font-medium">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Partly confirmed · {c.sites.filter((x) => x.confirmed).length}/{c.sites.length} sites
                      </span>
                      <ul className="text-xs space-y-0.5 pl-5">
                        {c.sites.map((site) => (
                          <li
                            key={site.site_id ?? "none"}
                            className={site.confirmed ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500 font-medium"}
                          >
                            {site.site_name} —{" "}
                            {site.confirmed
                              ? `confirmed${site.confirmed_by ? ` · ${site.confirmed_by}` : ""}`
                              : "not confirmed"}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-danger-700 dark:text-danger-500 text-xs font-medium">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Not confirmed
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {/* The collective line. Summed from the rows displayed above it — the
              one place arithmetic belongs on a reporting screen. */}
          <tfoot className="bg-slate-50 dark:bg-card font-medium">
            <tr>
              <td className="px-3 py-2">All clients</td>
              <td className="px-3 py-2 text-right tabular-nums">{t.deployed}</td>
              <td className="px-3 py-2 text-right tabular-nums">{t.present}</td>
              <td className="px-3 py-2 text-right tabular-nums">{t.absent}</td>
              <td className="px-3 py-2 text-right tabular-nums">{t.leave}</td>
              <td className="px-3 py-2 text-right tabular-nums">{t.other}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {confirmed}/{summary.clients.length} confirmed
                {partial > 0 ? ` · ${partial} partly` : ""}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
