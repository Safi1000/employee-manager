import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, Loader2 } from "lucide-react";
import Button from "./Button";
import ThemedSelect from "./ThemedSelect";
import { supabase } from "../lib/supabase";

/**
 * The two company-wide partnership settings, in the one place the partner
 * dialog points at.
 *
 * Both were database-only until now: `partner_remuneration_basis` has been
 * 'cash' for GGS since 0230/0232 with no screen that could show it, and
 * `partnership_posting_day` (0358) has been NULL since it shipped, which is
 * why `partnership_posting_deadline()` returns no rows and no deadline exists
 * to be chased. A setting nobody can see is a setting nobody can be held to.
 *
 * Deliberately NOT on the Receivables "Policy" tab, which is the other
 * finance_settings editor: that page is imported by routes.tsx and never
 * rendered — /receivables redirects into the Accounting tab strip — so putting
 * them there would have been a third unreachable screen. This panel sits on
 * the Partnership Report, which is in the Finance nav group and carries the
 * same permissions as the partner dialog that links to it.
 */

type Row = {
  partner_remuneration_basis: "cash" | "revenue" | null;
  /** Absent, not null, on a database that has not taken 0358. */
  partnership_posting_day?: number | null;
};

type Deadline = {
  period_month: string;
  due_date: string;
  posted: boolean;
  days_late: number;
};

