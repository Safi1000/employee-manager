import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, AlertCircle, X, Loader2, ArrowRightLeft, Wallet, Building2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

const fmt = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;
const today = () => new Date().toISOString().slice(0, 10);

type CashLocation = {
  id: string;
  name: string;
  location_type: "BANK" | "PETTY_CASH" | "CUSTODIAN";
  custodian_partner_id: string | null;
  custodian_user_id: string | null;
  opening_balance: number;
  branch_id: string | null;
  is_active: boolean;
};

type CustodyTransfer = {
  id: string;
  date: string;
  from_location_id: string | null;
  to_location_id: string | null;
  amount: number;
  notes: string | null;
  created_at: string;
};

type Partner = { id: string; name: string };
type Branch = { id: string; name: string };

type LocationWithBalance = CashLocation & { balance: number };

export default function CashCustody() {
  const { profile } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? null;

  const [tab, setTab] = useState<"locations" | "transfers" | "position" | "reconciliation">("position");
  const [locations, setLocations] = useState<CashLocation[]>([]);
  const [transfers, setTransfers] = useState<CustodyTransfer[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // For partner balances in reconciliation view
  const [partnerBalances, setPartnerBalances] = useState<Map<string, number>>(new Map());

  // Add/Edit Location modal
  const [isLocOpen, setIsLocOpen] = useState(false);
  const [editLoc, setEditLoc] = useState<CashLocation | null>(null);
  const [locForm, setLocForm] = useState({
    name: "", location_type: "CUSTODIAN" as CashLocation["location_type"],
    custodian_partner_id: "", branch_id: "", opening_balance: "0", is_active: true,
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
      const [{ data: locs }, { data: tx }, { data: pts }, { data: brs }] = await Promise.all([
        supabase.from("cash_locations").select("*").eq("company_id", companyId).order("name"),
        supabase.from("custody_transfers").select("*").eq("company_id", companyId).order("date", { ascending: false }).limit(100),
        supabase.from("partners").select("id, name").eq("company_id", companyId).eq("is_active", true).order("name"),
        supabase.from("branches").select("id, name").eq("company_id", companyId).order("name"),
      ]);
      setLocations((locs ?? []) as CashLocation[]);
      setTransfers((tx ?? []) as CustodyTransfer[]);
      setPartners((pts ?? []) as Partner[]);
      setBranches((brs ?? []) as Branch[]);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const loadPartnerBalances = async () => {
    if (!companyId || partners.length === 0) return;
    const { data } = await supabase
      .from("partner_account_entries")
      .select("partner_id, type, amount")
      .eq("company_id", companyId);
    const { data: pData } = await supabase.from("partners").select("id, opening_balance").eq("company_id", companyId);
    const openings = new Map<string, number>((pData ?? []).map((p: any) => [p.id, p.opening_balance]));
    const map = new Map<string, number>();
    for (const [pid, opening] of openings) {
      const entries = (data ?? []).filter((e: any) => e.partner_id === pid);
      let bal = opening;
      for (const e of entries as any[]) {
        if (e.type === "PROFIT_ALLOCATION") bal += e.amount;
        else if (e.type === "DRAWING") bal -= e.amount;
        else if (e.type === "CONTRIBUTION") bal += e.amount;
      }
      map.set(pid, bal);
    }
    setPartnerBalances(map);
  };

  useEffect(() => { loadData(); }, [companyId]);
  useEffect(() => { if (tab === "reconciliation" && partners.length > 0) loadPartnerBalances(); }, [tab, partners]);

  const computeLocationBalance = (loc: CashLocation): number => {
    let bal = loc.opening_balance;
    for (const t of transfers) {
      if (t.to_location_id === loc.id) bal += t.amount;
      if (t.from_location_id === loc.id) bal -= t.amount;
    }
    return bal;
  };

  const locationsWithBalance: LocationWithBalance[] = useMemo(
    () => locations.map((l) => ({ ...l, balance: computeLocationBalance(l) })),
    [locations, transfers],
  );

  const totalCash = useMemo(() => locationsWithBalance.filter((l) => l.is_active).reduce((s, l) => s + l.balance, 0), [locationsWithBalance]);
  const totalPartnerOwed = useMemo(() => Array.from(partnerBalances.values()).filter((b) => b > 0).reduce((s, b) => s + b, 0), [partnerBalances]);
  const freeCash = totalCash - totalPartnerOwed;

  const openAddLoc = () => {
    setEditLoc(null);
    setLocForm({ name: "", location_type: "CUSTODIAN", custodian_partner_id: "", branch_id: "", opening_balance: "0", is_active: true });
    setIsLocOpen(true);
  };

  const openEditLoc = (l: CashLocation) => {
    setEditLoc(l);
    setLocForm({
      name: l.name, location_type: l.location_type,
      custodian_partner_id: l.custodian_partner_id ?? "", branch_id: l.branch_id ?? "",
      opening_balance: String(l.opening_balance), is_active: l.is_active,
    });
    setIsLocOpen(true);
  };

  const saveLoc = async () => {
    if (!companyId || !locForm.name.trim()) return;
    setLocSaving(true);
    setError(null);
    try {
      const payload = {
        company_id: companyId,
        name: locForm.name.trim(),
        location_type: locForm.location_type,
        custodian_partner_id: locForm.custodian_partner_id || null,
        branch_id: locForm.branch_id || null,
        opening_balance: parseFloat(locForm.opening_balance) || 0,
        is_active: locForm.is_active,
      };
      if (editLoc) {
        const { error: e } = await supabase.from("cash_locations").update(payload).eq("id", editLoc.id);
        if (e) throw e;
      } else {
        const { error: e } = await supabase.from("cash_locations").insert(payload);
        if (e) throw e;
      }
      setIsLocOpen(false);
      await loadData();
    } catch (e: any) { setError(e.message); }
    finally { setLocSaving(false); }
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

  if (loading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;

  return (
    <>
      <Header
        title="Cash Custody"
        subtitle="Track who holds company cash — banks, petty cash, and custodians"
        actions={
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
        }
      />

      <div className="flex-1 overflow-y-auto p-8">
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
              {locationsWithBalance.filter((l) => l.is_active).map((loc) => (
                <div key={loc.id} className="bg-white rounded-lg border border-slate-200 p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      {typeIcon(loc.location_type)}
                      <div>
                        <p className="text-sm font-medium text-slate-900">{loc.name}</p>
                        <p className="text-xs text-slate-500">{typeLabel(loc.location_type)}</p>
                      </div>
                    </div>
                  </div>
                  {loc.custodian_partner_id && (
                    <p className="text-xs text-slate-500 mb-2">Holder: {partners.find((p) => p.id === loc.custodian_partner_id)?.name ?? "—"}</p>
                  )}
                  <p className={`text-xl font-mono ${loc.balance < 0 ? "text-danger-600" : "text-slate-900"}`}>{fmt(loc.balance)}</p>
                </div>
              ))}
              {locationsWithBalance.filter((l) => l.is_active).length === 0 && (
                <div className="col-span-3 bg-white rounded-lg border border-slate-200 py-12 text-center text-slate-500 text-sm">
                  No active cash locations. Add one to get started.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── RECONCILIATION TAB ── */}
        {tab === "reconciliation" && (
          <div className="space-y-4">
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
                    const bal = partnerBalances.get(p.id) ?? 0;
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
                {locationsWithBalance.length === 0 && (
                  <tr><td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">No cash locations yet.</td></tr>
                )}
                {locationsWithBalance.map((loc) => (
                  <tr key={loc.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {typeIcon(loc.location_type)}
                        <span className="text-sm text-slate-900">{loc.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">{typeLabel(loc.location_type)}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">
                      {loc.custodian_partner_id ? partners.find((p) => p.id === loc.custodian_partner_id)?.name ?? "—" : "—"}
                    </td>
                    <td className="px-6 py-4 text-right text-sm font-mono text-slate-600">{fmt(loc.opening_balance)}</td>
                    <td className={`px-6 py-4 text-right text-sm font-mono ${loc.balance < 0 ? "text-danger-600" : "text-slate-900"}`}>{fmt(loc.balance)}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs ${loc.is_active ? "bg-success-50 text-success-700" : "bg-slate-100 text-slate-500"}`}>
                        {loc.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button onClick={() => openEditLoc(loc)} className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900 transition-colors">
                        <Pencil className="w-4 h-4" strokeWidth={1.5} />
                      </button>
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
      <Modal isOpen={isLocOpen} onClose={() => setIsLocOpen(false)} title={editLoc ? "Edit Cash Location" : "Add Cash Location"} size="md">
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Name *</label>
            <input type="text" placeholder="e.g. CEO Cash, Meezan Bank" value={locForm.name} onChange={(e) => setLocForm({ ...locForm, name: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Type</label>
              <select value={locForm.location_type} onChange={(e) => setLocForm({ ...locForm, location_type: e.target.value as any })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="BANK">Bank Account</option>
                <option value="PETTY_CASH">Petty Cash</option>
                <option value="CUSTODIAN">Custodian (person)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Opening Balance (PKR)</label>
              <input type="number" value={locForm.opening_balance} onChange={(e) => setLocForm({ ...locForm, opening_balance: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
          </div>
          {(locForm.location_type === "CUSTODIAN" || locForm.location_type === "PETTY_CASH") && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Holder (Partner)</label>
              <select value={locForm.custodian_partner_id} onChange={(e) => setLocForm({ ...locForm, custodian_partner_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">None</option>
                {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm text-slate-700 mb-1">Branch (optional)</label>
            <select value={locForm.branch_id} onChange={(e) => setLocForm({ ...locForm, branch_id: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
              <option value="">All / Company-wide</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
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
          <p className="text-sm text-slate-500">Move company cash between locations. This does not change who owns the money.</p>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Date *</label>
            <input type="date" value={transferForm.date} onChange={(e) => setTransferForm({ ...transferForm, date: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">From *</label>
              <select value={transferForm.from_location_id} onChange={(e) => setTransferForm({ ...transferForm, from_location_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select…</option>
                {locations.filter((l) => l.is_active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">To *</label>
              <select value={transferForm.to_location_id} onChange={(e) => setTransferForm({ ...transferForm, to_location_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select…</option>
                {locations.filter((l) => l.is_active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
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
