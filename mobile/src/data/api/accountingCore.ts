// Accounting core (web OpeningBalances, ChartOfAccounts, TrialBalance,
// JournalView). The ledger answers: balances come from trial_balance_for, the
// journal from journal_lines_regional; nothing here adds anything up except
// the trial-balance footer, which is the one stated exception (a footer that
// cannot contradict its table has to be folded from the table).
import { q, rpc, sb } from "./core";

// ----------------------------------------------------------- Chart of accounts
export async function loadCoa(companyId: string, regionId: string | null) {
  const s = sb();
  const [accounts, locs, tb] = await Promise.all([
    q<any[]>(s.from("chart_of_accounts").select("*").order("account_code")),
    q<any[]>(s.from("cash_locations").select("name, location_type, coa_account_id, bank_account_id").eq("company_id", companyId)),
    rpc<any[]>("trial_balance_for", { p_company_id: companyId, p_period: null, p_branch_id: regionId }),
  ]);
  const sub = new Map<string, { name: string; kind: "bank" | "cash" }>();
  for (const r of locs) if (r.coa_account_id) sub.set(r.coa_account_id, { name: r.name, kind: r.bank_account_id ? "bank" : "cash" });
  const balances = new Map<string, { debit: number; credit: number }>();
  for (const r of (tb ?? []) as any[]) balances.set(r.account_id, { debit: Number(r.total_debit), credit: Number(r.total_credit) });
  return { accounts, sub, balances };
}
export type CoaForm = { account_code: string; account_name: string; account_type: string; normal_side: "debit" | "credit"; parent_id: string; active: boolean };
export async function saveAccount(editingId: string | null, f: CoaForm) {
  const payload = { account_code: f.account_code.trim(), account_name: f.account_name.trim(), account_type: f.account_type, normal_side: f.normal_side, parent_id: f.parent_id || null, active: f.active };
  if (editingId) await q(sb().from("chart_of_accounts").update(payload as never).eq("id", editingId));
  else await q(sb().from("chart_of_accounts").insert(payload as never));
}
export async function deleteAccount(a: any) {
  if (a.system_account) throw new Error(`"${a.account_name}" is a system account — deactivate instead.`);
  await q(sb().from("chart_of_accounts").delete().eq("id", a.id));
}

// ----------------------------------------------------------- Opening balances
export async function loadOpeningBatches(companyId: string) {
  const s = sb();
  const [batches, accounts, branches] = await Promise.all([
    q<any[]>(s.from("opening_balance_batches").select("*").eq("company_id", companyId).order("created_at", { ascending: false })),
    q<any[]>(s.from("chart_of_accounts").select("id,account_code,account_name,account_type").eq("company_id", companyId).eq("active", true).order("account_code")),
    q<any[]>(s.from("branches").select("*").eq("company_id", companyId).order("is_head_office", { ascending: false }).order("name")),
  ]);
  return { batches, accounts, branches };
}
export async function loadOpeningLines(batchId: string) {
  const [lines, totals] = await Promise.all([
    q<any[]>(sb().from("opening_balance_lines").select("*").eq("batch_id", batchId)),
    rpc<any>("opening_batch_totals", { p_batch_id: batchId }),
  ]);
  return { lines, totals: Array.isArray(totals) ? totals[0] : totals };
}
export async function createBatch(companyId: string, asOf: string, desc: string) {
  if (!companyId) throw new Error("No company is selected. A Super Super Admin must pick a company with “View as” before opening balances can be entered.");
  const r = await q<{ id: string }>(sb().from("opening_balance_batches").insert({ company_id: companyId, as_of_date: asOf, description: desc } as never).select("id").single());
  return r.id;
}
export const addOpeningLine = (batchId: string, f: { accountId: string; branchId: string; debit: string; credit: string }) =>
  q(sb().from("opening_balance_lines").insert({ batch_id: batchId, account_id: f.accountId, branch_id: f.branchId || null, debit: Number(f.debit) || 0, credit: Number(f.credit) || 0 } as never));
export const removeOpeningLine = (id: string) => q(sb().from("opening_balance_lines").delete().eq("id", id));

