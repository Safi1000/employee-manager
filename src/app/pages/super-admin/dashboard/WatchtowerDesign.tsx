import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import DashboardAttachments from "../../../components/DashboardAttachments";
import { formatDate } from "../../../lib/date";
import {
  type DashData, compact, currency, daysLabel, ensureFont, humanize, monthLabel, pctChange, short,
} from "./shared";

// WATCHTOWER — a tactical operations centre. Always dark: it is a night-shift
// console, the one design that does not follow the light/dark toggle.

const G = "#39ffa0"; // phosphor green
const A = "#ffb020"; // amber
const R = "#ff4d5e"; // alert red
const C = "#4de1ff"; // cyan
const DIM = "rgba(200,245,220,.5)";

const CSS = `
.wt-root{background:#03060a;color:#c8f5dc;font-family:'Chakra Petch','JetBrains Mono',ui-monospace,monospace;position:relative}
.wt-root:before{content:"";position:absolute;inset:0;pointer-events:none;z-index:0;
  background-image:linear-gradient(rgba(57,255,160,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(57,255,160,.045) 1px,transparent 1px);
  background-size:32px 32px}
.wt-root:after{content:"";position:absolute;inset:0;pointer-events:none;z-index:30;
  background:repeating-linear-gradient(0deg,rgba(0,0,0,.18) 0,rgba(0,0,0,.18) 1px,transparent 1px,transparent 3px);mix-blend-mode:multiply}
.wt-mono{font-family:'JetBrains Mono',ui-monospace,monospace}
.wt-frame{position:relative;background:linear-gradient(180deg,rgba(10,24,20,.82),rgba(4,10,10,.82));border:1px solid rgba(57,255,160,.16);box-shadow:inset 0 0 40px rgba(57,255,160,.03)}
.wt-c{position:absolute;width:10px;height:10px;border-color:${G}}
.wt-glow{text-shadow:0 0 12px currentColor}
.wt-spin{animation:wt-spin 4.5s linear infinite}
@keyframes wt-spin{to{transform:rotate(360deg)}}
.wt-blink{animation:wt-blink 1.1s steps(2,start) infinite}
@keyframes wt-blink{to{visibility:hidden}}
.wt-ping{animation:wt-ping 1.8s ease-out infinite;transform-box:fill-box;transform-origin:center}
@keyframes wt-ping{0%{transform:scale(1);opacity:.9}100%{transform:scale(3.2);opacity:0}}
.wt-ticker{animation:wt-ticker 60s linear infinite}
@keyframes wt-ticker{to{transform:translateX(-50%)}}
.wt-boot{animation:wt-boot .7s cubic-bezier(.2,.8,.2,1) both}
@keyframes wt-boot{from{opacity:0;transform:translateY(8px);filter:brightness(2.2)}to{opacity:1;transform:none;filter:none}}
.wt-row:hover{background:rgba(57,255,160,.06)}
.wt-link{color:${G};opacity:.7}.wt-link:hover{opacity:1;text-decoration:underline}
`;

function Frame({ title, code, children, className = "", delay = 0, accent = G, right }: {
  title: string; code: string; children: ReactNode; className?: string; delay?: number; accent?: string; right?: ReactNode;
}) {
  return (
    <section className={`wt-frame wt-boot ${className}`} style={{ animationDelay: `${delay}ms` }}>
      <span className="wt-c left-[-1px] top-[-1px] border-l-2 border-t-2" style={{ borderColor: accent }} />
      <span className="wt-c right-[-1px] top-[-1px] border-r-2 border-t-2" style={{ borderColor: accent }} />
      <span className="wt-c bottom-[-1px] left-[-1px] border-b-2 border-l-2" style={{ borderColor: accent }} />
      <span className="wt-c bottom-[-1px] right-[-1px] border-b-2 border-r-2" style={{ borderColor: accent }} />
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5" style={{ borderColor: "rgba(57,255,160,.12)" }}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-1.5 w-1.5 flex-shrink-0" style={{ background: accent, boxShadow: `0 0 8px ${accent}` }} />
          <h3 className="truncate text-[12px] font-semibold uppercase tracking-[.22em]" style={{ color: accent }}>{title}</h3>
        </div>
        <div className="flex items-center gap-3">
          {right}
          <span className="wt-mono text-[10px] tracking-widest" style={{ color: DIM }}>{code}</span>
        </div>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Stable pseudo-random angle from an id, so a blip stays put between renders. */
const angleOf = (id: string) => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 360) * (Math.PI / 180);
};

