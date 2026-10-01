import { useLocalSearchParams, useRouter } from "expo-router";
import { CalendarSync, FileSignature, Pencil, Plus, RefreshCw, Trash2, Upload } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { Progress } from "../../components/Charts";
import { Screen } from "../../components/Screen";
import { Select, Sheet, useOverlay } from "../../components/Sheet";
import { T } from "../../components/Text";
import { Badge, Banner, Button, Card, Chips, Empty, HStack, IconBtn, Input, Ledger, ListCard, RecordCard, Row, SearchBar, Section, Segmented, Toggle, toneOf } from "../../components/ui";
import {
  addAddendum, addCycleEvent, AddendumForm, blankAddendum, blankLine, contractCount, ContractFormState, deleteContract, deleteCycleEvent, LineDraft,
  loadContractEditor, loadCycles, nextSiteKey, NO_SITE, renewalDefaults, renewContract, saveContract, SiteDraft, uploadContractDocument,
} from "../../data/api/clients";
import { q, sb, type PickedFile } from "../../data/api/core";
import {
  ADDENDUM_CHANGE_TYPE_LABEL, ADDENDUM_SOURCE_LABEL, CONTRACT_LINE_CATEGORY_LABEL, CONTRACT_TYPE_LINE_CATEGORIES, isPersonnelCategory, type ContractLineCategory,
} from "../../lib/web/supabase";
import { pickDocument } from "../../lib/files";
import { useTheme } from "../../theme/ThemeProvider";
import { Contract, contractValue, TODAY } from "../../data/seed";
import { clientName, useDB } from "../../data/store";
import { useAuth } from "../../lib/auth";
import { daysBetween, fmtDate, fmtShort, pkr } from "../../lib/format";
import { inRegion, useRegion } from "../../lib/region";

const STATUS = ["active", "expired", "terminated", "draft"] as const;

