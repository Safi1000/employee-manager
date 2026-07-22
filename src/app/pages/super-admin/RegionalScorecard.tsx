import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import Header from "../../components/Header";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";

// §22 Regional scorecard + KPI department dashboard — one card per region with
// coverage, incidents, no-shows, receivables, profit and inter-region balance,
// plus the department KPI traffic-light roll-up.

const money = (n: any) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const prefersReduced = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Smoothly counts a number up on mount / when it changes. */
function CountUp({ value, format }: { value: number; format?: (n: number) => string }) {
  const [n, setN] = useState(prefersReduced() ? value : 0);
  useEffect(() => {
    const target = Number(value) || 0;
    if (prefersReduced()) {
      setN(target);
      return;
    }
    let raf = 0;
    let start: number | null = null;
    const from = 0;
    const dur = 900;
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setN(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format ? format(n) : Math.round(n).toLocaleString()}</>;
}

export default function RegionalScorecard() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [cards, setCards] = useState<any[]>([]);
  const [kpis, setKpis] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [sc, kd] = await Promise.all([
      supabase.from("regional_scorecard").select("*").eq("company_id", companyId),
      supabase.from("kpi_department_dashboard").select("*").eq("company_id", companyId).order("period_month", { ascending: false }),
    ]);
    setCards(sc.data ?? []);
    setKpis(kd.data ?? []);
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  // Auto-gliding, chevron-controllable marquee of region cards.
  const viewRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const geomRef = useRef({ set: 0, step: 340 });

  useEffect(() => {
    const view = viewRef.current;
    const track = trackRef.current;
    if (!view || !track || cards.length === 0) return;

    const measure = () => {
      geomRef.current.set = track.scrollWidth / 2;
      const card = track.querySelector<HTMLElement>("[data-card]");
      if (card) geomRef.current.step = card.getBoundingClientRect().width + 16;
    };
    measure();
    window.addEventListener("resize", measure);

    let raf = 0;
    const reduce = prefersReduced();
    const loop = () => {
      const g = geomRef.current;
      if (!pausedRef.current && !reduce && g.set > view.clientWidth) {
        view.scrollLeft += 0.4;
        if (view.scrollLeft >= g.set) view.scrollLeft -= g.set;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, [cards]);

  const nudge = (dir: number) => {
    const view = viewRef.current;
    const g = geomRef.current;
    if (!view) return;
    pausedRef.current = true;
    setTimeout(() => { pausedRef.current = false; }, 3200);
    if (dir < 0 && view.scrollLeft < g.step) view.scrollLeft += g.set;
    else if (dir > 0 && view.scrollLeft > g.set - g.step) view.scrollLeft -= g.set;
    view.scrollBy({ left: dir * g.step, behavior: prefersReduced() ? "auto" : "smooth" });
  };

  const loopCards = cards.length ? [...cards, ...cards] : [];

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header title="Regional Scorecard" subtitle="Per-region operating & financial health (§22)" />

      <div className="flex items-center justify-between mb-4 mt-1">
        <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-muted-foreground">Regions</h3>
        {cards.length > 1 && (
          <div className="flex gap-2">
            <button type="button" onClick={() => nudge(-1)} aria-label="Previous"
              className="w-9 h-9 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground hover:border-brand-500/50 grid place-items-center transition-colors">
              <ChevronLeft className="w-4 h-4" strokeWidth={2} />
            </button>
            <button type="button" onClick={() => nudge(1)} aria-label="Next"
              className="w-9 h-9 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground hover:border-brand-500/50 grid place-items-center transition-colors">
              <ChevronRight className="w-4 h-4" strokeWidth={2} />
            </button>
          </div>
        )}
      </div>

      {cards.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-10 text-center text-muted-foreground mb-8">No active regions.</div>
      ) : (
        <div
          ref={viewRef}
          className="overflow-hidden mb-8"
          style={{ WebkitMaskImage: "linear-gradient(90deg, transparent, #000 2%, #000 98%, transparent)", maskImage: "linear-gradient(90deg, transparent, #000 2%, #000 98%, transparent)" }}
          onMouseEnter={() => { pausedRef.current = true; }}
          onMouseLeave={() => { pausedRef.current = false; }}
        >
          <div ref={trackRef} className="flex w-max py-1">
            {loopCards.map((c, i) => {
              const profitUp = Number(c.profit_ytd ?? 0) >= Number(c.profit_prior_year ?? 0);
              const accent = profitUp ? "border-l-success-500" : "border-l-danger-500";
              return (
                <div
                  key={i}
                  data-card={i < cards.length ? "" : undefined}
                  aria-hidden={i >= cards.length}
                  className={`w-[320px] flex-shrink-0 mr-4 bg-card border border-border border-l-4 ${accent} rounded-xl p-5 space-y-3 transition-shadow hover:shadow-md`}
                  style={
                    i < cards.length && !prefersReduced()
                      ? { animation: `feed-slide-in 0.5s var(--ease, ease-out) both`, animationDelay: `${i * 70}ms` }
                      : undefined
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 font-semibold text-foreground truncate" style={{ fontFamily: "var(--font-display)" }}>
                      <MapPin className="w-3.5 h-3.5 text-brand-600 dark:text-brand-500 shrink-0" strokeWidth={2} />
                      {c.region_name}
                    </h3>
                    <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground border border-border shrink-0">{String(c.region_kind)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-y-2.5 gap-x-4 text-sm">
                    <Metric label="Active headcount" value={c.active_headcount} />
                    <Metric label="Incidents YTD" value={c.incidents_ytd} tone={Number(c.incidents_ytd) > 0 ? "warn" : undefined} />
                    <Metric label="No-shows 30d" value={c.no_shows_30d} tone={Number(c.no_shows_30d) > 0 ? "warn" : undefined} />
                    <Metric label="Receivables" value={c.receivables_outstanding} money />
                    <Metric label="Profit YTD" value={c.profit_ytd} money tone={Number(c.profit_ytd) < 0 ? "bad" : "good"} />
                    <Metric label="vs prior yr" text={profitUp ? "▲" : "▼"} tone={profitUp ? "good" : "bad"} />
                    <Metric label="Inter-region net" value={c.inter_region_balance} money />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <section>
        <h3 className="text-sm font-semibold uppercase tracking-[0.1em] text-muted-foreground mb-2">Department KPI roll-up</h3>
        <div className="overflow-x-auto border border-border rounded-xl bg-card">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="bg-slate-50 text-[11px] text-muted-foreground uppercase tracking-[0.08em] border-b border-border">
              <tr>
                <th className="text-left px-3 py-2.5">Month</th>
                <th className="text-left px-3 py-2.5">Department</th>
                <th className="text-right px-3 py-2.5">Scored</th>
                <th className="text-right px-3 py-2.5">Green</th>
                <th className="text-right px-3 py-2.5">Amber</th>
                <th className="text-right px-3 py-2.5">Red</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {kpis.map((k, i) => (
                <tr key={i} className="hover:bg-accent/50 transition-colors">
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">{String(k.period_month).slice(0, 7)}</td>
                  <td className="px-3 py-2 text-foreground capitalize">{String(k.department).replace(/_/g, " ")}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-foreground">{k.kpis_scored}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-success-700 dark:text-success-500">{k.green}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-warning-700 dark:text-warning-500">{k.amber}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-danger-700 dark:text-danger-500">{k.red}</td>
                </tr>
              ))}
              {kpis.length === 0 && <tr><td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">No KPI scores yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  text,
  tone,
  money: isMoney,
}: {
  label: string;
  value?: number;
  text?: string;
  tone?: "good" | "bad" | "warn";
  money?: boolean;
}) {
  const color =
    tone === "good" ? "text-success-700 dark:text-success-500"
    : tone === "bad" ? "text-danger-700 dark:text-danger-500"
    : tone === "warn" ? "text-warning-700 dark:text-warning-500"
    : "text-foreground";
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`tabular-nums font-medium ${color}`}>
        {text !== undefined ? (
          text
        ) : value === null || value === undefined ? (
          "—"
        ) : (
          <CountUp value={Number(value)} format={isMoney ? money : undefined} />
        )}
      </div>
    </div>
  );
}
