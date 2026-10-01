// Performance & Rewards (web Performance.tsx): KPIs, appraisals, bonus pools,
// guard bonuses. Every write is the web's own RPC or insert.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, HStack, Input, Ledger, ListCard, Row, Section, Tabs } from "../../components/ui";
import { useDB } from "../../data/store";
import { q, sb, todayIso } from "../../data/api/core";
import { useAuth } from "../../lib/auth";
import { fmtDate } from "../../lib/format";

type Tab = "kpis" | "appraisals" | "pools" | "guard";
const RAG = { green: "success", amber: "warning", red: "danger" } as const;
const KPI_SEATS = ["accounts", "hr", "compliance", "client_management", "regional_admin"] as const;
const thisMonthStart = () => new Date().toISOString().slice(0, 8) + "01";
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
type EmpLite = { id: string; full_name: string; category: string; kpi_seat: string | null; performance_enrolled: boolean };
type Data = { employees: EmpLite[]; branches: any[]; kpi: any[]; appraisals: any[]; pools: any[]; allocations: any[]; guardBonuses: any[] };

async function loadPerformance(): Promise<Data> {
  const s = sb();
  const [employees, branches, kpi, appraisals, pools, allocations, guardBonuses] = await Promise.all([
    q<EmpLite[]>(s.from("employees").select("id, full_name, category, kpi_seat, performance_enrolled, lifecycle_state").order("full_name")),
    q<any[]>(s.from("branches").select("*").order("is_head_office", { ascending: false }).order("name")),
    q<any[]>(s.from("kpi_dashboard").select("*")),
    q<any[]>(s.from("appraisals").select("*").order("period_year", { ascending: false })),
    q<any[]>(s.from("bonus_pools").select("*").order("period_year", { ascending: false })),
    q<any[]>(s.from("bonus_pool_allocations").select("*")),
    q<any[]>(s.from("guard_bonuses").select("*").order("created_at", { ascending: false })),
  ]);
  return { employees, branches, kpi, appraisals, pools, allocations, guardBonuses };
}

