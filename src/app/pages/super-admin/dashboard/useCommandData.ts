import { useEffect, useState } from "react";
import { fetchAllRows, supabase } from "../../../lib/supabase";
import { withRegion } from "../../../lib/region";

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
 *   revenue        invoices raised, by invoice_date
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
  asOf: string | null;
  sites: SiteTile[] | null;
  revenueMtd: number | null;
  revenuePrevMonth: number | null;
  revenuePrevToDate: number | null;
  /** Clients invoiced last month with nothing raised yet this month, by last month's amount. */
  uninvoiced: { clientId: string; name: string; lastMonth: number }[] | null;
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

export function useCommandData(companyId: string | null | undefined, regionId: string | null, canReports: boolean) {
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
        asOf
          ? fetchAllRows<{ worked_for_client_id: string | null; status: string }>(() =>
              withRegion(
                supabase.from("attendance_records").select("worked_for_client_id, status").eq("attendance_date", asOf),
                regionId,
              ) as never,
            )
          : Promise.resolve([] as { worked_for_client_id: string | null; status: string }[]),
        // 1 — contracted heads this month
        supabase.rpc("client_cover", { p_company_id: companyId, p_month: mStart }),
        // 2 — invoices raised, this month and last
        fetchAllRows<{ client_id: string; invoice_amount: number; invoice_date: string; branch_id: string | null }>(() =>
          withRegion(supabase.from("invoices").select("client_id, invoice_amount, invoice_date, branch_id").gte("invoice_date", trendStart).lte("invoice_date", today), regionId) as never,
        ),
        // 3 — receipts this month
        fetchAllRows<{ amount: number }>(() =>
          withRegion(supabase.from("invoice_payments").select("amount").gte("payment_date", mStart).lte("payment_date", today), regionId) as never,
        ),
        // 4 — open invoices for ageing
        fetchAllRows<{ client_id: string; invoice_date: string; outstanding: number }>(() =>
          withRegion(supabase.from("invoices").select("client_id, invoice_date, outstanding").gt("outstanding", 0), regionId) as never,
        ),
        // 5 — cash held by custodians
        supabase.rpc("cash_in_hand", { p_company_id: companyId }),
        // 6 — expenses this month
        fetchAllRows<{ amount: number }>(() =>
          withRegion(supabase.from("expenses").select("amount").gte("expense_date", mStart).lte("expense_date", today), regionId) as never,
        ),
        // 7 — client statement, last full month (reports access only)
        canReports
          ? supabase.rpc("client_statement_loaded", { p_start: pStart, p_end: pEnd, p_basis: "revenue", p_company_id: companyId })
          : Promise.resolve({ data: null, error: null }),
        // 8 — which regions are charged head office
        canReports ? supabase.rpc("ho_region_modes", { p_company_id: companyId, p_month: pStart }) : Promise.resolve({ data: null, error: null }),
      ]);
      if (cancelled) return;
      const ok = <T,>(i: number): T | null => {
        const r = tasks[i];
        if (r.status !== "fulfilled") return null;
        const v = r.value as { data?: unknown; error?: unknown } | unknown[];
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

      // Revenue
      const inv = ok<{ client_id: string; invoice_amount: number; invoice_date: string; branch_id: string | null }[]>(2);
      let uninvoiced: CommandData["uninvoiced"] = null;
      if (inv) {
        const last = new Map<string, number>(), cur = new Set<string>();
        for (const r of inv) {
          if (r.invoice_date >= pStart && r.invoice_date <= pEnd) last.set(r.client_id, (last.get(r.client_id) ?? 0) + Number(r.invoice_amount ?? 0));
          if (r.invoice_date >= mStart) cur.add(r.client_id);
        }
        uninvoiced = [...last.entries()]
          .filter(([id, amt]) => !cur.has(id) && amt > 0 && clientInfo.has(id))
          .map(([id, amt]) => ({ clientId: id, name: clientInfo.get(id)!.name, lastMonth: amt }))
          .sort((a, b) => b.lastMonth - a.lastMonth);
      }
      const sumInv = (from: string, to: string) => (inv ?? []).filter((r) => r.invoice_date >= from && r.invoice_date <= to).reduce((s, r) => s + Number(r.invoice_amount ?? 0), 0);

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
              return (inv ?? []).filter((r) => r.branch_id === id && r.invoice_date >= from && r.invoice_date <= to).reduce((s, r) => s + Number(r.invoice_amount ?? 0), 0);
            }),
            charged: modes ? modes.find((m) => m.branch_id === id)?.apportioned ?? null : null,
          }))
          .sort((a, b) => b.revenue - a.revenue);
      }

      const cash = ok<{ cash_balance: number }[]>(5);
      setData({
        asOf,
        sites,
        revenueMtd: inv ? sumInv(mStart, today) : null,
        revenuePrevMonth: inv ? sumInv(pStart, pEnd) : null,
        revenuePrevToDate: inv ? sumInv(pStart, pToDate) : null,
        uninvoiced,
        receiptsMtd: ok<{ amount: number }[]>(3)?.reduce((s, r) => s + Number(r.amount ?? 0), 0) ?? null,
        receivables,
        cashInHand: cash ? cash.reduce((s, r) => s + Number(r.cash_balance ?? 0), 0) : null,
        expensesPaidMtd: ok<{ amount: number }[]>(6)?.reduce((s, r) => s + Number(r.amount ?? 0), 0) ?? null,
        clientMap,
        regions,
      });
    })();
    return () => { cancelled = true; };
  }, [companyId, regionId, canReports]);

  return data;
}
