import { useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { supabase } from "../../lib/supabase";
import type { Advance, Expense, InvoicePayment, Payslip, Cheque, Client } from "../../lib/supabase";
import { useRegion, withRegion } from "../../lib/region";
import { Download, Loader2 } from "lucide-react";
import Modal from "../../components/Modal";
import ThemedSelect from "../../components/ThemedSelect";
import ExportButton from "../../components/ExportButton";
import { exportClientStatements } from "../../lib/excel";
import { formatDate } from "../../lib/date";

// One cash event, already resolved to a cash-basis effective date.
type CashItem = { date: string; amount: number; group: string; detail: string };

type MetricKey = "revenue" | "payroll" | "expenses" | "advances";

type MonthRow = {
  key: string;
  label: string;
  revenue: number;
  expenses: number;
  payroll: number;
  advances: number;
  net: number;
};

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const isoDay = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);
const monthKey = (day: string) => day.slice(0, 7);
const monthLabel = (key: string) => {
  const [y, m] = key.split("-");
  return `${MONTH_LABELS[Number(m) - 1]} ${y.slice(-2)}`;
};
const todayMonthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const currency = (n: number) => `PKR ${Math.round(n).toLocaleString("en-PK")}`;

type PeriodMode = "month" | "range" | "all";

const firstOfMonth = (key: string) => `${key}-01`;
const lastOfMonth = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return `${key}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
};
const formatPeriod = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

/**
 * One client's month on a CASH basis.
 *
 * The revenue-basis twin in Financial Reports reads invoices raised, payroll
 * accrued to the period and expenses by their expense_date. Every figure here
 * is the same question asked of money that actually moved: received, not
 * invoiced; disbursed, not earned; paid, not incurred.
 */
type CashStatementRow = {
  client: Client;
  received: number;
  payrollPaid: number;
  expensesPaid: number;
  /** This client's share of its region's own unattributed cost. */
  regionalOverhead: number;
  /** This client's share of head office, pro-rata by revenue. */
  hoShare: number;
  netCash: number;
  /** Region the client sits in, for the Head-Office-by-region breakdown. */
  branchId: string | null;
  regionName: string;
  payments: { id: string; date: string; amount: number; mode: string | null }[];
};

/** One row of public.client_statement_loaded, asked on the cash basis. */
type LoadedStatement = {
  client_id: string;
  branch_id: string | null;
  region_name: string;
  revenue: number;
  direct_payroll: number;
  direct_expenses: number;
  regional_overhead: number;
  ho_share: number;
  net: number;
};

export default function Cashflow({ embedded = false }: { embedded?: boolean } = {}) {
  const { regionId } = useRegion();
  const [invoicePayments, setInvoicePayments] = useState<InvoicePayment[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [cheques, setCheques] = useState<Cheque[]>([]);
  const [clientNames, setClientNames] = useState<Map<string, string>>(new Map());
  const [employeeNames, setEmployeeNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Period filter (item 1).
  const [mode, setMode] = useState<PeriodMode>("all");
  const [selMonth, setSelMonth] = useState<string>(todayMonthKey());
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  // Which card's breakdown is expanded (item 2).
  const [openMetric, setOpenMetric] = useState<MetricKey | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  // ----- Client Statements (cash basis) tab -----
  const [activeTab, setActiveTab] = useState<"cashflow" | "clients">("cashflow");
  const [clients, setClients] = useState<Client[]>([]);
  const [statementPeriod, setStatementPeriod] = useState<string>(todayMonthKey());
  // client_id → payroll CASH paid in the statement month, split by days worked
  // (payroll_cash_by_client, migration 0176).
  const [payrollCashByClient, setPayrollCashByClient] = useState<Map<string, number>>(new Map());
  const [loadedStatements, setLoadedStatements] = useState<LoadedStatement[]>([]);
  // Regional Overhead is an INVOICED-basis figure (pro-rata by Total Invoiced),
  // so it comes from the revenue-basis call — the same value Financial Reports
  // shows. Keyed by client so both pages display an identical number.
  const [revOverheadByClient, setRevOverheadByClient] = useState<Map<string, number>>(new Map());
  const [loadingStatements, setLoadingStatements] = useState(false);
  const [selectedStatement, setSelectedStatement] = useState<CashStatementRow | null>(null);

  const statementPeriodOptions = useMemo(() => {
    const opts: string[] = [];
    const d = new Date();
    d.setDate(1);
    for (let i = 0; i < 12; i += 1) {
      opts.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      d.setMonth(d.getMonth() - 1);
    }
    return opts;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [payRes, psRes, exRes, advRes, chqRes, cliRes, empRes] = await Promise.all([
          // Flow sources all carry branch_id, so the global region selector scopes
          // this projection to the region's own inflows/outflows. Client/employee
          // name lookups stay unfiltered — they're just label maps.
          // id + payment_mode are for the Client Statements tab's detail table;
          // it deliberately reads the SAME rows this page already loaded, so the
          // two tabs can never disagree about what came in.
          withRegion(
            supabase.from("invoice_payments").select("id, amount, payment_date, client_id, payment_mode"),
            regionId,
          ),
          withRegion(supabase.from("payslips").select("*").eq("disbursed", true), regionId),
          withRegion(supabase.from("expenses").select("*"), regionId),
          withRegion(
            supabase
              .from("advances")
              .select("amount, advance_date, payment_mode, cheque_id, employee_id"),
            regionId,
          ),
          withRegion(supabase.from("cheques").select("id, status, cleared_at"), regionId),
          supabase.from("clients").select("*").order("name"),
          supabase.from("employees").select("id, full_name"),
        ]);

        for (const r of [payRes, psRes, exRes, advRes, chqRes, cliRes, empRes]) {
          if (r.error) throw r.error;
        }
        if (cancelled) return;
        setInvoicePayments((payRes.data ?? []) as InvoicePayment[]);
        setPayslips((psRes.data ?? []) as Payslip[]);
        setExpenses((exRes.data ?? []) as Expense[]);
        setAdvances((advRes.data ?? []) as Advance[]);
        setCheques((chqRes.data ?? []) as Cheque[]);
        setClients((cliRes.data ?? []) as Client[]);
        setClientNames(new Map((cliRes.data ?? []).map((c: any) => [c.id, c.name])));
        setEmployeeNames(new Map((empRes.data ?? []).map((e: any) => [e.id, e.full_name])));
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? "Failed to load cashflow data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch when the global region selector changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId]);

  // Normalize every cash event to { effective date, amount, group, detail },
  // using the same cash-basis rules as before (cheque items only count once
  // their cheque clears). Unrealized items (uncleared cheques) are dropped.
  const allItems = useMemo(() => {
    const chequeById = new Map<string, Cheque>();
    for (const c of cheques) chequeById.set(c.id, c);
    const chequeClearedDay = (chequeId: string | null): string | null => {
      if (!chequeId) return null;
      const c = chequeById.get(chequeId);
      if (!c || c.status !== "cleared") return null;
      return isoDay(c.cleared_at);
    };
    const clientName = (id: string | null) => (id && clientNames.get(id)) || "Unassigned";
    const employeeName = (id: string | null) => (id && employeeNames.get(id)) || "Unknown employee";

    const revenue: CashItem[] = [];
    for (const p of invoicePayments) {
      const date = isoDay(p.payment_date);
      if (!date) continue;
      revenue.push({
        date,
        amount: Number(p.amount ?? 0),
        group: clientName(p.client_id),
        detail: clientName(p.client_id),
      });
    }

    const payroll: CashItem[] = [];
    for (const p of payslips) {
      const date =
        p.payment_mode === "Cheque"
          ? chequeClearedDay(p.cheque_id)
          : isoDay(p.disbursed_at ?? p.period_month);
      if (!date) continue;
      const name = employeeName(p.employee_id);
      payroll.push({
        date,
        amount: Number(p.net_salary ?? 0),
        group: name,
        detail: `${name} · ${monthLabel(monthKey(isoDay(p.period_month) ?? date))}`,
      });
    }

    const expensesItems: CashItem[] = [];
    for (const e of expenses) {
      let date: string | null = null;
      if (e.payment_mode === "Cash" || e.payment_mode === "Bank") {
        date = isoDay(e.expense_date);
      } else if (e.payment_mode === "Cheque") {
        date = chequeClearedDay(e.cheque_id);
      } else if (e.payment_mode === "Payable" && e.payable_status === "Paid") {
        date = isoDay(e.paid_at);
      }
      if (!date) continue;
      const cat = e.pl_category || "Uncategorized";
      expensesItems.push({
        date,
        amount: Number(e.amount ?? 0),
        group: cat,
        detail: e.description?.trim() || cat,
      });
    }

    const advancesItems: CashItem[] = [];
    for (const a of advances) {
      const date =
        a.payment_mode === "Cheque" ? chequeClearedDay(a.cheque_id) : isoDay(a.advance_date);
      if (!date) continue;
      const name = employeeName(a.employee_id);
      advancesItems.push({ date, amount: Number(a.amount ?? 0), group: name, detail: name });
    }

    return { revenue, payroll, expenses: expensesItems, advances: advancesItems };
  }, [invoicePayments, payslips, expenses, advances, cheques, clientNames, employeeNames]);

  // Payroll cash for the statement month, split across the clients each guard
  // actually worked for. Only this needs a round trip — revenue and expenses
  // are derived below from the rows already loaded above.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingStatements(true);
      const start = firstOfMonth(statementPeriod);
      const end = lastOfMonth(statementPeriod);
      const [payRes, loadedRes, loadedRevRes] = await Promise.all([
        supabase.rpc("payroll_cash_by_client", { p_start: start, p_end: end }),
        // Cash basis: the same apportionment the Financial Reports statement
        // uses on the revenue basis, asked of money that actually moved.
        supabase.rpc("client_statement_loaded", { p_start: start, p_end: end, p_basis: "cash" }),
        // Revenue basis, for the Regional Overhead column ONLY — it is an
        // invoiced-basis figure and must match Financial Reports exactly.
        supabase.rpc("client_statement_loaded", { p_start: start, p_end: end, p_basis: "revenue" }),
      ]);
      if (cancelled) return;
      const m = new Map<string, number>();
      for (const r of ((payRes.data ?? []) as { client_id: string; cost: number }[])) {
        m.set(r.client_id, Number(r.cost) || 0);
      }
      setPayrollCashByClient(m);
      setLoadedStatements((loadedRes.data ?? []) as LoadedStatement[]);
      const ro = new Map<string, number>();
      for (const r of ((loadedRevRes.data ?? []) as LoadedStatement[])) {
        ro.set(r.client_id, Number(r.regional_overhead) || 0);
      }
      setRevOverheadByClient(ro);
      setLoadingStatements(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [statementPeriod]);

  // One row per client for the statement month, entirely on a cash basis.
  //
  // Revenue and expenses reuse allItems — the very same normalized cash events
  // the tab beside this one totals — so a client statement can never claim cash
  // the cashflow chart does not show. allItems.expenses is grouped by P&L
  // category rather than client, though, so the expense side is re-derived here
  // from the raw rows using identical date rules.
  const cashStatementRows: CashStatementRow[] = useMemo(() => {
    const start = firstOfMonth(statementPeriod);
    const end = lastOfMonth(statementPeriod);
    const within = (d: string | null) => !!d && d >= start && d <= end;

    const chequeById = new Map<string, Cheque>();
    for (const c of cheques) chequeById.set(c.id, c);
    const chequeClearedDay = (chequeId: string | null): string | null => {
      if (!chequeId) return null;
      const c = chequeById.get(chequeId);
      if (!c || c.status !== "cleared") return null;
      return isoDay(c.cleared_at);
    };

    const receivedBy = new Map<string, number>();
    const paymentsBy = new Map<string, CashStatementRow["payments"]>();
    for (const p of invoicePayments) {
      const date = isoDay(p.payment_date);
      if (!within(date) || !p.client_id) continue;
      const amt = Number(p.amount ?? 0);
      receivedBy.set(p.client_id, (receivedBy.get(p.client_id) ?? 0) + amt);
      const arr = paymentsBy.get(p.client_id) ?? [];
      arr.push({ id: (p as any).id, date: date!, amount: amt, mode: (p as any).payment_mode ?? null });
      paymentsBy.set(p.client_id, arr);
    }

    const expensesBy = new Map<string, number>();
    for (const e of expenses) {
      if (!e.client_id) continue;
      let date: string | null = null;
      if (e.payment_mode === "Cash" || e.payment_mode === "Bank") date = isoDay(e.expense_date);
      else if (e.payment_mode === "Cheque") date = chequeClearedDay(e.cheque_id);
      else if (e.payment_mode === "Payable" && e.payable_status === "Paid") date = isoDay(e.paid_at);
      if (!within(date)) continue;
      expensesBy.set(e.client_id, (expensesBy.get(e.client_id) ?? 0) + Number(e.amount ?? 0));
    }

    // The money columns come from client_statement_loaded so the apportionment
    // matches the revenue-basis statement and the partner allocation exactly.
    // The payments list stays local: it is the detail behind the received
    // figure, drawn from the very rows this page already holds.
    const byId = new Map(loadedStatements.map((r) => [r.client_id, r]));
    return clients.map((c) => {
      const l = byId.get(c.id);
      return {
        client: c,
        received: Number(l?.revenue ?? receivedBy.get(c.id) ?? 0),
        payrollPaid: Number(l?.direct_payroll ?? payrollCashByClient.get(c.id) ?? 0),
        expensesPaid: Number(l?.direct_expenses ?? expensesBy.get(c.id) ?? 0),
        // Invoiced-basis (revenue) overhead so it equals the Financial Reports
        // column exactly; the cash-basis net below is unchanged.
        regionalOverhead: revOverheadByClient.get(c.id) ?? 0,
        hoShare: Number(l?.ho_share ?? 0),
        netCash: Number(l?.net ?? 0),
        branchId: l?.branch_id ?? c.branch_id ?? null,
        regionName: l?.region_name ?? "Unassigned",
        payments: (paymentsBy.get(c.id) ?? []).sort((a, b) => b.date.localeCompare(a.date)),
      };
    });
  }, [clients, invoicePayments, expenses, cheques, payrollCashByClient, loadedStatements, revOverheadByClient, statementPeriod]);

  const statementTotals = useMemo(() => {
    let received = 0, payroll = 0, exp = 0, regional = 0, ho = 0, net = 0;
    for (const r of cashStatementRows) {
      received += r.received;
      payroll += r.payrollPaid;
      exp += r.expensesPaid;
      regional += r.regionalOverhead;
      ho += r.hoShare;
      net += r.netCash;
    }
    return { received, payroll, expenses: exp, regional, ho, net };
  }, [cashStatementRows]);

  // Apply the period filter to a list.
  const inPeriod = useMemo(() => {
    return (date: string): boolean => {
      if (mode === "all") return true;
      if (mode === "month") return monthKey(date) === selMonth;
      // range (inclusive); missing bounds are treated as open-ended.
      if (fromDate && date < fromDate) return false;
      if (toDate && date > toDate) return false;
      return true;
    };
  }, [mode, selMonth, fromDate, toDate]);

  const filtered = useMemo(
    () => ({
      revenue: allItems.revenue.filter((i) => inPeriod(i.date)),
      payroll: allItems.payroll.filter((i) => inPeriod(i.date)),
      expenses: allItems.expenses.filter((i) => inPeriod(i.date)),
      advances: allItems.advances.filter((i) => inPeriod(i.date)),
    }),
    [allItems, inPeriod],
  );

  const sum = (items: CashItem[]) => items.reduce((s, i) => s + i.amount, 0);
  const totals = useMemo(() => {
    const revenue = sum(filtered.revenue);
    const payroll = sum(filtered.payroll);
    const exp = sum(filtered.expenses);
    const adv = sum(filtered.advances);
    return { revenue, payroll, expenses: exp, advances: adv, net: revenue - payroll - exp - adv };
  }, [filtered]);

  // Aggregation for charts + table. In single-month mode, group by day; otherwise by month.
  const rows: MonthRow[] = useMemo(() => {
    const isDaily = mode === "month";
    const map = new Map<string, MonthRow>();
    const bump = (date: string, field: keyof Omit<MonthRow, "key" | "label" | "net">, amt: number) => {
      const key = isDaily ? date : monthKey(date);
      const label = isDaily ? String(Number(date.slice(8, 10))) : monthLabel(key);
      let r = map.get(key);
      if (!r) {
        r = { key, label, revenue: 0, expenses: 0, payroll: 0, advances: 0, net: 0 };
        map.set(key, r);
      }
      r[field] += amt;
    };
    filtered.revenue.forEach((i) => bump(i.date, "revenue", i.amount));
    filtered.payroll.forEach((i) => bump(i.date, "payroll", i.amount));
    filtered.expenses.forEach((i) => bump(i.date, "expenses", i.amount));
    filtered.advances.forEach((i) => bump(i.date, "advances", i.amount));
    const arr = Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
    for (const r of arr) r.net = r.revenue - r.payroll - r.expenses - r.advances;
    return arr;
  }, [filtered, mode]);

  // Grouped breakdown for the currently-open card.
  const breakdown = useMemo(() => {
    if (!openMetric) return [];
    const items = filtered[openMetric];
    const groups = new Map<string, { total: number; items: CashItem[] }>();
    for (const it of items) {
      let g = groups.get(it.group);
      if (!g) {
        g = { total: 0, items: [] };
        groups.set(it.group, g);
      }
      g.total += it.amount;
      g.items.push(it);
    }
    return Array.from(groups.entries())
      .map(([name, g]) => ({
        name,
        total: g.total,
        items: g.items.slice().sort((a, b) => b.date.localeCompare(a.date)),
      }))
      .sort((a, b) => b.total - a.total);
  }, [openMetric, filtered]);

  const periodLabel =
    mode === "all"
      ? "All time"
      : mode === "month"
      ? monthLabel(selMonth)
      : `${fromDate || "start"} → ${toDate || "now"}`;

  const toggleMetric = (m: MetricKey) => {
    setOpenGroups(new Set());
    setOpenMetric((prev) => (prev === m ? null : m));
  };
  const toggleGroup = (name: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  const METRICS: { key: MetricKey; label: string }[] = [
    { key: "revenue", label: "Revenue" },
    { key: "payroll", label: "Payroll" },
    { key: "expenses", label: "Expenses" },
    { key: "advances", label: "Advances" },
  ];

  // Extracted so it can live either in the page Header (standalone) or in a
  // small toolbar (when embedded as a tab inside Financial Reports).
  const exportBtn = activeTab === "clients" ? (
    <ExportButton
      onExport={() =>
        exportClientStatements(
          cashStatementRows.map((r) => ({
            client: `${r.client.name} (${r.client.client_code})`,
            totalReceivable: r.received,
            payrollExpenses: r.payrollPaid,
            // Direct plus both apportioned layers, so the exported
            // columns still add up to netIncome.
            otherExpenses: r.expensesPaid + r.regionalOverhead + r.hoShare,
            netIncome: r.netCash,
          })),
          formatPeriod(statementPeriod),
          `Client Statement (Cash) ${formatPeriod(statementPeriod)}.xlsx`,
        )
      }
    />
  ) : null;

  return (
    <>
      {!embedded && (
        <Header
          title="Cash Flow"
          subtitle="Cash inflow vs outflow — filter by month, range or all time"
          actions={exportBtn}
        />
      )}

      {/* Embedded in Financial Reports: same white-card + bordered tab-header
          frame as that page's tabs, so the two top tabs read as one report. */}
      <div className={embedded ? "bg-white rounded-lg border border-slate-200" : "flex-1 overflow-y-auto px-3 py-4 md:p-8"}>
        {error && (
          <div className={`${embedded ? "m-4 md:m-6 mb-0" : "mb-4"} p-3 rounded-md border border-danger-200 bg-danger-50 text-danger-700 text-sm`}>
            {error}
          </div>
        )}

        <div className={embedded ? "p-4 md:p-6 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3" : "flex items-center gap-2 mb-6"}>
          <div className="flex items-center gap-2">
            {([
              { key: "cashflow", label: "Cash Flow" },
              { key: "clients", label: "Client Statements" },
            ] as const).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={`px-4 py-2 rounded-md text-sm whitespace-nowrap transition-colors ${
                  activeTab === t.key
                    ? "bg-brand-600 text-[#fff]"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {embedded && exportBtn}
        </div>

        <div className={embedded ? "p-4 md:p-6" : ""}>
        {activeTab === "clients" && (
          <ClientStatementsTab
            rows={cashStatementRows}
            totals={statementTotals}
            period={statementPeriod}
            periodOptions={statementPeriodOptions}
            onPeriodChange={setStatementPeriod}
            loading={loading || loadingStatements}
            onView={setSelectedStatement}
            bare={embedded}
          />
        )}

        {activeTab === "cashflow" && (
        <>
        {/* Period filter */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-6 flex flex-wrap items-center gap-3">
          <div className="flex gap-1 bg-slate-100 rounded-md p-1">
            {(["month", "range", "all"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 text-sm rounded capitalize transition-colors ${
                  mode === m ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {m === "all" ? "All time" : m === "month" ? "Month" : "Date range"}
              </button>
            ))}
          </div>

          {mode === "month" && (
            <input
              type="month"
              value={selMonth}
              onChange={(e) => setSelMonth(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          )}
          {mode === "range" && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
              />
              <span className="text-slate-400 text-sm">to</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600"
              />
            </div>
          )}

          <span className="text-xs text-slate-500 ml-auto">
            Showing: <span className="text-slate-700">{periodLabel}</span>
          </span>
        </div>

        {/* Cash Flow Statement — same layout as the Profit & Loss statement */}
        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-6 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg text-slate-900 mb-1">Cash Flow Statement</h3>
              <p className="text-sm text-slate-500">
                For {periodLabel} · cash-basis: revenue = received, payroll = disbursed, expenses = paid.
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => window.print()}>
              Download Report (PDF)
            </Button>
          </div>
          <div className="p-6">
            {loading ? (
              <div className="py-12 text-center text-slate-500 text-sm">Loading…</div>
            ) : (
              <div className="space-y-6">
                {/* Cash Inflows */}
                <div>
                  <h4 className="text-sm text-slate-900 mb-3 pb-2 border-b border-slate-200">Cash Inflows</h4>
                  <div className="space-y-2 mb-3">
                    <div className="flex justify-between items-center pl-4">
                      <span className="text-sm text-slate-600">Payments Received</span>
                      <span className="text-sm text-success-600">{currency(totals.revenue)}</span>
                    </div>
                  </div>
                  <div className="flex justify-between items-center pl-4 pt-2 border-t border-slate-200">
                    <span className="text-sm text-slate-900">Total Cash Inflows</span>
                    <span className="text-sm text-success-600">{currency(totals.revenue)}</span>
                  </div>
                </div>

                {/* Cash Outflows */}
                <div>
                  <h4 className="text-sm text-slate-900 mb-3 pb-2 border-b border-slate-200">Cash Outflows</h4>
                  <div className="space-y-2 mb-3">
                    {[
                      { name: "Payroll Paid (disbursed net salaries)", amount: totals.payroll },
                      { name: "Expenses Paid (Cash/Bank + paid payables)", amount: totals.expenses },
                      { name: "Advances", amount: totals.advances },
                    ].map((item) => (
                      <div key={item.name} className="flex justify-between items-center pl-4">
                        <span className="text-sm text-slate-600">{item.name}</span>
                        <span className="text-sm text-danger-600">{currency(item.amount)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between items-center pl-4 pt-2 border-t border-slate-200">
                    <span className="text-sm text-slate-900">Total Cash Outflows</span>
                    <span className="text-sm text-danger-600">
                      {currency(totals.payroll + totals.expenses + totals.advances)}
                    </span>
                  </div>
                </div>

                {/* Net Cash Flow */}
                <div className="pt-4 border-t-2 border-slate-300">
                  <div className="flex justify-between items-center">
                    <span className="text-base text-slate-900">Net Cash Flow</span>
                    <span className={`text-lg ${totals.net >= 0 ? "text-success-600" : "text-danger-600"}`}>
                      {currency(totals.net)}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>


        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <h3 className="text-base text-slate-900">{mode === "month" ? "Daily" : "Monthly"} Breakdown · {periodLabel}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                  <th className="px-6 py-3 text-left">{mode === "month" ? "Day" : "Month"}</th>
                  <th className="px-6 py-3 text-right">Revenue</th>
                  <th className="px-6 py-3 text-right">Payroll</th>
                  <th className="px-6 py-3 text-right">Expenses</th>
                  <th className="px-6 py-3 text-right">Advances</th>
                  <th className="px-6 py-3 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-6 py-3 text-slate-900">{r.label}</td>
                    <td className="px-6 py-3 text-right text-success-600">{currency(r.revenue)}</td>
                    <td className="px-6 py-3 text-right text-slate-700">{currency(r.payroll)}</td>
                    <td className="px-6 py-3 text-right text-danger-600">{currency(r.expenses)}</td>
                    <td className="px-6 py-3 text-right text-warning-600">{currency(r.advances)}</td>
                    <td
                      className={`px-6 py-3 text-right ${
                        r.net >= 0 ? "text-success-600" : "text-danger-600"
                      }`}
                    >
                      {currency(r.net)}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && !loading && (
                  <tr>
                    <td colSpan={6} className="px-6 py-6 text-center text-slate-500">
                      No data available.
                    </td>
                  </tr>
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50 text-slate-900">
                    <td className="px-6 py-3">Total</td>
                    <td className="px-6 py-3 text-right">{currency(totals.revenue)}</td>
                    <td className="px-6 py-3 text-right">{currency(totals.payroll)}</td>
                    <td className="px-6 py-3 text-right">{currency(totals.expenses)}</td>
                    <td className="px-6 py-3 text-right">{currency(totals.advances)}</td>
                    <td className="px-6 py-3 text-right">{currency(totals.net)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
        </>
        )}
        </div>
      </div>

      <Modal
        isOpen={!!selectedStatement}
        onClose={() => setSelectedStatement(null)}
        title="Full Client Statement (Cash Basis)"
        size="lg"
      >
        {selectedStatement && (
          <div className="space-y-4">
            <div className="pb-4 border-b border-slate-200">
              <h3 className="text-base text-slate-900">{selectedStatement.client.name}</h3>
              <p className="text-xs text-slate-500 font-mono">{selectedStatement.client.client_code}</p>
              <p className="text-xs text-slate-500 mt-1">Month: {formatPeriod(statementPeriod)}</p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-brand-500">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Cash Received</p>
                <p className="text-lg text-brand-900">{currency(selectedStatement.received)}</p>
              </div>
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-danger-500">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Payroll Paid</p>
                <p className="text-lg text-danger-900">{currency(selectedStatement.payrollPaid)}</p>
              </div>
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-danger-500">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Direct Expenses</p>
                <p className="text-lg text-danger-900">{currency(selectedStatement.expensesPaid)}</p>
              </div>
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-slate-400">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Regional Overhead</p>
                <p className="text-lg text-slate-700">{currency(selectedStatement.regionalOverhead)}</p>
              </div>
              <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-slate-400">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Head Office</p>
                <p className="text-lg text-slate-700">{currency(selectedStatement.hoShare)}</p>
              </div>
              <div
                className={`p-3 rounded-lg border ${
                  selectedStatement.netCash >= 0
                    ? "bg-success-50 border-success-200"
                    : "bg-danger-50 border-danger-200"
                }`}
              >
                <p className={`text-xs mb-1 ${selectedStatement.netCash >= 0 ? "text-success-700" : "text-danger-700"}`}>
                  Net Cash
                </p>
                <p className={`text-lg ${selectedStatement.netCash >= 0 ? "text-success-900" : "text-danger-900"}`}>
                  {currency(selectedStatement.netCash)}
                </p>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200">
              <h4 className="text-sm text-slate-900 mb-3">Payments Received</h4>
              {selectedStatement.payments.length === 0 ? (
                <p className="text-sm text-slate-500">No payments received from this client in {formatPeriod(statementPeriod)}.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="text-left px-3 py-2 text-xs text-slate-500">Date</th>
                        <th className="text-left px-3 py-2 text-xs text-slate-500">Mode</th>
                        <th className="text-right px-3 py-2 text-xs text-slate-500">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedStatement.payments.map((p) => (
                        <tr key={p.id}>
                          <td className="px-3 py-2 text-xs text-slate-600">{formatDate(p.date)}</td>
                          <td className="px-3 py-2 text-xs text-slate-600">{p.mode ?? "—"}</td>
                          <td className="px-3 py-2 text-xs text-right text-success-600">{currency(p.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
              <Button variant="primary" size="md" className="flex-1" onClick={() => window.print()}>
                <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Print / Save PDF
              </Button>
              <Button variant="secondary" size="md" onClick={() => setSelectedStatement(null)}>
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

/**
 * The cash-basis Client Statements table. Deliberately the same layout as the
 * revenue-basis one in Financial Reports — same four cards, same columns, same
 * "View Full Statement" — so the two read as one report shown on two bases.
 * Only the labels change, because only the basis changed.
 */
function ClientStatementsTab({
  rows, totals, period, periodOptions, onPeriodChange, loading, onView, bare = false,
}: {
  rows: CashStatementRow[];
  totals: { received: number; payroll: number; expenses: number; regional: number; ho: number; net: number };
  period: string;
  periodOptions: string[];
  onPeriodChange: (p: string) => void;
  loading: boolean;
  onView: (r: CashStatementRow) => void;
  bare?: boolean;
}) {
  return (
    <div className={bare ? "" : "bg-white rounded-lg border border-slate-200"}>
      <div className={`${bare ? "pb-6" : "p-6"} flex flex-wrap items-end justify-between gap-3`}>
        <div>
          <h3 className="text-lg text-slate-900 mb-1">Client Statements — Cash Basis</h3>
          <p className="text-sm text-slate-500">
            For {formatPeriod(period)} ({firstOfMonth(period)} – {lastOfMonth(period)})
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-sm text-slate-600">Month:</label>
          <ThemedSelect
            value={period}
            onChange={(e) => onPeriodChange(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            {periodOptions.map((p) => (
              <option key={p} value={p}>{formatPeriod(p)}</option>
            ))}
          </ThemedSelect>
        </div>
        <span className="text-xs text-slate-500">
          Net Cash = Received − (Payroll + Direct Expenses + Regional Overhead + Head Office).
          Overhead is apportioned pro-rata by cash received.
        </span>
      </div>

      <div className="p-4 grid grid-cols-2 md:grid-cols-6 gap-3 border-b border-slate-200">
        <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-brand-500">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Cash Received</p>
          <p className="text-lg text-brand-900">{currency(totals.received)}</p>
        </div>
        <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-danger-500">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Payroll Paid</p>
          <p className="text-lg text-danger-900">{currency(totals.payroll)}</p>
        </div>
        <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-danger-500">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Direct Expenses</p>
          <p className="text-lg text-danger-900">{currency(totals.expenses)}</p>
        </div>
        <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-slate-400">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Regional Overhead</p>
          <p className="text-lg text-slate-700">{currency(totals.regional)}</p>
        </div>
        <div className="bg-white p-3 rounded-lg border border-slate-200 border-l-4 border-l-slate-400">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Head Office</p>
          <p className="text-lg text-slate-700">{currency(totals.ho)}</p>
        </div>
        <div
          className={`p-3 rounded-lg border ${
            totals.net >= 0 ? "bg-success-50 border-success-200" : "bg-danger-50 border-danger-200"
          }`}
        >
          <p className={`text-xs mb-1 ${totals.net >= 0 ? "text-success-700" : "text-danger-700"}`}>Net Cash</p>
          <p className={`text-lg ${totals.net >= 0 ? "text-success-900" : "text-danger-900"}`}>
            {currency(totals.net)}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="text-left px-6 py-3 text-sm text-slate-500">Client</th>
              <th className="text-right px-6 py-3 text-sm text-slate-500">Cash Received</th>
              <th className="text-right px-6 py-3 text-sm text-slate-500">Payroll Paid</th>
              <th className="text-right px-6 py-3 text-sm text-slate-500">Direct Expenses</th>
              <th className="text-right px-6 py-3 text-sm text-slate-500">Regional Overhead</th>
              <th className="text-right px-6 py-3 text-sm text-slate-500">Net Cash</th>
              <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {loading && (
              <tr>
                <td colSpan={7} className="px-6 py-10 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">
                  No clients yet.
                </td>
              </tr>
            )}
            {!loading && rows.map((r) => (
              <tr key={r.client.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-6 py-4 text-sm text-slate-900">
                  <div>{r.client.name}</div>
                  <div className="text-xs text-slate-500 font-mono">{r.client.client_code}</div>
                </td>
                <td className="px-6 py-4 text-sm text-brand-600 text-right">{currency(r.received)}</td>
                <td className="px-6 py-4 text-sm text-danger-600 text-right">{currency(r.payrollPaid)}</td>
                <td className="px-6 py-4 text-sm text-danger-600 text-right">{currency(r.expensesPaid)}</td>
                <td className="px-6 py-4 text-sm text-slate-500 text-right">{currency(r.regionalOverhead)}</td>
                <td className="px-6 py-4 text-sm text-right">
                  <span className={r.netCash >= 0 ? "text-success-600" : "text-danger-600"}>
                    {currency(r.netCash)}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <button
                    className="text-sm text-brand-600 hover:text-brand-700"
                    onClick={() => onView(r)}
                  >
                    View Full Statement
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  icon,
  accent,
  subtitle,
  active,
  onClick,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent: "emerald" | "rose" | "slate";
  subtitle?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const accentBg =
    accent === "emerald" ? "bg-success-50" : accent === "rose" ? "bg-danger-50" : "bg-slate-100";
  const valueText =
    accent === "emerald"
      ? "text-success-700"
      : accent === "rose"
      ? "text-danger-700"
      : "text-slate-900";
  const borderL =
    accent === "emerald"
      ? "border-l-success-500"
      : accent === "rose"
      ? "border-l-danger-500"
      : "border-l-slate-400";
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`text-left w-full bg-white rounded-lg border border-slate-200 border-l-4 ${borderL} p-4 transition-shadow ${
        clickable ? "hover:shadow-sm cursor-pointer" : "cursor-default"
      } ${active ? "ring-2 ring-brand-200" : ""}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
          <div className={`text-lg mt-1 ${valueText}`}>{value}</div>
          {subtitle && <div className="text-xs text-slate-400 mt-1">{subtitle}</div>}
          {clickable && (
            <div className="text-[11px] text-brand-600 mt-1">{active ? "Hide breakdown" : "View breakdown"}</div>
          )}
        </div>
        <div className={`p-2 rounded-md ${accentBg}`}>{icon}</div>
      </div>
    </button>
  );
}
