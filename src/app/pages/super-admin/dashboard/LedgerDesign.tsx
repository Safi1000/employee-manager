import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import DashboardAttachments from "../../../components/DashboardAttachments";
import { formatDate } from "../../../lib/date";
import {
  type DashData, currency, daysLabel, ensureFont, humanize, monthLabel, pctChange, short,
} from "./shared";

// THE LEDGER — the dashboard as a morning broadsheet. Paper by day; in dark
// mode it prints the night edition (ink-black stock, paper-white type).

const CSS = `
.lg-root{--paper:#f3ede1;--ink:#1b1712;--mute:#6b6256;--rule:#1b1712;--hair:#c9bfae;--red:#8c1c13;--tint:#e9e1d1;
  background:var(--paper);color:var(--ink);font-family:'Newsreader',Georgia,serif;position:relative}
.dark .lg-root{--paper:#14110d;--ink:#ece4d4;--mute:#a39a8a;--rule:#ece4d4;--hair:#3b342b;--red:#e2614f;--tint:#1d1914}
.lg-root:before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.35;mix-blend-mode:multiply;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .4  0 0 0 0 .33  0 0 0 0 .2  0 0 0 .22 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")}
.dark .lg-root:before{mix-blend-mode:screen;opacity:.12}
.lg-black{font-family:'UnifrakturMaguntia','Old English Text MT',serif;font-weight:400}
.lg-head{font-family:'Playfair Display',Georgia,serif}
.lg-sans{font-family:'Libre Franklin','Hanken Grotesk',system-ui,sans-serif}
.lg-num{font-family:'Playfair Display',Georgia,serif;font-variant-numeric:lining-nums tabular-nums}
.lg-kicker{font-family:'Libre Franklin',system-ui,sans-serif;font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;font-weight:700;color:var(--red)}
.lg-rule{border-color:var(--rule)}
.lg-hair{border-color:var(--hair)}
.lg-mute{color:var(--mute)}
.lg-red{color:var(--red)}
.lg-drop:first-letter{font-family:'Playfair Display',Georgia,serif;float:left;font-size:4.1em;line-height:.82;padding:.06em .08em 0 0;font-weight:900;color:var(--red)}
.lg-leader{flex:1;border-bottom:1px dotted var(--mute);transform:translateY(-4px);margin:0 6px;min-width:12px}
.lg-in{animation:lg-in .9s cubic-bezier(.2,.7,.2,1) both}
@keyframes lg-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.lg-a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--hair);text-underline-offset:3px}
.lg-a:hover{text-decoration-color:var(--red);color:var(--red)}
.lg-col>*+*{border-left:1px solid var(--hair)}
@media (max-width:1023px){.lg-col>*+*{border-left:0;border-top:1px solid var(--hair)}}
`;

const HATCH = ["solid", "hatch", "dots", "cross", "solid2", "hatch2", "dots2", "plain"] as const;

function Section({ kicker, title, children, aside }: { kicker: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="px-0 py-5 lg:px-6">
      <p className="lg-kicker">{kicker}</p>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="lg-head mt-1 text-[22px] font-bold leading-tight">{title}</h3>
        {aside}
      </div>
      <div className="mt-2 border-t lg-rule" />
      <div className="mt-3">{children}</div>
    </section>
  );
}

