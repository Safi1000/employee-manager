import { useCallback, useEffect, useMemo, useState } from "react";
import PartnershipRegions from "../../components/PartnershipRegions";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Download, FileText, Loader2, RotateCcw, Send,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import ThemedSelect from "../../components/ThemedSelect";
import { supabase } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { usePageState } from "../../lib/pageState";
import { exportTable } from "../../lib/excel";

/**
 * PARTNERSHIP — MONTHS (redesigned 2026-10-26; the run, rebuilt in 0360s).
 *
 * One month at a time, read top to bottom the way it is worked:
 *   the year      — every month's state and profit, one click to open it;
 *   the month     — status, who posted it and when, the actions;
 *   before posting — a checklist: can it be drafted, is every client billed,
 *                   what the review flags;
 *   where the profit came from — each region: its own profit, its share of head
 *                   office, what its regional partner took, what reached equity;
 *   who gets what — each partner's total for the month; open one for the
 *                   detail: client by client (regional), region by region
 *                   (equity), and the partner's running position.
 * A posted month reads exactly as it was posted — the run's stored inputs and
 * outputs, never recomputed — and exports as a statement.
 *
 * Every rule lives in the database and is deliberately NOT restated here:
 *   partnership_run_blocker, draft_profit_allocation (0361),
 *   profit_allocation_review (0303), partnership_uninvoiced_clients (0358),
 *   post_profit_allocation, reverse_profit_allocation,
 *   partnership_posting_deadline. The screen calls them in order and shows
 *   what they say.
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
  posted_by: string | null;
  reversed_at: string | null;
  entry_id: string | null;
  outputs: AllocationRow[] | null;
  inputs: InputRow[] | null;
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
/** One client line the run was drafted from: the client's net and a regional partner's % of it. */
type InputRow = { client_id: string; client_net: number; partner_id: string; partner_name: string; pct: number };

type ReviewRow = { kind: string; subject: string; subject_id: string | null; amount: number; detail: string };
type Uninvoiced = { client_id: string; client_code: string; client_name: string; contract_code: string | null; region_name: string | null; reason: string };
type Deadline = { period_month: string; due_date: string; posted: boolean; days_late: number };

