import ThemedSelect from "../../components/ThemedSelect";
import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, AlertCircle, X, Loader2, ArrowRightLeft, Wallet, Building2 } from "lucide-react";
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
type BankAccountLite = { id: string; balance: number; active: boolean };
type PartnerStats = { allocated: number; drawn: number; contributed: number; balance: number };

type LocationWithBalance = CashLocation & { balance: number };

// Synthetic id for the "Cash in Hand" (company treasury) row shown alongside
// the real cash_locations on the Cash Position tab.
const CASH_IN_HAND_ID = "__cash_in_hand__";

export function CashCustodyPanel() {
  const { profile } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? null;
  // Only a (super) admin may delete a custodian added by mistake.
  const canDelete = profile?.role === "super_admin" || profile?.role === "super_super_admin";
  // Branch-scoped (regional partner) logins see only their own branch's partners;
  // company-wide roles (no branch) see everyone. SSA viewing a company is company-wide.
  const branchScope = profile?.role === "super_super_admin" ? null : (profile?.branch_id ?? null);

  const [tab, setTab] = useState<"locations" | "transfers" | "position" | "reconciliation">("position");
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
    date: today(), from_location_id: "", to_location_id: "", amount: "", notes: "",
  });
  const [transferSaving, setTransferSaving] = useState(false);

  const loadData = async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [
        { data: locs }, { data: tx }, { data: pts }, { data: brs },
        { data: bnks }, { data: treas }, { data: pEntries }, { data: iEntries },
        { data: staff }, { data: cashPays }, { data: cashExps },
      ] = await Promise.all([
        supabase.from("cash_locations").select("*").eq("company_id", companyId).order("name"),
        supabase.from("custody_transfers").select("*").eq("company_id", companyId).order("date", { ascending: false }).limit(100),
        supabase.from("partners").select("id, name, scope, branch_id, opening_balance, is_active").eq("company_id", companyId).order("name"),
        supabase.from("branches").select("id, name").eq("company_id", companyId).order("name"),
        supabase.from("bank_accounts").select("id, balance, active").eq("company_id", companyId),
        supabase.from("treasury").select("cash_balance").eq("company_id", companyId).maybeSingle(),
        supabase.from("partner_account_entries").select("partner_id, type, amount").eq("company_id", companyId),
        supabase.from("investor_ledger_entries").select("investor_id, type, amount").eq("company_id", companyId),
        supabase.from("employees").select("id, full_name").eq("category", "office_staff").order("full_name"),
        supabase.from("invoice_payments").select("amount, custodian_location_id").eq("payment_mode", "Cash").not("custodian_location_id", "is", null),
        supabase.from("expenses").select("amount, custodian_location_id").not("custodian_location_id", "is", null),
      ]);
      const partnerList = ((pts ?? []) as Partner[]).filter((p) => p.is_active);
      setLocations((locs ?? []) as CashLocation[]);
      setOfficeStaff((staff ?? []) as OfficeStaff[]);
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
      setCashOutByLoc(outBy);
      setTransfers((tx ?? []) as CustodyTransfer[]);
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
    computeLocationBalance(loc) + (cashInByLoc.get(loc.id) ?? 0) - (cashOutByLoc.get(loc.id) ?? 0);

  const staffName = (id: string | null) => (id ? officeStaff.find((s) => s.id === id)?.full_name ?? "—" : "—");

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
  }, [locationsWithBalance, cashInByLoc, cashOutByLoc, cashInHand]);

  // Cash in Hand (company treasury) as its own Position row alongside real locations.
  const cashInHandRow: LocationWithBalance = {
    id: CASH_IN_HAND_ID, name: "Cash in Hand", location_type: "PETTY_CASH",
    custodian_partner_id: null, custodian_user_id: null, custodian_employee_id: null, opening_balance: 0,
    branch_id: null, is_active: true, bank_account_id: null, balance: cashInHand,
  };
  // Cash Position shows only the headline Cash in Hand figure. Per-custodian holdings
  // live on the Reconciliation tab; bank balances live on the Bank Accounts tab.
  const positionRows = useMemo(
    () => [cashInHandRow],
    [cashInHand],
  );

  const totalCash = useMemo(
    () => cashInHand + locationsWithBalance.filter((l) => l.is_active).reduce((s, l) => s + l.balance, 0),
    [locationsWithBalance, cashInHand],
  );
  const totalPartnerOwed = useMemo(
    () => Array.from(partnerStats.values()).filter((s) => s.balance > 0).reduce((s, v) => s + v.balance, 0),
    [partnerStats],
  );
  const freeCash = totalCash - totalPartnerOwed - investorLiabilities;

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
    // A custodian IS an office-staff member; the location is named after them.
    if (locForm.location_type === "CUSTODIAN" && !empId) {
      setError("Select the office-staff member for this custodian.");
      return;
    }
    const derivedName = (empId ? officeStaff.find((s) => s.id === empId)?.full_name : null) || locForm.name.trim();
    if (!derivedName) return;
    setLocSaving(true);
    setError(null);
    try {
      const payload = {
        company_id: companyId,
        name: derivedName,
        location_type: locForm.location_type,
        custodian_partner_id: null,
        custodian_employee_id: empId || null,
        branch_id: locForm.branch_id || null,
        opening_balance: parseFloat(locForm.opening_balance) || 0,
        is_active: locForm.is_active,
      };
      if (editLoc) {
        const { error: e } = await supabase.from("cash_locations").update(payload).eq("id", editLoc.id);
        if (e) throw e;
      } else {
        // One custodian per office-staff member — never create a second row for a
        // person who already has one.
        const existing = empId ? locations.find((l) => l.custodian_employee_id === empId && l.location_type === "CUSTODIAN") : null;
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
    if (!companyId || !transferForm.from_location_id || !transferForm.to_location_id || !transferForm.amount) return;
    if (transferForm.from_location_id === transferForm.to_location_id) {
      setError("From and To locations must be different.");
      return;
    }
    setTransferSaving(true);
    setError(null);
    try {
      const amt = parseFloat(transferForm.amount);
      if (isNaN(amt) || amt <= 0) throw new Error("Enter a valid amount");
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
      setIsTransferOpen(false);
      setTransferForm({ date: today(), from_location_id: "", to_location_id: "", amount: "", notes: "" });
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

  const locName = (id: string | null) => id ? (locations.find((l) => l.id === id)?.name ?? id) : "—";

  if (loading) return <div className="py-12 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <p className="text-sm text-slate-500">Track who holds company cash — banks, petty cash, and custodians</p>
        <div className="flex gap-2">
          <Button variant="secondary" size="md" onClick={() => { setIsTransferOpen(true); }}>
            <ArrowRightLeft className="w-4 h-4 mr-2" strokeWidth={1.5} />
            Record Transfer
          </Button>
          <Button variant="primary" size="md" onClick={openAddLoc}>
            <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
            Add Location
          </Button>
        </div>
      </div>

      <div>
        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}

        {/* Tab bar */}
        <div className="flex gap-1 bg-slate-100 rounded-md p-1 mb-6 w-fit">
          {([["position", "Cash Position"], ["reconciliation", "Reconciliation"], ["locations", "Locations"], ["transfers", "Transfers"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${tab === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
              {l}
            </button>
          ))}
        </div>

        {/* ── POSITION TAB ── */}
        {tab === "position" && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-2">
              <div className="bg-white rounded-lg border border-slate-200 border-l-4 border-l-brand-500 p-4">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Total Cash (All Locations)</p>
                <p className="text-2xl font-mono text-slate-900">{fmt(totalCash)}</p>
              </div>
              <div className="bg-white rounded-lg border border-slate-200 border-l-4 border-l-warning-500 p-4">
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Owed to Partners (Undrawn)</p>
                <p className="text-2xl font-mono text-slate-700">{fmt(totalPartnerOwed)}</p>
              </div>
              <div className={`bg-white rounded-lg border border-slate-200 border-l-4 ${freeCash >= 0 ? "border-l-success-500" : "border-l-danger-500"} p-4`}>
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Free Company Cash</p>
                <p className={`text-2xl font-mono ${freeCash < 0 ? "text-danger-700" : "text-success-700"}`}>{fmt(freeCash)}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {positionRows.map((loc) => (
                <div key={loc.id} className="bg-white rounded-lg border border-slate-200 p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      {typeIcon(loc.location_type)}
                      <div>
                        <p className="text-sm font-medium text-slate-900">{loc.name}</p>
                        <p className="text-xs text-slate-500">{loc.id === CASH_IN_HAND_ID ? "Cash / Treasury" : typeLabel(loc.location_type)}</p>
                      </div>
                    </div>
                  </div>
                  {(loc.custodian_employee_id || loc.custodian_partner_id) && (
                    <p className="text-xs text-slate-500 mb-2">
                      Holder: {loc.custodian_employee_id ? staffName(loc.custodian_employee_id) : partners.find((p) => p.id === loc.custodian_partner_id)?.name ?? "—"}
                    </p>
                  )}
                  {(() => {
                    // Treasury total + BANK use loc.balance; custodian/petty show HELD
                    // cash (opening + transfers + attributed cash in − cash out).
                    const shown = loc.id === CASH_IN_HAND_ID || loc.location_type === "BANK" ? loc.balance : heldCash(loc);
                    return <p className={`text-xl font-mono ${shown < 0 ? "text-danger-600" : "text-slate-900"}`}>{fmt(shown)}</p>;
                  })()}
                </div>
              ))}
            </div>

            {/* ── Partners Summary (Phase 3) ── */}
            <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
              <div className="p-4 border-b border-slate-200">
                <h3 className="text-base text-slate-900">Partners Summary</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Running balance per partner. Positive = company owes the partner; negative (red) = overdrawn.
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
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {summaryPartners.length === 0 && (
                    <tr><td colSpan={5} className="px-6 py-8 text-center text-slate-500 text-sm">No partners.</td></tr>
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
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── RECONCILIATION TAB ── */}
        {tab === "reconciliation" && (
          <div className="space-y-4">
            {/* Cash-in-Hand by custodian (0135): Σ custodians must equal Total Cash in Hand. */}
            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
              <div className="p-4 border-b border-slate-200">
                <h3 className="text-base text-slate-900">Cash in Hand — by Custodian</h3>
                <p className="text-xs text-slate-500 mt-0.5">Which office-staff member holds how much company cash. The sum must equal Total Cash in Hand.</p>
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
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Custodian</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Holder</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Held Cash</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {custodyRecon.custodians.length === 0 && (
                    <tr><td colSpan={3} className="px-6 py-8 text-center text-slate-500 text-sm">No custodian locations yet. Add one (Locations → Add) and set its office-staff holder.</td></tr>
                  )}
                  {custodyRecon.custodians.map(({ loc, held }) => (
                    <tr key={loc.id} className="hover:bg-slate-50">
                      <td className="px-6 py-4 text-sm text-slate-900">{loc.name}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{loc.custodian_employee_id ? staffName(loc.custodian_employee_id) : "—"}</td>
                      <td className={`px-6 py-4 text-right text-sm font-mono ${held < 0 ? "text-danger-600" : "text-slate-900"}`}>{fmt(held)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50">
                    <td className="px-6 py-3 text-sm font-medium text-slate-700" colSpan={2}>Sum of custodians</td>
                    <td className="px-6 py-3 text-right text-sm font-mono font-semibold text-slate-900">{fmt(custodyRecon.sumHeld)}</td>
                  </tr>
                  <tr className="bg-slate-50">
                    <td className="px-6 py-2 text-sm text-slate-500" colSpan={2}>Total Cash in Hand (treasury)</td>
                    <td className="px-6 py-2 text-right text-sm font-mono text-slate-700">{fmt(cashInHand)}</td>
                  </tr>
                  <tr className={`${Math.round(custodyRecon.discrepancy) !== 0 ? "bg-warning-50" : "bg-success-50"}`}>
                    <td className={`px-6 py-2 text-sm font-medium ${Math.round(custodyRecon.discrepancy) !== 0 ? "text-warning-800" : "text-success-700"}`} colSpan={2}>Unattributed (should be 0)</td>
                    <td className={`px-6 py-2 text-right text-sm font-mono font-bold ${Math.round(custodyRecon.discrepancy) !== 0 ? "text-warning-800" : "text-success-700"}`}>{fmt(custodyRecon.discrepancy)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="bg-white rounded-lg border border-slate-200 p-6">
              <h3 className="text-base text-slate-900 mb-1">Cash vs Liabilities</h3>
              <p className="text-xs text-slate-500 mb-4">Shows how much of the cash on hand is actually owed to partners vs. truly free.</p>
              <div className="space-y-2">
                <div className="flex items-center justify-between py-2 border-b border-slate-100">
                  <span className="text-sm text-slate-700">Total Cash (all active locations)</span>
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

            {/* Partner balance breakdown */}
            <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
              <div className="p-4 border-b border-slate-200">
                <h3 className="text-base text-slate-900">Partner Balances</h3>
                <p className="text-xs text-slate-500 mt-0.5">Positive = company owes the partner (cash tied up). Negative = partner is overdrawn.</p>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Partner</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Balance</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Cash Impact</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {partners.length === 0 && (
                    <tr><td colSpan={3} className="px-6 py-8 text-center text-slate-500 text-sm">No partners.</td></tr>
                  )}
                  {partners.map((p) => {
                    const bal = partnerStats.get(p.id)?.balance ?? 0;
                    return (
                      <tr key={p.id} className="hover:bg-slate-50">
                        <td className="px-6 py-4 text-sm text-slate-900">{p.name}</td>
                        <td className={`px-6 py-4 text-right text-sm font-mono ${bal < 0 ? "text-danger-600" : "text-slate-900"}`}>{fmt(bal)}</td>
                        <td className={`px-6 py-4 text-right text-sm font-mono ${bal > 0 ? "text-warning-600" : "text-success-600"}`}>
                          {bal > 0 ? `(${fmt(bal)}) tied up` : bal < 0 ? "— overdrawn" : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── LOCATIONS TAB ── */}
        {tab === "locations" && (
          <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Name</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Holder</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Opening Balance</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Current Balance</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {/* Banks are managed on the Bank Accounts tab — only cash custodians here. */}
                {locationsWithBalance.filter((l) => l.location_type !== "BANK").length === 0 && (
                  <tr><td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">No cash locations yet.</td></tr>
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
                      // BANK mirrors its live account; custodian/petty show HELD cash
                      // (opening + transfers + attributed cash received − cash paid).
                      const shown = loc.location_type === "BANK" ? loc.balance : heldCash(loc);
                      return <td className={`px-6 py-4 text-right text-sm font-mono ${shown < 0 ? "text-danger-600" : "text-slate-900"}`}>{fmt(shown)}</td>;
                    })()}
                    <td className="px-6 py-4">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs ${loc.is_active ? "bg-success-50 text-success-700" : "bg-slate-100 text-slate-500"}`}>
                        {loc.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {loc.location_type === "BANK" ? (
                        <span className="text-xs text-slate-400" title="Synced automatically from the Bank Accounts tab">Auto-synced</span>
                      ) : (
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
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── TRANSFERS TAB ── */}
        {tab === "transfers" && (
          <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
            <div className="p-4 border-b border-slate-200">
              <h3 className="text-base text-slate-900">Custody Transfers</h3>
              <p className="text-xs text-slate-500 mt-0.5">Moving cash between locations. Changes where money is, not whose it is.</p>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Date</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">From</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">To</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Amount</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {transfers.length === 0 && (
                  <tr><td colSpan={5} className="px-6 py-10 text-center text-slate-500 text-sm">No transfers yet.</td></tr>
                )}
                {transfers.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 text-sm text-slate-900">{t.date}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{locName(t.from_location_id)}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{locName(t.to_location_id)}</td>
                    <td className="px-6 py-4 text-right text-sm font-mono text-slate-900">{fmt(t.amount)}</td>
                    <td className="px-6 py-4 text-sm text-slate-500">{t.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Add/Edit Location Modal ── */}
      <Modal isOpen={isLocOpen} onClose={() => setIsLocOpen(false)} title={editLoc ? "Edit Custodian" : "Add Custodian"} size="md">
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Office Staff *</label>
            {/* The custodian IS the office-staff member — no free-text name. Their cash
                is tracked as one custody under their own name. On Add, staff who already
                have a custody are hidden so nobody gets a duplicate. */}
            <ThemedSelect value={locForm.custodian_employee_id} onChange={(e) => setLocForm({ ...locForm, custodian_employee_id: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
              <option value="">Select office-staff member…</option>
              {(editLoc
                ? officeStaff
                : officeStaff.filter((s) => !locations.some((l) => l.custodian_employee_id === s.id && l.location_type === "CUSTODIAN"))
              ).map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
            </ThemedSelect>
            {editLoc?.custodian_partner_id && !locForm.custodian_employee_id && (
              <p className="text-[11px] text-warning-700 mt-1">Legacy partner holder: {partners.find((p) => p.id === editLoc.custodian_partner_id)?.name ?? "—"}. Pick an office-staff holder to migrate.</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
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
      <Modal isOpen={isTransferOpen} onClose={() => setIsTransferOpen(false)} title="Record Custody Transfer" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-slate-500">Move company cash between custodian / petty-cash locations. This does not change who owns the money. (Bank ↔ cash moves happen via Deposit / Withdraw on the Bank Accounts tab.)</p>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Date *</label>
            <input type="date" value={transferForm.date} onChange={(e) => setTransferForm({ ...transferForm, date: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">From (office staff) *</label>
              <ThemedSelect value={transferForm.from_location_id} onChange={(e) => setTransferForm({ ...transferForm, from_location_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select…</option>
                {locations.filter((l) => l.is_active && l.location_type !== "BANK" && l.custodian_employee_id).map((l) => (
                  <option key={l.id} value={l.id}>{staffName(l.custodian_employee_id)} — holds {fmt(heldCash(l))}</option>
                ))}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">To (office staff) *</label>
              <ThemedSelect value={transferForm.to_location_id} onChange={(e) => setTransferForm({ ...transferForm, to_location_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select…</option>
                {locations.filter((l) => l.is_active && l.location_type !== "BANK" && l.custodian_employee_id).map((l) => (
                  <option key={l.id} value={l.id}>{staffName(l.custodian_employee_id)} — holds {fmt(heldCash(l))}</option>
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
