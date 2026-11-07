import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, TrendingUp } from "lucide-react";
import { supabase, CONTRACT_LINE_CATEGORY_LABEL, addendumHeadcountDelta, effectiveRateByLine, type Contract, type ContractAddendum, type ContractLine } from "../lib/supabase";
import { formatDate } from "../lib/date";

/**
 * THE CONTRACT AS IT STANDS (Shayan, 7 Nov 2026): "addendums should be shown
 * like the other contract lines, with a tag, and a history behind them —
 * not separate". Bagh reads 2 with "1 original + 1 by addendum", not 1 in one
 * table and +1 in another.
 *
 * One row per post (site × category × shift). Its count is the contract line's
 * committed count plus every headcount addendum in force today that targets
 * it; an addendum for a site the contract had no line at becomes its own row,
 * tagged "Added by addendum". Future-dated addendums are shown as pending and
 * not counted. Totals are folded from the rows shown, so the footer cannot
 * disagree with the table above it.
 *
 * Below it, the annual increase: the clause, the next anniversary, today's rate
 * and what it becomes, and every increase already approved (RATE_CHANGE
 * addendums) — with a warning when one is due and none is recorded.
 */
type Tag = { delta: number; date: string; ref: string | null; pending: boolean };
type Post = {
  key: string; siteId: string | null; category: string; shift: string | null;
  base: number; delta: number; rate: number; active: number; tags: Tag[]; fromAddendumOnly: boolean;
};

const today = () => new Date().toISOString().slice(0, 10);
const pkr = (n: number) => Math.round(n).toLocaleString("en-PK");

