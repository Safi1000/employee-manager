import { useEffect, useState } from "react";
import { effectiveContractLinesValue, fetchAllRows, supabase, type ContractAddendum, type ContractLine } from "../../../lib/supabase";
import { withRegion } from "../../../lib/region";
import { GROUPS, KNOWN } from "../accountant/AccountsGrid";

/**
 * The figures the command dashboard adds on top of the classic set. Every one
 * is READ from a table or a database function that already owns its
 * definition — nothing here invents a rule:
 *
 *   on strength    attendance_records on the latest marked day, present,
 *                  double duty or on leave, grouped by the client worked for.
 *                  A guard on leave still fills a contracted head (DECIDED
 *                  2026-10-21: "60 present, 10 on leave — that is the exact
 *                  number contracted"); only absent leaves a post short.
 *   contracted     client_cover() for the month (committed heads on active
 *                  guard-deployment contracts)
 *   billing        invoices by SERVICE month (service_month, falling back to
 *                  invoice_date), the basis revenue is recognised on (A4).
 *                  The month being billed is last month; a client with a live
 *                  contract and no invoice for it is "not billed" (2026-10-21:
 *                  by invoice_date, September's invoices raised in October
 *                  read as October's and every client looked un-invoiced).
 *   receivables    invoices.outstanding > 0, aged by invoice_date
 *   client map     client_statement_loaded(), revenue basis, last full month —
 *                  the same client P&L Financial Reports and partners read
 *
 * Each block fails on its own: a user without reports access still gets the
 * post board, and a missing function hides one panel instead of the page.
 */

export type SiteTile = { clientId: string; name: string; regionId: string | null; region: string; contracted: number; onPost: number; present: number; onLeave: number; absent: number; marked: number };
export type AgeRow = { clientId: string; name: string; regionId: string | null; buckets: [number, number, number, number] };
export type ClientDot = { clientId: string; name: string; regionId: string | null; region: string; revenue: number; net: number; guards: number };
export type RegionCard = { regionId: string; name: string; revenue: number; net: number; trend: number[]; charged: boolean | null };

export type CommandData = {
  /** Relievers on the books with no attendance row on the latest marked day — free to send. */
  freeRelievers: { id: string; name: string; regionId: string | null }[] | null;
  asOf: string | null;
  sites: SiteTile[] | null;
  /** Every bank and cash account this month, from the ledger: opening, each
   *  kind of movement (Accountant grid grouping), closing. Null without access. */
  cashMonth: { opening: number; closing: number; flows: { key: string; label: string; v: number }[] } | null;
  /** Last month's payroll in full (net of every payslip, paid or not) — what the next run needs. */
  payrollLastFull: number | null;
  /** Last month's payroll: payslips and money, paid against the whole. */
  payrollLast: { slips: number; paidSlips: number; net: number; paid: number } | null;
  /** Workforce: active now, joined and left this month. */
  workforce: { active: number; joined: number; left: number } | null;
  /** Salary actually paid out this month (disbursements dated this month). */
  salariesPaidMtd: number | null;
  /** First day of the service month being billed now (last month). */
  billMonth: string;
  /** Invoiced for that service month, and for the month before it. */
  billed: number | null;
  billedPrev: number | null;
  /** Already invoiced for the running month (billed in advance). */
  billedAhead: number | null;
  /** Clients with a live contract this month, and how many have their invoice. */
  expectedClients: number | null;
  billedClients: number | null;
  /** The billing month's contract value at line rates (the Contracts screens'
   *  own effectiveContractLinesValue), and clients billed more than 10% off it. */
  contractValue: number | null;
  offContract: { clientId: string; name: string; value: number; billed: number }[] | null;
  /** Live-contract clients with no invoice for the billing month, by contracted heads. */
  notBilled: { clientId: string; name: string; heads: number }[] | null;
  receiptsMtd: number | null;
  receivables: { total: number; buckets: [number, number, number, number]; byClient: AgeRow[] } | null;
  cashInHand: number | null;
  expensesPaidMtd: number | null;
  clientMap: { month: string; rows: ClientDot[] } | null;
  regions: RegionCard[] | null;
};

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Counted against the contract: on duty, or away on leave in the roster.
const ON_POST = ["present", "double_duty", "leave"];

