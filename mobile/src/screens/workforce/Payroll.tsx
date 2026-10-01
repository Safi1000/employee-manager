// Payroll = web /payroll (Payslips | Adjustments | Leave) and /relievers/payroll.
// Payslips lists only scopes Finance-Verified for the month, each opening to its
// roster in the web's afterNet slice (Net + payment). Reliever payroll is the
// classic full table. Everything reads and writes through data/api/payroll.
import { useLocalSearchParams } from "expo-router";
import { CheckCheck, ChevronDown, ChevronRight, Download, HandCoins, Wallet } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Checkbox, Chips, Empty, HStack, IconBtn, Input, Ledger, ListCard, Row, SearchBar, Section, StatGrid, Tabs } from "../../components/ui";
import { useDB } from "../../data/store";
import { q, sb, todayIso } from "../../data/api/core";
import {
  AdjustmentRow, autoSaveMissing, bulkDisburse, cancelAdjustment, exportSheets, filterRows, formatPeriod, LeaveGuard, LedgerRow, loadAdjustmentPayOptions,
  loadAdjustments, loadFvShell, loadLeaveGuards, loadLeaveLedger, loadLostAtCap, LostRow, markAllCleared, payrollTotals, periodOptions, previousPeriod, RowFilter,
  Scope, setQuotaOverride, settleAdjustment, ShellTotals, ZERO_SHELL, daysInMonth,
} from "../../data/api/payroll";
import type { CustodianOption } from "../../lib/web/custodian";
import { useAuth } from "../../lib/auth";
import { fmtDate, pkr } from "../../lib/format";
import { useTheme } from "../../theme/ThemeProvider";
import { BulkDisburseSheet, err, PayslipPanel, PayslipSheet, RosterLine, usePayrollWorkspace, Workspace } from "./payrollParts";

type Tab = "payslips" | "adjustments" | "leave";

export default function Payroll({ relieversOnly }: { relieversOnly?: boolean }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("payslips");
  if (relieversOnly) return <Screen region eyebrow="Workforce" title="Reliever payroll" subtitle="Per-client day attribution and disbursement"><RelieverPayroll /></Screen>;
  const tabs = [
    ...(can("payroll.view") || can("payroll.edit") ? [{ key: "payslips" as const, label: "Payslips" }] : []),
    { key: "adjustments" as const, label: "Adjustments" },
    { key: "leave" as const, label: "Leave" },
  ];
  return (
    <Screen region eyebrow="Workforce" title="Payroll" sticky={<Tabs value={tab} onChange={setTab} items={tabs} />}>
      {tab === "payslips" && <FinanceVerifiedPayroll />}
      {tab === "adjustments" && <Adjustments />}
      {tab === "leave" && <Leave />}
    </Screen>
  );
}

const periodSelectOptions = () => periodOptions().map((p) => ({ value: p, label: formatPeriod(p) }));

