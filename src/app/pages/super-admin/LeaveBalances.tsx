// ── Leave: a balance and how it got there ───────────────────────────────────
//
// Nothing here is computed. leave_ledger() derives every period from
// attendance — days present, tier, quota, earned, lost at the cap, taken,
// unpaid, closing — and this screen shows it back. A balance with no
// derivation is a number people dispute; this is the derivation.
//
// Every balance opens at ZERO on 1 September 2026 (DECIDED: no opening
// balances). The quota is the contract's allowed_leaves_per_month — none means
// zero earned, by design — unless a NAMED OVERRIDE is recorded against the
// guard, with a reason, through set_leave_quota_override(). Who, when and why
// are shown beside it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import Header from "../../components/Header";
import ThemedSelect from "../../components/ThemedSelect";
import Button from "../../components/Button";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { formatDate } from "../../lib/date";

const FIELD = "w-full px-3 py-2 border border-border rounded-md text-sm bg-background";
const monthLabel = (d: string) => new Date(d + "T00:00:00").toLocaleString("en", { month: "long", year: "numeric" });

type Guard = {
  id: string; full_name: string; guard_code: string | null;
  leave_quota_override: number | null; leave_quota_override_reason: string | null; leave_quota_override_at: string | null;
  leave_quota_override_by: string | null;
};
type LedgerRow = {
  period_start: string; period_end: string; present_days: number; leave_days: number; absent_days: number;
  tier: number; quota: number; earned: number; lost: number; opening: number; taken: number; unpaid: number; closing: number;
};
type Lost = { employee_id: string; full_name: string; opening: number; would_earn: number; banked: number; lost: number };

