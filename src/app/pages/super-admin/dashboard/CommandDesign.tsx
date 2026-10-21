import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import DetailSheet, { type DetailContent } from "../../../components/DetailSheet";
import DashboardAttachments from "../../../components/DashboardAttachments";
import { formatDate } from "../../../lib/date";
import type { DashData } from "./shared";
import type { CommandData, SiteTile } from "./useCommandData";

/**
 * THE COMMAND DASHBOARD — the home screen, built for a guarding business:
 * guards on post first, then where the month lands, whether payday is covered,
 * where cash went, which clients earn, who owes, each region, what is due, and
 * what is happening. Every tile, bar, dot and row opens a detail sheet with a
 * way through to the record.
 *
 * Figures come from the classic dashboard queries (DashData) and the command
 * additions (useCommandData). Panels whose data the user cannot read, or that a
 * function did not return, are left out rather than shown as zero.
 */

const fmt = (n: number) => `${n < 0 ? "−" : ""}${Math.abs(Math.round(n)).toLocaleString("en-PK")}`;
const mil = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : `${Math.round(a)}`;
  return `${n < 0 ? "−" : ""}${s}`;
};
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const AGE = [
  { label: "0–30 days", color: "#2f5d8a" },
  { label: "31–60", color: "#7fa3c4" },
  { label: "61–90", color: "#e9a73c" },
  { label: "90+", color: "#a3392a" },
] as const;