const money = (n: number | null | undefined) => Math.round(Number(n ?? 0)).toLocaleString();
/** Accounting negatives, because a partner's share can legitimately be one (A9). */
const acct = (n: number | null | undefined) => (Number(n ?? 0) < 0 ? `(${money(Math.abs(Number(n ?? 0)))})` : money(n));
const firstOfMonth = (p: string) => `${p}-01`;
const monthName = (p: string) => new Date(`${p}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
const shortMonth = (p: string) => new Date(`${p}-01T00:00:00`).toLocaleDateString(undefined, { month: "short" });
const longDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const previousMonthKey = () => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/** Headings for profit_allocation_review's `kind`, so the screen does not show a slug. */
const REVIEW_KINDS: Record<string, { title: string; note: string }> = {
  client_cost_no_invoice: { title: "Cost booked, nothing billed", note: "Their cost is in the pool and their revenue is not, so every partner's share is understated." },
  client_negative_net: { title: "Clients net negative for the month", note: "Not necessarily wrong — a month of costs against a client billed elsewhere looks like this." },
  unallocated_pool: { title: "A pool reached no region", note: "Head office cost with no revenue base to apportion it against. It is sitting unallocated." },
  partner_negative_total: { title: "A partner's total is negative", note: "A9 permits this with no floor; it reduces the partner's capital account." },
};

export default function PartnershipRun() {
  const { profile } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? null;
  // The database refuses a post without partnership.post (0361); this only
  // decides whether the button is offered.
  const canPost = hasPermission(profile, "partnership.post");

  const [period, setPeriod] = usePageState("PartnershipRun.period", previousMonthKey());
  const [run, setRun] = useState<Run | null>(null);
  const [positions, setPositions] = useState<Map<string, { agency: number; remuneration: number; balance: number }>>(new Map());
  const [blocker, setBlocker] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewRow[]>([]);
  const [uninvoiced, setUninvoiced] = useState<Uninvoiced[]>([]);
  const [deadline, setDeadline] = useState<Deadline | null>(null);
  const [yearRuns, setYearRuns] = useState<Map<string, { status: string; profit: number | null }>>(new Map());
  const [clientName, setClientName] = useState<Map<string, string>>(new Map());
  const [postedByName, setPostedByName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "draft" | "post" | "reverse">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const [openPartner, setOpenPartner] = useState<string | null>(null);

  const periodOptions = useMemo(() => {
    const out: string[] = [];
    const d = new Date(); d.setDate(1);
    for (let i = 0; i < 15; i++) {
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      d.setMonth(d.getMonth() - 1);
    }
    return out;
  }, []);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true); setError(null);
    const month = firstOfMonth(period);
    const [runRes, blockRes, revRes, uninvRes, dueRes, yrRes, clRes] = await Promise.all([
      supabase.from("profit_allocation_runs")
        .select("id, period_month, status, basis, total_profit, regional_total, equity_total, posted_at, posted_by, reversed_at, entry_id, outputs, inputs")
        .eq("company_id", companyId).eq("period_month", month).maybeSingle(),
      supabase.rpc("partnership_run_blocker", { p_company_id: companyId, p_period: month }),
      supabase.rpc("profit_allocation_review", { p_company_id: companyId, p_period: month }),
      supabase.rpc("partnership_uninvoiced_clients", { p_company_id: companyId, p_period: month }),
      supabase.rpc("partnership_posting_deadline", { p_company_id: companyId, p_period: month }),
      supabase.from("profit_allocation_runs").select("period_month, status, total_profit")
        .eq("company_id", companyId).gte("period_month", firstOfMonth(periodOptions[periodOptions.length - 1])),
      supabase.from("clients").select("id, name").eq("company_id", companyId),
    ]);
    setYearRuns(new Map(((yrRes.data ?? []) as { period_month: string; status: string; total_profit: number | null }[])
      .map((r) => [r.period_month.slice(0, 7), { status: r.status, profit: r.total_profit == null ? null : Number(r.total_profit) }])));
    setClientName(new Map(((clRes.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name])));

    // Each active partner's standing position, from partner_ledger (never
    // recomputed from hand-entered rows, which omit every agency movement).
    const { data: pts } = await supabase.from("partners").select("id").eq("company_id", companyId).eq("is_active", true);
    const pos = new Map<string, { agency: number; remuneration: number; balance: number }>();
    await Promise.all(((pts ?? []) as { id: string }[]).map(async (pt) => {
      const { data } = await supabase.rpc("partner_ledger", { p_partner_id: pt.id, p_start: null, p_end: null });
      const rows = (data ?? []) as { cash_paid: number; remuneration: number; balance: number }[];
      pos.set(pt.id, {
        agency: rows.reduce((n, x) => n + Number(x.cash_paid ?? 0), 0),
        remuneration: rows.reduce((n, x) => n + Number(x.remuneration ?? 0), 0),
        balance: rows.length ? Number(rows[rows.length - 1].balance ?? 0) : 0,
      });
    }));
    setPositions(pos);

    setLoading(false);
    if (runRes.error) { setError(runRes.error.message); return; }
    const r = (runRes.data ?? null) as Run | null;
    setRun(r);
    setPostedByName(null);
    if (r?.posted_by) {
      const { data: pf } = await supabase.from("profiles").select("full_name").eq("id", r.posted_by).maybeSingle();
      setPostedByName((pf as { full_name: string | null } | null)?.full_name ?? null);
    }
    setBlocker((blockRes.data ?? null) as string | null);
    setReview((revRes.data ?? []) as ReviewRow[]);
    setUninvoiced((uninvRes.data ?? []) as Uninvoiced[]);
    setDeadline(((dueRes.data ?? []) as Deadline[])[0] ?? null);
  }, [companyId, period, periodOptions]);
  useEffect(() => { void load(); setOpenPartner(null); setOpenCheck(null); }, [load]);

  const draft = async () => {
    if (!companyId) return;
    setBusy("draft"); setError(null); setNotice(null);
    const { error: e } = await supabase.rpc("draft_profit_allocation", { p_company_id: companyId, p_period: firstOfMonth(period), p_basis: null });
    setBusy(null);
    if (e) { setError(e.message); return; }
    setNotice(`${monthName(period)} is drafted. Nothing has been posted — check it below, then post.`);
    await load();
  };
  const post = async (confirmIncomplete = false) => {
    if (!run) return;
    setBusy("post"); setError(null); setNotice(null);
    const { error: e } = await supabase.rpc("post_profit_allocation", { p_run_id: run.id, p_confirm_incomplete: confirmIncomplete });
    setBusy(null);
    if (e) {
      // 0361 raises the completeness gate as a CONFIRMATION, marked with this
      // hint: the first call names the clients, the second proceeds. Any other
      // refusal is shown as it came — it names what moved.
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
      `Reverse the posted run for ${monthName(period)}?\n\nThis unwinds the journal entry and every partner's share for the month. ` +
      "The posting deadline comes back onto the compliance calendar.",
    )) return;
    setBusy("reverse"); setError(null); setNotice(null);
    const { error: e } = await supabase.rpc("reverse_profit_allocation", { p_run_id: run.id });
    setBusy(null);
    if (e) { setError(e.message); return; }
    setNotice(`${monthName(period)} is reversed. Re-draft it when the source data is right.`);
    await load();
  };

  // ── the run, read ──
  const outputs = run?.outputs ?? [];
  const inputs = run?.inputs ?? [];
  const regions = outputs.filter((r) => r.row_kind === "REGION");
  const unallocated = outputs.filter((r) => r.row_kind === "UNALLOCATED").reduce((n, r) => n + Number(r.amount ?? 0), 0);
  const partners = useMemo(() => {
    const m = new Map<string, { id: string; name: string; kinds: Set<string>; total: number; regional: AllocationRow[]; equity: AllocationRow[]; equityRegions: AllocationRow[] }>();
    for (const r of outputs) {
      if (!r.partner_id || !["REGIONAL_PARTNER", "EQUITY_PARTNER", "EQUITY_REGION"].includes(r.row_kind)) continue;
      const p = m.get(r.partner_id) ?? { id: r.partner_id, name: r.partner_name ?? "—", kinds: new Set<string>(), total: 0, regional: [], equity: [], equityRegions: [] };
      if (r.row_kind === "REGIONAL_PARTNER") { p.regional.push(r); p.total += Number(r.amount ?? 0); p.kinds.add("Regional"); }
      if (r.row_kind === "EQUITY_PARTNER") { p.equity.push(r); p.total += Number(r.amount ?? 0); p.kinds.add("Equity"); }
      if (r.row_kind === "EQUITY_REGION") p.equityRegions.push(r);
      m.set(r.partner_id, p);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [outputs]);
  const reviewByKind = useMemo(() => {
    const m = new Map<string, ReviewRow[]>();
    for (const r of review) m.set(r.kind, [...(m.get(r.kind) ?? []), r]);
    return m;
  }, [review]);

  const exportStatement = async () => {
    if (!run) return;
    const rows: (string | number | null)[][] = [];
    rows.push(["Month", monthName(period), "", ""]);
    rows.push(["Status", run.status + (run.posted_at ? ` · posted ${longDate(run.posted_at)}${postedByName ? ` by ${postedByName}` : ""}` : ""), "", ""]);
    rows.push(["Basis", run.basis === "cash" ? "Net cash" : run.basis === "revenue" ? "Total income" : "—", "", ""]);
    rows.push(["Profit to divide", "", "", Number(run.total_profit ?? 0)]);
    rows.push([]);
    rows.push(["WHERE THE PROFIT CAME FROM", "", "", ""]);
    for (const r of regions) {
      rows.push(["Region", r.region_name ?? "—", "Own profit", Number(r.own_profit ?? 0)]);
      rows.push(["", "", "Head office share", Number(r.ho_allocated ?? 0)]);
      rows.push(["", "", "Profit to share", Number(r.base_amount ?? 0)]);
      rows.push(["", "", "To regional partner", Number(r.amount ?? 0)]);
      rows.push(["", "", "To equity", Number(r.residual ?? 0)]);
    }
    rows.push([]);
    rows.push(["WHO GETS WHAT", "", "", ""]);
    for (const p of partners) {
      rows.push(["Partner", p.name, [...p.kinds].join(" + "), p.total]);
      for (const x of p.regional) rows.push(["", `Regional · ${x.region_name ?? ""}`, `${x.share_pct ?? ""}% of ${money(x.base_amount)}`, Number(x.amount ?? 0)]);
      for (const x of p.equityRegions) rows.push(["", `Equity · ${x.region_name ?? ""}`, `${x.share_pct ?? ""}%`, Number(x.amount ?? 0)]);
    }
    if (unallocated) rows.push(["Unallocated", "", "", unallocated]);
    rows.push([]);
    rows.push(["CLIENT BY CLIENT (regional partners)", "", "", ""]);
    for (const i of inputs) rows.push([i.partner_name, clientName.get(i.client_id) ?? i.client_id, `${i.pct}% of ${money(i.client_net)}`, Math.round(Number(i.client_net) * Number(i.pct)) / 100]);
    await exportTable({
      fileName: `Partnership ${monthName(period)}.xlsx`, sheetName: "Partnership", title: `Partnership — ${monthName(period)}`,
      headers: ["", "", "", "PKR"], rows, columnWidths: [26, 34, 30, 16],
    });
  };

  // ── the checklist ──
  type Check = { key: string; ok: boolean; title: string; sub: string; body?: React.ReactNode };
  const checks: Check[] = [
    {
      key: "draftable", ok: !blocker, title: blocker ? "This month can't be drafted yet" : "The month can be drafted",
      sub: blocker ?? "Nothing stands in the way.",
    },
    {
      key: "billed", ok: uninvoiced.length === 0,
      title: uninvoiced.length ? `${uninvoiced.length} client${uninvoiced.length === 1 ? "" : "s"} live but never billed` : "Every live client is billed",
      sub: uninvoiced.length ? "Their cost is in the pool and their revenue is not. Posting will ask you to confirm." : `Every client with a live contract has a primary invoice for ${monthName(period)}.`,
      body: uninvoiced.length ? (
        <ul className="divide-y divide-border text-sm">
          {uninvoiced.map((u) => (
            <li key={`${u.client_id}${u.contract_code}`} className="py-1.5 flex flex-wrap gap-x-2">
              <span className="text-foreground">{u.client_name}</span>
              <span className="text-xs text-muted-foreground">{u.contract_code ?? ""} · {u.region_name ?? ""} · {u.reason}</span>
            </li>
          ))}
        </ul>
      ) : undefined,
    },
    ...[...reviewByKind.entries()].map(([kind, rows]): Check => ({
      key: kind, ok: false,
      title: `${REVIEW_KINDS[kind]?.title ?? kind} · ${rows.length}`,
      sub: REVIEW_KINDS[kind]?.note ?? "",
      body: (
        <ul className="divide-y divide-border text-sm">
          {rows.map((r, i) => (
            <li key={`${r.subject_id ?? i}`} className="py-1.5 flex justify-between gap-3">
              <span className="text-foreground">{r.subject}{r.detail ? <span className="text-xs text-muted-foreground"> · {r.detail}</span> : null}</span>
              <span className={`font-ledger ${r.amount < 0 ? "text-down" : "text-muted-foreground"}`}>{acct(r.amount)}</span>
            </li>
          ))}
        </ul>
      ),
    })),
  ];
  const openIssues = checks.filter((c) => !c.ok).length;

  const statusChip = (st: string | undefined) =>
    st === "POSTED" ? "bg-success-50 text-success-700 border-success-200"
    : st === "DRAFT" ? "bg-warning-50 text-warning-700 border-warning-200"
    : st === "REVERSED" ? "bg-muted text-muted-foreground border-border"
    : "bg-card text-muted-foreground border-border";
  const statusText = !run ? "Not drafted" : run.status === "DRAFT" ? "Draft — not posted" : run.status === "POSTED" ? "Posted" : "Reversed";

  return (
    <>
      <Header
        title="Partnership"
        subtitle="Each month's profit, where it came from and who it goes to — drafted, checked, posted, and kept"
        actions={
          <div className="flex items-center gap-2">
            {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            <ThemedSelect value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Month" className="w-44 min-h-10 rounded-xl">
              {periodOptions.map((p) => <option key={p} value={p}>{monthName(p)}</option>)}
            </ThemedSelect>
          </div>
        }
      >
        {/* The year: each month's state and profit. */}
        <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-12 gap-1.5">
          {[...periodOptions].reverse().slice(-12).map((p) => {
            const y = yearRuns.get(p);
            const tone = y?.status === "POSTED" ? "border-up/50 bg-up/10" : y?.status === "DRAFT" ? "border-heed/50 bg-heed/10" : y?.status === "REVERSED" ? "border-down/40 bg-down/10" : "border-border bg-card";
            return (
              <button key={p} type="button" onClick={() => setPeriod(p)}
                className={`rounded-xl border px-2 py-1.5 text-left transition-colors ${tone} ${p === period ? "ring-2 ring-brand-500" : "hover:border-brand-500/60"}`}
                title={`${monthName(p)} — ${y ? y.status.toLowerCase() : "not started"}`}>
                <span className="block text-[11px] font-semibold text-foreground">{shortMonth(p)}</span>
                <span className="block text-[10px] text-muted-foreground truncate">
                  {y?.status === "POSTED" ? "posted" : y?.status === "DRAFT" ? "draft" : y?.status === "REVERSED" ? "reversed" : "—"}
                </span>
                {y?.profit != null && y.status !== "REVERSED" && <span className="block font-ledger text-[11px] text-foreground truncate">{acct(y.profit)}</span>}
              </button>
            );
          })}
        </div>
      </Header>

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-5">
        {error && (
          <div className="bg-danger-50 border border-danger-200 rounded-lg px-4 py-3">
            {/* Whitespace kept: the refusals list what moved or who is missing. */}
            <pre className="text-sm text-danger-700 whitespace-pre-wrap font-sans">{error}</pre>
          </div>
        )}
        {notice && <div className="bg-success-50 border border-success-200 rounded-lg px-4 py-3 text-sm text-success-700">{notice}</div>}

        {/* ── The month ─────────────────────────────────────────────────────── */}
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-4 flex flex-wrap items-start gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-xl font-bold tracking-tight text-foreground">{monthName(period)}</h2>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${statusChip(run?.status)}`}>{statusText}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {run?.status === "POSTED" && run.posted_at
                  ? <>Posted {longDate(run.posted_at)}{postedByName ? ` by ${postedByName}` : ""}{run.entry_id ? ` · journal ${run.entry_id.slice(0, 8)}` : ""} — this is the month as it was posted.</>
                  : run?.status === "REVERSED" && run.reversed_at ? <>Reversed {longDate(run.reversed_at)}. Draft it again when the source data is right.</>
                  : deadline ? <>Due {longDate(deadline.due_date)}{deadline.days_late > 0 && !deadline.posted ? <span className="text-down font-semibold"> · {deadline.days_late} days late</span> : ""}</> : null}
                {run?.basis && <> · basis: {run.basis === "cash" ? "net cash" : run.basis === "revenue" ? "total income" : run.basis}</>}
              </p>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {run && (
                <Button variant="ghost" onClick={() => void exportStatement()}>
                  <Download className="w-4 h-4" /> Export statement
                </Button>
              )}
              {run?.status !== "POSTED" && (
                <Button variant={run?.status === "DRAFT" ? "secondary" : "primary"} disabled={busy !== null || !!blocker} onClick={draft}>
                  {busy === "draft" ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                  {run?.status === "DRAFT" ? "Re-draft" : "Draft this month"}
                </Button>
              )}
              {run?.status === "DRAFT" && (
                <Button variant="primary" disabled={busy !== null || !canPost} onClick={() => post(false)}
                  title={canPost ? undefined : "Posting needs the partnership.post permission"}>
                  {busy === "post" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Post
                </Button>
              )}
              {run?.status === "POSTED" && (
                <Button variant="danger" disabled={busy !== null || !canPost} onClick={reverse}>
                  {busy === "reverse" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} Reverse
                </Button>
              )}
            </div>
          </div>
          {run && run.status !== "REVERSED" && (
            <div className="grid grid-cols-2 lg:grid-cols-4 border-t border-border divide-x divide-border">
              {[
                { k: "Profit to divide", v: run.total_profit },
                { k: "To regional partners", v: run.regional_total },
                { k: "To equity partners", v: run.equity_total },
                { k: "Unallocated", v: unallocated },
              ].map((x) => (
                <div key={x.k} className="px-5 py-3">
                  <span className="lbl">{x.k}</span>
                  <div className={`font-ledger text-xl font-semibold mt-0.5 ${Number(x.v ?? 0) < 0 ? "text-down" : "text-foreground"}`}>
                    <span className="cur">PKR</span>{acct(x.v)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Before posting: the checklist ─────────────────────────────────── */}
        {run?.status !== "POSTED" && (
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center gap-2">
              <h3 className="font-display text-base font-bold tracking-tight text-foreground">Before posting</h3>
              <span className={`ml-auto text-xs font-semibold ${openIssues ? "text-heed" : "text-success-700 dark:text-success-500"}`}>
                {openIssues ? `${openIssues} to look at` : "all clear"}
              </span>
            </div>
            <ul className="divide-y divide-border">
              {checks.map((c) => {
                const open = openCheck === c.key;
                return (
                  <li key={c.key} className="px-5 py-2.5">
                    <button type="button" disabled={!c.body} onClick={() => setOpenCheck(open ? null : c.key)} className="w-full flex items-start gap-3 text-left">
                      {c.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-success-600 flex-shrink-0" /> : <CircleAlert className="w-4 h-4 mt-0.5 text-heed flex-shrink-0" />}
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-foreground">{c.title}</span>
                        <span className="block text-xs text-muted-foreground">{c.sub}</span>
                      </span>
                      {c.body && (open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />)}
                    </button>
                    {open && c.body && <div className="mt-2 ml-7 rounded-lg border border-border px-3">{c.body}</div>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {!run && !loading && (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {blocker ? <><AlertTriangle className="w-4 h-4 inline mr-1 text-heed" />{blocker}</> : <>Nothing drafted for {monthName(period)} yet. Draft it to see where the profit came from and who gets what — nothing reaches the ledger until it is posted.</>}
          </div>
        )}

        {run && run.status !== "REVERSED" && (
          <>
            {/* ── Where the profit came from ────────────────────────────────── */}
            {regions.length > 0 && (
              <section className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="px-5 py-3 border-b border-border">
                  <h3 className="font-display text-base font-bold tracking-tight text-foreground">Where the profit came from</h3>
                  <p className="text-xs text-muted-foreground">Each region&rsquo;s own profit, its share of head office, what its regional partner took, and what reached the equity pool.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="text-left px-5 py-2 font-medium">Region</th>
                        <th className="text-right px-4 py-2 font-medium">Own profit</th>
                        <th className="text-right px-4 py-2 font-medium">Head office</th>
                        <th className="text-right px-4 py-2 font-medium">To share</th>
                        <th className="text-right px-4 py-2 font-medium">Regional partner</th>
                        <th className="text-right px-5 py-2 font-medium">To equity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {regions.map((r) => {
                        const rp = outputs.filter((x) => x.row_kind === "REGIONAL_PARTNER" && x.branch_id === r.branch_id);
                        return (
                          <tr key={r.branch_id ?? r.region_name ?? ""}>
                            <td className="px-5 py-2 text-foreground">{r.region_name ?? "—"}</td>
                            <td className={`px-4 py-2 text-right font-ledger ${Number(r.own_profit) < 0 ? "text-down" : ""}`}>{acct(r.own_profit)}</td>
                            <td className="px-4 py-2 text-right font-ledger text-muted-foreground">{acct(r.ho_allocated)}</td>
                            <td className="px-4 py-2 text-right font-ledger">{acct(r.base_amount)}</td>
                            <td className="px-4 py-2 text-right">
                              <span className="font-ledger">{acct(r.amount)}</span>
                              {rp.length > 0 && <span className="block text-[11px] text-muted-foreground">{rp.map((x) => `${x.partner_name} ${x.share_pct}%`).join(", ")}</span>}
                            </td>
                            <td className={`px-5 py-2 text-right font-ledger font-semibold ${Number(r.residual) < 0 ? "text-down" : ""}`}>{acct(r.residual)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border font-semibold">
                        <td className="px-5 py-2">Total</td>
                        <td className="px-4 py-2 text-right font-ledger">{acct(regions.reduce((n, r) => n + Number(r.own_profit ?? 0), 0))}</td>
                        <td className="px-4 py-2 text-right font-ledger text-muted-foreground">{acct(regions.reduce((n, r) => n + Number(r.ho_allocated ?? 0), 0))}</td>
                        <td className="px-4 py-2 text-right font-ledger">{acct(regions.reduce((n, r) => n + Number(r.base_amount ?? 0), 0))}</td>
                        <td className="px-4 py-2 text-right font-ledger">{acct(regions.reduce((n, r) => n + Number(r.amount ?? 0), 0))}</td>
                        <td className="px-5 py-2 text-right font-ledger">{acct(regions.reduce((n, r) => n + Number(r.residual ?? 0), 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>
            )}

            {/* ── Who gets what ─────────────────────────────────────────────── */}
            {partners.length > 0 && (
              <section className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="px-5 py-3 border-b border-border">
                  <h3 className="font-display text-base font-bold tracking-tight text-foreground">Who gets what</h3>
                  <p className="text-xs text-muted-foreground">Open a partner for the detail behind the figure and where their account stands.</p>
                </div>
                <ul className="divide-y divide-border">
                  {partners.map((p) => {
                    const open = openPartner === p.id;
                    const pos = positions.get(p.id);
                    const myInputs = inputs.filter((i) => i.partner_id === p.id && Number(i.client_net) !== 0)
                      .sort((a, b) => Number(b.client_net) * Number(b.pct) - Number(a.client_net) * Number(a.pct));
                    const clientSum = myInputs.reduce((n, i) => n + Number(i.client_net) * Number(i.pct) / 100, 0);
                    const regionalAmt = p.regional.reduce((n, x) => n + Number(x.amount ?? 0), 0);
                    return (
                      <li key={p.id}>
                        <button type="button" onClick={() => setOpenPartner(open ? null : p.id)} className="w-full px-5 py-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-left hover:bg-muted/30">
                          {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                          <span className="font-medium text-foreground">{p.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {[...p.kinds].join(" + ")}
                            {p.regional.length ? ` · ${p.regional.map((x) => `${x.region_name} ${x.share_pct}%`).join(", ")}` : ""}
                            {p.equity.length ? ` · equity ${p.equity.map((x) => `${x.share_pct}%`).join(", ")}` : ""}
                          </span>
                          <span className={`ml-auto font-ledger text-lg font-semibold ${p.total < 0 ? "text-down" : "text-foreground"}`}>{acct(p.total)}</span>
                        </button>
                        {open && (
                          <div className="px-5 pb-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
                            <div className="flex flex-col gap-3">
                              {p.regional.length > 0 && (
                                <div className="rounded-lg border border-border">
                                  <div className="px-3 py-2 text-xs font-semibold text-foreground border-b border-border">Regional share — client by client</div>
                                  <ul className="divide-y divide-border text-sm max-h-72 overflow-y-auto">
                                    {myInputs.map((i) => (
                                      <li key={i.client_id} className="px-3 py-1.5 flex justify-between gap-3">
                                        <span className="truncate">{clientName.get(i.client_id) ?? "Client"} <span className="text-[11px] text-muted-foreground">· {i.pct}% of {acct(i.client_net)}</span></span>
                                        <span className={`font-ledger ${Number(i.client_net) < 0 ? "text-down" : ""}`}>{acct(Number(i.client_net) * Number(i.pct) / 100)}</span>
                                      </li>
                                    ))}
                                  </ul>
                                  <div className="px-3 py-1.5 border-t border-border text-sm flex justify-between"><span className="text-muted-foreground">Clients, before head office</span><span className="font-ledger">{acct(clientSum)}</span></div>
                                  <div className="px-3 py-1.5 text-sm flex justify-between"><span className="text-muted-foreground">Head office and region adjustments</span><span className="font-ledger">{acct(regionalAmt - clientSum)}</span></div>
                                  <div className="px-3 py-1.5 border-t border-border text-sm font-semibold flex justify-between"><span>Regional share</span><span className="font-ledger">{acct(regionalAmt)}</span></div>
                                </div>
                              )}
                              {p.equityRegions.length > 0 && (
                                <div className="rounded-lg border border-border">
                                  <div className="px-3 py-2 text-xs font-semibold text-foreground border-b border-border">Equity share — region by region</div>
                                  <ul className="divide-y divide-border text-sm">
                                    {p.equityRegions.map((x) => (
                                      <li key={x.branch_id ?? x.region_name ?? ""} className="px-3 py-1.5 flex justify-between gap-3">
                                        <span>{x.region_name ?? "—"} <span className="text-[11px] text-muted-foreground">· {x.share_pct}%</span></span>
                                        <span className={`font-ledger ${Number(x.amount) < 0 ? "text-down" : ""}`}>{acct(x.amount)}</span>
                                      </li>
                                    ))}
                                  </ul>
                                  <div className="px-3 py-1.5 border-t border-border text-sm font-semibold flex justify-between"><span>Equity share</span><span className="font-ledger">{acct(p.equity.reduce((n, x) => n + Number(x.amount ?? 0), 0))}</span></div>
                                </div>
                              )}
                            </div>
                            <div className="rounded-lg border border-border px-3 py-2.5 self-start">
                              <div className="lbl">Account today</div>
                              <div className={`font-ledger text-xl font-semibold mt-0.5 ${Number(pos?.balance ?? 0) < 0 ? "text-down" : ""}`}>{acct(pos?.balance ?? 0)}</div>
                              {/* One net figure with its two parts: a partner "owed nothing" may hold company cash against profit share. */}
                              <div className="mt-2 text-sm flex justify-between"><span className="text-muted-foreground">Profit share to date</span><span className="font-ledger">{acct(pos?.remuneration ?? 0)}</span></div>
                              <div className="text-sm flex justify-between"><span className="text-muted-foreground">Cash held / drawn (agency)</span><span className="font-ledger">{acct(-(pos?.agency ?? 0))}</span></div>
                              <p className="text-[11px] text-muted-foreground mt-2">The full ledger is under Statements.</p>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* Regions outside the partnership and their declared profit (0537). */}
            {companyId && (
              <PartnershipRegions companyId={companyId} month={firstOfMonth(period)} outputs={outputs}
                status={run.status} canDeclare={hasPermission(profile, "accounting.edit")}
                onDeclared={() => setNotice("Declared. Re-draft the month to include it.")} />
            )}
          </>
        )}
      </div>
    </>
  );
}
