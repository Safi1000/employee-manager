import ThemedSelect from "../../components/ThemedSelect";
import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, AlertCircle, X, Loader2, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";

const fmt = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;
const today = () => new Date().toISOString().slice(0, 10);

type Partner = { id: string; name: string; scope: string; branch_id: string | null; default_share_pct: number | null };
type Branch = { id: string; name: string };
type Client = { id: string; name: string };

type DistributionRule = {
  id: string;
  level: "COMPANY" | "BRANCH" | "CLIENT";
  target_id: string | null;
  effective_from: string;
};

type RuleLine = {
  id: string;
  rule_id: string;
  beneficiary: "PARTNER" | "RETAINED";
  partner_id: string | null;
  percentage: number;
};

type ReferralArrangement = {
  id: string;
  referring_partner_id: string;
  source_branch_id: string;
  basis: "CLIENT_PROFIT" | "BRANCH_PROFIT";
  client_id: string | null;
  percentage: number;
  funding_method: "OFF_THE_TOP" | "PARTNERS_ONLY" | "CUSTOM_SPLIT";
  is_active: boolean;
};

export default function ProfitDistribution() {
  const { profile } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? null;

  const [tab, setTab] = useState<"rules" | "referrals">("rules");
  const [partners, setPartners] = useState<Partner[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [rules, setRules] = useState<DistributionRule[]>([]);
  const [ruleLines, setRuleLines] = useState<RuleLine[]>([]);
  const [referrals, setReferrals] = useState<ReferralArrangement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRule, setExpandedRule] = useState<string | null>(null);

  // Add/Edit Rule modal
  const [isRuleOpen, setIsRuleOpen] = useState(false);
  const [editRule, setEditRule] = useState<DistributionRule | null>(null);
  const [ruleForm, setRuleForm] = useState({
    level: "COMPANY" as DistributionRule["level"],
    target_id: "",
    effective_from: today().slice(0, 7) + "-01",
  });
  const [ruleLinesFrm, setRuleLinesFrm] = useState<Array<{ beneficiary: "PARTNER" | "RETAINED"; partner_id: string; percentage: string }>>([]);
  const [ruleSaving, setRuleSaving] = useState(false);

  // Add/Edit Referral modal
  const [isReferralOpen, setIsReferralOpen] = useState(false);
  const [editReferral, setEditReferral] = useState<ReferralArrangement | null>(null);
  const [refForm, setRefForm] = useState({
    referring_partner_id: "",
    source_branch_id: "",
    basis: "BRANCH_PROFIT" as "CLIENT_PROFIT" | "BRANCH_PROFIT",
    client_id: "",
    percentage: "",
    funding_method: "OFF_THE_TOP" as ReferralArrangement["funding_method"],
    is_active: true,
  });
  const [refSaving, setRefSaving] = useState(false);

  const loadData = async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [{ data: pt }, { data: br }, { data: cl }, { data: ru }, { data: rl }, { data: ra }] = await Promise.all([
        supabase.from("partners").select("id, name, scope, branch_id, default_share_pct").eq("company_id", companyId).eq("is_active", true).order("name"),
        supabase.from("branches").select("id, name").eq("company_id", companyId).order("name"),
        supabase.from("clients").select("id, name").eq("company_id", companyId).eq("is_active", true).order("name"),
        supabase.from("profit_distribution_rules").select("*").eq("company_id", companyId).order("effective_from", { ascending: false }),
        supabase.from("profit_distribution_rule_lines").select("*"),
        supabase.from("referral_arrangements").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
      ]);
      setPartners((pt ?? []) as Partner[]);
      setBranches((br ?? []) as Branch[]);
      setClients((cl ?? []) as Client[]);
      setRules((ru ?? []) as DistributionRule[]);
      setRuleLines((rl ?? []) as RuleLine[]);
      setReferrals((ra ?? []) as ReferralArrangement[]);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, [companyId]);

  const openAddRule = () => {
    setEditRule(null);
    setRuleForm({ level: "COMPANY", target_id: "", effective_from: today().slice(0, 7) + "-01" });
    setRuleLinesFrm([{ beneficiary: "PARTNER", partner_id: "", percentage: "" }]);
    setIsRuleOpen(true);
  };

  const openEditRule = (r: DistributionRule) => {
    setEditRule(r);
    setRuleForm({ level: r.level, target_id: r.target_id ?? "", effective_from: r.effective_from });
    const lines = ruleLines.filter((l) => l.rule_id === r.id);
    setRuleLinesFrm(lines.map((l) => ({ beneficiary: l.beneficiary, partner_id: l.partner_id ?? "", percentage: String(l.percentage) })));
    setIsRuleOpen(true);
  };

  const addRuleLine = () => setRuleLinesFrm((prev) => [...prev, { beneficiary: "PARTNER", partner_id: "", percentage: "" }]);
  const removeRuleLine = (i: number) => setRuleLinesFrm((prev) => prev.filter((_, j) => j !== i));

  const totalPct = useMemo(() => ruleLinesFrm.reduce((s, l) => s + (parseFloat(l.percentage) || 0), 0), [ruleLinesFrm]);

  const saveRule = async () => {
    if (!companyId) return;
    setRuleSaving(true);
    setError(null);
    try {
      const pct = ruleLinesFrm.reduce((s, l) => s + (parseFloat(l.percentage) || 0), 0);
      if (pct > 100.01) throw new Error("Percentages exceed 100%.");
      const rulePayload = {
        company_id: companyId,
        level: ruleForm.level,
        target_id: (ruleForm.level !== "COMPANY" && ruleForm.target_id) ? ruleForm.target_id : null,
        effective_from: ruleForm.effective_from,
      };
      let ruleId: string;
      if (editRule) {
        const { error: e } = await supabase.from("profit_distribution_rules").update(rulePayload).eq("id", editRule.id);
        if (e) throw e;
        await supabase.from("profit_distribution_rule_lines").delete().eq("rule_id", editRule.id);
        ruleId = editRule.id;
      } else {
        const { data, error: e } = await supabase.from("profit_distribution_rules").insert(rulePayload).select("id").single();
        if (e) throw e;
        ruleId = data.id;
      }
      const lines = ruleLinesFrm.filter((l) => l.percentage && parseFloat(l.percentage) > 0).map((l) => ({
        rule_id: ruleId,
        beneficiary: l.beneficiary,
        partner_id: l.beneficiary === "PARTNER" && l.partner_id ? l.partner_id : null,
        percentage: parseFloat(l.percentage),
      }));
      if (lines.length > 0) {
        const { error: le } = await supabase.from("profit_distribution_rule_lines").insert(lines);
        if (le) throw le;
      }
      setIsRuleOpen(false);
      await loadData();
    } catch (e: any) { setError(e.message); }
    finally { setRuleSaving(false); }
  };

  const deleteRule = async (id: string) => {
    if (!confirm("Delete this rule? This will also remove its lines.")) return;
    const { error: e } = await supabase.from("profit_distribution_rules").delete().eq("id", id);
    if (e) { setError(e.message); return; }
    await loadData();
  };

  const openAddReferral = () => {
    setEditReferral(null);
    setRefForm({ referring_partner_id: "", source_branch_id: "", basis: "BRANCH_PROFIT", client_id: "", percentage: "", funding_method: "OFF_THE_TOP", is_active: true });
    setIsReferralOpen(true);
  };

  const openEditReferral = (r: ReferralArrangement) => {
    setEditReferral(r);
    setRefForm({
      referring_partner_id: r.referring_partner_id,
      source_branch_id: r.source_branch_id,
      basis: r.basis,
      client_id: r.client_id ?? "",
      percentage: String(r.percentage),
      funding_method: r.funding_method,
      is_active: r.is_active,
    });
    setIsReferralOpen(true);
  };

  const saveReferral = async () => {
    if (!companyId || !refForm.referring_partner_id || !refForm.source_branch_id || !refForm.percentage) return;
    setRefSaving(true);
    setError(null);
    try {
      const payload = {
        company_id: companyId,
        referring_partner_id: refForm.referring_partner_id,
        source_branch_id: refForm.source_branch_id,
        basis: refForm.basis,
        client_id: refForm.basis === "CLIENT_PROFIT" && refForm.client_id ? refForm.client_id : null,
        percentage: parseFloat(refForm.percentage),
        funding_method: refForm.funding_method,
        is_active: refForm.is_active,
      };
      if (editReferral) {
        const { error: e } = await supabase.from("referral_arrangements").update(payload).eq("id", editReferral.id);
        if (e) throw e;
      } else {
        const { error: e } = await supabase.from("referral_arrangements").insert(payload);
        if (e) throw e;
      }
      setIsReferralOpen(false);
      await loadData();
    } catch (e: any) { setError(e.message); }
    finally { setRefSaving(false); }
  };

  const deleteReferral = async (id: string) => {
    if (!confirm("Delete this referral arrangement?")) return;
    const { error: e } = await supabase.from("referral_arrangements").delete().eq("id", id);
    if (e) { setError(e.message); return; }
    await loadData();
  };

  const partnerName = (id: string | null) => id ? (partners.find((p) => p.id === id)?.name ?? "—") : "—";
  const branchName = (id: string | null) => id ? (branches.find((b) => b.id === id)?.name ?? "—") : "—";
  const clientName = (id: string | null) => id ? (clients.find((c) => c.id === id)?.name ?? "—") : "—";

  const levelLabel = (level: DistributionRule["level"], target_id: string | null) => {
    if (level === "COMPANY") return "Company (all branches)";
    if (level === "BRANCH") return `Branch: ${branchName(target_id)}`;
    return `Client: ${clientName(target_id)}`;
  };

  if (loading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;

  return (
    <>
      <Header
        title="Profit Distribution"
        subtitle="Define how profit is split among partners, branches, and clients"
        actions={
          tab === "rules" ? (
            <Button variant="primary" size="md" onClick={openAddRule}>
              <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Add Rule
            </Button>
          ) : (
            <Button variant="primary" size="md" onClick={openAddReferral}>
              <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Add Referral
            </Button>
          )
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

        {/* Explainer */}
        <div className="bg-brand-50 border border-brand-200 rounded-md p-4 mb-6 text-sm text-brand-800">
          <strong>How it works:</strong> Rules are resolved from most specific to least: Client → Branch → Company.
          The remaining % after all lines sum is the company-retained share (currently 0 if lines sum to 100%).
          Referral cuts are taken off-the-top before the pool is split per your funding method.
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 bg-slate-100 rounded-md p-1 mb-6 w-fit">
          {([["rules", "Distribution Rules"], ["referrals", "Referral Arrangements"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${tab === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
              {l}
            </button>
          ))}
        </div>

        {/* ── RULES TAB ── */}
        {tab === "rules" && (
          <div className="space-y-3">
            {rules.length === 0 && (
              <div className="bg-white rounded-lg border border-slate-200 py-12 text-center text-slate-500 text-sm">
                No distribution rules yet. Add one to define how profit is split.
              </div>
            )}
            {rules.map((r) => {
              const lines = ruleLines.filter((l) => l.rule_id === r.id);
              const isExpanded = expandedRule === r.id;
              const sumPct = lines.reduce((s, l) => s + l.percentage, 0);
              const retained = 100 - sumPct;
              return (
                <div key={r.id} className="bg-white rounded-lg border border-slate-200">
                  <div className="flex items-center justify-between p-4 cursor-pointer select-none" onClick={() => setExpandedRule(isExpanded ? null : r.id)}>
                    <div className="flex items-center gap-3">
                      {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                      <div>
                        <p className="text-sm font-medium text-slate-900">{levelLabel(r.level, r.target_id)}</p>
                        <p className="text-xs text-slate-500">Effective from {r.effective_from} · {lines.length} partner line{lines.length !== 1 ? "s" : ""}{retained > 0 ? ` · ${retained}% retained` : ""}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs ${r.level === "COMPANY" ? "bg-brand-50 text-brand-700" : r.level === "BRANCH" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-700"}`}>
                        {r.level}
                      </span>
                      <button onClick={(e) => { e.stopPropagation(); openEditRule(r); }} className="p-1 rounded hover:bg-slate-100 text-slate-500">
                        <Pencil className="w-3.5 h-3.5" strokeWidth={1.5} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); deleteRule(r.id); }} className="p-1 rounded hover:bg-danger-50 text-slate-400 hover:text-danger-600">
                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-slate-200 px-4 py-3">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-100">
                            <th className="text-left py-2 text-xs text-slate-500">Beneficiary</th>
                            <th className="text-right py-2 text-xs text-slate-500">Share %</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {lines.map((l) => (
                            <tr key={l.id}>
                              <td className="py-2 text-slate-900">{l.beneficiary === "PARTNER" ? partnerName(l.partner_id) : "Company Retained"}</td>
                              <td className="py-2 text-right font-mono">{l.percentage}%</td>
                            </tr>
                          ))}
                          {retained > 0 && (
                            <tr className="text-slate-500">
                              <td className="py-2 italic">Company Retained (remainder)</td>
                              <td className="py-2 text-right font-mono">{retained.toFixed(2)}%</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── REFERRALS TAB ── */}
        {tab === "referrals" && (
          <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Referring Partner</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Source Branch</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Basis</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Client (if any)</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Cut %</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Funding</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                  <th className="text-right px-6 py-3 text-sm text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {referrals.length === 0 && (
                  <tr><td colSpan={8} className="px-6 py-10 text-center text-slate-500 text-sm">No referral arrangements yet.</td></tr>
                )}
                {referrals.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 text-sm text-slate-900">{partnerName(r.referring_partner_id)}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{branchName(r.source_branch_id)}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{r.basis.replace("_", " ")}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{r.client_id ? clientName(r.client_id) : "—"}</td>
                    <td className="px-6 py-4 text-right text-sm font-mono">{r.percentage}%</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{r.funding_method.replace(/_/g, " ")}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs ${r.is_active ? "bg-success-50 text-success-700" : "bg-slate-100 text-slate-500"}`}>
                        {r.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => openEditReferral(r)} className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900 transition-colors">
                          <Pencil className="w-4 h-4" strokeWidth={1.5} />
                        </button>
                        <button onClick={() => deleteReferral(r.id)} className="p-1.5 rounded hover:bg-danger-50 text-slate-400 hover:text-danger-600 transition-colors">
                          <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Add/Edit Rule Modal ── */}
      <Modal isOpen={isRuleOpen} onClose={() => setIsRuleOpen(false)} title={editRule ? "Edit Distribution Rule" : "Add Distribution Rule"} size="md">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Level</label>
              <ThemedSelect value={ruleForm.level} onChange={(e) => setRuleForm({ ...ruleForm, level: e.target.value as any, target_id: "" })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="COMPANY">Company (all branches)</option>
                <option value="BRANCH">Branch-specific</option>
                <option value="CLIENT">Client-specific</option>
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Effective From</label>
              <input type="date" value={ruleForm.effective_from} onChange={(e) => setRuleForm({ ...ruleForm, effective_from: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
          </div>
          {ruleForm.level === "BRANCH" && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Branch</label>
              <ThemedSelect value={ruleForm.target_id} onChange={(e) => setRuleForm({ ...ruleForm, target_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select branch…</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </ThemedSelect>
            </div>
          )}
          {ruleForm.level === "CLIENT" && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Client</label>
              <ThemedSelect value={ruleForm.target_id} onChange={(e) => setRuleForm({ ...ruleForm, target_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select client…</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </ThemedSelect>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-slate-700">Distribution Lines</label>
              <button type="button" onClick={addRuleLine} className="text-xs text-brand-600 hover:text-brand-800">+ Add Line</button>
            </div>
            <div className="space-y-2">
              {ruleLinesFrm.map((l, i) => (
                <div key={i} className="flex items-center gap-2">
                  <ThemedSelect value={l.beneficiary} onChange={(e) => setRuleLinesFrm((prev) => prev.map((x, j) => j === i ? { ...x, beneficiary: e.target.value as any, partner_id: "" } : x))}
                    className="flex-1 px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                    <option value="PARTNER">Partner</option>
                    <option value="RETAINED">Company Retained</option>
                  </ThemedSelect>
                  {l.beneficiary === "PARTNER" && (
                    <ThemedSelect value={l.partner_id} onChange={(e) => setRuleLinesFrm((prev) => prev.map((x, j) => j === i ? { ...x, partner_id: e.target.value } : x))}
                      className="flex-1 px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                      <option value="">Select partner…</option>
                      {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </ThemedSelect>
                  )}
                  <input type="number" min="0" max="100" step="0.01" placeholder="%" value={l.percentage}
                    onChange={(e) => setRuleLinesFrm((prev) => prev.map((x, j) => j === i ? { ...x, percentage: e.target.value } : x))}
                    className="w-20 px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
                  <button type="button" onClick={() => removeRuleLine(i)} className="p-1 text-slate-400 hover:text-danger-600">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
            <div className={`flex items-center justify-between mt-3 text-sm ${totalPct > 100 ? "text-danger-600" : "text-slate-500"}`}>
              <span>Total: <span className="font-mono">{totalPct.toFixed(2)}%</span></span>
              <span>{totalPct < 100 ? `${(100 - totalPct).toFixed(2)}% retained by company` : totalPct > 100 ? "Exceeds 100%!" : "Fully distributed"}</span>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" onClick={saveRule} disabled={ruleSaving || totalPct > 100}>
              {ruleSaving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : editRule ? "Save Rule" : "Add Rule"}
            </Button>
            <Button variant="secondary" size="md" className="flex-1" onClick={() => setIsRuleOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* ── Add/Edit Referral Modal ── */}
      <Modal isOpen={isReferralOpen} onClose={() => setIsReferralOpen(false)} title={editReferral ? "Edit Referral Arrangement" : "Add Referral Arrangement"} size="md">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Referring Partner *</label>
              <ThemedSelect value={refForm.referring_partner_id} onChange={(e) => setRefForm({ ...refForm, referring_partner_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select partner…</option>
                {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Source Branch *</label>
              <ThemedSelect value={refForm.source_branch_id} onChange={(e) => setRefForm({ ...refForm, source_branch_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select branch…</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </ThemedSelect>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Basis</label>
              <ThemedSelect value={refForm.basis} onChange={(e) => setRefForm({ ...refForm, basis: e.target.value as any, client_id: "" })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="BRANCH_PROFIT">Branch Profit</option>
                <option value="CLIENT_PROFIT">Client Profit</option>
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Cut % *</label>
              <input type="number" min="0" max="100" step="0.01" placeholder="e.g. 10" value={refForm.percentage} onChange={(e) => setRefForm({ ...refForm, percentage: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900" />
            </div>
          </div>
          {refForm.basis === "CLIENT_PROFIT" && (
            <div>
              <label className="block text-sm text-slate-700 mb-1">Client</label>
              <ThemedSelect value={refForm.client_id} onChange={(e) => setRefForm({ ...refForm, client_id: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
                <option value="">Select client…</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </ThemedSelect>
            </div>
          )}
          <div>
            <label className="block text-sm text-slate-700 mb-1">Funding Method</label>
            <ThemedSelect value={refForm.funding_method} onChange={(e) => setRefForm({ ...refForm, funding_method: e.target.value as any })}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
              <option value="OFF_THE_TOP">Off the Top (everyone bears it pro-rata)</option>
              <option value="PARTNERS_ONLY">Partners Only (company retained slice excluded)</option>
            </ThemedSelect>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={refForm.is_active} onChange={(e) => setRefForm({ ...refForm, is_active: e.target.checked })} className="rounded border-slate-300" />
            Active
          </label>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" size="md" className="flex-1" onClick={saveReferral} disabled={refSaving}>
              {refSaving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : editReferral ? "Save" : "Add Arrangement"}
            </Button>
            <Button variant="secondary" size="md" className="flex-1" onClick={() => setIsReferralOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
