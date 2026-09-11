import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ShieldAlert, ShieldCheck, Loader2, AlertCircle, ArrowRight, Building2, Users, Lock, Search, X, Download } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import PayrollManagement from "./PayrollManagement";
import { supabase } from "../../lib/supabase";
import { useAuth, hasPermission } from "../../lib/auth";
import { useRegion, withRegion } from "../../lib/region";
import { exportPayrollSheets, type PayrollExportRow } from "../../lib/excel";
import { guardDisplayCode } from "../../lib/guardCode";
import { isSeparatedState } from "../../lib/employmentWindow";

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

// Default to the previous month — payroll is processed after a month ends (in
// August you disburse July's salary). Matches Payroll Management's default.
const monthNow = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const fmtMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
};
// System date + time a verification happened, e.g. "24 Aug 2026, 5:49 PM".
const fmtStamp = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "";
// office_staff → "Office Staff", reliever → "Relievers" (pluralised for the group).
const catLabel = (cat: string) => {
  const t = cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return cat === "reliever" ? "Relievers" : t;
};

const todayIso = () => new Date().toISOString().slice(0, 10);

type Phase = "review" | "finance_verify";
type Scope = {
  key: string;              // clientId, or `cat:<category>`
  name: string;
  clientId: string | null;
  category: string | null;
  verifiable: boolean;      // false for relievers (no OPS-verify surface)
};
type Totals = { disbursed: number; notDisbursed: number; advance: number; disbursedCount: number; notDisbursedCount: number };
const ZERO_TOTALS: Totals = { disbursed: 0, notDisbursed: 0, advance: 0, disbursedCount: 0, notDisbursedCount: 0 };
const addTotals = (a: Totals, b: Totals): Totals => ({
  disbursed: a.disbursed + b.disbursed,
  notDisbursed: a.notDisbursed + b.notDisbursed,
  advance: a.advance + b.advance,
  disbursedCount: a.disbursedCount + b.disbursedCount,
  notDisbursedCount: a.notDisbursedCount + b.notDisbursedCount,
});