export default function LeaveBalances() {
  const { company, profile } = useAuth();
  const canEdit = hasPermission(profile, "payroll.edit");

  const [guards, setGuards] = useState<Guard[]>([]);
  const [selected, setSelected] = useState("");
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [lost, setLost] = useState<Lost[]>([]);
  const [lostPeriod, setLostPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ovQuota, setOvQuota] = useState("");
  const [ovReason, setOvReason] = useState("");
  const [setterNames, setSetterNames] = useState<Map<string, string>>(new Map());

  const loadGuards = useCallback(async () => {
    const { data, error } = await supabase.from("employees")
      .select("id, full_name, guard_code, leave_quota_override, leave_quota_override_reason, leave_quota_override_at, leave_quota_override_by")
      // On-staff only, by the project-wide membership test: lifecycle_state in
      // (active, on_leave) — the same set 0291 settled on. The list this
      // replaced read ("active","draft","ops_verified","finance_approved"),
      // which mixed in three RECORD_STATE values; employee_lifecycle_state has
      // no 'draft', so Postgres rejected the whole query and the page loaded
      // nothing at all.
      .in("lifecycle_state", ["active", "on_leave"]).order("full_name");
    if (error) setErr(error.message);
    const gs = (data ?? []) as Guard[];
    setGuards(gs);
    const ids = Array.from(new Set(gs.map((g) => g.leave_quota_override_by).filter(Boolean))) as string[];
    if (ids.length) {
      const { data: ps } = await supabase.from("profiles").select("id, full_name").in("id", ids);
      setSetterNames(new Map(((ps ?? []) as any[]).map((x) => [x.id, x.full_name])));
    }
    setLoading(false);
  }, []);
  useEffect(() => { loadGuards(); }, [loadGuards]);

  const guard = guards.find((g) => g.id === selected);
  useEffect(() => {
    setOvQuota(guard?.leave_quota_override != null ? String(guard.leave_quota_override) : "");
    setOvReason("");
  }, [guard?.id, guard?.leave_quota_override]);

  // The override is a decision: quota AND reason, or a clear. The RPC refuses a
  // blank reason and stamps who/when; nothing here writes employees directly.
  const saveOverride = async (clear: boolean) => {
    if (!selected) return;
    setBusy(true); setErr(null); setNotice(null);
    const { error } = await supabase.rpc("set_leave_quota_override", {
      p_employee_id: selected,
      p_quota: clear ? null : Number(ovQuota),
      p_reason: clear ? null : ovReason,
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setNotice(clear ? "Override cleared — the contract's quota applies." : `Quota override ${ovQuota} recorded. It replaces the contract's quota entirely.`);
    await loadGuards();
    supabase.rpc("leave_ledger", { p_employee_id: selected }).then(({ data }) => setLedger((data ?? []) as LedgerRow[]));
  };

  useEffect(() => {
    if (!selected) { setLedger([]); return; }
    supabase.rpc("leave_ledger", { p_employee_id: selected })
      .then(({ data, error }) => { if (error) setErr(friendlyDbError(error)); setLedger((data ?? []) as LedgerRow[]); });
  }, [selected]);

  useEffect(() => {
    if (!company?.id) return;
    supabase.rpc("leave_lost_at_cap", { p_company_id: company.id, p_period_start: `${lostPeriod}-01` })
      .then(({ data }) => setLost((data ?? []) as Lost[]));
  }, [company?.id, lostPeriod]);

  const guardOptions = useMemo(() => guards.map((g) => (
    <option key={g.id} value={g.id}>{g.full_name}{g.guard_code ? ` · ${g.guard_code}` : ""}</option>
  )), [guards]);

  return (
    <>
      <Header title="Leave" subtitle="Earned per payroll period by days present; capped at 15; derived, never stored" />

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-4 space-y-6">
        {err && <div className="p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">{err}</div>}
        {notice && <div className="p-3 bg-success-50 text-success-700 border border-success-200 rounded-md text-sm">{notice}</div>}
        {loading && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}

        <div className="bg-card border border-border rounded-md px-4 py-3 text-xs text-muted-foreground space-y-1">
          <p>
            Every balance opens at zero on 1 September 2026. The quota is the contract's monthly leaves; a contract
            with none earns none. Tiers on days present: 1–8 → nothing · 9–16 → half · 17–24 → three quarters ·
            25+ → full quota, rounded down to whole days. A named override on a guard, with a reason, replaces the
            contract's quota. Leave marks are paid from the balance; the rest are unpaid.
            Absences are unpaid and do not touch the balance — they only lower the tier. At 15 earning stops: what
            would go past it is lost, and shown as lost.
          </p>
        </div>

        {/* ---- LOST AT THE CAP ---- */}
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">Lost at the cap</h3>
              <p className="text-xs text-muted-foreground mt-0.5">A guard losing leave silently is how a rule becomes an argument.</p>
            </div>
            <input className={FIELD + " max-w-[10rem]"} type="month" value={lostPeriod} onChange={(e) => setLostPeriod(e.target.value)} />
          </div>
          <table className="w-full">
            <thead className="bg-muted/40 border-b border-border">
              <tr>{["Guard", "Opening", "Would earn", "Banked", "Lost"].map((h) => (
                <th key={h} className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>))}</tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lost.length === 0 && <tr><td colSpan={5} className="px-4 py-4 text-sm text-muted-foreground">Nobody lost leave at the cap in {monthLabel(`${lostPeriod}-01`)}.</td></tr>}
              {lost.map((l) => (
                <tr key={l.employee_id}>
                  <td className="px-4 py-2 text-sm">
                    <button type="button" className="text-brand-600 hover:underline" onClick={() => setSelected(l.employee_id)}>{l.full_name}</button>
                  </td>
                  <td className="px-4 py-2 text-sm tabular-nums">{l.opening}</td>
                  <td className="px-4 py-2 text-sm tabular-nums">{l.would_earn}</td>
                  <td className="px-4 py-2 text-sm tabular-nums">{l.banked}</td>
                  <td className="px-4 py-2 text-sm tabular-nums text-danger-700">{l.lost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ---- ONE GUARD'S LEDGER ---- */}
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-3 flex-wrap">
            <h3 className="text-sm font-medium">A guard's balance, and how it got there</h3>
            <div className="min-w-[16rem]">
              <ThemedSelect value={selected} onChange={(e) => setSelected(e.target.value)}>
                <option value="">Pick a guard…</option>
                {guardOptions}
              </ThemedSelect>
            </div>
          </div>
          {selected && guard && (
            <div className="px-4 py-3 border-b border-border text-xs space-y-2">
              {guard.leave_quota_override != null ? (
                <p>
                  <span className="font-medium text-warning-700">Quota override {guard.leave_quota_override}</span>
                  <span className="text-muted-foreground">
                    {" "}— {guard.leave_quota_override_reason} · set by {setterNames.get(guard.leave_quota_override_by ?? "") ?? "unknown"}
                    {guard.leave_quota_override_at ? ` on ${formatDate(guard.leave_quota_override_at)}` : ""}. Replaces the contract's quota entirely.
                  </span>
                </p>
              ) : (
                <p className="text-muted-foreground">No override — the contract's quota applies.</p>
              )}
              {canEdit && (
                <div className="flex items-end gap-2 flex-wrap">
                  <div>
                    <label className="block text-muted-foreground mb-1">Override quota</label>
                    <input className={FIELD + " w-24"} type="number" min={0} max={31} value={ovQuota} onChange={(e) => setOvQuota(e.target.value)} />
                  </div>
                  <div className="flex-1 min-w-[16rem]">
                    <label className="block text-muted-foreground mb-1">Reason (required — it is recorded against the guard)</label>
                    <input className={FIELD} value={ovReason} onChange={(e) => setOvReason(e.target.value)} placeholder="e.g. site agreed 2 leaves in the deployment letter" />
                  </div>
                  <Button size="sm" variant="secondary" disabled={busy || ovQuota === "" || !ovReason.trim()} onClick={() => saveOverride(false)}>Record override</Button>
                  {guard.leave_quota_override != null && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => saveOverride(true)}>Clear</Button>
                  )}
                </div>
              )}
            </div>
          )}
          {selected && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>{["Period", "Opening", "Present", "Tier", "Quota", "Earned", "Lost", "Taken", "Unpaid", "Closing"].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>))}</tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {ledger.map((r) => (
                    <tr key={r.period_start} className="text-sm">
                      <td className="px-3 py-2">{monthLabel(r.period_start)}</td>
                      <td className="px-3 py-2 tabular-nums">{r.opening}</td>
                      <td className="px-3 py-2 tabular-nums">{r.present_days}</td>
                      <td className="px-3 py-2 tabular-nums">{r.tier}</td>
                      <td className="px-3 py-2 tabular-nums">{r.quota}</td>
                      <td className="px-3 py-2 tabular-nums text-success-700">+{r.earned}</td>
                      <td className="px-3 py-2 tabular-nums text-danger-700">{r.lost > 0 ? `−${r.lost}` : "—"}</td>
                      <td className="px-3 py-2 tabular-nums">−{r.taken}</td>
                      <td className="px-3 py-2 tabular-nums">{r.unpaid > 0 ? r.unpaid : "—"}</td>
                      <td className="px-3 py-2 tabular-nums font-medium">{r.closing}</td>
                    </tr>
                  ))}
                  {ledger.length === 0 && <tr><td colSpan={10} className="px-3 py-4 text-sm text-muted-foreground">No periods yet — the first is September 2026.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
