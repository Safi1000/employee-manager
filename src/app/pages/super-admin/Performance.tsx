import { useCallback, useEffect, useMemo, useState } from "react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import { useAuth } from "../../lib/auth";
import { formatDate } from "../../lib/date";
import {
  supabase,
  LIFECYCLE_STATE_LABEL,
  type Branch,
} from "../../lib/supabase";

// Part IV — Performance & Rewards (§14 KPI, §15 Appraisal, §16 Bonus Pools) plus
// §17 Guard Bonuses, on one tabbed page. Every gated action is enforced by its
// RPC (COO approver, appraisal chain); this is the operator surface.

type Tab = "kpis" | "appraisals" | "pools" | "guard";

const FIELD =
  "px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent";
const RAG: Record<string, string> = {
  green: "bg-success-50 text-success-700 border-success-200",
  amber: "bg-warning-50 text-warning-700 border-warning-200",
  red: "bg-danger-50 text-danger-700 border-danger-200",
};
const KPI_SEATS = ["accounts", "hr", "compliance", "client_management", "regional_admin"] as const;
const thisMonthStart = () => new Date().toISOString().slice(0, 8) + "01";

type EmpLite = {
  id: string;
  full_name: string;
  category: string;
  kpi_seat: string | null;
  performance_enrolled: boolean;
  lifecycle_state: keyof typeof LIFECYCLE_STATE_LABEL;
};