function AttendanceFigure({ d }: { d: DashData }) {
  const pts = d.attendanceTrend.map((p) => {
    const t = p.present + p.absent + p.leave;
    return { ...p, t, pct: t ? (p.present / t) * 100 : null };
  });
  const W = 640;
  const H = 210;
  const L = 34;
  const B = 28;
  const T = 14;
  const vals = pts.map((p) => p.pct).filter((v): v is number => v != null);
  const lo = Math.max(0, Math.floor((Math.min(...vals, 100) - 5) / 10) * 10);
  const hi = 100;
  const x = (i: number) => L + (i * (W - L - 10)) / Math.max(1, pts.length - 1);
  const y = (v: number) => T + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - T - B);
  const path = pts
    .map((p, i) => (p.pct == null ? null : `${x(i)},${y(p.pct)}`))
    .filter(Boolean)
    .join(" L ");
  const ticks = [lo, lo + (hi - lo) / 2, hi];
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Share of guards present, last seven days">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - 6} y1={y(t)} y2={y(t)} stroke="var(--hair)" strokeDasharray="2 3" />
            <text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--mute)" fontFamily="Libre Franklin">{Math.round(t)}%</text>
          </g>
        ))}
        {path && <path d={`M ${path} L ${x(pts.length - 1)},${H - B} L ${x(0)},${H - B} Z`} fill="var(--tint)" opacity=".9" />}
        {path && <path d={`M ${path}`} fill="none" stroke="var(--ink)" strokeWidth="2" />}
        {pts.map((p, i) => (
          <g key={p.date}>
            {p.pct != null && <circle cx={x(i)} cy={y(p.pct)} r={i === pts.length - 1 ? 5 : 3} fill={i === pts.length - 1 ? "var(--red)" : "var(--paper)"} stroke="var(--ink)" strokeWidth="1.5" />}
            {p.pct != null && i === pts.length - 1 && (
              <text x={x(i) - 8} y={y(p.pct) - 10} textAnchor="end" fontSize="13" fontWeight="700" fill="var(--red)" fontFamily="Playfair Display">{Math.round(p.pct)}%</text>
            )}
            <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--mute)" fontFamily="Libre Franklin" letterSpacing=".08em">{p.label.toUpperCase()}</text>
          </g>
        ))}
      </svg>
      <figcaption className="lg-sans mt-1 text-[11px] lg-mute">
        <span className="font-bold" style={{ color: "var(--ink)" }}>Fig. 1</span> — Share of rostered guards marked present, by day. Source: attendance records.
      </figcaption>
    </figure>
  );
}

function Pattern({ kind, color }: { kind: (typeof HATCH)[number]; color: string }) {
  const id = `lg-p-${kind}`;
  return (
    <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform={kind.startsWith("hatch") ? `rotate(${kind === "hatch" ? 45 : -45})` : undefined}>
      <rect width="6" height="6" fill={kind === "plain" ? "var(--tint)" : "var(--paper)"} />
      {kind.startsWith("solid") && <rect width="6" height="6" fill={kind === "solid" ? color : "var(--mute)"} />}
      {kind.startsWith("hatch") && <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeWidth="2" />}
      {kind.startsWith("dots") && <circle cx="3" cy="3" r={kind === "dots" ? 1.3 : 0.9} fill={color} />}
      {kind === "cross" && <path d="M0 0 L6 6 M6 0 L0 6" stroke={color} strokeWidth=".9" />}
    </pattern>
  );
}

