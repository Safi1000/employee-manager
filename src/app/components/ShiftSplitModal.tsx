// Shift structure — split a contract's committed headcount into Day vs Night.
//
// The contract is where the TOTAL committed count per category is set (on the
// Contracts page). This modal does ONE thing: given that total, decide how many
// of those guards the site runs on Day vs Night. It touches no billing — rate,
// line value and contract value all stay on the contract's own line editor.
//
// Data model (no schema of its own): the split already lives in contract_lines
// as one row per (category, site, shift_code), each with its own committed_count.
// So a category's "total" is the SUM of its shift rows, and this modal only
// REDISTRIBUTES that sum between the day row and the night row — it never changes
// the total. The total shown is snapshotted when the modal opens; Day + Night
// must equal it before Save is allowed. The Contracts page remains the only place
// the total itself moves.
import { useEffect, useMemo, useState } from "react";
import { Loader2, AlertCircle, X } from "lucide-react";
import Button from "./Button";
import Modal from "./Modal";
import {
  supabase,
  CONTRACT_LINE_CATEGORY_LABEL,
  isPersonnelCategory,
  type Contract,
  type ContractLine,
} from "../lib/supabase";

// One (category, site) group the user splits. `total` is the frozen sum of the
// group's committed rows; `day`/`night` are the editable distribution.
type Group = {
  key: string;
  label: string; // category label, with site appended when the contract has sites
  category: ContractLine["category"]; // passed to set_shift_split as p_category
  siteId: string | null;
  total: number;
  day: string;
  night: string;
  rows: ContractLine[]; // the raw lines in this group, for change detection
};

const num = (s: string) => Math.max(0, Math.floor(Number(s) || 0));
const groupKey = (l: ContractLine) => `${l.category}|${l.site_id ?? ""}`;

