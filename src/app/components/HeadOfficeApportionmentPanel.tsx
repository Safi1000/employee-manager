import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Info, Loader2 } from "lucide-react";
import Button from "./Button";
import { supabase } from "../lib/supabase";

/**
 * 0514/0515. Is head-office cost apportioned to a region, from which month.
 *
 * Per region (0515, option (a)): a region switched on takes its revenue share of
 * head office; a held region's share stays at head office as the named
 * unallocated line. The setting is effective-dated in ho_apportionment_settings
 * and written only by set_ho_apportionment(). Nothing here derives it: each
 * region's mode comes from ho_region_modes(), the month's pool from ho_pool(),
 * and the price of a change — every partner as set and as proposed — from
 * ho_switch_impact(). The price is shown before anything is saved, because the
 * switch moves money between partners.
 *
 * The screen is one row per region with a Yes/No choice. Choosing the value a
 * region does not already have stages exactly one change; "every region at
 * once" is the company-wide row, kept behind a disclosure because it overrides
 * regions' own settings.
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
/** One staged change: a region (or "all") set to yes/no. */
type Pending = { scope: string; apportion: boolean };

const money = (v: number | null | undefined) =>
  v == null ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number | null | undefined) =>
  v == null ? "—" : `${Number(v) > 0 ? "+" : ""}${money(v)}`;
