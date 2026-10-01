// Accounting Core (web AccountingCore hub): Opening balances | Chart of accounts
// | Trial balance | Journal. Every figure is read from the ledger.
import { useLocalSearchParams } from "expo-router";
import { ChevronDown, ChevronRight, Download, Landmark, Pencil, Plus, Trash2, Wallet } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, HStack, IconBtn, Input, Ledger, ListCard, Row, SearchBar, Section, Tabs, Toggle, tap } from "../../components/ui";
import { useDB } from "../../data/store";
import { todayIso } from "../../data/api/core";
import {
  addOpeningLine, CoaForm, createBatch, deleteAccount, JOURNAL_PAGE, JournalEntryView, loadCoa, loadJournalMeta, loadJournalPage, loadOpeningBatches, loadOpeningLines,
  loadTrialBalance, postBatch, postManualJournal, prefillFromOperational, removeOpeningLine, saveAccount,
} from "../../data/api/accountingCore";
import { ACCOUNT_TYPE_LABEL, ACCOUNT_TYPE_ORDER } from "../../lib/web/supabase";
import { exportTable } from "../../lib/web/excel";
import { useAuth } from "../../lib/auth";
import { useRegion } from "../../lib/region";
import { useTheme } from "../../theme/ThemeProvider";

type Tab = "opening" | "coa" | "tb" | "journal";
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmtPKR = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;
const money = (n: unknown) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const monthLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

