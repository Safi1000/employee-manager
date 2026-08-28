import { useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import ThemedSelect from "./ThemedSelect";
import { supabase, type Branch, type Partner } from "../lib/supabase";

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
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  /** null = add */
  partner: Partner | null;
  branches: Branch[];
  /** Equity % already committed, so the form can warn before exceeding 100. */
  equityShareTotal: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"COMPANY" | "BRANCH">("COMPANY");
  const [branchId, setBranchId] = useState("");
  const [share, setShare] = useState("");
  const [basis, setBasis] = useState<"" | "cash" | "revenue">("");
  const [opening, setOpening] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setBusy(false);
    setName(partner?.name ?? "");
    setScope((partner?.scope as "COMPANY" | "BRANCH") ?? "COMPANY");
    setBranchId(partner?.branch_id ?? "");
    setShare(partner ? String(partner.profit_share_percent) : "");
    setBasis(((partner?.basis ?? "") as "" | "cash" | "revenue"));
    setOpening(partner ? String(partner.opening_balance ?? 0) : "");
  }, [isOpen, partner]);

  // Head Office is the cost centre the regions are charged from, never a region
  // a partner holds a stake in.
  const regionOptions = branches.filter((b) => !b.is_head_office);

  const submit = async () => {
    const pct = Number(share);
    if (!name.trim()) { setError("Enter the partner's name."); return; }
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) { setError("Share must be between 0 and 100."); return; }
    if (scope === "BRANCH" && !branchId) { setError("Pick the region this partner holds a stake in."); return; }
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
      basis: scope === "BRANCH" ? (basis || null) : null,
    };
    // Opening balance locks once set, so only send it while it is still editable.
    if (!partner || !partner.opening_balance_locked) {
      payload.opening_balance = Number(opening) || 0;
    }
    const res = partner
      ? await supabase.from("partners").update(payload).eq("id", partner.id)
      : await supabase.from("partners").insert({ ...payload, is_active: true, allocation_method: "FIXED_PCT" });
    setBusy(false);
    if (res.error) { setError(res.error.message); return; }
    onSaved();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={partner ? `Edit ${partner.name}` : "Add Partner"} size="md">
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-slate-700 mb-1">Partner name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Kind *</label>
            <ThemedSelect
              value={scope}
              onChange={(e) => setScope(e.target.value as "COMPANY" | "BRANCH")}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
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
              onChange={(e) => setShare(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-right"
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
                onChange={(e) => setBranchId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">Select region…</option>
                {regionOptions.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Share bites on</label>
              <ThemedSelect
                value={basis}
                onChange={(e) => setBasis(e.target.value as "" | "cash" | "revenue")}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                <option value="">Adjusted profit (legacy)</option>
                <option value="cash">Net Cash — cash basis</option>
                <option value="revenue">Total Income — revenue basis</option>
              </ThemedSelect>
              <p className="text-[11px] text-slate-500 mt-1">
                The Client Statements column their share is taken from.
              </p>
            </div>
          </div>
        )}

        <div>
          <label className="block text-sm text-slate-700 mb-1">
            Opening balance {partner?.opening_balance_locked && <span className="text-slate-400">(locked)</span>}
          </label>
          <input
            type="number"
            value={opening}
            disabled={!!partner?.opening_balance_locked}
            onChange={(e) => setOpening(e.target.value)}
            placeholder="0"
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-right disabled:bg-slate-50 disabled:text-slate-400"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Where their ledger starts. Positive = the partner owes the company.
          </p>
        </div>

        {error && <p className="text-sm text-danger-600">{error}</p>}

        <div className="flex items-center gap-3 pt-4 border-t border-slate-200">
          <Button variant="primary" size="md" className="flex-1" disabled={busy} onClick={submit}>
            {busy
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</>
              : partner ? "Save changes" : <><Plus className="w-4 h-4 mr-2" /> Add Partner</>}
          </Button>
          <Button variant="secondary" size="md" disabled={busy} onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}
