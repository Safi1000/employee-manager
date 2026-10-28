import { useCallback, useEffect, useMemo, useState } from "react";
import PartnershipRegions from "../../components/PartnershipRegions";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, FileDown, FileText, Loader2, RotateCcw, Send,
} from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { supabase } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { usePageState } from "../../lib/pageState";
import { brandingFromCompany } from "../../lib/pdfBranding";
import { generatePartnerStatementPdf, generatePartnershipMonthPdf } from "../../lib/partnershipPdf";

/**
 * PARTNERSHIP (redesigned again 2026-10-26).
 *
 * One month, read as statements. What the page shows depends on who opens it,
 * and that is decided in the database, not here — partnership_month_view
 * (0557) returns only what the viewer may see:
 *   an equity partner, or office staff with accounting/reports access — the
 *     whole month: the total, every partner's statement, every region and client;
 *   a regional partner (Nauman Ahmed, ISB/RWP) — his own statement, his own
 *     region and its clients, and nothing company-wide.
 * profit_allocation_runs itself is closed to partner logins (0557), so this
 * screen never reads it for them.
 *
 * Managers (accounting.edit) additionally get the run's controls — draft,
 * check, post, reverse — which call the same RPCs as before:
 *   partnership_run_blocker, draft_profit_allocation, profit_allocation_review,
 *   partnership_uninvoiced_clients, post_profit_allocation,
 *   reverse_profit_allocation, partnership_posting_deadline.
 * Every figure is the run's own; nothing is recomputed here.
 */

type Viewer = { mode: "all" | "region" | "none"; can_manage: boolean; partner_ids: string[] | null };
type RunView = {
  id: string; status: "DRAFT" | "POSTED" | "REVERSED"; basis: string | null; posted_at: string | null; reversed_at: string | null;
  posted_by: string | null; entry_id: string | null; total_profit: number | null; regional_total: number | null;
  equity_total: number | null; unallocated: number | null;
};
type Region = {
  branch_id: string | null; region: string | null; own_profit: number; ho_allocated: number; base: number; regional: number;
  to_equity: number; regional_partners: { name: string; pct: number }[]; outside: boolean; declared: number | null;
  /** 0573: a declared region — the PRA GGS holds for it, and its profit client by client. */
  pra_held?: number | null; declared_clients?: DeclaredClient[] | null;
};
type DeclaredClient = { client: string; amount: number; pra_held: number };
type Partner = {
  partner_id: string; name: string; kind: "equity" | "regional"; region: string | null; pct: number | null; amount: number;
  clients: { client_id: string; client: string | null; net: number; pct: number; share: number }[];
  equity_regions: { region: string | null; amount: number; pct: number | null }[];
  drawings_month: number; profit_month: number; closing_balance: number;
};
type ClientRow = { client_id: string | null; client: string; branch_id: string | null; region: string | null; revenue: number; cost: number; overhead: number; net: number };
type MonthView = {
  viewer: Viewer; month: string; run: RunView | null; regions: Region[]; partners: Partner[]; clients: ClientRow[];
  months: { month: string; status: string; amount: number | null }[];
};

type ReviewRow = { kind: string; subject: string; subject_id: string | null; amount: number; detail: string };
type Uninvoiced = { client_id: string; client_code: string; client_name: string; contract_code: string | null; region_name: string | null; reason: string };
type Deadline = { period_month: string; due_date: string; posted: boolean; days_late: number };

