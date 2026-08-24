import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ShieldAlert, ShieldCheck, Loader2, AlertCircle, ArrowRight, Building2, Users } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import PayrollManagement from "./PayrollManagement";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { useRegion } from "../../lib/region";

// Payroll Run — a scoped Draft → Review → Finance Verify workflow.
//   • A "scope" is either a real CLIENT or a client-less CATEGORY group
//     (office_staff, reliever, …). Category groups mirror the attendance board's
//     synthetic 'cat:<category>' rows so office staff / relievers can be paid too.
//   • Draft: OPS-verifiable scopes (clients + office_staff/armed/gunman) must be
//     OPS-verified for the month to become actionable; relievers have no OPS
//     surface, so they're ungated. The gate is checked ONCE at Draft → Review and
//     then persisted (payroll_run_phases) — never re-evaluated live (migrations
//     0191 client scope, 0193 category scope).
//   • Review embeds the existing Payslips page, scoped + "through Net Salary".

const monthNow = () => new Date().toISOString().slice(0, 7);
const fmtMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
};
// office_staff → "Office Staff", reliever → "Relievers" (pluralised for the group).
const catLabel = (cat: string) => {
  const t = cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return cat === "reliever" ? "Relievers" : t;
};

type Phase = "review" | "finance_verify";
type Scope = {
  key: string;              // clientId, or `cat:<category>`
  name: string;
  clientId: string | null;
  category: string | null;
  verifiable: boolean;      // false for relievers (no OPS-verify surface)
};

