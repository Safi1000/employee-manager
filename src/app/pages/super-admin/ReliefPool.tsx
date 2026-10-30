import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, CalendarDays, Loader2, MapPin, Send, Undo2, Users } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { hasPermission, useAuth } from "../../lib/auth";
import { clearConflictingDayRows } from "../../lib/attendanceDay";
import { isSeparatedState } from "../../lib/employmentWindow";
import { guardDisplayCode } from "../../lib/guardCode";

/**
 * RELIEF POOL (DECIDED 2026-10-23, Shayan).
 *
 * Four kinds of reliever, and only one of them lives here:
 *   • relievers inside a client's billed strength (Emaar 60+10, HMC) are guards;
 *   • a client's own extra relievers (PCI-PFM, contract line at rate 0) are
 *     guards that stay at that one client;
 *   • POOL relievers — category "reliever" — are sent by the office from one
 *     client to another, day by day; usually on monthly salary, whose cost is
 *     apportioned by the days at each client;
 *   • per-day relievers are pool relievers on per-day pay, each at his own rate.
 *
 * The board shows each pool reliever's day (free, at which site, on leave), the
 * open gaps — posted guards marked absent or on leave — and the days each
 * reliever spent at each client this month. "Send" marks his attendance at the
 * site exactly as the Reliever Attendance page does (site named; the database
 * derives the client), so his cost follows the client. Pay is in the Payroll
 * Run, under "Relievers".
 *
 * 0613: where the site has a supervisor on the field app, he confirms each
 * reliever sent there — arrived, or didn't arrive (reliever_arrivals). That
 * shows beside the reliever here. "Didn't arrive" never removes the mark: the
 * office decides (DECIDED 30 Oct 2026, office wins) — use Back to free.
 */

type Reliever = {
  id: string; full_name: string; employee_code: string; guard_code: string | null; display_number: number | null;
  shift: string | null; pay_basis: string | null; daily_rate: number | null; base_salary: number | null; lifecycle_state: string | null;
};
type DayRow = { id: string; employee_id: string; status: string; site_id: string | null; worked_for_client_id: string | null; covering_for_guard_id: string | null; worked_shift: string | null };
type Gap = { guard_id: string; name: string; status: string; site_id: string | null; client_id: string | null; shift: string | null; covered_by: string | null };

const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const SHIFTS = ["day", "evening", "night"];

