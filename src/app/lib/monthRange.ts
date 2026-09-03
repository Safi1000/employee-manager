import { supabase } from "./supabase";

// WHERE A MONTH PICKER STARTS.
//
// Three pages each carried their own copy of `for (let i = 0; i < 18; i++)`,
// counting back eighteen months from today regardless of whether the company
// existed. On GGS — whose ledger begins August 2026 — Period Close offered
// months back to March 2025, sixteen of which can never hold anything. A picker
// that offers a month nothing can be in is a picker that has to be read past.
//
// The bound is THE EARLIEST POSTED JOURNAL ENTRY. Not the opening batch date:
// GGS has not posted one, so that bound would be null exactly where it is
// needed, and a company can post before it seeds openings. Not `created_at`
// either, as the primary rule — a company created in May whose books start in
// August would offer three empty months — but it IS the fallback, because a
// company with nothing posted still needs a picker that renders.
//
// Both queries below are scoped by RLS to the caller's company, so neither
// takes a company id. Passing one would be a second opinion about which company
// the session is in, and the two would eventually disagree.

/**
 * First-of-month ISO strings ("YYYY-MM-01") from the current month back to the
 * month containing `startISO`, newest first. `maxMonths` is a guard, not a
 * window: it stops one bad date turning a dropdown into an essay.
 */
export function monthsFrom(startISO: string | null | undefined, maxMonths = 120): string[] {
  const now = new Date();
  const cur = new Date(now.getFullYear(), now.getMonth(), 1);
  const out: string[] = [];
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;

  // No start: the current month alone. Honest about knowing nothing, and never
  // an empty list — a dropdown with no options reads as a broken page.
  if (!startISO) return [iso(cur)];

  const [y, m] = startISO.slice(0, 7).split("-").map(Number);
  if (!y || !m) return [iso(cur)];
  const start = new Date(y, m - 1, 1);

  const d = cur;
  while (d >= start && out.length < maxMonths) {
    out.push(iso(d));
    d.setMonth(d.getMonth() - 1);
  }
  // A start in the future (a clock skew, a mis-dated entry) still yields the
  // current month rather than nothing.
  return out.length > 0 ? out : [iso(cur)];
}

/** Same list as `{ key: "YYYY-MM", label: "Aug 2026" }`, for the filter dropdowns. */
export function monthKeysFrom(
  startISO: string | null | undefined,
  maxMonths = 120,
): { key: string; label: string }[] {
  return monthsFrom(startISO, maxMonths).map((isoDate) => {
    const [y, m] = isoDate.split("-").map(Number);
    return {
      key: isoDate.slice(0, 7),
      label: new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" }),
    };
  });
}

/**
 * The month the books actually begin: the earliest posted journal entry, else
 * the company's creation date, else null. Returns "YYYY-MM-DD".
 */
export async function fetchLedgerStart(): Promise<string | null> {
  const { data: entry } = await supabase
    .from("journal_entries")
    .select("entry_date")
    .order("entry_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (entry?.entry_date) return String(entry.entry_date).slice(0, 10);

  const { data: company } = await supabase
    .from("companies")
    .select("created_at")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return company?.created_at ? String(company.created_at).slice(0, 10) : null;
}
