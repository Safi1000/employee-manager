import { useCallback, useEffect, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { supabase } from "../../lib/supabase";

// §21 Alert Engine — three tiers. Persisted blocking/warning alerts with an
// acknowledge/override trail, plus the live warning and dashboard signals
// computed from data.

const TIER: Record<string, string> = {
  blocking: "bg-danger-50 text-danger-700 border-danger-200",
  warning: "bg-warning-50 text-warning-700 border-warning-200",
  dashboard: "bg-slate-50 text-slate-600 border-slate-200",
};

export default function Alerts() {
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
      supabase.from("alerts").select("*").eq("company_id", companyId).eq("state", "open").order("created_at", { ascending: false }),
      supabase.from("warning_alerts").select("*").eq("company_id", companyId),
      supabase.from("dashboard_alerts").select("*").eq("company_id", companyId),
    ]);
    setAlerts(al.data ?? []);
    setWarnings(wa.data ?? []);
    setDashboard(da.data ?? []);
  }, [companyId]);

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

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header title="Alerts" subtitle="Blocking, warning and dashboard-tier signals" />
      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      <div className="space-y-6">
        <section>
          <h3 className="text-sm text-slate-900 mb-2">Open alerts (blocking / warning)</h3>
          <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
            {alerts.map((a) => (
              <div key={a.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs border ${TIER[a.tier] ?? ""}`}>{a.tier}</span>
                  <span className="text-slate-700">{a.message}</span>
                </div>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => ack(a.id, a.tier === "blocking")}>
                  {a.tier === "blocking" ? "Override" : "Acknowledge"}
                </Button>
              </div>
            ))}
            {alerts.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No open alerts.</p>}
          </div>
        </section>

        <section>
          <h3 className="text-sm text-slate-900 mb-2">Live warnings</h3>
          <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
            {warnings.map((w, i) => (
              <div key={i} className="px-3 py-2 text-sm text-slate-700 flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded-full text-xs border ${TIER.warning}`}>{String(w.category).replace(/_/g, " ")}</span>
                {w.message}
              </div>
            ))}
            {warnings.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No live warnings.</p>}
          </div>
        </section>

        <section>
          <h3 className="text-sm text-slate-900 mb-2">Dashboard summary</h3>
          <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
            {dashboard.map((d, i) => (
              <div key={i} className="px-3 py-2 text-sm text-slate-600 flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded-full text-xs border ${TIER.dashboard}`}>{String(d.category).replace(/_/g, " ")}</span>
                {d.message}
              </div>
            ))}
            {dashboard.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">Nothing to surface.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
