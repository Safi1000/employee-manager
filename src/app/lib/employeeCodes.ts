import { useEffect, useState } from "react";
import { fetchAllRows, supabase } from "./supabase";
import { guardDisplayCode, relabelEmployeeCodes } from "./guardCode";

// Every employee's client display code, for screens that do not otherwise load
// employees and clients: byId for rows that carry an employee_id, byPermanent
// for text that names an employee by the permanent code.
export type EmployeeCodeIndex = {
  byId: Map<string, string>;
  byPermanent: Map<string, string>;
};

const EMPTY: EmployeeCodeIndex = { byId: new Map(), byPermanent: new Map() };

type EmpCodeRow = {
  id: string;
  client_id: string | null;
  display_number: number | null;
  guard_code: string | null;
  employee_code: string | null;
};

export async function loadEmployeeCodeIndex(): Promise<EmployeeCodeIndex> {
  const [emps, cliRes] = await Promise.all([
    fetchAllRows<EmpCodeRow>(() =>
      supabase
        .from("employees")
        .select("id, client_id, display_number, guard_code, employee_code")
        .order("id") as unknown as {
        range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
      },
    ),
    supabase.from("clients").select("id, employee_id_prefix"),
  ]);
  const prefix = new Map(
    ((cliRes.data ?? []) as { id: string; employee_id_prefix: string | null }[]).map((c) => [c.id, c.employee_id_prefix]),
  );
  const byId = new Map<string, string>();
  const byPermanent = new Map<string, string>();
  for (const e of emps) {
    const code = guardDisplayCode(e, e.client_id ? prefix.get(e.client_id) ?? null : null);
    byId.set(e.id, code);
    for (const perm of [e.guard_code, e.employee_code]) {
      if (perm && perm !== code) byPermanent.set(perm, code);
    }
  }
  return { byId, byPermanent };
}

/** The index, loaded once per mount; empty maps until it arrives. */
export function useEmployeeCodeIndex(): EmployeeCodeIndex & { relabel: (text: string | null | undefined) => string } {
  const [idx, setIdx] = useState<EmployeeCodeIndex>(EMPTY);
  useEffect(() => {
    let alive = true;
    loadEmployeeCodeIndex().then((i) => { if (alive) setIdx(i); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return { ...idx, relabel: (text) => relabelEmployeeCodes(text, idx.byPermanent) };
}
