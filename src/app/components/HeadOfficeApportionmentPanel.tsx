import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import Button from "./Button";
import ThemedSelect from "./ThemedSelect";
import { supabase } from "../lib/supabase";

/**
 * 0514. Is head-office cost apportioned to the regions, from which month.
 *
 * The setting is effective-dated in ho_apportionment_settings and written only
 * by set_ho_apportionment(). Nothing here derives it: the month's mode is read
 * from ho_apportioned(), and the price — every partner's share apportioned and
 * held — from ho_apportionment_impact(). The price is shown before anything is
 * saved, because the switch moves money between partners and nobody should
 * flip it without seeing by how much.
 */

type Impact = {
  partner_id: string;
  partner_name: string;
  row_kind: "REGIONAL_PARTNER" | "EQUITY_PARTNER";
  apportioned: number | null;
  held: number | null;
  difference: number | null;
};

type SettingRow = {
  id: string;
  effective_month: string;
  apportion: boolean;
  reason: string;
  set_at: string;
};

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
  const [on, setOn] = useState<boolean | null>(null);
  const [history, setHistory] = useState<SettingRow[]>([]);
  const [impact, setImpact] = useState<Impact[]>([]);
  const [effMonth, setEffMonth] = useState(period);
  const [target, setTarget] = useState<"on" | "off">("off");
  const [reason, setReason] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setEffMonth(period); }, [period]);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    const [modeRes, histRes, impRes] = await Promise.all([
      supabase.rpc("ho_apportioned", { p_company_id: companyId, p_month: `${effMonth}-01` }),
      supabase
        .from("ho_apportionment_settings")
        .select("id, effective_month, apportion, reason, set_at")
        .eq("company_id", companyId)
        .order("effective_month", { ascending: false }),
      supabase.rpc("ho_apportionment_impact", { p_company_id: companyId, p_period: `${effMonth}-01` }),
    ]);
    setLoading(false);
    const failure = modeRes.error?.message ?? histRes.error?.message ?? impRes.error?.message ?? null;
    if (failure) { setError(failure); return; }
    setError(null);
    const mode = Boolean(modeRes.data);
    setOn(mode);
    setTarget(mode ? "on" : "off");
    setHistory((histRes.data ?? []) as SettingRow[]);
    setImpact((impRes.data ?? []) as Impact[]);
  }, [companyId, effMonth]);

  useEffect(() => { void load(); }, [load]);

  const changing = on != null && (target === "on") !== on;

  const save = async () => {
    setError(null);
    if (reason.trim() === "") { setError("Say why head-office apportionment is changing. The reason is kept with the setting."); return; }
    setBusy(true);
    const { error: e } = await supabase.rpc("set_ho_apportionment", {
      p_company_id: companyId,
      p_effective_month: `${effMonth}-01`,
      p_apportion: target === "on",
      p_reason: reason.trim(),
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
          Whether head-office cost is apportioned to the regions by their revenue, or held at head
          office as a named <strong>unallocated</strong> line. Effective from a month onward; a closed
          month is never restated.
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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-slate-700 mb-1">From month</label>
              <input
                type="month"
                value={effMonth}
                disabled={busy}
                onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { setEffMonth(e.target.value); setReviewing(false); } }}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                {monthName(effMonth)} is currently <strong>{on ? "apportioned" : "held at head office"}</strong>.
              </p>
            </div>
            <div>
              <label className="block text-sm text-slate-700 mb-1">Head-office cost</label>
              <ThemedSelect
                value={target}
                disabled={!canEdit || busy}
                onChange={(e) => { setTarget(e.target.value as "on" | "off"); setReviewing(false); }}
                className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-50 disabled:text-slate-500"
              >
                <option value="off">Held at head office (unallocated)</option>
                <option value="on">Apportioned to regions by revenue</option>
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

          {/* ── The price, always visible, read from ho_apportionment_impact ── */}
          <div className="mt-4">
            <div className="text-xs text-slate-600 mb-1.5">
              What it does to each partner&apos;s share for {monthName(effMonth)}
            </div>
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2 font-normal">Partner</th>
                    <th className="text-right px-3 py-2 font-normal">Apportioned</th>
                    <th className="text-right px-3 py-2 font-normal">Held at head office</th>
                    <th className="text-right px-3 py-2 font-normal">Held − apportioned</th>
                  </tr>
                </thead>
                <tbody>
                  {impact.length === 0 ? (
                    <tr><td colSpan={4} className="px-3 py-3 text-xs text-slate-500">No partners share profit in this month.</td></tr>
                  ) : impact.map((r) => (
                    <tr key={r.partner_id} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-900">
                        {r.partner_name}
                        <span className="text-[11px] text-slate-500 ml-1.5">{r.row_kind === "EQUITY_PARTNER" ? "equity" : "regional"}</span>
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${on ? "text-slate-900" : "text-slate-500"}`}>{money(r.apportioned)}</td>
                      <td className={`px-3 py-2 text-right font-mono ${on ? "text-slate-500" : "text-slate-900"}`}>{money(r.held)}</td>
                      <td className={`px-3 py-2 text-right font-mono ${Number(r.difference) > 0 ? "text-success-700" : Number(r.difference) < 0 ? "text-danger-700" : "text-slate-500"}`}>{signed(r.difference)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              The figure in dark is what {monthName(effMonth)} reads today. Holding head office moves its whole
              cost onto the equity residual; apportioning it moves each region&apos;s share onto that region.
            </p>
          </div>

          {canEdit && changing && (
            <div className="mt-4">
              {!reviewing ? (
                <Button variant="primary" size="sm" disabled={busy} onClick={() => { setError(null); setReviewing(true); }}>
                  Review change
                </Button>
              ) : (
                <div className="text-[12px] text-warning-700 bg-warning-50 border border-warning-200 rounded px-3 py-2.5">
                  <div className="flex gap-1.5 mb-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                    <span>
                      From <strong>{monthName(effMonth)}</strong> onward, head-office cost will be{" "}
                      <strong>{target === "on" ? "apportioned to the regions" : "held at head office"}</strong>. For {monthName(effMonth)}:
                    </span>
                  </div>
                  <ul className="ml-6 list-disc space-y-0.5">
                    {impact.map((r) => (
                      <li key={r.partner_id}>
                        {r.partner_name}: {money(target === "on" ? r.held : r.apportioned)} → <strong>{money(target === "on" ? r.apportioned : r.held)}</strong>{" "}
                        ({signed(target === "on" ? -(Number(r.difference) || 0) : r.difference)})
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
                    From {monthName(h.effective_month)}: <span className="text-slate-700">{h.apportion ? "apportioned" : "held"}</span> — {h.reason}
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