/** readOperationalRows: the recorded bank / cash / client openings the batch should seed. */
async function readOperationalRows(companyId: string, accounts: any[]) {
  const [cli, loc] = await Promise.all([
    q<any[]>(sb().from("clients").select("opening_balance").eq("company_id", companyId)),
    q<any[]>(sb().from("cash_locations").select("name, location_type, opening_balance, coa_account_id, bank_accounts(opening_balance)").eq("company_id", companyId)),
  ]);
  const rows: { account_id: string; debit: number; notes: string }[] = [];
  const ar = cli.reduce((s2, c) => s2 + Number(c.opening_balance ?? 0), 0);
  const arAcct = accounts.find((a) => a.account_code === "1100");
  if (ar !== 0 && arAcct) {
    const n = cli.filter((c) => Number(c.opening_balance ?? 0) !== 0).length;
    rows.push({ account_id: arAcct.id, debit: ar, notes: `clients.opening_balance — ${n} client${n === 1 ? "" : "s"}` });
  }
  for (const l of loc) {
    if (!l.coa_account_id) continue;
    const isBank = l.location_type === "BANK";
    const amt = isBank ? Number(l.bank_accounts?.opening_balance ?? 0) : Number(l.opening_balance ?? 0);
    if (amt === 0) continue;
    rows.push({ account_id: l.coa_account_id, debit: amt, notes: `${isBank ? "bank_accounts" : "cash_locations"}.opening_balance — ${l.name}` });
  }
  return rows;
}
export async function prefillFromOperational(companyId: string, batchId: string, accounts: any[]) {
  const rows = await readOperationalRows(companyId, accounts);
  if (rows.length === 0) throw new Error("Nothing to prefill — no bank, cash or client opening balance is recorded yet.");
  const obe = accounts.find((a) => a.account_code === "3200");
  if (!obe) throw new Error("No 3200 Opening Balance Equity account — the batch cannot be balanced automatically.");
  const total = rows.reduce((s2, r) => s2 + r.debit, 0);
  await q(sb().from("opening_balance_lines").insert([
    ...rows.map((r) => ({ batch_id: batchId, account_id: r.account_id, branch_id: null, debit: r.debit, credit: 0, notes: r.notes })),
    { batch_id: batchId, account_id: obe.id, branch_id: null, debit: 0, credit: total, notes: "Balancing entry" },
  ] as never));
}
/** postBatch: refuse a prefilled draft that no longer matches the recorded balances, then post_opening_balances. */
export async function postBatch(companyId: string, batchId: string, lines: any[], accounts: any[]) {
  const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const acctName = new Map(accounts.map((a) => [a.id, `${a.account_code} ${a.account_name}`]));
  const fresh = await readOperationalRows(companyId, accounts);
  const drafted = lines.filter((l) => typeof l.notes === "string" && l.notes && l.notes !== "Balancing entry");
  if (drafted.length > 0) {
    const freshBy = new Map(fresh.map((r) => [r.account_id, r.debit]));
    const draftBy = new Map(drafted.map((l) => [l.account_id as string, Number(l.debit ?? 0)]));
    const changes: string[] = [];
    for (const [acct, amt] of freshBy) {
      const was = draftBy.get(acct);
      if (was === undefined) changes.push(`${acctName.get(acct) ?? acct}: not in the draft, now ${money(amt)}`);
      else if (Math.abs(was - amt) >= 0.005) changes.push(`${acctName.get(acct) ?? acct}: drafted ${money(was)}, now ${money(amt)}`);
    }
    for (const [acct, was] of draftBy) if (!freshBy.has(acct)) changes.push(`${acctName.get(acct) ?? acct}: drafted ${money(was)}, now zero or removed`);
    if (changes.length > 0) throw new Error(`This draft no longer matches the recorded balances, so posting it would seed the wrong opening. Delete the lines and prefill again.\n\n${changes.join("\n")}`);
  }
  await rpc("post_opening_balances", { p_batch_id: batchId });
}

// ------------------------------------------------------------- Trial balance
export async function loadTrialBalance(companyId: string, regionId: string | null, period: string) {
  const [rows, closed, per] = await Promise.all([
    rpc<any[]>("trial_balance_for", { p_company_id: companyId, p_period: period || null, p_branch_id: regionId }),
    q<any[]>(sb().from("accounting_periods").select("period_month, closed_at").eq("company_id", companyId)),
    q<any[]>(sb().from("trial_balance").select("posting_period").eq("company_id", companyId)),
  ]);
  return {
    rows: (rows ?? []) as any[],
    closed: new Set(closed.map((p) => p.period_month as string)),
    periods: [...new Set(per.map((r) => r.posting_period as string))].sort().reverse(),
  };
}

