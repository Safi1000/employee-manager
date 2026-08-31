import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, RotateCcw } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import ThemedSelect from "./ThemedSelect";
import { supabase, type Branch, type Partner } from "../lib/supabase";

/** One client's contribution to a regional partner's share for the period. */
type BreakdownRow = {
  client_id: string;
  client_name: string;
  client_code: string;
  basis: string;
  client_net: number;
  share_percent: number;
  is_override: boolean;
  amount: number;
};

const money = (n: number) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const acct = (n: number) => (n < 0 ? `(${money(Math.abs(n))})` : money(n));
const firstOfMonth = (p: string) => `${p}-01`;
const lastOfMonth = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  return new Date(y, m, 0).toISOString().slice(0, 10);
};

/**
 * Add / edit a partner. Previously this was a twelve-column grid crammed into
 * the report body, where the fields wrapped unpredictably and the submit button
 * kept falling onto its own row. Same fields, same rules — now in a dialog with
 * room to label them.
 *
 * The two kinds are not interchangeable and the form says so: an EQUITY partner
 * takes a share of the company-wide residual pool, a REGIONAL one takes a share
 * of their own region measured on a basis they pick. Region and basis therefore
 * only appear for regional partners.
 */
export default function PartnerFormModal({
  isOpen,
  partner,
  branches,
  equityShareTotal,
  period,
  regionName,
  onClose,
  onSaved,
  onChanged,
}: {
  isOpen: boolean;
  /** null = add */
  partner: Partner | null;
  branches: Branch[];
  /** Equity % already committed, so the form can warn before exceeding 100. */
  equityShareTotal: number;
  /** YYYY-MM the report is showing — the period the client breakdown reads. */
  period: string;
  regionName?: string | null;
  onClose: () => void;
  onSaved: () => void;
  /** A client-share override was written — refresh the report WITHOUT closing. */
  onChanged?: () => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"COMPANY" | "BRANCH">("COMPANY");
  const [branchId, setBranchId] = useState("");
  const [share, setShare] = useState("");
  // Remuneration basis is COMPANY policy (finance_settings.partner_remuneration_basis),
  // not a per-partner choice — 0232 dropped partners.basis. Held here only to
  // label the breakdown column and show what the share bites on.
  const [companyBasis, setCompanyBasis] = useState<"cash" | "revenue" | null>(null);
  const [opening, setOpening] = useState("");
  const [startMonth, setStartMonth] = useState(""); // YYYY-MM — partner shares profit from here on
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-client share breakdown (regional partners only) — the actual place to
  // edit each client's override %. Read-only view of it lives in the detail drawer.
  const isRegional = !!partner && partner.scope === "BRANCH";
  const [breakdown, setBreakdown] = useState<BreakdownRow[]>([]);
  const [loadingBd, setLoadingBd] = useState(false);
  const [editClientId, setEditClientId] = useState<string | null>(null);
  const [editPct, setEditPct] = useState("");
  const [savingShare, setSavingShare] = useState(false);

  // Partner identity is set once, at creation. Editing an existing partner locks
  // every headline field — only the per-client shares stay editable here.
  const editing = !!partner;

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setBusy(false);
    setName(partner?.name ?? "");
    setScope((partner?.scope as "COMPANY" | "BRANCH") ?? "COMPANY");
    setBranchId(partner?.branch_id ?? "");
    setShare(partner ? String(partner.profit_share_percent) : "");
    setOpening(partner ? String(partner.opening_balance ?? 0) : "");
    setStartMonth(
      partner?.start_month ? String(partner.start_month).slice(0, 7) : new Date().toISOString().slice(0, 7),
    );
    setEditClientId(null);
    // RLS scopes finance_settings to the caller's company, so no filter needed.
    void (async () => {
      const { data } = await supabase
        .from("finance_settings").select("partner_remuneration_basis").maybeSingle();
      setCompanyBasis(((data as { partner_remuneration_basis?: string } | null)
        ?.partner_remuneration_basis ?? null) as "cash" | "revenue" | null);
    })();
  }, [isOpen, partner]);

  const loadBreakdown = useCallback(async () => {
    if (!partner || partner.scope !== "BRANCH") { setBreakdown([]); return; }
    setLoadingBd(true);
    const { data, error: e } = await supabase.rpc("partner_client_breakdown", {
      p_partner_id: partner.id,
      p_start: firstOfMonth(period),
      p_end: lastOfMonth(period),
    });
    setLoadingBd(false);
    if (e) { setError(e.message); return; }
    setBreakdown((data ?? []) as BreakdownRow[]);
  }, [partner, period]);

  useEffect(() => {
    if (isOpen) void loadBreakdown();
  }, [isOpen, loadBreakdown]);

  const saveClientShare = async (row: BreakdownRow) => {
    if (!partner) return;
    const pct = Number(editPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) { setError("Share must be between 0 and 100."); return; }
    setSavingShare(true);
    setError(null);
    // Dated override: effective from the month the report is showing, so a change
    // made while viewing August applies from August on and leaves July as it was.
    const { error: e } = await supabase
      .from("partner_client_shares")
      .upsert(
        { partner_id: partner.id, client_id: row.client_id, share_percent: pct, effective_month: firstOfMonth(period) },
        { onConflict: "partner_id,client_id,effective_month" },
      );
    setSavingShare(false);
    if (e) { setError(e.message); return; }
    setEditClientId(null);
    await loadBreakdown();
    onChanged?.();
  };

  /** Drop THIS month's override so the client falls back to the earlier override
   *  in effect (or the headline %). Earlier months keep their own rows.
   *  ponytail: clears only the shown month; ending an ongoing prior override
   *  going-forward means re-saving the headline value for the current month. */
  const clearClientShare = async (row: BreakdownRow) => {
    if (!partner) return;
    setSavingShare(true);
    const { error: e } = await supabase
      .from("partner_client_shares")
      .delete()
      .eq("partner_id", partner.id)
      .eq("client_id", row.client_id)
      .eq("effective_month", firstOfMonth(period));
    setSavingShare(false);
    if (e) { setError(e.message); return; }
    await loadBreakdown();
    onChanged?.();
  };

  // Head Office is the cost centre the regions are charged from, never a region
  // a partner holds a stake in.
  const regionOptions = branches.filter((b) => !b.is_head_office);

  const submit = async () => {
    const pct = Number(share);
    if (!name.trim()) { setError("Enter the partner's name."); return; }
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) { setError("Share must be between 0 and 100."); return; }
    if (scope === "BRANCH" && !branchId) { setError("Pick the region this partner holds a stake in."); return; }
    if (!partner && !startMonth) { setError("Pick the month this partner starts sharing profit."); return; }
    // Equity shares divide one pool, so they cannot exceed 100% between them.
    // Regional shares divide their own region and are checked per region.
    if (scope === "COMPANY") {
      const others = equityShareTotal - (partner && partner.scope !== "BRANCH" ? Number(partner.profit_share_percent) : 0);
      if (others + pct > 100) {
        setError(`Equity shares would exceed 100% (${others}% already allocated).`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    const payload: Record<string, unknown> = {
      name: name.trim(),
      scope,
      branch_id: scope === "BRANCH" ? branchId : null,
      profit_share_percent: pct,
    };
    // Opening balance locks once set, so only send it while it is still editable.
    if (!partner || !partner.opening_balance_locked) {
      payload.opening_balance = Number(opening) || 0;
    }
    const res = partner
      ? await supabase.from("partners").update(payload).eq("id", partner.id)
      : await supabase.from("partners").insert({
          ...payload,
          is_active: true,
          allocation_method: "FIXED_PCT",
          start_month: `${startMonth}-01`,
        });
    setBusy(false);
    if (res.error) { setError(res.error.message); return; }
    onSaved();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={partner ? `Edit ${partner.name}` : "Add Partner"} size="md">
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-slate-700 mb-1">
            Partner name * {editing && <span className="text-slate-400">(locked)</span>}
          </label>
          <input
            type="text"
            value={name}
            disabled={editing}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-50 disabled:text-slate-400"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Kind *</label>
            <ThemedSelect
              value={scope}
              disabled={editing}
              onChange={(e) => setScope(e.target.value as "COMPANY" | "BRANCH")}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-50 disabled:text-slate-400"
            >
              <option value="COMPANY">Equity partner</option>
              <option value="BRANCH">Regional partner</option>
            </ThemedSelect>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Profit share % *</label>
            <input
              type="number"
              step="0.001"
              min="0"
              max="100"
              value={share}
              disabled={editing}
              onChange={(e) => setShare(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-right disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>
        </div>

        <p className="text-[11px] text-slate-500 -mt-2">
          {scope === "COMPANY"
            ? `Takes a share of the company-wide residual pool. ${equityShareTotal}% of equity is allocated so far.`
            : "Takes a share of their own region only. Regional and equity shares are separate pools and are never summed together."}
        </p>

        {scope === "BRANCH" && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-700 mb-1">Region *</label>
              <ThemedSelect
                value={branchId}
                disabled={editing}
                onChange={(e) => setBranchId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-50 disabled:text-slate-400"
              >
                <option value="">Select region…</option>
                {regionOptions.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Share bites on</label>
              {/* Company policy, not a per-partner choice. It used to be a dropdown
                  writing partners.basis — which is exactly how two partners could
                  come to disagree about what a rupee of profit is, so 0232 hoisted
                  it to finance_settings and dropped the column. Read-only here;
                  change it once, for the company, in Finance settings. */}
              <div className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm bg-slate-50 text-slate-600">
                {companyBasis === "cash" ? "Net Cash — cash basis"
                  : companyBasis === "revenue" ? "Total Income — revenue basis"
                    : "Not configured"}
              </div>
              <p className="text-[11px] text-slate-500 mt-1">
                Company-wide setting — the Client Statements column every partner's
                share is taken from. Change it in Finance settings.
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-slate-700 mb-1">
              Opening balance {partner && <span className="text-slate-400">(locked)</span>}
            </label>
            <input
              type="number"
              value={opening}
              disabled={editing}
              onChange={(e) => setOpening(e.target.value)}
              placeholder="0"
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-right disabled:bg-slate-50 disabled:text-slate-400"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Positive = the partner owes the company.
            </p>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">
              Shares profit from {partner && <span className="text-slate-400">(locked)</span>}
            </label>
            <input
              type="month"
              value={startMonth}
              disabled={editing}
              onChange={(e) => setStartMonth(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-50 disabled:text-slate-400"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              No profit share for months before this.
            </p>
          </div>
        </div>

        {/* ── PER-CLIENT SHARE OVERRIDES (regional partners) ──────────────
            The actual place to edit each client's share. The detail drawer
            shows the same breakdown read-only. */}
        {isRegional && (
          <div className="pt-4 border-t border-slate-200">
            <p className="text-sm text-slate-700 mb-1">Client shares — {regionName ?? "this region"}</p>
            <p className="text-[11px] text-slate-500 mb-2">
              Set a share on a single client to override their headline {Number(partner?.profit_share_percent)}%.
              Amounts are for {period}.
            </p>
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr className="text-xs text-slate-500 uppercase">
                    <th className="text-left px-3 py-2">Client</th>
                    <th className="text-right px-3 py-2">{companyBasis === "cash" ? "Net Cash" : "Total Income"}</th>
                    <th className="text-right px-3 py-2">Share</th>
                    <th className="text-right px-3 py-2">Amount</th>
                    <th className="text-right px-3 py-2">Edit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loadingBd && (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                      <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" /> Loading…
                    </td></tr>
                  )}
                  {!loadingBd && breakdown.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                      No clients in this region for {period}.
                    </td></tr>
                  )}
                  {!loadingBd && breakdown.map((r) => {
                    const editing = editClientId === r.client_id;
                    return (
                      <tr key={r.client_id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 text-slate-900">
                          {r.client_name}
                          <span className="text-xs text-slate-500 font-mono ml-2">{r.client_code}</span>
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${Number(r.client_net) < 0 ? "text-danger-600" : "text-slate-700"}`}>
                          {acct(Number(r.client_net))}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {editing ? (
                            <input
                              type="number" step="0.001" min="0" max="100"
                              value={editPct}
                              onChange={(e) => setEditPct(e.target.value)}
                              className="w-20 px-2 py-1 border border-slate-200 rounded text-sm text-right"
                            />
                          ) : (
                            <span className={r.is_override ? "text-brand-700 font-medium" : "text-slate-600"}>
                              {Number(r.share_percent)}%
                              {r.is_override && <span className="block text-[10px] text-slate-500">override</span>}
                            </span>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${Number(r.amount) < 0 ? "text-danger-600" : "text-slate-900"}`}>
                          {acct(Number(r.amount))}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {editing ? (
                            <div className="flex gap-1 justify-end">
                              <Button variant="primary" size="sm" disabled={savingShare} onClick={() => saveClientShare(r)}>Save</Button>
                              <Button variant="ghost" size="sm" onClick={() => setEditClientId(null)}>Cancel</Button>
                            </div>
                          ) : (
                            <div className="flex gap-1 justify-end">
                              <button
                                type="button"
                                onClick={() => { setEditClientId(r.client_id); setEditPct(String(r.share_percent)); }}
                                className="p-1.5 rounded text-slate-600 hover:bg-slate-100"
                                title="Set a share just for this client"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              {r.is_override && (
                                <button
                                  type="button"
                                  onClick={() => clearClientShare(r)}
                                  className="p-1.5 rounded text-slate-500 hover:bg-slate-100"
                                  title={`Reset to the headline ${Number(partner?.profit_share_percent)}%`}
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-danger-600">{error}</p>}

        <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
          {/* Editing an existing partner only touches per-client shares, which
              save inline — so there is nothing for a form-level Save to do. */}
          {!editing && (
            <Button variant="primary" size="md" className="flex-1" disabled={busy} onClick={submit}>
              {busy
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</>
                : <><Plus className="w-4 h-4 mr-2" /> Add Partner</>}
            </Button>
          )}
          <Button variant="secondary" size="md" className={editing ? "flex-1" : ""} disabled={busy} onClick={onClose}>
            {editing ? "Close" : "Cancel"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
