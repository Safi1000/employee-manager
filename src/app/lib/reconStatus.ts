import { useEffect, useState } from "react";
import { supabase } from "./supabase";

/**
 * Where each bank stands against its statement (0534): the last reconciliation
 * and how many movements have been ENTERED since it — the same "since" the
 * Banks tab lists. Read by the bank cards and the Dashboard.
 *
 * Pass enabled=false for anyone who may not see banks: nothing is fetched.
 * (bank_reconciliations carries the bank_accounts read gate as well, so a
 * caller without access would only ever get an empty map.)
 */
export type ReconStatus = {
  statementDate: string;
  statementBalance: number;
  difference: number;
  parked: boolean;
  reconciledAt: string;
  enteredSince: number;
};

export function useReconStatus(companyId: string | null | undefined, enabled: boolean, refreshKey: unknown = 0) {
  const [map, setMap] = useState<Map<string, ReconStatus>>(new Map());
  useEffect(() => {
    if (!enabled || !companyId) { setMap(new Map()); return; }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.from("bank_reconciliations")
        .select("bank_account_id, statement_date, statement_balance, difference, posted_to_suspense, cleared_at, reconciled_at")
        .eq("company_id", companyId).order("reconciled_at", { ascending: false });
      if (error || cancelled) return;
      const last = new Map<string, any>();
      for (const r of data ?? []) if (!last.has(r.bank_account_id)) last.set(r.bank_account_id, r);
      const out = new Map<string, ReconStatus>();
      await Promise.all([...last.values()].map(async (r) => {
        const { count } = await supabase.from("bank_transactions").select("id", { count: "exact", head: true })
          .eq("bank_account_id", r.bank_account_id).gt("created_at", r.reconciled_at).neq("account_delta", 0);
        out.set(r.bank_account_id, {
          statementDate: r.statement_date,
          statementBalance: Number(r.statement_balance),
          difference: Number(r.difference),
          parked: !!r.posted_to_suspense && !r.cleared_at,
          reconciledAt: r.reconciled_at,
          enteredSince: count ?? 0,
        });
      }));
      if (!cancelled) setMap(out);
    })();
    return () => { cancelled = true; };
  }, [companyId, enabled, refreshKey]);
  return map;
}

export const tallyDate = (d: string) =>
  new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