// ─────────────────────────────────────────── Payslips (Finance-Verified shell)
function FinanceVerifiedPayroll() {
  const t = useTheme();
  const { v } = useDB();
  const { toast } = useOverlay();
  const [period, setPeriod] = useState(previousPeriod());
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [shell, setShell] = useState<Awaited<ReturnType<typeof loadFvShell>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const ws = usePayrollWorkspace(period, false, !!expanded);

  useEffect(() => {
    let cancelled = false;
    loadFvShell(period).then((s) => { if (!cancelled) { setShell(s); setError(null); } }).catch((e) => { if (!cancelled) setError(err(e)); });
    return () => { cancelled = true; };
  }, [period, reloadKey, v]);

  const fully = useCallback((key: string) => { const x = shell?.totals.get(key); return !!x && x.disbursedCount > 0 && x.notDisbursedCount === 0; }, [shell]);
  const scopes = useMemo(() => {
    if (!shell) return [];
    const qs = search.trim().toLowerCase();
    return [...shell.scopes]
      .filter((sc) => !qs || sc.name.toLowerCase().includes(qs) || (shell.index.get(sc.key) ?? "").includes(qs))
      .sort((a, b) => Number(fully(a.key)) - Number(fully(b.key)));
  }, [shell, search, fully]);
  const cards: ShellTotals = useMemo(() => {
    if (!shell) return ZERO_SHELL;
    if (expanded) return shell.totals.get(expanded) ?? ZERO_SHELL;
    return scopes.reduce((acc, s) => {
      const x = shell.totals.get(s.key) ?? ZERO_SHELL;
      return { disbursed: acc.disbursed + x.disbursed, notDisbursed: acc.notDisbursed + x.notDisbursed, advance: acc.advance + x.advance, disbursedCount: acc.disbursedCount + x.disbursedCount, notDisbursedCount: acc.notDisbursedCount + x.notDisbursedCount };
    }, { ...ZERO_SHELL });
  }, [shell, expanded, scopes]);

  const runExport = async (keys: string[]) => {
    if (!shell) return;
    try { await exportSheets(keys.map((k) => ({ name: shell.scopes.find((sc) => sc.key === k)?.name ?? "Client", rows: shell.rowsByScope.get(k) ?? [] })), formatPeriod(period)); }
    catch (e) { toast(err(e), "danger"); }
  };

  return (
    <>
      <StatGrid items={[
        { label: "Disbursed", value: pkr(cards.disbursed, { compact: true }), tone: "success", hint: `${cards.disbursedCount} payslips` },
        { label: "Not disbursed", value: pkr(cards.notDisbursed, { compact: true }), tone: "warning", hint: `${cards.notDisbursedCount} payslips` },
        { label: "Advance", value: pkr(cards.advance, { compact: true }), tone: "danger" },
      ]} />
      <View style={{ gap: 8, marginTop: 12 }}>
        <HStack>
          <View style={{ flex: 1 }}><Select compact label="Period" value={period} onChange={(p) => { setPeriod(p); setExpanded(null); setShell(null); }} options={periodSelectOptions()} /></View>
          <IconBtn icon={Download} label="Export payroll sheets" onPress={() => { setPicked(new Set(scopes.map((s) => s.key))); setExportOpen(true); }} />
        </HStack>
        <SearchBar value={search} onChange={setSearch} placeholder="Client, employee name or code" />
      </View>
      {error && <Banner tone="danger" title={error} />}
      {!shell && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      {shell && scopes.length === 0 && <Empty icon={Wallet} title={search ? `Nothing matches “${search}”` : `No Finance-Verified clients for ${formatPeriod(period)}`} sub="Scopes arrive here from Payroll Run once Finance Verified." />}
      <View style={{ marginTop: 12 }}>
        {scopes.map((s) => {
          const open = expanded === s.key;
          const x = shell?.totals.get(s.key) ?? ZERO_SHELL;
          const done = fully(s.key);
          return (
            <Card key={s.key} pad={0} style={{ marginBottom: 10, ...(done ? { backgroundColor: t.tone("success").tint, borderColor: t.tone("success").line } : {}) }}>
              <Row onPress={() => setExpanded(open ? null : s.key)} last={!open}
                left={open ? <ChevronDown size={18} color={t.mutedFg} /> : <ChevronRight size={18} color={t.mutedFg} />}
                title={s.name}
                meta={`Paid ${pkr(x.disbursed, { compact: true })} · Owed ${pkr(x.notDisbursed, { compact: true })}`}
                right={<HStack>{done && <Badge small tone="success" label="All disbursed" />}<IconBtn icon={Download} size={34} label={`Export ${s.name}`} onPress={() => runExport([s.key])} /></HStack>} />
              {open && (
                <View style={{ padding: 12 }}>
                  <ScopeRoster ws={ws} scope={s} period={period} onChanged={() => setReloadKey((k) => k + 1)} />
                </View>
              )}
            </Card>
          );
        })}
      </View>

      <Sheet open={exportOpen} onClose={() => setExportOpen(false)} title="Export payroll sheets" subtitle={formatPeriod(period)}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setExportOpen(false)} /><Button label={`Export ${picked.size}`} full disabled={picked.size === 0} onPress={() => { setExportOpen(false); void runExport([...picked]); }} /></>}>
        <HStack>
          <T v="smallStrong" color={t.tone("brand").text} onPress={() => setPicked(new Set(scopes.filter((sc) => (shell?.rowsByScope.get(sc.key)?.length ?? 0) > 0).map((sc) => sc.key)))}>Select all</T>
          <T v="smallStrong" color={t.tone("brand").text} onPress={() => setPicked(new Set())}>Clear</T>
        </HStack>
        {scopes.map((sc) => {
          const n = shell?.rowsByScope.get(sc.key)?.length ?? 0;
          return <Checkbox key={sc.key} value={picked.has(sc.key)} label={sc.name} sub={n === 0 ? "No payslips" : `${n} employee${n === 1 ? "" : "s"}`}
            onChange={(on) => n > 0 && setPicked((p) => { const nx = new Set(p); if (on) nx.add(sc.key); else nx.delete(sc.key); return nx; })} />;
        })}
      </Sheet>
    </>
  );
}

