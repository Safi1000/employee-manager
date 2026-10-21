import ThemedSelect from "../../components/ThemedSelect";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, ArrowRight, CalendarClock, Plus } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { useRegion, withRegionOrUnassigned } from "../../lib/region";
import { formatDate } from "../../lib/date";

// Contract renewal pipeline — re-homed here (Compliance ▸ Licenses & Renewals)
// when the Client Relationships panel was dissolved. Same renewal_pipeline table.
//
// Rebuilt 2026-10-21 as a board: the band counts each stage (tap to filter)
// and lists the live contracts ending in the next 90 days that nobody has put
// in the pipeline yet, one tap to add. Every write is the one this page always
// made — an insert, or a stage update on one row.

const FIELD =
  "px-3 py-2 border border-border rounded-xl text-sm bg-card focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-transparent";
const RENEWAL_STAGES = ["not_started", "contacted", "negotiating", "renewed", "lost"] as const;
type Stage = (typeof RENEWAL_STAGES)[number];
const STAGE_LABEL: Record<Stage, string> = {
  not_started: "Not started", contacted: "Contacted", negotiating: "Negotiating", renewed: "Renewed", lost: "Lost",
};
const STAGE_TONE: Record<Stage, string> = {
  not_started: "text-muted-foreground", contacted: "text-calm", negotiating: "text-heed", renewed: "text-up", lost: "text-down",
};
// The same stages on the paper board (the band's soft tones are for ink).
const BOARD_TONE: Record<Stage, string> = {
  not_started: "text-muted-foreground", contacted: "text-info-700 dark:text-info-500", negotiating: "text-warning-700 dark:text-warning-500",
  renewed: "text-success-700 dark:text-success-500", lost: "text-danger-700 dark:text-danger-500",
};
const OPEN: Stage[] = ["not_started", "contacted", "negotiating"];

type Renewal = { id: string; client_id: string; stage: Stage; expected_close_date: string | null; owner_id: string | null; notes: string | null; updated_at: string | null; created_at: string | null };
const STALE_DAYS = 14;
type Ending = { id: string; client_id: string; contract_code: string | null; end_date: string };