const monthName = (p: string) =>
  new Date(`${p.slice(0, 7)}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

function YesNo({ value, disabled, onPick }: { value: boolean | null; disabled: boolean; onPick: (v: boolean) => void }) {
  const base = "px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed";
  return (
    <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
      <button type="button" disabled={disabled} onClick={() => onPick(false)}
        className={`${base} ${value === false ? "bg-slate-700 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
        No — keep at head office
      </button>
      <button type="button" disabled={disabled} onClick={() => onPick(true)}
        className={`${base} border-l border-slate-200 ${value === true ? "bg-brand-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
        Yes — charge the region
      </button>
    </div>
  );
}

export default function HeadOfficeApportionmentPanel({
  companyId,
  period,
  canEdit,
  onSaved,
  bare = false,
}: {
  companyId: string;
  /** YYYY-MM the report is showing. */
  period: string;
  /** accounting.edit — set_ho_apportionment() refuses without it anyway. */
  canEdit: boolean;
  onSaved?: () => void;
  /** Inside a Panel that already carries the title: no rule and no heading. */
  bare?: boolean;
}) {
  const [modes, setModes] = useState<Mode[]>([]);
  const [history, setHistory] = useState<SettingRow[]>([]);
  const [pool, setPool] = useState<number | null>(null);
  const [impact, setImpact] = useState<Impact[]>([]);
  const [effMonth, setEffMonth] = useState(period);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pricing, setPricing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => { setEffMonth(period); }, [period]);

  const monthEndOf = (m: string) => {
    const d = new Date(`${m}-01T00:00:00`);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return `${m}-${String(last).padStart(2, "0")}`;
  };

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    const [modeRes, histRes, poolRes] = await Promise.all([
      supabase.rpc("ho_region_modes", { p_company_id: companyId, p_month: `${effMonth}-01` }),
      supabase
        .from("ho_apportionment_settings")
        .select("id, branch_id, effective_month, apportion, reason")
        .eq("company_id", companyId)
        .order("effective_month", { ascending: false }),
      supabase.rpc("ho_pool", { p_company_id: companyId, p_start: `${effMonth}-01`, p_end: monthEndOf(effMonth), p_basis: "accrual" }),
    ]);
    setLoading(false);
    const failure = modeRes.error?.message ?? histRes.error?.message ?? null;
    if (failure) { setError(failure); return; }
    setError(null);
    setModes((modeRes.data ?? []) as Mode[]);
    setHistory((histRes.data ?? []) as SettingRow[]);
    // The pool is context only; a failure to read it does not block the switch.
    setPool(poolRes.error ? null : Number(poolRes.data ?? 0));
  }, [companyId, effMonth]);

  useEffect(() => { void load(); }, [load]);

  const scope = pending?.scope ?? null;
  const target = pending?.apportion ?? null;
  const scopeMode = scope && scope !== "all" ? modes.find((m) => m.branch_id === scope) ?? null : null;
  // A region change is a change when the region is not already there; an
  // every-region change is a change when any region differs from it.
  const changing = pending != null && (scope === "all"
    ? modes.some((m) => m.apportioned !== target)
    : scopeMode != null && scopeMode.apportioned !== target);

  // The price of exactly the change on screen, read from the database.
  useEffect(() => {
    if (!companyId || !changing || pending == null) { setImpact([]); return; }
    let cancelled = false;
    setPricing(true);
    void (async () => {
      const { data, error: e } = await supabase.rpc("ho_switch_impact", {
        p_company_id: companyId,
        p_period: `${effMonth}-01`,
        p_branch_id: pending.scope === "all" ? null : pending.scope,
        p_apportion: pending.apportion,
      });
      if (cancelled) return;
      setPricing(false);
      if (e) { setError(e.message); return; }
      setImpact((data ?? []) as Impact[]);
    })();
    return () => { cancelled = true; };
  }, [companyId, effMonth, pending, changing]);

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
    () => (id: string | null) => (id == null || id === "all" ? "every region" : modes.find((m) => m.branch_id === id)?.region_name ?? "Region"),
    [modes],
  );

  const pick = (s: string, apportion: boolean) => {
    setError(null);
    setSaved(null);
    setReviewing(false);
    const current = s === "all" ? null : modes.find((m) => m.branch_id === s)?.apportioned;
    // Picking what a region already has clears the staged change.
    if (current === apportion) { setPending(null); return; }
    setPending({ scope: s, apportion });
  };

  const cancel = () => { setPending(null); setReviewing(false); setReason(""); setError(null); };

  const save = async () => {
    if (!pending) return;
    setError(null);
    if (reason.trim() === "") { setError("Say why head-office apportionment is changing. The reason is kept with the setting."); return; }
    setBusy(true);
    const { error: e } = await supabase.rpc("set_ho_apportionment", {
      p_company_id: companyId,
      p_effective_month: `${effMonth}-01`,
      p_apportion: pending.apportion,
      p_reason: reason.trim(),
      p_branch_id: pending.scope === "all" ? null : pending.scope,
    });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setSaved(`Saved: from ${monthName(effMonth)}, ${regionName(pending.scope)} — ${pending.apportion ? "charged its share of head office" : "head office kept at head office"}.`);
    setPending(null);
    setReviewing(false);
    setReason("");
    await load();
    onSaved?.();
  };

  const shownValue = (m: Mode) => (pending && (pending.scope === m.branch_id || pending.scope === "all") ? pending.apportion : m.apportioned);

  return (
    <div className={bare ? "" : "mt-5 pt-4 border-t border-slate-100"}>
      {!bare && <h4 className="text-sm text-slate-900 mb-2">Head-office cost</h4>}
      {/* ── What this is, in plain words ── */}
      <div className="text-sm text-slate-700 space-y-2 mb-4">
        <p>
          <strong>Head-office cost</strong> is everything booked to head office rather than to a region — for
          example the PTA licence and guard insurance, which cover every region&apos;s guards. For each region you decide whether that region is <strong>charged its
          share</strong> of it in its own profit.
        </p>
        <ul className="text-xs text-slate-600 list-disc ml-5 space-y-1">
          <li>
            <strong>Yes — charge the region:</strong> the region carries its share of head office, so its profit (and
            its regional partner&apos;s share) goes down by that amount.
          </li>
          <li>
            <strong>No — keep at head office:</strong> the region carries none of it. Its share stays at head office as
            the line <em>Head office — unallocated</em>, which still reduces company profit. Nothing is dropped.
          </li>
          <li>
            A region&apos;s share is <strong>its revenue ÷ the revenue of every region</strong>, whatever the other
            regions are set to. Saying No for one region does not push its share onto the others.
          </li>
        </ul>
        {pool != null && (
          <p className="text-xs text-slate-600">
            Head-office cost for {monthName(effMonth)}: <strong className="font-mono text-slate-900">{money(pool)}</strong> (accrual).
          </p>
        )}
        <button type="button" onClick={() => setShowHelp((v) => !v)}
          className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline">
          <Info className="w-3.5 h-3.5" />{showHelp ? "Hide the details" : "How the dates and partners work"}
        </button>
        {showHelp && (
          <ul className="text-xs text-slate-600 list-disc ml-5 space-y-1 bg-slate-50 border border-slate-200 rounded p-3 pl-7">
            <li>A change applies <strong>from the month you choose, onward</strong>, until you change it again. Earlier months keep the setting they had.</li>
            <li>A month that has been <strong>closed</strong> in accounting can never be changed. Choose a month after the last closed one.</li>
            <li>Before you save, the screen shows <strong>every partner&apos;s share before and after</strong> the change, worked out by the database. Charging a region lowers its profit, and so its regional partner&apos;s share; the table shows exactly who gains and who loses.</li>
            <li>A reason is required and is kept with the setting, so the history below says why each change was made.</li>
            <li>&quot;Every region at once&quot; sets a company default. It overrides any region that has its own setting from an earlier month; a region set in the same month keeps its own. The screen names them before you confirm.</li>
          </ul>
        )}
      </div>

      {error && (
        <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2 rounded mb-3">{error}</div>
      )}
      {saved && !pending && (
        <div className="text-sm text-success-700 bg-success-50 border border-success-200 px-3 py-2 rounded mb-3">{saved}</div>
      )}

      <div className="flex flex-wrap items-end gap-3 mb-3">
        <div>
          <label className="block text-xs text-slate-600 mb-1">Showing and changing from</label>
          <input
            type="month"
            value={effMonth}
            disabled={busy}
            onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { setEffMonth(e.target.value); setReviewing(false); } }}
            className="px-3 py-1.5 border border-slate-200 rounded-md text-sm"
          />
        </div>
        {!canEdit && <span className="text-xs text-slate-500 pb-2">View only — changing this needs the accounting.edit permission.</span>}
      </div>

      {loading ? (
        <div className="text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />Loading…</div>
      ) : (
        <>
          {/* ── One row per region, from ho_region_modes ── */}
          <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
            <div className="hidden md:grid grid-cols-[1fr_auto] px-3 py-2 text-[11px] text-slate-500 bg-slate-50">
              <span>Region — charge it a share of head-office cost?</span>
            </div>
            {modes.length === 0 && <div className="px-3 py-3 text-xs text-slate-500">No active regions.</div>}
            {modes.map((m) => {
              const staged = pending != null && (pending.scope === m.branch_id || (pending.scope === "all" && m.apportioned !== pending.apportion));
              return (
                <div key={m.branch_id} className={`flex flex-col md:flex-row md:items-center justify-between gap-2 px-3 py-2.5 ${staged ? "bg-warning-50" : ""}`}>
                  <div className="min-w-0">
                    <div className="text-sm text-slate-900">{m.region_name}</div>
                    <div className="text-[11px] text-slate-500">
                      Now: {m.apportioned ? "charged its share" : "kept at head office"}
                      {m.own_setting && m.decided_from ? `, since ${monthName(m.decided_from)}` : " (company default)"}
                      {staged && <span className="text-warning-700 font-medium"> → changing to {(pending!.apportion) ? "charged" : "kept at head office"}</span>}
                    </div>
                  </div>
                  <YesNo value={shownValue(m)} disabled={!canEdit || busy} onPick={(v) => pick(m.branch_id, v)} />
                </div>
              );
            })}
          </div>

          {canEdit && modes.length > 1 && (
            <div className="mt-2">
              <button type="button" onClick={() => setShowAll((v) => !v)}
                className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900">
                {showAll ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Set every region at once
              </button>
              {showAll && (
                <div className="mt-2 flex flex-wrap items-center gap-3 px-3 py-2 border border-dashed border-slate-200 rounded-md">
                  <span className="text-xs text-slate-600">Every region:</span>
                  <YesNo value={pending?.scope === "all" ? pending.apportion : null} disabled={busy} onPick={(v) => pick("all", v)} />
                </div>
              )}
            </div>
          )}

          {/* ── The staged change: price, reason, confirm ── */}
          {pending && changing && (
            <div className="mt-4 border border-warning-200 bg-warning-50/50 rounded-md p-3">
              <div className="text-sm text-slate-900 mb-1">
                From <strong>{monthName(effMonth)}</strong> onward, <strong>{regionName(pending.scope)}</strong>{" "}
                {pending.apportion
                  ? <>will be <strong>charged its share</strong> of head-office cost.</>
                  : <>will <strong>not</strong> be charged head-office cost; its share stays at head office as unallocated.</>}
              </div>
              <div className="text-xs text-slate-600 mb-2">
                What this does to each partner&apos;s share for {monthName(effMonth)}
                {pricing && <Loader2 className="w-3 h-3 animate-spin inline-block ml-1.5" />}
              </div>
              <div className="overflow-x-auto border border-slate-200 rounded-md bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="text-left px-3 py-2 font-normal">Partner</th>
                      <th className="text-right px-3 py-2 font-normal">Now</th>
                      <th className="text-right px-3 py-2 font-normal">After this change</th>
                      <th className="text-right px-3 py-2 font-normal">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {impact.length === 0 ? (
                      <tr><td colSpan={4} className="px-3 py-3 text-xs text-slate-500">{pricing ? "Working it out…" : "No partners share profit in this month."}</td></tr>
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

              {pending.scope === "all" && (overridden.length > 0 || keepsOwnSameMonth.length > 0 || laterRegionRows.length > 0) && (
                <div className="mt-3 text-[12px] text-warning-700 flex gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                  <div>
                    {overridden.length > 0 && (
                      <>
                        <div className="font-medium">This replaces the region&apos;s own setting for:</div>
                        <ul className="list-disc ml-5 mb-1">
                          {overridden.map((m) => (
                            <li key={m.branch_id}>
                              {m.region_name} — currently <strong>{m.apportioned ? "charged" : "kept at head office"}</strong> by its own setting from {monthName(m.decided_from!)}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {keepsOwnSameMonth.length > 0 && (
                      <div>
                        Not changed (its own setting is dated {monthName(effMonth)} and wins):{" "}
                        {keepsOwnSameMonth.map((m) => `${m.region_name} (${m.apportioned ? "charged" : "kept at head office"})`).join(", ")}
                      </div>
                    )}
                    {laterRegionRows.length > 0 && (
                      <div>
                        Still takes effect later, from its own month:{" "}
                        {laterRegionRows.map((h) => `${regionName(h.branch_id)} ${h.apportion ? "charged" : "kept at head office"} from ${monthName(h.effective_month)}`).join(", ")}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="mt-3">
                <label className="block text-xs text-slate-700 mb-1">Reason (kept with the setting) *</label>
                <input
                  type="text"
                  value={reason}
                  disabled={busy}
                  placeholder="e.g. Lahore now uses head-office admin for its billing"
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm bg-white"
                />
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                {!reviewing ? (
                  <Button variant="primary" size="sm" disabled={busy || pricing || reason.trim() === ""} onClick={() => { setError(null); setReviewing(true); }}>
                    Save this change…
                  </Button>
                ) : (
                  <>
                    <span className="text-xs text-warning-700">This moves money between partners from {monthName(effMonth)}. Sure?</span>
                    <Button variant="primary" size="sm" disabled={busy || reason.trim() === ""} onClick={save}>
                      {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                      Yes, save
                    </Button>
                  </>
                )}
                <button type="button" className="text-xs text-slate-600 hover:text-slate-900" onClick={cancel}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {history.length > 0 && (
            <div className="mt-4 text-[11px] text-slate-500">
              <button type="button" onClick={() => setShowHistory((v) => !v)} className="inline-flex items-center gap-1 hover:text-slate-800">
                {showHistory ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                History of changes ({history.length})
              </button>
              {showHistory && (
                <ul className="space-y-0.5 mt-1 ml-5">
                  {history.map((h) => (
                    <li key={h.id}>
                      From {monthName(h.effective_month)}, {regionName(h.branch_id)}:{" "}
                      <span className="text-slate-700">{h.apportion ? "charged its share" : "kept at head office"}</span> — {h.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