export default function Performance() {
  const { db } = useDB();
  const { can } = useAuth();
  const { toast } = useOverlay();
  const canApprove = can("performance.approve");
  const companyId = db.company.id;
  const [tab, setTab] = useState<Tab>("kpis");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [year, setYear] = useState(String(new Date().getFullYear()));

  const load = useCallback(async () => { try { setData(await loadPerformance()); setError(null); } catch (e) { setError(err(e)); } }, []);
  useEffect(() => { const h = setTimeout(() => { void load(); }, 0); return () => clearTimeout(h); }, [load]);

  /** The web `run`: one write, the error shown verbatim, then reload. */
  const run = async (p: PromiseLike<{ error: { message: string } | null }>, ok?: string) => {
    setBusy(true); setError(null);
    const { error: e } = await p;
    setBusy(false);
    if (e) { setError(e.message); toast(e.message, "danger"); return false; }
    await load();
    if (ok) toast(ok);
    return true;
  };
  const rpc = (fn: string, args: Record<string, unknown>) => sb().rpc(fn as never, args as never);

  const nameById = useMemo(() => new Map((data?.employees ?? []).map((e) => [e.id, e.full_name])), [data]);
  const officeStaff = useMemo(() => (data?.employees ?? []).filter((e) => e.category === "office_staff"), [data]);
  const y = Number(year) || new Date().getFullYear();

  return (
    <Screen eyebrow="Workforce" title="Performance & Rewards" subtitle="KPIs, appraisals, bonus pools and guard bonuses"
      sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "kpis", label: "KPIs" }, { key: "appraisals", label: "Appraisals" }, { key: "pools", label: "Bonus pools" }, { key: "guard", label: "Guard bonuses" }]} />}>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}

      {data && tab === "kpis" && (
        <>
          <Section title="Enrollment (salaried staff)" hint="Enrollment requires COO approval — enforced by the RPC."
            action={<Button size="sm" variant="secondary" label="Run KPI computation" disabled={busy} onPress={() => run(rpc("run_kpi_computation", { p_company_id: companyId, p_period: thisMonthStart() }), "KPI computation run")} />}>
            {officeStaff.map((e) => (
              <Card key={e.id} style={{ marginBottom: 8 }}>
                <T v="bodyStrong">{e.full_name}</T>
                <HStack style={{ marginTop: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Select compact label="Seat" value={e.kpi_seat ?? ""} placeholder="— seat —" clearable
                      onChange={(seat) => run(rpc("set_performance_enrollment", { p_employee_id: e.id, p_enrolled: e.performance_enrolled, p_seat: seat || null }))}
                      options={KPI_SEATS.map((s) => ({ value: s, label: s.replace("_", " ") }))} />
                  </View>
                  <Button size="sm" variant={e.performance_enrolled ? "secondary" : "primary"} label={e.performance_enrolled ? "Enrolled ✓" : "Enroll"} disabled={busy}
                    onPress={() => run(rpc("set_performance_enrollment", { p_employee_id: e.id, p_enrolled: !e.performance_enrolled, p_seat: e.kpi_seat }))} />
                </HStack>
              </Card>
            ))}
            {officeStaff.length === 0 && <T v="small" muted>No salaried staff.</T>}
          </Section>
          <Section title="KPI dashboard">
            <ListCard>
              {data.kpi.map((r, i) => (
                <Row key={i} last={i === data.kpi.length - 1} title={r.full_name} subtitle={r.name}
                  meta={`Target ${r.target ?? "—"} · Value ${r.value ?? "—"}`}
                  right={r.rag ? <Badge small tone={RAG[r.rag as keyof typeof RAG]} label={r.rag} /> : <T v="small" muted>—</T>} />
              ))}
            </ListCard>
            {data.kpi.length === 0 && <T v="small" muted>No enrolled KPI data yet.</T>}
          </Section>
        </>
      )}

      {data && tab === "appraisals" && (
        <Appraisals data={data} year={year} setYear={setYear} y={y} companyId={companyId} nameById={nameById} busy={busy} run={run} rpc={rpc}
          enrolled={officeStaff.filter((e) => e.performance_enrolled)} />
      )}

      {data && tab === "pools" && (
        <>
          <Banner tone="warning" title="Regional profit is stated after head-office cost allocation." sub="Run HO cost allocation for the period (Treasury → Regional P&L) before sizing pools so profit isn't overstated." />
          <Input label="Year" keyboardType="numeric" value={year} onChangeText={setYear} />
          {canApprove && (
            <View style={{ gap: 8, marginBottom: 12 }}>
              <Button variant="secondary" label="Generate HO pool" disabled={busy} onPress={() => run(rpc("generate_bonus_pool", { p_company_id: companyId, p_year: y, p_scope: "head_office" }), "HO pool generated")} />
              {data.branches.filter((b) => !b.is_head_office).map((b) => (
                <Button key={b.id} variant="secondary" label={`Generate ${b.name} pool`} disabled={busy}
                  onPress={() => run(rpc("generate_bonus_pool", { p_company_id: companyId, p_year: y, p_scope: "regional", p_branch_id: b.id }), `${b.name} pool generated`)} />
              ))}
            </View>
          )}
          {data.pools.map((p) => (
            <Card key={p.id} style={{ marginBottom: 10 }}>
              <HStack>
                <View style={{ flex: 1 }}>
                  <T v="bodyStrong">{p.period_year} · {p.scope}{p.branch_id ? ` · ${data.branches.find((b) => b.id === p.branch_id)?.name ?? ""}` : ""}</T>
                  <T v="small" muted>growth {Number(p.growth ?? 0).toLocaleString()} → pool {Number(p.pool_amount ?? 0).toLocaleString()}</T>
                </View>
                <Badge small label={p.status} />
              </HStack>
              {data.allocations.filter((a) => a.pool_id === p.id && Number(a.share_amount) > 0).map((a) => (
                <Ledger key={a.id} label={`${nameById.get(a.employee_id) ?? a.employee_id} · ${a.rating ?? "unrated"}`} value={`${Number(a.share_amount ?? 0).toLocaleString()}${a.paid ? " · paid" : ""}`} />
              ))}
              {p.status === "draft" && canApprove && <Button size="sm" label="Approve" style={{ marginTop: 8, alignSelf: "flex-start" }} disabled={busy} onPress={() => run(rpc("approve_bonus_pool", { p_pool_id: p.id }), "Pool approved")} />}
            </Card>
          ))}
          {data.pools.length === 0 && <T v="small" muted>No pools generated.</T>}
          <T v="small" muted style={{ marginTop: 8 }}>Payout to payslips happens in the payroll stream (§28).</T>
        </>
      )}

      {data && tab === "guard" && <GuardBonuses data={data} companyId={companyId} nameById={nameById} busy={busy} run={run} rpc={rpc} canApprove={canApprove} />}
    </Screen>
  );
}

