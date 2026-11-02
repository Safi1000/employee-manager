import { supabase } from "./supabase";

/**
 * The nightly controls, as last run (0635). ledger_checks() now outlasts a
 * signed-in user's statement timeout, so the pages read what the 05:10 run kept
 * in ledger_check_results instead of running every check live. `runAt` says how
 * old the result is; `error` is set when nothing could be read, so a page shows
 * a sentence instead of waiting for ever.
 */
export type CheckRow = { check_name: string; expected: number | null; actual: number | null; difference: number | null; passed: boolean };
export type LatestChecks = { rows: CheckRow[]; runAt: string | null; error: string | null };

export async function loadLatestChecks(companyId: string): Promise<LatestChecks> {
  const { data, error } = await supabase
    .from("ledger_check_results")
    .select("run_at, check_name, expected, actual, difference, passed")
    .eq("company_id", companyId)
    .order("run_at", { ascending: false })
    .limit(200);
  if (error) {
    return { rows: [], runAt: null, error: "The checks couldn't be read here — they take longer to run than a page may wait. Each red one is still raised as an alert every morning." };
  }
  const all = (data ?? []) as (CheckRow & { run_at: string })[];
  if (!all.length) return { rows: [], runAt: null, error: "No nightly run has been kept yet — the first one lands at 05:10." };
  const runAt = all[0].run_at;
  return { rows: all.filter((r) => r.run_at === runAt), runAt, error: null };
}

export const ranAt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
