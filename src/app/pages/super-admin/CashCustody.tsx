import ThemedSelect from "../../components/ThemedSelect";
import { useEffect, useMemo, useState } from "react";
import { Pencil, Trash2, AlertCircle, X, Loader2, Wallet, Building2 } from "lucide-react";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

// Rendered as the "Cash Custody" tab inside Banks & Ledgers (Accounting.tsx).
// Self-contained: no page Header — the action buttons live in an inline toolbar.

const fmt = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;
const today = () => new Date().toISOString().slice(0, 10);

type CashLocation = {
  id: string;
  name: string;
  location_type: "BANK" | "PETTY_CASH" | "CUSTODIAN";
  custodian_partner_id: string | null;
  custodian_user_id: string | null;
  // Office-staff custodian who physically holds this cash (0135). The task's
  // custodian = an office-staff employee; partner-held locations kept for legacy.
  custodian_employee_id: string | null;
  opening_balance: number;
  branch_id: string | null;
  is_active: boolean;
  bank_account_id: string | null;
};

type OfficeStaff = { id: string; full_name: string };

type CustodyTransfer = {
  id: string;
  date: string;
  from_location_id: string | null;
  to_location_id: string | null;
  amount: number;
  notes: string | null;
  created_at: string;
};

type Partner = {
  id: string;
  name: string;
  scope: "COMPANY" | "BRANCH";
  branch_id: string | null;
  opening_balance: number;
  is_active: boolean;
};
type Branch = { id: string; name: string };
type BankAccountLite = { id: string; bank_name: string; account_number: string | null; balance: number; active: boolean };
type PartnerStats = { allocated: number; drawn: number; contributed: number; balance: number };

type LocationWithBalance = CashLocation & { balance: number };

// One row of a custodian's cash ledger (Transactions tab) — mirrors the Bank
// Accounts transaction log: date, what happened, cash in / cash out.
type LedgerEntry = {
  id: string;
  date: string;
  locationId: string;          // the custodian location this row belongs to
  employeeId: string | null;   // office-staff holder (for the filter)
  kind: "cheque_cashed" | "bank_to_cash" | "transfer_in" | "transfer_out" | "cash_received" | "cash_paid";
  detail: string;
  cashIn: number;
  cashOut: number;
  before: number;  // this custodian's held cash before/after the entry
  after: number;
};

const LEDGER_KIND_LABEL: Record<LedgerEntry["kind"], string> = {
  cheque_cashed: "Cheque cashed",
  bank_to_cash: "Bank → cash",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
  cash_received: "Cash received",
  cash_paid: "Cash paid",
};