export default function Contracts() {
  const router = useRouter();
  const { db } = useDB();
  const { can } = useAuth();
  const { regionId } = useRegion();
  const [q, setQ] = useState("");
  const [client, setClient] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [sort, setSort] = useState<"end" | "value" | "guards">("end");
  const [edit, setEdit] = useState<Contract | "new" | null>(null);

  const list = db.contracts
    .filter((k) => inRegion(regionId, db.clients.find((c) => c.id === k.client_id)?.branch_id) && (!client || k.client_id === client) && (status === "all" || k.status === status) &&
      (!q || (k.code + clientName(db, k.client_id)).toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => sort === "end" ? a.end.localeCompare(b.end) : sort === "value" ? contractValue(b) - contractValue(a) : b.lines.reduce((x, l) => x + l.committed, 0) - a.lines.reduce((x, l) => x + l.committed, 0));

  return (
    <Screen
      region
      eyebrow="Clients & Contracts"
      title="Contracts"
      actions={can("contracts.edit") ? <IconBtn icon={Plus} label="New contract" filled onPress={() => setEdit("new")} /> : undefined}
      sticky={<SearchBar value={q} onChange={setQ} placeholder="Code or client" />}
    >
      <Select compact clearable label="Client" value={client} onChange={setClient} placeholder="All" options={db.clients.map((c) => ({ value: c.id, label: c.name }))} />
      <View style={{ marginTop: 8 }}>
        <Chips value={status} onChange={setStatus} items={[{ key: "all", label: "All" }, ...STATUS.map((s) => ({ key: s, label: s[0]!.toUpperCase() + s.slice(1), count: db.contracts.filter((k) => k.status === s).length }))]} />
      </View>
      <HStack style={{ marginTop: 10, marginBottom: 12 }}>
        <T v="small" muted>Sort</T>
        <Chips value={sort} onChange={setSort} items={[{ key: "end", label: "Ending soonest" }, { key: "value", label: "Value" }, { key: "guards", label: "Guards" }]} />
      </HStack>
      {list.map((k) => {
        const committed = k.lines.reduce((a, l) => a + l.committed, 0);
        const active = k.lines.reduce((a, l) => a + l.active, 0);
        const left = daysBetween(TODAY, k.end);
        return (
          <RecordCard
            key={k.id}
            title={clientName(db, k.client_id)}
            subtitle={k.code}
            badge={<Badge label={k.status} tone={toneOf(k.status)} />}
            accent={k.status === "active" && left <= 30 ? "warning" : undefined}
            onPress={() => router.push(`/contracts/${k.id}`)}
            fields={[
              { label: "Period", value: `${fmtShort(k.start)} – ${fmtShort(k.end)}` },
              { label: "Value / month", value: pkr(contractValue(k), { compact: true }), mono: true },
              { label: "Guards", value: `${active}/${committed}`, tone: active < committed ? "danger" : undefined },
              { label: "Document", value: k.document ? "Uploaded" : "Missing", tone: k.document ? undefined : "warning" },
            ]}
            tags={k.status === "active" && left <= 60 ? <Badge small label={`${left} days left`} tone={left <= 30 ? "danger" : "warning"} /> : undefined}
          />
        );
      })}
      {list.length === 0 && <Empty icon={FileSignature} title="No contracts match" />}
      {edit && <ContractEditor key={edit === "new" ? "new" : edit.id} contract={edit} onClose={() => setEdit(null)} />}
    </Screen>
  );
}

export function ContractDetail() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { db, v, act } = useDB();
  const { can } = useAuth();
  const { toast, confirm } = useOverlay();
  const [edit, setEdit] = useState<Contract | null>(null);
  const [renew, setRenew] = useState(false);
  const [cycles, setCycles] = useState(false);
  const [addendum, setAddendum] = useState(false);
  const [addendums, setAddendums] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const k = db.contracts.find((x) => x.id === id);
  useEffect(() => {
    if (!id) return;
    q<any[]>(sb().from("contract_addendums").select("*").eq("contract_id", id).order("effective_from", { ascending: false })).then(setAddendums).catch(() => setAddendums([]));
  }, [id, v]);
  if (!k) return <Screen title="Contract"><Empty title="Contract not found" /></Screen>;
  const committed = k.lines.reduce((a, l) => a + l.committed, 0);
  const active = k.lines.reduce((a, l) => a + l.active, 0);
  const canEdit = can("contracts.edit");
  const company = { id: db.company.id, name: db.company.name };

  const uploadDoc = async () => {
    try {
      const file = await pickDocument();
      if (!file) return;
      setBusy(true);
      await act(() => uploadContractDocument(k.id, k.code, file, k.raw?.drive_file_id ?? null, company), "Document uploaded");
    } catch (e) { toast(e instanceof Error ? e.message : String(e), "danger"); } finally { setBusy(false); }
  };

  return (
    <Screen
      eyebrow={k.code}
      title={clientName(db, k.client_id)}
      subtitle={`${fmtDate(k.start)} → ${k.raw?.is_infinite ? "no end date" : fmtDate(k.end)}`}
      actions={canEdit ? <IconBtn icon={Pencil} label="Edit" onPress={() => setEdit(k)} /> : undefined}
      footer={canEdit ? <>
        <Button label="Cycles" icon={CalendarSync} variant="secondary" full onPress={() => setCycles(true)} />
        <Button label="Renew" icon={RefreshCw} full onPress={() => setRenew(true)} />
      </> : undefined}
    >
      <Card>
        <HStack style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <Badge label={k.status} tone={toneOf(k.status)} dot />
          <T v="small" muted>{k.type === "services" ? "Services" : "Guard deployment"}</T>
        </HStack>
        <T v="eyebrow" muted>Value per month</T>
        <T v="figure" style={{ marginTop: 4 }}>{pkr(contractValue(k))}</T>
        <View style={{ marginTop: 14, gap: 6 }}>
          <HStack><T v="small" soft style={{ flex: 1 }}>Guards posted</T><T v="mono">{active}/{committed}</T></HStack>
          <Progress value={active} max={Math.max(committed, 1)} tone={active < committed ? "warning" : "success"} />
        </View>
      </Card>

      <Section title="Contract lines" count={k.lines.length}>
        {k.lines.map((l) => (
          <Card key={l.id} style={{ marginBottom: 8 }}>
            <HStack><T v="bodyStrong" style={{ flex: 1 }}>{l.category}</T><Badge label={`${l.active}/${l.committed} active`} small tone={l.active < l.committed ? "warning" : "success"} /></HStack>
            <T v="small" muted style={{ marginTop: 2 }}>{[l.raw?.shift_code ? `${l.raw.shift_code} shift` : "", l.raw?.site_id ? db.sites.find((s) => s.id === l.raw.site_id)?.name ?? "" : "", l.notes].filter(Boolean).join(" · ")}</T>
            <Ledger label={`${l.committed} × ${pkr(l.rate)}`} value={pkr(l.committed * l.rate)} />
          </Card>
        ))}
        <Card><Ledger label="Total / month" value={pkr(contractValue(k))} strong /></Card>
      </Section>

      <Section title="Addendums" count={addendums.length} action={canEdit ? <T v="smallStrong" color={t.tone("brand").text} onPress={() => setAddendum(true)}>Add</T> : undefined}>
        {addendums.length ? addendums.map((a) => (
          <RecordCard key={a.id} title={ADDENDUM_CHANGE_TYPE_LABEL[a.change_type as keyof typeof ADDENDUM_CHANGE_TYPE_LABEL] ?? a.change_type} subtitle={a.reference ?? undefined}
            fields={[
              { label: "Effective", value: fmtShort(a.effective_from) },
              { label: a.change_type === "RATE_CHANGE" ? "New rate" : a.change_type === "EXTEND_END_DATE" ? "New end" : "Headcount", value: a.change_type === "RATE_CHANGE" ? pkr(Number(a.new_rate)) : a.change_type === "EXTEND_END_DATE" ? (a.new_is_infinite ? "No end date" : fmtShort(a.new_end_date)) : `${a.change_type === "REDUCE_HEADCOUNT" ? "−" : "+"}${a.count_delta}` },
              { label: "Source", value: ADDENDUM_SOURCE_LABEL[a.source as keyof typeof ADDENDUM_SOURCE_LABEL] ?? a.source },
            ]}
            actions={a.drive_view_url ? [{ label: "Reference file", onPress: () => { Linking.openURL(a.drive_view_url).catch(() => {}); } }] : undefined} />
        )) : <T v="small" muted>No addendums.</T>}
      </Section>

      <Section title="Document">
        <ListCard>
          <Row last title={k.document ? k.raw?.contract_file_name ?? `${k.code}.pdf` : "No signed copy uploaded"} subtitle={k.document ? "Signed contract — tap to open" : undefined}
            onPress={k.raw?.drive_view_url ? () => { Linking.openURL(k.raw.drive_view_url).catch(() => {}); } : undefined}
            right={canEdit ? <Button size="sm" variant="secondary" icon={Upload} label={k.document ? "Replace" : "Upload"} loading={busy} onPress={uploadDoc} /> : undefined} />
        </ListCard>
      </Section>

      {canEdit && (
        <Button label="Delete contract" icon={Trash2} variant="ghost" style={{ marginTop: 20 }} onPress={async () => {
          if (await confirm({ title: `Delete contract ${k.code}?`, message: "Its contract lines and addendums are permanently removed. Invoices stay but are unlinked. Guard assignments to this contract are cleared. This cannot be undone.", confirmLabel: "Delete", tone: "danger" })) {
            if (await act(() => deleteContract(k.id), "Contract deleted")) router.back();
          }
        }} />
      )}

      {edit && <ContractEditor contract={edit} onClose={() => setEdit(null)} />}
      {renew && <RenewSheet k={k} onClose={() => setRenew(false)} />}
      {cycles && <CyclesSheet k={k} canEdit={canEdit} onClose={() => setCycles(false)} />}
      {addendum && <AddendumSheet k={k} onClose={() => setAddendum(false)} />}
    </Screen>
  );
}

