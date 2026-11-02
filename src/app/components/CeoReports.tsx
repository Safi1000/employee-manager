import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useRegion } from "../lib/region";
import { loadAttendanceSummary, type AttendanceSummary } from "../lib/attendanceSummary";
import { loadStaffChanges, staffForRegion, type StaffChanges } from "../lib/staffChanges";
import { REPORTS_BUCKET, type ReportKind } from "../lib/reportArchive";
import { openRemoteFile } from "../lib/saveFile";
import { AttendanceReport } from "../pages/super-admin/FieldOps";
import StaffChangesPanel from "./StaffChangesPanel";

/**
 * The CEO dashboard's report screens (DECIDED 2 Nov 2026: "proper tabs and
 * screens in it directly", not a PDF viewer). Each reads the same records its
 * report is printed from, read-only, for any day. The last PDF actually sent
 * (0633) is one link above, for when the exact copy matters.
 */

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (day: string, n: number) => { const d = new Date(`${day}T00:00:00`); d.setDate(d.getDate() + n); return iso(d); };
const longDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const when = (t: string) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** "Last sent 2 Nov, 22:12 by Gul Rahman · Open PDF" — the kept copy (0633). */
export function LastSent({ kinds }: { kinds: ReportKind[] }) {
  const [row, setRow] = useState<{ file_path: string; exported_at: string; exported_by_name: string | null; region_label: string | null } | null>(null);
  useEffect(() => {
    void supabase.rpc("report_exports_list", { p_kinds: kinds, p_limit: 1 }).then(({ data }) => setRow(((data ?? []) as any[])[0] ?? null));
  }, [kinds.join(",")]);
  if (!row) return <p className="text-xs text-muted-foreground">Not sent yet since reports started being kept.</p>;
  const open = async () => {
    const { data } = await supabase.storage.from(REPORTS_BUCKET).createSignedUrl(row.file_path, 600);
    if (data?.signedUrl) void openRemoteFile(data.signedUrl);
  };
  return (
    <p className="text-xs text-muted-foreground">
      Last sent {when(row.exported_at)}{row.exported_by_name ? ` by ${row.exported_by_name}` : ""}{row.region_label ? ` · ${row.region_label}` : ""} ·{" "}
      <button type="button" onClick={() => void open()} className="inline-flex items-center gap-0.5 text-brand-700 dark:text-brand-500 hover:underline"><ExternalLink className="w-3 h-3" />Open the PDF</button>
    </p>
  );
}

function DayPicker({ day, setDay, max }: { day: string; setDay: (d: string) => void; max: string }) {
  return (
    <div className="inline-flex items-center gap-1">
      <button type="button" className="p-1.5 rounded-lg border border-border bg-card hover:bg-muted" onClick={() => setDay(shift(day, -1))} aria-label="Previous day"><ChevronLeft className="w-4 h-4" /></button>
      <input type="date" value={day} max={max} onChange={(e) => e.target.value && setDay(e.target.value)} className="px-2 py-1 rounded-lg border border-border bg-card text-sm" />
      <button type="button" className="p-1.5 rounded-lg border border-border bg-card hover:bg-muted disabled:opacity-40" disabled={day >= max} onClick={() => setDay(shift(day, 1))} aria-label="Next day"><ChevronRight className="w-4 h-4" /></button>
    </div>
  );
}

function Block({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="border border-border rounded-xl bg-card">
      <h3 className="px-4 py-2.5 border-b border-border font-semibold text-foreground">{n}. {title}</h3>
      <div className="px-4 py-3 text-sm">{children}</div>
    </section>
  );
}
const Nil = ({ text = "Nil." }: { text?: string }) => <p className="italic text-muted-foreground">{text}</p>;

// ───────────────────────── Daily Operations ─────────────────────────
type Task = { id: string; title: string; assignee_employee_id: string | null; branch_id: string | null; status: string | null; status_note: string | null; report_date: string; done_at: string | null };
const STATUS: Record<string, string> = { pending: "Pending", in_progress: "In progress", completed: "Completed" };

