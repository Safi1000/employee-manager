// Payroll Run (web PayrollRun.tsx): Draft → Review → Finance Verify, per client
// and staff group. Review opens a scope's roster "through Net Salary" — the same
// calculation and Save as Payroll, with no payment controls.
import { ArrowRight, ChevronDown, ChevronRight, Download, Lock, ShieldAlert, ShieldCheck } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Checkbox, Empty, HStack, IconBtn, Row, SearchBar, StatGrid, Tabs } from "../../components/ui";
import { useDB } from "../../data/store";
import {
  backToDraft, exportRowOf, exportSheets, filterRows, financeVerify, formatPeriod, loadRun, moveToReview, payrollTotals, RunData, Scope, setPhase, ShellTotals, ZERO_SHELL,
} from "../../data/api/payroll";
import type { PayrollExportRow } from "../../lib/web/excel";
import { useAuth } from "../../lib/auth";
import { useRegion } from "../../lib/region";
import { useTheme } from "../../theme/ThemeProvider";
import { err, PayslipSheet, RosterLine, usePayrollWorkspace, Workspace } from "./payrollParts";

type Tab = "draft" | "review" | "finance_verify";
const monthNow = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };
const monthOptions = () => {
  const out: { value: string; label: string }[] = [];
  const d = new Date(); d.setDate(1);
  for (let i = 0; i < 13; i++) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const ym = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
    out.push({ value: ym, label: formatPeriod(`${ym}-01`) });
  }
  return out;
};
const fmtStamp = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "");
const add = (a: ShellTotals, b: ShellTotals): ShellTotals => ({
  disbursed: a.disbursed + b.disbursed, notDisbursed: a.notDisbursed + b.notDisbursed, advance: a.advance + b.advance,
  disbursedCount: a.disbursedCount + b.disbursedCount, notDisbursedCount: a.notDisbursedCount + b.notDisbursedCount,
});

