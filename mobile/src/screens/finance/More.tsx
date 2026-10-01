// Finance pages ported from the web: Partnership Run, Period Close, Treasury,
// Regional operating expenses, Partners, Project Financing.
import { ChevronDown, ChevronRight, Download, FileText, Lock, Pencil, Plus, RotateCcw, Send, Unlock } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Chips, Empty, HStack, IconBtn, Input, Ledger, ListCard, Row, SearchBar, Section, StatGrid, Tabs, Toggle, tap } from "../../components/ui";
import { useDB } from "../../data/store";
import { todayIso } from "../../data/api/core";
import {
  accrueBonusReserve, addInvestment, addLedgerEntry, addPartnerEntry, closePeriod, draftProfitAllocation, ENTRY_TYPES, fundReserve, loadPartnerStatement, loadPartnerSummary,
  loadPartners, loadPartnershipRun, loadPeriodClose, loadProjects, loadRegionalOpex, loadTreasury, mirrorDepreciation, monthKeys, monthName, PartnerForm, PAYMENT_METHODS,
  PeriodRow, postProfitAllocation, previousMonthKey, reopenPeriod, requestInterregionFunding, reverseProfitAllocation, REVIEW_KINDS, runHoAllocation, saveInvestor, savePartner, saveProject,
} from "../../data/api/finance";
import { exportTable } from "../../lib/web/excel";
import { saveText } from "../../lib/saveFile";
import { useAuth } from "../../lib/auth";
import { useRegion } from "../../lib/region";
import { useTheme } from "../../theme/ThemeProvider";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const money0 = (n: unknown) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const money2 = (n: unknown) => Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const acct = (n: unknown) => (Number(n ?? 0) < 0 ? `(${money2(Math.abs(Number(n ?? 0)))})` : money2(n));
const fmt = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;

function useLoad<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => { try { setData(await fn()); setError(null); } catch (e) { setError(err(e)); } }, [fn]);
  useEffect(() => { const h = setTimeout(() => { void reload(); }, 0); return () => clearTimeout(h); }, [reload]);
  return { data, error, reload };
}

