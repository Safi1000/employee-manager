import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, RotateCcw, X } from "lucide-react";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import { supabase } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";

/**
 * THE PARTNERSHIP RUN — draft, review, post.
 *
 * Until 0360 this screen could not exist. run_profit_allocation() computed a
 * month and posted it in the same call, so there was no drafted state to review
 * and no separate act of posting to review it FOR. The run was SQL-only: no
 * frontend called it at all, and a partner's month reached the ledger only if
 * somebody typed a function call.
 *
 * What is deliberately NOT here: payment. Posting credits each partner's
 * current account — it records what they are owed. Paying them is a separate
 * act on a separate screen, and putting a "pay" button beside "post" would
 * invite the two to be done as one, which is exactly how a partner ends up paid
 * for a month that was later reversed.
 */

const fmt = (n: number) =>
  `PKR ${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const monthOf = (d: Date) => d.toISOString().slice(0, 7);
const firstOf = (m: string) => `${m}-01`;
const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** Last month, which is the month a run is normally made for. */
const defaultMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return monthOf(d);
};

type Run = {
  id: string;
  period_month: string;
  status: "DRAFT" | "POSTED" | "REVERSED";
  basis: string | null;
  total_profit: number | null;
  regional_total: number | null;
  equity_total: number | null;
  entry_id: string | null;
  posted_at: string | null;
  reversed_at: string | null;
  inputs: InputRow[] | null;
  outputs: OutputRow[] | null;
};

/** One per (partner, client): the Net Cash the partner's take was computed from
 *  and the rate applied to it. Written by run_profit_allocation (0282). */
type InputRow = {
  partner_id: string;
  partner_name: string;
  client_id: string;
  client_net: number;
  pct: number;
  /** null = the partner's headline %, not a per-client override. */
  share_row_id: string | null;
};

type OutputRow = {
  row_kind: string;
  partner_id: string | null;
  partner_name: string | null;
  branch_id: string | null;
  region_name: string | null;
  amount: number | null;
  base_amount: number | null;
};

type Uninvoiced = {
  client_name: string;
  contract_code: string | null;
  region_name: string | null;
  reason: string;
};

type ReviewRow = {
  kind: string;
  subject: string;
  amount: number;
  detail: string;
};

type Deadline = { due_date: string; posted: boolean; days_late: number };

/** Agency and profit share, from the ledger rather than recomputed here. */
type PartnerPosition = {
  id: string;
  name: string;
  /** Signed: positive = money left the company through them. */
  agency: number;
  remuneration: number;
  balance: number;
};

export default function PartnershipRun() {
  const { profile } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? null;
  const canPost = hasPermission(profile, "partnership.post");

  const [month, setMonth] = useState(defaultMonth());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"draft" | "post" | "reverse" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [run, setRun] = useState<Run | null>(null);
  const [blocker, setBlocker] = useState<string | null>(null);
  const [uninvoiced, setUninvoiced] = useState<Uninvoiced[]>([]);
  const [review, setReview] = useState<ReviewRow[]>([]);
  const [deadline, setDeadline] = useState<Deadline | null>(null);
  const [positions, setPositions] = useState<Map<string, PartnerPosition>>(new Map());
  /** inputs stores client ids, not names — a review screen that shows a uuid
   *  is not a review screen. */
  const [clientNames, setClientNames] = useState<Map<string, string>>(new Map());

  /** Set when post() came back asking for confirmation. Holds the message the
   *  database wrote, because it names the clients and the reason for each. */
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const start = firstOf(month);
      const [runRes, blkRes, uninvRes, revRes, dlRes] = await Promise.all([
        supabase
          .from("profit_allocation_runs")
          .select(
            "id, period_month, status, basis, total_profit, regional_total, equity_total, entry_id, posted_at, reversed_at, inputs, outputs",
          )
          .eq("company_id", companyId)
          .eq("period_month", start)
          .maybeSingle(),
        supabase.rpc("partnership_run_blocker", { p_company_id: companyId, p_period: start }),
        supabase.rpc("partnership_uninvoiced_clients", { p_company_id: companyId, p_period: start }),
        supabase.rpc("profit_allocation_review", { p_company_id: companyId, p_period: start }),
        supabase.rpc("partnership_posting_deadline", { p_company_id: companyId, p_period: start }),
      ]);

      setRun((runRes.data as Run | null) ?? null);
      setBlocker(((blkRes.data as string | null) ?? null) || null);
      setUninvoiced((uninvRes.data ?? []) as Uninvoiced[]);
      setReview((revRes.data ?? []) as ReviewRow[]);
      setDeadline(((dlRes.data ?? []) as Deadline[])[0] ?? null);

      // Each partner's standing position, read from partner_ledger. NOT
      // recomputed from partner_account_entries — that is only the hand-entered
      // half and omits every agency movement, which is the defect the Summary
      // tab had before it was pointed at the ledger.
      const { data: pts } = await supabase
        .from("partners")
        .select("id, name")
        .eq("company_id", companyId)
        .eq("is_active", true);
      const map = new Map<string, PartnerPosition>();
      await Promise.all(
        ((pts ?? []) as { id: string; name: string }[]).map(async (p) => {
          const { data } = await supabase.rpc("partner_ledger", {
            p_partner_id: p.id,
            p_start: null,
            p_end: null,
          });
          const rows = (data ?? []) as { cash_paid: number; remuneration: number; balance: number }[];
          map.set(p.id, {
            id: p.id,
            name: p.name,
            agency: rows.reduce((s, r) => s + Number(r.cash_paid ?? 0), 0),
            remuneration: rows.reduce((s, r) => s + Number(r.remuneration ?? 0), 0),
            balance: rows.length ? Number(rows[rows.length - 1].balance ?? 0) : 0,
          });
        }),
      );
      setPositions(map);

      const { data: cls } = await supabase
        .from("clients")
        .select("id, name")
        .eq("company_id", companyId);
      setClientNames(new Map(((cls ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name])));
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [companyId, month]);

  useEffect(() => {
    void load();
  }, [load]);

  const draft = async () => {
    if (!companyId) return;
    setBusy("draft");
    setError(null);
    setNotice(null);
    const { error: e } = await supabase.rpc("draft_profit_allocation", {
      p_company_id: companyId,
      p_period: firstOf(month),
      p_basis: null,
    });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    setNotice(`Drafted ${monthLabel(month)}. Nothing has been posted — review it below.`);
    await load();
  };

  const post = async (confirmIncomplete: boolean) => {
    if (!run) return;
    setBusy("post");
    setError(null);
    setNotice(null);
    const { error: e } = await supabase.rpc("post_profit_allocation", {
      p_run_id: run.id,
      p_confirm_incomplete: confirmIncomplete,
    });
    setBusy(null);
    if (e) {
      // The completeness refusal is a question, not a failure — it carries the
      // client names and why each one is uninvoiced. Show it as the confirmation
      // it is rather than as a red error the user has to re-read as a prompt.
      if (!confirmIncomplete && /no primary invoice for the month/.test(e.message)) {
        setConfirmMsg(e.message);
        return;
      }
      setError(e.message);
      return;
    }
    setConfirmMsg(null);
    setNotice(
      `Posted ${monthLabel(month)}. Each partner's current account has been credited; paying them is separate.`,
    );
    await load();
  };

  const reverse = async () => {
    if (!run) return;
    setBusy("reverse");
    setError(null);
    const { error: e } = await supabase.rpc("reverse_profit_allocation", { p_run_id: run.id });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    setNotice(`Reversed ${monthLabel(month)}. The month can be drafted again.`);
    await load();
  };

  // ── Derived views of the stored run ──────────────────────────────────────
  const outputs = run?.outputs ?? [];

  const partnerRows = useMemo(() => {
    const byPartner = new Map<
      string,
      { id: string; name: string; kind: string; region: string | null; share: number }
    >();
    for (const o of outputs) {
      if (o.row_kind !== "REGIONAL_PARTNER" && o.row_kind !== "EQUITY_PARTNER") continue;
      if (!o.partner_id) continue;
      const prev = byPartner.get(o.partner_id);
      byPartner.set(o.partner_id, {
        id: o.partner_id,
        name: o.partner_name ?? "Partner",
        kind: o.row_kind,
        region: o.region_name ?? prev?.region ?? null,
        share: (prev?.share ?? 0) + Number(o.amount ?? 0),
      });
    }
    return Array.from(byPartner.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [outputs]);

  /** The per-client Net Cash and the rate applied, grouped under the partner it
   *  was computed for. This is `inputs`, stored at draft time — it is what the
   *  number on screen was actually made from, not a fresh recomputation that
   *  might disagree with the run beside it. */
  const inputsByPartner = useMemo(() => {
    const m = new Map<string, InputRow[]>();
    for (const i of run?.inputs ?? []) {
      const arr = m.get(i.partner_id) ?? [];
      arr.push(i);
      m.set(i.partner_id, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => b.client_net - a.client_net);
    return m;
  }, [run]);

  const [openPartner, setOpenPartner] = useState<string | null>(null);

  const statusChip = () => {
    if (!run) return <span className="text-sm text-slate-500">No run for this month</span>;
    const tone =
      run.status === "POSTED"
        ? "bg-success-50 text-success-700 border-success-200"
        : run.status === "DRAFT"
          ? "bg-amber-50 text-amber-700 border-amber-200"
          : "bg-slate-100 text-slate-600 border-slate-200";
    return (
      <span className={`text-xs px-2 py-1 rounded border font-medium ${tone}`}>{run.status}</span>
    );
  };

  if (!companyId) return null;

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-start gap-2 bg-danger-50 border border-danger-200 text-danger-800 rounded-md px-4 py-3">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="text-sm whitespace-pre-line flex-1">{error}</div>
          <button onClick={() => setError(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 bg-success-50 border border-success-200 text-success-800 rounded-md px-4 py-3">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="text-sm flex-1">{notice}</div>
          <button onClick={() => setNotice(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Month, status, actions ── */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Month</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          />
        </div>
        <div className="pb-2">{statusChip()}</div>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={draft} disabled={busy !== null || loading}>
            {busy === "draft" ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {run?.status === "DRAFT" ? "Re-draft" : "Draft"}
          </Button>
          {run?.status === "DRAFT" && (
            <Button
              onClick={() => post(false)}
              disabled={busy !== null || !canPost}
              title={canPost ? undefined : "Requires the partnership.post permission"}
            >
              {busy === "post" ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Post
            </Button>
          )}
          {run?.status === "POSTED" && (
            <Button
              variant="secondary"
              onClick={reverse}
              disabled={busy !== null || !canPost}
              title={canPost ? undefined : "Requires the partnership.post permission"}
            >
              <RotateCcw className="w-4 h-4" />
              Reverse
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        </div>
      ) : (
        <>
          {/* ── The blocker. Not advisory: the run refuses while it stands. ── */}
          {blocker && (
            <div className="bg-danger-50 border border-danger-200 rounded-md px-4 py-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 text-danger-700 shrink-0" />
                <div className="text-sm text-danger-800">
                  <div className="font-medium">This month cannot be allocated yet.</div>
                  <div className="mt-1 whitespace-pre-line">{blocker}</div>
                </div>
              </div>
            </div>
          )}

          {/* ── The deadline ── */}
          {deadline && !deadline.posted && (
            <div
              className={`rounded-md px-4 py-2 text-sm border ${
                deadline.days_late > 0
                  ? "bg-danger-50 border-danger-200 text-danger-800"
                  : "bg-slate-50 border-slate-200 text-slate-700"
              }`}
            >
              {deadline.days_late > 0
                ? `Overdue by ${deadline.days_late} day(s) — this run was due to be POSTED on ${deadline.due_date}.`
                : `Due to be POSTED by ${deadline.due_date}. Drafting does not satisfy the deadline.`}
            </div>
          )}

          {/* ── Completeness: named, and never a block ── */}
          {uninvoiced.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-700 shrink-0" />
                <div className="text-sm text-amber-900 w-full">
                  <div className="font-medium">
                    {uninvoiced.length} client{uninvoiced.length === 1 ? "" : "s"} live in{" "}
                    {monthLabel(month)} {uninvoiced.length === 1 ? "has" : "have"} no primary
                    invoice.
                  </div>
                  <div className="mt-1 text-amber-800">
                    Their cost is in the pool and their revenue is not, so every partner's share is
                    understated. You can still post — you will be asked to confirm.
                  </div>
                  <ul className="mt-2 space-y-0.5">
                    {uninvoiced.map((u, i) => (
                      <li key={i} className="text-amber-900">
                        <span className="font-medium">{u.client_name}</span>
                        {u.contract_code ? ` (${u.contract_code})` : ""}
                        {u.region_name ? ` · ${u.region_name}` : ""} — {u.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* ── Surfacing review (0282): worth a look, none of it wrong ── */}
          {review.length > 0 && (
            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
              <div className="px-4 py-2 border-b border-slate-200 text-sm font-medium text-slate-700">
                Worth a look before posting
              </div>
              <table className="w-full">
                <tbody>
                  {review.map((r, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-2 text-sm text-slate-900">{r.subject}</td>
                      <td className="px-4 py-2 text-sm text-slate-500">{r.detail}</td>
                      <td className="px-4 py-2 text-sm font-mono text-right text-slate-900">
                        {fmt(r.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── The run itself ── */}
          {!run ? (
            <div className="bg-white rounded-lg border border-slate-200 px-4 py-10 text-center text-sm text-slate-500">
              Nothing drafted for {monthLabel(month)} yet.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  ["Profit for the month", run.total_profit],
                  ["Regional partners", run.regional_total],
                  ["Equity partners", run.equity_total],
                ].map(([label, v]) => (
                  <div key={label as string} className="bg-white rounded-lg border border-slate-200 p-4">
                    <div className="text-xs text-slate-500">{label as string}</div>
                    <div className="text-lg font-mono text-slate-900">{fmt(Number(v ?? 0))}</div>
                  </div>
                ))}
              </div>
              <div className="text-xs text-slate-500">
                Basis: {run.basis === "cash" ? "Net Cash (cash basis)" : "Total Income (revenue basis)"}.
                Regional + equity exhausts the profit — the run refuses to post if it does not.
              </div>

              <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left px-4 py-3 text-sm text-slate-500">Partner</th>
                      <th className="text-left px-4 py-3 text-sm text-slate-500">Region</th>
                      <th className="text-right px-4 py-3 text-sm text-slate-500">
                        This month's share
                      </th>
                      <th className="text-right px-4 py-3 text-sm text-slate-500">Net position</th>
                    </tr>
                  </thead>
                  <tbody>
                    {partnerRows.map((p) => {
                      const pos = positions.get(p.id);
                      const clients = inputsByPartner.get(p.id) ?? [];
                      const open = openPartner === p.id;
                      return (
                        <Fragment key={p.id}>
                          <tr
                            className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                            onClick={() => setOpenPartner(open ? null : p.id)}
                          >
                            <td className="px-4 py-3 text-sm text-slate-900">
                              {p.name}
                              <span className="ml-2 text-xs text-slate-400">
                                {p.kind === "EQUITY_PARTNER" ? "equity" : "regional"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-sm text-slate-500">
                              {p.kind === "EQUITY_PARTNER" ? "—" : (p.region ?? "—")}
                            </td>
                            <td className="px-4 py-3 text-sm font-mono text-right text-slate-900">
                              {fmt(p.share)}
                            </td>
                            {/* ONE NET FIGURE, with agency and profit beneath it.
                                The ledger keeps cash_paid and remuneration as
                                separate columns and nets them into the running
                                balance; showing the net alone would hide that a
                                partner "owed nothing" may be holding 80,000 of
                                company cash against 80,000 of profit share. */}
                            <td className="px-4 py-3 text-right">
                              <div className="text-sm font-mono text-slate-900">
                                {fmt(pos?.balance ?? 0)}
                              </div>
                              <div className="text-xs text-slate-500 font-mono">
                                profit {fmt(pos?.remuneration ?? 0)} · agency{" "}
                                {fmt(-(pos?.agency ?? 0))}
                              </div>
                            </td>
                          </tr>
                          {open && (
                            <tr className="bg-slate-50">
                              <td colSpan={4} className="px-4 py-3">
                                {clients.length === 0 ? (
                                  <div className="text-sm text-slate-500">
                                    {p.kind === "EQUITY_PARTNER"
                                      ? "An equity share bites on the residual pool, which is not attributable to any single client."
                                      : "No per-client inputs were stored for this partner."}
                                  </div>
                                ) : (
                                  <table className="w-full">
                                    <thead>
                                      <tr>
                                        <th className="text-left text-xs text-slate-500 pb-1">
                                          Client
                                        </th>
                                        <th className="text-right text-xs text-slate-500 pb-1">
                                          Net {run.basis === "cash" ? "Cash" : "Income"}
                                        </th>
                                        <th className="text-right text-xs text-slate-500 pb-1">
                                          Rate applied
                                        </th>
                                        <th className="text-right text-xs text-slate-500 pb-1">
                                          Share
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {clients.map((c, i) => (
                                        <tr key={i}>
                                          <td className="text-sm text-slate-700 py-0.5">
                                            {clientNames.get(c.client_id) ??
                                              c.client_id.slice(0, 8)}
                                          </td>
                                          <td className="text-sm font-mono text-right text-slate-700">
                                            {fmt(c.client_net)}
                                          </td>
                                          <td className="text-sm font-mono text-right text-slate-700">
                                            {Number(c.pct)}%
                                            {c.share_row_id ? (
                                              <span
                                                className="ml-1 text-xs text-amber-700"
                                                title="Per-client override, not this partner's headline rate"
                                              >
                                                override
                                              </span>
                                            ) : null}
                                          </td>
                                          <td className="text-sm font-mono text-right text-slate-900">
                                            {fmt((Number(c.client_net) * Number(c.pct)) / 100)}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {partnerRows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">
                          This run allocated nothing to any partner.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {run.status === "POSTED" && (
                <div className="text-xs text-slate-500">
                  Posted {run.posted_at?.slice(0, 10)}. Each partner's current account has been
                  credited — payment is a separate act, on the partner's own screen.
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── Confirm-to-proceed. The database wrote this message; it names the
             clients and why each one is uninvoiced, so it is shown verbatim
             rather than summarised into something less specific. ── */}
      <Modal
        isOpen={confirmMsg !== null}
        onClose={() => setConfirmMsg(null)}
        title={`Post ${monthLabel(month)} anyway?`}
        size="md"
      >
        <div className="space-y-4">
          <div className="text-sm text-slate-700 whitespace-pre-line">{confirmMsg}</div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmMsg(null)}>
              Cancel
            </Button>
            <Button onClick={() => post(true)} disabled={busy !== null}>
              {busy === "post" ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Post anyway
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
