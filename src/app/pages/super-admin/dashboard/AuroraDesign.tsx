import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import {
  Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis,
} from "recharts";
import {
  ArrowDownRight, ArrowUpRight, Banknote, CalendarClock, FileSignature, Landmark, Lock,
  ShieldAlert, Siren, Sparkles, Unlock, Users, Wallet,
} from "lucide-react";
import DashboardAttachments from "../../../components/DashboardAttachments";
import { formatDate } from "../../../lib/date";
import {
  type DashData, compact, currency, daysLabel, ensureFont, greeting, humanize, monthLabel, pctChange, short,
} from "./shared";

// AURORA — frosted glass tiles floating over a slow, living gradient. Follows
// the app's light/dark mode: pastel dawn by day, neon aurora by night.

const HUES = ["#7c5cff", "#00c2b8", "#ff5c9a", "#ffaa33", "#3b82f6", "#84cc16", "#e879f9", "#22d3ee"];

const CSS = `
.au-root{--bg:#f5f3ff;--fg:#1c1838;--mute:#6b6790;--glass:rgba(255,255,255,.58);--edge:rgba(255,255,255,.85);--line:rgba(28,24,56,.08);--shadow:0 10px 40px -12px rgba(76,52,170,.22);--blob:.55;
  background:var(--bg);color:var(--fg);font-family:'Plus Jakarta Sans','Hanken Grotesk',system-ui,sans-serif;position:relative;isolation:isolate}
.dark .au-root{--bg:#06061a;--fg:#f2f0ff;--mute:#a19dc9;--glass:rgba(255,255,255,.055);--edge:rgba(255,255,255,.12);--line:rgba(255,255,255,.08);--shadow:0 20px 60px -20px rgba(0,0,0,.7);--blob:.42}
.au-disp{font-family:'Outfit','Plus Jakarta Sans',system-ui,sans-serif}
.au-sky{position:absolute;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.au-blob{position:absolute;border-radius:9999px;filter:blur(90px);opacity:var(--blob);will-change:transform}
.au-b1{width:46vw;height:46vw;left:-8vw;top:-14vw;background:#8b5cf6;animation:au-d1 26s ease-in-out infinite alternate}
.au-b2{width:38vw;height:38vw;right:-10vw;top:6vh;background:#06d6c7;animation:au-d2 30s ease-in-out infinite alternate}
.au-b3{width:42vw;height:42vw;left:22vw;bottom:-22vw;background:#ff4f9a;animation:au-d3 34s ease-in-out infinite alternate}
.au-b4{width:28vw;height:28vw;right:16vw;bottom:-6vw;background:#ffb547;animation:au-d1 38s ease-in-out infinite alternate-reverse}
@keyframes au-d1{to{transform:translate(12vw,10vh) scale(1.15)}}
@keyframes au-d2{to{transform:translate(-14vw,18vh) scale(.9)}}
@keyframes au-d3{to{transform:translate(10vw,-16vh) scale(1.1)}}
.au-grain{position:absolute;inset:0;opacity:.07;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence baseFrequency='.9' numOctaves='2'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")}
.au-tile{background:var(--glass);border:1px solid var(--edge);box-shadow:var(--shadow);backdrop-filter:blur(22px) saturate(160%);-webkit-backdrop-filter:blur(22px) saturate(160%);border-radius:28px;
  transition:transform .35s cubic-bezier(.2,.8,.2,1),box-shadow .35s;animation:au-rise .8s cubic-bezier(.2,.8,.2,1) both}
.au-tile:hover{transform:translateY(-3px)}
@keyframes au-rise{from{opacity:0;transform:translateY(16px) scale(.985)}to{opacity:1;transform:none}}
.au-mute{color:var(--mute)}
.au-grad{background:linear-gradient(100deg,#7c5cff,#ff5c9a 45%,#ffaa33);-webkit-background-clip:text;background-clip:text;color:transparent}
.au-ring{animation:au-ring 1.6s cubic-bezier(.2,.8,.2,1) both}
@keyframes au-ring{from{stroke-dashoffset:var(--full)}}
.au-chip{border:1px solid var(--edge);background:var(--glass)}
.au-row{border-top:1px solid var(--line)}
@media (max-width:640px){.au-tile{border-radius:22px}}
`;

