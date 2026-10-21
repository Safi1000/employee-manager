import { useEmployeeCodeIndex } from "../../lib/employeeCodes";
import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  AlertCircle,
  CalendarDays,
  Wallet,
  FileText,
  ShieldAlert,
  Banknote,
  UserRound,
} from "lucide-react";
import Header from "../../components/Header";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { loadCustodianOptions } from "../../lib/custodian";
import { formatDate } from "../../lib/date";
import { lifecycleStatusLabel } from "../../lib/employmentWindow";
import { usePageState } from "../../lib/pageState";
import { generatePayslipPdf } from "../../lib/payslipPdf";
import { brandingFromCompany } from "../../lib/pdfBranding";

/**
 * My Profile — the self-view a user gets by being LINKED to one employee
 * (profiles.employee_id, migration 0424).
 *
 * Everything on this page is about that one person: their record, their
 * attendance, their payslips, their advances, their cash if they hold any, and
 * the documents and warnings on their file. Nothing here is permission-gated —
 * the link IS the permission, and it grants a view of yourself and nothing
 * else. A user who also holds `payroll.view` keeps the full Payroll screen as
 * well; this page does not replace it, it sits beside it.
 *
 * READ-ONLY BY DECISION. There is no edit control anywhere on this page, and
 * the database agrees: 0424 added SELECT policies only, so a linked user with
 * no permissions cannot write these tables even by calling the API directly.
 *
 * Nothing here filters by employee in the query for SECURITY — RLS already
 * refuses another employee's rows to a linked user. The `.eq()` calls are for
 * CORRECTNESS, because a user who ALSO holds the governing permission is not
 * restricted by RLS at all, and without them this page would show that person
 * the whole company on a screen titled "My Profile".
 */

type EmployeeRow = {
  id: string;
  full_name: string;
  employee_code: string | null;
  guard_code: string | null;
  phone: string | null;
  category: string;
  department: string | null;
  shift: string;
  status: string;
  lifecycle_state: string | null;
  base_salary: number | null;
  allowance: number | null;
  join_date: string | null;
  bank_name: string | null;
  bank_account: string | null;
  account_title: string | null;
  client?: { name: string } | null;
  branch?: { name: string } | null;
  location?: { name: string } | null;
};

type PayslipRow = {
  id: string;
  period_month: string;
  present_days: number;
  absent_days: number;
  leave_days: number;
  base_salary: number;
  bonus: number;
  deductions: number;
  advance: number;
  net_salary: number;
  amount_paid: number;
  status: string;
  disbursed: boolean;
  disbursed_at: string | null;
};

type AdvanceRow = {
  id: string;
  amount: number;
  advance_date: string;
  payment_mode: string | null;
  notes: string | null;
};

type AttendanceRow = { attendance_date: string; status: string };
type DocRow = { id: string; doc_type: string | null; file_name: string | null; created_at: string | null };
type WarningRow = { id: string; warning_type: string | null; reason: string | null; issued_date: string | null };

const monthNow = () => new Date().toISOString().slice(0, 7);
const fmtMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
};
const pkr = (n: number) => `PKR ${Math.round(n || 0).toLocaleString()}`;

// The last 12 months, newest first — enough history to answer "what was I paid
// in March" without a date picker nobody needs on a personal page.
const recentMonths = () => {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < 12; i += 1) {
    out.push(d.toISOString().slice(0, 7));
    d.setMonth(d.getMonth() - 1);
  }
  return out;
};

function Card({
  icon: Icon,
  label,
  value,
  hint,
  tone = "slate",
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  hint?: string;
  tone?: "slate" | "success" | "warning" | "brand";
}) {
  const bar = {
    slate: "border-l-muted-foreground/50",
    success: "border-l-success-500",
    warning: "border-l-warning-500",
    brand: "border-l-brand-500",
  }[tone];
  return (
    <div className={`bg-card p-4 rounded-xl border border-border border-l-4 ${bar}`}>
      <p className="lbl mb-1.5 flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5" strokeWidth={1.5} />
        {label}
      </p>
      <p className="font-ledger whitespace-nowrap text-xl font-semibold tracking-tight text-foreground">
        {value}
      </p>
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border flex items-baseline justify-between gap-2">
        <h3 className="font-display text-base font-bold tracking-tight text-foreground">{title}</h3>
        {count != null && <span className="text-xs text-muted-foreground">{count}</span>}
      </div>
      {children}
    </div>
  );
}