/** What this user may see (Dashboard.tsx `can`). A figure the user has no
 *  permission for is not fetched at all — not merely hidden (2026-10-21). */
export type DashPerms = {
  reports: boolean; accounting: boolean; payroll: boolean; employees: boolean; expenses: boolean;
  attendance: boolean; roster: boolean; contracts: boolean; invoices: boolean; receivables: boolean;
};

export function useCommandData(companyId: string | null | undefined, regionId: string | null, can: DashPerms) {
  const canReports = can.reports;
  const seesPosts = can.attendance || can.roster;
  const seesBilling = can.invoices || can.reports;
  const skip = Promise.resolve(null);
  const [data, setData] = useState<CommandData | null>(null);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void (async () => {
      const now = new Date();
      const mStart = iso(new Date(now.getFullYear(), now.getMonth(), 1));
      const today = iso(now);
      const pStart = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      const pEnd = iso(new Date(now.getFullYear(), now.getMonth(), 0));
      const pToDate = iso(new Date(now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth(), 0).getDate())));
      const trendStart = iso(new Date(now.getFullYear(), now.getMonth() - 6, 1));
      const ppStart = trendStart < iso(new Date(now.getFullYear(), now.getMonth() - 2, 1)) ? trendStart : iso(new Date(now.getFullYear(), now.getMonth() - 2, 1));
      const ppEnd = iso(new Date(now.getFullYear(), now.getMonth() - 1, 0));

      const [branchesRes, clientsRes, lastDayRes] = await Promise.all([
        supabase.from("branches").select("id, name, is_head_office").eq("company_id", companyId),
        supabase.from("clients").select("id, name, branch_id, is_internal").eq("company_id", companyId),
        withRegion(supabase.from("attendance_records").select("attendance_date").lte("attendance_date", today).order("attendance_date", { ascending: false }).limit(1), regionId),
      ]);
      const branchName = new Map<string, string>();
      for (const b of (branchesRes.data ?? []) as { id: string; name: string }[]) branchName.set(b.id, b.name);
      const clientInfo = new Map<string, { name: string; branch: string | null }>();
      for (const c of (clientsRes.data ?? []) as { id: string; name: string; branch_id: string | null; is_internal: boolean | null }[]) {
        if (!c.is_internal) clientInfo.set(c.id, { name: c.name, branch: c.branch_id });
      }
      const regionOf = (id: string | null) => (id ? branchName.get(id) ?? "Unassigned" : "Unassigned");
      const inScope = (branch: string | null) => !regionId || branch === regionId;
      const asOf = ((lastDayRes.data ?? []) as { attendance_date: string }[])[0]?.attendance_date ?? null;

      const tasks = await Promise.allSettled([
        // 0 — on post, latest marked day
        asOf && seesPosts
          ? fetchAllRows<{ worked_for_client_id: string | null; status: string }>(() =>
              withRegion(
                supabase.from("attendance_records").select("worked_for_client_id, status").eq("attendance_date", asOf),
                regionId,
              ) as never,
            )
          : Promise.resolve([] as { worked_for_client_id: string | null; status: string }[]),
        // 1 — contracted heads this month
        seesPosts || can.contracts || seesBilling ? supabase.rpc("client_cover", { p_company_id: companyId, p_month: mStart }) : skip,
        // 2 — invoices raised, this month and last
        !seesBilling ? skip : fetchAllRows<{ client_id: string; invoice_amount: number; invoice_date: string; service_month: string | null; branch_id: string | null }>(() =>
          withRegion(supabase.from("invoices").select("client_id, invoice_amount, invoice_date, service_month, branch_id").or(`service_month.gte.${ppStart},invoice_date.gte.${ppStart}`), regionId) as never,
        ),
        // 3 — receipts this month
        !can.receivables ? skip : fetchAllRows<{ amount: number }>(() =>
          withRegion(supabase.from("invoice_payments").select("amount").gte("payment_date", mStart).lte("payment_date", today), regionId) as never,
        ),
        // 4 — open invoices for ageing
        !can.receivables ? skip : fetchAllRows<{ client_id: string; invoice_date: string; outstanding: number }>(() =>
          withRegion(supabase.from("invoices").select("client_id, invoice_date, outstanding").gt("outstanding", 0), regionId) as never,
        ),
        // 5 — cash held by custodians
        can.accounting ? supabase.rpc("cash_in_hand", { p_company_id: companyId }) : skip,
        // 6 — expenses this month
        !can.expenses ? skip : fetchAllRows<{ amount: number }>(() =>
          withRegion(supabase.from("expenses").select("amount").gte("expense_date", mStart).lte("expense_date", today), regionId) as never,
        ),
        // 7 — client statement, last full month (reports access only)
        canReports
          ? supabase.rpc("client_statement_loaded", { p_start: pStart, p_end: pEnd, p_basis: "revenue", p_company_id: companyId })
          : Promise.resolve({ data: null, error: null }),
        // 8 — which regions are charged head office
        canReports ? supabase.rpc("ho_region_modes", { p_company_id: companyId, p_month: pStart }) : Promise.resolve({ data: null, error: null }),
        // 9 — contracted heads in the month being billed: a contract that
        // starts this month owes no invoice for last month (Regent 1, 2026-10-21).
        seesBilling ? supabase.rpc("client_cover", { p_company_id: companyId, p_month: pStart }) : skip,
        // 10 — when each client's live contract began; client_cover counts a
        // contract that is active now even for a month before it started.
        seesBilling ? supabase.from("contracts").select("client_id, start_date").eq("status", "active").eq("contract_type", "guard_deployment") : skip,
        // 11 — the month on every bank and cash account, from the ledger
        // Bank and cash balances: banking access only (not merely reports).
        can.accounting
          ? (async () => {
              const { data: locs } = await supabase.from("cash_locations").select("id, coa_account_id").eq("company_id", companyId).eq("is_active", true);
              const accts = ((locs ?? []) as { coa_account_id: string | null }[]).map((l) => l.coa_account_id).filter(Boolean) as string[];
              const res = await Promise.all(accts.map((a) => supabase.rpc("ledger_statement", { p_company_id: companyId, p_kind: "account", p_subject_id: a, p_start: mStart, p_end: today })));
              const failed = res.find((r) => r.error);
              if (failed?.error) throw failed.error;
              return res.map((r) => (r.data ?? []) as { row_kind: string; source_table: string | null; debit: number | null; credit: number | null; balance: number | null }[]);
            })()
          : Promise.resolve(null),
        // 12 — last month's payslips in full, and salary disbursed this month
        !can.payroll ? skip : fetchAllRows<{ net_salary: number; amount_paid: number | null; disbursed: boolean | null }>(() =>
          withRegion(supabase.from("payslips").select("net_salary, amount_paid, disbursed").eq("period_month", pStart), regionId) as never,
        ),
        !can.payroll ? skip : fetchAllRows<{ amount_paid: number }>(() =>
          withRegion(supabase.from("payslips").select("amount_paid").gte("disbursed_at", mStart).lte("disbursed_at", `${today}T23:59:59`), regionId) as never,
        ),
        // 14 — the workforce: who is on the books, who joined and left this month
        !can.employees ? skip : fetchAllRows<{ lifecycle_state: string | null; join_date: string | null; last_working_day: string | null }>(() =>
          withRegion(supabase.from("employees").select("lifecycle_state, join_date, last_working_day").eq("company_id", companyId), regionId) as never,
        ),
        // 15 — contract lines and addendums for the billing month's contract value
        seesBilling
          ? Promise.all([
              supabase.from("contracts").select("id, client_id, start_date").eq("status", "active").eq("contract_type", "guard_deployment"),
              supabase.from("contract_lines").select("*"),
              supabase.from("contract_addendums").select("*"),
            ]).then(([k, l, a]) => ({ data: { contracts: (k.data ?? []) as { id: string; client_id: string; start_date: string | null }[], lines: (l.data ?? []) as ContractLine[], adds: (a.data ?? []) as ContractAddendum[] }, error: k.error ?? l.error ?? a.error }))
          : skip,
        // 16 — relievers, and who among them is marked on the latest day
        seesPosts && asOf
          ? Promise.all([
              withRegion(supabase.from("employees").select("id, full_name, branch_id, lifecycle_state").eq("company_id", companyId).eq("category", "reliever"), regionId),
              withRegion(supabase.from("attendance_records").select("employee_id").eq("attendance_date", asOf), regionId),
            ]).then(([e, a]) => ({ data: { emps: (e.data ?? []) as { id: string; full_name: string; branch_id: string | null; lifecycle_state: string | null }[], marked: new Set(((a.data ?? []) as { employee_id: string }[]).map((r) => r.employee_id)) }, error: e.error ?? a.error }))
          : skip,
      ]);
      if (cancelled) return;
      const ok = <T,>(i: number): T | null => {
        const r = tasks[i];
        if (r.status !== "fulfilled") return null;
        const v = r.value as { data?: unknown; error?: unknown } | unknown[];
        if (v == null) return null;
        if (Array.isArray(v)) return v as T;
        if (v && typeof v === "object" && "error" in v && v.error) return null;
        return ((v as { data?: unknown }).data ?? null) as T | null;
      };

      // Post board
      // A client with no rows at all on the day is NOT MARKED, which is a
      // different fact from marked-and-short: the board must not report an
      // unmarked register as an uncovered site.
      const dayRows = ok<{ worked_for_client_id: string | null; status: string }[]>(0) ?? [];
      const onPost = new Map<string, number>();
      const marked = new Map<string, number>();
      const presentBy = new Map<string, number>(), leaveBy = new Map<string, number>(), absentBy = new Map<string, number>();
      for (const r of dayRows) {
        if (!r.worked_for_client_id) continue;
        marked.set(r.worked_for_client_id, (marked.get(r.worked_for_client_id) ?? 0) + 1);
        if (ON_POST.includes(r.status)) onPost.set(r.worked_for_client_id, (onPost.get(r.worked_for_client_id) ?? 0) + 1);
        const bucket = r.status === "leave" ? leaveBy : r.status === "absent" ? absentBy : r.status === "present" || r.status === "double_duty" ? presentBy : null;
        if (bucket) bucket.set(r.worked_for_client_id, (bucket.get(r.worked_for_client_id) ?? 0) + 1);
      }
      const cover = ok<{ client_id: string; client_name: string; contracted: number }[]>(1);
      let sites: SiteTile[] | null = null;
      if (cover) {
        const ids = new Set<string>([...cover.filter((c) => Number(c.contracted) > 0).map((c) => c.client_id), ...onPost.keys()]);
        sites = [...ids]
          .map((id) => {
            const info = clientInfo.get(id);
            const cv = cover.find((c) => c.client_id === id);
            return info ? { clientId: id, name: info.name ?? cv?.client_name ?? "Client", regionId: info.branch, region: regionOf(info.branch), contracted: Number(cv?.contracted ?? 0), onPost: onPost.get(id) ?? 0, present: presentBy.get(id) ?? 0, onLeave: leaveBy.get(id) ?? 0, absent: absentBy.get(id) ?? 0, marked: marked.get(id) ?? 0 } : null;
          })
          .filter((x): x is SiteTile => !!x && inScope(x.regionId))
          .sort((a, b) => a.region.localeCompare(b.region) || b.contracted - a.contracted);
      }

      // Billing, by service month
      const inv = ok<{ client_id: string; invoice_amount: number; invoice_date: string; service_month: string | null; branch_id: string | null }[]>(2);
      const svc = (r: { service_month: string | null; invoice_date: string }) => (r.service_month ?? r.invoice_date).slice(0, 10);
      const sumSvc = (from: string, to: string) => (inv ?? []).filter((r) => svc(r) >= from && svc(r) <= to).reduce((n, r) => n + Number(r.invoice_amount ?? 0), 0);
      let notBilled: CommandData["notBilled"] = null, expectedClients: number | null = null, billedClients: number | null = null;
      const billCover = ok<{ client_id: string; client_name: string; contracted: number }[]>(9);
      if (inv && billCover) {
        const billedSet = new Set((inv ?? []).filter((r) => svc(r) >= pStart && svc(r) <= pEnd).map((r) => r.client_id));
        const firstStart = new Map<string, string>();
        for (const k of (ok<{ client_id: string; start_date: string | null }[]>(10) ?? [])) {
          if (!k.start_date) continue;
          const cur = firstStart.get(k.client_id);
          if (!cur || k.start_date < cur) firstStart.set(k.client_id, k.start_date);
        }
        const liveInMonth = (id: string) => { const st = firstStart.get(id); return !st || st <= pEnd; };
        const expected = billCover.filter((cv) => Number(cv.contracted) > 0 && clientInfo.has(cv.client_id) && inScope(clientInfo.get(cv.client_id)!.branch) && liveInMonth(cv.client_id));
        expectedClients = expected.length;
        billedClients = expected.filter((cv) => billedSet.has(cv.client_id)).length;
        notBilled = expected
          .filter((cv) => !billedSet.has(cv.client_id))
          .map((cv) => ({ clientId: cv.client_id, name: clientInfo.get(cv.client_id)!.name, heads: Number(cv.contracted) }))
          .sort((x, y) => y.heads - x.heads);
      }

      // Receivables
      const open = ok<{ client_id: string; invoice_date: string; outstanding: number }[]>(4);
      let receivables: CommandData["receivables"] = null;
      if (open) {
        const byClient = new Map<string, [number, number, number, number]>();
        const total: [number, number, number, number] = [0, 0, 0, 0];
        for (const r of open) {
          const days = Math.floor((now.getTime() - new Date(`${r.invoice_date}T00:00:00`).getTime()) / 86400000);
          const b = days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
          const amt = Number(r.outstanding ?? 0);
          total[b] += amt;
          const row = byClient.get(r.client_id) ?? [0, 0, 0, 0];
          row[b] += amt;
          byClient.set(r.client_id, row);
        }
        receivables = {
          total: total.reduce((a, b) => a + b, 0),
          buckets: total,
          byClient: [...byClient.entries()]
            .map(([id, buckets]) => ({ clientId: id, name: clientInfo.get(id)?.name ?? "Client", regionId: clientInfo.get(id)?.branch ?? null, buckets }))
            .sort((a, b) => b.buckets.reduce((x, y) => x + y, 0) - a.buckets.reduce((x, y) => x + y, 0)),
        };
      }

      // Client map + regions
      const stmt = ok<{ client_id: string | null; client_name: string; branch_id: string | null; region_name: string; revenue: number; net: number }[]>(7);
      const contractedOf = (id: string) => Number(cover?.find((c) => c.client_id === id)?.contracted ?? 0);
      const clientMap = stmt
        ? {
            month: pStart,
            rows: stmt
              .filter((r) => r.client_id && Number(r.revenue) > 0 && inScope(r.branch_id))
              .map((r) => ({ clientId: r.client_id!, name: r.client_name, regionId: r.branch_id, region: r.region_name, revenue: Number(r.revenue), net: Number(r.net), guards: contractedOf(r.client_id!) })),
          }
        : null;
      const modes = ok<{ branch_id: string; apportioned: boolean }[]>(8);
      let regions: RegionCard[] | null = null;
      if (stmt) {
        const agg = new Map<string, { revenue: number; net: number }>();
        for (const r of stmt) {
          if (!r.branch_id) continue;
          const a = agg.get(r.branch_id) ?? { revenue: 0, net: 0 };
          a.revenue += Number(r.revenue);
          a.net += Number(r.net);
          agg.set(r.branch_id, a);
        }
        // Six FULL months: the running month is part-invoiced and would read as a fall.
        const months = Array.from({ length: 6 }, (_, i) => new Date(now.getFullYear(), now.getMonth() - 6 + i, 1));
        regions = [...agg.entries()]
          .filter(([id, a]) => inScope(id) && a.revenue > 0)
          .map(([id, a]) => ({
            regionId: id,
            name: regionOf(id),
            revenue: a.revenue,
            net: a.net,
            trend: months.map((m) => {
              const from = iso(m), to = iso(new Date(m.getFullYear(), m.getMonth() + 1, 0));
              return (inv ?? []).filter((r) => r.branch_id === id && svc(r) >= from && svc(r) <= to).reduce((s, r) => s + Number(r.invoice_amount ?? 0), 0);
            }),
            charged: modes ? modes.find((m) => m.branch_id === id)?.apportioned ?? null : null,
          }))
          .sort((a, b) => b.revenue - a.revenue);
      }

      // Cash month from the ledger: openings and closings are the accounts'
      // own rows; each movement is the sum of its LINE rows by posting source.
      type LRow = { row_kind: string; source_table: string | null; debit: number | null; credit: number | null; balance: number | null };
      const ledgers = ok<LRow[][]>(11);
      let cashMonth: CommandData["cashMonth"] = null;
      if (ledgers && ledgers.length) {
        let opening = 0, closing = 0;
        const by = new Map<string, number>();
        for (const rows of ledgers) {
          const op = Number(rows.find((r) => r.row_kind === "OPENING")?.balance ?? 0);
          opening += op;
          closing += Number(rows.find((r) => r.row_kind === "CLOSING")?.balance ?? op);
          for (const r of rows) {
            if (r.row_kind !== "LINE") continue;
            const g = GROUPS.find((x) => (x.sources ? x.sources.includes(r.source_table ?? "") : !KNOWN.has(r.source_table ?? "")));
            if (g) by.set(g.key, (by.get(g.key) ?? 0) + Number(r.debit ?? 0) - Number(r.credit ?? 0));
          }
        }
        cashMonth = { opening, closing, flows: GROUPS.map((g) => ({ key: g.key, label: g.label, v: by.get(g.key) ?? 0 })).filter((f) => Math.abs(f.v) >= 1) };
      }
      // The billing month's contract value, client by client, at the line rates
      // in effect on its last day — the same definition Contracts shows.
      let contractValue: number | null = null, offContract: CommandData["offContract"] = null;
      const cdef = ok<{ contracts: { id: string; client_id: string; start_date: string | null }[]; lines: ContractLine[]; adds: ContractAddendum[] }>(15);
      if (cdef && inv) {
        const byClient = new Map<string, number>();
        for (const k of cdef.contracts) {
          if (k.start_date && k.start_date > pEnd) continue;
          const info = clientInfo.get(k.client_id);
          if (!info || !inScope(info.branch)) continue;
          const v = effectiveContractLinesValue(cdef.lines.filter((l) => l.contract_id === k.id), cdef.adds.filter((a) => a.contract_id === k.id), pEnd);
          byClient.set(k.client_id, (byClient.get(k.client_id) ?? 0) + v);
        }
        const billedBy = new Map<string, number>();
        for (const r of inv) if (svc(r) >= pStart && svc(r) <= pEnd) billedBy.set(r.client_id, (billedBy.get(r.client_id) ?? 0) + Number(r.invoice_amount ?? 0));
        contractValue = [...byClient.values()].reduce((n, v) => n + v, 0);
        offContract = [...byClient.entries()]
          .filter(([id, v]) => v > 0 && billedBy.has(id) && Math.abs((billedBy.get(id)! - v) / v) > 0.1)
          .map(([id, v]) => ({ clientId: id, name: clientInfo.get(id)!.name, value: v, billed: billedBy.get(id)! }))
          .sort((a, b) => Math.abs(b.billed - b.value) - Math.abs(a.billed - a.value));
      }
      const cash = ok<{ cash_balance: number }[]>(5);
      setData({
        asOf,
        sites,
        cashMonth,
        payrollLastFull: ok<{ net_salary: number }[]>(12)?.reduce((n, r) => n + Number(r.net_salary ?? 0), 0) ?? null,
        payrollLast: (() => {
          const ps = ok<{ net_salary: number; amount_paid: number | null; disbursed: boolean | null }[]>(12);
          if (!ps || ps.length === 0) return null;
          // A payslip that nets to nothing is settled (the "1 unpaid" at HMC).
          return {
            slips: ps.length,
            paidSlips: ps.filter((p) => p.disbursed || Math.round(Number(p.net_salary || 0)) <= 0).length,
            net: ps.reduce((n, p) => n + Number(p.net_salary || 0), 0),
            paid: ps.reduce((n, p) => n + Number(p.amount_paid || 0), 0),
          };
        })(),
        workforce: (() => {
          const em = ok<{ lifecycle_state: string | null; join_date: string | null; last_working_day: string | null }[]>(14);
          if (!em) return null;
          const live = (s: string | null) => s === "active" || s === "on_leave";
          return {
            active: em.filter((e) => live(e.lifecycle_state)).length,
            joined: em.filter((e) => e.join_date && e.join_date >= mStart && e.join_date <= today).length,
            left: em.filter((e) => !live(e.lifecycle_state) && e.last_working_day && e.last_working_day >= mStart && e.last_working_day <= today).length,
          };
        })(),
        salariesPaidMtd: ok<{ amount_paid: number }[]>(13)?.reduce((n, r) => n + Number(r.amount_paid ?? 0), 0) ?? null,
        contractValue,
        offContract,
        freeRelievers: (() => {
          const r = ok<{ emps: { id: string; full_name: string; branch_id: string | null; lifecycle_state: string | null }[]; marked: Set<string> }>(16);
          if (!r) return null;
          return r.emps.filter((e) => (e.lifecycle_state === "active") && !r.marked.has(e.id)).map((e) => ({ id: e.id, name: e.full_name, regionId: e.branch_id }));
        })(),
        billMonth: pStart,
        billed: inv ? sumSvc(pStart, pEnd) : null,
        billedPrev: inv ? sumSvc(iso(new Date(now.getFullYear(), now.getMonth() - 2, 1)), ppEnd) : null,
        billedAhead: inv ? sumSvc(mStart, "9999-12-31") : null,
        expectedClients,
        billedClients,
        notBilled,
        receiptsMtd: ok<{ amount: number }[]>(3)?.reduce((s, r) => s + Number(r.amount ?? 0), 0) ?? null,
        receivables,
        cashInHand: cash ? cash.reduce((s, r) => s + Number(r.cash_balance ?? 0), 0) : null,
        expensesPaidMtd: ok<{ amount: number }[]>(6)?.reduce((s, r) => s + Number(r.amount ?? 0), 0) ?? null,
        clientMap,
        regions,
      });
    })();
    return () => { cancelled = true; };
  }, [companyId, regionId, canReports, can.accounting, can.payroll, can.employees, can.expenses, can.attendance, can.roster, can.contracts, can.invoices, can.receivables]);

  return data;
}
