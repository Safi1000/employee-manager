// The remaining finance pages (web PeriodClose, Treasury, RegionalScorecard,
// Partners, PartnershipRun, ProjectFinancing, CashFlow, FinancialReports and
// its RegionalPerformance / ContractedVsDeployed / partner dialogs). Reads and
// writes are the web's own; the folds below are the ones the web does in the
// browser, ported so the phone shows the same figures.
import { q, rpc, sb } from "./core";
import { fetchAllRows, isPersonnelCategory } from "../../lib/web/supabase";
import { invoicePeriodFilter } from "../../lib/web/date";
import { fetchLedgerStart, monthsFrom } from "../../lib/web/monthRange";
import { ensureCustodianLocation, loadCustodianOptions, type CustodianOption } from "../../lib/web/custodian";

export const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
});
export const lastOfMonthKey = (key: string) => { const [y, m] = key.split("-").map(Number); return `${key}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; };
export const monthName = (key: string) => { const [y, m] = key.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }); };
export function monthKeys(n: number, from = 0) {
  const out: string[] = [];
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - from);
  for (let i = 0; i < n; i++) { out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); d.setMonth(d.getMonth() - 1); }
  return out;
}
export const previousMonthKey = () => monthKeys(1, 1)[0];

// ---------------------------------------------------------------- Period close
export type PeriodRow = { period_month: string; label: string; invoices: number; payments: number; expenses: number; payslips: number; advances: number; cheques: number; total: number; closed_at: string | null; closed_by_name: string | null; note: string | null; period_id: string | null };
export async function loadPeriodClose(): Promise<PeriodRow[]> {
  const start = await fetchLedgerStart().catch(() => null);
  const monthList = monthsFrom(start ?? null);
  const startMonth = monthList[monthList.length - 1];
  const endMonth = lastOfMonthKey(monthList[0].slice(0, 7));
  const s = sb();
  const [periods, profiles, inv, pay, exp, ps, adv, chq] = await Promise.all([
    q<any[]>(s.from("accounting_periods").select("*")),
    q<any[]>(s.from("profiles").select("id, full_name, email")),
    q<any[]>(s.from("invoices").select("invoice_date, period_start").or(invoicePeriodFilter(startMonth, endMonth))),
    q<any[]>(s.from("invoice_payments").select("payment_date").gte("payment_date", startMonth).lte("payment_date", endMonth)),
    q<any[]>(s.from("expenses").select("expense_date").gte("expense_date", startMonth).lte("expense_date", endMonth)),
    q<any[]>(s.from("payslips").select("period_month").gte("period_month", startMonth).lte("period_month", endMonth)),
    q<any[]>(s.from("advances").select("advance_date").gte("advance_date", startMonth).lte("advance_date", endMonth)),
    q<any[]>(s.from("cheques").select("cheque_date").gte("cheque_date", startMonth).lte("cheque_date", endMonth)),
  ]);
  const pMap = new Map(periods.map((p) => [String(p.period_month).slice(0, 7) + "-01", p]));
  const prof = new Map(profiles.map((p) => [p.id, p.full_name ?? p.email ?? p.id]));
  const tally = (ds: (string | null)[]) => { const m = new Map<string, number>(); for (const d of ds) if (d) { const k = `${d.slice(0, 7)}-01`; m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const tInv = tally(inv.map((r) => r.invoice_date)), tPay = tally(pay.map((r) => r.payment_date)), tExp = tally(exp.map((r) => r.expense_date));
  const tPs = tally(ps.map((r) => r.period_month)), tAdv = tally(adv.map((r) => r.advance_date)), tChq = tally(chq.map((r) => r.cheque_date));
  return monthList.map((iso) => {
    const p = pMap.get(iso);
    const c = { invoices: tInv.get(iso) ?? 0, payments: tPay.get(iso) ?? 0, expenses: tExp.get(iso) ?? 0, payslips: tPs.get(iso) ?? 0, advances: tAdv.get(iso) ?? 0, cheques: tChq.get(iso) ?? 0 };
    return { period_month: iso, label: monthName(iso.slice(0, 7)), ...c, total: Object.values(c).reduce((a, b) => a + b, 0),
      closed_at: p?.closed_at ?? null, closed_by_name: p?.closed_by ? prof.get(p.closed_by) ?? null : null, note: p?.note ?? null, period_id: p?.id ?? null };
  });
}
export const closePeriod = (periodMonth: string, profileId: string | null, note: string) =>
  q(sb().from("accounting_periods").insert({ period_month: periodMonth, closed_by: profileId, note: note.trim() || null } as never));
export const reopenPeriod = (periodId: string) => q(sb().from("accounting_periods").delete().eq("id", periodId));

// -------------------------------------------------------------------- Treasury
export async function loadTreasury(companyId: string) {
  const s = sb();
  const [branches, cockpit, danger, reserves, pnl, entitlements, interregion, forecast, capital, custody] = await Promise.all([
    q<any[]>(s.from("branches").select("*").eq("company_id", companyId).order("is_head_office", { ascending: false }).order("name")),
    q<any>(s.from("cash_cockpit").select("*").eq("company_id", companyId).maybeSingle()),
    q<any>(s.from("danger_level").select("*").eq("company_id", companyId).maybeSingle()),
    q<any[]>(s.from("reserve_status").select("*").eq("company_id", companyId)),
    q<any[]>(s.from("regional_pnl_monthly").select("*").eq("company_id", companyId).order("period_month", { ascending: false })),
    q<any[]>(s.from("cash_entitlements").select("*").eq("company_id", companyId)),
    q<any[]>(s.from("interregion_transactions").select("*").eq("company_id", companyId).order("txn_date", { ascending: false })),
    rpc<any[]>("cash_forecast", { p_company_id: companyId, p_weeks: 13 }),
    q<any[]>(s.from("partner_capital_balances").select("*").eq("company_id", companyId)),
    q<any[]>(s.from("cash_location_balances").select("*").eq("company_id", companyId)),
  ]);
  return { branches, cockpit, danger, reserves, pnl, entitlements, interregion, forecast: (forecast ?? []) as any[], capital, custody };
}
export const runHoAllocation = (companyId: string, period: string) => rpc("run_ho_cost_allocation", { p_company_id: companyId, p_period: period });
export const accrueBonusReserve = (companyId: string, period: string) => rpc("accrue_bonus_reserve", { p_company_id: companyId, p_period: period });
export const mirrorDepreciation = (companyId: string, period: string) => rpc("mirror_depreciation_to_reserve", { p_company_id: companyId, p_period: period });
export const fundReserve = (companyId: string, type: string, amount: number) => rpc("fund_reserve", { p_company_id: companyId, p_type: type, p_amount: amount });
export const requestInterregionFunding = (companyId: string, lender: string, borrower: string, amount: number) =>
  rpc("request_approval", { p_company_id: companyId, p_action_key: "interregion_funding", p_ref_table: "interregion_transactions", p_ref_id: uuid(), p_amount: amount, p_payload: { lender, borrower } });

// ----------------------------------------------- Regional operating expenses
export async function loadRegionalOpex(companyId: string, period: string) {
  const monthStart = `${period}-01`;
  const monthEnd = lastOfMonthKey(period);
  const [pl, opex, scorecard, cs] = await Promise.all([
    rpc<any[]>("regional_pl", { p_month: monthStart }),
    rpc<any[]>("operating_expense_detail", { p_month: monthStart }),
    q<any[]>(sb().from("regional_scorecard").select("branch_id, region_name, active_headcount, incidents_ytd, no_shows_30d, receivables_outstanding, profit_ytd, profit_prior_year").eq("company_id", companyId).order("region_name")),
    rpc<any[]>("client_statement_loaded", { p_start: monthStart, p_end: monthEnd, p_basis: "revenue" }),
  ]);
  return { pl: (pl ?? []) as any[], opex: (opex ?? []) as any[], scorecard, clientStmt: (cs ?? []) as any[] };
}

// -------------------------------------------------------------------- Partners
export const PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "FUEL_CARD", "CHEQUE"] as const;
export async function loadPartners(companyId: string) {
  const [partners, branches] = await Promise.all([
    q<any[]>(sb().from("partners").select("*").eq("company_id", companyId).order("name")),
    q<any[]>(sb().from("branches").select("id, name").eq("company_id", companyId).order("name")),
  ]);
  return { partners, branches };
}
export async function loadPartnerStatement(partnerId: string, from: string, to: string) {
  let qb = sb().from("partner_account_entries").select("*").eq("partner_id", partnerId).order("date").order("created_at");
  if (from) qb = qb.gte("date", from);
  if (to) qb = qb.lte("date", to);
  return q<any[]>(qb);
}
export async function loadPartnerSummary(partners: any[]) {
  const map = new Map<string, { allocated: number; drawn: number; contributed: number; balance: number }>();
  await Promise.all(partners.map(async (p) => {
    const rows = ((await rpc<any[]>("partner_ledger", { p_partner_id: p.id, p_start: null, p_end: null })) ?? []) as any[];
    const allocated = rows.reduce((s2, r) => s2 + Number(r.remuneration ?? 0), 0);
    const cash = rows.reduce((s2, r) => s2 + Number(r.cash_paid ?? 0), 0);
    map.set(p.id, { allocated, drawn: cash > 0 ? cash : 0, contributed: cash < 0 ? -cash : 0, balance: rows.length > 0 ? Number(rows[rows.length - 1].balance ?? 0) : Number(p.opening_balance) });
  }));
  return map;
}
export type PartnerForm = { name: string; scope: "COMPANY" | "BRANCH"; branch_id: string; allocation_method: "FIXED_PCT" | "MANUAL"; default_share_pct: string; opening_balance: string; opening_balance_date: string; is_active: boolean };
export async function savePartner(companyId: string, editing: any | null, f: PartnerForm) {
  const payload: Record<string, unknown> = {
    company_id: companyId, name: f.name.trim(), scope: f.scope, branch_id: f.scope === "BRANCH" && f.branch_id ? f.branch_id : null,
    allocation_method: f.allocation_method, default_share_pct: f.default_share_pct ? parseFloat(f.default_share_pct) : null,
    opening_balance: parseFloat(f.opening_balance) || 0, opening_balance_date: f.opening_balance_date || null,
    opening_balance_locked: editing?.opening_balance_locked ?? false, is_active: f.is_active,
  };
  if (editing) {
    delete payload.default_share_pct;
    if (editing.opening_balance_locked) { delete payload.opening_balance; delete payload.opening_balance_date; }
    await q(sb().from("partners").update(payload as never).eq("id", editing.id));
  } else {
    await q(sb().from("partners").insert({ ...payload, profit_share_percent: parseFloat(f.default_share_pct) || 0 } as never));
  }
}
export async function addPartnerEntry(companyId: string, partnerId: string, type: "DRAWING" | "CONTRIBUTION", f: { date: string; amount: string; payment_method: string; description: string }, profileId: string | null) {
  const amt = parseFloat(f.amount);
  if (isNaN(amt) || amt <= 0) throw new Error("Enter a valid amount");
  await q(sb().from("partner_account_entries").insert({
    company_id: companyId, partner_id: partnerId, date: f.date, type, description: f.description || (type === "DRAWING" ? "Drawing" : "Contribution"),
    amount: amt, payment_method: f.payment_method, created_by: profileId,
  } as never));
}

// ------------------------------------------------------------ Partnership run
export async function loadPartnershipRun(companyId: string, period: string) {
  const month = `${period}-01`;
  const [run, blocker, review, uninvoiced, due] = await Promise.all([
    q<any>(sb().from("profit_allocation_runs").select("id, period_month, status, basis, total_profit, regional_total, equity_total, posted_at, reversed_at, outputs").eq("company_id", companyId).eq("period_month", month).maybeSingle()),
    rpc<string | null>("partnership_run_blocker", { p_company_id: companyId, p_period: month }),
    rpc<any[]>("profit_allocation_review", { p_company_id: companyId, p_period: month }),
    rpc<any[]>("partnership_uninvoiced_clients", { p_company_id: companyId, p_period: month }),
    rpc<any[]>("partnership_posting_deadline", { p_company_id: companyId, p_period: month }),
  ]);
  const pts = await q<any[]>(sb().from("partners").select("id").eq("company_id", companyId).eq("is_active", true));
  const positions = new Map<string, { agency: number; remuneration: number; balance: number }>();
  await Promise.all(pts.map(async (pt) => {
    const rows = ((await rpc<any[]>("partner_ledger", { p_partner_id: pt.id, p_start: null, p_end: null })) ?? []) as any[];
    positions.set(pt.id, {
      agency: rows.reduce((n, x) => n + Number(x.cash_paid ?? 0), 0),
      remuneration: rows.reduce((n, x) => n + Number(x.remuneration ?? 0), 0),
      balance: rows.length ? Number(rows[rows.length - 1].balance ?? 0) : 0,
    });
  }));
  return { run, blocker: blocker ?? null, review: (review ?? []) as any[], uninvoiced: (uninvoiced ?? []) as any[], deadline: ((due ?? []) as any[])[0] ?? null, positions };
}
export const draftProfitAllocation = (companyId: string, period: string) => rpc("draft_profit_allocation", { p_company_id: companyId, p_period: `${period}-01`, p_basis: null });
/** post_profit_allocation; returns `needsConfirm` with the message when the DB asks to confirm an incomplete month. */
export async function postProfitAllocation(runId: string, confirmIncomplete: boolean): Promise<{ needsConfirm?: string }> {
  const { error } = await sb().rpc("post_profit_allocation" as never, { p_run_id: runId, p_confirm_incomplete: confirmIncomplete } as never);
  if (error) {
    if ((error as { hint?: string }).hint === "Confirm to proceed." && !confirmIncomplete) return { needsConfirm: error.message };
    throw new Error(error.message);
  }
  return {};
}
export const reverseProfitAllocation = (runId: string) => rpc("reverse_profit_allocation", { p_run_id: runId });
export const REVIEW_KINDS: Record<string, { title: string; note: string }> = {
  client_cost_no_invoice: { title: "Cost booked, nothing billed", note: "Their cost is in the pool and their revenue is not, so every partner's share is understated." },
  client_negative_net: { title: "Client is net negative for the month", note: "Not necessarily wrong — a month of costs against a client billed elsewhere looks like this." },
  unallocated_pool: { title: "A pool reached no region", note: "Head office cost with no revenue base to apportion it against. It is sitting unallocated." },
  partner_negative_total: { title: "Partner's total is negative", note: "A9 permits this with no floor; it reduces the partner's capital account." },
};

// ----------------------------------------------------------- Project financing
export const ENTRY_TYPES = ["CAPITAL_IN", "CAPITAL_REPAYMENT", "RETURN_ALLOCATION", "RETURN_PAYOUT", "FINANCE_COST_ACCRUAL", "FINANCE_COST_PAYMENT"] as const;
export async function loadProjects(companyId: string) {
  const s = sb();
  const [clients, partners, cashLocs, projects, investors, investments, ledger] = await Promise.all([
    q<any[]>(s.from("clients").select("id, name").eq("company_id", companyId).eq("is_active", true).order("name")),
    q<any[]>(s.from("partners").select("id, name").eq("company_id", companyId).eq("is_active", true).order("name")),
    q<any[]>(s.from("cash_locations").select("id, name").eq("company_id", companyId).eq("is_active", true).order("name")),
    q<any[]>(s.from("finance_projects").select("*").eq("company_id", companyId).order("created_at", { ascending: false })),
    q<any[]>(s.from("finance_investors").select("*").eq("company_id", companyId).order("name")),
    q<any[]>(s.from("project_investments").select("*").eq("company_id", companyId)),
    q<any[]>(s.from("investor_ledger_entries").select("*").eq("company_id", companyId).order("date", { ascending: false })),
  ]);
  return { clients, partners, cashLocs, projects, investors, investments, ledger };
}
export async function saveProject(companyId: string, editingId: string | null, f: { name: string; client_id: string; total_required: string; reserved_profit_pct: string; payout_gate: string; status: string; notes: string }) {
  const payload = { company_id: companyId, name: f.name.trim(), client_id: f.client_id || null, total_required: parseFloat(f.total_required) || 0, reserved_profit_pct: parseFloat(f.reserved_profit_pct) || 0, payout_gate: f.payout_gate, status: f.status, notes: f.notes || null };
  if (editingId) await q(sb().from("finance_projects").update(payload as never).eq("id", editingId));
  else await q(sb().from("finance_projects").insert(payload as never));
}
export async function saveInvestor(companyId: string, editingId: string | null, f: { name: string; type: "PARTNER" | "THIRD_PARTY"; linked_partner_id: string; is_active: boolean }) {
  const payload = { company_id: companyId, name: f.name.trim(), type: f.type, linked_partner_id: f.type === "PARTNER" && f.linked_partner_id ? f.linked_partner_id : null, is_active: f.is_active };
  if (editingId) await q(sb().from("finance_investors").update(payload as never).eq("id", editingId));
  else await q(sb().from("finance_investors").insert(payload as never));
}
export const addInvestment = (companyId: string, projectId: string, f: { investor_id: string; return_type: "PROFIT_SHARE" | "FIXED_FINANCE"; committed_amount: string; fixed_cost_amount: string }) =>
  q(sb().from("project_investments").insert({
    company_id: companyId, project_id: projectId, investor_id: f.investor_id, return_type: f.return_type, committed_amount: parseFloat(f.committed_amount) || 0,
    fixed_cost_amount: f.return_type === "FIXED_FINANCE" && f.fixed_cost_amount ? parseFloat(f.fixed_cost_amount) : null,
  } as never));
export const addLedgerEntry = (companyId: string, f: { investor_id: string; project_id: string; date: string; type: string; amount: string; description: string; cash_location_id: string }, profileId: string | null) =>
  q(sb().from("investor_ledger_entries").insert({
    company_id: companyId, investor_id: f.investor_id, project_id: f.project_id, date: f.date, type: f.type, amount: parseFloat(f.amount),
    description: f.description || null, cash_location_id: f.cash_location_id || null, created_by: profileId,
  } as never));

// ------------------------------------------------------------------- Cash flow
const isoDay = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);
export async function loadCashflow(regionId: string | null) {
  const s = sb();
  const reg = <T,>(qb: T) => (regionId ? (qb as any).eq("branch_id", regionId) : qb) as T;
  const [payments, payslips, expenses, advances, cheques, clients, employees, categories, branches] = await Promise.all([
    q<any[]>(reg(s.from("invoice_payments").select("id, amount, payment_date, client_id, payment_mode"))),
    q<any[]>(reg(s.from("payslips").select("*, employee:employee_id(category, branch_id)").eq("disbursed", true))),
    q<any[]>(reg(s.from("expenses").select("*"))),
    q<any[]>(reg(s.from("advances").select("amount, advance_date, payment_mode, cheque_id, employee_id"))),
    q<any[]>(reg(s.from("cheques").select("id, status, cleared_at"))),
    q<any[]>(s.from("clients").select("*").order("name")),
    q<any[]>(s.from("employees").select("id, full_name, branch_id")),
    q<any[]>(s.from("expense_categories").select("*")),
    q<any[]>(s.from("branches").select("*").order("is_head_office", { ascending: false }).order("name")),
  ]);
  return { payments, payslips, expenses, advances, cheques, clients, employees, categories, branches };
}
export type CashData = Awaited<ReturnType<typeof loadCashflow>>;

/** The web cashPl memo: the cash-basis statement for one month and branch filter. */
export function cashStatement(d: CashData, monthKey: string, branchFilter: string) {
  const inPeriod = (date: string) => date.slice(0, 7) === monthKey;
  const branchOk = (bid: string | null) => branchFilter === "all" || bid === branchFilter;
  const chequeById = new Map(d.cheques.map((c) => [c.id, c]));
  const clearedDay = (id: string | null) => { const c = id ? chequeById.get(id) : null; return c && c.status === "cleared" ? isoDay(c.cleared_at) : null; };
  const clientType = new Map(d.clients.map((c) => [c.id, c.client_type ?? "security_services"]));
  const clientBranch = new Map(d.clients.map((c) => [c.id, c.branch_id ?? null]));
  const catName = new Map(d.categories.map((c) => [c.id, c.name]));
  const employeeBranch = new Map(d.employees.map((e) => [e.id, e.branch_id ?? null]));
  const headOfficeId = d.branches.find((b) => b.is_head_office)?.id ?? null;
  let securityRevenue = 0, guardRevenue = 0;
  for (const p of d.payments) {
    const date = isoDay(p.payment_date);
    if (!date || !inPeriod(date)) continue;
    if (!branchOk(p.client_id ? clientBranch.get(p.client_id) ?? null : null)) continue;
    const amt = Number(p.amount ?? 0);
    if ((p.client_id ? clientType.get(p.client_id) : "security_services") === "guard_deployment") guardRevenue += amt; else securityRevenue += amt;
  }
  const totalRevenue = securityRevenue + guardRevenue;
  let guardPayroll = 0, officePayroll = 0;
  for (const p of d.payslips) {
    const date = p.payment_mode === "Cheque" ? clearedDay(p.cheque_id) : isoDay(p.disbursed_at ?? p.period_month);
    if (!date || !inPeriod(date)) continue;
    if (!branchOk(p.employee?.branch_id ?? employeeBranch.get(p.employee_id) ?? null)) continue;
    const amt = Number(p.net_salary ?? 0);
    if (p.employee?.category === "office_staff") officePayroll += amt; else guardPayroll += amt;
  }
  let cosStatutory = 0, cosTransport = 0, cosEquipment = 0, cosOther = 0, opUtilities = 0, opInsurance = 0, opLicenses = 0, opOther = 0, taxes = 0;
  for (const e of d.expenses) {
    let date: string | null = null;
    if (e.payment_mode === "Cash" || e.payment_mode === "Bank") date = isoDay(e.expense_date);
    else if (e.payment_mode === "Cheque") date = clearedDay(e.cheque_id);
    else if (e.payment_mode === "Payable" && e.payable_status === "Paid") date = isoDay(e.paid_at);
    if (!date || !inPeriod(date)) continue;
    if (!branchOk(e.client_id ? clientBranch.get(e.client_id) ?? null : headOfficeId)) continue;
    const name = (e.category_id ? catName.get(e.category_id) : "") ?? "";
    const amt = Number(e.amount ?? 0);
    if (name === "Taxes") { taxes += amt; continue; }
    if (name === "Equipment & Supplies") { cosEquipment += amt; continue; }
    if (name === "Transportation & Fuel") { cosTransport += amt; continue; }
    if (name === "EOBI" || name === "IESSI" || name === "PESSI") { cosStatutory += amt; continue; }
    if (name === "Weapons & Ammunition" || name === "Uniform") { cosOther += amt; continue; }
    if (name === "Utilities & Rent") { opUtilities += amt; continue; }
    if (name === "Insurance") { opInsurance += amt; continue; }
    if (name === "Licenses") { opLicenses += amt; continue; }
    if (e.pl_category === "cost_of_services") cosOther += amt; else opOther += amt;
  }
  const totalCos = guardPayroll + cosStatutory + cosTransport + cosEquipment + cosOther;
  const grossProfit = totalRevenue - totalCos;
  const totalOpex = officePayroll + opUtilities + opInsurance + opLicenses + opOther;
  const operatingProfit = grossProfit - totalOpex;
  const netProfit = operatingProfit - taxes;
  let advancesPaid = 0;
  for (const a of d.advances) {
    const date = a.payment_mode === "Cheque" ? clearedDay(a.cheque_id) : isoDay(a.advance_date);
    if (!date || !inPeriod(date)) continue;
    if (!branchOk(employeeBranch.get(a.employee_id) ?? null)) continue;
    advancesPaid += Number(a.amount ?? 0);
  }
  return {
    securityRevenue, guardRevenue, totalRevenue, guardPayroll, cosStatutory, cosTransport, cosEquipment, cosOther, totalCos, grossProfit,
    officePayroll, opUtilities, opInsurance, opLicenses, opOther, totalOpex, operatingProfit, ebt: operatingProfit, taxes, netProfit, advancesPaid, netCashChange: netProfit - advancesPaid,
  };
}

/** The Client Statements (cash basis) tab: payroll_cash_by_client + client_statement_loaded (cash and revenue). */
export async function loadCashClientStatements(d: CashData, period: string) {
  const start = `${period}-01`, end = lastOfMonthKey(period);
  const [pay, loaded, loadedRev] = await Promise.all([
    rpc<any[]>("payroll_cash_by_client", { p_start: start, p_end: end }),
    rpc<any[]>("client_statement_loaded", { p_start: start, p_end: end, p_basis: "cash" }),
    rpc<any[]>("client_statement_loaded", { p_start: start, p_end: end, p_basis: "revenue" }),
  ]);
  const payroll = new Map(((pay ?? []) as any[]).map((r) => [r.client_id, Number(r.cost) || 0]));
  const revOverhead = new Map(((loadedRev ?? []) as any[]).map((r) => [r.client_id, Number(r.regional_overhead) || 0]));
  const within = (x: string | null) => !!x && x >= start && x <= end;
  const chequeById = new Map(d.cheques.map((c) => [c.id, c]));
  const clearedDay = (id: string | null) => { const c = id ? chequeById.get(id) : null; return c && c.status === "cleared" ? isoDay(c.cleared_at) : null; };
  const receivedBy = new Map<string, number>();
  const paymentsBy = new Map<string, { id: string; date: string; amount: number; mode: string | null }[]>();
  for (const p of d.payments) {
    const date = isoDay(p.payment_date);
    if (!within(date) || !p.client_id) continue;
    const amt = Number(p.amount ?? 0);
    receivedBy.set(p.client_id, (receivedBy.get(p.client_id) ?? 0) + amt);
    paymentsBy.set(p.client_id, [...(paymentsBy.get(p.client_id) ?? []), { id: p.id, date: date!, amount: amt, mode: p.payment_mode ?? null }]);
  }
  const expensesBy = new Map<string, number>();
  for (const e of d.expenses) {
    if (!e.client_id) continue;
    let date: string | null = null;
    if (e.payment_mode === "Cash" || e.payment_mode === "Bank") date = isoDay(e.expense_date);
    else if (e.payment_mode === "Cheque") date = clearedDay(e.cheque_id);
    else if (e.payment_mode === "Payable" && e.payable_status === "Paid") date = isoDay(e.paid_at);
    if (!within(date)) continue;
    expensesBy.set(e.client_id, (expensesBy.get(e.client_id) ?? 0) + Number(e.amount ?? 0));
  }
  const byId = new Map(((loaded ?? []) as any[]).map((r) => [r.client_id, r]));
  return d.clients.map((c) => {
    const l = byId.get(c.id);
    return {
      client: c, received: Number(l?.revenue ?? receivedBy.get(c.id) ?? 0), payrollPaid: Number(l?.direct_payroll ?? payroll.get(c.id) ?? 0),
      expensesPaid: Number(l?.direct_expenses ?? expensesBy.get(c.id) ?? 0), regionalOverhead: revOverhead.get(c.id) ?? 0, hoShare: Number(l?.ho_share ?? 0),
      netCash: Number(l?.net ?? 0), branchId: (l?.branch_id ?? c.branch_id ?? null) as string | null, regionName: (l?.region_name ?? "Unassigned") as string,
      payments: (paymentsBy.get(c.id) ?? []).sort((a, b) => b.date.localeCompare(a.date)),
    };
  });
}

// ------------------------------------------------------------ Financial reports
export async function loadPl(period: string) {
  const start = `${period}-01`, end = lastOfMonthKey(period);
  const [inv, ps, exp] = await Promise.all([
    q<any[]>(sb().from("invoices").select("invoice_amount, invoice_date, period_start, client:client_id(client_type, branch_id)").or(invoicePeriodFilter(start, end))),
    q<any[]>(sb().from("payslips").select("final_salary, employee:employee_id(branch_id, category)").eq("period_month", start)),
    q<any[]>(sb().from("expenses").select("amount, expense_date, category_id, client_id, pl_category, category:category_id(name), client:client_id(branch_id)").gte("expense_date", start).lte("expense_date", end)),
  ]);
  return { inv, ps, exp };
}
export async function allocatedHoFor(companyId: string, period: string, branchId: string) {
  const rows = ((await rpc<any[]>("ho_exclusion_preview", { p_company_id: companyId, p_period: `${period}-01`, p_excluded: null })) ?? []) as any[];
  const row = rows.find((r) => r.branch_id === branchId);
  return row ? Number(row.absorbs_now) : 0;
}
/** The web plFigures memo. */
export function plFigures(d: Awaited<ReturnType<typeof loadPl>>, branchFilter: string, headOfficeId: string | null, allocatedHo: number) {
  const isHo = branchFilter === headOfficeId;
  const branchOk = (bid: string | null | undefined) => (branchFilter === "all" ? true : bid === branchFilter);
  let securityRevenue = 0, guardRevenue = 0;
  for (const i of d.inv) { if (!branchOk(i.client?.branch_id)) continue; const amt = Number(i.invoice_amount); if ((i.client?.client_type ?? "security_services") === "guard_deployment") guardRevenue += amt; else securityRevenue += amt; }
  const totalRevenue = securityRevenue + guardRevenue;
  let guardPayroll = 0, officePayroll = 0;
  for (const p of d.ps) { if (!branchOk(p.employee?.branch_id)) continue; const amt = Number(p.final_salary); if (p.employee?.category === "office_staff") officePayroll += amt; else guardPayroll += amt; }
  let cosStatutory = 0, cosTransport = 0, cosEquipment = 0, cosOther = 0, opUtilities = 0, opInsurance = 0, opLicenses = 0, opOther = 0, taxes = 0;
  for (const e of d.exp) {
    if (branchFilter !== "all") { if (!e.client_id) { if (!isHo) continue; } else if (e.client?.branch_id !== branchFilter) continue; }
    const name = e.category?.name ?? "";
    const amt = Number(e.amount);
    if (name === "Taxes") { taxes += amt; continue; }
    if (name === "Equipment & Supplies") { cosEquipment += amt; continue; }
    if (name === "Transportation & Fuel") { cosTransport += amt; continue; }
    if (name === "EOBI" || name === "IESSI" || name === "PESSI") { cosStatutory += amt; continue; }
    if (name === "Weapons & Ammunition" || name === "Uniform") { cosOther += amt; continue; }
    if (name === "Utilities & Rent") { opUtilities += amt; continue; }
    if (name === "Insurance") { opInsurance += amt; continue; }
    if (name === "Licenses") { opLicenses += amt; continue; }
    if (e.pl_category === "cost_of_services") cosOther += amt; else opOther += amt;
  }
  const totalCos = guardPayroll + cosStatutory + cosTransport + cosEquipment + cosOther;
  const grossProfit = totalRevenue - totalCos;
  const totalOpex = officePayroll + opUtilities + opInsurance + opLicenses + opOther + allocatedHo;
  const operatingProfit = grossProfit - totalOpex;
  return { securityRevenue, guardRevenue, totalRevenue, guardPayroll, cosStatutory, cosTransport, cosEquipment, cosOther, totalCos, grossProfit,
    officePayroll, opUtilities, opInsurance, opLicenses, opOther, allocatedHo, totalOpex, operatingProfit, ebt: operatingProfit, taxes, netProfit: operatingProfit - taxes };
}
export async function loadClientStatements(period: string) {
  const start = `${period}-01`, end = lastOfMonthKey(period);
  const [clients, invoices, loaded] = await Promise.all([
    q<any[]>(sb().from("clients").select("*").order("name")),
    q<any[]>(sb().from("invoices").select("*").or(invoicePeriodFilter(start, end))),
    rpc<any[]>("client_statement_loaded", { p_start: start, p_end: end, p_basis: "revenue" }),
  ]);
  const byId = new Map(((loaded ?? []) as any[]).map((r) => [r.client_id, r]));
  return clients.map((c) => {
    const l = byId.get(c.id);
    return {
      ...c, total_invoiced: Number(l?.revenue ?? 0), payroll_expense: Number(l?.direct_payroll ?? 0), expenses: Number(l?.direct_expenses ?? 0),
      regional_overhead: Number(l?.regional_overhead ?? 0), ho_share: Number(l?.ho_share ?? 0), total_income: Number(l?.net ?? 0),
      invoices: invoices.filter((i) => i.client_id === c.id).sort((a, b) => (a.invoice_date < b.invoice_date ? 1 : -1)),
    };
  });
}
/** RegionalPerformance load(). */
export async function loadRegionalPerformance(companyId: string, period: string, basis: "revenue" | "cash") {
  const start = `${period}-01`;
  const [y, m] = period.split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const [pl, prev, cs, ex] = await Promise.all([
    rpc<any[]>("regional_pl_range", { p_start: start, p_end: end, p_company_id: companyId }),
    rpc<any[]>("ho_exclusion_preview", { p_company_id: companyId, p_period: start, p_excluded: null }),
    rpc<any[]>("client_statement_loaded", { p_start: start, p_end: end, p_basis: basis, p_company_id: companyId }),
    q<any[]>(sb().from("expenses").select("amount, branch_id, client_id, expense_date, payment_mode, payable_status, paid_at, category:expense_categories(name)").eq("company_id", companyId)),
  ]);
  const alloc = new Map<string, { absorbs: number; invoiced: number; excluded: boolean }>();
  for (const r of (prev ?? []) as any[]) alloc.set(r.branch_id, { absorbs: Number(r.absorbs_now ?? 0), invoiced: Number(r.invoiced ?? 0), excluded: !!r.excluded_now });
  const rows: { branch_id: string; region_name: string; revenue: number; own_cost: number; ho_allocated: number; invoiced: number; excluded: boolean }[] = [];
  let hoPool = 0;
  for (const r of (pl ?? []) as any[]) {
    const isHo = !alloc.has(r.branch_id);
    const revenue = basis === "cash" ? Number(r.revenue_cash ?? 0) : Number(r.revenue_accrual ?? 0);
    const payroll = basis === "cash" ? Number(r.payroll_cash ?? 0) : Number(r.payroll_accrual ?? 0);
    const expenses = basis === "cash" ? Number(r.expenses_cash ?? 0) : Number(r.expenses_accrual ?? 0);
    if (isHo) { hoPool += payroll + expenses - revenue; continue; }
    const a = alloc.get(r.branch_id)!;
    rows.push({ branch_id: r.branch_id, region_name: r.region_name ?? "Unassigned", revenue, own_cost: payroll + expenses, ho_allocated: a.absorbs, invoiced: a.invoiced, excluded: a.excluded });
  }
  const inPeriod = (e: any) => {
    if (basis !== "cash") return e.expense_date >= start && e.expense_date <= end;
    const dd = e.payment_mode === "Cash" || e.payment_mode === "Bank" ? e.expense_date : e.payment_mode === "Payable" && e.payable_status === "Paid" ? (e.paid_at ?? "").slice(0, 10) : null;
    return !!dd && dd >= start && dd <= end;
  };
  const hoId = new Set(((pl ?? []) as any[]).map((r) => r.branch_id).filter((id: string) => !alloc.has(id)));
  const categories = new Map<string, Map<string, number>>();
  for (const e of ex) {
    if (!inPeriod(e)) continue;
    const key = hoId.has(e.branch_id) ? "__HO__" : e.branch_id ?? "__NONE__";
    const name = e.category?.name ?? "Uncategorised";
    if (!categories.has(key)) categories.set(key, new Map());
    const mm = categories.get(key)!;
    mm.set(name, (mm.get(name) ?? 0) + Number(e.amount ?? 0));
  }
  return { regions: rows, clients: (cs ?? []) as any[], pool: rows.reduce((s2, r) => s2 + r.ho_allocated, 0) || hoPool, categories };
}
/** ContractedVsDeployed. */
export async function loadCover(month: string) {
  const start = `${month}-01`, end = lastOfMonthKey(month);
  const [cli, con, lines, cost] = await Promise.all([
    q<any[]>(sb().from("clients").select("id, name")),
    q<any[]>(sb().from("contracts").select("id, client_id, status, contract_type")),
    q<any[]>(sb().from("contract_lines").select("contract_id, category, committed_count")),
    rpc<any[]>("payroll_cost_by_client", { p_period_month: start }),
  ]);
  const marks = await fetchAllRows<{ worked_for_client_id: string | null; employee_id: string }>(() =>
    sb().from("attendance_records").select("worked_for_client_id, employee_id").gte("attendance_date", start).lte("attendance_date", end).in("status", ["present", "double_duty", "relief_cover"]) as any);
  const name = new Map(cli.map((c) => [c.id, c.name]));
  const contractClient = new Map<string, string>();
  for (const k of con) if (k.status === "active" && k.contract_type === "guard_deployment") contractClient.set(k.id, k.client_id);
  const contracted = new Map<string, number>();
  for (const l of lines) { const cid = contractClient.get(l.contract_id); if (!cid || !isPersonnelCategory(l.category)) continue; contracted.set(cid, (contracted.get(cid) ?? 0) + (Number(l.committed_count) || 0)); }
  const deployed = new Map<string, Set<string>>();
  for (const r of marks) { if (!r.worked_for_client_id) continue; const s2 = deployed.get(r.worked_for_client_id) ?? new Set<string>(); s2.add(r.employee_id); deployed.set(r.worked_for_client_id, s2); }
  const costBy = new Map(((cost ?? []) as any[]).map((r) => [r.client_id, Number(r.cost) || 0]));
  const ids = new Set<string>([...contracted.keys(), ...deployed.keys(), ...costBy.keys()]);
  return [...ids].map((id) => ({ client_id: id, client_name: name.get(id) ?? "—", contracted: contracted.get(id) ?? 0, deployed: deployed.get(id)?.size ?? 0, cost: costBy.get(id) ?? 0 }))
    .sort((a, b) => (b.deployed - b.contracted) - (a.deployed - a.contracted) || a.client_name.localeCompare(b.client_name));
}

// ------------------------------------------------------- Partnership report
export async function loadPartnershipReport(companyId: string) {
  const [partners, settings, branches] = await Promise.all([
    q<any[]>(sb().from("partners").select("*").order("name")),
    q<any>(sb().from("finance_settings").select("*").eq("company_id", companyId).maybeSingle()),
    q<any[]>(sb().from("branches").select("*").order("is_head_office", { ascending: false }).order("name")),
  ]);
  return { partners, settings, branches };
}
export const deletePartner = (id: string) => q(sb().from("partners").delete().eq("id", id));
export async function savePolicy(companyId: string, basis: "cash" | "revenue", day: number | null) {
  const patch = { partner_remuneration_basis: basis, partnership_posting_day: day, updated_at: new Date().toISOString() };
  const { data, error } = await sb().from("finance_settings").update(patch as never).eq("company_id", companyId).select("company_id");
  if (error) throw new Error(error.message);
  if ((data ?? []).length === 0) await q(sb().from("finance_settings").insert({ company_id: companyId, ...patch } as never));
}
export const postingDeadline = async (companyId: string, period: string) => (((await rpc<any[]>("partnership_posting_deadline", { p_company_id: companyId, p_period: `${period}-01` })) ?? []) as any[])[0] ?? null;
export const partnerClientBreakdown = async (partnerId: string, period: string) =>
  ((await rpc<any[]>("partner_client_breakdown", { p_partner_id: partnerId, p_start: `${period}-01`, p_end: lastOfMonthKey(period) })) ?? []) as any[];
export const setClientShare = (partnerId: string, clientId: string, pct: number, period: string) =>
  q(sb().from("partner_client_shares").upsert({ partner_id: partnerId, client_id: clientId, share_percent: pct, effective_month: `${period}-01` } as never, { onConflict: "partner_id,client_id,effective_month" }));
export const clearClientShare = (partnerId: string, clientId: string, period: string) =>
  q(sb().from("partner_client_shares").delete().eq("partner_id", partnerId).eq("client_id", clientId).eq("effective_month", `${period}-01`));
/** PartnerFormModal submit. */
export async function submitPartnerForm(partner: any | null, f: { name: string; scope: "COMPANY" | "BRANCH"; branchId: string; share: string; opening: string; startMonth: string }, equityShareTotal: number) {
  const pct = Number(f.share);
  if (!f.name.trim()) throw new Error("Enter the partner's name.");
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error("Share must be between 0 and 100.");
  if (f.scope === "BRANCH" && !f.branchId) throw new Error("Pick the region this partner holds a stake in.");
  if (!partner && !f.startMonth) throw new Error("Pick the month this partner starts sharing profit.");
  if (f.scope === "COMPANY") {
    const others = equityShareTotal - (partner && partner.scope !== "BRANCH" ? Number(partner.profit_share_percent) : 0);
    if (others + pct > 100) throw new Error(`Equity shares would exceed 100% (${others}% already allocated).`);
  }
  const payload: Record<string, unknown> = { name: f.name.trim(), scope: f.scope, branch_id: f.scope === "BRANCH" ? f.branchId : null, profit_share_percent: pct };
  if (!partner || !partner.opening_balance_locked) payload.opening_balance = Number(f.opening) || 0;
  if (partner) await q(sb().from("partners").update(payload as never).eq("id", partner.id));
  else await q(sb().from("partners").insert({ ...payload, is_active: true, allocation_method: "FIXED_PCT", start_month: `${f.startMonth}-01` } as never));
}
export const partnerLedger = async (partnerId: string) => ((await rpc<any[]>("partner_ledger", { p_partner_id: partnerId, p_start: "2000-01-01", p_end: "2999-12-31" })) ?? []) as any[];
export async function loadEntryOptions(companyId: string) {
  const [banks, custodians] = await Promise.all([
    q<any[]>(sb().from("bank_accounts").select("id, bank_name, balance").order("bank_name")),
    loadCustodianOptions(companyId).catch(() => [] as CustodianOption[]),
  ]);
  return { banks, custodians };
}
export async function recordPartnerEntry(companyId: string, partnerId: string, f: { date: string; type: "DRAWING" | "CONTRIBUTION"; note: string; amount: string; method: string; paidByEmp: string; bankId: string }, custodians: CustodianOption[]) {
  const amt = Number(f.amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter an amount above zero.");
  const usesBank = f.method === "BANK_TRANSFER" || f.method === "CHEQUE";
  if (f.method === "CASH" && !f.paidByEmp) throw new Error("Choose who paid (cash custodian).");
  if (usesBank && !f.bankId) throw new Error("Choose the bank account.");
  let cashLocationId: string | null = null;
  if (f.method === "CASH") {
    const staff = custodians.find((c) => c.employeeId === f.paidByEmp);
    if (staff) cashLocationId = await ensureCustodianLocation(companyId, staff.employeeId, staff.fullName, staff.kind);
  }
  await rpc("record_partner_entry", { p_partner_id: partnerId, p_date: f.date, p_type: f.type, p_description: f.note.trim(), p_amount: amt, p_method: f.method, p_bank_account_id: usesBank ? f.bankId : null, p_cash_location_id: cashLocationId });
}
export const deletePartnerEntry = (entryId: string) => rpc("delete_partner_entry", { p_entry_id: entryId });
