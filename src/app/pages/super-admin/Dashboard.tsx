import { useCallback, useEffect, useMemo, useState } from "react";
import { useReconStatus } from "../../lib/reconStatus";
import { Loader2 } from "lucide-react";
import { formatDate } from "../../lib/date";
import { type FeedItem } from "../../components/ActivityFeed";
import { hasPermission, useAuth } from "../../lib/auth";
import { supabase, fetchAllRows } from "../../lib/supabase";
import { useRegion, withRegion } from "../../lib/region";
import {
  type AlertRow, type AttendancePoint, type BankRow, type ContractEndingRow, type DashData,
  type ExpensePieRow, type IncidentRow, type RecentPaymentRow, type TopClientRow,
  compact,
} from "./dashboard/shared";
import CommandDesign from "./dashboard/CommandDesign";
import { useCommandData } from "./dashboard/useCommandData";

// compliance_upcoming rows -> the panel's shape. One mapper, used by both the
// initial load and the realtime refresh, so the two cannot drift.
//
// The urgency badge is derived from days_remaining for every kind, where it
// used to be important_dates.priority for those rows and a separate ladder for
// contracts. The human-set priority is not lost — it travels in the view's
// sublabel, which is what the panel prints as the category line.
const toAlertRows = (data: unknown): AlertRow[] =>
  ((data ?? []) as {
    kind: string; ref_id: string; label: string; sublabel: string | null;
    due_date: string; days_remaining: number;
  }[]).map((r) => ({
    id: `${r.kind}-${r.ref_id}`,
    title: r.label,
    due_date: r.due_date,
    category: r.sublabel ?? "",
    priority:
      r.days_remaining < 0 ? "critical"
      : r.days_remaining <= 7 ? "critical"
      : r.days_remaining <= 30 ? "high"
      : "medium",
    days_remaining: r.days_remaining,
  }));