function Radar({ d }: { d: DashData }) {
  const blips = useMemo(() => {
    const now = Date.now();
    const out: { id: string; r: number; a: number; color: string; label: string; hot: boolean }[] = [];
    for (const a of d.alerts) {
      const days = a.days_remaining;
      out.push({
        id: a.id,
        a: angleOf(a.id),
        r: days < 0 ? 0.1 + Math.min(Math.abs(days), 30) / 300 : 0.2 + (Math.min(days, 60) / 60) * 0.72,
        color: days <= 7 ? R : days <= 30 ? A : G,
        label: `${a.title} — ${daysLabel(days)}`,
        hot: days < 0,
      });
    }
    for (const i of d.recentIncidents) {
      const age = Math.max(0, (now - new Date(i.occurred_at).getTime()) / 86_400_000);
      const open = i.status === "open" || i.status === "under_investigation";
      out.push({
        id: `i-${i.id}`,
        a: angleOf(i.id),
        r: 0.15 + (Math.min(age, 30) / 30) * 0.78,
        color: i.severity === "critical" || i.severity === "high" ? R : C,
        label: `${i.code} · ${humanize(i.category)} · ${humanize(i.status)}`,
        hot: open && (i.severity === "critical" || i.severity === "high"),
      });
    }
    return out;
  }, [d.alerts, d.recentIncidents]);

  const S = 300;
  const c = S / 2;
  const R0 = c - 8;
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[320px]">
      <div className="absolute inset-[8px] overflow-hidden rounded-full">
        <div className="wt-spin absolute inset-0 rounded-full" style={{ background: `conic-gradient(from 0deg, rgba(57,255,160,.42), rgba(57,255,160,.08) 50deg, transparent 70deg)` }} />
      </div>
      <svg viewBox={`0 0 ${S} ${S}`} className="absolute inset-0 h-full w-full">
        {[1, 0.75, 0.5, 0.25].map((k) => (
          <circle key={k} cx={c} cy={c} r={R0 * k} fill="none" stroke={G} strokeOpacity={k === 1 ? 0.55 : 0.18} strokeDasharray={k === 1 ? undefined : "2 4"} />
        ))}
        <line x1={c} y1={8} x2={c} y2={S - 8} stroke={G} strokeOpacity={0.15} />
        <line x1={8} y1={c} x2={S - 8} y2={c} stroke={G} strokeOpacity={0.15} />
        {Array.from({ length: 72 }).map((_, i) => {
          const a = (i * 5 * Math.PI) / 180;
          const len = i % 6 === 0 ? 8 : 3;
          return (
            <line key={i} x1={c + Math.cos(a) * R0} y1={c + Math.sin(a) * R0} x2={c + Math.cos(a) * (R0 - len)} y2={c + Math.sin(a) * (R0 - len)} stroke={G} strokeOpacity={0.5} />
          );
        })}
        <text x={c + 4} y={c - R0 * 0.25 - 3} fill={G} fillOpacity={0.45} fontSize="8" fontFamily="JetBrains Mono">NOW</text>
        <text x={c + 4} y={c - R0 * 0.5 - 3} fill={G} fillOpacity={0.45} fontSize="8" fontFamily="JetBrains Mono">20D</text>
        <text x={c + 4} y={c - R0 * 0.75 - 3} fill={G} fillOpacity={0.45} fontSize="8" fontFamily="JetBrains Mono">40D</text>
        {blips.map((b) => {
          const x = c + Math.cos(b.a) * b.r * R0;
          const y = c + Math.sin(b.a) * b.r * R0;
          return (
            <g key={b.id}>
              <title>{b.label}</title>
              {b.hot && <circle className="wt-ping" cx={x} cy={y} r={4} fill="none" stroke={b.color} />}
              <circle cx={x} cy={y} r={3.2} fill={b.color} style={{ filter: `drop-shadow(0 0 4px ${b.color})` }} />
            </g>
          );
        })}
        <circle cx={c} cy={c} r={3} fill={G} />
      </svg>
    </div>
  );
}