function Card({ kicker, title, aside, children, className = "" }: { kicker: string; title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`bg-card border border-border rounded-[18px] p-4 md:p-5 flex flex-col gap-3.5 min-w-0 ${className}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="lbl">{kicker}</p>
          {title && <h2 className="font-display text-lg md:text-[22px] font-bold tracking-tight text-foreground mt-1">{title}</h2>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Hit({ onClick, children, className = "", label }: { onClick: () => void; children: ReactNode; className?: string; label?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className={`group w-full text-left ${className}`}>
      {children}
    </button>
  );
}

export default function CommandDesign({ d, c }: { d: DashData; c: CommandData | null }) {
  const [sheet, setSheet] = useState<DetailContent | null>(null);
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysToPayday = daysInMonth - dayOfMonth + 1;

  // ---- right now ----
  const sites = c?.sites ?? null;
  // Unmarked clients are left out of the cover figure entirely: their guards
  // may well be on post, the register just has not been filled in yet.
  const markedSites = sites ? sites.filter((x) => x.marked > 0) : [];
  const unmarked = sites ? sites.filter((x) => x.marked === 0 && x.contracted > 0) : [];
  const contracted = markedSites.reduce((s, x) => s + x.contracted, 0);
  const onPost = markedSites.reduce((s, x) => s + Math.min(x.onPost, x.contracted || x.onPost), 0);
  const short = markedSites.filter((x) => x.contracted > x.onPost);
  const shortHeads = short.reduce((s, x) => s + (x.contracted - x.onPost), 0);
  const coverPct = contracted > 0 ? onPost / contracted : d.attendanceTodayPct / 100;
  const C = 2 * Math.PI * 54;

  const cashTotal = d.totalBankBalance + (c?.cashInHand ?? 0);
  const ar = c?.receivables ?? null;
  const ar90 = ar && ar.total > 0 ? ar.buckets[3] / ar.total : 0;

  // ---- payday ----
  // The next run needs about last month's payroll in full — every payslip,
  // paid or not — not only the part already disbursed.
  const payNeed = c?.payrollLastFull || d.payrollPrev || d.payrollMtd;
  const dueFirst = ar ? ar.buckets[0] : 0;
  const payScale = Math.max(cashTotal + dueFirst, payNeed, 1) * 1.05;
  const spare = cashTotal + dueFirst - payNeed;

  const attention = [
    d.can.compliance && d.licencesOverdue > 0 && { n: d.licencesOverdue, text: "guards with an expired document", to: "/super-admin/compliance" },
    d.can.compliance && d.licencesExpiring - d.licencesOverdue > 0 && { n: d.licencesExpiring - d.licencesOverdue, text: "guard documents expiring in 30 days", to: "/super-admin/compliance" },
    d.can.incidents && d.openIncidents > 0 && { n: d.openIncidents, text: "open incidents", to: "/super-admin/incidents" },
    d.can.contracts && d.contractsEnding.length > 0 && { n: d.contractsEnding.length, text: "contracts ending in 60 days", to: "/super-admin/contracts" },
    d.can.periodClose && d.periodClosedThisMonth === false && d.lastClosedMonth && { n: "!", text: `last closed: ${formatDate(d.lastClosedMonth)}`, to: "/super-admin/period-close" },
    // A week out from payday and the money in hand plus what clients owe
    // inside 30 days will not cover last month's payroll.
    d.can.accounting && d.can.payroll && c && ar && payNeed > 0 && daysToPayday <= 7 && spare < 0 && { n: mil(-spare), text: `short for the salary run in ${daysToPayday} day${daysToPayday === 1 ? "" : "s"}`, to: "/super-admin/payroll" },
  ].filter(Boolean) as { n: number | string; text: string; to: string }[];

  // ---- run rate ----
  // Billing is by SERVICE month: the month being billed now is last month.
  const billLabel = c ? new Date(`${c.billMonth}T00:00:00`).toLocaleDateString(undefined, { month: "long" }) : "";
  const prevLabel = c ? new Date(new Date(`${c.billMonth}T00:00:00`).getFullYear(), new Date(`${c.billMonth}T00:00:00`).getMonth() - 1, 1).toLocaleDateString(undefined, { month: "long" }) : "";
  const billed = c?.billed ?? null;
  const billedPrev = c?.billedPrev ?? null;

  // ---- cash this month ----
  // From the ledger (2026-10-21): every bank and cash account's opening and
  // closing are its own rows, and each step is that month's postings by source
  // — the same grouping as the Accountant's grid. The old version worked the
  // opening backwards from today and three flows, so any transfer, advance or
  // partner draw left it wrong.
  const cm = c?.cashMonth ?? null;
  const fall = useMemo(() => {
    if (!cm) return [];
    const steps: { label: string; v: number; kind?: "edge"; to: string }[] = [
      { label: "Start of month", v: cm.opening, kind: "edge", to: "/super-admin/accounting" },
      ...cm.flows.map((f) => ({ label: f.label, v: f.v, to: f.key === "clients" ? "/super-admin/invoices" : f.key === "salaries" ? "/super-admin/payroll" : f.key === "expenses" || f.key === "advances" ? "/super-admin/expenses" : "/super-admin/accounting" })),
      { label: "Today", v: cm.closing, kind: "edge", to: "/super-admin/accounting" },
    ];
    let run = 0, top = 1;
    for (const st of steps) { run = st.kind ? st.v : run + st.v; top = Math.max(top, run, st.kind ? st.v : 0); }
    run = 0;
    return steps.map((st) => {
      let from: number, to: number;
      if (st.kind === "edge") { from = 0; to = st.v; run = st.v; } else { from = run; to = run + st.v; run = to; }
      const lo = Math.max(0, Math.min(from, to)), hi = Math.max(from, to);
      return { ...st, left: (lo / top) * 100, width: Math.max(0.6, ((hi - lo) / top) * 100) };
    });
  }, [cm]);

  // ---- client map ----
  const dots = (c?.clientMap?.rows ?? []).filter((r) => r.revenue > 0);
  const maxRev = Math.max(1, ...dots.map((r) => r.revenue)) * 1.1;
  const margins = dots.map((r) => r.net / r.revenue);
  // Clamp the scale: a client with no payroll recorded reads ~100% and would
  // squash everyone else into a strip. Outliers sit on the edge; the sheet has
  // the real figure.
  const mHi = Math.min(0.6, Math.max(0.25, ...margins)), mLo = Math.max(-0.3, Math.min(0, ...margins));

  // ---- timeline ----
  const dues = d.alerts.filter((a) => a.days_remaining <= 30).slice(0, 10);

  const openSite = (s: SiteTile) => setSheet({
    kicker: `${s.region} · as marked ${c?.asOf ? formatDate(c.asOf) : "today"}`,
    title: s.name,
    big: `${s.onPost} / ${s.contracted || "—"} on strength`,
    note: s.marked === 0 ? "No attendance has been marked for this client on this day yet, so cover cannot be read. Mark the register to see it here." :
      s.contracted === 0 ? "Guards are marked for this client but no contracted heads were found for the month — cover the company absorbs." :
      s.onPost < s.contracted ? `${s.contracted - s.onPost} head${s.contracted - s.onPost > 1 ? "s" : ""} short of contract${s.absent ? ` — ${s.absent} marked absent` : ""}. Send a reliever from the roster, or check the attendance has been marked.` :
      `Every contracted head is filled${s.onLeave ? ` — ${s.onLeave} of them on leave` : ""}.`,
    rows: [
      { label: "Contracted heads", value: fmt(s.contracted), hint: "Active guard-deployment contracts this month" },
      { label: "Present or double duty", value: fmt(s.present) },
      { label: "On leave", value: fmt(s.onLeave), hint: "Counts against the contract" },
      { label: "Absent", value: fmt(s.absent), hint: "Leaves the post short" },
      { label: "Difference", value: fmt(s.onPost - s.contracted) },
    ],
    link: { to: "/super-admin/attendance", label: "Open attendance" },
  });

  const groups = useMemo(() => {
    const m = new Map<string, SiteTile[]>();
    for (const s of sites ?? []) m.set(s.region, [...(m.get(s.region) ?? []), s]);
    return [...m.entries()];
  }, [sites]);

  const tile = (s: SiteTile) => {
    if (s.marked === 0) return "bg-muted text-muted-foreground border border-border bg-[repeating-linear-gradient(135deg,transparent_0_7px,color-mix(in_srgb,var(--border)_70%,transparent)_7px_9px)]";
    if (s.contracted === 0) return "bg-card text-foreground border border-dashed border-border";
    const gap = s.contracted - s.onPost;
    if (gap <= 0) return "bg-settled text-ink-foreground";
    if (gap === 1) return "bg-brand-500 text-on-brand";
    return "bg-danger-700 text-on-fill";
  };

  return (
    <div className="flex-1 overflow-y-auto px-3 md:px-8 pt-3 md:pt-5 pb-10 flex flex-col gap-4 md:gap-5">
      {/* COMMAND BAND */}
      <section aria-label="Right now" className="band on-dark rounded-[22px] px-4 md:px-7 py-5 md:py-6 flex flex-col gap-5">
        <div className="flex flex-wrap justify-between gap-3 items-center">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="live-dot w-2.5 h-2.5 rounded-full bg-brand-500 flex-shrink-0" aria-hidden="true" />
            <span className="text-[13px] text-muted-foreground truncate">
              {d.companyName} · {now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · day {dayOfMonth} of {daysInMonth}
            </span>
          </div>
          {d.branchScopeNote && <span className="text-xs text-muted-foreground">{d.branchScopeNote}</span>}
        </div>

        <div className="flex flex-wrap gap-5 items-stretch">
          {(d.can.attendance || d.can.roster) && !c && (
            <div className="flex-[1_1_300px] flex items-center gap-3 text-sm text-muted-foreground min-h-32"><Loader2 className="w-5 h-5 animate-spin" /> Reading today's register…</div>
          )}
          {(d.can.attendance || d.can.roster) && c && (
            <Hit
              onClick={() => setSheet({
                kicker: "Right now", title: "Short of contract", big: fmt(shortHeads),
                note: sites ? "Clients with fewer guards on strength (present, double duty or on leave) than their contracts ask for." : "Coverage by client needs the contract cover figures; showing today's attendance instead.",
                rows: short.slice(0, 12).map((s) => ({ label: s.name, value: `${s.contracted - s.onPost} short`, hint: s.region })),
                link: { to: "/super-admin/attendance", label: "Open attendance" },
              })}
              className="flex-[1_1_300px] flex gap-5 items-center"
              label="Guards on strength now"
            >
              <svg width="128" height="128" viewBox="0 0 132 132" role="img" aria-label={`${Math.round(coverPct * 100)} percent of contracted heads filled`} className="flex-shrink-0">
                <circle cx="66" cy="66" r="54" fill="none" stroke="#2e3125" strokeWidth="12" />
                <circle cx="66" cy="66" r="54" fill="none" stroke="#e9a73c" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${(C * Math.min(1, coverPct)).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 66 66)" />
                <text x="66" y="62" textAnchor="middle" fontFamily="Bricolage Grotesque, sans-serif" fontSize="27" fontWeight="700" fill="#f3eee2">{pct(Math.min(1, coverPct)).replace(".0%", "%")}</text>
                <text x="66" y="82" textAnchor="middle" fontFamily="Hanken Grotesk, sans-serif" fontSize="11" fill="#bdb6a0">of contract</text>
              </svg>
              <span className="flex flex-col gap-1.5 min-w-0">
                <span className="lbl">Guards on strength {c?.asOf ? `· ${formatDate(c.asOf)}` : "today"}</span>
                <span className="font-display text-5xl md:text-[54px] font-extrabold leading-none tracking-tight text-foreground group-hover:underline">
                  {sites ? fmt(onPost) : `${d.attendanceTodayPct}%`}
                  {sites && <span className="text-2xl text-muted-foreground font-semibold"> / {fmt(contracted)}</span>}
                </span>
                <span className="text-[13px] text-heed">{sites ? (shortHeads > 0 ? `${shortHeads} heads short across ${short.length} clients — tap for the list` : "Every marked client is at contract strength") : `Yesterday ${d.attendanceYesterdayPct}%`}</span>
                {unmarked.length > 0 && <span className="text-xs text-muted-foreground">{unmarked.length} client{unmarked.length > 1 ? "s" : ""} not marked yet — left out of the figure</span>}
              </span>
            </Hit>
          )}
          <div className="flex-[999_1_420px] grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
            {billed != null && (
              <BandStat to="/super-admin/invoices" label={`Billed for ${billLabel}`} value={mil(billed)}
                sub={c?.expectedClients ? `${c.billedClients} of ${c.expectedClients} contracted clients` : billedPrev ? `${prevLabel}: ${mil(billedPrev)}` : "by service month"}
                tone={c?.notBilled && c.notBilled.length > 0 && dayOfMonth > 10 ? "bad" : undefined} />
            )}
            {c?.receiptsMtd != null && <BandStat to="/super-admin/invoices" label="Received, month to date" value={mil(c.receiptsMtd)} sub="from clients" />}
            {d.can.accounting && <BandStat to="/super-admin/accounting" label="Cash and bank" value={mil(cashTotal)} sub={`${d.banks.length} bank accounts${c?.cashInHand != null ? " + cash held" : ""}`} />}
            {ar && <BandStat to="/super-admin/invoices?tab=receivables" label="Owed to us" value={mil(ar.total)} sub={`${Math.round(ar90 * 100)}% older than 90 days`} tone={ar90 > 0.25 ? "bad" : undefined} />}
          </div>
        </div>

        {attention.length > 0 && (
          <div className="flex flex-wrap gap-2 items-center">
            <span className="lbl mr-1">Needs attention</span>
            {attention.map((a) => (
              <Link key={a.text} to={a.to} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-card border border-border text-[13px] text-foreground hover:border-brand-500 min-h-9">
                <span className="font-ledger font-semibold text-down">{a.n}</span>{a.text}
              </Link>
            ))}
          </div>
        )}
      </section>

      {d.nothingToShow && (
        <div className="bg-card border border-border rounded-[18px] p-10 text-center">
          <h3 className="text-base text-foreground mb-2">Nothing to show yet</h3>
          <p className="text-sm text-muted-foreground">You don&apos;t have any feature permissions yet. Ask a Super Admin to grant you access.</p>
        </div>
      )}

      {!c && !d.nothingToShow && (
        <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading the rest of the dashboard…</div>
      )}

      {/* POST BOARD + RUN RATE / PAYDAY */}
      <div className="flex flex-wrap gap-4 md:gap-5 items-stretch">
        {d.show("post_board") && sites && sites.length > 0 && (
          <Card kicker="Post board" title="Every client, right now" className="flex-[2_1_620px]"
            aside={
              <div className="flex gap-3 text-xs text-muted-foreground flex-wrap">
                <Legend color="#3d4a2b">Covered</Legend><Legend color="#e9a73c">1 short</Legend><Legend color="#a3392a">2+ short</Legend><Legend muted>Not marked</Legend><Legend dashed>No contract</Legend>
              </div>
            }>
            {groups.map(([region, list]) => {
              const ml = list.filter((x) => x.marked > 0);
              const rq = ml.reduce((s, x) => s + x.contracted, 0), o = ml.reduce((s, x) => s + x.onPost, 0);
              const nm = list.length - ml.length;
              return (
                <div key={region} className="flex flex-col gap-2">
                  <div className="flex justify-between text-xs text-muted-foreground"><span className="font-bold text-foreground">{region}</span><span className="font-ledger">{o} / {rq} on strength · {ml.filter((x) => x.contracted > x.onPost).length} short{nm ? ` · ${nm} not marked` : ""}</span></div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(122px,1fr))] gap-2">
                    {list.map((s) => (
                      <button key={s.clientId} type="button" onClick={() => openSite(s)} aria-label={`${s.name}, ${s.onPost} of ${s.contracted} on strength`}
                        className={`${tile(s)} rounded-[10px] px-2.5 py-2 min-h-16 flex flex-col justify-between gap-1.5 text-left transition-transform hover:-translate-y-0.5 hover:shadow-md`}>
                        <span className="text-xs font-semibold leading-tight line-clamp-2">{s.name}</span>
                        <span className="font-ledger text-[13px] font-semibold">{s.marked === 0 ? "not marked" : `${s.onPost} / ${s.contracted || "—"}`}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </Card>
        )}

        <div className="flex-[1_1_340px] min-w-0 flex flex-col gap-4 md:gap-5">
          {d.show("month_landing") && billed != null && (() => {
            const exp = c?.expectedClients ?? 0, done = c?.billedClients ?? 0;
            const pctDone = exp ? done / exp : 1;
            const change = billedPrev ? (billed - billedPrev) / billedPrev : null;
            const missing = c?.notBilled ?? [];
            return (
              <Card kicker={`Billing for ${billLabel} · by service month`}>
                <div className="flex items-baseline gap-2.5 flex-wrap -mt-1">
                  <span className="font-display text-4xl font-extrabold tracking-tight text-foreground">{mil(billed)}</span>
                  <span className="text-[13px] text-muted-foreground">
                    {change == null ? "invoiced" : `${change >= 0 ? "+" : "−"}${Math.abs(Math.round(change * 100))}% on ${prevLabel}'s ${mil(billedPrev!)}`}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="relative h-3 rounded-full bg-muted overflow-hidden">
                    <div className={`absolute inset-y-0 left-0 rounded-full ${pctDone >= 1 ? "bg-success-500" : "bg-brand-500"}`} style={{ width: `${Math.min(100, pctDone * 100)}%` }} />
                  </div>
                  <span className="text-xs text-muted-foreground"><span className="font-semibold text-foreground">{done} of {exp}</span> clients with a contract in {billLabel} invoiced</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <MiniFig label={`${billLabel} billed`} value={mil(billed)} />
                  <MiniFig label="Clients left" value={String(missing.length)} tone={missing.length > 0 && dayOfMonth > 10 ? "bad" : undefined} />
                  <MiniFig label="Billed ahead" value={c?.billedAhead ? mil(c.billedAhead) : "—"} />
                </div>
                {missing.length > 0 ? (
                  <Hit onClick={() => setSheet({
                    kicker: `Live contract in ${billLabel}, no invoice for it`, title: "Clients to invoice", big: String(missing.length),
                    note: `Each had a guard-deployment contract running in ${billLabel} and has no invoice for that service month yet. Contracts that began after ${billLabel} are left out.`,
                    rows: missing.slice(0, 20).map((x) => ({ label: x.name, value: `${x.heads} heads` })),
                    link: { to: "/super-admin/invoices?tab=generate", label: "Generate invoices" },
                  })} className="text-[13px] text-brand-700 dark:text-brand-500 inline-flex items-center gap-1.5">
                    <span className="group-hover:underline">See the {missing.length} client{missing.length > 1 ? "s" : ""} still to invoice for {billLabel}</span><ArrowRight className="w-3.5 h-3.5" />
                  </Hit>
                ) : (
                  <p className="text-[13px] text-success-700 dark:text-success-500">Every client with a contract in {billLabel} has been invoiced for it.</p>
                )}
              </Card>
            );
          })()}

          {d.show("payday") && c && ar && d.can.accounting && d.can.payroll && payNeed > 0 && (
            <Card kicker={`Next salary run · in ${daysToPayday} day${daysToPayday === 1 ? "" : "s"}`} title={spare >= 0 ? `Covered, ${mil(spare)} to spare` : `Short by ${mil(-spare)}`}>
              <div className="relative h-6 rounded-lg bg-muted overflow-hidden flex">
                <span title="Cash and bank now" className="h-full bg-info-600" style={{ width: `${(cashTotal / payScale) * 100}%` }} />
                <span title="Owed to us, under 30 days" className="h-full bg-info-200" style={{ width: `${(dueFirst / payScale) * 100}%` }} />
                <span aria-hidden="true" className="absolute inset-y-0 w-[3px] bg-foreground" style={{ left: `${(payNeed / payScale) * 100}%` }} />
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <MiniFig label="In hand" value={mil(cashTotal)} dot="bg-info-600" />
                <MiniFig label="Owed, under 30 days" value={mil(dueFirst)} dot="bg-info-200" />
                <MiniFig label="Last month's payroll" value={mil(payNeed)} dot="bg-foreground" />
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* CASH + CLIENT MAP */}
      <div className="flex flex-wrap gap-4 md:gap-5 items-stretch">
        {d.show("cash_month") && cm && (
          <Card kicker="Cash this month · from the ledger" title={`From ${mil(cm.opening)} to ${mil(cm.closing)}`} className="flex-[1_1_420px]"
            aside={<Link to="/super-admin/accounting" className="text-[13px] text-brand-700 dark:text-brand-500 hover:underline">By account</Link>}>
            {fall.map((f) => (
              <Link key={f.label} to={f.to} className="grid grid-cols-[170px_minmax(0,1fr)_88px] gap-3 items-center min-h-8 text-[13px] group">
                <span className={`group-hover:underline ${f.kind ? "font-bold" : ""}`}>{f.label}</span>
                <span className="relative h-[18px] rounded bg-muted/70">
                  <span className="absolute inset-y-0 rounded" style={{ left: `${f.left}%`, width: `${f.width}%`, background: f.kind ? "var(--foreground)" : f.v >= 0 ? "#2f5d8a" : "#e9a73c" }} />
                </span>
                <span className={`font-ledger text-right ${f.kind ? "font-bold" : f.v < 0 ? "text-danger-700 dark:text-danger-500" : "text-info-700 dark:text-info-500"}`}>{f.kind ? "" : f.v >= 0 ? "+" : ""}{mil(f.v)}</span>
              </Link>
            ))}
            <p className="text-xs text-muted-foreground">Every bank and cash account, read from the ledger. Moves between our own accounts net to nothing; tap a line for where it was recorded.</p>
            {d.can.accounting && Math.abs(cm.closing - cashTotal) >= 1000 && (
              <Link to="/super-admin/accounting-core" className="rounded-xl border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-700 dark:text-warning-500 hover:underline">
                The ledger holds {mil(cm.closing)} on these accounts; the recorded bank and cash balances say {mil(cashTotal)}. The {mil(Math.abs(cashTotal - cm.closing))} between them is mostly opening balances from before the ledger began that were never posted — post them in Opening Balances and the two will agree.
              </Link>
            )}
          </Card>
        )}

        {d.show("client_map") && dots.length > 0 && c?.clientMap && (
          <Card kicker={`Client map · ${new Date(`${c.clientMap.month}T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}`} title="Who earns, who costs" className="flex-[1_1_460px]"
            aside={<span className="text-xs text-muted-foreground">Size = contracted guards</span>}>
            <div className="flex gap-2">
              <div className="flex flex-col justify-between text-[11px] text-muted-foreground py-1 pb-6 text-right w-9">
                <span>{pct(mHi).replace(".0", "")}</span><span>{pct((mHi + mLo) / 2).replace(".0", "")}</span><span>{pct(mLo).replace(".0", "")}</span>
              </div>
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <div className="relative h-[270px] border-l border-b border-border rounded-tr-[10px] bg-[linear-gradient(to_bottom,color-mix(in_srgb,var(--color-success-500)_9%,var(--card))_0,color-mix(in_srgb,var(--color-success-500)_9%,var(--card))_var(--split),color-mix(in_srgb,var(--color-danger-500)_8%,var(--card))_var(--split))]"
                  style={{ ["--split" as string]: `${(1 - (0.1 - mLo) / (mHi - mLo)) * 100}%` }}>
                  <span className="absolute right-2 top-1.5 text-[11px] font-semibold text-success-700 dark:text-success-500">10%+ margin</span>
                  <span className="absolute right-2 bottom-1.5 text-[11px] font-semibold text-danger-700 dark:text-danger-500">Under 10% — look closer</span>
                  {dots.map((r) => {
                    const m = r.net / r.revenue;
                    const x = 4 + (r.revenue / maxRev) * 90;
                    const y = 100 - (((Math.min(mHi, Math.max(mLo, m)) - mLo) / (mHi - mLo)) * 88 + 6);
                    const size = 14 + Math.sqrt(Math.max(1, r.guards)) * 4;
                    const col = m >= 0.15 ? "#3d4a2b" : m >= 0.1 ? "#e9a73c" : "#a3392a";
                    return (
                      <button key={r.clientId} type="button" title={`${r.name}: revenue ${fmt(r.revenue)}, margin ${pct(m)}`} aria-label={`${r.name}, margin ${pct(m)}`}
                        onClick={() => setSheet({
                          kicker: `${r.region} · revenue basis`, title: r.name, big: `${pct(m)} margin`,
                          note: "Last full month, with regional overhead and head office as currently set — the same client P&L Financial Reports shows.",
                          rows: [{ label: "Revenue", value: fmt(r.revenue) }, { label: "Net", value: fmt(r.net) }, { label: "Contracted guards", value: fmt(r.guards) }],
                          link: { to: "/super-admin/reports", label: "Open client profit" },
                        })}
                        className="absolute rounded-full border-2 border-card -translate-x-1/2 -translate-y-1/2 hover:scale-110 hover:z-10 transition-transform"
                        style={{ left: `${x}%`, top: `${y}%`, width: size, height: size, background: col }} />
                    );
                  })}
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground"><span>Revenue →</span><span className="font-ledger">{mil(maxRev)}</span></div>
              </div>
            </div>
          </Card>
        )}
      </div>

      {/* RECEIVABLES + REGIONS */}
      <div className="flex flex-wrap gap-4 md:gap-5 items-stretch">
        {d.show("payroll_last") && d.can.payroll && c?.payrollLast && (() => {
          const p = c.payrollLast;
          const left = Math.max(0, p.net - p.paid);
          const slipPct = p.slips ? p.paidSlips / p.slips : 0;
          return (
            <Card kicker={`Payroll · ${new Date(`${c.billMonth}T00:00:00`).toLocaleDateString(undefined, { month: "long" })}`} title={left < 1 ? "Every salary is paid" : `${mil(left)} still to pay`} className="flex-[1_1_320px]"
              aside={<Link to="/super-admin/payroll" className="text-[13px] text-brand-700 dark:text-brand-500 hover:underline">Open payroll</Link>}>
              <div className="flex flex-col gap-1.5">
                <div className="relative h-3 rounded-full bg-muted overflow-hidden">
                  <div className={`absolute inset-y-0 left-0 rounded-full ${slipPct >= 1 ? "bg-success-500" : "bg-brand-500"}`} style={{ width: `${Math.min(100, slipPct * 100)}%` }} />
                </div>
                <span className="text-xs text-muted-foreground"><span className="font-semibold text-foreground">{p.paidSlips} of {p.slips}</span> payslips settled</span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <MiniFig label="Net payroll" value={mil(p.net)} />
                <MiniFig label="Paid out" value={mil(p.paid)} tone={left < 1 ? "good" : undefined} />
                <MiniFig label="Left to pay" value={mil(left)} tone={left >= 1 && dayOfMonth > 10 ? "bad" : undefined} />
              </div>
            </Card>
          );
        })()}

        {d.show("workforce") && d.can.employees && c?.workforce && (() => {
          const w = c.workforce;
          const net = w.joined - w.left;
          return (
            <Card kicker="Workforce · this month" title={`${fmt(w.active)} on the books`} className="flex-[1_1_300px]"
              aside={<Link to="/super-admin/employees" className="text-[13px] text-brand-700 dark:text-brand-500 hover:underline">Open employees</Link>}>
              <div className="flex items-end gap-6">
                <div className="flex flex-col">
                  <span className="font-display text-3xl font-extrabold text-success-700 dark:text-success-500">+{w.joined}</span>
                  <span className="text-xs text-muted-foreground">joined</span>
                </div>
                <div className="flex flex-col">
                  <span className="font-display text-3xl font-extrabold text-danger-700 dark:text-danger-500">−{w.left}</span>
                  <span className="text-xs text-muted-foreground">left</span>
                </div>
                <div className="flex flex-col ml-auto text-right">
                  <span className={`font-ledger text-lg font-semibold ${net > 0 ? "text-success-700 dark:text-success-500" : net < 0 ? "text-danger-700 dark:text-danger-500" : "text-foreground"}`}>{net > 0 ? "+" : net < 0 ? "−" : ""}{Math.abs(net)}</span>
                  <span className="text-xs text-muted-foreground">net change</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{w.left > w.joined ? "More leaving than joining this month — check the posts it leaves short on the board above." : "Joined by their joining date, left by their last working day."}</p>
            </Card>
          );
        })()}

        {d.show("receivables_ladder") && ar && ar.byClient.length > 0 && (
          <Card kicker="Money owed to us" title={`${mil(ar.total)} outstanding`} className="flex-[1_1_460px]"
            aside={<div className="flex gap-2.5 text-[11px] text-muted-foreground flex-wrap">{AGE.map((a) => <Legend key={a.label} color={a.color}>{a.label}</Legend>)}</div>}>
            {(() => {
              const top = ar.byClient.slice(0, 7);
              const mx = Math.max(1, ...top.map((r) => r.buckets.reduce((a, b) => a + b, 0)));
              return top.map((r) => {
                const t = r.buckets.reduce((a, b) => a + b, 0);
                return (
                  <Hit key={r.clientId} onClick={() => setSheet({
                    kicker: "Receivables", title: r.name, big: `${fmt(t)} owed`, note: "Open invoices by age. Chase the oldest first.",
                    rows: AGE.map((a, i) => ({ label: `${a.label}${i === 0 ? "" : " days"}`, value: fmt(r.buckets[i]) })),
                    link: { to: "/super-admin/invoices?tab=receivables", label: "Open receivables" },
                  })} className="grid grid-cols-[150px_minmax(0,1fr)_76px] gap-3 items-center min-h-[34px] text-[13px]">
                    <span className="truncate group-hover:underline">{r.name}</span>
                    <span className="flex h-3.5 rounded-full overflow-hidden bg-muted/70">
                      {r.buckets.map((b, i) => <span key={i} className="h-full" style={{ width: `${(b / mx) * 100}%`, background: AGE[i].color }} />)}
                    </span>
                    <span className="font-ledger text-right font-semibold">{mil(t)}</span>
                  </Hit>
                );
              });
            })()}
          </Card>
        )}

        {d.show("region_cards") && c?.regions && c.regions.length > 0 && (
          <section aria-label="Regions" className="flex-[1_1_420px] min-w-0 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
            {c.regions.map((r) => {
              const mx = Math.max(...r.trend, 1), mn = Math.min(...r.trend) * 0.85;
              const pts = r.trend.map((v, i) => `${i * 40},${(42 - ((v - mn) / Math.max(1, mx - mn)) * 36).toFixed(1)}`);
              const regionSites = (sites ?? []).filter((s) => s.regionId === r.regionId);
              const rq = regionSites.reduce((s, x) => s + x.contracted, 0), o = regionSites.reduce((s, x) => s + x.onPost, 0);
              return (
                <Hit key={r.regionId} onClick={() => setSheet({
                  kicker: "Region · last full month", title: r.name, big: fmt(r.net),
                  note: `Profit after regional overhead${r.charged ? " and its head-office share" : r.charged === false ? ". Head office is not charged to this region" : ""}.`,
                  rows: [{ label: "Revenue", value: fmt(r.revenue) }, { label: "Margin", value: pct(r.net / Math.max(1, r.revenue)) }, { label: "Guards on strength", value: rq ? `${o} / ${rq}` : "—" }, { label: "Invoices, last 6 months", value: r.trend.map(mil).join(" → ") }],
                  link: { to: "/super-admin/reports", label: "Open in Financial Reports" },
                })} className="bg-card border border-border rounded-[18px] p-4 flex flex-col gap-2.5 hover:border-brand-500/60">
                  <span className="flex flex-col items-start gap-1 w-full min-w-0">
                    <span className="font-display text-lg font-bold group-hover:underline truncate max-w-full">{r.name}</span>
                    {r.charged != null && <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${r.charged ? "bg-brand-100 text-brand-700 dark:text-brand-500" : "bg-muted text-muted-foreground"}`}>{r.charged ? "Head office charged" : "Head office not charged"}</span>}
                  </span>
                  <span className="flex flex-col"><span className="text-xs text-muted-foreground">Profit, last month</span><span className="font-ledger text-2xl font-semibold">{mil(r.net)}</span></span>
                  <svg width="100%" height="46" viewBox="0 0 200 46" preserveAspectRatio="none" role="img" aria-label={`${r.name} invoices over six months`}>
                    <polyline points={`0,46 ${pts.join(" ")} 200,46`} fill="color-mix(in srgb, var(--color-brand-500) 28%, transparent)" stroke="none" />
                    <polyline points={pts.join(" ")} fill="none" stroke="var(--color-brand-700)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                  </svg>
                  <span className="grid grid-cols-3 gap-1.5 text-[11px] text-muted-foreground w-full">
                    <MiniFig label="Margin" value={pct(r.net / Math.max(1, r.revenue))} />
                    <MiniFig label="Cover" value={rq ? pct(o / rq) : "—"} />
                    <MiniFig label="Clients" value={String(regionSites.length || "—")} />
                  </span>
                </Hit>
              );
            })}
          </section>
        )}
      </div>

      {/* NEXT 30 DAYS */}
      {d.show("due_30_days") && d.can.compliance && dues.length > 0 && (
        <Card kicker="Next 30 days" title="What is coming due">
          <div className="overflow-x-auto">
            <div className="relative min-w-[960px] h-[132px] mx-14">
              <div aria-hidden="true" className="absolute inset-x-0 top-[86px] h-1 rounded-full bg-muted" />
              {[0, 7, 14, 21, 28].map((t) => {
                const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + t);
                return <span key={t} className="absolute top-[102px] text-[11px] text-muted-foreground -translate-x-1/2" style={{ left: `${(t / 30) * 100}%` }}>{t === 0 ? "Today" : dt.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>;
              })}
              {dues.map((a, i) => {
                const pos = Math.max(0, a.days_remaining);
                const urgent = a.days_remaining <= 7;
                return (
                  <button key={a.id} type="button" aria-label={`${a.title}, ${a.days_remaining < 0 ? "overdue" : `in ${a.days_remaining} days`}`}
                    onClick={() => setSheet({
                      kicker: a.days_remaining < 0 ? `Overdue by ${-a.days_remaining} days` : `Due in ${a.days_remaining} days`,
                      title: a.title, big: formatDate(a.due_date), note: a.category || undefined,
                      link: { to: "/super-admin/compliance", label: "Open compliance" },
                    })}
                    className="absolute -translate-x-1/2 flex flex-col items-center gap-1" style={{ left: `${(pos / 30) * 100}%`, top: i % 2 ? 36 : 0 }}>
                    <span className={`whitespace-nowrap max-w-[180px] truncate text-xs font-semibold px-2.5 py-1.5 rounded-lg ${urgent ? "bg-foreground text-background" : "bg-muted text-foreground border border-border"}`}>
                      {a.days_remaining < 0 && <AlertTriangle className="inline w-3 h-3 mr-1 -mt-0.5" />}{a.title}
                    </span>
                    <span className="w-0.5 bg-border" style={{ height: i % 2 ? 7 : 43 }} />
                    <span className={`w-3.5 h-3.5 rounded-full border-[3px] border-card ${a.days_remaining < 0 ? "bg-danger-600" : urgent ? "bg-danger-500" : "bg-brand-500"}`} />
                  </button>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {/* LIVE */}
      {d.show("live_feed") && d.feedItems.length > 0 && (
        <Card kicker="Live" title="What is happening" aside={<span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="live-dot w-2 h-2 rounded-full bg-brand-500" />updating</span>}>
          <div className="grid gap-x-8 md:grid-cols-2">
            {d.feedItems.slice(0, 12).map((e) => (
              <div key={e.id} className="grid grid-cols-[10px_minmax(0,1fr)_auto] gap-3 items-start py-2.5 border-t border-border/70 text-[13px]">
                <span className={`w-2 h-2 rounded-full mt-1.5 ${e.tone === "in" ? "bg-success-500" : e.tone === "out" ? "bg-danger-500" : "bg-brand-500"}`} />
                <span className="leading-snug">{e.text}</span>
                {e.amount && <span className="font-ledger text-success-700 dark:text-success-500">{e.amount}</span>}
              </div>
            ))}
          </div>
          <Link to="/super-admin/alerts" className="self-start inline-flex items-center gap-1.5 text-[13px] text-brand-700 dark:text-brand-500 hover:underline">All alerts <ArrowRight className="w-3.5 h-3.5" /></Link>
        </Card>
      )}

      {d.show("attachments") && <DashboardAttachments />}

      <DetailSheet content={sheet} onClose={() => setSheet(null)} />
    </div>
  );
}

function BandStat({ to, label, value, sub, tone }: { to: string; label: string; value: string; sub: string; tone?: "good" | "bad" }) {
  return (
    <Link to={to} className="bg-card border border-border rounded-[14px] px-4 py-3.5 flex flex-col gap-1.5 text-foreground hover:border-brand-500/80 transition-colors">
      <span className="lbl">{label}</span>
      <span className="font-ledger text-[26px] font-semibold tracking-tight leading-none">{value}</span>
      <span className={`text-xs ${tone === "good" ? "text-up" : tone === "bad" ? "text-down" : "text-muted-foreground"}`}>{sub}</span>
    </Link>
  );
}

function MiniFig({ label, value, tone, dot }: { label: string; value: string; tone?: "good" | "bad"; dot?: string }) {
  return (
    <span className="flex flex-col gap-0.5 min-w-0">
      <span className="flex items-center gap-1.5 text-muted-foreground truncate">{dot && <span className={`w-2 h-2 rounded-sm flex-shrink-0 ${dot}`} />}{label}</span>
      <span className={`font-ledger text-[15px] font-semibold ${tone === "good" ? "text-success-700 dark:text-success-500" : tone === "bad" ? "text-danger-700 dark:text-danger-500" : "text-foreground"}`}>{value}</span>
    </span>
  );
}

function Legend({ color, dashed, muted, children }: { color?: string; dashed?: boolean; muted?: boolean; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-3 h-3 rounded-[3px] ${dashed ? "border border-dashed border-muted-foreground" : ""} ${muted ? "bg-muted border border-border" : ""}`} style={color ? { background: color } : undefined} />
      {children}
    </span>
  );
}