const money = (n: number | null | undefined) => Math.round(Number(n ?? 0)).toLocaleString();
/** Accounting negatives, because a partner's share can legitimately be one (A9). */
const acct = (n: number | null | undefined) => (Number(n ?? 0) < 0 ? `(${money(Math.abs(Number(n ?? 0)))})` : money(n));
const neg = (n: number | null | undefined) => (Number(n ?? 0) < 0 ? "text-down" : "");
const firstOfMonth = (p: string) => `${p}-01`;
const monthName = (p: string) => new Date(`${p}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
const shortMonth = (p: string) => new Date(`${p}-01T00:00:00`).toLocaleDateString(undefined, { month: "short" });
const shortDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const shift = (p: string, by: number) => {
  const d = new Date(`${p}-01T00:00:00`); d.setMonth(d.getMonth() + by);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

/** Segment tones for the split bar, in partner order. */
const SPLIT = ["bg-brand-500", "bg-up", "bg-heed", "bg-brand-500/50", "bg-up/50", "bg-heed/50"];

const REVIEW_KINDS: Record<string, { title: string; note: string }> = {
  client_cost_no_invoice: { title: "Cost booked, nothing billed", note: "Their cost is in the pool and their revenue is not, so every partner's share is understated." },
  client_negative_net: { title: "Clients net negative for the month", note: "Not necessarily wrong — a month of costs against a client billed elsewhere looks like this." },
  unallocated_pool: { title: "A pool reached no region", note: "Head office cost with no revenue base to apportion it against. It is sitting unallocated." },
  partner_negative_total: { title: "A partner's total is negative", note: "A9 permits this with no floor; it reduces the partner's capital account." },
};

export default function PartnershipRun() {
  const { profile, company } = useAuth();
  const companyId = profile?.view_as_company ?? profile?.company_id ?? null;
  const canPost = hasPermission(profile, "partnership.post");

  const [period, setPeriod] = usePageState("PartnershipRun.period", shift(thisMonth(), -1));
  const [view, setView] = useState<MonthView | null>(null);
  const [rawOutputs, setRawOutputs] = useState<Parameters<typeof PartnershipRegions>[0]["outputs"]>([]);
  const [blocker, setBlocker] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewRow[]>([]);
  const [uninvoiced, setUninvoiced] = useState<Uninvoiced[]>([]);
  const [deadline, setDeadline] = useState<Deadline | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "draft" | "post" | "reverse">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const [openRegion, setOpenRegion] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true); setError(null);
    const month = firstOfMonth(period);
    const { data, error: e } = await supabase.rpc("partnership_month_view", { p_company_id: companyId, p_period: month });
    if (e) { setLoading(false); setView(null); setError(e.message); return; }
    const v = data as MonthView;
    setView(v);
    // The controls, and what they need, are for managers only.
    if (v.viewer.can_manage) {
      const [blockRes, revRes, uninvRes, dueRes, outRes] = await Promise.all([
        supabase.rpc("partnership_run_blocker", { p_company_id: companyId, p_period: month }),
        supabase.rpc("profit_allocation_review", { p_company_id: companyId, p_period: month }),
        supabase.rpc("partnership_uninvoiced_clients", { p_company_id: companyId, p_period: month }),
        supabase.rpc("partnership_posting_deadline", { p_company_id: companyId, p_period: month }),
        supabase.from("profit_allocation_runs").select("outputs").eq("company_id", companyId).eq("period_month", month).maybeSingle(),
      ]);
      setBlocker((blockRes.data ?? null) as string | null);
      setReview((revRes.data ?? []) as ReviewRow[]);
      setUninvoiced((uninvRes.data ?? []) as Uninvoiced[]);
      setDeadline(((dueRes.data ?? []) as Deadline[])[0] ?? null);
      setRawOutputs(((outRes.data as { outputs: typeof rawOutputs | null } | null)?.outputs) ?? []);
    }
    setLoading(false);
  }, [companyId, period]);
  useEffect(() => { void load(); setOpenCheck(null); setOpenRegion(null); }, [load]);

  const run = view?.run ?? null;
  const live = run && run.status !== "REVERSED";
  const isAll = view?.viewer.mode === "all";
  const manage = !!view?.viewer.can_manage;
  const partners = useMemo(() => [...(view?.partners ?? [])].sort((a, b) => b.amount - a.amount), [view]);
  const regions = view?.regions ?? [];
  const clients = view?.clients ?? [];
  const myShare = partners.reduce((n, p) => n + Number(p.amount), 0);

  const statusLine = !run ? "Not drafted"
    : run.status === "DRAFT" ? "Draft — not final"
    : run.status === "POSTED" ? `Posted${run.posted_at ? ` ${shortDate(run.posted_at)}` : ""}${run.posted_by ? ` · ${run.posted_by}` : ""}`
    : `Reversed${run.reversed_at ? ` ${shortDate(run.reversed_at)}` : ""}`;
  const statusTone = run?.status === "POSTED" ? "bg-up/10 text-up border-up/40"
    : run?.status === "DRAFT" ? "bg-heed/10 text-heed border-heed/40"
    : "bg-muted text-muted-foreground border-border";

  const branding = brandingFromCompany(company);
  const partnerPdf = (p: Partner) => generatePartnerStatementPdf({ branding, monthLabel: monthName(period), status: statusLine, partner: p, regions });
  const monthPdf = () => generatePartnershipMonthPdf({
    branding, monthLabel: monthName(period), status: statusLine, total: isAll ? run?.total_profit ?? null : null,
    partners, regions: regions.map((r) => ({ ...r })), clients,
  });

  // ── manager actions ──
  const draft = async () => {
    if (!companyId) return;
    setBusy("draft"); setError(null); setNotice(null);
    const { error: e } = await supabase.rpc("draft_profit_allocation", { p_company_id: companyId, p_period: firstOfMonth(period), p_basis: null });
    setBusy(null);
    if (e) { setError(e.message); return; }
    setNotice(`${monthName(period)} is drafted. Nothing has been posted — check it, then post.`);
    await load();
  };
  const post = async (confirmIncomplete = false): Promise<void> => {
    if (!run) return;
    setBusy("post"); setError(null); setNotice(null);
    const { error: e } = await supabase.rpc("post_profit_allocation", { p_run_id: run.id, p_confirm_incomplete: confirmIncomplete });
    setBusy(null);
    if (e) {
      // 0361 raises the completeness gate as a CONFIRMATION marked with this
      // hint: the first call names the clients, the second proceeds.
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
    if (!window.confirm(`Reverse the posted run for ${monthName(period)}?\n\nThis unwinds the journal entry and every partner's share for the month.`)) return;
    setBusy("reverse"); setError(null); setNotice(null);
    const { error: e } = await supabase.rpc("reverse_profit_allocation", { p_run_id: run.id });
    setBusy(null);
    if (e) { setError(e.message); return; }
    setNotice(`${monthName(period)} is reversed. Re-draft it when the source data is right.`);
    await load();
  };

  type Check = { key: string; ok: boolean; title: string; sub: string; body?: React.ReactNode };
  const reviewByKind = new Map<string, ReviewRow[]>();
  for (const r of review) reviewByKind.set(r.kind, [...(reviewByKind.get(r.kind) ?? []), r]);
  const checks: Check[] = [
    { key: "draftable", ok: !blocker, title: blocker ? "This month can't be drafted yet" : "The month can be drafted", sub: blocker ?? "Nothing stands in the way." },
    {
      key: "billed", ok: uninvoiced.length === 0,
      title: uninvoiced.length ? `${uninvoiced.length} client${uninvoiced.length === 1 ? "" : "s"} live but never billed` : "Every live client is billed",
      sub: uninvoiced.length ? "Their cost is in the pool and their revenue is not. Posting will ask you to confirm." : `Every client with a live contract has an invoice for ${monthName(period)}.`,
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
      key: kind, ok: false, title: `${REVIEW_KINDS[kind]?.title ?? kind} · ${rows.length}`, sub: REVIEW_KINDS[kind]?.note ?? "",
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

  const months = useMemo(() => {
    const m = new Map((view?.months ?? []).map((x) => [x.month.slice(0, 7), x]));
    const out: string[] = [];
    for (let i = 11; i >= 0; i--) out.push(shift(thisMonth(), -i));
    return out.map((p) => ({ p, row: m.get(p) }));
  }, [view]);

  const subtitle = view?.viewer.mode === "region"
    ? `Your region and your share — ${partners.map((p) => p.region).filter(Boolean).join(", ")}`
    : "Each month's profit, who it goes to, and where it came from";

  return (
    <>
      <Header
        title="Partnership"
        subtitle={subtitle}
        actions={
          <div className="flex items-center gap-2">
            {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            {live && partners.length > 0 && (
              <Button variant="ghost" onClick={monthPdf}><FileDown className="w-4 h-4" /> Month PDF</Button>
            )}
          </div>
        }
      >
        {/* The year: one chip per month, its state and (for this viewer) its figure. */}
        <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-12 gap-1.5">
          {months.map(({ p, row }) => {
            const tone = row?.status === "POSTED" ? "border-up/50 bg-up/10" : row?.status === "DRAFT" ? "border-heed/50 bg-heed/10" : row?.status === "REVERSED" ? "border-down/40 bg-down/10" : "border-border bg-card";
            return (
              <button key={p} type="button" onClick={() => setPeriod(p)}
                className={`rounded-xl border px-2 py-1.5 text-left transition-colors ${tone} ${p === period ? "ring-2 ring-brand-500" : "hover:border-brand-500/60"}`}>
                <span className="block text-[11px] font-semibold text-foreground">{shortMonth(p)}</span>
                <span className="block font-ledger text-[11px] text-muted-foreground truncate">
                  {row?.amount != null && row.status !== "REVERSED" ? acct(row.amount) : row ? row.status.toLowerCase() : "—"}
                </span>
              </button>
            );
          })}
        </div>
      </Header>

      <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8 space-y-5">
        {error && (
          <div className="bg-danger-50 border border-danger-200 rounded-lg px-4 py-3">
            <pre className="text-sm text-danger-700 whitespace-pre-wrap font-sans">{error}</pre>
          </div>
        )}
        {notice && <div className="bg-success-50 border border-success-200 rounded-lg px-4 py-3 text-sm text-success-700">{notice}</div>}

        {view?.viewer.mode === "none" && (
          <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            Your login isn&rsquo;t linked to a partner, so there is nothing here for you to see.
          </div>
        )}

        {view && view.viewer.mode !== "none" && (
          <>
            {/* ── The month ───────────────────────────────────────────────── */}
            <section className="rounded-2xl border border-border bg-card overflow-hidden">
              <div className="px-5 pt-4 pb-3 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1">
                  <button type="button" aria-label="Previous month" onClick={() => setPeriod(shift(period, -1))} className="p-1.5 rounded-lg hover:bg-muted"><ChevronLeft className="w-4 h-4" /></button>
                  <h2 className="font-display text-2xl font-bold tracking-tight text-foreground min-w-[11rem] text-center">{monthName(period)}</h2>
                  <button type="button" aria-label="Next month" disabled={period >= thisMonth()} onClick={() => setPeriod(shift(period, 1))} className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
                </div>
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${statusTone}`}>{statusLine}</span>
                {manage && run?.status !== "POSTED" && deadline && (
                  <span className="text-xs text-muted-foreground">
                    Due {shortDate(deadline.due_date)}{deadline.days_late > 0 && !deadline.posted ? <span className="text-down font-semibold"> · {deadline.days_late} days late</span> : null}
                  </span>
                )}
                {manage && (
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {run?.status !== "POSTED" && (
                      <Button variant={run?.status === "DRAFT" ? "secondary" : "primary"} disabled={busy !== null || !!blocker} onClick={draft}>
                        {busy === "draft" ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                        {run?.status === "DRAFT" ? "Re-draft" : "Draft this month"}
                      </Button>
                    )}
                    {run?.status === "DRAFT" && (
                      <Button variant="primary" disabled={busy !== null || !canPost} onClick={() => void post(false)}
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
                )}
              </div>

              {live && (
                <div className="px-5 pb-5">
                  <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
                    <div>
                      <span className="lbl">{isAll ? "Profit divided" : partners.length === 1 ? "Your share this month" : "Your shares this month"}</span>
                      <div className={`font-ledger text-3xl font-bold mt-0.5 ${neg(isAll ? run.total_profit : myShare)}`}>
                        <span className="cur">PKR</span>{acct(isAll ? run.total_profit : myShare)}
                      </div>
                    </div>
                    {isAll && (
                      <>
                        <div><span className="lbl">To regional partners</span><div className="font-ledger text-lg font-semibold">{acct(run.regional_total)}</div></div>
                        <div><span className="lbl">To equity</span><div className="font-ledger text-lg font-semibold">{acct(run.equity_total)}</div></div>
                        {Number(run.unallocated ?? 0) !== 0 && <div><span className="lbl">Unallocated</span><div className="font-ledger text-lg font-semibold text-heed">{acct(run.unallocated)}</div></div>}
                      </>
                    )}
                  </div>
                  {/* The split: each partner's part of the month, only where every part is positive. */}
                  {isAll && partners.length > 1 && partners.every((p) => p.amount > 0) && (
                    <div className="mt-4">
                      <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
                        {partners.map((p, i) => <div key={p.partner_id} className={SPLIT[i % SPLIT.length]} style={{ width: `${(p.amount / myShare) * 100}%` }} title={`${p.name} ${acct(p.amount)}`} />)}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                        {partners.map((p, i) => (
                          <span key={p.partner_id} className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${SPLIT[i % SPLIT.length]}`} />
                            {p.name} <span className="font-ledger text-foreground">{Math.round((p.amount / myShare) * 100)}%</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* ── Before posting (managers) ───────────────────────────────── */}
            {manage && run?.status !== "POSTED" && (
              <section className="rounded-2xl border border-border bg-card overflow-hidden">
                <div className="px-5 py-3 border-b border-border flex items-center gap-2">
                  <h3 className="font-display text-base font-bold tracking-tight text-foreground">Before posting</h3>
                  <span className={`ml-auto text-xs font-semibold ${openIssues ? "text-heed" : "text-up"}`}>{openIssues ? `${openIssues} to look at` : "all clear"}</span>
                </div>
                <ul className="divide-y divide-border">
                  {checks.map((c) => {
                    const open = openCheck === c.key;
                    return (
                      <li key={c.key} className="px-5 py-2.5">
                        <button type="button" disabled={!c.body} onClick={() => setOpenCheck(open ? null : c.key)} className="w-full flex items-start gap-3 text-left">
                          {c.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-up flex-shrink-0" /> : <CircleAlert className="w-4 h-4 mt-0.5 text-heed flex-shrink-0" />}
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

            {!live && !loading && (
              <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                {manage && blocker
                  ? <><AlertTriangle className="w-4 h-4 inline mr-1 text-heed" />{blocker}</>
                  : run?.status === "REVERSED"
                    ? <>{monthName(period)} was reversed. {manage ? "Re-draft it when the source data is right." : "It will appear here once it is posted again."}</>
                    : <>{monthName(period)} hasn&rsquo;t been drafted yet.{manage ? " Draft it to see who gets what — nothing reaches the ledger until it is posted." : ""}</>}
              </div>
            )}

            {live && (
              <>
                {/* ── Statements: one card per partner the viewer may see ──── */}
                <section>
                  <h3 className="font-display text-base font-bold tracking-tight text-foreground mb-2 px-1">
                    {isAll ? "Each partner's statement" : "Your statement"}
                  </h3>
                  <div className={`grid gap-4 ${partners.length > 1 ? "lg:grid-cols-2" : ""}`}>
                    {partners.map((p) => {
                      const clientSum = p.clients.reduce((n, c) => n + Number(c.share), 0);
                      const lines = [...p.clients].filter((c) => Number(c.net) !== 0).sort((a, b) => b.share - a.share);
                      return (
                        <article key={p.partner_id} className="rounded-2xl border border-border bg-card overflow-hidden flex flex-col">
                          <div className="px-5 py-4 flex items-start gap-3 border-b border-border">
                            <div className="min-w-0">
                              <div className="font-display text-lg font-bold text-foreground">{p.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {p.kind === "regional" ? `Regional partner · ${p.region ?? ""} · ${p.pct ?? ""}% of each client` : `Equity partner · ${p.pct ?? ""}% of what every region leaves`}
                              </div>
                            </div>
                            <div className="ml-auto text-right">
                              <span className="lbl">Share</span>
                              <div className={`font-ledger text-2xl font-bold ${neg(p.amount)}`}>{acct(p.amount)}</div>
                            </div>
                          </div>

                          <div className="px-5 py-3 flex-1">
                            {p.kind === "regional" ? (
                              <>
                                <ul className="divide-y divide-border text-sm max-h-80 overflow-y-auto">
                                  {lines.map((c) => (
                                    <li key={c.client_id} className="py-1.5 flex justify-between gap-3">
                                      <span className="truncate">{c.client ?? "Client"} <span className="text-[11px] text-muted-foreground">· {c.pct}% of {acct(c.net)}</span></span>
                                      <span className={`font-ledger ${neg(c.share)}`}>{acct(c.share)}</span>
                                    </li>
                                  ))}
                                </ul>
                                <div className="mt-1 pt-1.5 border-t border-border text-sm flex justify-between">
                                  <span className="text-muted-foreground">Head office and region adjustments</span>
                                  <span className={`font-ledger ${neg(p.amount - clientSum)}`}>{acct(p.amount - clientSum)}</span>
                                </div>
                              </>
                            ) : (
                              <ul className="divide-y divide-border text-sm">
                                {p.equity_regions.map((e) => {
                                  // 0573: a declared region shows, beside the partner's profit,
                                  // what GGS kept for it including the PRA it holds — and the
                                  // profit client by client. The partner's part of each is his
                                  // share of the region's declared total.
                                  const rg = regions.find((r) => r.region === e.region && r.outside && r.declared);
                                  const f = rg && rg.declared ? e.amount / rg.declared : 0;
                                  const pra = rg ? Number(rg.pra_held ?? 0) * f : 0;
                                  return (
                                    <li key={e.region ?? ""} className="py-1.5">
                                      <div className="flex justify-between gap-3">
                                        <span>{e.region ?? "—"}{rg ? <span className="ml-1.5 text-[11px] text-muted-foreground">declared</span> : null}</span>
                                        <span className="flex items-baseline gap-4">
                                          {pra > 0.5 && <span className="text-[11px] text-muted-foreground">kept by GGS incl. PRA <span className="font-ledger text-foreground">{acct(e.amount + pra)}</span></span>}
                                          <span className={`font-ledger ${neg(e.amount)}`}>{acct(e.amount)}</span>
                                        </span>
                                      </div>
                                      {rg?.declared_clients?.length ? (
                                        <ul className="mt-1 ml-3 text-xs text-muted-foreground space-y-0.5">
                                          {rg.declared_clients.map((c) => (
                                            <li key={c.client} className="flex justify-between gap-3">
                                              <span>{c.client}</span>
                                              <span className="flex gap-4">
                                                {Number(c.pra_held) > 0 && <span>PRA held <span className="font-ledger">{acct(Number(c.pra_held) * f)}</span></span>}
                                                <span className="font-ledger text-foreground">{acct(Number(c.amount) * f)}</span>
                                              </span>
                                            </li>
                                          ))}
                                        </ul>
                                      ) : null}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </div>

                          <div className="px-5 py-3 border-t border-border bg-muted/30 grid grid-cols-3 gap-3 items-end">
                            <div><span className="lbl">Drawn this month</span><div className="font-ledger text-sm font-semibold">{acct(-p.drawings_month)}</div></div>
                            <div><span className="lbl">Closing balance</span><div className={`font-ledger text-sm font-semibold ${neg(p.closing_balance)}`}>{acct(p.closing_balance)}</div></div>
                            <div className="text-right">
                              <Button variant="ghost" onClick={() => partnerPdf(p)}><FileDown className="w-4 h-4" /> PDF</Button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>

                {/* ── Where it came from: region → clients ──────────────────── */}
                {regions.length > 0 && (
                  <section className="rounded-2xl border border-border bg-card overflow-hidden">
                    <div className="px-5 py-3 border-b border-border">
                      <h3 className="font-display text-base font-bold tracking-tight text-foreground">{isAll ? "Profit by region" : "Your region"}</h3>
                      <p className="text-xs text-muted-foreground">Open a region for its clients: revenue, less direct cost, less overhead, is the client&rsquo;s net.</p>
                    </div>
                    <ul className="divide-y divide-border">
                      {regions.map((r) => {
                        const key = r.branch_id ?? r.region ?? "";
                        const open = openRegion === key;
                        const rc = clients.filter((c) => c.branch_id === r.branch_id).sort((a, b) => b.net - a.net);
                        return (
                          <li key={key}>
                            <button type="button" onClick={() => setOpenRegion(open ? null : key)} className="w-full px-5 py-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-left hover:bg-muted/30">
                              {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                              <span className="font-medium text-foreground min-w-[8rem]">
                                {r.region ?? "—"}
                                {r.outside && <span className="ml-2 text-[11px] font-normal text-muted-foreground">outside the partnership{r.declared != null ? ` · declared ${acct(r.declared)}` : ""}{Number(r.pra_held ?? 0) > 0 ? ` · kept by GGS incl. PRA ${acct(Number(r.declared ?? 0) + Number(r.pra_held))}` : ""}</span>}
                              </span>
                              <span className="text-xs text-muted-foreground">Own <span className={`font-ledger text-foreground ${neg(r.own_profit)}`}>{acct(r.own_profit)}</span></span>
                              <span className="text-xs text-muted-foreground">Head office <span className="font-ledger text-foreground">{acct(r.ho_allocated)}</span></span>
                              {r.regional_partners.length > 0 && (
                                <span className="text-xs text-muted-foreground">{r.regional_partners.map((x) => `${x.name} ${x.pct}%`).join(", ")} <span className="font-ledger text-foreground">{acct(r.regional)}</span></span>
                              )}
                              <span className="ml-auto text-xs text-muted-foreground">To equity <span className={`font-ledger text-base font-semibold text-foreground ${neg(r.to_equity)}`}>{acct(r.to_equity)}</span></span>
                            </button>
                            {open && (
                              <div className="px-5 pb-4 overflow-x-auto">
                                {r.declared_clients?.length ? (
                                  // 0573: what the regional partner's statement declared, client by client.
                                  <table className="w-full text-sm mb-4">
                                    <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                      <tr>
                                        <th className="text-left py-1.5 font-medium">Declared — client</th>
                                        <th className="text-right py-1.5 font-medium">GGS profit</th>
                                        <th className="text-right py-1.5 font-medium">PRA held</th>
                                        <th className="text-right py-1.5 font-medium">Kept by GGS</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border">
                                      {r.declared_clients.map((c) => (
                                        <tr key={c.client}>
                                          <td className="py-1.5 pr-3 text-foreground">{c.client}</td>
                                          <td className="py-1.5 text-right font-ledger font-semibold">{acct(Number(c.amount))}</td>
                                          <td className="py-1.5 text-right font-ledger text-muted-foreground">{acct(Number(c.pra_held))}</td>
                                          <td className="py-1.5 text-right font-ledger">{acct(Number(c.amount) + Number(c.pra_held))}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                ) : null}
                                <table className="w-full text-sm">
                                  <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                    <tr>
                                      <th className="text-left py-1.5 font-medium">Client</th>
                                      <th className="text-right py-1.5 font-medium">Revenue</th>
                                      <th className="text-right py-1.5 font-medium">Direct cost</th>
                                      <th className="text-right py-1.5 font-medium">Overhead</th>
                                      <th className="text-right py-1.5 font-medium">Net</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border">
                                    {rc.map((c) => (
                                      <tr key={c.client_id ?? c.client}>
                                        <td className="py-1.5 pr-3 text-foreground">{c.client}</td>
                                        <td className="py-1.5 text-right font-ledger">{acct(c.revenue)}</td>
                                        <td className="py-1.5 text-right font-ledger text-muted-foreground">{acct(c.cost)}</td>
                                        <td className="py-1.5 text-right font-ledger text-muted-foreground">{acct(c.overhead)}</td>
                                        <td className={`py-1.5 text-right font-ledger font-semibold ${neg(c.net)}`}>{acct(c.net)}</td>
                                      </tr>
                                    ))}
                                    {rc.length === 0 && <tr><td colSpan={5} className="py-2 text-xs text-muted-foreground">No client lines for this region this month.</td></tr>}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}

                {/* Regions outside the partnership and their declared profit (0537) — managers. */}
                {manage && companyId && (
                  <PartnershipRegions companyId={companyId} month={firstOfMonth(period)} outputs={rawOutputs}
                    status={run.status} canDeclare={hasPermission(profile, "accounting.edit")}
                    onDeclared={() => setNotice("Declared. Re-draft the month to include it.")} />
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