function RenewSheet({ k, onClose }: { k: Contract; onClose: () => void }) {
  const { act } = useDB();
  const d = renewalDefaults(k.raw?.end_date ?? null);
  const [start, setStart] = useState(d.start);
  const [end, setEnd] = useState(d.end);
  const [inf, setInf] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={`Renew ${k.code}`}
      footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button label="Renew" full loading={busy} onPress={async () => {
        setBusy(true); const ok = await act(() => renewContract(k.id, start, end, inf), "Contract renewed"); setBusy(false); if (ok) onClose();
      }} /></>}>
      <Ledger label="Current term" value={`${fmtDate(k.start)} → ${k.raw?.is_infinite ? "no end date" : fmtDate(k.end)}`} />
      <Input label="Renewed term starts" value={start} onChangeText={setStart} placeholder="YYYY-MM-DD" />
      {!inf && <Input label="Renewed term ends" value={end} onChangeText={setEnd} placeholder="YYYY-MM-DD" />}
      <Toggle label="No end date" value={inf} onChange={setInf} />
      <T v="small" muted style={{ marginTop: 6 }}>Lines and rates carry over. Change rates with an addendum.</T>
    </Sheet>
  );
}

function CyclesSheet({ k, canEdit, onClose }: { k: Contract; canEdit: boolean; onClose: () => void }) {
  const { act } = useDB();
  const [data, setData] = useState<Awaited<ReturnType<typeof loadCycles>> | null>(null);
  const [kind, setKind] = useState<"billing" | "payroll">("billing");
  const [f, setF] = useState({ effective_from: "", anchor_day: "25", note: "" });
  const load = useCallback(() => loadCycles(k.id).then(setData).catch(() => setData({ events: [], billing: [], payroll: [] })), [k.id]);
  useEffect(() => { void load(); }, [load]);
  const periods = data ? (kind === "billing" ? data.billing : data.payroll).slice(-8) : [];
  return (
    <Sheet open onClose={onClose} title={`Cycles — ${k.code}`} full
      footer={canEdit ? <Button label="Add cycle change" full disabled={!f.effective_from} onPress={async () => {
        if (await act(() => addCycleEvent(k.id, kind, f.effective_from, f.anchor_day, f.note), "Cycle change added")) { setF({ effective_from: "", anchor_day: "25", note: "" }); await load(); }
      }} /> : undefined}>
      <Segmented value={kind} onChange={setKind} items={[{ key: "billing", label: "Billing" }, { key: "payroll", label: "Payroll" }]} />
      <Section title="Periods (latest 8)">
        <ListCard>{periods.map((p: any, i: number, a: any[]) => <Row key={i} last={i === a.length - 1} title={`${fmtShort(p.period_start ?? p.start_date)} → ${fmtShort(p.period_end ?? p.end_date)}`} />)}</ListCard>
      </Section>
      <Section title="Cycle changes">
        <ListCard>
          {(data?.events ?? []).filter((e) => e.cycle_kind === kind).map((e, i, a) => (
            <Row key={e.id} last={i === a.length - 1} title={`From ${fmtShort(e.effective_from)} · anchor day ${e.anchor_day}`} subtitle={e.note ?? undefined}
              right={canEdit ? <IconBtn icon={Trash2} label="Remove" onPress={async () => { if (await act(() => deleteCycleEvent(e.id), "Removed")) await load(); }} /> : undefined} />
          ))}
        </ListCard>
      </Section>
      {canEdit && (
        <>
          <Input label="Effective from" value={f.effective_from} onChangeText={(x) => setF({ ...f, effective_from: x })} placeholder="YYYY-MM-DD" />
          <Input label="Anchor day" keyboardType="numeric" value={f.anchor_day} onChangeText={(x) => setF({ ...f, anchor_day: x })} />
          <Input label="Note" value={f.note} onChangeText={(x) => setF({ ...f, note: x })} />
        </>
      )}
    </Sheet>
  );
}