export default function PayrollRun() {
  const { profile } = useAuth();
  const { regionId } = useRegion();
  const [month, setMonth] = useState(monthNow());
  const period = `${month}-01`;

  const [tab, setTab] = useState<"draft" | "review" | "finance_verify">("draft");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [scopes, setScopes] = useState<Scope[]>([]);
  const [verified, setVerified] = useState<Set<string>>(new Set());       // scope keys OPS-verified this month
  const [phaseByKey, setPhaseByKey] = useState<Map<string, Phase>>(new Map());
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const [{ data: cls }, { data: catEmps }, { data: vers }, { data: phs }] = await Promise.all([
        supabase.from("clients").select("id, name").order("name"),
        // Client-less staff → category groups (office_staff, reliever, armed, gunman).
        supabase.from("employees").select("category").is("client_id", null).neq("category", "client").neq("lifecycle_state", "archived"),
        supabase.from("attendance_month_verifications").select("client_id, category").eq("period_month", period),
        supabase.from("payroll_run_phases").select("client_id, category, phase").eq("period_month", period),
      ]);
      const clientScopes: Scope[] = ((cls ?? []) as any[]).map((c) => ({ key: c.id, name: c.name, clientId: c.id, category: null, verifiable: true }));
      const cats = Array.from(new Set(((catEmps ?? []) as any[]).map((e) => e.category).filter(Boolean))).sort();
      const catScopes: Scope[] = cats.map((cat) => ({ key: `cat:${cat}`, name: catLabel(cat), clientId: null, category: cat, verifiable: cat !== "reliever" }));
      setScopes([...clientScopes, ...catScopes]);
      setVerified(new Set(((vers ?? []) as any[]).map((v) => (v.client_id ?? `cat:${v.category}`))));
      setPhaseByKey(new Map(((phs ?? []) as any[]).map((p) => [(p.client_id ?? `cat:${p.category}`), p.phase as Phase])));
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [period, regionId]);

  const draftScopes = useMemo(() => scopes.filter((s) => !phaseByKey.has(s.key)), [scopes, phaseByKey]);
  const reviewScopes = useMemo(() => scopes.filter((s) => phaseByKey.get(s.key) === "review"), [scopes, phaseByKey]);
  const financeScopes = useMemo(() => scopes.filter((s) => phaseByKey.get(s.key) === "finance_verify"), [scopes, phaseByKey]);

  // Live OPS-verified check for one scope+month (re-queried at every transition).
  const isVerifiedNow = async (s: Scope): Promise<boolean> => {
    if (!s.verifiable) return true;
    const q = supabase.from("attendance_month_verifications").select("id").eq("period_month", period);
    const { data } = await (s.clientId ? q.eq("client_id", s.clientId) : q.eq("category", s.category as string)).maybeSingle();
    return !!data;
  };

  const moveToReview = async (s: Scope) => {
    setBusyKey(s.key); setErr(null);
    // Rule 8: re-check OPS-verified status LIVE at every Draft → Review move.
    if (!(await isVerifiedNow(s))) {
      setBusyKey(null);
      setErr(`${s.name} isn't OPS-verified for ${fmtMonth(month)} — verify OPS first.`);
      await load();
      return;
    }
    const { error } = await supabase.from("payroll_run_phases")
      .insert({ client_id: s.clientId, category: s.category, period_month: period, phase: "review", moved_by: profile?.id ?? null });
    setBusyKey(null);
    if (error) { setErr(error.message); return; }
    await load();
    setTab("review"); setExpanded(s.key);
  };

  // Back to Draft: delete the phase row (frees the month for un-verify again).
  const backToDraft = async (s: Scope) => {
    setBusyKey(s.key); setErr(null);
    const q = supabase.from("payroll_run_phases").delete().eq("period_month", period);
    const { error } = await (s.clientId ? q.eq("client_id", s.clientId) : q.eq("category", s.category as string));
    setBusyKey(null);
    if (error) { setErr(error.message); return; }
    if (expanded === s.key) setExpanded(null); // close any open accordion cleanly
    await load();
  };

  const setPhase = async (s: Scope, phase: Phase) => {
    setBusyKey(s.key); setErr(null);
    const q = supabase.from("payroll_run_phases")
      .update({ phase, moved_by: profile?.id ?? null, moved_at: new Date().toISOString() })
      .eq("period_month", period);
    const { error } = await (s.clientId ? q.eq("client_id", s.clientId) : q.eq("category", s.category as string));
    setBusyKey(null);
    if (error) { setErr(error.message); return; }
    await load();
  };

  const TABS: { key: typeof tab; label: string; count: number }[] = [
    { key: "draft", label: "Draft", count: draftScopes.length },
    { key: "review", label: "Review", count: reviewScopes.length },
    { key: "finance_verify", label: "Finance Verify", count: financeScopes.length },
  ];

  const ScopeIcon = ({ s }: { s: Scope }) =>
    s.category ? <Users className="w-5 h-5 text-muted-foreground shrink-0" strokeWidth={1.5} /> : <Building2 className="w-5 h-5 text-muted-foreground shrink-0" strokeWidth={1.5} />;

  return (
    <>
      <Header title="Payroll Run" subtitle="Draft → Review → Finance Verify, per client & staff group" />
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
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
                {draftScopes.length === 0 && <p className="text-sm text-muted-foreground py-8 text-center">Nothing left in Draft for {fmtMonth(month)}.</p>}
                {draftScopes.map((s) => {
                  const ok = !s.verifiable || verified.has(s.key);
                  const blocked = s.verifiable && !verified.has(s.key);
                  return (
                    <div key={s.key} className={`bg-card rounded-xl border p-4 flex items-center gap-3 ${blocked ? "border-warning-300 dark:border-warning-800 bg-warning-50/40 dark:bg-warning-900/10" : "border-border"}`}>
                      <ScopeIcon s={s} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">{s.name}</p>
                        {!s.verifiable ? (
                          <p className="text-xs text-muted-foreground">Not OPS-gated (no attendance verification for this group)</p>
                        ) : ok ? (
                          <p className="text-xs text-success-700 dark:text-success-500 flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" /> OPS-verified for {fmtMonth(month)}</p>
                        ) : (
                          <p className="text-xs text-warning-700 dark:text-warning-500 flex items-center gap-1"><ShieldAlert className="w-3.5 h-3.5" /> Verify OPS first — not verified for {fmtMonth(month)}</p>
                        )}
                      </div>
                      {ok ? (
                        <Button size="sm" variant="primary" disabled={busyKey === s.key} onClick={() => moveToReview(s)}>
                          {busyKey === s.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Move to Review <ArrowRight className="w-4 h-4 ml-1.5" /></>}
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
                {reviewScopes.length === 0 && <p className="text-sm text-muted-foreground py-8 text-center">Nothing in Review. Move a scope from Draft.</p>}
                {reviewScopes.map((s) => {
                  const open = expanded === s.key;
                  return (
                    <div key={s.key} className="bg-card rounded-xl border border-border overflow-hidden">
                      <div className="flex items-center gap-2 p-4 flex-wrap">
                        <button type="button" onClick={() => setExpanded(open ? null : s.key)} className="flex items-center gap-2 min-w-0 flex-1 text-left">
                          <ChevronRight className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
                          <ScopeIcon s={s} />
                          <span className="text-sm font-medium text-foreground truncate">{s.name}</span>
                          {/* Rule 10: OPS verification revoked while past Draft — warn, don't auto-revert. */}
                          {s.verifiable && !verified.has(s.key) && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning-700 dark:text-warning-500 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 px-1.5 py-0.5 rounded" title="OPS verification is no longer present for this month.">
                              <ShieldAlert className="w-3 h-3" /> OPS unverified
                            </span>
                          )}
                        </button>
                        <Button size="sm" variant="ghost" disabled={busyKey === s.key} onClick={() => backToDraft(s)}>Back to Draft</Button>
                        <Button size="sm" variant="secondary" disabled={busyKey === s.key} onClick={() => setPhase(s, "finance_verify")}>
                          {busyKey === s.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Send to Finance <ArrowRight className="w-4 h-4 ml-1.5" /></>}
                        </Button>
                      </div>
                      {open && (
                        <div className="border-t border-border">
                          {/* Existing Payslips page, scoped + through-Net (no payment UI). */}
                          <PayrollManagement clientScopeId={s.clientId} categoryScope={s.category} throughNet runInline periodOverride={period} />
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
                  Finance Verify rules aren't defined yet — this phase currently confirms a scope has cleared Review. Define the finance checks/sign-off separately to make it do more.
                </div>
                {financeScopes.length === 0 && <p className="text-sm text-muted-foreground py-8 text-center">Nothing awaiting Finance Verify.</p>}
                {financeScopes.map((s) => (
                  <div key={s.key} className="bg-card rounded-xl border border-border p-4 flex items-center gap-2 flex-wrap">
                    <ShieldCheck className="w-5 h-5 text-brand-600 shrink-0" strokeWidth={1.5} />
                    <p className="text-sm font-medium text-foreground min-w-0 flex-1 truncate">{s.name}</p>
                    {s.verifiable && !verified.has(s.key) && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning-700 dark:text-warning-500 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 px-1.5 py-0.5 rounded" title="OPS verification is no longer present for this month.">
                        <ShieldAlert className="w-3 h-3" /> OPS unverified
                      </span>
                    )}
                    <Button size="sm" variant="ghost" disabled={busyKey === s.key} onClick={() => setPhase(s, "review")}>Back to Review</Button>
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
