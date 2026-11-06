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
  /** Employee id — needed for the same-shift-at-two-clients check (Monthly board rows carry it). */
  empId?: string | null;
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
const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : 0);

type Extras = {
  /** What the client was invoiced for the month, before tax. null = no invoice yet. */
  billed: number | null;
  /** Last month's payslips for this client's guards: pay days, gross, headcount. */
  prev: { payDays: number; gross: number; heads: number } | null;
  /** Same guard, same day, same shift, present at two clients. */
  clashes: { name: string; date: string; shift: string }[];
};

async function loadExtras(clientId: string, month: string, empIds: string[], names: Map<string, string>): Promise<Extras> {
  const start = `${month.slice(0, 7)}-01`;
  const [y, m] = start.split("-").map(Number);
  const end = `${start.slice(0, 7)}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  const prevStart = `${new Date(y, m - 2, 1).getFullYear()}-${String(new Date(y, m - 2, 1).getMonth() + 1).padStart(2, "0")}-01`;

  const [inv, prev, att] = await Promise.all([
    supabase.from("invoices").select("subtotal, invoice_amount, tax_added_total, invoice_kind, status")
      .eq("client_id", clientId).eq("service_month", start),
    supabase.from("payslips").select("final_salary, allowance, bonus, per_day_salary, employees!inner(client_id)")
      .eq("period_month", prevStart).eq("employees.client_id", clientId),
    empIds.length
      ? supabase.from("attendance_records").select("employee_id, attendance_date, worked_shift, scheduled_shift, worked_for_client_id, status")
          .in("employee_id", empIds.slice(0, 400)).gte("attendance_date", start).lte("attendance_date", end)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const invs = ((inv.data ?? []) as any[]).filter((i) => i.status !== "Cancelled" && i.status !== "Void");
  const billed = invs.length
    ? invs.reduce((t, i) => t + (Number(i.subtotal) > 0 ? Number(i.subtotal) : Number(i.invoice_amount ?? 0) - Number(i.tax_added_total ?? 0)), 0)
    : null;

  const ps = (prev.data ?? []) as any[];
  const prevAgg = ps.length ? {
    heads: ps.length,
    gross: ps.reduce((t, r) => t + Number(r.final_salary ?? 0), 0),
    payDays: ps.reduce((t, r) => {
      const pd = Number(r.per_day_salary ?? 0);
      const d = pd > 0 ? (Math.round(Number(r.final_salary ?? 0)) - Math.round(Number(r.allowance ?? 0)) - Math.round(Number(r.bonus ?? 0))) / pd : 0;
      return t + (Math.abs(d - Math.round(d)) < 0.05 ? Math.round(d) : 0);
    }, 0),
  } : null;

  // Present-type marks keyed by guard + day + shift; two different clients on one key is a clash.
  const seen = new Map<string, Set<string>>();
  for (const r of (att.data ?? []) as any[]) {
    if (!/^(present|double_duty|relief_cover)$/i.test(String(r.status ?? ""))) continue;
    const shift = String(r.worked_shift ?? r.scheduled_shift ?? "day").toLowerCase();
    const key = `${r.employee_id}|${r.attendance_date}|${shift}`;
    const set = seen.get(key) ?? new Set<string>();
    set.add(String(r.worked_for_client_id ?? "?"));
    seen.set(key, set);
  }
  const clashes = [...seen].filter(([, set]) => set.size > 1).map(([k]) => {
    const [id, date, shift] = k.split("|");
    return { name: names.get(id) ?? "A guard", date, shift };
  });
  return { billed, prev: prevAgg, clashes };
}

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
  const [extras, setExtras] = useState<Extras | null>(null);
  const empKey = rows.map((r) => r.empId ?? "").join(",");
  useEffect(() => {
    let cancelled = false;
    setExtras(null);
    if (!clientId) return;
    const ids = rows.map((r) => r.empId).filter((x): x is string => !!x);
    const names = new Map(rows.filter((r) => r.empId).map((r) => [r.empId as string, r.name]));
    void loadExtras(clientId, month, ids, names).then((x) => { if (!cancelled) setExtras(x); }, () => undefined);
    return () => { cancelled = true; };
  }, [clientId, month, empKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

    // 9. Same guard, same day, same shift, present at two clients (a double duty is two shifts, so it is not this).
    if (extras?.clashes.length) out.push({ level: "warn", title: `${extras.clashes.length} shift${extras.clashes.length === 1 ? "" : "s"} marked present at two clients`, detail: "The same guard is present for the same shift on the same day at two clients — one of the marks is probably wrong, and both clients may be billed.", names: extras.clashes.slice(0, 12).map((c) => `${c.name} · ${c.date} · ${c.shift}`) });

    // 10. Billed against paid (payroll).
    if (mode === "payroll" && clientId && extras) {
      const gross = rs.reduce((t, r) => t + Number(r.gross ?? 0), 0);
      if (extras.billed == null) out.push({ level: "info", title: "Not billed yet", detail: `No invoice for this month's service yet — payroll cost so far Rs ${fmt(Math.round(gross))}.` });
      else if (gross > extras.billed) out.push({ level: "warn", title: "Payroll costs more than the client was billed", detail: `Gross payroll Rs ${fmt(Math.round(gross))} against Rs ${fmt(Math.round(extras.billed))} invoiced (before tax) — Rs ${fmt(Math.round(gross - extras.billed))} short. Check the invoice, the rate, or extra guards not billed.` });
      else {
        const margin = Math.round(((extras.billed - gross) / extras.billed) * 100);
        out.push({ level: margin < 5 ? "info" : "ok", title: margin < 5 ? "Thin margin" : "Billed covers payroll", detail: `Invoiced Rs ${fmt(Math.round(extras.billed))} (before tax), gross payroll Rs ${fmt(Math.round(gross))} — ${margin}% left before EOBI, kit and overheads.` });
      }
    }

    // 11. Month on month.
    if (extras?.prev && rs.length) {
      const gross = rs.reduce((t, r) => t + Number(r.gross ?? 0), 0);
      const jumps: string[] = [];
      if (Math.abs(pct(pd, extras.prev.payDays)) >= 15) jumps.push(`pay days ${fmt(extras.prev.payDays)} → ${fmt(pd)} (${pct(pd, extras.prev.payDays) > 0 ? "+" : ""}${pct(pd, extras.prev.payDays)}%)`);
      if (Math.abs(rs.length - extras.prev.heads) >= Math.max(3, extras.prev.heads * 0.1)) jumps.push(`guards ${extras.prev.heads} → ${rs.length}`);
      if (mode === "payroll" && gross > 0 && Math.abs(pct(gross, extras.prev.gross)) >= 15) jumps.push(`gross Rs ${fmt(Math.round(extras.prev.gross))} → ${fmt(Math.round(gross))} (${pct(gross, extras.prev.gross) > 0 ? "+" : ""}${pct(gross, extras.prev.gross)}%)`);
      out.push(jumps.length
        ? { level: "warn", title: "Big change from last month", detail: jumps.join(" · ") + ". A new contract, a rate change or a missing batch of marks would explain it." }
        : { level: "ok", title: "In line with last month", detail: `Last month: ${fmt(extras.prev.payDays)} pay days, ${extras.prev.heads} guards.` });
    }

    if (!out.some((c) => c.level !== "ok") && rs.length) out.push({ level: "ok", title: "Nothing unusual", detail: "No guard over the month, nobody paid without a present day." });
    return { checks: out, totals: { pd, p, l, a, dd, n: rs.length } };
  }, [rows, daysInMonth, contracted, clientId, mode, extras]);

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