/** One Finance-Verified scope's roster in the afterNet slice. */
function ScopeRoster({ ws, scope, period, onChanged }: { ws: Workspace; scope: Scope; period: string; onChanged: () => void }) {
  const t = useTheme();
  const { can } = useAuth();
  const { toast } = useOverlay();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const autoSaved = useRef<string | null>(null);
  const filter: RowFilter = { clientScopeId: scope.clientId, categoryScope: scope.category, search: q };
  const rows = useMemo(() => (ws.base ? filterRows(ws.base, ws.rows, filter) : []), [ws.base, ws.rows, q, scope.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const scopeRows = useMemo(() => (ws.base ? filterRows(ws.base, ws.rows, { clientScopeId: scope.clientId, categoryScope: scope.category }) : []), [ws.base, ws.rows, scope.clientId, scope.category]);

  // afterNet auto-save: every employee on this Finance-Verified scope gets a
  // payslip from the computed figures, once per period per scope.
  useEffect(() => {
    if (!ws.base || ws.loading || !can("payroll.edit")) return;
    const key = `${period}|${scope.key}`;
    if (autoSaved.current === key) return;
    autoSaved.current = key;
    autoSaveMissing(scopeRows).then((wrote) => { if (wrote) { void ws.reload(); onChanged(); } }).catch((e) => toast(err(e), "danger"));
  }, [ws.base, ws.loading, scopeRows, period, scope.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const remainingOf = (r: typeof rows[number]) => Math.round(r.net_salary) - Math.round(r.amount_paid || 0);
  const selectable = rows.filter((r) => remainingOf(r) > 0);
  const allSelected = selectable.length > 0 && selectable.every((r) => sel.has(r.employee.id));
  const chosen = rows.filter((r) => sel.has(r.employee.id) && remainingOf(r) > 0);

  if (ws.error) return <Banner tone="danger" title={ws.error} />;
  if (!ws.base) return <ActivityIndicator />;
  return (
    <>
      <SearchBar value={q} onChange={setQ} placeholder="Name or employee ID" />
      {can("payroll.edit") && (
        <HStack style={{ marginVertical: 8 }}>
          <Button size="sm" variant="secondary" label={allSelected ? "Clear all" : "Mark all"} disabled={selectable.length === 0}
            onPress={() => setSel(allSelected ? new Set() : new Set(selectable.map((r) => r.employee.id)))} />
          <Button size="sm" icon={HandCoins} label={`Disburse selected${sel.size ? ` (${sel.size})` : ""}`} disabled={chosen.length === 0} onPress={() => setBulk(true)} />
          <T v="small" muted>{selectable.length} payable</T>
        </HStack>
      )}
      {rows.map((r) => (
        <RosterLine key={r.employee.id} base={ws.base!} row={r} onPress={() => setOpen(r.employee.id)}
          left={can("payroll.edit") && remainingOf(r) > 0 ? <Checkbox value={sel.has(r.employee.id)} onChange={(on) => setSel((p) => { const n = new Set(p); if (on) n.add(r.employee.id); else n.delete(r.employee.id); return n; })} /> : undefined} />
      ))}
      {rows.length === 0 && <T v="small" color={t.mutedFg}>Nobody on this scope for the period.</T>}
      <PayslipSheet ws={ws} employeeId={open} mode="afterNet" onClose={() => setOpen(null)} onChanged={onChanged} />
      <BulkDisburseSheet ws={ws} open={bulk} count={chosen.length} total={chosen.reduce((s, r) => s + remainingOf(r), 0)} onClose={() => setBulk(false)}
        onSubmit={async (o) => {
          try {
            const res = await bulkDisburse(ws.base!, ws.companyId, chosen, { ...o, canViewBanking: ws.canViewBanking });
            setBulk(false); setSel(new Set()); toast(`${res.done} of ${res.total} disbursed`);
          } catch (e) { toast(err(e), "danger"); }
          await ws.reload(); onChanged();
        }} />
    </>
  );
}

/** /payroll/[id] — a payslip opened from elsewhere (employee history). Resolves its month first, as the web focus link does. */
export function PayslipDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [target, setTarget] = useState<{ period: string; employeeId: string; reliever: boolean } | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const p = await q<any>(sb().from("payslips").select("id, period_month, employee_id").eq("id", id).maybeSingle());
        if (!p) { setMissing(true); return; }
        const e = await q<any>(sb().from("employees").select("category").eq("id", p.employee_id).maybeSingle());
        setTarget({ period: String(p.period_month).slice(0, 7) + "-01", employeeId: p.employee_id, reliever: e?.category === "reliever" });
      } catch { setMissing(true); }
    })();
  }, [id]);
  if (missing) return <Screen title="Payslip"><Empty title="Payslip not found" sub="It may have been removed, or you can't view it." /></Screen>;
  if (!target) return <Screen title="Payslip"><ActivityIndicator style={{ marginTop: 24 }} /></Screen>;
  return <PayslipDetailLoaded {...target} />;
}
function PayslipDetailLoaded({ period, employeeId, reliever }: { period: string; employeeId: string; reliever: boolean }) {
  const ws = usePayrollWorkspace(period, reliever);
  const row = ws.rows.find((r) => r.employee.id === employeeId);
  return (
    <Screen eyebrow={`Salary calculation · ${formatPeriod(period)}`} title={row?.employee.full_name ?? "Payslip"}>
      {ws.error && <Banner tone="danger" title={ws.error} />}
      {!row && !ws.error && <ActivityIndicator style={{ marginTop: 24 }} />}
      {row && <DetailBody ws={ws} employeeId={employeeId} mode={reliever ? "full" : "afterNet"} />}
    </Screen>
  );
}
function DetailBody({ ws, employeeId, mode }: { ws: Workspace; employeeId: string; mode: "full" | "afterNet" }) {
  const row = ws.rows.find((r) => r.employee.id === employeeId)!;
  return <PayslipPanel ws={ws} row={row} mode={mode} />;
}

