import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Pencil, AlertCircle, X, ChevronDown, Loader2, Download, ArrowDownLeft, ArrowUpRight, Landmark } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { supabase, fetchAllRows } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

const fmt = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;
const today = () => new Date().toISOString().slice(0, 10);

type Partner = {
  id: string;
  name: string;
  scope: "COMPANY" | "BRANCH";
  branch_id: string | null;
  allocation_method: "FIXED_PCT" | "MANUAL";
  default_share_pct: number | null;
  opening_balance: number;
  opening_balance_date: string | null;
  opening_balance_locked: boolean;
  is_active: boolean;
  start_month: string | null;
};

type Branch = { id: string; name: string };

type AccountEntry = {
  id: string;
  date: string;
  type: "OPENING" | "PROFIT_ALLOCATION" | "DRAWING" | "CONTRIBUTION";
  description: string;
  amount: number;
  payment_method: string | null;
  period_month: string | null;
  created_at: string;
};

type PartnerWithBalance = Partner & { balance: number };

const computeBalance = (opening: number, entries: AccountEntry[]): { balance: number; allocated: number; drawn: number; contributed: number } => {
  let balance = opening;
  let allocated = 0;
  let drawn = 0;
  let contributed = 0;
  for (const e of entries) {
    if (e.type === "PROFIT_ALLOCATION") { balance += e.amount; allocated += e.amount; }
    else if (e.type === "DRAWING") { balance -= e.amount; drawn += e.amount; }
    else if (e.type === "CONTRIBUTION") { balance += e.amount; contributed += e.amount; }
  }
  return { balance, allocated, drawn, contributed };
};

const PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "FUEL_CARD", "CHEQUE"] as const;

