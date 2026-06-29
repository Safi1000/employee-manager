import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, AlertCircle, X, Loader2, Trash2, ChevronDown, ChevronRight, TrendingUp, DollarSign } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

const fmt = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;
const today = () => new Date().toISOString().slice(0, 10);

type Client = { id: string; name: string };
type Partner = { id: string; name: string };
type CashLocation = { id: string; name: string };

type Project = {
  id: string;
  name: string;
  client_id: string | null;
  total_required: number;
  reserved_profit_pct: number;
  payout_gate: "COMPANY_CASHFLOW" | "PROJECT_CASHFLOW";
  status: "Raising" | "Active" | "Completed";
  notes: string | null;
};

type Investor = {
  id: string;
  name: string;
  type: "PARTNER" | "THIRD_PARTY";
  linked_partner_id: string | null;
  is_active: boolean;
};

type ProjectInvestment = {
  id: string;
  project_id: string;
  investor_id: string;
  return_type: "PROFIT_SHARE" | "FIXED_FINANCE";
  committed_amount: number;
  fixed_cost_amount: number | null;
};

type LedgerEntry = {
  id: string;
  investor_id: string;
  project_id: string;
  date: string;
  type: "CAPITAL_IN" | "CAPITAL_REPAYMENT" | "RETURN_ALLOCATION" | "RETURN_PAYOUT" | "FINANCE_COST_ACCRUAL" | "FINANCE_COST_PAYMENT";
  amount: number;
  description: string | null;
};

const STATUS_COLORS: Record<Project["status"], string> = {
  Raising: "bg-warning-50 text-warning-700",
  Active: "bg-success-50 text-success-700",
  Completed: "bg-slate-100 text-slate-600",
};

const ENTRY_TYPES = ["CAPITAL_IN", "CAPITAL_REPAYMENT", "RETURN_ALLOCATION", "RETURN_PAYOUT", "FINANCE_COST_ACCRUAL", "FINANCE_COST_PAYMENT"] as const;

const ENTRY_COLORS: Record<LedgerEntry["type"], string> = {
  CAPITAL_IN: "bg-brand-50 text-brand-700",
  CAPITAL_REPAYMENT: "bg-slate-100 text-slate-700",
  RETURN_ALLOCATION: "bg-success-50 text-success-700",
  RETURN_PAYOUT: "bg-success-100 text-success-800",
  FINANCE_COST_ACCRUAL: "bg-danger-50 text-danger-700",
  FINANCE_COST_PAYMENT: "bg-danger-100 text-danger-800",
};