export function DailyOpsView() {
  const { company } = useAuth();
  const { regionId, regions } = useRegion();
  const today = iso(new Date());
  const [day, setDay] = useState(today);
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState<{ id: string; name: string; branch_id: string | null }[]>([]);
  const [notes, setNotes] = useState<Map<string, { details: string; no_report: boolean; urgent: boolean }>>(new Map());
  const [updates, setUpdates] = useState<{ branch_id: string | null; other_updates: string | null }[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [prev, setPrev] = useState<Task[]>([]);
  const [staff, setStaff] = useState<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    if (!company?.id) return;
    setLoading(true);
    const cols = "id, title, assignee_employee_id, branch_id, status, status_note, report_date, done_at";
    const [c, r, u, t, p, s] = await Promise.all([
      supabase.from("clients").select("id, name, branch_id, contracts!inner(id, status)").eq("company_id", company.id).eq("contracts.status", "active").order("name"),
      supabase.from("daily_client_reports").select("client_id, details, no_report, urgent").eq("company_id", company.id).eq("report_date", day),
      supabase.from("daily_report_day_notes").select("branch_id, other_updates").eq("company_id", company.id).eq("report_date", day),
      supabase.from("daily_report_tasks").select(cols).eq("company_id", company.id).eq("report_date", day).order("sort_order"),
      supabase.from("daily_report_tasks").select(cols).eq("company_id", company.id).eq("report_date", shift(day, -1)).order("sort_order"),
      supabase.from("employees").select("id, full_name").eq("company_id", company.id).eq("category", "office_staff"),
    ]);
    const seen = new Map<string, { id: string; name: string; branch_id: string | null }>();
    for (const x of (c.data ?? []) as any[]) if (!seen.has(x.id)) seen.set(x.id, { id: x.id, name: x.name, branch_id: x.branch_id });
    setClients([...seen.values()]);
    setNotes(new Map(((r.data ?? []) as any[]).map((x) => [x.client_id, { details: x.details ?? "", no_report: !!x.no_report, urgent: !!x.urgent }])));
    setUpdates((u.data ?? []) as any[]);
    setTasks((t.data ?? []) as Task[]);
    setPrev((p.data ?? []) as Task[]);
    setStaff(new Map(((s.data ?? []) as any[]).map((x) => [x.id, x.full_name])));
    setLoading(false);
  }, [company?.id, day]);
  useEffect(() => { void load(); }, [load]);

  const inRegion = (b: string | null) => !regionId || b === regionId;
  const shown = clients.filter((c) => inRegion(c.branch_id));
  const withNote = shown.filter((c) => { const x = notes.get(c.id); return x && !x.no_report && x.details.trim(); })
    .sort((a, b) => Number(!!notes.get(b.id)?.urgent) - Number(!!notes.get(a.id)?.urgent) || a.name.localeCompare(b.name));
  const nil = shown.filter((c) => !withNote.includes(c));
  const urgent = withNote.filter((c) => notes.get(c.id)?.urgent);
  const regionName = (b: string | null) => regions.find((r) => r.id === b)?.name ?? "Before regions";
  const ups = updates.filter((u) => inRegion(u.branch_id) && (u.other_updates ?? "").trim());
  const who = (id: string | null) => (id ? staff.get(id) ?? "—" : "—");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <DayPicker day={day} setDay={setDay} max={today} />
        <span className="text-sm text-muted-foreground">{longDay(day)}</span>
        <div className="ml-auto"><LastSent kinds={["daily", "daily_attendance"]} /></div>
      </div>
      {loading ? <div className="text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div> : (
        <>
          {urgent.length > 0 && (
            <div className="rounded-xl border border-danger-200 bg-danger-50 dark:bg-danger-500/10 px-4 py-3 text-sm">
              <p className="font-semibold text-danger-700 dark:text-danger-500 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" />Matters requiring attention</p>
              <ul className="mt-1 list-disc ml-5 text-foreground">{urgent.map((c) => <li key={c.id}><b>{c.name}</b> — {notes.get(c.id)?.details}</li>)}</ul>
            </div>
          )}
          <Block n={1} title="Updates">
            {ups.length ? ups.map((u) => (
              <div key={u.branch_id ?? "none"} className="mb-2 last:mb-0">
                {!regionId && <p className="text-xs font-semibold text-muted-foreground mb-0.5">{regionName(u.branch_id)}</p>}
                <p className="whitespace-pre-line text-foreground">{u.other_updates}</p>
              </div>
            )) : <Nil />}
          </Block>
          <Block n={2} title={`Previous tasks (set ${new Date(`${shift(day, -1)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })})`}>
            {prev.filter((t) => inRegion(t.branch_id)).length ? (
              <table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1">Task</th><th>Responsible</th><th>Status</th></tr></thead>
                <tbody>{prev.filter((t) => inRegion(t.branch_id)).map((t) => (
                  <tr key={t.id} className="border-t border-border align-top"><td className="py-1.5 pr-3">{t.title}{t.status_note ? <div className="text-xs text-muted-foreground">{t.status_note}</div> : null}</td><td className="pr-3 whitespace-nowrap">{who(t.assignee_employee_id)}</td>
                    <td className={`whitespace-nowrap ${t.status === "completed" ? "text-success-700 dark:text-success-500" : "text-warning-700 dark:text-warning-500"}`}>{STATUS[t.status ?? "pending"] ?? t.status}</td></tr>
                ))}</tbody></table>
            ) : <Nil />}
          </Block>
          <Block n={3} title="Tasks for tomorrow">
            {tasks.filter((t) => inRegion(t.branch_id)).length ? (
              <ol className="list-decimal ml-5 space-y-0.5">{tasks.filter((t) => inRegion(t.branch_id)).map((t) => <li key={t.id}>{t.title} <span className="text-muted-foreground">— {who(t.assignee_employee_id)}</span></li>)}</ol>
            ) : <Nil />}
          </Block>
          <Block n={4} title="Clients">
            {withNote.length ? (
              <ul className="space-y-2">{withNote.map((c) => (
                <li key={c.id}><p className="font-medium text-foreground">{c.name}{notes.get(c.id)?.urgent ? <span className="ml-2 text-xs text-danger-700 dark:text-danger-500">urgent</span> : null}{!regionId && <span className="ml-2 text-xs text-muted-foreground">{regionName(c.branch_id)}</span>}</p>
                  <p className="whitespace-pre-line text-foreground">{notes.get(c.id)?.details}</p></li>
              ))}</ul>
            ) : <Nil text="No client notes for this day." />}
            {nil.length > 0 && <p className="mt-3 text-xs text-muted-foreground"><b>Nil report:</b> {nil.map((c) => c.name).join(", ")}.</p>}
          </Block>
        </>
      )}
    </div>
  );
}

// ───────────────────────── Attendance ─────────────────────────
export function AttendanceView() {
  const { company } = useAuth();
  const { regionId, regions } = useRegion();
  const yesterday = shift(iso(new Date()), -1);
  const [day, setDay] = useState(yesterday);
  const [summary, setSummary] = useState<AttendanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<Map<string, string>>(new Map());
  const [staff, setStaff] = useState<StaffChanges | null>(null);

  useEffect(() => {
    if (!company?.id) return;
    setLoading(true);
    void Promise.all([
      loadAttendanceSummary(company.id, day, regionId),
      supabase.from("attendance_gap_notes").select("client_id, note").eq("company_id", company.id).eq("attendance_date", day),
    ]).then(([s, g]) => {
      setSummary(s);
      setNotes(new Map(((g.data ?? []) as any[]).map((x) => [x.client_id, x.note ?? ""])));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [company?.id, day, regionId]);
  useEffect(() => { void loadStaffChanges().then(setStaff); }, []);

  const regionNames = useMemo(() => Object.fromEntries(regions.map((r) => [r.id, r.name])), [regions]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <DayPicker day={day} setDay={setDay} max={yesterday} />
        <span className="text-sm text-muted-foreground">Attendance for {longDay(day)}</span>
        <div className="ml-auto"><LastSent kinds={["attendance", "daily_attendance"]} /></div>
      </div>
      <AttendanceReport summary={summary} loading={loading} date={day} regionLabel={regionId ? regionNames[regionId] ?? null : null}
        regionNames={regionNames} notes={notes} canExplain={false} onExplain={() => undefined} />
      {staff && <StaffChangesPanel data={staffForRegion(staff, regionId)} title="Staff changes since the last attendance report" />}
    </div>
  );
}
