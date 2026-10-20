import { useCallback, useEffect, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { useRegion, withRegionOrUnassigned } from "../../lib/region";
import { describeAlert, alertCategoryLabel, alertTierLabel } from "../../lib/alertText";

// §21 Alert Engine — three tiers. Persisted blocking/warning alerts with an
// acknowledge/override trail, plus the live warning and dashboard signals
// computed from data.

const TIER: Record<string, string> = {
  blocking: "bg-danger-50 text-danger-700 border-danger-200",
  warning: "bg-warning-50 text-warning-700 border-warning-200",
  dashboard: "bg-muted/50 text-muted-foreground border-border",
};

export default function Alerts() {
  const { regionId } = useRegion();
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [warnings, setWarnings] = useState<any[]>([]);
  const [dashboard, setDashboard] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const [al, wa, da] = await Promise.all([
      withRegionOrUnassigned(supabase.from("alerts").select("*").eq("company_id", companyId).eq("state", "open"), regionId).order("created_at", { ascending: false }),
      withRegionOrUnassigned(supabase.from("warning_alerts").select("*").eq("company_id", companyId), regionId),
      withRegionOrUnassigned(supabase.from("dashboard_alerts").select("*").eq("company_id", companyId), regionId),
    ]);
    setAlerts(al.data ?? []);
    setWarnings(wa.data ?? []);
    setDashboard(da.data ?? []);
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

  const ack = async (id: string, blocking: boolean) => {
    let reason: string | null = null;
    if (blocking) {
      reason = window.prompt("Override reason (required for blocking alerts):") ?? "";
      if (!reason.trim()) return;
    }
    await run(supabase.rpc("acknowledge_alert", { p_alert_id: id, p_override_reason: reason }));
  };

  const blocking = alerts.filter((a) => a.tier === "blocking").length;
  const tile = (label: string, v: number, sub: string, tone: string) => (
    <div className="rounded-[14px] border border-border bg-card px-4 py-3 flex flex-col gap-1">
      <span className="lbl">{label}</span><span className={`font-ledger text-2xl font-semibold leading-none ${tone}`}>{v}</span><span className="text-xs text-muted-foreground">{sub}</span>
    </div>
  );
  const Section = ({ kicker, title, children, empty, n }: { kicker: string; title: string; children: React.ReactNode; empty: string; n: number }) => (
    <section className="bg-card border border-border rounded-[18px] overflow-hidden">
      <div className="px-5 pt-4 pb-3"><p className="lbl">{kicker}</p><h2 className="font-display text-lg md:text-xl font-bold tracking-tight mt-0.5">{title}</h2></div>
      <div className="border-t border-border divide-y divide-border/70">{n === 0 ? <p className="px-5 py-5 text-sm text-muted-foreground">{empty}</p> : children}</div>
    </section>
  );

  return (
    <div className="flex-1 overflow-y-auto px-3 py-4 md:p-8">
      <Header title="Alerts" subtitle="Blocking, warning and dashboard-tier signals" live>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          {tile("Blocking", blocking, "stop an action until overridden", blocking ? "text-down" : "text-up")}
          {tile("Open warnings", alerts.length - blocking, "waiting to be acknowledged", alerts.length - blocking ? "text-heed" : "text-up")}
          {tile("Live warnings", warnings.length, "computed from today's data", warnings.length ? "text-heed" : "text-up")}
          {tile("Dashboard signals", dashboard.length, "worth knowing, no action", "text-foreground")}
        </div>
      </Header>
      {err && <p role="alert" className="text-sm text-danger-700 dark:text-danger-500 bg-danger-50 border border-danger-200 rounded-xl px-4 py-2.5 mb-4">{err}</p>}

      <div className="space-y-5">
        <Section kicker="Needs a decision" title="Open alerts" empty="No open alerts — nothing is waiting on anyone." n={alerts.length}>
          {alerts.map((a) => {
            const text = describeAlert(a);
            const isBlocking = a.tier === "blocking";
            return (
              <div key={a.id} className={`flex items-start justify-between gap-4 px-5 py-3.5 ${isBlocking ? "shadow-[inset_4px_0_0_var(--color-danger-500)]" : "shadow-[inset_4px_0_0_var(--color-warning-500)]"}`}>
                <div className="min-w-0 flex flex-col gap-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${TIER[a.tier] ?? ""}`}>{alertTierLabel(a.tier)}</span>
                    <span className="text-[11px] text-muted-foreground">{alertCategoryLabel(a.category)}</span>
                  </div>
                  <p className="text-sm font-semibold text-foreground">{text.title}</p>
                  {text.figures && <p className="font-ledger text-xs text-foreground">{text.figures}</p>}
                  {text.detail && <p className="text-xs text-muted-foreground leading-relaxed">{text.detail}</p>}
                </div>
                <Button variant={isBlocking ? "ink" : "secondary"} size="sm" disabled={busy} onClick={() => ack(a.id, isBlocking)}>
                  {isBlocking ? "Override with a reason" : "Acknowledge"}
                </Button>
              </div>
            );
          })}
        </Section>

        <Section kicker="Computed from data" title="Live warnings" empty="No live warnings." n={warnings.length}>
          {warnings.map((w, i) => (
            <div key={i} className="px-5 py-3 text-sm flex items-center gap-3">
              <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${TIER.warning}`}>{alertCategoryLabel(w.category)}</span>
              <span>{describeAlert(w).title}</span>
            </div>
          ))}
        </Section>

        <Section kicker="Worth knowing" title="Dashboard summary" empty="Nothing to surface." n={dashboard.length}>
          {dashboard.map((d, i) => (
            <div key={i} className="px-5 py-3 text-sm text-muted-foreground flex items-center gap-3">
              <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${TIER.dashboard}`}>{alertCategoryLabel(d.category)}</span>
              <span className="text-foreground">{describeAlert(d).title}</span>
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}
