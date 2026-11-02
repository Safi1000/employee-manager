import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { withRegion, withRegionOrUnassigned } from "./region";

/**
 * Counts on the section rail (2026-10-21): what is waiting in each section,
 * so the rail says where to look before you open anything. Each is one
 * head-only count query; one that fails (no access) simply shows nothing.
 *
 *   Dashboard  open alerts (on the Home icon)
 *   Workforce  last month's payslips not yet paid (a payslip netting to
 *              nothing is settled, as on Payroll)
 *   Finance    fixed expenses this month still waiting for a decision
 *   Compliance guard documents already expired
 *   Comments   conversations with a reply the viewer has not read (0606)
 */
export type NavBadge = { n: number; title: string };

const REFRESH_MS = 5 * 60 * 1000;

export function useNavBadges(companyId: string | null, regionId: string | null): Record<string, NavBadge> {
  const [badges, setBadges] = useState<Record<string, NavBadge>>({});

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    const load = async () => {
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastKey = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}-01`;
      const thisKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const [al, ps, fx, cu, cm] = await Promise.all([
        withRegionOrUnassigned(supabase.from("alerts").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("state", "open"), regionId),
        withRegion(supabase.from("payslips").select("id", { count: "exact", head: true }).eq("period_month", lastKey).eq("disbursed", false).gt("net_salary", 0), regionId),
        withRegionOrUnassigned(supabase.from("fixed_expense_instances").select("id", { count: "exact", head: true }).eq("period_month", thisKey).eq("status", "pending"), regionId),
        withRegionOrUnassigned(supabase.from("compliance_upcoming").select("ref_id", { count: "exact", head: true }).eq("company_id", companyId).lt("days_remaining", 0), regionId),
        supabase.rpc("my_unread_comment_threads"),
      ]);
      if (cancelled) return;
      const month = lastMonth.toLocaleDateString(undefined, { month: "long" });
      const next: Record<string, NavBadge> = {};
      // Keyed by the section each page now sits in (sidebar regrouped 2 Nov 2026):
      // alerts and unread replies on Overview, payslips with expenses on
      // Finance, expired documents on Admin (the Compliance Calendar's home).
      const unread = !cm.error && typeof cm.data === "number" ? cm.data : 0;
      const alerts = !al.error ? al.count ?? 0 : 0;
      if (alerts || unread) next["Overview"] = { n: alerts + unread, title: [alerts ? `${alerts} open alert${alerts === 1 ? "" : "s"}` : "", unread ? `${unread} conversation${unread === 1 ? "" : "s"} with an unread reply` : ""].filter(Boolean).join(" · ") };
      const pay = !ps.error ? ps.count ?? 0 : 0;
      const fixed = !fx.error ? fx.count ?? 0 : 0;
      if (pay || fixed) next["Finance"] = { n: pay + fixed, title: [pay ? `${pay} ${month} payslip${pay === 1 ? "" : "s"} not yet paid` : "", fixed ? `${fixed} fixed expense${fixed === 1 ? "" : "s"} waiting for a decision` : ""].filter(Boolean).join(" · ") };
      if (!cu.error && cu.count) next["Admin"] = { n: cu.count, title: `${cu.count} guard document${cu.count === 1 ? "" : "s"} expired` };
      setBadges(next);
    };
    void load();
    const t = window.setInterval(() => void load(), REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [companyId, regionId]);

  return badges;
}