// ─────────────────────────────────────────────────────────── Partnership Run
export function PartnershipRun() {
  const t = useTheme();
  const { db } = useDB();
  const { can } = useAuth();
  const { confirm } = useOverlay();
  const canPost = can("partnership.post");
  const [period, setPeriod] = useState(previousMonthKey());
  const loader = useCallback(() => loadPartnershipRun(db.company.id, period), [db.company.id, period]);
  const { data, error, reload } = useLoad(loader);
  const [busy, setBusy] = useState<null | "draft" | "post" | "reverse">(null);
  const [msg, setMsg] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const run = data?.run;
  const outputs: any[] = run?.outputs ?? [];
  const partnerRows = outputs.filter((r) => r.row_kind === "REGIONAL_PARTNER" || r.row_kind === "EQUITY_PARTNER");
  const otherRows = outputs.filter((r) => !partnerRows.includes(r));
  const reviewByKind = useMemo(() => { const m = new Map<string, any[]>(); for (const r of data?.review ?? []) m.set(r.kind, [...(m.get(r.kind) ?? []), r]); return m; }, [data]);

  const doPost = async (confirmIncomplete: boolean): Promise<void> => {
    if (!run) return;
    setBusy("post"); setMsg(null);
    try {
      const r = await postProfitAllocation(run.id, confirmIncomplete);
      if (r.needsConfirm) {
        setBusy(null);
        if (await confirm({ title: "Post anyway?", message: r.needsConfirm, confirmLabel: "Post anyway" })) return doPost(true);
        return;
      }
      setMsg({ tone: "success", text: `${monthName(period)} is posted. Every partner's capital account has moved.` });
      await reload();
    } catch (e) { setMsg({ tone: "danger", text: err(e) }); } finally { setBusy(null); }
  };

  return (
    <Screen eyebrow="Finance" title="Partnership Run" subtitle="Draft a month, review what it would pay, then post it to every partner's account">
      <HStack>
        <View style={{ flex: 1 }}><Select compact label="Month" value={period} onChange={setPeriod} options={monthKeys(15).map((p) => ({ value: p, label: monthName(p) }))} /></View>
        <Badge label={run?.status ?? "NOT DRAFTED"} tone={run?.status === "POSTED" ? "success" : run?.status === "DRAFT" ? "warning" : "neutral"} />
      </HStack>
      {data?.deadline && (
        <T v="small" style={{ marginTop: 8 }} color={data.deadline.posted ? t.tone("success").text : data.deadline.days_late > 0 ? t.tone("danger").text : t.mutedFg}>
          {data.deadline.posted ? `Posted. It was due ${data.deadline.due_date}.` : data.deadline.days_late > 0 ? `${data.deadline.days_late} day(s) late — due ${data.deadline.due_date} and not posted.` : `Due ${data.deadline.due_date}.`}
        </T>
      )}
      {error && <Banner tone="danger" title={error} />}
      {msg && <Banner tone={msg.tone} title={msg.text} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      {data?.blocker && <Banner tone="warning" title={`${monthName(period)} cannot be drafted yet.`} sub={data.blocker} />}
      {data && (
        <HStack wrap style={{ marginVertical: 10 }}>
          <Button variant="secondary" icon={FileText} label={run?.status === "DRAFT" ? "Re-draft" : "Draft this month"} loading={busy === "draft"} disabled={busy !== null || !!data.blocker || run?.status === "POSTED"}
            onPress={async () => {
              setBusy("draft"); setMsg(null);
              try { await draftProfitAllocation(db.company.id, period); setMsg({ tone: "success", text: `${monthName(period)} is drafted. Nothing has been posted — review it below, then post.` }); await reload(); }
              catch (e) { setMsg({ tone: "danger", text: err(e) }); } finally { setBusy(null); }
            }} />
          {run?.status === "DRAFT" && <Button icon={Send} label="Post the run" loading={busy === "post"} disabled={busy !== null || !canPost} onPress={() => doPost(false)} />}
          {run?.status === "POSTED" && <Button variant="danger" icon={RotateCcw} label="Reverse" loading={busy === "reverse"} disabled={busy !== null || !canPost} onPress={async () => {
            if (!(await confirm({ title: `Reverse the posted run for ${monthName(period)}?`, message: "This unwinds the journal entry and every partner's share for the month. The posting deadline comes back onto the compliance calendar.", confirmLabel: "Reverse", tone: "danger" }))) return;
            setBusy("reverse"); setMsg(null);
            try { await reverseProfitAllocation(run.id); setMsg({ tone: "success", text: `${monthName(period)} is reversed. Re-draft it when the source data is right.` }); await reload(); }
            catch (e) { setMsg({ tone: "danger", text: err(e) }); } finally { setBusy(null); }
          }} />}
          {!canPost && run?.status === "DRAFT" && <T v="small" muted>Posting needs the partnership.post permission.</T>}
        </HStack>
      )}
      {run && (
        <Card style={{ marginBottom: 10 }}>
          <Ledger label="Total profit" value={acct(run.total_profit)} strong />
          <Ledger label="Regional total" value={acct(run.regional_total)} />
          <Ledger label="Equity total" value={acct(run.equity_total)} />
          {run.basis && <Ledger label="Basis" value={run.basis} />}
        </Card>
      )}
      {partnerRows.length > 0 && (
        <Section title="Partner shares">
          {partnerRows.map((r, i) => {
            const pos = data?.positions.get(r.partner_id ?? "");
            return (
              <Card key={`${r.partner_id ?? i}`} style={{ marginBottom: 8 }}>
                <T v="bodyStrong">{r.partner_name ?? "—"}</T>
                <T v="small" muted>{r.row_kind === "REGIONAL_PARTNER" ? `Regional · ${r.region_name ?? "no region"}` : "Equity"}{r.share_pct != null ? ` · ${r.share_pct}%` : ""}</T>
                <Ledger label="Base" value={acct(r.base_amount)} />
                <Ledger label="Amount" value={acct(r.amount)} strong />
                {pos && <Ledger label="Net position" sub={`profit ${acct(pos.remuneration)} · agency ${acct(-pos.agency)}`} value={acct(pos.balance)} />}
              </Card>
            );
          })}
        </Section>
      )}
      {otherRows.length > 0 && (
        <Section title="Regions & pools">
          <ListCard>{otherRows.map((r, i) => <Row key={i} last={i === otherRows.length - 1} title={r.region_name ?? r.row_kind} meta={`own ${acct(r.own_profit)} · HO ${acct(r.ho_allocated)}${r.residual != null ? ` · residual ${acct(r.residual)}` : ""}`} right={<T v="mono">{acct(r.amount ?? r.base_amount)}</T>} />)}</ListCard>
        </Section>
      )}
      {data && (
        <Section title="Review before posting" count={data.review.length}>
          {data.review.length === 0 && <T v="small" muted>Nothing flagged for this month.</T>}
          {[...reviewByKind.entries()].map(([kind, rows]) => (
            <Card key={kind} style={{ marginBottom: 8 }}>
              <T v="bodyStrong">{REVIEW_KINDS[kind]?.title ?? kind}</T>
              {REVIEW_KINDS[kind] && <T v="small" muted>{REVIEW_KINDS[kind].note}</T>}
              {rows.map((r, i) => <Ledger key={`${r.subject_id ?? i}`} label={r.subject} sub={r.detail} value={acct(r.amount)} tone={r.amount < 0 ? "danger" : undefined} />)}
            </Card>
          ))}
          {data.uninvoiced.length > 0 && (
            <Card>
              <T v="bodyStrong">Clients with no invoice this month</T>
              {data.uninvoiced.map((u) => <T key={u.client_id} v="small">{u.client_name} · {u.client_code}{u.region_name ? ` · ${u.region_name}` : ""} — {u.reason}</T>)}
            </Card>
          )}
        </Section>
      )}
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────── Period Close
export function PeriodClose() {
  const { can, profile } = useAuth();
  const { toast } = useOverlay();
  const canManage = can("period_close.manage");
  const { data, error, reload } = useLoad(loadPeriodClose);
  const [action, setAction] = useState<{ row: PeriodRow; kind: "close" | "reopen" } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const closed = (data ?? []).filter((r) => r.closed_at).length;
  return (
    <Screen eyebrow="Finance" title="Period Close" subtitle="Lock a month so no edits can land in it. Re-opens require explicit confirmation.">
      <Banner tone="info" title="How this works" sub="Closing a month blocks any new or edited invoice, payment, expense, payslip, advance, or cheque dated in that month — for everyone. To correct a closed period, post in an open month, or re-open, fix and close again. Re-openings are logged." />
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      {data && <StatGrid cols={3} items={[{ label: "Months shown", value: String(data.length) }, { label: "Closed", value: String(closed), tone: "success" }, { label: "Open", value: String(data.length - closed), tone: "warning" }]} />}
      <View style={{ marginTop: 12 }}>
        {data?.map((r) => (
          <Card key={r.period_month} style={{ marginBottom: 8 }}>
            <HStack>
              <View style={{ flex: 1 }}>
                <T v="bodyStrong">{r.label}</T>
                <T v="small" muted>Inv {r.invoices} · Pay {r.payments} · Exp {r.expenses} · Payslips {r.payslips} · Adv {r.advances} · Chq {r.cheques}</T>
                {r.closed_at && <T v="small" muted>Closed {r.closed_at.slice(0, 10)}{r.closed_by_name ? ` by ${r.closed_by_name}` : ""}{r.note ? ` · ${r.note}` : ""}</T>}
              </View>
              <Badge small label={r.closed_at ? "Closed" : "Open"} tone={r.closed_at ? "success" : "warning"} />
            </HStack>
            {canManage && <Button size="sm" variant={r.closed_at ? "secondary" : "primary"} icon={r.closed_at ? Unlock : Lock} label={r.closed_at ? "Re-open" : "Close month"} style={{ marginTop: 8, alignSelf: "flex-start" }}
              onPress={() => { setNote(""); setSheetErr(null); setAction({ row: r, kind: r.closed_at ? "reopen" : "close" }); }} />}
          </Card>
        ))}
      </View>
      <Sheet open={!!action} onClose={() => setAction(null)} error={sheetErr} title={action ? `${action.kind === "close" ? "Close" : "Re-open"} ${action.row.label}?` : ""}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setAction(null)} /><Button full label={busy ? "Saving…" : action?.kind === "close" ? "Close month" : "Re-open month"} disabled={busy} variant={action?.kind === "reopen" ? "danger" : "primary"} onPress={async () => {
          if (!action) return;
          setBusy(true); setSheetErr(null);
          try {
            if (action.kind === "close") await closePeriod(action.row.period_month, profile?.id ?? null, note);
            else if (action.row.period_id) await reopenPeriod(action.row.period_id);
            setAction(null); toast(action.kind === "close" ? "Month closed" : "Month re-opened"); await reload();
          } catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
        }} /></>}>
        {action && <T v="small" muted>{action.row.total} transaction(s) are dated in this month. {action.kind === "close" ? "No one will be able to add or edit anything dated in it until it is re-opened." : "Edits will be allowed again until it is closed."}</T>}
        {action?.kind === "close" && <Input label="Note (optional)" value={note} onChangeText={setNote} />}
      </Sheet>
    </Screen>
  );
}

// ────────────────────────────────────────────────────────────────── Treasury
const BAND: Record<string, "success" | "warning" | "danger"> = { green: "success", amber: "warning", red: "danger" };
export function Treasury() {
  const t = useTheme();
  const { db } = useDB();
  const { toast } = useOverlay();
  const companyId = db.company.id;
  const loader = useCallback(() => loadTreasury(companyId), [companyId]);
  const { data, error, reload } = useLoad(loader);
  const [tab, setTab] = useState<"cockpit" | "regional" | "reserves" | "interregion" | "capital">("cockpit");
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 8) + "01");
  const [busy, setBusy] = useState(false);
  const [ir, setIr] = useState({ lender: "", borrower: "", amount: "" });
  const branchName = new Map((data?.branches ?? []).map((b) => [b.id, b.name]));
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await reload(); } catch (e) { toast(err(e), "danger"); } finally { setBusy(false); }
  };
  const firstBreach = (data?.forecast ?? []).find((w) => w.is_breach);
  return (
    <Screen eyebrow="Finance" title="Treasury & Regional Finance" sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "cockpit", label: "Cash cockpit" }, { key: "regional", label: "Regional P&L" }, { key: "reserves", label: "Reserves" }, { key: "interregion", label: "Inter-region" }, { key: "capital", label: "Capital & custody" }]} />}>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      {data && tab === "cockpit" && (
        <>
          <StatGrid items={[
            { label: "Gross cash", value: `PKR ${money0(data.cockpit?.gross_cash)}` }, { label: "Reserves", value: `PKR ${money0(data.cockpit?.reserves)}` },
            { label: "Available after reserves", value: `PKR ${money0(data.cockpit?.available_after_reserves)}`, tone: "success" }, { label: "Days of runway", value: String(data.cockpit?.days_runway ?? "—") },
          ]} />
          {data.danger && <Banner tone={BAND[data.danger.band] ?? "info"} title={`${String(data.danger.band).toUpperCase()} band · available ${money0(data.danger.available_cash)} vs minimum ${money0(data.danger.min_cash)}${data.danger.ratio != null ? ` · ratio ${Number(data.danger.ratio).toFixed(2)}×` : ""}`} sub={data.danger.band === "red" ? "Non-payroll disbursements require COO override" : undefined} />}
          <Section title="13-week cash forecast" hint={firstBreach ? `First breach: week of ${firstBreach.week_start}` : undefined}>
            <ListCard>
              {data.forecast.map((w, i) => (
                <Row key={w.week_no} last={i === data.forecast.length - 1} title={`Week ${w.week_no} · ${w.week_start}`} meta={`Open ${money0(w.opening_balance)} · In ${money0(w.expected_inflow)} · Out ${money0(w.expected_outflow)}`}
                  right={<T v="mono" color={Number(w.closing_balance) < 0 ? t.tone("danger").text : t.fg}>{money0(w.closing_balance)}</T>} />
              ))}
            </ListCard>
          </Section>
          <Section title="Cash entitlement by region">
            <ListCard>
              {data.entitlements.map((e, i) => (
                <Row key={i} last={i === data.entitlements.length - 1} title={e.region_name ?? "—"} meta={`Reserve ${money0(e.restricted_reserve)} · Free ${money0(e.free_entitlement)} · Inter-region ${money0(e.interregion_net_position)}`} right={<T v="mono">{money0(e.entitlement)}</T>} />
              ))}
            </ListCard>
          </Section>
        </>
      )}
      {data && tab === "regional" && (
        <>
          <Input label="Month (YYYY-MM-01)" value={period} onChangeText={setPeriod} />
          <HStack wrap>
            <Button size="sm" variant="secondary" label="Run HO cost allocation" disabled={busy} onPress={() => run(() => runHoAllocation(companyId, period), "HO cost allocated")} />
            <Button size="sm" variant="secondary" label="Accrue bonus reserve" disabled={busy} onPress={() => run(() => accrueBonusReserve(companyId, period), "Bonus reserve accrued")} />
            <Button size="sm" variant="secondary" label="Mirror depreciation → reserve" disabled={busy} onPress={() => run(() => mirrorDepreciation(companyId, period), "Depreciation mirrored")} />
          </HStack>
          <T v="small" muted style={{ marginVertical: 6 }}>Run HO allocation before pools/accrual so regional profit is stated after head-office cost.</T>
          <ListCard>
            {data.pnl.map((r, i) => (
              <Row key={i} last={i === data.pnl.length - 1} title={`${r.region_name ?? "—"} · ${String(r.period_month).slice(0, 7)}`} meta={`Rev ${money0(r.revenue)} · Direct ${money0(r.direct_cost)} · HO ${money0(r.allocated_ho_cost)}`}
                right={<T v="mono" color={Number(r.net_profit) < 0 ? t.tone("danger").text : t.tone("success").text}>{money0(r.net_profit)}</T>} />
            ))}
          </ListCard>
        </>
      )}
      {data && tab === "reserves" && (
        <>
          {data.reserves.map((r) => (
            <Card key={r.reserve_type} style={{ marginBottom: 8 }}>
              <T v="bodyStrong">{r.reserve_type}</T>
              <Ledger label="Balance" value={money0(r.balance)} />
              <Ledger label="Target" value={money0(r.target)} />
              <Ledger label="Shortfall" value={money0(r.shortfall)} tone={Number(r.shortfall) > 0 ? "danger" : "success"} />
              {Number(r.shortfall) > 0 && <Button size="sm" variant="secondary" label="Fund shortfall" style={{ alignSelf: "flex-start", marginTop: 6 }} disabled={busy} onPress={() => run(() => fundReserve(companyId, r.reserve_type, Number(r.shortfall)), "Reserve funded")} />}
            </Card>
          ))}
          <T v="small" muted>Funding sweeps cash into a restricted reserve account (Dr reserve / Cr bank).</T>
        </>
      )}
      {data && tab === "interregion" && (
        <>
          <Section title="Request inter-region funding" hint="Funding posts only after COO approval (Governance); a repayment nets the balance down.">
            <Card>
              <Select label="Lender region" value={ir.lender} onChange={(v) => setIr({ ...ir, lender: v })} options={data.branches.map((b) => ({ value: b.id, label: b.name }))} />
              <Select label="Borrower region" value={ir.borrower} onChange={(v) => setIr({ ...ir, borrower: v })} options={data.branches.map((b) => ({ value: b.id, label: b.name }))} />
              <Input label="Amount" keyboardType="numeric" value={ir.amount} onChangeText={(v) => setIr({ ...ir, amount: v })} />
              <Button label="Request approval" disabled={busy || !ir.lender || !ir.borrower || !ir.amount} onPress={() => run(() => requestInterregionFunding(companyId, ir.lender, ir.borrower, Number(ir.amount)), "Funding request submitted for COO approval (see Governance).")} />
            </Card>
          </Section>
          <Section title="Transactions">
            <ListCard>{data.interregion.map((x, i) => <Row key={x.id} last={i === data.interregion.length - 1} title={`${branchName.get(x.lender_branch_id) ?? "?"} → ${branchName.get(x.borrower_branch_id) ?? "?"}`} meta={`${x.txn_type} · ${x.txn_date}`} right={<T v="mono">{Number(x.amount ?? 0).toLocaleString()}</T>} />)}</ListCard>
          </Section>
        </>
      )}
      {data && tab === "capital" && (
        <>
          <Section title="Partner capital (from ledger)" hint="Balances are derived from the equity sub-ledger, not the stored opening figure.">
            <ListCard>{data.capital.map((p, i) => <Row key={p.partner_id} last={i === data.capital.length - 1} title={p.name} meta={p.region_name ?? p.scope} right={<T v="mono">{money0(p.capital_balance)}</T>} />)}</ListCard>
          </Section>
          <Section title="Cash sub-ledgers" hint="Each cash box reconciles to its own COA sub-account.">
            <ListCard>{data.custody.map((c, i) => <Row key={c.cash_location_id} last={i === data.custody.length - 1} title={c.name} meta={`${c.location_type ?? ""}${c.region_name ? ` · ${c.region_name}` : ""}`} right={<T v="mono">{money0(c.balance)}</T>} />)}</ListCard>
          </Section>
        </>
      )}
    </Screen>
  );
}

