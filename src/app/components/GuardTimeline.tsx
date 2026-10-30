import { useEffect, useState } from "react";
import { ArrowRightLeft, Banknote, Briefcase, Flag, HandCoins, IdCard, Loader2, LogOut, ShieldAlert, UserPlus, type LucideIcon } from "lucide-react";
import { supabase } from "../lib/supabase";
import { formatDate } from "../lib/date";

/**
 * A guard's whole service on one line (2026-10-21): joined, every posting,
 * pay changes, advances, warnings, code changes and state changes, newest
 * first. Each event is a row read from the table that owns it — nothing is
 * inferred.
 */
type Event = { date: string; icon: LucideIcon; tone: string; title: string; detail?: string };

export default function GuardTimeline({ employeeId, joinDate }: { employeeId: string; joinDate?: string | null }) {
  const [events, setEvents] = useState<Event[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [dep, sal, adv, warn, code, life] = await Promise.all([
        supabase.from("deployments").select("start_date, end_date, reason, client:client_id(name), site:site_id(name)").eq("guard_id", employeeId).order("start_date"),
        supabase.from("employee_salary_history").select("effective_date, base_salary, allowance, reason, salary_change_reason").eq("employee_id", employeeId).order("effective_date"),
        supabase.from("advances").select("advance_date, amount, payment_mode").eq("employee_id", employeeId).order("advance_date"),
        supabase.from("disciplinary_warnings").select("issued_on, warning_number, reason, rescinded, kind, status").eq("employee_id", employeeId).order("issued_on"),
        supabase.from("employee_code_history").select("changed_at, old_code, new_code, reason").eq("employee_id", employeeId).order("changed_at"),
        supabase.from("employee_lifecycle_events").select("changed_at, from_state, to_state, reason").eq("employee_id", employeeId).order("changed_at"),
      ]);
      if (cancelled) return;
      const out: Event[] = [];
      const pkr = (n: number) => `PKR ${Math.round(Number(n || 0)).toLocaleString()}`;
      const nice = (s: string | null) => (s ?? "").replace(/_/g, " ");
      if (joinDate) out.push({ date: joinDate, icon: UserPlus, tone: "text-success-700 dark:text-success-500", title: "Joined" });
      for (const d of (dep.data ?? []) as unknown as { start_date: string | null; end_date: string | null; reason: string | null; client: { name: string } | null; site: { name: string } | null }[]) {
        const where = [d.client?.name, d.site?.name].filter(Boolean).join(" · ") || "a posting";
        if (d.start_date) out.push({ date: d.start_date, icon: Briefcase, tone: "text-info-700 dark:text-info-500", title: `Posted to ${where}`, detail: d.reason ? nice(d.reason) : undefined });
        if (d.end_date) out.push({ date: d.end_date, icon: ArrowRightLeft, tone: "text-muted-foreground", title: `Left the posting at ${where}` });
      }
      let prev: number | null = null;
      for (const s of (sal.data ?? []) as { effective_date: string; base_salary: number; allowance: number | null; reason: string | null; salary_change_reason: string | null }[]) {
        const pay = Number(s.base_salary) + Number(s.allowance ?? 0);
        out.push({ date: s.effective_date, icon: Banknote, tone: "text-brand-700 dark:text-brand-500",
          title: prev == null ? `Pay set at ${pkr(pay)}` : `Pay ${pay >= prev ? "raised" : "lowered"} to ${pkr(pay)}`,
          detail: [prev != null ? `from ${pkr(prev)}` : null, nice(s.salary_change_reason ?? s.reason)].filter(Boolean).join(" · ") || undefined });
        prev = pay;
      }
      for (const a of (adv.data ?? []) as { advance_date: string; amount: number; payment_mode: string | null }[])
        out.push({ date: a.advance_date, icon: HandCoins, tone: "text-warning-700 dark:text-warning-500", title: `Advance of ${pkr(a.amount)}`, detail: a.payment_mode ?? undefined });
      for (const w of (warn.data ?? []) as { issued_on: string; warning_number: number | null; reason: string | null; rescinded: boolean | null; kind: string; status: string }[])
        out.push({ date: w.issued_on, icon: ShieldAlert, tone: w.rescinded ? "text-muted-foreground" : "text-danger-700 dark:text-danger-500",
          title: `${w.kind === "soft" ? "Soft warning" : `Warning${w.warning_number ? ` ${w.warning_number}` : ""}`}${w.status === "pending" ? " (awaiting approval)" : w.status === "refused" ? " (refused)" : ""}${w.rescinded ? " (rescinded)" : ""}`, detail: w.reason ?? undefined });
      for (const c of (code.data ?? []) as { changed_at: string; old_code: string | null; new_code: string | null; reason: string | null }[])
        out.push({ date: c.changed_at.slice(0, 10), icon: IdCard, tone: "text-muted-foreground", title: `Code ${c.old_code ?? "—"} → ${c.new_code ?? "—"}`, detail: c.reason ?? undefined });
      for (const l of (life.data ?? []) as { changed_at: string; from_state: string | null; to_state: string | null; reason: string | null }[]) {
        const leaving = ["fired", "left", "absconded", "resigned", "terminated"].includes(l.to_state ?? "");
        out.push({ date: l.changed_at.slice(0, 10), icon: leaving ? LogOut : Flag, tone: leaving ? "text-danger-700 dark:text-danger-500" : "text-muted-foreground",
          title: `${nice(l.from_state) || "—"} → ${nice(l.to_state)}`, detail: l.reason ?? undefined });
      }
      out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      setEvents(out);
    })();
    return () => { cancelled = true; };
  }, [employeeId, joinDate]);

  if (!events) return <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Reading the record…</div>;
  if (events.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">Nothing recorded yet for this guard.</p>;

  return (
    <ol className="relative ml-3 border-l border-border">
      {events.map((e, i) => (
        <li key={i} className="ml-5 py-2.5">
          <span className={`absolute -left-[13px] mt-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card ${e.tone}`}>
            <e.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
          </span>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-sm font-medium text-foreground">{e.title}</span>
            <span className="text-xs text-muted-foreground">{formatDate(e.date)}</span>
          </div>
          {e.detail && <p className="text-xs text-muted-foreground mt-0.5">{e.detail}</p>}
        </li>
      ))}
    </ol>
  );
}
