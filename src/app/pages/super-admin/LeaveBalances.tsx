// ── Leave: a balance and how it got there ───────────────────────────────────
//
// Nothing here is computed. leave_ledger() derives every period from
// attendance — days present, tier, quota, earned, lost at the cap, taken,
// unpaid, closing — and this screen shows it back. A balance with no
// derivation is a number people dispute; this is the derivation.
//
// CARRY IS THE CLIENT'S DECISION (0639, DECIDED 2026-11-04). A client that
// carries says from WHEN (leave_carry_start), so switching it on cannot
// backdate a bank to September; a guard FORFEITS his bank the period he stands
// on a client that does not carry. Where nobody carries, leave is earned and
// spent within the period and what is unused lapses.
//
// 0438's "DECIDED: no opening balances" IS REVERSED, by name, in 0639 — it was
// right while the ledger opened at zero for everyone on one date and wrong once
// a client can be switched on later with guards who have stood there for years.
// A guard of a carrying client may be given a NAMED opening balance, with a
// reason, through set_leave_opening(). This comment said the opposite until
// 0639; the previous wording outlived its truth by one migration, which is the
// failure 0402 was written to repair elsewhere.
//
// The quota is the contract's allowed_leaves_per_month — none means zero
// earned, by design — unless a NAMED OVERRIDE is recorded against the guard,
// with a reason, through set_leave_quota_override(). Who, when and why are
// shown beside every one of these.

import { useEmployeeCodeIndex } from "../../lib/employeeCodes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import Header from "../../components/Header";
import ThemedSelect from "../../components/ThemedSelect";
import Button from "../../components/Button";
import { supabase, friendlyDbError } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { formatDate } from "../../lib/date";
import { usePageState } from "../../lib/pageState";

const FIELD = "w-full px-3 py-2 border border-border rounded-md text-sm bg-background";
const monthLabel = (d: string) => new Date(d + "T00:00:00").toLocaleString("en", { month: "long", year: "numeric" });

type Guard = {
  id: string; full_name: string; guard_code: string | null; client_id: string | null;
  leave_quota_override: number | null; leave_quota_override_reason: string | null; leave_quota_override_at: string | null;
  leave_quota_override_by: string | null;
  leave_opening_balance: number | null; leave_opening_month: string | null;
  leave_opening_reason: string | null; leave_opening_at: string | null; leave_opening_by: string | null;
};
/** 0639: who carries, and from when. Both or neither — carry_on_needs_a_start. */
type CarryClient = { id: string; name: string; leave_carry_forward: boolean; leave_carry_start: string | null };
type LedgerRow = {
  period_start: string; period_end: string; present_days: number; leave_days: number; absent_days: number;
  tier: number; quota: number; earned: number; lost: number; opening: number; taken: number; unpaid: number; closing: number;
};
type Lost = { employee_id: string; full_name: string; opening: number; would_earn: number; banked: number; lost: number };