const daysTo = (iso: string) => Math.round((new Date(iso).getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);

export default function ContractRenewals() {
  const { company } = useAuth();
  const { regionId } = useRegion();
  const companyId = company?.id ?? "";
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [renewals, setRenewals] = useState<Renewal[]>([]);
  const [ending, setEnding] = useState<Ending[]>([]);
  const [stageFilter, setStageFilter] = useState<Stage | "all">("all");
  const [liveContract, setLiveContract] = useState<Map<string, string>>(new Map());
  const [people, setPeople] = useState<{ id: string; full_name: string | null; email: string | null }[]>([]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const horizon = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    const [cl, rn, ct, live] = await Promise.all([
      withRegionOrUnassigned(supabase.from("clients").select("id,name").eq("company_id", companyId), regionId).order("name"),
      supabase.from("renewal_pipeline").select("id, client_id, stage, expected_close_date, owner_id, notes, updated_at, created_at").eq("company_id", companyId).order("expected_close_date"),
      supabase.from("contracts").select("id, client_id, contract_code, end_date")
        .eq("company_id", companyId).eq("status", "active").eq("is_infinite", false)
        .not("end_date", "is", null).lte("end_date", horizon).order("end_date"),
      // Each client's live contract, for "Renew the contract" on a Renewed card.
      supabase.from("contracts").select("id, client_id, end_date").eq("company_id", companyId).eq("status", "active").order("end_date", { ascending: false }),
    ]);
    const err0 = cl.error ?? rn.error ?? ct.error;
    if (err0) setErr(err0.message);
    setClients((cl.data ?? []) as { id: string; name: string }[]);
    setRenewals((rn.data ?? []) as Renewal[]);
    setEnding((ct.data ?? []) as Ending[]);
    const lc = new Map<string, string>();
    for (const k of ((live.data ?? []) as { id: string; client_id: string }[])) if (!lc.has(k.client_id)) lc.set(k.client_id, k.id);
    setLiveContract(lc);
    const { data: pr } = await supabase.from("profiles").select("id, full_name, email").eq("company_id", companyId).order("full_name");
    setPeople((pr ?? []) as { id: string; full_name: string | null; email: string | null }[]);
    setLoaded(true);
  }, [companyId, regionId]);
  useEffect(() => { load(); }, [load]);

  const run = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setErr(null);
    const { error } = await p;
    setBusy(false);
    if (error) { setErr(error.message); return false; }
    await load();
    return true;
  };

  const clientName = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
  // The region narrows the clients; the board shows only their renewals.
  const shown = useMemo(() => renewals.filter((r) => clientName.has(r.client_id)), [renewals, clientName]);
  const inPipeline = useMemo(() => new Set(shown.filter((r) => OPEN.includes(r.stage)).map((r) => r.client_id)), [shown]);
  const unclaimed = useMemo(() => ending.filter((c) => clientName.has(c.client_id) && !inPipeline.has(c.client_id)), [ending, clientName, inPipeline]);
  const count = (s: Stage) => shown.filter((r) => r.stage === s).length;
  const dueSoon = shown.filter((r) => OPEN.includes(r.stage) && r.expected_close_date && daysTo(r.expected_close_date) <= 30).length;
  const closed = count("renewed") + count("lost");
  const winRate = closed ? Math.round((count("renewed") / closed) * 100) : null;

  const [rnClient, setRnClient] = useState("");
  const [rnDate, setRnDate] = useState("");

  const addRenewal = async (clientId = rnClient, date = rnDate) => {
    if (!clientId) return;
    const ok = await run(supabase.from("renewal_pipeline").insert({
      company_id: companyId, client_id: clientId, stage: "not_started",
      expected_close_date: date || null,
    }));
    if (ok) { setRnClient(""); setRnDate(""); }
  };
  const move = (r: Renewal, dir: -1 | 1) => {
    const next = RENEWAL_STAGES[RENEWAL_STAGES.indexOf(r.stage) + dir];
    if (next) void run(supabase.from("renewal_pipeline").update({ stage: next, updated_at: new Date().toISOString() }).eq("id", r.id));
  };

  const columns = stageFilter === "all" ? [...RENEWAL_STAGES] : [stageFilter];

  return (
    <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
      <Header title="Contract Renewals" subtitle="Every renewal from first call to signed — and the contracts ending soon that nobody has picked up">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {RENEWAL_STAGES.map((s) => (
              <button key={s} type="button" onClick={() => setStageFilter(stageFilter === s ? "all" : s)}
                className={`text-left rounded-[14px] border bg-card px-4 py-3 flex flex-col gap-1 transition-colors ${stageFilter === s ? "border-brand-500" : "border-border hover:border-brand-500/60"}`}>
                <span className="lbl">{STAGE_LABEL[s]}</span>
                <span className={`font-ledger text-2xl font-semibold leading-none ${STAGE_TONE[s]}`}>{loaded ? count(s) : "…"}</span>
              </button>
            ))}
            <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
              <span className="lbl">Kept</span>
              <span className="font-ledger text-2xl font-semibold leading-none">{winRate == null ? "—" : `${winRate}%`}</span>
              <span className="text-xs text-muted-foreground">{closed ? `${count("renewed")} of ${closed} decided` : "none decided yet"}</span>
            </div>
          </div>
          <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="lbl flex items-center gap-1.5"><CalendarClock className="w-3.5 h-3.5" /> Ending in 90 days, not in the pipeline</span>
              <span className="text-xs text-muted-foreground">{dueSoon ? `${dueSoon} open renewal${dueSoon === 1 ? "" : "s"} due to close within 30 days` : "no open renewal is due within 30 days"}{(() => { const n = shown.filter((r) => OPEN.includes(r.stage) && (r.updated_at ?? r.created_at) && -daysTo((r.updated_at ?? r.created_at)!.slice(0, 10)) >= STALE_DAYS).length; return n ? ` · ${n} untouched for two weeks` : ""; })()}</span>
            </div>
            {!loaded ? (
              <span className="text-sm text-muted-foreground">Reading contracts…</span>
            ) : unclaimed.length === 0 ? (
              <span className="text-sm text-up">Every contract ending in the next 90 days is already being worked.</span>
            ) : (
              <div className="flex flex-wrap gap-2">
                {unclaimed.map((c) => {
                  const d = daysTo(c.end_date);
                  return (
                    <button key={c.id} type="button" disabled={busy} onClick={() => addRenewal(c.client_id, c.end_date)}
                      title="Add to the pipeline, closing on the contract's end date"
                      className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs hover:border-brand-500/60 disabled:opacity-50">
                      <Plus className="w-3 h-3" />
                      <span className="text-foreground font-medium">{clientName.get(c.client_id)}</span>
                      <span className={d < 0 ? "text-down" : d <= 30 ? "text-heed" : "text-muted-foreground"}>{d < 0 ? `ended ${-d}d ago` : `${d}d left`}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Header>
      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      <div className="space-y-4">
        <section className="bg-card border border-border rounded-2xl p-4 flex items-end gap-3 flex-wrap">
          <div>
            <label className="lbl block mb-1">Client</label>
            <ThemedSelect className={FIELD} value={rnClient} onChange={(e) => setRnClient(e.target.value)}>
              <option value="">— client —</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </ThemedSelect>
          </div>
          <div>
            <label className="lbl block mb-1">Expected close</label>
            <input type="date" className={FIELD} value={rnDate} onChange={(e) => setRnDate(e.target.value)} />
          </div>
          <Button variant="primary" size="sm" disabled={busy || !rnClient} onClick={() => addRenewal()}>Add to pipeline</Button>
          {stageFilter !== "all" && (
            <button type="button" onClick={() => setStageFilter("all")} className="ml-auto text-xs text-muted-foreground hover:text-foreground underline">Show every stage</button>
          )}
        </section>

        <div className={`grid gap-3 ${columns.length === 1 ? "grid-cols-1" : "grid-cols-1 md:grid-cols-3 xl:grid-cols-5"}`}>
          {columns.map((s) => {
            const items = shown.filter((r) => r.stage === s);
            return (
              <section key={s} className="bg-muted/50 border border-border rounded-2xl p-2.5 flex flex-col gap-2 min-h-32">
                <div className="flex items-center justify-between px-1.5 pt-1">
                  <span className={`text-sm font-semibold ${BOARD_TONE[s]}`}>{STAGE_LABEL[s]}</span>
                  <span className="text-xs text-muted-foreground font-ledger">{items.length}</span>
                </div>
                {items.length === 0 && <p className="px-1.5 pb-2 text-xs text-muted-foreground">{s === "not_started" ? "Add a client above, or tap a contract ending soon." : "Nothing here."}</p>}
                {items.map((r) => {
                  const d = r.expected_close_date ? daysTo(r.expected_close_date) : null;
                  const i = RENEWAL_STAGES.indexOf(r.stage);
                  const lastMove = r.updated_at ?? r.created_at;
                  const idle = lastMove ? -daysTo(lastMove.slice(0, 10)) : null;
                  const stale = OPEN.includes(r.stage) && idle != null && idle >= STALE_DAYS;
                  return (
                    <article key={r.id} className="bg-card border border-border rounded-xl px-3 py-2.5 flex flex-col gap-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">{clientName.get(r.client_id)}</span>
                        {stale && <span className="flex-shrink-0 rounded-full bg-warning-50 text-warning-700 dark:text-warning-500 px-2 py-0.5 text-[10px] font-semibold" title="No change to this card for two weeks">{idle}d idle</span>}
                      </div>
                      <span className={`text-xs ${d == null ? "text-muted-foreground" : OPEN.includes(r.stage) && d < 0 ? "text-danger-600" : OPEN.includes(r.stage) && d <= 30 ? "text-warning-700 dark:text-warning-500" : "text-muted-foreground"}`}>
                        {r.expected_close_date ? `Close ${formatDate(r.expected_close_date)}${OPEN.includes(r.stage) ? ` · ${d! < 0 ? `${-d!}d overdue` : `${d}d`}` : ""}` : "No close date"}
                      </span>
                      <select
                        value={r.owner_id ?? ""}
                        onChange={(e) => run(supabase.from("renewal_pipeline").update({ owner_id: e.target.value || null, updated_at: new Date().toISOString() }).eq("id", r.id))}
                        aria-label="Owner"
                        className="w-full px-2 py-1 border border-border rounded-lg bg-card text-xs text-foreground"
                      >
                        <option value="">No owner yet</option>
                        {people.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
                      </select>
                      <input
                        defaultValue={r.notes ?? ""}
                        placeholder="Next step — e.g. send revised rates Friday"
                        aria-label="Next step"
                        onBlur={(e) => { const v = e.target.value.trim(); if (v !== (r.notes ?? "")) void run(supabase.from("renewal_pipeline").update({ notes: v || null, updated_at: new Date().toISOString() }).eq("id", r.id)); }}
                        className="w-full px-2 py-1 border border-border rounded-lg bg-card text-xs text-foreground placeholder:text-muted-foreground"
                      />
                      {r.stage === "renewed" && liveContract.get(r.client_id) && (
                        <Link to={`/super-admin/contracts?renew=${liveContract.get(r.client_id)}`}
                          className="rounded-lg bg-brand-500/15 text-brand-700 dark:text-brand-500 px-2.5 py-1.5 text-xs font-semibold text-center hover:bg-brand-500/25">
                          Renew the contract → carries its lines over
                        </Link>
                      )}
                      <div className="flex items-center gap-1 pt-0.5">
                        <button type="button" disabled={busy || i === 0} onClick={() => move(r, -1)} aria-label="Back a stage" className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowLeft className="w-3.5 h-3.5" /></button>
                        <ThemedSelect className={FIELD + " py-1 text-xs flex-1"} value={r.stage}
                          onChange={(e) => run(supabase.from("renewal_pipeline").update({ stage: e.target.value, updated_at: new Date().toISOString() }).eq("id", r.id))}>
                          {RENEWAL_STAGES.map((x) => <option key={x} value={x}>{STAGE_LABEL[x]}</option>)}
                        </ThemedSelect>
                        <button type="button" disabled={busy || i === RENEWAL_STAGES.length - 1} onClick={() => move(r, 1)} aria-label="Forward a stage" className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowRight className="w-3.5 h-3.5" /></button>
                      </div>
                    </article>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
