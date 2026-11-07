import { useCallback, useEffect, useState } from "react";
import { CircleSlash, FileSignature, Gavel } from "lucide-react";
import Button from "./Button";
import { supabase, friendlyDbError, effectiveContractLinesValue, effectiveBillingGroups, type Contract, type ContractAddendum, type ContractLine } from "../lib/supabase";
import { formatDate } from "../lib/date";

/**
 * DECISIONS ON A CONTRACT (0647, 7 Nov 2026) — the things that happen to a
 * contract after it is signed, each recorded where it can be seen later:
 *
 *  - Rate reviews: every annual increase and every statutory pass-through
 *    (EOBI, minimum wage) with what was asked, what the client agreed — or that
 *    he refused / deferred — and the shortfall against the clause. Agreeing
 *    writes the rate changes (decide_rate_review); refusing just records it.
 *  - Ending the contract: who ended it, when notice was served, the last day,
 *    and the notice shortfall — "one month notice or equivalent amount" — shown
 *    as a charge before it is confirmed (end_contract).
 *
 * Before 0647 is applied the reviews table does not exist: the section then
 * says so and offers nothing, rather than failing.
 */
type Review = {
  id: string; kind: "annual" | "statutory" | "other"; due_on: string; basis: string | null;
  requested_pct: number | null; requested_amount: number | null;
  outcome: "proposed" | "agreed" | "partial" | "refused" | "deferred";
  agreed_pct: number | null; agreed_amount: number | null; effective_from: string | null; decided_on: string | null;
  note: string | null; reference: string | null;
};

const pkr = (n: number) => Math.round(n).toLocaleString("en-PK");
const today = () => new Date().toISOString().slice(0, 10);
const OUTCOME_CLS: Record<Review["outcome"], string> = {
  proposed: "border-border text-muted-foreground",
  agreed: "border-success-200 bg-success-50 text-success-700 dark:bg-success-500/10",
  partial: "border-warning-200 bg-warning-50 text-warning-700 dark:bg-warning-500/10",
  refused: "border-danger-200 bg-danger-50 text-danger-700 dark:bg-danger-500/10",
  deferred: "border-border bg-muted text-muted-foreground",
};

