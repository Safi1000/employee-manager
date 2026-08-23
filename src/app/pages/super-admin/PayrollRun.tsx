import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ShieldAlert, ShieldCheck, Loader2, AlertCircle, ArrowRight, Building2 } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import PayrollManagement from "./PayrollManagement";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { useRegion } from "../../lib/region";

// Payroll Run — a client-scoped Draft → Review → Finance Verify workflow.
//   • Draft: only OPS-verified clients (attendance_month_verifications) are
//     actionable; unverified ones show a "Verify OPS first" warning.
//   • Draft → Review is a ONE-TIME gate: it persists a payroll_run_phases row.
//     From then on the client renders by its stored phase, never by live OPS
//     status, so a later OPS-revoke never re-blocks it (migration 0191).
//   • Review embeds the existing Payroll (Payslips) page, client-scoped and in
//     "through Net Salary" mode — same calc + Save logic, no payment/disburse UI.

const monthNow = () => new Date().toISOString().slice(0, 7);
const fmtMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
};

type Client = { id: string; name: string };
type Phase = "review" | "finance_verify";

export default function PayrollRun() {
  const { profile } = useAuth();
  const { regionId } = useRegion();
  const [month, setMonth] = useState(monthNow());
  const period = `${month}-01`;

  const [tab, setTab] = useState<"draft" | "review" | "finance_verify">("draft");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyClient, setBusyClient] = useState<string | null>(null);

  const [clients, setClients] = useState<Client[]>([]);
  const [verified, setVerified] = useState<Set<string>>(new Set());       // client_ids OPS-verified this month
  const [phaseByClient, setPhaseByClient] = useState<Map<string, Phase>>(new Map());
  const [expanded, setExpanded] = useState<string | null>(null);          // which Review client is open

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const [{ data: cls }, { data: vers }, { data: phs }] = await Promise.all([
        supabase.from("clients").select("id, name").order("name"),
        supabase.from("attendance_month_verifications").select("client_id").eq("period_month", period),
        supabase.from("payroll_run_phases").select("client_id, phase").eq("period_month", period),
      ]);
      setClients((cls ?? []) as Client[]);
      setVerified(new Set(((vers ?? []) as any[]).map((v) => v.client_id)));
      setPhaseByClient(new Map(((phs ?? []) as any[]).map((p) => [p.client_id, p.phase as Phase])));
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [period, regionId]);

  const draftClients = useMemo(() => clients.filter((c) => !phaseByClient.has(c.id)), [clients, phaseByClient]);
  const reviewClients = useMemo(() => clients.filter((c) => phaseByClient.get(c.id) === "review"), [clients, phaseByClient]);
  const financeClients = useMemo(() => clients.filter((c) => phaseByClient.get(c.id) === "finance_verify"), [clients, phaseByClient]);

  // Draft → Review: gated ONCE on OPS-verified, then persisted.
  const moveToReview = async (c: Client) => {
    if (!verified.has(c.id)) { setErr(`${c.name} isn't OPS-verified for ${fmtMonth(month)} yet.`); return; }
    setBusyClient(c.id); setErr(null);
    const { error } = await supabase.from("payroll_run_phases")
      .insert({ client_id: c.id, period_month: period, phase: "review", moved_by: profile?.id ?? null });
    setBusyClient(null);
    if (error) { setErr(error.message); return; }
    await load();
    setTab("review"); setExpanded(c.id);
  };

  const setPhase = async (c: Client, phase: Phase) => {
    setBusyClient(c.id); setErr(null);
    const { error } = await supabase.from("payroll_run_phases")
      .update({ phase, moved_by: profile?.id ?? null, moved_at: new Date().toISOString() })
      .eq("client_id", c.id).eq("period_month", period);
    setBusyClient(null);
    if (error) { setErr(error.message); return; }
    await load();
  };

  const TABS: { key: typeof tab; label: string; count: number }[] = [
    { key: "draft", label: "Draft", count: draftClients.length },
    { key: "review", label: "Review", count: reviewClients.length },
    { key: "finance_verify", label: "Finance Verify", count: financeClients.length },
  ];

  return (
    <>
      <Header title="Payroll Run" subtitle="Draft → Review → Finance Verify, per client" />
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
        {/* Phase nav + month */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div className="inline-flex items-center rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
            {TABS.map((t) => (
              <button key={t.key} type="button" onClick={() => setTab(t.key)}
                className={`px-3.5 py-1.5 text-sm font-medium rounded-md transition-colors ${tab === t.key ? "bg-card text-brand-700 dark:text-brand-400 shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                {t.label} <span className="ml-1 text-xs text-muted-foreground">({t.count})</span>
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Month
            <input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setExpanded(null); }}
              className="px-2 py-1.5 border border-border rounded-md text-sm bg-card" />
          </label>
        </div>

        {err && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-danger-50 text-danger-700 border border-danger-200 rounded-md text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5" strokeWidth={2} />
            <div className="flex-1">{err}</div>
            <button onClick={() => setErr(null)}>✕</button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…</div>
        ) : (
          <>
            {/* ── DRAFT ── */}
            {tab === "draft" && (
              <div className="space-y-3">
                {draftClients.length === 0 && <p className="text-sm text-muted-foreground py-8 text-center">No clients left in Draft for {fmtMonth(month)}.</p>}
                {draftClients.map((c) => {
                  const ok = verified.has(c.id);
                  return (
                    <div key={c.id} className={`bg-card rounded-xl border p-4 flex items-center gap-3 ${ok ? "border-border" : "border-warning-300 dark:border-warning-800 bg-warning-50/40 dark:bg-warning-900/10"}`}>
                      <Building2 className="w-5 h-5 text-muted-foreground shrink-0" strokeWidth={1.5} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">{c.name}</p>
                        {ok ? (
                          <p className="text-xs text-success-700 dark:text-success-500 flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" /> OPS-verified for {fmtMonth(month)}</p>
                        ) : (
                          <p className="text-xs text-warning-700 dark:text-warning-500 flex items-center gap-1"><ShieldAlert className="w-3.5 h-3.5" /> Verify OPS first — not verified for {fmtMonth(month)}</p>
                        )}
                      </div>
                      {ok ? (
                        <Button size="sm" variant="primary" disabled={busyClient === c.id} onClick={() => moveToReview(c)}>
                          {busyClient === c.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Move to Review <ArrowRight className="w-4 h-4 ml-1.5" /></>}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground italic px-2">Blocked</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── REVIEW ── */}
            {tab === "review" && (
              <div className="space-y-3">
                {reviewClients.length === 0 && <p className="text-sm text-muted-foreground py-8 text-center">No clients in Review. Move an OPS-verified client from Draft.</p>}
                {reviewClients.map((c) => {
                  const open = expanded === c.id;
                  return (
                    <div key={c.id} className="bg-card rounded-xl border border-border overflow-hidden">
                      <div className="flex items-center gap-3 p-4">
                        <button type="button" onClick={() => setExpanded(open ? null : c.id)} className="flex items-center gap-2 min-w-0 flex-1 text-left">
                          <ChevronRight className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
                          <Building2 className="w-5 h-5 text-muted-foreground shrink-0" strokeWidth={1.5} />
                          <span className="text-sm font-medium text-foreground truncate">{c.name}</span>
                        </button>
                        <Button size="sm" variant="secondary" disabled={busyClient === c.id} onClick={() => setPhase(c, "finance_verify")}>
                          {busyClient === c.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Send to Finance <ArrowRight className="w-4 h-4 ml-1.5" /></>}
                        </Button>
                      </div>
                      {open && (
                        <div className="border-t border-border">
                          {/* Reuse the existing Payslips page, client-scoped + through-Net (no payment UI). */}
                          <PayrollManagement clientScopeId={c.id} throughNet periodOverride={period} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── FINANCE VERIFY ── */}
            {tab === "finance_verify" && (
              <div className="space-y-3">
                <div className="text-xs text-muted-foreground bg-secondary/50 rounded-md px-3 py-2">
                  Finance Verify rules aren't defined yet — this phase currently confirms a client's run has cleared Review. Define the finance checks/sign-off separately to make it do more.
                </div>
                {financeClients.length === 0 && <p className="text-sm text-muted-foreground py-8 text-center">No clients awaiting Finance Verify.</p>}
                {financeClients.map((c) => (
                  <div key={c.id} className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
                    <ShieldCheck className="w-5 h-5 text-brand-600 shrink-0" strokeWidth={1.5} />
                    <p className="text-sm font-medium text-foreground min-w-0 flex-1 truncate">{c.name}</p>
                    <Button size="sm" variant="ghost" disabled={busyClient === c.id} onClick={() => setPhase(c, "review")}>Back to Review</Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
