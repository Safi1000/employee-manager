// On-screen version of the monthly attendance Excel sheet, per client (optionally
// one site). Renders the exact same grid the exporter produces — day columns split
// by shift, P/A/L/X marks, per-day and grand totals, legend — plus a Download
// button that hands the identical rows to exportAttendance. View without downloading.

import { useEffect, useMemo, useState } from "react";
import { X, Download, Loader2, ChevronLeft, ChevronRight, ShieldCheck, AlertTriangle, Lock } from "lucide-react";
import Button from "./Button";
import { supabase } from "../lib/supabase";
import { guardDisplayCode } from "../lib/guardCode";
import { buildAttendanceRows, type SheetEmployee } from "../lib/attendanceSheet";
import { exportAttendance, deriveAttendanceShifts, shiftAbbr, type AttendanceEmployeeRow } from "../lib/excel";

const todayMonth = () => new Date().toISOString().slice(0, 7);

const statusClass = (s: string): string =>
  s === "P" ? "text-success-700 dark:text-success-500"
    : s === "DD" ? "text-info-700 dark:text-info-500"
    : s === "A" ? "text-danger-600"
      : s === "L" ? "text-warning-700 dark:text-warning-500"
        : s === "X" ? "text-muted-foreground/60"
          : "";

type OverrideRow = {
  id: string; employee_id: string; attendance_date: string;
  reason: string; before_value: string | null; after_value: string | null;
  created_by: string | null; created_at: string;
};

