import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import Button from "./Button";
import ThemedSelect from "./ThemedSelect";
import { supabase } from "../lib/supabase";

/**
 * 0514/0515. Is head-office cost apportioned to a region, from which month.
 *
 * Per region (0515, option (a)): a region switched on takes its revenue share of
 * head office; a held region's share stays at head office as the named
 * unallocated line. The setting is effective-dated in ho_apportionment_settings
 * and written only by set_ho_apportionment(). Nothing here derives it: each
 * region's mode comes from ho_region_modes(), and the price of a change — every
 * partner as set and as proposed — from ho_switch_impact(). The price is shown
 * before anything is saved, because the switch moves money between partners.
 */

type Mode = { branch_id: string; region_name: string; apportioned: boolean; own_setting: boolean; decided_from: string | null };
type Impact = {
  partner_id: string;
  partner_name: string;
  row_kind: "REGIONAL_PARTNER" | "EQUITY_PARTNER";
  current_amount: number | null;
  proposed_amount: number | null;
  difference: number | null;
};
type SettingRow = { id: string; branch_id: string | null; effective_month: string; apportion: boolean; reason: string };

const money = (v: number | null | undefined) =>
  v == null ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number | null | undefined) =>
  v == null ? "—" : `${Number(v) > 0 ? "+" : ""}${money(v)}`;