export default function ContractPosts({ contract, lines, addendums, activeByLine }: {
  contract: Contract;
  lines: ContractLine[];
  addendums: ContractAddendum[];
  activeByLine: Map<string, number>;
}) {
  const [siteNames, setSiteNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void supabase.from("sites").select("id, name").eq("client_id", contract.client_id).then(({ data }) => {
      if (!cancelled) setSiteNames(new Map(((data ?? []) as { id: string; name: string }[]).map((s) => [s.id, s.name])));
    });
    return () => { cancelled = true; };
  }, [contract.client_id]);

  const now = today();
  const rateNow = useMemo(() => effectiveRateByLine(lines, addendums, now), [lines, addendums, now]);

  const posts = useMemo(() => {
    const byKey = new Map<string, Post>();
    const lineKey = new Map<string, string>();
    for (const l of lines) {
      const key = `${l.site_id ?? ""}|${l.category}|${l.shift_code ?? ""}`;
      lineKey.set(l.id, key);
      const p = byKey.get(key) ?? { key, siteId: l.site_id ?? null, category: l.category, shift: l.shift_code ?? null, base: 0, delta: 0, rate: 0, active: 0, tags: [], fromAddendumOnly: false };
      p.base += Number(l.committed_count) || 0;
      p.rate = rateNow.get(l.id) ?? (Number(l.unit_rate) || 0);
      p.active += activeByLine.get(l.id) ?? 0;
      byKey.set(key, p);
    }
    const sorted = [...addendums].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    for (const a of sorted) {
      const delta = addendumHeadcountDelta(a);
      if (!delta) continue;
      const cat = a.contract_line_id ? lines.find((l) => l.id === a.contract_line_id)?.category ?? a.category : a.category;
      let key = a.contract_line_id ? lineKey.get(a.contract_line_id) : undefined;
      if (!key) {
        // Same site and category, any shift (an added guard carries no shift of its own).
        key = [...byKey.values()].find((p) => p.siteId === (a.site_id ?? null) && p.category === cat)?.key;
      }
      if (!key) {
        key = `${a.site_id ?? ""}|${cat ?? ""}|add`;
        if (!byKey.has(key)) byKey.set(key, { key, siteId: a.site_id ?? null, category: String(cat ?? "GUARD"), shift: null, base: 0, delta: 0, rate: Number((a as { unit_rate?: number | null }).unit_rate ?? 0), active: 0, tags: [], fromAddendumOnly: true });
      }
      const p = byKey.get(key)!;
      const pending = a.effective_from > now;
      if (!pending) p.delta += delta;
      if (!p.rate) p.rate = Number((a as { unit_rate?: number | null }).unit_rate ?? 0);
      p.tags.push({ delta, date: a.effective_from, ref: a.reference ?? null, pending });
    }
    const name = (p: Post) => (p.siteId ? siteNames.get(p.siteId) ?? "…" : "No site");
    return [...byKey.values()].sort((a, b) => name(a).localeCompare(name(b)) || a.category.localeCompare(b.category));
  }, [lines, addendums, rateNow, activeByLine, siteNames, now]);

  const total = posts.reduce((t, p) => t + Math.max(0, p.base + p.delta), 0);
  const totalActive = posts.reduce((t, p) => t + p.active, 0);
  const totalValue = posts.reduce((t, p) => t + Math.max(0, p.base + p.delta) * p.rate, 0);
  const added = posts.reduce((t, p) => t + p.delta, 0);

  // ── Annual increase ──────────────────────────────────────────────────────
  const pct = Number(contract.annual_escalation_pct ?? 0);
  const start = contract.start_date;
  const nextAnniv = (() => {
    if (!start) return null;
    const s = new Date(`${start}T00:00:00`);
    const t = new Date(`${now}T00:00:00`);
    let y = t.getFullYear();
    let d = new Date(y, s.getMonth(), s.getDate());
    if (d < t) d = new Date(++y, s.getMonth(), s.getDate());
    if (d <= s) d = new Date(s.getFullYear() + 1, s.getMonth(), s.getDate());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const daysTo = nextAnniv ? Math.round((new Date(`${nextAnniv}T00:00:00`).getTime() - new Date(`${now}T00:00:00`).getTime()) / 86400000) : null;
  const rateCounts = new Map<number, number>();
  for (const p of posts) if (p.rate) rateCounts.set(p.rate, (rateCounts.get(p.rate) ?? 0) + Math.max(0, p.base + p.delta));
  const mainRate = [...rateCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const increases = addendums.filter((a) => a.change_type === "RATE_CHANGE").sort((a, b) => b.effective_from.localeCompare(a.effective_from)).map((a) => {
    const line = lines.find((l) => l.id === a.contract_line_id);
    const prev = Number(line?.unit_rate ?? 0);
    const next = Number(a.new_rate ?? 0);
    return { date: a.effective_from, prev, next, pctUp: prev > 0 ? ((next - prev) / prev) * 100 : null, where: line?.site_id ? siteNames.get(line.site_id) ?? null : null, ref: a.reference };
  });
  const recordedNearNext = nextAnniv ? increases.some((i) => Math.abs((new Date(`${i.date}T00:00:00`).getTime() - new Date(`${nextAnniv}T00:00:00`).getTime()) / 86400000) <= 45) : false;
  const dueSoon = daysTo != null && daysTo <= 60 && !recordedNearNext;   // every contract's anniversary is its review point, % set or not

  return (
    <>
      <div className="border border-border rounded-md overflow-hidden">
        <div className="px-3 py-2 bg-muted/50 border-b border-border flex flex-wrap items-baseline gap-x-3">
          <span className="text-sm font-medium text-foreground">Posts on this contract</span>
          <span className="text-[11px] text-muted-foreground">Contract lines with every addendum in force applied{added ? ` — ${added > 0 ? "+" : ""}${added} by addendum` : ""}.</span>
        </div>
        {posts.length === 0 ? <p className="px-3 py-3 text-sm text-muted-foreground">No posts on this contract.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground uppercase border-b border-border">
                  <th className="text-left px-3 py-2">Site</th>
                  <th className="text-left px-3 py-2">Post</th>
                  <th className="text-right px-3 py-2">Guards</th>
                  <th className="text-right px-3 py-2">Active</th>
                  <th className="text-right px-3 py-2">Rate / month</th>
                  <th className="text-right px-3 py-2">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {posts.map((p) => {
                  const count = Math.max(0, p.base + p.delta);
                  return (
                    <tr key={p.key} className={p.fromAddendumOnly ? "bg-brand-50/40 dark:bg-brand-500/5" : ""}>
                      <td className="px-3 py-2 text-foreground align-top">
                        {p.siteId ? siteNames.get(p.siteId) ?? "…" : <span className="text-muted-foreground">No site</span>}
                        <div className="flex flex-wrap gap-1 mt-1">
                          {p.fromAddendumOnly && <span className="rounded-full border border-brand-300 bg-brand-50 dark:bg-brand-500/10 px-1.5 text-[10px] font-medium text-brand-700 dark:text-brand-500">Added by addendum</span>}
                          {p.tags.map((t, i) => (
                            <span key={i} title={t.ref ?? undefined} className={`rounded-full border px-1.5 text-[10px] ${t.pending ? "border-dashed border-border text-muted-foreground" : t.delta > 0 ? "border-success-200 bg-success-50 text-success-700 dark:bg-success-500/10" : "border-danger-200 bg-danger-50 text-danger-700 dark:bg-danger-500/10"}`}>
                              {t.delta > 0 ? "+" : ""}{t.delta} {t.pending ? `from ${formatDate(t.date)}` : `· ${formatDate(t.date)}`}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground align-top">{CONTRACT_LINE_CATEGORY_LABEL[p.category as keyof typeof CONTRACT_LINE_CATEGORY_LABEL] ?? p.category}{p.shift ? ` · ${p.shift}` : ""}</td>
                      <td className="px-3 py-2 text-right align-top tabular-nums">
                        <span className="font-semibold text-foreground">{count}</span>
                        {p.delta !== 0 && !p.fromAddendumOnly && <div className="text-[10px] text-muted-foreground">{p.base} original {p.delta > 0 ? "+" : "−"} {Math.abs(p.delta)} addendum</div>}
                      </td>
                      <td className={`px-3 py-2 text-right align-top tabular-nums ${p.active > count ? "text-danger-700 font-medium" : "text-foreground"}`}>{p.fromAddendumOnly ? <span className="text-muted-foreground">—</span> : p.active}</td>
                      <td className="px-3 py-2 text-right align-top text-muted-foreground tabular-nums">{pkr(p.rate)}</td>
                      <td className="px-3 py-2 text-right align-top text-muted-foreground tabular-nums">{pkr(count * p.rate)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-muted/50 font-medium text-foreground">
                  <td className="px-3 py-2" colSpan={2}>Total — {posts.length} post{posts.length === 1 ? "" : "s"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{total}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{totalActive}</td>
                  <td className="px-3 py-2"></td>
                  <td className="px-3 py-2 text-right tabular-nums">PKR {pkr(totalValue)}</td>
                </tr>
              </tfoot>
            </table>
            <p className="px-3 py-1.5 text-[11px] text-muted-foreground border-t border-border">Active counts guards assigned to the original contract lines; guards posted to a post added by addendum show on the site's roster.</p>
          </div>
        )}
      </div>

      <div className={`border rounded-md p-3 ${dueSoon ? "border-warning-300 bg-warning-50/50 dark:bg-warning-500/5" : "border-border"}`}>
        <div className="flex items-center gap-2 mb-2">
          <TrendingUp className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Annual increase</span>
          {pct > 0 ? <span className="text-xs text-muted-foreground">{pct}% a year per the contract</span> : <span className="text-xs text-muted-foreground">No increase % on this contract — the anniversary is still the review date (set the % in Edit)</span>}
        </div>
        {nextAnniv && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div><div className="text-[11px] text-muted-foreground uppercase">Next anniversary</div><div className="text-foreground inline-flex items-center gap-1"><CalendarClock className="w-3.5 h-3.5" />{formatDate(nextAnniv)}</div><div className="text-[11px] text-muted-foreground">in {daysTo} day{daysTo === 1 ? "" : "s"}</div></div>
            <div><div className="text-[11px] text-muted-foreground uppercase">Rate now</div><div className="text-foreground tabular-nums">PKR {pkr(mainRate)}</div></div>
            {pct > 0 && <div><div className="text-[11px] text-muted-foreground uppercase">At {pct}%</div><div className="text-foreground tabular-nums">PKR {pkr(mainRate * (1 + pct / 100))}</div><div className="text-[11px] text-muted-foreground">+{pkr(mainRate * pct / 100)} a guard</div></div>}
            {pct > 0 && <div><div className="text-[11px] text-muted-foreground uppercase">Contract value after</div><div className="text-foreground tabular-nums">PKR {pkr(totalValue * (1 + pct / 100))}</div><div className="text-[11px] text-muted-foreground">+{pkr(totalValue * pct / 100)} a month</div></div>}
          </div>
        )}
        {dueSoon && (
          <p className="mt-2 text-xs text-warning-700 inline-flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />The annual increase is due in {daysTo} days and none is recorded yet. Send the client the increase letter, then record the agreed rate as a rate-change addendum — the reminder emails stop once it is recorded.</p>
        )}
        <div className="mt-3">
          <div className="text-[11px] text-muted-foreground uppercase mb-1">Increases approved</div>
          {increases.length === 0 ? <p className="text-xs text-muted-foreground italic">None recorded. An agreed increase is recorded as a rate-change addendum, and it then shows here.</p> : (
            <ul className="text-sm divide-y divide-border">
              {increases.map((i, k) => (
                <li key={k} className="py-1 flex flex-wrap gap-x-3">
                  <span className="text-foreground">{formatDate(i.date)}</span>
                  <span className="tabular-nums text-muted-foreground">PKR {pkr(i.prev)} → <span className="text-foreground">{pkr(i.next)}</span></span>
                  {i.pctUp != null && <span className={`tabular-nums ${i.pctUp >= pct ? "text-success-700" : "text-warning-700"}`}>{i.pctUp >= 0 ? "+" : ""}{i.pctUp.toFixed(1)}%</span>}
                  {i.where && <span className="text-muted-foreground">{i.where}</span>}
                  {i.ref && <span className="text-muted-foreground text-xs">· {i.ref}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
