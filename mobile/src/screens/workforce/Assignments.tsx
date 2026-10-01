// Assignments & Pay (web EmployeeAssignments.tsx): client → site → people with
// contracted-vs-enrolled strength, Edit rules (fixed per post / variable per
// person), the row editor, Assign employees, and the posting actions.
import { useRouter } from "expo-router";
import { ChevronDown, ChevronRight, Download, SlidersHorizontal, UserPlus } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Checkbox, Chips, HStack, IconBtn, Input, Ledger, SearchBar, StatGrid, Toggle, tap } from "../../components/ui";
import { useDB } from "../../data/store";
import { setSalary } from "../../data/api/employees";
import {
  AssignData, AssignTarget, addendumFilledCounts, applyRules, assignEmployees, buildGroups, deptOptions, derive, emptyOther, emptyRule, EmpRow,
  exportAssignments, fixedChanges, Group, loadAssignments, offeredGroups, OtherState, PayMode, perDayOf, postBuckets, PostRule, rowLineOptions,
  saveRowEdit, slotForGroup, totals, variableChanges, CATEGORY_LABEL,
} from "../../data/api/assignments";
import { isSeparatedState, lifecycleStatusLabel } from "../../lib/web/employmentWindow";
import { useAuth } from "../../lib/auth";
import { pkr } from "../../lib/format";
import { useRegion } from "../../lib/region";
import { useTheme } from "../../theme/ThemeProvider";
import { radius } from "../../theme/tokens";
import { EmpAction, EmployeeActionSheets } from "../employees/actions";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const todayIso = () => new Date().toISOString().slice(0, 10);
type RulesTarget = { group: Group; siteId: string | null; siteName: string | null; rows: EmpRow[] };