type Run = (p: PromiseLike<{ error: { message: string } | null }>, ok?: string) => Promise<boolean>;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>;

function Appraisals({ data, year, setYear, y, companyId, nameById, busy, run, rpc, enrolled }: {
  data: Data; year: string; setYear: (s: string) => void; y: number; companyId: string; nameById: Map<string, string>; busy: boolean; run: Run; rpc: Rpc; enrolled: EmpLite[];
}) {
  const [empId, setEmpId] = useState("");
  const [scores, setScores] = useState({ job: "", own: "", qual: "", team: "", init: "" });
  const [apprPct, setApprPct] = useState("10");
  const [effDate, setEffDate] = useState(todayIso());
  const NEXT: Record<string, string> = { draft: "moderated", moderated: "approved" };
  const n = (s: string) => (s ? Number(s) : null);
  return (
    <>
      <Input label="Year" keyboardType="numeric" value={year} onChangeText={setYear} />
      <Section title="New appraisal" hint="Weighted score & rating are computed by the DB; the 35% job/KPI criterion auto-fills from §14.">
        <Card>
          <Select label="Employee" searchable value={empId} onChange={setEmpId} placeholder="— employee —" options={enrolled.map((e) => ({ value: e.id, label: e.full_name }))} />
          <HStack>
            <Input style={{ flex: 1 }} label="Job & KPI 1-5" keyboardType="numeric" value={scores.job} onChangeText={(v) => setScores({ ...scores, job: v })} />
            <Input style={{ flex: 1 }} label="Ownership 1-5" keyboardType="numeric" value={scores.own} onChangeText={(v) => setScores({ ...scores, own: v })} />
          </HStack>
          <HStack>
            <Input style={{ flex: 1 }} label="Quality 1-5" keyboardType="numeric" value={scores.qual} onChangeText={(v) => setScores({ ...scores, qual: v })} />
            <Input style={{ flex: 1 }} label="Teamwork 1-5" keyboardType="numeric" value={scores.team} onChangeText={(v) => setScores({ ...scores, team: v })} />
          </HStack>
          <Input label="Initiative 1-5" keyboardType="numeric" value={scores.init} onChangeText={(v) => setScores({ ...scores, init: v })} />
          <Button label="Create appraisal" disabled={busy || !empId} onPress={async () => {
            const ok = await run(sb().from("appraisals").insert({
              employee_id: empId, period_year: y, score_job_kpi: n(scores.job), score_ownership: n(scores.own),
              score_quality: n(scores.qual), score_teamwork: n(scores.team), score_initiative: n(scores.init),
            } as never), "Appraisal created");
            if (ok) { setEmpId(""); setScores({ job: "", own: "", qual: "", team: "", init: "" }); }
          }} />
        </Card>
      </Section>
      <Section title="Appraisals" count={data.appraisals.length}>
        {data.appraisals.map((a) => (
          <Card key={a.id} style={{ marginBottom: 8 }}>
            <HStack>
              <T v="body" style={{ flex: 1 }}>{nameById.get(a.employee_id) ?? a.employee_id} · {a.period_year}{a.rating ? ` · ${a.rating}` : ""}{a.weighted_score ? ` (${Number(a.weighted_score).toFixed(2)})` : ""}</T>
              <Badge small label={a.status} />
            </HStack>
            {NEXT[a.status] && <Button size="sm" variant="secondary" style={{ marginTop: 8, alignSelf: "flex-start" }} label={`→ ${NEXT[a.status]}`} disabled={busy}
              onPress={() => run(rpc("transition_appraisal", { p_appraisal_id: a.id, p_to: NEXT[a.status] }))} />}
          </Card>
        ))}
      </Section>
      <Section title="Appreciation (annual flat %)" hint="Writes an increment to salary history from the effective date. Below-rated are excluded.">
        <Card>
          <HStack>
            <Input style={{ flex: 1 }} label="%" keyboardType="numeric" value={apprPct} onChangeText={setApprPct} />
            <Input style={{ flex: 2 }} label="Effective date" value={effDate} onChangeText={setEffDate} placeholder="YYYY-MM-DD" />
          </HStack>
          <Button variant="secondary" label="Apply to all in good standing" disabled={busy}
            onPress={() => run(rpc("run_appreciation", { p_company_id: companyId, p_effective_date: effDate, p_appraisal_year: y }), "Appreciation applied")} />
        </Card>
      </Section>
    </>
  );
}