const firstOfMonth = (p: string) => `${p}-01`;
const monthName = (p: string) =>
  new Date(`${p}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
const longDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const nextMonth = (p: string) => {
  const [y, m] = p.split("-").map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

export default function PartnershipPolicyPanel({
  companyId,
  period,
  canEdit,
  onSaved,
}: {
  companyId: string;
  /** YYYY-MM the report is showing — the month the deadline is quoted for. */
  period: string;
  /** accounting.edit. Read-only for everyone else; the values are still shown. */
  canEdit: boolean;
  /** Basis changes the report's own labels, so the page re-reads after a save. */
  onSaved?: () => void;
}) {
  const [row, setRow] = useState<Row | null>(null);
  const [basis, setBasis] = useState<"cash" | "revenue">("cash");
  const [day, setDay] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [deadline, setDeadline] = useState<Deadline | null>(null);
  /** The RPC is absent or refused. Belt-and-braces now that prod is the only
   *  database and prod has 0358 — but a failure named on screen beats a panel
   *  that silently shows "no deadline configured" when the truth is that it
   *  could not ask. */
  const [deadlineUnavailable, setDeadlineUnavailable] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    // select("*") rather than naming the columns: a database that has not taken
    // 0358 has no partnership_posting_day, and naming it fails the whole read —
    // taking the basis down with it over a column that is not even present.
    const { data, error: e } = await supabase
      .from("finance_settings").select("*").eq("company_id", companyId).maybeSingle();
    setLoading(false);
    if (e) { setError(e.message); return; }
    const r = (data ?? null) as Row | null;
    setRow(r);
    setBasis((r?.partner_remuneration_basis ?? "cash") as "cash" | "revenue");
    setDay(r?.partnership_posting_day != null ? String(r.partnership_posting_day) : "");
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  // The deadline itself is computed by the database, never re-derived here: the
  // month-after rule and the posted/late test live in 0358 and must not be
  // stated in two places.
  //
  // This is the first caller in the FRONTEND, not the first caller.
  // run_monthly_ledger_jobs (cron, 02:20 on the 1st) already calls
  // sync_partnership_posting_date, which reads this same function and raises or
  // removes the compliance-calendar row; clear_partnership_deadline_on_post
  // takes the row away again when the run posts. Both are 0362. So the posting
  // day set here is not merely displayed: it is what that chain waited on.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    void (async () => {
      const { data, error: e } = await supabase.rpc("partnership_posting_deadline", {
        p_company_id: companyId,
        p_period: firstOfMonth(period),
      });
      if (cancelled) return;
      if (e) { setDeadline(null); setDeadlineUnavailable(e.message); return; }
      setDeadlineUnavailable(null);
      setDeadline(((data ?? []) as Deadline[])[0] ?? null);
    })();
    return () => { cancelled = true; };
  }, [companyId, period, row]);

  const dayNum = day.trim() === "" ? null : Number(day);
  // Compared against the row's values, or against the column defaults when
  // there is no row at all. Guarding these on `row != null` would have left
  // Save permanently disabled for a company that has never had finance
  // settings written — the one case the insert below exists for.
  const basisChanged = basis !== (row?.partner_remuneration_basis ?? "cash");
  const dayChanged = (dayNum ?? null) !== (row?.partnership_posting_day ?? null);
  const dirty = basisChanged || dayChanged;

  const save = async () => {
    setError(null);
    setSaved(false);
    if (dayNum !== null && (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 28)) {
      setError("Posting day must be a whole number from 1 to 28, or blank for no deadline.");
      return;
    }
    // The warning is the point of the control, so it is a stop, not a caption.
    if (basisChanged && !window.confirm(
      `Change the remuneration basis to ${basis === "cash" ? "Net Cash (cash basis)" : "Total Income (revenue basis)"}?\n\n` +
      "This changes what EVERY partner is paid, in every month the report is " +
      "re-run for — not only future months. Shares already posted to a partner " +
      "ledger keep the amounts they were posted at; anything not yet posted is " +
      "allocated on the new basis.",
    )) return;

    setBusy(true);
    const patch = {
      partner_remuneration_basis: basis,
      partnership_posting_day: dayNum,
      updated_at: new Date().toISOString(),
    };
    // company_id is the primary key, so there is at most one row — but "at
    // most" is not "exactly": a company that has never had finance settings
    // written has none, and an update would then report success having changed
    // nothing at all. Insert in that case rather than silently no-op.
    const upd = await supabase
      .from("finance_settings").update(patch).eq("company_id", companyId).select("company_id");
    let failure = upd.error?.message ?? null;
    if (!failure && (upd.data ?? []).length === 0) {
      const ins = await supabase.from("finance_settings").insert({ company_id: companyId, ...patch });
      failure = ins.error?.message ?? null;
    }
    setBusy(false);
    if (failure) { setError(failure); return; }
    setSaved(true);
    await load();
    onSaved?.();
  };

  if (loading) {
    return (
      <div className="border border-slate-200 rounded-md p-4 mb-6 text-sm text-slate-500">
        <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" /> Loading partnership policy…
      </div>
    );
  }

  return (
    <section
      id="partnership-policy"
      className="border border-slate-200 rounded-md p-4 md:p-5 mb-6 bg-white scroll-mt-6"
    >
      <div className="mb-3">
        <h4 className="text-sm text-slate-900">Partnership policy</h4>
        <p className="text-xs text-slate-500 mt-0.5">
          Company-wide, not per partner. One decides what every partner is paid on; the other
          decides when the month has to be paid by.
        </p>
      </div>

      {error && (
        <div className="text-sm text-danger-600 bg-danger-50 border border-danger-200 px-3 py-2 rounded mb-3">{error}</div>
      )}
      {saved && !dirty && (
        <div className="text-sm text-success-700 bg-success-50 border border-success-200 px-3 py-2 rounded mb-3">Policy saved.</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* ── Remuneration basis ─────────────────────────────────────────── */}
        <div>
          <label className="block text-sm text-slate-700 mb-1">Remuneration basis</label>
          <ThemedSelect
            value={basis}
            disabled={!canEdit || busy}
            onChange={(e) => setBasis(e.target.value as "cash" | "revenue")}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-50 disabled:text-slate-500"
          >
            <option value="cash">Net Cash — cash basis</option>
            <option value="revenue">Total Income — revenue basis</option>
          </ThemedSelect>
          <p className="text-[11px] text-slate-500 mt-1">
            The Client Statements column every partner&apos;s share is taken from.
          </p>
          {basisChanged && (
            <p className="text-[11px] text-warning-700 bg-warning-50 border border-warning-200 rounded px-2 py-1.5 mt-2 flex gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                Changing this changes what <strong>every partner is paid</strong>. Amounts already
                posted to a partner ledger keep the basis they were posted on; everything not yet
                posted is re-allocated on the new one.
              </span>
            </p>
          )}
        </div>

        {/* ── Posting deadline ───────────────────────────────────────────── */}
        <div>
          <label className="block text-sm text-slate-700 mb-1">
            Posting deadline (day of the following month)
          </label>
          <input
            type="number"
            min={1}
            max={28}
            step={1}
            value={day}
            disabled={!canEdit || busy}
            placeholder="No deadline"
            onChange={(e) => setDay(e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded-md text-sm disabled:bg-slate-50 disabled:text-slate-500"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            The day of the month <em>after</em> the one being allocated by which the run must be
            <strong> posted</strong> — a drafted run does not satisfy it. Capped at 28 so every
            month has the day. Blank means no deadline, and nothing is raised.
          </p>
          {dayNum !== null && Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 28 && (
            <p className="text-[11px] text-slate-600 mt-1">
              {monthName(period)} would be due on the {ordinal(dayNum)} of {monthName(nextMonth(period))}.
            </p>
          )}
        </div>
      </div>

      {/* ── What the deadline says today, straight from 0358 ─────────────── */}
      <div className="mt-4 pt-3 border-t border-slate-100 text-xs flex items-start gap-1.5">
        <CalendarClock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
        {deadlineUnavailable ? (
          <span className="text-slate-500">
            Deadline status unavailable on this database —{" "}
            <code className="text-[10px]">partnership_posting_deadline()</code> answered:{" "}
            {deadlineUnavailable}
          </span>
        ) : deadline == null ? (
          <span className="text-slate-500">
            No deadline configured, so {monthName(period)} raises no calendar entry and no reminder.
          </span>
        ) : deadline.posted ? (
          <span className="text-success-700">
            {monthName(period)} is posted. It was due {longDate(deadline.due_date)}.
          </span>
        ) : deadline.days_late > 0 ? (
          <span className="text-danger-700">
            {monthName(period)} is{" "}
            <strong>{deadline.days_late} day{deadline.days_late === 1 ? "" : "s"} late</strong> — it
            was due {longDate(deadline.due_date)} and is not posted.
          </span>
        ) : (
          <span className="text-slate-600">
            {monthName(period)} is not posted yet. Due {longDate(deadline.due_date)}.
          </span>
        )}
      </div>

      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={save}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Save policy
          </Button>
          {dirty && (
            <button
              type="button"
              className="text-xs text-slate-500 hover:text-slate-800"
              onClick={() => {
                setBasis((row?.partner_remuneration_basis ?? "cash") as "cash" | "revenue");
                setDay(row?.partnership_posting_day != null ? String(row.partnership_posting_day) : "");
                setError(null);
              }}
            >
              Discard changes
            </button>
          )}
        </div>
      )}
    </section>
  );
}
