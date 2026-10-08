// On-screen version of the monthly attendance Excel sheet, per client (optionally
// one site). Renders the exact same grid the exporter produces — day columns split
// by shift, P/A/L/X marks, per-day and grand totals, legend — plus a Download
// button that hands the identical rows to exportAttendance. View without downloading.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X, Download, Loader2, ChevronLeft, ChevronRight, ShieldCheck, AlertTriangle, Lock } from "lucide-react";
import Button from "./Button";
import { supabase } from "../lib/supabase";
import { guardDisplayCode } from "../lib/guardCode";
import BoardVerificationBar, { type HalfInfo, type HalfVerification } from "./BoardVerificationBar";
import ThemedSelect from "./ThemedSelect";
import { useRegion } from "../lib/region";
import { buildAttendanceRows, buildRelieverRows, loadSheetEmployees, loadSiteByGuard, loadConfirmationGate } from "../lib/attendanceSheet";
import { exportAttendance, deriveAttendanceShifts, shiftAbbr, type AttendanceEmployeeRow } from "../lib/excel";

const previousMonth = () => {
  const d = new Date();
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, "0")}`;
};

// Frozen left columns (Ser. / Name / Desg. / Emp #) — fixed widths + cumulative
// left offsets so they stick in place while the day columns scroll horizontally.
const LEAD = [
  { w: 44, left: 0 },    // Ser.
  { w: 210, left: 44 },  // Name
  { w: 52, left: 254 },  // Desg.
  { w: 96, left: 306 },  // Emp #
] as const;
const LEAD_TOTAL = LEAD.reduce((s, c) => s + c.w, 0); // 402 — width the totals row's label spans
const leadCell = (i: number) => ({ left: LEAD[i].left, width: LEAD[i].w, minWidth: LEAD[i].w, maxWidth: LEAD[i].w });

// The header is frozen the same way the lead columns are: per-CELL `position:
// sticky`, never on <thead> or <tr>.
//
// Sticky on a row or a row group is the obvious way to write it and it is the
// reason the headings drifted. Browsers only began honouring it on <thead>
// recently and still disagree with `border-collapse: collapse`, under which
// borders belong to the table's own grid rather than to the cells — so a header
// that did stick left its borders behind and opened a line of bare background
// between itself and the first row. Sticky cells have always worked.
//
// Two header rows means two offsets: the day numbers at 0, the D/N/E letters
// directly beneath them. The second offset is the MEASURED height of the first
// row, not a constant — the row's height follows the font and the theme, and a
// guessed number is a gap that reappears the moment either changes.
const stickyHead = (top: number) => ({
  top,
  // border-collapse drops a sticky cell's own borders. Redrawing the bottom
  // edge as an inset shadow keeps the rule under the header while it floats.
  boxShadow: "inset 0 -1px 0 var(--border, rgb(226 232 240))",
});

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
  clientId, clientName, siteId, siteName, companyId, canHrVerify = false,
  currentUserId = null, currentUserRole = null, onClose, inline = false, initialMonth, onMonthChange, initialBranchId,
}: {
  clientId: string;
  clientName: string;
  siteId?: string | null;
  siteName?: string | null;
  companyId?: string | null;
  /** Kept for callers; Ops now verifies on the Attendance Run, not here. */
  canOpsVerify?: boolean;
  canHrVerify?: boolean;
  currentUserId?: string | null;
  currentUserRole?: string | null;
  onClose?: () => void;
  /** Render inside a page (the Attendance page's Monthly tab) instead of as a pop-up. */
  inline?: boolean;
  /** YYYY-MM to open on (the Attendance Run passes its month). Defaults to this month. */
  initialMonth?: string;
  /** Told whenever the board's month changes (the Monthly tab labels its client list by it). */
  onMonthChange?: (month: string) => void;
  /** Staff-group boards: the region to open on (the Attendance Run passes its row's). */
  initialBranchId?: string | null;
}) {
  // Opens on the PREVIOUS month — the one being closed and verified (asked 2026-10-05).
  const [month, setMonth] = useState(initialMonth ?? previousMonth());
  useEffect(() => { onMonthChange?.(month); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps
  // What the grid shows: the whole month (default), or one half (0493). HR's
  // verify button acts on what is shown — a half, or both halves in one go.
  const [view, setView] = useState<"month" | 1 | 2>("month");
  // Both halves' verification rows. The edit lock is decided per day by the
  // half that day falls in.
  const [halfVers, setHalfVers] = useState<Record<1 | 2, HalfVerification | null>>({ 1: null, 2: null });
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
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
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
  // 0498: a staff group (office staff etc.) is verified PER REGION. Its board
  // shows one region's staff and verifies that region only. A regional user is
  // pinned to their own region; head office picks one.
  const { regions, regionId: globalRegion, locked: regionLocked } = useRegion();
  const [branch, setBranch] = useState<string | null>(() =>
    initialBranchId !== undefined ? initialBranchId : globalRegion ?? null);
  useEffect(() => {
    if (!synthetic || branch) return;
    if (globalRegion) setBranch(globalRegion);
    else if (regions[0]) setBranch(regions[0].id);
  }, [synthetic, branch, globalRegion, regions]);
  const branchId = synthetic ? branch : null;
  const branchName = regions.find((r) => r.id === branchId)?.name ?? null;
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
        // The roster, the site map and the confirmation gate all come from
        // lib/attendanceSheet now. They used to be written out here, and the
        // Attendance board's client export wrote its OWN version of the first
        // two and NONE of the third — which is why the two sheets disagreed.
        const [{ data: client }, { data: contracts }] = await Promise.all([
          // Synthetic groups have no real client row.
          synthetic
            ? Promise.resolve({ data: null })
            : supabase.from("clients").select("id, name, employee_id_prefix, allowed_leaves_per_month").eq("id", clientId).single(),
          synthetic
            ? Promise.resolve({ data: [] })
            : supabase.from("contracts").select("id, allowed_leaves_per_month").eq("client_id", clientId),
        ]);
        const prefix = (client as any)?.employee_id_prefix ?? null;

        // Guard → current site (open posting). Used both to narrow to one site
        // AND to match each guard against the right per-site confirmation.
        const siteByGuard = await loadSiteByGuard(realClientId);
        const employees = await loadSheetEmployees({
          clientId: realClientId, category, siteId, siteByGuard, clientPrefix: prefix,
          ...(synthetic ? { branchId } : {}),
        });

        // Monthly Board shows ONLY supervisor-confirmed attendance: an
        // unconfirmed mark renders blank, exactly as if it were never entered.
        const [cy, cm] = month.split("-").map(Number);
        const monthEndDate = `${month}-${String(new Date(cy, cm, 0).getDate()).padStart(2, "0")}`;
        const confirmedOnly = await loadConfirmationGate({
          clientId: realClientId, category,
          startDate: monthStartDate, endDate: monthEndDate, siteByGuard,
        });

        const built = await buildAttendanceRows({
          month,
          employees,
          contracts: (contracts ?? []) as any[],
          clients: client ? ([client] as any[]) : [],
          confirmedOnly,
        });
        // Standalone reliever coverage: guards who covered THIS client on some
        // day(s) but aren't on its roster (real clients only). Roster guards'
        // own reliever days are already folded into their row above, so they're
        // excluded here to avoid a duplicate row.
        const relieverRows = synthetic
          ? []
          : await buildRelieverRows({
              month, clientId, clientPrefix: prefix,
              excludeEmpIds: employees.map((e) => e.id),
            });
        // Continue the serial column past the roster so numbering is unbroken.
        relieverRows.forEach((r, i) => (r.serial = built.rows.length + i + 1));
        if (cancelled) return;
        setRows([...built.rows, ...relieverRows]);
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
  }, [clientId, siteId, month, reloadKey, branchId]);

  // Load OPS-Verify state (verification stamp + override log) for this client+month.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const verBase = supabase.from("attendance_month_verifications").select("verified_at").eq("period_month", monthStartDate);
      const ovBase = supabase.from("attendance_overrides")
        .select("id, employee_id, attendance_date, reason, before_value, after_value, created_by, created_at")
        .gte("attendance_date", monthStartDate).lte("attendance_date", `${month}-31`)
        .order("created_at", { ascending: false });
      const phBase = supabase.from("payroll_run_phases").select("phase, finance_verified_at").eq("period_month", monthStartDate);
      const hvBase = supabase.from("attendance_half_verifications")
        .select("id, half, hr_verified_at, hr_verified_by_name, ops_verified_at, ops_verified_by_name")
        .eq("period_month", monthStartDate);
      const [{ data: ver }, { data: ovs }, { data: ph }, { data: hv }] = await Promise.all([
        (synthetic ? verBase.eq("category", category as string) : verBase.eq("client_id", clientId)).maybeSingle(),
        synthetic ? ovBase.eq("category", category as string) : ovBase.eq("client_id", clientId),
        (synthetic ? phBase.eq("category", category as string) : phBase.eq("client_id", clientId)).maybeSingle(),
        synthetic
          ? (branchId ? hvBase.eq("category", category as string).eq("branch_id", branchId) : hvBase.eq("category", category as string).is("branch_id", null))
          : hvBase.eq("client_id", clientId),
      ]);
      if (cancelled) return;
      const byHalf: Record<1 | 2, HalfVerification | null> = { 1: null, 2: null };
      for (const r of (hv ?? []) as (HalfVerification & { half: 1 | 2 })[]) byHalf[r.half] = r;
      setHalfVers(byHalf);
      setVerifiedAt((ver as any)?.verified_at ?? null);
      setOverrides((ovs ?? []) as OverrideRow[]);
      setRunPhase((ph as any)?.phase ?? null);
    })();
    return () => { cancelled = true; };
  }, [clientId, month, monthStartDate, reloadKey, branchId]);

  // Half ranges, by the same exact-halves rule as attendance_half_of() in the
  // database (0493): half 1 is days 1..floor(dim/2).
  const halfCut = Math.floor(daysInMonth / 2);
  const rangeOf = (h: 1 | 2) => (h === 1 ? { first: 0, last: halfCut - 1 } : { first: halfCut, last: daysInMonth - 1 });
  const viewFirstIdx = view === "month" ? 0 : rangeOf(view).first;
  const viewLastIdx = view === "month" ? daysInMonth - 1 : rangeOf(view).last;
  const halfMeta = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const mon = new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short" });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const meta = (h: 1 | 2) => {
      const r = h === 1 ? { first: 0, last: halfCut - 1 } : { first: halfCut, last: daysInMonth - 1 };
      const lastDay = new Date(y, m - 1, r.last + 1); lastDay.setHours(0, 0, 0, 0);
      return { label: `${r.first + 1}–${r.last + 1} ${mon}`, ended: lastDay < today };
    };
    return { 1: meta(1), 2: meta(2) };
  }, [month, halfCut, daysInMonth]);
  // Per-day lock for the whole-month grid: is the half this day falls in locked?
  const dayLocked = (i: number) =>
    !!verifiedAt || !!halfVers[i < halfCut ? 1 : 2]?.hr_verified_at;
  const dateLocked = (iso: string) => dayLocked(Number(iso.slice(8, 10)) - 1);

  // Set of "empId|date" that has at least one override (an unmarked day so covered
  // is treated as resolved for OPS Verify).
  const overriddenKeys = useMemo(() => new Set(overrides.map((o) => `${o.employee_id}|${o.attendance_date}`)), [overrides]);

  // Cells whose LATEST override cleared them (after_value 'cleared') and that carry
  // no mark now — so a day reset to unmarked shows as cleared, but one cleared then
  // re-marked does not. `overrides` is ordered created_at desc, so the first row per
  // key is the latest word on it.
  const clearedKeys = useMemo(() => {
    const latest = new Map<string, string | null>();
    for (const o of overrides) {
      const k = `${o.employee_id}|${o.attendance_date}`;
      if (!latest.has(k)) latest.set(k, o.after_value);
    }
    const s = new Set<string>();
    for (const [k, v] of latest) if (v === "cleared") s.add(k);
    return s;
  }, [overrides]);

  const dayDate = (dayIdx: number) => `${month}-${String(dayIdx + 1).padStart(2, "0")}`;

  // Unmarked days = empty status cells (X / P / A / L are all fine). Flagged =
  // unmarked AND not yet overridden. Keyed per row+day for grid highlighting.
  const { flaggedKeys, outstandingByHalf } = useMemo(() => {
    const flagged = new Set<string>();
    const byHalf: Record<1 | 2, { empId: string; empName: string; date: string }[]> = { 1: [], 2: [] };
    for (const row of rows) {
      if (!row.empId) continue;
      // Reliever coverage rows are allowed gaps (a reliever may cover 1 day of
      // 31) — they never flag or block OPS Verify, and need no per-gap override.
      if (row.isReliever) continue;
      for (let i = 0; i < daysInMonth; i += 1) {
        // Belt-and-braces per-day exemption (also covers any future mixed row).
        if (row.relieverByDay?.[i]) continue;
        if ((row.statusByDay[i] ?? "") !== "") continue;          // marked or X (not applicable)
        const date = dayDate(i);
        if (overriddenKeys.has(`${row.empId}|${date}`)) continue;  // resolved via override
        flagged.add(`${row.empId}|${i}`);
        // Each half's own gaps block that half's HR Verify.
        byHalf[i < halfCut ? 1 : 2].push({ empId: row.empId, empName: row.name, date });
      }
    }
    return { flaggedKeys: flagged, outstandingByHalf: byHalf };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, daysInMonth, overriddenKeys, month, halfCut]);

  const halvesInfo: Record<1 | 2, HalfInfo> = {
    1: { ...halfMeta[1], ver: halfVers[1], outstanding: outstandingByHalf[1] },
    2: { ...halfMeta[2], ver: halfVers[2], outstanding: outstandingByHalf[2] },
  };
  const viewOutstanding = view === "month" ? [...outstandingByHalf[1], ...outstandingByHalf[2]] : outstandingByHalf[view];
  const viewLocked = view === "month" ? dayLocked(0) && dayLocked(daysInMonth - 1) : dayLocked(rangeOf(view).first);
  const viewEnded = view === "month" ? halfMeta[2].ended : halfMeta[view].ended;

  // Per-row counts for what the grid shows. In the whole-month view these are
  // the builder's own month totals; in a half view, that half's days.
  const viewCounts = useMemo(() => {
    const m = new Map<AttendanceEmployeeRow, { p: number; a: number; l: number; dd: number }>();
    for (const row of rows) {
      if (view === "month") { m.set(row, { p: row.presents, a: row.absents, l: row.leaves, dd: row.doubleDuties }); continue; }
      let p = 0, a = 0, l = 0, dd = 0;
      for (let i = viewFirstIdx; i <= viewLastIdx; i += 1) {
        const st = row.statusByDay[i] ?? "";
        if (st === "P") p += 1;
        else if (st === "DD") { p += 1; dd += 1; }
        else if (st === "A") a += 1;
        else if (st === "L") l += 1;
      }
      m.set(row, { p, a, l, dd });
    }
    return m;
  }, [rows, view, viewFirstIdx, viewLastIdx]);

  const shifts = useMemo(() => deriveAttendanceShifts(rows), [rows]);
  const S = shifts.length;
  const shiftIndex = useMemo(() => new Map(shifts.map((c, i) => [c, i])), [shifts]);

  // Measured height of the day-number row, so the shift-letter row underneath it
  // freezes flush against it instead of at a guessed offset. Observed rather
  // than read once: the row resizes with the theme, the font and the month.
  const dayRowRef = useRef<HTMLTableRowElement>(null);
  const [dayRowH, setDayRowH] = useState(0);
  useLayoutEffect(() => {
    const el = dayRowRef.current;
    if (!el) return;
    const measure = () => setDayRowH(el.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, rows.length, S]);

  // Per-day per-shift totals + grand sums, mirroring exportAttendance.
  const totals = useMemo(() => {
    const zeros = () => Array.from({ length: daysInMonth }, () => Array(S).fill(0) as number[]);
    const P = zeros(), L = zeros(), A = zeros();
    // Totals describe the ASSIGNED roster's strength (grand = P+A+L per day = the
    // bodies the client contracted). Relievers are cover on top of that, so they
    // are excluded here — counting them would double the head on a covered day.
    const assigned = rows.filter((r) => !r.isReliever);
    for (const row of assigned) {
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
      sumP: assigned.reduce((s, r) => s + (viewCounts.get(r)?.p ?? 0), 0),
      sumA: assigned.reduce((s, r) => s + (viewCounts.get(r)?.a ?? 0), 0),
      sumAL: assigned.reduce((s, r) => s + (r.allowedLeaves ?? 0), 0),
      sumL: assigned.reduce((s, r) => s + (viewCounts.get(r)?.l ?? 0), 0),
      sumDD: assigned.reduce((s, r) => s + (viewCounts.get(r)?.dd ?? 0), 0),
      sumPD: assigned.reduce((s, r) => s + r.payDays, 0),
    };
  }, [rows, daysInMonth, S, shiftIndex, viewCounts]);

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

  const days = Array.from({ length: viewLastIdx - viewFirstIdx + 1 }, (_, k) => viewFirstIdx + k + 1);
  const totalRowCells = (src: number[][], final?: string[]) => (
    <>
      {days.map((d) => d - 1).map((i) =>
        shifts.map((_c, s) => (
          <td key={`${i}-${s}`} className="border border-border px-1 py-0.5 text-center tabular-nums text-muted-foreground">
            {src[i]?.[s] || ""}
          </td>
        )),
      )}
      {final
        ? final.map((v, i) => <td key={i} className="border border-border px-1 py-0.5 text-center tabular-nums font-medium">{v}</td>)
        : Array(6).fill(0).map((_, i) => <td key={i} className="border border-border" />)}
    </>
  );

  return (
    <div
      className={inline ? "" : "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 md:p-4"}
      onClick={inline ? undefined : onClose}
    >
      {/* dvh, not vh: `vh` on a mobile WebView is the viewport with the URL bar
          hidden, so a 92vh sheet is taller than the screen and its bottom row
          is unreachable. The safe-area margins keep it clear of the notch and
          the home indicator, which `fixed` positioning ignores. */}
      <div
        style={inline ? undefined : { marginTop: "var(--safe-top, 0px)", marginBottom: "var(--safe-bottom, 0px)" }}
        className={inline
          ? "bg-card rounded-lg border border-border w-full max-h-[calc(100dvh-14rem)] min-h-[24rem] flex flex-col overflow-hidden"
          : "bg-card rounded-xl shadow-xl w-full max-w-[95vw] max-h-[92dvh] flex flex-col overflow-hidden"}
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
                {dayLocked(0) && dayLocked(daysInMonth - 1) && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success-700 dark:text-success-500 bg-success-50 dark:bg-success-900/20 px-1.5 py-0.5 rounded" title="Both halves verified — the month's attendance is locked">
                    <ShieldCheck className="w-3 h-3" /> Verified <Lock className="w-3 h-3" />
                  </span>
                )}
              </h2>
              <p className="text-xs text-muted-foreground">
                {monthLabel || month}
                {synthetic && branchName && <span> · {branchName}</span>}
              </p>
            </div>
            {synthetic && !regionLocked && regions.length > 1 && (
              <ThemedSelect
                value={branch ?? ""}
                onChange={(e) => setBranch(e.target.value || null)}
                className="px-2 py-1 border border-border rounded-md text-sm bg-card shrink-0"
                title="Staff groups are verified per region"
              >
                {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </ThemedSelect>
            )}
            <div className="hidden sm:flex items-center gap-1 shrink-0">
              <button onClick={() => shiftMonth(-1)} className="p-1.5 rounded hover:bg-accent" title="Previous month"><ChevronLeft className="w-4 h-4" /></button>
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="px-2 py-1 border border-border rounded-md text-sm bg-card" />
              <button onClick={() => shiftMonth(1)} className="p-1.5 rounded hover:bg-accent" title="Next month"><ChevronRight className="w-4 h-4" /></button>
            </div>
            <div className="hidden sm:block">            <div className="inline-flex items-center rounded-md border border-border p-0.5 bg-secondary shrink-0" role="tablist" aria-label="What the board shows">
              {([["month", "Whole month"], [1, "1st half"], [2, "2nd half"]] as const).map(([v, text]) => {
                const range = v === "month" ? "" : v === 1 ? `1–${halfCut}` : `${halfCut + 1}–${daysInMonth}`;
                return (
                  <button
                    key={String(v)}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    onClick={() => setView(v)}
                    className={`px-2.5 py-1 rounded text-xs transition-colors ${view === v ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {text}{range && <span className="text-muted-foreground tabular-nums"> {range}</span>}
                  </button>
                );
              })}
            </div></div>
            <Button size="sm" variant="secondary" className="hidden sm:inline-flex shrink-0" onClick={download} disabled={loading || rows.length === 0}>
              <Download className="w-4 h-4 mr-1.5" /> Download Excel
            </Button>
            {!inline && onClose && (
              <button onClick={onClose} className="p-1.5 rounded hover:bg-accent shrink-0" title="Close"><X className="w-4 h-4" /></button>
            )}
          </div>
          <div className="mt-2 flex items-center gap-1 sm:hidden">
            <button onClick={() => shiftMonth(-1)} className="p-1.5 rounded hover:bg-accent shrink-0" title="Previous month"><ChevronLeft className="w-4 h-4" /></button>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="flex-1 min-w-0 px-2 py-1 border border-border rounded-md text-sm bg-card" />
            <button onClick={() => shiftMonth(1)} className="p-1.5 rounded hover:bg-accent shrink-0" title="Next month"><ChevronRight className="w-4 h-4" /></button>
            <Button size="sm" variant="secondary" className="shrink-0" onClick={download} disabled={loading || rows.length === 0} title="Download Excel">
              <Download className="w-4 h-4" />
            </Button>
          </div>
          <div className="mt-2 sm:hidden">            <div className="inline-flex items-center rounded-md border border-border p-0.5 bg-secondary shrink-0" role="tablist" aria-label="What the board shows">
              {([["month", "Whole month"], [1, "1st half"], [2, "2nd half"]] as const).map(([v, text]) => {
                const range = v === "month" ? "" : v === 1 ? `1–${halfCut}` : `${halfCut + 1}–${daysInMonth}`;
                return (
                  <button
                    key={String(v)}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    onClick={() => setView(v)}
                    className={`px-2.5 py-1 rounded text-xs transition-colors ${view === v ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {text}{range && <span className="text-muted-foreground tabular-nums"> {range}</span>}
                  </button>
                );
              })}
            </div></div>
          <BoardVerificationBar
            clientId={realClientId}
            category={category}
            branchId={branchId}
            month={month}
            view={view}
            halves={halvesInfo}
            legacyVerifiedAt={verifiedAt}
            payrollPhase={runPhase}
            canHr={canHrVerify}
            onChanged={() => setReloadKey((k) => k + 1)}
          />
          {!viewLocked && canHrVerify && !loading && rows.length > 0 && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {viewOutstanding.length === 0
                ? viewEnded ? "Every day shown is confirmed. Ready for HR to verify." : "Every day so far is confirmed — HR can verify a half once it has ended."
                : `${viewOutstanding.length} unconfirmed day(s) are highlighted below. Confirm those shifts on the Daily board first.`}
            </p>
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
              <thead>
                <tr ref={dayRowRef} className="bg-secondary">
                  {["Ser.", "Name", "Desg.", "Emp #"].map((h, ci) => (
                    <th
                      key={h}
                      rowSpan={2}
                      // The corner: frozen in BOTH directions, and so above
                      // every other sticky cell — it is the one thing that must
                      // never be scrolled under.
                      style={{ ...leadCell(ci), ...stickyHead(0) }}
                      className={`sticky z-40 border border-border px-2 py-1 text-left whitespace-nowrap bg-secondary${ci === LEAD.length - 1 ? " border-r-2" : ""}`}
                    >
                      {h}
                    </th>
                  ))}
                  {days.map((d) => (
                    <th key={d} colSpan={S} style={stickyHead(0)} className="sticky z-30 border border-border px-1 py-1 text-center tabular-nums bg-secondary">{d}</th>
                  ))}
                  {["Presents", "Absents", "Allowed Leaves", "Leaves Taken", "Double Duty", view === "month" ? "Pay Days" : "Month Pay Days"].map((h) => (
                    <th key={h} rowSpan={2} style={stickyHead(0)} className="sticky z-30 border border-border px-1.5 py-1 text-center whitespace-nowrap bg-secondary">{h}</th>
                  ))}
                </tr>
                <tr className="bg-secondary">
                  {days.map((d) =>
                    shifts.map((c) => (
                      <th key={`${d}-${c}`} style={stickyHead(dayRowH)} className="sticky z-30 border border-border px-1 py-0.5 text-center text-[10px] text-muted-foreground bg-secondary" title={`${c} shift`}>{shiftAbbr(c)}</th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.empCode + row.serial} className="hover:bg-accent/40">
                    <td style={leadCell(0)} className="sticky z-10 bg-card border border-border px-2 py-0.5 tabular-nums">{String(row.serial).padStart(2, "0")}</td>
                    <td style={leadCell(1)} className="sticky z-10 bg-card border border-border px-2 py-0.5 whitespace-nowrap overflow-hidden text-ellipsis">
                      {row.name}
                      {row.isReliever && (
                        <span className="ml-1.5 inline-flex items-center rounded-sm border border-brand-200 bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 dark:border-brand-800 dark:bg-brand-900/20 dark:text-brand-400">
                          Reliever
                        </span>
                      )}
                      {row.separationNote && <span className="text-muted-foreground"> ({row.separationNote})</span>}
                    </td>
                    <td style={leadCell(2)} className="sticky z-10 bg-card border border-border px-2 py-0.5">{row.designation}</td>
                    <td style={leadCell(3)} className="sticky z-10 bg-card border border-border border-r-2 px-2 py-0.5 whitespace-nowrap font-mono text-[11px]">{row.empCode}</td>
                    {days.map((d) => d - 1).map((i) => {
                      const st = row.statusByDay[i] ?? "";
                      const ds = String(row.shiftByDay?.[i] ?? row.shift ?? "day").toLowerCase();
                      const si = shiftIndex.get(ds) ?? 0;
                      const date = dayDate(i);
                      const flagged = row.empId ? flaggedKeys.has(`${row.empId}|${i}`) : false;
                      // Was this guard a RELIEVER on this specific day? (day-level,
                      // from worked_for_client_id). Drives the per-day marker and
                      // keeps reliever days non-overridable while REGULAR days of
                      // the same row stay overridable.
                      const isRelieverDay = !!row.relieverByDay?.[i];
                      // A confirmed day only shows a real P/A/L here (unconfirmed =
                      // blank). Override is the ONE way to change such a day, and
                      // only once the month has ended (and while it isn't yet
                      // OPS-verified). Before month-end the board stays read-only;
                      // editing happens on the Attendance board until it locks.
                      // Reliever days are not overridable here — their marks come
                      // from the Relievers section and carry per-day client
                      // attribution an override can't reproduce.
                      const hasMark = st === "P" || st === "A" || st === "L" || st === "DD";
                      // A cleared/blank primary cell in an ended month is overridable
                      // too, so a day cleared here can be re-marked here — the daily
                      // Attendance board is locked once the shift is confirmed and the
                      // month has ended. A *flagged* blank (an unconfirmed mark) is
                      // excluded: that belongs on the Attendance board to be confirmed,
                      // not overridden.
                      const canOverridePrimary = !!row.empId && !isRelieverDay && monthEnded && !dayLocked(i) && (hasMark || (st === "" && !flagged));
                      // A SECOND shift = double duty, which only exists when the
                      // guard is PRESENT that day. If they're absent/leave the other
                      // shift columns stay inert, and adding one is Present-only.
                      //
                      // A day already showing DD is excluded: it is already two
                      // shifts, and two is the maximum a guard can cover (0395).
                      // Offering a third here would only produce a refusal at
                      // save time, which is a worse way to learn the rule.
                      const canAddSecond = !!row.empId && !isRelieverDay && monthEnded && !dayLocked(i) && st === "P";
                      return shifts.map((cShift, s) => {
                        const isPrimary = s === si;
                        // Primary column = the guard's own status; other columns =
                        // any second-shift (double-duty) mark from `cells`.
                        const cellStatus = isPrimary
                          ? st
                          : (row.empId ? cells.get(row.empId)?.get(`${i + 1}|${cShift}`) ?? "" : "");
                        const clickable = isPrimary ? canOverridePrimary : canAddSecond;
                        // A day reset to unmarked via Clear (still blank now) gets a
                        // blue tint so the gap reads as deliberate, not un-entered.
                        const isCleared = isPrimary && st === "" && !!row.empId && clearedKeys.has(`${row.empId}|${date}`);
                        // Reliever days get a brand tint so the reliever segment is
                        // visible at a glance; the flagged (unconfirmed regular)
                        // red always wins.
                        const cellBg = isPrimary && flagged ? "bg-danger-100 dark:bg-danger-900/30"
                          : isPrimary && isRelieverDay ? "bg-brand-50 dark:bg-brand-900/20"
                          : isCleared ? `bg-info-100${clickable ? " cursor-pointer hover:bg-info-200" : ""}`
                          : clickable ? "cursor-pointer hover:bg-accent" : "";
                        return (
                          <td
                            key={`${i}-${s}`}
                            onClick={clickable ? () => setOvTarget({ empId: row.empId!, empName: row.name, date, current: cellStatus, shift: cShift, presentOnly: !isPrimary }) : undefined}
                            title={isPrimary && isRelieverDay ? "Reliever day — covered as a reliever (gaps allowed)"
                              : isPrimary && flagged ? "Not confirmed — confirm this shift on the Attendance board to show it here"
                              : isCleared ? (clickable ? "Cleared — click to re-mark via override" : "Cleared (this day was reset to unmarked)")
                              : !clickable ? undefined
                              : isPrimary ? (hasMark ? "Confirmed & month ended — click to override" : "Cleared / unmarked — click to mark via override")
                              : cellStatus ? "Double duty — click to edit" : `Click to add a ${cShift} shift (double duty)`}
                            className={`border border-border px-1 py-0.5 text-center font-medium ${cellBg} ${statusClass(cellStatus)}`}
                          >
                            {cellStatus}
                            {isPrimary && isRelieverDay && cellStatus && (
                              <sup className="ml-0.5 text-[8px] font-semibold text-brand-600 dark:text-brand-400" title="Reliever day">R</sup>
                            )}
                          </td>
                        );
                      });
                    })}
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums">{viewCounts.get(row)?.p ?? 0}</td>
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums">{viewCounts.get(row)?.a ?? 0}</td>
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums">{row.allowedLeaves ?? ""}</td>
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums">{viewCounts.get(row)?.l ?? 0}</td>
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums">{viewCounts.get(row)?.dd || ""}</td>
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums font-medium">{row.payDays}</td>
                  </tr>
                ))}
                <tr className="bg-secondary/60 font-medium">
                  <td colSpan={4} style={{ left: 0, width: LEAD_TOTAL, minWidth: LEAD_TOTAL, maxWidth: LEAD_TOTAL }} className="sticky left-0 z-10 bg-secondary border border-border border-r-2 px-2 py-0.5">Total Presents</td>
                  {totalRowCells(totals.P, [String(totals.sumP), String(totals.sumA), String(totals.sumAL), String(totals.sumL), String(totals.sumDD), String(totals.sumPD)])}
                </tr>
                <tr className="bg-secondary/40">
                  <td colSpan={4} style={{ left: 0, width: LEAD_TOTAL, minWidth: LEAD_TOTAL, maxWidth: LEAD_TOTAL }} className="sticky left-0 z-10 bg-secondary border border-border border-r-2 px-2 py-0.5">Total Leaves</td>
                  {totalRowCells(totals.L)}
                </tr>
                <tr className="bg-secondary/40">
                  <td colSpan={4} style={{ left: 0, width: LEAD_TOTAL, minWidth: LEAD_TOTAL, maxWidth: LEAD_TOTAL }} className="sticky left-0 z-10 bg-secondary border border-border border-r-2 px-2 py-0.5">Total Absents</td>
                  {totalRowCells(totals.A)}
                </tr>
                <tr className="bg-secondary/60 font-medium">
                  <td colSpan={4} style={{ left: 0, width: LEAD_TOTAL, minWidth: LEAD_TOTAL, maxWidth: LEAD_TOTAL }} className="sticky left-0 z-10 bg-secondary border border-border border-r-2 px-2 py-0.5">Grand Total</td>
                  {totalRowCells(totals.grand)}
                </tr>
              </tbody>
            </table>
          )}

          {!loading && !err && rows.length > 0 && (
            <div className="mt-3 text-[11px] text-muted-foreground space-y-0.5">
              {shifts.map((c) => <span key={c} className="inline-block mr-3">{shiftAbbr(c)} = {c} shift</span>)}
              <div>P / A / L = present / absent / leave · X = not markable (separated / before joining / off-contract) · allowed leaves = this employee's own allowance for the month (as payroll uses it) · pay days = presents + double duties + leaves taken, counted only up to allowed leaves</div>
              <div>
                <span className="inline-block align-middle rounded-sm bg-brand-50 dark:bg-brand-900/20 px-1 mr-1">P<sup className="text-[8px] font-semibold text-brand-600 dark:text-brand-400">R</sup></span>
                = reliever day (the guard covered as a reliever that day) — gaps in a reliever segment are expected and never block verification.
              </div>
              <div className="text-muted-foreground">
                Shows only attendance the supervisor has confirmed on the Attendance board; unconfirmed days stay blank.
                {monthEnded
                  ? " The month has ended — a confirmed day is now locked everywhere else and can be changed only by clicking it here to override."
                  : " Until the month ends, this view is read-only — edit on the Attendance board."}
              </div>
              <div>Whole month / 1st half / 2nd half changes what the grid shows; HR's verify button acts on it. In a half view the counts are that half's, and pay days stay the month's. A half HR has verified is locked and waits in Review on the Attendance Run for Ops.</div>
              {canHrVerify && <div><span className="inline-block w-3 h-3 align-middle rounded-sm bg-danger-100 dark:bg-danger-900/30 mr-1" /> not yet confirmed (blocks HR Verify of its half)</div>}
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
          locked={dateLocked(ovTarget.date)}
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
    // 0. An override to Leave replaces the whole day. This is the path that made
    // the worst of the found cases — a night cell overridden to Leave while the
    // day cell still said double duty, one guard both working and on leave
    // (0393). Overriding a WORKED status likewise clears a standing leave.
    // Sanctioned server-side clear: a plain DELETE here is refused by the
    // confirmed-month-end lock, which is the whole point of Override (0407). A
    // worked/DD override clears only leave rows (keep a DD sibling); a Leave
    // override clears the whole day.
    const pLeaveOnly = presentOnly ? true : status !== "leave";
    const { error: cErr } = await supabase.rpc("clear_attendance_conflicts", {
      p_employee: target.empId,
      p_date: target.date,
      p_leave_only: pLeaveOnly,
      p_reason: reason.trim(),
    });
    if (cErr) {
      setBusy(false);
      setErr(cErr.message ?? "Could not clear the existing marks on that day.");
      return;
    }
    const nowIso = new Date().toISOString();
    const base = {
      employee_id: target.empId,
      attendance_date: target.date,
      source: "manual",
      marked_by_role: currentUserRole ?? "hr",
      marked_by_user_id: currentUserId,
      marked_at: nowIso,
      supervisor_override: true,
      override_reason: reason.trim(),
    };
    if (presentOnly) {
      // Adding a SECOND shift makes the day a double duty, and a double duty is
      // two rows that BOTH say double_duty (0395). Both rows MUST be written in
      // ONE transaction: PostgREST wraps each call separately, and 0395's
      // constraint is DEFERRED to commit — so writing the extra shift on its own
      // commits the day as `present + double_duty` (half a double duty) and is
      // refused before a follow-up update could fix it. A single array upsert is
      // one transaction, so the constraint sees the finished day.
      //
      // The sibling's real worked_shift is read rather than assumed — the extra
      // shift is target.shift, but the rostered one could be any other code.
      const { data: existing } = await supabase
        .from("attendance_records")
        .select("worked_shift")
        .eq("employee_id", target.empId)
        .eq("attendance_date", target.date)
        .in("status", ["present", "double_duty"]);
      const shiftSet = new Set<string>([target.shift, ...((existing ?? []).map((r) => String(r.worked_shift)))]);
      const rows = [...shiftSet].map((sh) => ({
        ...base,
        status: "double_duty",
        absent_reason: null,
        scheduled_shift: sh,
        worked_shift: sh,
        entry_type: "double_duty",
      }));
      const { error: mErr } = await supabase
        .from("attendance_records")
        .upsert(rows, { onConflict: "employee_id,attendance_date,worked_shift" });
      if (mErr) { setBusy(false); setErr(mErr.message); return; }
    } else {
      // 1. Mark the day (upsert keyed on employee+date+worked_shift, per the model).
      // "leave" goes in as-is: 0224 folded rotation_leave into leave and dropped
      // it from attendance_records_status_check, so translating to it here is
      // what raised "violates check constraint attendance_records_status_check".
      const { error: mErr } = await supabase.from("attendance_records").upsert({
        ...base,
        status,
        absent_reason: status === "absent" ? "awol" : null,
        scheduled_shift: target.shift,
        worked_shift: target.shift,
        entry_type: "normal",
      }, { onConflict: "employee_id,attendance_date,worked_shift" });
      if (mErr) { setBusy(false); setErr(mErr.message); return; }
    }
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

  // Clear Marks — revert to the true UNMARKED state (delete the row(s)), as if
  // nothing was ever recorded. Goes through a SECURITY DEFINER RPC that gets past
  // the confirmed-month-end lock (Override's authority) but NOT the OPS-verified
  // lock, and writes an audit row. A reason is required, same as an override.
  const clearDay = async () => {
    if (locked) { setErr("This month is OPS-verified and locked. Un-verify it to change attendance."); return; }
    if (!reason.trim()) { setErr("A reason is required to clear this day."); return; }
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("clear_attendance_day", {
      p_employee: target.empId, p_date: target.date, p_reason: reason.trim(),
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onSaved();
  };
  const clearMonth = async () => {
    if (locked) { setErr("This month is OPS-verified and locked. Un-verify it to change attendance."); return; }
    if (!reason.trim()) { setErr("A reason is required to clear the month."); return; }
    if (!window.confirm(`Clear ALL of ${target.empName}'s marks for ${target.date.slice(0, 7)}? Every day goes back to unmarked. This cannot be undone.`)) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("clear_attendance_month", {
      p_employee: target.empId, p_month: target.date.slice(0, 7), p_reason: reason.trim(),
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
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

          {/* Clear Marks — revert to unmarked (blank), as if never recorded.
              Offered on the guard's own (primary) cell; needs the same reason. */}
          {!presentOnly && (
            <div className="pt-2 border-t border-border space-y-1.5">
              <p className="text-xs text-muted-foreground">Or revert to <span className="font-medium">unmarked</span> (blank), as if nothing was recorded:</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" className="flex-1" onClick={clearDay} disabled={busy || locked || !reason.trim()} title={!reason.trim() ? "Enter a reason first" : "Clear this day back to unmarked"}>
                  Clear this day
                </Button>
                <Button size="sm" variant="secondary" className="flex-1" onClick={clearMonth} disabled={busy || locked || !reason.trim()} title={!reason.trim() ? "Enter a reason first" : "Clear the whole month for this employee"}>
                  Clear whole month
                </Button>
              </div>
            </div>
          )}

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