export default function MyProfile() {
  const codeIndex = useEmployeeCodeIndex();
  const { profile, company } = useAuth();
  const employeeId = profile?.employee_id ?? null;

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [month, setMonth] = usePageState("MyProfile.month", monthNow());

  const [emp, setEmp] = useState<EmployeeRow | null>(null);
  const [payslips, setPayslips] = useState<PayslipRow[]>([]);
  const [advances, setAdvances] = useState<AdvanceRow[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [warnings, setWarnings] = useState<WarningRow[]>([]);
  const [heldCash, setHeldCash] = useState<number | null>(null);
  // Leave, from leave_ledger (the same function Leave Balances reads): the
  // latest period's banked balance and what was taken in it.
  const [leave, setLeave] = useState<{ closing: number; taken: number; unpaid: number; period_end: string } | null>(null);
  useEffect(() => {
    if (!employeeId) return;
    let cancelled = false;
    void supabase.rpc("leave_ledger", { p_employee_id: employeeId }).then(({ data, error }) => {
      if (cancelled || error) return;
      const rows = (data ?? []) as { period_end: string; closing: number; taken: number; unpaid: number }[];
      const last = rows[rows.length - 1];
      setLeave(last ? { closing: Number(last.closing), taken: Number(last.taken), unpaid: Number(last.unpaid), period_end: last.period_end } : null);
    });
    return () => { cancelled = true; };
  }, [employeeId]);

  const monthStart = `${month}-01`;
  const monthEnd = (() => {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(y, m, 0).getDate();
    return `${month}-${String(last).padStart(2, "0")}`;
  })();

  useEffect(() => {
    if (!employeeId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      const [empRes, psRes, advRes, attRes, docRes, warnRes] = await Promise.all([
        supabase
          .from("employees")
          .select(
            "id, full_name, employee_code, guard_code, phone, category, department, shift, status, lifecycle_state, base_salary, allowance, join_date, bank_name, bank_account, account_title, client:client_id(name), branch:branch_id(name), location:location_id(name)",
          )
          .eq("id", employeeId)
          .maybeSingle(),
        supabase
          .from("payslips")
          .select(
            "id, period_month, present_days, absent_days, leave_days, base_salary, bonus, deductions, advance, net_salary, amount_paid, status, disbursed, disbursed_at",
          )
          .eq("employee_id", employeeId)
          .order("period_month", { ascending: false }),
        supabase
          .from("advances")
          .select("id, amount, advance_date, payment_mode, notes")
          .eq("employee_id", employeeId)
          .order("advance_date", { ascending: false }),
        supabase
          .from("attendance_records")
          .select("attendance_date, status")
          .eq("employee_id", employeeId)
          .gte("attendance_date", monthStart)
          .lte("attendance_date", monthEnd)
          .order("attendance_date"),
        supabase
          .from("employee_documents")
          .select("id, doc_type, file_name, created_at")
          .eq("employee_id", employeeId)
          .order("created_at", { ascending: false }),
        supabase
          .from("disciplinary_warnings")
          // The table's columns are warning_number / issued_on (the old select
          // named columns that do not exist, so every guard read "a clean record").
          .select("id, warning_number, reason, issued_on, rescinded")
          .eq("employee_id", employeeId)
          .order("issued_on", { ascending: false }),
      ]);
      if (cancelled) return;
      // Only the employee record failing is worth stopping for — it is the page.
      // A subsystem this person has nothing in returns an empty list, and an
      // empty list is the correct answer, not an error to shout about.
      if (empRes.error) setErr(empRes.error.message);
      setEmp((empRes.data ?? null) as EmployeeRow | null);
      setPayslips((psRes.data ?? []) as PayslipRow[]);
      setAdvances((advRes.data ?? []) as AdvanceRow[]);
      setAttendance((attRes.data ?? []) as AttendanceRow[]);
      setDocs((docRes.data ?? []) as DocRow[]);
      setWarnings(((warnRes.data ?? []) as { id: string; warning_number: number | null; reason: string | null; issued_on: string | null; rescinded: boolean | null }[])
        .map((w) => ({ id: w.id, warning_type: `Warning${w.warning_number ? ` ${w.warning_number}` : ""}${w.rescinded ? " (rescinded)" : ""}`, reason: w.reason, issued_date: w.issued_on })) as WarningRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [employeeId, monthStart, monthEnd]);

  // Cash held, only if this person is actually a custodian. loadCustodianOptions
  // returns people who HAVE a custodian location, so an ordinary guard simply
  // isn't in the list and the card stays off the page — "PKR 0 held" would
  // imply they are a custodian who has run out.
  useEffect(() => {
    const cid = profile?.view_as_company ?? profile?.company_id ?? company?.id ?? null;
    if (!employeeId || !cid) return;
    let cancelled = false;
    loadCustodianOptions(cid, true)
      .then((opts) => {
        if (cancelled) return;
        const mine = opts.find((o) => o.kind === "employee" && o.employeeId === employeeId);
        setHeldCash(mine ? mine.held : null);
      })
      .catch(() => {
        /* Not a custodian, or no access to the balance sources — leave the card off. */
      });
    return () => {
      cancelled = true;
    };
  }, [employeeId, profile?.view_as_company, profile?.company_id, company?.id]);

  const attSummary = useMemo(() => {
    let present = 0;
    let absent = 0;
    let leave = 0;
    for (const a of attendance) {
      const s = (a.status ?? "").toLowerCase();
      if (s.startsWith("present") || s === "p" || s === "double_duty") present += 1;
      else if (s.startsWith("absent") || s === "a") absent += 1;
      else if (s.startsWith("leave") || s === "l") leave += 1;
    }
    return { present, absent, leave, marked: attendance.length };
  }, [attendance]);

  const monthPayslip = useMemo(
    () => payslips.find((p) => (p.period_month ?? "").slice(0, 7) === month) ?? null,
    [payslips, month],
  );
  const outstandingPay = useMemo(
    () => payslips.reduce((s, p) => s + Math.max(0, Number(p.net_salary || 0) - Number(p.amount_paid || 0)), 0),
    [payslips],
  );

  if (!employeeId) {
    return (
      <>
        <Header title="My Profile" subtitle="Your own record" />
        <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
          <div className="flex items-start gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-700 dark:text-warning-500">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              This login is not linked to an employee record, so there is nothing personal to show.
              An administrator can link it in Access &amp; Governance ▸ Users.
            </span>
          </div>
        </div>
      </>
    );
  }

  // The last six payslips, oldest first, for the band's pay strip.
  const payTrend = payslips.slice(0, 6).reverse();
  const payMax = Math.max(1, ...payTrend.map((p) => Number(p.net_salary || 0)));
  // The month as a calendar: blanks before the 1st so each date sits under
  // its weekday, Monday first.
  const calendar = (() => {
    const [y, m] = month.split("-").map(Number);
    const days = new Date(y, m, 0).getDate();
    const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
    const byDay = new Map(attendance.map((a) => [Number(a.attendance_date.slice(8, 10)), a.status ?? ""]));
    return { lead, days: Array.from({ length: days }, (_, i) => ({ d: i + 1, status: byDay.get(i + 1) ?? null })) };
  })();
  const dayTone = (status: string | null) => {
    const s = (status ?? "").toLowerCase();
    if (!status) return "bg-muted/40 text-muted-foreground/60 border-transparent";
    if (s.startsWith("present") || s === "p" || s === "double_duty") return "bg-success-100 text-success-700 dark:text-success-500 border-success-200";
    if (s.startsWith("absent") || s === "a") return "bg-danger-50 text-danger-700 dark:text-danger-500 border-danger-200";
    if (s.startsWith("leave") || s === "l") return "bg-warning-50 text-warning-700 dark:text-warning-500 border-warning-200";
    return "bg-muted text-muted-foreground border-border";
  };
  const initials = (emp?.full_name ?? "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const fig = "font-ledger text-2xl font-semibold tracking-tight leading-none whitespace-nowrap";

  return (
    <>
      <Header
        title="My Profile"
        subtitle={emp ? "Your record, attendance, pay and cash — read-only" : "Your own record"}
        actions={
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            aria-label="Month"
            className="px-3 min-h-10 border border-border rounded-xl text-sm bg-card text-foreground"
          >
            {recentMonths().map((m) => (
              <option key={m} value={m}>{fmtMonth(m)}</option>
            ))}
          </select>
        }
      >
        {!loading && emp && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="h-12 w-12 rounded-2xl bg-brand-500 text-on-brand flex items-center justify-center font-display font-bold text-lg flex-shrink-0">{initials}</span>
                <div className="min-w-0">
                  <p className="font-display text-lg font-bold text-foreground truncate">{emp.full_name}</p>
                  <p className="text-xs font-ledger text-muted-foreground">{codeIndex.byId.get(emp.id) ?? emp.employee_code ?? emp.guard_code ?? "—"}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
                {[
                  ["Status", lifecycleStatusLabel({ lifecycle_state: emp.lifecycle_state ?? "", status: emp.status })],
                  ["Posted at", emp.client?.name ?? "—"],
                  ["Region", emp.branch?.name ?? "—"],
                  ["Shift", emp.shift ? emp.shift[0].toUpperCase() + emp.shift.slice(1) : "—"],
                  ["Joined", emp.join_date ? formatDate(emp.join_date) : "—"],
                ].map(([k, v]) => (
                  <div key={k}>
                    <p className="lbl">{k}</p>
                    <p className="text-foreground">{v}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1 min-w-0">
                <span className="lbl">Base salary</span>
                <span className={fig}><span className="cur">PKR</span>{Math.round(Number(emp.base_salary ?? 0)).toLocaleString()}</span>
                <span className="text-xs text-muted-foreground truncate">{Number(emp.allowance ?? 0) > 0 ? `plus ${pkr(Number(emp.allowance))} allowance` : "no allowance"}</span>
              </div>
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1 min-w-0">
                <span className="lbl">Present · {fmtMonth(month)}</span>
                <span className={`${fig} text-up`}>{attSummary.present}<span className="text-sm text-muted-foreground font-normal"> / {calendar.days.length}</span></span>
                <span className="text-xs text-muted-foreground truncate">{attSummary.absent} absent · {attSummary.leave} leave · {calendar.days.length - attSummary.marked} unmarked</span>
              </div>
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1 min-w-0">
                <span className="lbl">Net pay · {fmtMonth(month)}</span>
                <span className={`${fig} ${monthPayslip ? (monthPayslip.disbursed ? "text-up" : "text-heed") : ""}`}>{monthPayslip ? <><span className="cur">PKR</span>{Math.round(Number(monthPayslip.net_salary)).toLocaleString()}</> : "—"}</span>
                <span className="text-xs text-muted-foreground truncate">
                  {monthPayslip
                    ? monthPayslip.disbursed
                      ? `Paid${monthPayslip.disbursed_at ? ` ${formatDate(monthPayslip.disbursed_at.slice(0, 10))}` : ""}`
                      : `${pkr(Number(monthPayslip.net_salary) - Number(monthPayslip.amount_paid))} still owed`
                    : "no payslip for this month yet"}
                </span>
              </div>
              <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1 min-w-0">
                <span className="lbl">{heldCash != null ? "Cash you hold" : "Owed to you"}</span>
                <span className={`${fig} ${heldCash == null && outstandingPay > 0 ? "text-heed" : ""}`}><span className="cur">PKR</span>{Math.round(heldCash ?? outstandingPay).toLocaleString()}</span>
                <span className="text-xs text-muted-foreground truncate">{heldCash != null ? "company cash in your custody" : "across every payslip, all time"}</span>
              </div>
              <div className="col-span-2 lg:col-span-1 rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1.5 min-w-0">
                <span className="lbl">Net pay · last {payTrend.length || 6} months</span>
                {payTrend.length === 0 ? (
                  <span className="text-xs text-muted-foreground">no payslips yet</span>
                ) : (
                  <div className="flex items-end gap-1.5 h-12">
                    {payTrend.map((p) => (
                      <div key={p.id} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={`${fmtMonth((p.period_month ?? "").slice(0, 7))}: ${pkr(p.net_salary)}${p.disbursed ? " · paid" : " · not yet paid"}`}>
                        <span className={`w-full rounded-t ${p.disbursed ? "bg-up" : "bg-heed"}`} style={{ height: `${Math.max(8, (Number(p.net_salary || 0) / payMax) * 36)}px` }} />
                        <span className="text-[9px] text-muted-foreground leading-none">{fmtMonth((p.period_month ?? "").slice(0, 7)).slice(0, 3)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </Header>
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-5">
        {err && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-xl text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{err}</div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        ) : !emp ? (
          <p className="text-sm text-muted-foreground py-10 text-center">
            The employee record this login points at could not be read.
          </p>
        ) : (
          <>
            {/* ── Attendance, as the month's calendar ── */}
            <Section title={`Attendance · ${fmtMonth(month)}`} count={attendance.length}>
              <div className="p-4">
                <div className="grid grid-cols-7 gap-1.5 max-w-xl">
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                    <span key={d} className="lbl text-center">{d}</span>
                  ))}
                  {Array.from({ length: calendar.lead }, (_, i) => <span key={`b${i}`} />)}
                  {calendar.days.map(({ d, status }) => (
                    <span
                      key={d}
                      title={status ? `${d} ${fmtMonth(month)} — ${status.replace(/_/g, " ")}` : `${d} ${fmtMonth(month)} — not marked`}
                      className={`aspect-square rounded-lg border flex flex-col items-center justify-center text-[11px] ${dayTone(status)}`}
                    >
                      <span className="font-semibold">{d}</span>
                      {status && <span className="uppercase text-[9px] leading-none">{status === "double_duty" ? "DD" : status[0]}</span>}
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap gap-4 mt-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-success-100 border border-success-200" /> Present</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-danger-50 border border-danger-200" /> Absent</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-warning-50 border border-warning-200" /> Leave</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-muted/40" /> Not marked</span>
                </div>
                {leave && (
                  <div className="mt-4 rounded-xl bg-muted/50 px-4 py-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                    <span className="lbl">Leave</span>
                    <span><span className="font-ledger font-semibold text-foreground">{leave.closing}</span> <span className="text-muted-foreground">days banked</span></span>
                    <span><span className="font-ledger font-semibold text-foreground">{leave.taken}</span> <span className="text-muted-foreground">taken this period</span></span>
                    {leave.unpaid > 0 && <span><span className="font-ledger font-semibold text-danger-700 dark:text-danger-500">{leave.unpaid}</span> <span className="text-muted-foreground">unpaid</span></span>}
                    <span className="text-xs text-muted-foreground ml-auto">period to {formatDate(leave.period_end)}</span>
                  </div>
                )}
              </div>
            </Section>

            {/* ── Payslips ── */}
            <Section title="Payslips" count={payslips.length}>
              {payslips.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground text-center">No payslips yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left px-4 py-2 text-xs text-muted-foreground">Month</th>
                        <th className="text-right px-4 py-2 text-xs text-muted-foreground">Present</th>
                        <th className="text-right px-4 py-2 text-xs text-muted-foreground">Base</th>
                        <th className="text-right px-4 py-2 text-xs text-muted-foreground">Bonus</th>
                        <th className="text-right px-4 py-2 text-xs text-muted-foreground">Advance</th>
                        <th className="text-right px-4 py-2 text-xs text-muted-foreground">Deductions</th>
                        <th className="text-right px-4 py-2 text-xs text-muted-foreground">Net</th>
                        <th className="text-right px-4 py-2 text-xs text-muted-foreground">Paid</th>
                        <th className="text-left px-4 py-2 text-xs text-muted-foreground">Status</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {payslips.map((p) => {
                        const owed = Number(p.net_salary || 0) - Number(p.amount_paid || 0);
                        return (
                          <tr key={p.id} className="hover:bg-accent/40">
                            <td className="px-4 py-2 text-sm text-foreground whitespace-nowrap">
                              {fmtMonth((p.period_month ?? "").slice(0, 7))}
                            </td>
                            <td className="px-4 py-2 text-sm text-right tabular-nums text-muted-foreground">{p.present_days}</td>
                            <td className="px-4 py-2 text-sm text-right tabular-nums">{pkr(p.base_salary)}</td>
                            <td className="px-4 py-2 text-sm text-right tabular-nums text-success-600">
                              {p.bonus ? pkr(p.bonus) : "—"}
                            </td>
                            <td className="px-4 py-2 text-sm text-right tabular-nums text-danger-600">
                              {p.advance ? pkr(p.advance) : "—"}
                            </td>
                            <td className="px-4 py-2 text-sm text-right tabular-nums text-danger-600">
                              {p.deductions ? pkr(p.deductions) : "—"}
                            </td>
                            <td className="px-4 py-2 text-sm text-right tabular-nums font-medium">{pkr(p.net_salary)}</td>
                            <td className="px-4 py-2 text-sm text-right tabular-nums text-success-700">{pkr(p.amount_paid)}</td>
                            <td className="px-4 py-2 text-sm">
                              {p.disbursed ? (
                                <span className="text-success-700">Paid</span>
                              ) : (
                                <span className="text-warning-700">{pkr(owed)} owed</span>
                              )}
                            </td>
                            <td className="px-4 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => generatePayslipPdf({
                                  branding: brandingFromCompany(company),
                                  monthLabel: fmtMonth((p.period_month ?? "").slice(0, 7)),
                                  employee: {
                                    full_name: emp.full_name,
                                    code: codeIndex.byId.get(emp.id) ?? emp.employee_code ?? emp.guard_code ?? "",
                                    posted_at: emp.client?.name ?? null,
                                    region: emp.branch?.name ?? null,
                                    bank: emp.bank_name ? `${emp.bank_name}${emp.account_title ? ` · ${emp.account_title}` : ""}` : null,
                                  },
                                  slip: p,
                                })}
                                className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                                title="Download this payslip as a PDF"
                              >
                                <FileText className="w-3.5 h-3.5" /> PDF
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            {/* ── Advances ── */}
            <Section title="Advances taken" count={advances.length}>
              {advances.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground text-center">No advances on record.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left px-4 py-2 text-xs text-muted-foreground">Date</th>
                        <th className="text-right px-4 py-2 text-xs text-muted-foreground">Amount</th>
                        <th className="text-left px-4 py-2 text-xs text-muted-foreground">Mode</th>
                        <th className="text-left px-4 py-2 text-xs text-muted-foreground">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {advances.map((a) => (
                        <tr key={a.id}>
                          <td className="px-4 py-2 text-sm whitespace-nowrap">{formatDate(a.advance_date)}</td>
                          <td className="px-4 py-2 text-sm text-right tabular-nums">{pkr(a.amount)}</td>
                          <td className="px-4 py-2 text-sm text-muted-foreground">{a.payment_mode ?? "—"}</td>
                          <td className="px-4 py-2 text-sm text-muted-foreground">{a.notes ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            {/* ── Documents and warnings ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <Section title="Documents on file" count={docs.length}>
                {docs.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-muted-foreground text-center">Nothing on file.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {docs.map((d) => (
                      <li key={d.id} className="px-4 py-2.5 flex items-center gap-2 text-sm">
                        <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" strokeWidth={1.5} />
                        <span className="flex-1 truncate">{d.file_name ?? d.doc_type ?? "Document"}</span>
                        <span className="text-xs text-muted-foreground">
                          {d.created_at ? formatDate(d.created_at.slice(0, 10)) : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Disciplinary warnings" count={warnings.length}>
                {warnings.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-muted-foreground text-center">
                    None — a clean record.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {warnings.map((w) => (
                      <li key={w.id} className="px-4 py-2.5 flex items-start gap-2 text-sm">
                        <ShieldAlert className="w-3.5 h-3.5 text-warning-600 shrink-0 mt-0.5" strokeWidth={1.5} />
                        <span className="flex-1">
                          <span className="text-foreground">{w.warning_type ?? "Warning"}</span>
                          {w.reason && <span className="text-muted-foreground"> — {w.reason}</span>}
                        </span>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {w.issued_date ? formatDate(w.issued_date) : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>

            <p className="text-xs text-muted-foreground">
              This page is read-only. If something here is wrong, it has to be corrected by whoever
              maintains the record — which is also the only way an audit of it stays meaningful.
            </p>
          </>
        )}
      </div>
    </>
  );
}