export default function LeaveBalances() {
  const codeIndex = useEmployeeCodeIndex();
  const { company, profile } = useAuth();
  const canEdit = hasPermission(profile, "payroll.edit");
  // 0639: the carry switch writes public.clients, so it asks what a direct
  // write to that table asks. RLS (0310) enforces it; this only hides the
  // control, and someone with payroll.edit alone sees the policy read-only.
  const canEditClients = hasPermission(profile, "clients.edit");

  const [guards, setGuards] = useState<Guard[]>([]);
  const [carryClients, setCarryClients] = useState<CarryClient[]>([]);
  const [carrySearch, setCarrySearch] = usePageState("LeaveBalances.carrySearch", "");
  const [carryBusy, setCarryBusy] = useState<string | null>(null);
  const [opBalance, setOpBalance] = useState("");
  const [opMonth, setOpMonth] = useState("");
  const [opReason, setOpReason] = useState("");
  const [selected, setSelected] = useState("");
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [lost, setLost] = useState<Lost[]>([]);
  const [lostPeriod, setLostPeriod] = usePageState("LeaveBalances.lostPeriod", new Date().toISOString().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ovQuota, setOvQuota] = useState("");
  const [ovReason, setOvReason] = useState("");
  const [setterNames, setSetterNames] = useState<Map<string, string>>(new Map());

  const loadGuards = useCallback(async () => {
    const { data, error } = await supabase.from("employees")
      .select("id, full_name, guard_code, client_id, leave_quota_override, leave_quota_override_reason, leave_quota_override_at, leave_quota_override_by, leave_opening_balance, leave_opening_month, leave_opening_reason, leave_opening_at, leave_opening_by")
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
    const ids = Array.from(new Set(
      gs.flatMap((g) => [g.leave_quota_override_by, g.leave_opening_by]).filter(Boolean),
    )) as string[];
    if (ids.length) {
      const { data: ps } = await supabase.from("profiles").select("id, full_name").in("id", ids);
      setSetterNames(new Map(((ps ?? []) as any[]).map((x) => [x.id, x.full_name])));
    }
    setLoading(false);
  }, []);
  useEffect(() => { loadGuards(); }, [loadGuards]);

  const loadCarryClients = useCallback(async () => {
    const { data, error } = await supabase.from("clients")
      .select("id, name, leave_carry_forward, leave_carry_start").order("name");
    if (error) setErr(friendlyDbError(error));
    setCarryClients((data ?? []) as CarryClient[]);
  }, []);
  useEffect(() => { loadCarryClients(); }, [loadCarryClients]);

  /** 0639: carry and its start month move TOGETHER or the row is refused
   *  (carry_on_needs_a_start). Switching on with no month would silently
   *  backdate a bank to September 2026, so the UI never offers that state:
   *  ticking defaults the month to the one on screen, unticking clears it. */
  const setCarry = async (c: CarryClient, on: boolean, startMonth: string | null) => {
    setCarryBusy(c.id); setErr(null); setNotice(null);
    const start = on ? `${startMonth || new Date().toISOString().slice(0, 7)}-01` : null;
    const { error } = await supabase.from("clients")
      .update({ leave_carry_forward: on, leave_carry_start: start }).eq("id", c.id);
    setCarryBusy(null);
    if (error) { setErr(friendlyDbError(error)); return; }
    setNotice(on
      ? `${c.name} carries unused leave from ${monthLabel(start!)}. Periods before it still lapse.`
      : `${c.name} no longer carries leave — its guards forfeit what they have banked.`);
    await loadCarryClients();
    if (selected) refreshLedger(selected);
  };

  /** The opening balance is a decision: figure, month AND reason, or a clear.
   *  The RPC refuses a blank reason, a month before the ledger starts and a
   *  client that does not carry; nothing here writes employees directly. */
  const saveOpening = async (clear: boolean) => {
    if (!selected) return;
    setBusy(true); setErr(null); setNotice(null);
    const { error } = await supabase.rpc("set_leave_opening", {
      p_employee_id: selected,
      p_balance: clear ? null : Number(opBalance),
      p_month: clear ? null : `${opMonth}-01`,
      p_reason: clear ? null : opReason,
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setNotice(clear
      ? "Opening balance cleared — the derived balance applies."
      : `Opening balance ${opBalance} recorded for ${monthLabel(`${opMonth}-01`)}.`);
    await loadGuards();
    refreshLedger(selected);
  };

  const refreshLedger = useCallback((id: string) => {
    supabase.rpc("leave_ledger", { p_employee_id: id })
      .then(({ data, error }) => { if (error) setErr(friendlyDbError(error)); setLedger((data ?? []) as LedgerRow[]); });
  }, []);

  const guard = guards.find((g) => g.id === selected);
  const guardCarry = carryClients.find((c) => c.id === guard?.client_id) ?? null;
  useEffect(() => {
    setOvQuota(guard?.leave_quota_override != null ? String(guard.leave_quota_override) : "");
    setOvReason("");
    setOpBalance(guard?.leave_opening_balance != null ? String(guard.leave_opening_balance) : "");
    setOpMonth(guard?.leave_opening_month ? guard.leave_opening_month.slice(0, 7) : new Date().toISOString().slice(0, 7));
    setOpReason("");
  }, [guard?.id, guard?.leave_quota_override, guard?.leave_opening_balance, guard?.leave_opening_month]);

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
    refreshLedger(selected);
  };

  useEffect(() => {
    if (!selected) { setLedger([]); return; }
    refreshLedger(selected);
  }, [selected, refreshLedger]);

  useEffect(() => {
    if (!company?.id) return;
    supabase.rpc("leave_lost_at_cap", { p_company_id: company.id, p_period_start: `${lostPeriod}-01` })
      .then(({ data }) => setLost((data ?? []) as Lost[]));
  }, [company?.id, lostPeriod]);

  const carryFiltered = useMemo(() => {
    const q = carrySearch.trim().toLowerCase();
    return carryClients
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      // Carrying clients first: the exceptions are the ones worth reading.
      .sort((a, b) => Number(b.leave_carry_forward) - Number(a.leave_carry_forward) || a.name.localeCompare(b.name));
  }, [carryClients, carrySearch]);
  const carryOnCount = useMemo(() => carryClients.filter((c) => c.leave_carry_forward).length, [carryClients]);

  const guardOptions = useMemo(() => guards.map((g) => (
    <option key={g.id} value={g.id}>{g.full_name}{(codeIndex.byId.get(g.id) ?? g.guard_code) ? ` · ${codeIndex.byId.get(g.id) ?? g.guard_code}` : ""}</option>
  )), [guards]);

  return (
    <>
      <Header title="Leave" subtitle="Earned per payroll period by days present; capped at 15; carried only where the client says so; derived, never stored" />

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-4 space-y-6">
        {err && <div className="p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">{err}</div>}
        {notice && <div className="p-3 bg-success-50 text-success-700 border border-success-200 rounded-md text-sm">{notice}</div>}
        {loading && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}

        <div className="bg-card border border-border rounded-md px-4 py-3 text-xs text-muted-foreground space-y-1">
          <p>
            The ledger begins 1 September 2026. The quota is the contract's monthly leaves; a contract
            with none earns none. Tiers on days present: 1–8 → nothing · 9–16 → half · 17–24 → three quarters ·
            25+ → full quota, rounded down to whole days. A 2-leave quota, from October 2026: 15 days present → 1,
            16 or more → 2, fewer → none (four and every other quota keep the tiers). A guard moved between clients mid-month earns each stretch on that client's own quota and days, added together. A named override on a guard, with a reason, replaces the
            contract's quota. Leave marks are paid from the balance; the rest are unpaid.
            Absences are unpaid and do not touch the balance — they only lower the tier. At 15 earning stops: what
            would go past it is lost, and shown as lost.
          </p>
          <p>
            <span className="font-medium text-foreground">Carrying is decided per client, below.</span> Where a client
            does not carry, each period opens at zero: leave is earned and spent inside the period and whatever is
            unused lapses. Where it does carry, it carries only from the month that client was switched on, and a
            guard forfeits what he has banked the period he stands on a client that does not carry. A guard of a
            carrying client can be given a named opening balance, with a reason, on his ledger below.
          </p>
        </div>

        {/* ---- WHO CARRIES, AND FROM WHEN (0639) ---- */}
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-sm font-medium">Which clients carry leave forward</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {carryOnCount === 0
                  ? "None — every client is use-it-or-lose-it within the period."
                  : `${carryOnCount} of ${carryClients.length} carry. The rest are use-it-or-lose-it within the period.`}
                {!canEditClients && " Read-only: changing this needs the clients permission."}
              </p>
            </div>
            <input className={FIELD + " max-w-[14rem]"} placeholder="Find a client…" value={carrySearch}
                   onChange={(e) => setCarrySearch(e.target.value)} />
          </div>
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full">
              <thead className="bg-muted/40 border-b border-border sticky top-0">
                <tr>{["Client", "Carries forward", "From"].map((h) => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>))}</tr>
              </thead>
              <tbody className="divide-y divide-border">
                {carryFiltered.length === 0 && (
                  <tr><td colSpan={3} className="px-4 py-4 text-sm text-muted-foreground">No client matches that.</td></tr>
                )}
                {carryFiltered.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-2 text-sm">{c.name}</td>
                    <td className="px-4 py-2 text-sm">
                      <label className="inline-flex items-center gap-2">
                        <input type="checkbox" checked={c.leave_carry_forward} disabled={!canEditClients || carryBusy === c.id}
                               onChange={(e) => setCarry(c, e.target.checked, c.leave_carry_start?.slice(0, 7) ?? null)} />
                        <span className={c.leave_carry_forward ? "text-success-700" : "text-muted-foreground"}>
                          {c.leave_carry_forward ? "Carries" : "Lapses"}
                        </span>
                      </label>
                    </td>
                    <td className="px-4 py-2 text-sm">
                      {c.leave_carry_forward ? (
                        <input className={FIELD + " max-w-[10rem]"} type="month" disabled={!canEditClients || carryBusy === c.id}
                               value={c.leave_carry_start?.slice(0, 7) ?? ""}
                               onChange={(e) => e.target.value && setCarry(c, true, e.target.value)} />
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

              {/* ---- OPENING BALANCE (0639) ---- */}
              <div className="pt-2 border-t border-border space-y-2">
                {guard.leave_opening_balance != null ? (
                  <p>
                    <span className="font-medium text-brand-600">
                      Opening balance {guard.leave_opening_balance}
                      {guard.leave_opening_month ? ` from ${monthLabel(guard.leave_opening_month)}` : ""}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}— {guard.leave_opening_reason} · set by {setterNames.get(guard.leave_opening_by ?? "") ?? "unknown"}
                      {guard.leave_opening_at ? ` on ${formatDate(guard.leave_opening_at)}` : ""}. Replaces the derived
                      balance for that period only.
                    </span>
                  </p>
                ) : (
                  <p className="text-muted-foreground">No opening balance — the period opens at whatever the previous one closed with.</p>
                )}
                {/* The RPC refuses an opening on a client that does not carry; saying so
                    here means nobody has to discover it by being refused. */}
                {!guardCarry?.leave_carry_forward ? (
                  <p className="text-warning-700">
                    {guardCarry
                      ? `${guardCarry.name} does not carry leave forward, so an opening balance would lapse the period it is set. Switch carry on for the client above first.`
                      : "This guard is on no client, so there is nothing to carry."}
                  </p>
                ) : canEdit && (
                  <div className="flex items-end gap-2 flex-wrap">
                    <div>
                      <label className="block text-muted-foreground mb-1">Opening balance</label>
                      <input className={FIELD + " w-24"} type="number" min={0} max={15} value={opBalance} onChange={(e) => setOpBalance(e.target.value)} />
                    </div>
                    <div>
                      <label className="block text-muted-foreground mb-1">From</label>
                      <input className={FIELD + " w-40"} type="month" min="2026-09" value={opMonth} onChange={(e) => setOpMonth(e.target.value)} />
                    </div>
                    <div className="flex-1 min-w-[16rem]">
                      <label className="block text-muted-foreground mb-1">Reason (required — it is recorded against the guard)</label>
                      <input className={FIELD} value={opReason} onChange={(e) => setOpReason(e.target.value)} placeholder="e.g. balance agreed with the site on transfer" />
                    </div>
                    <Button size="sm" variant="secondary" disabled={busy || opBalance === "" || !opMonth || !opReason.trim()} onClick={() => saveOpening(false)}>Record opening</Button>
                    {guard.leave_opening_balance != null && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => saveOpening(true)}>Clear</Button>
                    )}
                  </div>
                )}
              </div>
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