// ------------------------------------------------------------------- Journal
export const JOURNAL_PAGE = 50;
export async function loadJournalMeta(companyId: string) {
  const s = sb();
  const [accounts, clients, partners, per] = await Promise.all([
    q<any[]>(s.from("chart_of_accounts").select("*").eq("company_id", companyId).order("account_code")),
    q<any[]>(s.from("clients").select("id, name").eq("company_id", companyId).order("name")),
    q<any[]>(s.from("partners").select("id, name").eq("company_id", companyId).order("name")),
    q<any[]>(s.from("journal_lines_regional").select("posting_period").eq("company_id", companyId)),
  ]);
  return { accounts, clients, partners, periods: [...new Set(per.map((r) => r.posting_period as string))].sort().reverse() };
}
export type JournalEntryView = {
  id: string; entry_date: string; posting_period: string; description: string | null; source_table: string | null; source_id: string | null;
  manual: boolean; is_reversal: boolean; is_reversed: boolean; region_name: string | null; lines: any[];
};
export async function loadJournalPage(companyId: string, regionId: string | null, f: { period: string; accountId: string; clientId: string; partnerId: string; page: number }) {
  let idq = sb().from("journal_entries").select("id, journal_lines!inner(id)", { count: "exact" }).eq("company_id", companyId)
    .order("entry_date", { ascending: false }).order("id", { ascending: false }).range(f.page * JOURNAL_PAGE, f.page * JOURNAL_PAGE + JOURNAL_PAGE - 1);
  if (f.period) idq = idq.eq("posting_period", f.period);
  if (f.accountId) idq = idq.eq("journal_lines.account_id", f.accountId);
  if (f.clientId) idq = idq.eq("journal_lines.client_id", f.clientId);
  if (f.partnerId) idq = idq.eq("journal_lines.partner_id", f.partnerId);
  if (regionId) idq = idq.eq("journal_lines.branch_id", regionId);
  const { data: idRows, error, count } = await idq;
  if (error) throw new Error(error.message);
  const ids = ((idRows ?? []) as { id: string }[]).map((r) => r.id);
  const hasMore = (count ?? 0) > (f.page + 1) * JOURNAL_PAGE;
  if (ids.length === 0) return { entries: [] as JournalEntryView[], hasMore };
  const lines = await q<any[]>(sb().from("journal_lines_regional").select("*").in("journal_entry_id", ids));
  const m = new Map<string, JournalEntryView>();
  for (const l of lines) {
    let e = m.get(l.journal_entry_id);
    if (!e) {
      e = { id: l.journal_entry_id, entry_date: l.entry_date, posting_period: l.posting_period, description: l.description, source_table: l.source_table, source_id: l.source_id,
        manual: l.manual, is_reversal: l.is_reversal, is_reversed: l.is_reversed, region_name: l.region_name, lines: [] };
      m.set(l.journal_entry_id, e);
    }
    e.lines.push(l);
  }
  for (const e of m.values()) e.lines.sort((a, b) => Number(b.debit) - Number(a.debit));
  const entries = [...m.values()].sort((a, b) => (a.entry_date !== b.entry_date ? (a.entry_date < b.entry_date ? 1 : -1) : a.id < b.id ? 1 : -1));
  return { entries, hasMore };
}
export async function postManualJournal(f: { entry_date: string; description: string; debit_account_id: string; credit_account_id: string; amount: string }, regionId: string | null) {
  const amt = Number(f.amount);
  if (!amt || amt <= 0) throw new Error("Enter a positive amount.");
  if (!f.debit_account_id || !f.credit_account_id) throw new Error("Select both a debit and a credit account.");
  if (f.debit_account_id === f.credit_account_id) throw new Error("Debit and credit accounts must differ.");
  await rpc("post_manual_journal", {
    p_entry_date: f.entry_date, p_description: f.description.trim() || "Manual adjustment", p_debit_account_id: f.debit_account_id,
    p_credit_account_id: f.credit_account_id, p_amount: amt, p_branch_id: regionId,
  });
}