// ─────────────────────────────────────────────────────────── Reliever payroll
function RelieverPayroll() {
  const { can, profile } = useAuth();
  const { db } = useDB();
  const { toast, confirm } = useOverlay();
  const [period, setPeriod] = useState(previousPeriod());
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "Cleared" | "Pending">("all");
  const [disbursedFilter, setDisbursedFilter] = useState<"all" | "yes" | "no">("all");
  const [empTab, setEmpTab] = useState<"all" | "active" | "inactive">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const [busy, setBusy] = useState(false);
  const ws = usePayrollWorkspace(period, true);
  void profile;
  const rows = useMemo(() => (ws.base ? filterRows(ws.base, ws.rows, { relieversOnly: true, search, clientFilter, statusFilter, disbursedFilter, empTab }) : []),
    [ws.base, ws.rows, search, clientFilter, statusFilter, disbursedFilter, empTab]);
  const totals = payrollTotals(rows);
  const remainingOf = (r: typeof rows[number]) => Math.round(r.net_salary) - Math.round(r.amount_paid || 0);
  const unpaid = rows.filter((r) => remainingOf(r) > 0);
  const clientName = (cid: string) => (cid === "unattributed" ? "(Unattributed)" : ws.base?.clients.find((c) => c.id === cid)?.name ?? "(Unknown)");

  return (
    <>
      <StatGrid items={[
        { label: "Disbursed", value: pkr(totals.disbursed, { compact: true }), tone: "success" },
        { label: "Not disbursed", value: pkr(totals.notDisbursed, { compact: true }), tone: "warning" },
        { label: "Advance", value: pkr(totals.advance, { compact: true }), tone: "danger" },
        { label: "Cash in hand", value: pkr(ws.base?.cashBalance ?? 0, { compact: true }), hint: `${daysInMonth(period)} days in ${formatPeriod(period)}` },
      ]} />
      <View style={{ gap: 8, marginTop: 12 }}>
        <Select compact label="Period" value={period} onChange={setPeriod} options={periodSelectOptions()} />
        <Select compact clearable label="Client" value={clientFilter === "all" ? "" : clientFilter} onChange={(x) => setClientFilter(x || "all")} placeholder="All clients"
          options={db.clients.map((c) => ({ value: c.id, label: c.name }))} />
        <SearchBar value={search} onChange={setSearch} placeholder="Name, code or phone" />
        <Chips value={empTab} onChange={setEmpTab} items={[{ key: "all", label: "All" }, { key: "active", label: "Active" }, { key: "inactive", label: "Fired / left" }]} />
        <Chips value={statusFilter} onChange={setStatusFilter} items={[{ key: "all", label: "Any status" }, { key: "Pending", label: "Pending" }, { key: "Cleared", label: "Cleared" }]} />
        <Chips value={disbursedFilter} onChange={setDisbursedFilter} items={[{ key: "all", label: "Any" }, { key: "yes", label: "Disbursed" }, { key: "no", label: "Not disbursed" }]} />
      </View>
      {can("payroll.edit") && (
        <HStack style={{ marginTop: 12 }}>
          <Button style={{ flex: 1 }} variant="secondary" icon={CheckCheck} label={busy ? "Clearing…" : "Mark all as Cleared"} disabled={busy} onPress={async () => {
            const pending = rows.filter((r) => r.status === "Pending");
            if (pending.length === 0) { toast("No pending rows in the current filter to clear.", "warning"); return; }
            if (!(await confirm({ title: `Mark ${pending.length} payslip${pending.length === 1 ? "" : "s"} as Cleared?`, message: "No money moves — this is a status change.", confirmLabel: "Mark Cleared" }))) return;
            setBusy(true);
            try { await markAllCleared(pending); toast("Payslips cleared"); } catch (e) { toast(err(e), "danger"); }
            await ws.reload(); setBusy(false);
          }} />
          <Button style={{ flex: 1 }} icon={HandCoins} label="Bulk disburse" disabled={unpaid.length === 0} onPress={() => setBulk(true)} />
        </HStack>
      )}
      {ws.error && <Banner tone="danger" title={ws.error} />}
      {!ws.base && !ws.error && <ActivityIndicator style={{ marginTop: 24 }} />}
      <View style={{ marginTop: 12 }}>
        {ws.base && rows.map((r) => {
          const bd = ws.pd?.relieverPerClient.get(r.employee.id);
          const items = bd ? [...bd.entries()].sort((a, b) => b[1] - a[1]) : [];
          return <RosterLine key={r.employee.id} base={ws.base!} row={r} onPress={() => setOpen(r.employee.id)}
            extra={items.length ? <T v="small" muted numberOfLines={2}>{items.map(([cid, d]) => `${clientName(cid)} ${d}d`).join(" · ")}</T> : undefined} />;
        })}
        {ws.base && rows.length === 0 && <Empty icon={Wallet} title="No relievers with attendance, a payslip or an advance this period" />}
      </View>
      <PayslipSheet ws={ws} employeeId={open} mode="full" onClose={() => setOpen(null)} />
      <BulkDisburseSheet ws={ws} open={bulk} count={unpaid.length} total={unpaid.reduce((s, r) => s + remainingOf(r), 0)} onClose={() => setBulk(false)}
        onSubmit={async (o) => {
          try { const res = await bulkDisburse(ws.base!, ws.companyId, unpaid, { ...o, canViewBanking: ws.canViewBanking }); setBulk(false); toast(`${res.done} of ${res.total} disbursed`); }
          catch (e) { toast(err(e), "danger"); }
          await ws.reload();
        }} />
    </>
  );
}

