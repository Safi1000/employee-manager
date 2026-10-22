import { useEffect, useState } from "react";
import { fetchAllRows, supabase } from "./supabase";
import { guardDisplayCode } from "./guardCode";

/**
 * TRANSACTION LOG GROUPING (2026-10-22). A bulk salary run writes one money
 * line per payslip — 109 lines for HMC's guards paid from Askari — which is
 * right for the record and unreadable as a log. Lines that are the same
 * payment run fold into one row: same client, same pay month, same account,
 * paid within a few days of each other. The row shows the count and the
 * total; opening it shows every line. Advances fold the same way.
 *
 * Nothing is computed that the lines do not already say: the client comes
 * from the guard code in the line's own description ("Payroll September 2026 ·
 * 68HPP-009 Maratab Ali"), looked up against the employees' codes. A line
 * whose code is not found still groups, under "Client not found".
 */

export type TxGroup<T> = {
  kind: "group";
  key: string;
  title: string;
  subtitle: string;
  rows: T[];
  total: number;
};
export type TxItem<T> = { kind: "row"; row: T } | TxGroup<T>;

/** Every guard code an employee has carried → that employee's client name. */
export type PayClientIndex = Map<string, string>;

export async function loadPayClientIndex(): Promise<PayClientIndex> {
  const [emps, cliRes] = await Promise.all([
    fetchAllRows<{ id: string; client_id: string | null; display_number: number | null; guard_code: string | null; employee_code: string | null }>(() =>
      supabase.from("employees").select("id, client_id, display_number, guard_code, employee_code").order("id") as unknown as {
        range: (from: number, to: number) => Promise<{ data: unknown; error: { message: string } | null }>;
      },
    ),
    supabase.from("clients").select("id, name, employee_id_prefix"),
  ]);
  const clients = new Map(((cliRes.data ?? []) as { id: string; name: string; employee_id_prefix: string | null }[]).map((c) => [c.id, c]));
  const idx: PayClientIndex = new Map();
  for (const e of emps) {
    const c = e.client_id ? clients.get(e.client_id) : undefined;
    const name = c?.name ?? "Head office";
    for (const code of [guardDisplayCode(e, c?.employee_id_prefix ?? null), e.guard_code, e.employee_code]) {
      if (code && !idx.has(code)) idx.set(code, name);
    }
  }
  return idx;
}

/** The index, loaded once per mount; empty until it arrives (lines then group as "Client not found"). */
export function usePayClientIndex(): PayClientIndex {
  const [idx, setIdx] = useState<PayClientIndex>(new Map());
  useEffect(() => {
    let alive = true;
    loadPayClientIndex().then((i) => { if (alive) setIdx(i); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return idx;
}

const PAYROLL = /^(Reverse payroll|Payroll)( \(cash\))? ([A-Z][a-z]+ \d{4}) · (\S+)/;
const ADVANCE = /^Advance · (\S+)/;
const DAY = 86400000;

/**
 * Fold a newest-first list into rows and groups. A line joins an open group
 * with the same key whose latest line is within `windowDays`; otherwise it
 * starts one. Groups of one stay plain rows, and every item keeps the
 * position of its newest line, so the log still reads newest first.
 */
export function groupLedger<T>(rows: T[], o: {
  at: (r: T) => string | null | undefined;
  text: (r: T) => string | null | undefined;
  /** What the money moved through — a bank, cash, a custodian. Groups never cross it. */
  account: (r: T) => string;
  delta: (r: T) => number;
  clients: PayClientIndex;
  windowDays?: number;
}): TxItem<T>[] {
  const win = (o.windowDays ?? 3) * DAY;
  const items: (TxItem<T> & { last?: number })[] = [];
  const open = new Map<string, TxGroup<T> & { last: number }>();
  for (const r of rows) {
    const text = o.text(r) ?? "";
    const t = Date.parse(o.at(r) ?? "") || 0;
    let key: string | null = null, title = "", subtitle = "";
    const p = PAYROLL.exec(text);
    const a = p ? null : ADVANCE.exec(text);
    if (p) {
      const client = o.clients.get(p[4]) ?? "Client not found";
      const rev = p[1] === "Reverse payroll";
      key = `pay|${o.account(r)}|${rev ? "rev" : "pay"}|${p[3]}|${client}`;
      title = `${client} — ${p[3]} ${rev ? "payroll reversed" : "payroll"}`;
      subtitle = p[2] ? "cash" : "";
    } else if (a) {
      const client = o.clients.get(a[1]) ?? "Client not found";
      key = `adv|${o.account(r)}|${client}`;
      title = `${client} — advances`;
    }
    if (!key) { items.push({ kind: "row", row: r }); continue; }
    const g = open.get(key);
    if (g && Math.abs(g.last - t) <= win) {
      g.rows.push(r); g.total += o.delta(r); g.last = t;
      continue;
    }
    const ng = { kind: "group" as const, key: `${key}|${t}`, title, subtitle, rows: [r], total: o.delta(r), last: t };
    open.set(key, ng);
    items.push(ng);
  }
  return items.map((it) => (it.kind === "group" && it.rows.length === 1 ? { kind: "row", row: it.rows[0] } : it));
}
