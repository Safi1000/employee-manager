import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase";
import { monthEnd, monthStart } from "./kit";

/**
 * The company P&L on either basis, for a period and a comparison period.
 *
 * READ, NOT COMPUTED. The revenue basis is the general ledger, account by
 * account (trial_balance_for, 0320) — a year to date is that function read for
 * each month and added up, which is the same arithmetic as a footer. The cash
 * basis is client_statement_loaded(…, 'cash') over the period: the one client
 * P&L the partners are paid on, totalled line by line. Nothing here decides
 * what a figure means; it adds the rows a database function returned.
 */

export type Basis = "revenue" | "cash";
export type Compare = "prev" | "ly" | "ytd";
export type PLLine = { key: string; label: string; value: number; code?: string };
export type PLSection = { key: "rev" | "cos" | "opex" | "tax"; title: string; cost: boolean; lines: PLLine[] };
export type PL = { sections: PLSection[]; revenue: number; cos: number; opex: number; tax: number; gross: number; operating: number; net: number };

type TB = { account_code: string; account_name: string; account_type: string; net_debit: number };
type CS = { branch_id: string | null; revenue: number; direct_payroll: number; direct_expenses: number; regional_overhead: number; ho_share: number; client_id: string | null };

const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/** The months a range covers, as YYYY-MM keys. */
function monthsBetween(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  let [y, m] = fromKey.split("-").map(Number);
  const [ty, tm] = toKey.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(ym(y, m)); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

export function ranges(period: string, cmp: Compare) {
  const [y, m] = period.split("-").map(Number);
  const prev = m === 1 ? ym(y - 1, 12) : ym(y, m - 1);
  if (cmp === "prev") return { cur: [period, period], cmp: [prev, prev], curLabel: period, cmpLabel: prev, ytd: false };
  if (cmp === "ly") return { cur: [period, period], cmp: [ym(y - 1, m), ym(y - 1, m)], curLabel: period, cmpLabel: ym(y - 1, m), ytd: false };
  return { cur: [ym(y, 1), period], cmp: [ym(y - 1, 1), ym(y - 1, m)], curLabel: period, cmpLabel: ym(y - 1, m), ytd: true };
}

function fromTB(rows: TB[]): PL {
  const sec = (key: PLSection["key"], title: string, cost: boolean, match: (a: TB) => boolean, sign: 1 | -1): PLSection => ({
    key, title, cost,
    lines: rows.filter(match).filter((a) => Math.abs(Number(a.net_debit)) > 0.005)
      .map((a) => ({ key: a.account_code, code: a.account_code, label: a.account_name, value: sign * Number(a.net_debit) }))
      .sort((a, b) => (a.code ?? "").localeCompare(b.code ?? "")),
  });
  const sections = [
    sec("rev", "Revenue", false, (a) => a.account_type === "revenue", -1),
    sec("cos", "Cost of services", true, (a) => a.account_type === "expense" && a.account_code.startsWith("5"), 1),
    sec("opex", "Operating expenses", true, (a) => a.account_type === "expense" && a.account_code.startsWith("6"), 1),
    sec("tax", "Income tax", true, (a) => a.account_type === "expense" && a.account_code.startsWith("7"), 1),
  ];
  return totals(sections);
}

function fromCS(rows: CS[]): PL {
  const t = rows.reduce((a, r) => ({
    revenue: a.revenue + Number(r.revenue ?? 0), pay: a.pay + Number(r.direct_payroll ?? 0), exp: a.exp + Number(r.direct_expenses ?? 0),
    ro: a.ro + Number(r.regional_overhead ?? 0), ho: a.ho + Number(r.ho_share ?? 0),
  }), { revenue: 0, pay: 0, exp: 0, ro: 0, ho: 0 });
  const sections: PLSection[] = [
    { key: "rev", title: "Received", cost: false, lines: [{ key: "received", label: "Received from clients", value: t.revenue }] },
    { key: "cos", title: "Direct costs paid", cost: true, lines: [{ key: "pay", label: "Guard payroll disbursed", value: t.pay }, { key: "exp", label: "Site expenses paid", value: t.exp }] },
    { key: "opex", title: "Overheads", cost: true, lines: [{ key: "ro", label: "Regional overhead", value: t.ro }, { key: "ho", label: "Head office", value: t.ho }] },
  ];
  return totals(sections);
}

function totals(sections: PLSection[]): PL {
  const sum = (k: PLSection["key"]) => sections.find((s) => s.key === k)?.lines.reduce((a, l) => a + l.value, 0) ?? 0;
  const revenue = sum("rev"), cos = sum("cos"), opex = sum("opex"), tax = sum("tax");
  return { sections, revenue, cos, opex, tax, gross: revenue - cos, operating: revenue - cos - opex, net: revenue - cos - opex - tax };
}

async function load(companyId: string, basis: Basis, from: string, to: string, regionId: string | null): Promise<PL> {
  if (basis === "cash") {
    const { data, error } = await supabase.rpc("client_statement_loaded", { p_start: monthStart(from), p_end: monthEnd(to), p_basis: "cash", p_company_id: companyId });
    if (error) throw new Error(error.message);
    return fromCS(((data ?? []) as CS[]).filter((r) => !regionId || r.branch_id === regionId));
  }
  const months = monthsBetween(from, to);
  const results = await Promise.all(months.map((mk) => supabase.rpc("trial_balance_for", { p_company_id: companyId, p_period: monthStart(mk), p_branch_id: regionId })));
  const acc = new Map<string, TB>();
  for (const r of results) {
    if (r.error) throw new Error(r.error.message);
    for (const a of (r.data ?? []) as TB[]) {
      if (a.account_type !== "revenue" && a.account_type !== "expense") continue;
      const cur = acc.get(a.account_code);
      if (cur) cur.net_debit = Number(cur.net_debit) + Number(a.net_debit);
      else acc.set(a.account_code, { ...a, net_debit: Number(a.net_debit) });
    }
  }
  return fromTB([...acc.values()]);
}

export function usePL(companyId: string | null, period: string, basis: Basis, cmp: Compare, regionId: string | null) {
  const [state, setState] = useState<{ cur: PL | null; cmp: PL | null; error: string | null; loading: boolean }>({ cur: null, cmp: null, error: null, loading: true });
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    const r = ranges(period, cmp);
    void Promise.all([load(companyId, basis, r.cur[0], r.cur[1], regionId), load(companyId, basis, r.cmp[0], r.cmp[1], regionId)])
      .then(([a, b]) => { if (!cancelled) setState({ cur: a, cmp: b, error: null, loading: false }); })
      .catch((e: Error) => { if (!cancelled) setState({ cur: null, cmp: null, error: e.message, loading: false }); });
    return () => { cancelled = true; };
  }, [companyId, period, basis, cmp, regionId]);
  return state;
}