export default function ReliefPool() {
  const { profile } = useAuth();
  const canEdit = hasPermission(profile, "attendance.edit");
  const [date, setDate] = useState(todayIso());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [relievers, setRelievers] = useState<Reliever[]>([]);
  const [day, setDay] = useState<Map<string, DayRow>>(new Map());
  const [monthDays, setMonthDays] = useState<Map<string, Map<string, number>>>(new Map());
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [sites, setSites] = useState<{ id: string; client_id: string; name: string }[]>([]);
  const [clientName, setClientName] = useState<Map<string, string>>(new Map());
  // The site supervisor's word on today's reliever rows (0613), by attendance row id.
  const [arrivals, setArrivals] = useState<Map<string, { arrived: boolean; supervisor_name: string }>>(new Map());

  const [send, setSend] = useState<{ relieverId: string; siteId: string; shift: string; covering: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    const monthStart = `${date.slice(0, 7)}-01`;
    const [rel, st, cl] = await Promise.all([
      supabase.from("employees")
        .select("id, full_name, employee_code, guard_code, display_number, shift, pay_basis, daily_rate, base_salary, lifecycle_state")
        .eq("category", "reliever").order("full_name"),
      supabase.from("sites").select("id, client_id, name").order("name"),
      supabase.from("clients").select("id, name"),
    ]);
    if (rel.error) { setErr(rel.error.message); setLoading(false); return; }
    const rs = ((rel.data ?? []) as Reliever[]).filter((r) => !isSeparatedState(r.lifecycle_state));
    setRelievers(rs);
    setSites((st.data ?? []) as { id: string; client_id: string; name: string }[]);
    setClientName(new Map(((cl.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name])));
    const ids = rs.map((r) => r.id);

    const [dayRes, monthRes, absRes] = await Promise.all([
      ids.length ? supabase.from("attendance_records")
        .select("id, employee_id, status, site_id, worked_for_client_id, covering_for_guard_id, worked_shift")
        .in("employee_id", ids).eq("attendance_date", date) : Promise.resolve({ data: [] }),
      ids.length ? supabase.from("attendance_records")
        .select("employee_id, worked_for_client_id")
        .in("employee_id", ids).gte("attendance_date", monthStart).lte("attendance_date", date)
        .in("status", ["present", "double_duty"]) : Promise.resolve({ data: [] }),
      // Open gaps: posted guards marked absent or on leave that day.
      supabase.from("attendance_records")
        .select("employee_id, status, worked_for_client_id, worked_shift")
        .eq("attendance_date", date).in("status", ["absent", "leave"]),
    ]);
    const dm = new Map<string, DayRow>();
    for (const r of (dayRes.data ?? []) as DayRow[]) dm.set(r.employee_id, r);
    setDay(dm);
    const rowIds = [...dm.values()].map((r) => r.id);
    const arr = rowIds.length
      ? await supabase.from("reliever_arrivals").select("attendance_record_id, arrived, supervisor_name").in("attendance_record_id", rowIds)
      : { data: [] };
    setArrivals(new Map(((arr.data ?? []) as { attendance_record_id: string; arrived: boolean; supervisor_name: string }[])
      .map((a) => [a.attendance_record_id, { arrived: a.arrived, supervisor_name: a.supervisor_name }])));
    const mm = new Map<string, Map<string, number>>();
    for (const r of (monthRes.data ?? []) as { employee_id: string; worked_for_client_id: string | null }[]) {
      const k = r.worked_for_client_id ?? "—";
      const inner = mm.get(r.employee_id) ?? new Map<string, number>();
      inner.set(k, (inner.get(k) ?? 0) + 1);
      mm.set(r.employee_id, inner);
    }
    setMonthDays(mm);

    const abs = ((absRes.data ?? []) as { employee_id: string; status: string; worked_for_client_id: string | null; worked_shift: string | null }[])
      .filter((a) => !ids.includes(a.employee_id));
    const absIds = abs.map((a) => a.employee_id);
    let names = new Map<string, string>(); let siteOf = new Map<string, string | null>();
    if (absIds.length) {
      const [em, dep] = await Promise.all([
        supabase.from("employees").select("id, full_name").in("id", absIds),
        supabase.from("deployments").select("guard_id, site_id, start_date, end_date").in("guard_id", absIds).lte("start_date", date),
      ]);
      names = new Map(((em.data ?? []) as { id: string; full_name: string }[]).map((e) => [e.id, e.full_name]));
      for (const d of (dep.data ?? []) as { guard_id: string; site_id: string | null; end_date: string | null }[]) {
        if (!d.end_date || d.end_date >= date) siteOf.set(d.guard_id, d.site_id);
      }
    }
    const coveredBy = new Map<string, string>();
    for (const r of dm.values()) if (r.covering_for_guard_id) coveredBy.set(r.covering_for_guard_id, r.employee_id);
    setGaps(abs.map((a) => ({
      guard_id: a.employee_id, name: names.get(a.employee_id) ?? "—", status: a.status,
      site_id: siteOf.get(a.employee_id) ?? null, client_id: a.worked_for_client_id, shift: a.worked_shift,
      covered_by: coveredBy.get(a.employee_id) ?? null,
    })).sort((x, y) => Number(!!x.covered_by) - Number(!!y.covered_by) || (clientName.get(x.client_id ?? "") ?? "").localeCompare(clientName.get(y.client_id ?? "") ?? "")));
    setLoading(false);
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const siteName = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);
  const siteClient = useMemo(() => new Map(sites.map((s) => [s.id, s.client_id])), [sites]);
  const nameOf = (r: Reliever) => `${guardDisplayCode(r, null) ?? r.employee_code} · ${r.full_name}`;
  const stateOf = (r: Reliever): { kind: "free" | "out" | "leave" | "absent"; text: string } => {
    const d = day.get(r.id);
    if (!d) return { kind: "free", text: "Free" };
    if (d.status === "leave") return { kind: "leave", text: "On leave" };
    if (d.status === "absent") return { kind: "absent", text: "Absent" };
    const where = d.site_id ? `${siteName.get(d.site_id) ?? "site"} · ${clientName.get(d.worked_for_client_id ?? siteClient.get(d.site_id) ?? "") ?? ""}` : clientName.get(d.worked_for_client_id ?? "") ?? "a client";
    const cover = d.covering_for_guard_id ? ` · covering ${gaps.find((g) => g.guard_id === d.covering_for_guard_id)?.name ?? "a guard"}` : "";
    return { kind: "out", text: `At ${where}${cover}` };
  };

  const counts = relievers.reduce((n, r) => { n[stateOf(r).kind] += 1; return n; }, { free: 0, out: 0, leave: 0, absent: 0 });
  const openGaps = gaps.filter((g) => !g.covered_by);

  // ── writes: the same row the Reliever Attendance page writes ──
  const mark = async (relieverId: string, status: "present" | "leave", siteId: string | null, shift: string, covering: string | null) => {
    if (date > todayIso()) { setErr("Future days can't be marked."); return; }
    setBusy(relieverId); setErr(null);
    try {
      await clearConflictingDayRows([{ employee_id: relieverId, attendance_date: date, status, worked_shift: shift }]);
    } catch (e) {
      setBusy(null); setErr((e as { message?: string }).message ?? "Could not clear that day's marks."); return;
    }
    const { error } = await supabase.from("attendance_records").upsert({
      employee_id: relieverId, attendance_date: date, status,
      scheduled_shift: shift, worked_shift: shift, worked_for_client_id: null,
      site_id: status === "present" ? siteId : null,
      covering_for_guard_id: status === "present" ? covering : null,
      marked_by_user_id: profile?.id ?? null, marked_at: new Date().toISOString(),
    }, { onConflict: "employee_id,attendance_date,worked_shift" });
    setBusy(null);
    if (error) { setErr(friendlyDbError(error)); return; }
    setSend(null);
    await load();
  };
  const unmark = async (relieverId: string) => {
    setBusy(relieverId); setErr(null);
    const { error } = await supabase.rpc("clear_attendance_day", { p_employee: relieverId, p_date: date, p_reason: "Relief pool: back to free" });
    setBusy(null);
    if (error) { setErr(friendlyDbError(error)); return; }
    await load();
  };

  const freeRelievers = relievers.filter((r) => stateOf(r).kind === "free");

  return (
    <>
      <Header title="Relief pool" subtitle="Pool relievers sent from client to client by the office — their day, the gaps, and where their days went">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          {[
            { k: "In the pool", v: relievers.length, s: "active pool relievers" },
            { k: "Out today", v: counts.out, s: "sent to a client" },
            { k: "Free", v: counts.free, s: counts.leave + counts.absent ? `${counts.leave} on leave · ${counts.absent} absent` : "ready to send" },
            { k: "Open gaps", v: openGaps.length, s: `guards absent or on leave, not covered · ${gaps.length - openGaps.length} covered` },
          ].map((t) => (
            <div key={t.k} className="rounded-[14px] border border-border bg-card px-4 py-3">
              <span className="lbl">{t.k}</span>
              <div className="font-ledger text-2xl font-semibold leading-none mt-1">{t.v}</div>
              <span className="text-xs text-muted-foreground">{t.s}</span>
            </div>
          ))}
        </div>
      </Header>
      <div className="flex-1 overflow-y-auto px-4 md:px-8 pb-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3 pt-4">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <CalendarDays className="w-4 h-4" /> Day
            <input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} className="px-2 py-1.5 border border-border rounded-md text-sm bg-card" />
          </label>
          <span className="text-sm text-muted-foreground">{fmtDay(date)} · days this month counted to this day</span>
        </div>

        {err && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" /><div className="flex-1">{err}</div>
            <button onClick={() => setErr(null)}>✕</button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…</div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            {/* The pool */}
            <section className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                <Users className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">Pool relievers</h3>
              </div>
              {relievers.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  No pool relievers. A pool reliever is an employee whose category is &ldquo;Reliever&rdquo;. Client-specific relievers (Emaar, HMC, PCI-PFM) are guards and stay on their client.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {relievers.map((r) => {
                    const st = stateOf(r);
                    const md = [...(monthDays.get(r.id) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]);
                    const total = md.reduce((n, [, v]) => n + v, 0);
                    return (
                      <li key={r.id} className="px-4 py-3 flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="text-sm font-medium text-foreground">{nameOf(r)}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {r.pay_basis === "per_day" ? `per day · PKR ${Number(r.daily_rate ?? 0).toLocaleString()}` : `monthly · PKR ${Number(r.base_salary ?? 0).toLocaleString()}`}
                          </span>
                          <span className={`ml-auto text-xs font-medium ${st.kind === "out" ? "text-success-700 dark:text-success-500" : st.kind === "free" ? "text-heed" : "text-muted-foreground"}`}>{st.text}</span>
                        </div>
                        {st.kind === "out" && (() => {
                          const a = arrivals.get(day.get(r.id)?.id ?? "");
                          if (!a) return null;
                          return a.arrived
                            ? <span className="text-[11px] text-up">Site confirmed he arrived · {a.supervisor_name}</span>
                            : <span className="text-[11px] font-semibold text-heed">Site says he didn't arrive · {a.supervisor_name} — still marked present; use Back to free if so</span>;
                        })()}
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          {md.length === 0 ? <span className="text-muted-foreground">No days this month yet</span> : md.map(([cid, n]) => (
                            <span key={cid} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                              {clientName.get(cid) ?? "No client"} <span className="font-ledger text-foreground">{n}</span>d{total ? ` · ${Math.round((n / total) * 100)}%` : ""}
                            </span>
                          ))}
                        </div>
                        {canEdit && (
                          <div className="flex flex-wrap gap-1.5">
                            <Button size="sm" variant={st.kind === "free" ? "primary" : "secondary"} disabled={busy === r.id}
                              onClick={() => setSend({ relieverId: r.id, siteId: day.get(r.id)?.site_id ?? "", shift: day.get(r.id)?.worked_shift ?? r.shift ?? "day", covering: day.get(r.id)?.covering_for_guard_id ?? "" })}>
                              <Send className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} /> {st.kind === "out" ? "Change site" : "Send"}
                            </Button>
                            {st.kind !== "leave" && (
                              <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => void mark(r.id, "leave", null, r.shift ?? "day", null)}>On leave</Button>
                            )}
                            {st.kind !== "free" && (
                              <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => void unmark(r.id)}>
                                <Undo2 className="w-3.5 h-3.5 mr-1" strokeWidth={1.5} /> Back to free
                              </Button>
                            )}
                            {busy === r.id && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground self-center" />}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* The gaps */}
            <section className="rounded-2xl border border-border bg-card overflow-hidden self-start">
              <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                <MapPin className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">Gaps on {fmtDay(date)}</h3>
                <span className="ml-auto text-xs text-muted-foreground">guards marked absent or on leave</span>
              </div>
              {gaps.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">No guard is marked absent or on leave that day — or attendance has not been marked yet.</p>
              ) : (
                <ul className="divide-y divide-border text-sm max-h-[32rem] overflow-y-auto">
                  {gaps.map((g) => (
                    <li key={g.guard_id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 ${g.covered_by ? "opacity-60" : ""}`}>
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground">{g.name}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {g.status === "leave" ? "On leave" : "Absent"} · {g.site_id ? siteName.get(g.site_id) ?? "site" : "no site"}{g.client_id ? ` · ${clientName.get(g.client_id) ?? ""}` : ""}{g.shift ? ` · ${g.shift}` : ""}
                        </span>
                      </span>
                      {g.covered_by ? (
                        <span className="text-xs text-success-700 dark:text-success-500">covered by {relievers.find((r) => r.id === g.covered_by)?.full_name ?? "a reliever"}</span>
                      ) : canEdit && freeRelievers.length > 0 ? (
                        <Button size="sm" variant="secondary" onClick={() => setSend({ relieverId: freeRelievers[0].id, siteId: g.site_id ?? "", shift: g.shift ?? "day", covering: g.guard_id })}>
                          Cover <ArrowRight className="w-3.5 h-3.5 ml-1" />
                        </Button>
                      ) : (
                        <span className="text-xs text-heed">uncovered</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>

      <Modal isOpen={!!send} onClose={() => !busy && setSend(null)} title={`Send a reliever — ${fmtDay(date)}`}
        footer={<>
          <Button variant="secondary" onClick={() => setSend(null)}>Cancel</Button>
          <Button disabled={!!busy || !send?.siteId || !send?.relieverId}
            onClick={() => send && void mark(send.relieverId, "present", send.siteId, send.shift, send.covering || null)}>
            {busy ? "Saving…" : "Send — mark present there"}
          </Button>
        </>}>
        {send && (
          <div className="flex flex-col gap-3">
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Reliever</label>
              <ThemedSelect value={send.relieverId} onChange={(e) => setSend({ ...send, relieverId: e.target.value })}>
                {relievers.map((r) => <option key={r.id} value={r.id}>{nameOf(r)} — {stateOf(r).text}</option>)}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Site *</label>
              <ThemedSelect value={send.siteId} onChange={(e) => setSend({ ...send, siteId: e.target.value, covering: "" })}>
                <option value="">Choose the site…</option>
                {[...sites].sort((a, b) => (clientName.get(a.client_id) ?? "").localeCompare(clientName.get(b.client_id) ?? "") || a.name.localeCompare(b.name))
                  .filter((s) => clientName.has(s.client_id))
                  .map((s) => <option key={s.id} value={s.id}>{clientName.get(s.client_id)} — {s.name}</option>)}
              </ThemedSelect>
              <p className="text-[11px] text-muted-foreground mt-1">The client comes from the site; this day&rsquo;s cost of the reliever lands on it.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">Shift</label>
                <ThemedSelect value={send.shift} onChange={(e) => setSend({ ...send, shift: e.target.value })}>
                  {SHIFTS.map((s) => <option key={s} value={s}>{s}</option>)}
                </ThemedSelect>
              </div>
              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">Covering for (optional)</label>
                <ThemedSelect value={send.covering} onChange={(e) => setSend({ ...send, covering: e.target.value })}>
                  <option value="">Nobody named</option>
                  {gaps.filter((g) => !send.siteId || g.site_id === send.siteId || g.guard_id === send.covering)
                    .map((g) => <option key={g.guard_id} value={g.guard_id}>{g.name} ({g.status})</option>)}
                </ThemedSelect>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
