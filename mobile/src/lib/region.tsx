// Region context, as web lib/region.tsx: null = all regions; `locked` when the
// user is pinned to a branch. Pages filter by it; the selector lives in the shell.
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useContext, useEffect, useState } from "react";
import type { Branch } from "../data/seed";
import { useDB } from "../data/store";
import { useAuth } from "./auth";

type RegionCtx = { regionId: string | null; setRegionId: (id: string | null) => void; locked: boolean; regions: Branch[]; label: string };
const Ctx = createContext<RegionCtx | null>(null);

export function RegionProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();
  const { db } = useDB();
  const branches = db.branches;
  const [picked, setPicked] = useState<string | null>(null);
  const locked = !!profile?.branch_id;
  const key = `ggs.region.${profile?.id ?? "anon"}`;

  useEffect(() => {
    AsyncStorage.getItem(key).then((v) => setPicked(v || null)).catch(() => {});
  }, [key]);

  const regionId = locked ? profile!.branch_id : picked;
  const setRegionId = (id: string | null) => {
    if (locked) return;
    setPicked(id);
    AsyncStorage.setItem(key, id ?? "").catch(() => {});
  };
  const label = regionId ? branches.find((b) => b.id === regionId)?.name ?? "Region" : "All regions";
  return <Ctx.Provider value={{ regionId, setRegionId, locked, regions: branches, label }}>{children}</Ctx.Provider>;
}

export function useRegion() {
  const c = useContext(Ctx);
  if (!c) throw new Error("RegionProvider missing");
  return c;
}

/** Filter helper: rows carrying a branch id (directly or via their client). */
export function inRegion(regionId: string | null, branchId: string | null | undefined) {
  return !regionId || branchId === regionId;
}