export default function LedgerDesign({ d }: { d: DashData }) {
  useEffect(() => {
    ensureFont(
      "font-ledger",
      "https://fonts.googleapis.com/css2?family=UnifrakturMaguntia&family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=Libre+Franklin:wght@400;600;700&display=swap",
    );
  }, []);

  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86_400_000);
  const dateLine = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const seeAtt = d.can.attendance && d.show("stat_attendance_today");
  const seePay = d.can.payroll && d.show("stat_payroll_mtd");
  const seeExp = d.can.expenses && d.show("stat_expenses_mtd");
  const seeCmp = d.can.compliance && d.show("stat_licences_expiring");
  const overdue = d.alerts.filter((a) => a.days_remaining < 0);

  // The lead story is written from the figures this reader may see, and only
  // those. Every clause is a number already on the page.
  let headline = "A Quiet Day on the Books";
  if (overdue.length > 0 && seeAtt) headline = `${overdue.length} Deadline${overdue.length > 1 ? "s" : ""} Pass Unmet as ${d.attendanceTodayPct}% of Guards Report for Duty`;
  else if (overdue.length > 0) headline = `${overdue.length} Deadline${overdue.length > 1 ? "s" : ""} Pass Unmet; Compliance Desk on Notice`;
  else if (seePay && d.payrollMtd > 0 && seeAtt) headline = `Payroll Reaches ${short(d.payrollMtd)} as Attendance Holds at ${d.attendanceTodayPct}%`;
  else if (seeAtt) headline = `${d.attendanceTodayPct}% of the Force Reports for Duty`;
  else if (seePay && d.payrollMtd > 0) headline = `Payroll Reaches ${short(d.payrollMtd)} for ${monthLabel(0)}`;

  const attDelta = d.attendanceTodayPct - d.attendanceYesterdayPct;
  const deck: string[] = [];
  if (seeAtt) deck.push(`Turnout ${attDelta === 0 ? "unchanged" : attDelta > 0 ? `up ${attDelta} points` : `down ${Math.abs(attDelta)} points`} on yesterday`);
  if (d.can.incidents && d.show("stat_open_incidents")) deck.push(d.openIncidents === 0 ? "no incidents open" : `${d.openIncidents} incident${d.openIncidents > 1 ? "s" : ""} still open`);
  if (d.can.contracts && d.show("stat_active_contracts")) deck.push(`${d.activeContracts} contracts in force`);

  const story: string[] = [];
  if (d.can.employees && d.show("stat_employees")) story.push(`${d.companyName} carries ${d.employeeCount.toLocaleString("en-PK")} active staff on its books this morning.`);
  if (seeAtt) story.push(`Of those rostered today, ${d.attendanceTodayPct} per cent were marked present, against ${d.attendanceYesterdayPct} per cent yesterday.`);
  if (seePay) {
    const c = pctChange(d.payrollMtd, d.payrollPrev);
    story.push(`Disbursed payroll for ${monthLabel(0)} stands at ${currency(d.payrollMtd)}${c == null ? "" : `, ${c >= 0 ? "up" : "down"} ${Math.abs(c).toFixed(0)} per cent on ${monthLabel(-1)}`}.`);
  }
  if (seeExp) {
    const c = pctChange(d.expensesMtd, d.expensesPrev);
    story.push(`Spending has run to ${currency(d.expensesMtd)}${c == null ? "" : ` — ${c >= 0 ? "higher" : "lower"} than last month by ${Math.abs(c).toFixed(0)} per cent`}.`);
  }
  if (seeCmp) story.push(d.licencesExpiring === 0 ? "No guard faces a lapsing licence or document within thirty days." : `${d.licencesExpiring} guard${d.licencesExpiring > 1 ? "s face" : " faces"} a lapsing document within thirty days${d.licencesOverdue ? `, ${d.licencesOverdue} of them already past due` : ""}.`);
  if (d.can.accounting && d.show("bank_overview") && d.banks.length) story.push(`Cash at bank across ${d.banks.length} account${d.banks.length > 1 ? "s" : ""} totals ${currency(d.totalBankBalance)}.`);
  if (story.length === 0) story.push("There is nothing on the wire for this reader today. A Super Admin can widen your access.");

  const expTotal = d.expensesPie.reduce((s, r) => s + r.value, 0);
  const maxClient = Math.max(1, ...d.topClients.map((c) => c.revenue));
  const inkPalette = ["var(--ink)", "var(--red)", "var(--ink)", "var(--ink)", "var(--red)", "var(--ink)", "var(--red)", "var(--ink)"];

  return (
    <div className="lg-root relative flex-1 min-h-0 overflow-hidden">
      <style>{CSS}</style>
      <div className="absolute inset-0 z-[1] overflow-y-auto">
      <div className="relative mx-auto max-w-[1280px] px-4 pb-24 pt-6 md:px-10">
        {/* Masthead */}
        <div className="lg-sans flex flex-wrap items-center justify-between gap-2 border-b lg-hair pb-2 text-[10.5px] uppercase tracking-[.16em] lg-mute">
          <span>Vol. {now.getFullYear() - 2023} · No. {dayOfYear}</span>
          <span className="hidden md:inline">{d.companyName} Edition</span>
          <span>{dateLine}</span>
        </div>
        <h1 className="lg-black lg-in mt-3 text-center text-[44px] leading-none sm:text-[64px] md:text-[86px]">The Bastion Ledger</h1>
        <p className="lg-head mt-2 text-center text-[13px] italic lg-mute">“All the figures fit to print.”</p>
        <div className="mt-3 border-t-[3px] lg-rule" />
        <div className="mt-[3px] border-t lg-rule" />
        <div className="lg-sans flex flex-wrap items-center justify-center gap-x-6 gap-y-1 border-b lg-rule py-2 text-[11px] font-semibold uppercase tracking-[.2em]">
          <span>Operations</span><span className="lg-red">◆</span><span>Finance</span><span className="lg-red">◆</span><span>Compliance</span><span className="lg-red">◆</span><span>Clients</span>
          {d.can.periodClose && d.show("period_close_status") && (
            <span className="lg-mute">· Books {d.periodClosedThisMonth ? "closed" : "open"} for {monthLabel(0)}</span>
          )}
        </div>

        {d.branchScopeNote && <p className="lg-sans mt-3 text-center text-xs italic lg-mute">Regional edition — {d.branchScopeNote}</p>}

        {/* Front page */}
        <div className="lg-col mt-2 grid grid-cols-1 lg:grid-cols-12">
          <article className="lg-in py-5 lg:col-span-8 lg:pr-6" style={{ animationDelay: "120ms" }}>
            <p className="lg-kicker">Lead · Operations &amp; Finance</p>
            <h2 className="lg-head mt-2 text-[34px] font-black leading-[1.05] tracking-tight md:text-[48px]">{headline}</h2>
            {deck.length > 0 && <p className="lg-head mt-3 text-[19px] italic leading-snug lg-mute">{deck.join("; ").replace(/^./, (c) => c.toUpperCase())}.</p>}
            <p className="lg-sans mt-3 text-[11px] uppercase tracking-[.14em] lg-mute">By the Ledger Desk · filed {now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</p>
            <div className="mt-4 gap-6 text-[16.5px] leading-[1.6] md:columns-2" style={{ columnRule: "1px solid var(--hair)" }}>
              <p className="lg-drop">{story.join(" ")}</p>
            </div>
            {d.can.attendance && d.show("attendance_trend") && !d.attendanceTrend.every((p) => p.present + p.absent + p.leave === 0) && (
              <div className="mt-6 border-t lg-hair pt-4">
                <AttendanceFigure d={d} />
              </div>
            )}
          </article>

          <aside className="lg-in py-5 lg:col-span-4 lg:pl-6" style={{ animationDelay: "220ms" }}>
            {(seePay || seeExp) && (
              <div className="border-2 lg-rule p-4">
                <p className="lg-kicker text-center">The Month in Figures</p>
                <div className="mt-3 grid grid-cols-2 divide-x lg-hair">
                  {seePay && (
                    <div className="px-2 text-center">
                      <p className="lg-sans text-[10px] uppercase tracking-[.16em] lg-mute">Payroll</p>
                      <p className="lg-num text-[30px] font-black leading-tight">{short(d.payrollMtd)}</p>
                      <Change curr={d.payrollMtd} prev={d.payrollPrev} />
                    </div>
                  )}
                  {seeExp && (
                    <div className="px-2 text-center">
                      <p className="lg-sans text-[10px] uppercase tracking-[.16em] lg-mute">Expenses</p>
                      <p className="lg-num text-[30px] font-black leading-tight">{short(d.expensesMtd)}</p>
                      <Change curr={d.expensesMtd} prev={d.expensesPrev} invert />
                    </div>
                  )}
                </div>
              </div>
            )}

            {d.can.accounting && d.show("bank_overview") && (
              <div className="mt-6">
                <p className="lg-kicker">Markets</p>
                <h3 className="lg-head text-[22px] font-bold">Cash at Bank</h3>
                <div className="mt-2 border-t-2 lg-rule" />
                {d.banks.length === 0 ? (
                  <p className="mt-2 text-sm italic lg-mute">No accounts listed.</p>
                ) : (
                  <table className="lg-sans mt-1 w-full text-[13px]">
                    <thead>
                      <tr className="border-b lg-hair text-[10px] uppercase tracking-[.14em] lg-mute">
                        <th className="py-1.5 text-left font-semibold">Account</th>
                        <th className="py-1.5 text-right font-semibold">Balance</th>
                        <th className="py-1.5 text-right font-semibold">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.banks.map((b) => (
                        <tr key={b.id} className="border-b lg-hair">
                          <td className="py-1.5 pr-2 font-semibold">{b.bank_name}</td>
                          <td className="lg-num py-1.5 text-right">{Math.round(b.balance).toLocaleString("en-PK")}</td>
                          <td className="py-1.5 text-right lg-mute tabular-nums">{d.totalBankBalance ? `${((b.balance / d.totalBankBalance) * 100).toFixed(1)}%` : "—"}</td>
                        </tr>
                      ))}
                      <tr className="border-t-2 lg-rule">
                        <td className="py-2 font-bold uppercase tracking-wider text-[11px]">Total (PKR)</td>
                        <td className="lg-num py-2 text-right text-[15px] font-black" colSpan={2}>{Math.round(d.totalBankBalance).toLocaleString("en-PK")}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            )}

            <div className="mt-6 grid grid-cols-2 gap-3">
              {d.can.contracts && d.show("stat_active_contracts") && <Stat label="Contracts in force" value={d.activeContracts} />}
              {d.can.incidents && d.show("stat_open_incidents") && <Stat label="Incidents open" value={d.openIncidents} red={d.openIncidents > 0} />}
              {d.can.employees && d.show("stat_employees") && <Stat label="Staff on books" value={d.employeeCount} />}
              {seeCmp && <Stat label="Documents lapsing" value={d.licencesExpiring} red={d.licencesOverdue > 0} note={d.licencesOverdue ? `${d.licencesOverdue} overdue` : undefined} />}
            </div>
          </aside>
        </div>

        <div className="border-t-[3px] lg-rule" />
        <div className="mt-[3px] border-t lg-rule" />

        {/* Second band */}
        <div className="lg-col grid grid-cols-1 lg:grid-cols-3">
          {d.show("compliance_alerts") && (
            <Section kicker="Classifieds" title="Notices & Deadlines">
              {d.alerts.length === 0 ? (
                <p className="italic lg-mute">No notices this week. Nothing is due inside sixty days.</p>
              ) : (
                <div className="space-y-2.5">
                  {d.alerts.slice(0, 12).map((a) => (
                    <div key={a.id} className={`border p-2.5 ${a.days_remaining < 0 ? "border-2" : ""}`} style={{ borderColor: a.days_remaining < 0 ? "var(--red)" : "var(--hair)" }}>
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="lg-head text-[15px] font-bold leading-tight">{a.title}</p>
                        <span className={`lg-sans whitespace-nowrap text-[10px] font-bold uppercase tracking-wider ${a.days_remaining <= 7 ? "lg-red" : "lg-mute"}`}>{daysLabel(a.days_remaining)}</span>
                      </div>
                      <p className="lg-sans mt-0.5 text-[11px] lg-mute">{a.category} — due {formatDate(a.due_date)}</p>
                    </div>
                  ))}
                  {d.alerts.length > 12 && <p className="lg-sans text-[11px] italic lg-mute">…and {d.alerts.length - 12} further notices.</p>}
                </div>
              )}
            </Section>
          )}
          {d.can.contracts && d.show("contracts_ending") && (
            <Section kicker="Business" title="Contracts Nearing Term" aside={<Link to="/super-admin/contracts" className="lg-a lg-sans text-[11px]">All contracts</Link>}>
              {d.contractsEnding.length === 0 ? (
                <p className="italic lg-mute">No contract runs out in the next sixty days.</p>
              ) : (
                <ul className="divide-y lg-hair">
                  {d.contractsEnding.map((c) => (
                    <li key={c.id} className="flex items-baseline gap-3 py-2">
                      <span className={`lg-num w-12 text-right text-[26px] font-black leading-none ${c.days_left <= 30 ? "lg-red" : ""}`}>{c.days_left}</span>
                      <span className="lg-sans text-[9px] uppercase leading-tight tracking-wider lg-mute">days<br />left</span>
                      <div className="min-w-0 flex-1">
                        <p className="lg-head truncate text-[15px] font-bold">{c.client_name}</p>
                        <p className="lg-sans text-[11px] lg-mute">{c.code} · ends {formatDate(c.end_date)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
          {d.can.incidents && d.show("incidents_recent") && (
            <Section kicker="Security" title="The Incident Blotter" aside={<Link to="/super-admin/incidents" className="lg-a lg-sans text-[11px]">Full log</Link>}>
              {d.recentIncidents.length === 0 ? (
                <p className="italic lg-mute">A clean month: no incidents reported in thirty days.</p>
              ) : (
                <div className="space-y-3 text-[14.5px] leading-snug">
                  {d.recentIncidents.map((i) => (
                    <p key={i.id}>
                      <span className="lg-sans text-[10px] font-bold uppercase tracking-wider lg-red">{i.severity}</span>{" "}
                      <span className="font-semibold capitalize">{humanize(i.category)}</span>
                      <span className="lg-mute">, {new Date(i.occurred_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. Case {i.code}; status {humanize(i.status)}.</span>
                    </p>
                  ))}
                </div>
              )}
            </Section>
          )}
        </div>

        <div className="border-t-2 lg-rule" />

        {/* Third band */}
        <div className="lg-col grid grid-cols-1 lg:grid-cols-3">
          {d.can.reports && d.show("top_clients") && (
            <Section kicker={`Sport · ${monthLabel(0)}`} title="The League Table">
              {d.topClients.length === 0 ? (
                <p className="italic lg-mute">No payments received this month; the table is empty.</p>
              ) : (
                <ol className="space-y-1.5">
                  {d.topClients.map((c, i) => (
                    <li key={c.id}>
                      <div className="flex items-baseline">
                        <span className={`lg-num w-7 text-[17px] font-black ${i === 0 ? "lg-red" : ""}`}>{i + 1}</span>
                        <span className="truncate text-[15px]">{c.name}</span>
                        <span className="lg-leader" />
                        <span className="lg-num text-[14px] font-bold">{short(c.revenue)}</span>
                      </div>
                      <div className="ml-7 mt-0.5 h-[3px]" style={{ background: "var(--tint)" }}>
                        <div className="h-full" style={{ width: `${(c.revenue / maxClient) * 100}%`, background: i === 0 ? "var(--red)" : "var(--ink)" }} />
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          )}
          {d.can.expenses && d.show("expenses_pie") && (
            <Section kicker={`Economy · ${monthLabel(0)}`} title="Where the Rupee Went">
              {d.expensesPie.length === 0 ? (
                <p className="italic lg-mute">Nothing spent this month.</p>
              ) : (
                <>
                  <svg viewBox="0 0 300 34" className="w-full" preserveAspectRatio="none">
                    <defs>{HATCH.map((h, i) => <Pattern key={h} kind={h} color={inkPalette[i]} />)}</defs>
                    {(() => {
                      let acc = 0;
                      const top = d.expensesPie.slice(0, HATCH.length);
                      return top.map((r, i) => {
                        const w = expTotal ? (r.value / expTotal) * 300 : 0;
                        const el = <rect key={r.name} x={acc} y={0} width={Math.max(0, w - 1)} height={34} fill={`url(#lg-p-${HATCH[i]})`} stroke="var(--ink)" strokeWidth=".6" />;
                        acc += w;
                        return el;
                      });
                    })()}
                  </svg>
                  <ul className="mt-3 space-y-1.5">
                    {d.expensesPie.slice(0, HATCH.length).map((r, i) => (
                      <li key={r.name} className="flex items-center text-[14px]">
                        <svg width="14" height="14" className="mr-2 flex-shrink-0"><rect width="14" height="14" fill={`url(#lg-p-${HATCH[i]})`} stroke="var(--ink)" strokeWidth="1" /></svg>
                        <span className="truncate">{r.name}</span>
                        <span className="lg-leader" />
                        <span className="lg-sans mr-2 text-[11px] lg-mute">{expTotal ? Math.round((r.value / expTotal) * 100) : 0}%</span>
                        <span className="lg-num font-bold">{short(r.value)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="lg-sans mt-2 text-right text-[11px] lg-mute">Total {currency(expTotal)}</p>
                </>
              )}
            </Section>
          )}
          <Section kicker="Wire" title="In Brief">
            {d.feedItems.length === 0 ? (
              <p className="italic lg-mute">The wire is quiet. Payments, incidents and deadlines appear here as they land.</p>
            ) : (
              <ul className="space-y-2 text-[14.5px] leading-snug">
                {d.feedItems.slice(0, 14).map((f) => (
                  <li key={f.id} className="flex gap-2">
                    <span className={`mt-[3px] text-[10px] ${f.tone === "out" ? "lg-red" : ""}`}>{f.tone === "in" ? "▲" : f.tone === "out" ? "■" : "◆"}</span>
                    <span>
                      {f.text}
                      {f.amount && <span className="lg-num font-bold"> {f.amount}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        {d.can.periodClose && d.show("period_close_status") && (
          <div className="mt-2 border-y-2 lg-rule py-3 text-center">
            <p className="lg-head text-[15px] italic">
              <span className="lg-sans mr-2 text-[10px] font-bold not-italic uppercase tracking-[.18em] lg-red">Editor’s note</span>
              {d.periodClosedThisMonth
                ? `The books for ${monthLabel(0)} are closed; no further entries may be written to the month.`
                : `The books for ${monthLabel(0)} remain open. ${d.lastClosedMonth ? `The last month closed was ${d.lastClosedMonth.slice(0, 7)}.` : "No month has yet been closed."}`}{" "}
              <Link to="/super-admin/period-close" className="lg-a not-italic">Period close</Link>
            </p>
          </div>
        )}

        <div className="mt-8">
          <DashboardAttachments />
        </div>
        <p className="lg-sans mt-10 text-center text-[10px] uppercase tracking-[.2em] lg-mute">Printed and published by {d.companyName} · Bastion</p>
      </div>
      </div>
    </div>
  );
}

function Change({ curr, prev, invert = false }: { curr: number; prev: number; invert?: boolean }) {
  const c = pctChange(curr, prev);
  if (c == null) return <p className="lg-sans text-[11px] lg-mute">no prior month</p>;
  const good = invert ? c <= 0 : c >= 0;
  return (
    <p className={`lg-sans text-[11px] font-semibold ${good ? "" : "lg-red"}`}>
      {c >= 0 ? "▲" : "▼"} {Math.abs(c).toFixed(0)}% <span className="font-normal lg-mute">vs {monthLabel(-1)}</span>
    </p>
  );
}

function Stat({ label, value, red = false, note }: { label: string; value: number; red?: boolean; note?: string }) {
  return (
    <div className="border-t-2 lg-rule pt-2">
      <p className={`lg-num text-[34px] font-black leading-none ${red ? "lg-red" : ""}`}>{value.toLocaleString("en-PK")}</p>
      <p className="lg-sans mt-1 text-[10px] uppercase tracking-[.14em] lg-mute">{label}</p>
      {note && <p className="lg-sans text-[10px] font-bold uppercase tracking-wider lg-red">{note}</p>}
    </div>
  );
}
