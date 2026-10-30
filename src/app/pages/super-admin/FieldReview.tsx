import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, MapPin, RotateCcw, X } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Tabs from "../../components/Tabs";
import { hasPermission, useAuth } from "../../lib/auth";
import { supabase, friendlyDbError } from "../../lib/supabase";

/**
 * Workforce ▸ Field Review (30 Oct 2026). What the field app sends that the
 * office has to decide on. Two queues, each shown to whoever holds its key —
 * never a named person (Shayan: "anyone with permission … don't link anything
 * with any specific user"):
 *
 *   Site attendance   attendance.field_review (0618). A site supervisor's
 *                     confirmation has already written the rows; the review is
 *                     the second stage. Accept — the shift is the office's now.
 *                     Return with a note — the supervisor fixes it and confirms
 *                     again the same day. Not reviewed in 12 hours → an alert.
 *                     Correcting rows is still done on the Attendance Board.
 *   Warnings          warnings.approve (0617). A formal warning from the field
 *                     app arrives pending. Approve (with any fine of 1–6 days'
 *                     salary — HR only) or refuse. An approved fine then waits on
 *                     Payroll until HR adds it to the payslip.
 *
 * The marks shown under a shift are read for display only: the guards whose
 * deployment puts them at that site on that day, and their rows for that shift.
 */