function GuardBonuses({ data, companyId, nameById, busy, run, rpc, canApprove }: { data: Data; companyId: string; nameById: Map<string, string>; busy: boolean; run: Run; rpc: Rpc; canApprove: boolean }) {
  const [attMonth, setAttMonth] = useState(thisMonthStart());
  const [attAmount, setAttAmount] = useState("");
  const [eidDate, setEidDate] = useState(todayIso());
  const [eidAmount, setEidAmount] = useState("");
  return (
    <>
      <Section title="Accrue bonuses" hint="Referral and long-service bonuses accrue automatically / per-guard. Attendance qualifies guards with zero unexcused absences.">
        <Card style={{ marginBottom: 10 }}>
          <T v="bodyStrong">Attendance</T>
          <HStack>
            <Input style={{ flex: 1 }} label="Any date in the month" value={attMonth} onChangeText={setAttMonth} placeholder="YYYY-MM-DD" />
            <Input style={{ flex: 1 }} label="Amount" keyboardType="numeric" value={attAmount} onChangeText={setAttAmount} />
          </HStack>
          <Button variant="secondary" label="Accrue" disabled={busy || !attAmount} onPress={() => run(rpc("accrue_attendance_bonuses", { p_company_id: companyId, p_period: attMonth, p_amount: Number(attAmount) }), "Attendance bonuses accrued")} />
        </Card>
        <Card>
          <T v="bodyStrong">Eid</T>
          <HStack>
            <Input style={{ flex: 1 }} label="Eid date" value={eidDate} onChangeText={setEidDate} placeholder="YYYY-MM-DD" />
            <Input style={{ flex: 1 }} label="Amount" keyboardType="numeric" value={eidAmount} onChangeText={setEidAmount} />
          </HStack>
          <Button variant="secondary" label="Accrue" disabled={busy || !eidAmount} onPress={() => run(rpc("accrue_eid_bonuses", { p_company_id: companyId, p_eid_date: eidDate, p_amount: Number(eidAmount) }), "Eid bonuses accrued")} />
        </Card>
      </Section>
      <Section title="Guard bonus ledger" count={data.guardBonuses.length} hint="Approved bonuses pay out via the guard payroll stream (§28).">
        {data.guardBonuses.map((g) => (
          <Card key={g.id} style={{ marginBottom: 8 }}>
            <HStack>
              <T v="body" style={{ flex: 1 }}>{nameById.get(g.employee_id) ?? g.employee_id} · {g.bonus_type}{g.period_month ? ` · ${fmtDate(g.period_month)}` : ""} · {Number(g.amount ?? 0).toLocaleString()}</T>
              <Badge small label={g.status} tone={g.status === "approved" ? "success" : g.status === "accrued" ? "warning" : undefined} />
            </HStack>
            {g.status === "accrued" && canApprove && <Button size="sm" label="Approve" style={{ marginTop: 8, alignSelf: "flex-start" }} disabled={busy}
              onPress={() => run(sb().from("guard_bonuses").update({ status: "approved" } as never).eq("id", g.id), "Bonus approved")} />}
          </Card>
        ))}
      </Section>
    </>
  );
}
