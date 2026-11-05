import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, ListChecks } from "lucide-react";
import { supabase } from "../lib/supabase";

/**
 * QUICK CHECKS on pay days (Shayan, 6 Nov 2026) — a second look, for show, NOT
 * a rule. Nothing here blocks or changes anything; each line is a question a
 * reviewer might ask before the month is paid.
 *
 * Pay days = present + double duties + leaves up to the allowance.
 *
 * The headline check is capacity: a client that contracted 70 guards in a
 * 30-day month can owe at most 70 × 30 = 2,100 guard-days. Pay days above that
 * mean either the contract on file is out of date or we may be paying for days
 * the client is not billed for.
 */
export type CheckRow = {
  name: string;
  payDays: number | null | undefined;
  present: number;
  leave: number;
  absent: number;
  doubleDuties?: number | null;
  allowedLeaves?: number | null;
  /** Payroll only. */
  gross?: number | null;
  net?: number | null;
  base?: number | null;
  allowance?: number | null;
  bonus?: number | null;
  /** False when the row has no payroll figures yet (payroll not run for it). */
  hasFigures?: boolean;
};

type Level = "ok" | "warn" | "info";
type Check = { level: Level; title: string; detail: string; names?: string[] };

/** Guards contracted for a client in the month: active contracts' committed lines, else their guard count. */
async function contractedGuards(clientId: string, month: string): Promise<number | null> {
  const start = `${month.slice(0, 7)}-01`;
  const [y, m] = start.split("-").map(Number);
  const end = `${start.slice(0, 7)}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  const { data } = await supabase
    .from("contracts")
    .select("id, status, start_date, end_date, termination_date, number_of_guards, contract_lines(committed_count)")
    .eq("client_id", clientId);
  const live = ((data ?? []) as any[]).filter((c) =>
    c.status !== "draft" && c.start_date <= end && (!c.end_date || c.end_date >= start) && (!c.termination_date || c.termination_date >= start));
  if (!live.length) return null;
  return live.reduce((t, c) => {
    const lines = (c.contract_lines ?? []) as { committed_count: number | null }[];
    const committed = lines.reduce((s, l) => s + Number(l.committed_count ?? 0), 0);
    return t + (committed > 0 ? committed : Number(c.number_of_guards ?? 0));
  }, 0);
}

const fmt = (n: number) => n.toLocaleString("en-PK");

export default function PayDaysChecks({ rows, daysInMonth, clientId, month, mode, defaultOpen = false }: {
  rows: CheckRow[];
  daysInMonth: number;
  /** A client's id, to read its contracted guards; omit for a staff group (no contract). */
  clientId?: string | null;
  /** YYYY-MM or YYYY-MM-DD. */
  month: string;
  mode: "attendance" | "payroll";
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [contracted, setContracted] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    if (!clientId) { setContracted(null); return; }
    setContracted(undefined);
    void contractedGuards(clientId, month).then((n) => { if (!cancelled) setContracted(n); });
    return () => { cancelled = true; };
  }, [clientId, month]);

  const { checks, totals } = useMemo(() => {
    const rs = rows.filter((r) => r.hasFigures !== false);
    const pd = rs.reduce((t, r) => t + Number(r.payDays ?? 0), 0);
    const p = rs.reduce((t, r) => t + r.present, 0);
    const l = rs.reduce((t, r) => t + r.leave, 0);
    const a = rs.reduce((t, r) => t + r.absent, 0);
    const dd = rs.reduce((t, r) => t + Number(r.doubleDuties ?? 0), 0);
    const out: Check[] = [];

    // 1. Contract capacity.
    if (contracted && contracted > 0) {
      const cap = contracted * daysInMonth;
      out.push(pd > cap
        ? { level: "warn", title: "Pay days exceed what the contract covers", detail: `${fmt(pd)} pay days against ${fmt(contracted)} contracted × ${daysInMonth} days = ${fmt(cap)}. ${fmt(pd - cap)} more than the contract allows — check the contract on file, relievers, or extra guards the client has not been billed for.` }
        : { level: "ok", title: "Within contract capacity", detail: `${fmt(pd)} of ${fmt(cap)} possible pay days (${fmt(contracted)} contracted × ${daysInMonth} days) — ${Math.round((pd / cap) * 100)}% used.` });
    } else if (contracted === null && clientId) {
      out.push({ level: "info", title: "No active contract found", detail: "Capacity cannot be checked: no live contract with a guard count is on file for this month." });
    }

    // 2. Headcount.
    const paid = rs.filter((r) => Number(r.payDays ?? 0) > 0).length;
    if (contracted && paid > contracted) {
      out.push({ level: "warn", title: "More guards paid than contracted", detail: `${paid} guards have pay days; the contract covers ${contracted}. Relievers and rotations explain some of this — the rest is worth a look.` });
    }

    // 3. One guard over the month.
    const over = rs.filter((r) => Number(r.payDays ?? 0) > daysInMonth);
    if (over.length) out.push({ level: "warn", title: `${over.length} guard${over.length === 1 ? "" : "s"} with more pay days than days in the month`, detail: `Possible only through double duties — confirm each was really worked.`, names: over.map((r) => `${r.name} (${r.payDays})`) });

    // 4. Double-duty share.
    if (p > 0 && dd / p > 0.1) out.push({ level: "info", title: "High double-duty share", detail: `${fmt(dd)} double duties on ${fmt(p)} present days (${Math.round((dd / p) * 100)}%). The site may be short-staffed.` });

    // 5. Leave beyond allowance (unpaid).
    const unpaidLeave = rs.reduce((t, r) => t + (r.allowedLeaves != null ? Math.max(0, r.leave - r.allowedLeaves) : 0), 0);
    if (unpaidLeave > 0) out.push({ level: "info", title: "Leave beyond allowance", detail: `${fmt(unpaidLeave)} leave day${unpaidLeave === 1 ? "" : "s"} over the allowance — not paid.` });

    // 6. Paid without working.
    const idle = rs.filter((r) => r.present === 0 && Number(r.payDays ?? 0) > 0);
    if (idle.length) out.push({ level: "warn", title: `${idle.length} paid with no present day`, detail: "Pay days come only from leave. Usually a guard on long leave — or a mark missing.", names: idle.map((r) => r.name) });

    // 7. Unmarked days.
    const unmarked = rs.filter((r) => r.present + r.leave + r.absent < daysInMonth && r.present + r.leave + r.absent > 0);
    if (mode === "attendance" && unmarked.length) out.push({ level: "info", title: `${unmarked.length} guard${unmarked.length === 1 ? "" : "s"} not fully marked`, detail: "Present + leave + absent is short of the days in the month (joiners and leavers are expected here).", names: unmarked.slice(0, 12).map((r) => `${r.name} (${r.present + r.leave + r.absent}/${daysInMonth})`) });

    // 8. Payroll: salary against pay days.
    if (mode === "payroll") {
      const tooMuch = rs.filter((r) => {
        if (r.gross == null || r.base == null || r.payDays == null || !daysInMonth) return false;
        const fair = (Number(r.base) / daysInMonth) * Number(r.payDays) + Number(r.allowance ?? 0) + Number(r.bonus ?? 0);
        return Number(r.gross) > fair * 1.02 + 50;
      });
      if (tooMuch.length) out.push({ level: "warn", title: `${tooMuch.length} paid more than pay days explain`, detail: "Gross is above base ÷ days in month × pay days, plus allowance and bonus (2% margin). Per-day rates, rate changes mid-month and relief cover can explain it.", names: tooMuch.slice(0, 12).map((r) => r.name) });
      const netOver = rs.filter((r) => r.net != null && r.gross != null && Number(r.net) > Number(r.gross) + 1);
      if (netOver.length) out.push({ level: "warn", title: `${netOver.length} with net above gross`, detail: "Net pay should not exceed gross — an adjustment may have been entered the wrong way round.", names: netOver.map((r) => r.name) });
      const missing = rs.filter((r) => r.payDays == null).length;
      if (missing) out.push({ level: "info", title: `${missing} without a readable pay-day figure`, detail: "Saved payslips don't store pay days; for these the salary does not divide into whole days at the per-day rate." });
    }

    if (!out.some((c) => c.level !== "ok") && rs.length) out.push({ level: "ok", title: "Nothing unusual", detail: "No guard over the month, nobody paid without a present day." });
    return { checks: out, totals: { pd, p, l, a, dd, n: rs.length } };
  }, [rows, daysInMonth, contracted, clientId, mode]);

  const warns = checks.filter((c) => c.level === "warn").length;
  const icon = (lv: Level) => lv === "warn" ? <AlertTriangle className="w-4 h-4 text-warning-600 shrink-0" />
    : lv === "ok" ? <CheckCircle2 className="w-4 h-4 text-success-600 shrink-0" /> : <Info className="w-4 h-4 text-muted-foreground shrink-0" />;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-2 text-sm">
        <span className="text-foreground"><span className="font-semibold tabular-nums">{fmt(totals.pd)}</span> pay days</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="text-success-700">P {fmt(totals.p)}</span> · <span className="text-warning-700">L {fmt(totals.l)}</span> · <span className="text-danger-700">A {fmt(totals.a)}</span>{totals.dd ? <> · <span className="text-brand-700">DD {fmt(totals.dd)}</span></> : null} · {totals.n} guard{totals.n === 1 ? "" : "s"}
          {contracted ? <> · contracted {contracted} × {daysInMonth} = {fmt(contracted * daysInMonth)}</> : null}
        </span>
        <button type="button" onClick={() => setOpen((o) => !o)} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
          <ListChecks className="w-3.5 h-3.5" />
          Checks{warns ? <span className="ml-1 rounded-full bg-warning-100 dark:bg-warning-500/15 px-1.5 text-warning-700">{warns}</span> : null}
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
      </div>
      {open && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          {checks.map((c, i) => (
            <div key={i} className="flex gap-2 text-sm">
              {icon(c.level)}
              <div className="min-w-0">
                <p className="text-foreground font-medium">{c.title}</p>
                <p className="text-xs text-muted-foreground">{c.detail}</p>
                {c.names?.length ? <p className="text-xs text-muted-foreground mt-0.5 break-words">{c.names.join(" · ")}</p> : null}
              </div>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground/80 pt-1 border-t border-border">A second look for review — not a rule. Nothing here blocks or changes the payroll. Pay days = present + double duties + leaves up to the allowance.</p>
        </div>
      )}
    </div>
  );
}