export default function PayrollRun() {
  const { profile } = useAuth();
  // Payroll run sign-off (Send to Finance / Finance Verify) is gated on
  // payroll.approve (super_admin + SSA implicit). NOTE: the phase table these
  // write is not yet under backend RLS (see 0313 recommendation) — FE-only.
  const canApprovePayroll = hasPermission(profile, "payroll.approve");
  const { regionId } = useRegion();
  const [month, setMonth] = useState(monthNow());
  const period = `${month}-01`;

  const [tab, setTab] = useState<"draft" | "review" | "finance_verify">("draft");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [scopes, setScopes] = useState<Scope[]>([]);
  const [verified, setVerified] = useState<Set<string>>(new Set());       // scope keys OPS-verified this month
  const [verifiedAt, setVerifiedAt] = useState<Map<string, string>>(new Map()); // key → OPS verified timestamp
  const [phaseByKey, setPhaseByKey] = useState<Map<string, Phase>>(new Map());
  const [financeVerified, setFinanceVerified] = useState<Set<string>>(new Set()); // permanently Finance Verified keys
  const [financeVerifiedAt, setFinanceVerifiedAt] = useState<Map<string, string>>(new Map()); // key → Finance verified timestamp
  const [expanded, setExpanded] = useState<string | null>(null);
  // One search box across all three tabs. A client does not stop being the thing
  // you are looking for because it has moved from Draft to Review, and retyping
  // the name per tab is the kind of friction that makes people stop filtering.
  const [search, setSearch] = useState("");
  // Per-scope export rows, and the text each scope can be found by. Both are
  // built from the same employee+payslip read, so the sheet you export is the
  // roster the search matched.
  const [rowsByScope, setRowsByScope] = useState<Map<string, PayrollExportRow[]>>(new Map());
  const [searchIndex, setSearchIndex] = useState<Map<string, string>>(new Map());
  // Rows computed live by an expanded Review embed. Before Finance Verify these
  // are the ONLY complete figures that exist — see the onRows prop.
  const [liveRowsByScope, setLiveRowsByScope] = useState<Map<string, PayrollExportRow[]>>(new Map());
  // An export asked for on a scope whose live rows have not been computed yet.
  // The card is expanded, and this fires once its embed reports.
  const [pendingExport, setPendingExport] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPicked, setExportPicked] = useState<Set<string>>(new Set());
  // Finance Verify is irreversible → confirm first. { scope } = one, { all:true } = bulk.
  const [confirmFV, setConfirmFV] = useState<{ scope?: Scope; all?: boolean } | null>(null);
  // Per-scope payslip totals for the month, keyed like `verified`/`phaseByKey`.
  // Same columns PayrollManagement sums (payslips.net_salary/amount_paid/advance),
  // so the cards match the embedded page for saved payslips.
  const [totalsByKey, setTotalsByKey] = useState<Map<string, Totals>>(new Map());
  // Live totals reported by an expanded Review roster — Review has no persisted
  // payslips (those are written only at Finance Verify), so the cards must use the
  // roster's live figures. Falls back to persisted totals for un-opened scopes.
  const [liveTotalsByKey, setLiveTotalsByKey] = useState<Map<string, Totals>>(new Map());

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const [{ data: cls }, { data: cons }, { data: catEmps }, { data: postedEmps }, { data: vers }, { data: phs }, { data: ps }, { data: rosterEmps }] = await Promise.all([
        // A client carries a branch, and a branch IS the region — so the region
        // selector narrows the client list here exactly as it does on Employee
        // Assignments. A client with no branch belongs to no region and stays
        // visible everywhere.
        regionId
          ? supabase.from("clients").select("id, name, employee_id_prefix").or(`branch_id.eq.${regionId},branch_id.is.null`).order("name")
          : supabase.from("clients").select("id, name, employee_id_prefix").order("name"),
        supabase.from("contracts").select("client_id, contract_type, status, start_date, end_date, is_infinite"),
        // Client-less staff → category groups (office_staff, reliever, armed, gunman).
        supabase.from("employees").select("category").is("client_id", null).neq("category", "client").neq("lifecycle_state", "archived"),
        // Who is actually posted to a client, for the dormancy rule below.
        withRegion(
          supabase.from("employees").select("client_id, lifecycle_state, category").not("client_id", "is", null).range(0, 9999),
          regionId,
        ),
        supabase.from("attendance_month_verifications").select("client_id, category, verified_at").eq("period_month", period),
        supabase.from("payroll_run_phases").select("client_id, category, phase, finance_verified_at").eq("period_month", period),
        supabase
          .from("payslips")
          .select(
            "net_salary, amount_paid, advance, disbursed, employee_id, present_days, absent_days, leave_days, base_salary, allowance, bonus, final_salary, eobi, income_tax, deductions, payment_mode, status",
          )
          .eq("period_month", period),
        // Everyone who should appear on a sheet this month, whether or not a
        // payslip exists for them yet. Drives BOTH the employee search and the
        // export — see buildRows below for why the roster and not the payslips
        // is the spine.
        withRegion(
          supabase
            .from("employees")
            .select(
              "id, full_name, employee_code, guard_code, display_number, client_id, category, lifecycle_state, base_salary, allowance",
            )
            .not("lifecycle_state", "in", "(terminated,fired,left,absconded)")
            .neq("category", "reliever")
            .range(0, 9999),
          regionId,
        ),
      ]);
      // Which scope each of this month's payslips belongs to (client_id, else
      // `cat:<category>`). Resolved BEFORE the scope list is built, because the
      // services filter below needs to know which clients already have payslips.
      const rows = (ps ?? []) as any[];
      const empIds = Array.from(new Set(rows.map((r) => r.employee_id)));
      const empScope = new Map<string, string>();
      if (empIds.length) {
        const { data: emps } = await supabase.from("employees").select("id, client_id, category").in("id", empIds);
        for (const e of (emps ?? []) as any[]) empScope.set(e.id, e.client_id ?? `cat:${e.category}`);
      }

      // A "Services" contract bills for hardware (weapons / equipment), not people,
      // so a client whose contracts are ALL Services has nobody to pay and is noise
      // on every tab of this page. Same rule, same reasoning as the Employee
      // Assignments board. A client with no contracts at all stays visible: absence
      // of evidence isn't evidence that they have no guards.
      const servicesOnly = new Map<string, boolean>();
      for (const k of (cons ?? []) as any[]) {
        servicesOnly.set(k.client_id, (servicesOnly.get(k.client_id) ?? true) && k.contract_type === "services");
      }
      // ...except where this month already has work against them. A scope holding
      // a phase row or a payslip would be stranded mid-workflow by the filter —
      // neither visible nor finishable, and its money invisible to the totals — so
      // evidence of a real payroll outranks the contract-type rule.
      const hasWork = new Set<string>([
        ...((phs ?? []) as any[]).map((p) => p.client_id as string | null).filter(Boolean) as string[],
        ...[...empScope.values()].filter((k) => !k.startsWith("cat:")),
      ]);
      // Dormant clients — no contract live TODAY and nobody posted — are dropped,
      // the same pair of conditions Employee Assignments requires before it will
      // render a client card. Missing exactly one of the two is a problem to fix,
      // so that client stays; missing BOTH means there is no obligation and
      // nobody to pay, which is nothing this page can act on.
      const today = todayIso();
      const liveContract = new Set<string>();
      for (const k of (cons ?? []) as any[]) {
        if (k.status !== "active") continue;
        if (k.start_date && k.start_date > today) continue;
        if (!k.is_infinite && k.end_date && k.end_date < today) continue;
        liveContract.add(k.client_id);
      }
      // Relievers are NOT paid through the run: PayrollManagement's roster drops
      // them from every non-reliever surface, so they are paid on the Reliever
      // Payroll screen instead. That makes a RELIEF POOL client — one whose live
      // staff are all relievers — a scope with an empty roster behind it: it can
      // be drafted, reviewed and finance-verified while paying nobody. Dropped
      // here, so the only way it returns is somebody actually posting a payable
      // employee to it.
      const livePosted = ((postedEmps ?? []) as any[]).filter((e) => !isSeparatedState(e.lifecycle_state));
      const staffed = new Set<string>(
        livePosted.filter((e) => e.category !== "reliever").map((e) => e.client_id as string),
      );
      const reliefPoolOnly = new Set<string>(
        livePosted.filter((e) => !staffed.has(e.client_id as string)).map((e) => e.client_id as string),
      );
      const clientScopes: Scope[] = ((cls ?? []) as any[])
        .filter((c) =>
          hasWork.has(c.id) ||
          (!servicesOnly.get(c.id) && !reliefPoolOnly.has(c.id) && (liveContract.has(c.id) || staffed.has(c.id))),
        )
        .map((c) => ({ key: c.id, name: c.name, clientId: c.id, category: null, verifiable: true }));
      const cats = Array.from(new Set(((catEmps ?? []) as any[]).map((e) => e.category).filter(Boolean))).sort();
      const catScopes: Scope[] = cats.map((cat) => ({ key: `cat:${cat}`, name: catLabel(cat), clientId: null, category: cat, verifiable: cat !== "reliever" }));
      setScopes([...clientScopes, ...catScopes]);
      setVerified(new Set(((vers ?? []) as any[]).map((v) => (v.client_id ?? `cat:${v.category}`))));
      setVerifiedAt(new Map(((vers ?? []) as any[]).filter((v) => v.verified_at).map((v) => [(v.client_id ?? `cat:${v.category}`), v.verified_at as string])));
      setPhaseByKey(new Map(((phs ?? []) as any[]).map((p) => [(p.client_id ?? `cat:${p.category}`), p.phase as Phase])));
      setFinanceVerified(new Set(((phs ?? []) as any[]).filter((p) => p.finance_verified_at).map((p) => (p.client_id ?? `cat:${p.category}`))));
      setFinanceVerifiedAt(new Map(((phs ?? []) as any[]).filter((p) => p.finance_verified_at).map((p) => [(p.client_id ?? `cat:${p.category}`), p.finance_verified_at as string])));

      // Aggregate this month's payslips by scope, using the mapping resolved
      // above, and sum the same figures PayrollManagement shows so the cards
      // agree with the embedded page.
      const totals = new Map<string, Totals>();
      for (const r of rows) {
        const key = empScope.get(r.employee_id);
        if (!key) continue;
        const cur = totals.get(key) ?? { ...ZERO_TOTALS };
        const paid = Math.round(r.amount_paid || 0);
        cur.disbursed += paid;
        cur.notDisbursed += Math.max(0, Math.round(r.net_salary || 0) - paid);
        cur.advance += Math.round(r.advance || 0);
        if (r.disbursed) cur.disbursedCount += 1; else cur.notDisbursedCount += 1;
        totals.set(key, cur);
      }
      setTotalsByKey(totals);

      // ── Export rows, and the search text, per scope ──
      //
      // THE ROSTER IS THE SPINE, NOT THE PAYSLIPS, and that is the whole design
      // decision here. Payslips are only written at Finance Verify: this month
      // Draft holds 50 live employees and ZERO payslips, Review holds 132 and
      // one. An export driven off payslips would therefore hand back an empty
      // workbook on two of the three tabs — and hand it back silently, which is
      // the failure this codebase exists to remove.
      //
      // So every live employee in the scope gets a row. Where a payslip exists
      // the figures are its figures; where none does the row reads "No payslip
      // yet" with zeros. On Finance Verify that is an ordinary payroll sheet; on
      // Draft and Review it is the roster awaiting payroll, which is the useful
      // thing to export at those stages and also shows WHO is missing a payslip.
      const psByEmp = new Map<string, any>();
      for (const r of rows) psByEmp.set(r.employee_id, r);
      // The display code is {current client's prefix}-{display_number}, so the
      // prefix has to come from the client list, not the employee row.
      const prefixByClient = new Map<string, string | null>(
        ((cls ?? []) as any[]).map((c) => [c.id, c.employee_id_prefix ?? null]),
      );

      const rowsOut = new Map<string, PayrollExportRow[]>();
      const indexOut = new Map<string, string[]>();
      for (const e of ((rosterEmps ?? []) as any[])) {
        const key = e.client_id ?? `cat:${e.category}`;
        const r = psByEmp.get(e.id);
        const arr = rowsOut.get(key) ?? [];
        arr.push({
          employeeCode: guardDisplayCode(e, e.client_id ? prefixByClient.get(e.client_id) ?? null : null),
          guardCode: e.guard_code ?? e.employee_code ?? "",
          name: e.full_name ?? "",
          hasPayslip: !!r,
          presentDays: Number(r?.present_days ?? 0),
          absentDays: Number(r?.absent_days ?? 0),
          leaveDays: Number(r?.leave_days ?? 0),
          // From the payslip once one exists, else from the employee record —
          // these two are contractual and known before payroll runs, which is
          // what makes a Draft-stage sheet worth having.
          baseSalary: Math.round(Number(r?.base_salary ?? e.base_salary ?? 0)),
          allowance: Math.round(Number(r?.allowance ?? e.allowance ?? 0)),
          bonus: Math.round(Number(r?.bonus ?? 0)),
          finalSalary: Math.round(Number(r?.final_salary ?? 0)),
          advance: Math.round(Number(r?.advance ?? 0)),
          eobi: Math.round(Number(r?.eobi ?? 0)),
          incomeTax: Math.round(Number(r?.income_tax ?? 0)),
          deductions: Math.round(Number(r?.deductions ?? 0)),
          netSalary: Math.round(Number(r?.net_salary ?? 0)),
          amountPaid: Math.round(Number(r?.amount_paid ?? 0)),
          paymentMode: r?.payment_mode ?? "",
          status: !r ? "No payslip yet" : r.disbursed ? "Disbursed" : (r.status ?? "Pending"),
        });
        rowsOut.set(key, arr);
        const idx = indexOut.get(key) ?? [];
        // Findable by either code — people quote whichever is in front of them,
        // the client-prefixed one on a roster or the GGS one on a payslip.
        idx.push(
          `${e.full_name ?? ""} ${e.employee_code ?? ""} ${e.guard_code ?? ""} ${guardDisplayCode(e, e.client_id ? prefixByClient.get(e.client_id) ?? null : null)}`.toLowerCase(),
        );
        indexOut.set(key, idx);
      }
      for (const arr of rowsOut.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
      setRowsByScope(rowsOut);
      setSearchIndex(new Map([...indexOut].map(([k, v]) => [k, v.join(" | ")])));
    } catch (e: any) { setErr(e.message ?? String(e)); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [period, regionId]);

  // Matches a client or staff-group name. Trimmed and lowercased once here
  // rather than per row, and returning true on an empty query keeps the three
  // memos below free of "is there a search" branching.
  // Matches the scope's own name OR any employee in it, by name or code. One
  // box rather than two: "find Emaar" and "find GGS-00287" are the same act —
  // show me the card this person is on — and a second input would make the user
  // decide which kind of thing they were about to type before typing it.
  const matchesSearch = useCallback(
    (s: Scope) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      if (s.name.toLowerCase().includes(q)) return true;
      return (searchIndex.get(s.key) ?? "").includes(q);
    },
    [search, searchIndex],
  );

  // Both tabs sort by what the user can still ACT on, so the work is at the top
  // and the done pile sinks. Array.prototype.sort is stable, so scopes within a
  // half keep the name order `scopes` was built in.
  //
  // Draft: OPS-verified first — a blocked scope has no button, so it is not work
  // that can be done here. Ungated scopes (relievers) sort with the verified,
  // because they are equally ready to move.
  const draftScopes = useMemo(
    () =>
      scopes
        .filter((s) => !phaseByKey.has(s.key) && matchesSearch(s))
        .sort((a, b) => {
          const ready = (s: Scope) => (!s.verifiable || verified.has(s.key) ? 0 : 1);
          return ready(a) - ready(b);
        }),
    [scopes, phaseByKey, verified, matchesSearch],
  );
  const reviewScopes = useMemo(
    () => scopes.filter((s) => phaseByKey.get(s.key) === "review" && matchesSearch(s)),
    [scopes, phaseByKey, matchesSearch],
  );
  // Finance Verify: signed-off scopes sink. Finance Verify is permanent, so a
  // verified row is frozen — nothing on it can be actioned again.
  const financeScopes = useMemo(
    () =>
      scopes
        .filter((s) => phaseByKey.get(s.key) === "finance_verify" && matchesSearch(s))
        .sort((a, b) => Number(financeVerified.has(a.key)) - Number(financeVerified.has(b.key))),
    [scopes, phaseByKey, financeVerified, matchesSearch],
  );

  // A scope the search has just hidden must not stay expanded — its embedded
  // roster would keep rendering under a list it is no longer in, and the Review
  // totals are scoped to `expanded` when it is set, so the cards would report a
  // client that is not on screen. Only collapses when it genuinely drops out, so
  // typing while something is open does not keep snapping it shut.
  useEffect(() => {
    if (!expanded) return;
    const stillVisible = scopes.some((s) => s.key === expanded && matchesSearch(s));
    if (!stillVisible) setExpanded(null);
  }, [expanded, scopes, matchesSearch]);

  // The queued export, fired when the scope it was asked for reports its rows.
  useEffect(() => {
    if (!pendingExport) return;
    const rows = liveRowsByScope.get(pendingExport);
    if (!rows || rows.length === 0) return;
    runExportRef.current(pendingExport);
    setPendingExport(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingExport, liveRowsByScope]);

  // Review-tab cards: the expanded client's totals, else the sum across every
  // client currently in Review this month. Same source for both, so they agree.
  const reviewCardTotals = useMemo(() => {
    const forKey = (k: string) => liveTotalsByKey.get(k) ?? totalsByKey.get(k) ?? ZERO_TOTALS;
    if (expanded) return forKey(expanded);
    return reviewScopes.reduce((acc, s) => addTotals(acc, forKey(s.key)), { ...ZERO_TOTALS });
  }, [expanded, reviewScopes, totalsByKey, liveTotalsByKey]);

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

  // Finance Verify — PERMANENT sign-off. Stamps finance_verified_at; a DB trigger
  // then freezes the row (no Back to Review, no delete). Locks OPS un-verify too.
  const financeVerify = async (s: Scope) => {
    setBusyKey(s.key); setErr(null);
    const q = supabase.from("payroll_run_phases")
      .update({ finance_verified_at: new Date().toISOString(), finance_verified_by: profile?.id ?? null })
      .eq("period_month", period);
    const { error } = await (s.clientId ? q.eq("client_id", s.clientId) : q.eq("category", s.category as string));
    setBusyKey(null);
    if (error) { setErr(error.message); return; }
    await load();
  };

  const financeVerifyAll = async () => {
    const pending = financeScopes.filter((s) => !financeVerified.has(s.key));
    if (pending.length === 0) return;
    setBusyKey("__all__"); setErr(null);
    for (const s of pending) {
      const q = supabase.from("payroll_run_phases")
        .update({ finance_verified_at: new Date().toISOString(), finance_verified_by: profile?.id ?? null })
        .eq("period_month", period);
      const { error } = await (s.clientId ? q.eq("client_id", s.clientId) : q.eq("category", s.category as string));
      if (error) { setBusyKey(null); setErr(error.message); await load(); return; }
    }
    setBusyKey(null);
    await load();
  };

  // The scopes the CURRENT tab is showing — what a bulk export acts on, and what
  // the picker lists. Exporting from Draft while looking at Finance Verify would
  // be a button that does something other than what is on screen.
  const visibleScopes = tab === "draft" ? draftScopes : tab === "review" ? reviewScopes : financeScopes;

  // Live rows win over the persisted fallback. A scope that has been opened this
  // session has real figures for everybody; one that has not falls back to the
  // roster, where anyone without a saved payslip exports with blank salary
  // columns and "No payslip yet" against their name.
  const buildSheets = (keys: string[]) =>
    keys
      .map((k) => ({
        name: scopes.find((sc) => sc.key === k)?.name ?? "Client",
        rows: liveRowsByScope.get(k) ?? rowsByScope.get(k) ?? [],
      }))
      .filter((sheet) => sheet.rows.length > 0);

  const runExport = (keys: string[]) => {
    exportPayrollSheets(buildSheets(keys), fmtMonth(month));
  };
  // Held in a ref so the queued-export effect above does not have to list
  // runExport (and therefore every map it closes over) as a dependency.
  const runExportRef = useRef((k: string) => runExport([k]));
  runExportRef.current = (k: string) => runExport([k]);

  /**
   * Export one scope, with real figures.
   *
   * If the scope is on the Review tab and has not been opened, its payroll has
   * not been computed by anything yet — only the embedded roster does that. So
   * open it and export when the numbers arrive, rather than handing back a sheet
   * of blanks and letting the user work out why.
   */
  const exportScope = (s: Scope) => {
    const needsCompute =
      tab === "review" && !liveRowsByScope.has(s.key) &&
      (rowsByScope.get(s.key) ?? []).some((r) => !r.hasPayslip);
    if (needsCompute) {
      setExpanded(s.key);
      setPendingExport(s.key);
      return;
    }
    runExport([s.key]);
  };

  const TABS: { key: typeof tab; label: string; count: number }[] = [
    { key: "draft", label: "Draft", count: draftScopes.length },
    { key: "review", label: "Review", count: reviewScopes.length },
    { key: "finance_verify", label: "Finance Verify", count: financeScopes.length },
  ];

  // The same control on all three tabs. A Draft card and a Finance-Verified card
  // export the same shape of sheet — the difference is what is IN it, which the
  // Status column states per row rather than the button implying by absence.
  const ExportScopeButton = ({ s }: { s: Scope }) => {
    const n = rowsByScope.get(s.key)?.length ?? 0;
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); exportScope(s); }}
        disabled={n === 0 || pendingExport === s.key}
        title={n === 0 ? "Nobody is on this scope to export" : `Export ${s.name} — ${n} employee${n === 1 ? "" : "s"}`}
        aria-label={`Export ${s.name}'s sheet`}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
      >
        {pendingExport === s.key
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <Download className="w-3.5 h-3.5" strokeWidth={1.5} />}
        {pendingExport === s.key ? "Calculating…" : "Export"}
      </button>
    );
  };

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
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" strokeWidth={1.5} />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search client, group or employee…"
                aria-label="Search clients and staff groups"
                className="w-56 pl-8 pr-8 py-1.5 border border-border rounded-md text-sm bg-card"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3.5 h-3.5" strokeWidth={2} />
                </button>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Month
              <input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setExpanded(null); }}
                className="px-2 py-1.5 border border-border rounded-md text-sm bg-card" />
            </label>
            {/* Acts on the tab you are looking at — see visibleScopes. */}
            <Button
              variant="secondary"
              size="sm"
              disabled={visibleScopes.length === 0}
              onClick={() => { setExportPicked(new Set(visibleScopes.map((sc) => sc.key))); setExportOpen(true); }}
            >
              <Download className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
              Export sheets
            </Button>
          </div>
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
                {draftScopes.length === 0 && (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    {search.trim()
                      ? `Nothing in Draft matches “${search.trim()}”.`
                      : `Nothing left in Draft for ${fmtMonth(month)}.`}
                  </p>
                )}
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
                          <p className="text-xs text-success-700 dark:text-success-500 flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" /> OPS-verified for {fmtMonth(month)}{verifiedAt.get(s.key) ? ` · ${fmtStamp(verifiedAt.get(s.key))}` : ""}</p>
                        ) : (
                          <p className="text-xs text-warning-700 dark:text-warning-500 flex items-center gap-1"><ShieldAlert className="w-3.5 h-3.5" /> Verify OPS first — not verified for {fmtMonth(month)}</p>
                        )}
                      </div>
                      <ExportScopeButton s={s} />
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
                {/* Summary cards — scoped to the expanded client, else all Review
                    clients. Review doesn't disburse, so we show what's payable:
                    Total Salaries (net) and Total Advance. */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-2">
                  <div className="bg-card p-5 rounded-xl border border-border border-l-4 border-l-success-500">
                    <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Total Salaries</p>
                    <p className="text-2xl font-semibold tabular-nums text-success-700 dark:text-success-500" style={{ fontFamily: "var(--font-display)" }}>
                      PKR {(reviewCardTotals.disbursed + reviewCardTotals.notDisbursed).toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">{reviewCardTotals.disbursedCount + reviewCardTotals.notDisbursedCount} payslip{reviewCardTotals.disbursedCount + reviewCardTotals.notDisbursedCount === 1 ? "" : "s"}</p>
                  </div>
                  <div className="bg-card p-5 rounded-xl border border-border border-l-4 border-l-danger-500">
                    <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground mb-1.5">Total Advance</p>
                    <p className="text-2xl font-semibold tabular-nums text-danger-700 dark:text-danger-500" style={{ fontFamily: "var(--font-display)" }}>
                      PKR {reviewCardTotals.advance.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">for {fmtMonth(month)}{expanded ? "" : " · all Review clients"}</p>
                  </div>
                </div>
                {reviewScopes.length === 0 && (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    {search.trim()
                      ? `Nothing in Review matches “${search.trim()}”.`
                      : "Nothing in Review. Move a scope from Draft."}
                  </p>
                )}
                {reviewScopes.map((s) => {
                  const open = expanded === s.key;
                  return (
                    <div key={s.key} className="bg-card rounded-xl border border-border overflow-hidden">
                      <div className="flex items-center gap-2 p-4 flex-wrap">
                        <button type="button" onClick={() => setExpanded(open ? null : s.key)} className="flex items-center gap-2 min-w-0 flex-1 text-left">
                          <ChevronRight className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
                          <ScopeIcon s={s} />
                          <span className="min-w-0">
                            <span className="text-sm font-medium text-foreground truncate block">{s.name}</span>
                            {verifiedAt.get(s.key) && (
                              <span className="text-[11px] text-muted-foreground block">OPS verified: {fmtStamp(verifiedAt.get(s.key))}</span>
                            )}
                          </span>
                          {/* Rule 10: OPS verification revoked while past Draft — warn, don't auto-revert. */}
                          {s.verifiable && !verified.has(s.key) && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning-700 dark:text-warning-500 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 px-1.5 py-0.5 rounded" title="OPS verification is no longer present for this month.">
                              <ShieldAlert className="w-3 h-3" /> OPS unverified
                            </span>
                          )}
                        </button>
                        <ExportScopeButton s={s} />
                        <Button size="sm" variant="ghost" disabled={busyKey === s.key} onClick={() => backToDraft(s)}>Back to Draft</Button>
                        {canApprovePayroll && (
                        <Button size="sm" variant="secondary" disabled={busyKey === s.key} onClick={() => setPhase(s, "finance_verify")}>
                          {busyKey === s.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Send to Finance <ArrowRight className="w-4 h-4 ml-1.5" /></>}
                        </Button>
                        )}
                      </div>
                      {open && (
                        <div className="border-t border-border">
                          {/* Existing Payslips page, scoped + through-Net (no payment UI). */}
                          {/* Site-wise rows inside the client, the same shape the
                              Attendance board and Employee Assignments use. */}
                          <PayrollManagement clientScopeId={s.clientId} categoryScope={s.category} throughNet runInline siteGrouped periodOverride={period}
                            onTotals={(t) => setLiveTotalsByKey((prev) => { const n = new Map(prev); n.set(s.key, t); return n; })}
                            onRows={(rs) => setLiveRowsByScope((prev) => { const n = new Map(prev); n.set(s.key, rs); return n; })} />
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
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-xs text-muted-foreground bg-secondary/50 rounded-md px-3 py-2 flex-1 min-w-0">
                    Finance Verify is permanent — it locks OPS un-verify and all phase movement for that client/month and reveals it on Payroll Management. It cannot be reversed.
                  </p>
                  {canApprovePayroll && financeScopes.some((s) => !financeVerified.has(s.key)) && (
                    <Button size="sm" variant="primary" disabled={busyKey === "__all__"} onClick={() => setConfirmFV({ all: true })}>
                      {busyKey === "__all__" ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Mark All as Finance Verified</>}
                    </Button>
                  )}
                </div>
                {financeScopes.length === 0 && <p className="text-sm text-muted-foreground py-8 text-center">Nothing awaiting Finance Verify.</p>}
                {financeScopes.map((s) => {
                  const locked = financeVerified.has(s.key);
                  return (
                  <div key={s.key} className={`rounded-xl border p-4 flex items-center gap-2 flex-wrap ${locked ? "bg-success-50/40 dark:bg-success-900/10 border-success-300 dark:border-success-800" : "bg-card border-border"}`}>
                    <ShieldCheck className={`w-5 h-5 shrink-0 ${locked ? "text-success-600" : "text-brand-600"}`} strokeWidth={1.5} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground truncate">{s.name}</p>
                      {verifiedAt.get(s.key) && (
                        <p className="text-[11px] text-muted-foreground">OPS verified: {fmtStamp(verifiedAt.get(s.key))}</p>
                      )}
                      {locked && financeVerifiedAt.get(s.key) && (
                        <p className="text-[11px] text-success-700 dark:text-success-500">Finance verified: {fmtStamp(financeVerifiedAt.get(s.key))}</p>
                      )}
                    </div>
                    {!locked && s.verifiable && !verified.has(s.key) && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning-700 dark:text-warning-500 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 px-1.5 py-0.5 rounded" title="OPS verification is no longer present for this month.">
                        <ShieldAlert className="w-3 h-3" /> OPS unverified
                      </span>
                    )}
                    <ExportScopeButton s={s} />
                    {locked ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-success-700 dark:text-success-500">
                        <Lock className="w-3.5 h-3.5" /> Locked — Finance Verified, cannot be reversed
                      </span>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" disabled={busyKey === s.key || busyKey === "__all__"} onClick={() => setPhase(s, "review")}>Back to Review</Button>
                        {canApprovePayroll && (
                        <Button size="sm" variant="primary" disabled={busyKey === s.key || busyKey === "__all__"} onClick={() => setConfirmFV({ scope: s })}>
                          {busyKey === s.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Finance Verify</>}
                        </Button>
                        )}
                      </>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Export picker ──
          Lists the CURRENT tab's scopes, ticked to whatever is visible, so a
          search then Export means "these". A scope with nobody on it cannot be
          ticked: an empty worksheet reads as a client with no staff rather than
          one that was never selected. */}
      <Modal isOpen={exportOpen} onClose={() => setExportOpen(false)} title="Export payroll sheets" size="md">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            One worksheet per client, in a single workbook, for {fmtMonth(month)}.
            {tab !== "finance_verify" && (
              <>
                {" "}
                <span className="text-warning-700 dark:text-warning-500">
                  Payslips are only written at Finance Verify, so rows on this tab show the
                  roster with “No payslip yet” against anyone not yet processed.
                </span>
              </>
            )}
          </p>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">{exportPicked.size} of {visibleScopes.length} selected</span>
            <div className="flex gap-2">
              <button type="button" className="text-brand-600 hover:text-brand-700"
                onClick={() => setExportPicked(new Set(visibleScopes.filter((sc) => (rowsByScope.get(sc.key)?.length ?? 0) > 0).map((sc) => sc.key)))}>
                Select all
              </button>
              <span className="text-border">|</span>
              <button type="button" className="text-brand-600 hover:text-brand-700" onClick={() => setExportPicked(new Set())}>
                Clear
              </button>
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-md border border-border divide-y divide-border">
            {visibleScopes.map((sc) => {
              const n = rowsByScope.get(sc.key)?.length ?? 0;
              const disabled = n === 0;
              return (
                <label key={sc.key}
                  className={`flex items-center gap-2 px-3 py-2 text-sm ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-accent"}`}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={exportPicked.has(sc.key)}
                    onChange={() => {
                      const next = new Set(exportPicked);
                      if (next.has(sc.key)) next.delete(sc.key); else next.add(sc.key);
                      setExportPicked(next);
                    }}
                  />
                  <span className="flex-1 truncate">{sc.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {n === 0 ? "nobody on scope" : `${n} employee${n === 1 ? "" : "s"}`}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="flex items-center gap-3 pt-2">
            <Button variant="primary" size="md" className="flex-1" disabled={exportPicked.size === 0}
              onClick={() => { runExport([...exportPicked]); setExportOpen(false); }}>
              <Download className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Export {exportPicked.size} sheet{exportPicked.size === 1 ? "" : "s"}
            </Button>
            <Button variant="secondary" size="md" onClick={() => setExportOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {confirmFV && (() => {
        const pendingCount = financeScopes.filter((s) => !financeVerified.has(s.key)).length;
        const target = confirmFV.all ? `${pendingCount} client${pendingCount === 1 ? "" : "s"}` : confirmFV.scope?.name;
        return (
          <Modal isOpen onClose={() => setConfirmFV(null)} title="Finance Verify — permanent" size="sm">
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border border-danger-200 bg-danger-50 dark:bg-danger-900/15 p-3">
                <ShieldAlert className="w-5 h-5 text-danger-600 shrink-0 mt-0.5" strokeWidth={2} />
                <div className="text-sm text-danger-800 dark:text-danger-300">
                  <p className="font-semibold">This action cannot be reversed.</p>
                  <p className="mt-1 text-danger-700 dark:text-danger-400">
                    Finance Verifying <span className="font-medium">{target}</span> for {fmtMonth(month)} permanently locks OPS un-verify and all phase movement (no Back to Review or Back to Draft), and moves it to the Payroll Management page for payment.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirmFV(null)}>Cancel</Button>
                <Button variant="primary" onClick={() => { const c = confirmFV; setConfirmFV(null); if (c.all) financeVerifyAll(); else if (c.scope) financeVerify(c.scope); }}>
                  {confirmFV.all ? "Yes, Finance Verify all" : "Yes, Finance Verify"}
                </Button>
              </div>
            </div>
          </Modal>
        );
      })()}
    </>
  );
}