const SHIFT_OPTS = [{ value: "day", label: "Day" }, { value: "evening", label: "Evening" }, { value: "night", label: "Night" }];

/** ContractEditorModal: one save_contract call writes the contract, its sites and lines together. */
function ContractEditor({ contract, onClose }: { contract: Contract | "new"; onClose: () => void }) {
  const t = useTheme();
  const { db, act } = useDB();
  const { can } = useAuth();
  const { confirm } = useOverlay();
  const isNew = contract === "new";
  const raw = isNew ? null : contract.raw;
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof loadContractEditor>> | null>(null);
  const [form, setForm] = useState<ContractFormState | null>(null);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [sites, setSites] = useState<SiteDraft[]>([]);
  const [hasSites, setHasSites] = useState(false);
  const [file, setFile] = useState<PickedFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [clientId, setClientId] = useState<string>(raw?.client_id ?? "");

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-change, as the web screen does
    setLoaded(null);
    loadContractEditor(raw, clientId).then((d) => {
      if (!alive) return;
      setLoaded(d); setForm({ ...d.form, client_id: clientId || d.form.client_id }); setLines(d.lines); setSites(d.sites); setHasSites(d.hasSites);
    }).catch(() => {});
    return () => { alive = false; };
  }, [raw, clientId]);

  if (!loaded || !form) return <Sheet open onClose={onClose} title={isNew ? "New contract" : `Edit ${(contract as Contract).code}`}><ActivityIndicator color={t.brand[500]} /></Sheet>;
  const termsLocked = !isNew && raw?.status === "active";
  const locked = !isNew && !can("contracts.edit");
  const allowed = CONTRACT_TYPE_LINE_CATEGORIES[form.contract_type];
  const setF = <K extends keyof ContractFormState>(k: K, val: ContractFormState[K]) => setForm({ ...form, [k]: val });
  const setLine = (i: number, patch: Partial<LineDraft>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((a, l) => a + (Number(l.committed_count) || 0) * (Number(l.unit_rate) || 0), 0);

  const save = async () => {
    if (locked) return onClose();
    if (isNew && form.client_id && (await contractCount(form.client_id)) > 0) {
      if (!(await confirm({ title: "This client already has a contract", message: "Adding a second contract is legitimate but rarely intended. Create it anyway?", confirmLabel: "Create" }))) return;
    }
    setBusy(true);
    const ok = await act(() => saveContract({
      contractId: isNew ? null : (contract as Contract).id, form, lines, sites, hasSites, loadedSiteIds: loaded.loadedSiteIds, file,
      existingDriveFileId: raw?.drive_file_id ?? null, company: { id: db.company.id, name: db.company.name },
    }), isNew ? "Contract created" : "Contract saved");
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Sheet open onClose={onClose} title={isNew ? "New contract" : `Edit ${(contract as Contract).code}`} full
      footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button label="Save" full loading={busy} disabled={!form.client_id || locked} onPress={save} /></>}>
      {termsLocked && <Banner tone="info" title="Active contract" sub="Committed counts and rates move only by a dated addendum. Other details can still be edited." />}
      {isNew && <Select label="Client" required value={clientId} onChange={setClientId} options={db.clients.map((c) => ({ value: c.id, label: c.name }))} />}
      <HStack gap={10}>
        <View style={{ flex: 1 }}><Select label="Type" value={form.contract_type} onChange={(x) => { setF("contract_type", x as ContractFormState["contract_type"]); if (x === "services") setHasSites(false); }} options={[{ value: "guard_deployment", label: "Guard deployment" }, { value: "services", label: "Services" }]} /></View>
        <View style={{ flex: 1 }}><Select label="Status" value={form.status} onChange={(x) => setF("status", x as ContractFormState["status"])} options={STATUS.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }))} /></View>
      </HStack>
      {form.status === "terminated" && <Input label="Termination date" required value={form.termination_date} onChangeText={(x) => setF("termination_date", x)} placeholder="YYYY-MM-DD" />}
      <HStack gap={10}>
        <Input style={{ flex: 1 }} label="Start" value={form.start_date} onChangeText={(x) => setF("start_date", x)} placeholder="YYYY-MM-DD" />
        {!form.is_infinite && <Input style={{ flex: 1 }} label="End" value={form.end_date} onChangeText={(x) => setF("end_date", x)} placeholder="YYYY-MM-DD" />}
      </HStack>
      <Toggle label="No end date" value={form.is_infinite} onChange={(x) => setF("is_infinite", x)} />
      {form.is_infinite && <Input label="Notice period (days)" keyboardType="numeric" value={form.notice_period_days} onChangeText={(x) => setF("notice_period_days", x)} />}
      <HStack gap={10}>
        <Input style={{ flex: 1 }} label="Allowed leaves / month" keyboardType="numeric" value={form.allowed_leaves_per_month} onChangeText={(x) => setF("allowed_leaves_per_month", x)} />
        <Input style={{ flex: 1 }} label="Annual escalation %" keyboardType="decimal-pad" value={form.annual_escalation_pct} onChangeText={(x) => setF("annual_escalation_pct", x)} />
      </HStack>
      <Toggle label="EOBI deduction" value={form.eobi_deduction} onChange={(x) => setF("eobi_deduction", x)} />
      {form.eobi_deduction && <Input label="EOBI amount" amount value={form.eobi_amount} onChangeText={(x) => setF("eobi_amount", x)} />}
      <Input label="Renewal terms" multiline value={form.renewal_terms} onChangeText={(x) => setF("renewal_terms", x)} />

      {form.contract_type !== "services" && (
        <Toggle label="Split by site" sub="Each line sits under one of the client's sites" value={hasSites} onChange={(x) => {
          setHasSites(x);
          if (x && sites.length === 0) setSites([{ key: nextSiteKey(), name: "", location: "", is_default: true }]);
          if (x && sites.length) setLines(lines.map((l) => (l.site_key === NO_SITE ? { ...l, site_key: sites[0]!.key } : l)));
        }} />
      )}
      {hasSites && (
        <>
          <T v="eyebrow" muted style={{ marginVertical: 10 }}>Sites</T>
          {sites.map((s, i) => (
            <Card key={s.key} style={{ marginBottom: 8 }}>
              <Input label="Site name" required value={s.name} onChangeText={(x) => setSites(sites.map((y, j) => (j === i ? { ...y, name: x } : y)))} />
              <Input label="Location" value={s.location} onChangeText={(x) => setSites(sites.map((y, j) => (j === i ? { ...y, location: x } : y)))} />
              {sites.length > 1 && <Button size="sm" variant="ghost" label="Remove site" onPress={() => { setSites(sites.filter((_, j) => j !== i)); setLines(lines.filter((l) => l.site_key !== s.key)); }} />}
            </Card>
          ))}
          <Button size="sm" variant="secondary" icon={Plus} label="Add site" onPress={() => setSites([...sites, { key: nextSiteKey(), name: "", location: "", is_default: false }])} />
        </>
      )}

      <T v="eyebrow" muted style={{ marginVertical: 10 }}>Contract lines</T>
      {lines.map((l, i) => (
        <Card key={l.id ?? `n${i}`} style={{ marginBottom: 10 }}>
          {hasSites && <Select label="Site" value={l.site_key} onChange={(x) => setLine(i, { site_key: x })} options={sites.map((s) => ({ value: s.key, label: s.name || "(unnamed site)" }))} />}
          <HStack gap={10}>
            <View style={{ flex: 1 }}><Select label="Category" value={l.category} onChange={(x) => { const c = x as ContractLineCategory; setLine(i, { category: c, label: CONTRACT_LINE_CATEGORY_LABEL[c], shift_code: isPersonnelCategory(c) ? l.shift_code || "day" : "" }); }} options={allowed.map((c) => ({ value: c, label: CONTRACT_LINE_CATEGORY_LABEL[c] }))} /></View>
            {isPersonnelCategory(l.category) && <View style={{ flex: 1 }}><Select label="Shift" value={l.shift_code} onChange={(x) => setLine(i, { shift_code: x })} options={SHIFT_OPTS} /></View>}
          </HStack>
          <Input label="Label" value={l.label} onChangeText={(x) => setLine(i, { label: x })} />
          <Input label="Notes / location" value={l.location} onChangeText={(x) => setLine(i, { location: x })} />
          <HStack gap={10}>
            <Input style={{ flex: 1 }} label="Committed" keyboardType="numeric" editable={!(termsLocked && l.id)} value={l.committed_count} onChangeText={(x) => setLine(i, { committed_count: x })} />
            <Input style={{ flex: 1.4 }} label="Rate / month" amount editable={!(termsLocked && l.id)} value={l.unit_rate} onChangeText={(x) => setLine(i, { unit_rate: x })} />
          </HStack>
          <Toggle label="Taxable" value={l.taxable} onChange={(x) => setLine(i, { taxable: x })} />
          <Ledger label="Line value" value={pkr((Number(l.committed_count) || 0) * (Number(l.unit_rate) || 0))} />
          {!(termsLocked && l.id) && lines.length > 1 && <Button size="sm" variant="ghost" label="Remove line" onPress={() => setLines(lines.filter((_, j) => j !== i))} />}
        </Card>
      ))}
      <Button label="Add line" icon={Plus} variant="secondary" onPress={() => setLines([...lines, blankLine(allowed[0]!, hasSites ? sites[0]?.key ?? NO_SITE : NO_SITE)])} />
      <Ledger label="Total / month" value={pkr(total)} strong top />
      <T v="smallStrong" soft style={{ marginTop: 14, marginBottom: 6 }}>Signed document{raw?.contract_file_name ? ` (current: ${raw.contract_file_name})` : ""}</T>
      {file ? <T v="small" style={{ marginBottom: 6 }}>{file.name} — uploads on save</T> : null}
      <Button size="sm" variant="secondary" icon={Upload} label={file ? "Change file" : "Choose file"} onPress={() => pickDocument().then((x) => x && setFile(x)).catch(() => {})} />
    </Sheet>
  );
}