export default function Assignments() {
  const t = useTheme();
  const router = useRouter();
  const { db, v } = useDB();
  const { canAny } = useAuth();
  const { regionId } = useRegion();
  const { toast } = useOverlay();
  const canAccounts = canAny(["assignments.accounts", "employees.edit"]);
  const canHr = canAny(["assignments.hr", "employees.edit"]);
  const [data, setData] = useState<AssignData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showFired, setShowFired] = useState(false);
  const [onlyMismatch, setOnlyMismatch] = useState(false);
  const [showServices, setShowServices] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [openSites, setOpenSites] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [rulesTarget, setRulesTarget] = useState<RulesTarget | null>(null);
  const [rowTarget, setRowTarget] = useState<EmpRow | null>(null);
  const [assignTo, setAssignTo] = useState<AssignTarget | null>(null);
  const [action, setAction] = useState<{ id: string; a: EmpAction } | null>(null);

  const load = useCallback(async () => { try { setData(await loadAssignments(regionId)); setError(null); } catch (e) { setError(err(e)); } }, [regionId]);
  useEffect(() => { const h = setTimeout(() => { void load(); }, 0); return () => clearTimeout(h); }, [load, v]);

  const x = useMemo(() => (data ? derive(data) : null), [data]);
  const groups = useMemo(() => (data && x ? buildGroups(data, x, { search, showFired, onlyMismatch, showServices }) : []), [data, x, search, showFired, onlyMismatch, showServices]);
  const tot = data && x ? totals(data, x, showServices) : null;
  const stranded = data && x && !showServices ? data.employees.filter((e) => e.client_id && x.servicesOnly.has(e.client_id) && !isSeparatedState(e.lifecycle_state)).length : 0;
  const assignable = useMemo(() => (data?.employees ?? []).filter((e) => (e.category ?? "client") === "client" && !e.client_id && !isSeparatedState(e.lifecycle_state)), [data]);
  const missingBase = (e: EmpRow) => canAccounts && !isSeparatedState(e.lifecycle_state) && !(Number(e.base_salary) > 0);
  const missingJoin = (e: EmpRow) => canAccounts && !isSeparatedState(e.lifecycle_state) && !e.join_date;
  const toggle = (set: Set<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };
  const sel = (key: string) => selected[key] ?? new Set<string>();

  const personRow = (g: Group, e: EmpRow) => (
    <Pressable key={e.id} onPress={() => { tap(); setRowTarget(e); }} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: 1, borderTopColor: t.border, backgroundColor: pressed ? t.muted : isSeparatedState(e.lifecycle_state) ? t.tone("danger").tint : "transparent" })}>
      {canAccounts && <Checkbox value={sel(g.key).has(e.id)} onChange={() => setSelected((p) => ({ ...p, [g.key]: toggle(sel(g.key), e.id) }))} />}
      <View style={{ flex: 1 }}>
        <T v="smallStrong" style={{ fontSize: 14 }}>{e.full_name}</T>
        <T v="mono" muted style={{ fontSize: 11 }}>{x!.displayCodeFor(e)} · {x!.departmentOf(e) ?? "—"} · {e.shift ?? "—"}{showFired ? ` · ${lifecycleStatusLabel(e)}` : ""}</T>
        {missingJoin(e) && <Badge small tone="danger" label="Joining date not set" />}
      </View>
      {canAccounts && (
        <View style={{ alignItems: "flex-end" }}>
          {missingBase(e) ? <Badge small tone="danger" label="Base not set" /> : <T v="mono" style={{ fontSize: 13 }}>{pkr(e.base_salary, { compact: true })}</T>}
          <T v="mono" muted style={{ fontSize: 11 }}>+{pkr(e.allowance ?? 0, { compact: true })}</T>
        </View>
      )}
    </Pressable>
  );

  return (
    <Screen region eyebrow="Workforce" title="Assignments & Pay" subtitle="Posting, pay and contracted-vs-enrolled strength by client"
      actions={<IconBtn icon={Download} label="Export" onPress={() => { if (x) exportAssignments(groups, x).catch((e) => toast(err(e), "danger")); }} />}
      sticky={<SearchBar value={search} onChange={setSearch} placeholder="Search clients" />}>
      {error && <Banner tone="danger" title={error} />}
      {!data && !error && <ActivityIndicator style={{ marginTop: 24 }} />}
      {tot && (
        <StatGrid items={[
          { label: "Contracted", value: String(tot.contracted), tone: "brand", hint: "billed headcount" },
          { label: "Enrolled", value: String(tot.enrolled), tone: tot.enrolled < tot.contracted ? "warning" : "success", hint: "active" },
          { label: "Sites", value: String(tot.sites) },
          { label: "Clients mismatched", value: String(tot.mismatched), tone: tot.mismatched ? "danger" : "success" },
        ]} />
      )}
      {stranded > 0 && <Banner tone="warning" title={`${stranded} active employee${stranded === 1 ? "" : "s"} posted to services-only clients`} sub="They are hidden with those clients. Turn on “Show services clients” to see them." />}
      {data && (
        <View style={{ marginTop: 10 }}>
          {canAccounts && <Toggle label="Show fired / left" value={showFired} onChange={setShowFired} />}
          <Toggle label="Only mismatched clients" value={onlyMismatch} onChange={setOnlyMismatch} />
          <Toggle label="Show services clients" value={showServices} onChange={setShowServices} />
          {canHr && assignable.length > 0 && <T v="small" muted>{assignable.length} unposted employee{assignable.length === 1 ? "" : "s"} waiting to be assigned.</T>}
        </View>
      )}

      {groups.map((g) => {
        const isOpen = open.has(g.key);
        const r = g.recon;
        const selectedHere = sel(g.key);
        return (
          <Card key={g.key} pad={0} style={{ marginTop: 10 }}>
            <Pressable onPress={() => { tap(); setOpen(toggle(open, g.key)); }} style={{ padding: 14, gap: 10 }}>
              <HStack>
                {isOpen ? <ChevronDown size={18} color={t.mutedFg} /> : <ChevronRight size={18} color={t.mutedFg} />}
                <View style={{ flex: 1 }}>
                  <T v="bodyStrong">{g.label}</T>
                  <T v="small" muted>{g.hint}{g.gap === "contract" ? " · No live contract" : g.gap === "employees" ? " · Nobody posted" : ""}</T>
                </View>
                {canHr && (g.clientId || g.categoryKey) && <IconBtn icon={UserPlus} size={36} label="Assign employees" onPress={() => setAssignTo(g.clientId ? { kind: "client", id: g.clientId, name: g.label, siteId: null, siteName: null } : { kind: "category", category: g.categoryKey!, name: g.label })} />}
                {canAccounts && g.rows.length > 0 && <IconBtn icon={SlidersHorizontal} size={36} label="Edit rules" onPress={() => setRulesTarget({ group: g, siteId: null, siteName: null, rows: g.rows })} />}
              </HStack>
              <HStack gap={6} wrap>
                {r ? (
                  <>
                    <Badge small label={`${r.site_count} site${r.site_count === 1 ? "" : "s"}`} />
                    <Badge small label={`${r.contracted_billed_qty} / ${r.enrolled_active}`} tone="info" />
                    <Badge small label={`req. ${r.required_on_ground}`} />
                    <Badge small label={`${r.variance > 0 ? "+" : ""}${r.variance}`} tone={r.variance === 0 ? "success" : r.variance < 0 ? "danger" : "warning"} />
                  </>
                ) : <Badge small label={`Enrolled ${g.rows.filter((e) => !isSeparatedState(e.lifecycle_state)).length}`} tone="info" />}
                {canAccounts && g.rows.filter(missingBase).length > 0 && <Badge small tone="danger" label={`${g.rows.filter(missingBase).length} no base`} />}
                {selectedHere.size > 0 && <Badge small tone="brand" label={`${selectedHere.size} selected`} />}
              </HStack>
            </Pressable>
            {isOpen && (g.siteBuckets ? g.siteBuckets.map((b) => {
              const k = `${g.key}|${b.id}`;
              const so = openSites.has(k);
              const req = b.id ? x!.requiredBySite.get(b.id) : undefined;
              return (
                <View key={k} style={{ borderTopWidth: 1, borderTopColor: t.border }}>
                  <Pressable onPress={() => setOpenSites(toggle(openSites, k))} style={{ paddingHorizontal: 14, paddingVertical: 10, backgroundColor: t.muted, flexDirection: "row", alignItems: "center", gap: 8 }}>
                    {so ? <ChevronDown size={16} color={t.mutedFg} /> : <ChevronRight size={16} color={t.mutedFg} />}
                    <T v="eyebrow" soft style={{ flex: 1 }}>{b.name} · {b.rows.length}{req != null ? ` / req. ${req}` : ""}</T>
                    {canHr && g.clientId && b.id && <IconBtn icon={UserPlus} size={30} label="Assign to site" onPress={() => setAssignTo({ kind: "client", id: g.clientId!, name: `${g.label} · ${b.name}`, siteId: b.id, siteName: b.name })} />}
                    {canHr && g.categoryKey === "office_staff" && b.id && <IconBtn icon={UserPlus} size={30} label="Assign to region" onPress={() => setAssignTo({ kind: "category", category: "office_staff", name: `${g.label} · ${b.name}`, branchId: b.id, branchName: b.name })} />}
                    {canAccounts && b.rows.length > 0 && <IconBtn icon={SlidersHorizontal} size={30} label="Edit rules for site" onPress={() => setRulesTarget({ group: g, siteId: g.clientId ? b.id : null, siteName: b.name, rows: b.rows })} />}
                  </Pressable>
                  {so && b.rows.map((e) => personRow(g, e))}
                  {so && b.rows.length === 0 && <T v="small" muted style={{ padding: 14 }}>Nobody posted here.</T>}
                </View>
              );
            }) : g.rows.map((e) => personRow(g, e)))}
          </Card>
        );
      })}

      {data && x && rulesTarget && (
        <EditRulesSheet data={data} target={rulesTarget} selectedIds={sel(rulesTarget.group.key)} canAccounts={canAccounts} canHr={canHr}
          lines={rulesTarget.group.clientId ? x.personnelLinesForSite(rulesTarget.group.clientId, rulesTarget.siteId ?? "") : []}
          onClose={() => setRulesTarget(null)}
          onDone={async (msg) => { const k = rulesTarget.group.key; setRulesTarget(null); setSelected((p) => ({ ...p, [k]: new Set() })); toast(msg); await load(); }} />
      )}

      {data && x && rowTarget && (
        <RowEditSheet data={data} e={rowTarget} canAccounts={canAccounts} canHr={canHr}
          onClose={() => setRowTarget(null)}
          onSaved={async (msg) => { setRowTarget(null); toast(msg); await load(); }}
          onAction={(a) => { const id = rowTarget.id; setRowTarget(null); setTimeout(() => setAction({ id, a }), 300); }}
          onProfile={() => { const id = rowTarget.id; setRowTarget(null); router.push(`/employees/${id}`); }} />
      )}

      {data && assignTo && (
        <AssignSheet data={data} target={assignTo} candidates={assignable} onClose={() => setAssignTo(null)}
          onDone={async (msg) => { setAssignTo(null); toast(msg); await load(); }} />
      )}

      <EmployeeActionSheets e={action ? db.employees.find((y) => y.id === action.id) ?? null : null} action={action?.a ?? null} onClose={() => { setAction(null); void load(); }} />
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────── Edit rules
const MODE_OPTIONS: { value: PayMode; label: string }[] = [
  { value: "none", label: "No change" }, { value: "set", label: "Set to exact amount" }, { value: "percent", label: "Increase by %" }, { value: "flat", label: "Add fixed amount" },
];

function EditRulesSheet({ data, target, selectedIds, canAccounts, canHr, lines, onClose, onDone }: {
  data: AssignData; target: RulesTarget; selectedIds: Set<string>; canAccounts: boolean; canHr: boolean; lines: any[]; onClose: () => void; onDone: (m: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"fixed" | "variable">("fixed");
  const [rules, setRules] = useState<Record<string, PostRule>>({});
  const [drafts, setDrafts] = useState<Record<string, { base: string; allowance: string }>>({});
  const [other, setOther] = useState<OtherState>(emptyOther);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [e, setE] = useState<string | null>(null);
  const scopeLabel = target.siteName ?? target.group.label;
  const targets = useMemo(() => { const p = target.rows.filter((r) => selectedIds.has(r.id)); return p.length > 0 ? p : target.rows; }, [target.rows, selectedIds]);
  const { buckets, emptyPosts } = useMemo(() => postBuckets(lines, data.contractLines, targets), [lines, data.contractLines, targets]);
  const rule = (k: string) => rules[k] ?? emptyRule();
  const setRule = (k: string, patch: Partial<PostRule>) => setRules((p) => ({ ...p, [k]: { ...(p[k] ?? emptyRule()), ...patch } }));
  const draftOf = (r: EmpRow) => drafts[r.id] ?? { base: r.base_salary != null ? String(Math.round(Number(r.base_salary))) : "", allowance: r.allowance != null ? String(Math.round(Number(r.allowance))) : "" };
  const payChanges = mode === "fixed" ? fixedChanges(buckets, rules) : variableChanges(buckets, drafts);
  const set = (patch: Partial<OtherState>) => setOther((o) => ({ ...o, ...patch }));

  return (
    <Sheet open full onClose={onClose} title={`Edit rules — ${scopeLabel}`} error={e}
      subtitle={`${targets.length} employee${targets.length === 1 ? "" : "s"}${targets.length !== target.rows.length ? " selected" : ""} · ${buckets.length} post${buckets.length === 1 ? "" : "s"}`}
      footer={<><Button label="Cancel" variant="secondary" full disabled={saving} onPress={onClose} /><Button full loading={saving}
        label={saving && payChanges.length ? `Applying ${progress} / ${payChanges.length}…` : payChanges.length ? `Apply ${payChanges.length} pay change${payChanges.length === 1 ? "" : "s"}` : "Apply"}
        onPress={async () => {
          setSaving(true); setE(null); setProgress(0);
          try { const bits = await applyRules(targets, payChanges, other, setProgress); await onDone(`${scopeLabel}: ${bits}.`); }
          catch (x) { setE(err(x)); setSaving(false); }
        }} /></>}>
      {canAccounts && (
        <>
          <Chips value={mode} onChange={setMode} items={[{ key: "fixed", label: "Fixed" }, { key: "variable", label: "Variable" }]} />
          <T v="small" muted style={{ marginVertical: 8 }}>
            {mode === "fixed" ? "One rule per post — everyone filling the same post at this site ends on the same figure. Posts come from the contract lines that staff this site." : "One figure per person, for sites where pay is negotiated individually. Blank keeps what they earn today."}
          </T>
          {buckets.length === 0 && <T v="small" muted>Nobody here to edit.</T>}
          {buckets.map((b) => (
            <Card key={b.key} style={{ marginBottom: 10 }}>
              <T v="bodyStrong">{b.label} · {b.rows.length}</T>
              {mode === "fixed" ? (
                <>
                  <HStack>
                    <View style={{ flex: 1 }}><Select label="Base salary" value={rule(b.key).baseMode} onChange={(m) => setRule(b.key, { baseMode: m as PayMode })} options={MODE_OPTIONS} /></View>
                    <Input style={{ flex: 1 }} label="Value" keyboardType="numeric" editable={rule(b.key).baseMode !== "none"} value={rule(b.key).baseValue} onChangeText={(s) => setRule(b.key, { baseValue: s })} />
                  </HStack>
                  <HStack>
                    <View style={{ flex: 1 }}><Select label="Allowance" value={rule(b.key).allowanceMode} onChange={(m) => setRule(b.key, { allowanceMode: m as PayMode })} options={MODE_OPTIONS} /></View>
                    <Input style={{ flex: 1 }} label="Value" keyboardType="numeric" editable={rule(b.key).allowanceMode !== "none"} value={rule(b.key).allowanceValue} onChangeText={(s) => setRule(b.key, { allowanceValue: s })} />
                  </HStack>
                </>
              ) : b.rows.map((r) => (
                <View key={r.id} style={{ marginTop: 8 }}>
                  <T v="small">{r.full_name}</T>
                  <HStack>
                    <Input style={{ flex: 1 }} label="Base" keyboardType="numeric" value={draftOf(r).base} onChangeText={(s) => setDrafts((p) => ({ ...p, [r.id]: { ...draftOf(r), base: s } }))} />
                    <Input style={{ flex: 1 }} label="Allowance" keyboardType="numeric" value={draftOf(r).allowance} onChangeText={(s) => setDrafts((p) => ({ ...p, [r.id]: { ...draftOf(r), allowance: s } }))} />
                  </HStack>
                </View>
              ))}
            </Card>
          ))}
          {emptyPosts.length > 0 && <T v="small" muted>No one here fills: {emptyPosts.join(", ")}.</T>}
          <HStack>
            <Input style={{ flex: 1 }} label="Effective date" value={other.effectiveDate} onChangeText={(s) => set({ effectiveDate: s })} placeholder="YYYY-MM-DD" />
            <Input style={{ flex: 1 }} label="Reason" value={other.reason} onChangeText={(s) => set({ reason: s })} placeholder="Annual increment" />
          </HStack>
          {payChanges.length > 0 && (
            <Card style={{ marginBottom: 10 }}>
              {payChanges.slice(0, 50).map((c) => <Ledger key={c.employee.id} label={c.employee.full_name} value={`${pkr(c.base)} + ${pkr(c.allowance)}`} />)}
              {payChanges.length > 50 && <T v="small" muted>…and {payChanges.length - 50} more</T>}
            </Card>
          )}
        </>
      )}
      <T v="eyebrow" muted style={{ marginVertical: 8 }}>Other details — applied to all {targets.length}</T>
      {canHr && (
        <>
          <Toggle label="Location" value={other.setLocation} onChange={(b) => set({ setLocation: b })} />
          {other.setLocation && <Select label="Location" clearable value={other.locationId} onChange={(s) => set({ locationId: s })} options={data.locations.map((l) => ({ value: l.id, label: l.name }))} />}
          <Toggle label="Primary branch" value={other.setBranch} onChange={(b) => set({ setBranch: b })} />
          {other.setBranch && <Select label="Branch" clearable value={other.branchId} onChange={(s) => set({ branchId: s })} options={data.branches.map((b) => ({ value: b.id, label: b.name }))} />}
        </>
      )}
      {canAccounts && (
        <>
          <Toggle label="Joining date" value={other.setJoinDate} onChange={(b) => set({ setJoinDate: b })} />
          {other.setJoinDate && <Input label="Joining date" value={other.joinDate} onChangeText={(s) => set({ joinDate: s })} placeholder="YYYY-MM-DD" />}
        </>
      )}
    </Sheet>
  );
}

// ──────────────────────────────────────────────────────────────── Row edit
function RowEditSheet({ data, e, canAccounts, canHr, onClose, onSaved, onAction, onProfile }: {
  data: AssignData; e: EmpRow; canAccounts: boolean; canHr: boolean; onClose: () => void; onSaved: (m: string) => Promise<void>; onAction: (a: EmpAction) => void; onProfile: () => void;
}) {
  const t = useTheme();
  const x = useMemo(() => derive(data), [data]);
  const { db } = useDB();
  const category = e.category ?? "client";
  const neverPosted = !e.client_id;
  const canPost = ["active", "on_leave"].includes(e.lifecycle_state ?? "");
  const [joinDate, setJoinDate] = useState(e.join_date ?? "");
  const [shift, setShift] = useState<string>(e.shift ?? "day");
  const [draftCategory, setDraftCategory] = useState<string>(category);
  const [lineId, setLineId] = useState(e.contract_line_id ?? "");
  const [saving, setSaving] = useState(false);
  const [er, setEr] = useState<string | null>(null);
  const lineOptions = useMemo(() => rowLineOptions(data, x, e), [data, x, e]);
  const canPickLine = canHr && category === "client" && lineOptions.length > 0;
  const depts = useMemo(() => deptOptions(lineOptions, x, e.contract_line_id ?? ""), [lineOptions, x, e.contract_line_id]);
  const [sal, setSal] = useState({ base: e.base_salary != null ? String(e.base_salary) : "", allowance: e.allowance != null ? String(e.allowance) : "", date: todayIso(), reason: "Increment" });
  const mobileEmp = db.employees.find((y) => y.id === e.id);

  return (
    <Sheet open full onClose={onClose} title={`${e.full_name} · ${x.displayCodeFor(e)}`} error={er}
      subtitle={`${CATEGORY_LABEL[category]} · ${data.clients.find((c) => c.id === e.client_id)?.name ?? "—"}`}
      footer={<><Button label="Close" variant="secondary" full disabled={saving} onPress={onClose} />{(canAccounts || canHr) && <Button label="Save" full loading={saving} onPress={async () => {
        setSaving(true); setEr(null);
        try { await saveRowEdit(e, { joinDate, shift, category: draftCategory, lineId, canPickLine, depts }); await onSaved(`${e.full_name} saved`); }
        catch (z) { setEr(err(z)); setSaving(false); }
      }} />}</>}>
      <T v="eyebrow" muted style={{ marginBottom: 8 }}>Posting</T>
      {neverPosted && canHr ? (
        <Select label="Category" value={draftCategory} onChange={setDraftCategory} options={Object.entries(CATEGORY_LABEL).map(([k, l]) => ({ value: k, label: l }))} />
      ) : <Ledger label="Category" value={CATEGORY_LABEL[category]} />}
      {neverPosted && canHr
        ? <Select label="Shift" value={shift} onChange={setShift} options={[{ value: "day", label: "Day" }, { value: "night", label: "Night" }]} />
        : <Ledger label="Shift" value={e.shift ?? "—"} sub="Change it with Change shift below — it is dated." />}
      {canPickLine ? (
        <Select label="Department" value={lineId} onChange={setLineId} placeholder="Not set"
          options={depts.map((d) => ({ value: d.lineId, label: `${d.label} · ${d.filled}/${d.committed} filled${d.full ? " · FULL" : ""}` }))} />
      ) : <Ledger label="Department" value={x.departmentOf(e) ?? "—"} />}
      <Input label="Joining date" editable={canAccounts} value={joinDate} onChangeText={setJoinDate} placeholder="YYYY-MM-DD" />

      {canHr && canPost && (
        <View style={{ gap: 2, marginVertical: 10 }}>
          {([["client", "Change client"], ["category", "Change category"], ["shift", "Change shift"], ["transfer", "Transfer"], ["warnings", "Disciplinary warnings"], ["fire", "Fire / Resign"]] as [EmpAction, string][]).map(([a, label]) => (
            <Pressable key={a} disabled={!mobileEmp} onPress={() => onAction(a)} style={{ paddingVertical: 12, borderRadius: radius.md }}>
              <T v="bodyStrong" color={a === "fire" ? t.tone("danger").text : t.fg}>{label}</T>
            </Pressable>
          ))}
        </View>
      )}

      {canAccounts && (
        <>
          <T v="eyebrow" muted style={{ marginVertical: 8 }}>Pay</T>
          <Card style={{ marginBottom: 10 }}>
            <Ledger label="Base salary" value={e.base_salary == null ? "—" : pkr(e.base_salary)} />
            <Ledger label="Per day" value={perDayOf(e.base_salary) == null ? "—" : pkr(perDayOf(e.base_salary))} sub="Base ÷ days this month" />
            <Ledger label="Allowance" value={e.allowance == null ? "—" : pkr(e.allowance)} />
          </Card>
          <T v="smallStrong" soft>New salary (dated)</T>
          <HStack>
            <Input style={{ flex: 1 }} label="New base" keyboardType="numeric" value={sal.base} onChangeText={(s) => setSal({ ...sal, base: s })} />
            <Input style={{ flex: 1 }} label="Allowance" keyboardType="numeric" value={sal.allowance} onChangeText={(s) => setSal({ ...sal, allowance: s })} />
          </HStack>
          <HStack>
            <Input style={{ flex: 1 }} label="Effective date" value={sal.date} onChangeText={(s) => setSal({ ...sal, date: s })} />
            <Input style={{ flex: 1 }} label="Reason" value={sal.reason} onChangeText={(s) => setSal({ ...sal, reason: s })} />
          </HStack>
          <Button variant="secondary" label="Apply salary change" disabled={saving || !mobileEmp} onPress={async () => {
            setSaving(true); setEr(null);
            try { await setSalary(mobileEmp!, Number(sal.base), Number(sal.allowance) || 0, sal.date, sal.reason); await onSaved("Salary change recorded"); }
            catch (z) { setEr(err(z)); setSaving(false); }
          }} />
        </>
      )}
      <Button variant="ghost" label="Open full profile" style={{ marginTop: 10 }} onPress={onProfile} />
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────── Assign employees
function AssignSheet({ data, target, candidates, onClose, onDone }: { data: AssignData; target: AssignTarget; candidates: EmpRow[]; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const { canAny } = useAuth();
  const canAccounts = canAny(["assignments.accounts", "employees.edit"]);
  const toClient = target.kind === "client";
  const siteId = target.kind === "client" ? target.siteId : null;
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [contractId, setContractId] = useState("");
  const [groupKey, setGroupKey] = useState("");
  const [startDate, setStartDate] = useState("");
  const [shift, setShift] = useState("");
  const [baseSalary, setBaseSalary] = useState("");
  const [allowance, setAllowance] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [er, setEr] = useState<string | null>(null);
  const [addFilled, setAddFilled] = useState<Map<string, number>>(new Map());
  const clientContracts = toClient ? data.contracts.filter((c) => c.client_id === target.id) : [];
  const asOf = startDate || todayIso();
  const groups = useMemo(() => offeredGroups(data, contractId, siteId, asOf), [data, contractId, siteId, asOf]);
  useEffect(() => { let c = false; addendumFilledCounts(groups, asOf).then((m) => { if (!c) setAddFilled(m); }).catch(() => undefined); return () => { c = true; }; }, [groups, asOf]);
  const grp = groups.find((g) => g.key === groupKey);
  const slot = grp ? slotForGroup(data, grp, contractId, siteId, asOf, addFilled) : null;
  const cap = slot ? slot.available : Infinity;
  const shown = useMemo(() => {
    const qs = search.trim().toLowerCase();
    if (!qs) return candidates;
    return candidates.filter((e) => e.full_name.toLowerCase().includes(qs) || (e.employee_code ?? "").toLowerCase().includes(qs) || (e.guard_code ?? "").toLowerCase().includes(qs) || (e.cnic_number ?? "").toLowerCase().includes(qs) || (e.phone ?? "").toLowerCase().includes(qs));
  }, [candidates, search]);
  const pick = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else if (n.size < cap) n.add(id); return n; });
  // The joining date suggests itself when every pick shares one (the web's suggestedJoin).
  const pickAndSuggest = (id: string) => {
    pick(id);
    const next = new Set(picked); if (next.has(id)) next.delete(id); else next.add(id);
    const ds = new Set(candidates.filter((e) => next.has(e.id)).map((e) => e.join_date ?? ""));
    if (ds.size === 1 && [...ds][0]) setStartDate([...ds][0]);
  };

  return (
    <Sheet open full onClose={onClose} title={`Assign employees — ${target.name}`} error={er}
      subtitle={slot ? `${slot.filled}/${slot.committed} filled · ${slot.available} free` : `${picked.size} picked`}
      footer={<><Button label="Cancel" variant="secondary" full disabled={saving} onPress={onClose} /><Button full loading={saving}
        label={saving ? `Assigning ${progress} / ${picked.size}…` : `Assign ${picked.size}`} onPress={async () => {
          setSaving(true); setEr(null); setProgress(0);
          try {
            const msg = await assignEmployees(target, candidates.filter((e) => picked.has(e.id)), { startDate, contractId, groupKey, groups, slot, clientContracts: clientContracts.length, shift, baseSalary, allowance }, setProgress);
            await onDone(msg);
          } catch (x) { setEr(err(x)); setSaving(false); }
        }} /></>}>
      {toClient && clientContracts.length > 0 && (
        <Select label="Contract" required value={contractId} onChange={(c) => { setContractId(c); setGroupKey(""); setPicked(new Set()); }}
          options={clientContracts.map((c) => ({ value: c.id, label: `${c.contract_code} · ${c.status}` }))} />
      )}
      {toClient && groups.length > 0 && (
        <Select label="Post" required value={groupKey} onChange={(k) => { setGroupKey(k); setPicked(new Set()); }}
          options={groups.map((g) => { const s = slotForGroup(data, g, contractId, siteId, asOf, addFilled); return { value: g.key, label: g.label, sub: `${s.filled}/${s.committed} filled · ${s.available} free` }; })} />
      )}
      <Input label="Joining date" required value={startDate} onChangeText={setStartDate} placeholder="YYYY-MM-DD" />
      <Select label="Shift" clearable value={shift} onChange={setShift} placeholder="Keep each person's shift" options={[{ value: "day", label: "Day" }, { value: "night", label: "Night" }]} />
      {canAccounts && (
        <HStack>
          <Input style={{ flex: 1 }} label="Base salary (optional)" keyboardType="numeric" value={baseSalary} onChangeText={setBaseSalary} />
          <Input style={{ flex: 1 }} label="Allowance" keyboardType="numeric" value={allowance} onChangeText={setAllowance} />
        </HStack>
      )}
      <SearchBar value={search} onChange={setSearch} placeholder="Name, code, CNIC or phone" />
      <HStack style={{ marginVertical: 8 }}>
        <T v="small" muted style={{ flex: 1 }}>{candidates.length} unposted · {picked.size} picked{cap !== Infinity ? ` · cap ${cap}` : ""}</T>
      </HStack>
      {shown.map((e) => (
        <Checkbox key={e.id} value={picked.has(e.id)} onChange={() => pickAndSuggest(e.id)} label={e.full_name}
          sub={`${e.guard_code ?? e.employee_code ?? ""}${e.join_date ? ` · joined ${e.join_date}` : ""}${!picked.has(e.id) && picked.size >= cap ? " · post full" : ""}`} />
      ))}
      {candidates.length === 0 && <T v="small" muted>No unposted employees. Office staff and relievers are already placed — change their category first to post them to a client.</T>}
    </Sheet>
  );
}