export default function ProjectFinancing() {
  const { profile } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? null;

  const [tab, setTab] = useState<"projects" | "investors" | "ledger">("projects");
  const [clients, setClients] = useState<Client[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [cashLocs, setCashLocs] = useState<CashLocation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [investors, setInvestors] = useState<Investor[]>([]);
  const [investments, setInvestments] = useState<ProjectInvestment[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  // Ledger tab filters
  const [ledgerProjectId, setLedgerProjectId] = useState<string>("");
  const [ledgerInvestorId, setLedgerInvestorId] = useState<string>("");

  // Add/Edit Project
  const [isProjOpen, setIsProjOpen] = useState(false);
  const [editProj, setEditProj] = useState<Project | null>(null);
  const [projForm, setProjForm] = useState({
    name: "", client_id: "", total_required: "", reserved_profit_pct: "0",
    payout_gate: "COMPANY_CASHFLOW" as Project["payout_gate"],
    status: "Raising" as Project["status"], notes: "",
  });
  const [projSaving, setProjSaving] = useState(false);

  // Add/Edit Investor
  const [isInvOpen, setIsInvOpen] = useState(false);
  const [editInv, setEditInv] = useState<Investor | null>(null);
  const [invForm, setInvForm] = useState({ name: "", type: "THIRD_PARTY" as "PARTNER" | "THIRD_PARTY", linked_partner_id: "", is_active: true });
  const [invSaving, setInvSaving] = useState(false);

  // Add Investment (investor → project)
  const [isInvestmentOpen, setIsInvestmentOpen] = useState(false);
  const [investmentProjectId, setInvestmentProjectId] = useState<string>("");
  const [invmtForm, setInvmtForm] = useState({
    investor_id: "", return_type: "PROFIT_SHARE" as "PROFIT_SHARE" | "FIXED_FINANCE",
    committed_amount: "", fixed_cost_amount: "",
  });
  const [invmtSaving, setInvmtSaving] = useState(false);

  // Add Ledger Entry
  const [isLedgerOpen, setIsLedgerOpen] = useState(false);
  const [ledgerForm, setLedgerForm] = useState({
    investor_id: "", project_id: "", date: today(),
    type: "CAPITAL_IN" as LedgerEntry["type"],
    amount: "", description: "", cash_location_id: "",
  });
  const [ledgerSaving, setLedgerSaving] = useState(false);

  const loadData = async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [{ data: cl }, { data: pt }, { data: lc }, { data: pr }, { data: inv }, { data: invmt }, { data: le }] = await Promise.all([
        supabase.from("clients").select("id, name").eq("company_id", companyId).eq("is_active", true).order("name"),
        supabase.from("partners").select("id, name").eq("company_id", companyId).eq("is_active", true).order("name"),
        supabase.from("cash_locations").select("id, name").eq("company_id", companyId).eq("is_active", true).order("name"),
        supabase.from("finance_projects").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
        supabase.from("finance_investors").select("*").eq("company_id", companyId).order("name"),
        supabase.from("project_investments").select("*").eq("company_id", companyId),
        supabase.from("investor_ledger_entries").select("*").eq("company_id", companyId).order("date", { ascending: false }),
      ]);
      setClients((cl ?? []) as Client[]);
      setPartners((pt ?? []) as Partner[]);
      setCashLocs((lc ?? []) as CashLocation[]);
      setProjects((pr ?? []) as Project[]);
      setInvestors((inv ?? []) as Investor[]);
      setInvestments((invmt ?? []) as ProjectInvestment[]);
      setLedgerEntries((le ?? []) as LedgerEntry[]);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, [companyId]);

  const clientName = (id: string | null) => id ? (clients.find((c) => c.id === id)?.name ?? "—") : "—";
  const investorName = (id: string) => investors.find((i) => i.id === id)?.name ?? "—";
  const projName = (id: string) => projects.find((p) => p.id === id)?.name ?? "—";

  const openAddProject = () => {
    setEditProj(null);
    setProjForm({ name: "", client_id: "", total_required: "", reserved_profit_pct: "0", payout_gate: "COMPANY_CASHFLOW", status: "Raising", notes: "" });
    setIsProjOpen(true);
  };

  const saveProject = async () => {
    if (!companyId || !projForm.name.trim()) return;
    setProjSaving(true);
    setError(null);
    try {
      const payload = {
        company_id: companyId,
        name: projForm.name.trim(),
        client_id: projForm.client_id || null,
        total_required: parseFloat(projForm.total_required) || 0,
        reserved_profit_pct: parseFloat(projForm.reserved_profit_pct) || 0,
        payout_gate: projForm.payout_gate,
        status: projForm.status,
        notes: projForm.notes || null,
      };
      if (editProj) {
        const { error: e } = await supabase.from("finance_projects").update(payload).eq("id", editProj.id);
        if (e) throw e;
      } else {
        const { error: e } = await supabase.from("finance_projects").insert(payload);
        if (e) throw e;
      }
      setIsProjOpen(false);
      await loadData();
    } catch (e: any) { setError(e.message); }
    finally { setProjSaving(false); }
  };

  const openAddInvestor = () => {
    setEditInv(null);
    setInvForm({ name: "", type: "THIRD_PARTY", linked_partner_id: "", is_active: true });
    setIsInvOpen(true);
  };

  const saveInvestor = async () => {
    if (!companyId || !invForm.name.trim()) return;
    setInvSaving(true);
    setError(null);
    try {
      const payload = {
        company_id: companyId,
        name: invForm.name.trim(),
        type: invForm.type,
        linked_partner_id: invForm.type === "PARTNER" && invForm.linked_partner_id ? invForm.linked_partner_id : null,
        is_active: invForm.is_active,
      };
      if (editInv) {
        const { error: e } = await supabase.from("finance_investors").update(payload).eq("id", editInv.id);
        if (e) throw e;
      } else {
        const { error: e } = await supabase.from("finance_investors").insert(payload);
        if (e) throw e;
      }
      setIsInvOpen(false);
      await loadData();
    } catch (e: any) { setError(e.message); }
    finally { setInvSaving(false); }
  };

  const saveInvestment = async () => {
    if (!companyId || !investmentProjectId || !invmtForm.investor_id || !invmtForm.committed_amount) return;
    setInvmtSaving(true);
    setError(null);
    try {
      const { error: e } = await supabase.from("project_investments").insert({
        company_id: companyId,
        project_id: investmentProjectId,
        investor_id: invmtForm.investor_id,
        return_type: invmtForm.return_type,
        committed_amount: parseFloat(invmtForm.committed_amount) || 0,
        fixed_cost_amount: invmtForm.return_type === "FIXED_FINANCE" && invmtForm.fixed_cost_amount ? parseFloat(invmtForm.fixed_cost_amount) : null,
      });
      if (e) throw e;
      setIsInvestmentOpen(false);
      await loadData();
    } catch (e: any) { setError(e.message); }
    finally { setInvmtSaving(false); }
  };

  const saveLedgerEntry = async () => {
    if (!companyId || !ledgerForm.investor_id || !ledgerForm.project_id || !ledgerForm.amount) return;
    setLedgerSaving(true);
    setError(null);
    try {
      const { error: e } = await supabase.from("investor_ledger_entries").insert({
        company_id: companyId,
        investor_id: ledgerForm.investor_id,
        project_id: ledgerForm.project_id,
        date: ledgerForm.date,
        type: ledgerForm.type,
        amount: parseFloat(ledgerForm.amount),
        description: ledgerForm.description || null,
        cash_location_id: ledgerForm.cash_location_id || null,
        created_by: profile?.id,
      });
      if (e) throw e;
      setIsLedgerOpen(false);
      await loadData();
    } catch (e: any) { setError(e.message); }
    finally { setLedgerSaving(false); }
  };

  const getProjectTotals = (projectId: string) => {
    const invmts = investments.filter((i) => i.project_id === projectId);
    const totalCommitted = invmts.reduce((s, i) => s + i.committed_amount, 0);
    return { totalCommitted, investorCount: invmts.length };
  };

  const getInvestorLedger = (investorId: string, projectId?: string) => {
    const entries = ledgerEntries.filter((e) => e.investor_id === investorId && (!projectId || e.project_id === projectId));
    const capitalIn = entries.filter((e) => e.type === "CAPITAL_IN").reduce((s, e) => s + e.amount, 0);
    const capitalRepaid = entries.filter((e) => e.type === "CAPITAL_REPAYMENT").reduce((s, e) => s + e.amount, 0);
    const returnAlloc = entries.filter((e) => e.type === "RETURN_ALLOCATION" || e.type === "FINANCE_COST_ACCRUAL").reduce((s, e) => s + e.amount, 0);
    const returnPaid = entries.filter((e) => e.type === "RETURN_PAYOUT" || e.type === "FINANCE_COST_PAYMENT").reduce((s, e) => s + e.amount, 0);
    return {
      capitalOutstanding: capitalIn - capitalRepaid,
      returnBalance: returnAlloc - returnPaid,
    };
  };

  const filteredLedger = useMemo(() => {
    return ledgerEntries.filter((e) =>
      (!ledgerProjectId || e.project_id === ledgerProjectId) &&
      (!ledgerInvestorId || e.investor_id === ledgerInvestorId)
    );
  }, [ledgerEntries, ledgerProjectId, ledgerInvestorId]);

  if (loading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;

  return (
    <>
      <Header
        title="Project Financing"
        subtitle="Track investors, capital, and returns for funded projects"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={() => { setIsLedgerOpen(true); setLedgerForm({ investor_id: "", project_id: "", date: today(), type: "CAPITAL_IN", amount: "", description: "", cash_location_id: "" }); }}>
              Record Entry
            </Button>
            {tab === "projects" && (
              <Button variant="primary" size="md" onClick={openAddProject}>
                <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                New Project
              </Button>
            )}
            {tab === "investors" && (
              <Button variant="primary" size="md" onClick={openAddInvestor}>
                <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                Add Investor
              </Button>
            )}
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
          {([["projects", "Projects"], ["investors", "Investors"], ["ledger", "Capital & Returns"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${tab === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
              {l}
            </button>
          ))}
        </div>

        {/* ── PROJECTS TAB ── */}
        {tab === "projects" && (
          <div className="space-y-3">
            {projects.length === 0 && (
              <div className="bg-white rounded-lg border border-slate-200 py-12 text-center text-slate-500 text-sm">
                No projects yet. Add one to start tracking investor capital.
              </div>
            )}
            {projects.map((p) => {
              const { totalCommitted, investorCount } = getProjectTotals(p.id);
              const isExpanded = expandedProject === p.id;
              const projInvestments = investments.filter((i) => i.project_id === p.id);
              return (
                <div key={p.id} className="bg-white rounded-lg border border-slate-200">
                  <div className="flex items-center justify-between p-4 cursor-pointer select-none" onClick={() => setExpandedProject(isExpanded ? null : p.id)}>
                    <div className="flex items-center gap-3">
                      {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                      <div>
                        <p className="text-sm font-medium text-slate-900">{p.name}</p>
                        <p className="text-xs text-slate-500">
                          {p.client_id ? clientName(p.client_id) : "No client"} · {investorCount} investor{investorCount !== 1 ? "s" : ""} · {fmt(totalCommitted)} committed / {fmt(p.total_required)} required · {p.reserved_profit_pct}% reserved
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs ${STATUS_COLORS[p.status]}`}>{p.status}</span>
                      <button onClick={(e) => { e.stopPropagation(); setEditProj(p); setProjForm({ name: p.name, client_id: p.client_id ?? "", total_required: String(p.total_required), reserved_profit_pct: String(p.reserved_profit_pct), payout_gate: p.payout_gate, status: p.status, notes: p.notes ?? "" }); setIsProjOpen(true); }}
                        className="p-1 rounded hover:bg-slate-100 text-slate-500">
                        <Pencil className="w-3.5 h-3.5" strokeWidth={1.5} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); setInvestmentProjectId(p.id); setInvmtForm({ investor_id: "", return_type: "PROFIT_SHARE", committed_amount: "", fixed_cost_amount: "" }); setIsInvestmentOpen(true); }}
                        className="p-1 rounded hover:bg-brand-50 text-slate-500 hover:text-brand-600" title="Add Investor">
                        <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-slate-200 p-4">
                      {p.notes && <p className="text-xs text-slate-500 mb-3 italic">{p.notes}</p>}
                      {projInvestments.length === 0 ? (
                        <p className="text-sm text-slate-400 text-center py-4">No investors linked yet. Click + to add.</p>
                      ) : (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-slate-100">
                              <th className="text-left py-2 text-xs text-slate-500">Investor</th>
                              <th className="text-left py-2 text-xs text-slate-500">Return Type</th>
                              <th className="text-right py-2 text-xs text-slate-500">Committed</th>
                              <th className="text-right py-2 text-xs text-slate-500">Capital Outstanding</th>
                              <th className="text-right py-2 text-xs text-slate-500">Return Owed</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {projInvestments.map((inv) => {
                              const { capitalOutstanding, returnBalance } = getInvestorLedger(inv.investor_id, p.id);
                              return (
                                <tr key={inv.id}>
                                  <td className="py-2 text-slate-900">{investorName(inv.investor_id)}</td>
                                  <td className="py-2">
                                    <span className={`inline-flex px-2 py-0.5 rounded text-xs ${inv.return_type === "PROFIT_SHARE" ? "bg-success-50 text-success-700" : "bg-warning-50 text-warning-700"}`}>
                                      {inv.return_type === "PROFIT_SHARE" ? "Profit Share" : "Fixed Finance"}
                                    </span>
                                  </td>
                                  <td className="py-2 text-right font-mono">{fmt(inv.committed_amount)}</td>
                                  <td className={`py-2 text-right font-mono ${capitalOutstanding > 0 ? "text-brand-700" : "text-slate-500"}`}>{fmt(capitalOutstanding)}</td>
                                  <td className={`py-2 text-right font-mono ${returnBalance > 0 ? "text-success-700" : "text-slate-500"}`}>{fmt(returnBalance)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── INVESTORS TAB ── */}
        {tab === "investors" && (
          <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Investor</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Linked Partner</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Capital Outstanding</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Return Balance</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {investors.length === 0 && (
                  <tr><td colSpan={7} className="px-6 py-10 text-center text-slate-500 text-sm">No investors yet.</td></tr>
                )}
                {investors.map((inv) => {
                  const { capitalOutstanding, returnBalance } = getInvestorLedger(inv.id);
                  return (
                    <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 text-sm font-medium text-slate-900">{inv.name}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs ${inv.type === "PARTNER" ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-700"}`}>
                          {inv.type === "PARTNER" ? "Partner" : "Third Party"}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {inv.linked_partner_id ? partners.find((p) => p.id === inv.linked_partner_id)?.name ?? "—" : "—"}
                      </td>
                      <td className={`px-6 py-4 text-right text-sm font-mono ${capitalOutstanding > 0 ? "text-brand-700" : "text-slate-500"}`}>{fmt(capitalOutstanding)}</td>
                      <td className={`px-6 py-4 text-right text-sm font-mono ${returnBalance > 0 ? "text-success-700" : "text-slate-500"}`}>{fmt(returnBalance)}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs ${inv.is_active ? "bg-success-50 text-success-700" : "bg-slate-100 text-slate-500"}`}>
                          {inv.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button onClick={() => { setEditInv(inv); setInvForm({ name: inv.name, type: inv.type, linked_partner_id: inv.linked_partner_id ?? "", is_active: inv.is_active }); setIsInvOpen(true); }}
                          className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900 transition-colors">
                          <Pencil className="w-4 h-4" strokeWidth={1.5} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── LEDGER TAB ── */}
        {tab === "ledger" && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg border border-slate-200 p-4 flex flex-wrap gap-4">
              <div className="flex-1 min-w-[180px]">
                <label className="block text-sm text-slate-700 mb-1">Project</label>
                <select value={ledgerProjectId} onChange={(e) => setLedgerProjectId(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="">All Projects</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-[180px]">
                <label className="block text-sm text-slate-700 mb-1">Investor</label>
                <select value={ledgerInvestorId} onChange={(e) => setLedgerInvestorId(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                  <option value="">All Investors</option>
                  {investors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </div>
            </div>

            <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Date</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Project</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Investor</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                    <th className="text-right px-6 py-3 text-sm text-slate-500">Amount</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredLedger.length === 0 && (
                    <tr><td colSpan={6} className="px-6 py-10 text-center text-slate-500 text-sm">No entries.</td></tr>
                  )}
                  {filteredLedger.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 text-sm text-slate-900">{e.date}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{projName(e.project_id)}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{investorName(e.investor_id)}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs ${ENTRY_COLORS[e.type]}`}>
                          {e.type.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right text-sm font-mono text-slate-900">{fmt(e.amount)}</td>
                      <td className="px-6 py-4 text-sm text-slate-500">{e.description ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── Add/Edit Project Modal ── */}
      <Modal isOpen={isProjOpen} onClose={() => setIsProjOpen(false)} title={editProj ? "Edit Project" : "New Project"} size="md">
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Project Name *</label>
            <input type="text" value={projForm.name} onChange={(e) => setProjForm({ ...projForm, name: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Client</label>
            <select value={projForm.client_id} onChange={(e) => setProjForm({ ...projForm, client_id: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
              <option value="">No client linked</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Total Required (PKR)</label>
              <input type="number" min="0" value={projForm.total_required} onChange={(e) => setProjForm({ ...projForm, total_required: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Reserved Profit % for Investors</label>
              <input type="number" min="0" max="100" step="0.01" value={projForm.reserved_profit_pct} onChange={(e) => setProjForm({ ...projForm, reserved_profit_pct: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Status</label>
              <select value={projForm.status} onChange={(e) => setProjForm({ ...projForm, status: e.target.value as any })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option>Raising</option>
                <option>Active</option>
                <option>Completed</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Payout Gate</label>
              <select value={projForm.payout_gate} onChange={(e) => setProjForm({ ...projForm, payout_gate: e.target.value as any })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="COMPANY_CASHFLOW">Company Cashflow</option>
                <option value="PROJECT_CASHFLOW">Project Cashflow</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Notes</label>
            <textarea rows={2} value={projForm.notes} onChange={(e) => setProjForm({ ...projForm, notes: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 resize-none" />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" onClick={saveProject} disabled={projSaving}>
              {projSaving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : editProj ? "Save Changes" : "Create Project"}
            </Button>
            <Button variant="secondary" size="md" className="flex-1" onClick={() => setIsProjOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* ── Add/Edit Investor Modal ── */}
      <Modal isOpen={isInvOpen} onClose={() => setIsInvOpen(false)} title={editInv ? "Edit Investor" : "Add Investor"} size="sm">
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Name *</label>
            <input type="text" value={invForm.name} onChange={(e) => setInvForm({ ...invForm, name: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Type</label>
            <select value={invForm.type} onChange={(e) => setInvForm({ ...invForm, type: e.target.value as any, linked_partner_id: "" })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
              <option value="THIRD_PARTY">Third Party (arms-length)</option>
              <option value="PARTNER">Partner (linked to partner account)</option>
            </select>
          </div>
          {invForm.type === "PARTNER" && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Linked Partner</label>
              <select value={invForm.linked_partner_id} onChange={(e) => setInvForm({ ...invForm, linked_partner_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">None</option>
                {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={invForm.is_active} onChange={(e) => setInvForm({ ...invForm, is_active: e.target.checked })} className="rounded border-slate-300" />
            Active
          </label>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" onClick={saveInvestor} disabled={invSaving}>
              {invSaving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : editInv ? "Save" : "Add Investor"}
            </Button>
            <Button variant="secondary" size="md" className="flex-1" onClick={() => setIsInvOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* ── Add Investment Modal ── */}
      <Modal isOpen={isInvestmentOpen} onClose={() => setIsInvestmentOpen(false)} title="Link Investor to Project" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-slate-500">Project: <strong>{projName(investmentProjectId)}</strong></p>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Investor *</label>
            <select value={invmtForm.investor_id} onChange={(e) => setInvmtForm({ ...invmtForm, investor_id: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
              <option value="">Select investor…</option>
              {investors.filter((i) => i.is_active).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Return Type</label>
              <select value={invmtForm.return_type} onChange={(e) => setInvmtForm({ ...invmtForm, return_type: e.target.value as any })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="PROFIT_SHARE">Profit Share</option>
                <option value="FIXED_FINANCE">Fixed Finance Cost</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Committed Amount (PKR) *</label>
              <input type="number" min="0" value={invmtForm.committed_amount} onChange={(e) => setInvmtForm({ ...invmtForm, committed_amount: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
          </div>
          {invmtForm.return_type === "FIXED_FINANCE" && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Finance Cost Amount (PKR)</label>
              <input type="number" min="0" value={invmtForm.fixed_cost_amount} onChange={(e) => setInvmtForm({ ...invmtForm, fixed_cost_amount: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
          )}
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" onClick={saveInvestment} disabled={invmtSaving}>
              {invmtSaving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Add Investment"}
            </Button>
            <Button variant="secondary" size="md" className="flex-1" onClick={() => setIsInvestmentOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* ── Record Ledger Entry Modal ── */}
      <Modal isOpen={isLedgerOpen} onClose={() => setIsLedgerOpen(false)} title="Record Investor Ledger Entry" size="md">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Project *</label>
              <select value={ledgerForm.project_id} onChange={(e) => setLedgerForm({ ...ledgerForm, project_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select project…</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Investor *</label>
              <select value={ledgerForm.investor_id} onChange={(e) => setLedgerForm({ ...ledgerForm, investor_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select investor…</option>
                {investors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Date *</label>
              <input type="date" value={ledgerForm.date} onChange={(e) => setLedgerForm({ ...ledgerForm, date: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Amount (PKR) *</label>
              <input type="number" min="0" value={ledgerForm.amount} onChange={(e) => setLedgerForm({ ...ledgerForm, amount: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Entry Type *</label>
            <select value={ledgerForm.type} onChange={(e) => setLedgerForm({ ...ledgerForm, type: e.target.value as any })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
              {ENTRY_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Cash Location (if money moved)</label>
            <select value={ledgerForm.cash_location_id} onChange={(e) => setLedgerForm({ ...ledgerForm, cash_location_id: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
              <option value="">None / journal only</option>
              {cashLocs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Description</label>
            <input type="text" value={ledgerForm.description} onChange={(e) => setLedgerForm({ ...ledgerForm, description: e.target.value })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
          </div>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" onClick={saveLedgerEntry} disabled={ledgerSaving}>
              {ledgerSaving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Record Entry"}
            </Button>
            <Button variant="secondary" size="md" className="flex-1" onClick={() => setIsLedgerOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