export default function PayrollRun() {
  const t = useTheme();
  const { profile, can } = useAuth();
  const { v } = useDB();
  const { regionId } = useRegion();
  const { toast } = useOverlay();
  const canApprove = can("payroll.approve");
  const [month, setMonth] = useState(monthNow());
  const period = `${month}-01`;
  const [tab, setTab] = useState<Tab>("draft");
  const [data, setData] = useState<RunData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [confirmFV, setConfirmFV] = useState<{ scope?: Scope; all?: boolean } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pendingExport, setPendingExport] = useState<string | null>(null);
  // The Review roster computes payroll live; loaded once a Review scope is opened.
  const ws = usePayrollWorkspace(period, false, tab === "review" && (!!expanded || !!pendingExport));

  const load = useCallback(async () => {
    try { setData(await loadRun(period, regionId)); setError(null); } catch (e) { setError(err(e)); }
  }, [period, regionId]);
  useEffect(() => { const h = setTimeout(() => { setData(null); void load(); }, 0); return () => clearTimeout(h); }, [load, v]);

  const matches = useCallback((s: Scope) => {
    const qs = search.trim().toLowerCase();
    if (!qs) return true;
    return s.name.toLowerCase().includes(qs) || (data?.searchIndex.get(s.key) ?? "").includes(qs);
  }, [search, data]);
  const scopes = useMemo(() => data?.scopes ?? [], [data]);
  const draftScopes = useMemo(() => scopes.filter((s) => !data!.phaseByKey.has(s.key) && matches(s))
    .sort((a, b) => { const ready = (s: Scope) => (!s.verifiable || data!.verified.has(s.key) ? 0 : 1); return ready(a) - ready(b); }), [scopes, data, matches]);
  const reviewScopes = useMemo(() => scopes.filter((s) => data!.phaseByKey.get(s.key) === "review" && matches(s)), [scopes, data, matches]);
  const financeScopes = useMemo(() => scopes.filter((s) => data!.phaseByKey.get(s.key) === "finance_verify" && matches(s))
    .sort((a, b) => Number(data!.financeVerified.has(a.key)) - Number(data!.financeVerified.has(b.key))), [scopes, data, matches]);
  const visible = tab === "draft" ? draftScopes : tab === "review" ? reviewScopes : financeScopes;

  // Live rows/totals for a Review scope, from the same computation the roster shows.
  const liveRows = useCallback((s: Scope) => (ws.base ? filterRows(ws.base, ws.rows, { clientScopeId: s.clientId, categoryScope: s.category }) : null), [ws.base, ws.rows]);
  const liveTotalsFor = (s: Scope): ShellTotals | null => { const r = liveRows(s); return r ? payrollTotals(r) : null; };
  const reviewCards = useMemo(() => {
    const forKey = (s: Scope) => liveTotalsFor(s) ?? data?.totals.get(s.key) ?? ZERO_SHELL;
    const exp = reviewScopes.find((s) => s.key === expanded);
    if (exp) return forKey(exp);
    return reviewScopes.reduce((acc, s) => add(acc, forKey(s)), { ...ZERO_SHELL });
  }, [expanded, reviewScopes, data, ws.rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowsFor = (s: Scope): PayrollExportRow[] => {
    const live = tab === "review" ? liveRows(s) : null;
    if (live && ws.base) return live.map((r) => exportRowOf(ws.base!, r));
    return data?.rowsByScope.get(s.key) ?? [];
  };
  const runExport = async (keys: string[]) => {
    try { await exportSheets(keys.map((k) => { const s = scopes.find((x) => x.key === k)!; return { name: s?.name ?? "Client", rows: rowsFor(s) }; }), formatPeriod(period)); }
    catch (e) { toast(err(e), "danger"); }
  };
  const exportScope = (s: Scope) => {
    const needsCompute = tab === "review" && !ws.base && (data?.rowsByScope.get(s.key) ?? []).some((r) => !r.hasPayslip);
    if (needsCompute) { setExpanded(s.key); setPendingExport(s.key); return; }
    void runExport([s.key]);
  };
  useEffect(() => {
    if (!pendingExport || !ws.base) return;
    const s = scopes.find((x) => x.key === pendingExport);
    const h = setTimeout(() => { setPendingExport(null); if (s) void runExport([s.key]); }, 0);
    return () => clearTimeout(h);
  }, [pendingExport, ws.base]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusyKey(key); setError(null);
    try { await fn(); } catch (e) { setError(err(e)); }
    setBusyKey(null);
    await load();
  };

  const opsLine = (s: Scope) => data?.verifiedAt.get(s.key) ? `Attendance verified: ${fmtStamp(data.verifiedAt.get(s.key))}` : undefined;
  const unverified = (s: Scope) => s.verifiable && !data?.verified.has(s.key);

  return (
    <Screen region eyebrow="Workforce" title="Payroll Run" subtitle="Draft → Review → Finance Verify, per client & staff group"
      sticky={<Tabs value={tab} onChange={(k) => { setTab(k); setExpanded(null); }} items={[
        { key: "draft", label: `Draft${data ? ` ${draftScopes.length}` : ""}` },
        { key: "review", label: `Review${data ? ` ${reviewScopes.length}` : ""}` },
        { key: "finance_verify", label: `Finance${data ? ` ${financeScopes.length}` : ""}` },
      ]} />}>
      <View style={{ gap: 8 }}>
        <HStack>
          <View style={{ flex: 1 }}><Select compact label="Month" value={month} onChange={(m) => { setMonth(m); setExpanded(null); }} options={monthOptions()} /></View>
          <IconBtn icon={Download} label="Export payroll sheets" onPress={() => { setPicked(new Set(visible.map((s) => s.key))); setExportOpen(true); }} />
        </HStack>
        <SearchBar value={search} onChange={setSearch} placeholder="Client, employee name or code" />
      </View>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}

      {data && tab === "draft" && (
        <View style={{ marginTop: 12 }}>
          {draftScopes.length === 0 && <Empty title={search.trim() ? `Nothing in Draft matches “${search.trim()}”.` : `Nothing left in Draft for ${formatPeriod(period)}.`} />}
          {draftScopes.map((s) => {
            const ok = !s.verifiable || data.verified.has(s.key);
            return (
              <Card key={s.key} style={{ marginBottom: 10, ...(ok ? {} : { borderColor: t.tone("warning").line, backgroundColor: t.tone("warning").tint }) }}>
                <T v="bodyStrong">{s.name}</T>
                <T v="small" muted>{!s.verifiable ? "No attendance verification needed" : ok ? opsLine(s) ?? "Attendance verified" : "Waiting on HR and Ops to verify both halves"}</T>
                {ok && can("payroll.edit") && <Button size="sm" style={{ marginTop: 10, alignSelf: "flex-start" }} icon={ArrowRight} label="Move to Review" loading={busyKey === s.key}
                  onPress={() => run(s.key, async () => { await moveToReview(s, period, profile?.id ?? null); setTab("review"); setExpanded(s.key); })} />}
              </Card>
            );
          })}
        </View>
      )}

      {data && tab === "review" && (
        <View style={{ marginTop: 12 }}>
          <StatGrid items={[
            { label: "Total salaries", value: `PKR ${(reviewCards.disbursed + reviewCards.notDisbursed).toLocaleString()}`, tone: "success" },
            { label: "Total advance", value: `PKR ${reviewCards.advance.toLocaleString()}`, tone: "danger" },
          ]} />
          <View style={{ height: 10 }} />
          {reviewScopes.length === 0 && <Empty title={search.trim() ? `Nothing in Review matches “${search.trim()}”.` : "Nothing in Review. Move a scope from Draft."} />}
          {reviewScopes.map((s) => {
            const open = expanded === s.key;
            return (
              <Card key={s.key} pad={0} style={{ marginBottom: 10 }}>
                <Row onPress={() => setExpanded(open ? null : s.key)} last
                  left={open ? <ChevronDown size={18} color={t.mutedFg} /> : <ChevronRight size={18} color={t.mutedFg} />}
                  title={s.name} meta={opsLine(s)}
                  right={<HStack>{unverified(s) && <Badge small tone="warning" label="OPS unverified" />}<IconBtn icon={Download} size={34} label={`Export ${s.name}`} onPress={() => exportScope(s)} /></HStack>} />
                <HStack style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
                  {can("payroll.edit") && <Button size="sm" variant="ghost" label="Back to Draft" disabled={busyKey === s.key} onPress={() => run(s.key, async () => { await backToDraft(s, period); if (expanded === s.key) setExpanded(null); })} />}
                  {canApprove && <Button size="sm" variant="secondary" icon={ArrowRight} label="Send to Finance" loading={busyKey === s.key} onPress={() => run(s.key, () => setPhase(s, period, "finance_verify", profile?.id ?? null))} />}
                </HStack>
                {open && <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}><ReviewRoster ws={ws} scope={s} /></View>}
              </Card>
            );
          })}
        </View>
      )}

      {data && tab === "finance_verify" && (
        <View style={{ marginTop: 12 }}>
          {canApprove && financeScopes.some((s) => !data.financeVerified.has(s.key)) && (
            <Button icon={ShieldCheck} label="Finance Verify all" loading={busyKey === "__all__"} style={{ marginBottom: 10 }} onPress={() => setConfirmFV({ all: true })} />
          )}
          {financeScopes.length === 0 && <Empty title={search.trim() ? `Nothing in Finance Verify matches “${search.trim()}”.` : "Nothing waiting on Finance Verify."} />}
          {financeScopes.map((s) => {
            const locked = data.financeVerified.has(s.key);
            return (
              <Card key={s.key} style={{ marginBottom: 10, ...(locked ? { borderColor: t.tone("success").line, backgroundColor: t.tone("success").tint } : {}) }}>
                <HStack>
                  {locked ? <ShieldCheck size={20} color={t.tone("success").text} /> : <ShieldCheck size={20} color={t.tone("brand").text} />}
                  <View style={{ flex: 1 }}>
                    <T v="bodyStrong">{s.name}</T>
                    {opsLine(s) && <T v="small" muted>{opsLine(s)}</T>}
                    {locked && data.financeVerifiedAt.get(s.key) && <T v="small" color={t.tone("success").text}>Finance verified: {fmtStamp(data.financeVerifiedAt.get(s.key))}</T>}
                  </View>
                  {!locked && unverified(s) && <Badge small tone="warning" label="OPS unverified" />}
                </HStack>
                {locked ? (
                  <HStack style={{ marginTop: 8 }}><Lock size={14} color={t.tone("success").text} /><T v="small" color={t.tone("success").text}>Locked — Finance Verified, cannot be reversed</T></HStack>
                ) : (
                  <HStack style={{ marginTop: 10 }}>
                    {canApprove && <Button size="sm" variant="ghost" label="Back to Review" disabled={busyKey === s.key || busyKey === "__all__"} onPress={() => run(s.key, () => setPhase(s, period, "review", profile?.id ?? null))} />}
                    {canApprove && <Button size="sm" label="Finance Verify" loading={busyKey === s.key} disabled={busyKey === "__all__"} onPress={() => setConfirmFV({ scope: s })} />}
                  </HStack>
                )}
              </Card>
            );
          })}
        </View>
      )}

      <Sheet open={!!confirmFV} onClose={() => setConfirmFV(null)} title="Finance Verify — permanent"
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setConfirmFV(null)} /><Button label={confirmFV?.all ? "Yes, Finance Verify all" : "Yes, Finance Verify"} full onPress={() => {
          const c = confirmFV; setConfirmFV(null);
          if (!c) return;
          const targets = c.all ? financeScopes.filter((s) => !data?.financeVerified.has(s.key)) : c.scope ? [c.scope] : [];
          void run(c.all ? "__all__" : c.scope!.key, () => financeVerify(targets, period, profile?.id ?? null));
        }} /></>}>
        <HStack style={{ alignItems: "flex-start" }}>
          <ShieldAlert size={20} color={t.tone("danger").text} />
          <View style={{ flex: 1 }}>
            <T v="bodyStrong" color={t.tone("danger").text}>This action cannot be reversed.</T>
            <T v="small" color={t.tone("danger").text}>
              Finance Verifying {confirmFV?.all ? `${financeScopes.filter((s) => !data?.financeVerified.has(s.key)).length} clients` : confirmFV?.scope?.name} for {formatPeriod(period)} permanently locks OPS un-verify and all phase movement (no Back to Review or Back to Draft), and moves it to the Payroll Management page for payment.
            </T>
          </View>
        </HStack>
      </Sheet>

      <Sheet open={exportOpen} onClose={() => setExportOpen(false)} title="Export payroll sheets" subtitle={formatPeriod(period)}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setExportOpen(false)} /><Button label={`Export ${picked.size}`} full disabled={picked.size === 0} onPress={() => { setExportOpen(false); void runExport([...picked]); }} /></>}>
        <T v="small" muted>Scopes with no computed payroll export their roster with blank salary columns and “No payslip yet”. Open a Review scope first to export live figures.</T>
        <HStack style={{ marginVertical: 8 }}>
          <T v="smallStrong" color={t.tone("brand").text} onPress={() => setPicked(new Set(visible.filter((s) => (data?.rowsByScope.get(s.key)?.length ?? 0) > 0).map((s) => s.key)))}>Select all</T>
          <T v="smallStrong" color={t.tone("brand").text} onPress={() => setPicked(new Set())}>Clear</T>
        </HStack>
        {visible.map((s) => {
          const n = data?.rowsByScope.get(s.key)?.length ?? 0;
          return <Checkbox key={s.key} value={picked.has(s.key)} label={s.name} sub={n === 0 ? "Nobody on this scope" : `${n} employee${n === 1 ? "" : "s"}`}
            onChange={(on) => n > 0 && setPicked((p) => { const nx = new Set(p); if (on) nx.add(s.key); else nx.delete(s.key); return nx; })} />;
        })}
      </Sheet>
    </Screen>
  );
}

/** The Review embed: roster through Net Salary; tap a guard for the calculation and Save. */
function ReviewRoster({ ws, scope }: { ws: Workspace; scope: Scope }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => (ws.base ? filterRows(ws.base, ws.rows, { clientScopeId: scope.clientId, categoryScope: scope.category }) : []), [ws.base, ws.rows, scope.clientId, scope.category]);
  if (ws.error) return <Banner tone="danger" title={ws.error} />;
  if (!ws.base) return <ActivityIndicator />;
  return (
    <>
      {rows.map((r) => <RosterLine key={r.employee.id} base={ws.base!} row={r} onPress={() => setOpen(r.employee.id)} />)}
      {rows.length === 0 && <T v="small" muted>Nobody with attendance on this scope this month.</T>}
      <PayslipSheet ws={ws} employeeId={open} mode="throughNet" onClose={() => setOpen(null)} />
    </>
  );
}