function Tile({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return <div className={`au-tile p-5 md:p-6 ${className}`} style={{ animationDelay: `${delay}ms` }}>{children}</div>;
}

function TileHead({ icon, title, hue, right }: { icon: ReactNode; title: string; hue: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: `linear-gradient(135deg, ${hue}, ${hue}99)`, boxShadow: `0 8px 20px -6px ${hue}` }}>
          {icon}
        </span>
        <h3 className="au-disp truncate text-[15px] font-semibold">{title}</h3>
      </div>
      {right}
    </div>
  );
}

function DeltaChip({ curr, prev, invert = false }: { curr: number; prev: number; invert?: boolean }) {
  const c = pctChange(curr, prev);
  if (c == null) return <span className="au-chip rounded-full px-2 py-0.5 text-[11px] au-mute">new</span>;
  const good = invert ? c <= 0 : c >= 0;
  const Icon = c >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: good ? "rgba(16,185,129,.16)" : "rgba(244,63,94,.16)", color: good ? "#10b981" : "#f43f5e" }}>
      <Icon className="h-3 w-3" />{Math.abs(c).toFixed(0)}%
    </span>
  );
}

function Ring({ pct, size = 168, stroke = 16 }: { pct: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const full = 2 * Math.PI * r;
  const off = full * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
      <defs>
        <linearGradient id="au-ring-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7c5cff" />
          <stop offset="55%" stopColor="#ff5c9a" />
          <stop offset="100%" stopColor="#ffaa33" />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
      <circle
        className="au-ring"
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#au-ring-g)" strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={full} strokeDashoffset={off}
        style={{ ["--full" as string]: full, filter: "drop-shadow(0 0 10px rgba(255,92,154,.45))" }}
      />
    </svg>
  );
}

/** Small countdown ring: how much of the 60-day window is left. */
function Countdown({ days }: { days: number }) {
  const s = 40, st = 4, r = (s - st) / 2, full = 2 * Math.PI * r;
  const frac = days < 0 ? 1 : Math.min(1, days / 60);
  const col = days < 0 || days <= 7 ? "#f43f5e" : days <= 30 ? "#ffaa33" : "#10b981";
  return (
    <div className="relative h-10 w-10 flex-shrink-0">
      <svg width={s} height={s} className="-rotate-90">
        <circle cx={s / 2} cy={s / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={st} />
        <circle cx={s / 2} cy={s / 2} r={r} fill="none" stroke={col} strokeWidth={st} strokeLinecap="round" strokeDasharray={full} strokeDashoffset={days < 0 ? 0 : full * (1 - frac)} />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold tabular-nums" style={{ color: col }}>
        {days < 0 ? "!" : days}
      </span>
    </div>
  );
}

function GlassTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="au-tile !animate-none rounded-2xl px-3 py-2 text-xs" style={{ borderRadius: 14 }}>
      {label && <p className="mb-1 font-semibold">{label}</p>}
      {payload.map((p: any) => (
        <p key={p.dataKey ?? p.name} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color ?? p.payload?.fill }} />
          <span className="au-mute">{p.name}</span>
          <span className="font-semibold tabular-nums">{typeof p.value === "number" && p.value > 1000 ? currency(p.value) : p.value}</span>
        </p>
      ))}
    </div>
  );
}

// Fill each row of the bento exactly, whatever subset of KPIs this reader sees.
const kpiSpan = (i: number, n: number) =>
  n === 1 ? "lg:col-span-12"
  : n === 2 ? "lg:col-span-6"
  : n === 4 ? "lg:col-span-3"
  : n === 5 ? (i < 3 ? "lg:col-span-4" : "lg:col-span-6")
  : "lg:col-span-4";

const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