/** Addendum form: add / reduce headcount, rate change, renewal — each a dated change. */
function AddendumSheet({ k, onClose }: { k: Contract; onClose: () => void }) {
  const { db, act } = useDB();
  const [data, setData] = useState<Awaited<ReturnType<typeof loadContractEditor>> | null>(null);
  const [f, setF] = useState<AddendumForm>(blankAddendum());
  const [file, setFile] = useState<PickedFile | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadContractEditor(k.raw, k.client_id).then(setData).catch(() => {}); }, [k]);
  if (!data) return <Sheet open onClose={onClose} title="Add addendum"><ActivityIndicator /></Sheet>;
  const allowed = CONTRACT_TYPE_LINE_CATEGORIES[data.form.contract_type];
  const isRenewal = f.change_type === "EXTEND_END_DATE";
  const isAdd = f.change_type === "ADD_HEADCOUNT";
  const picksSite = data.hasSites || isAdd;
  const savedSites = data.sites.filter((s) => s.id);
  const siteKey = !picksSite ? NO_SITE : savedSites.some((s) => s.key === f.site_key) ? f.site_key : data.hasSites ? savedSites[0]?.key ?? NO_SITE : NO_SITE;
  const category = allowed.includes(f.category) ? f.category : allowed[0]!;
  const matches = data.lines.filter((l) => !!l.id && l.site_key === siteKey && l.category === category);
  const line = f.change_type === "REDUCE_HEADCOUNT" || f.change_type === "RATE_CHANGE" ? matches.find((l) => l.id === f.line_id) ?? (matches.length === 1 ? matches[0] : undefined) : undefined;
  const siteId = savedSites.find((s) => s.key === siteKey)?.id ?? null;
  const set = <K extends keyof AddendumForm>(key: K, val: AddendumForm[K]) => setF({ ...f, [key]: val });
  return (
    <Sheet open onClose={onClose} title={`Addendum — ${k.code}`} full
      footer={<><Button label="Cancel" variant="secondary" full onPress={onClose} /><Button label="Add addendum" full loading={busy} onPress={async () => {
        if (!isRenewal && data.hasSites && siteKey === NO_SITE) return;
        setBusy(true);
        const ok = await act(() => addAddendum({ id: k.id, contract_code: k.code }, { ...f, category }, siteId, line, file, { id: db.company.id, name: db.company.name }), "Addendum added");
        setBusy(false);
        if (ok) onClose();
      }} /></>}>
      <Select label="Change" value={f.change_type} onChange={(x) => set("change_type", x as AddendumForm["change_type"])} options={Object.entries(ADDENDUM_CHANGE_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
      <Input label="Effective from" required value={f.effective_from} onChangeText={(x) => set("effective_from", x)} placeholder="YYYY-MM-DD" />
      {!isRenewal && (
        <>
          {picksSite && savedSites.length > 0 && <Select label="Site" value={siteKey} onChange={(x) => set("site_key", x)} options={savedSites.map((s) => ({ value: s.key, label: s.name }))} />}
          <Select label="Category" value={category} onChange={(x) => set("category", x as ContractLineCategory)} options={allowed.map((c) => ({ value: c, label: CONTRACT_LINE_CATEGORY_LABEL[c] }))} />
          {!isAdd && matches.length > 1 && <Select label="Which line" required value={f.line_id} onChange={(x) => set("line_id", x)} options={matches.map((l) => ({ value: l.id!, label: `${l.label} · ${l.shift_code || "—"} · PKR ${l.unit_rate}` }))} />}
          {!isAdd && matches.length === 0 && <Banner tone="warning" title={`No ${CONTRACT_LINE_CATEGORY_LABEL[category]} line there to change`} />}
        </>
      )}
      {(isAdd || f.change_type === "REDUCE_HEADCOUNT") && <Input label="Headcount" keyboardType="numeric" value={f.count_delta} onChangeText={(x) => set("count_delta", x)} />}
      {isAdd && (
        <>
          <Input label="Rate / month" amount value={f.line_rate} onChangeText={(x) => set("line_rate", x)} />
          <Input label="Notes" value={f.line_notes} onChangeText={(x) => set("line_notes", x)} />
          <Toggle label="Taxable" value={f.line_taxable} onChange={(x) => set("line_taxable", x)} />
        </>
      )}
      {f.change_type === "RATE_CHANGE" && <Input label="New rate / month" amount value={f.new_rate} onChangeText={(x) => set("new_rate", x)} />}
      {isRenewal && (
        <>
          {!f.new_is_infinite && <Input label="New end date" value={f.new_end_date} onChangeText={(x) => set("new_end_date", x)} placeholder="YYYY-MM-DD" />}
          <Toggle label="No end date" value={f.new_is_infinite} onChange={(x) => set("new_is_infinite", x)} />
        </>
      )}
      <Select label="Source" value={f.source} onChange={(x) => set("source", x)} options={Object.entries(ADDENDUM_SOURCE_LABEL).map(([value, label]) => ({ value, label }))} />
      <Input label="Reference" value={f.reference} onChangeText={(x) => set("reference", x)} />
      {file ? <T v="small" style={{ marginBottom: 6 }}>{file.name}</T> : null}
      <Button size="sm" variant="secondary" icon={Upload} label={file ? "Change file" : "Attach reference"} onPress={() => pickDocument().then((x) => x && setFile(x)).catch(() => {})} />
    </Sheet>
  );
}