export default function Partners() {
  const { profile } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? null;

  const [tab, setTab] = useState<"partners" | "statement" | "summary">("partners");
  const [partners, setPartners] = useState<Partner[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Statement tab
  const [stmtPartner, setStmtPartner] = useState<string>("");
  const [stmtEntries, setStmtEntries] = useState<AccountEntry[]>([]);
  const [stmtLoading, setStmtLoading] = useState(false);
  const [stmtFrom, setStmtFrom] = useState("");
  const [stmtTo, setStmtTo] = useState(today());

  // Summary balances
  const [summaryData, setSummaryData] = useState<Map<string, { allocated: number; drawn: number; contributed: number; balance: number }>>(new Map());
  const [summaryLoading, setSummaryLoading] = useState(false);

  // Add/Edit Partner modal
  const [isPartnerOpen, setIsPartnerOpen] = useState(false);
  const [editPartner, setEditPartner] = useState<Partner | null>(null);
  const [partnerForm, setPartnerForm] = useState({
    name: "",
    scope: "COMPANY" as "COMPANY" | "BRANCH",
    branch_id: "",
    allocation_method: "MANUAL" as "FIXED_PCT" | "MANUAL",
    default_share_pct: "",
    opening_balance: "0",
    opening_balance_date: today(),
    is_active: true,
  });
  const [partnerSaving, setPartnerSaving] = useState(false);

  // Drawing modal
  const [isDrawingOpen, setIsDrawingOpen] = useState(false);
  const [drawingPartnerId, setDrawingPartnerId] = useState<string>("");
  const [drawingForm, setDrawingForm] = useState({ date: today(), amount: "", payment_method: "CASH" as typeof PAYMENT_METHODS[number], description: "" });
  const [drawingSaving, setDrawingSaving] = useState(false);

  // Contribution modal
  const [isContribOpen, setIsContribOpen] = useState(false);
  const [contribPartnerId, setContribPartnerId] = useState<string>("");
  const [contribForm, setContribForm] = useState({ date: today(), amount: "", payment_method: "CASH" as typeof PAYMENT_METHODS[number], description: "" });
  const [contribSaving, setContribSaving] = useState(false);

  // Profit Allocation modal
  const [isAllocOpen, setIsAllocOpen] = useState(false);
  const [allocPartnerId, setAllocPartnerId] = useState<string>("");
  const [allocForm, setAllocForm] = useState({ date: today(), amount: "", period_month: today().slice(0, 7), description: "Profit allocation" });
  const [allocSaving, setAllocSaving] = useState(false);

  const loadData = async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [{ data: p }, { data: b }] = await Promise.all([
        supabase.from("partners").select("*").eq("company_id", companyId).order("name"),
        supabase.from("branches").select("id, name").eq("company_id", companyId).order("name"),
      ]);
      setPartners((p ?? []) as Partner[]);
      setBranches((b ?? []) as Branch[]);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, [companyId]);

  const loadStatement = async (partnerId: string) => {
    if (!partnerId) return;
    setStmtLoading(true);
    try {
      let q = supabase.from("partner_account_entries").select("*").eq("partner_id", partnerId).order("date").order("created_at");
      if (stmtFrom) q = q.gte("date", stmtFrom);
      if (stmtTo) q = q.lte("date", stmtTo);
      const { data } = await q;
      setStmtEntries((data ?? []) as AccountEntry[]);
    } catch (e: any) { setError(e.message); }
    finally { setStmtLoading(false); }
  };

  useEffect(() => { if (stmtPartner) loadStatement(stmtPartner); }, [stmtPartner, stmtFrom, stmtTo]);

  const loadSummary = async () => {
    if (!companyId || partners.length === 0) return;
    setSummaryLoading(true);
    try {
      const { data } = await supabase.from("partner_account_entries").select("partner_id, type, amount").in("partner_id", partners.map((p) => p.id));
      const map = new Map<string, { allocated: number; drawn: number; contributed: number; balance: number }>();
      for (const p of partners) {
        const entries = (data ?? []).filter((e) => e.partner_id === p.id) as unknown as AccountEntry[];
        const res = computeBalance(p.opening_balance, entries);
        map.set(p.id, res);
      }
      setSummaryData(map);
    } catch (e: any) { setError(e.message); }
    finally { setSummaryLoading(false); }
  };

  useEffect(() => { if (tab === "summary" && partners.length > 0) loadSummary(); }, [tab, partners]);

  const openAddPartner = () => {
    setEditPartner(null);
    setPartnerForm({ name: "", scope: "COMPANY", branch_id: "", allocation_method: "MANUAL", default_share_pct: "", opening_balance: "0", opening_balance_date: today(), is_active: true });
    setIsPartnerOpen(true);
  };

  const openEditPartner = (p: Partner) => {
    setEditPartner(p);
    setPartnerForm({
      name: p.name, scope: p.scope, branch_id: p.branch_id ?? "",
      allocation_method: p.allocation_method, default_share_pct: p.default_share_pct != null ? String(p.default_share_pct) : "",
      opening_balance: String(p.opening_balance), opening_balance_date: p.opening_balance_date ?? today(),
      is_active: p.is_active,
    });
    setIsPartnerOpen(true);
  };

  const savePartner = async () => {
    if (!companyId || !partnerForm.name.trim()) return;
    setPartnerSaving(true);
    setError(null);
    try {
      const payload = {
        company_id: companyId,
        name: partnerForm.name.trim(),
        scope: partnerForm.scope,
        branch_id: partnerForm.scope === "BRANCH" && partnerForm.branch_id ? partnerForm.branch_id : null,
        allocation_method: partnerForm.allocation_method,
        default_share_pct: partnerForm.default_share_pct ? parseFloat(partnerForm.default_share_pct) : null,
        opening_balance: parseFloat(partnerForm.opening_balance) || 0,
        opening_balance_date: partnerForm.opening_balance_date || null,
        opening_balance_locked: editPartner?.opening_balance_locked ?? false,
        is_active: partnerForm.is_active,
      };
      if (editPartner) {
        const updatePayload: any = { ...payload };
        if (editPartner.opening_balance_locked) {
          delete updatePayload.opening_balance;
          delete updatePayload.opening_balance_date;
        }
        const { error: e } = await supabase.from("partners").update(updatePayload).eq("id", editPartner.id);
        if (e) throw e;
      } else {
        const { error: e } = await supabase.from("partners").insert({ ...payload, profit_share_percent: parseFloat(partnerForm.default_share_pct) || 0 });
        if (e) throw e;
      }
      setIsPartnerOpen(false);
      await loadData();
    } catch (e: any) { setError(e.message); }
    finally { setPartnerSaving(false); }
  };

  const saveDrawing = async () => {
    if (!companyId || !drawingPartnerId || !drawingForm.amount) return;
    setDrawingSaving(true);
    setError(null);
    try {
      const amt = parseFloat(drawingForm.amount);
      if (isNaN(amt) || amt <= 0) throw new Error("Enter a valid amount");
      const { error: e } = await supabase.from("partner_account_entries").insert({
        company_id: companyId, partner_id: drawingPartnerId,
        date: drawingForm.date, type: "DRAWING",
        description: drawingForm.description || "Drawing",
        amount: amt, payment_method: drawingForm.payment_method,
        created_by: profile?.id,
      });
      if (e) throw e;
      setIsDrawingOpen(false);
      if (stmtPartner === drawingPartnerId) loadStatement(drawingPartnerId);
      if (tab === "summary") loadSummary();
    } catch (e: any) { setError(e.message); }
    finally { setDrawingSaving(false); }
  };

  const saveContrib = async () => {
    if (!companyId || !contribPartnerId || !contribForm.amount) return;
    setContribSaving(true);
    setError(null);
    try {
      const amt = parseFloat(contribForm.amount);
      if (isNaN(amt) || amt <= 0) throw new Error("Enter a valid amount");
      const { error: e } = await supabase.from("partner_account_entries").insert({
        company_id: companyId, partner_id: contribPartnerId,
        date: contribForm.date, type: "CONTRIBUTION",
        description: contribForm.description || "Contribution",
        amount: amt, payment_method: contribForm.payment_method,
        created_by: profile?.id,
      });
      if (e) throw e;
      setIsContribOpen(false);
      if (stmtPartner === contribPartnerId) loadStatement(contribPartnerId);
      if (tab === "summary") loadSummary();
    } catch (e: any) { setError(e.message); }
    finally { setContribSaving(false); }
  };

  const saveAlloc = async () => {
    if (!companyId || !allocPartnerId || !allocForm.amount) return;
    setAllocSaving(true);
    setError(null);
    try {
      const amt = parseFloat(allocForm.amount);
      if (isNaN(amt)) throw new Error("Enter a valid amount");
      const { error: e } = await supabase.from("partner_account_entries").insert({
        company_id: companyId, partner_id: allocPartnerId,
        date: allocForm.date, type: "PROFIT_ALLOCATION",
        description: allocForm.description || "Profit allocation",
        amount: amt,
        period_month: allocForm.period_month ? `${allocForm.period_month}-01` : null,
        created_by: profile?.id,
      });
      if (e) throw e;
      setIsAllocOpen(false);
      if (stmtPartner === allocPartnerId) loadStatement(allocPartnerId);
      if (tab === "summary") loadSummary();
    } catch (e: any) { setError(e.message); }
    finally { setAllocSaving(false); }
  };

  const filteredPartners = useMemo(() => {
    const q = search.trim().toLowerCase();
    return partners.filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [partners, search]);

  const stmtPartnerObj = partners.find((p) => p.id === stmtPartner);
  const stmtStats = stmtPartnerObj ? computeBalance(stmtPartnerObj.opening_balance, stmtEntries) : null;

  const exportStatement = () => {
    if (!stmtPartnerObj || stmtEntries.length === 0) return;
    let running = stmtPartnerObj.opening_balance;
    const rows = [["Date", "Description", "Drawing (Out)", "Allocation (In)", "Contribution (In)", "Balance"]];
    rows.push(["", "Opening Balance", "", "", "", String(running)]);
    for (const e of stmtEntries) {
      let dr = "", cr = "", contrib = "";
      if (e.type === "DRAWING") { dr = String(e.amount); running -= e.amount; }
      else if (e.type === "PROFIT_ALLOCATION") { cr = String(e.amount); running += e.amount; }
      else if (e.type === "CONTRIBUTION") { contrib = String(e.amount); running += e.amount; }
      rows.push([e.date, e.description, dr, cr, contrib, String(running)]);
    }
    const csv = rows.map((r) => r.join(",")).join("\n");
    const a = document.createElement("a");
    a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    a.download = `${stmtPartnerObj.name} Statement.csv`;
    a.click();
  };

  const typeBadge = (type: AccountEntry["type"]) => {
    const cfg: Record<AccountEntry["type"], { label: string; cls: string }> = {
      OPENING: { label: "Opening", cls: "bg-slate-100 text-slate-700" },
      PROFIT_ALLOCATION: { label: "Allocation", cls: "bg-success-50 text-success-700" },
      DRAWING: { label: "Drawing", cls: "bg-danger-50 text-danger-700" },
      CONTRIBUTION: { label: "Contribution", cls: "bg-brand-50 text-brand-700" },
    };
    const c = cfg[type];
    return <span className={`inline-flex px-2 py-0.5 rounded text-xs ${c.cls}`}>{c.label}</span>;
  };

  if (loading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;

  return (
    <>
      <Header
        title="Partner Accounts"
        subtitle="Running ledger per partner — drawings, contributions, profit allocations"
        actions={
          <Button variant="primary" size="md" onClick={openAddPartner}>
            <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
            Add Partner
          </Button>
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
          {([["partners", "Partners"], ["statement", "Partner Statement"], ["summary", "Summary"]] as const).map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTab(key)}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${tab === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
              {label}
            </button>
          ))}
        </div>

        {/* ── PARTNERS TAB ── */}
        {tab === "partners" && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <div className="relative max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
                <input type="text" placeholder="Search partners…" value={search} onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
              </div>
            </div>

            <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Name</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Scope</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Method</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Default %</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredPartners.length === 0 && (
                    <tr><td colSpan={6} className="px-6 py-10 text-center text-slate-500 text-sm">No partners yet.</td></tr>
                  )}
                  {filteredPartners.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4">
                        <p className="text-sm text-slate-900 font-medium">{p.name}</p>
                        {p.branch_id && <p className="text-xs text-slate-500">{branches.find((b) => b.id === p.branch_id)?.name ?? ""}</p>}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs ${p.scope === "COMPANY" ? "bg-brand-50 text-brand-700" : "bg-amber-50 text-amber-700"}`}>
                          {p.scope === "COMPANY" ? "Company" : "Branch"}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{p.allocation_method === "MANUAL" ? "Manual" : "Fixed %"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{p.default_share_pct != null ? `${p.default_share_pct}%` : "—"}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs ${p.is_active ? "bg-success-50 text-success-700" : "bg-slate-100 text-slate-500"}`}>
                          {p.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <button title="View Statement" onClick={() => { setStmtPartner(p.id); setTab("statement"); }}
                            className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900 transition-colors">
                            <Landmark className="w-4 h-4" strokeWidth={1.5} />
                          </button>
                          <button title="Record Drawing" onClick={() => { setDrawingPartnerId(p.id); setDrawingForm({ date: today(), amount: "", payment_method: "CASH", description: "" }); setIsDrawingOpen(true); }}
                            className="p-1.5 rounded hover:bg-danger-50 text-slate-500 hover:text-danger-600 transition-colors">
                            <ArrowUpRight className="w-4 h-4" strokeWidth={1.5} />
                          </button>
                          <button title="Record Contribution" onClick={() => { setContribPartnerId(p.id); setContribForm({ date: today(), amount: "", payment_method: "CASH", description: "" }); setIsContribOpen(true); }}
                            className="p-1.5 rounded hover:bg-success-50 text-slate-500 hover:text-success-600 transition-colors">
                            <ArrowDownLeft className="w-4 h-4" strokeWidth={1.5} />
                          </button>
                          <button title="Edit" onClick={() => openEditPartner(p)}
                            className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900 transition-colors">
                            <Pencil className="w-4 h-4" strokeWidth={1.5} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── STATEMENT TAB ── */}
        {tab === "statement" && (
          <div className="space-y-4">
            {/* Controls */}
            <div className="bg-white rounded-lg border border-slate-200 p-4 flex flex-wrap gap-4 items-end">
              <div className="flex-1 min-w-[180px]">
                <label className="block text-sm text-slate-700 mb-2">Partner</label>
                <select value={stmtPartner} onChange={(e) => setStmtPartner(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="">Select partner…</option>
                  {partners.filter((p) => p.is_active).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-2">From</label>
                <input type="date" value={stmtFrom} onChange={(e) => setStmtFrom(e.target.value)}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
              </div>
              <div>
                <label className="block text-sm text-slate-700 mb-2">To</label>
                <input type="date" value={stmtTo} onChange={(e) => setStmtTo(e.target.value)}
                  className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
              </div>
              {stmtPartner && (
                <>
                  <Button variant="secondary" size="md" onClick={() => { setIsAllocOpen(true); setAllocPartnerId(stmtPartner); setAllocForm({ date: today(), amount: "", period_month: today().slice(0, 7), description: "Profit allocation" }); }}>
                    Profit Allocation
                  </Button>
                  <Button variant="secondary" size="md" onClick={exportStatement} disabled={stmtEntries.length === 0}>
                    <Download className="w-4 h-4 mr-2" strokeWidth={1.5} /> Export CSV
                  </Button>
                </>
              )}
            </div>

            {/* Summary strip */}
            {stmtPartnerObj && stmtStats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: "Allocated", value: stmtStats.allocated, cls: "border-l-success-500" },
                  { label: "Drawn", value: stmtStats.drawn, cls: "border-l-danger-500" },
                  { label: "Contributed", value: stmtStats.contributed, cls: "border-l-brand-500" },
                  { label: "Net Balance", value: stmtStats.balance, cls: stmtStats.balance >= 0 ? "border-l-success-500" : "border-l-danger-500" },
                ].map((s) => (
                  <div key={s.label} className={`bg-white rounded-lg border border-slate-200 border-l-4 ${s.cls} p-4`}>
                    <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{s.label}</p>
                    <p className={`text-lg font-mono ${s.label === "Net Balance" && s.value < 0 ? "text-danger-700" : "text-slate-900"}`}>{fmt(s.value)}</p>
                    {s.label === "Net Balance" && s.value < 0 && <p className="text-[10px] text-danger-500 mt-0.5">Partner overdrawn</p>}
                    {s.label === "Net Balance" && s.value > 0 && <p className="text-[10px] text-success-600 mt-0.5">Company owes partner</p>}
                  </div>
                ))}
              </div>
            )}

            {/* Ledger table */}
            {stmtPartner && (
              <div className="bg-white rounded-lg border border-slate-200">
                <div className="p-4 border-b border-slate-200">
                  <h3 className="text-base text-slate-900">Ledger — {stmtPartnerObj?.name ?? ""}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">Opening balance: {fmt(stmtPartnerObj?.opening_balance ?? 0)}</p>
                </div>
                {stmtLoading ? (
                  <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-slate-200">
                          <th className="text-left px-6 py-3 text-sm text-slate-500">Date</th>
                          <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                          <th className="text-left px-6 py-3 text-sm text-slate-500">Particulars</th>
                          <th className="text-left px-6 py-3 text-sm text-slate-500">Method</th>
                          <th className="text-right px-6 py-3 text-sm text-slate-500">Drawing (Out)</th>
                          <th className="text-right px-6 py-3 text-sm text-slate-500">Allocation (In)</th>
                          <th className="text-right px-6 py-3 text-sm text-slate-500">Contribution (In)</th>
                          <th className="text-right px-6 py-3 text-sm text-slate-500">Balance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {(() => {
                          let running = stmtPartnerObj?.opening_balance ?? 0;
                          return [
                            <tr key="opening" className="bg-slate-50">
                              <td className="px-6 py-3 text-xs text-slate-500">{stmtPartnerObj?.opening_balance_date ?? "—"}</td>
                              <td className="px-6 py-3">{typeBadge("OPENING")}</td>
                              <td className="px-6 py-3 text-sm text-slate-600">Opening Balance</td>
                              <td className="px-6 py-3 text-sm text-slate-500">—</td>
                              <td className="px-6 py-3 text-right"></td>
                              <td className="px-6 py-3 text-right"></td>
                              <td className="px-6 py-3 text-right"></td>
                              <td className={`px-6 py-3 text-right text-sm font-mono ${running < 0 ? "text-danger-600" : "text-slate-900"}`}>{fmt(running)}</td>
                            </tr>,
                            ...stmtEntries.map((e) => {
                              let dr = 0, cr = 0, contrib = 0;
                              if (e.type === "DRAWING") { dr = e.amount; running -= e.amount; }
                              else if (e.type === "PROFIT_ALLOCATION") { cr = e.amount; running += e.amount; }
                              else if (e.type === "CONTRIBUTION") { contrib = e.amount; running += e.amount; }
                              return (
                                <tr key={e.id} className="hover:bg-slate-50 transition-colors">
                                  <td className="px-6 py-3 text-xs text-slate-500">{e.date}</td>
                                  <td className="px-6 py-3">{typeBadge(e.type)}</td>
                                  <td className="px-6 py-3 text-sm text-slate-900">{e.description}{e.period_month ? <span className="ml-2 text-xs text-slate-400">({e.period_month.slice(0, 7)})</span> : null}</td>
                                  <td className="px-6 py-3 text-xs text-slate-500">{e.payment_method ?? "—"}</td>
                                  <td className="px-6 py-3 text-right text-sm text-danger-600">{dr > 0 ? fmt(dr) : ""}</td>
                                  <td className="px-6 py-3 text-right text-sm text-success-600">{cr !== 0 ? fmt(Math.abs(cr)) : ""}</td>
                                  <td className="px-6 py-3 text-right text-sm text-brand-600">{contrib > 0 ? fmt(contrib) : ""}</td>
                                  <td className={`px-6 py-3 text-right text-sm font-mono ${running < 0 ? "text-danger-600" : "text-slate-900"}`}>{fmt(running)}</td>
                                </tr>
                              );
                            }),
                          ];
                        })()}
                        {stmtEntries.length === 0 && (
                          <tr><td colSpan={8} className="px-6 py-8 text-center text-slate-500 text-sm">No entries in this range.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
            {!stmtPartner && (
              <div className="bg-white rounded-lg border border-slate-200 py-16 text-center text-slate-500 text-sm">
                Select a partner to view their statement.
              </div>
            )}
          </div>
        )}

        {/* ── SUMMARY TAB ── */}
        {tab === "summary" && (
          <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
            {summaryLoading ? (
              <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Partner</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Scope</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Opening</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Allocated</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Contributed</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Drawn</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Net Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {partners.length === 0 && (
                    <tr><td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">No partners.</td></tr>
                  )}
                  {partners.map((p) => {
                    const s = summaryData.get(p.id);
                    return (
                      <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4">
                          <p className="text-sm text-slate-900 font-medium">{p.name}</p>
                          {p.branch_id && <p className="text-xs text-slate-500">{branches.find((b) => b.id === p.branch_id)?.name}</p>}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex px-2 py-0.5 rounded text-xs ${p.scope === "COMPANY" ? "bg-brand-50 text-brand-700" : "bg-amber-50 text-amber-700"}`}>
                            {p.scope === "COMPANY" ? "Company" : "Branch"}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right text-sm font-mono text-slate-700">{fmt(p.opening_balance)}</td>
                        <td className="px-6 py-4 text-right text-sm font-mono text-success-600">{s ? fmt(s.allocated) : "—"}</td>
                        <td className="px-6 py-4 text-right text-sm font-mono text-brand-600">{s ? fmt(s.contributed) : "—"}</td>
                        <td className="px-6 py-4 text-right text-sm font-mono text-danger-600">{s ? fmt(s.drawn) : "—"}</td>
                        <td className={`px-6 py-4 text-right text-sm font-mono font-semibold ${s && s.balance < 0 ? "text-danger-700" : "text-slate-900"}`}>
                          {s ? fmt(s.balance) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {partners.length > 0 && summaryData.size > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 bg-slate-50">
                      <td colSpan={3} className="px-6 py-3 text-sm font-medium text-slate-700">Total</td>
                      <td className="px-6 py-3 text-right text-sm font-mono font-semibold text-success-700">
                        {fmt(Array.from(summaryData.values()).reduce((s, d) => s + d.allocated, 0))}
                      </td>
                      <td className="px-6 py-3 text-right text-sm font-mono font-semibold text-brand-700">
                        {fmt(Array.from(summaryData.values()).reduce((s, d) => s + d.contributed, 0))}
                      </td>
                      <td className="px-6 py-3 text-right text-sm font-mono font-semibold text-danger-700">
                        {fmt(Array.from(summaryData.values()).reduce((s, d) => s + d.drawn, 0))}
                      </td>
                      <td className="px-6 py-3 text-right text-sm font-mono font-semibold text-slate-900">
                        {fmt(Array.from(summaryData.values()).reduce((s, d) => s + d.balance, 0))}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            )}
          </div>
        )}
      </div>

      {/* ── Add/Edit Partner Modal ── */}
      <Modal isOpen={isPartnerOpen} onClose={() => setIsPartnerOpen(false)} title={editPartner ? "Edit Partner" : "Add Partner"} size="md">
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Name *</label>
            <input type="text" value={partnerForm.name} onChange={(e) => setPartnerForm({ ...partnerForm, name: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Scope</label>
              <select value={partnerForm.scope} onChange={(e) => setPartnerForm({ ...partnerForm, scope: e.target.value as any })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="COMPANY">Company (owner)</option>
                <option value="BRANCH">Branch (regional partner)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Allocation Method</label>
              <select value={partnerForm.allocation_method} onChange={(e) => setPartnerForm({ ...partnerForm, allocation_method: e.target.value as any })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="MANUAL">Manual (typed each period)</option>
                <option value="FIXED_PCT">Fixed % (auto-computed)</option>
              </select>
            </div>
          </div>
          {partnerForm.scope === "BRANCH" && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Branch</label>
              <select value={partnerForm.branch_id} onChange={(e) => setPartnerForm({ ...partnerForm, branch_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select branch…</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Default Share %</label>
              <input type="number" min="0" max="100" step="0.01" value={partnerForm.default_share_pct}
                onChange={(e) => setPartnerForm({ ...partnerForm, default_share_pct: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">
                Opening Balance {editPartner?.opening_balance_locked && <span className="text-xs text-slate-400 ml-1">(locked)</span>}
              </label>
              <input type="number" value={partnerForm.opening_balance}
                onChange={(e) => setPartnerForm({ ...partnerForm, opening_balance: e.target.value })}
                disabled={editPartner?.opening_balance_locked}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:bg-slate-50 disabled:text-slate-400" />
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Opening Balance Date</label>
            <input type="date" value={partnerForm.opening_balance_date} disabled={editPartner?.opening_balance_locked}
              onChange={(e) => setPartnerForm({ ...partnerForm, opening_balance_date: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 disabled:bg-slate-50 disabled:text-slate-400" />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={partnerForm.is_active} onChange={(e) => setPartnerForm({ ...partnerForm, is_active: e.target.checked })} className="rounded border-slate-300" />
            Active
          </label>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" onClick={savePartner} disabled={partnerSaving}>
              {partnerSaving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : editPartner ? "Save Changes" : "Add Partner"}
            </Button>
            <Button variant="secondary" size="md" className="flex-1" onClick={() => setIsPartnerOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* ── Drawing Modal ── */}
      <Modal isOpen={isDrawingOpen} onClose={() => setIsDrawingOpen(false)} title="Record Drawing" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-slate-500">Payment <strong>out</strong> to the partner. Does not hit P&L.</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Date *</label>
              <input type="date" value={drawingForm.date} onChange={(e) => setDrawingForm({ ...drawingForm, date: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
              <input type="number" min="0" placeholder="0" value={drawingForm.amount} onChange={(e) => setDrawingForm({ ...drawingForm, amount: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Payment Method</label>
            <select value={drawingForm.payment_method} onChange={(e) => setDrawingForm({ ...drawingForm, payment_method: e.target.value as any })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Description</label>
            <input type="text" placeholder="e.g. Cash paid, Fuel card…" value={drawingForm.description} onChange={(e) => setDrawingForm({ ...drawingForm, description: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="danger" size="md" className="flex-1" onClick={saveDrawing} disabled={drawingSaving}>
              {drawingSaving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Record Drawing"}
            </Button>
            <Button variant="secondary" size="md" className="flex-1" onClick={() => setIsDrawingOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* ── Contribution Modal ── */}
      <Modal isOpen={isContribOpen} onClose={() => setIsContribOpen(false)} title="Record Contribution" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-slate-500">Partner's own money put <strong>into</strong> the company. Does not hit P&L.</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Date *</label>
              <input type="date" value={contribForm.date} onChange={(e) => setContribForm({ ...contribForm, date: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
              <input type="number" min="0" placeholder="0" value={contribForm.amount} onChange={(e) => setContribForm({ ...contribForm, amount: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Payment Method</label>
            <select value={contribForm.payment_method} onChange={(e) => setContribForm({ ...contribForm, payment_method: e.target.value as any })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Description</label>
            <input type="text" placeholder="e.g. Capital injection" value={contribForm.description} onChange={(e) => setContribForm({ ...contribForm, description: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" onClick={saveContrib} disabled={contribSaving}>
              {contribSaving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Record Contribution"}
            </Button>
            <Button variant="secondary" size="md" className="flex-1" onClick={() => setIsContribOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* ── Profit Allocation Modal ── */}
      <Modal isOpen={isAllocOpen} onClose={() => setIsAllocOpen(false)} title="Record Profit Allocation" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-slate-500">Post partner's profit share for a period. Use a negative amount for a loss share.</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Date *</label>
              <input type="date" value={allocForm.date} onChange={(e) => setAllocForm({ ...allocForm, date: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Period (Month)</label>
              <input type="month" value={allocForm.period_month} onChange={(e) => setAllocForm({ ...allocForm, period_month: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
            <input type="number" placeholder="0 (negative for loss)" value={allocForm.amount} onChange={(e) => setAllocForm({ ...allocForm, amount: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Description</label>
            <input type="text" value={allocForm.description} onChange={(e) => setAllocForm({ ...allocForm, description: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" onClick={saveAlloc} disabled={allocSaving}>
              {allocSaving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Post Allocation"}
            </Button>
            <Button variant="secondary" size="md" className="flex-1" onClick={() => setIsAllocOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