export function CashCustodyPanel({ onReady, onSummary }: {
  onReady?: (api: { addLocation: () => void; recordTransfer: () => void; openTransactions: () => void }) => void;
  // Push the three summary figures up so the page can render the cards above the
  // tab bar (same slot as the Bank Accounts cards). Presentation only.
  onSummary?: (s: { totalCash: number; totalPartnerOwed: number; freeCash: number }) => void;
} = {}) {
  const { profile } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? null;
  // Only a (super) admin may delete a custodian added by mistake.
  const canDelete = profile?.role === "super_admin" || profile?.role === "super_super_admin";
  // Branch-scoped (regional partner) logins see only their own branch's partners;
  // company-wide roles (no branch) see everyone. SSA viewing a company is company-wide.
  const branchScope = profile?.role === "super_super_admin" ? null : (profile?.branch_id ?? null);

  // Transactions is a header-button modal (mirrors the Bank Accounts "Transaction Log"), not a sub-tab.
  const [isTxOpen, setIsTxOpen] = useState(false);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerStaffFilter, setLedgerStaffFilter] = useState<string>("all");
  const [ledgerMonth, setLedgerMonth] = useState<string>("all");
  const [locations, setLocations] = useState<CashLocation[]>([]);
  const [transfers, setTransfers] = useState<CustodyTransfer[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [banks, setBanks] = useState<BankAccountLite[]>([]);
  const [cashInHand, setCashInHand] = useState<number>(0);
  const [officeStaff, setOfficeStaff] = useState<OfficeStaff[]>([]);
  // Cash attributed to each custodian location: client payments received (in) and
  // expenses paid (out), summed per custodian_location_id (0135).
  const [cashInByLoc, setCashInByLoc] = useState<Map<string, number>>(new Map());
  const [cashOutByLoc, setCashOutByLoc] = useState<Map<string, number>>(new Map());
  // Cleared cash cheques handed to each custodian (cash they now hold).
  const [chequeInByLoc, setChequeInByLoc] = useState<Map<string, number>>(new Map());
  // Bank→custodian withdrawals attributed to each custodian location.
  const [withdrawInByLoc, setWithdrawInByLoc] = useState<Map<string, number>>(new Map());
  // Payroll paid in cash by each custodian (signed cash_delta; negative = paid out).
  const [payrollCashByLoc, setPayrollCashByLoc] = useState<Map<string, number>>(new Map());
  const [partnerStats, setPartnerStats] = useState<Map<string, PartnerStats>>(new Map());
  const [investorLiabilities, setInvestorLiabilities] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add/Edit Location modal
  const [isLocOpen, setIsLocOpen] = useState(false);
  const [editLoc, setEditLoc] = useState<CashLocation | null>(null);
  const [locForm, setLocForm] = useState({
    name: "", location_type: "CUSTODIAN" as CashLocation["location_type"],
    custodian_partner_id: "", custodian_employee_id: "", branch_id: "", opening_balance: "0", is_active: true,
  });
  const [locSaving, setLocSaving] = useState(false);

  // Transfer modal
  const [isTransferOpen, setIsTransferOpen] = useState(false);
  const [transferForm, setTransferForm] = useState({
    // from_type: where the cash comes from — another office-staff custodian, or a
    // bank (a withdrawal that raises Cash in Hand).
    from_type: "staff" as "staff" | "bank",
    date: today(), from_location_id: "", from_bank_id: "", to_location_id: "", amount: "", notes: "",
  });
  const [transferSaving, setTransferSaving] = useState(false);

  const loadData = async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [
        { data: locs }, { data: tx }, { data: pts }, { data: brs },
        { data: bnks }, { data: treas }, { data: pEntries }, { data: iEntries },
        { data: staff }, { data: cashPays }, { data: cashExps }, { data: cashCheques }, { data: bankWd }, { data: payrollCash },
        { data: cashAdvances },
      ] = await Promise.all([
        supabase.from("cash_locations").select("*").eq("company_id", companyId).order("name"),
        supabase.from("custody_transfers").select("*").eq("company_id", companyId).order("date", { ascending: false }).limit(100),
        supabase.from("partners").select("id, name, scope, branch_id, opening_balance, is_active").eq("company_id", companyId).order("name"),
        supabase.from("branches").select("id, name").eq("company_id", companyId).order("name"),
        supabase.from("bank_accounts").select("id, bank_name, account_number, balance, active").eq("company_id", companyId),
        supabase.from("treasury").select("cash_balance").eq("company_id", companyId).maybeSingle(),
        supabase.from("partner_account_entries").select("partner_id, type, amount").eq("company_id", companyId),
        supabase.from("investor_ledger_entries").select("investor_id, type, amount").eq("company_id", companyId),
        supabase.from("employees").select("id, full_name").eq("category", "office_staff").order("full_name"),
        supabase.from("invoice_payments").select("id, amount, custodian_location_id, payment_date, clients:client_id(name)").eq("payment_mode", "Cash").not("custodian_location_id", "is", null),
        supabase.from("expenses").select("id, amount, custodian_location_id, expense_date, description").not("custodian_location_id", "is", null),
        supabase.from("cheques").select("id, amount, custodian_location_id, cheque_date, cheque_number").eq("cheque_type", "cash").eq("status", "cleared").not("custodian_location_id", "is", null),
        supabase.from("bank_transactions").select("id, cash_delta, reference_id, description, created_at").eq("kind", "withdraw_to_cash").not("reference_id", "is", null),
        // Payroll cash payments handed out by a custodian (reference_id = custodian
        // cash_location, cash_delta negative). Shows as "Cash paid" in the ledger.
        supabase.from("bank_transactions").select("id, cash_delta, reference_id, description, created_at").eq("kind", "payroll").not("reference_id", "is", null),
        // Salary advances paid in cash by a custodian (0203). Cash out of their
        // hands, same as an expense — without this the advance left Cash in Hand
        // but never left the custodian, so the reconciliation drifted by the
        // amount of every cash advance ever paid.
        supabase.from("advances").select("id, amount, custodian_location_id, advance_date, employees:employee_id(full_name, employee_code)").eq("payment_mode", "Cash").not("custodian_location_id", "is", null),
      ]);
      const partnerList = ((pts ?? []) as Partner[]).filter((p) => p.is_active);
      setLocations((locs ?? []) as CashLocation[]);
      setOfficeStaff((staff ?? []) as OfficeStaff[]);
      // A custodian location belongs to an office-staff member OR a partner.
      const partnerNameById = new Map<string, string>();
      for (const p of partnerList) partnerNameById.set(p.id, p.name);
      const isCustodian = (l: CashLocation) =>
        l.location_type !== "BANK" && !!(l.custodian_employee_id || l.custodian_partner_id);
      // Attributed cash per custodian location.
      const inBy = new Map<string, number>();
      for (const p of (cashPays ?? []) as any[]) {
        if (!p.custodian_location_id) continue;
        inBy.set(p.custodian_location_id, (inBy.get(p.custodian_location_id) ?? 0) + Number(p.amount ?? 0));
      }
      setCashInByLoc(inBy);
      const outBy = new Map<string, number>();
      for (const e of (cashExps ?? []) as any[]) {
        if (!e.custodian_location_id) continue;
        outBy.set(e.custodian_location_id, (outBy.get(e.custodian_location_id) ?? 0) + Number(e.amount ?? 0));
      }
      for (const a of (cashAdvances ?? []) as any[]) {
        if (!a.custodian_location_id) continue;
        outBy.set(a.custodian_location_id, (outBy.get(a.custodian_location_id) ?? 0) + Number(a.amount ?? 0));
      }
      setCashOutByLoc(outBy);
      const chqBy = new Map<string, number>();
      for (const c of (cashCheques ?? []) as any[]) {
        if (!c.custodian_location_id) continue;
        chqBy.set(c.custodian_location_id, (chqBy.get(c.custodian_location_id) ?? 0) + Number(c.amount ?? 0));
      }
      setChequeInByLoc(chqBy);
      // Bank→custodian withdrawals attributed by reference_id (a custodian location).
      const custodianIdSet = new Set(((locs ?? []) as CashLocation[]).filter(isCustodian).map((l) => l.id));
      const wdBy = new Map<string, number>();
      for (const w of (bankWd ?? []) as any[]) {
        if (!w.reference_id || !custodianIdSet.has(w.reference_id)) continue;
        wdBy.set(w.reference_id, (wdBy.get(w.reference_id) ?? 0) + Number(w.cash_delta ?? 0));
      }
      setWithdrawInByLoc(wdBy);
      // Payroll cash paid out by each custodian (signed cash_delta, negative = out).
      const prBy = new Map<string, number>();
      for (const pr of (payrollCash ?? []) as any[]) {
        if (!pr.reference_id || !custodianIdSet.has(pr.reference_id)) continue;
        prBy.set(pr.reference_id, (prBy.get(pr.reference_id) ?? 0) + Number(pr.cash_delta ?? 0));
      }
      setPayrollCashByLoc(prBy);
      setTransfers((tx ?? []) as CustodyTransfer[]);

      // Custodian transaction ledger (Transactions tab): every cash movement that
      // touches a custodian — transfers, bank→cash, client cash, expenses, cheques.
      const locList = (locs ?? []) as CashLocation[];
      const staffById = new Map<string, string>();
      for (const s of (staff ?? []) as OfficeStaff[]) staffById.set(s.id, s.full_name);
      const custodianLocIds = new Set(locList.filter(isCustodian).map((l) => l.id));
      const empByLoc = new Map<string, string | null>();
      const labelByLoc = new Map<string, string>();
      for (const l of locList) {
        const personId = l.custodian_employee_id ?? l.custodian_partner_id ?? null;
        empByLoc.set(l.id, personId);
        labelByLoc.set(
          l.id,
          l.custodian_employee_id ? (staffById.get(l.custodian_employee_id) ?? l.name)
            : l.custodian_partner_id ? (partnerNameById.get(l.custodian_partner_id) ?? l.name)
            : l.name,
        );
      }
      const raw: Omit<LedgerEntry, "before" | "after">[] = [];
      for (const t of (tx ?? []) as CustodyTransfer[]) {
        const toCustodian = t.to_location_id != null && custodianLocIds.has(t.to_location_id);
        const fromCustodian = t.from_location_id != null && custodianLocIds.has(t.from_location_id);
        const fromIsBank = !fromCustodian; // BANK cash_location or null ⇒ bank/cash-in-hand source
        if (toCustodian) {
          raw.push({
            id: `t-in-${t.id}`, date: t.date, locationId: t.to_location_id!, employeeId: empByLoc.get(t.to_location_id!) ?? null,
            kind: fromIsBank ? "bank_to_cash" : "transfer_in",
            detail: fromIsBank ? `From ${t.from_location_id ? (labelByLoc.get(t.from_location_id) ?? "bank") : "bank"}` : `From ${labelByLoc.get(t.from_location_id!) ?? "—"}`,
            cashIn: Number(t.amount), cashOut: 0,
          });
        }
        if (fromCustodian) {
          raw.push({
            id: `t-out-${t.id}`, date: t.date, locationId: t.from_location_id!, employeeId: empByLoc.get(t.from_location_id!) ?? null,
            kind: "transfer_out",
            detail: `To ${t.to_location_id ? (labelByLoc.get(t.to_location_id) ?? "—") : "—"}`,
            cashIn: 0, cashOut: Number(t.amount),
          });
        }
      }
      for (const p of (cashPays ?? []) as any[]) {
        if (!p.custodian_location_id) continue;
        raw.push({
          id: `p-${p.id}`, date: p.payment_date, locationId: p.custodian_location_id, employeeId: empByLoc.get(p.custodian_location_id) ?? null,
          kind: "cash_received", detail: p.clients?.name ? `Client: ${p.clients.name}` : "Client cash", cashIn: Number(p.amount), cashOut: 0,
        });
      }
      for (const ex of (cashExps ?? []) as any[]) {
        if (!ex.custodian_location_id) continue;
        raw.push({
          id: `e-${ex.id}`, date: ex.expense_date, locationId: ex.custodian_location_id, employeeId: empByLoc.get(ex.custodian_location_id) ?? null,
          kind: "cash_paid", detail: ex.description || "Expense", cashIn: 0, cashOut: Number(ex.amount),
        });
      }
      for (const a of (cashAdvances ?? []) as any[]) {
        if (!a.custodian_location_id) continue;
        const who = a.employees ? `${a.employees.employee_code} ${a.employees.full_name}` : "employee";
        raw.push({
          id: `a-${a.id}`, date: a.advance_date, locationId: a.custodian_location_id, employeeId: empByLoc.get(a.custodian_location_id) ?? null,
          kind: "cash_paid", detail: `Advance · ${who}`, cashIn: 0, cashOut: Number(a.amount),
        });
      }
      for (const c of (cashCheques ?? []) as any[]) {
        if (!c.custodian_location_id) continue;
        raw.push({
          id: `c-${c.id}`, date: c.cheque_date, locationId: c.custodian_location_id, employeeId: empByLoc.get(c.custodian_location_id) ?? null,
          kind: "cheque_cashed", detail: `Cheque #${c.cheque_number}`, cashIn: Number(c.amount), cashOut: 0,
        });
      }
      for (const w of (bankWd ?? []) as any[]) {
        if (!w.reference_id || !custodianLocIds.has(w.reference_id)) continue;
        raw.push({
          id: `w-${w.id}`, date: String(w.created_at ?? "").slice(0, 10), locationId: w.reference_id, employeeId: empByLoc.get(w.reference_id) ?? null,
          kind: "bank_to_cash", detail: w.description || "Bank withdrawal to cash", cashIn: Number(w.cash_delta ?? 0), cashOut: 0,
        });
      }
      // Payroll cash paid out by a custodian (cash_delta negative = paid, positive = reversal).
      for (const pr of (payrollCash ?? []) as any[]) {
        if (!pr.reference_id || !custodianLocIds.has(pr.reference_id)) continue;
        const cd = Number(pr.cash_delta ?? 0);
        raw.push({
          id: `pr-${pr.id}`, date: String(pr.created_at ?? "").slice(0, 10), locationId: pr.reference_id, employeeId: empByLoc.get(pr.reference_id) ?? null,
          kind: cd < 0 ? "cash_paid" : "cash_received", detail: pr.description || "Payroll (cash)", cashIn: cd > 0 ? cd : 0, cashOut: cd < 0 ? -cd : 0,
        });
      }
      // Running held-cash per custodian (seed with each custodian's opening
      // balance), oldest→newest, so each row shows Before → After like the bank log.
      raw.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
      const runBal = new Map<string, number>();
      for (const l of locList) if (isCustodian(l)) runBal.set(l.id, Number(l.opening_balance ?? 0));
      const withBal: LedgerEntry[] = raw.map((e) => {
        const before = runBal.get(e.locationId) ?? 0;
        const after = before + e.cashIn - e.cashOut;
        runBal.set(e.locationId, after);
        return { ...e, before, after };
      });
      withBal.reverse(); // newest first for display
      setLedger(withBal);
      setPartners(partnerList);
      setBranches((brs ?? []) as Branch[]);
      setBanks((bnks ?? []) as BankAccountLite[]);
      setCashInHand(Number(treas?.cash_balance ?? 0));

      // Partner running balances: OPENING + PROFIT_ALLOCATION + CONTRIBUTION − DRAWING.
      // (Same engine as Partners.tsx computeBalance.)
      const stats = new Map<string, PartnerStats>();
      for (const p of partnerList) {
        stats.set(p.id, { allocated: 0, drawn: 0, contributed: 0, balance: Number(p.opening_balance ?? 0) });
      }
      for (const e of (pEntries ?? []) as any[]) {
        const s = stats.get(e.partner_id);
        if (!s) continue;
        const amt = Number(e.amount ?? 0);
        if (e.type === "PROFIT_ALLOCATION") { s.allocated += amt; s.balance += amt; }
        else if (e.type === "DRAWING") { s.drawn += amt; s.balance -= amt; }
        else if (e.type === "CONTRIBUTION") { s.contributed += amt; s.balance += amt; }
      }
      setPartnerStats(stats);

      // Investor liabilities the company owes (spec §2.6): outstanding capital +
      // unpaid return balance, per investor, positive amounts only.
      const invAgg = new Map<string, { capital: number; ret: number }>();
      for (const e of (iEntries ?? []) as any[]) {
        const cur = invAgg.get(e.investor_id) ?? { capital: 0, ret: 0 };
        const amt = Number(e.amount ?? 0);
        if (e.type === "CAPITAL_IN") cur.capital += amt;
        else if (e.type === "CAPITAL_REPAYMENT") cur.capital -= amt;
        else if (e.type === "RETURN_ALLOCATION" || e.type === "FINANCE_COST_ACCRUAL") cur.ret += amt;
        else if (e.type === "RETURN_PAYOUT" || e.type === "FINANCE_COST_PAYMENT") cur.ret -= amt;
        invAgg.set(e.investor_id, cur);
      }
      let invLiab = 0;
      for (const v of invAgg.values()) invLiab += Math.max(0, v.capital) + Math.max(0, v.ret);
      setInvestorLiabilities(invLiab);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, [companyId]);

  const bankBalanceById = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of banks) m.set(b.id, Number(b.balance ?? 0));
    return m;
  }, [banks]);

  // BANK locations mirror their live bank balance (single source of truth so the
  // two never drift); custodian / petty-cash use opening + net custody transfers.
  const computeLocationBalance = (loc: CashLocation): number => {
    if (loc.location_type === "BANK" && loc.bank_account_id) {
      return bankBalanceById.get(loc.bank_account_id) ?? 0;
    }
    let bal = Number(loc.opening_balance ?? 0);
    for (const t of transfers) {
      if (t.to_location_id === loc.id) bal += t.amount;
      if (t.from_location_id === loc.id) bal -= t.amount;
    }
    return bal;
  };

  const locationsWithBalance: LocationWithBalance[] = useMemo(
    () => locations.map((l) => ({ ...l, balance: computeLocationBalance(l) })),
    [locations, transfers, bankBalanceById],
  );

  // Held cash for a custodian/petty location = opening + net transfers + client cash
  // received (attributed) − cash expenses paid (attributed). This is the TRUE cash
  // that office-staff member currently holds (0135). Not applied to BANK locations.
  const heldCash = (loc: CashLocation): number =>
    computeLocationBalance(loc) + (cashInByLoc.get(loc.id) ?? 0) - (cashOutByLoc.get(loc.id) ?? 0) + (chequeInByLoc.get(loc.id) ?? 0) + (withdrawInByLoc.get(loc.id) ?? 0) + (payrollCashByLoc.get(loc.id) ?? 0);

  // A custodian is an office-staff member or a partner — resolve either.
  const staffName = (id: string | null) =>
    id ? (officeStaff.find((s) => s.id === id)?.full_name ?? partners.find((p) => p.id === id)?.name ?? "—") : "—";

  // Month options for the transaction log — the months that actually have entries
  // (YYYY-MM), newest first, labeled like the Bank Accounts log ("Aug 2026").
  const ledgerMonthOptions = useMemo(() => {
    const keys = Array.from(new Set(ledger.map((e) => (e.date ?? "").slice(0, 7)).filter(Boolean))).sort().reverse();
    return keys.map((key) => {
      const [y, m] = key.split("-");
      return { key, label: new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" }) };
    });
  }, [ledger]);

  // Transactions log: the ledger, optionally narrowed to one office-staff member and/or month.
  const filteredLedger = useMemo(
    () => ledger.filter((e) =>
      (ledgerStaffFilter === "all" || e.employeeId === ledgerStaffFilter) &&
      (ledgerMonth === "all" || (e.date ?? "").slice(0, 7) === ledgerMonth)),
    [ledger, ledgerStaffFilter, ledgerMonth],
  );
  const ledgerTotals = useMemo(() => {
    let cin = 0, cout = 0;
    for (const e of filteredLedger) { cin += e.cashIn; cout += e.cashOut; }
    return { cin, cout, net: cin - cout };
  }, [filteredLedger]);
  // Office staff who actually hold a custodian location (for the filter dropdown).
  const custodianStaff = useMemo(
    () => [
      ...officeStaff.map((s) => ({ id: s.id, name: s.full_name })),
      ...partners.map((p) => ({ id: p.id, name: p.name })),
    ].filter((person) => locations.some(
      (l) => (l.custodian_employee_id === person.id || l.custodian_partner_id === person.id) && l.location_type !== "BANK",
    )),
    [officeStaff, partners, locations],
  );

  // Cash-in-hand custodian reconciliation (Change 1): every custodian's held cash,
  // summed, must equal Total Cash in Hand (treasury). The gap is unattributed cash.
  const custodyRecon = useMemo(() => {
    const custodians = locationsWithBalance
      .filter((l) => l.is_active && l.location_type !== "BANK")
      .map((l) => ({ loc: l, held: heldCash(l) }))
      .sort((a, b) => b.held - a.held);
    const sumHeld = custodians.reduce((s, c) => s + c.held, 0);
    const discrepancy = cashInHand - sumHeld; // >0 = cash not yet attributed to a custodian
    return { custodians, sumHeld, discrepancy };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationsWithBalance, cashInByLoc, cashOutByLoc, chequeInByLoc, withdrawInByLoc, payrollCashByLoc, cashInHand]);

  // Total Cash = Cash in Hand (treasury) ONLY. This page deals with cash; bank
  // balances live on the Bank Accounts tab and are deliberately not added in here.
  // Custodian/petty locations are a BREAKDOWN of Cash in Hand (Σ custodian held
  // already equals it), so they are not added either.
  const totalCash = useMemo(() => cashInHand, [cashInHand]);
  const totalPartnerOwed = useMemo(
    () => Array.from(partnerStats.values()).filter((s) => s.balance > 0).reduce((s, v) => s + v.balance, 0),
    [partnerStats],
  );
  const freeCash = totalCash - totalPartnerOwed - investorLiabilities;

  // Report the summary figures to the page (cards live above the tab bar).
  useEffect(() => {
    onSummary?.({ totalCash, totalPartnerOwed, freeCash });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalCash, totalPartnerOwed, freeCash]);

  // Partners shown in the summary (branch-scoped logins see only their branch),
  // owner (COMPANY) first then regional partners by name.
  const summaryPartners = useMemo(() => {
    const list = branchScope ? partners.filter((p) => p.branch_id === branchScope) : partners;
    return [...list].sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === "COMPANY" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [partners, branchScope]);

  const openAddLoc = () => {
    setEditLoc(null);
    setLocForm({ name: "", location_type: "CUSTODIAN", custodian_partner_id: "", custodian_employee_id: "", branch_id: "", opening_balance: "0", is_active: true });
    setIsLocOpen(true);
  };

  // Expose the two header actions so the Banks & Ledgers page can render them in
  // its Header row (same placement as the Bank Accounts buttons). Purely wiring —
  // the handlers and their behaviour are unchanged.
  useEffect(() => {
    onReady?.({ addLocation: openAddLoc, recordTransfer: () => setIsTransferOpen(true), openTransactions: () => setIsTxOpen(true) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReady]);

  const openEditLoc = (l: CashLocation) => {
    setEditLoc(l);
    setLocForm({
      name: l.name, location_type: l.location_type,
      custodian_partner_id: l.custodian_partner_id ?? "", custodian_employee_id: l.custodian_employee_id ?? "",
      branch_id: l.branch_id ?? "",
      opening_balance: String(l.opening_balance), is_active: l.is_active,
    });
    setIsLocOpen(true);
  };

  const saveLoc = async () => {
    if (!companyId) return;
    const empId = locForm.custodian_employee_id;
    const partId = locForm.custodian_partner_id;
    // A custodian IS an office-staff member OR a partner; the location is named after them.
    if (locForm.location_type === "CUSTODIAN" && !empId && !partId) {
      setError("Select the office-staff member or partner for this custodian.");
      return;
    }
    if (empId && partId) { setError("Pick either an office-staff member or a partner, not both."); return; }
    const derivedName =
      (empId ? officeStaff.find((s) => s.id === empId)?.full_name
        : partId ? partners.find((p) => p.id === partId)?.name
        : null) || locForm.name.trim();
    if (!derivedName) return;
    setLocSaving(true);
    setError(null);
    try {
      const payload = {
        company_id: companyId,
        name: derivedName,
        location_type: locForm.location_type,
        custodian_partner_id: partId || null,
        custodian_employee_id: empId || null,
        branch_id: locForm.branch_id || null,
        opening_balance: parseFloat(locForm.opening_balance) || 0,
        is_active: locForm.is_active,
      };
      if (editLoc) {
        const { error: e } = await supabase.from("cash_locations").update(payload).eq("id", editLoc.id);
        if (e) throw e;
      } else {
        // One custody per person — never create a second row for someone who has one.
        const existing = (empId || partId)
          ? locations.find((l) => l.location_type === "CUSTODIAN"
              && (empId ? l.custodian_employee_id === empId : l.custodian_partner_id === partId))
          : null;
        if (existing) {
          setError(`${derivedName} already has a custody location. Edit it from the list instead.`);
          setLocSaving(false);
          return;
        }
        const { error: e } = await supabase.from("cash_locations").insert(payload);
        if (e) throw e;
      }
      setIsLocOpen(false);
      await loadData();
    } catch (e: any) { setError(e.message); }
    finally { setLocSaving(false); }
  };

  // Delete a custodian added by mistake. Blocked once any cash has moved through it
  // (transfers or attributed payments/expenses) so history is never orphaned —
  // deactivate instead in that case.
  const deleteLoc = async (loc: LocationWithBalance) => {
    if (!canDelete) return;
    const hasHistory =
      (cashInByLoc.get(loc.id) ?? 0) !== 0 ||
      (cashOutByLoc.get(loc.id) ?? 0) !== 0 ||
      (chequeInByLoc.get(loc.id) ?? 0) !== 0 ||
      (withdrawInByLoc.get(loc.id) ?? 0) !== 0 ||
      (payrollCashByLoc.get(loc.id) ?? 0) !== 0 ||
      transfers.some((t) => t.from_location_id === loc.id || t.to_location_id === loc.id);
    if (hasHistory) {
      setError(`"${loc.name}" has cash movements recorded and can't be deleted. Deactivate it instead (Edit → uncheck Active).`);
      return;
    }
    if (!window.confirm(`Delete custodian "${loc.name}"? This cannot be undone.`)) return;
    setError(null);
    const { error: e } = await supabase.from("cash_locations").delete().eq("id", loc.id);
    if (e) { setError(e.message); return; }
    await loadData();
  };

  const saveTransfer = async () => {
    if (!companyId || !transferForm.to_location_id || !transferForm.amount) return;
    const fromBank = transferForm.from_type === "bank";
    if (!fromBank && !transferForm.from_location_id) return;
    if (fromBank && !transferForm.from_bank_id) { setError("Select the bank to withdraw from."); return; }
    if (!fromBank && transferForm.from_location_id === transferForm.to_location_id) {
      setError("From and To locations must be different.");
      return;
    }
    setTransferSaving(true);
    setError(null);
    try {
      const amt = parseFloat(transferForm.amount);
      if (isNaN(amt) || amt <= 0) throw new Error("Enter a valid amount");
      if (fromBank) {
        // Bank → office staff: withdrawal that raises Cash in Hand and credits the
        // custodian, done atomically (bank −, Cash in Hand +, custody transfer, log).
        const { error: e } = await supabase.rpc("record_bank_to_custodian", {
          p_bank_account_id: transferForm.from_bank_id,
          p_custodian_location_id: transferForm.to_location_id,
          p_amount: amt,
          p_date: transferForm.date,
          p_notes: transferForm.notes || null,
        });
        if (e) throw e;
      } else {
        // Office staff → office staff: pure custody move; Cash in Hand unchanged.
        const { error: e } = await supabase.from("custody_transfers").insert({
          company_id: companyId,
          date: transferForm.date,
          from_location_id: transferForm.from_location_id,
          to_location_id: transferForm.to_location_id,
          amount: amt,
          notes: transferForm.notes || null,
          created_by: profile?.id,
        });
        if (e) throw e;
      }
      setIsTransferOpen(false);
      setTransferForm({ from_type: "staff", date: today(), from_location_id: "", from_bank_id: "", to_location_id: "", amount: "", notes: "" });
      await loadData();
    } catch (e: any) { setError(e.message); }
    finally { setTransferSaving(false); }
  };

  const typeIcon = (t: CashLocation["location_type"]) => {
    if (t === "BANK") return <Building2 className="w-4 h-4 text-brand-600" strokeWidth={1.5} />;
    return <Wallet className="w-4 h-4 text-amber-600" strokeWidth={1.5} />;
  };

  const typeLabel = (t: CashLocation["location_type"]) =>
    ({ BANK: "Bank", PETTY_CASH: "Petty Cash", CUSTODIAN: "Custodian" })[t];


  if (loading) return <div className="py-12 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;

  return (
    <>
      <div>
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        {/* One view. Cash Holdings used to be split across three tabs that asked
            the same question in three shapes — a Position tab showing only the
            treasury total, a Locations tab listing the custodians, and a
            Reconciliation tab listing the same custodians again with their held
            cash. They are one table now, with the reconciliation check as its
            footer. The Transfers tab is gone too; transfers are recorded from the
            header button and read back in the Transaction Log. */}
        <div className="space-y-4">
          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-200">
              <h3 className="text-base text-slate-900">Cash Holdings</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Where company cash sits right now. Each custodian's held cash is opening balance
                plus what they have taken in, less what they have paid out — and the sum of them
                must equal Total Cash in Hand. Bank balances live on the Bank Accounts tab.
              </p>
            </div>

            {Math.round(custodyRecon.discrepancy) !== 0 && (
              <div className="m-4 flex items-start gap-2 p-3 bg-warning-50 text-warning-800 border border-warning-200 rounded-md text-sm">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" strokeWidth={2} />
                <div>
                  <span className="font-medium">Discrepancy: {fmt(Math.abs(custodyRecon.discrepancy))}</span> {custodyRecon.discrepancy > 0
                    ? "of Cash in Hand is not attributed to any custodian yet. Assign it via custodian opening balances or record the movements against a custodian."
                    : "more is attributed to custodians than the Total Cash in Hand — check for an over-attribution."}
                </div>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Location</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Holder</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Opening</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Held Cash</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {/* Treasury total first — the figure every custodian row rolls up to. */}
                  <tr className="bg-slate-50/60">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {typeIcon("PETTY_CASH")}
                        <span className="text-sm text-slate-900">Cash in Hand</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">Cash / Treasury</td>
                    <td className="px-6 py-4 text-sm text-slate-600">—</td>
                    <td className="px-6 py-4 text-right text-sm font-mono text-slate-400">—</td>
                    <td className={`px-6 py-4 text-right text-sm font-mono ${cashInHand < 0 ? "text-danger-600" : "text-slate-900"}`}>{fmt(cashInHand)}</td>
                    <td className="px-6 py-4 text-sm text-slate-400">—</td>
                    <td className="px-6 py-4 text-right">
                      <span className="text-xs text-slate-400" title="The company treasury total — derived, not editable">Derived</span>
                    </td>
                  </tr>

                  {/* Banks are managed on the Bank Accounts tab — only cash custodians here. */}
                  {locationsWithBalance.filter((l) => l.location_type !== "BANK").length === 0 && (
                    <tr><td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">No cash custodians yet. Add one with "Add Location" above and set its office-staff holder.</td></tr>
                  )}
                  {locationsWithBalance.filter((l) => l.location_type !== "BANK").map((loc) => (
                    <tr key={loc.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          {typeIcon(loc.location_type)}
                          <span className="text-sm text-slate-900">{loc.name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{typeLabel(loc.location_type)}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {loc.custodian_employee_id ? staffName(loc.custodian_employee_id) : loc.custodian_partner_id ? partners.find((p) => p.id === loc.custodian_partner_id)?.name ?? "—" : "—"}
                      </td>
                      <td className="px-6 py-4 text-right text-sm font-mono text-slate-600">{fmt(loc.opening_balance)}</td>
                      {(() => {
                        const shown = heldCash(loc);
                        return <td className={`px-6 py-4 text-right text-sm font-mono ${shown < 0 ? "text-danger-600" : "text-slate-900"}`}>{fmt(shown)}</td>;
                      })()}
                      <td className="px-6 py-4">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs ${loc.is_active ? "bg-success-50 text-success-700" : "bg-slate-100 text-slate-500"}`}>
                          {loc.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => openEditLoc(loc)} title="Edit" className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900 transition-colors">
                            <Pencil className="w-4 h-4" strokeWidth={1.5} />
                          </button>
                          {canDelete && (
                            <button onClick={() => deleteLoc(loc)} title="Delete (super admin only)" className="p-1.5 rounded hover:bg-danger-50 text-slate-500 hover:text-danger-600 transition-colors">
                              <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {/* The reconciliation check, sitting under the numbers it checks. */}
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50">
                    <td className="px-6 py-3 text-sm font-medium text-slate-700" colSpan={4}>Sum of custodians</td>
                    <td className="px-6 py-3 text-right text-sm font-mono font-semibold text-slate-900">{fmt(custodyRecon.sumHeld)}</td>
                    <td colSpan={2} />
                  </tr>
                  <tr className="bg-slate-50">
                    <td className="px-6 py-2 text-sm text-slate-500" colSpan={4}>Total Cash in Hand (treasury)</td>
                    <td className="px-6 py-2 text-right text-sm font-mono text-slate-700">{fmt(cashInHand)}</td>
                    <td colSpan={2} />
                  </tr>
                  <tr className={`${Math.round(custodyRecon.discrepancy) !== 0 ? "bg-warning-50" : "bg-success-50"}`}>
                    <td className={`px-6 py-2 text-sm font-medium ${Math.round(custodyRecon.discrepancy) !== 0 ? "text-warning-800" : "text-success-700"}`} colSpan={4}>Unattributed (should be 0)</td>
                    <td className={`px-6 py-2 text-right text-sm font-mono font-bold ${Math.round(custodyRecon.discrepancy) !== 0 ? "text-warning-800" : "text-success-700"}`}>{fmt(custodyRecon.discrepancy)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-6">
            <h3 className="text-base text-slate-900 mb-1">Cash vs Liabilities</h3>
            <p className="text-xs text-slate-500 mb-4">Shows how much of the cash on hand is actually owed to partners vs. truly free.</p>
            <div className="space-y-2">
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-sm text-slate-700">Total Cash in Hand</span>
                <span className="text-sm font-mono font-semibold text-slate-900">{fmt(totalCash)}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-sm text-slate-500 ml-4">− Undrawn partner entitlements (positive balances)</span>
                <span className="text-sm font-mono text-warning-700">({fmt(totalPartnerOwed)})</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-sm text-slate-500 ml-4">− Investor liabilities (capital outstanding + returns owed)</span>
                <span className="text-sm font-mono text-warning-700">({fmt(investorLiabilities)})</span>
              </div>
              <div className={`flex items-center justify-between py-3 rounded-md px-3 ${freeCash >= 0 ? "bg-success-50" : "bg-danger-50"}`}>
                <span className={`text-sm font-medium ${freeCash >= 0 ? "text-success-700" : "text-danger-700"}`}>= Free Company Cash</span>
                <span className={`text-base font-mono font-bold ${freeCash >= 0 ? "text-success-700" : "text-danger-700"}`}>{fmt(freeCash)}</span>
              </div>
            </div>
          </div>

          {/* Partners Summary. The old Reconciliation tab repeated Net Balance in a
              second "Partner Balances" table whose only addition was the cash-impact
              wording — that is the last column here instead. */}
          <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
            <div className="p-4 border-b border-slate-200">
              <h3 className="text-base text-slate-900">Partners Summary</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Running balance per partner. Positive = company owes the partner (cash tied up); negative (red) = overdrawn.
              </p>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Partner</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Allocated</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Contributed</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Drawn</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Net Balance</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Cash Impact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {summaryPartners.length === 0 && (
                  <tr><td colSpan={6} className="px-6 py-8 text-center text-slate-500 text-sm">No partners.</td></tr>
                )}
                {summaryPartners.map((p) => {
                  const s = partnerStats.get(p.id) ?? { allocated: 0, drawn: 0, contributed: 0, balance: 0 };
                  return (
                    <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4">
                        <p className="text-sm text-slate-900 font-medium">{p.name}</p>
                        <span className={`inline-flex mt-0.5 px-2 py-0.5 rounded text-xs ${p.scope === "COMPANY" ? "bg-brand-50 text-brand-700" : "bg-amber-50 text-amber-700"}`}>
                          {p.scope === "COMPANY" ? "Owner" : (branches.find((b) => b.id === p.branch_id)?.name ?? "Branch")}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right text-sm font-mono text-success-600">{fmt(s.allocated)}</td>
                      <td className="px-6 py-4 text-right text-sm font-mono text-brand-600">{fmt(s.contributed)}</td>
                      <td className="px-6 py-4 text-right text-sm font-mono text-danger-600">{fmt(s.drawn)}</td>
                      <td className={`px-6 py-4 text-right text-sm font-mono font-semibold ${s.balance < 0 ? "text-danger-700" : "text-slate-900"}`}>{fmt(s.balance)}</td>
                      <td className={`px-6 py-4 text-right text-sm font-mono ${s.balance > 0 ? "text-warning-600" : "text-success-600"}`}>
                        {s.balance > 0 ? `(${fmt(s.balance)}) tied up` : s.balance < 0 ? "— overdrawn" : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      {/* ── Transactions Modal — mirrors the Bank Accounts "Transaction Log":
          same modal chrome, a flex-wrap filter row (Cash Custody's own "All
          custodians" filter in the Account/Month slot), entry count, and the
          px-3 py-2 text-xs table with colored Δ. Opened from the header button. */}
      <Modal isOpen={isTxOpen} onClose={() => setIsTxOpen(false)} title="Transaction Log" size="lg">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3 items-center pb-3 border-b border-slate-200">
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-500">Custodian</label>
              <ThemedSelect value={ledgerStaffFilter} onChange={(e) => setLedgerStaffFilter(e.target.value)}
                className="px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="all">All custodians</option>
                {custodianStaff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </ThemedSelect>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-500">Month</label>
              <ThemedSelect value={ledgerMonth} onChange={(e) => setLedgerMonth(e.target.value)}
                className="px-3 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="all">All</option>
                {ledgerMonthOptions.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </ThemedSelect>
            </div>
            <span className="ml-auto text-xs text-slate-500">{filteredLedger.length} entr{filteredLedger.length === 1 ? "y" : "ies"}</span>
          </div>

          {/* Same table chrome as the Bank Accounts Transaction Log (HistoryBody):
              sticky header, plain-text Kind, colored Δ, labeled Before → After. */}
          <div className="max-h-[60vh] overflow-auto">
            {filteredLedger.length === 0 ? (
              <p className="text-sm text-slate-500 py-6 text-center">No transactions yet.</p>
            ) : (
              <table className="w-full">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-3 py-2 text-xs text-slate-500">Date</th>
                    <th className="text-left px-3 py-2 text-xs text-slate-500">Kind</th>
                    <th className="text-left px-3 py-2 text-xs text-slate-500">Custodian</th>
                    <th className="text-right px-3 py-2 text-xs text-slate-500">Δ</th>
                    <th className="text-right px-3 py-2 text-xs text-slate-500">Before → After</th>
                    <th className="text-left px-3 py-2 text-xs text-slate-500">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredLedger.map((e) => {
                    const delta = e.cashIn - e.cashOut;
                    return (
                      <tr key={e.id}>
                        <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">{e.date}</td>
                        <td className="px-3 py-2 text-xs text-slate-700">{LEDGER_KIND_LABEL[e.kind]}</td>
                        <td className="px-3 py-2 text-xs text-slate-700">{staffName(e.employeeId)}</td>
                        <td className={`px-3 py-2 text-right text-xs font-mono ${delta >= 0 ? "text-success-700" : "text-danger-700"}`}>{delta >= 0 ? "+" : ""}{Math.round(delta).toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-xs font-mono text-slate-700 whitespace-nowrap">
                          <span className="text-slate-400">Cash </span>{Math.round(e.before).toLocaleString()} → {Math.round(e.after).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">{e.detail}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
            <Button variant="secondary" size="md" className="ml-auto" onClick={() => setIsTxOpen(false)}>Close</Button>
          </div>
        </div>
      </Modal>

      {/* ── Add/Edit Location Modal ── */}
      <Modal isOpen={isLocOpen} error={error} onDismissError={() => setError(null)} onClose={() => setIsLocOpen(false)} title={editLoc ? "Edit Custodian" : "Add Custodian"} size="md">
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Office Staff</label>
            {/* The custodian is an office-staff member OR a partner — pick one. On Add,
                people who already hold a custody are hidden so nobody gets a duplicate. */}
            <ThemedSelect value={locForm.custodian_employee_id}
              onChange={(e) => setLocForm({ ...locForm, custodian_employee_id: e.target.value, custodian_partner_id: e.target.value ? "" : locForm.custodian_partner_id })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
              <option value="">Select office-staff member…</option>
              {(editLoc
                ? officeStaff
                : officeStaff.filter((s) => !locations.some((l) => l.custodian_employee_id === s.id && l.location_type === "CUSTODIAN"))
              ).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
            </ThemedSelect>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">…or Partner</label>
            <ThemedSelect value={locForm.custodian_partner_id}
              onChange={(e) => setLocForm({ ...locForm, custodian_partner_id: e.target.value, custodian_employee_id: e.target.value ? "" : locForm.custodian_employee_id })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
              <option value="">Select partner…</option>
              {(editLoc
                ? partners
                : partners.filter((p) => !locations.some((l) => l.custodian_partner_id === p.id && l.location_type === "CUSTODIAN"))
              ).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </ThemedSelect>
            <p className="text-[11px] text-slate-500 mt-1">Cash a partner holds is company custody (activity), not a capital drawing.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Opening Balance (PKR)</label>
              <input type="number" value={locForm.opening_balance} onChange={(e) => setLocForm({ ...locForm, opening_balance: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Branch (optional)</label>
              <ThemedSelect value={locForm.branch_id} onChange={(e) => setLocForm({ ...locForm, branch_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">All / Company-wide</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </ThemedSelect>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={locForm.is_active} onChange={(e) => setLocForm({ ...locForm, is_active: e.target.checked })} className="rounded border-slate-300" />
            Active
          </label>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" onClick={saveLoc} disabled={locSaving}>
              {locSaving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : editLoc ? "Save Changes" : "Add Location"}
            </Button>
            <Button variant="secondary" size="md" className="flex-1" onClick={() => setIsLocOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* ── Custody Transfer Modal ── */}
      <Modal isOpen={isTransferOpen} error={error} onDismissError={() => setError(null)} onClose={() => setIsTransferOpen(false)} title="Record Custody Transfer" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            {transferForm.from_type === "bank"
              ? "Withdraw cash from a bank to an office-staff custodian. This raises Cash in Hand and reduces the bank."
              : "Move cash from one office-staff custodian to another. Cash in Hand is unchanged — only who holds it."}
          </p>
          {/* From-source toggle */}
          <div className="flex gap-1 bg-slate-100 rounded-md p-1 w-fit max-w-full overflow-x-auto">
            {([["staff", "From Office Staff"], ["bank", "From Bank"]] as const).map(([k, l]) => (
              <button key={k} type="button"
                onClick={() => setTransferForm({ ...transferForm, from_type: k, from_location_id: "", from_bank_id: "" })}
                className={`px-3 py-1.5 text-sm rounded transition-colors ${transferForm.from_type === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
                {l}
              </button>
            ))}
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Date *</label>
            <input type="date" value={transferForm.date} onChange={(e) => setTransferForm({ ...transferForm, date: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">{transferForm.from_type === "bank" ? "From (bank) *" : "From (office staff) *"}</label>
              {transferForm.from_type === "bank" ? (
                <ThemedSelect value={transferForm.from_bank_id} onChange={(e) => setTransferForm({ ...transferForm, from_bank_id: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="">Select bank…</option>
                  {banks.filter((b) => b.active).map((b) => (
                    <option key={b.id} value={b.id}>{b.bank_name}{b.account_number ? ` ••${String(b.account_number).slice(-4)}` : ""} — {fmt(b.balance)}</option>
                  ))}
                </ThemedSelect>
              ) : (
                <ThemedSelect value={transferForm.from_location_id} onChange={(e) => setTransferForm({ ...transferForm, from_location_id: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="">Select…</option>
                  {locations.filter((l) => l.is_active && l.location_type !== "BANK" && l.custodian_employee_id).map((l) => (
                    <option key={l.id} value={l.id}>{staffName(l.custodian_employee_id)} — holds {fmt(heldCash(l))}</option>
                  ))}
                </ThemedSelect>
              )}
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">To (office staff) *</label>
              <ThemedSelect value={transferForm.to_location_id} onChange={(e) => setTransferForm({ ...transferForm, to_location_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select…</option>
                {locations.filter((l) => l.is_active && l.location_type !== "BANK" && (l.custodian_employee_id || l.custodian_partner_id)).map((l) => (
                  <option key={l.id} value={l.id}>{staffName(l.custodian_employee_id ?? l.custodian_partner_id)} — holds {fmt(heldCash(l))}</option>
                ))}
              </ThemedSelect>
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
            <input type="number" min="0" placeholder="0" value={transferForm.amount} onChange={(e) => setTransferForm({ ...transferForm, amount: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Notes</label>
            <input type="text" placeholder="e.g. Cash handed to CEO for salaries" value={transferForm.notes} onChange={(e) => setTransferForm({ ...transferForm, notes: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" onClick={saveTransfer} disabled={transferSaving}>
              {transferSaving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Record Transfer"}
            </Button>
            <Button variant="secondary" size="md" className="flex-1" onClick={() => setIsTransferOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