const monthName = (p: string) =>
  new Date(`${p.slice(0, 7)}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

export default function HeadOfficeApportionmentPanel({
  companyId,
  period,
  canEdit,
  onSaved,
}: {
  companyId: string;
  /** YYYY-MM the report is showing. */
  period: string;
  /** accounting.edit — set_ho_apportionment() refuses without it anyway. */
  canEdit: boolean;
  onSaved?: () => void;
}) {
  const [modes, setModes] = useState<Mode[]>([]);
  const [history, setHistory] = useState<SettingRow[]>([]);
  const [impact, setImpact] = useState<Impact[]>([]);
  const [effMonth, setEffMonth] = useState(period);
  /** "all" = every region (the company default); otherwise one region's id. */
  const [scope, setScope] = useState<string>("all");
  const [target, setTarget] = useState<"on" | "off">("off");
  const [reason, setReason] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pricing, setPricing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setEffMonth(period); }, [period]);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    const [modeRes, histRes] = await Promise.all([
      supabase.rpc("ho_region_modes", { p_company_id: companyId, p_month: `${effMonth}-01` }),
      supabase
        .from("ho_apportionment_settings")
        .select("id, branch_id, effective_month, apportion, reason")
        .eq("company_id", companyId)
        .order("effective_month", { ascending: false }),
    ]);
    setLoading(false);
    const failure = modeRes.error?.message ?? histRes.error?.message ?? null;
    if (failure) { setError(failure); return; }
    setError(null);
    setModes((modeRes.data ?? []) as Mode[]);
    setHistory((histRes.data ?? []) as SettingRow[]);
  }, [companyId, effMonth]);

  useEffect(() => { void load(); }, [load]);

  const scopeMode = scope === "all" ? null : modes.find((m) => m.branch_id === scope) ?? null;
  // A region change is a change when the region is not already there; an
  // every-region change is a change when any region differs from it.
  const changing = scope === "all"
    ? modes.some((m) => m.apportioned !== (target === "on"))
    : scopeMode != null && scopeMode.apportioned !== (target === "on");

  // The price of exactly the change on screen, read from the database.
  useEffect(() => {
    if (!companyId || !changing) { setImpact([]); return; }
    let cancelled = false;
    setPricing(true);
    void (async () => {
      const { data, error: e } = await supabase.rpc("ho_switch_impact", {
        p_company_id: companyId,
        p_period: `${effMonth}-01`,
        p_branch_id: scope === "all" ? null : scope,
        p_apportion: target === "on",
      });
      if (cancelled) return;
      setPricing(false);
      if (e) { setError(e.message); return; }
      setImpact((data ?? []) as Impact[]);
    })();
    return () => { cancelled = true; };
  }, [companyId, effMonth, scope, target, changing]);

  // A company-wide change from effMonth overrides every region whose OWN row
  // took effect before effMonth (ho_region_modes says which row decides). On
  // the same month the region's row wins; a region row dated later still takes
  // effect from its own month. Named in the confirm step, never summarised.
  const overridden = useMemo(
    () => (scope === "all" ? modes.filter((m) => m.own_setting && m.decided_from != null && m.decided_from < `${effMonth}-01`) : []),
    [scope, modes, effMonth],
  );
  const keepsOwnSameMonth = useMemo(
    () => (scope === "all" ? modes.filter((m) => m.own_setting && m.decided_from === `${effMonth}-01`) : []),
    [scope, modes, effMonth],
  );
  const laterRegionRows = useMemo(
    () => (scope === "all" ? history.filter((h) => h.branch_id != null && h.effective_month > `${effMonth}-01`) : []),
    [scope, history, effMonth],
  );

  const regionName = useMemo(
    () => (id: string | null) => (id == null ? "Every region" : modes.find((m) => m.branch_id === id)?.region_name ?? "Region"),
    [modes],
  );

  const save = async () => {
    setError(null);
    if (reason.trim() === "") { setError("Say why head-office apportionment is changing. The reason is kept with the setting."); return; }
    setBusy(true);
    const { error: e } = await supabase.rpc("set_ho_apportionment", {
      p_company_id: companyId,
      p_effective_month: `${effMonth}-01`,
      p_apportion: target === "on",
      p_reason: reason.trim(),
      p_branch_id: scope === "all" ? null : scope,
    });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setReviewing(false);
    setReason("");
    setSaved(true);
    await load();
    onSaved?.();
  };

  return (
    <div className="mt-5 pt-4 border-t border-slate-100">
      <div className="mb-3">
        <h4 className="text-sm text-slate-900">Head-office cost</h4>
        <p className="text-xs text-slate-500 mt-0.5">
          Per region: a region switched on takes its share of head office by revenue; a held region&apos;s
          share stays at head office as a named <strong>unallocated</strong> line. Effective from a month
          onward; a closed month is never restated.
        </p>
      </div>

      {error && (
        <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2 rounded mb-3">{error}</div>
      )}
      {saved && !changing && (
        <div className="text-sm text-success-700 bg-success-50 border border-success-200 px-3 py-2 rounded mb-3">Head-office setting saved.</div>
      )}

      {loading ? (
        <div className="text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />Loading…</div>
      ) : (
        <>
          {/* ── Each region's mode for the month, from ho_region_modes ── */}
          <div className="flex flex-wrap gap-2 mb-4">
            {modes.map((m) => (
              <span
                key={m.branch_id}
                className={`text-[11px] px-2 py-1 rounded border ${m.apportioned ? "border-brand-200 bg-brand-50 text-brand-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}
              >
                {m.region_name}: {m.apportioned ? "apportioned" : "held"}{m.own_setting ? "" : " (company default)"}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">From month</label>
              <input
                type="month"
                value={effMonth}
                disabled={busy}
                onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { setEffMonth(e.target.value); setReviewing(false); } }}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Region</label>
              <ThemedSelect
                value={scope}
                disabled={!canEdit || busy}
                onChange={(e) => { setScope(e.target.value); setReviewing(false); }}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-50 disabled:text-slate-500"
              >
                <option value="all">Every region</option>
                {modes.map((m) => <option key={m.branch_id} value={m.branch_id}>{m.region_name}</option>)}
              </ThemedSelect>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Head-office cost</label>
              <ThemedSelect
                value={target}
                disabled={!canEdit || busy}
                onChange={(e) => { setTarget(e.target.value as "on" | "off"); setReviewing(false); }}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-50 disabled:text-slate-500"
              >
                <option value="off">Held at head office</option>
                <option value="on">Apportioned by revenue</option>
              </ThemedSelect>
            </div>
            {canEdit && changing && (
              <div>
                <label className="block text-sm text-slate-700 mb-1">Reason *</label>
                <input
                  type="text"
                  value={reason}
                  disabled={busy}
                  placeholder="Why this changes"
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
                />
              </div>
            )}
          </div>

          {/* ── The price of this change, read from ho_switch_impact ── */}
          {changing && (
            <div className="mt-4">
              <div className="text-xs text-slate-600 mb-1.5">
                What {target === "on" ? "apportioning" : "holding"} {scope === "all" ? "every region" : regionName(scope)} does to each partner&apos;s share for {monthName(effMonth)}
                {pricing && <Loader2 className="w-3 h-3 animate-spin inline-block ml-1.5" />}
              </div>
              <div className="overflow-x-auto border border-slate-200 rounded-md">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="text-left px-3 py-2 font-normal">Partner</th>
                      <th className="text-right px-3 py-2 font-normal">As set</th>
                      <th className="text-right px-3 py-2 font-normal">After this change</th>
                      <th className="text-right px-3 py-2 font-normal">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {impact.length === 0 ? (
                      <tr><td colSpan={4} className="px-3 py-3 text-xs text-slate-500">{pricing ? "Pricing…" : "No partners share profit in this month."}</td></tr>
                    ) : impact.map((r) => (
                      <tr key={r.partner_id} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-slate-900">
                          {r.partner_name}
                          <span className="text-[11px] text-slate-500 ml-1.5">{r.row_kind === "EQUITY_PARTNER" ? "equity" : "regional"}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-700">{money(r.current_amount)}</td>
                        <td className="px-3 py-2 text-right font-mono text-slate-900">{money(r.proposed_amount)}</td>
                        <td className={`px-3 py-2 text-right font-mono ${Number(r.difference) > 0 ? "text-success-700" : Number(r.difference) < 0 ? "text-danger-700" : "text-slate-500"}`}>{signed(r.difference)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {canEdit && changing && (
            <div className="mt-4">
              {!reviewing ? (
                <Button variant="primary" size="sm" disabled={busy || pricing} onClick={() => { setError(null); setReviewing(true); }}>
                  Review change
                </Button>
              ) : (
                <div className="text-[12px] text-warning-700 bg-warning-50 border border-warning-200 rounded px-3 py-2.5">
                  <div className="flex gap-1.5 mb-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                    <span>
                      From <strong>{monthName(effMonth)}</strong> onward, head-office cost for{" "}
                      <strong>{regionName(scope === "all" ? null : scope)}</strong> will be{" "}
                      <strong>{target === "on" ? "apportioned by revenue" : "held at head office"}</strong>. For {monthName(effMonth)}:
                    </span>
                  </div>
                  {scope === "all" && (overridden.length > 0 || keepsOwnSameMonth.length > 0 || laterRegionRows.length > 0) && (
                    <div className="mb-2 ml-6">
                      {overridden.length > 0 && (
                        <>
                          <div className="font-medium">This overrides the region&apos;s own setting for:</div>
                          <ul className="list-disc ml-5 mb-1">
                            {overridden.map((m) => (
                              <li key={m.branch_id}>
                                {m.region_name} — currently <strong>{m.apportioned ? "apportioned" : "held"}</strong> by its own setting from {monthName(m.decided_from!)}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {keepsOwnSameMonth.length > 0 && (
                        <div>
                          Not changed (its own setting is dated {monthName(effMonth)} and wins):{" "}
                          {keepsOwnSameMonth.map((m) => `${m.region_name} (${m.apportioned ? "apportioned" : "held"})`).join(", ")}
                        </div>
                      )}
                      {laterRegionRows.length > 0 && (
                        <div>
                          Still takes effect later, from its own month:{" "}
                          {laterRegionRows.map((h) => `${regionName(h.branch_id)} ${h.apportion ? "apportioned" : "held"} from ${monthName(h.effective_month)}`).join(", ")}
                        </div>
                      )}
                    </div>
                  )}
                  <ul className="ml-6 list-disc space-y-0.5">
                    {impact.map((r) => (
                      <li key={r.partner_id}>
                        {r.partner_name}: {money(r.current_amount)} → <strong>{money(r.proposed_amount)}</strong> ({signed(r.difference)})
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2.5 flex items-center gap-3">
                    <Button variant="primary" size="sm" disabled={busy || reason.trim() === ""} onClick={save}>
                      {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                      Confirm and save
                    </Button>
                    <button type="button" className="text-xs text-slate-600 hover:text-slate-900" onClick={() => setReviewing(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {history.length > 0 && (
            <div className="mt-4 text-[11px] text-slate-500">
              <div className="mb-1">History</div>
              <ul className="space-y-0.5">
                {history.map((h) => (
                  <li key={h.id}>
                    {regionName(h.branch_id)}, from {monthName(h.effective_month)}:{" "}
                    <span className="text-slate-700">{h.apportion ? "apportioned" : "held"}</span> — {h.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