// ──────────────────────────────────── Regional operating expenses (scorecard)
export function RegionalScorecard() {
  const t = useTheme();
  const { db } = useDB();
  const { regionId, regions, locked } = useRegion();
  const { toast } = useOverlay();
  const [period, setPeriod] = useState(monthKeys(1)[0]);
  const [regionTab, setRegionTab] = useState("all");
  const [openCats, setOpenCats] = useState<Set<string>>(new Set());
  const loader = useCallback(() => loadRegionalOpex(db.company.id, period), [db.company.id, period]);
  const { data, error } = useLoad(loader);
  const hoBranchIds = useMemo(() => new Set(regions.filter((r) => r.kind === "head_office").map((r) => r.id)), [regions]);
  const opexRows = useMemo(() => {
    if (!data) return [];
    const m = new Map<string, { branchId: string; name: string; ho: number }>();
    for (const r of data.clientStmt) {
      if (!r.branch_id || hoBranchIds.has(r.branch_id)) continue;
      const cur = m.get(r.branch_id) ?? { branchId: r.branch_id, name: regions.find((x) => x.id === r.branch_id)?.name ?? "Region", ho: 0 };
      cur.ho += Number(r.ho_share);
      m.set(r.branch_id, cur);
    }
    const hoLines = [...m.values()].filter((r) => r.ho > 0).map((r) => ({ branch_id: r.branchId, region_name: r.name, category: "Head Office (allocated)", expense_id: null, expense_date: `${period}-01`, description: "Apportioned by share of company revenue", client_name: null, vendor_name: null, payment_mode: null, amount: r.ho, is_derived: false }));
    const all = [...data.opex, ...hoLines];
    return locked && regionId ? all.filter((r) => r.branch_id === regionId) : all;
  }, [data, hoBranchIds, regions, period, locked, regionId]);
  const regionTabs = (locked && regionId ? regions.filter((r) => r.id === regionId) : regions).map((r) => ({ key: r.id, name: r.name }));
  const active = regionTabs.some((x) => x.key === regionTab) ? regionTab : "all";
  const shown = active === "all" ? opexRows : opexRows.filter((r) => (r.branch_id ?? "unassigned") === active);
  const tree = useMemo(() => {
    const by = new Map<string, { region: string; total: number; cats: Map<string, { category: string; total: number; items: any[] }> }>();
    for (const r of shown) {
      let reg = by.get(r.region_name);
      if (!reg) { reg = { region: r.region_name, total: 0, cats: new Map() }; by.set(r.region_name, reg); }
      let cat = reg.cats.get(r.category);
      if (!cat) { cat = { category: r.category, total: 0, items: [] }; reg.cats.set(r.category, cat); }
      cat.items.push(r); cat.total += Number(r.amount); reg.total += Number(r.amount);
    }
    const list = [...by.values()].map((r) => ({ ...r, catList: [...r.cats.values()].sort((a, b) => b.total - a.total) })).sort((a, b) => b.total - a.total);
    return { list, grand: list.reduce((s, r) => s + r.total, 0) };
  }, [shown]);
  return (
    <Screen region eyebrow="Finance" title="Regional Operating Expenses"
      actions={<IconBtn icon={Download} label="Export" onPress={() => exportTable({
        fileName: `Operating Expenses ${monthName(period)}.xlsx`, sheetName: "Operating Expenses", title: `Operating Expenses by Region — ${monthName(period)}`,
        headers: ["Region", "Category", "Date", "Description", "Client / Vendor", "Mode", "Amount"],
        rows: shown.map((r) => [r.region_name, r.category, r.expense_date, r.description ?? "", r.client_name ?? r.vendor_name ?? "Office", r.payment_mode ?? (r.is_derived ? "Payroll" : ""), Number(r.amount)]),
      }).catch((e) => toast(err(e), "danger"))} />}>
      <Select compact label="Month" value={period} onChange={setPeriod} options={monthKeys(18).map((p) => ({ value: p, label: monthName(p) }))} />
      <View style={{ marginVertical: 8 }}><Chips value={active} onChange={setRegionTab} items={[{ key: "all", label: "All regions" }, ...regionTabs.map((r) => ({ key: r.key, label: r.name }))]} /></View>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator />}
      {data && <Ledger label="Total operating expenses" value={fmt(tree.grand)} strong />}
      {tree.list.map((reg) => (
        <Card key={reg.region} pad={0} style={{ marginTop: 10 }}>
          <HStack style={{ padding: 12 }}><T v="bodyStrong" style={{ flex: 1 }}>{reg.region}</T><T v="mono">{fmt(reg.total)}</T></HStack>
          {reg.catList.map((c) => {
            const k = `${reg.region}|${c.category}`;
            const open = openCats.has(k);
            return (
              <View key={k} style={{ borderTopWidth: 1, borderTopColor: t.border }}>
                <Pressable onPress={() => { tap(); setOpenCats((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }); }} style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12 }}>
                  {open ? <ChevronDown size={14} color={t.mutedFg} /> : <ChevronRight size={14} color={t.mutedFg} />}
                  <T v="small" style={{ flex: 1 }}>{c.category} · {c.items.length}</T>
                  <T v="mono" style={{ fontSize: 12 }}>{fmt(c.total)}</T>
                </Pressable>
                {open && c.items.map((it, i) => (
                  <View key={it.expense_id ?? `${k}-${i}`} style={{ paddingLeft: 34, paddingRight: 12, paddingBottom: 8 }}>
                    <HStack><T v="small" style={{ flex: 1 }}>{it.description ?? "—"}</T><T v="mono" style={{ fontSize: 12 }}>{money0(it.amount)}</T></HStack>
                    <T v="small" muted>{it.expense_date} · {it.client_name ?? it.vendor_name ?? "Office"}{it.payment_mode ? ` · ${it.payment_mode}` : it.is_derived ? " · Payroll" : ""}</T>
                  </View>
                ))}
              </View>
            );
          })}
        </Card>
      ))}
      {data && tree.list.length === 0 && <Empty title={`No operating expenses in ${monthName(period)}`} />}
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────── Partners
const blankPartner = (): PartnerForm => ({ name: "", scope: "COMPANY", branch_id: "", allocation_method: "MANUAL", default_share_pct: "", opening_balance: "0", opening_balance_date: todayIso(), is_active: true });
export function Partners() {
  const { db } = useDB();
  const { profile } = useAuth();
  const { toast } = useOverlay();
  const companyId = db.company.id;
  const loader = useCallback(() => loadPartners(companyId), [companyId]);
  const { data, error, reload } = useLoad(loader);
  const [tab, setTab] = useState<"partners" | "statement" | "summary">("partners");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<any | "new" | null>(null);
  const [f, setF] = useState<PartnerForm>(blankPartner);
  const [entry, setEntry] = useState<{ type: "DRAWING" | "CONTRIBUTION"; partnerId: string } | null>(null);
  const [ef, setEf] = useState({ date: todayIso(), amount: "", payment_method: "CASH", description: "" });
  const [stmtPartner, setStmtPartner] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(todayIso());
  const [stmt, setStmt] = useState<any[]>([]);
  const [summary, setSummary] = useState<Map<string, any> | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const partners = data?.partners ?? [];
  useEffect(() => { if (stmtPartner) loadPartnerStatement(stmtPartner, from, to).then(setStmt).catch((e) => toast(err(e), "danger")); }, [stmtPartner, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === "summary" && partners.length) loadPartnerSummary(partners).then(setSummary).catch((e) => toast(err(e), "danger")); }, [tab, partners]); // eslint-disable-line react-hooks/exhaustive-deps
  const sp = partners.find((p) => p.id === stmtPartner);
  const stmtRows = useMemo(() => {
    if (!sp) return [];
    let running = Number(sp.opening_balance);
    return stmt.map((e) => {
      if (e.type === "PROFIT_ALLOCATION" || e.type === "CONTRIBUTION") running += Number(e.amount);
      else if (e.type === "DRAWING") running -= Number(e.amount);
      return { ...e, running };
    });
  }, [sp, stmt]);

  return (
    <Screen eyebrow="Finance" title="Partners" sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "partners", label: "Partners" }, { key: "statement", label: "Statement" }, { key: "summary", label: "Summary" }]} />}>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      {data && tab === "partners" && (
        <>
          <HStack><View style={{ flex: 1 }}><SearchBar value={search} onChange={setSearch} placeholder="Partner name" /></View><IconBtn icon={Plus} filled label="Add partner" onPress={() => { setEdit("new"); setF(blankPartner()); setSheetErr(null); }} /></HStack>
          {partners.filter((p) => !search.trim() || p.name.toLowerCase().includes(search.trim().toLowerCase())).map((p) => (
            <Card key={p.id} style={{ marginTop: 8 }}>
              <HStack>
                <View style={{ flex: 1 }}>
                  <T v="bodyStrong">{p.name}{p.opening_balance_locked ? " 🔒" : ""}</T>
                  <T v="small" muted>{p.scope === "BRANCH" ? `Regional · ${data.branches.find((b) => b.id === p.branch_id)?.name ?? "no region"}` : "Company"} · {p.allocation_method} · opening {fmt(Number(p.opening_balance))}</T>
                </View>
                <Badge small label={p.is_active ? "Active" : "Inactive"} tone={p.is_active ? "success" : "neutral"} />
              </HStack>
              <HStack wrap style={{ marginTop: 8 }}>
                <Button size="sm" variant="ghost" icon={Pencil} label="Edit" onPress={() => {
                  setEdit(p); setSheetErr(null);
                  setF({ name: p.name, scope: p.scope, branch_id: p.branch_id ?? "", allocation_method: p.allocation_method, default_share_pct: p.profit_share_percent != null ? String(p.profit_share_percent) : "", opening_balance: String(p.opening_balance), opening_balance_date: p.opening_balance_date ?? todayIso(), is_active: p.is_active });
                }} />
                <Button size="sm" variant="secondary" label="Drawing" onPress={() => { setEf({ date: todayIso(), amount: "", payment_method: "CASH", description: "" }); setSheetErr(null); setEntry({ type: "DRAWING", partnerId: p.id }); }} />
                <Button size="sm" variant="secondary" label="Contribution" onPress={() => { setEf({ date: todayIso(), amount: "", payment_method: "CASH", description: "" }); setSheetErr(null); setEntry({ type: "CONTRIBUTION", partnerId: p.id }); }} />
                <Button size="sm" variant="ghost" label="Statement" onPress={() => { setStmtPartner(p.id); setTab("statement"); }} />
              </HStack>
            </Card>
          ))}
        </>
      )}
      {data && tab === "statement" && (
        <>
          <Select label="Partner" value={stmtPartner} onChange={setStmtPartner} options={partners.map((p) => ({ value: p.id, label: p.name }))} />
          <HStack>
            <Input style={{ flex: 1 }} label="From" value={from} onChangeText={setFrom} placeholder="YYYY-MM-DD" />
            <Input style={{ flex: 1 }} label="To" value={to} onChangeText={setTo} />
          </HStack>
          {sp && (
            <>
              <HStack style={{ justifyContent: "space-between" }}>
                <Ledger label="Opening balance" value={fmt(Number(sp.opening_balance))} />
                <IconBtn icon={Download} label="Export CSV" onPress={() => {
                  if (stmtRows.length === 0) return;
                  let running = Number(sp.opening_balance);
                  const rows = [["Date", "Description", "Drawing (Out)", "Allocation (In)", "Contribution (In)", "Balance"], ["", "Opening Balance", "", "", "", String(running)]];
                  for (const e of stmt) {
                    let dr = "", cr = "", contrib = "";
                    if (e.type === "DRAWING") { dr = String(e.amount); running -= Number(e.amount); }
                    else if (e.type === "PROFIT_ALLOCATION") { cr = String(e.amount); running += Number(e.amount); }
                    else if (e.type === "CONTRIBUTION") { contrib = String(e.amount); running += Number(e.amount); }
                    rows.push([e.date, e.description, dr, cr, contrib, String(running)]);
                  }
                  saveText(rows.map((r) => r.join(",")).join("\n"), `${sp.name} Statement.csv`).catch((x) => toast(err(x), "danger"));
                }} />
              </HStack>
              <ListCard>
                {stmtRows.map((e, i) => (
                  <Row key={e.id} last={i === stmtRows.length - 1} title={e.description} meta={`${e.date} · ${e.type === "PROFIT_ALLOCATION" ? "Allocation" : e.type === "DRAWING" ? "Drawing" : e.type === "CONTRIBUTION" ? "Contribution / repayment" : "Opening"}${e.payment_method ? ` · ${e.payment_method}` : ""}`}
                    right={<View style={{ alignItems: "flex-end" }}><T v="mono">{e.type === "DRAWING" ? "−" : "+"}{money0(e.amount)}</T><T v="small" muted>{money0(e.running)}</T></View>} />
                ))}
              </ListCard>
              {stmtRows.length === 0 && <T v="small" muted>No entries in this range.</T>}
            </>
          )}
        </>
      )}
      {data && tab === "summary" && (
        <>
          {!summary && <ActivityIndicator />}
          {summary && partners.map((p) => {
            const s = summary.get(p.id);
            return (
              <Card key={p.id} style={{ marginBottom: 8 }}>
                <T v="bodyStrong">{p.name}</T>
                <Ledger label="Allocated" value={fmt(s?.allocated ?? 0)} />
                <Ledger label="Drawn" value={fmt(s?.drawn ?? 0)} />
                <Ledger label="Contributed" value={fmt(s?.contributed ?? 0)} />
                <Ledger label="Balance" value={fmt(s?.balance ?? 0)} strong />
              </Card>
            );
          })}
        </>
      )}
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit === "new" ? "Add partner" : "Edit partner"} error={sheetErr}
        footer={<Button full label={busy ? "Saving…" : "Save"} disabled={busy || !f.name.trim()} onPress={async () => {
          setBusy(true); setSheetErr(null);
          try { await savePartner(companyId, edit === "new" ? null : edit, f); setEdit(null); toast("Partner saved"); await reload(); } catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
        }} />}>
        <Input label="Name" required value={f.name} onChangeText={(s) => setF({ ...f, name: s })} />
        <Select label="Scope" value={f.scope} onChange={(v) => setF({ ...f, scope: v as "COMPANY" | "BRANCH" })} options={[{ value: "COMPANY", label: "Company" }, { value: "BRANCH", label: "Region" }]} />
        {f.scope === "BRANCH" && <Select label="Region" value={f.branch_id} onChange={(v) => setF({ ...f, branch_id: v })} options={(data?.branches ?? []).map((b) => ({ value: b.id, label: b.name }))} />}
        <Select label="Allocation method" value={f.allocation_method} onChange={(v) => setF({ ...f, allocation_method: v as "FIXED_PCT" | "MANUAL" })} options={[{ value: "MANUAL", label: "Manual" }, { value: "FIXED_PCT", label: "Fixed %" }]} />
        {edit === "new" && <Input label="Default share %" keyboardType="numeric" value={f.default_share_pct} onChangeText={(s) => setF({ ...f, default_share_pct: s })} />}
        {!(edit && edit !== "new" && edit.opening_balance_locked) && (
          <HStack>
            <Input style={{ flex: 1 }} label="Opening balance" keyboardType="numeric" value={f.opening_balance} onChangeText={(s) => setF({ ...f, opening_balance: s })} />
            <Input style={{ flex: 1 }} label="As of" value={f.opening_balance_date} onChangeText={(s) => setF({ ...f, opening_balance_date: s })} />
          </HStack>
        )}
        <Toggle label="Active" value={f.is_active} onChange={(v) => setF({ ...f, is_active: v })} />
      </Sheet>
      <Sheet open={!!entry} onClose={() => setEntry(null)} title={entry?.type === "DRAWING" ? "Record drawing" : "Record contribution"} error={sheetErr}
        footer={<Button full label={busy ? "Saving…" : "Save"} disabled={busy || !ef.amount} onPress={async () => {
          if (!entry) return;
          setBusy(true); setSheetErr(null);
          try {
            await addPartnerEntry(companyId, entry.partnerId, entry.type, ef, profile?.id ?? null);
            setEntry(null); toast("Entry recorded");
            if (stmtPartner === entry.partnerId) setStmt(await loadPartnerStatement(entry.partnerId, from, to));
            if (tab === "summary") setSummary(await loadPartnerSummary(partners));
          } catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
        }} />}>
        <Input label="Date" value={ef.date} onChangeText={(s) => setEf({ ...ef, date: s })} />
        <Input label="Amount" required amount keyboardType="numeric" value={ef.amount} onChangeText={(s) => setEf({ ...ef, amount: s.replace(/[^\d.]/g, "") })} />
        <Select label="Payment method" value={ef.payment_method} onChange={(v) => setEf({ ...ef, payment_method: v })} options={PAYMENT_METHODS.map((m) => ({ value: m, label: m.replace("_", " ") }))} />
        <Input label="Description" value={ef.description} onChangeText={(s) => setEf({ ...ef, description: s })} />
      </Sheet>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────── Project Financing
