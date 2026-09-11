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
    slate: "border-l-slate-400",
    success: "border-l-success-500",
    warning: "border-l-warning-500",
    brand: "border-l-brand-500",
  }[tone];
  return (
    <div className={`bg-card p-4 rounded-xl border border-border border-l-4 ${bar}`}>
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5" strokeWidth={1.5} />
        {label}
      </p>
      <p className="text-xl font-semibold tabular-nums text-foreground" style={{ fontFamily: "var(--font-display)" }}>
        {value}
      </p>
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {count != null && <span className="text-xs text-muted-foreground">{count}</span>}
      </div>
      {children}
    </div>
  );
}

export default function MyProfile() {
  const { profile, company } = useAuth();
  const employeeId = profile?.employee_id ?? null;

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [month, setMonth] = useState(monthNow());

  const [emp, setEmp] = useState<EmployeeRow | null>(null);
  const [payslips, setPayslips] = useState<PayslipRow[]>([]);
  const [advances, setAdvances] = useState<AdvanceRow[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [warnings, setWarnings] = useState<WarningRow[]>([]);
  const [heldCash, setHeldCash] = useState<number | null>(null);

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
          .select("id, warning_type, reason, issued_date")
          .eq("employee_id", employeeId)
          .order("issued_date", { ascending: false }),
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
      setWarnings((warnRes.data ?? []) as WarningRow[]);
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
          <div className="flex items-start gap-2 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800">
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

  return (
    <>
      <Header title="My Profile" subtitle={emp ? `${emp.full_name} · your record, attendance, pay and cash` : "Your own record"} />
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-5">
        {err && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
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
            {/* ── Who you are ── */}
            <div className="bg-card rounded-xl border border-border p-5">
              <div className="flex flex-wrap items-start gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-500/15 text-brand-600 shrink-0">
                  <UserRound className="w-6 h-6" strokeWidth={1.5} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold text-foreground" style={{ fontFamily: "var(--font-display)" }}>
                    {emp.full_name}
                  </h2>
                  <p className="text-xs font-mono text-muted-foreground">
                    {emp.employee_code ?? emp.guard_code ?? "—"}
                  </p>
                  <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-sm">
                    {[
                      ["Status", lifecycleStatusLabel({ lifecycle_state: emp.lifecycle_state ?? "", status: emp.status })],
                      ["Posted at", emp.client?.name ?? "—"],
                      ["Site / location", emp.location?.name ?? "—"],
                      ["Region", emp.branch?.name ?? "—"],
                      ["Designation", emp.department ?? "—"],
                      ["Shift", emp.shift ? emp.shift[0].toUpperCase() + emp.shift.slice(1) : "—"],
                      ["Joined", emp.join_date ? formatDate(emp.join_date) : "—"],
                      ["Phone", emp.phone ?? "—"],
                    ].map(([k, v]) => (
                      <div key={k as string}>
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</p>
                        <p className="text-foreground truncate">{v as string}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* ── The numbers ── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Card
                icon={Banknote}
                label="Base salary"
                tone="brand"
                value={pkr(Number(emp.base_salary ?? 0))}
                hint={Number(emp.allowance ?? 0) > 0 ? `plus ${pkr(Number(emp.allowance))} allowance` : "no allowance"}
              />
              <Card
                icon={CalendarDays}
                label={`Present · ${fmtMonth(month)}`}
                tone="success"
                value={String(attSummary.present)}
                hint={`${attSummary.absent} absent · ${attSummary.leave} leave · ${attSummary.marked} days marked`}
              />
              <Card
                icon={Wallet}
                label={`Net pay · ${fmtMonth(month)}`}
                value={monthPayslip ? pkr(monthPayslip.net_salary) : "—"}
                hint={
                  monthPayslip
                    ? monthPayslip.disbursed
                      ? `Paid${monthPayslip.disbursed_at ? ` ${formatDate(monthPayslip.disbursed_at.slice(0, 10))}` : ""}`
                      : `${pkr(Number(monthPayslip.net_salary) - Number(monthPayslip.amount_paid))} still owed`
                    : "No payslip for this month yet"
                }
                tone={monthPayslip?.disbursed ? "success" : "warning"}
              />
              {heldCash != null ? (
                <Card
                  icon={Wallet}
                  label="Cash you hold"
                  tone="warning"
                  value={pkr(heldCash)}
                  hint="Company cash in your custody"
                />
              ) : (
                <Card
                  icon={Wallet}
                  label="Owed to you"
                  tone={outstandingPay > 0 ? "warning" : "success"}
                  value={pkr(outstandingPay)}
                  hint="Across every payslip, all time"
                />
              )}
            </div>

            {/* ── Month selector, shared by the attendance and pay cards above ── */}
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-sm text-muted-foreground">Month</label>
              <select
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="px-2 py-1.5 border border-border rounded-md text-sm bg-card"
              >
                {recentMonths().map((m) => (
                  <option key={m} value={m}>
                    {fmtMonth(m)}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted-foreground">
                Changes the attendance and net-pay cards above, and the attendance list below.
              </span>
            </div>

            {/* ── Attendance ── */}
            <Section title={`Attendance · ${fmtMonth(month)}`} count={attendance.length}>
              {attendance.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground text-center">
                  Nothing marked for this month.
                </p>
              ) : (
                <div className="p-4 flex flex-wrap gap-1.5">
                  {attendance.map((a) => {
                    const s = (a.status ?? "").toLowerCase();
                    const tone = s.startsWith("present") || s === "double_duty"
                      ? "bg-success-100 text-success-800 border-success-200"
                      : s.startsWith("absent")
                        ? "bg-danger-50 text-danger-700 border-danger-200"
                        : s.startsWith("leave")
                          ? "bg-warning-50 text-warning-800 border-warning-200"
                          : "bg-slate-50 text-slate-600 border-slate-200";
                    return (
                      <span
                        key={a.attendance_date}
                        title={`${formatDate(a.attendance_date)} — ${a.status}`}
                        className={`inline-flex flex-col items-center justify-center w-10 h-10 rounded border text-[11px] ${tone}`}
                      >
                        <span className="font-medium">{Number(a.attendance_date.slice(8, 10))}</span>
                        <span className="uppercase">{(a.status ?? "?")[0]}</span>
                      </span>
                    );
                  })}
                </div>
              )}
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