export default function ContractDecisions({ contract, lines, addendums, canEdit, onChanged }: {
  contract: Contract;
  lines: ContractLine[];
  addendums: ContractAddendum[];
  canEdit: boolean;
  onChanged?: () => void;
}) {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<null | { reviewId: string | null; kind: Review["kind"]; due: string; basis: string; askPct: string; askAmt: string; outcome: Review["outcome"]; mode: "pct" | "amt"; value: string; from: string; note: string; ref: string }>(null);
  const [ending, setEnding] = useState<null | { last: string; notice: string; by: "client" | "company" | "mutual"; reason: string }>(null);
  const [endResult, setEndResult] = useState<null | { shortfall_days: number; guards_still_posted: number; notice_days: number }>(null);

  const pct = Number(contract.annual_escalation_pct ?? 0);
  const monthly = effectiveContractLinesValue(lines, addendums, today());
  const guardsInForce = effectiveBillingGroups(lines, addendums, today()).reduce((t, g) => t + g.qty, 0);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("contract_rate_reviews").select("*").eq("contract_id", contract.id).order("due_on", { ascending: false });
    if (error) { setUnavailable(true); setReviews([]); return; }
    setReviews((data ?? []) as Review[]);
  }, [contract.id]);
  useEffect(() => { void load(); }, [load]);

  const nextAnniv = (() => {
    const s = new Date(`${contract.start_date}T00:00:00`), t = new Date(`${today()}T00:00:00`);
    let d = new Date(t.getFullYear(), s.getMonth(), s.getDate());
    if (d < t) d = new Date(t.getFullYear() + 1, s.getMonth(), s.getDate());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  const openForm = (r?: Review) => setForm({
    reviewId: r?.id ?? null, kind: r?.kind ?? "annual", due: r?.due_on ?? nextAnniv, basis: r?.basis ?? (pct ? `Annual increase per contract (${pct}%)` : "Annual increase"),
    askPct: r?.requested_pct != null ? String(r.requested_pct) : pct ? String(pct) : "", askAmt: r?.requested_amount != null ? String(r.requested_amount) : "",
    outcome: "agreed", mode: r?.requested_amount != null ? "amt" : "pct", value: r?.requested_amount != null ? String(r.requested_amount) : pct ? String(pct) : "",
    from: r?.due_on ?? nextAnniv, note: "", ref: "",
  });

  const submit = async () => {
    if (!form) return;
    setBusy(true); setErr(null);
    const decided = form.outcome === "agreed" || form.outcome === "partial";
    const v = Number(form.value);
    const { error } = await supabase.rpc("decide_rate_review", {
      p_review_id: form.reviewId, p_contract_id: form.reviewId ? null : contract.id, p_kind: form.reviewId ? null : form.kind,
      p_due_on: form.reviewId ? null : form.due, p_basis: form.reviewId ? null : form.basis,
      p_requested_pct: form.reviewId ? null : form.askPct ? Number(form.askPct) : null,
      p_requested_amount: form.reviewId ? null : form.askAmt ? Number(form.askAmt) : null,
      p_outcome: form.outcome, p_agreed_pct: decided && form.mode === "pct" ? v : null, p_agreed_amount: decided && form.mode === "amt" ? v : null,
      p_effective_from: decided ? form.from : null, p_note: form.note || null, p_reference: form.ref || null,
    });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setForm(null); void load(); onChanged?.();
  };

  const endPreview = ending ? (() => {
    const notice = contract.notice_period_days ?? 30;
    const given = ending.notice ? Math.round((new Date(`${ending.last}T00:00:00`).getTime() - new Date(`${ending.notice}T00:00:00`).getTime()) / 86400000) : 0;
    const short = ending.by === "mutual" ? 0 : Math.max(0, notice - given);
    return { notice, given, short, charge: (monthly / 30) * short };
  })() : null;

  const confirmEnd = async () => {
    if (!ending) return;
    setBusy(true); setErr(null);
    const { data, error } = await supabase.rpc("end_contract", { p_contract_id: contract.id, p_last_day: ending.last, p_notice_served_on: ending.notice || null, p_ended_by: ending.by, p_reason: ending.reason || null });
    setBusy(false);
    if (error) { setErr(friendlyDbError(error)); return; }
    setEndResult(data as { shortfall_days: number; guards_still_posted: number; notice_days: number });
    setEnding(null); onChanged?.();
  };

  const field = "w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm";
  const ended = contract.status === "terminated" || contract.status === "expired" || !!contract.termination_date;

  return (
    <div className="border border-border rounded-md p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Gavel className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Decisions</span>
        <span className="text-xs text-muted-foreground">rate reviews and ending the contract</span>
        <div className="flex-1" />
        {canEdit && !unavailable && !form && <Button size="sm" variant="secondary" onClick={() => openForm()}><FileSignature className="w-3.5 h-3.5 mr-1" />Record increase decision</Button>}
        {canEdit && !unavailable && !ended && !ending && <Button size="sm" variant="secondary" onClick={() => { setEndResult(null); setEnding({ last: today(), notice: today(), by: "client", reason: "" }); }}><CircleSlash className="w-3.5 h-3.5 mr-1" />End contract</Button>}
      </div>
      {err && <p className="text-sm text-down">{err}</p>}
      {unavailable && <p className="text-xs text-muted-foreground italic">Rate reviews and ending a contract switch on once database update 0647 is applied.</p>}

      {/* Contract ending — recorded, with notice */}
      {contract.termination_date && (
        <p className="text-sm text-foreground">
          {contract.status === "terminated" ? "Ended" : "Ends"} on <span className="font-medium">{formatDate(contract.termination_date)}</span>
          {(contract as { ended_by?: string | null }).ended_by ? ` · ended by ${(contract as { ended_by?: string | null }).ended_by}` : ""}
          {(contract as { notice_served_on?: string | null }).notice_served_on ? ` · notice served ${formatDate((contract as { notice_served_on?: string | null }).notice_served_on!)}` : ""}
          {(contract as { termination_reason?: string | null }).termination_reason ? ` · ${(contract as { termination_reason?: string | null }).termination_reason}` : ""}
        </p>
      )}
      {endResult && (
        <div className="rounded-lg border border-warning-200 bg-warning-50/60 dark:bg-warning-500/5 p-2.5 text-sm">
          Recorded. {endResult.shortfall_days > 0 ? <>Notice was <b>{endResult.shortfall_days} days short</b> of the {endResult.notice_days}-day clause — add the notice charge (about PKR {pkr((monthly / 30) * endResult.shortfall_days)}) to the final invoice.</> : "Notice was in full — no notice charge."}
          {endResult.guards_still_posted > 0 && <> {endResult.guards_still_posted} guard{endResult.guards_still_posted === 1 ? " is" : "s are"} still posted to this contract — move them (relievers, another client) before the last day.</>}
        </div>
      )}
      {ending && endPreview && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Ended by</span>
              <select className={field} value={ending.by} onChange={(e) => setEnding({ ...ending, by: e.target.value as "client" | "company" | "mutual" })}>
                <option value="client">Client</option><option value="company">Us (company)</option><option value="mutual">Mutual consent</option>
              </select></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Notice served on</span><input type="date" className={field} value={ending.notice} onChange={(e) => setEnding({ ...ending, notice: e.target.value })} /></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Last day of service</span><input type="date" className={field} value={ending.last} onChange={(e) => setEnding({ ...ending, last: e.target.value })} /></label>
            <label className="space-y-1 col-span-2 md:col-span-1"><span className="text-xs text-muted-foreground">Reason</span><input className={field} value={ending.reason} onChange={(e) => setEnding({ ...ending, reason: e.target.value })} placeholder="e.g. site closed" /></label>
          </div>
          <p className="text-xs text-muted-foreground">
            Notice clause {endPreview.notice} days · given {endPreview.given} days ·{" "}
            {endPreview.short > 0 ? <span className="text-warning-700 font-medium">{endPreview.short} days short → notice charge about PKR {pkr(endPreview.charge)} (monthly value ÷ 30 × days short)</span> : "no shortfall"}.
            {" "}Billing stops at the last day; a last day already past marks the contract ended now.
          </p>
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="secondary" onClick={() => setEnding(null)}>Cancel</Button>
            <Button size="sm" disabled={busy || !ending.last} onClick={() => void confirmEnd()}>End the contract</Button>
          </div>
        </div>
      )}

      {/* Decision form */}
      {form && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          {!form.reviewId && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <label className="space-y-1"><span className="text-xs text-muted-foreground">Review</span>
                <select className={field} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Review["kind"] })}>
                  <option value="annual">Annual increase</option><option value="statutory">Statutory (EOBI, minimum wage)</option><option value="other">Other</option>
                </select></label>
              <label className="space-y-1"><span className="text-xs text-muted-foreground">Due on</span><input type="date" className={field} value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} /></label>
              <label className="space-y-1"><span className="text-xs text-muted-foreground">Asked %</span><input className={field} inputMode="decimal" value={form.askPct} onChange={(e) => setForm({ ...form, askPct: e.target.value })} placeholder={pct ? String(pct) : "—"} /></label>
              <label className="space-y-1"><span className="text-xs text-muted-foreground">or asked Rs / guard</span><input className={field} inputMode="decimal" value={form.askAmt} onChange={(e) => setForm({ ...form, askAmt: e.target.value })} placeholder="—" /></label>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Client's answer</span>
              <select className={field} value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value as Review["outcome"] })}>
                <option value="agreed">Agreed in full</option><option value="partial">Agreed less</option><option value="refused">Refused</option><option value="deferred">Deferred</option>
              </select></label>
            {(form.outcome === "agreed" || form.outcome === "partial") && <>
              <label className="space-y-1"><span className="text-xs text-muted-foreground">Agreed</span>
                <div className="flex gap-1">
                  <input className={field} inputMode="decimal" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
                  <select className="rounded-lg border border-border bg-card px-1.5 text-sm" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as "pct" | "amt" })}><option value="pct">%</option><option value="amt">Rs/guard</option></select>
                </div></label>
              <label className="space-y-1"><span className="text-xs text-muted-foreground">New rate from</span><input type="date" className={field} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></label>
            </>}
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Letter / reference</span><input className={field} value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} /></label>
          </div>
          <input className={field} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Note — what the client said" />
          {(form.outcome === "agreed" || form.outcome === "partial") && form.value && (
            <p className="text-xs text-muted-foreground">
              Monthly value from {formatDate(form.from)}: about PKR {pkr(form.mode === "pct" ? monthly * (1 + Number(form.value) / 100) : monthly + Number(form.value) * guardsInForce)}
              {form.mode === "pct" && pct > 0 && Number(form.value) < pct && <span className="text-warning-700"> — {(pct - Number(form.value)).toFixed(1)}% short of the {pct}% clause (about PKR {pkr(monthly * (pct - Number(form.value)) / 100)} a month)</span>}.
              {" "}A rate change is written for every line at its own rate, and for guards added by addendum.
            </p>
          )}
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
            <Button size="sm" disabled={busy || ((form.outcome === "agreed" || form.outcome === "partial") && (!form.value || !form.from))} onClick={() => void submit()}>Record</Button>
          </div>
        </div>
      )}

      {/* Review history */}
      {reviews && reviews.length > 0 && (
        <ul className="text-sm divide-y divide-border">
          {reviews.map((r) => {
            const shortPct = r.requested_pct != null && r.agreed_pct != null ? r.requested_pct - r.agreed_pct : null;
            return (
              <li key={r.id} className="py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={`rounded-full border px-1.5 text-[11px] font-medium ${OUTCOME_CLS[r.outcome]}`}>{r.outcome}</span>
                <span className="text-foreground">{r.kind === "annual" ? "Annual increase" : r.kind === "statutory" ? "Statutory" : "Rate review"} · due {formatDate(r.due_on)}</span>
                {r.basis && <span className="text-muted-foreground">{r.basis}</span>}
                <span className="text-muted-foreground tabular-nums">asked {r.requested_pct != null ? `${r.requested_pct}%` : r.requested_amount != null ? `Rs ${pkr(r.requested_amount)}/guard` : "—"}</span>
                {(r.agreed_pct != null || r.agreed_amount != null) && <span className="tabular-nums text-foreground">agreed {r.agreed_pct != null ? `${r.agreed_pct}%` : `Rs ${pkr(r.agreed_amount!)}/guard`}{r.effective_from ? ` from ${formatDate(r.effective_from)}` : ""}</span>}
                {shortPct != null && shortPct > 0 && <span className="text-warning-700 text-xs">{shortPct.toFixed(1)}% short of what was asked</span>}
                {r.note && <span className="text-xs text-muted-foreground">· {r.note}</span>}
                {r.outcome === "proposed" && canEdit && <Button size="sm" variant="secondary" onClick={() => openForm(r)}>Answer</Button>}
              </li>
            );
          })}
        </ul>
      )}
      {reviews && reviews.length === 0 && !unavailable && <p className="text-xs text-muted-foreground italic">No rate reviews recorded yet.</p>}
    </div>
  );
}
