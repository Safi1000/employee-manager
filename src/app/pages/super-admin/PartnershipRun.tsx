import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, CalendarClock, CheckCircle2, FileText, Loader2, RotateCcw, Send,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import ThemedSelect from "../../components/ThemedSelect";
import { supabase } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";

/**
 * Partnership Run — draft a month, review it, then post it.
 *
 * REBUILT, NOT WRITTEN FRESH. A screen for this was reported delivered in an
 * earlier round and is in no commit on any branch: `git log --all -S` finds no
 * caller of draft_profit_allocation anywhere in history, and neither do the
 * session transcripts on this machine. The same lost work applied migrations
 * 0360–0363 straight to production without committing their files — see
 * docs/MIGRATION_DIVERGENCE.md. The database half survived; this is the half
 * that did not.
 *
 * Every rule below lives in the database and is deliberately NOT restated here:
 *
 *   partnership_run_blocker        may this month be drafted at all
 *   draft_profit_allocation        compute it, stop at DRAFT (0361)
 *   profit_allocation_review       what a reviewer should look at (0303)
 *   partnership_uninvoiced_clients who was live and never billed (0358)
 *   post_profit_allocation         post it, refusing if the source data moved
 *   reverse_profit_allocation      unwind a posted one
 *   partnership_posting_deadline   when it was due, and whether it is late
 *
 * The screen's whole job is to call them in order and show what they say. A
 * second copy of "when may this post" in TypeScript is how the two come to
 * disagree, and the database is the one holding the money.
 */

type Run = {
  id: string;
  period_month: string;
  status: "DRAFT" | "POSTED" | "REVERSED";
  basis: string | null;
  total_profit: number | null;
  regional_total: number | null;
  equity_total: number | null;
  posted_at: string | null;
  reversed_at: string | null;
  outputs: AllocationRow[] | null;
};

/** One row of partnership_allocation, as stored in the run's `outputs`. */
type AllocationRow = {
  row_kind: string;
  branch_id: string | null;
  region_name: string | null;
  partner_id: string | null;
  partner_name: string | null;
  share_pct: number | null;
  own_profit: number | null;
  ho_allocated: number | null;
  base_amount: number | null;
  amount: number | null;
  residual: number | null;
};

type ReviewRow = {
  kind: string;
  subject: string;
  subject_id: string | null;
  amount: number;
  detail: string;
};

type Uninvoiced = {
  client_id: string;
  client_code: string;
  client_name: string;
  contract_code: string | null;
  region_name: string | null;
  reason: string;
};

type Deadline = { period_month: string; due_date: string; posted: boolean; days_late: number };

const money = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Accounting negatives, because a partner's share can legitimately be one (A9). */
const acct = (n: number | null | undefined) =>
  Number(n ?? 0) < 0 ? `(${money(Math.abs(Number(n ?? 0)))})` : money(n);