const monthRange = (offset: number) => {
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  const end = new Date(d.getFullYear(), d.getMonth() + offset + 1, 0);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysAgoIso = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const daysAheadIso = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

export default function SuperAdminDashboard() {
  const { profile, company } = useAuth();
  const { regionId } = useRegion();
  const hiddenWidgets = useMemo(
    () => new Set<string>((company?.dashboard_hidden_widgets ?? []) as string[]),
    [company?.dashboard_hidden_widgets],
  );
  const show = (key: string) => !hiddenWidgets.has(key);

  const can = {
    compliance: hasPermission(profile, "compliance.view"),
    employees: hasPermission(profile, "employees.view"),
    attendance: hasPermission(profile, "attendance.view"),
    expenses: hasPermission(profile, "expenses.view"),
    payroll: hasPermission(profile, "payroll.view"),
    accounting: hasPermission(profile, "banks.view"),
    // 2026-10-21: money a client owes or has paid, and what was invoiced, are
    // each their own permission. The Dashboard used to show them to anyone who
    // could open it — received this month, owed to us, billed, the payment
    // feed — whatever their role.
    invoices: hasPermission(profile, "invoices.view") || hasPermission(profile, "invoices.edit"),
    receivables: hasPermission(profile, "receivables.view") || hasPermission(profile, "invoices.view") || hasPermission(profile, "accounting.edit"),
    reports: hasPermission(profile, "reports.view"),
    contracts: hasPermission(profile, "contracts.view"),
    roster: hasPermission(profile, "roster.view"),
    incidents: hasPermission(profile, "incidents.view"),
    coa: hasPermission(profile, "coa.view") || hasPermission(profile, "reports.view"),
    periodClose: hasPermission(profile, "period_close.manage") || hasPermission(profile, "reports.view"),
  };

  const nothingToShow =
    !can.compliance && !can.employees && !can.attendance && !can.expenses &&
    !can.payroll && !can.accounting && !can.reports && !can.contracts &&
    !can.roster && !can.incidents && !can.invoices && !can.receivables;


  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [employeeCount, setEmployeeCount] = useState(0);
  const [attendanceTodayPct, setAttendanceTodayPct] = useState(0);
  const [attendanceYesterdayPct, setAttendanceYesterdayPct] = useState(0);

  const [expensesMtd, setExpensesMtd] = useState(0);
  const [expensesPrev, setExpensesPrev] = useState(0);

  const [payrollMtd, setPayrollMtd] = useState(0);
  const [payrollPrev, setPayrollPrev] = useState(0);

  const [banks, setBanks] = useState<BankRow[]>([]);
  const [topClients, setTopClients] = useState<TopClientRow[]>([]);
  const [attendanceTrend, setAttendanceTrend] = useState<AttendancePoint[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);

  // Sprint 1-5 additions
  const [activeContracts, setActiveContracts] = useState(0);
  const [openIncidents, setOpenIncidents] = useState(0);
  const [licencesExpiring, setLicencesExpiring] = useState(0);
  const [licencesOverdue, setLicencesOverdue] = useState(0);
  const [expensesPie, setExpensesPie] = useState<ExpensePieRow[]>([]);
  const [contractsEnding, setContractsEnding] = useState<ContractEndingRow[]>([]);
  const [recentIncidents, setRecentIncidents] = useState<IncidentRow[]>([]);
  const [recentPayments, setRecentPayments] = useState<RecentPaymentRow[]>([]);
  const [periodClosedThisMonth, setPeriodClosedThisMonth] = useState<boolean | null>(null);
  const [lastClosedMonth, setLastClosedMonth] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { start: mStart, end: mEnd } = monthRange(0);
        const { start: pStart, end: pEnd } = monthRange(-1);
        const today = todayIso();
        const yesterday = daysAgoIso(1);
        const sevenDaysAgo = daysAgoIso(6);
        const in60 = daysAheadIso(60);
        const periodMonthKey = `${mStart.slice(0, 7)}-01`;

        const [
          empRes,
          attTodayRes,
          attYestRes,
          attTrendRes,
          expMtdRes,
          expPrevRes,
          psMtdRes,
          psPrevRes,
          banksRes,
          payMtdRes,
          complianceRes,
          // Sprint 1-5 additions
          activeContractsRes,
          openIncidentsRes,
          expCatRes,
          contractsEndingRes,
          recentIncRes,
          recentPayRes,
          empExpRes,
          periodRes,
          periodLastRes,
        ] = await Promise.all([
          // Region-aware widgets filter on branch_id via the global selector.
          can.employees ? withRegion(supabase.from("employees").select("id", { count: "exact", head: true }).eq("status", "Active"), regionId) : Promise.resolve({ data: [], error: null, count: 0 } as never),
          can.attendance || can.roster ? withRegion(supabase.from("attendance_records").select("status").eq("attendance_date", today), regionId) : Promise.resolve({ data: [], error: null, count: 0 } as never),
          can.attendance || can.roster ? withRegion(supabase.from("attendance_records").select("status").eq("attendance_date", yesterday), regionId) : Promise.resolve({ data: [], error: null, count: 0 } as never),
          can.attendance || can.roster ? withRegion(supabase.from("attendance_records").select("attendance_date, status").gte("attendance_date", sevenDaysAgo).lte("attendance_date", today), regionId) : Promise.resolve({ data: [], error: null, count: 0 } as never),
          can.expenses ? withRegion(supabase.from("expenses").select("amount, expense_date, category_id").gte("expense_date", mStart).lte("expense_date", mEnd), regionId) : Promise.resolve({ data: [], error: null, count: 0 } as never),
          can.expenses ? withRegion(supabase.from("expenses").select("amount, expense_date").gte("expense_date", pStart).lte("expense_date", pEnd), regionId) : Promise.resolve({ data: [], error: null, count: 0 } as never),
          can.payroll ? withRegion(supabase.from("payslips").select("net_salary, disbursed").eq("period_month", periodMonthKey).eq("disbursed", true), regionId) : Promise.resolve({ data: [], error: null, count: 0 } as never),
          can.payroll ? withRegion(supabase.from("payslips").select("net_salary, disbursed").eq("period_month", `${pStart.slice(0, 7)}-01`).eq("disbursed", true), regionId) : Promise.resolve({ data: [], error: null, count: 0 } as never),
          // Bank pool is shared across regions (spec §8) — stays company-wide.
          can.accounting ? supabase.from("bank_accounts").select("id, bank_name, balance").order("bank_name") : Promise.resolve({ data: [], error: null, count: 0 } as never),
          !can.receivables ? Promise.resolve([] as { client_id: string | null; invoice_id: string | null; amount: number; payment_date: string }[]) : fetchAllRows<{ client_id: string | null; invoice_id: string | null; amount: number; payment_date: string }>(() =>
            withRegion(
              supabase
                .from("invoice_payments")
                .select("client_id, invoice_id, amount, payment_date")
                .gte("payment_date", mStart)
                .lte("payment_date", mEnd),
              regionId,
            ) as unknown as {
                range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
              },
          ),
          // Compliance alerts — one query where there were two.
          //
          // This panel previously read important_dates directly AND
          // clients.contract_end, which made it a sixth implementation of "what
          // is expiring" (0291 found five). clients.contract_end is not
          // authoritative — contracts.end_date is — but two clients carry an end
          // date with no active contract row behind them, so repointing alone
          // would have dropped them. 0293 adds them to the view as an explicit
          // client_contract_end ANOMALY instead. Both now arrive from one place.
          //
          // No lower bound. Overdue items are the loudest rows here, not the
          // ones that fall out of the filter.
          !can.compliance ? Promise.resolve({ data: [], error: null } as never) : withRegion(
            supabase
              .from("compliance_upcoming")
              .select("kind, ref_id, label, sublabel, due_date, days_remaining")
              .in("kind", ["important_date", "contract_end", "client_contract_end"])
              .lte("days_remaining", 60)
              .order("days_remaining"),
            regionId,
          ),
          // active contracts count — contracts carry no branch_id (region is via
          // client); left company-wide rather than restructure this count query.
          can.contracts ? supabase.from("contracts").select("id", { count: "exact", head: true }).eq("status", "active") : Promise.resolve({ data: [], error: null, count: 0 } as never),
          // open incidents count (open + under_investigation)
          can.incidents ? withRegion(supabase.from("incidents").select("id", { count: "exact", head: true }).in("status", ["open", "under_investigation"]), regionId) : Promise.resolve({ data: [], error: null, count: 0 } as never),
          // expense categories for pie chart
          supabase.from("expense_categories").select("id, name"),
          // contracts ending in next 60 days — no branch_id on contracts; left
          // company-wide (region for contracts is derivable only via client).
          !can.contracts ? Promise.resolve({ data: [], error: null } as never) : supabase
            .from("contracts")
            .select("id, contract_code, client_id, end_date")
            .eq("status", "active")
            .not("end_date", "is", null)
            .gte("end_date", today)
            .lte("end_date", in60)
            .order("end_date")
            .limit(10),
          // recent incidents (last 30 days)
          !can.incidents ? Promise.resolve({ data: [], error: null } as never) : withRegion(
            supabase
              .from("incidents")
              .select("id, incident_code, severity, category, occurred_at, status")
              .gte("occurred_at", daysAgoIso(30) + "T00:00:00Z")
              .order("occurred_at", { ascending: false })
              .limit(8),
            regionId,
          ),
          // Latest payments for the activity feed. Deliberately NOT windowed to a
          // month: the feed used to reuse the month-to-date figures behind "Top
          // clients", so on the 1st of every month it emptied itself and the whole
          // section vanished. Guards and Guides last took a payment on 28 Jul, so
          // by August the feed had nothing to say. Newest first, no date filter.
          !can.receivables ? Promise.resolve({ data: [], error: null } as never) : withRegion(
            supabase
              .from("invoice_payments")
              .select("id, client_id, invoice_id, amount, payment_date")
              .order("payment_date", { ascending: false })
              .limit(8),
            regionId,
          ),
          // Guard compliance expiries — from compliance_upcoming, the one place
          // this is computed (0291/0292). No lower bound: an item that expired
          // last week is not "not yet due", it is the most urgent row there is.
          !can.compliance ? Promise.resolve({ data: [], error: null } as never) : withRegion(
            supabase
              .from("compliance_upcoming")
              .select("kind, ref_id, days_remaining")
              .lte("days_remaining", 30),
            regionId,
          ),
          // current month period closed?
          supabase
            .from("accounting_periods")
            .select("period_month")
            .eq("period_month", periodMonthKey)
            .maybeSingle(),
          // most recent closed month
          supabase
            .from("accounting_periods")
            .select("period_month")
            .order("period_month", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);

        if (cancelled) return;

        if (empRes.error) throw empRes.error;
        setEmployeeCount(empRes.count ?? 0);

        const attPct = (rows: { status: string }[] | null): number => {
          if (!rows || rows.length === 0) return 0;
          const present = rows.filter((r) => r.status === "present").length;
          return Math.round((present / rows.length) * 100);
        };
        if (attTodayRes.error) throw attTodayRes.error;
        if (attYestRes.error) throw attYestRes.error;
        setAttendanceTodayPct(attPct(attTodayRes.data as { status: string }[]));
        setAttendanceYesterdayPct(attPct(attYestRes.data as { status: string }[]));

        if (attTrendRes.error) throw attTrendRes.error;
        const byDay = new Map<string, { present: number; absent: number; leave: number }>();
        const dayList: string[] = [];
        for (let i = 6; i >= 0; i -= 1) {
          const d = daysAgoIso(i);
          dayList.push(d);
          byDay.set(d, { present: 0, absent: 0, leave: 0 });
        }
        for (const r of (attTrendRes.data ?? []) as { attendance_date: string; status: string }[]) {
          const slot = byDay.get(r.attendance_date);
          if (!slot) continue;
          if (r.status === "present") slot.present += 1;
          else if (r.status === "absent") slot.absent += 1;
          else if (r.status === "leave") slot.leave += 1;
        }
        setAttendanceTrend(
          dayList.map((d) => {
            const slot = byDay.get(d)!;
            const label = new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
            return { date: d, label, ...slot };
          }),
        );

        if (expMtdRes.error) throw expMtdRes.error;
        if (expPrevRes.error) throw expPrevRes.error;
        const sum = (rows: { amount: number }[] | null) =>
          (rows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
        setExpensesMtd(sum(expMtdRes.data as { amount: number }[]));
        setExpensesPrev(sum(expPrevRes.data as { amount: number }[]));

        // Expense pie — group MTD expenses by category name
        const catMap = new Map<string, string>();
        for (const c of (expCatRes.data ?? []) as { id: string; name: string }[]) catMap.set(c.id, c.name);
        const pieMap = new Map<string, number>();
        for (const e of ((expMtdRes.data ?? []) as { amount: number; category_id: string | null }[])) {
          const name = e.category_id ? catMap.get(e.category_id) ?? "Other" : "Uncategorised";
          pieMap.set(name, (pieMap.get(name) ?? 0) + Number(e.amount ?? 0));
        }
        const pieData: ExpensePieRow[] = Array.from(pieMap.entries())
          .map(([name, value]) => ({ name, value }))
          .filter((r) => r.value > 0)
          .sort((a, b) => b.value - a.value);
        setExpensesPie(pieData);

        if (psMtdRes.error) throw psMtdRes.error;
        if (psPrevRes.error) throw psPrevRes.error;
        const sumPay = (rows: { net_salary: number }[] | null) =>
          (rows ?? []).reduce((s, r) => s + Number(r.net_salary ?? 0), 0);
        setPayrollMtd(sumPay(psMtdRes.data as { net_salary: number }[]));
        setPayrollPrev(sumPay(psPrevRes.data as { net_salary: number }[]));

        if (banksRes.error) throw banksRes.error;
        setBanks(
          ((banksRes.data ?? []) as BankRow[]).map((b) => ({
            id: b.id,
            bank_name: b.bank_name,
            balance: Number(b.balance ?? 0),
          })),
        );

        // Top clients by payments
        const payByClient = new Map<string, number>();
        const invoiceOnly: string[] = [];
        for (const r of payMtdRes) {
          if (r.client_id) payByClient.set(r.client_id, (payByClient.get(r.client_id) ?? 0) + Number(r.amount));
          else if (r.invoice_id) invoiceOnly.push(r.invoice_id);
        }
        if (invoiceOnly.length > 0) {
          const { data: invs } = await supabase.from("invoices").select("id, client_id").in("id", invoiceOnly);
          const map = new Map<string, string>();
          for (const i of (invs ?? []) as { id: string; client_id: string }[]) map.set(i.id, i.client_id);
          for (const r of payMtdRes) {
            if (!r.client_id && r.invoice_id) {
              const cid = map.get(r.invoice_id);
              if (cid) payByClient.set(cid, (payByClient.get(cid) ?? 0) + Number(r.amount));
            }
          }
        }
        const clientIds = Array.from(payByClient.keys());
        if (clientIds.length > 0) {
          const { data: clientRows } = await supabase.from("clients").select("id, name").in("id", clientIds);
          const nameMap = new Map<string, string>();
          for (const c of (clientRows ?? []) as { id: string; name: string }[]) nameMap.set(c.id, c.name);
          const list: TopClientRow[] = clientIds.map((id) => ({
            id,
            name: nameMap.get(id) ?? "Unknown client",
            revenue: payByClient.get(id) ?? 0,
          }));
          list.sort((a, b) => b.revenue - a.revenue);
          setTopClients(list.slice(0, 10));
        } else {
          setTopClients([]);
        }

        // Compliance alerts
        if (complianceRes.error) throw complianceRes.error;
        const todayDate = new Date(today);
        setAlerts(toAlertRows(complianceRes.data));

        // Sprint 1-5 stat tallies
        setActiveContracts(activeContractsRes.count ?? 0);
        setOpenIncidents(openIncidentsRes.count ?? 0);

        // Guards with a compliance item due within 30 days OR ALREADY OVERDUE.
        //
        // The previous version of this tile filtered `d >= today && d <= in30`,
        // so an expired item fell out of the window entirely and the tile read
        // zero while ten guards on production held an expired CNIC. The lower
        // bound was the defect: it hid the failures and showed the warnings.
        // See TENANT_GUARD_REPORT.md 9.11.
        //
        // Membership and the day arithmetic now come from the view. The only
        // decision left here is which kinds this particular tile covers, which
        // is presentation, not computation.
        const GUARD_KINDS = new Set([
          "weapon_licence", "guard_licence", "medical_fitness", "probation_end",
          "cnic", "weapons_cert", "refresher", "guard_document", "training",
        ]);
        const dueRows = ((empExpRes.data ?? []) as {
          kind: string; ref_id: string; days_remaining: number;
        }[]).filter((r) => GUARD_KINDS.has(r.kind));
        // One guard with three lapsing documents is one guard, as before.
        setLicencesExpiring(new Set(dueRows.map((r) => r.ref_id)).size);
        setLicencesOverdue(
          new Set(dueRows.filter((r) => r.days_remaining < 0).map((r) => r.ref_id)).size,
        );

        // Contracts ending list
        const contractsEndingRaw = (contractsEndingRes.data ?? []) as { id: string; contract_code: string; client_id: string | null; end_date: string }[];
        const ceClientIds = Array.from(new Set(contractsEndingRaw.map((c) => c.client_id).filter(Boolean) as string[]));
        const ceClientMap = new Map<string, string>();
        if (ceClientIds.length > 0) {
          const { data: ceClients } = await supabase.from("clients").select("id, name").in("id", ceClientIds);
          for (const c of (ceClients ?? []) as { id: string; name: string }[]) ceClientMap.set(c.id, c.name);
        }
        setContractsEnding(contractsEndingRaw.map((c) => ({
          id: c.id,
          code: c.contract_code,
          client_name: c.client_id ? ceClientMap.get(c.client_id) ?? "—" : "—",
          end_date: c.end_date,
          days_left: Math.round((new Date(c.end_date).getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24)),
        })));

        // Recent incidents
        type IncidentRaw = { id: string; incident_code: string; severity: string; category: string; occurred_at: string; status: string };
        setRecentIncidents(((recentIncRes.data ?? []) as IncidentRaw[]).map((i) => ({
          id: i.id,
          code: i.incident_code,
          severity: i.severity,
          category: i.category,
          occurred_at: i.occurred_at,
          status: i.status,
        })));

        // Recent payments for the activity feed. A payment names either a client
        // directly or only the invoice it settles, so unresolved ones are looked
        // up through invoices — the same two-step the top-clients figures use.
        type PayRaw = { id: string; client_id: string | null; invoice_id: string | null; amount: number; payment_date: string };
        const recentPayRaw = (recentPayRes.data ?? []) as PayRaw[];
        const payClientIds = new Set(recentPayRaw.map((p) => p.client_id).filter(Boolean) as string[]);
        const payInvoiceIds = recentPayRaw.filter((p) => !p.client_id && p.invoice_id).map((p) => p.invoice_id as string);
        const invoiceToClient = new Map<string, string>();
        if (payInvoiceIds.length > 0) {
          const { data: invs } = await supabase.from("invoices").select("id, client_id").in("id", payInvoiceIds);
          for (const i of (invs ?? []) as { id: string; client_id: string }[]) {
            invoiceToClient.set(i.id, i.client_id);
            payClientIds.add(i.client_id);
          }
        }
        const payNames = new Map<string, string>();
        if (payClientIds.size > 0) {
          const { data: cls } = await supabase.from("clients").select("id, name").in("id", [...payClientIds]);
          for (const c of (cls ?? []) as { id: string; name: string }[]) payNames.set(c.id, c.name);
        }
        setRecentPayments(
          recentPayRaw.map((p) => {
            const cid = p.client_id ?? (p.invoice_id ? invoiceToClient.get(p.invoice_id) ?? null : null);
            return {
              id: p.id,
              client_name: cid ? payNames.get(cid) ?? "Unknown client" : "Unallocated",
              amount: Number(p.amount ?? 0),
              payment_date: p.payment_date,
            };
          }),
        );

        // Period close status
        setPeriodClosedThisMonth(periodRes.data != null);
        setLastClosedMonth((periodLastRes.data as { period_month: string } | null)?.period_month ?? null);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Re-fetch region-aware widgets when the global region selector changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId]);

  /**
   * Re-read just the three sources the activity feed is built from. Cheap
   * enough to run on every insert, and it resolves client names properly —
   * which a raw realtime payload cannot do, since it carries a client_id (or
   * only an invoice_id) and no name.
   */
  const refreshFeed = useCallback(async () => {
    const today = todayIso();
    const [payRes, incRes, dateRes] = await Promise.all([
      withRegion(
        supabase
          .from("invoice_payments")
          .select("id, client_id, invoice_id, amount, payment_date")
          .order("payment_date", { ascending: false })
          .limit(8),
        regionId,
      ),
      withRegion(
        supabase
          .from("incidents")
          .select("id, incident_code, severity, category, occurred_at, status")
          .gte("occurred_at", daysAgoIso(30) + "T00:00:00Z")
          .order("occurred_at", { ascending: false })
          .limit(8),
        regionId,
      ),
      withRegion(
        supabase
          .from("compliance_upcoming")
          .select("kind, ref_id, label, sublabel, due_date, days_remaining")
          .in("kind", ["important_date", "contract_end", "client_contract_end"])
          .lte("days_remaining", 60)
          .order("days_remaining"),
        regionId,
      ),
    ]);

    type PayRaw = { id: string; client_id: string | null; invoice_id: string | null; amount: number; payment_date: string };
    const raw = (payRes.data ?? []) as PayRaw[];
    const clientIds = new Set(raw.map((p) => p.client_id).filter(Boolean) as string[]);
    const invoiceIds = raw.filter((p) => !p.client_id && p.invoice_id).map((p) => p.invoice_id as string);
    const invToClient = new Map<string, string>();
    if (invoiceIds.length > 0) {
      const { data: invs } = await supabase.from("invoices").select("id, client_id").in("id", invoiceIds);
      for (const i of (invs ?? []) as { id: string; client_id: string }[]) {
        invToClient.set(i.id, i.client_id);
        clientIds.add(i.client_id);
      }
    }
    const names = new Map<string, string>();
    if (clientIds.size > 0) {
      const { data: cls } = await supabase.from("clients").select("id, name").in("id", [...clientIds]);
      for (const c of (cls ?? []) as { id: string; name: string }[]) names.set(c.id, c.name);
    }
    setRecentPayments(
      raw.map((p) => {
        const cid = p.client_id ?? (p.invoice_id ? invToClient.get(p.invoice_id) ?? null : null);
        return {
          id: p.id,
          client_name: cid ? names.get(cid) ?? "Unknown client" : "Unallocated",
          amount: Number(p.amount ?? 0),
          payment_date: p.payment_date,
        };
      }),
    );

    type IncRaw = { id: string; incident_code: string; severity: string; category: string; occurred_at: string; status: string };
    setRecentIncidents(
      ((incRes.data ?? []) as IncRaw[]).map((i) => ({
        id: i.id,
        code: i.incident_code,
        severity: i.severity,
        category: i.category,
        occurred_at: i.occurred_at,
        status: i.status,
      })),
    );
    // One source now, so this replaces the whole list rather than merging two
    // halves and hoping the id prefixes keep them apart.
    if (dateRes.data) setAlerts(() => {
      return toAlertRows(dateRes.data);
    });
  }, [regionId]);

  /**
   * THIS is what makes the feed live. Without it the panel was a snapshot from
   * page load that the component rotated on a timer to look busy — the "live"
   * badge was decoration. Now a payment banked or an incident logged anywhere
   * pushes into an open dashboard within a second.
   *
   * Requires the tables to be in the supabase_realtime publication (0171); the
   * subscription would otherwise connect fine and receive nothing forever.
   */
  useEffect(() => {
    const channel = supabase
      .channel("dashboard-activity")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "invoice_payments" }, () => { refreshFeed(); })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "incidents" }, () => { refreshFeed(); })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "important_dates" }, () => { refreshFeed(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [refreshFeed]);

  const totalBankBalance = useMemo(() => banks.reduce((s, b) => s + b.balance, 0), [banks]);

  const branchScopeNote = profile?.branch_id ? "Scoped to your branch." : null;

  /**
   * Live activity feed — real recent data: payments in, incidents logged,
   * compliance items due.
   *
   * The payment lines come from the LATEST payments, not month-to-date. They
   * used to reuse the "Top clients this month" figures, which meant the feed
   * reset to empty at every month boundary and, because the section was hidden
   * whenever it had no items, the whole panel disappeared with no explanation.
   * Guards and Guides last banked a payment on 28 July, so the feed went blank
   * on 1 August and stayed blank.
   *
   * Newest first across all three sources, so the feed reads chronologically
   * rather than payments-then-incidents-then-alerts.
   */
  const feedItems = useMemo<FeedItem[]>(() => {
    const dated: { at: string; item: FeedItem }[] = [];
    recentPayments.forEach((p) =>
      dated.push({
        at: p.payment_date,
        item: {
          id: `pay-${p.id}`,
          tone: "in",
          text: `Payment received · ${p.client_name} · ${formatDate(p.payment_date)}`,
          amount: `+${compact(p.amount)}`,
        },
      }),
    );
    recentIncidents.forEach((i) =>
      dated.push({
        at: i.occurred_at.slice(0, 10),
        item: {
          id: `inc-${i.id}`,
          tone: "out",
          text: `Incident ${i.code} · ${i.category} · ${i.status.replace(/_/g, " ")}`,
        },
      }),
    );
    alerts.forEach((a) =>
      dated.push({
        at: a.due_date,
        item: { id: `al-${a.id}`, tone: "evt", text: `${a.title} · due ${formatDate(a.due_date)}` },
      }),
    );
    return dated.sort((a, b) => b.at.localeCompare(a.at)).map((d) => d.item);
  }, [recentPayments, recentIncidents, alerts]);

  // The command dashboard (2026-10-20) replaces the classic layout and the
  // three alternate designs that sat behind a floating switcher: one home
  // screen, read the same way by everyone.
  const command = useCommandData(company?.id, regionId, can);
  const recon = useReconStatus(profile?.view_as_company ?? profile?.company_id ?? company?.id, can.accounting);
  const data: DashData = {
    can, recon, show, nothingToShow, branchScopeNote,
    companyName: profile?.display_company_name || company?.name || "Bastion",
    userName: profile?.full_name ?? "",
    employeeCount, attendanceTodayPct, attendanceYesterdayPct,
    expensesMtd, expensesPrev, payrollMtd, payrollPrev,
    banks, totalBankBalance, topClients, attendanceTrend, alerts,
    activeContracts, openIncidents, licencesExpiring, licencesOverdue,
    expensesPie, contractsEnding, recentIncidents, recentPayments,
    periodClosedThisMonth, lastClosedMonth, feedItems,
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading dashboard…
      </div>
    );
  }
  return (
    <>
      {error && (
        <div role="alert" className="mx-3 md:mx-8 mt-3 p-3 rounded-xl bg-danger-50 text-danger-700 dark:text-danger-500 border border-danger-200 text-sm">{error}</div>
      )}
      <CommandDesign d={data} c={command} />
    </>
  );
}