export default function AuroraDesign({ d }: { d: DashData }) {
  useEffect(() => {
    ensureFont("font-aurora", "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap");
  }, []);

  const first = d.userName.split(/\s+/)[0] || "there";
  const seeAtt = d.can.attendance && d.show("stat_attendance_today");
  const trendHas = !d.attendanceTrend.every((p) => p.present + p.absent + p.leave === 0);
  const expTotal = d.expensesPie.reduce((s, r) => s + r.value, 0);
  const maxClient = Math.max(1, ...d.topClients.map((c) => c.revenue));
  const attDelta = d.attendanceTodayPct - d.attendanceYesterdayPct;

  const kpis: { key: string; label: string; value: string; icon: ReactNode; hue: string; foot: ReactNode }[] = [];
  if (d.can.payroll && d.show("stat_payroll_mtd"))
    kpis.push({ key: "pay", label: `Payroll · ${monthLabel(0)}`, value: short(d.payrollMtd), icon: <Wallet className="h-4 w-4" />, hue: HUES[0], foot: <DeltaChip curr={d.payrollMtd} prev={d.payrollPrev} /> });
  if (d.can.expenses && d.show("stat_expenses_mtd"))
    kpis.push({ key: "exp", label: `Expenses · ${monthLabel(0)}`, value: short(d.expensesMtd), icon: <Banknote className="h-4 w-4" />, hue: HUES[2], foot: <DeltaChip curr={d.expensesMtd} prev={d.expensesPrev} invert /> });
  if (d.can.contracts && d.show("stat_active_contracts"))
    kpis.push({ key: "ctr", label: "Active contracts", value: String(d.activeContracts), icon: <FileSignature className="h-4 w-4" />, hue: HUES[1], foot: <span className="text-[11px] au-mute">{d.contractsEnding.length} ending ≤60d</span> });
  if (d.can.incidents && d.show("stat_open_incidents"))
    kpis.push({ key: "inc", label: "Open incidents", value: String(d.openIncidents), icon: <Siren className="h-4 w-4" />, hue: d.openIncidents ? "#f43f5e" : HUES[5], foot: <span className="text-[11px] au-mute">{d.recentIncidents.length} logged in 30d</span> });
  if (d.can.compliance && d.show("stat_licences_expiring"))
    kpis.push({ key: "cmp", label: "Compliance due <30d", value: String(d.licencesExpiring), icon: <ShieldAlert className="h-4 w-4" />, hue: d.licencesOverdue ? "#f43f5e" : HUES[3], foot: <span className="text-[11px]" style={{ color: d.licencesOverdue ? "#f43f5e" : "var(--mute)" }}>{d.licencesOverdue} overdue</span> });
  if (d.can.employees && d.show("stat_employees"))
    kpis.push({ key: "emp", label: "Active staff", value: d.employeeCount.toLocaleString("en-PK"), icon: <Users className="h-4 w-4" />, hue: HUES[4], foot: <span className="text-[11px] au-mute">on the books</span> });

  return (
    <div className="au-root relative flex-1 min-h-0 overflow-hidden">
      <style>{CSS}</style>
      <div className="au-sky" aria-hidden>
        <div className="au-blob au-b1" /><div className="au-blob au-b2" /><div className="au-blob au-b3" /><div className="au-blob au-b4" />
        <div className="au-grain" />
      </div>
      <div className="absolute inset-0 overflow-y-auto">

      <div className="mx-auto max-w-[1440px] px-3 pb-28 pt-6 md:px-8 md:pt-8">
        {/* Greeting */}
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4 md:mb-8">
          <div>
            <p className="au-chip inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] au-mute">
              <Sparkles className="h-3.5 w-3.5" style={{ color: "#ff5c9a" }} />
              {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
            </p>
            <h1 className="au-disp mt-3 text-[34px] font-semibold leading-[1.05] tracking-tight md:text-[52px]">
              {greeting()}, <span className="au-grad">{first}</span>.
            </h1>
            <p className="mt-2 text-[15px] au-mute">Here’s the pulse of {d.companyName} right now.</p>
          </div>
          {d.can.periodClose && d.show("period_close_status") && (
            <Link to="/super-admin/period-close" className="au-chip flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium">
              {d.periodClosedThisMonth ? <Lock className="h-4 w-4 text-emerald-500" /> : <Unlock className="h-4 w-4 text-amber-500" />}
              {monthLabel(0)} {d.periodClosedThisMonth ? "closed" : "open"}
              {!d.periodClosedThisMonth && d.lastClosedMonth && <span className="au-mute">· last {d.lastClosedMonth.slice(0, 7)}</span>}
            </Link>
          )}
        </div>

        {d.branchScopeNote && <p className="au-chip mb-4 inline-block rounded-full px-3 py-1 text-xs au-mute">{d.branchScopeNote}</p>}
        {d.nothingToShow && (
          <Tile className="mb-5 text-center">
            <p className="au-disp text-lg font-semibold">Nothing to show yet</p>
            <p className="text-sm au-mute">You don’t have any feature permissions yet. Ask a Super Admin to grant you access.</p>
          </Tile>
        )}

        <div className="grid grid-cols-1 gap-4 md:gap-5 lg:grid-cols-12">
          {/* Hero: attendance */}
          {d.can.attendance && (seeAtt || d.show("attendance_trend")) && (
            <Tile className="lg:col-span-8" delay={60}>
              <div className="flex flex-col gap-6 md:flex-row md:items-center">
                {seeAtt && (
                  <div className="relative mx-auto flex-shrink-0 md:mx-0">
                    <Ring pct={d.attendanceTodayPct} />
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="au-disp text-[44px] font-bold leading-none tabular-nums">{d.attendanceTodayPct}<span className="text-xl">%</span></span>
                      <span className="mt-1 text-[11px] uppercase tracking-[.14em] au-mute">present today</span>
                    </div>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <h3 className="au-disp text-[18px] font-semibold">Attendance</h3>
                    {seeAtt && (
                      <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: attDelta >= 0 ? "rgba(16,185,129,.16)" : "rgba(244,63,94,.16)", color: attDelta >= 0 ? "#10b981" : "#f43f5e" }}>
                        {attDelta >= 0 ? "+" : ""}{attDelta}% vs yesterday
                      </span>
                    )}
                  </div>
                  {d.show("attendance_trend") && trendHas ? (
                    <div className="h-[170px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={d.attendanceTrend} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
                          <defs>
                            <linearGradient id="au-a1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7c5cff" stopOpacity={0.55} /><stop offset="100%" stopColor="#7c5cff" stopOpacity={0} /></linearGradient>
                            <linearGradient id="au-a2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ff5c9a" stopOpacity={0.45} /><stop offset="100%" stopColor="#ff5c9a" stopOpacity={0} /></linearGradient>
                            <linearGradient id="au-a3" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ffaa33" stopOpacity={0.45} /><stop offset="100%" stopColor="#ffaa33" stopOpacity={0} /></linearGradient>
                          </defs>
                          <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "var(--mute)", fontSize: 11 }} />
                          <Tooltip content={<GlassTooltip />} cursor={{ stroke: "var(--line)", strokeWidth: 2 }} />
                          <Area type="monotone" dataKey="present" name="Present" stroke="#7c5cff" strokeWidth={2.5} fill="url(#au-a1)" />
                          <Area type="monotone" dataKey="leave" name="Leave" stroke="#ffaa33" strokeWidth={2} fill="url(#au-a3)" />
                          <Area type="monotone" dataKey="absent" name="Absent" stroke="#ff5c9a" strokeWidth={2} fill="url(#au-a2)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-sm au-mute">No attendance recorded in the last 7 days.</p>
                  )}
                </div>
              </div>
            </Tile>
          )}

          {/* Cash */}
          {d.can.accounting && d.show("bank_overview") && (
            <Tile className="lg:col-span-4" delay={120}>
              <TileHead icon={<Landmark className="h-4 w-4" />} title="Cash at bank" hue={HUES[1]} />
              <p className="au-disp text-[34px] font-bold leading-none tracking-tight tabular-nums">{compact(d.totalBankBalance)}</p>
              <p className="mt-1 text-[12px] au-mute">{currency(d.totalBankBalance)} across {d.banks.length} account{d.banks.length === 1 ? "" : "s"}</p>
              {d.banks.length > 0 && d.totalBankBalance > 0 && (
                <div className="mt-4 flex h-3 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
                  {d.banks.filter((b) => b.balance > 0).map((b, i) => (
                    <div key={b.id} title={`${b.bank_name}: ${currency(b.balance)}`} style={{ width: `${(b.balance / d.totalBankBalance) * 100}%`, background: HUES[i % HUES.length] }} />
                  ))}
                </div>
              )}
              <div className="mt-4 space-y-2.5">
                {d.banks.length === 0 ? (
                  <p className="text-sm au-mute">No bank accounts yet.</p>
                ) : d.banks.map((b, i) => (
                  <div key={b.id} className="flex items-center gap-2.5 text-[13px]">
                    <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: HUES[i % HUES.length], boxShadow: `0 0 10px ${HUES[i % HUES.length]}` }} />
                    <span className="flex-1 truncate">{b.bank_name}</span>
                    <span className="font-semibold tabular-nums">{compact(b.balance)}</span>
                  </div>
                ))}
              </div>
            </Tile>
          )}

          {/* KPI tiles */}
          {kpis.map((k, i) => (
            <Tile key={k.key} className={kpiSpan(i, kpis.length)} delay={160 + i * 50}>
              <div className="flex items-start justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl text-white" style={{ background: `linear-gradient(135deg, ${k.hue}, ${k.hue}aa)`, boxShadow: `0 10px 24px -8px ${k.hue}` }}>{k.icon}</span>
                {k.foot}
              </div>
              <p className="au-disp mt-4 text-[32px] font-bold leading-none tracking-tight tabular-nums">{k.value}</p>
              <p className="mt-1.5 text-[13px] au-mute">{k.label}</p>
            </Tile>
          ))}

          {/* Expenses donut */}
          {d.can.expenses && d.show("expenses_pie") && (
            <Tile className="lg:col-span-5" delay={260}>
              <TileHead icon={<Banknote className="h-4 w-4" />} title={`Where spend went · ${monthLabel(0)}`} hue={HUES[2]} />
              {d.expensesPie.length === 0 ? (
                <p className="text-sm au-mute">No expenses recorded this month.</p>
              ) : (
                <div className="flex flex-col items-center gap-4 sm:flex-row">
                  <div className="relative h-[190px] w-[190px] flex-shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={d.expensesPie} dataKey="value" nameKey="name" innerRadius={62} outerRadius={90} paddingAngle={3} cornerRadius={8} stroke="none">
                          {d.expensesPie.map((_, i) => <Cell key={i} fill={HUES[i % HUES.length]} style={{ filter: `drop-shadow(0 0 6px ${HUES[i % HUES.length]}88)` }} />)}
                        </Pie>
                        <Tooltip content={<GlassTooltip />} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-[11px] au-mute">total</span>
                      <span className="au-disp text-[20px] font-bold tabular-nums">{short(expTotal)}</span>
                    </div>
                  </div>
                  <div className="w-full flex-1 space-y-1.5">
                    {d.expensesPie.slice(0, 7).map((r, i) => (
                      <div key={r.name} className="flex items-center gap-2 text-[13px]">
                        <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: HUES[i % HUES.length] }} />
                        <span className="flex-1 truncate">{r.name}</span>
                        <span className="text-[11px] au-mute tabular-nums">{expTotal ? Math.round((r.value / expTotal) * 100) : 0}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Tile>
          )}

          {/* Top clients */}
          {d.can.reports && d.show("top_clients") && (
            <Tile className="lg:col-span-7" delay={300}>
              <TileHead icon={<Sparkles className="h-4 w-4" />} title={`Top clients · ${monthLabel(0)}`} hue={HUES[3]} right={<span className="text-[11px] au-mute">by payments received</span>} />
              {d.topClients.length === 0 ? (
                <p className="text-sm au-mute">No client payments received this month yet.</p>
              ) : (
                <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                  {d.topClients.map((c, i) => {
                    const hue = HUES[i % HUES.length];
                    return (
                      <div key={c.id} className="flex items-center gap-3">
                        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: `linear-gradient(135deg, ${hue}, ${HUES[(i + 2) % HUES.length]})` }}>
                          {initials(c.name)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-[13px] font-medium">{c.name}</span>
                            <span className="text-[12px] font-semibold tabular-nums">{short(c.revenue)}</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
                            <div className="h-full rounded-full" style={{ width: `${Math.max(3, (c.revenue / maxClient) * 100)}%`, background: `linear-gradient(90deg, ${hue}, ${HUES[(i + 2) % HUES.length]})` }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Tile>
          )}

          {/* Compliance */}
          {d.show("compliance_alerts") && (
            <Tile className="lg:col-span-7" delay={340}>
              <TileHead icon={<CalendarClock className="h-4 w-4" />} title="Deadlines · overdue and next 60 days" hue={HUES[3]} right={<span className="au-chip rounded-full px-2 py-0.5 text-[11px] font-semibold">{d.alerts.length}</span>} />
              {d.alerts.length === 0 ? (
                <p className="text-sm au-mute">Nothing overdue or due in the next 60 days. ✨</p>
              ) : (
                <div className="grid max-h-[340px] grid-cols-1 gap-2.5 overflow-y-auto pr-1 sm:grid-cols-2">
                  {d.alerts.map((a) => (
                    <div key={a.id} className="au-chip flex items-center gap-3 rounded-2xl px-3 py-2.5">
                      <Countdown days={a.days_remaining} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{a.title}</p>
                        <p className="truncate text-[11px] au-mute">{a.category} · {formatDate(a.due_date)}</p>
                      </div>
                      {a.days_remaining < 0 && <span className="text-[10px] font-bold uppercase text-rose-500">{daysLabel(a.days_remaining)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </Tile>
          )}

          {/* Activity timeline */}
          <Tile className="lg:col-span-5" delay={380}>
            <TileHead
              icon={<Sparkles className="h-4 w-4" />} title="Live activity" hue={HUES[4]}
              right={<span className="flex items-center gap-1.5 text-[11px] au-mute"><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" /></span>live</span>}
            />
            {d.feedItems.length === 0 ? (
              <p className="text-sm au-mute">No recent activity. Payments, incidents and compliance dates appear here.</p>
            ) : (
              <div className="relative max-h-[340px] overflow-y-auto pl-5">
                <span className="absolute bottom-2 left-[7px] top-2 w-[2px] rounded-full" style={{ background: "linear-gradient(#7c5cff,#ff5c9a,#ffaa33)" }} />
                {d.feedItems.slice(0, 16).map((f) => {
                  const col = f.tone === "in" ? "#10b981" : f.tone === "out" ? "#f43f5e" : "#7c5cff";
                  return (
                    <div key={f.id} className="relative pb-3">
                      <span className="absolute -left-[17px] top-1.5 h-2.5 w-2.5 rounded-full ring-4" style={{ background: col, boxShadow: `0 0 10px ${col}`, ["--tw-ring-color" as string]: "var(--glass)" }} />
                      <p className="text-[13px] leading-snug">{f.text}</p>
                      {f.amount && <p className="text-[12px] font-semibold tabular-nums" style={{ color: col }}>{f.amount}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </Tile>

          {/* Contracts ending */}
          {d.can.contracts && d.show("contracts_ending") && (
            <Tile className="lg:col-span-6" delay={420}>
              <TileHead icon={<FileSignature className="h-4 w-4" />} title="Contracts ending soon" hue={HUES[1]} right={<Link to="/super-admin/contracts" className="text-[12px] font-medium au-mute hover:underline">All →</Link>} />
              {d.contractsEnding.length === 0 ? (
                <p className="text-sm au-mute">No active contracts ending in the next 60 days.</p>
              ) : (
                <div className="-mx-1">
                  {d.contractsEnding.map((c, i) => (
                    <div key={c.id} className={`flex items-center gap-3 px-1 py-2.5 ${i ? "au-row" : ""}`}>
                      <div className="flex h-11 w-11 flex-shrink-0 flex-col items-center justify-center rounded-2xl" style={{ background: c.days_left <= 7 ? "rgba(244,63,94,.15)" : c.days_left <= 30 ? "rgba(255,170,51,.18)" : "rgba(0,194,184,.15)" }}>
                        <span className="au-disp text-[15px] font-bold leading-none tabular-nums">{c.days_left}</span>
                        <span className="text-[9px] au-mute">days</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{c.client_name}</p>
                        <p className="text-[11px] au-mute">{c.code} · ends {formatDate(c.end_date)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Tile>
          )}

          {/* Incidents */}
          {d.can.incidents && d.show("incidents_recent") && (
            <Tile className="lg:col-span-6" delay={460}>
              <TileHead icon={<Siren className="h-4 w-4" />} title="Recent incidents · 30 days" hue="#f43f5e" right={<Link to="/super-admin/incidents" className="text-[12px] font-medium au-mute hover:underline">All →</Link>} />
              {d.recentIncidents.length === 0 ? (
                <p className="text-sm au-mute">No incidents in the last 30 days. 🌿</p>
              ) : (
                <div className="-mx-1">
                  {d.recentIncidents.map((i, idx) => {
                    const col = i.severity === "critical" ? "#f43f5e" : i.severity === "high" ? "#fb7185" : i.severity === "medium" ? "#ffaa33" : "#94a3b8";
                    return (
                      <div key={i.id} className={`flex items-center gap-3 px-1 py-2.5 ${idx ? "au-row" : ""}`}>
                        <span className="rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide" style={{ background: `${col}26`, color: col }}>{i.severity}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium capitalize">{humanize(i.category)}</p>
                          <p className="text-[11px] au-mute">{i.code} · {new Date(i.occurred_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>
                        </div>
                        <span className="text-[11px] capitalize au-mute">{humanize(i.status)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Tile>
          )}

          <div className="lg:col-span-12">
            <DashboardAttachments />
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