export default function AccountingCore() {
  const { tab: initial } = useLocalSearchParams<{ tab?: Tab }>();
  const [tab, setTab] = useState<Tab>(initial ?? "coa");
  return (
    <Screen region eyebrow="Finance" title="Accounting Core"
      sticky={<Tabs value={tab} onChange={setTab} items={[{ key: "opening", label: "Opening balances" }, { key: "coa", label: "Chart of accounts" }, { key: "tb", label: "Trial balance" }, { key: "journal", label: "Journal" }]} />}>
      {tab === "opening" && <Opening />}
      {tab === "coa" && <COA />}
      {tab === "tb" && <TrialBalance />}
      {tab === "journal" && <Journal />}
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────── Opening balances
function Opening() {
  const t = useTheme();
  const { db } = useDB();
  const { toast } = useOverlay();
  const companyId = db.company.id;
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof loadOpeningBatches>> | null>(null);
  const [selected, setSelected] = useState("");
  const [lines, setLines] = useState<any[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asOf, setAsOf] = useState(todayIso());
  const [desc, setDesc] = useState("Opening trial balance");
  const [line, setLine] = useState({ accountId: "", branchId: "", debit: "", credit: "" });

  const loadMeta = useCallback(async () => { try { setMeta(await loadOpeningBatches(companyId)); } catch (e) { setError(err(e)); } }, [companyId]);
  const loadLines = useCallback(async () => {
    if (!selected) { setLines([]); setTotals(null); return; }
    try { const r = await loadOpeningLines(selected); setLines(r.lines); setTotals(r.totals); } catch (e) { setError(err(e)); }
  }, [selected]);
  useEffect(() => { const h = setTimeout(() => { void loadMeta(); }, 0); return () => clearTimeout(h); }, [loadMeta]);
  useEffect(() => { const h = setTimeout(() => { void loadLines(); }, 0); return () => clearTimeout(h); }, [loadLines]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setError(null);
    try { await fn(); if (ok) toast(ok); await loadMeta(); await loadLines(); return true; } catch (e) { setError(err(e)); return false; } finally { setBusy(false); }
  };

  const accounts = meta?.accounts ?? [];
  const acctName = new Map(accounts.map((a) => [a.id, `${a.account_code} ${a.account_name}`]));
  const brName = new Map((meta?.branches ?? []).map((b) => [b.id, b.name]));
  const selBatch = meta?.batches.find((b) => b.id === selected);
  const balanced = totals && Math.abs(Number(totals.total_debit ?? 0) - Number(totals.total_credit ?? 0)) < 0.005;
  const posted = selBatch && String(selBatch.status) !== "draft";

  if (!companyId) return <Banner tone="warning" title="No company selected" sub="Opening balances are entered against one company's chart of accounts. Choose a company with “View as”, then come back." />;
  return (
    <>
      {error && <Banner tone="danger" title={error} />}
      {!meta && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      <Section title="New batch">
        <Card>
          <HStack>
            <Input style={{ flex: 1 }} label="As of" value={asOf} onChangeText={setAsOf} />
            <Input style={{ flex: 2 }} label="Description" value={desc} onChangeText={setDesc} />
          </HStack>
          <Button label="Create batch" disabled={busy} onPress={() => run(async () => setSelected(await createBatch(companyId, asOf, desc)), "Batch created")} />
        </Card>
      </Section>
      <Section title="Batches" count={meta?.batches.length}>
        <ListCard>
          {(meta?.batches ?? []).map((b, i) => (
            <Row key={b.id} last={i === (meta?.batches.length ?? 0) - 1} onPress={() => setSelected(b.id)} title={b.description ?? "Opening batch"} meta={`As of ${b.as_of_date}`}
              right={<HStack>{selected === b.id && <Badge small tone="brand" label="Open" />}<Badge small label={b.status} tone={b.status === "draft" ? "warning" : "success"} /></HStack>} />
          ))}
        </ListCard>
      </Section>
      {selBatch && (
        <Section title={`Lines — ${selBatch.description ?? ""}`} count={lines.length}>
          {totals && (
            <Card style={{ marginBottom: 10 }}>
              <Ledger label="Total debit" value={money(totals.total_debit)} />
              <Ledger label="Total credit" value={money(totals.total_credit)} />
              <Ledger label={balanced ? "Balanced" : "Out of balance"} value={money(Number(totals.total_debit ?? 0) - Number(totals.total_credit ?? 0))} tone={balanced ? "success" : "danger"} strong />
            </Card>
          )}
          {lines.map((l) => (
            <Card key={l.id} style={{ marginBottom: 6 }}>
              <HStack>
                <View style={{ flex: 1 }}>
                  <T v="bodyStrong">{acctName.get(l.account_id) ?? l.account_id}</T>
                  <T v="small" muted>{l.branch_id ? brName.get(l.branch_id) : "Company-wide"}{l.notes ? ` · ${l.notes}` : ""}</T>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  {Number(l.debit) > 0 && <T v="mono">Dr {money(l.debit)}</T>}
                  {Number(l.credit) > 0 && <T v="mono">Cr {money(l.credit)}</T>}
                </View>
                {!posted && <IconBtn icon={Trash2} size={34} tone="danger" label="Remove" onPress={() => run(() => removeOpeningLine(l.id))} />}
              </HStack>
            </Card>
          ))}
          {!posted && (
            <Card>
              <Select label="Account" searchable value={line.accountId} onChange={(v) => setLine({ ...line, accountId: v })} options={accounts.map((a) => ({ value: a.id, label: `${a.account_code} ${a.account_name}` }))} />
              <Select label="Region" clearable value={line.branchId} onChange={(v) => setLine({ ...line, branchId: v })} placeholder="Company-wide" options={(meta?.branches ?? []).map((b) => ({ value: b.id, label: b.name }))} />
              <HStack>
                <Input style={{ flex: 1 }} label="Debit" keyboardType="numeric" value={line.debit} onChangeText={(s) => setLine({ ...line, debit: s })} />
                <Input style={{ flex: 1 }} label="Credit" keyboardType="numeric" value={line.credit} onChangeText={(s) => setLine({ ...line, credit: s })} />
              </HStack>
              <HStack wrap>
                <Button size="sm" variant="secondary" label="Add line" disabled={busy || !line.accountId} onPress={async () => { if (await run(() => addOpeningLine(selected, line))) setLine({ accountId: "", branchId: line.branchId, debit: "", credit: "" }); }} />
                <Button size="sm" variant="secondary" label="Prefill from recorded balances" disabled={busy} onPress={() => run(() => prefillFromOperational(companyId, selected, accounts), "Prefilled")} />
              </HStack>
              <Button style={{ marginTop: 10 }} label="Post opening balances" disabled={busy || !balanced || lines.length === 0} onPress={() => run(() => postBatch(companyId, selected, lines, accounts), "Opening balances posted")} />
              {lines.length > 0 && balanced && <T v="small" color={t.tone("warning").text} style={{ marginTop: 6 }}>Post this before recording receipts against an opening balance — a receipt credits the receivable control, so it would go negative if the opening is not in the ledger yet.</T>}
            </Card>
          )}
        </Section>
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────── Chart of accounts
const blankCoa = (): CoaForm => ({ account_code: "", account_name: "", account_type: "expense", normal_side: "debit", parent_id: "", active: true });

function COA() {
  const t = useTheme();
  const { db } = useDB();
  const { profile } = useAuth();
  const { regionId, label: regionLabel } = useRegion();
  const { toast, confirm } = useOverlay();
  const isSuper = profile?.role === "super_admin" || profile?.role === "super_super_admin";
  const [data, setData] = useState<Awaited<ReturnType<typeof loadCoa>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<any | "new" | null>(null);
  const [form, setForm] = useState<CoaForm>(blankCoa);
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const load = useCallback(async () => { try { setData(await loadCoa(db.company.id, regionId)); setError(null); } catch (e) { setError(err(e)); } }, [db.company.id, regionId]);
  useEffect(() => { const h = setTimeout(() => { void load(); }, 0); return () => clearTimeout(h); }, [load]);

  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return accounts;
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const keep = new Set<string>();
    for (const a of accounts) {
      if (a.account_code.toLowerCase().includes(s) || a.account_name.toLowerCase().includes(s)) {
        keep.add(a.id);
        let p = a.parent_id;
        while (p && !keep.has(p)) { keep.add(p); p = byId.get(p)?.parent_id ?? null; }
      }
    }
    return accounts.filter((a) => keep.has(a.id));
  }, [accounts, q]);
  const visible = new Set(filtered.map((a) => a.id));
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, any[]>();
    for (const a of filtered) m.set(a.parent_id ?? null, [...(m.get(a.parent_id ?? null) ?? []), a]);
    for (const arr of m.values()) arr.sort((x, y) => x.account_code.localeCompare(y.account_code));
    return m;
  }, [filtered]);
  const lockStructure = editing && editing !== "new" && (!!editing.system_key || !!data?.balances.has(editing.id));

  const node = (a: any, depth: number): React.ReactNode => {
    const kids = childrenOf.get(a.id) ?? [];
    const open = openIds.has(a.id) || !!q.trim();
    const bal = data?.balances.get(a.id) ?? { debit: 0, credit: 0 };
    const net = bal.debit - bal.credit;
    const contra = net !== 0 && (net > 0 ? a.normal_side === "credit" : a.normal_side === "debit");
    const sub = data?.sub.get(a.id);
    return (
      <View key={a.id}>
        <Pressable onPress={() => { tap(); if (kids.length) setOpenIds((p) => { const n = new Set(p); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; }); }}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingLeft: 12 + depth * 16, paddingRight: 8, borderTopWidth: 1, borderTopColor: t.border, opacity: a.active ? 1 : 0.5 }}>
          {kids.length ? (open ? <ChevronDown size={14} color={t.mutedFg} /> : <ChevronRight size={14} color={t.mutedFg} />) : <View style={{ width: 14 }} />}
          {sub?.kind === "bank" && <Landmark size={14} color={t.mutedFg} />}
          {sub?.kind === "cash" && <Wallet size={14} color={t.mutedFg} />}
          <View style={{ flex: 1 }}>
            <T v="small"><T v="mono">{a.account_code}</T>  {a.account_name}</T>
            {(a.is_control || sub) && <T v="small" muted>{a.is_control ? "control" : ""}{sub ? ` ${sub.kind} · ${sub.name}` : ""}</T>}
          </View>
          <T v="mono" color={contra ? t.tone("danger").text : t.fg} style={{ fontSize: 12 }}>{net === 0 ? "—" : `${fmtPKR(Math.abs(net))} ${net > 0 ? "Dr" : "Cr"}`}</T>
          {isSuper && <IconBtn icon={Pencil} size={30} label="Edit" onPress={() => { setEditing(a); setSheetErr(null); setForm({ account_code: a.account_code, account_name: a.account_name, account_type: a.account_type, normal_side: a.normal_side, parent_id: a.parent_id ?? "", active: a.active }); }} />}
        </Pressable>
        {open && kids.map((k) => node(k, depth + 1))}
      </View>
    );
  };

  return (
    <>
      {error && <Banner tone="danger" title={error} />}
      <HStack>
        <View style={{ flex: 1 }}><SearchBar value={q} onChange={setQ} placeholder="Search code or name…" /></View>
        <IconBtn icon={Download} label="Export" onPress={() => {
          exportTable({
            fileName: "Chart of Accounts.xlsx", sheetName: "CoA", title: "Chart of Accounts",
            headers: ["Code", "Name", "Type", "Normal Side", "Control", "Sub-account of", "Debit (PKR)", "Credit (PKR)", "Net (PKR)", "Side", "Active"],
            rows: accounts.map((a) => {
              const b = data?.balances.get(a.id) ?? { debit: 0, credit: 0 };
              return [a.account_code, a.account_name, (ACCOUNT_TYPE_LABEL as any)[a.account_type], a.normal_side, a.is_control ? "Yes" : "", data?.sub.get(a.id)?.name ?? "", b.debit, b.credit,
                Math.abs(b.debit - b.credit), b.debit - b.credit === 0 ? "" : b.debit - b.credit > 0 ? "Dr" : "Cr", a.active ? "Yes" : "No"];
            }),
          }).catch((e) => toast(err(e), "danger"));
        }} />
        {isSuper && <IconBtn icon={Plus} filled label="New account" onPress={() => { setEditing("new"); setForm(blankCoa()); setSheetErr(null); }} />}
      </HStack>
      <T v="small" muted style={{ marginVertical: 8 }}>Balances read from the ledger{regionId ? ` — ${regionLabel}` : ""}.</T>
      {!data && !error && <ActivityIndicator />}
      {data && ACCOUNT_TYPE_ORDER.map((type) => {
        const roots = filtered.filter((a) => a.account_type === type && (!a.parent_id || !visible.has(a.parent_id))).sort((x, y) => x.account_code.localeCompare(y.account_code));
        if (roots.length === 0) return null;
        return (
          <Card key={type} pad={0} style={{ marginBottom: 10 }}>
            <T v="eyebrow" soft style={{ padding: 12 }}>{(ACCOUNT_TYPE_LABEL as any)[type]}</T>
            {roots.map((a) => node(a, 0))}
          </Card>
        );
      })}

      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing === "new" ? "New account" : "Edit account"} error={sheetErr}
        footer={<>
          {editing && editing !== "new" && !editing.system_account && <Button label="Delete" variant="danger" full onPress={async () => {
            if (!(await confirm({ title: `Delete account "${editing.account_code} — ${editing.account_name}"?`, confirmLabel: "Delete", tone: "danger" }))) return;
            try { await deleteAccount(editing); setEditing(null); toast("Account deleted", "warning"); await load(); } catch (e) { setSheetErr(err(e)); }
          }} />}
          <Button label={busy ? "Saving…" : "Save"} full disabled={busy || !form.account_code.trim() || !form.account_name.trim()} onPress={async () => {
            setBusy(true); setSheetErr(null);
            try { await saveAccount(editing === "new" ? null : editing.id, form); setEditing(null); toast("Account saved"); await load(); } catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
          }} />
        </>}>
        <Input label="Account code" required editable={!lockStructure} value={form.account_code} onChangeText={(s) => setForm({ ...form, account_code: s })} placeholder="e.g., 6400" />
        <Select label="Account type" required value={form.account_type} onChange={(v) => !lockStructure && setForm({ ...form, account_type: v, normal_side: v === "asset" || v === "expense" ? "debit" : "credit" })}
          options={ACCOUNT_TYPE_ORDER.map((ty) => ({ value: ty, label: (ACCOUNT_TYPE_LABEL as any)[ty] }))} />
        {lockStructure && <T v="small" muted>{editing?.system_key ? "Fixed — changing it would move every balance under this account to a different statement." : "Fixed — this account carries posted entries, and retyping it moves a balance to the other side."}</T>}
        <Input label="Account name" required value={form.account_name} onChangeText={(s) => setForm({ ...form, account_name: s })} />
        <Select label="Parent account" clearable value={form.parent_id} onChange={(v) => !lockStructure && setForm({ ...form, parent_id: v })} placeholder="— None (top level) —" searchable
          options={accounts.filter((a) => a.account_type === form.account_type && (editing === "new" || a.id !== editing?.id)).map((a) => ({ value: a.id, label: `${a.account_code} — ${a.account_name}` }))} />
        <Select label="Normal side" value={form.normal_side} onChange={(v) => !lockStructure && setForm({ ...form, normal_side: v as "debit" | "credit" })} options={[{ value: "debit", label: "Debit" }, { value: "credit", label: "Credit" }]} />
        <Toggle label="Active" value={form.active} onChange={(v) => setForm({ ...form, active: v })} />
      </Sheet>
    </>
  );
}