const firstOfMonth = (p: string) => `${p}-01`;
const monthName = (p: string) =>
  new Date(`${p}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
const longDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const previousMonthKey = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/** Headings for profit_allocation_review's `kind`, so the screen does not show a slug. */
const REVIEW_KINDS: Record<string, { title: string; note: string }> = {
  client_cost_no_invoice: {
    title: "Cost booked, nothing billed",
    note: "Their cost is in the pool and their revenue is not, so every partner's share is understated.",
  },
  client_negative_net: {
    title: "Client is net negative for the month",
    note: "Not necessarily wrong — a month of costs against a client billed elsewhere looks like this.",
  },
  unallocated_pool: {
    title: "A pool reached no region",
    note: "Head office cost with no revenue base to apportion it against. It is sitting unallocated.",
  },
  partner_negative_total: {
    title: "Partner's total is negative",
    note: "A9 permits this with no floor; it reduces the partner's capital account.",
  },
};

const STATUS_STYLE: Record<string, string> = {
  DRAFT: "bg-warning-50 text-warning-700 border-warning-200",
  POSTED: "bg-success-50 text-success-700 border-success-200",
  REVERSED: "bg-slate-100 text-slate-600 border-slate-200",
};

export default function PartnershipRun() {
  const { profile } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? null;
  // The database refuses a post without partnership.post (0361) and both admin
  // roles satisfy it outright. Mirroring the test here only decides whether the
  // button is offered — the refusal that matters is the one in the database.
  const canPost = hasPermission(profile, "partnership.post");

  const [period, setPeriod] = useState(previousMonthKey());
  const [run, setRun] = useState<Run | null>(null);
  const [blocker, setBlocker] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewRow[]>([]);
  const [uninvoiced, setUninvoiced] = useState<Uninvoiced[]>([]);
  const [deadline, setDeadline] = useState<Deadline | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "draft" | "post" | "reverse">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const periodOptions = useMemo(() => {
    const out: string[] = [];
    const d = new Date();
    d.setDate(1);
    for (let i = 0; i < 15; i++) {
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      d.setMonth(d.getMonth() - 1);
    }
    return out;
  }, []);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    const month = firstOfMonth(period);

    // One round trip each, in parallel. Every one of them is a question only
    // the database can answer, so none of them is cached or re-derived.
    const [runRes, blockRes, revRes, uninvRes, dueRes] = await Promise.all([
      supabase.from("profit_allocation_runs")
        .select("id, period_month, status, basis, total_profit, regional_total, equity_total, posted_at, reversed_at, outputs")
        .eq("company_id", companyId).eq("period_month", month).maybeSingle(),
      supabase.rpc("partnership_run_blocker", { p_company_id: companyId, p_period: month }),
      supabase.rpc("profit_allocation_review", { p_company_id: companyId, p_period: month }),
      supabase.rpc("partnership_uninvoiced_clients", { p_company_id: companyId, p_period: month }),
      supabase.rpc("partnership_posting_deadline", { p_company_id: companyId, p_period: month }),
    ]);

    setLoading(false);
    // The run row is the one read whose failure means the screen is wrong
    // rather than merely thinner. The advisory reads below degrade quietly.
    if (runRes.error) { setError(runRes.error.message); return; }
    setRun((runRes.data ?? null) as Run | null);
    setBlocker((blockRes.data ?? null) as string | null);
    setReview((revRes.data ?? []) as ReviewRow[]);
    setUninvoiced((uninvRes.data ?? []) as Uninvoiced[]);
    setDeadline(((dueRes.data ?? []) as Deadline[])[0] ?? null);
  }, [companyId, period]);

  useEffect(() => { void load(); }, [load]);

  const draft = async () => {
    if (!companyId) return;
    setBusy("draft"); setError(null); setNotice(null);
    const { error: e } = await supabase.rpc("draft_profit_allocation", {
      p_company_id: companyId, p_period: firstOfMonth(period), p_basis: null,
    });
    setBusy(null);
    if (e) { setError(e.message); return; }
    setNotice(`${monthName(period)} is drafted. Nothing has been posted — review it below, then post.`);
    await load();
  };

  const post = async (confirmIncomplete = false) => {
    if (!run) return;
    setBusy("post"); setError(null); setNotice(null);
    const { error: e } = await supabase.rpc("post_profit_allocation", {
      p_run_id: run.id, p_confirm_incomplete: confirmIncomplete,
    });
    setBusy(null);
    if (e) {
      // 0361 raises the completeness gate as a CONFIRMATION, not a block, and
      // marks it with this hint. Re-asking is the whole design: the first call
      // names the clients, the second proceeds. Any other refusal is shown as
      // it came — the staleness message in particular names what moved, and
      // paraphrasing it would throw away the only useful part.
      const hint = (e as { hint?: string }).hint;
      if (hint === "Confirm to proceed." && !confirmIncomplete) {
        if (window.confirm(`${e.message}\n\nPost anyway?`)) return post(true);
        return;
      }
      setError(e.message);
      return;
    }
    setNotice(`${monthName(period)} is posted. Every partner's capital account has moved.`);
    await load();
  };

  const reverse = async () => {
    if (!run) return;
    if (!window.confirm(
      `Reverse the posted run for ${monthName(period)}?\n\n` +
      "This unwinds the journal entry and every partner's share for the month. " +
      "The posting deadline comes back onto the compliance calendar, because an " +
      "unallocated month is a month somebody still has to do.",
    )) return;
    setBusy("reverse"); setError(null); setNotice(null);
    const { error: e } = await supabase.rpc("reverse_profit_allocation", { p_run_id: run.id });
    setBusy(null);
    if (e) { setError(e.message); return; }
    setNotice(`${monthName(period)} is reversed. Re-draft it when the source data is right.`);
    await load();
  };

  const outputs = run?.outputs ?? [];
  const partnerRows = outputs.filter((r) => r.row_kind === "REGIONAL_PARTNER" || r.row_kind === "EQUITY_PARTNER");
  const otherRows = outputs.filter((r) => !partnerRows.includes(r));
  const reviewByKind = useMemo(() => {
    const m = new Map<string, ReviewRow[]>();
    for (const r of review) {
      if (!m.has(r.kind)) m.set(r.kind, []);
      m.get(r.kind)!.push(r);
    }
    return m;
  }, [review]);

  return (
    <>
      <Header
        title="Partnership Run"
        subtitle="Draft a month, review what it would pay, then post it to every partner's account"
      />

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-5">
        {/* ── Month, status, deadline ─────────────────────────────────────── */}
        <div className="bg-white border border-slate-200 rounded-lg p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-600">Month:</label>
              <ThemedSelect
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-md text-sm"
              >
                {periodOptions.map((p) => <option key={p} value={p}>{monthName(p)}</option>)}
              </ThemedSelect>
              {loading && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
            </div>

            <div className="flex items-center gap-2">
              {run ? (
                <span className={`px-2 py-0.5 rounded text-xs border ${STATUS_STYLE[run.status] ?? ""}`}>
                  {run.status}
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded text-xs border bg-slate-50 text-slate-500 border-slate-200">
                  NOT DRAFTED
                </span>
              )}
            </div>
          </div>

          {deadline && (
            <div className="mt-3 pt-3 border-t border-slate-100 text-xs flex items-start gap-1.5">
              <CalendarClock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
              {deadline.posted ? (
                <span className="text-success-700">Posted. It was due {longDate(deadline.due_date)}.</span>
              ) : deadline.days_late > 0 ? (
                <span className="text-danger-700">
                  <strong>{deadline.days_late} day{deadline.days_late === 1 ? "" : "s"} late</strong> —
                  due {longDate(deadline.due_date)} and not posted.
                </span>
              ) : (
                <span className="text-slate-600">Due {longDate(deadline.due_date)}.</span>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="bg-danger-50 border border-danger-200 rounded-lg px-4 py-3">
            {/* Whitespace preserved: the staleness and completeness refusals are
                multi-line and list what moved or who is missing. Flattening them
                into one line is throwing the answer away. */}
            <pre className="text-sm text-danger-700 whitespace-pre-wrap font-sans">{error}</pre>
          </div>
        )}
        {notice && (
          <div className="bg-success-50 border border-success-200 rounded-lg px-4 py-3 text-sm text-success-700">
            {notice}
          </div>
        )}

        {/* ── The blocker, if the month cannot be drafted at all ──────────── */}
        {blocker && (
          <div className="bg-warning-50 border border-warning-200 rounded-lg px-4 py-3 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-warning-700" />
            <div className="text-sm text-warning-800">
              <p className="font-medium">{monthName(period)} cannot be drafted yet.</p>
              <p className="mt-0.5">{blocker}</p>
            </div>
          </div>
        )}

        {/* ── Actions ─────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            disabled={busy !== null || !!blocker || run?.status === "POSTED"}
            onClick={draft}
          >
            {busy === "draft" ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {run?.status === "DRAFT" ? "Re-draft" : "Draft this month"}
          </Button>

          {run?.status === "DRAFT" && (
            <Button variant="primary" disabled={busy !== null || !canPost} onClick={() => post(false)}>
              {busy === "post" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Post the run
            </Button>
          )}

          {run?.status === "POSTED" && (
            <Button variant="danger" disabled={busy !== null || !canPost} onClick={reverse}>
              {busy === "reverse" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
              Reverse
            </Button>
          )}

          {!canPost && run?.status === "DRAFT" && (
            <span className="text-xs text-slate-500">
              Posting needs the <code className="text-[11px]">partnership.post</code> permission.
            </span>
          )}
          {run?.status === "DRAFT" && (
            <span className="text-xs text-slate-500">
              Re-drafting overwrites the draft. Nothing reaches the ledger until it is posted.
            </span>
          )}
        </div>

        {/* ── Totals ──────────────────────────────────────────────────────── */}
        {run && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Stat label={`Profit to divide (${run.basis === "cash" ? "Net Cash" : run.basis === "revenue" ? "Total Income" : "basis not set"})`} value={acct(run.total_profit)} />
            <Stat label="Regional partners" value={acct(run.regional_total)} />
            <Stat label="Equity partners" value={acct(run.equity_total)} />
          </div>
        )}

        {/* ── What it would pay ───────────────────────────────────────────── */}
        {run && partnerRows.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <h3 className="text-sm text-slate-900 px-4 py-3 border-b border-slate-200">
              What this run pays
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="text-left px-4 py-2">Partner</th>
                    <th className="text-left px-4 py-2">Kind</th>
                    <th className="text-right px-4 py-2">Share</th>
                    <th className="text-right px-4 py-2">Base</th>
                    <th className="text-right px-4 py-2">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {partnerRows.map((r, i) => (
                    <tr key={`${r.partner_id ?? i}`}>
                      <td className="px-4 py-2 text-slate-900">{r.partner_name ?? "—"}</td>
                      <td className="px-4 py-2 text-slate-500 text-xs">
                        {r.row_kind === "REGIONAL_PARTNER"
                          ? `Regional · ${r.region_name ?? "no region"}`
                          : "Equity"}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.share_pct != null ? `${r.share_pct}%` : "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-500">{acct(r.base_amount)}</td>
                      <td className={`px-4 py-2 text-right tabular-nums ${Number(r.amount ?? 0) < 0 ? "text-danger-700" : "text-slate-900"}`}>
                        {acct(r.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {otherRows.length > 0 && (
              <div className="px-4 py-2 border-t border-slate-100 text-[11px] text-slate-500">
                {otherRows.length} further row{otherRows.length === 1 ? "" : "s"} in the allocation
                (region subtotals, head-office apportionment and any unallocated pool) — the review
                below names an unallocated pool if there is one.
              </div>
            )}
          </section>
        )}

        {/* ── Review ──────────────────────────────────────────────────────── */}
        <section className="bg-white border border-slate-200 rounded-lg">
          <h3 className="text-sm text-slate-900 px-4 py-3 border-b border-slate-200">
            Review — {monthName(period)}
          </h3>
          <div className="p-4 space-y-4">
            {review.length === 0 ? (
              <p className="text-sm text-slate-500 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-success-600" />
                Nothing flagged. This is not "the month is right" — it is "none of the four things
                the review looks for is present".
              </p>
            ) : (
              [...reviewByKind.entries()].map(([kind, rows]) => (
                <div key={kind}>
                  <h4 className="text-xs uppercase text-slate-500">
                    {REVIEW_KINDS[kind]?.title ?? kind} <span className="text-slate-400">({rows.length})</span>
                  </h4>
                  {REVIEW_KINDS[kind] && (
                    <p className="text-[11px] text-slate-500 mt-0.5">{REVIEW_KINDS[kind].note}</p>
                  )}
                  <ul className="mt-1.5 divide-y divide-slate-100 border border-slate-100 rounded">
                    {rows.map((r, i) => (
                      <li key={`${r.subject_id ?? i}`} className="px-3 py-1.5 flex justify-between gap-3 text-sm">
                        <span className="text-slate-700">{r.subject}</span>
                        <span className={`tabular-nums ${r.amount < 0 ? "text-danger-700" : "text-slate-600"}`}>
                          {acct(r.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}

            {/* Completeness is advisory here and a confirmation at posting time —
                never a block, because a hard block is worked around by
                back-dating an invoice, which is worse (0358 item 5). */}
            <div>
              <h4 className="text-xs uppercase text-slate-500">
                Live but never billed <span className="text-slate-400">({uninvoiced.length})</span>
              </h4>
              {uninvoiced.length === 0 ? (
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Every client with a contract live in {monthName(period)} has a primary invoice for it.
                </p>
              ) : (
                <>
                  <p className="text-[11px] text-warning-700 mt-0.5">
                    Their cost is in the pool and their revenue is not, so every partner's share is
                    understated. Posting will ask you to confirm.
                  </p>
                  <ul className="mt-1.5 divide-y divide-slate-100 border border-warning-200 rounded">
                    {uninvoiced.map((u) => (
                      <li key={u.client_id} className="px-3 py-1.5 text-sm text-slate-700">
                        {u.client_name}
                        <span className="text-slate-400 text-xs"> · {u.client_code}</span>
                        {u.region_name && <span className="text-slate-400 text-xs"> · {u.region_name}</span>}
                        <div className="text-[11px] text-slate-500">{u.reason}</div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg text-slate-900 tabular-nums mt-1">{value}</div>
    </div>
  );
}