function Segments({ pct, color, n = 24 }: { pct: number; color: string; n?: number }) {
  const on = Math.round((Math.max(0, Math.min(100, pct)) / 100) * n);
  return (
    <div className="flex gap-[3px]">
      {Array.from({ length: n }).map((_, i) => (
        <span key={i} className="h-3 flex-1" style={{ background: i < on ? color : "rgba(57,255,160,.08)", boxShadow: i < on ? `0 0 6px ${color}66` : undefined }} />
      ))}
    </div>
  );
}

function Readout({ label, value, sub, color = G, delay }: { label: string; value: ReactNode; sub?: ReactNode; color?: string; delay: number }) {
  return (
    <div className="wt-frame wt-boot px-4 py-3" style={{ animationDelay: `${delay}ms` }}>
      <span className="wt-c left-[-1px] top-[-1px] border-l border-t" style={{ borderColor: color }} />
      <span className="wt-c bottom-[-1px] right-[-1px] border-b border-r" style={{ borderColor: color }} />
      <p className="text-[10px] uppercase tracking-[.25em]" style={{ color: DIM }}>{label}</p>
      <p className="wt-mono wt-glow mt-1 text-2xl font-bold tabular-nums" style={{ color }}>{value}</p>
      {sub && <p className="wt-mono mt-0.5 text-[10px] uppercase tracking-wider" style={{ color: DIM }}>{sub}</p>}
    </div>
  );
}

const bar = (frac: number, n = 22) => {
  const k = Math.round(Math.max(0, Math.min(1, frac)) * n);
  return "█".repeat(k) + "░".repeat(n - k);
};