// ──────────────────────────────────────────────────────────────── Adjustments
const monthLabel = (d: string) => new Date(d + "T00:00:00").toLocaleString("en", { month: "long", year: "numeric" });

function Adjustments() {
  const t = useTheme();
  const { can } = useAuth();
  const { db } = useDB();
  const { toast } = useOverlay();
  const canAdjust = can("payroll.adjust");
  const [rows, setRows] = useState<AdjustmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettled, setShowSettled] = useState(false);
  const [settling, setSettling] = useState<AdjustmentRow | null>(null);
  const [cancelling, setCancelling] = useState<AdjustmentRow | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [pay, setPay] = useState({ mode: "Cash", bank: "", custodian: "", date: todayIso() });
  const [opts, setOpts] = useState<{ banks: any[]; custodians: CustodianOption[] }>({ banks: [], custodians: [] });
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);

  const load = useCallback(async () => { try { setRows(await loadAdjustments()); setError(null); } catch (e) { setError(err(e)); } }, []);
  useEffect(() => { const h = setTimeout(() => { void load(); }, 0); return () => clearTimeout(h); }, [load]);
  useEffect(() => { if (settling && db.company.id) loadAdjustmentPayOptions(db.company.id).then(setOpts).catch(() => undefined); }, [settling, db.company.id]);

  const open = (rows ?? []).filter((r) => r.status === "open");
  const rest = (rows ?? []).filter((r) => r.status !== "open");
  const repeat = useMemo(() => { const c = new Map<string, number>(); for (const r of rows ?? []) if (r.status !== "cancelled") c.set(r.employee_id, (c.get(r.employee_id) ?? 0) + 1); return c; }, [rows]);

  const card = (r: AdjustmentRow) => (
    <Card key={r.id} style={{ marginBottom: 10 }}>
      <HStack>
        <View style={{ flex: 1 }}>
          <T v="bodyStrong">{r.full_name}{r.guard_code ? ` · ${r.guard_code}` : ""}</T>
          <T v="small" muted>Corrects {monthLabel(r.original_period_month)} · {r.reason}</T>
          <T v="small" muted>{r.settlement === "pay_now" ? "Pay now" : "Next payslip"}{r.settled_period ? ` · ${monthLabel(r.settled_period)}` : ""} · raised {fmtDate(r.raised_at)}</T>
          <T v="small" muted>{r.status}{r.status === "cancelled" && r.cancelled_reason ? ` — ${r.cancelled_reason}` : ""}</T>
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <T v="monoLg" color={Number(r.amount) < 0 ? t.tone("danger").text : t.tone("success").text}>{Number(r.amount) > 0 ? "+" : ""}{Number(r.amount).toLocaleString()}</T>
          {(repeat.get(r.employee_id) ?? 0) > 1 && <Badge small tone="warning" label={`×${repeat.get(r.employee_id)}`} />}
        </View>
      </HStack>
      {canAdjust && r.status === "open" && (
        <HStack style={{ marginTop: 10 }}>
          {r.settlement === "pay_now" && <Button size="sm" label={Number(r.amount) > 0 ? "Pay" : "Receive"} disabled={busy} onPress={() => { setSheetErr(null); setPay({ mode: "Cash", bank: "", custodian: "", date: todayIso() }); setSettling(r); }} />}
          <Button size="sm" variant="ghost" label="Cancel" disabled={busy} onPress={() => { setSheetErr(null); setCancelReason(""); setCancelling(r); }} />
        </HStack>
      )}
    </Card>
  );

  return (
    <>
      {error && <Banner tone="danger" title={error} />}
      {!rows && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      <Section title="Open" count={open.length} hint="Raised from a payslip. A pay-now adjustment settles here; one carried to the next payslip settles when that payslip is disbursed. An adjustment still open when its period closes is money that quietly stops existing — the nightly check watches for it.">
        {open.map(card)}
        {rows && open.length === 0 && <Empty title="Nothing open" sub="Every correction raised has been settled." />}
      </Section>
      <Section title="Settled and cancelled" count={rest.length} action={<T v="smallStrong" color={t.tone("brand").text} onPress={() => setShowSettled((x) => !x)}>{showSettled ? "Hide" : "Show"}</T>}>
        {showSettled && (rest.length ? rest.map(card) : <T v="small" muted>None yet.</T>)}
      </Section>

      <Sheet open={!!settling} onClose={() => setSettling(null)} error={sheetErr}
        title={settling ? `${Number(settling.amount) > 0 ? "Pay" : "Receive"} PKR ${Math.abs(Number(settling.amount)).toLocaleString()} — ${settling.full_name}` : ""}
        footer={<><Button label="Back" variant="secondary" full onPress={() => setSettling(null)} /><Button label={busy ? "Settling…" : "Settle"} full disabled={busy || (pay.mode === "Bank" ? !pay.bank : !pay.custodian)} onPress={async () => {
          if (!settling) return;
          setBusy(true); setSheetErr(null);
          try { await settleAdjustment(db.company.id, settling, pay, opts.custodians); setSettling(null); toast("Adjustment settled"); await load(); }
          catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
        }} /></>}>
        {settling && <T v="small" muted>Corrects {monthLabel(settling.original_period_month)}: {settling.reason}. The money moves through the ledger and the balance in one transaction.</T>}
        <View style={{ height: 10 }} />
        <Select label="By" value={pay.mode} onChange={(m) => setPay({ ...pay, mode: m })} options={[{ value: "Cash", label: "Cash" }, { value: "Bank", label: "Bank" }]} />
        {pay.mode === "Bank"
          ? <Select label="Bank account" value={pay.bank} onChange={(b) => setPay({ ...pay, bank: b })} options={opts.banks.map((b) => ({ value: b.id, label: `${b.bank_name} — ${b.account_number}` }))} />
          : <Select label={settling && Number(settling.amount) > 0 ? "Who hands the cash over" : "Who receives the cash"} searchable value={pay.custodian} onChange={(c) => setPay({ ...pay, custodian: c })} options={opts.custodians.map((c) => ({ value: c.employeeId, label: c.fullName }))} />}
        <Input label="Date" value={pay.date} onChangeText={(d) => setPay({ ...pay, date: d })} placeholder="YYYY-MM-DD" />
      </Sheet>

      <Sheet open={!!cancelling} onClose={() => setCancelling(null)} title="Cancel adjustment" error={sheetErr}
        footer={<><Button label="Back" variant="secondary" full onPress={() => setCancelling(null)} /><Button label="Cancel adjustment" variant="danger" full disabled={busy || !cancelReason.trim()} onPress={async () => {
          if (!cancelling) return;
          setBusy(true); setSheetErr(null);
          try { await cancelAdjustment(cancelling.id, cancelReason); setCancelling(null); toast("Adjustment cancelled", "warning"); await load(); }
          catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
        }} /></>}>
        <T v="small" muted>The accrual reverses and the row stays, marked cancelled with this reason. Nothing is deleted.</T>
        <View style={{ height: 10 }} />
        <Input label="Why" required value={cancelReason} onChangeText={setCancelReason} />
      </Sheet>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────── Leave
function Leave() {
  const t = useTheme();
  const { can } = useAuth();
  const { db } = useDB();
  const { toast } = useOverlay();
  const canEdit = can("payroll.edit");
  const [guards, setGuards] = useState<LeaveGuard[]>([]);
  const [setterNames, setSetterNames] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState("");
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [lost, setLost] = useState<LostRow[]>([]);
  const [lostPeriod, setLostPeriod] = useState(todayIso().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ovQuota, setOvQuota] = useState("");
  const [ovReason, setOvReason] = useState("");
  const [busy, setBusy] = useState(false);

  const loadGuards = useCallback(async () => {
    try { const r = await loadLeaveGuards(); setGuards(r.guards); setSetterNames(r.setterNames); } catch (e) { setError(err(e)); }
    setLoading(false);
  }, []);
  useEffect(() => { const h = setTimeout(() => { void loadGuards(); }, 0); return () => clearTimeout(h); }, [loadGuards]);
  const guard = guards.find((g) => g.id === selected);
  useEffect(() => {
    const h = setTimeout(() => { setOvQuota(guard?.leave_quota_override != null ? String(guard.leave_quota_override) : ""); setOvReason(""); }, 0);
    return () => clearTimeout(h);
  }, [guard?.id, guard?.leave_quota_override]);
  useEffect(() => {
    if (!selected) return;
    loadLeaveLedger(selected).then(setLedger).catch((e) => setError(err(e)));
  }, [selected]);
  useEffect(() => {
    if (!db.company.id || !/^\d{4}-\d{2}$/.test(lostPeriod)) return;
    loadLostAtCap(db.company.id, lostPeriod).then(setLost).catch(() => setLost([]));
  }, [db.company.id, lostPeriod]);

  const saveOverride = async (clear: boolean) => {
    if (!selected) return;
    setBusy(true);
    try {
      await setQuotaOverride(selected, clear ? null : ovQuota, clear ? null : ovReason);
      toast(clear ? "Override cleared — the contract's quota applies." : `Quota override ${ovQuota} recorded. It replaces the contract's quota entirely.`);
      await loadGuards();
      setLedger(await loadLeaveLedger(selected));
    } catch (e) { toast(err(e), "danger"); }
    finally { setBusy(false); }
  };

  return (
    <>
      {error && <Banner tone="danger" title={error} />}
      {loading && <ActivityIndicator style={{ marginTop: 12 }} />}
      <Card style={{ marginBottom: 12 }}>
        <T v="small" muted>
          Every balance opens at zero on 1 September 2026. The quota is the contract&apos;s monthly leaves; a contract with none earns none. Tiers on days present: 1–8 → nothing · 9–16 → half · 17–24 → three quarters · 25+ → full quota, rounded down to whole days. A named override on a guard, with a reason, replaces the contract&apos;s quota. Leave marks are paid from the balance; the rest are unpaid. Absences are unpaid and do not touch the balance — they only lower the tier. At 15 earning stops: what would go past it is lost, and shown as lost.
        </T>
      </Card>
      <Section title="Lost at the cap" count={lost.length} hint="A guard losing leave silently is how a rule becomes an argument.">
        <Input label="Month (YYYY-MM)" value={lostPeriod} onChangeText={setLostPeriod} />
        <ListCard>
          {lost.map((l, i) => (
            <Row key={l.employee_id} last={i === lost.length - 1} onPress={() => setSelected(l.employee_id)} title={l.full_name}
              meta={`Opening ${l.opening} · Would earn ${l.would_earn} · Banked ${l.banked}`} right={<Badge small tone="danger" label={`Lost ${l.lost}`} />} />
          ))}
        </ListCard>
        {lost.length === 0 && /^\d{4}-\d{2}$/.test(lostPeriod) && <T v="small" muted>Nobody lost leave at the cap in {monthLabel(`${lostPeriod}-01`)}.</T>}
      </Section>
      <Section title="A guard's balance, and how it got there">
        <Select label="Guard" searchable value={selected} onChange={setSelected} placeholder="Pick a guard…"
          options={guards.map((g) => ({ value: g.id, label: `${g.full_name}${g.guard_code ? ` · ${g.guard_code}` : ""}` }))} />
        {guard && (
          <Card style={{ marginBottom: 10 }}>
            {guard.leave_quota_override != null
              ? <T v="small"><T v="smallStrong" color={t.tone("warning").text}>Quota override {guard.leave_quota_override}</T> — {guard.leave_quota_override_reason} · set by {setterNames.get(guard.leave_quota_override_by ?? "") ?? "unknown"}{guard.leave_quota_override_at ? ` on ${fmtDate(guard.leave_quota_override_at)}` : ""}. Replaces the contract&apos;s quota entirely.</T>
              : <T v="small" muted>No override — the contract&apos;s quota applies.</T>}
            {canEdit && (
              <View style={{ marginTop: 10 }}>
                <Input label="Override quota" keyboardType="numeric" value={ovQuota} onChangeText={setOvQuota} />
                <Input label="Reason (required — it is recorded against the guard)" value={ovReason} onChangeText={setOvReason} placeholder="e.g. site agreed 2 leaves in the deployment letter" />
                <HStack>
                  <Button size="sm" variant="secondary" label="Record override" disabled={busy || ovQuota === "" || !ovReason.trim()} onPress={() => saveOverride(false)} />
                  {guard.leave_quota_override != null && <Button size="sm" variant="ghost" label="Clear" disabled={busy} onPress={() => saveOverride(true)} />}
                </HStack>
              </View>
            )}
          </Card>
        )}
        {selected && ledger.map((r) => (
          <Card key={r.period_start} style={{ marginBottom: 8 }}>
            <T v="bodyStrong">{monthLabel(r.period_start)}</T>
            <Ledger label="Opening" value={String(r.opening)} />
            <Ledger label={`Present ${r.present_days} → tier ${r.tier} of quota ${r.quota}`} value={`+${r.earned}`} tone="success" />
            {r.lost > 0 && <Ledger label="Lost" value={`−${r.lost}`} tone="danger" />}
            <Ledger label="Taken" value={`−${r.taken}`} />
            {r.unpaid > 0 && <Ledger label="Unpaid" value={String(r.unpaid)} />}
            <Ledger label="Closing" value={String(r.closing)} strong top />
          </Card>
        ))}
        {selected && ledger.length === 0 && <T v="small" muted>No periods yet — the first is September 2026.</T>}
      </Section>
    </>
  );
}