export default function AttendanceSheetModal({
  clientId, clientName, siteId, siteName, companyId, canOpsVerify = false, currentUserId = null, currentUserRole = null, onClose,
}: {
  clientId: string;
  clientName: string;
  siteId?: string | null;
  siteName?: string | null;
  companyId?: string | null;
  canOpsVerify?: boolean;
  currentUserId?: string | null;
  currentUserRole?: string | null;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(todayMonth());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<AttendanceEmployeeRow[]>([]);
  // Per-employee `${day}|${shift}` → P/A/L for every visible (confirmed/overridden)
  // mark, so each shift column renders independently and double duty shows in two.
  const [cells, setCells] = useState<Map<string, Map<string, string>>>(new Map());
  const [daysInMonth, setDaysInMonth] = useState(30);
  const [monthLabel, setMonthLabel] = useState("");

  // OPS Verify state (per client + month).
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null); // ISO or null (= not verified)
  // Payroll Run phase for this client/category + month. Un-verify is only allowed
  // while the phase is Draft (no row); once in Review/Finance Verify it's locked.
  const [runPhase, setRunPhase] = useState<"review" | "finance_verify" | null>(null);
  const [financeVerified, setFinanceVerified] = useState(false);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [opsMsg, setOpsMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [opsBusy, setOpsBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Override modal target: which employee+date cell is being overridden.
  const [ovTarget, setOvTarget] = useState<{ empId: string; empName: string; date: string; current: string; shift: string; presentOnly?: boolean } | null>(null);

  const label = siteName ? `${clientName} — ${siteName}` : clientName;
  // Synthetic (non-client) groups from the attendance board carry id 'cat:<category>'
  // — office_staff / armed / gunman have no client. Scope everything by category
  // for those; by real client uuid otherwise.
  const synthetic = clientId.startsWith("cat:");
  const category = synthetic ? clientId.slice(4) : null;
  const realClientId = synthetic ? null : clientId;
  const monthStartDate = `${month}-01`;
  // Month has ended when its last calendar day is strictly before today.
  const monthEnded = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(y, m, 0);
    const today = new Date();
    lastDay.setHours(0, 0, 0, 0); today.setHours(0, 0, 0, 0);
    return lastDay < today;
  }, [month]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const empQuery = supabase
          .from("employees")
          .select("id, full_name, display_number, guard_code, employee_code, contract_id, client_id, join_date, last_working_day, termination_date, lifecycle_state, shift")
          .neq("lifecycle_state", "archived");
        const [{ data: client }, { data: contracts }, { data: emps }] = await Promise.all([
          // Synthetic groups have no real client row.
          synthetic
            ? Promise.resolve({ data: null })
            : supabase.from("clients").select("id, name, employee_id_prefix, allowed_leaves_per_month").eq("id", clientId).single(),
          synthetic
            ? Promise.resolve({ data: [] })
            : supabase.from("contracts").select("id, allowed_leaves_per_month").eq("client_id", clientId),
          synthetic
            ? empQuery.eq("category", category as string)
            : empQuery.eq("client_id", clientId),
        ]);

        let list = (emps ?? []) as any[];
        // Guard → current site (open posting). Used both to narrow to one site
        // AND to match each guard against the right per-site supervisor
        // confirmation below.
        const siteByGuard = new Map<string, string | null>();
        if (!synthetic) {
          const { data: deps } = await supabase
            .from("deployments").select("guard_id, site_id, end_date").eq("client_id", clientId)
            .order("end_date", { ascending: false, nullsFirst: true });
          // Open posting (end_date null) wins; else fall back to the guard's most
          // recent closed posting so separated/fired guards' confirmed attendance
          // still matches its site instead of rendering a blank row.
          for (const d of (deps ?? []) as any[]) if (!siteByGuard.has(d.guard_id)) siteByGuard.set(d.guard_id, d.site_id ?? null);
        }
        // Narrow to one site by the guard's current open posting.
        if (siteId) list = list.filter((e) => siteByGuard.get(e.id) === siteId);

        const prefix = (client as any)?.employee_id_prefix ?? null;
        const employees: SheetEmployee[] = list
          .map((e) => ({
            id: e.id,
            full_name: e.full_name,
            display_code: guardDisplayCode(e, prefix),
            contract_id: e.contract_id ?? null,
            client_id: e.client_id ?? null,
            join_date: e.join_date ?? null,
            last_working_day: e.last_working_day ?? null,
            termination_date: e.termination_date ?? null,
            lifecycle_state: e.lifecycle_state ?? null,
            shift: e.shift ?? null,
          }))
          .sort((a, b) => a.full_name.localeCompare(b.full_name));

        // Monthly Board shows ONLY supervisor-confirmed attendance. Load the
        // month's confirmations for this client/category and gate every mark on
        // a matching (site, shift, date). A confirmation with site_id null is
        // client-wide / a category group — it matches any of the client's sites.
        const [cy, cm] = month.split("-").map(Number);
        const monthEndDate = `${month}-${String(new Date(cy, cm, 0).getDate()).padStart(2, "0")}`;
        const confQ = supabase
          .from("attendance_confirmations")
          .select("site_id, shift_code, attendance_date")
          .gte("attendance_date", monthStartDate)
          .lte("attendance_date", monthEndDate);
        const { data: confs } = await (synthetic ? confQ.eq("category", category as string) : confQ.eq("client_id", clientId));
        const anySite = new Set<string>(); // `${shift}|${date}`
        const bySite = new Set<string>(); // `${site}|${shift}|${date}`
        for (const c of (confs ?? []) as any[]) {
          if (c.site_id) bySite.add(`${c.site_id}|${c.shift_code}|${c.attendance_date}`);
          else anySite.add(`${c.shift_code}|${c.attendance_date}`);
        }
        const confirmedOnly = (empId: string, iso: string, ws: string): boolean => {
          if (anySite.has(`${ws}|${iso}`)) return true;
          const site = siteByGuard.get(empId) ?? null;
          return site ? bySite.has(`${site}|${ws}|${iso}`) : false;
        };

        const built = await buildAttendanceRows({
          month,
          employees,
          contracts: (contracts ?? []) as any[],
          clients: client ? ([client] as any[]) : [],
          confirmedOnly,
        });
        if (cancelled) return;
        setRows(built.rows);
        setCells(built.cellsByEmp);
        setDaysInMonth(built.daysInMonth);
        setMonthLabel(built.monthLabel);
      } catch (e: any) {
        if (!cancelled) setErr(e.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // reloadKey: re-fetch the grid after a cell is marked via override.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, siteId, month, reloadKey]);

  // Load OPS-Verify state (verification stamp + override log) for this client+month.
  useEffect(() => {
    let cancelled = false;
    setOpsMsg(null);
    (async () => {
      const verBase = supabase.from("attendance_month_verifications").select("verified_at").eq("period_month", monthStartDate);
      const ovBase = supabase.from("attendance_overrides")
        .select("id, employee_id, attendance_date, reason, before_value, after_value, created_by, created_at")
        .gte("attendance_date", monthStartDate).lte("attendance_date", `${month}-31`)
        .order("created_at", { ascending: false });
      const phBase = supabase.from("payroll_run_phases").select("phase, finance_verified_at").eq("period_month", monthStartDate);
      const [{ data: ver }, { data: ovs }, { data: ph }] = await Promise.all([
        (synthetic ? verBase.eq("category", category as string) : verBase.eq("client_id", clientId)).maybeSingle(),
        synthetic ? ovBase.eq("category", category as string) : ovBase.eq("client_id", clientId),
        (synthetic ? phBase.eq("category", category as string) : phBase.eq("client_id", clientId)).maybeSingle(),
      ]);
      if (cancelled) return;
      setVerifiedAt((ver as any)?.verified_at ?? null);
      setOverrides((ovs ?? []) as OverrideRow[]);
      setRunPhase((ph as any)?.phase ?? null);
      setFinanceVerified(!!(ph as any)?.finance_verified_at);
    })();
    return () => { cancelled = true; };
  }, [clientId, month, monthStartDate, reloadKey]);

  // Set of "empId|date" that has at least one override (an unmarked day so covered
  // is treated as resolved for OPS Verify).
  const overriddenKeys = useMemo(() => new Set(overrides.map((o) => `${o.employee_id}|${o.attendance_date}`)), [overrides]);

  // Un-verify is locked once payroll has moved past Draft for this scope+month.
  const phaseLocked = runPhase !== null;
  const unverifyLockMsg = financeVerified
    ? "Locked — this month is Finance Verified and can no longer be reversed."
    : `Locked — payroll is in ${runPhase === "finance_verify" ? "Finance Verify" : "Review"} for this month. Move it back to Draft to un-verify.`;

  const dayDate = (dayIdx: number) => `${month}-${String(dayIdx + 1).padStart(2, "0")}`;

  // Unmarked days = empty status cells (X / P / A / L are all fine). Flagged =
  // unmarked AND not yet overridden. Keyed per row+day for grid highlighting.
  const { flaggedKeys, outstanding } = useMemo(() => {
    const flagged = new Set<string>();
    const list: { empId: string; empName: string; date: string }[] = [];
    for (const row of rows) {
      if (!row.empId) continue;
      for (let i = 0; i < daysInMonth; i += 1) {
        if ((row.statusByDay[i] ?? "") !== "") continue;          // marked or X (not applicable)
        const date = dayDate(i);
        if (overriddenKeys.has(`${row.empId}|${date}`)) continue;  // resolved via override
        flagged.add(`${row.empId}|${i}`);
        list.push({ empId: row.empId, empName: row.name, date });
      }
    }
    return { flaggedKeys: flagged, outstanding: list };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, daysInMonth, overriddenKeys, month]);

  const runOpsVerify = async () => {
    setOpsMsg(null);
    if (!monthEnded) { setOpsMsg({ kind: "err", text: "This month hasn't ended yet — OPS Verify is available once the last day has passed." }); return; }
    if (outstanding.length > 0) {
      const preview = outstanding.slice(0, 8).map((o) => `${o.empName} (${o.date})`).join(", ");
      setOpsMsg({ kind: "err", text: `${outstanding.length} unmarked day(s) still outstanding: ${preview}${outstanding.length > 8 ? "…" : ""}. Mark or override them, then verify again.` });
      return;
    }
    setOpsBusy(true);
    const { error } = await supabase.from("attendance_month_verifications")
      .insert({ client_id: realClientId, category, period_month: monthStartDate, verified_by: currentUserId });
    setOpsBusy(false);
    if (error) { setOpsMsg({ kind: "err", text: error.message }); return; }
    setReloadKey((k) => k + 1);
    setOpsMsg({ kind: "ok", text: "Month OPS-Verified. Attendance for this client is now locked for the month." });
  };

  const unVerify = async () => {
    if (!window.confirm("Un-verify this month? Attendance edits will be unlocked again. The override audit log is kept.")) return;
    setOpsBusy(true);
    const delQ = supabase.from("attendance_month_verifications").delete().eq("period_month", monthStartDate);
    const { error } = await (synthetic ? delQ.eq("category", category as string) : delQ.eq("client_id", clientId));
    setOpsBusy(false);
    if (error) { setOpsMsg({ kind: "err", text: error.message }); return; }
    setReloadKey((k) => k + 1);
    setOpsMsg(null);
  };

  const shifts = useMemo(() => deriveAttendanceShifts(rows), [rows]);
  const S = shifts.length;
  const shiftIndex = useMemo(() => new Map(shifts.map((c, i) => [c, i])), [shifts]);

  // Per-day per-shift totals + grand sums, mirroring exportAttendance.
  const totals = useMemo(() => {
    const zeros = () => Array.from({ length: daysInMonth }, () => Array(S).fill(0) as number[]);
    const P = zeros(), L = zeros(), A = zeros();
    for (const row of rows) {
      for (let i = 0; i < daysInMonth; i += 1) {
        const st = row.statusByDay[i] ?? "";
        const ds = String(row.shiftByDay?.[i] ?? row.shift ?? "day").toLowerCase();
        const si = shiftIndex.get(ds) ?? 0;
        if (st === "P" || st === "DD") P[i][si] += 1;
        else if (st === "L") L[i][si] += 1;
        else if (st === "A") A[i][si] += 1;
      }
    }
    const grand = P.map((per, i) => per.map((v, s) => v + L[i][s] + A[i][s]));
    return {
      P, L, A, grand,
      sumP: rows.reduce((s, r) => s + r.presents, 0),
      sumA: rows.reduce((s, r) => s + r.absents, 0),
      sumL: rows.reduce((s, r) => s + r.leaves, 0),
      sumDD: rows.reduce((s, r) => s + r.doubleDuties, 0),
      sumPD: rows.reduce((s, r) => s + r.payDays, 0),
    };
  }, [rows, daysInMonth, S, shiftIndex]);

  const shiftMonth = (delta: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const download = () =>
    exportAttendance({
      monthLabel, daysInMonth, clientLabel: label, rows,
      fileName: `Attendance ${label} ${monthLabel}.xlsx`,
    });

  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const totalRowCells = (src: number[][], final?: string[]) => (
    <>
      {days.map((_, i) =>
        shifts.map((_c, s) => (
          <td key={`${i}-${s}`} className="border border-border px-1 py-0.5 text-center tabular-nums text-muted-foreground">
            {src[i]?.[s] || ""}
          </td>
        )),
      )}
      {final
        ? final.map((v, i) => <td key={i} className="border border-border px-1 py-0.5 text-center tabular-nums font-medium">{v}</td>)
        : Array(5).fill(0).map((_, i) => <td key={i} className="border border-border" />)}
    </>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 md:p-4" onClick={onClose}>
      {/* dvh, not vh: `vh` on a mobile WebView is the viewport with the URL bar
          hidden, so a 92vh sheet is taller than the screen and its bottom row
          is unreachable. The safe-area margins keep it clear of the notch and
          the home indicator, which `fixed` positioning ignores. */}
      <div
        style={{ marginTop: "var(--safe-top, 0px)", marginBottom: "var(--safe-bottom, 0px)" }}
        className="bg-card rounded-xl shadow-xl w-full max-w-[95vw] max-h-[92dvh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Two stacked rows on a phone (title+close, then the month controls),
            one row from `sm` up. Packing all four groups into a single
            non-wrapping flex row squeezed the month picker into the title. */}
        <div className="border-b border-border px-3 md:px-5 py-2.5 md:py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold text-foreground truncate flex items-center gap-2">
                Monthly Board — {label}
                {verifiedAt && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success-700 dark:text-success-500 bg-success-50 dark:bg-success-900/20 px-1.5 py-0.5 rounded" title={`OPS-Verified ${new Date(verifiedAt).toLocaleString()} — month locked`}>
                    <ShieldCheck className="w-3 h-3" /> OPS Verified <Lock className="w-3 h-3" />
                  </span>
                )}
              </h2>
              <p className="text-xs text-muted-foreground">
                {monthLabel || month}
                {verifiedAt && (
                  <span className="text-success-700 dark:text-success-500"> · OPS verified {new Date(verifiedAt).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}</span>
                )}
              </p>
            </div>
            <div className="hidden sm:flex items-center gap-1 shrink-0">
              <button onClick={() => shiftMonth(-1)} className="p-1.5 rounded hover:bg-accent" title="Previous month"><ChevronLeft className="w-4 h-4" /></button>
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="px-2 py-1 border border-border rounded-md text-sm bg-card" />
              <button onClick={() => shiftMonth(1)} className="p-1.5 rounded hover:bg-accent" title="Next month"><ChevronRight className="w-4 h-4" /></button>
            </div>
            {canOpsVerify && (
              verifiedAt ? (
                <Button size="sm" variant="secondary" className="hidden sm:inline-flex shrink-0" onClick={unVerify} disabled={opsBusy || phaseLocked} title={phaseLocked ? unverifyLockMsg : "Remove OPS verification"}>
                  <Lock className="w-4 h-4 mr-1.5" /> Un-verify
                </Button>
              ) : (
                <Button size="sm" variant="primary" className="hidden sm:inline-flex shrink-0" onClick={runOpsVerify} disabled={opsBusy || loading}>
                  {opsBusy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-1.5" />} OPS Verify
                </Button>
              )
            )}
            <Button size="sm" variant="secondary" className="hidden sm:inline-flex shrink-0" onClick={download} disabled={loading || rows.length === 0}>
              <Download className="w-4 h-4 mr-1.5" /> Download Excel
            </Button>
            <button onClick={onClose} className="p-1.5 rounded hover:bg-accent shrink-0" title="Close"><X className="w-4 h-4" /></button>
          </div>
          <div className="mt-2 flex items-center gap-1 sm:hidden">
            <button onClick={() => shiftMonth(-1)} className="p-1.5 rounded hover:bg-accent shrink-0" title="Previous month"><ChevronLeft className="w-4 h-4" /></button>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="flex-1 min-w-0 px-2 py-1 border border-border rounded-md text-sm bg-card" />
            <button onClick={() => shiftMonth(1)} className="p-1.5 rounded hover:bg-accent shrink-0" title="Next month"><ChevronRight className="w-4 h-4" /></button>
            <Button size="sm" variant="secondary" className="shrink-0" onClick={download} disabled={loading || rows.length === 0} title="Download Excel">
              <Download className="w-4 h-4" />
            </Button>
            {canOpsVerify && (
              verifiedAt ? (
                <Button size="sm" variant="secondary" className="shrink-0" onClick={unVerify} disabled={opsBusy || phaseLocked} title={phaseLocked ? unverifyLockMsg : "Un-verify"}><Lock className="w-4 h-4" /></Button>
              ) : (
                <Button size="sm" variant="primary" className="shrink-0" onClick={runOpsVerify} disabled={opsBusy || loading} title="OPS Verify"><ShieldCheck className="w-4 h-4" /></Button>
              )
            )}
          </div>
          {opsMsg && (
            <div className={`mt-2 flex items-start gap-2 px-3 py-2 rounded-md text-xs ${opsMsg.kind === "ok" ? "bg-success-50 text-success-700 border border-success-200 dark:bg-success-900/20 dark:text-success-400" : "bg-danger-50 text-danger-700 border border-danger-200"}`}>
              {opsMsg.kind === "ok" ? <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
              <span className="flex-1">{opsMsg.text}</span>
              <button onClick={() => setOpsMsg(null)}><X className="w-3.5 h-3.5" /></button>
            </div>
          )}
          {!verifiedAt && canOpsVerify && !loading && rows.length > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {outstanding.length === 0
                ? monthEnded ? "All days confirmed. Ready to OPS Verify." : "All days confirmed — verify once the month has ended."
                : `${outstanding.length} unconfirmed day(s) highlighted below. Confirm those shifts on the Attendance board — attendance only appears here once the supervisor confirms it.`}
            </p>
          )}
          {verifiedAt && canOpsVerify && phaseLocked && (
            <p className="mt-2 text-[11px] text-warning-700 dark:text-warning-500 flex items-center gap-1"><Lock className="w-3 h-3" /> {unverifyLockMsg}</p>
          )}
        </div>

        <div className="flex-1 overflow-auto p-2 md:p-4">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
            </div>
          ) : err ? (
            <p className="text-sm text-danger-600 py-8 text-center">{err}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No employees on this {siteId ? "site" : "client"} for {monthLabel}.</p>
          ) : (
            <table className="text-xs border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-secondary">
                  {["Ser.", "Name", "Desg.", "Emp #"].map((h) => (
                    <th key={h} rowSpan={2} className="border border-border px-2 py-1 text-left whitespace-nowrap bg-secondary">{h}</th>
                  ))}
                  {days.map((d) => (
                    <th key={d} colSpan={S} className="border border-border px-1 py-1 text-center tabular-nums bg-secondary">{d}</th>
                  ))}
                  {["Presents", "Absents", "Leaves", "Double Duty", "Pay Days"].map((h) => (
                    <th key={h} rowSpan={2} className="border border-border px-1.5 py-1 text-center whitespace-nowrap bg-secondary">{h}</th>
                  ))}
                </tr>
                <tr className="bg-secondary">
                  {days.map((d) =>
                    shifts.map((c) => (
                      <th key={`${d}-${c}`} className="border border-border px-1 py-0.5 text-center text-[10px] text-muted-foreground bg-secondary" title={`${c} shift`}>{shiftAbbr(c)}</th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.empCode + row.serial} className="hover:bg-accent/40">
                    <td className="border border-border px-2 py-0.5 tabular-nums">{String(row.serial).padStart(2, "0")}</td>
                    <td className="border border-border px-2 py-0.5 whitespace-nowrap">
                      {row.name}
                      {row.separationNote && <span className="text-muted-foreground"> ({row.separationNote})</span>}
                    </td>
                    <td className="border border-border px-2 py-0.5">{row.designation}</td>
                    <td className="border border-border px-2 py-0.5 whitespace-nowrap font-mono text-[11px]">{row.empCode}</td>
                    {days.map((_, i) => {
                      const st = row.statusByDay[i] ?? "";
                      const ds = String(row.shiftByDay?.[i] ?? row.shift ?? "day").toLowerCase();
                      const si = shiftIndex.get(ds) ?? 0;
                      const date = dayDate(i);
                      const flagged = row.empId ? flaggedKeys.has(`${row.empId}|${i}`) : false;
                      // A confirmed day only shows a real P/A/L here (unconfirmed =
                      // blank). Override is the ONE way to change such a day, and
                      // only once the month has ended (and while it isn't yet
                      // OPS-verified). Before month-end the board stays read-only;
                      // editing happens on the Attendance board until it locks.
                      // The guard's own (primary) shift is overridable to any
                      // status once the day is confirmed, the month has ended, and
                      // it isn't OPS-verified.
                      const canOverridePrimary = !!row.empId && monthEnded && !verifiedAt && (st === "P" || st === "A" || st === "L" || st === "DD");
                      // A SECOND shift = double duty, which only exists when the
                      // guard is PRESENT that day. If they're absent/leave the other
                      // shift columns stay inert, and adding one is Present-only.
                      const canAddSecond = !!row.empId && monthEnded && !verifiedAt && (st === "P" || st === "DD");
                      return shifts.map((cShift, s) => {
                        const isPrimary = s === si;
                        // Primary column = the guard's own status; other columns =
                        // any second-shift (double-duty) mark from `cells`.
                        const cellStatus = isPrimary
                          ? st
                          : (row.empId ? cells.get(row.empId)?.get(`${i + 1}|${cShift}`) ?? "" : "");
                        const clickable = isPrimary ? canOverridePrimary : canAddSecond;
                        const cellBg = isPrimary && flagged ? "bg-danger-100 dark:bg-danger-900/30"
                          : clickable ? "cursor-pointer hover:bg-accent" : "";
                        return (
                          <td
                            key={`${i}-${s}`}
                            onClick={clickable ? () => setOvTarget({ empId: row.empId!, empName: row.name, date, current: cellStatus, shift: cShift, presentOnly: !isPrimary }) : undefined}
                            title={isPrimary && flagged ? "Not confirmed — confirm this shift on the Attendance board to show it here"
                              : !clickable ? undefined
                              : isPrimary ? "Confirmed & month ended — click to override"
                              : cellStatus ? "Double duty — click to edit" : `Click to add a ${cShift} shift (double duty)`}
                            className={`border border-border px-1 py-0.5 text-center font-medium ${cellBg} ${statusClass(cellStatus)}`}
                          >
                            {cellStatus}
                          </td>
                        );
                      });
                    })}
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums">{row.presents}</td>
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums">{row.absents}</td>
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums">{row.leaves}</td>
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums">{row.doubleDuties || ""}</td>
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums font-medium">{row.payDays}</td>
                  </tr>
                ))}
                <tr className="bg-secondary/60 font-medium">
                  <td colSpan={4} className="border border-border px-2 py-0.5">Total Presents</td>
                  {totalRowCells(totals.P, [String(totals.sumP), String(totals.sumA), String(totals.sumL), String(totals.sumDD), String(totals.sumPD)])}
                </tr>
                <tr className="bg-secondary/40">
                  <td colSpan={4} className="border border-border px-2 py-0.5">Total Leaves</td>
                  {totalRowCells(totals.L)}
                </tr>
                <tr className="bg-secondary/40">
                  <td colSpan={4} className="border border-border px-2 py-0.5">Total Absents</td>
                  {totalRowCells(totals.A)}
                </tr>
                <tr className="bg-secondary/60 font-medium">
                  <td colSpan={4} className="border border-border px-2 py-0.5">Grand Total</td>
                  {totalRowCells(totals.grand)}
                </tr>
              </tbody>
            </table>
          )}

          {!loading && !err && rows.length > 0 && (
            <div className="mt-3 text-[11px] text-muted-foreground space-y-0.5">
              {shifts.map((c) => <span key={c} className="inline-block mr-3">{shiftAbbr(c)} = {c} shift</span>)}
              <div>P / A / L = present / absent / leave · X = not markable (separated / before joining / off-contract) · pay days = presents + allowed leaves − excess</div>
              <div className="text-muted-foreground">
                Shows only attendance the supervisor has confirmed on the Attendance board; unconfirmed days stay blank.
                {monthEnded
                  ? " The month has ended — a confirmed day is now locked everywhere else and can be changed only by clicking it here to override."
                  : " Until the month ends, this view is read-only — edit on the Attendance board."}
              </div>
              {canOpsVerify && <div><span className="inline-block w-3 h-3 align-middle rounded-sm bg-danger-100 dark:bg-danger-900/30 mr-1" /> not yet confirmed (blocks OPS Verify)</div>}
            </div>
          )}
        </div>
      </div>

      {ovTarget && (
        <OverrideModal
          target={ovTarget}
          clientId={realClientId}
          category={category}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
          locked={!!verifiedAt}
          presentOnly={!!ovTarget.presentOnly}
          history={overrides.filter((o) => o.employee_id === ovTarget.empId && o.attendance_date === ovTarget.date)}
          onClose={() => setOvTarget(null)}
          onSaved={() => { setOvTarget(null); setReloadKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}

// Status tokens stored in attendance_records (Phase-6 model — lowercase), mapped
// to the P/A/L letters the sheet renders.
const OV_STATUSES: { key: "present" | "absent" | "leave"; label: string; letter: string; activeBtn: string }[] = [
  { key: "present", label: "Present", letter: "P", activeBtn: "bg-success-600 text-white border-success-600" },
  { key: "absent", label: "Absent", letter: "A", activeBtn: "bg-danger-600 text-white border-danger-600" },
  { key: "leave", label: "Leave", letter: "L", activeBtn: "bg-warning-600 text-white border-warning-600" },
];
const letterToStatus = (l: string) => OV_STATUSES.find((s) => s.letter === l)?.key ?? null;

// Override a cell: PICK the status (Present / Absent / Leave), give a required
// reason, and it marks the day (attendance_records) + writes a permanent audit
// row. Prior overrides for this exact employee+date are listed below.
function OverrideModal({
  target, clientId, category, currentUserId, currentUserRole, locked, presentOnly = false, history, onClose, onSaved,
}: {
  target: { empId: string; empName: string; date: string; current: string; shift: string };
  clientId: string | null;
  category: string | null;
  currentUserId: string | null;
  currentUserRole: string | null;
  locked: boolean;
  // A second shift can only be a double-duty Present — offer Present alone and
  // default to it (used when overriding a shift other than the guard's own).
  presentOnly?: boolean;
  history: OverrideRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const wasUnmarked = target.current === "";
  const statusOptions = presentOnly ? OV_STATUSES.filter((s) => s.key === "present") : OV_STATUSES;
  const [status, setStatus] = useState<"present" | "absent" | "leave" | null>(presentOnly ? "present" : letterToStatus(target.current));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (locked) { setErr("This month is OPS-verified and locked. Un-verify it to change attendance."); return; }
    if (!status) { setErr("Choose Present, Absent, or Leave."); return; }
    if (!reason.trim()) { setErr("A reason is required to override."); return; }
    setBusy(true); setErr(null);
    // 1. Mark the day (upsert keyed on employee+date+worked_shift, per the model).
    const { error: mErr } = await supabase.from("attendance_records").upsert({
      employee_id: target.empId,
      attendance_date: target.date,
      // A second (non-primary) shift IS double duty — store it as DD, never a
      // second Present, so the day reads P on the normal shift + DD on the extra.
      // "leave" goes in as-is: 0224 folded rotation_leave into leave and dropped
      // it from attendance_records_status_check, so translating to it here is
      // what raised "violates check constraint attendance_records_status_check".
      status: presentOnly ? "double_duty" : status,
      absent_reason: status === "absent" ? "awol" : null,
      scheduled_shift: target.shift,
      worked_shift: target.shift,
      entry_type: presentOnly ? "double_duty" : "normal",
      source: "manual",
      marked_by_role: currentUserRole ?? "hr",
      marked_by_user_id: currentUserId,
      marked_at: new Date().toISOString(),
      supervisor_override: true,
      override_reason: reason.trim(),
    }, { onConflict: "employee_id,attendance_date,worked_shift" });
    if (mErr) { setBusy(false); setErr(mErr.message); return; }
    // 2. Permanent audit record (before → after + reason).
    const { error: aErr } = await supabase.from("attendance_overrides").insert({
      client_id: clientId,
      category,
      employee_id: target.empId,
      attendance_date: target.date,
      reason: reason.trim(),
      before_value: wasUnmarked ? "unmarked" : target.current,
      after_value: presentOnly ? "DD" : (OV_STATUSES.find((s) => s.key === status)?.letter ?? status),
      created_by: currentUserId,
    });
    setBusy(false);
    if (aErr) { setErr(aErr.message); return; }
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div className="bg-card rounded-xl shadow-xl w-full max-w-md flex flex-col max-h-[85dvh]" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-border px-4 py-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-warning-600" />
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-sm text-foreground truncate">Override — {target.empName}</h3>
            <p className="text-xs text-muted-foreground">{target.date} · {target.shift} shift · currently {wasUnmarked ? "unmarked" : target.current}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3 overflow-auto">
          {locked && (
            <p className="text-xs text-danger-600 flex items-center gap-1"><Lock className="w-3.5 h-3.5" /> Month is OPS-verified and locked. Un-verify to edit.</p>
          )}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              {presentOnly ? "Double duty — add this shift as" : "Mark this day as"}
            </label>
            <div className="flex gap-2">
              {statusOptions.map((s) => (
                <button
                  key={s.key} type="button" disabled={locked}
                  onClick={() => setStatus(s.key)}
                  className={`flex-1 px-3 py-2 rounded-md text-sm border transition-colors disabled:opacity-50 ${status === s.key ? s.activeBtn : "border-border text-foreground hover:bg-accent"}`}
                >
                  {presentOnly ? "Double Duty (DD)" : s.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Reason (required)</label>
            <textarea
              value={reason} onChange={(e) => setReason(e.target.value)} rows={3} disabled={locked}
              placeholder="Why is this day being set manually? e.g. guard confirmed present via WhatsApp, records lost, etc."
              className="w-full px-3 py-2 border border-border rounded-md text-sm bg-card focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
            />
          </div>
          {err && <p className="text-xs text-danger-600">{err}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" className="flex-1" onClick={save} disabled={busy || locked || !status || !reason.trim()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Confirm Override"}
            </Button>
            <Button size="sm" variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
          </div>

          <div className="pt-2 border-t border-border">
            <p className="text-xs font-medium text-foreground mb-1.5">Override History</p>
            {history.length === 0 ? (
              <p className="text-xs text-muted-foreground">No prior overrides for this day.</p>
            ) : (
              <ul className="space-y-2">
                {history.map((o) => (
                  <li key={o.id} className="text-xs bg-secondary/50 rounded-md px-2.5 py-1.5">
                    <div className="text-foreground">{o.reason}</div>
                    <div className="text-muted-foreground mt-0.5">
                      {new Date(o.created_at).toLocaleString()}
                      {(o.before_value || o.after_value) && <> · {o.before_value ?? "?"} → {o.after_value ?? "?"}</>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
