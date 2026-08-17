// On-screen version of the monthly attendance Excel sheet, per client (optionally
// one site). Renders the exact same grid the exporter produces — day columns split
// by shift, P/A/L/X marks, per-day and grand totals, legend — plus a Download
// button that hands the identical rows to exportAttendance. View without downloading.

import { useEffect, useMemo, useState } from "react";
import { X, Download, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import Button from "./Button";
import { supabase } from "../lib/supabase";
import { guardDisplayCode } from "../lib/guardCode";
import { buildAttendanceRows, type SheetEmployee } from "../lib/attendanceSheet";
import { exportAttendance, deriveAttendanceShifts, shiftAbbr, type AttendanceEmployeeRow } from "../lib/excel";

const todayMonth = () => new Date().toISOString().slice(0, 7);

const statusClass = (s: string): string =>
  s === "P" ? "text-success-700 dark:text-success-500"
    : s === "A" ? "text-danger-600"
      : s === "L" ? "text-warning-700 dark:text-warning-500"
        : s === "X" ? "text-muted-foreground/60"
          : "";

export default function AttendanceSheetModal({
  clientId, clientName, siteId, siteName, onClose,
}: {
  clientId: string;
  clientName: string;
  siteId?: string | null;
  siteName?: string | null;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(todayMonth());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<AttendanceEmployeeRow[]>([]);
  const [daysInMonth, setDaysInMonth] = useState(30);
  const [monthLabel, setMonthLabel] = useState("");

  const label = siteName ? `${clientName} — ${siteName}` : clientName;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [{ data: client }, { data: contracts }, { data: emps }] = await Promise.all([
          supabase.from("clients").select("id, name, employee_id_prefix, allowed_leaves_per_month").eq("id", clientId).single(),
          supabase.from("contracts").select("id, allowed_leaves_per_month").eq("client_id", clientId),
          supabase
            .from("employees")
            .select("id, full_name, display_number, guard_code, employee_code, contract_id, client_id, join_date, last_working_day, termination_date, lifecycle_state, shift")
            .eq("client_id", clientId)
            .neq("lifecycle_state", "archived"),
        ]);

        let list = (emps ?? []) as any[];
        // Narrow to one site by the guard's current open posting.
        if (siteId) {
          const { data: deps } = await supabase
            .from("deployments").select("guard_id, site_id").eq("client_id", clientId).is("end_date", null);
          const siteByGuard = new Map<string, string | null>();
          for (const d of (deps ?? []) as any[]) siteByGuard.set(d.guard_id, d.site_id);
          list = list.filter((e) => siteByGuard.get(e.id) === siteId);
        }

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

        const built = await buildAttendanceRows({
          month,
          employees,
          contracts: (contracts ?? []) as any[],
          clients: client ? ([client] as any[]) : [],
        });
        if (cancelled) return;
        setRows(built.rows);
        setDaysInMonth(built.daysInMonth);
        setMonthLabel(built.monthLabel);
      } catch (e: any) {
        if (!cancelled) setErr(e.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clientId, siteId, month]);

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
        if (st === "P") P[i][si] += 1;
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
        : Array(4).fill(0).map((_, i) => <td key={i} className="border border-border" />)}
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
              <h2 className="font-semibold text-foreground truncate">Attendance — {label}</h2>
              <p className="text-xs text-muted-foreground">{monthLabel || month}</p>
            </div>
            <div className="hidden sm:flex items-center gap-1 shrink-0">
              <button onClick={() => shiftMonth(-1)} className="p-1.5 rounded hover:bg-accent" title="Previous month"><ChevronLeft className="w-4 h-4" /></button>
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="px-2 py-1 border border-border rounded-md text-sm bg-card" />
              <button onClick={() => shiftMonth(1)} className="p-1.5 rounded hover:bg-accent" title="Next month"><ChevronRight className="w-4 h-4" /></button>
            </div>
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
          </div>
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
                  {["Presents", "Absents", "Leaves", "Pay Days"].map((h) => (
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
                      return shifts.map((_c, s) => (
                        <td key={`${i}-${s}`} className={`border border-border px-1 py-0.5 text-center font-medium ${statusClass(s === si ? st : "")}`}>
                          {s === si ? st : ""}
                        </td>
                      ));
                    })}
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums">{row.presents}</td>
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums">{row.absents}</td>
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums">{row.leaves}</td>
                    <td className="border border-border px-1.5 py-0.5 text-center tabular-nums font-medium">{row.payDays}</td>
                  </tr>
                ))}
                <tr className="bg-secondary/60 font-medium">
                  <td colSpan={4} className="border border-border px-2 py-0.5">Total Presents</td>
                  {totalRowCells(totals.P, [String(totals.sumP), String(totals.sumA), String(totals.sumL), String(totals.sumPD)])}
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