export default function Performance() {
  const { company } = useAuth();
  const companyId = company?.id ?? "";
  const [tab, setTab] = useState<Tab>("kpis");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [employees, setEmployees] = useState<EmpLite[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [kpiRows, setKpiRows] = useState<any[]>([]);
  const [appraisals, setAppraisals] = useState<any[]>([]);
  const [pools, setPools] = useState<any[]>([]);
  const [allocations, setAllocations] = useState<any[]>([]);
  const [guardBonuses, setGuardBonuses] = useState<any[]>([]);

  const [year, setYear] = useState(new Date().getFullYear());

  const load = useCallback(async () => {
    const [emp, br, kpi, app, pl, al, gb] = await Promise.all([
      supabase.from("employees").select("id, full_name, category, kpi_seat, performance_enrolled, lifecycle_state").order("full_name"),
      supabase.from("branches").select("*").order("is_head_office", { ascending: false }).order("name"),
      supabase.from("kpi_dashboard").select("*"),
      supabase.from("appraisals").select("*").order("period_year", { ascending: false }),
      supabase.from("bonus_pools").select("*").order("period_year", { ascending: false }),
      supabase.from("bonus_pool_allocations").select("*"),
      supabase.from("guard_bonuses").select("*").order("created_at", { ascending: false }),
    ]);
    setEmployees((emp.data ?? []) as EmpLite[]);
    setBranches((br.data ?? []) as Branch[]);
    setKpiRows(kpi.data ?? []);
    setAppraisals(app.data ?? []);
    setPools(pl.data ?? []);
    setAllocations(al.data ?? []);
    setGuardBonuses(gb.data ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (p: PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true);
    setErr(null);
    const { error } = await p;
    setBusy(false);
    if (error) {
      setErr(error.message);
      return false;
    }
    await load();
    return true;
  };

  const nameById = useMemo(() => new Map(employees.map((e) => [e.id, e.full_name])), [employees]);
  const officeStaff = useMemo(() => employees.filter((e) => e.category === "office_staff"), [employees]);

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8">
      <Header title="Performance & Rewards" subtitle="KPIs, appraisals, bonus pools and guard bonuses" />

      <div className="flex gap-1 border-b border-slate-200 mb-4">
        {([
          ["kpis", "KPIs"],
          ["appraisals", "Appraisals"],
          ["pools", "Bonus Pools"],
          ["guard", "Guard Bonuses"],
        ] as [Tab, string][]).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${
              tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {err && <p className="text-sm text-danger-600 mb-3">{err}</p>}

      {/* ================= KPIs ================= */}
      {tab === "kpis" && (
        <div className="space-y-6">
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm text-slate-900">Enrollment (salaried staff)</h3>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => run(supabase.rpc("run_kpi_computation", { p_company_id: companyId, p_period: thisMonthStart() }))}
              >
                Run KPI computation (this month)
              </Button>
            </div>
            <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
              {officeStaff.map((e) => (
                <div key={e.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-slate-800">{e.full_name}</span>
                  <div className="flex items-center gap-2">
                    <select
                      className={FIELD}
                      value={e.kpi_seat ?? ""}
                      onChange={(ev) =>
                        run(
                          supabase.rpc("set_performance_enrollment", {
                            p_employee_id: e.id,
                            p_enrolled: e.performance_enrolled,
                            p_seat: ev.target.value || null,
                          }),
                        )
                      }
                    >
                      <option value="">— seat —</option>
                      {KPI_SEATS.map((s) => (
                        <option key={s} value={s}>{s.replace("_", " ")}</option>
                      ))}
                    </select>
                    <Button
                      variant={e.performance_enrolled ? "secondary" : "primary"}
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        run(
                          supabase.rpc("set_performance_enrollment", {
                            p_employee_id: e.id,
                            p_enrolled: !e.performance_enrolled,
                            p_seat: e.kpi_seat,
                          }),
                        )
                      }
                    >
                      {e.performance_enrolled ? "Enrolled ✓" : "Enroll"}
                    </Button>
                  </div>
                </div>
              ))}
              {officeStaff.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No salaried staff.</p>}
            </div>
            <p className="text-xs text-slate-400 mt-1">Enrollment requires COO approval — enforced by the RPC.</p>
          </section>

          <section>
            <h3 className="text-sm text-slate-900 mb-2">KPI Dashboard</h3>
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Employee</th>
                    <th className="text-left px-3 py-2">KPI</th>
                    <th className="text-right px-3 py-2">Target</th>
                    <th className="text-right px-3 py-2">Value</th>
                    <th className="text-center px-3 py-2">RAG</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {kpiRows.map((r, i) => (
                    <tr key={i}>
                      <td className="px-3 py-1.5 text-slate-800">{r.full_name}</td>
                      <td className="px-3 py-1.5 text-slate-600">{r.name}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{r.target ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{r.value ?? "—"}</td>
                      <td className="px-3 py-1.5 text-center">
                        {r.rag ? (
                          <span className={`inline-block px-2 py-0.5 rounded-md text-xs border ${RAG[r.rag]}`}>{r.rag}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {kpiRows.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-3 text-slate-500">No enrolled KPI data yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* ================= Appraisals ================= */}
      {tab === "appraisals" && (
        <AppraisalsTab
          companyId={companyId}
          year={year}
          setYear={setYear}
          appraisals={appraisals}
          enrolled={officeStaff.filter((e) => e.performance_enrolled)}
          nameById={nameById}
          run={run}
          busy={busy}
        />
      )}

      {/* ================= Bonus Pools ================= */}
      {tab === "pools" && (
        <div className="space-y-4">
          <div className="p-3 bg-warning-50 border border-warning-200 rounded-md text-sm text-warning-800">
            Regional profit is stated <strong>after</strong> head-office cost allocation. Run HO cost allocation for the period
            (Treasury → Regional P&L) before sizing pools so profit isn't overstated.
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-sm text-slate-600">Year</label>
            <input type="number" className={FIELD + " w-24"} value={year} onChange={(e) => setYear(Number(e.target.value))} />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => run(supabase.rpc("generate_bonus_pool", { p_company_id: companyId, p_year: year, p_scope: "head_office" }))}
            >
              Generate HO pool
            </Button>
            {branches
              .filter((b) => !b.is_head_office)
              .map((b) => (
                <Button
                  key={b.id}
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(supabase.rpc("generate_bonus_pool", { p_company_id: companyId, p_year: year, p_scope: "regional", p_branch_id: b.id }))
                  }
                >
                  Generate {b.name} pool
                </Button>
              ))}
          </div>

          {pools.map((p) => (
            <div key={p.id} className="border border-slate-200 rounded-md p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm text-slate-800">
                  {p.period_year} · {p.scope}
                  {p.branch_id ? ` · ${branches.find((b) => b.id === p.branch_id)?.name ?? ""}` : ""}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">
                    growth {Number(p.growth ?? 0).toLocaleString()} → pool {Number(p.pool_amount ?? 0).toLocaleString()}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200">{p.status}</span>
                  {p.status === "draft" && (
                    <Button variant="primary" size="sm" disabled={busy} onClick={() => run(supabase.rpc("approve_bonus_pool", { p_pool_id: p.id }))}>
                      Approve
                    </Button>
                  )}
                </div>
              </div>
              <ul className="mt-2 text-xs text-slate-600 space-y-0.5">
                {allocations
                  .filter((a) => a.pool_id === p.id && Number(a.share_amount) > 0)
                  .map((a) => (
                    <li key={a.id} className="flex justify-between">
                      <span>{nameById.get(a.employee_id) ?? a.employee_id} · {a.rating ?? "unrated"}</span>
                      <span className="tabular-nums">{Number(a.share_amount ?? 0).toLocaleString()}{a.paid ? " · paid" : ""}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
          {pools.length === 0 && <p className="text-sm text-slate-500">No pools generated.</p>}
          <p className="text-xs text-slate-400">Payout to payslips happens in the payroll stream (§28).</p>
        </div>
      )}

      {/* ================= Guard Bonuses ================= */}
      {tab === "guard" && (
        <GuardBonusTab
          companyId={companyId}
          guardBonuses={guardBonuses}
          nameById={nameById}
          run={run}
          busy={busy}
        />
      )}
    </div>
  );
}

// -------------------- Appraisals tab --------------------
function AppraisalsTab({
  companyId,
  year,
  setYear,
  appraisals,
  enrolled,
  nameById,
  run,
  busy,
}: {
  companyId: string;
  year: number;
  setYear: (y: number) => void;
  appraisals: any[];
  enrolled: EmpLite[];
  nameById: Map<string, string>;
  run: (p: PromiseLike<{ error: { message: string } | null }>) => Promise<boolean>;
  busy: boolean;
}) {
  const [empId, setEmpId] = useState("");
  const [scores, setScores] = useState({ job: "", own: "", qual: "", team: "", init: "" });
  const [apprPct, setApprPct] = useState("10");
  const [effDate, setEffDate] = useState(new Date().toISOString().slice(0, 10));

  const create = async () => {
    if (!empId) return;
    await run(
      supabase.from("appraisals").insert({
        employee_id: empId,
        period_year: year,
        score_job_kpi: scores.job ? Number(scores.job) : null,
        score_ownership: scores.own ? Number(scores.own) : null,
        score_quality: scores.qual ? Number(scores.qual) : null,
        score_teamwork: scores.team ? Number(scores.team) : null,
        score_initiative: scores.init ? Number(scores.init) : null,
      }),
    );
  };

  const NEXT: Record<string, string> = { draft: "moderated", moderated: "approved" };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <label className="text-sm text-slate-600">Year</label>
        <input type="number" className={FIELD + " w-24"} value={year} onChange={(e) => setYear(Number(e.target.value))} />
      </div>

      <section className="border border-slate-200 rounded-md p-3">
        <h3 className="text-sm text-slate-900 mb-2">New appraisal</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <select className={FIELD} value={empId} onChange={(e) => setEmpId(e.target.value)}>
            <option value="">— employee —</option>
            {enrolled.map((e) => (
              <option key={e.id} value={e.id}>{e.full_name}</option>
            ))}
          </select>
          <input className={FIELD} placeholder="Job & KPI 1-5" value={scores.job} onChange={(e) => setScores({ ...scores, job: e.target.value })} />
          <input className={FIELD} placeholder="Ownership 1-5" value={scores.own} onChange={(e) => setScores({ ...scores, own: e.target.value })} />
          <input className={FIELD} placeholder="Quality 1-5" value={scores.qual} onChange={(e) => setScores({ ...scores, qual: e.target.value })} />
          <input className={FIELD} placeholder="Teamwork 1-5" value={scores.team} onChange={(e) => setScores({ ...scores, team: e.target.value })} />
          <input className={FIELD} placeholder="Initiative 1-5" value={scores.init} onChange={(e) => setScores({ ...scores, init: e.target.value })} />
        </div>
        <div className="mt-2">
          <Button variant="primary" size="sm" disabled={busy || !empId} onClick={create}>Create appraisal</Button>
        </div>
        <p className="text-xs text-slate-400 mt-1">Weighted score &amp; rating are computed by the DB; the 35% job/KPI criterion auto-fills from §14.</p>
      </section>

      <section>
        <h3 className="text-sm text-slate-900 mb-2">Appraisals</h3>
        <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
          {appraisals.map((a) => (
            <div key={a.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-slate-800">
                {nameById.get(a.employee_id) ?? a.employee_id} · {a.period_year}
                {a.rating ? ` · ${a.rating}` : ""}
                {a.weighted_score ? ` (${Number(a.weighted_score).toFixed(2)})` : ""}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200">{a.status}</span>
                {NEXT[a.status] && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => run(supabase.rpc("transition_appraisal", { p_appraisal_id: a.id, p_to: NEXT[a.status] }))}
                  >
                    → {NEXT[a.status]}
                  </Button>
                )}
              </div>
            </div>
          ))}
          {appraisals.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No appraisals yet.</p>}
        </div>
      </section>

      <section className="border border-slate-200 rounded-md p-3">
        <h3 className="text-sm text-slate-900 mb-2">Appreciation (annual flat %)</h3>
        <div className="flex items-center gap-2 flex-wrap">
          <input className={FIELD + " w-20"} value={apprPct} onChange={(e) => setApprPct(e.target.value)} placeholder="%" />
          <span className="text-sm text-slate-500">effective</span>
          <input type="date" className={FIELD} value={effDate} onChange={(e) => setEffDate(e.target.value)} />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => run(supabase.rpc("run_appreciation", { p_company_id: companyId, p_effective_date: effDate, p_appraisal_year: year }))}
          >
            Apply to all in good standing
          </Button>
        </div>
        <p className="text-xs text-slate-400 mt-1">Writes an increment to salary history from the effective date. Below-rated are excluded.</p>
      </section>
    </div>
  );
}

// -------------------- Guard bonuses tab --------------------
function GuardBonusTab({
  companyId,
  guardBonuses,
  nameById,
  run,
  busy,
}: {
  companyId: string;
  guardBonuses: any[];
  nameById: Map<string, string>;
  run: (p: PromiseLike<{ error: { message: string } | null }>) => Promise<boolean>;
  busy: boolean;
}) {
  const [attMonth, setAttMonth] = useState(thisMonthStart());
  const [attAmount, setAttAmount] = useState("");
  const [eidDate, setEidDate] = useState(new Date().toISOString().slice(0, 10));
  const [eidAmount, setEidAmount] = useState("");

  return (
    <div className="space-y-5">
      <section className="border border-slate-200 rounded-md p-3 space-y-3">
        <h3 className="text-sm text-slate-900">Accrue bonuses</h3>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-slate-600 w-24">Attendance</span>
          <input type="date" className={FIELD} value={attMonth} onChange={(e) => setAttMonth(e.target.value)} title="Any date in the month" />
          <input className={FIELD + " w-28"} placeholder="Amount" value={attAmount} onChange={(e) => setAttAmount(e.target.value)} />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !attAmount}
            onClick={() => run(supabase.rpc("accrue_attendance_bonuses", { p_company_id: companyId, p_period: attMonth, p_amount: Number(attAmount) }))}
          >
            Accrue
          </Button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-slate-600 w-24">Eid</span>
          <input type="date" className={FIELD} value={eidDate} onChange={(e) => setEidDate(e.target.value)} />
          <input className={FIELD + " w-28"} placeholder="Amount" value={eidAmount} onChange={(e) => setEidAmount(e.target.value)} />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !eidAmount}
            onClick={() => run(supabase.rpc("accrue_eid_bonuses", { p_company_id: companyId, p_eid_date: eidDate, p_amount: Number(eidAmount) }))}
          >
            Accrue
          </Button>
        </div>
        <p className="text-xs text-slate-400">Referral and long-service bonuses accrue automatically / per-guard. Attendance qualifies guards with zero unexcused absences.</p>
      </section>

      <section>
        <h3 className="text-sm text-slate-900 mb-2">Guard bonus ledger</h3>
        <div className="border border-slate-200 rounded-md divide-y divide-slate-100">
          {guardBonuses.map((g) => (
            <div key={g.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-slate-800">
                {nameById.get(g.employee_id) ?? g.employee_id} · {g.bonus_type}
                {g.period_month ? ` · ${formatDate(g.period_month)}` : ""} · {Number(g.amount ?? 0).toLocaleString()}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200">{g.status}</span>
                {g.status === "accrued" && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    onClick={() => run(supabase.from("guard_bonuses").update({ status: "approved" }).eq("id", g.id))}
                  >
                    Approve
                  </Button>
                )}
              </div>
            </div>
          ))}
          {guardBonuses.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">No guard bonuses accrued.</p>}
        </div>
        <p className="text-xs text-slate-400 mt-1">Approved bonuses pay out via the guard payroll stream (§28).</p>
      </section>
    </div>
  );
}