export default function ShiftSplitModal({
  contract,
  clientName,
  canEdit,
  onClose,
  onSaved,
}: {
  contract: Contract;
  clientName?: string;
  /** assignments.hr — the split is an ops action, gated like Shift Change. The
   *  set_shift_split RPC enforces the same key at the DB (0450). */
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      const [linesRes, sitesRes] = await Promise.all([
        supabase.from("contract_lines").select("*").eq("contract_id", contract.id),
        supabase.from("sites").select("id, name").eq("client_id", contract.client_id),
      ]);
      if (!alive) return;
      const firstErr = linesRes.error || sitesRes.error;
      if (firstErr) setError(firstErr.message);
      const siteName = new Map((sitesRes.data ?? []).map((s: any) => [s.id, s.name as string]));
      // Only personnel lines staff a shift; hardware bills nobody.
      const lines = ((linesRes.data ?? []) as ContractLine[]).filter((l) => isPersonnelCategory(l.category));
      const hasSites = lines.some((l) => l.site_id);
      const byKey = new Map<string, ContractLine[]>();
      for (const l of lines) {
        const arr = byKey.get(groupKey(l)) ?? [];
        arr.push(l);
        byKey.set(groupKey(l), arr);
      }
      const gs: Group[] = [];
      for (const [key, rows] of byKey) {
        const total = rows.reduce((s, l) => s + (Number(l.committed_count) || 0), 0);
        const first = rows[0];
        const cat = CONTRACT_LINE_CATEGORY_LABEL[first.category];
        const site = first.site_id ? siteName.get(first.site_id) ?? "Site" : null;
        gs.push({
          key,
          label: hasSites && site ? `${cat} — ${site}` : cat,
          category: first.category,
          siteId: first.site_id,
          total,
          day: String(rows.find((l) => l.shift_code === "day")?.committed_count ?? 0),
          night: String(rows.find((l) => l.shift_code === "night")?.committed_count ?? 0),
          rows,
        });
      }
      gs.sort((a, b) => a.label.localeCompare(b.label));
      setGroups(gs);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [contract.id, contract.client_id]);

  const update = (key: string, patch: Partial<Pick<Group, "day" | "night">>) =>
    setGroups((prev) => prev.map((g) => (g.key === key ? { ...g, ...patch } : g)));

  const allValid = useMemo(
    () => groups.every((g) => num(g.day) + num(g.night) === g.total),
    [groups],
  );

  const save = async () => {
    if (!canEdit || !allValid) return;
    setSubmitting(true);
    setError(null);
    try {
      for (const g of groups) {
        const dayRow = g.rows.find((l) => l.shift_code === "day");
        const nightRow = g.rows.find((l) => l.shift_code === "night");
        const wantDay = num(g.day);
        const wantNight = num(g.night);
        // Nothing to write for a group left as it loaded.
        if ((dayRow?.committed_count ?? 0) === wantDay && (nightRow?.committed_count ?? 0) === wantNight) continue;

        // One atomic call per group: set_shift_split rewrites the group's day/night
        // rows in a single transaction (0450). The deferred sum-invariance trigger
        // checks the total at commit — a per-row rewrite would trip it mid-sequence.
        const { error: e } = await supabase.rpc("set_shift_split", {
          p_contract_id: contract.id,
          p_category: g.category,
          p_site_id: g.siteId,
          p_day_count: wantDay,
          p_night_count: wantNight,
        });
        if (e) throw e;
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Shift structure${clientName ? ` — ${clientName}` : ""}`}
      size="md"
      footer={
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="md"
            className="flex-1"
            disabled={submitting || loading || !canEdit || !allValid}
            onClick={save}
          >
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            {submitting ? "Saving…" : "Save Changes"}
          </Button>
          <Button type="button" variant="secondary" size="md" onClick={onClose}>Cancel</Button>
        </div>
      }
    >
      <div className="space-y-3">
        {error && (
          <div className="flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button type="button" onClick={() => setError(null)}><X className="w-4 h-4" /></button>
          </div>
        )}
        <p className="text-[13px] text-slate-500">
          Split each category's committed headcount between Day and Night. The total is
          set on the contract and can't be changed here — Day + Night must equal it.
        </p>

        {!canEdit && (
          <div className="p-2 bg-slate-50 border border-slate-200 rounded text-[12px] text-slate-500">
            You can view the split but need the Assignments (HR) permission to change it.
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500 text-sm py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : groups.length === 0 ? (
          <div className="text-center text-slate-500 text-sm py-8">This contract has no personnel lines to split.</div>
        ) : (
          <div className="border border-slate-200 rounded-md overflow-hidden divide-y divide-slate-100">
            {groups.map((g) => {
              const sum = num(g.day) + num(g.night);
              const ok = sum === g.total;
              return (
                <div key={g.key} className="p-3">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <span className="text-sm font-medium text-slate-700">{g.label}</span>
                    <span className="text-xs text-slate-500">{g.total} committed</span>
                  </div>
                  <div className="flex items-end gap-3">
                    <label className="flex-1">
                      <span className="block text-[11px] text-slate-500 mb-1">Day</span>
                      <input
                        type="number" min="0" inputMode="numeric"
                        disabled={!canEdit}
                        value={g.day}
                        onChange={(e) => update(g.key, { day: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-right disabled:bg-slate-100 disabled:text-slate-500"
                      />
                    </label>
                    <label className="flex-1">
                      <span className="block text-[11px] text-slate-500 mb-1">Night</span>
                      <input
                        type="number" min="0" inputMode="numeric"
                        disabled={!canEdit}
                        value={g.night}
                        onChange={(e) => update(g.key, { night: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm text-right disabled:bg-slate-100 disabled:text-slate-500"
                      />
                    </label>
                  </div>
                  <p className={`mt-1 text-[11px] ${ok ? "text-emerald-600" : "text-danger-600"}`}>
                    {ok
                      ? `✓ ${num(g.day)} + ${num(g.night)} = ${g.total}`
                      : `Day + Night must equal ${g.total} — currently ${sum}`}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