export function ProjectFinancing() {
  const { db } = useDB();
  const { profile } = useAuth();
  const { toast } = useOverlay();
  const companyId = db.company.id;
  const loader = useCallback(() => loadProjects(companyId), [companyId]);
  const { data, error, reload } = useLoad(loader);
  const [tab, setTab] = useState<"projects" | "investors" | "ledger">("projects");
  const [proj, setProj] = useState<{ id: string | null; f: any } | null>(null);
  const [inv, setInv] = useState<{ id: string | null; f: any } | null>(null);
  const [invmt, setInvmt] = useState<{ projectId: string; f: any } | null>(null);
  const [led, setLed] = useState<any | null>(null);
  const [lp, setLp] = useState(""); const [li, setLi] = useState("");
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, close: () => void, ok: string) => {
    setBusy(true); setSheetErr(null);
    try { await fn(); close(); toast(ok); await reload(); } catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
  };
  const clientName = (id: string | null) => (id ? data?.clients.find((c) => c.id === id)?.name ?? "—" : "—");
  const investorName = (id: string) => data?.investors.find((i) => i.id === id)?.name ?? "—";
  const projName = (id: string) => data?.projects.find((p) => p.id === id)?.name ?? "—";
  const invLedger = (investorId: string, projectId?: string) => {
    const es = (data?.ledger ?? []).filter((e) => e.investor_id === investorId && (!projectId || e.project_id === projectId));
    const sum = (types: string[]) => es.filter((e) => types.includes(e.type)).reduce((s, e) => s + Number(e.amount), 0);
    return { capitalOutstanding: sum(["CAPITAL_IN"]) - sum(["CAPITAL_REPAYMENT"]), returnBalance: sum(["RETURN_ALLOCATION", "FINANCE_COST_ACCRUAL"]) - sum(["RETURN_PAYOUT", "FINANCE_COST_PAYMENT"]) };
  };
  return (
    <Screen eyebrow="Finance" title="Project Financing" subtitle="Investors, capital and returns for funded projects"
      actions={<IconBtn icon={Plus} filled label="Record entry" onPress={() => { setSheetErr(null); setLed({ investor_id: "", project_id: "", date: todayIso(), type: "CAPITAL_IN", amount: "", description: "", cash_location_id: "" }); }} />}
      sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "projects", label: "Projects" }, { key: "investors", label: "Investors" }, { key: "ledger", label: "Ledger" }]} />}>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      {data && tab === "projects" && (
        <>
          <Button icon={Plus} label="New project" style={{ marginBottom: 10 }} onPress={() => { setSheetErr(null); setProj({ id: null, f: { name: "", client_id: "", total_required: "", reserved_profit_pct: "0", payout_gate: "COMPANY_CASHFLOW", status: "Raising", notes: "" } }); }} />
          {data.projects.map((p) => {
            const ims = data.investments.filter((i) => i.project_id === p.id);
            const committed = ims.reduce((s, i) => s + Number(i.committed_amount), 0);
            return (
              <Card key={p.id} style={{ marginBottom: 8 }}>
                <HStack><T v="bodyStrong" style={{ flex: 1 }}>{p.name}</T><Badge small label={p.status} tone={p.status === "Active" ? "success" : p.status === "Raising" ? "warning" : "neutral"} /></HStack>
                <T v="small" muted>{clientName(p.client_id)} · gate {p.payout_gate} · reserved {p.reserved_profit_pct}%</T>
                <Ledger label="Required" value={fmt(Number(p.total_required))} />
                <Ledger label={`Committed (${ims.length} investor${ims.length === 1 ? "" : "s"})`} value={fmt(committed)} />
                {ims.map((i) => <T key={i.id} v="small" muted>• {investorName(i.investor_id)} · {i.return_type} · {fmt(Number(i.committed_amount))}{i.fixed_cost_amount != null ? ` · cost ${fmt(Number(i.fixed_cost_amount))}` : ""}</T>)}
                <HStack style={{ marginTop: 8 }}>
                  <Button size="sm" variant="ghost" icon={Pencil} label="Edit" onPress={() => { setSheetErr(null); setProj({ id: p.id, f: { name: p.name, client_id: p.client_id ?? "", total_required: String(p.total_required), reserved_profit_pct: String(p.reserved_profit_pct), payout_gate: p.payout_gate, status: p.status, notes: p.notes ?? "" } }); }} />
                  <Button size="sm" variant="secondary" label="Add investment" onPress={() => { setSheetErr(null); setInvmt({ projectId: p.id, f: { investor_id: "", return_type: "PROFIT_SHARE", committed_amount: "", fixed_cost_amount: "" } }); }} />
                </HStack>
              </Card>
            );
          })}
          {data.projects.length === 0 && <Empty title="No projects yet" />}
        </>
      )}
      {data && tab === "investors" && (
        <>
          <Button icon={Plus} label="New investor" style={{ marginBottom: 10 }} onPress={() => { setSheetErr(null); setInv({ id: null, f: { name: "", type: "THIRD_PARTY", linked_partner_id: "", is_active: true } }); }} />
          {data.investors.map((i) => {
            const l = invLedger(i.id);
            return (
              <Card key={i.id} style={{ marginBottom: 8 }} onPress={() => { setSheetErr(null); setInv({ id: i.id, f: { name: i.name, type: i.type, linked_partner_id: i.linked_partner_id ?? "", is_active: i.is_active } }); }}>
                <HStack><T v="bodyStrong" style={{ flex: 1 }}>{i.name}</T><Badge small label={i.type === "PARTNER" ? "Partner" : "Third party"} /></HStack>
                <Ledger label="Capital outstanding" value={fmt(l.capitalOutstanding)} />
                <Ledger label="Return balance" value={fmt(l.returnBalance)} />
              </Card>
            );
          })}
        </>
      )}
      {data && tab === "ledger" && (
        <>
          <HStack>
            <View style={{ flex: 1 }}><Select compact clearable label="Project" value={lp} onChange={setLp} placeholder="All projects" options={data.projects.map((p) => ({ value: p.id, label: p.name }))} /></View>
            <View style={{ flex: 1 }}><Select compact clearable label="Investor" value={li} onChange={setLi} placeholder="All investors" options={data.investors.map((p) => ({ value: p.id, label: p.name }))} /></View>
          </HStack>
          <ListCard style={{ marginTop: 8 }}>
            {data.ledger.filter((e) => (!lp || e.project_id === lp) && (!li || e.investor_id === li)).map((e, i, arr) => (
              <Row key={e.id} last={i === arr.length - 1} title={`${investorName(e.investor_id)} · ${projName(e.project_id)}`} meta={`${e.date} · ${e.type.replace(/_/g, " ")}${e.description ? ` · ${e.description}` : ""}`} right={<T v="mono">{money0(e.amount)}</T>} />
            ))}
          </ListCard>
        </>
      )}
      <Sheet open={!!proj} onClose={() => setProj(null)} title={proj?.id ? "Edit project" : "New project"} error={sheetErr}
        footer={<Button full label={busy ? "Saving…" : "Save"} disabled={busy || !proj?.f.name.trim()} onPress={() => proj && run(() => saveProject(companyId, proj.id, proj.f), () => setProj(null), "Project saved")} />}>
        {proj && (
          <>
            <Input label="Name" required value={proj.f.name} onChangeText={(s) => setProj({ ...proj, f: { ...proj.f, name: s } })} />
            <Select label="Client" clearable searchable value={proj.f.client_id} onChange={(v) => setProj({ ...proj, f: { ...proj.f, client_id: v } })} options={(data?.clients ?? []).map((c) => ({ value: c.id, label: c.name }))} />
            <HStack>
              <Input style={{ flex: 1 }} label="Total required" keyboardType="numeric" value={proj.f.total_required} onChangeText={(s) => setProj({ ...proj, f: { ...proj.f, total_required: s } })} />
              <Input style={{ flex: 1 }} label="Reserved profit %" keyboardType="numeric" value={proj.f.reserved_profit_pct} onChangeText={(s) => setProj({ ...proj, f: { ...proj.f, reserved_profit_pct: s } })} />
            </HStack>
            <Select label="Payout gate" value={proj.f.payout_gate} onChange={(v) => setProj({ ...proj, f: { ...proj.f, payout_gate: v } })} options={[{ value: "COMPANY_CASHFLOW", label: "Company cashflow" }, { value: "PROJECT_CASHFLOW", label: "Project cashflow" }]} />
            <Select label="Status" value={proj.f.status} onChange={(v) => setProj({ ...proj, f: { ...proj.f, status: v } })} options={["Raising", "Active", "Completed"].map((s) => ({ value: s, label: s }))} />
            <Input label="Notes" multiline value={proj.f.notes} onChangeText={(s) => setProj({ ...proj, f: { ...proj.f, notes: s } })} />
          </>
        )}
      </Sheet>
      <Sheet open={!!inv} onClose={() => setInv(null)} title={inv?.id ? "Edit investor" : "New investor"} error={sheetErr}
        footer={<Button full label={busy ? "Saving…" : "Save"} disabled={busy || !inv?.f.name.trim()} onPress={() => inv && run(() => saveInvestor(companyId, inv.id, inv.f), () => setInv(null), "Investor saved")} />}>
        {inv && (
          <>
            <Input label="Name" required value={inv.f.name} onChangeText={(s) => setInv({ ...inv, f: { ...inv.f, name: s } })} />
            <Select label="Type" value={inv.f.type} onChange={(v) => setInv({ ...inv, f: { ...inv.f, type: v } })} options={[{ value: "THIRD_PARTY", label: "Third party" }, { value: "PARTNER", label: "Partner" }]} />
            {inv.f.type === "PARTNER" && <Select label="Linked partner" value={inv.f.linked_partner_id} onChange={(v) => setInv({ ...inv, f: { ...inv.f, linked_partner_id: v } })} options={(data?.partners ?? []).map((p) => ({ value: p.id, label: p.name }))} />}
            <Toggle label="Active" value={inv.f.is_active} onChange={(v) => setInv({ ...inv, f: { ...inv.f, is_active: v } })} />
          </>
        )}
      </Sheet>
      <Sheet open={!!invmt} onClose={() => setInvmt(null)} title="Add investment" error={sheetErr}
        footer={<Button full label={busy ? "Saving…" : "Save"} disabled={busy || !invmt?.f.investor_id || !invmt?.f.committed_amount} onPress={() => invmt && run(() => addInvestment(companyId, invmt.projectId, invmt.f), () => setInvmt(null), "Investment added")} />}>
        {invmt && (
          <>
            <Select label="Investor" required value={invmt.f.investor_id} onChange={(v) => setInvmt({ ...invmt, f: { ...invmt.f, investor_id: v } })} options={(data?.investors ?? []).map((p) => ({ value: p.id, label: p.name }))} />
            <Select label="Return type" value={invmt.f.return_type} onChange={(v) => setInvmt({ ...invmt, f: { ...invmt.f, return_type: v } })} options={[{ value: "PROFIT_SHARE", label: "Profit share" }, { value: "FIXED_FINANCE", label: "Fixed finance" }]} />
            <Input label="Committed amount" keyboardType="numeric" value={invmt.f.committed_amount} onChangeText={(s) => setInvmt({ ...invmt, f: { ...invmt.f, committed_amount: s } })} />
            {invmt.f.return_type === "FIXED_FINANCE" && <Input label="Fixed cost amount" keyboardType="numeric" value={invmt.f.fixed_cost_amount} onChangeText={(s) => setInvmt({ ...invmt, f: { ...invmt.f, fixed_cost_amount: s } })} />}
          </>
        )}
      </Sheet>
      <Sheet open={!!led} onClose={() => setLed(null)} title="Record ledger entry" error={sheetErr}
        footer={<Button full label={busy ? "Saving…" : "Save"} disabled={busy || !led?.investor_id || !led?.project_id || !led?.amount} onPress={() => led && run(() => addLedgerEntry(companyId, led, profile?.id ?? null), () => setLed(null), "Entry recorded")} />}>
        {led && (
          <>
            <Select label="Investor" required value={led.investor_id} onChange={(v) => setLed({ ...led, investor_id: v })} options={(data?.investors ?? []).map((p) => ({ value: p.id, label: p.name }))} />
            <Select label="Project" required value={led.project_id} onChange={(v) => setLed({ ...led, project_id: v })} options={(data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} />
            <Select label="Type" value={led.type} onChange={(v) => setLed({ ...led, type: v })} options={ENTRY_TYPES.map((x) => ({ value: x, label: x.replace(/_/g, " ") }))} />
            <HStack>
              <Input style={{ flex: 1 }} label="Date" value={led.date} onChangeText={(s) => setLed({ ...led, date: s })} />
              <Input style={{ flex: 1 }} label="Amount" keyboardType="numeric" value={led.amount} onChangeText={(s) => setLed({ ...led, amount: s })} />
            </HStack>
            <Select label="Cash location" clearable value={led.cash_location_id} onChange={(v) => setLed({ ...led, cash_location_id: v })} options={(data?.cashLocs ?? []).map((c) => ({ value: c.id, label: c.name }))} />
            <Input label="Description" value={led.description} onChangeText={(s) => setLed({ ...led, description: s })} />
          </>
        )}
      </Sheet>
    </Screen>
  );
}