type Conf = {
  id: string; site_id: string | null; attendance_date: string; shift_code: string; supervisor_name: string;
  confirmed_at: string; review_status: "pending" | "returned"; review_note: string | null; reviewed_by_name: string | null;
  geo: { inside?: boolean | null; distance_m?: number | null } | null;
  sites: { name: string; clients: { name: string } | null } | null;
};
type Mark = { employee_id: string; status: string; worked_shift: string | null; employees: { full_name: string; employee_code: string } | null };
type PendingWarning = {
  id: string; employee_id: string; issued_on: string; reason: string; raised_by_name: string | null; created_at: string;
  employees: { full_name: string; employee_code: string; pending_termination_review: boolean } | null;
  sites: { name: string } | null;
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const STATUS_WORD: Record<string, string> = { present: "Present", absent: "Absent", leave: "Leave", double_duty: "Double duty" };

export default function FieldReview() {
  const { profile } = useAuth();
  const canAttendance = hasPermission(profile, "attendance.field_review");
  const canWarnings = hasPermission(profile, "warnings.approve");
  const [view, setView] = useState<"attendance" | "warnings">(canAttendance ? "attendance" : "warnings");
  const [confs, setConfs] = useState<Conf[]>([]);
  const [warnings, setWarnings] = useState<PendingWarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [c, w] = await Promise.all([
      canAttendance
        ? supabase.from("attendance_confirmations")
            .select("id, site_id, attendance_date, shift_code, supervisor_name, confirmed_at, review_status, review_note, reviewed_by_name, geo, sites(name, clients(name))")
            .in("review_status", ["pending", "returned"]).order("confirmed_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      canWarnings
        ? supabase.from("disciplinary_warnings")
            .select("id, employee_id, issued_on, reason, raised_by_name, created_at, employees(full_name, employee_code, pending_termination_review), sites(name)")
            .eq("status", "pending").eq("kind", "formal").order("created_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (c.error || w.error) setErr(friendlyDbError((c.error ?? w.error)!));
    setConfs((c.data ?? []) as unknown as Conf[]);
    setWarnings((w.data ?? []) as unknown as PendingWarning[]);
    setLoading(false);
  }, [canAttendance, canWarnings]);
  useEffect(() => { void load(); }, [load]);

  const items = useMemo(() => [
    ...(canAttendance ? [{ value: "attendance" as const, label: "Site attendance", count: confs.filter((c) => c.review_status === "pending").length || undefined }] : []),
    ...(canWarnings ? [{ value: "warnings" as const, label: "Warnings", count: warnings.length || undefined }] : []),
  ], [canAttendance, canWarnings, confs, warnings]);

  return (
    <div className="space-y-4">
      <Header title="Field Review" subtitle="Attendance the sites confirmed on the field app, and formal warnings waiting for a decision" />
      {err && <div className="rounded-lg border border-down/40 bg-down/10 p-3 text-sm text-down">{err}</div>}
      {items.length > 1 && <Tabs value={view} onChange={setView} items={items} />}
      {loading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : view === "attendance" && canAttendance ? (
        confs.length === 0 ? <Empty text="Nothing waiting. Every shift a site confirmed has been reviewed." /> : (
          <div className="space-y-3">{confs.map((c) => <ShiftCard key={c.id} conf={c} onDone={load} onError={setErr} />)}</div>
        )
      ) : canWarnings ? (
        warnings.length === 0 ? <Empty text="No formal warnings waiting." /> : (
          <div className="space-y-3">{warnings.map((w) => <WarningCard key={w.id} w={w} onDone={load} onError={setErr} />)}</div>
        )
      ) : <Empty text="You need Review site attendance or Approve warnings to use this page." />}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">{text}</div>;
}

function ShiftCard({ conf, onDone, onError }: { conf: Conf; onDone: () => void; onError: (s: string) => void }) {
  const [marks, setMarks] = useState<Mark[] | null>(null);
  const [note, setNote] = useState("");
  const [returning, setReturning] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!conf.site_id) { setMarks([]); return; }
      const d = conf.attendance_date;
      const dep = await supabase.from("deployments").select("guard_id").eq("site_id", conf.site_id).lte("start_date", d).or(`end_date.is.null,end_date.gte.${d}`);
      const ids = [...new Set(((dep.data ?? []) as { guard_id: string }[]).map((x) => x.guard_id))];
      if (!ids.length) { if (live) setMarks([]); return; }
      const rec = await supabase.from("attendance_records").select("employee_id, status, worked_shift, employees(full_name, employee_code)")
        .eq("attendance_date", d).in("employee_id", ids).eq("source", "app");
      if (live) setMarks(((rec.data ?? []) as unknown as Mark[]).filter((m) => m.worked_shift === conf.shift_code || m.status === "leave"));
    })();
    return () => { live = false; };
  }, [conf.site_id, conf.attendance_date, conf.shift_code]);

  const decide = async (accept: boolean) => {
    setBusy(true);
    const { error } = await supabase.rpc("review_field_attendance", { p_confirmation_id: conf.id, p_accept: accept, p_note: accept ? null : note });
    setBusy(false);
    if (error) { onError(friendlyDbError(error)); return; }
    onDone();
  };

  const exceptions = (marks ?? []).filter((m) => m.status !== "present");
  const present = (marks ?? []).filter((m) => m.status === "present").length;
  const late = Date.now() - new Date(conf.confirmed_at).getTime() > 12 * 3600_000;
  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium">{conf.sites?.name ?? "Site"} <span className="text-muted-foreground font-normal">· {conf.sites?.clients?.name}</span></div>
          <div className="text-sm text-muted-foreground">
            {day(conf.attendance_date)} · {conf.shift_code} shift · confirmed by {conf.supervisor_name} at {when(conf.confirmed_at)}
            {late && conf.review_status === "pending" && <span className="ml-1 text-down">· over 12 hours</span>}
          </div>
          {conf.geo?.inside === false && <div className="mt-1 inline-flex items-center gap-1 text-xs text-warning-700"><MapPin className="h-3 w-3" /> Phone was {Math.round((conf.geo.distance_m ?? 0) / 100) / 10} km away — outside the site's area</div>}
          {conf.review_status === "returned" && <div className="mt-1 text-xs text-muted-foreground">Returned by {conf.reviewed_by_name}: “{conf.review_note}” — waiting for the site to confirm again</div>}
        </div>
      </div>
      {marks === null ? <div className="text-sm text-muted-foreground">Loading marks…</div> : (
        <div className="text-sm">
          <span className="text-muted-foreground">{present} present</span>
          {exceptions.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {exceptions.map((m) => (
                <li key={`${m.employee_id}-${m.worked_shift}`}>{m.employees?.full_name} <span className="text-muted-foreground">({m.employees?.employee_code})</span> — {STATUS_WORD[m.status] ?? m.status}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {conf.review_status === "pending" && (
        returning ? (
          <div className="flex flex-wrap gap-2">
            <input className="flex-1 min-w-[220px] px-3 py-2 border border-border rounded-md text-sm" placeholder="What is wrong — the site sees this" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
            <Button size="sm" variant="secondary" disabled={busy || !note.trim()} onClick={() => void decide(false)}><RotateCcw className="mr-1.5 h-4 w-4" /> Return</Button>
            <Button size="sm" variant="ghost" onClick={() => setReturning(false)}>Cancel</Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void decide(true)}><Check className="mr-1.5 h-4 w-4" /> Accept</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setReturning(true)}><RotateCcw className="mr-1.5 h-4 w-4" /> Return to site</Button>
          </div>
        )
      )}
    </div>
  );
}

function WarningCard({ w, onDone, onError }: { w: PendingWarning; onDone: () => void; onError: (s: string) => void }) {
  const [days, setDays] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    const { error } = await supabase.rpc("decide_warning", { p_id: w.id, p_approve: approve, p_fine_days: approve && days ? Number(days) : null, p_note: note || null });
    setBusy(false);
    if (error) { onError(friendlyDbError(error)); return; }
    onDone();
  };
  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <div>
        <div className="font-medium">{w.employees?.full_name} <span className="text-muted-foreground font-normal">· {w.employees?.employee_code}</span></div>
        <div className="text-sm text-muted-foreground">Formal warning · {day(w.issued_on)}{w.sites ? ` · ${w.sites.name}` : ""}{w.raised_by_name ? ` · raised by ${w.raised_by_name} on the field app` : ""}</div>
        <div className="mt-1 text-sm">{w.reason}</div>
        {w.employees?.pending_termination_review && <div className="mt-1 text-xs text-down">Already flagged for termination review</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="px-3 py-2 border border-border rounded-md text-sm" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Fine">
          <option value="">No fine</option>
          {[1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>Fine: {d} day{d === 1 ? "" : "s"}' salary</option>)}
        </select>
        <input className="flex-1 min-w-[180px] px-3 py-2 border border-border rounded-md text-sm" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button size="sm" disabled={busy} onClick={() => void decide(true)}><Check className="mr-1.5 h-4 w-4" /> Approve</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void decide(false)}><X className="mr-1.5 h-4 w-4" /> Refuse</Button>
      </div>
      <p className="text-xs text-muted-foreground">Approving counts it towards three in 12 months; the third flags him for termination review. A fine waits on Payroll until it is added to his payslip.</p>
    </div>
  );
}