// ────────────────────────────────────────────────────────────── Trial balance
function TrialBalance() {
  const t = useTheme();
  const { db } = useDB();
  const { regionId, label: regionLabel } = useRegion();
  const { toast } = useOverlay();
  const [period, setPeriod] = useState("");
  const [hideZero, setHideZero] = useState(true);
  const [data, setData] = useState<Awaited<ReturnType<typeof loadTrialBalance>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let c = false;
    loadTrialBalance(db.company.id, regionId, period).then((r) => { if (!c) { setData(r); setError(null); } }).catch((e) => { if (!c) setError(err(e)); });
    return () => { c = true; };
  }, [db.company.id, regionId, period]);
  const folded = useMemo(() => (data?.rows ?? []).map((r) => ({ account_id: r.account_id, account_code: r.account_code, account_name: r.account_name, account_type: r.account_type, debit: Number(r.total_debit), credit: Number(r.total_credit) }))
    .filter((r) => !hideZero || r.debit !== 0 || r.credit !== 0), [data, hideZero]);
  // The footer is the sum of the rows shown above it — the one stated exception.
  const totals = folded.reduce((a, r) => ({ d: a.d + r.debit, c: a.c + r.credit }), { d: 0, c: 0 });
  const balanced = Math.abs(totals.d - totals.c) < 0.005;
  const isClosed = period ? data?.closed.has(period) : false;
  return (
    <>
      {error && <Banner tone="danger" title={error} />}
      <HStack>
        <View style={{ flex: 1 }}><Select compact label="Period" value={period} onChange={setPeriod} options={[{ value: "", label: "All periods (cumulative)" }, ...(data?.periods ?? []).map((p) => ({ value: p, label: monthLabel(p) }))]} /></View>
        <IconBtn icon={Download} label="Export" onPress={() => {
          exportTable({
            fileName: `Trial Balance ${period || "all periods"}.xlsx`, sheetName: "Trial Balance",
            title: `Trial Balance — ${period ? monthLabel(period) : "all periods"}${regionId ? ` — ${regionLabel}` : ""}`,
            headers: ["Code", "Account", "Type", "Debit (PKR)", "Credit (PKR)"],
            rows: [...folded.map((r) => [r.account_code, r.account_name, (ACCOUNT_TYPE_LABEL as any)[r.account_type], r.debit, r.credit]), ["", "TOTAL", "", totals.d, totals.c]],
          }).catch((e) => toast(err(e), "danger"));
        }} />
      </HStack>
      <Toggle label="Hide zero-balance accounts" value={hideZero} onChange={setHideZero} />
      {period !== "" && <Badge label={isClosed ? "Closed period" : "Open period"} tone={isClosed ? "neutral" : "info"} />}
      {!data && !error && <ActivityIndicator />}
      {data && ACCOUNT_TYPE_ORDER.map((type) => {
        const rows = folded.filter((r) => r.account_type === type);
        if (rows.length === 0) return null;
        return (
          <Section key={type} title={(ACCOUNT_TYPE_LABEL as any)[type]}>
            <ListCard>
              {rows.map((r, i) => (
                <Row key={r.account_id} last={i === rows.length - 1} title={`${r.account_code} ${r.account_name}`}
                  right={<View style={{ alignItems: "flex-end" }}>{r.debit !== 0 && <T v="mono">Dr {fmtPKR(r.debit)}</T>}{r.credit !== 0 && <T v="mono" muted>Cr {fmtPKR(r.credit)}</T>}</View>} />
              ))}
            </ListCard>
          </Section>
        );
      })}
      {data && (
        <Card style={{ marginTop: 12, borderColor: balanced ? t.tone("success").line : t.tone("danger").line }}>
          <Ledger label="Total debit" value={fmtPKR(totals.d)} strong />
          <Ledger label="Total credit" value={fmtPKR(totals.c)} strong />
          <Ledger label={balanced ? "Balanced" : "Out of balance"} value={fmtPKR(totals.d - totals.c)} tone={balanced ? "success" : "danger"} />
        </Card>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────── Journal
function Journal() {
  const t = useTheme();
  const { db } = useDB();
  const { profile } = useAuth();
  const { regionId } = useRegion();
  const { toast } = useOverlay();
  const isSuper = profile?.role === "super_admin" || profile?.role === "super_super_admin";
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof loadJournalMeta>> | null>(null);
  const [f, setF] = useState({ period: "", accountId: "", clientId: "", partnerId: "" });
  const [page, setPage] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [entries, setEntries] = useState<JournalEntryView[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [mf, setMf] = useState({ entry_date: todayIso(), description: "", debit_account_id: "", credit_account_id: "", amount: "" });
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  useEffect(() => { loadJournalMeta(db.company.id).then(setMeta).catch((e) => setError(err(e))); }, [db.company.id]);
  useEffect(() => {
    let c = false;
    loadJournalPage(db.company.id, regionId, { ...f, page }).then((r) => { if (!c) { setEntries(r.entries); setHasMore(r.hasMore); setError(null); } }).catch((e) => { if (!c) setError(err(e)); });
    return () => { c = true; };
  }, [db.company.id, regionId, f, page, reloadKey]);
  const setFilter = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setPage(0); };
  const accOpts = (meta?.accounts ?? []).map((a) => ({ value: a.id, label: `${a.account_code} — ${a.account_name}` }));

  return (
    <>
      {error && <Banner tone="danger" title={error} />}
      <HStack>
        <View style={{ flex: 1 }}><Select compact label="Period" value={f.period} onChange={(v) => setFilter({ period: v })} options={[{ value: "", label: "All periods" }, ...(meta?.periods ?? []).map((p) => ({ value: p, label: monthLabel(p) }))]} /></View>
        <IconBtn icon={Download} label="Export" onPress={() => {
          exportTable({
            fileName: "Journal.xlsx", sheetName: "Journal", title: "Journal",
            headers: ["Date", "Period", "Description", "Source", "Account", "Region", "Debit", "Credit", "Reversal"],
            rows: (entries ?? []).flatMap((e) => e.lines.map((l) => [e.entry_date, e.posting_period, e.description ?? "", e.source_table ?? "manual", `${l.account_code} — ${l.account_name}`, l.region_name ?? "", Number(l.debit), Number(l.credit), e.is_reversal ? "is a reversal" : e.is_reversed ? "was reversed" : ""])),
          }).catch((x) => toast(err(x), "danger"));
        }} />
        {isSuper && <IconBtn icon={Plus} filled label="Manual journal entry" onPress={() => { setSheetErr(null); setManual(true); }} />}
      </HStack>
      <View style={{ gap: 8, marginVertical: 8 }}>
        <Select compact clearable searchable label="Account" value={f.accountId} onChange={(v) => setFilter({ accountId: v })} placeholder="Any account" options={accOpts} />
        <HStack>
          <View style={{ flex: 1 }}><Select compact clearable searchable label="Client" value={f.clientId} onChange={(v) => setFilter({ clientId: v })} placeholder="Any client" options={(meta?.clients ?? []).map((c) => ({ value: c.id, label: c.name }))} /></View>
          <View style={{ flex: 1 }}><Select compact clearable label="Partner" value={f.partnerId} onChange={(v) => setFilter({ partnerId: v })} placeholder="Any partner" options={(meta?.partners ?? []).map((c) => ({ value: c.id, label: c.name }))} /></View>
        </HStack>
      </View>
      {!entries && !error && <ActivityIndicator />}
      {entries?.map((e) => (
        <Card key={e.id} style={{ marginBottom: 8, opacity: e.is_reversed ? 0.7 : 1 }}>
          <HStack>
            <View style={{ flex: 1 }}>
              <T v="bodyStrong">{e.description ?? "—"}</T>
              <T v="small" muted>{e.entry_date} · {monthLabel(e.posting_period)} · {e.source_table ?? "manual"}{e.region_name ? ` · ${e.region_name}` : ""}</T>
            </View>
            {e.is_reversal && <Badge small tone="info" label="Reversal" />}
            {e.is_reversed && <Badge small tone="neutral" label="Reversed" />}
          </HStack>
          {e.lines.map((l) => (
            <HStack key={l.id ?? `${l.account_code}-${l.debit}-${l.credit}`} style={{ marginTop: 4 }}>
              <T v="small" style={{ flex: 1, paddingLeft: Number(l.credit) > 0 ? 16 : 0 }}>{l.account_code} {l.account_name}</T>
              <T v="mono" style={{ fontSize: 12 }} color={Number(l.credit) > 0 ? t.mutedFg : t.fg}>{Number(l.debit) > 0 ? `Dr ${money(l.debit)}` : `Cr ${money(l.credit)}`}</T>
            </HStack>
          ))}
        </Card>
      ))}
      {entries && entries.length === 0 && <T v="small" muted>No entries match.</T>}
      <HStack style={{ marginTop: 10, justifyContent: "space-between" }}>
        <Button size="sm" variant="secondary" label="Newer" disabled={page === 0} onPress={() => setPage((p) => Math.max(0, p - 1))} />
        <T v="small" muted>Page {page + 1} · {JOURNAL_PAGE} entries</T>
        <Button size="sm" variant="secondary" label="Older" disabled={!hasMore} onPress={() => setPage((p) => p + 1)} />
      </HStack>

      <Sheet open={manual} onClose={() => setManual(false)} title="Manual journal entry" error={sheetErr}
        footer={<><Button label="Cancel" variant="secondary" full onPress={() => setManual(false)} /><Button label={busy ? "Posting…" : "Post"} full disabled={busy} onPress={async () => {
          setBusy(true); setSheetErr(null);
          try {
            await postManualJournal(mf, regionId);
            setManual(false); setMf({ entry_date: todayIso(), description: "", debit_account_id: "", credit_account_id: "", amount: "" });
            setPage(0); setReloadKey((k) => k + 1); toast("Journal entry posted");
          } catch (e) { setSheetErr(err(e)); } finally { setBusy(false); }
        }} /></>}>
        <Input label="Date" value={mf.entry_date} onChangeText={(s) => setMf({ ...mf, entry_date: s })} />
        <Input label="Description" value={mf.description} onChangeText={(s) => setMf({ ...mf, description: s })} placeholder="Manual adjustment" />
        <Select label="Debit account" required searchable value={mf.debit_account_id} onChange={(v) => setMf({ ...mf, debit_account_id: v })} options={accOpts} />
        <Select label="Credit account" required searchable value={mf.credit_account_id} onChange={(v) => setMf({ ...mf, credit_account_id: v })} options={accOpts} />
        <Input label="Amount" required amount keyboardType="numeric" value={mf.amount} onChangeText={(s) => setMf({ ...mf, amount: s.replace(/[^\d.]/g, "") })} />
        <T v="small" muted>Posted to the selected region{regionId ? "" : " (company-wide — no region selected)"}.</T>
      </Sheet>
    </>
  );
}