export default function WatchtowerDesign({ d }: { d: DashData }) {
  useEffect(() => {
    ensureFont("font-chakra", "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&display=swap");
  }, []);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const clock = now.toLocaleTimeString("en-GB", { timeZone: "Asia/Karachi", hour12: false });
  const zulu = now.toISOString().slice(11, 19);

  // Condition — a summary of the alarms already on screen, nothing new.
  const overdueAlerts = d.alerts.filter((a) => a.days_remaining < 0).length;
  const hotIncidents = d.recentIncidents.filter(
    (i) => (i.severity === "critical" || i.severity === "high") && (i.status === "open" || i.status === "under_investigation"),
  ).length;
  const soon = d.alerts.filter((a) => a.days_remaining >= 0 && a.days_remaining <= 7).length;
  const reasons: string[] = [];
  if (overdueAlerts) reasons.push(`${overdueAlerts} DEADLINE${overdueAlerts > 1 ? "S" : ""} OVERDUE`);
  if (d.licencesOverdue) reasons.push(`${d.licencesOverdue} GUARD${d.licencesOverdue > 1 ? "S" : ""} OUT OF COMPLIANCE`);
  if (hotIncidents) reasons.push(`${hotIncidents} HIGH-SEVERITY INCIDENT${hotIncidents > 1 ? "S" : ""} OPEN`);
  if (d.openIncidents && !hotIncidents) reasons.push(`${d.openIncidents} INCIDENT${d.openIncidents > 1 ? "S" : ""} OPEN`);
  if (soon) reasons.push(`${soon} DUE WITHIN 7 DAYS`);
  const level = overdueAlerts || d.licencesOverdue || hotIncidents ? "RED" : d.openIncidents || soon ? "AMBER" : "GREEN";
  const levelColor = level === "RED" ? R : level === "AMBER" ? A : G;

  const attDelta = d.attendanceTodayPct - d.attendanceYesterdayPct;
  const trendMax = Math.max(1, ...d.attendanceTrend.map((p) => p.present + p.absent + p.leave));
  const maxBank = Math.max(1, ...d.banks.map((b) => b.balance));
  const maxClient = Math.max(1, ...d.topClients.map((c) => c.revenue));
  const expTotal = d.expensesPie.reduce((s, r) => s + r.value, 0);
  const tickerText = d.feedItems.length
    ? d.feedItems.map((f) => `${f.tone === "in" ? "▲" : f.tone === "out" ? "■" : "◆"} ${f.text}${f.amount ? ` ${f.amount}` : ""}`).join("     ///     ")
    : "NO TRAFFIC ON THE WIRE";
  const payChg = pctChange(d.payrollMtd, d.payrollPrev);
  const expChg = pctChange(d.expensesMtd, d.expensesPrev);
  const fmtChg = (v: number | null) => (v == null ? "NO PRIOR" : `${v >= 0 ? "+" : ""}${v.toFixed(0)}% VS ${monthLabel(-1).toUpperCase()}`);

  return (
    <div className="wt-root relative flex-1 min-h-0 overflow-hidden">
      <style>{CSS}</style>
      <div className="absolute inset-0 z-[1] overflow-y-auto">

      {/* Status strip */}
      <div className="sticky top-0 z-20 border-b backdrop-blur" style={{ borderColor: "rgba(57,255,160,.2)", background: "rgba(3,6,10,.88)" }}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 md:px-8">
          <div className="flex items-center gap-3">
            <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
              <path d="M13 2 L23 6 V13 C23 19 18 23 13 24 C8 23 3 19 3 13 V6 Z" fill="none" stroke={G} strokeWidth="1.5" />
              <path d="M8 13 l3.5 3.5 L18 10" fill="none" stroke={G} strokeWidth="1.5" />
            </svg>
            <div>
              <p className="text-[15px] font-bold uppercase tracking-[.3em]" style={{ color: G }}>Watchtower</p>
              <p className="wt-mono text-[10px] uppercase tracking-widest" style={{ color: DIM }}>{d.companyName} · ops console</p>
            </div>
          </div>
          <div className="wt-mono flex items-center gap-5 text-[11px] uppercase tracking-wider">
            <div><span style={{ color: DIM }}>PKT </span><span className="wt-glow text-base font-bold tabular-nums" style={{ color: G }}>{clock}</span></div>
            <div className="hidden sm:block"><span style={{ color: DIM }}>ZULU </span><span className="tabular-nums" style={{ color: C }}>{zulu}</span></div>
            <div className="hidden md:block"><span style={{ color: DIM }}>OPR </span><span style={{ color: "#e8fff2" }}>{d.userName.toUpperCase()}</span></div>
          </div>
          <div className="ml-auto flex items-center gap-2 border px-3 py-1.5" style={{ borderColor: levelColor, background: `${levelColor}14` }}>
            <span className={`h-2.5 w-2.5 rounded-full ${level !== "GREEN" ? "wt-blink" : ""}`} style={{ background: levelColor, boxShadow: `0 0 10px ${levelColor}` }} />
            <span className="text-[12px] font-bold uppercase tracking-[.25em]" style={{ color: levelColor }}>Condition {level}</span>
          </div>
        </div>
        <div className="overflow-hidden border-t py-1.5" style={{ borderColor: "rgba(57,255,160,.12)", background: "rgba(57,255,160,.04)" }}>
          <div className="wt-ticker wt-mono flex w-max whitespace-nowrap text-[11px] uppercase tracking-wider" style={{ color: "rgba(200,245,220,.75)" }}>
            <span className="px-8">{tickerText}</span>
            <span className="px-8">{tickerText}</span>
          </div>
        </div>
      </div>

      <div className="relative z-10 space-y-4 px-3 py-5 md:px-8 md:py-6">
        {d.branchScopeNote && <p className="wt-mono text-[11px] uppercase tracking-widest" style={{ color: A }}>⚠ {d.branchScopeNote}</p>}
        {d.nothingToShow && (
          <Frame title="Access" code="ERR-403">
            <p className="wt-mono text-sm" style={{ color: A }}>NO CLEARANCE ON FILE. ASK A SUPER ADMIN TO GRANT FEATURE ACCESS.</p>
          </Frame>
        )}

        {/* Row 1 — radar + readiness */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          <Frame title="Threat radar" code="RDR-01" className="xl:col-span-5" right={<span className="wt-mono text-[10px]" style={{ color: DIM }}>{d.alerts.length + d.recentIncidents.length} CONTACTS</span>}>
            <Radar d={d} />
            <div className="wt-mono mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] uppercase tracking-wider" style={{ color: DIM }}>
              <span><span style={{ color: R }}>●</span> overdue / ≤7d / severe</span>
              <span><span style={{ color: A }}>●</span> due ≤30d</span>
              <span><span style={{ color: G }}>●</span> due ≤60d</span>
              <span><span style={{ color: C }}>●</span> incident (by age)</span>
            </div>
            <div className="mt-4 space-y-1 border-t pt-3" style={{ borderColor: "rgba(57,255,160,.12)" }}>
              {reasons.length === 0 ? (
                <p className="wt-mono text-[11px] uppercase" style={{ color: G }}>&gt; ALL SECTORS QUIET_</p>
              ) : reasons.map((r) => (
                <p key={r} className="wt-mono text-[11px] uppercase" style={{ color: levelColor }}>&gt; {r}</p>
              ))}
            </div>
          </Frame>

          <div className="space-y-4 xl:col-span-7">
            {d.can.attendance && d.show("stat_attendance_today") && (
              <Frame title="Force readiness" code="ATT-24H" delay={80}>
                <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-[.25em]" style={{ color: DIM }}>On post today</p>
                    <p className="wt-mono wt-glow text-6xl font-bold leading-none tabular-nums md:text-7xl" style={{ color: d.attendanceTodayPct >= 85 ? G : d.attendanceTodayPct >= 60 ? A : R }}>
                      {d.attendanceTodayPct}<span className="text-3xl">%</span>
                    </p>
                  </div>
                  <div className="wt-mono pb-2 text-[11px] uppercase tracking-wider" style={{ color: DIM }}>
                    <p>Yesterday <span style={{ color: "#e8fff2" }}>{d.attendanceYesterdayPct}%</span></p>
                    <p>Delta <span style={{ color: attDelta >= 0 ? G : R }}>{attDelta >= 0 ? "▲ +" : "▼ "}{attDelta}%</span></p>
                    {d.can.employees && d.show("stat_employees") && <p>Personnel <span style={{ color: "#e8fff2" }}>{d.employeeCount}</span></p>}
                  </div>
                </div>
                <div className="mt-4"><Segments pct={d.attendanceTodayPct} color={d.attendanceTodayPct >= 85 ? G : d.attendanceTodayPct >= 60 ? A : R} n={40} /></div>
              </Frame>
            )}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              {d.can.employees && d.show("stat_employees") && !(d.can.attendance && d.show("stat_attendance_today")) && (
                <Readout label="Personnel" value={d.employeeCount} sub="active" delay={120} />
              )}
              {d.can.contracts && d.show("stat_active_contracts") && (
                <Readout label="Contracts" value={d.activeContracts} sub="active" color={C} delay={140} />
              )}
              {d.can.incidents && d.show("stat_open_incidents") && (
                <Readout label="Incidents" value={d.openIncidents} sub="open" color={d.openIncidents ? R : G} delay={180} />
              )}
              {d.can.compliance && d.show("stat_licences_expiring") && (
                <Readout label="Compliance <30d" value={d.licencesExpiring} sub={`${d.licencesOverdue} overdue`} color={d.licencesOverdue ? R : d.licencesExpiring ? A : G} delay={220} />
              )}
              {d.can.payroll && d.show("stat_payroll_mtd") && (
                <Readout label={`Payroll · ${monthLabel(0)}`} value={short(d.payrollMtd)} sub={fmtChg(payChg)} color={A} delay={260} />
              )}
              {d.can.expenses && d.show("stat_expenses_mtd") && (
                <Readout label={`Expenses · ${monthLabel(0)}`} value={short(d.expensesMtd)} sub={fmtChg(expChg)} color={R} delay={300} />
              )}
              {d.can.periodClose && d.show("period_close_status") && (
                <Readout
                  label="Period"
                  value={d.periodClosedThisMonth ? "LOCKED" : "OPEN"}
                  sub={d.periodClosedThisMonth ? monthLabel(0) : d.lastClosedMonth ? `last lock ${d.lastClosedMonth.slice(0, 7)}` : "none locked"}
                  color={d.periodClosedThisMonth ? G : A}
                  delay={340}
                />
              )}
            </div>
          </div>
        </div>

        {/* Row 2 — deployment columns + reserves */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          {d.can.attendance && d.show("attendance_trend") && (
            <Frame title="Deployment · 7 day" code="ATT-07D" className="xl:col-span-7" delay={120}>
              {d.attendanceTrend.every((p) => p.present + p.absent + p.leave === 0) ? (
                <p className="wt-mono text-sm" style={{ color: DIM }}>&gt; NO MUSTER RECORDED IN 7 DAYS</p>
              ) : (
                <div className="flex h-56 items-end gap-2 md:gap-4">
                  {d.attendanceTrend.map((p) => {
                    const t = p.present + p.absent + p.leave;
                    const pct = t ? Math.round((p.present / t) * 100) : 0;
                    const h = (n: number) => `${(n / trendMax) * 100}%`;
                    return (
                      <div key={p.date} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                        <span className="wt-mono text-[10px] tabular-nums" style={{ color: pct >= 85 ? G : A }}>{t ? `${pct}%` : "—"}</span>
                        <div className="flex w-full max-w-[56px] flex-1 flex-col justify-end gap-[2px]" title={`${p.label}: ${p.present} present · ${p.leave} leave · ${p.absent} absent`}>
                          <div style={{ height: h(p.absent), background: R, opacity: 0.85 }} />
                          <div style={{ height: h(p.leave), background: A, opacity: 0.85 }} />
                          <div style={{ height: h(p.present), background: `linear-gradient(180deg, ${G}, rgba(57,255,160,.35))`, boxShadow: `0 0 12px rgba(57,255,160,.25)` }} />
                        </div>
                        <span className="wt-mono text-[10px] uppercase" style={{ color: DIM }}>{p.label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="wt-mono mt-3 flex gap-4 text-[10px] uppercase" style={{ color: DIM }}>
                <span><span style={{ color: G }}>■</span> present</span>
                <span><span style={{ color: A }}>■</span> leave</span>
                <span><span style={{ color: R }}>■</span> absent</span>
              </div>
            </Frame>
          )}
          {d.can.accounting && d.show("bank_overview") && (
            <Frame title="Reserves" code="BNK-ALL" className="xl:col-span-5" delay={160} accent={C}>
              {d.banks.length === 0 ? (
                <p className="wt-mono text-sm" style={{ color: DIM }}>&gt; NO ACCOUNTS ON FILE</p>
              ) : (
                <>
                  <p className="text-[10px] uppercase tracking-[.25em]" style={{ color: DIM }}>Total liquid</p>
                  <p className="wt-mono wt-glow mb-4 text-3xl font-bold tabular-nums" style={{ color: C }}>{currency(d.totalBankBalance)}</p>
                  <div className="space-y-3">
                    {d.banks.map((b) => (
                      <div key={b.id}>
                        <div className="wt-mono mb-1 flex justify-between text-[11px] uppercase">
                          <span className="truncate" style={{ color: "#e8fff2" }}>{b.bank_name}</span>
                          <span className="tabular-nums" style={{ color: b.balance < 0 ? R : C }}>{compact(b.balance)}</span>
                        </div>
                        <Segments pct={(Math.max(0, b.balance) / maxBank) * 100} color={C} n={30} />
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Frame>
          )}
        </div>

        {/* Row 3 — watch list, contracts, incidents */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {d.show("compliance_alerts") && (
            <Frame title="Watch list" code="CMP-60D" delay={160} accent={A} right={<span className="wt-mono text-[10px]" style={{ color: A }}>{d.alerts.length}</span>}>
              {d.alerts.length === 0 ? (
                <p className="wt-mono text-sm" style={{ color: G }}>&gt; NOTHING DUE IN 60 DAYS</p>
              ) : (
                <div className="-mx-4 max-h-80 overflow-y-auto">
                  {d.alerts.map((a) => {
                    const col = a.days_remaining < 0 || a.days_remaining <= 7 ? R : a.days_remaining <= 30 ? A : G;
                    return (
                      <div key={a.id} className="wt-row flex items-center gap-3 px-4 py-2">
                        <span className={`h-2 w-2 flex-shrink-0 ${a.days_remaining < 0 ? "wt-blink" : ""}`} style={{ background: col }} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px]" style={{ color: "#e8fff2" }}>{a.title}</p>
                          <p className="wt-mono truncate text-[10px] uppercase" style={{ color: DIM }}>{a.category} · {formatDate(a.due_date)}</p>
                        </div>
                        <span className="wt-mono text-[11px] font-bold uppercase tabular-nums" style={{ color: col }}>{daysLabel(a.days_remaining)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Frame>
          )}
          {d.can.contracts && d.show("contracts_ending") && (
            <Frame title="Contract expiry" code="CTR-T-MINUS" delay={200} accent={C} right={<Link to="/super-admin/contracts" className="wt-link wt-mono text-[10px] uppercase">open ›</Link>}>
              {d.contractsEnding.length === 0 ? (
                <p className="wt-mono text-sm" style={{ color: G }}>&gt; NO EXPIRIES IN 60 DAYS</p>
              ) : (
                <div className="space-y-2">
                  {d.contractsEnding.map((c) => {
                    const col = c.days_left <= 7 ? R : c.days_left <= 30 ? A : G;
                    return (
                      <div key={c.id} className="flex items-center gap-3">
                        <div className="wt-mono w-16 flex-shrink-0 border py-1 text-center text-sm font-bold tabular-nums" style={{ borderColor: col, color: col }}>
                          T-{c.days_left}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px]" style={{ color: "#e8fff2" }}>{c.client_name}</p>
                          <p className="wt-mono text-[10px] uppercase" style={{ color: DIM }}>{c.code} · ends {formatDate(c.end_date)}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Frame>
          )}
          {d.can.incidents && d.show("incidents_recent") && (
            <Frame title="Incident log" code="INC-30D" delay={240} accent={R} right={<Link to="/super-admin/incidents" className="wt-link wt-mono text-[10px] uppercase">open ›</Link>}>
              {d.recentIncidents.length === 0 ? (
                <p className="wt-mono text-sm" style={{ color: G }}>&gt; NO INCIDENTS IN 30 DAYS</p>
              ) : (
                <div className="wt-mono space-y-1.5 text-[11px]">
                  {d.recentIncidents.map((i) => {
                    const col = i.severity === "critical" || i.severity === "high" ? R : i.severity === "medium" ? A : DIM;
                    return (
                      <div key={i.id} className="flex items-baseline gap-2">
                        <span style={{ color: DIM }}>{new Date(i.occurred_at).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" })}</span>
                        <span className="w-16 flex-shrink-0 font-bold uppercase" style={{ color: col }}>[{i.severity.slice(0, 4)}]</span>
                        <span className="flex-1 truncate uppercase" style={{ color: "#e8fff2" }}>{i.code} {humanize(i.category)}</span>
                        <span className="uppercase" style={{ color: DIM }}>{humanize(i.status)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Frame>
          )}
        </div>

        {/* Row 4 — ops feed terminal, principals, burn */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Frame title="Ops feed" code="LIVE" delay={200} right={<span className="wt-mono flex items-center gap-1.5 text-[10px]" style={{ color: G }}><span className="wt-blink h-1.5 w-1.5 rounded-full" style={{ background: G }} />REC</span>}>
            <div className="wt-mono max-h-80 space-y-1 overflow-y-auto text-[11px] leading-relaxed">
              {d.feedItems.length === 0 ? (
                <p style={{ color: DIM }}>&gt; awaiting traffic<span className="wt-blink">_</span></p>
              ) : d.feedItems.map((f) => (
                <p key={f.id}>
                  <span style={{ color: f.tone === "in" ? G : f.tone === "out" ? R : C }}>{f.tone === "in" ? "IN " : f.tone === "out" ? "INC" : "EVT"}</span>
                  <span style={{ color: DIM }}> &gt;&gt; </span>
                  <span style={{ color: "#d6ffe9" }}>{f.text}</span>
                  {f.amount && <span style={{ color: G }}> {f.amount}</span>}
                </p>
              ))}
              {d.feedItems.length > 0 && <p style={{ color: G }}>&gt; <span className="wt-blink">_</span></p>}
            </div>
          </Frame>
          {d.can.reports && d.show("top_clients") && (
            <Frame title={`Principals · ${monthLabel(0)}`} code="CLT-TOP10" delay={240} accent={A}>
              {d.topClients.length === 0 ? (
                <p className="wt-mono text-sm" style={{ color: DIM }}>&gt; NO RECEIPTS THIS MONTH</p>
              ) : (
                <div className="space-y-2">
                  {d.topClients.map((c, i) => (
                    <div key={c.id}>
                      <div className="flex items-baseline gap-2 text-[12px]">
                        <span className="wt-mono w-5 text-[10px]" style={{ color: DIM }}>{String(i + 1).padStart(2, "0")}</span>
                        <span className="flex-1 truncate" style={{ color: "#e8fff2" }}>{c.name}</span>
                        <span className="wt-mono tabular-nums" style={{ color: A }}>{short(c.revenue)}</span>
                      </div>
                      <div className="ml-7 mt-1 h-[3px]" style={{ background: "rgba(255,176,32,.12)" }}>
                        <div className="h-full" style={{ width: `${Math.max(2, (c.revenue / maxClient) * 100)}%`, background: A, boxShadow: `0 0 8px ${A}` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Frame>
          )}
          {d.can.expenses && d.show("expenses_pie") && (
            <Frame title={`Burn · ${monthLabel(0)}`} code="EXP-CAT" delay={280} accent={R}>
              {d.expensesPie.length === 0 ? (
                <p className="wt-mono text-sm" style={{ color: DIM }}>&gt; NO SPEND RECORDED</p>
              ) : (
                <div className="wt-mono space-y-2 text-[11px]">
                  {d.expensesPie.slice(0, 9).map((r) => (
                    <div key={r.name}>
                      <div className="flex justify-between uppercase">
                        <span className="truncate" style={{ color: "#e8fff2" }}>{r.name}</span>
                        <span className="tabular-nums" style={{ color: DIM }}>{expTotal ? Math.round((r.value / expTotal) * 100) : 0}% · {short(r.value)}</span>
                      </div>
                      <div className="overflow-hidden whitespace-nowrap leading-none tracking-[-.05em]" style={{ color: R }}>{bar(expTotal ? r.value / expTotal : 0, 34)}</div>
                    </div>
                  ))}
                </div>
              )}
            </Frame>
          )}
        </div>

        <div className="dark pb-20">
          <DashboardAttachments />
        </div>
      </div>
      </div>
    </div>
  );
}
