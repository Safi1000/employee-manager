import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { supabase, type Region } from "./supabase";
import { useAuth } from "./auth";

// Global region context (spec section 3).
//
// "A context switch at the top of the app: All regions / each region / Head
// Office. Every screen filters to the selection."
//
// `regionId === null` means All — the consolidated company view. Regions are
// the `branches` table; see migration 0074 for why that table IS the region.

/** Sentinel for the consolidated "All regions" view. */
export const ALL_REGIONS = null;

type RegionCtx = {
  /** Selected region, or null for the consolidated "All regions" view. */
  regionId: string | null;
  setRegionId: (id: string | null) => void;
  /** Active regions for the current company, Head Office first. */
  regions: Region[];
  /** The selected region's row; null while loading or when All is selected. */
  region: Region | null;
  /**
   * True when the user is pinned to one region and cannot switch (spec §2's
   * RMD: "owns one region … cannot see other regions"). Driven by
   * profiles.branch_id, so no new role is needed to turn it on.
   */
  locked: boolean;
  loading: boolean;
};

const Ctx = createContext<RegionCtx | null>(null);

// Persist the selection per user+company. Switching companies (SSA "view as")
// must not carry a region from a company that doesn't have it.
const storageKey = (userId: string, companyId: string) =>
  `region:${userId}:${companyId}`;

export function RegionProvider({ children }: { children: ReactNode }) {
  const { profile, company } = useAuth();
  const [regions, setRegions] = useState<Region[]>([]);
  const [regionId, setRegionIdState] = useState<string | null>(ALL_REGIONS);
  const [loading, setLoading] = useState(true);

  // A pinned profile is locked to its own region and never sees the selector.
  const locked = !!profile?.branch_id;
  const companyId = company?.id ?? null;
  const userId = profile?.id ?? null;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!companyId) {
        setRegions([]);
        setRegionIdState(ALL_REGIONS);
        setLoading(false);
        return;
      }
      setLoading(true);
      const { data } = await supabase
        .from("branches")
        .select("id, company_id, name, code, kind, is_head_office, active")
        .eq("company_id", companyId)
        .eq("active", true)
        // Head Office first, then regions alphabetically.
        .order("is_head_office", { ascending: false })
        .order("name", { ascending: true });

      if (cancelled) return;

      const rows = (data as Region[]) ?? [];
      setRegions(rows);

      if (profile?.branch_id) {
        // Locked users always land on their own region regardless of what is
        // stored — the pin is the authority, not the last selection.
        setRegionIdState(profile.branch_id);
      } else {
        // Restore the last selection, but only if it still exists and is
        // active on this company. Otherwise fall back to consolidated.
        // Head Office is merged into the consolidated view, so a persisted HO
        // selection is treated as consolidated (null) rather than an HO-only filter.
        const hoId = rows.find((r) => r.is_head_office)?.id ?? null;
        let restored: string | null = ALL_REGIONS;
        if (userId) {
          try {
            const saved = localStorage.getItem(storageKey(userId, companyId));
            if (saved && saved !== hoId && rows.some((r) => r.id === saved)) restored = saved;
          } catch {
            // localStorage unavailable (private mode) — consolidated is fine.
          }
        }
        setRegionIdState(restored);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [companyId, userId, profile?.branch_id]);

  const setRegionId = useCallback(
    (id: string | null) => {
      if (locked) return; // Pinned users cannot switch.
      setRegionIdState(id);
      if (!userId || !companyId) return;
      try {
        const key = storageKey(userId, companyId);
        if (id === null) localStorage.removeItem(key);
        else localStorage.setItem(key, id);
      } catch {
        // Non-fatal: the selection just won't survive a reload.
      }
    },
    [locked, userId, companyId],
  );

  const region = useMemo(
    () => regions.find((r) => r.id === regionId) ?? null,
    [regions, regionId],
  );

  const value = useMemo(
    () => ({ regionId, setRegionId, regions, region, locked, loading }),
    [regionId, setRegionId, regions, region, locked, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRegion() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRegion must be used inside RegionProvider");
  return ctx;
}

/**
 * Apply the active region to a supabase query. Pages call this instead of
 * hand-rolling `.eq("branch_id", …)` so that "All regions" (null) consistently
 * means no filter rather than a filter on null.
 *
 *   const { regionId } = useRegion();
 *   const { data } = await withRegion(
 *     supabase.from("employees").select("*").eq("company_id", cid),
 *     regionId,
 *   );
 *
 * `column` covers the tables that name the region differently.
 */
export function withRegion<T>(query: T, regionId: string | null, column = "branch_id"): T {
  // Deliberately not constrained to a builder shape: supabase's query types are
  // recursive enough that a structural `{ eq(): T }` bound sends tsc into
  // "type instantiation is excessively deep". Passing T through untouched keeps
  // the caller's builder type exact.
  if (!regionId) return query;
  return (query as { eq: (col: string, val: string) => T }).eq(column, regionId);
}

/**
 * Client-side equivalent of withRegion, for lists already in memory.
 */
export function filterByRegion<T extends { branch_id?: string | null }>(
  rows: T[],
  regionId: string | null,
): T[] {
  if (!regionId) return rows;
  return rows.filter((r) => r.branch_id === regionId);
}
